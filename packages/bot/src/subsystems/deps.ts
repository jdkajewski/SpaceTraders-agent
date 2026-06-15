/**
 * subsystems/deps.ts — the dependency bundle + hook contracts shared by every Wave-4
 * subsystem (gate, contracts, mining, feed, fleet).
 *
 * Each subsystem exports a `createXHooks(deps: SubsystemDeps)` factory returning the
 * `WorkerHook`s it owns (pure closures over the injected deps — no module globals; all
 * mutable runtime state lives on `deps.state`). Background managers take the same
 * `SubsystemDeps`. `subsystems/index.ts` assembles the full `WorkerHooks` from these
 * factories; `main.ts` injects it into `WorkerDeps.hooks` and launches the managers.
 *
 * With every subsystem flag OFF, each factory's hooks must be behaviourally no-ops so the
 * bot is identical to the Wave-3 trading-only build (the key safety property).
 */

import type { Config, Market, Ship } from '@st/shared';
import type { BotState } from '../runtime/state.js';
import type {
  MarketsService,
  PersistenceClient,
  Router,
  ShipActions,
  SpaceTradersClient,
} from '../interfaces.js';
import type { MarketsServiceExtra } from '../market/markets.js';
import type { WorkerHook } from '../worker.js';
import type { DistFn } from '../trade/lanes.js';

/** Refuel-aware navigation: plan a ≤1-tank route and fly it (the worker's `goTo`). */
export type GoToFn = (shipSym: string, dest: string, markets: Record<string, Market>) => Promise<void>;

/** Record a completed trip's net + label (per-ship + lifetime accounting; bot2 `record`). */
export type RecordFn = (shipSym: string, net: number, label: string) => Promise<void>;

/** Everything a Wave-4 subsystem needs, injected explicitly (no module globals). */
export interface SubsystemDeps {
  state: BotState;
  cfg: Config;
  actions: ShipActions;
  router: Router;
  markets: MarketsService & MarketsServiceExtra;
  persistence: PersistenceClient;
  /** Direct SpaceTraders client (negotiate/extract/survey/refine/shipyard/repair/purchase). */
  client: SpaceTradersClient;
  D: DistFn;
  /** Refuel-aware navigation (the worker's `goTo`, markets bound per call). */
  goTo: GoToFn;
  /** Run-accounting + status write (the worker's `record`). */
  record: RecordFn;
}

/** A background manager: a long-running loop until `state.stop` (bot2 manager funcs). */
export type Manager = () => Promise<void>;

// ── per-subsystem hook contracts (the typed target each factory implements) ──

/** 4.1 — gate supply + orphan delivery. */
export interface GateHooks {
  /** Dedicated gate hauler pin (gateSupplyTrip → inputFeedTrip → PARK while unbuilt). */
  gateHauler: WorkerHook;
  /** Idle fallback: divert to a gate-supply trip. */
  gateSupplyTrip: WorkerHook;
  /** Orphan gate cargo self-delivery (SELF → SELF+fuel → TRANSFER → stage-hop). */
  orphanGate: WorkerHook;
}

/** 4.2 — contract pipeline. */
export interface ContractHooks {
  /** Contract runner-trip + deliver-held + fulfill (TRADE_FIRST opportunistic). */
  contracts: WorkerHook;
}

/** 4.3 — mining colony. */
export interface MiningHooks {
  /** Role dispatch (REFINER/DRONE/SURVEYOR/FUNNEL/TRANSPORT). */
  mining: WorkerHook;
  /** Colony hulls hold cargo intentionally → skip recovery salvage. */
  isColonyHull: (ship: Ship) => boolean;
}

/** 4.4 — input feed. */
export interface FeedHooks {
  /** Dedicated input feeder pin (inputFeedTrip → PARK while inputFeedActive). */
  inputFeeder: WorkerHook;
  /** Idle fallback: profitable input-feed trip. */
  inputFeedTrip: WorkerHook;
}

/** 4.5 — fleet scale + repair. */
export interface FleetHooks {
  /** Two-tier maintenance hook (runs before recovery). */
  repair: WorkerHook;
}
