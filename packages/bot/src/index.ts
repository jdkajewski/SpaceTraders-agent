/**
 * @st/bot — public surface of the Wave 2 core libraries.
 *
 * Interfaces (committed for Waves 3–5) + concrete factories for the SpaceTraders
 * client, persistence client, ship actions, routing, and the markets service.
 */

export * from './interfaces.js';
export { logger } from './core/logger.js';
export type { Logger } from './core/logger.js';

export { createSpaceTradersClient, __resetRateLimiter } from './clients/spacetraders.js';
export type { SpaceTradersClientOptions } from './clients/spacetraders.js';

export { createPersistenceClient } from './clients/persistence.js';
export type { PersistenceClientOptions } from './clients/persistence.js';

export { createShipActions } from './trade/shipActions.js';

export { TIME_FACTOR, legFuel, legTime, computeFuelPx, chooseMode } from './routing/flight.js';
export { createRouter, marketSellsFuel } from './routing/route.js';
export type { RouterOptions } from './routing/route.js';

export { createMarketsService } from './market/markets.js';
export type { MarketsServiceOptions, MarketsServiceExtra } from './market/markets.js';

// ── Wave 3: runtime state, trading core, budget/phase, recovery, worker ──────
export { createState, gs } from './runtime/state.js';
export type { BotState, GoodState, GateCache, PerShipState } from './runtime/state.js';

export {
  buildLanes,
  claimLane,
  planRideAlongs,
  cooldownFor,
  gateSinkWaypoints,
  activeGateMaterials,
} from './trade/lanes.js';
export type { Lane, RideAlongPlan, ClaimResult, DistFn } from './trade/lanes.js';
export { cheapestSrc, bestSink, findProducerWp } from './trade/marketHelpers.js';

export {
  availableForWork,
  growthBudget,
  commit,
  uncommit,
  noteLaneCost,
  recomputeReserve,
  computeExpansionTarget,
} from './budget/budget.js';
export { PHASES, determinePhase, gateSupplyActive, gateCreditOk, reloadGateLevers } from './budget/phase.js';
export type { PhaseDef } from './budget/phase.js';

export {
  FileLocalStore,
  reconcileLocalToApi,
  loadIntents,
  saveIntent,
  clearIntent,
  reconcileHeldCargo,
} from './recovery.js';
export type { StoredRideAlong, SaveIntentInput, ReconcileDeps } from './recovery.js';

export { record, writeStatus } from './status.js';

export { worker, supervise, goTo, installStopHandlers, noopHooks } from './worker.js';
export type { WorkerDeps, WorkerHooks, WorkerHook, StopOptions } from './worker.js';

export { main } from './main.js';
