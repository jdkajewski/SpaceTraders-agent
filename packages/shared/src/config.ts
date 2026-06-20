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
  // Home system. Default is EMPTY so the bot auto-detects it from /my/agent HQ at
  // boot (greenfield-safe across weekly resets). Set SYSTEM explicitly to pin it.
  SYSTEM: str(''),
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

  // ── value-weighted scan budgeting (issue #2) ────────────────────────────
  // Every per-market `GET /market` spends against the shared 2 req/s ceiling, so scan budget is
  // allocated by profit contribution rather than uniformly. Defaults keep the average market near
  // the legacy 75s cadence while concentrating reads on high-value lanes and starving dead markets.
  SCAN_BASE_MS: num(75_000), // base interval for an average-value, flat market (legacy MARKET_TTL_MS)
  SCAN_MIN_MS: num(30_000), // hard floor — even the hottest market won't refresh faster than this
  SCAN_MAX_MS: num(600_000), // hard ceiling — a dead market still gets a cheap re-check this often
  SCAN_SWEEP_MS: num(10_000), // min wall-clock between due-checks (throttles getMarkets evaluation)
  SCAN_VALUE_REALIZED_WEIGHT: num(1), // weight on realized lane-profit attribution
  SCAN_VALUE_STRUCTURAL_WEIGHT: num(1), // weight on structural potential (Σ tradeVolume × margin)
  SCAN_VALUE_VOLUME_WEIGHT: num(0), // weight on raw Σ tradeVolume (off by default; pure tie-breaker)
  SCAN_VAL_FACTOR_MIN: num(0.1), // clamp on valueFactor = V/Vref (dead market floor)
  SCAN_VAL_FACTOR_MAX: num(10), // clamp on valueFactor (hot market ceiling)
  SCAN_VOL_ALPHA: num(0.3), // EWMA weight for per-market price-volatility updates
  SCAN_VOL_GAIN: num(10), // maps relative price change → volatility multiplier
  SCAN_VOL_FACTOR_MIN: num(0.5), // clamp on volFactor (flat market lengthens interval)
  SCAN_VOL_FACTOR_MAX: num(4), // clamp on volFactor (churning market shortens interval)
  LANE_VALUE_ALPHA: num(0.3), // EWMA weight for realized net per lane
  LANE_VALUE_HALFLIFE_MS: num(1_800_000), // staleness half-life for a lane's realized value (30 min)
  // LANE_VALUE_* validated on live UPRISING: realized net/lane was highly dispersed (median 21,980,
  // p90 60,480, min −90,240, 15.5% negative) so a smoothing alpha 0.3 tames per-trip noise; lanes
  // completed fleet-wide at ~0.8/min, for which a 30-min half-life keeps stale lanes fading without
  // thrashing. Realized value concentrated in ~12 sinks/goods → TOPK 20 comfortably covers them.
  LANE_TOPK: num(20), // top-K lanes retained in the registry status block

  // ── value-driven coverage tiering + reversible pruning + cold re-check (issue #2, phases 4+7) ──
  // Probes only yield live prices where a ship is present, so coverage is a budget too. These levers
  // let probe placement follow VALUE instead of parking ~1 probe per market uniformly. Both master
  // switches default OFF, so with defaults `fleet/scale` is byte-for-byte the legacy behaviour.
  FLEET_COVERAGE_ADAPTIVE: boolOff, // value-driven probe TARGET + PLACEMENT (non-mutating to existing probes)
  FLEET_COVERAGE_PRUNE: boolOff, // also redeploy probes off DEAD markets + cold re-visit (FLEET-MUTATING)
  COVERAGE_HOT_MULT: num(2), // rel value ≥ 2× fleet mean ⇒ HOT
  COVERAGE_WARM_MULT: num(0.75), // rel ≥ 0.75× ⇒ WARM
  COVERAGE_COLD_MULT: num(0.2), // rel ≥ 0.2× ⇒ COLD; below ⇒ DEAD (never worth a parked probe)
  // The DEAD cutoff (rel < 0.2× fleet mean) targets the genuinely-dead tail; live UPRISING showed a
  // 15.5% negative-lane share — the empirical dead-market fraction the DEAD tier + scan de-prioritising
  // should catch (see the replay calibration test, which asserts the cheap tier captures a comparable
  // share of the real value distribution).
  COVERAGE_TARGET_BASE: num(3), // value-driven probe target floor before signal bonuses
  COVERAGE_LANE_BONUS: num(1), // +N covered markets per active lane (maturity → wider coverage)
  COVERAGE_FLEET_BONUS: num(0.5), // +N covered markets per ship in the fleet
  COVERAGE_TARGET_MIN: num(3), // never cover fewer than this (keep the engine fed at cold start)
  COVERAGE_RECHECK_BASE_MS: num(1_800_000), // base cold re-visit interval at rel = 1 (30 min)
  COVERAGE_RECHECK_MIN_MS: num(600_000), // floor — promising uncovered market re-visited at most this often (10 min)
  COVERAGE_RECHECK_MAX_MS: num(21_600_000), // ceiling — even a dead market is re-checked this often, never forgotten (6 h)

  // ── global scan-budget priority scheduler (issue #2, phase 5) ──────────────────────────────────
  // PR1 gave each market a per-market interval; this makes the SHARED ~2 req/s budget explicit. When
  // many markets are due in one sweep, scans are granted highest value×staleness first (not FIFO) up
  // to a per-sweep budget that reserves headroom for trade/nav. Default OFF ⇒ legacy fetch-all-due.
  SCAN_BUDGET_ON: boolOff, // gate the priority scheduler; off ⇒ refreshDue fetches every due market in order
  SCAN_BUDGET_REQ_PER_SEC: num(2), // account request ceiling the budget is computed against (mirror the client)
  // Calibrated from 13.45h of live UPRISING (.mjs) telemetry: observed request mix was scans 40.1% /
  // actions 55.7% / price-reads 4.3%. 0.4 caps scans at their empirical share so actions keep their
  // observed ~60% — matches Steer #2's action-protection intent. At the observed steady-state scan
  // rate (5.74/min) this cap never binds; it only bounds a synchronized due-burst.
  SCAN_BUDGET_REQ_FRACTION: num(0.4), // fraction of sweep capacity scans may spend (rest reserved for trades)
  SCAN_BUDGET_MAX_PER_SWEEP: num(0), // absolute hard cap on reads per sweep; 0 ⇒ fraction-derived only

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
  // [GATE] PRICE HYSTERESIS resume thresholds (anti-sawtooth on the per-material price cap). GATE_MAX_PRICE is the
  // HARD pause line; we do NOT resume buying the instant a material dips back under it (that sawtooths at the
  // ceiling) — we wait until it COOLS to GATE_RESUME_PRICE (an explicit per-material floor, or max ×
  // GATE_RESUME_PRICE_FACTOR when unset). Mirrors the credit floor/resume latch, inverted for price. (bot2 L216-227)
  GATE_RESUME_PRICE: kvMap,
  GATE_RESUME_PRICE_FACTOR: num(0.9),
  // [GATE] Fraction of the free growth budget the gate may spend per planning pass (the rest stays liquid for the
  // trading/contract/feed earners that refill the pool, so gate buying never starves them). Clamped to [0,1].
  // Live-tunable via the gate-levers control input (budgetFraction). (bot2 L228-230)
  GATE_BUDGET_FRACTION: z
    .string()
    .optional()
    .default('0.8')
    .transform((v) => Math.min(1, Math.max(0, Number(v)))),
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
  // [FEED RESERVE] Which materials' inputs get RESERVED out of non-feed trades (separate from FEED_FOCUS so we can
  // focus-FEED a material without locking its fat-lane inputs). Defaults to FAB_MATS only: FAB's inputs (IRON/QUARTZ/
  // SILICON/COPPER) are thin and worth reserving; ADV_CIRC's inputs (MACHINERY/MICROPROCESSORS) are fat trade lanes
  // that already sell into D45, so we feed ADV but DON'T reserve its inputs. (bot2 L268-272)
  FEED_RESERVE_MATERIALS: z
    .string()
    .optional()
    .default('FAB_MATS')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  // [FEED SECOND-LEVEL] Also feed the SUB-producers that make a gate producer's SCARCE inputs (e.g. J62 ore → H55,
  // which makes the IRON/COPPER/ALUMINUM that F49 and D45 need). Restocks the bottleneck at its true source. Default
  // ON. (bot2 L273-274)
  FEED_SECOND_LEVEL: boolOn,
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

  // ── expansion (port of expansion.mjs — Wave 5; all default OFF/inert) ─────
  AUTO_EXPAND: boolOff,
  EXPAND_TARGET_SYSTEM: str(''),
  // 0 ⇒ derived at runtime (reserve()+400_000); see createExpansion.
  EXPAND_CREDIT_FLOOR: num(0),
  EXPAND_HAULERS: csvSet,
  EXPAND_LIGHT: csvSet,
  EXPAND_PROBES: csvSet,
  EXPAND_MAX_PROBES: num(4),
  EXPAND_MIN_NET: num(1000),
  EXPAND_PROBE_DWELL_MS: num(90_000),
  EXPAND_SCAN_TTL_MS: num(120_000),
  EXPAND_JUMP_COST: num(12_000),
  EXPAND_JUMP_COOLDOWN_MIN: num(8.2),
  EXPAND_OP_OVERHEAD_MIN: num(1.5),
  // outpost fan-out (default OFF — empty set)
  EXPAND_OUTPOSTS: csvSet,
  EXPAND_OUTPOST_PROBES: num(2),
  EXPAND_OUTPOST_TRADERS: num(1),
  // galaxy-driven outpost selection: when AUTO_EXPAND runs with the crawler
  // (GALAXY_CRAWL) and EXPAND_OUTPOSTS is empty, seed the top-N ranked reachable
  // systems as outposts instead of a hardcoded list.
  EXPAND_OUTPOST_MAX: num(6),
  // fueled-relay seeding hull (port of seed-relay.mjs): relay ONE fueled hull
  // home→target via chained gate jumps, then buy probes/traders LOCALLY.
  EXPAND_RELAY_HULL: str('SHIP_LIGHT_HAULER'),
  // fleet auto-buy (default OFF)
  EXPAND_AUTOBUY: boolOff,
  // 0 ⇒ derived at runtime (max(FLOOR+250_000, 700_000)); see createExpansion.
  EXPAND_BUY_FLOOR: num(0),
  EXPAND_AUTOBUY_MS: num(90_000),
  EXPAND_MAX_BUY_PROBES: num(24),
  EXPAND_MAX_BUY_TRADERS: num(8),
  EXPAND_PROBE_TARGET: num(0),
  EXPAND_TRADER_PREF: str(
    'SHIP_HEAVY_FREIGHTER,SHIP_REFINING_FREIGHTER,SHIP_LIGHT_HAULER,SHIP_LIGHT_SHUTTLE,SHIP_COMMAND_FRIGATE',
  ),

  // ── galaxy crawler (home-rooted BFS map for AUTO_EXPAND; default OFF) ──────
  // When on, a gentle background crawler BFS-maps the jump-gate network from
  // home, ranks rich markets, and persists the galaxy map (System/GateEdge/
  // SystemRichness). AUTO_EXPAND consumes its ranked targets + gate graph.
  GALAXY_CRAWL: boolOff,
  // Min spacing between crawler API calls (ms) so trading ships keep priority
  // on the shared 2 req/s account ceiling. ~1500–2000ms is gentle.
  GALAXY_CRAWL_GAP_MS: num(1800),
  // Systems persisted per batched upsert flush.
  GALAXY_CRAWL_BATCH: num(25),
  // Re-crawl a system for refresh once it is older than this (ms). Gates finish
  // over time, so periodic re-checks keep build-state + richness fresh.
  GALAXY_REFRESH_MS: num(3_600_000),
  // Promote a ranked candidate to FULL-tier richness (per-market + shipyard
  // reads) once it lands in the top-N by counts-tier score.
  GALAXY_FULL_TOP_N: num(40),
  // Ranking weights (score = Σ wᵢ·featureᵢ); marketplace count is primary.
  GALAXY_W_MARKET: num(10),
  GALAXY_W_IMPORT: num(3),
  GALAXY_W_YARD: num(5),
  GALAXY_W_PREMIUM: num(8),
  // Stop the (already flag-guarded) mining manager once the gate is BUILT and
  // expansion begins — lets mining colonies be abandoned post-gate. Default ON
  // (preserves the legacy always-stop-after-gate behavior); set to 0 to keep
  // mining running through and after expansion.
  MINE_STOP_AFTER_GATE: boolOn,

  // ── dry-run / offline smoke (Wave 5 — not in legacy bot2.mjs) ─────────────
  // When DRY_RUN=1 the SpaceTraders game client is swapped for a no-op fixture
  // client (no live game calls, no mutations); the bot still talks to the
  // persistence API. DRY_RUN_CREDITS seeds the fixture agent balance.
  DRY_RUN: boolOff,
  DRY_RUN_CREDITS: num(1_000_000),

  // ── API server (Wave 1 additions — not in legacy bot2.mjs) ───────────────
  API_PORT: num(3000),
  API_HOST: str('0.0.0.0'),
  BOT_KEY: str(''),
  BOT_AUTH_ENABLED: boolOff,

  // ── bot runtime endpoints (Wave 3 — fold st.mjs/bot2 process.env reads into
  //    shared config; resolves DRIFT #17) ────────────────────────────────────
  API_BASE_URL: str('http://localhost:3000'),
  SPACETRADERS_PLAYER_AGENT_TOKEN: str(''),
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
