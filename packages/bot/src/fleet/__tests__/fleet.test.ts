import { describe, expect, it } from 'vitest';
import { loadConfig } from '@st/shared';
import { makeShip } from '../../__tests__/fixtures.js';
import { cappedProbeTarget, coverageMode, isProbeHull, probeTargetFor } from '../scale.js';
import { repairTierDecision } from '../repair.js';
import type { CoveragePlan } from '../../market/coverage.js';

const cfg = loadConfig({ REPAIR_COND_MIN: '0.85', REPAIR_INTEG_FORCE: '0.5', REPAIR_MAX_COST: '100000' });

describe('fleet scale helpers', () => {
  it('probeTarget math is BASE + RATIO×(cargo-1)', () => {
    expect(probeTargetFor(1, 5, 3)).toBe(5);
    expect(probeTargetFor(4, 5, 3)).toBe(14);
    expect(probeTargetFor(0, 5, 3)).toBe(5);
  });

  it('probeTarget is capped at market count', () => {
    expect(cappedProbeTarget(4, 9, 5, 3)).toBe(9);
    expect(cappedProbeTarget(2, 20, 5, 3)).toBe(8);
  });

  it('isProbeHull uses FRAME_PROBE and rejects cargo hulls', () => {
    expect(isProbeHull(makeShip({ frame: { symbol: 'FRAME_PROBE', condition: 1, integrity: 1 }, cargo: { capacity: 0, units: 0, inventory: [] }, fuel: { current: 0, capacity: 0 } }))).toBe(true);
    expect(isProbeHull(makeShip({ frame: { symbol: 'FRAME_FRIGATE', condition: 1, integrity: 1 }, cargo: { capacity: 40, units: 0, inventory: [] } }))).toBe(false);
  });
});

describe('fleet coverage mode (issue #2 phases 4+7 + observe baseline)', () => {
  const mkPlan = (over: Partial<CoveragePlan> = {}): CoveragePlan => ({
    tierByWp: new Map(),
    shouldCover: ['A', 'B'],
    toCover: ['A'],
    toPrune: ['DEAD1'],
    recheckDue: ['R1'],
    counts: { HOT: 1, WARM: 1, COLD: 1, DEAD: 1 },
    probesSaved: 3,
    ...over,
  });
  const base = {
    plan: mkPlan(),
    legacyProbeTarget: 7,
    parkedProbeWps: new Set(['DEAD1']), // a movable probe sits on the DEAD prune candidate
    hasValueDest: true,
    coveredCount: 4,
    now: 1000,
  };

  it('all three levers OFF ⇒ brain inert: null telemetry, legacy target, no enactment', () => {
    const m = coverageMode({ ...base, plan: null, observe: false, adaptive: false, prune: false });
    expect(m.telemetry).toBeNull();
    expect(m.enactAdaptive).toBe(false);
    expect(m.enactPrune).toBe(false);
    expect(m.probeTarget).toBe(7); // legacy, untouched
  });

  it('OBSERVE on ⇒ telemetry only: zero enactment, legacy target, populated wouldPrune/wouldRedeploy', () => {
    const m = coverageMode({ ...base, observe: true, adaptive: false, prune: false });
    expect(m.enactAdaptive).toBe(false); // no value-driven placement
    expect(m.enactPrune).toBe(false); // no redeploys
    expect(m.probeTarget).toBe(7); // legacy buys/placement unchanged
    expect(m.telemetry).not.toBeNull();
    expect(m.telemetry!.observe).toBe(true);
    expect(m.telemetry!.wouldPrune).toBe(1); // would-redeploy DEAD1
    expect(m.telemetry!.wouldRedeploy).toBe(1); // probe parked there + value dest exists
  });

  it('OBSERVE forces observe even when ADAPTIVE+PRUNE are also set (clean baseline precedence)', () => {
    const m = coverageMode({ ...base, observe: true, adaptive: true, prune: true });
    expect(m.enactAdaptive).toBe(false);
    expect(m.enactPrune).toBe(false);
    expect(m.probeTarget).toBe(7); // still legacy — OBSERVE wins
    expect(m.telemetry!.wouldRedeploy).toBe(1); // but still reports what it WOULD do
  });

  it('ADAPTIVE on (observe off) ⇒ enacts value target + placement, no prune', () => {
    const m = coverageMode({ ...base, observe: false, adaptive: true, prune: false });
    expect(m.enactAdaptive).toBe(true);
    expect(m.enactPrune).toBe(false);
    expect(m.probeTarget).toBe(2); // shouldCover.length, value-driven
  });

  it('ADAPTIVE+PRUNE on (observe off) ⇒ enacts redeploys', () => {
    const m = coverageMode({ ...base, observe: false, adaptive: true, prune: true });
    expect(m.enactAdaptive).toBe(true);
    expect(m.enactPrune).toBe(true);
  });

  it('PRUNE without ADAPTIVE never enacts (plan would be null upstream)', () => {
    const m = coverageMode({ ...base, plan: null, observe: false, adaptive: false, prune: true });
    expect(m.enactPrune).toBe(false);
    expect(m.telemetry).toBeNull();
  });

  it('wouldRedeploy is 0 when no probe is parked on a prune candidate', () => {
    const m = coverageMode({ ...base, observe: true, adaptive: false, prune: false, parkedProbeWps: new Set() });
    expect(m.telemetry!.wouldPrune).toBe(1); // still a candidate
    expect(m.telemetry!.wouldRedeploy).toBe(0); // but nothing to actually move
  });

  it('wouldRedeploy is 0 when no value destination exists', () => {
    const m = coverageMode({ ...base, observe: true, adaptive: false, prune: false, hasValueDest: false });
    expect(m.telemetry!.wouldRedeploy).toBe(0);
  });
});

describe('fleet repair helpers', () => {
  it('decides opportunistic, forced-divert, healthy skip, and over-cost skip', () => {
    const yard = 'X1-PP30-SY';
    const atYardWorn = makeShip({
      nav: { ...makeShip().nav, waypointSymbol: yard, status: 'DOCKED' },
      frame: { condition: 0.7, integrity: 1 },
    });
    expect(repairTierDecision(atYardWorn, [yard], cfg).tier).toBe('opportunistic');

    const midRouteBroken = makeShip({
      nav: { ...makeShip().nav, waypointSymbol: 'X1-PP30-A1', status: 'IN_TRANSIT' },
      frame: { condition: 1, integrity: 0.3 },
    });
    expect(repairTierDecision(midRouteBroken, [yard], cfg).tier).toBe('forced');

    const healthy = makeShip({ nav: { ...makeShip().nav, waypointSymbol: yard, status: 'DOCKED' } });
    expect(repairTierDecision(healthy, [yard], cfg).skipReason).toBe('healthy');

    expect(repairTierDecision(atYardWorn, [yard], cfg, cfg.REPAIR_MAX_COST + 1, 1_000_000).skipReason).toBe('over-cost');
  });
});
