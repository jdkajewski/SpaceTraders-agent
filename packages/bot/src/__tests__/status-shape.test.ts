/**
 * status-shape.test.ts — snapshot-shape parity (Wave 6, spec §6.1).
 *
 * Asserts the bot's `writeStatus` payload (`StatusSnapshot.data`) matches the legacy
 * `bot-status.json` shape FIELD-FOR-FIELD, so the existing monitors (dashboard.mjs /
 * contracts.mjs / status.mjs) can migrate to the API unchanged. The legacy key set is
 * transcribed verbatim from `bot2.mjs:L2786` (the single `writeStatus` JSON.stringify);
 * if a future change adds/drops/renames a snapshot field the key-set assertion fails.
 *
 * This is the test that pins DRIFT #36 (mineFeed `good`/`transport`) shut.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig, type StatusSnapshot } from '@st/shared';
import { writeStatus } from '../status.js';
import { createState, type BotState } from '../runtime/state.js';
import { PHASES } from '../budget/phase.js';
import type { PersistenceClient } from '../interfaces.js';

// ── Legacy bot-status.json key sets — transcribed verbatim from bot2.mjs:L2786 ──────────
// JSON.stringify({ updated, phase, phaseDesc, runNet, inFlightProjected, projectedTotal,
//   lanesRun, goal, goalBreakdown, credits, reserve, committed, growthBudget, gate{…},
//   inputFeed{…}, mineFeed{…}, expand, ships[…] }, null, 1)
const LEGACY_TOP = [
  'updated', 'phase', 'phaseDesc', 'runNet', 'inFlightProjected', 'projectedTotal',
  'lanesRun', 'goal', 'goalBreakdown', 'credits', 'reserve', 'committed', 'growthBudget',
  'gate', 'inputFeed', 'mineFeed', 'expand', 'ships',
];
const LEGACY_GATE = ['exists', 'built', 'known', 'remaining', 'haulers', 'supplying', 'buyPaused', 'creditFloor', 'creditResume'];
const LEGACY_INPUT_FEED = ['enabled', 'active', 'feeders', 'busy'];
const LEGACY_MINE_FEED = ['enabled', 'feeders', 'busy', 'good', 'site', 'refiner', 'transport'];
const LEGACY_SHIP = ['ship', 'net', 'projected', 'lanes', 'doing', 'route'];

function captureSnapshot(state: BotState, cfg = loadConfig({})): StatusSnapshot {
  let captured: StatusSnapshot | undefined;
  const persistence = {
    postStatus: (s: StatusSnapshot) => { captured = s; },
    putRunStats: async () => undefined,
  } as unknown as PersistenceClient;
  state.lastStatusAt = 0; // defeat the ≥4s throttle
  writeStatus(state, cfg, persistence);
  if (!captured) throw new Error('writeStatus did not post a snapshot');
  return captured;
}

describe('status snapshot shape == legacy bot-status.json (bot2.mjs:L2786)', () => {
  const cfg = loadConfig({});
  const state = createState(cfg);
  state.currentPhase = PHASES.PROFIT;
  state.perShip = { 'X1-AA1-A1B': { net: 1234, lanes: 3, last: 'GOLD', projected: 500 } };
  state.fleetRoutes = { A1B: 'GBUY→GSELL' };

  const snap = captureSnapshot(state, cfg);
  const data = snap.data as Record<string, unknown>;

  it('top-level snapshot keys match legacy exactly', () => {
    expect(Object.keys(data).sort()).toEqual([...LEGACY_TOP].sort());
  });
  it('gate block keys match legacy exactly', () => {
    expect(Object.keys(data.gate as object).sort()).toEqual([...LEGACY_GATE].sort());
  });
  it('inputFeed block keys match legacy exactly', () => {
    expect(Object.keys(data.inputFeed as object).sort()).toEqual([...LEGACY_INPUT_FEED].sort());
  });
  it('mineFeed block keys match legacy exactly (incl. DRIFT #36 good/transport)', () => {
    expect(Object.keys(data.mineFeed as object).sort()).toEqual([...LEGACY_MINE_FEED].sort());
  });
  it('per-ship row keys match legacy exactly', () => {
    const ships = data.ships as Array<Record<string, unknown>>;
    expect(ships).toHaveLength(1);
    expect(Object.keys(ships[0]).sort()).toEqual([...LEGACY_SHIP].sort());
  });
  it('the StatusSnapshot envelope carries the legacy data block', () => {
    expect(snap.phase).toBe('PROFIT');
    expect(snap.runNet).toBe(state.totalNet);
    expect(snap.credits).toBe(state.cachedCredits);
    expect(snap.data).toBe(data);
  });
});
