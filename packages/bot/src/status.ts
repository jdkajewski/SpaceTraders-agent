/**
 * status.ts — run accounting + live status snapshot
 * (port of bot2.mjs L2771–2798 record/writeStatus).
 *
 * `record()` updates per-ship + lifetime net, persists run-stats (crash-safety), and
 * triggers a status write. `writeStatus()` builds the full `bot-status.json`-shaped
 * snapshot and POSTs it to `/status` (the tools/dashboard read it from the API now).
 * Throttled to ≥4s as in the legacy.
 *
 * DRIFT #20: the POST body matches the API `/status` schema
 * (`{ phase, runNet, credits, gate, data }`) — the full snapshot rides in `data`.
 */

import type { Config, RunStats, StatusSnapshot } from '@st/shared';
import type { BotState } from './runtime/state.js';
import type { PersistenceClient } from './interfaces.js';
import { growthBudget } from './budget/budget.js';
import { gateSupplyActive, gateCreditOk } from './budget/phase.js';
import { logger } from './core/logger.js';

const log = logger.child({ mod: 'status' });
const now = (): number => Date.now();

/**
 * Record a completed lane/trip: per-ship + lifetime net, persist run-stats (so a
 * crash-restart loop isn't a phantom flatline), and refresh the status snapshot.
 * (bot2 `record`)
 */
export async function record(
  state: BotState,
  cfg: Config,
  persistence: PersistenceClient,
  shipSym: string,
  net: number,
  label: string,
): Promise<void> {
  const ps = (state.perShip[shipSym] = state.perShip[shipSym] ?? { net: 0, lanes: 0, last: '' });
  ps.net += net;
  ps.lanes += 1;
  state.totalNet += net;
  state.lanesRun += 1;
  const stats: RunStats = { totalNet: state.totalNet, lanesRun: state.lanesRun, updatedAt: new Date().toISOString() };
  try {
    await persistence.putRunStats(stats); // [B] survive restarts — write-through (local + best-effort API)
  } catch (e) {
    log.warn(`run-stats persist failed: ${(e as Error).message}`);
  }
  log.info(
    `${shipSym.slice(-3)} ${label} net=${net.toLocaleString()} | run total +${state.totalNet.toLocaleString()} over ${state.lanesRun} lanes`,
  );
  writeStatus(state, cfg, persistence);
}

/** Short gate label for the snapshot's top-level `gate` column. */
function gateLabel(state: BotState): string | null {
  const g = state.gateCache;
  if (!g.exists) return null;
  return g.built ? 'BUILT' : 'UNBUILT';
}

/**
 * Build the full bot-status snapshot and POST it (throttled ≥4s). The `data` block is
 * the legacy `bot-status.json` shape so monitors migrate unchanged. (bot2 `writeStatus`)
 */
export function writeStatus(state: BotState, cfg: Config, persistence: PersistenceClient): void {
  if (now() - state.lastStatusAt < 4000) return;
  state.lastStatusAt = now();

  const ships = Object.entries(state.perShip).map(([s, v]) => ({
    ship: s.slice(-3),
    net: v.net,
    projected: v.projected || 0,
    lanes: v.lanes,
    doing: v.last,
    route: state.fleetRoutes[s.slice(-3)] ?? null,
  }));
  const inFlightProjected = ships.reduce((a, s) => a + (s.projected || 0), 0);

  const data = {
    updated: new Date().toISOString(),
    phase: state.currentPhase.name,
    phaseDesc: state.currentPhase.desc,
    runNet: state.totalNet,
    inFlightProjected,
    projectedTotal: state.totalNet + inFlightProjected,
    lanesRun: state.lanesRun,
    goal: state.expansionTarget,
    goalBreakdown: state.targetBreakdown,
    credits: state.cachedCredits,
    reserve: state.operatingReserve,
    committed: state.committed,
    growthBudget: growthBudget(state),
    gate: {
      exists: state.gateCache.exists,
      built: state.gateCache.built,
      known: state.gateCache.known,
      remaining: state.gateCache.remaining,
      haulers: [...cfg.GATE_HAULERS],
      supplying: gateSupplyActive(state, cfg) && gateCreditOk(state),
      buyPaused: state.gateBuyPaused,
      creditFloor: state.gateLevers.floor,
      creditResume: state.gateLevers.resume,
    },
    inputFeed: {
      enabled: cfg.INPUT_FEED,
      active: cfg.INPUT_FEED && gateSupplyActive(state, cfg),
      feeders: [...cfg.INPUT_FEEDERS],
      busy: [...state.inputActiveFeeders].map((s) => s.slice(-3)),
    },
    mineFeed: {
      enabled: cfg.MINE_FEED,
      feeders: [...cfg.MINE_FEEDERS],
      busy: [...state.mining.active].map((s) => s.slice(-3)),
      site: state.mining.site,
      refiner: state.mining.refinerSym && state.mining.refinerSym.slice(-3),
    },
    expand:
      state.expansionStatus !== undefined
        ? (state.expansionStatus() as Record<string, unknown>)
        : { enabled: cfg.AUTO_EXPAND },
    ships,
  };

  const snapshot: StatusSnapshot = {
    phase: state.currentPhase.name,
    runNet: state.totalNet,
    credits: state.cachedCredits,
    gate: gateLabel(state),
    data,
  };
  persistence.postStatus(snapshot); // fire-and-forget telemetry
}
