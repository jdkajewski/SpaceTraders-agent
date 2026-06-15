/**
 * subsystems/index.ts — Wave-4 hook aggregator + manager wiring.
 *
 * `buildWorkerHooks` assembles the full `WorkerHooks` object the worker injects, by
 * calling each subsystem's factory over a shared `SubsystemDeps`. `buildManagers`
 * returns the background managers (contract election, mine expand/migrate, fleet scale).
 *
 * Every subsystem is internally flag-guarded: with all Wave-4 flags OFF, the hooks are
 * behavioural no-ops and the managers idle/return — so the bot is identical to the
 * Wave-3 trading-only build. `main.ts` builds the `SubsystemDeps` once and calls both.
 */

import { goTo as workerGoTo, type WorkerHooks } from '../worker.js';
import { record } from '../status.js';
import type { BotState } from '../runtime/state.js';
import type { Config } from '@st/shared';
import type {
  MarketsService,
  PersistenceClient,
  Router,
  ShipActions,
  SpaceTradersClient,
} from '../interfaces.js';
import type { MarketsServiceExtra } from '../market/markets.js';
import type { DistFn } from '../trade/lanes.js';
import type { GoToFn, LaunchWorkerFn, Manager, RecordFn, SubsystemDeps } from './deps.js';

import { createGateHooks } from '../gate/gate.js';
import { createContractHooks, contractManager } from '../contracts/contracts.js';
import { createMiningHooks } from '../mining/mining.js';
import { mineExpandManager, mineMigrateManager } from '../mining/expandMine.js';
import { createFeedHooks } from '../feed/inputFeed.js';
import { createFleetHooks } from '../fleet/repair.js';
import { fleetScaleManager } from '../fleet/scale.js';

/** The pieces `main.ts` already has on hand; `SubsystemDeps` is derived from these. */
export interface SubsystemWiring {
  state: BotState;
  cfg: Config;
  actions: ShipActions;
  router: Router;
  markets: MarketsService & MarketsServiceExtra;
  persistence: PersistenceClient;
  client: SpaceTradersClient;
  D: DistFn;
  /** Spawn a supervised worker for a newly-acquired hull (bot2 `launchWorker`). */
  launchWorker: LaunchWorkerFn;
}

/** Derive the `SubsystemDeps` bundle (binds the worker `goTo` + `record`). */
export function makeSubsystemDeps(w: SubsystemWiring): SubsystemDeps {
  const goTo: GoToFn = (shipSym, dest, markets) =>
    workerGoTo(shipSym, dest, markets, { state: w.state, actions: w.actions, router: w.router, D: w.D });
  const recordFn: RecordFn = (shipSym, net, label) => record(w.state, w.cfg, w.persistence, shipSym, net, label);
  return {
    state: w.state,
    cfg: w.cfg,
    actions: w.actions,
    router: w.router,
    markets: w.markets,
    persistence: w.persistence,
    client: w.client,
    D: w.D,
    goTo,
    record: recordFn,
    launchWorker: w.launchWorker,
  };
}

/** Assemble the full `WorkerHooks` from every subsystem factory. */
export function buildWorkerHooks(deps: SubsystemDeps): WorkerHooks {
  const gate = createGateHooks(deps);
  const contracts = createContractHooks(deps);
  const mining = createMiningHooks(deps);
  const feed = createFeedHooks(deps);
  const fleet = createFleetHooks(deps);
  return {
    // Expansion member-dispatch is wired by main() only when AUTO_EXPAND is on; default no-op here.
    expansion: () => Promise.resolve(false),
    repair: fleet.repair,
    gateHauler: gate.gateHauler,
    inputFeeder: feed.inputFeeder,
    mining: mining.mining,
    orphanGate: gate.orphanGate,
    contracts: contracts.contracts,
    gateSupplyTrip: gate.gateSupplyTrip,
    inputFeedTrip: feed.inputFeedTrip,
    isColonyHull: mining.isColonyHull,
  };
}

/** The background managers (each idles/returns when its flag is OFF). */
export function buildManagers(deps: SubsystemDeps): Manager[] {
  return [
    () => contractManager(deps),
    () => mineExpandManager(deps),
    () => mineMigrateManager(deps),
    () => fleetScaleManager(deps),
  ];
}
