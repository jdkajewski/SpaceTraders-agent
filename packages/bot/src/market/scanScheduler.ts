/**
 * market/scanScheduler.ts — value-weighted adaptive scan interval (issue #2, phase 3)
 *
 * Replaces the uniform global market TTL with a PER-MARKET refresh interval driven by value and
 * volatility, the issue's `T(market) = base / (V × volatility)` clamped to `[Tmin, Tmax]`:
 *
 *   • valueFactor = clamp(V / Vref, valMin, valMax) — Vref is this cycle's mean market value, so a
 *     market scores RELATIVE to the fleet. A top-value market refreshes near `Tmin`; a dead market
 *     (V≈0) stretches toward `Tmax` and effectively drops out of the scan budget.
 *   • volFactor   = clamp(1 + gain × volatility, volMin, volMax) — volatility is an EWMA of relative
 *     mid-price change between successive scans, so a churning market refreshes faster, a flat one
 *     slower.
 *
 * A market that has never been scanned is immediately due (scan-once-to-classify). The scheduler is
 * pure aside from the per-market state it owns; `selectDue` + `noteScan` are the only entry points
 * markets.ts needs. `now` is injected for deterministic tests.
 */

import type { Market } from '@st/shared';

export interface ScanSchedulerOptions {
  /** Base interval (ms) — the cadence an average-value, flat market settles at. */
  baseMs: number;
  /** Hard floor on the per-market interval (ms). */
  minMs: number;
  /** Hard ceiling on the per-market interval (ms). */
  maxMs: number;
  /** Clamp on valueFactor = V/Vref. Default [0.1, 10]. */
  valFactorMin: number;
  valFactorMax: number;
  /** EWMA weight for volatility updates (0..1]. */
  volAlpha: number;
  /** Gain mapping relative price change → volatility multiplier. */
  volGain: number;
  /** Clamp on volFactor. Default [0.5, 4]. */
  volFactorMin: number;
  volFactorMax: number;
}

export interface MarketScanState {
  lastScanAt: number;
  /** EWMA of relative mid-price change across scans (0 = unknown/flat). */
  volatility: number;
  /** Last computed interval (ms) — diagnostics. */
  intervalMs: number;
  /** Number of times this market has been scanned. */
  scans: number;
}

export interface ScanScheduler {
  /** Of `wps`, the markets due for a refresh at `now` (never-scanned markets are always due). */
  selectDue(scoreByWp: Map<string, number>, wps: readonly string[], now: number): string[];
  /** Record a completed scan: update volatility from the price delta and reset the due clock. */
  noteScan(wp: string, market: Market, now: number): void;
  /** Computed interval (ms) for a market given its value + this cycle's reference value. */
  intervalFor(score: number, valueRef: number, volatility: number): number;
  /** Reference value (mean of supplied scores) used to normalise valueFactor. */
  valueRef(scoreByWp: Map<string, number>): number;
  /** Per-market state (diagnostics / metric). */
  state(wp: string): MarketScanState | undefined;
  states(): Map<string, MarketScanState>;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const mid = (g: { purchasePrice: number; sellPrice: number }): number => (g.purchasePrice + g.sellPrice) / 2;

/** Mean relative mid-price change between two market reads, over goods present in both. */
export function relativePriceChange(prev: Map<string, number>, market: Market): number {
  let sum = 0;
  let n = 0;
  for (const g of market.tradeGoods ?? []) {
    const before = prev.get(g.symbol);
    if (before === undefined) continue;
    const after = mid(g);
    sum += Math.abs(after - before) / Math.max(1, before);
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

export function createScanScheduler(opts: ScanSchedulerOptions): ScanScheduler {
  const volAlpha = clamp(opts.volAlpha, 0, 1);
  const states = new Map<string, MarketScanState>();
  const prevMids = new Map<string, Map<string, number>>();

  function valueRef(scoreByWp: Map<string, number>): number {
    if (scoreByWp.size === 0) return 1;
    let sum = 0;
    for (const v of scoreByWp.values()) sum += v;
    return Math.max(sum / scoreByWp.size, Number.EPSILON);
  }

  function intervalFor(score: number, valueRef: number, volatility: number): number {
    const valueFactor = clamp(score / valueRef, opts.valFactorMin, opts.valFactorMax);
    const volFactor = clamp(1 + opts.volGain * volatility, opts.volFactorMin, opts.volFactorMax);
    return clamp(opts.baseMs / (valueFactor * volFactor), opts.minMs, opts.maxMs);
  }

  function selectDue(scoreByWp: Map<string, number>, wps: readonly string[], now: number): string[] {
    const ref = valueRef(scoreByWp);
    const due: string[] = [];
    for (const wp of wps) {
      const st = states.get(wp);
      if (!st) {
        due.push(wp); // never scanned → classify it once
        continue;
      }
      const interval = intervalFor(scoreByWp.get(wp) ?? 0, ref, st.volatility);
      st.intervalMs = interval;
      if (now - st.lastScanAt >= interval) due.push(wp);
    }
    return due;
  }

  function noteScan(wp: string, market: Market, now: number): void {
    const prev = prevMids.get(wp);
    const st = states.get(wp) ?? { lastScanAt: 0, volatility: 0, intervalMs: opts.baseMs, scans: 0 };
    if (prev) st.volatility = st.volatility * (1 - volAlpha) + relativePriceChange(prev, market) * volAlpha;
    st.lastScanAt = now;
    st.scans += 1;
    states.set(wp, st);
    const mids = new Map<string, number>();
    for (const g of market.tradeGoods ?? []) mids.set(g.symbol, mid(g));
    prevMids.set(wp, mids);
  }

  return {
    selectDue,
    noteScan,
    intervalFor,
    valueRef,
    state: (wp) => states.get(wp),
    states: () => new Map(states),
  };
}
