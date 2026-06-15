import { describe, it, expect } from 'vitest';
import { createMarketsService } from '../market/markets.js';
import type { CoordsMap, Market } from '@st/shared';
import type { PersistenceClient, SpaceTradersClient } from '../interfaces.js';

const coords: CoordsMap = { A: [0, 0], B: [10, 0] };

const client = { api: async () => ({ data: {} }) } as unknown as SpaceTradersClient;
const persistence = {
  putMarkets: () => {},
  appendMarketHistory: () => {},
  getMarkets: async () => ({}),
} as unknown as PersistenceClient;

function svc() {
  return createMarketsService({ client, persistence, coords, maxd: 2000 });
}

function marketsWith(sellAtB: number): Record<string, Market> {
  return {
    A: { symbol: 'A', tradeGoods: [{ symbol: 'X', purchasePrice: 100, sellPrice: 90 }] },
    B: { symbol: 'B', tradeGoods: [{ symbol: 'X', purchasePrice: 200, sellPrice: sellAtB }] },
  } as unknown as Record<string, Market>;
}

describe('markets: goodMargins', () => {
  it('finds the best cross-market margin within MAXD', () => {
    // buy X @ A (100) → sell X @ B (180) = 80; reverse is unprofitable.
    expect(svc().goodMargins(marketsWith(180))).toEqual({ X: 80 });
  });

  it('drops pairs beyond MAXD', () => {
    const far = createMarketsService({ client, persistence, coords, maxd: 5 });
    // A↔B distance is 10 > 5 → no qualifying pair.
    expect(far.goodMargins(marketsWith(180))).toEqual({ X: 0 });
  });
});

describe('markets: updateBaselines', () => {
  it('seeds then EMA-smooths the per-good baseline (alpha 0.2)', () => {
    const m = svc();
    m.updateBaselines(marketsWith(180)); // margin 80 → ema 80
    expect(m.goodEMA().get('X')).toBe(80);

    m.updateBaselines(marketsWith(140)); // margin 40 → ema 80·0.8 + 40·0.2 = 72
    expect(m.goodEMA().get('X')).toBeCloseTo(72, 6);
    expect(m.lastMargins()['X']).toBe(40);
  });
});
