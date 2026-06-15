import { describe, it, expect } from 'vitest';
import { loadConfig, type Config, type Market } from '@st/shared';
import { createState } from '../../runtime/state.js';
import { makeShip } from '../../__tests__/fixtures.js';
import { deliverWhenPaused, gateBuyAllowed, planGateFill } from '../gate.js';

const baseCfg = loadConfig({});

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...baseCfg, ...overrides } as Config;
}

function market(symbol: string, goods: Array<{ symbol: string; type: 'EXPORT' | 'IMPORT' | 'EXCHANGE'; purchasePrice: number; tradeVolume: number }>): Market {
  return {
    symbol,
    tradeGoods: goods.map((g) => ({ ...g, sellPrice: Math.max(1, g.purchasePrice - 100), supply: 'MODERATE' })),
  };
}

describe('gate: planGateFill', () => {
  it('respects absolute GATE_MAX_PRICE cap', () => {
    const c = cfg({ GATE_MAX_PRICE: { FAB_MATS: 100 } });
    const s = createState(c);
    const markets = {
      A: market('A', [{ symbol: 'FAB_MATS', type: 'EXPORT', purchasePrice: 101, tradeVolume: 20 }]),
      B: market('B', [{ symbol: 'FAB_MATS', type: 'EXCHANGE', purchasePrice: 150, tradeVolume: 20 }]),
    };

    const buys = planGateFill({ FAB_MATS: 50 }, new Map(), markets, {
      free: 40,
      headroom: 100_000,
      slippage: 1,
      ceilFactor: 10,
      absMax: c.GATE_MAX_PRICE,
      state: s,
      cfg: c,
    });

    expect(buys).toEqual([]);
  });

  it('respects ceil-factor cap, free slots, remaining headroom, and gateClaims', () => {
    const c = cfg({ GATE_MAX_PRICE: {}, GATE_PRICE_SETTLE_MS: 0 });
    const s = createState(c);
    const claims = new Map<string, number>([['FAB_MATS', 30]]);
    const markets = {
      cheap: market('cheap', [{ symbol: 'FAB_MATS', type: 'EXPORT', purchasePrice: 100, tradeVolume: 40 }]),
      pricey: market('pricey', [{ symbol: 'FAB_MATS', type: 'EXPORT', purchasePrice: 130, tradeVolume: 40 }]),
      import: market('import', [{ symbol: 'FAB_MATS', type: 'IMPORT', purchasePrice: 90, tradeVolume: 40 }]),
    };

    const buys = planGateFill({ FAB_MATS: 100 }, claims, markets, {
      free: 50,
      headroom: 2_500,
      slippage: 1,
      ceilFactor: 1.2,
      state: s,
      cfg: c,
    });

    expect(buys).toEqual([{ sym: 'FAB_MATS', wp: 'cheap', units: 25, px: 100 }]);
  });
});

describe('gate: gateBuyAllowed patience FSM', () => {
  it('moves paused→settling→normal on REBOUND', () => {
    const c = cfg({ GATE_PRICE_SETTLE_MS: 10_000, GATE_PRICE_REBOUND_EPS: 0.02 });
    const s = createState(c);

    expect(gateBuyAllowed(s, c, 'FAB_MATS', 120, 100, 1_000)).toBe(false);
    expect(s.gatePxState.get('FAB_MATS')?.state).toBe('paused');

    expect(gateBuyAllowed(s, c, 'FAB_MATS', 95, 100, 2_000)).toBe(false);
    expect(s.gatePxState.get('FAB_MATS')).toMatchObject({ state: 'settling', low: 95 });

    expect(gateBuyAllowed(s, c, 'FAB_MATS', 90, 100, 3_000)).toBe(false);
    expect(s.gatePxState.get('FAB_MATS')?.low).toBe(90);

    expect(gateBuyAllowed(s, c, 'FAB_MATS', 92, 100, 4_000)).toBe(true);
    expect(s.gatePxState.get('FAB_MATS')?.state).toBe('normal');
  });

  it('moves settling→normal on TIMEOUT', () => {
    const c = cfg({ GATE_PRICE_SETTLE_MS: 5_000, GATE_PRICE_REBOUND_EPS: 0.5 });
    const s = createState(c);

    expect(gateBuyAllowed(s, c, 'ADVANCED_CIRCUITRY', 150, 100, 1_000)).toBe(false);
    expect(gateBuyAllowed(s, c, 'ADVANCED_CIRCUITRY', 99, 100, 2_000)).toBe(false);
    expect(gateBuyAllowed(s, c, 'ADVANCED_CIRCUITRY', 98, 100, 7_000)).toBe(true);
    expect(s.gatePxState.get('ADVANCED_CIRCUITRY')?.state).toBe('normal');
  });
});

describe('gate: paused delivery predicate', () => {
  it('returns true while buy is paused and the ship holds still-needed gate material', () => {
    const c = cfg({ GATE_PROTECT_MATERIALS: ['FAB_MATS'] });
    const s = createState(c);
    s.gateBuyPaused = true;
    s.gateCache = { exists: true, wp: 'GATE', built: false, known: true, remaining: { FAB_MATS: 10 } };
    const ship = makeShip({ cargo: { capacity: 40, units: 5, inventory: [{ symbol: 'FAB_MATS', units: 5 }] } });

    expect(deliverWhenPaused(ship, s, c)).toBe(true);
  });
});
