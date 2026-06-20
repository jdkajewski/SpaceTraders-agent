/**
 * market/scanBudget.ts — explicit global scan-budget priority scheduler (issue #2, phase 5).
 *
 * PR1 gave every market a per-market refresh INTERVAL (`scanScheduler`). But when many markets come
 * due at once, the shared ~2 req/s account budget (the module-global token bucket in the API client)
 * is spent strictly FIFO — `refreshDue` fetches every due market in insertion order, reading dead
 * markets ahead of lane-critical ones and monopolising the budget that latency-sensitive trade/nav
 * requests also need. This module makes the allocation EXPLICIT: a priority queue keyed by
 * value × staleness, drained at the budget the operator allows scans to spend per sweep.
 *
 *   • PRIORITY — `priority = relValue × overrun`. `relValue` is the market's value relative to the
 *     fleet mean (same scale `scanScheduler` uses); `overrun = (now − lastScanAt) / interval` is how
 *     far past due it is (1.0 exactly at due, growing the longer it waits). A never-scanned market
 *     gets a fixed cold-start priority so it's classified promptly without dividing by a zero clock.
 *   • BUDGET — how many `GET /market` reads a sweep may spend, derived from the request rate and the
 *     sweep window so scans never consume the whole 2 req/s (headroom for trades). See {@link scanBudgetPerSweep}.
 *   • ALLOCATION — sort candidates by priority desc, grant the top `budget`, defer the rest to the
 *     next sweep. Deferral is NOT starvation: a deferred market's `overrun` keeps rising every sweep,
 *     so its priority climbs until it is eventually granted. The most-overdue, highest-value markets
 *     are simply served first.
 *
 * Everything here is pure: `(candidates, budget) → allocation`. No clock, no I/O. Unit-testable in
 * isolation; `markets.ts` owns the wiring and the (gated) behaviour change.
 */

/** Coverage-style tier label for the budget metric (independent of coverage.ts; local to scans). */
export type ScanTier = 'hot' | 'warm' | 'cold';

export interface ScanCandidate {
  wp: string;
  /** Market value relative to the fleet mean (score / valueRef). */
  relValue: number;
  /**
   * How far past its due time the market is: `(now − lastScanAt) / interval`. 1.0 exactly at due,
   * > 1 the longer it waits. Use {@link COLD_START_OVERRUN} for a never-scanned market.
   */
  overrun: number;
}

export interface ScanAllocation {
  /** Waypoints to fetch THIS sweep, highest priority first. */
  granted: string[];
  /** Due waypoints held back to a later sweep (priority too low for this sweep's budget). */
  deferred: string[];
  /** Per-tier counts of GRANTED reads (metric: where the budget went). */
  byTier: Record<ScanTier, number>;
  /** Budget applied this sweep (granted.length ≤ budget). */
  budget: number;
}

export interface ScanBudgetOptions {
  /** Account request rate the scan budget is computed against (req/s). Mirrors the client token bucket. */
  reqPerSec: number;
  /** Length of one scan sweep window (ms) — the cadence `refreshDue` runs at. */
  sweepMs: number;
  /** Fraction of the sweep's theoretical request capacity scans may use (0..1]; leaves headroom for trades. */
  fraction: number;
  /** Hard cap on reads per sweep; 0 ⇒ no absolute cap (fraction-derived only). */
  maxPerSweep: number;
}

/** Overrun assigned to a never-scanned market so it sorts above merely-overdue ones (classify promptly). */
export const COLD_START_OVERRUN = 1e6;

/** Relative-value cutoffs (multiples of the fleet mean) used only to bucket the GRANTED metric. */
const HOT_REL = 2;
const WARM_REL = 0.75;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Scan priority for a single market: value × how-overdue. Higher ⇒ fetched sooner. */
export function scanPriority(relValue: number, overrun: number): number {
  // relValue can be ~0 for a dead market; keep priority ≥ 0 and let overrun still rank dead markets
  // among themselves so even they are eventually read (starvation avoidance), just last.
  return Math.max(0, relValue) * Math.max(0, overrun);
}

function tierOf(relValue: number): ScanTier {
  if (relValue >= HOT_REL) return 'hot';
  if (relValue >= WARM_REL) return 'warm';
  return 'cold';
}

/**
 * Per-sweep scan budget: `floor(reqPerSec × sweepSeconds × fraction)`, optionally hard-capped by
 * `maxPerSweep`, never below 1 (always make some progress). The fraction reserves part of the ~2 req/s
 * for trade/nav traffic, so scans can't starve earning requests.
 */
export function scanBudgetPerSweep(opts: ScanBudgetOptions): number {
  const sweepSeconds = Math.max(0, opts.sweepMs) / 1000;
  const capacity = opts.reqPerSec * sweepSeconds * clamp(opts.fraction, 0, 1);
  const fromFraction = Math.floor(capacity);
  const capped = opts.maxPerSweep > 0 ? Math.min(fromFraction, opts.maxPerSweep) : fromFraction;
  return Math.max(1, capped);
}

/**
 * Allocate the per-sweep budget across due markets by priority. Sorts candidates by
 * `scanPriority` desc (ties broken by higher overrun, so the longest-waiting goes first), grants the
 * top `budget`, defers the rest. Returns the granted/deferred split and a per-tier histogram of where
 * the budget was spent.
 *
 * Callers MUST pass only markets that are scannable right now (a ship present/inbound — a `GET /market`
 * on an uncovered market returns no live prices, so budget there is wasted). Presence-gating is the
 * caller's responsibility (see `markets.ts allocateDue`); this function is pure and presence-agnostic.
 */
export function allocateScanBudget(candidates: readonly ScanCandidate[], budget: number): ScanAllocation {
  const ranked = [...candidates].sort((a, b) => {
    const pb = scanPriority(b.relValue, b.overrun);
    const pa = scanPriority(a.relValue, a.overrun);
    if (pb !== pa) return pb - pa;
    return b.overrun - a.overrun; // tie-break: longest-overdue first (helps dead markets eventually run)
  });
  const n = Math.max(0, Math.floor(budget));
  const granted = ranked.slice(0, n);
  const deferred = ranked.slice(n);
  const byTier: Record<ScanTier, number> = { hot: 0, warm: 0, cold: 0 };
  for (const c of granted) byTier[tierOf(c.relValue)] += 1;
  return {
    granted: granted.map((c) => c.wp),
    deferred: deferred.map((c) => c.wp),
    byTier,
    budget: n,
  };
}
