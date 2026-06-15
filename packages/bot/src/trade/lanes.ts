/**
 * trade/lanes.ts — lane build / score / claim (the trade scheduler)
 * (port of bot2.mjs L396–501 cooldownFor/buildLanes/planRideAlongs and
 * L322–392 gateSinkWaypoints/claimLane + the gate-protect read helpers L196–201,
 * L992–1018).
 *
 * `buildLanes` enumerates the best-gross lane per good (MAXD-gated, gate-protect
 * guarded). `claimLane` re-scores every lane on *true net/min* using the Wave-2
 * refuel-aware router (`routeCost`), applies the fill-bias tie-break, and atomically
 * locks the good + commits cash. `planRideAlongs` plans zero-detour multi-good fill.
 *
 * Parity-first: `[FAB GUARD]`/`[FEED FOCUS]`/`[FILL-BIAS]`/`[D]`/`[PARK]` and the
 * claimLane atomicity rule are preserved verbatim.
 */

import type { Config, Market, MarketGood, Ship } from '@st/shared';
import type { BotState } from '../runtime/state.js';
import type { Router } from '../interfaces.js';
import { gs } from '../runtime/state.js';
import { availableForWork, growthBudget, commit, noteLaneCost } from '../budget/budget.js';
import { gateSupplyActive } from '../budget/phase.js';
import { findProducerWp } from './marketHelpers.js';

const now = (): number => Date.now();

/** A profit lane (bot2 lane object: legacy field names preserved). */
export interface Lane {
  sym: string;
  buyWp: string;
  buy: number;
  sellWp: string;
  sell: number;
  margin: number;
  units: number;
  dist: number;
  gross: number;
}

/** A planned zero-detour ride-along buy. */
export interface RideAlongPlan {
  sym: string;
  buy: number;
  sell: number;
  margin: number;
  tv: number;
  units: number;
}

/** Result of an attempted lane claim. */
export type ClaimResult =
  | { lane: Lane; score: number; cost: number; projectedNet: number }
  | { park: true; score: number; projectedNet: number }
  | null;

export type DistFn = (a: string, b: string) => number;

// ── gate-protect read helpers (bot2 L196–201, L992–1018) ─────────────────────

/**
 * The gate materials the build STILL needs (remaining > 0). Unknown gate → protect all
 * (safe default); built → protect nothing. (bot2 `activeGateMaterials` L196–201)
 */
export function activeGateMaterials(state: BotState, cfg: Config): Set<string> {
  if (!cfg.GATE_PROTECT) return new Set();
  const g = state.gateCache;
  if (!g.known || !g.exists) return new Set(cfg.GATE_PROTECT_MATERIALS);
  if (g.built) return new Set();
  return new Set(cfg.GATE_PROTECT_MATERIALS.filter((m) => (g.remaining[m] || 0) > 0));
}

/** Waypoints that EXPORT still-needed gate materials. (bot2 `gateProducerWps`) */
export function gateProducerWps(state: BotState, cfg: Config, markets: Record<string, Market>): Set<string> {
  const set = new Set<string>();
  if (cfg.GATE_PROTECT)
    for (const mat of activeGateMaterials(state, cfg)) {
      const w = findProducerWp(markets, mat);
      if (w) set.add(w);
    }
  return set;
}

/**
 * Producers (EXPORT) of still-needed materials in a given set. Used two ways with DIFFERENT sets:
 *   • FEED_FOCUS_MATERIALS → capped-loss feeding targets (we actively push these gate materials down).
 *   • FEED_RESERVE_MATERIALS → input reservation (we hold these producers' inputs out of non-feed trades).
 * Keeping them separate lets us focus-FEED a material (e.g. ADVANCED_CIRCUITRY) WITHOUT reserving its inputs
 * (MACHINERY/MICROPROCESSORS are fat trade lanes that already sell INTO D45 — reserving them would kill throughput).
 * (bot2 `producerWpsFor`)
 */
export function producerWpsFor(state: BotState, cfg: Config, markets: Record<string, Market>, matSet: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const mat of activeGateMaterials(state, cfg)) {
    if (!matSet.includes(mat)) continue;
    const w = findProducerWp(markets, mat);
    if (w) set.add(w);
  }
  return set;
}

/** Producers (EXPORT) of still-needed FOCUS materials (the long pole). (bot2 `focusProducerWps`) */
export function focusProducerWps(state: BotState, cfg: Config, markets: Record<string, Market>): Set<string> {
  return producerWpsFor(state, cfg, markets, cfg.FEED_FOCUS_MATERIALS);
}

/**
 * The input goods a RESERVE-material producer IMPORTS. RESERVED: normal lanes/ride-alongs may not
 * BUY these to sell anywhere but a focus producer. Empty unless FEED_RESERVE_INPUTS.
 * (bot2 `gateInputGoods`)
 */
export function gateInputGoods(state: BotState, cfg: Config, markets: Record<string, Market>): Set<string> {
  const set = new Set<string>();
  if (!cfg.FEED_RESERVE_INPUTS) return set;
  for (const wp of producerWpsFor(state, cfg, markets, cfg.FEED_RESERVE_MATERIALS)) {
    const m = markets[wp];
    if (!m) continue;
    for (const g of m.tradeGoods ?? []) if (g.type === 'IMPORT') set.add(g.symbol);
  }
  return set;
}

/**
 * [FILL-BIAS] Waypoints whose drop-off helps the gate: the EXPORT producers of
 * still-needed gate materials. Empty while the gate is built/unknown/off, so the bias
 * self-disables. (bot2 `gateSinkWaypoints` L325–337)
 */
export function gateSinkWaypoints(state: BotState, cfg: Config, markets: Record<string, Market>): Set<string> {
  const set = new Set<string>();
  if (!gateSupplyActive(state, cfg)) return set;
  const needed = Object.keys(state.gateCache.remaining || {});
  if (!needed.length) return set;
  for (const [wp, m] of Object.entries(markets)) {
    for (const tg of m.tradeGoods ?? []) {
      if (tg.type === 'EXPORT' && needed.includes(tg.symbol)) {
        set.add(wp);
        break;
      }
    }
  }
  return set;
}

// ── adaptive cooldown (bot2 L396–402) ────────────────────────────────────────

/**
 * Adaptive per-good cooldown: thin goods (current margin below typical) rest LONGER
 * (mult > 1), thick goods rest SHORTER (mult < 1), clamped to [MIN,MAX]_MULT and floored.
 * (bot2 `cooldownFor`)
 */
export function cooldownFor(
  sym: string,
  goodEMA: Map<string, number>,
  lastMargins: Record<string, number>,
  cfg: Config,
): number {
  const typical = goodEMA.get(sym) || 0;
  const cur = lastMargins[sym] ?? typical;
  if (typical <= 0 || cur <= 0) return cfg.COOLDOWN_MS;
  const mult = Math.min(cfg.COOLDOWN_MAX_MULT, Math.max(cfg.COOLDOWN_MIN_MULT, typical / cur)); // thick→<1, thin→>1
  return Math.max(cfg.COOLDOWN_FLOOR_MS, Math.round(cfg.COOLDOWN_MS * mult));
}

// ── lane building (bot2 L416–448) ────────────────────────────────────────────

/**
 * Enumerate the single best-gross lane per good (buy wp → sell wp). MAXD-gated, gross
 * ≥ MIN_NET, with the gate-protect / feed-focus guards. (bot2 `buildLanes`)
 */
export function buildLanes(markets: Record<string, Market>, state: BotState, cfg: Config, D: DistFn): Lane[] {
  const goods: Record<string, Array<MarketGood & { wp: string }>> = {};
  for (const [wp, m] of Object.entries(markets))
    for (const g of m.tradeGoods ?? []) (goods[g.symbol] = goods[g.symbol] ?? []).push({ wp, ...g });

  // [FAB GUARD] never source profit lanes out of still-needed gate-material producers.
  const activeMats = activeGateMaterials(state, cfg);
  const protectedWps = new Set<string>();
  if (cfg.GATE_PROTECT)
    for (const mat of activeMats) {
      const w = findProducerWp(markets, mat);
      if (w) protectedWps.add(w);
    }
  const inputGoods = gateInputGoods(state, cfg, markets); // [FEED FOCUS] reserved FAB_MATS inputs
  const focusProducers = focusProducerWps(state, cfg, markets); // [FEED FOCUS] the only sinks a reserved input may sell into

  const best: Record<string, Lane> = {};
  for (const [sym, entries] of Object.entries(goods)) {
    if (cfg.GATE_PROTECT && activeMats.has(sym)) continue; // never profit-trade a still-needed gate material
    const reservedInput = inputGoods.has(sym); // [FEED FOCUS] this good is a focus producer's input
    for (const b of entries)
      for (const s of entries) {
        if (cfg.GATE_PROTECT && protectedWps.has(b.wp)) continue; // don't buy OUT OF a gate-material producer market
        if (reservedInput && !focusProducers.has(s.wp)) continue; // [FEED FOCUS] reserved input: only a feed lane allowed
        if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
        const dist = D(b.wp, s.wp);
        if (dist > cfg.MAXD) continue;
        const units = Math.min(Math.min(b.tradeVolume, s.tradeVolume), 20);
        const margin = s.sellPrice - b.purchasePrice;
        const gross = margin * units;
        if (gross < cfg.MIN_NET) continue;
        const existing = best[sym];
        if (!existing || gross > existing.gross)
          best[sym] = { sym, buyWp: b.wp, buy: b.purchasePrice, sellWp: s.wp, sell: s.sellPrice, margin, units, dist, gross };
      }
  }
  return Object.values(best);
}

// ── ride-along fill planning (bot2 L450–501) ─────────────────────────────────

/**
 * [MULTI-GOOD] Plan zero-detour ride-along buys for a chosen lane: goods sold at
 * `lane.buyWp` that also sink profitably at `lane.sellWp`. Greedy by per-lot gross, one
 * tradeVolume lot each, bounded by remaining cargo space and cash. (bot2 `planRideAlongs`)
 */
export function planRideAlongs(
  markets: Record<string, Market>,
  lane: Lane,
  freeUnits: number,
  cashBudget: number,
  state: BotState,
  cfg: Config,
  excludeSyms: Set<string> | null = null,
): RideAlongPlan[] {
  if (!cfg.MULTI_GOOD || freeUnits <= 0 || cashBudget <= 0) return [];
  const src = markets[lane.buyWp];
  const dst = markets[lane.sellWp];
  if (!src || !dst) return [];
  // [GATE PROTECT] never source ride-alongs out of a gate-material producer market.
  if (cfg.GATE_PROTECT && gateProducerWps(state, cfg, markets).has(lane.buyWp)) return [];
  const dstSell: Record<string, MarketGood> = {};
  for (const g of dst.tradeGoods ?? []) dstSell[g.symbol] = g;
  const activeMats = activeGateMaterials(state, cfg);
  const inputGoods = gateInputGoods(state, cfg, markets);
  const focusProducers = focusProducerWps(state, cfg, markets);
  const cands: Array<{ sym: string; buy: number; sell: number; margin: number; tv: number }> = [];
  for (const g of src.tradeGoods ?? []) {
    if (g.symbol === lane.sym || !(g.purchasePrice > 0)) continue;
    if (excludeSyms && excludeSyms.has(g.symbol)) continue; // [DEDUP]
    if (cfg.GATE_PROTECT && activeMats.has(g.symbol)) continue; // never ride-along a still-needed gate material
    if (inputGoods.has(g.symbol) && !focusProducers.has(lane.sellWp)) continue; // [FEED FOCUS]
    const d = dstSell[g.symbol];
    if (!d || !(d.sellPrice > 0)) continue;
    const margin = d.sellPrice - g.purchasePrice;
    if (margin <= 0) continue;
    const tv = Math.min(g.tradeVolume || 20, d.tradeVolume || 20);
    cands.push({ sym: g.symbol, buy: g.purchasePrice, sell: d.sellPrice, margin, tv });
  }
  cands.sort((a, b) => b.margin * Math.min(b.tv, freeUnits) - a.margin * Math.min(a.tv, freeUnits));
  const picks: RideAlongPlan[] = [];
  let space = freeUnits;
  let cash = cashBudget;
  for (const c of cands) {
    if (space <= 0 || cash <= 0) break;
    const aff = Math.floor(cash / Math.max(1, c.buy * cfg.SLIPPAGE_FACTOR));
    const units = Math.min(space, c.tv, aff); // one trade-volume lot keeps each buy off the slippage curve
    if (units <= 0) continue;
    if (c.margin * units < cfg.RIDEALONG_MIN_GROSS) continue;
    picks.push({ ...c, units });
    space -= units;
    cash -= Math.ceil(units * c.buy * cfg.SLIPPAGE_FACTOR);
  }
  return picks;
}

// ── atomic lane claim (bot2 L339–392) ────────────────────────────────────────

export interface ClaimDeps {
  state: BotState;
  cfg: Config;
  router: Router;
  D: DistFn;
}

/**
 * Pure lane SELECTION — score every lane (incl. outer) on true net/min using refuel-aware
 * multi-hop routing (a fat outer trade can beat a thin cluster one, no hard distance cap),
 * apply the FILL-BIAS near-tie re-rank, and return the chosen lane descriptor / park sentinel
 * / null. **No side effects** — does NOT lock the good or commit cash. (bot2 `claimLane`
 * scoring half; the lock/commit half lives in `claimLane`.)
 *
 * Shared by `claimLane` (which mutates) and `peekLane` (which doesn't), so the two can never
 * diverge in how they rank lanes.
 */
export function selectLane(ship: Ship, lanes: Lane[], markets: Record<string, Market>, deps: ClaimDeps): ClaimResult {
  const { state, cfg, router } = deps;
  const cand: Array<{ l: Lane; score: number; estCost: number; net: number; bias?: number }> = [];
  for (const l of lanes) {
    const st = gs(state, l.sym);
    if (st.lockedBy || now() < st.cooldownUntil) continue; // locked or cooling down
    const estCost = Math.ceil(l.units * l.buy * 1.1); // buy cost + slippage headroom
    if (estCost > availableForWork(state)) continue; // would breach operating reserve
    const repo = router.routeCost(ship.nav.waypointSymbol, l.buyWp, ship);
    const haul = router.routeCost(l.buyWp, l.sellWp, ship);
    const fuelCr = repo.fuelCr + haul.fuelCr;
    const timeS = repo.timeS + haul.timeS + 30;
    const net = l.gross - fuelCr;
    if (net <= 0) continue; // travel ate the margin
    let score = net / (timeS / 60); // net per minute, full round-trip-aware
    // [D] Far lanes favor fast hulls: discount a far lane's score for slow ships.
    if (l.dist > cfg.SPEED_FAR_DIST) score *= (ship.engine?.speed || state.fleetMaxSpeed) / state.fleetMaxSpeed;
    cand.push({ l, score, estCost, net });
  }
  if (!cand.length) return null;

  // [FILL-BIAS] Pick the top-scoring lane, but break near-ties toward fuller hold + gate-helpful drop-off.
  let chosen: { l: Lane; score: number; estCost: number; net: number; bias?: number };
  if (cfg.FILL_BIAS && cand.length > 1) {
    const top = Math.max(...cand.map((c) => c.score));
    const band = cand.filter((c) => c.score >= top * (1 - cfg.FILL_BIAS_EPS));
    const sinks = gateSinkWaypoints(state, cfg, markets);
    const cap = ship.cargo?.capacity || 0;
    for (const c of band) {
      const primary = Math.min(c.l.units, cap);
      let rideUnits = 0;
      if (cap > primary)
        for (const p of planRideAlongs(markets, c.l, cap - primary, growthBudget(state), state, cfg)) rideUnits += p.units;
      const fillFrac = cap > 0 ? (primary + rideUnits) / cap : 0; // 0..1 projected hold utilisation
      const dropoff = sinks.has(c.l.sellWp) ? cfg.GATE_DROPOFF_WEIGHT : 0; // delivery restocks a gate material
      c.bias = fillFrac + dropoff;
    }
    band.sort((a, b) => b.bias! - a.bias! || b.score - a.score); // fuller/gate-helpful first, score breaks ties
    chosen = band[0]!;
  } else {
    cand.sort((a, b) => b.score - a.score);
    chosen = cand[0]!;
  }

  const best = chosen.l;
  const bestScore = chosen.score;
  const bestCost = chosen.estCost;
  const bestProjected = chosen.net;
  if (cfg.PARK_MIN_NET > 0 && bestProjected < cfg.PARK_MIN_NET)
    return { park: true, score: bestScore, projectedNet: bestProjected }; // best lane too thin → park
  return { lane: best, score: bestScore, cost: bestCost, projectedNet: bestProjected };
}

/**
 * Atomically (no await between check and set) claim the best AFFORDABLE lane: select it
 * (see {@link selectLane}) and, when a concrete lane wins, synchronously lock the good +
 * commit the cash. Returns the same descriptor as `selectLane`. (bot2 `claimLane`)
 */
export function claimLane(ship: Ship, lanes: Lane[], markets: Record<string, Market>, deps: ClaimDeps): ClaimResult {
  const sel = selectLane(ship, lanes, markets, deps);
  if (sel && 'lane' in sel) {
    gs(deps.state, sel.lane.sym).lockedBy = ship.symbol; // lock synchronously
    commit(deps.state, sel.cost); // reserve the cash synchronously
    noteLaneCost(deps.state, sel.cost); // feed the rolling working-capital estimate
  }
  return sel;
}

/**
 * NON-MUTATING preview of {@link claimLane}: "would a profitable, affordable, unlocked lane
 * be claimable for this ship right now?" Returns the same descriptor without locking the good
 * or committing cash.
 *
 * DRIFT #26 (fixed in W6): legacy `worker()` did `const lanePref = TRADE_FIRST ? claimLane(...)`
 * as a *peek* to decide "skip the contract this loop if a lane is available", then the normal
 * section called `claimLane` AGAIN — leaking the first claim's lock + committed cash (the
 * re-claim skips the just-locked good and picks a different lane). The TS port additionally
 * dropped the skip-contract gate entirely (it discarded the peek result and always ran the
 * contract). `peekLane` restores the legacy gate with no side effect. (rebuild/DRIFT-LOG.md #26)
 */
export function peekLane(ship: Ship, lanes: Lane[], markets: Record<string, Market>, deps: ClaimDeps): ClaimResult {
  return selectLane(ship, lanes, markets, deps);
}
