/**
 * @st/bot — core library interfaces (Wave 2)
 *
 * Committed early because Waves 3–5 depend on these shapes. Each concrete module
 * (`clients/spacetraders.ts`, `clients/persistence.ts`, `trade/shipActions.ts`,
 * `routing/*`, `market/markets.ts`) implements one of these.
 *
 * Parity-first port of the legacy `.mjs` system; DTO types come from `@st/shared`.
 */

import type {
  Ship,
  Contract,
  Market,
  RunStats,
  Intent,
  GateLevers,
  StatusSnapshot,
  MarketHistoryRow,
  TradeObservation,
  MineEvent,
} from '@st/shared';

// ── SpaceTraders client (port of st.mjs) ─────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** SpaceTraders v2 response envelope. */
export interface ApiEnvelope<T> {
  data: T;
  meta?: { total: number; page: number; limit: number };
}

/** Structured error thrown by `SpaceTradersClient.api` (mirrors st.mjs tags). */
export interface StructuredApiError extends Error {
  /** HTTP status (0 for a network-level failure). */
  status: number;
  /** SpaceTraders error code, when present. */
  code?: number;
  /** SpaceTraders `error.data` payload, when present. */
  data?: unknown;
  /** True when `fetch()` itself rejected (no HTTP response). */
  network?: boolean;
}

export interface SpaceTradersClient {
  /**
   * Rate-limited request against the SpaceTraders v2 API. Returns the parsed JSON
   * envelope. Throws a {@link StructuredApiError} on non-retryable failure.
   */
  api<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  /** Paginated `/my/ships`. */
  getAllShips(): Promise<Ship[]>;
  /** Paginated `/my/contracts`. */
  getAllContracts(): Promise<Contract[]>;
  /** Cumulative request count (telemetry). */
  reqStats(): { reqCount: number };
}

// ── Persistence client (bot → Fastify API) ───────────────────────────────────

/** Coordinate record seeded from coords.csv (`GET /waypoints`). */
export interface Waypoint {
  symbol: string;
  x: number;
  y: number;
}

/**
 * Local crash-safety write-through store for the two critical records
 * (run-stats + intents). Wave 3/4 `recovery.ts` supplies an implementation; the
 * persistence client mirrors writes here and reconciles on boot (newest wins).
 */
export interface LocalStore {
  getRunStats(): Promise<RunStats | null>;
  putRunStats(stats: RunStats): Promise<void>;
  getIntents(): Promise<Intent[]>;
  putIntent(intent: Intent): Promise<void>;
  deleteIntent(shipSym: string): Promise<void>;
}

export interface PersistenceClient {
  // run-stats (critical: local write-through)
  getRunStats(): Promise<RunStats | null>;
  putRunStats(stats: RunStats): Promise<void>;

  // intents (critical: local write-through)
  getIntents(): Promise<Intent[]>;
  getIntent(shipSym: string): Promise<Intent | null>;
  putIntent(intent: Intent): Promise<void>;
  deleteIntent(shipSym: string): Promise<void>;

  // status (fire-and-forget telemetry)
  postStatus(snapshot: StatusSnapshot): void;

  // markets (latest snapshot; replaces markets.json)
  getMarkets(): Promise<Record<string, Market>>;
  getMarket(waypoint: string): Promise<Market | null>;
  /** Bulk replace markets snapshot — fire-and-forget with retry. */
  putMarkets(markets: Record<string, Market>): void;

  // gate-levers (operator control input; polled)
  getGateLevers(): Promise<GateLevers | null>;
  putGateLevers(levers: GateLevers): Promise<void>;

  // append-only history (batched, fire-and-forget)
  appendMarketHistory(rows: MarketHistoryRow[]): void;
  appendTradeObservations(rows: TradeObservation[]): void;
  appendMineEvents(rows: MineEvent[]): void;

  // static coords
  getWaypoints(): Promise<Waypoint[]>;

  /** Flush all internal append batchers + pending fire-and-forget writes. */
  flush(): Promise<void>;
}

// ── Ship actions (port of trade.mjs) ─────────────────────────────────────────

export type FlightMode = 'CRUISE' | 'BURN' | 'DRIFT' | 'STEALTH';

export interface ShipActions {
  getShip(sym: string): Promise<Ship>;
  ensureDocked(sym: string, shipState?: Ship): Promise<Ship>;
  ensureOrbit(sym: string): Promise<void>;
  setMode(sym: string, mode: FlightMode): Promise<void>;
  waitArrival(sym: string, ship?: Ship): Promise<Ship>;
  refuel(sym: string): Promise<Ship>;
  navigate(sym: string, dest: string, mode?: FlightMode): Promise<Ship>;
  buy(sym: string, symbol: string, units: number, maxPx?: number): Promise<{ bought: number; spent: number }>;
  sell(sym: string, symbol: string): Promise<{ got: number }>;
  /** [RULE: transfer-argorder] (fromSym, toSym, symbol, units) */
  transfer(fromSym: string, toSym: string, symbol: string, units: number): Promise<unknown>;
  deliver(sym: string, contractId: string, tradeSymbol: string, units: number): Promise<unknown>;
  fulfill(sym: string, contractId: string): Promise<unknown>;
  jump(sym: string, destGateWp: string): Promise<unknown>;
}

// ── Routing (port of bot2.mjs flight/route math) ─────────────────────────────

export interface ModeChoice {
  mode: FlightMode;
  fuel: number;
  time: number;
  cost?: number;
}

export interface RouteCost {
  fuelCr: number;
  timeS: number;
}

export interface Router {
  /** Cheapest feasible flight mode for a single leg of `dist` units. */
  chooseMode(dist: number, ship: Ship): ModeChoice;
  /** Dijkstra over fuel nodes (≤1-tank hops). `null` when unreachable. */
  planRoute(from: string, to: string, fuelCap: number, markets: Record<string, Market>): string[] | null;
  /** Any-arrival refuel route (carried fuel bridges dry legs). `null` when unreachable. */
  planRouteFuelCargo(from: string, to: string, fuelCap: number, markets: Record<string, Market>): string[] | null;
  /** Estimated fuel-credits + seconds for a (possibly multi-hop) trip — lane scoring. */
  routeCost(from: string, to: string, ship: Ship): RouteCost;
}

// ── Markets service (port of bot2.mjs market cache) ──────────────────────────

export interface MarketsService {
  /** Cached markets map (refreshes past `MARKET_TTL_MS`, single-flight dedupe). */
  getMarkets(): Promise<Record<string, Market>>;
  /** Live per-ship-fuel-unit cost (median market FUEL price ÷ 100). */
  getFuelPx(): number;
  /** Boot read: load the last persisted snapshot from the API. */
  loadSnapshot(): Promise<Record<string, Market>>;
  /** Best cross-market margin per good (router-distance gated). */
  goodMargins(markets: Record<string, Market>): Record<string, number>;
  /** Refresh per-good margin EMA baselines from a markets map. */
  updateBaselines(markets: Record<string, Market>): void;
}
