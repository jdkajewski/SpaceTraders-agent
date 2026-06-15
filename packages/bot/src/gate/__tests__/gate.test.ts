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

describe('gate: gateBuyAllowed price hysteresis latch', () => {
  it('pauses above cap, holds in the deadband, resumes only at/below the resume price', () => {
    const c = cfg({ GATE_MAX_PRICE: { FAB_MATS: 100 }, GATE_RESUME_PRICE_FACTOR: 0.9 });
    const s = createState(c);

    // spike above cap → latch arms (paused)
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 120, 100)).toBe(false);
    expect(s.gatePxPaused.get('FAB_MATS')).toBe(true);

    // dips back under the cap but still above resume (90) → HOLD paused (deadband)
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 95, 100)).toBe(false);
    expect(s.gatePxPaused.get('FAB_MATS')).toBe(true);

    // cools to the resume price (≤ 90) → release
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 90, 100)).toBe(true);
    expect(s.gatePxPaused.get('FAB_MATS')).toBe(false);

    // back into the deadband from below → HOLD resumed
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 95, 100)).toBe(true);
    expect(s.gatePxPaused.get('FAB_MATS')).toBe(false);
  });

  it('honours an explicit GATE_RESUME_PRICE override and treats no-cap as always allowed', () => {
    const c = cfg({ GATE_MAX_PRICE: { FAB_MATS: 100 }, GATE_RESUME_PRICE: { FAB_MATS: 80 } });
    const s = createState(c);

    expect(gateBuyAllowed(s, c, 'FAB_MATS', 120, 100)).toBe(false);
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 90, 100)).toBe(false); // above explicit resume 80 → still paused
    expect(gateBuyAllowed(s, c, 'FAB_MATS', 80, 100)).toBe(true); // at resume → release

    // no cap configured for the good → always allowed
    expect(gateBuyAllowed(s, c, 'QUANTUM_STABILIZERS', 9_999, undefined)).toBe(true);
  });
});

describe('gate: planGateFill packing', () => {
  it('packs the hold across all needed materials cheapest-first, balancing the basket', () => {
    const c = cfg({ GATE_MAX_PRICE: {} });
    const s = createState(c);
    const markets = {
      F: market('F', [{ symbol: 'FAB_MATS', type: 'EXPORT', purchasePrice: 100, tradeVolume: 20 }]),
      A: market('A', [{ symbol: 'ADVANCED_CIRCUITRY', type: 'EXPORT', purchasePrice: 110, tradeVolume: 20 }]),
    };

    const buys = planGateFill({ FAB_MATS: 100, ADVANCED_CIRCUITRY: 100 }, new Map(), markets, {
      free: 80,
      headroom: 1_000_000,
      slippage: 1,
      ceilFactor: 10,
      state: s,
      cfg: c,
    });

    const byMat = Object.fromEntries(buys.map((b) => [b.sym, b.units]));
    // Old single-lot-per-material behaviour would yield 20 + 20 = 40/80; packing fills the 80 hull (40 + 40).
    expect(byMat.FAB_MATS).toBe(40);
    expect(byMat.ADVANCED_CIRCUITRY).toBe(40);
    expect(buys.reduce((s, b) => s + b.units, 0)).toBe(80);
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
