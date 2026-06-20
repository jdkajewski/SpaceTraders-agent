/**
 * trade/laneRegistry.ts — realized lane-profit attribution (issue #2, phase 1)
 *
 * The source of truth for "which lanes actually earn". Every completed trade emits a
 * {@link TradeObservation} (`good`, `buyWp`, `sellWp`, `realized`, `units`, `ts`); this
 * registry folds that stream into a per-lane EWMA of realized net credits, time-decayed so
 * stale lanes fade. From it we derive:
 *
 *   • `topLanes(k)` — the K best lanes by decayed realized value (the lane registry the issue
 *     calls for: `(srcMkt, good, sinkMkt, value, units, lastSeen)`).
 *   • `marketRealizedValue(now)` — per-waypoint realized value: each lane attributes its decayed
 *     value to BOTH endpoints (a market matters only as an endpoint of a profitable lane), so a
 *     waypoint feeding several strong lanes scores high. Consumed by `market/value.ts`.
 *
 * Pure + deterministic (caller supplies `now`), so the scoring is unit-testable without clocks.
 */

import type { TradeObservation } from '@st/shared';

/** A profit lane keyed by (buy waypoint, good, sell waypoint). */
export interface LaneStat {
  /** Stable lane key `${srcWp}|${good}|${sinkWp}`. */
  key: string;
  srcWp: string;
  good: string;
  sinkWp: string;
  /** EWMA of realized net credits per trip (NOT time-decayed; see {@link decayedValue}). */
  ewmaNet: number;
  /** EWMA of units moved per trip — proxy for lane throughput. */
  ewmaUnits: number;
  /** Completed trips folded into this lane. */
  trips: number;
  /** Epoch ms of the most recent observation. */
  lastSeen: number;
}

/** A lane snapshot with its time-decayed value resolved at a given `now`. */
export interface RankedLane extends LaneStat {
  /** `ewmaNet` after half-life decay for staleness at the query time. */
  value: number;
}

export interface LaneRegistryOptions {
  /** EWMA weight for a fresh observation (0..1]; higher = more reactive. Default 0.3. */
  alpha: number;
  /** Half-life (ms) for staleness decay of a lane's value. Default 30 min. */
  halfLifeMs: number;
}

export interface LaneRegistry {
  /** Fold one completed trade into its lane. */
  ingest(obs: TradeObservation): void;
  /** Fold a batch (e.g. replaying persisted observations at boot). */
  ingestMany(rows: readonly TradeObservation[]): void;
  /** Top-K lanes by decayed value at `now`, descending. Excludes non-positive-value lanes. */
  topLanes(k: number, now: number): RankedLane[];
  /** Per-waypoint decayed realized value at `now` (each lane credits both endpoints). */
  marketRealizedValue(now: number): Map<string, number>;
  /** Raw lane stats (mainly for tests / diagnostics). */
  lanes(): LaneStat[];
}

const laneKey = (srcWp: string, good: string, sinkWp: string): string => `${srcWp}|${good}|${sinkWp}`;

/** Multiplicative half-life decay: 1 at age 0, 0.5 at age = halfLife. */
function decayFactor(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  if (halfLifeMs <= 0) return ageMs > 0 ? 0 : 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/** A lane's realized value after staleness decay relative to `now`. */
function decayedValue(l: LaneStat, now: number, halfLifeMs: number): number {
  return l.ewmaNet * decayFactor(now - l.lastSeen, halfLifeMs);
}

export function createLaneRegistry(opts: LaneRegistryOptions): LaneRegistry {
  const alpha = Math.min(1, Math.max(0, opts.alpha));
  const halfLifeMs = opts.halfLifeMs;
  const stats = new Map<string, LaneStat>();

  function ingest(obs: TradeObservation): void {
    const { buyWp, good, sellWp } = obs;
    if (!buyWp || !sellWp || !good) return; // ignore malformed rows
    const at = Date.parse(obs.ts);
    const ts = Number.isFinite(at) ? at : Date.now();
    const realized = Number.isFinite(obs.realized) ? obs.realized : 0;
    const units = Number.isFinite(obs.units) ? obs.units : 0;
    const key = laneKey(buyWp, good, sellWp);
    const cur = stats.get(key);
    if (!cur) {
      stats.set(key, { key, srcWp: buyWp, good, sinkWp: sellWp, ewmaNet: realized, ewmaUnits: units, trips: 1, lastSeen: ts });
      return;
    }
    cur.ewmaNet = cur.ewmaNet * (1 - alpha) + realized * alpha;
    cur.ewmaUnits = cur.ewmaUnits * (1 - alpha) + units * alpha;
    cur.trips += 1;
    cur.lastSeen = Math.max(cur.lastSeen, ts);
  }

  function ingestMany(rows: readonly TradeObservation[]): void {
    for (const r of rows) ingest(r);
  }

  function topLanes(k: number, now: number): RankedLane[] {
    const ranked: RankedLane[] = [];
    for (const l of stats.values()) {
      const value = decayedValue(l, now, halfLifeMs);
      if (value > 0) ranked.push({ ...l, value });
    }
    ranked.sort((a, b) => b.value - a.value);
    return k > 0 ? ranked.slice(0, k) : ranked;
  }

  function marketRealizedValue(now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const l of stats.values()) {
      const value = decayedValue(l, now, halfLifeMs);
      if (value <= 0) continue; // a money-losing/stale lane shouldn't keep its endpoints hot
      out.set(l.srcWp, (out.get(l.srcWp) ?? 0) + value);
      out.set(l.sinkWp, (out.get(l.sinkWp) ?? 0) + value);
    }
    return out;
  }

  return {
    ingest,
    ingestMany,
    topLanes,
    marketRealizedValue,
    lanes: () => [...stats.values()],
  };
}
