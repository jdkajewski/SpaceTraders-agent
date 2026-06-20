/**
 * market/coverage.ts — value-driven coverage tiering + REVERSIBLE pruning + cold re-check
 * (issue #2, phases 4 + 7, as one coherent adaptive unit).
 *
 * A `GET /market` only returns live prices when a SHIP IS PRESENT, so scan budget can only be
 * spent on COVERED markets (a parked probe / a docked trader). Today `fleet/scale.ts` drives toward
 * ~1 probe per market uniformly and never moves a probe — paying full coverage cost for dead markets.
 * This module is the pure brain that lets coverage follow VALUE instead:
 *
 *   • TIERING — each market is HOT / WARM / COLD / DEAD from its value score relative to the fleet
 *     mean (`valueRef`). Used for the metric and the prune/keep decision.
 *   • VALUE-DRIVEN TARGET — how many probes are worth parking, derived from LIVE signals (active
 *     lanes, fleet size) rather than the market count. As the operation matures (more lanes, bigger
 *     fleet) the target grows, so coverage widens over the game lifecycle — phase-adaptive, not a
 *     hardcoded early/mid/late assumption.
 *   • REVERSIBLE PRUNING — a probe on a DEAD market can be redeployed to a higher-value uncovered
 *     market. The vacated market is NOT forgotten: it keeps a value-decaying re-check schedule.
 *   • COLD RE-CHECK — every uncovered market is re-visit-due again within `recheck.maxMs` at the
 *     latest (a market that still looks promising from stale data sooner). So a market that's dead
 *     early but becomes a critical lane endpoint late WILL be re-evaluated and promoted back.
 *
 * Everything here is pure: `(scores, coverage, signals, now) → plan`. No clock, no I/O, no fleet
 * mutation — that lives in `fleet/scale.ts`, gated behind config levers. Unit-testable in isolation.
 */

export type CoverageTier = 'HOT' | 'WARM' | 'COLD' | 'DEAD';

/** Relative-value cutoffs (multiples of `valueRef`) separating the tiers. */
export interface CoverageWeights {
  /** rel ≥ hotMult ⇒ HOT. */
  hotMult: number;
  /** rel ≥ warmMult ⇒ WARM. */
  warmMult: number;
  /** rel ≥ coldMult ⇒ COLD; below ⇒ DEAD. */
  coldMult: number;
}

/** Live signals that make the coverage target phase-adaptive (no hardcoded early/mid/late). */
export interface PhaseSignals {
  /** Total ships in the fleet — a proxy for operation scale. */
  fleetSize: number;
  /** Number of currently-profitable lanes — the strongest "game phase / maturity" signal. */
  activeLanes: number;
  /** Known markets (the absolute coverage ceiling). */
  marketCount: number;
}

export interface CoverageTargetOptions {
  /** Floor of the value-driven target before signal bonuses. */
  base: number;
  /** Extra covered markets allowed per active lane (maturity → wider coverage). */
  laneBonus: number;
  /** Extra covered markets allowed per ship in the fleet. */
  fleetBonus: number;
  /** Never cover fewer than this many markets (safety — keep the engine fed at cold start). */
  min: number;
  /** Hard probe cap (FLEET_MAX_PROBES); 0 ⇒ uncapped (ceiling is marketCount). */
  maxProbes: number;
}

export interface RecheckOptions {
  /** Base cold re-check interval (ms) at rel = 1. */
  baseMs: number;
  /** Floor — even a promising uncovered market isn't re-visited faster than this. */
  minMs: number;
  /** Ceiling — even the deadest market is re-visited at least this often (NEVER forgotten). */
  maxMs: number;
}

export interface CoveragePlanInput {
  /** Per-market value score (from `value.ts` via the markets service). */
  scoreByWp: Map<string, number>;
  /** Fleet-mean value used to normalise scores into a relative scale. */
  valueRef: number;
  /** Markets currently covered (a ship present or inbound). */
  covered: ReadonlySet<string>;
  /** Last time each market was actually read (from the scan scheduler); absent ⇒ never. */
  lastScanAtByWp: Map<string, number>;
  now: number;
  /** Value-driven probe target (see {@link coverageTarget}). */
  target: number;
  weights: CoverageWeights;
  recheck: RecheckOptions;
}

export interface CoveragePlan {
  /** Tier of every scored market. */
  tierByWp: Map<string, CoverageTier>;
  /** The markets worth covering: top `target` non-DEAD markets by value. */
  shouldCover: string[];
  /** Uncovered markets that should be covered → place/redeploy a probe here (PROMOTE). */
  toCover: string[];
  /** Covered DEAD markets that are out of the target set → redeploy their probe (PRUNE, reversible). */
  toPrune: string[];
  /** Uncovered markets whose value-decaying re-check interval has elapsed (re-visit to re-evaluate). */
  recheckDue: string[];
  /** Tier histogram (metric). */
  counts: Record<CoverageTier, number>;
  /** Markets we DON'T pay to cover vs. the legacy 1:1 baseline (the headline reduction). */
  probesSaved: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Classify a market by its value relative to the fleet mean. */
export function classifyTier(relValue: number, w: CoverageWeights): CoverageTier {
  if (relValue >= w.hotMult) return 'HOT';
  if (relValue >= w.warmMult) return 'WARM';
  if (relValue >= w.coldMult) return 'COLD';
  return 'DEAD';
}

/**
 * Value-driven probe target: `base + laneBonus×activeLanes + fleetBonus×fleetSize`, clamped to
 * `[min, cap]` where `cap = min(maxProbes||∞, marketCount)`. Grows as lanes/fleet grow, so coverage
 * widens through the game lifecycle while never exceeding the markets that exist.
 */
export function coverageTarget(signals: PhaseSignals, opts: CoverageTargetOptions): number {
  const ceiling = opts.maxProbes > 0 ? Math.min(opts.maxProbes, signals.marketCount) : signals.marketCount;
  if (ceiling <= 0) return 0;
  const raw = opts.base + opts.laneBonus * Math.max(0, signals.activeLanes) + opts.fleetBonus * Math.max(0, signals.fleetSize);
  return clamp(Math.round(raw), Math.min(opts.min, ceiling), ceiling);
}

/**
 * Cold re-check interval for an uncovered market: `clamp(baseMs / max(rel, ε), minMs, maxMs)`. A
 * still-promising uncovered market (high rel) is re-visited sooner; a dead one (rel→0) stretches to
 * `maxMs` but NEVER to infinity — nothing is permanently dropped.
 */
export function recheckIntervalMs(relValue: number, opts: RecheckOptions): number {
  const rel = Math.max(relValue, 1e-6);
  return clamp(opts.baseMs / rel, opts.minMs, opts.maxMs);
}

/**
 * Build the coverage plan. Pure: ranks markets by value, tiers them, picks the top-`target`
 * *coverable* set as "should cover", and derives the promote / prune / re-check action lists.
 *
 * Cold-start safety: a market that has NEVER been read is UNKNOWN, not DEAD — its score is 0 only
 * because we've never looked. Such markets stay coverable (scan-once-to-classify) and are never
 * pruned, so an empty-data fleet still spreads out, reads, and classifies before concentrating.
 * Known HOT/WARM markets sort ahead of unknowns, so real winners are covered first and leftover
 * budget classifies the unknowns.
 *
 * Hysteresis: only a market we've actually read and found DEAD is pruned (not merely "below
 * target"), so a WARM/COLD market that temporarily drops out of the target keeps its probe and
 * doesn't thrash, and an unread market is never redeployed before we've classified it.
 */
export function planCoverage(input: CoveragePlanInput): CoveragePlan {
  const { scoreByWp, valueRef, covered, lastScanAtByWp, now, target, weights, recheck } = input;
  const ref = valueRef > 0 ? valueRef : 1;
  const scanned = (wp: string): boolean => lastScanAtByWp.has(wp);

  const entries = [...scoreByWp.entries()]
    .map(([wp, score]) => ({ wp, score, rel: score / ref }))
    .sort((a, b) => b.score - a.score);

  const tierByWp = new Map<string, CoverageTier>();
  const counts: Record<CoverageTier, number> = { HOT: 0, WARM: 0, COLD: 0, DEAD: 0 };
  for (const e of entries) {
    const tier = classifyTier(e.rel, weights);
    tierByWp.set(e.wp, tier);
    counts[tier] += 1;
  }

  // A market is worth covering if it isn't a KNOWN dead market: either it tiers above DEAD, or we've
  // never read it (unknown ⇒ classify it). Take the highest-value such markets up to the target.
  const coverable = (wp: string): boolean => tierByWp.get(wp) !== 'DEAD' || !scanned(wp);
  const shouldCover = entries.filter((e) => coverable(e.wp)).slice(0, Math.max(0, target)).map((e) => e.wp);
  const shouldSet = new Set(shouldCover);

  const toCover = shouldCover.filter((wp) => !covered.has(wp));
  // Reversible prune: redeploy a probe only off a market we've READ and found DEAD and dropped from
  // the target. Never prune an unread market (let it be classified first).
  const toPrune = [...covered].filter((wp) => !shouldSet.has(wp) && tierByWp.get(wp) === 'DEAD' && scanned(wp));

  const recheckDue = entries
    .filter((e) => !covered.has(e.wp))
    .filter((e) => {
      const last = lastScanAtByWp.get(e.wp);
      if (last === undefined) return true; // never read → due
      return now - last >= recheckIntervalMs(e.rel, recheck);
    })
    .map((e) => e.wp);

  return {
    tierByWp,
    shouldCover,
    toCover,
    toPrune,
    recheckDue,
    counts,
    probesSaved: Math.max(0, scoreByWp.size - shouldCover.length),
  };
}
