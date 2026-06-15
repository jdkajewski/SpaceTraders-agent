import { describe, it, expect } from 'vitest';
import { loadConfig, type Config, type CoordsMap, type Market, type MarketGood } from '@st/shared';
import { createRouter } from '../../routing/route.js';
import { createState, gs } from '../../runtime/state.js';
import { buildLanes, claimLane, planRideAlongs, cooldownFor } from '../lanes.js';
import { makeShip } from '../../__tests__/fixtures.js';

const cfg: Config = loadConfig({});

const coords: CoordsMap = {
  S: [0, 0], // ship start
  GBUY: [10, 0],
  GSELL: [12, 0], // GOLD: short haul
  IBUY: [10, 0],
  ISELL: [40, 0], // IRON: long haul
  SBUY: [10, 0],
  SSELL: [12, 0], // SILVER: short haul (near-tie with GOLD)
};

function good(symbol: string, type: MarketGood['type'], purchasePrice: number, sellPrice: number, tradeVolume = 20): MarketGood {
  return { symbol, type, tradeVolume, supply: 'MODERATE', purchasePrice, sellPrice };
}
function mkt(symbol: string, goods: MarketGood[]): Market {
  return { symbol, tradeGoods: goods };
}

function router(markets: Record<string, Market>) {
  return createRouter({ coords, getFuelPx: () => 0.72, valueOfTime: cfg.VALUE_OF_TIME, marketsRef: () => markets });
}

describe('lanes: cooldownFor (adaptive, symmetric)', () => {
  it('thin good (current < typical) rests LONGER than base', () => {
    const ema = new Map([['ORE', 100]]);
    const cd = cooldownFor('ORE', ema, { ORE: 50 }, cfg);
    expect(cd).toBeGreaterThan(cfg.COOLDOWN_MS);
  });
  it('thick good (current > typical) rests SHORTER than base (but floored)', () => {
    const ema = new Map([['ORE', 100]]);
    const cd = cooldownFor('ORE', ema, { ORE: 200 }, cfg);
    expect(cd).toBeLessThan(cfg.COOLDOWN_MS);
    expect(cd).toBeGreaterThanOrEqual(cfg.COOLDOWN_FLOOR_MS);
  });
});

describe('lanes: buildLanes', () => {
  it('emits the best-gross lane per good, MIN_NET-gated', () => {
    const markets: Record<string, Market> = {
      GBUY: mkt('GBUY', [good('GOLD', 'EXPORT', 100, 120)]),
      GSELL: mkt('GSELL', [good('GOLD', 'IMPORT', 580, 600)]),
      // a too-thin lane (gross 200 < MIN_NET) must be dropped
      IBUY: mkt('IBUY', [good('TIN', 'EXPORT', 100, 105)]),
      ISELL: mkt('ISELL', [good('TIN', 'IMPORT', 108, 110)]),
    };
    const s = createState(cfg, { marketsRef: () => markets });
    const lanes = buildLanes(markets, s, cfg, (a, b) => Math.abs((coords[a]![0]) - (coords[b]![0])));
    const syms = lanes.map((l) => l.sym);
    expect(syms).toContain('GOLD');
    expect(syms).not.toContain('TIN');
    const gold = lanes.find((l) => l.sym === 'GOLD')!;
    expect(gold.buyWp).toBe('GBUY');
    expect(gold.sellWp).toBe('GSELL');
  });
});

describe('lanes: claimLane net/min ranking + atomic lock', () => {
  const markets: Record<string, Market> = {
    GBUY: mkt('GBUY', [good('GOLD', 'EXPORT', 100, 120)]),
    GSELL: mkt('GSELL', [good('GOLD', 'IMPORT', 580, 600)]),
    IBUY: mkt('IBUY', [good('IRON', 'EXPORT', 100, 120)]),
    ISELL: mkt('ISELL', [good('IRON', 'IMPORT', 340, 350)]),
  };
  const D = (a: string, b: string) => Math.abs(coords[a]![0] - coords[b]![0]);

  function setup(over: Partial<Config> = {}) {
    const c = { ...cfg, FILL_BIAS: false, ...over } as Config;
    const s = createState(c, { marketsRef: () => markets });
    s.cachedCredits = 10_000_000;
    s.operatingReserve = 0;
    const ship = makeShip({ symbol: 'SHIP-1', nav: { ...makeShip().nav, waypointSymbol: 'S' } });
    return { c, s, ship };
  }

  it('picks the higher net/min lane (GOLD) and locks + commits it', () => {
    const { c, s, ship } = setup();
    const lanes = buildLanes(markets, s, c, D);
    const claim = claimLane(ship, lanes, markets, { state: s, cfg: c, router: router(markets), D });
    expect(claim && 'lane' in claim).toBe(true);
    if (claim && 'lane' in claim) {
      expect(claim.lane.sym).toBe('GOLD');
      expect(gs(s, 'GOLD').lockedBy).toBe('SHIP-1');
      expect(s.committed).toBe(claim.cost);
      expect(claim.cost).toBe(Math.ceil(20 * 100 * 1.1));
    }
  });

  it('a locked good cannot be re-claimed (atomic lock) — next claim falls to IRON', () => {
    const { c, s, ship } = setup();
    const lanes = buildLanes(markets, s, c, D);
    const first = claimLane(ship, lanes, markets, { state: s, cfg: c, router: router(markets), D });
    const second = claimLane(makeShip({ symbol: 'SHIP-2', nav: { ...makeShip().nav, waypointSymbol: 'S' } }), lanes, markets, {
      state: s,
      cfg: c,
      router: router(markets),
      D,
    });
    expect(first && 'lane' in first && first.lane.sym).toBe('GOLD');
    expect(second && 'lane' in second && second.lane.sym).toBe('IRON'); // GOLD locked → never re-issued
  });

  it('returns null when nothing is affordable (availableForWork gate)', () => {
    const { c, s, ship } = setup();
    s.cachedCredits = 0;
    s.operatingReserve = cfg.OPERATING_RESERVE;
    const lanes = buildLanes(markets, s, c, D);
    expect(claimLane(ship, lanes, markets, { state: s, cfg: c, router: router(markets), D })).toBeNull();
  });

  it('parks when the best projected net is below PARK_MIN_NET', () => {
    const { c, s, ship } = setup({ PARK_MIN_NET: 1_000_000_000 });
    const lanes = buildLanes(markets, s, c, D);
    const claim = claimLane(ship, lanes, markets, { state: s, cfg: c, router: router(markets), D });
    expect(claim && 'park' in claim).toBe(true);
  });
});

describe('lanes: FILL_BIAS re-ranks only within EPS toward a fuller hold', () => {
  it('prefers the near-tie lane that fills the hold via ride-alongs', () => {
    const markets: Record<string, Market> = {
      // GOLD: top score, but no ride-alongs available at its source → half-full hold
      GBUY: mkt('GBUY', [good('GOLD', 'EXPORT', 100, 120)]),
      GSELL: mkt('GSELL', [good('GOLD', 'IMPORT', 580, 600)]),
      // SILVER: within EPS of GOLD, and its source offers a ride-along that fills the hold
      SBUY: mkt('SBUY', [good('SILVER', 'EXPORT', 100, 120), good('EXTRA', 'EXPORT', 50, 60)]),
      SSELL: mkt('SSELL', [good('SILVER', 'IMPORT', 560, 577), good('EXTRA', 'IMPORT', 290, 300)]),
    };
    const D = (a: string, b: string) => Math.abs(coords[a]![0] - coords[b]![0]);
    const s = createState(cfg, { marketsRef: () => markets });
    s.cachedCredits = 10_000_000;
    s.operatingReserve = 0;
    const ship = makeShip({ symbol: 'SHIP-1', cargo: { capacity: 40, units: 0, inventory: [] }, nav: { ...makeShip().nav, waypointSymbol: 'S' } });
    const lanes = buildLanes(markets, s, cfg, D);
    const claim = claimLane(ship, lanes, markets, { state: s, cfg, router: router(markets), D });
    expect(claim && 'lane' in claim && claim.lane.sym).toBe('SILVER');
  });
});

describe('lanes: planRideAlongs (zero-detour fill)', () => {
  const markets: Record<string, Market> = {
    GBUY: mkt('GBUY', [
      good('GOLD', 'EXPORT', 100, 120),
      good('EXTRA', 'EXPORT', 50, 60), // rides well: margin 150 × 20 = 3000 ≥ RIDEALONG_MIN_GROSS
      good('TINY', 'EXPORT', 100, 110), // too thin: margin 10 × 20 = 200 < RIDEALONG_MIN_GROSS
    ]),
    GSELL: mkt('GSELL', [
      good('GOLD', 'IMPORT', 580, 600),
      good('EXTRA', 'IMPORT', 190, 200),
      good('TINY', 'IMPORT', 108, 110),
    ]),
  };

  it('includes a profitable ride-along and excludes sub-min-gross goods', () => {
    const s = createState(cfg, { marketsRef: () => markets });
    const lane = { sym: 'GOLD', buyWp: 'GBUY', buy: 100, sellWp: 'GSELL', sell: 600, margin: 500, units: 20, dist: 2, gross: 10000 };
    const picks = planRideAlongs(markets, lane, 40, 10_000_000, s, cfg);
    const syms = picks.map((p) => p.sym);
    expect(syms).toContain('EXTRA');
    expect(syms).not.toContain('TINY');
    expect(syms).not.toContain('GOLD'); // never rides the primary good
  });

  it('respects free-unit space (0 free → no picks)', () => {
    const s = createState(cfg, { marketsRef: () => markets });
    const lane = { sym: 'GOLD', buyWp: 'GBUY', buy: 100, sellWp: 'GSELL', sell: 600, margin: 500, units: 20, dist: 2, gross: 10000 };
    expect(planRideAlongs(markets, lane, 0, 10_000_000, s, cfg)).toEqual([]);
  });
});
