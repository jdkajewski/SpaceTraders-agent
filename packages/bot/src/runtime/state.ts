/**
 * runtime/state.ts — consolidated bot runtime state (port of the ~30 module-level
 * `let`/`const` mutables scattered across bot2.mjs into one explicitly-passed object).
 *
 * This is a pure refactor: the fields and their initial values mirror the legacy
 * globals exactly (see the table in rebuild/plans/wave-3-trading-budget.md §3.1).
 * Every Wave-3 module takes a `BotState` and mutates these fields instead of reading
 * file/module globals, so the runtime stays single-threaded-coherent and testable.
 *
 * The shared market cache lives in the Wave-2 markets service; `marketsRef()` exposes
 * it here for the routing/lane code that needs a synchronous snapshot.
 */

import type { Config, Market, Intent, Survey } from '@st/shared';
import type { PhaseDef } from '../budget/phase.js';
import { PHASES } from '../budget/phase.js';

/** Per-good scheduler entry (bot2 `goodState` Map value). */
export interface GoodState {
  lockedBy: string | null;
  cooldownUntil: number;
  deadStreak: number;
}

/** Live construction-site snapshot (bot2 `gateCache`). */
export interface GateCache {
  exists: boolean;
  wp: string | null;
  built: boolean;
  remaining: Record<string, number>;
  known: boolean;
}

/** Per-ship accounting + "what it's doing now" (bot2 `perShip`). */
export interface PerShipState {
  net: number;
  lanes: number;
  last: string;
  projected?: number;
}

/** Last KNOWN gate cost snapshot, reused when a fetch fails (bot2 `lastGate`). */
export interface LastGate {
  gateBuilt: boolean;
  gateCost: number;
  gateUnits: number;
}

/** Live gate credit band (mirrors bot2 mutable `GATE_CREDIT_FLOOR`/`GATE_CREDIT_RESUME`). */
export interface GateLeverState {
  floor: number;
  resume: number;
  budgetFraction: number;
}

/** Per-good buy-timing patience FSM value (bot2 `gatePxState`/`feedPxState` entry). */
export interface PriceSettleState {
  state: 'normal' | 'paused' | 'settling';
  since?: number;
  low?: number;
}

/** Active-contract pipeline state (bot2 `activeContractInfo`). */
export interface ActiveContractInfo {
  id: string;
  good: string;
  dest: string;
  units: number;
  pay: number;
}

/** A planned multi-hop route captured for the fleet table (bot2 `plannedRoutes`). */
export interface PlannedRoute {
  from: string;
  path: string[];
  at: number;
}

/**
 * Consolidated mutable runtime state. One instance per bot process, created in
 * `main()` and threaded through every module.
 */
export interface BotState {
  // ── budget (concurrency-safe) ──────────────────────────────────────────────
  cachedCredits: number;
  committed: number;
  /** Rolling reserve recomputed by recomputeReserve (bot2 mutable OPERATING_RESERVE). */
  operatingReserve: number;
  /** Rolling avg of claimed-lane estCost (bot2 `laneCostEMA`). */
  laneCostEMA: number;

  // ── expansion goal ─────────────────────────────────────────────────────────
  expansionTarget: number;
  targetBreakdown: Record<string, unknown>;
  gateKnown: boolean;
  lastGate: LastGate;

  // ── gate ───────────────────────────────────────────────────────────────────
  gateCache: GateCache;
  /** tradeSymbol -> units reserved by in-flight supply trips. */
  gateClaims: Map<string, number>;
  gateActiveSuppliers: Set<string>;
  inputActiveFeeders: Set<string>;
  inputActiveProducers: Set<string>;
  gateBuyPaused: boolean;
  gateLevers: GateLeverState;
  /** Per-good gate-material price-cap hysteresis latch (bot2 `gatePxPaused`): true = paused (price above cap). */
  gatePxPaused: Map<string, boolean>;
  /** Per-good input-feed buy-timing patience FSM (bot2 `feedPxState`). */
  feedPxState: Map<string, PriceSettleState>;

  // ── scheduler ──────────────────────────────────────────────────────────────
  goodState: Map<string, GoodState>;

  // ── accounting ─────────────────────────────────────────────────────────────
  perShip: Record<string, PerShipState>;
  totalNet: number;
  lanesRun: number;
  plannedRoutes: Record<string, PlannedRoute>;
  fleetRoutes: Record<string, string | null>;
  lastStatusAt: number;
  lastGateState: string | null;

  // ── fleet / phase ──────────────────────────────────────────────────────────
  fleetMaxSpeed: number;
  fleetSize: number;
  currentPhase: PhaseDef;

  // ── recovery ───────────────────────────────────────────────────────────────
  /** In-memory mirror of persisted per-ship intents (shipSym -> intent). */
  intents: Record<string, Intent>;

  // ── contracts (Wave-4 fills these; discovered pre-workers in main) ──────────
  activeContractInfo: ActiveContractInfo | null;
  contractOwner: { id: string; ship: string } | null;
  contractWorkingId: string | null;
  /** Auto-force grace clock: how long the active contract has gone unowned (bot2 `contractWedge`). */
  contractWedge: { id: string | null; since: number };
  /** Contract ids auto-forced after sitting unclaimed past the grace window (bot2 `contractAutoForced`). */
  contractAutoForced: Set<string>;

  // ── mining (Wave-4 stubs) ──────────────────────────────────────────────────
  mining: {
    surveys: Survey[];
    refinerSym: string | null;
    funnelSym: string | null;
    /** Registered fuel-tender hull (bot2 `mineTenderSym`). */
    tenderSym: string | null;
    /** Current single-good refine target, rotated to keep the hold pure (bot2 `refineTarget`). */
    refineTarget: string | null;
    colonyShips: Record<string, unknown>;
    site: string | null;
    active: Set<string>;
    /** Rocks mined out / abandoned by MINE_MIGRATE this run (bot2 `depletedSites`). */
    depletedSites: Set<string>;
    /** deposit-trait -> candidate asteroid waypoints (bot2 `asteroidCache`). */
    asteroidCache: Record<string, string[]>;
  };

  // ── fleet (Wave-4) ─────────────────────────────────────────────────────────
  fleet: {
    /** shipType -> shipyard waypoints that sell it (bot2 `shipyardCache`). */
    shipyards: Record<string, string[]> | null;
    lastScan: number;
  };

  // ── lifecycle ──────────────────────────────────────────────────────────────
  stop: boolean;

  /** Synchronous snapshot of the shared market cache (set by main/markets svc). */
  marketsRef: () => Record<string, Market>;

  /**
   * Optional expansion status provider (Wave 5). When `AUTO_EXPAND` is on, main sets this to
   * `expansion.statusBlock`; `writeStatus` surfaces it in the snapshot's `expand` field. Left
   * undefined in the single-system live build, so the snapshot reports `{ enabled: false }`.
   */
  expansionStatus?: () => unknown;
  /**
   * Optional scan-budget status provider (issue #2). main sets this to a closure surfacing the
   * value-weighted scan metric (credits-per-request, markets tracked, top lanes); `writeStatus`
   * emits it in the snapshot's `scan` field. Left undefined in minimal builds.
   */
  scanStatus?: () => unknown;
}

export interface CreateStateOptions {
  /** Synchronous accessor for the live shared market cache. */
  marketsRef?: () => Record<string, Market>;
}

/**
 * Build a fresh `BotState` from config, mirroring bot2's module-init values.
 * `expansionTarget` seeds from `CREDIT_TARGET || 8_000_000` (bot2 L285).
 */
export function createState(cfg: Config, opts: CreateStateOptions = {}): BotState {
  return {
    cachedCredits: 0,
    committed: 0,
    operatingReserve: cfg.OPERATING_RESERVE,
    laneCostEMA: 0,

    expansionTarget: cfg.CREDIT_TARGET || 8_000_000,
    targetBreakdown: {},
    gateKnown: false,
    lastGate: { gateBuilt: false, gateCost: 0, gateUnits: 0 },

    gateCache: { exists: false, wp: null, built: false, remaining: {}, known: false },
    gateClaims: new Map(),
    gateActiveSuppliers: new Set(),
    inputActiveFeeders: new Set(),
    inputActiveProducers: new Set(),
    gateBuyPaused: false,
    gateLevers: { floor: cfg.GATE_CREDIT_FLOOR, resume: cfg.GATE_CREDIT_RESUME, budgetFraction: cfg.GATE_BUDGET_FRACTION },
    gatePxPaused: new Map(),
    feedPxState: new Map(),

    goodState: new Map(),

    perShip: {},
    totalNet: 0,
    lanesRun: 0,
    plannedRoutes: {},
    fleetRoutes: {},
    lastStatusAt: 0,
    lastGateState: null,

    fleetMaxSpeed: 36,
    fleetSize: 0,
    currentPhase: PHASES.BOOTSTRAP,

    intents: {},

    activeContractInfo: null,
    contractOwner: null,
    contractWorkingId: null,
    contractWedge: { id: null, since: 0 },
    contractAutoForced: new Set(),

    mining: {
      surveys: [],
      refinerSym: null,
      funnelSym: null,
      tenderSym: null,
      refineTarget: null,
      colonyShips: {},
      site: null,
      active: new Set(),
      depletedSites: new Set(),
      asteroidCache: {},
    },

    fleet: {
      shipyards: null,
      lastScan: 0,
    },

    stop: false,

    marketsRef: opts.marketsRef ?? (() => ({})),
  };
}

/** Get-or-create the scheduler entry for a good (bot2 `gs(sym)`). */
export function gs(state: BotState, sym: string): GoodState {
  let s = state.goodState.get(sym);
  if (!s) {
    s = { lockedBy: null, cooldownUntil: 0, deadStreak: 0 };
    state.goodState.set(sym, s);
  }
  return s;
}
