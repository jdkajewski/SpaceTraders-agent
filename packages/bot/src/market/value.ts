/**
 * market/value.ts — per-market value score `V(market)` (issue #2, phase 2)
 *
 * A market is only worth scan budget if it's an endpoint of a profitable lane. `V(market)`
 * blends three signals so the scan scheduler can concentrate reads on the markets that earn:
 *
 *   1. REALIZED — decayed net credits attributed to this waypoint by the lane registry
 *      (`marketRealizedValue`). Markets feeding the best observed lanes score high.
 *   2. STRUCTURAL — potential from the market's own structure: `Σ over goods tradeVolume × margin`,
 *      where margin is the best cross-market gap reachable for that good. An EXPORT (buy-low
 *      source) or IMPORT (sell-high sink) with a real spread scores; an all-EXCHANGE, low-volume
 *      market with no spread scores ≈ 0 (a "dead" market we should stop paying to scan).
 *   3. VOLUME — raw `Σ tradeVolume`, a tie-breaker rewarding fat markets that enable bigger lanes
 *      (more cargo/trip ⇒ more credits/request).
 *
 * Pure: `(markets, realizedByWp, weights) → Map<wp, V>`. No clock, no I/O — unit-testable.
 */

import type { Market } from '@st/shared';

export interface ValueWeights {
  /** Weight on realized lane attribution. Default 1. */
  realized: number;
  /** Weight on structural potential (Σ tradeVolume × margin). Default 1. */
  structural: number;
  /** Weight on raw volume (Σ tradeVolume). Default small — a tie-breaker. */
  volume: number;
}

export interface MarketValue {
  realized: number;
  structural: number;
  volume: number;
  /** Weighted blend actually used by the scheduler. */
  score: number;
}

/**
 * Best cross-market margin per good across the supplied markets: the max `sell − buy` where a
 * lower-priced source can be sold higher elsewhere. This is the structural margin a market's
 * goods could realize, independent of whether a lane has been run yet. (Distance-agnostic — the
 * scheduler scores scan VALUE, not route feasibility; lane selection still applies MAXD.)
 */
export function bestMarginByGood(markets: Record<string, Market>): Record<string, number> {
  const byGood: Record<string, Array<{ buy: number; sell: number }>> = {};
  for (const m of Object.values(markets))
    for (const g of m.tradeGoods ?? []) (byGood[g.symbol] = byGood[g.symbol] ?? []).push({ buy: g.purchasePrice, sell: g.sellPrice });
  const out: Record<string, number> = {};
  for (const [sym, es] of Object.entries(byGood)) {
    let best = 0;
    for (const b of es) for (const s of es) if (b.buy > 0 && s.sell > b.buy) best = Math.max(best, s.sell - b.buy);
    out[sym] = best;
  }
  return out;
}

/**
 * Structural potential of a single market: `Σ over its goods tradeVolume × bestMargin(good)`.
 * Only goods with a positive cross-market margin contribute, so an all-EXCHANGE market with no
 * arbitrage (or a market whose goods sit at the global best price) contributes ~0.
 */
export function structuralPotential(market: Market, marginByGood: Record<string, number>): number {
  let sum = 0;
  for (const g of market.tradeGoods ?? []) {
    const margin = marginByGood[g.symbol] ?? 0;
    if (margin > 0) sum += (g.tradeVolume || 0) * margin;
  }
  return sum;
}

/** Raw `Σ tradeVolume` for a market. */
export function marketVolume(market: Market): number {
  let v = 0;
  for (const g of market.tradeGoods ?? []) v += g.tradeVolume || 0;
  return v;
}

/**
 * Score every market. `realizedByWp` comes from {@link import('../trade/laneRegistry.js').LaneRegistry.marketRealizedValue}.
 * Returns a per-waypoint {@link MarketValue}; the scheduler reads `.score`.
 */
export function scoreMarkets(
  markets: Record<string, Market>,
  realizedByWp: Map<string, number>,
  weights: ValueWeights,
): Map<string, MarketValue> {
  const marginByGood = bestMarginByGood(markets);
  const out = new Map<string, MarketValue>();
  for (const [wp, m] of Object.entries(markets)) {
    const realized = realizedByWp.get(wp) ?? 0;
    const structural = structuralPotential(m, marginByGood);
    const volume = marketVolume(m);
    const score = weights.realized * realized + weights.structural * structural + weights.volume * volume;
    out.set(wp, { realized, structural, volume, score: Math.max(0, score) });
  }
  return out;
}
