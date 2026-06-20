import { describe, it, expect } from 'vitest';
import {
  classifyTier,
  coverageTarget,
  recheckIntervalMs,
  planCoverage,
  type CoverageWeights,
  type RecheckOptions,
} from '../coverage.js';

const W: CoverageWeights = { hotMult: 2, warmMult: 0.75, coldMult: 0.2 };
const RC: RecheckOptions = { baseMs: 1_800_000, minMs: 600_000, maxMs: 21_600_000 };

describe('coverage: classifyTier', () => {
  it('separates HOT/WARM/COLD/DEAD by relative value', () => {
    expect(classifyTier(3, W)).toBe('HOT');
    expect(classifyTier(2, W)).toBe('HOT');
    expect(classifyTier(1, W)).toBe('WARM');
    expect(classifyTier(0.75, W)).toBe('WARM');
    expect(classifyTier(0.5, W)).toBe('COLD');
    expect(classifyTier(0.2, W)).toBe('COLD');
    expect(classifyTier(0.05, W)).toBe('DEAD');
    expect(classifyTier(0, W)).toBe('DEAD');
  });
});

describe('coverage: coverageTarget (phase-adaptive)', () => {
  const opts = { base: 3, laneBonus: 1, fleetBonus: 0.5, min: 3, maxProbes: 0 };

  it('grows with active lanes and fleet size (maturity → wider coverage)', () => {
    const early = coverageTarget({ fleetSize: 2, activeLanes: 0, marketCount: 50 }, opts); // 3 + 0 + 1 = 4
    const mid = coverageTarget({ fleetSize: 6, activeLanes: 4, marketCount: 50 }, opts); // 3 + 4 + 3 = 10
    const late = coverageTarget({ fleetSize: 12, activeLanes: 12, marketCount: 50 }, opts); // 3 + 12 + 6 = 21
    expect(early).toBe(4);
    expect(mid).toBe(10);
    expect(late).toBe(21);
    expect(late).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(early);
  });

  it('never exceeds the market count', () => {
    expect(coverageTarget({ fleetSize: 100, activeLanes: 100, marketCount: 5 }, opts)).toBe(5);
  });

  it('respects an explicit FLEET_MAX_PROBES cap', () => {
    expect(coverageTarget({ fleetSize: 100, activeLanes: 100, marketCount: 50 }, { ...opts, maxProbes: 8 })).toBe(8);
  });

  it('honours the minimum floor at cold start', () => {
    expect(coverageTarget({ fleetSize: 0, activeLanes: 0, marketCount: 50 }, { ...opts, base: 0 })).toBe(3);
  });

  it('is zero when there are no markets', () => {
    expect(coverageTarget({ fleetSize: 5, activeLanes: 5, marketCount: 0 }, opts)).toBe(0);
  });
});

describe('coverage: recheckIntervalMs (value-decaying, never infinite)', () => {
  it('re-checks a promising uncovered market sooner than a dead one', () => {
    const promising = recheckIntervalMs(2, RC);
    const dead = recheckIntervalMs(0.001, RC);
    expect(promising).toBeLessThan(dead);
  });

  it('clamps to [minMs, maxMs] — a dead market is still re-checked (never forgotten)', () => {
    expect(recheckIntervalMs(1000, RC)).toBe(RC.minMs); // very hot → floored
    expect(recheckIntervalMs(0, RC)).toBe(RC.maxMs); // dead → ceiling, NOT infinity
  });
});

describe('coverage: planCoverage', () => {
  const base = {
    valueRef: 100,
    weights: W,
    recheck: RC,
    now: 10_000_000,
  };

  it('promotes the highest-value uncovered markets up to target', () => {
    const scoreByWp = new Map([
      ['A', 500], // HOT
      ['B', 300], // HOT
      ['C', 80], // WARM
      ['D', 5], // DEAD
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set<string>(),
      lastScanAtByWp: new Map(),
      target: 2,
    });
    expect(plan.shouldCover).toEqual(['A', 'B']); // top-2 non-dead by value
    expect(plan.toCover).toEqual(['A', 'B']);
    expect(plan.tierByWp.get('A')).toBe('HOT');
    expect(plan.tierByWp.get('C')).toBe('WARM');
    expect(plan.tierByWp.get('D')).toBe('DEAD');
    expect(plan.counts).toEqual({ HOT: 2, WARM: 1, COLD: 0, DEAD: 1 });
  });

  it('never includes a known-DEAD market in shouldCover even if target has room', () => {
    const scoreByWp = new Map([
      ['A', 500],
      ['D', 5], // DEAD
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set(),
      lastScanAtByWp: new Map([['D', base.now - 1000]]), // D has been READ and found dead
      target: 5,
    });
    expect(plan.shouldCover).toEqual(['A']); // D excluded despite room
    expect(plan.probesSaved).toBe(1); // 2 markets − 1 covered
  });

  it('keeps a never-read market coverable (cold start: scan-once-to-classify)', () => {
    const scoreByWp = new Map([
      ['A', 500], // HOT, known
      ['U', 0], // unknown — never read, score 0
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set(),
      lastScanAtByWp: new Map(), // nothing read yet
      target: 5,
    });
    expect(plan.shouldCover).toContain('U'); // unknown stays coverable until classified
    expect(plan.toPrune).toEqual([]); // and is never pruned before being read
  });

  it('prunes ONLY a covered known-DEAD market that is out of target (reversible redeploy)', () => {
    const scoreByWp = new Map([
      ['A', 500], // HOT, covered, kept
      ['D', 5], // DEAD, covered → prune
      ['C', 80], // WARM, covered, out of target but NOT dead → kept (hysteresis)
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set(['A', 'D', 'C']),
      lastScanAtByWp: new Map([['D', base.now - 1000]]), // D has been read and found dead
      target: 1, // only A should be covered
    });
    expect(plan.shouldCover).toEqual(['A']);
    expect(plan.toPrune).toEqual(['D']); // dead + out of target + read
    expect(plan.toPrune).not.toContain('C'); // warm out-of-target is kept, no thrash
  });

  it('does not prune a covered market that has never been read', () => {
    const scoreByWp = new Map([
      ['A', 500],
      ['U', 0], // covered but never read → unknown, must not be redeployed yet
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set(['A', 'U']),
      lastScanAtByWp: new Map(),
      target: 1,
    });
    expect(plan.toPrune).toEqual([]);
  });

  it('marks uncovered markets re-check-due (never-scanned, and past their interval)', () => {
    const scoreByWp = new Map([
      ['A', 500], // covered → not a recheck candidate
      ['X', 50], // uncovered, never scanned → due
      ['Y', 50], // uncovered, scanned recently → not due
      ['Z', 1], // uncovered, dead, scanned long ago → due (past max interval)
    ]);
    const plan = planCoverage({
      ...base,
      scoreByWp,
      covered: new Set(['A']),
      lastScanAtByWp: new Map([
        ['Y', base.now - 1000], // just scanned
        ['Z', base.now - RC.maxMs - 1], // older than the ceiling
      ]),
      target: 1,
    });
    expect(plan.recheckDue).toContain('X');
    expect(plan.recheckDue).toContain('Z');
    expect(plan.recheckDue).not.toContain('Y');
    expect(plan.recheckDue).not.toContain('A'); // covered markets aren't re-check candidates
  });

  it('reports probesSaved vs the legacy 1:1 baseline', () => {
    const scoreByWp = new Map(Array.from({ length: 20 }, (_, i) => [`M${i}`, 20 - i] as const));
    const plan = planCoverage({ ...base, scoreByWp, covered: new Set(), lastScanAtByWp: new Map(), target: 5 });
    expect(plan.shouldCover.length).toBeLessThanOrEqual(5);
    expect(plan.probesSaved).toBe(20 - plan.shouldCover.length);
  });
});
