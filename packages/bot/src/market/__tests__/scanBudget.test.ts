import { describe, it, expect } from 'vitest';
import {
  scanPriority,
  scanBudgetPerSweep,
  allocateScanBudget,
  COLD_START_OVERRUN,
  type ScanCandidate,
} from '../scanBudget.js';

describe('scanBudget: scanPriority', () => {
  it('is value × overrun — both factors raise priority', () => {
    expect(scanPriority(2, 1)).toBe(2);
    expect(scanPriority(2, 3)).toBe(6); // more overdue → higher
    expect(scanPriority(4, 1)).toBe(4); // more valuable → higher
  });

  it('never goes negative and keeps dead markets rankable among themselves by overrun', () => {
    expect(scanPriority(0, 5)).toBe(0);
    expect(scanPriority(-1, 5)).toBe(0);
    // a high-value barely-due market outranks a dead long-overdue one
    expect(scanPriority(3, 1)).toBeGreaterThan(scanPriority(0.01, 50));
  });
});

describe('scanBudget: scanBudgetPerSweep', () => {
  it('derives floor(reqPerSec × sweepSeconds × fraction)', () => {
    // 2 req/s × 10s × 0.6 = 12
    expect(scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 10_000, fraction: 0.6, maxPerSweep: 0 })).toBe(12);
  });

  it('reserves headroom for trades via the fraction', () => {
    const full = scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 10_000, fraction: 1, maxPerSweep: 0 }); // 20
    const reserved = scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 10_000, fraction: 0.5, maxPerSweep: 0 }); // 10
    expect(full).toBe(20);
    expect(reserved).toBe(10);
    expect(reserved).toBeLessThan(full);
  });

  it('respects an absolute hard cap', () => {
    expect(scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 60_000, fraction: 1, maxPerSweep: 8 })).toBe(8);
  });

  it('never returns below 1 (always makes progress)', () => {
    expect(scanBudgetPerSweep({ reqPerSec: 2, sweepMs: 100, fraction: 0.1, maxPerSweep: 0 })).toBe(1);
  });
});

describe('scanBudget: allocateScanBudget', () => {
  const cand = (wp: string, relValue: number, overrun: number): ScanCandidate => ({ wp, relValue, overrun });

  it('grants the highest value×staleness first and defers the rest', () => {
    const candidates = [
      cand('A', 3, 1), // 3
      cand('B', 1, 1), // 1
      cand('C', 2, 2), // 4  ← top
      cand('D', 0.1, 1), // 0.1
    ];
    const out = allocateScanBudget(candidates, 2);
    expect(out.granted).toEqual(['C', 'A']); // top-2 by priority
    expect(out.deferred.sort()).toEqual(['B', 'D']);
    expect(out.budget).toBe(2);
  });

  it('classifies never-scanned markets promptly (cold-start overrun floats them up)', () => {
    // A never-scanned market is seeded with COLD_START_OVERRUN and a small positive relValue at the
    // call site (unknown ≠ dead), so even against a strong known market it is read first.
    const out = allocateScanBudget([cand('HOT', 5, 1.2), cand('NEW', 1, COLD_START_OVERRUN)], 1);
    expect(out.granted).toEqual(['NEW']); // cold-start dominates → classified first
  });

  it('avoids starvation: a deferred market rises as its overrun grows', () => {
    // C loses this sweep, but next sweep its overrun has grown and it now wins.
    const sweep1 = allocateScanBudget([cand('A', 2, 2), cand('C', 1, 1.5)], 1);
    expect(sweep1.granted).toEqual(['A']);
    expect(sweep1.deferred).toEqual(['C']);
    // A was just read (overrun resets ~1), C kept waiting (overrun climbed to 4)
    const sweep2 = allocateScanBudget([cand('A', 2, 1), cand('C', 1, 4)], 1);
    expect(sweep2.granted).toEqual(['C']); // the previously-starved market now wins
  });

  it('reports a per-tier histogram of where the budget went', () => {
    const out = allocateScanBudget(
      [cand('H', 3, 1), cand('W', 1, 1), cand('Cc', 0.2, 1)],
      3,
    );
    expect(out.byTier).toEqual({ hot: 1, warm: 1, cold: 1 });
    expect(out.granted.length).toBe(3);
    expect(out.deferred).toEqual([]);
  });

  it('grants everything when budget ≥ candidate count', () => {
    const out = allocateScanBudget([cand('A', 1, 1), cand('B', 2, 1)], 10);
    expect(out.granted.sort()).toEqual(['A', 'B']);
    expect(out.deferred).toEqual([]);
  });

  it('grants nothing at zero budget (all deferred, no crash)', () => {
    const out = allocateScanBudget([cand('A', 1, 1)], 0);
    expect(out.granted).toEqual([]);
    expect(out.deferred).toEqual(['A']);
    expect(out.byTier).toEqual({ hot: 0, warm: 0, cold: 0 });
  });
});
