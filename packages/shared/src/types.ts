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

export interface StatusSnapshot {
  ts: string;
  credits: number;
  phase: Phase;
  runNet: number;
  gate: GateState | null;
  ships: PerShip[];
  raw?: unknown;
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
