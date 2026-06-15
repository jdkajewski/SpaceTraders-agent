/**
 * parity.test.ts — DURABLE behavioral-parity harness (Wave 6, spec §6.1).
 *
 * Asserts the TS pure decision functions produce output IDENTICAL to the legacy `bot2.mjs` /
 * `expansion.mjs` math on shared fixtures. The legacy side is the verbatim, line-referenced
 * transcription in `legacy-shims.ts` (see that file's header for WHY a transcription rather than a
 * direct import — bot2 self-executes `main()` and reads files at import time, so it cannot be loaded
 * in a test). Both sides are fed the SAME `Config` defaults, so the only thing under test is the
 * formula. If a future change makes the TS diverge from the documented legacy behavior, one of these
 * assertions fails and points at the exact function + the `bot2.mjs:Lxxx` reference to reconcile.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig, distance, type Config, type CoordsMap, type Market, type MarketGood, type Ship } from '@st/shared';
import { chooseMode } from '../../routing/flight.js';
import { createRouter } from '../../routing/route.js';
import { buildLanes, cooldownFor } from '../../trade/lanes.js';
import { determinePhase, gateCreditOk } from '../../budget/phase.js';
import { computeExpansionTarget } from '../../budget/budget.js';
import { planGateFill } from '../../gate/gate.js';
import { partitionMarkets } from '../../expansion/partition.js';
import { createState, type BotState } from '../../runtime/state.js';
import type { SpaceTradersClient } from '../../interfaces.js';
import { makeShip } from '../fixtures.js';
import * as L from './legacy-shims.js';

const cfg: Config = loadConfig({ SYSTEM: 'X1-AA1' });
const FUEL_PX = 0.72;

function good(symbol: string, type: MarketGood['type'], purchasePrice: number, sellPrice: number, tradeVolume = 20): MarketGood {
  return { symbol, type, tradeVolume, supply: 'MODERATE', purchasePrice, sellPrice };
}
function mkt(symbol: string, goods: MarketGood[]): Market {
  return { symbol, tradeGoods: goods };
}

describe('parity: chooseMode / legFuel / legTime (bot2.mjs:L312-345)', () => {
  const ships: Array<[string, Ship]> = [
    ['frigate', makeShip({ engine: { speed: 30, condition: 1 }, fuel: { current: 400, capacity: 400 } })],
    ['shuttle', makeShip({ engine: { speed: 15, condition: 1 }, fuel: { current: 80, capacity: 80 } })],
    ['probe', makeShip({ engine: { speed: 15, condition: 1 }, fuel: { current: 0, capacity: 0 } })],
  ];
  for (const [name, ship] of ships)
    for (const dist of [5, 40, 120, 300, 900]) {
      it(`${name} @ dist ${dist} picks the same mode/fuel/time`, () => {
        const ts = chooseMode(dist, ship, FUEL_PX, cfg.VALUE_OF_TIME);
        const lg = L.chooseModeLegacy(dist, ship, FUEL_PX, cfg.VALUE_OF_TIME);
        expect(ts.mode).toBe(lg.mode);
        expect(ts.fuel).toBe(lg.fuel);
        expect(ts.time).toBe(lg.time);
      });
    }
});

describe('parity: planRoute / routeCost (bot2.mjs:L2229-2287)', () => {
  // 1-D layout: A — B(fuel) — C(fuel) — DST … FAR (no in-range fuel hop)
  const coords: CoordsMap = { A: [0, 0], B: [300, 0], C: [600, 0], DST: [900, 0], FAR: [2000, 0] };
  const D = (a: string, b: string): number => distance(a, b, coords);
  const fuelMarkets: Record<string, Market> = {
    B: mkt('B', [good('FUEL', 'EXCHANGE', 72, 72)]),
    C: mkt('C', [good('FUEL', 'EXCHANGE', 72, 72)]),
  };
  const fuelSet = new Set(['B', 'C']); // markets that sell FUEL, with coords → the legacy fuel-node set
  const router = createRouter({ coords, getFuelPx: () => FUEL_PX, valueOfTime: cfg.VALUE_OF_TIME, marketsRef: () => fuelMarkets });
  const ship = makeShip({ engine: { speed: 15, condition: 1 }, fuel: { current: 400, capacity: 400 } });

  const pairs: Array<[string, string]> = [
    ['A', 'B'], // direct-feasible
    ['A', 'DST'], // multi-hop via B, C
    ['A', 'FAR'], // unreachable on one-tank hops → DRIFT fallback
    ['A', 'A'], // degenerate
  ];
  for (const [from, to] of pairs) {
    it(`planRoute ${from}→${to} matches legacy`, () => {
      expect(router.planRoute(from, to, ship.fuel.capacity, fuelMarkets)).toEqual(
        L.planRouteLegacy(from, to, ship.fuel.capacity, coords, D, fuelSet),
      );
    });
    it(`routeCost ${from}→${to} matches legacy`, () => {
      expect(router.routeCost(from, to, ship)).toEqual(L.routeCostLegacy(from, to, ship, coords, D, fuelSet, FUEL_PX));
    });
  }
});

describe('parity: buildLanes ranking (bot2.mjs:L416-448, guards off)', () => {
  const coords: CoordsMap = { GBUY: [0, 0], GSELL: [10, 0], IBUY: [0, 0], ISELL: [40, 0], TBUY: [0, 0], TSELL: [5, 0] };
  const D = (a: string, b: string): number => distance(a, b, coords);
  const markets: Record<string, Market> = {
    GBUY: mkt('GBUY', [good('GOLD', 'EXPORT', 100, 120)]),
    GSELL: mkt('GSELL', [good('GOLD', 'IMPORT', 580, 600)]),
    IBUY: mkt('IBUY', [good('IRON', 'EXPORT', 100, 120)]),
    ISELL: mkt('ISELL', [good('IRON', 'IMPORT', 340, 350)]),
    TBUY: mkt('TBUY', [good('TIN', 'EXPORT', 100, 105)]), // too thin → dropped by MIN_NET
    TSELL: mkt('TSELL', [good('TIN', 'IMPORT', 108, 110)]),
  };

  it('emits the same best-gross lane set', () => {
    const state = createState(cfg, { marketsRef: () => markets });
    const ts = buildLanes(markets, state, cfg, D).sort((a, b) => a.sym.localeCompare(b.sym));
    const lg = L.buildLanesLegacy(markets, D, cfg.MAXD, cfg.MIN_NET).sort((a, b) => a.sym.localeCompare(b.sym));
    expect(ts).toEqual(lg);
  });
});

describe('parity: cooldownFor (bot2.mjs:L394-402)', () => {
  const ema = new Map<string, number>([['ORE', 100], ['GOLD', 50]]);
  const cases: Array<[string, Record<string, number>]> = [
    ['ORE', { ORE: 50 }], // thin → longer
    ['ORE', { ORE: 200 }], // thick → shorter (floored)
    ['ORE', { ORE: 100 }], // at typical → base
    ['GOLD', { GOLD: 0 }], // current 0 → base
    ['UNSEEN', { UNSEEN: 80 }], // no EMA → base
  ];
  for (const [sym, last] of cases)
    it(`${sym} cur=${last[sym]} matches legacy`, () => {
      const ts = cooldownFor(sym, ema, last, cfg);
      const lg = L.cooldownForLegacy(sym, ema, last, cfg.COOLDOWN_MS, cfg.COOLDOWN_MAX_MULT, cfg.COOLDOWN_MIN_MULT, cfg.COOLDOWN_FLOOR_MS);
      expect(ts).toBe(lg);
    });
});

describe('parity: gateCreditOk hysteresis latch (bot2.mjs:L635-647)', () => {
  it('tracks the same paused/resume sequence across a credit sweep', () => {
    const state = createState(cfg); // gateLevers = { floor, resume } from cfg
    const { floor, resume } = state.gateLevers;
    let was = false;
    // sweep credits down through the floor and back up past resume — the deadband must latch identically
    const sweep = [resume + 1, floor + 1, floor - 1, floor + 1, resume - 1, resume, resume + 1];
    for (const credits of sweep) {
      state.cachedCredits = credits;
      const tsOk = gateCreditOk(state);
      was = L.gateLatchLegacy(credits, was, floor, resume);
      expect(tsOk).toBe(!was); // gateCreditOk returns !paused
    }
  });
});

describe('parity: determinePhase (bot2.mjs:L648-655)', () => {
  type Scn = { name: string; fleetSize: number; markets: Record<string, Market>; gate: { known: boolean; exists: boolean; built: boolean } };
  const someMarket: Record<string, Market> = { M: mkt('M', [good('ORE', 'EXPORT', 1, 2)]) };
  const scenarios: Scn[] = [
    { name: 'no markets', fleetSize: 5, markets: {}, gate: { known: false, exists: false, built: false } },
    { name: 'small fleet', fleetSize: 1, markets: someMarket, gate: { known: false, exists: false, built: false } },
    { name: 'profit', fleetSize: 5, markets: someMarket, gate: { known: true, exists: false, built: false } },
    { name: 'gate supply', fleetSize: 5, markets: someMarket, gate: { known: true, exists: true, built: false } },
    { name: 'portal open', fleetSize: 5, markets: someMarket, gate: { known: true, exists: true, built: true } },
  ];
  for (const scn of scenarios)
    it(`${scn.name} resolves to the same phase`, () => {
      const c = { ...cfg, GATE_SUPPLY: true, INPUT_FEED: false } as Config;
      const state: BotState = createState(c, { marketsRef: () => scn.markets });
      state.fleetSize = scn.fleetSize;
      state.gateCache = { exists: scn.gate.exists, wp: null, built: scn.gate.built, remaining: {}, known: scn.gate.known };
      const gateSupplyActive = c.GATE_SUPPLY && scn.gate.exists && !scn.gate.built && scn.gate.known;
      const ts = determinePhase(state, c).name;
      const lg = L.determinePhaseLegacy({
        marketKnown: Object.keys(scn.markets).length > 0,
        fleetSize: scn.fleetSize,
        BOOTSTRAP_FLEET_MIN: c.BOOTSTRAP_FLEET_MIN,
        gate: scn.gate,
        gateSupplyActive,
        INPUT_FEED: c.INPUT_FEED,
      });
      expect(ts).toBe(lg);
    });
});

describe('parity: planGateFill (bot2.mjs:L1291-1328, absMax empty)', () => {
  const markets: Record<string, Market> = {
    P1: mkt('P1', [good('FAB_MATS', 'EXPORT', 90, 95, 30)]),
    P2: mkt('P2', [good('FAB_MATS', 'EXPORT', 110, 115, 30)]), // above ceilFactor → filtered
    P3: mkt('P3', [good('ADV_CIRCUIT', 'EXCHANGE', 200, 205, 10)]),
    C1: mkt('C1', [good('FAB_MATS', 'IMPORT', 80, 80, 30)]), // CONSUMER → never sourced
  };
  const remaining = { FAB_MATS: 50, ADV_CIRCUIT: 8 };
  it('plans the same buys', () => {
    const state = createState(cfg);
    const claims = new Map<string, number>();
    const opts = { free: 40, headroom: 1_000_000, slippage: cfg.SLIPPAGE_FACTOR, ceilFactor: 1.15 };
    const ts = planGateFill(remaining, claims, markets, { ...opts, state, cfg });
    const lg = L.planGateFillLegacy(remaining, claims, markets, opts);
    expect(ts).toEqual(lg);
  });
});

describe('parity: computeExpansionTarget pure target math (bot2.mjs:L657-722)', () => {
  it('produces the same target + breakdown', async () => {
    const materials = [
      { tradeSymbol: 'FAB_MATS', required: 1000, fulfilled: 200 },
      { tradeSymbol: 'ADV_CIRCUIT', required: 400, fulfilled: 0 },
    ];
    const markets: Record<string, Market> = {
      P1: mkt('P1', [good('FAB_MATS', 'EXPORT', 90, 95, 30)]),
      P2: mkt('P2', [good('FAB_MATS', 'EXPORT', 120, 125, 30)]),
      P3: mkt('P3', [good('ADV_CIRCUIT', 'EXPORT', 300, 305, 10)]),
    };
    const state = createState(cfg);
    // stub client: first call returns the JUMP_GATE waypoint, second returns its construction site
    let call = 0;
    const client = {
      api: async () => {
        call += 1;
        return call === 1
          ? { data: [{ symbol: 'X1-AA1-GATE' }] }
          : { data: { isComplete: false, materials } };
      },
    } as unknown as SpaceTradersClient;

    const tsTarget = await computeExpansionTarget(state, cfg, markets, { client });
    const lg = L.expansionTargetLegacy(materials, markets, state.operatingReserve, cfg.SLIPPAGE_FACTOR, cfg.HAULER_PRICE, cfg.NEW_CELL_SEED);
    expect(tsTarget).toBe(lg.target);
    expect(state.targetBreakdown).toEqual(lg.breakdown);
  });
});

describe('parity: partitionMarkets arc (expansion.mjs:L327-330)', () => {
  const wps = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  for (let n = 1; n <= 9; n++)
    for (let idx = 0; idx < n; idx++)
      it(`idx ${idx}/${n} over ${wps.length} markets matches legacy`, () => {
        expect(partitionMarkets(wps, idx, n)).toEqual(L.partitionMarketsLegacy(wps, idx, n));
      });
});
