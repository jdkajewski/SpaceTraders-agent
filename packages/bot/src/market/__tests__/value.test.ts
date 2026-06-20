import { describe, it, expect } from 'vitest';
import { bestMarginByGood, structuralPotential, marketVolume, scoreMarkets } from '../value.js';
import type { Market, MarketGood } from '@st/shared';

function good(symbol: string, type: MarketGood['type'], buy: number, sell: number, tv = 20): MarketGood {
  return { symbol, type, tradeVolume: tv, supply: 'MODERATE', purchasePrice: buy, sellPrice: sell };
}
function mkt(symbol: string, goods: MarketGood[]): Market {
  return { symbol, tradeGoods: goods };
}

describe('value: bestMarginByGood', () => {
  it('finds the max cross-market sell − buy gap per good', () => {
    const markets = {
      A: mkt('A', [good('IRON', 'EXPORT', 100, 90)]), // cheap source
      B: mkt('B', [good('IRON', 'IMPORT', 200, 180)]), // expensive sink
    };
    // buy IRON @ A (100) → sell @ B (180) = 80
    expect(bestMarginByGood(markets)['IRON']).toBe(80);
  });

  it('is zero when no profitable direction exists', () => {
    const markets = { A: mkt('A', [good('X', 'EXCHANGE', 100, 95)]), B: mkt('B', [good('X', 'EXCHANGE', 100, 95)]) };
    expect(bestMarginByGood(markets)['X']).toBe(0);
  });
});

describe('value: structuralPotential', () => {
  it('is Σ tradeVolume × bestMargin over profitable goods', () => {
    const markets = {
      A: mkt('A', [good('IRON', 'EXPORT', 100, 90, 30)]),
      B: mkt('B', [good('IRON', 'IMPORT', 200, 180, 10)]),
    };
    const margins = bestMarginByGood(markets); // IRON: 80
    expect(structuralPotential(markets.A, margins)).toBe(2400); // 30 × 80
    expect(structuralPotential(markets.B, margins)).toBe(800); // 10 × 80
  });

  it('scores an all-EXCHANGE, no-arbitrage market at ~0 (dead market)', () => {
    const markets = { A: mkt('A', [good('X', 'EXCHANGE', 100, 95)]), B: mkt('B', [good('X', 'EXCHANGE', 100, 95)]) };
    expect(structuralPotential(markets.A, bestMarginByGood(markets))).toBe(0);
  });
});

describe('value: marketVolume', () => {
  it('sums tradeVolume across goods', () => {
    expect(marketVolume(mkt('A', [good('X', 'EXPORT', 10, 5, 30), good('Y', 'IMPORT', 10, 20, 12)]))).toBe(42);
  });
});

describe('value: scoreMarkets', () => {
  it('blends realized + structural + volume by weight', () => {
    const markets = {
      A: mkt('A', [good('IRON', 'EXPORT', 100, 90, 30)]),
      B: mkt('B', [good('IRON', 'IMPORT', 200, 180, 10)]),
    };
    const realized = new Map([['A', 5000]]);
    const scores = scoreMarkets(markets, realized, { realized: 1, structural: 1, volume: 0 });
    expect(scores.get('A')!.score).toBe(7400); // 5000 realized + 2400 structural
    expect(scores.get('A')!.realized).toBe(5000);
    expect(scores.get('A')!.structural).toBe(2400);
    expect(scores.get('B')!.score).toBe(800); // 0 realized + 800 structural
  });

  it('weights let an operator tune the blend', () => {
    const markets = { A: mkt('A', [good('IRON', 'EXPORT', 100, 90, 30)]), B: mkt('B', [good('IRON', 'IMPORT', 200, 180, 10)]) };
    const scores = scoreMarkets(markets, new Map([['A', 5000]]), { realized: 0, structural: 0, volume: 1 });
    expect(scores.get('A')!.score).toBe(30); // volume only
    expect(scores.get('B')!.score).toBe(10);
  });

  it('floors a score at 0', () => {
    const markets = { A: mkt('A', [good('X', 'EXCHANGE', 100, 95)]) };
    const scores = scoreMarkets(markets, new Map(), { realized: 1, structural: 1, volume: 0 });
    expect(scores.get('A')!.score).toBe(0);
  });
});
