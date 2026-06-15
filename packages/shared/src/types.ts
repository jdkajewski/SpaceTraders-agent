/**
 * @st/shared — domain types
 *
 * Only fields the bot actually uses are listed (partial SpaceTraders API shapes).
 * Richer shapes will be added in Wave 1 (API) / Wave 2 (bot).
 */

// ── SpaceTraders API shapes (partial) ────────────────────────────────────────

export interface ShipNav {
  systemSymbol: string;
  waypointSymbol: string;
  status: 'IN_TRANSIT' | 'IN_ORBIT' | 'DOCKED';
  flightMode: 'CRUISE' | 'BURN' | 'DRIFT' | 'STEALTH';
  route: {
    origin: { symbol: string; x: number; y: number };
    destination: { symbol: string; x: number; y: number };
    departureTime: string;
    arrival: string;
  };
}

export interface ShipCargo {
  capacity: number;
  units: number;
  inventory: Array<{ symbol: string; units: number }>;
}

export interface ShipEngine {
  speed: number;
  condition: number;
}

export interface ShipFrame {
  /** Frame type symbol (e.g. FRAME_PROBE). Optional: not all API reads populate it. */
  symbol?: string;
  condition: number;
  integrity: number;
}

export interface ShipFuel {
  current: number;
  capacity: number;
}

export interface ShipMount {
  symbol: string;
}

export interface Ship {
  symbol: string;
  nav: ShipNav;
  cargo: ShipCargo;
  engine: ShipEngine;
  frame: ShipFrame;
  fuel: ShipFuel;
  mounts: ShipMount[];
  /** Installed modules (e.g. MODULE_ORE_REFINERY_I). Optional: only some reads populate it. */
  modules?: ShipMount[];
}

export interface MarketGood {
  symbol: string;
  type: 'EXPORT' | 'IMPORT' | 'EXCHANGE';
  tradeVolume: number;
  supply: string;
  activity?: string;
  purchasePrice: number;
  sellPrice: number;
}

export interface Market {
  symbol: string;
  exports?: Array<{ symbol: string }>;
  imports?: Array<{ symbol: string }>;
  exchange?: Array<{ symbol: string }>;
  tradeGoods?: MarketGood[];
}

export interface ContractDeliverGood {
  tradeSymbol: string;
  destinationSymbol: string;
  unitsRequired: number;
  unitsFulfilled: number;
}

export interface Contract {
  id: string;
  type: string;
  terms: {
    deadline: string;
    payment: { onAccepted: number; onFulfilled: number };
    deliver: ContractDeliverGood[];
  };
  accepted: boolean;
  fulfilled: boolean;
  expiration: string;
}

// ── Bot domain types ──────────────────────────────────────────────────────────

export type Phase =
  | 'BOOTSTRAP'
  | 'TRADE'
  | 'GATE_FILL'
  | 'FEED'
  | 'EXPAND'
  | 'POST_GATE';

export interface Lane {
  good: string;
  buyWp: string;
  sellWp: string;
  buyPx: number;
  sellPx: number;
  net: number;
  netPerMin: number;
  units: number;
  dist: number;
  claimedBy?: string;
}

export interface RideAlong {
  good: string;
  units: number;
  net: number;
}

export interface Intent {
  shipSym: string;
  phase: string;
  good: string;
  units: number;
  buyWp: string;
  sellWp: string;
  costBasis: number;
  extras?: Record<string, unknown>;
}

export interface GateLevers {
  floor: number;
  resume: number;
  gap: number;
}

export interface GateState {
  built: boolean;
  materials: Record<string, { required: number; fulfilled: number }>;
  active: boolean;
}

export interface ContractInfo {
  contractId: string;
  ownerShip: string;
  good: string;
  destWp: string;
  unitsRequired: number;
  unitsFulfilled: number;
  payout: number;
  deadline: string;
  forced: boolean;
}

export interface PerShip {
  symbol: string;
  phase: string;
  good: string;
  buyWp: string;
  sellWp: string;
  net: number;
  status: string;
}

/**
 * Status snapshot = the body POSTed to `POST /status`. Shape matches the API
 * route schema exactly: the mandatory summary columns plus `data`, which carries
 * the full bot-status.json-compatible snapshot (built by the bot's `writeStatus`).
 *
 * Wave 3 (DRIFT #20): redefined from the earlier speculative shape (`ts`/`ships`/
 * `gate: GateState`) to the real API body so the bot persistence client's
 * `postStatus(snapshot)` validates against `/status`. `gate` is a short string
 * label (or null), NOT the structured `GateState` (which now lives only inside `data`).
 */
export interface StatusSnapshot {
  phase: string;
  runNet: number;
  credits: number;
  gate?: string | null;
  data: unknown;
}

export interface RunStats {
  totalNet: number;
  lanesRun: number;
  updatedAt: string;
}

export interface Survey {
  signature: string;
  symbol: string;
  deposits: Array<{ symbol: string }>;
  expiration: string;
  size: 'SMALL' | 'MODERATE' | 'LARGE';
}

export interface MineEvent {
  ts: string;
  type: 'extract' | 'refine' | 'survey' | 'feed';
  ship: string;
  data: Record<string, unknown>;
}

export interface TradeObservation {
  ts: string;
  ship: string;
  good: string;
  buyWp: string;
  sellWp: string;
  projected: number;
  realized: number;
  units: number;
  buyPx: number;
  sellPx: number;
}

export interface MarketHistoryRow {
  ts: string;
  waypoint: string;
  good: string;
  purchasePrice: number;
  sellPrice: number;
  tradeVolume: number;
  supply: string;
  activity?: string;
}

// ── API request / response DTOs (used by both @st/api routes and Wave 2 bot client) ──

export interface BatchInsertResult {
  inserted: number;
}

export interface RunStatsDto {
  totalNet: number;
  lanesRun: number;
  updatedAt: string;
}

export type RunStatsPutBody = Omit<RunStatsDto, 'updatedAt'>;

export interface IntentDto {
  shipSym: string;
  phase: string;
  good: string;
  units: number;
  buyWp: string;
  sellWp: string;
  costBasis: number;
  extras?: Record<string, unknown>;
  updatedAt: string;
}

export type IntentPutBody = Omit<IntentDto, 'shipSym' | 'updatedAt'>;

export interface StatusSnapshotDto {
  id: string;
  createdAt: string;
  phase: string;
  runNet: number;
  credits: number;
  gate?: string | null;
  data: unknown;
}

export type StatusPostBody = StatusSnapshot;

export interface MarketSnapshotDto {
  waypoint: string;
  data: unknown;
  updatedAt: string;
}

export interface GateLeversDto {
  floor: number;
  resume: number;
  gap: number;
  updatedAt: string;
}

export type GateLeversPutBody = Omit<GateLeversDto, 'updatedAt'>;

export interface MarketHistoryFilter {
  waypoint?: string;
  good?: string;
  since?: string;
  limit?: number;
}

export interface TradeObservationFilter {
  shipSym?: string;
  good?: string;
  since?: string;
  limit?: number;
}

export interface MineEventFilter {
  shipSym?: string;
  type?: string;
  since?: string;
  limit?: number;
}

export interface WaypointDto {
  symbol: string;
  x: number;
  y: number;
}
