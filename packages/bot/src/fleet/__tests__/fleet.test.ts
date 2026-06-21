import { describe, expect, it } from 'vitest';
import { loadConfig } from '@st/shared';
import { makeShip } from '../../__tests__/fixtures.js';
import { cappedProbeTarget, isProbeHull, probeTargetFor, __test } from '../scale.js';
import { repairTierDecision } from '../repair.js';

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

  describe('pickAnchorYards (issue #17 trader-scale bug)', () => {
    const { pickAnchorYards } = __test;

    it('prefers a single yard that sells BOTH probes and cargo as the anchor', () => {
      // A1 sells probe + cargo; C40 sells probe only. A1 must win as the combined anchor even
      // though C40 also sells probes (the live X1-SQ96 case where a cheaper probe at C40 used to
      // hide that A2 sold both → cargo buys went to the probe-only yard → 400).
      const r = pickAnchorYards({
        SHIP_PROBE: ['X1-C40', 'X1-A1'],
        SHIP_LIGHT_SHUTTLE: ['X1-A1'],
        SHIP_LIGHT_HAULER: ['X1-A1'],
        SHIP_SIPHON_DRONE: ['X1-C40'],
      });
      expect(r.anchorYard).toBe('X1-A1');
      expect(r.probeYard).toBe('X1-A1');
      expect(r.cargoYard).toBe('X1-A1');
    });

    it('falls back to separate probe and cargo yards when no yard sells both', () => {
      const r = pickAnchorYards({
        SHIP_PROBE: ['X1-C40'],
        SHIP_SIPHON_DRONE: ['X1-C40'],
        SHIP_LIGHT_SHUTTLE: ['X1-A1'],
      });
      expect(r.probeYard).toBe('X1-C40');
      expect(r.cargoYard).toBe('X1-A1');
      expect(r.anchorYard).toBe('X1-C40'); // anchor follows the probe yard for the parked-probe buys
    });

    it('returns null cargoYard when no yard sells a cargo ship', () => {
      const r = pickAnchorYards({ SHIP_PROBE: ['X1-C40'], SHIP_MINING_DRONE: ['X1-H51'] });
      expect(r.probeYard).toBe('X1-C40');
      expect(r.cargoYard).toBeNull();
      expect(r.anchorYard).toBe('X1-C40');
    });
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
