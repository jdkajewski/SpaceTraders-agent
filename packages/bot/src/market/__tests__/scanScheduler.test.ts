import { describe, it, expect } from 'vitest';
import { createScanScheduler, relativePriceChange, type ScanSchedulerOptions } from '../scanScheduler.js';
import type { Market, MarketGood } from '@st/shared';

const OPTS: ScanSchedulerOptions = {
  baseMs: 1000,
  minMs: 100,
  maxMs: 10_000,
  valFactorMin: 0.1,
  valFactorMax: 10,
  volAlpha: 0.5,
  volGain: 10,
  volFactorMin: 0.5,
  volFactorMax: 4,
};

function good(symbol: string, buy: number, sell: number): MarketGood {
  return { symbol, type: 'EXPORT', tradeVolume: 20, supply: 'MODERATE', purchasePrice: buy, sellPrice: sell };
}
function mkt(symbol: string, goods: MarketGood[]): Market {
  return { symbol, tradeGoods: goods };
}

describe('scanScheduler: intervalFor', () => {
  const s = createScanScheduler(OPTS);

  it('an average-value, flat market settles at the base interval', () => {
    expect(s.intervalFor(100, 100, 0)).toBe(1000);
  });

  it('a high-value market refreshes near the floor', () => {
    // valueFactor = clamp(10000/100, .1, 10) = 10 → 1000/10 = 100 (= min)
    expect(s.intervalFor(10_000, 100, 0)).toBe(100);
  });

  it('a dead (zero-value) market stretches toward the ceiling', () => {
    // valueFactor = clamp(0, .1, 10) = 0.1 → 1000/0.1 = 10000 (= max)
    expect(s.intervalFor(0, 100, 0)).toBe(10_000);
  });

  it('volatility shortens the interval', () => {
    // volFactor = clamp(1 + 10*0.2, .5, 4) = 3 → 1000/3 ≈ 333
    expect(s.intervalFor(100, 100, 0.2)).toBeCloseTo(1000 / 3, 6);
  });

  it('clamps to [minMs, maxMs]', () => {
    expect(s.intervalFor(1e9, 1, 1)).toBe(100); // never below min
    expect(s.intervalFor(0, 1e9, 0)).toBe(10_000); // never above max
  });
});

describe('scanScheduler: valueRef', () => {
  it('is the mean of the supplied scores', () => {
    const s = createScanScheduler(OPTS);
    expect(s.valueRef(new Map([['A', 100], ['B', 300]]))).toBe(200);
  });
  it('falls back to 1 for an empty score set', () => {
    expect(createScanScheduler(OPTS).valueRef(new Map())).toBe(1);
  });
});

describe('scanScheduler: selectDue', () => {
  it('marks never-scanned markets due (scan-once-to-classify)', () => {
    const s = createScanScheduler(OPTS);
    const due = s.selectDue(new Map([['A', 100], ['B', 100]]), ['A', 'B'], 0);
    expect(due.sort()).toEqual(['A', 'B']);
  });

  it('is not due again until its interval elapses', () => {
    const s = createScanScheduler(OPTS);
    const scores = new Map([['A', 100]]);
    s.selectDue(scores, ['A'], 0);
    s.noteScan('A', mkt('A', [good('IRON', 100, 200)]), 0); // interval at avg value = base = 1000
    expect(s.selectDue(scores, ['A'], 500)).toEqual([]); // 500 < 1000
    expect(s.selectDue(scores, ['A'], 1000)).toEqual(['A']); // due at 1000
  });

  it('refreshes a high-value market more often than a low-value one', () => {
    const s = createScanScheduler(OPTS);
    const scores = new Map([['HOT', 10_000], ['COLD', 1]]);
    s.selectDue(scores, ['HOT', 'COLD'], 0);
    s.noteScan('HOT', mkt('HOT', [good('IRON', 100, 200)]), 0);
    s.noteScan('COLD', mkt('COLD', [good('IRON', 100, 200)]), 0);
    // valueRef = mean = ~5000 → HOT interval ~500ms, COLD interval at the ceiling (10000ms).
    // at t=600 HOT is due again; COLD is nowhere near due.
    const due = s.selectDue(scores, ['HOT', 'COLD'], 600);
    expect(due).toEqual(['HOT']);
  });
});

describe('scanScheduler: noteScan + volatility', () => {
  it('updates volatility from the price delta between scans', () => {
    const s = createScanScheduler(OPTS);
    s.noteScan('A', mkt('A', [good('IRON', 100, 200)]), 0); // mid 150, no prev → vol stays 0
    expect(s.state('A')!.volatility).toBe(0);
    s.noteScan('A', mkt('A', [good('IRON', 120, 240)]), 1000); // mid 180 → relChange 0.2, ema 0*.5 + .2*.5 = .1
    expect(s.state('A')!.volatility).toBeCloseTo(0.1, 6);
    expect(s.state('A')!.scans).toBe(2);
    expect(s.state('A')!.lastScanAt).toBe(1000);
  });
});

describe('scanScheduler: relativePriceChange', () => {
  it('is the mean |Δmid|/mid over goods present in both reads', () => {
    const prev = new Map([['IRON', 150]]); // mid
    expect(relativePriceChange(prev, mkt('A', [good('IRON', 120, 240)]))).toBeCloseTo(0.2, 6); // |180-150|/150
  });
  it('is 0 when no goods overlap', () => {
    expect(relativePriceChange(new Map(), mkt('A', [good('IRON', 120, 240)]))).toBe(0);
  });
});
