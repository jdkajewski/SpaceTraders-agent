/**
 * replay.calibration.test.ts — replay the value-weighted cores over REAL production data.
 *
 * Fixture below is the realized-lane distribution parsed from 13.45h of the live UPRISING (.mjs)
 * agent (phase PORTAL_OPEN, 226 ships) — see the orchestrator's `live-metrics.json` bundle
 * (`collect-metrics.mjs`, re-runnable). Zero API calls were spent to gather it (log + status parse).
 *
 * The point of this test is to PROVE THE WIN on real numbers, not just on synthetic toys: feeding the
 * real realized-net distribution through the pure cores (`laneRegistry` → `value.scoreMarkets` →
 * `scanScheduler.intervalFor` → `scanBudget.allocateScanBudget`) must produce a refresh cadence that
 * is (a) MONOTONIC in realized value and (b) FAR MORE DIFFERENTIATED than the observed near-uniform
 * ~24.65 refreshes/market the production bot actually ran. That differentiation — concentrating reads
 * on lane-critical markets and starving dead ones — is the entire thesis of issue #2.
 */

import { describe, it, expect } from 'vitest';
import { createLaneRegistry } from '../../trade/laneRegistry.js';
import { scoreMarkets } from '../value.js';
import { createScanScheduler } from '../scanScheduler.js';
import { allocateScanBudget, scanBudgetPerSweep, type ScanCandidate } from '../scanBudget.js';
import type { Market, TradeObservation } from '@st/shared';

// ── REAL fixture: topSinksByNet from live-metrics.json (sink, completed lanes, avg realized net) ──
const REAL_SINKS: ReadonlyArray<{ sink: string; lanes: number; avgNet: number }> = [
  { sink: '-A1', lanes: 68, avgNet: 43807 },
  { sink: 'Z9C', lanes: 30, avgNet: 49381 },
  { sink: '22A', lanes: 28, avgNet: 44199 },
  { sink: 'K82', lanes: 22, avgNet: 47571 },
  { sink: 'D41', lanes: 16, avgNet: 63914 },
  { sink: '37C', lanes: 40, avgNet: 24518 },
  { sink: '11X', lanes: 15, avgNet: 54696 },
  { sink: '-A2', lanes: 11, avgNet: 53303 },
  { sink: 'F8B', lanes: 7, avgNet: 70401 },
  { sink: '10X', lanes: 12, avgNet: 30315 },
  { sink: 'D40', lanes: 9, avgNet: 34889 },
  { sink: 'D46', lanes: 4, avgNet: 73800 },
];

// Observed dead-lane rate (negativeLaneShare) and near-uniform scan spread, from the same bundle.
const NEGATIVE_LANE_SHARE = 0.155;
const OBSERVED_AVG_REFRESHES = 24.65; // avgRefreshesPerMarket — the ~uniform baseline we beat

const NOW = 1_700_000_000_000; // fixed clock → ingest with ts = NOW so no staleness decay in replay

/** Mint a completed-trade observation for one lane endpoint pair. */
function obs(sink: string, net: number, units: number): TradeObservation {
  return {
    ts: new Date(NOW).toISOString(),
    ship: 'REPLAY',
    good: 'G',
    buyWp: `SRC-${sink}`,
    sellWp: `SINK-${sink}`,
    projected: net,
    realized: net,
    units,
    buyPx: 0,
    sellPx: net,
  };
}

/** Build the registry + scored markets for the real sinks plus a dead tail of never-traded markets. */
function buildReplay(deadCount: number) {
  const registry = createLaneRegistry({ alpha: 0.3, halfLifeMs: 1_800_000 });
  for (const s of REAL_SINKS) for (let i = 0; i < s.lanes; i += 1) registry.ingest(obs(s.sink, s.avgNet, 100));

  // Markets Record: every endpoint we want scored needs an entry (scoreMarkets iterates it). Empty
  // tradeGoods isolates the REALIZED path — exactly the lane-attribution signal the real data carries.
  const markets: Record<string, Market> = {};
  for (const s of REAL_SINKS) {
    markets[`SINK-${s.sink}`] = { symbol: `SINK-${s.sink}`, tradeGoods: [] } as unknown as Market;
    markets[`SRC-${s.sink}`] = { symbol: `SRC-${s.sink}`, tradeGoods: [] } as unknown as Market;
  }
  for (let i = 0; i < deadCount; i += 1)
    markets[`DEAD-${i}`] = { symbol: `DEAD-${i}`, tradeGoods: [] } as unknown as Market;

  const scored = scoreMarkets(markets, registry.marketRealizedValue(NOW), { realized: 1, structural: 0, volume: 0 });
  const scoreByWp = new Map<string, number>();
  for (const [wp, v] of scored) scoreByWp.set(wp, v.score);
  return { registry, markets, scoreByWp };
}

describe('replay calibration: value-weighted scan cadence vs the observed uniform baseline', () => {
  // Defaults under test (config.ts SCAN_*): base 75s, floor 30s, ceiling 600s → 20:1 dynamic range.
  const sched = () =>
    createScanScheduler({
      baseMs: 75_000,
      minMs: 30_000,
      maxMs: 600_000,
      valFactorMin: 0.1,
      valFactorMax: 10,
      volAlpha: 0.3,
      volGain: 10,
      volFactorMin: 0.5,
      volFactorMax: 4,
    });

  it('reproduces the real per-market realized value (lane net attributes to both endpoints)', () => {
    const { registry } = buildReplay(0);
    const realized = registry.marketRealizedValue(NOW);
    // Each sink's value ≈ its observed avgNet (constant-input EWMA, no decay at NOW).
    for (const s of REAL_SINKS) expect(realized.get(`SINK-${s.sink}`)).toBeCloseTo(s.avgNet, 0);
    // Top realized sink is the highest-avgNet lane endpoint (D46 @ 73,800).
    const topSink = [...REAL_SINKS].sort((a, b) => b.avgNet - a.avgNet)[0]!;
    expect(topSink.sink).toBe('D46');
  });

  it('drives a refresh cadence that is MONOTONIC in realized value (volatility held flat)', () => {
    const { scoreByWp } = buildReplay(20);
    const s = sched();
    const ref = s.valueRef(scoreByWp);
    const interval = (wp: string): number => s.intervalFor(scoreByWp.get(wp) ?? 0, ref, 0);

    // Sinks sorted by realized value DESC → their intervals must be non-increasing (more value ⇒
    // shorter interval ⇒ more refreshes). No inversion anywhere along the real distribution.
    const sinksByValue = [...REAL_SINKS].sort((a, b) => b.avgNet - a.avgNet).map((x) => `SINK-${x.sink}`);
    for (let i = 1; i < sinksByValue.length; i += 1)
      expect(interval(sinksByValue[i]!)).toBeGreaterThanOrEqual(interval(sinksByValue[i - 1]!) - 1e-6);

    // A dead (never-traded) market must refresh strictly less often than any real sink.
    const deadInterval = interval('DEAD-0');
    for (const wp of sinksByValue) expect(interval(wp)).toBeLessThan(deadInterval);
  });

  it('concentrates reads FAR more than the observed ~uniform 24.65 refreshes/market', () => {
    const { scoreByWp, markets } = buildReplay(40);
    const s = sched();
    const ref = s.valueRef(scoreByWp);
    const windowMs = 13.45 * 3600_000; // same 13.45h window as the live sample

    // Project each market's refresh COUNT over the window from its value-driven interval.
    const counts = Object.keys(markets).map((wp) => windowMs / s.intervalFor(scoreByWp.get(wp) ?? 0, ref, 0));
    const hot = Math.max(...counts);
    const cold = Math.min(...counts);

    // 1) Hot markets get an order of magnitude more reads than dead ones — the 20:1 clamp range
    //    realised on REAL value spread. The uniform baseline's hot:cold ratio is ~1.
    expect(hot / cold).toBeGreaterThanOrEqual(10);

    // 2) Differentiation: coefficient of variation of the projected refresh counts is large, whereas a
    //    uniform scheduler (every market = OBSERVED_AVG_REFRESHES) has CV 0.
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const sd = Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length);
    expect(sd / mean).toBeGreaterThan(0.3);

    // 3) Sanity vs the real baseline: the hottest real sink is read MANY× more per window than the
    //    flat 24.65 the production bot actually spent on the average market.
    expect(hot).toBeGreaterThan(OBSERVED_AVG_REFRESHES * 5);
  });

  it('spends a constrained scan budget on the high-value markets, deferring the dead tail', () => {
    const { scoreByWp } = buildReplay(40);
    const s = sched();
    const ref = s.valueRef(scoreByWp);

    // A synchronized due-burst: every market wants a read this sweep (cold-start staleness).
    const candidates: ScanCandidate[] = [...scoreByWp.keys()].map((wp) => ({
      wp,
      relValue: (scoreByWp.get(wp) ?? 0) / ref,
      overrun: 1,
    }));
    // Budget at the calibrated defaults: 2 req/s × 10s sweep × 0.4 = 8 reads.
    const budget = scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 10_000, fraction: 0.4, maxPerSweep: 0 });
    expect(budget).toBe(8);

    const alloc = allocateScanBudget(candidates, budget);
    expect(alloc.granted.length).toBe(budget);
    // No dead market wins budget while value-bearing sinks are still due — budget never leaks onto 0-value reads.
    for (const wp of alloc.granted) expect(wp.startsWith('DEAD-')).toBe(false);
    // The grant skews HOT (lane-critical), proving value-first spend rather than FIFO.
    expect(alloc.byTier.hot).toBeGreaterThan(0);
    expect(alloc.byTier.hot).toBeGreaterThanOrEqual(alloc.byTier.cold);
  });

  it('classifies a dead tail comparable to the real 15.5% negative-lane share into the cheapest cadence', () => {
    // Size the dead tail to the observed dead-lane rate among a real-sized market set, then confirm the
    // scheduler parks those markets at the SCAN_MAX ceiling (cheapest cadence) — the DEAD-tier intent.
    const sinkMarkets = REAL_SINKS.length * 2; // SINK-* + SRC-*
    const deadCount = Math.round((sinkMarkets / (1 - NEGATIVE_LANE_SHARE)) * NEGATIVE_LANE_SHARE);
    const { scoreByWp, markets } = buildReplay(deadCount);
    const s = sched();
    const ref = s.valueRef(scoreByWp);
    const atCeiling = Object.keys(markets).filter(
      (wp) => s.intervalFor(scoreByWp.get(wp) ?? 0, ref, 0) >= 600_000 - 1,
    );
    // Every dead market lands at the ceiling; the share is in the right ballpark (non-trivial, < half).
    expect(atCeiling.length).toBe(deadCount);
    const deadShare = deadCount / Object.keys(markets).length;
    expect(deadShare).toBeGreaterThan(0.05);
    expect(deadShare).toBeLessThan(0.4);
  });
});
