/**
 * trade/marketHelpers.ts — small pure market lookups shared by lanes, budget and
 * recovery (ports of bot2.mjs `cheapestSrc` L980, `bestSink` L1234, `findProducerWp`
 * L1724). Kept dependency-free to avoid import cycles between the modules that use them.
 */

import type { Market } from '@st/shared';

/** Cheapest market that SELLS `good` (lowest purchasePrice). bot2 `cheapestSrc`. */
export function cheapestSrc(
  markets: Record<string, Market>,
  good: string,
  excludeWps: Set<string> | null = null,
): { wp: string; px: number; tv: number } | null {
  let wp: string | undefined;
  let px = Infinity;
  let tv = 0;
  for (const [w, m] of Object.entries(markets)) {
    if (excludeWps && excludeWps.has(w)) continue;
    const g = (m.tradeGoods ?? []).find((x) => x.symbol === good);
    if (g && g.purchasePrice > 0 && g.purchasePrice < px) {
      px = g.purchasePrice;
      wp = w;
      tv = g.tradeVolume || 0;
    }
  }
  return wp ? { wp, px, tv } : null;
}

/** Best market that BUYS `good` (highest sellPrice). bot2 `bestSink`. */
export function bestSink(markets: Record<string, Market>, good: string): { wp: string; px: number } | null {
  let wp: string | undefined;
  let px = -Infinity;
  for (const [w, m] of Object.entries(markets)) {
    const g = (m.tradeGoods ?? []).find((x) => x.symbol === good);
    if (g && g.sellPrice > px) {
      px = g.sellPrice;
      wp = w;
    }
  }
  return wp ? { wp, px } : null;
}

/** First waypoint whose market EXPORTs `good`. bot2 `findProducerWp`. */
export function findProducerWp(markets: Record<string, Market>, good: string): string | null {
  for (const [wp, m] of Object.entries(markets))
    if ((m.tradeGoods ?? []).some((x) => x.symbol === good && x.type === 'EXPORT')) return wp;
  return null;
}
