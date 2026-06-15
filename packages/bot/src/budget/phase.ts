/**
 * budget/phase.ts — strategy phase machine + gate credit hysteresis
 * (port of bot2.mjs L213–277 PHASES/determinePhase/gateSupplyActive and
 * L237–266 reloadGateLevers/gateCreditOk).
 *
 * The phase is *derived* from live state with no side effects and does NOT change
 * lane ranking — it labels the run and drives the gate/feed levers via
 * `gateSupplyActive()` so the reported phase and behaviour can never diverge.
 *
 * DRIFT #4: `reloadGateLevers` no longer stats `gate-levers.json`; it polls
 * `GET /gate-levers` (the operator control input) and updates the live band on
 * `state.gateLevers`. `gateCreditOk` stays synchronous (reads `state.gateLevers`),
 * so its hot-path call sites are unchanged; the poll runs on the targetWatch cadence.
 */

import type { Config } from '@st/shared';
import type { BotState } from '../runtime/state.js';
import type { PersistenceClient } from '../interfaces.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'phase' });

export interface PhaseDef {
  n: number;
  name: string;
  desc: string;
}

/**
 * Strategy phases (greenfield → open portal). Order = progression. Legacy names
 * preserved verbatim (bot2 L213–220); the bot-status snapshot reports `.name`/`.desc`.
 */
export const PHASES = {
  BOOTSTRAP: { n: 0, name: 'BOOTSTRAP', desc: 'map markets + run starter contracts' },
  PROFIT: { n: 1, name: 'PROFIT', desc: 'grow fleet, run best net/min lanes (multi-route/ride-along)' },
  GATE_DISCOVERY: { n: 2, name: 'GATE_DISCOVERY', desc: 'gate site found — awareness only (supply disabled)' },
  GATE_SUPPLY: { n: 3, name: 'GATE_SUPPLY', desc: 'producer-only gate feed, capped + fill/drop-off bias' },
  INPUT_FEED: { n: 4, name: 'INPUT_FEED', desc: 'overlap: feed producer inputs to restock the long pole' },
  PORTAL_OPEN: { n: 5, name: 'PORTAL_OPEN', desc: 'gate built → seed the next system cell' },
} satisfies Record<string, PhaseDef>;

/**
 * Canonical "are we actively supplying the gate?" predicate = the GATE_SUPPLY phase
 * condition. The gate levers (sink waypoints, supply trips) read this so live
 * behaviour and the reported phase agree. (bot2 L226–228)
 */
export function gateSupplyActive(state: BotState, cfg: Config): boolean {
  const g = state.gateCache;
  return cfg.GATE_SUPPLY && g.exists && !g.built && g.known;
}

/**
 * Derive the strategy phase purely from live state. No side effects; progression-ordered.
 * (bot2 L269–277)
 */
export function determinePhase(state: BotState, cfg: Config): PhaseDef {
  const markets = state.marketsRef();
  const marketKnown = !!(markets && Object.keys(markets).length);
  if (!marketKnown || state.fleetSize < cfg.BOOTSTRAP_FLEET_MIN) return PHASES.BOOTSTRAP;
  const g = state.gateCache;
  if (g.known && g.exists && g.built) return PHASES.PORTAL_OPEN;
  if (gateSupplyActive(state, cfg)) return cfg.INPUT_FEED ? PHASES.INPUT_FEED : PHASES.GATE_SUPPLY;
  if (g.known && g.exists && !g.built) return PHASES.GATE_DISCOVERY; // discovered but supply disabled
  return PHASES.PROFIT;
}

/**
 * [LIVE-TUNE] Poll the operator gate-credit band (`GET /gate-levers`) and update the
 * live band on `state.gateLevers`. Accepts `{ floor, resume }` or `{ floor, gap }`
 * (resume = floor + gap), keeping a real deadband (resume > floor). Replaces the
 * legacy file-mtime hot-reload (bot2 L237–250 / DRIFT #4). Best-effort: a missing or
 * failed fetch keeps the current (config-seeded) values.
 */
export async function reloadGateLevers(state: BotState, cfg: Config, persistence: PersistenceClient): Promise<void> {
  let j;
  try {
    j = await persistence.getGateLevers();
  } catch {
    return; // unreachable/malformed → keep current values
  }
  if (!j) return;
  const lev = state.gateLevers;
  let changed = false;
  if (Number.isFinite(j.floor) && j.floor !== lev.floor) {
    lev.floor = j.floor;
    changed = true;
  }
  const resume = Number.isFinite(j.resume) ? j.resume : Number.isFinite(j.gap) ? lev.floor + j.gap : null;
  if (resume != null && resume !== lev.resume) {
    lev.resume = resume;
    changed = true;
  }
  if (lev.resume <= lev.floor) lev.resume = lev.floor + cfg.GATE_CREDIT_RESUME_GAP; // keep a real deadband
  if (Number.isFinite(j.budgetFraction)) {
    const bf = Math.min(1, Math.max(0, j.budgetFraction));
    if (bf !== lev.budgetFraction) {
      lev.budgetFraction = bf;
      changed = true;
    }
  }
  if (changed)
    log.info(
      `gate levers reloaded — nest-egg floor ${lev.floor.toLocaleString()} → burst resume ${lev.resume.toLocaleString()} (band ${(lev.resume - lev.floor).toLocaleString()}), budget ${Math.round(lev.budgetFraction * 100)}% of growth`,
    );
}

/**
 * [GATE] Hysteresis latch for the credit floor. HARD stop at floor; only RESUME once
 * credits recover to the resume band. Between the two thresholds we hold the previous
 * state (the deadband), which kills the at-floor sawtooth and lets buying run in
 * sustained bursts. Updated each call from `state.cachedCredits`. (bot2 L255–266)
 *
 * Synchronous by design (band refreshed out-of-band by `reloadGateLevers`).
 */
export function gateCreditOk(state: BotState): boolean {
  const { floor, resume } = state.gateLevers;
  const was = state.gateBuyPaused;
  if (state.cachedCredits < floor) state.gateBuyPaused = true; // hard stop: arm the latch
  else if (state.cachedCredits >= resume) state.gateBuyPaused = false; // recovered past resume band: release
  if (was !== state.gateBuyPaused) {
    if (state.gateBuyPaused)
      log.info(
        `gate-buy PAUSED — credits ${Math.round(state.cachedCredits).toLocaleString()} < floor ${floor.toLocaleString()} (rebuild to ${resume.toLocaleString()} to resume)`,
      );
    else
      log.info(
        `gate-buy RESUMED — credits ${Math.round(state.cachedCredits).toLocaleString()} ≥ resume ${resume.toLocaleString()} (buy down to floor ${floor.toLocaleString()})`,
      );
  }
  return !state.gateBuyPaused;
}
