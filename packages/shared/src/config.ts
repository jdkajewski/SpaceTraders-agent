/**
 * @st/shared — environment config
 *
 * Zod schema parsing all ~106 env flags from bot2.mjs.
 * Defaults are the CODE defaults (not operator live-launch values) as declared
 * at the top of bot2.mjs. Boolean idioms faithfully mirrored:
 *   - `!== '0'`  → default true  (z.string().default('1') → coerce to boolean)
 *   - `=== '1'`  → default false (z.string().default('0') → coerce to boolean)
 * Set-typed flags (comma-separated) are returned as string[].
 */

import { z } from 'zod';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Boolean flag that defaults ON (`!== '0'` idiom from bot2.mjs). */
const boolOn = z
  .string()
  .optional()
  .default('1')
  .transform((v) => v !== '0');

/** Boolean flag that defaults OFF (`=== '1'` idiom from bot2.mjs). */
const boolOff = z
  .string()
  .optional()
  .default('0')
  .transform((v) => v === '1');

/** A number parsed from a string env var. */
const num = (def: number) =>
  z
    .string()
    .optional()
    .default(String(def))
    .transform((v) => Number(v));

/** Optional string (defaults to ''). */
const str = (def = '') =>
  z
    .string()
    .optional()
    .default(def)
    .transform((v) => v);

/** Comma-separated set: "a,b,c" → ["a","b","c"] (trimmed, empty-filtered). */
const csvSet = z
  .string()
  .optional()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

/** Key:value pair map: "K1:100,K2:200" → {K1:100, K2:200} */
const kvMap = z
  .string()
  .optional()
  .default('')
  .transform((v) => {
    const out: Record<string, number> = {};
    for (const p of v.split(',')) {
      const [k, val] = p.split(':');
      if (k && val && Number(val) > 0) out[k.trim()] = Number(val);
    }
    return out;
  });

// ── raw schema (all fields parsed independently) ────────────────────────────

const RawConfigSchema = z.object({
  // ── core trade ──────────────────────────────────────────────────────────
  SYSTEM: str('X1-PP30'),
  MAXD: num(2000),
  MIN_NET: num(4000),
  VALUE_OF_TIME: num(100),
  COOLDOWN_MS: num(300_000),
  COOLDOWN_FLOOR_MS: num(60_000),
  COOLDOWN_MIN_MULT: num(0.33),
  COOLDOWN_MAX_MULT: num(4),
  DEAD_LANE_PENALTY: num(3),
  PARK_MIN_NET: num(0),
  SPEED_FAR_DIST: num(250),

  // ── ride-along / multi-good ─────────────────────────────────────────────
  MULTI_GOOD: boolOn,
  RIDEALONG_MIN_GROSS: num(1000),
  CONTRACT_RIDEALONG: boolOn, // default ON (tied to MULTI_GOOD && !== '0' in code; see post-transform)

  // ── fill-bias ───────────────────────────────────────────────────────────
  FILL_BIAS: boolOn,
  FILL_BIAS_EPS: num(0.10),
  GATE_DROPOFF_WEIGHT: num(0.5),

  // ── phase / budget ──────────────────────────────────────────────────────
  BOOTSTRAP_FLEET_MIN: num(2),
  CREDIT_TARGET: num(0),
  SLIPPAGE_FACTOR: num(1.5),
  GOODS_CUSHION: num(300_000),
  GOODS_CUSHION_PER_SHIP: num(25_000),
  RESERVE_CONCURRENCY: num(3),
  OPERATING_RESERVE: num(200_000),
  NEW_CELL_SEED: num(600_000),
  HAULER_PRICE: num(314_345),

  // ── contracts ───────────────────────────────────────────────────────────
  CONTRACTS: boolOn,
  TRADE_FIRST: boolOff,
  CONTRACT_AVOID_GATE_PRODUCER: boolOn,
  CONTRACT_BEST_SHIP: boolOn,
  CONTRACT_MIN_MARGIN: num(1000),
  CONTRACT_MIN_MARGIN_PCT: num(0.04),
  CONTRACT_MAX_SRC_DIST: num(500),
  CONTRACT_FUEL_PX: num(2),
  CONTRACT_MAX_HOPS: num(6),
  CONTRACT_AUTOFORCE_MINS: num(20),
  CONTRACT_REELECT_MARGIN: num(40),
  CONTRACT_RUNNER: csvSet,
  CONTRACT_FORCE: csvSet,
  DEBUG_CONTRACT: boolOff,
  NEGOTIATOR: str('SPACEJAM-DK-2-15'),

  // ── gate supply ─────────────────────────────────────────────────────────
  GATE_SUPPLY: boolOn,
  GATE_CREDIT_FLOOR: num(1_500_000),
  GATE_CREDIT_RESUME_GAP: num(250_000),
  // GATE_CREDIT_RESUME is derived in post-transform (FLOOR + GAP) when not set
  GATE_CREDIT_RESUME: z.string().optional(), // handled below
  GATE_SUPPLY_MAX_UNITS: num(0),
  GATE_MAX_SUPPLIERS: num(2),
  GATE_PRICE_CEIL_FACTOR: num(2.0),
  GATE_PRICE_SETTLE_MS: num(240_000),
  GATE_PRICE_REBOUND_EPS: num(0.02),
  GATE_MAX_PRICE: kvMap,
  GATE_PROTECT: boolOn,
  GATE_PROTECT_MATERIALS: z
    .string()
    .optional()
    .default('FAB_MATS,ADVANCED_CIRCUITRY,QUANTUM_STABILIZERS')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  GATE_FUEL_CARGO: boolOff,
  GATE_HAULERS: csvSet,
  ORPHAN_GATE_DELIVERY: boolOn,
  ORPHAN_MIN_UNITS: num(5),

  // ── input feed ──────────────────────────────────────────────────────────
  INPUT_FEED: boolOff,
  // HARD-capped ≤ 2 regardless of env — replicated in post-transform
  INPUT_FEED_MAX: z
    .string()
    .optional()
    .default('2')
    .transform((v) => Math.min(2, Number(v))),
  INPUT_FEED_MIN_GROSS: num(0),
  INPUT_FEED_GATE_PAUSE: boolOff,
  INPUT_FEED_MIN_CASH: num(0),
  INPUT_FEEDERS: csvSet,
  FEED_FOCUS_MATERIALS: z
    .string()
    .optional()
    .default('FAB_MATS')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  FEED_MAX_LOSS_PER_UNIT: num(30),
  FEED_RESERVE_INPUTS: boolOn,
  FEED_MAX_PRICE: kvMap,
  // FEED_PRICE_SETTLE_MS / FEED_PRICE_REBOUND_EPS default to GATE counterparts; see post-transform
  FEED_PRICE_SETTLE_MS: z.string().optional(), // handled below
  FEED_PRICE_REBOUND_EPS: z.string().optional(), // handled below

  // ── mining ──────────────────────────────────────────────────────────────
  MINE_FEED: boolOff,
  MINE_FEEDERS: csvSet,
  MINE_GOOD: str(''),
  MINE_BATCH: num(24),
  MINE_PRODUCER: str(''),
  MINE_TRANSPORT: csvSet,
  MINE_FUEL_RESERVE: num(12),
  MINE_FUNNEL: csvSet,
  MINE_CLOG_AT: num(32),
  MINE_ORE_RESERVE: num(30), // default = REFINE_IN constant (30) in bot2.mjs
  MINE_RAW_RELIEF: boolOn,

  // ── repair ──────────────────────────────────────────────────────────────
  REPAIR: boolOff,
  REPAIR_COND_MIN: num(0.85),
  REPAIR_INTEG_FORCE: num(0.5),
  REPAIR_MAX_COST: num(100_000),

  // ── fleet scale ─────────────────────────────────────────────────────────
  FLEET_SCALE: boolOff,
  FLEET_SCALE_FLOOR: num(30_000),
  FLEET_SCALE_MS: num(120_000),
  FLEET_HAULER_MIN: num(350_000),
  FLEET_SHUTTLE_MIN: num(120_000),
  FLEET_TARGET_TRADERS: num(4),
  FLEET_BASE_PROBES: num(5),
  FLEET_PROBE_RATIO: num(3),
  FLEET_MAX_PROBES: num(0),
  FLEET_MAX_HAULERS: num(6),
  FLEET_TABLE: boolOn,
  FLEET_TABLE_MS: num(60_000),

  // ── mine expand / migrate ────────────────────────────────────────────────
  MINE_EXPAND: boolOff,
  MINE_MAX_SURVEYORS: num(3),
  MINE_MAX_DRONES: num(4),
  MINE_EXPAND_CREDIT_FLOOR: num(600_000),
  MINE_EXPAND_SCAN_MS: num(600_000),
  MINE_MIGRATE: boolOff,
  MINE_MIGRATE_SCAN_MS: num(300_000),

  // ── fuel cargo ──────────────────────────────────────────────────────────
  FUEL_CARGO: boolOff,

  // ── expansion ───────────────────────────────────────────────────────────
  AUTO_EXPAND: boolOff,
  EXPAND_TARGET_SYSTEM: str(''),

  // ── API server (Wave 1 additions — not in legacy bot2.mjs) ───────────────
  API_PORT: num(3000),
  API_HOST: str('0.0.0.0'),
  BOT_KEY: str(''),
  BOT_AUTH_ENABLED: boolOff,
});

// ── post-transform: resolve derived defaults ─────────────────────────────────

/**
 * Config type after post-processing.
 * CONTRACT_RIDEALONG depends on MULTI_GOOD; GATE_CREDIT_RESUME depends on
 * GATE_CREDIT_FLOOR + GATE_CREDIT_RESUME_GAP; FEED_PRICE_* mirror GATE_PRICE_*.
 */
export type Config = Omit<
  z.infer<typeof RawConfigSchema>,
  'GATE_CREDIT_RESUME' | 'FEED_PRICE_SETTLE_MS' | 'FEED_PRICE_REBOUND_EPS'
> & {
  GATE_CREDIT_RESUME: number;
  FEED_PRICE_SETTLE_MS: number;
  FEED_PRICE_REBOUND_EPS: number;
};

/**
 * Parse all env flags from the provided env map (defaults to `process.env`).
 * Applies code defaults and the boolean idioms from bot2.mjs exhaustively.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = RawConfigSchema.parse(env);

  // [GATE_CREDIT_RESUME] default = GATE_CREDIT_FLOOR + GATE_CREDIT_RESUME_GAP
  const gateResumeRaw = env['GATE_CREDIT_RESUME'];
  const gateResume =
    gateResumeRaw !== undefined
      ? Number(gateResumeRaw)
      : raw.GATE_CREDIT_FLOOR + raw.GATE_CREDIT_RESUME_GAP;

  // [FEED_PRICE_*] default mirrors GATE_PRICE_* counterpart
  const feedSettleRaw = env['FEED_PRICE_SETTLE_MS'];
  const feedReboundRaw = env['FEED_PRICE_REBOUND_EPS'];
  const feedPriceSettleMs =
    feedSettleRaw !== undefined ? Number(feedSettleRaw) : raw.GATE_PRICE_SETTLE_MS;
  const feedPriceReboundEps =
    feedReboundRaw !== undefined ? Number(feedReboundRaw) : raw.GATE_PRICE_REBOUND_EPS;

  // [CONTRACT_RIDEALONG] tied to MULTI_GOOD in the code:
  //   `const CONTRACT_RIDEALONG = MULTI_GOOD && process.env.CONTRACT_RIDEALONG !== '0';`
  const contractRidealong = raw.MULTI_GOOD && env['CONTRACT_RIDEALONG'] !== '0';

  return {
    ...raw,
    CONTRACT_RIDEALONG: contractRidealong,
    GATE_CREDIT_RESUME: gateResume,
    FEED_PRICE_SETTLE_MS: feedPriceSettleMs,
    FEED_PRICE_REBOUND_EPS: feedPriceReboundEps,
  };
}
