/**
 * budget/budget.ts — operating budget + dynamic expansion goal
 * (port of bot2.mjs L143–174 budget accounting, L161–174 recomputeReserve,
 * L278–320 computeExpansionTarget).
 *
 * Working buys may only use funds above `operatingReserve`; `committed` tracks
 * in-flight buy cost so concurrent ships can't oversubscribe cash. The reserve and
 * the expansion goal are recomputed live (the goal = the actual cost to expand, not a
 * magic number) so the bot stops/continues on real headroom.
 */

import type { Config, Market, Ship } from '@st/shared';
import type { BotState } from '../runtime/state.js';
import type { SpaceTradersClient, ApiEnvelope } from '../interfaces.js';
import { cheapestSrc } from '../trade/marketHelpers.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'budget' });

// ── concurrency-safe budget accounting (bot2 L149–160) ───────────────────────

/** Funds free for working buys, after committed in-flight cash and the reserve. */
export function availableForWork(state: BotState): number {
  return state.cachedCredits - state.committed - state.operatingReserve;
}

/** Surplus free for ships/gate/expansion (never negative). */
export function growthBudget(state: BotState): number {
  return Math.max(0, state.cachedCredits - state.committed - state.operatingReserve);
}

export function commit(state: BotState, amount: number): void {
  state.committed += amount;
}

export function uncommit(state: BotState, amount: number): void {
  state.committed = Math.max(0, state.committed - amount);
}

/** Feed the rolling working-capital estimate from a claimed lane's est. cost. */
export function noteLaneCost(state: BotState, c: number): void {
  if (c > 0) state.laneCostEMA = state.laneCostEMA > 0 ? Math.round(0.8 * state.laneCostEMA + 0.2 * c) : c;
}

// ── rolling operating reserve (bot2 L161–174) ────────────────────────────────

export interface ReserveDeps {
  getAllShips: () => Promise<Ship[]>;
  getFuelPx: () => number;
}

/**
 * [ROLLING RESERVE] operatingReserve = (A) fuel to top off the WHOLE fleet at the live
 * fuel price + (B) a rolling working-capital buffer sized from the recent lane buy-cost
 * (EMA) × a small concurrency factor. We do NOT reserve one full load per ship — the
 * `committed` accounting already serializes concurrent buys. (bot2 L161–174)
 */
export async function recomputeReserve(state: BotState, cfg: Config, deps: ReserveDeps): Promise<void> {
  try {
    const ships = await deps.getAllShips();
    const fuelPx = deps.getFuelPx();
    const fuelReserve = ships.reduce((a, s) => a + (s.fuel?.capacity || 0), 0) * fuelPx;
    const cargoShips = ships.filter((s) => (s.cargo?.capacity || 0) >= 30).length;
    const perLoad = state.laneCostEMA > 0 ? state.laneCostEMA : cfg.GOODS_CUSHION_PER_SHIP;
    const buffer = Math.min(cargoShips, cfg.RESERVE_CONCURRENCY); // reserve cash for ~this many concurrent fresh loads
    const workingCapital = cfg.GOODS_CUSHION + perLoad * buffer;
    state.operatingReserve = Math.round(fuelReserve + workingCapital);
  } catch {
    /* keep current reserve on a transient fleet-fetch failure */
  }
}

// ── dynamic expansion goal (bot2 L278–320) ───────────────────────────────────

export interface ExpansionDeps {
  client: SpaceTradersClient;
}

/**
 * Dynamic goal = operating reserve + gate build (remaining materials × slippage +
 * dedicated haulers) + seed a new-system cell. Mutates `state.gateCache`,
 * `state.gateKnown`, `state.lastGate`, `state.targetBreakdown` and returns the target.
 *
 * [A] FAIL-SAFE gate status: default UNBUILT, remember the last KNOWN status, and never
 * let an UNKNOWN status collapse the goal or authorize a stop. (bot2 L180–184, L278–320)
 */
export async function computeExpansionTarget(
  state: BotState,
  cfg: Config,
  markets: Record<string, Market>,
  deps: ExpansionDeps,
): Promise<number> {
  const system = cfg.SYSTEM;
  let gateCost = 0;
  let gateUnits = 0;
  let gateBuilt = false;
  let fetched = false;
  try {
    const gsd = (
      await deps.client.api<ApiEnvelope<Array<{ symbol: string }>>>(
        'GET',
        `/systems/${system}/waypoints?limit=20&type=JUMP_GATE`,
      )
    ).data;
    const gateWp = gsd[0]?.symbol;
    if (gateWp) {
      const cs = (
        await deps.client.api<
          ApiEnvelope<{ isComplete: boolean; materials?: Array<{ tradeSymbol: string; required: number; fulfilled: number }> }>
        >('GET', `/systems/${system}/waypoints/${gateWp}/construction`)
      ).data;
      gateBuilt = cs.isComplete;
      const remaining: Record<string, number> = {};
      if (!gateBuilt)
        for (const m of cs.materials ?? []) {
          const need = m.required - m.fulfilled;
          if (need <= 0) continue;
          remaining[m.tradeSymbol] = need;
          gateUnits += need;
          const src = cheapestSrc(markets, m.tradeSymbol);
          gateCost += need * (src ? src.px : 1000) * cfg.SLIPPAGE_FACTOR;
        }
      state.gateCache = { exists: true, wp: gateWp, built: gateBuilt, remaining, known: true };
      fetched = true;
    } else {
      state.gateCache = { exists: false, wp: null, built: false, remaining: {}, known: true };
    }
  } catch (e) {
    log.warn(`gate status fetch failed (${(e as Error).message}) — NOT collapsing goal`);
  }

  if (!fetched && !state.gateKnown) {
    // Unknown and never confirmed: hold the current goal (do not collapse), block any stop.
    state.targetBreakdown = { ...state.targetBreakdown, gateBuilt: null, gateStatusKnown: false };
    return state.expansionTarget;
  }
  if (!fetched) {
    ({ gateBuilt } = state.lastGate);
    gateCost = state.lastGate.gateCost;
    gateUnits = state.lastGate.gateUnits;
  } else {
    state.gateKnown = true;
    state.lastGate = { gateBuilt, gateCost, gateUnits };
  }

  let haulerCost = 0;
  let nHaul = 0;
  if (!gateBuilt) {
    const loads = Math.ceil(gateUnits / 80);
    // No off-ship storage in SpaceTraders → ships ARE the warehouse. These dedicated hulls
    // store (accumulate-the-dip) AND supply the gate; a MANDATORY expansion cost.
    nHaul = Math.min(3, Math.max(1, Math.round(loads / 8)));
    haulerCost = nHaul * cfg.HAULER_PRICE;
  }
  const target = Math.round(state.operatingReserve + gateCost + haulerCost + cfg.NEW_CELL_SEED);
  state.targetBreakdown = {
    reserve: state.operatingReserve,
    gateMaterials: Math.round(gateCost),
    storageSupplyShips: haulerCost,
    storageSupplyShipCount: nHaul,
    seedNewCell: cfg.NEW_CELL_SEED,
    gateBuilt,
    gateStatusKnown: true,
    total: target,
  };
  return target;
}
