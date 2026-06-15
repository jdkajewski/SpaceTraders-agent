/**
 * legacy-shims.ts — verbatim transcriptions of the legacy `bot2.mjs` / `expansion.mjs`
 * decision math, used ONLY by the parity suite (`parity.test.ts`).
 *
 * ── WHY SHIMS INSTEAD OF IMPORTING THE LEGACY .mjs ──────────────────────────────────────
 * `bot2.mjs` cannot be imported in a test:
 *   • it exports NOTHING, and its last top-level statement is `main().catch(...)` —
 *     importing it immediately launches the live bot;
 *   • at module load it reads `coords.csv` and `JSON.parse(markets.json)` (bot2.mjs:L304/L308),
 *     and `markets.json` does not exist in a fresh worktree, so the import throws.
 * `expansion.mjs`'s OUTPROBE arc partition is inline in `stepOutpost` (expansion.mjs:L327-330),
 * not an exported function. `st.mjs` / `trade.mjs` DO export real functions, but none of the
 * decision functions under parity live there.
 *
 * So, per the Wave-6 spec's sanctioned option (a), each legacy expression is transcribed here
 * VERBATIM with a `bot2.mjs:Lxxx` / `expansion.mjs:Lxxx` line reference (the legacy source now lives
 * under `legacy/` — e.g. `legacy/bot2.mjs` — at the same line numbers). The parity suite asserts
 * `TS(fixture) === shim(fixture)` on shared fixtures; a reviewer audits parity by eye-diffing this
 * file against the legacy source. The legacy module-global constants (FUEL_PX, VALUE_OF_TIME, MAXD,
 * MIN_NET, COOLDOWN_*, SPEED_FAR_DIST, HAULER_PRICE, NEW_CELL_SEED, SLIPPAGE_FACTOR, …) are passed in
 * as parameters and fed the SAME defaults the TS `Config` uses, so the only thing under test is the
 * formula, not the wiring.
 *
 * DO NOT "fix" this file by importing bot2 — it has unavoidable import-time side effects.
 */

import type { Market, MarketGood, Ship } from '@st/shared';

// ── flight-mode math (bot2.mjs:L311-313, L329-345) ───────────────────────────────────────

export const TIME_FACTOR_LEGACY: Record<string, number> = { DRIFT: 250, CRUISE: 25, STEALTH: 30, BURN: 12.5 }; // bot2.mjs:L311

// bot2.mjs:L312
export function legFuelLegacy(dist: number, mode: string): number {
  return mode === 'DRIFT' ? 1 : mode === 'BURN' ? 2 * dist : dist;
}
// bot2.mjs:L313
export function legTimeLegacy(dist: number, speed: number, mode: string): number {
  return Math.round((dist * TIME_FACTOR_LEGACY[mode]!) / Math.max(1, speed)) + 15;
}

// bot2.mjs:L329-345 (FUEL_PX / VALUE_OF_TIME are module globals in legacy → passed in here)
export function chooseModeLegacy(dist: number, ship: Ship, FUEL_PX: number, VALUE_OF_TIME: number): { mode: string; fuel: number; time: number; cost?: number } {
  const cap = ship.fuel.capacity || 0;
  const speed = ship.engine?.speed || 15;
  if (cap === 0) return { mode: 'CRUISE', fuel: 0, time: legTimeLegacy(dist, speed, 'CRUISE') }; // probes: free fuel
  const cands: Array<{ mode: string; fuel: number; time: number; cost: number }> = [];
  for (const mode of ['CRUISE', 'BURN', 'DRIFT']) {
    const fuel = legFuelLegacy(dist, mode);
    if (fuel > cap * 0.97) continue; // 3% margin
    const time = legTimeLegacy(dist, speed, mode);
    const cost = fuel * FUEL_PX + time * VALUE_OF_TIME;
    cands.push({ mode, fuel, time, cost });
  }
  if (!cands.length) return { mode: 'DRIFT', fuel: 1, time: legTimeLegacy(dist, speed, 'DRIFT') };
  cands.sort((a, b) => a.cost - b.cost);
  return cands[0]!;
}

// ── multi-hop routing (bot2.mjs:L2229-2251, L2276-2287) ──────────────────────────────────
// In legacy, `coords`, `D`, and `fuelNodes(markets)` are module-level; here `coords`/`D`/`fuel`
// are passed in. The fuel-node SET is supplied by the caller (DRIFT #16: the legacy disk cache
// vs the TS in-memory set is a sourcing difference only — given the same set the routes match).

type Coords = Record<string, readonly [number, number]>;

// bot2.mjs:L2229-2251
export function planRouteLegacy(from: string, to: string, fuelCap: number, coords: Coords, D: (a: string, b: string) => number, fuel: Set<string>): string[] | null {
  const cap = (fuelCap || 0) * 0.97;
  if (cap <= 0 || D(from, to) <= cap) return [to]; // probes or direct-feasible
  const nodes = [...new Set([from, to, ...fuel])].filter((n) => coords[n]);
  const dist: Record<string, number> = {};
  const prev: Record<string, string> = {};
  const seen = new Set<string>();
  for (const n of nodes) dist[n] = Infinity;
  dist[from] = 0;
  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const n of nodes) if (!seen.has(n) && dist[n]! < best) { best = dist[n]!; u = n; }
    if (u === null || u === to) break;
    seen.add(u);
    for (const v of nodes) {
      if (v === u || seen.has(v)) continue;
      if (v !== to && !fuel.has(v)) continue; // can only refuel at fuel nodes (or the dest)
      const d = D(u, v); if (d > cap) continue; // too far for one tank
      const t = Math.round((d * 25) / 15) + 15; // CRUISE time
      if (dist[u]! + t < dist[v]!) { dist[v] = dist[u]! + t; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return null; // unreachable even multi-hop
  const path: string[] = [];
  let c: string | undefined = to;
  while (c && c !== from) { path.unshift(c); c = prev[c]; }
  return path;
}

// bot2.mjs:L2276-2287 (FUEL_PX module-global → passed in)
export function routeCostLegacy(from: string, to: string, ship: Ship, coords: Coords, D: (a: string, b: string) => number, fuel: Set<string>, FUEL_PX: number): { fuelCr: number; timeS: number } {
  if (from === to) return { fuelCr: 0, timeS: 0 };
  const speed = ship.engine?.speed || 15;
  const path = planRouteLegacy(from, to, ship.fuel.capacity, coords, D, fuel);
  if (!path) { const d = D(from, to); return { fuelCr: FUEL_PX, timeS: Math.round((d * 250) / speed) + 15 }; } // DRIFT fallback
  let cur = from, fuelCr = 0, timeS = 0;
  for (const hop of path) { const d = D(cur, hop); fuelCr += d * FUEL_PX; timeS += Math.round((d * 25) / speed) + 15; cur = hop; }
  return { fuelCr, timeS };
}

// ── lane building (bot2.mjs:L416-448) ────────────────────────────────────────────────────
// GATE_PROTECT / FEED-FOCUS guards are OFF by default (GATE_PROTECT=0, no reserved inputs), so
// the guarded `continue`s are no-ops here and omitted; the ranking math is transcribed verbatim.

type LaneLegacy = { sym: string; buyWp: string; buy: number; sellWp: string; sell: number; margin: number; units: number; dist: number; gross: number };

// bot2.mjs:L416-448 (guards-off path)
export function buildLanesLegacy(markets: Record<string, Market>, D: (a: string, b: string) => number, MAXD: number, MIN_NET: number): LaneLegacy[] {
  const goods: Record<string, Array<MarketGood & { wp: string }>> = {};
  for (const [wp, m] of Object.entries(markets))
    for (const g of m.tradeGoods || []) (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  const best: Record<string, LaneLegacy> = {};
  for (const [sym, entries] of Object.entries(goods)) {
    for (const b of entries) for (const s of entries) {
      if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
      const dist = D(b.wp, s.wp); if (dist > MAXD) continue;
      const units = Math.min(Math.min(b.tradeVolume, s.tradeVolume), 20);
      const margin = s.sellPrice - b.purchasePrice;
      const gross = margin * units;
      if (gross < MIN_NET) continue;
      if (!best[sym] || gross > best[sym]!.gross)
        best[sym] = { sym, buyWp: b.wp, buy: b.purchasePrice, sellWp: s.wp, sell: s.sellPrice, margin, units, dist, gross };
    }
  }
  return Object.values(best);
}

// ── adaptive cooldown (bot2.mjs:L394-402) ────────────────────────────────────────────────
// bot2.mjs:L394-402 (COOLDOWN_* module globals → passed in)
export function cooldownForLegacy(
  sym: string,
  goodEMA: Map<string, number>,
  lastMargins: Record<string, number>,
  COOLDOWN_MS: number,
  COOLDOWN_MAX_MULT: number,
  COOLDOWN_MIN_MULT: number,
  COOLDOWN_FLOOR_MS: number,
): number {
  const typical = goodEMA.get(sym) || 0;
  const cur = lastMargins[sym] ?? typical;
  if (typical <= 0 || cur <= 0) return COOLDOWN_MS;
  const mult = Math.min(COOLDOWN_MAX_MULT, Math.max(COOLDOWN_MIN_MULT, typical / cur)); // thick→<1, thin→>1
  return Math.max(COOLDOWN_FLOOR_MS, Math.round(COOLDOWN_MS * mult));
}

// ── gate credit hysteresis latch (bot2.mjs:L635-647) ─────────────────────────────────────
// Pure transcription of the latch decision: returns the next `gateBuyPaused` for a given
// credits reading + previous paused flag (the legacy log side-effects are omitted).
// bot2.mjs:L637-639
export function gateLatchLegacy(cachedCredits: number, was: boolean, GATE_CREDIT_FLOOR: number, GATE_CREDIT_RESUME: number): boolean {
  let gateBuyPaused = was;
  if (cachedCredits < GATE_CREDIT_FLOOR) gateBuyPaused = true; // hard stop: arm the latch
  else if (cachedCredits >= GATE_CREDIT_RESUME) gateBuyPaused = false; // recovered past resume band: release
  return gateBuyPaused;
}

// ── strategy phase (bot2.mjs:L648-655) ───────────────────────────────────────────────────
// Transcribed as a pure function of the live-state inputs the legacy reads from module globals.
// bot2.mjs:L648-655
export function determinePhaseLegacy(inp: {
  marketKnown: boolean;
  fleetSize: number;
  BOOTSTRAP_FLEET_MIN: number;
  gate: { known: boolean; exists: boolean; built: boolean };
  gateSupplyActive: boolean;
  INPUT_FEED: boolean;
}): string {
  if (!inp.marketKnown || inp.fleetSize < inp.BOOTSTRAP_FLEET_MIN) return 'BOOTSTRAP';
  const g = inp.gate;
  if (g.known && g.exists && g.built) return 'PORTAL_OPEN';
  if (inp.gateSupplyActive) return inp.INPUT_FEED ? 'INPUT_FEED' : 'GATE_SUPPLY';
  if (g.known && g.exists && !g.built) return 'GATE_DISCOVERY';
  return 'PROFIT';
}

// ── gate-fill planner (bot2.mjs:L1291-1365, packing version) ──────────────────────────────
// Tested with absMax = {} so the gateBuyAllowed branch is inert (the `am` guard is skipped) →
// fully deterministic. Transcribed verbatim from the packing rewrite otherwise.
type GateFillLegacy = { sym: string; wp: string; units: number; px: number };

// bot2.mjs:L1291-1365 (absMax = {} path; hold-packing cycle)
export function planGateFillLegacy(
  remaining: Record<string, number>,
  claims: Map<string, number>,
  markets: Record<string, Market>,
  o: { free: number; headroom: number; slippage: number; ceilFactor: number },
): GateFillLegacy[] {
  const { free: free0, headroom: headroom0, slippage, ceilFactor } = o;
  if (free0 <= 0 || headroom0 <= 0) return [];
  const minPx: Record<string, number> = {};
  const opts: Array<{ sym: string; wp: string; px: number; tv: number }> = [];
  for (const [sym, need] of Object.entries(remaining)) {
    const open = need - (claims.get(sym) || 0);
    if (open <= 0) continue;
    for (const [wp, m] of Object.entries(markets)) {
      const gg = (m.tradeGoods || []).find((x) => x.symbol === sym);
      if (!gg || !(gg.purchasePrice > 0)) continue;
      if (gg.type !== 'EXPORT' && gg.type !== 'EXCHANGE') continue; // PRODUCERS only
      opts.push({ sym, wp, px: gg.purchasePrice, tv: gg.tradeVolume || 0 });
      if (minPx[sym] === undefined || gg.purchasePrice < minPx[sym]!) minPx[sym] = gg.purchasePrice;
    }
  }
  // absMax = {} → the `!absMax[o.sym]` guard is always true, so capOK is never consulted.
  const cheap = opts.filter((op) => op.px <= (minPx[op.sym] ?? op.px) * ceilFactor).sort((a, b) => a.px - b.px);
  // [GATE FILL] Pack the hold: add tradeVolume lots cheapest-first, cycling across all still-needed materials until
  // the hold (f) or headroom (h) is exhausted (or nothing still needs units). bot2.mjs:L1333-1360.
  const order: Record<string, number> = {};
  let f = free0, h = headroom0;
  let progress = true;
  while (f > 0 && h > 0 && progress) {
    progress = false;
    for (const op of cheap) {
      if (f <= 0 || h <= 0) break;
      const plannedSym = Object.entries(order)
        .filter(([k]) => k.startsWith(op.sym + '@'))
        .reduce((s, [, u]) => s + u, 0);
      const open = (remaining[op.sym] || 0) - (claims.get(op.sym) || 0) - plannedSym;
      if (open <= 0) continue;
      const unitCost = op.px * slippage;
      const affordable = Math.floor(h / Math.max(1, unitCost));
      const lot = Math.min(f, op.tv > 0 ? op.tv : f, open, affordable);
      if (lot <= 0) continue;
      const key = op.sym + '@' + op.wp;
      order[key] = (order[key] || 0) + lot;
      f -= lot;
      h -= Math.ceil(lot * unitCost);
      progress = true;
    }
  }
  const buys: GateFillLegacy[] = [];
  for (const [key, units] of Object.entries(order)) {
    const at = key.lastIndexOf('@');
    const sym = key.slice(0, at), wp = key.slice(at + 1);
    const op = cheap.find((x) => x.sym === sym && x.wp === wp);
    if (op) buys.push({ sym, wp, units, px: op.px });
  }
  return buys;
}

// ── expansion target math (bot2.mjs:L657-722) ────────────────────────────────────────────
// The pure (post-fetch) target computation: given the gate materials + a market snapshot (for
// cheapest-source pricing) + the operating reserve + cost knobs, produce { target, breakdown }.
// `cheapestSrc` is transcribed inline. (bot2.mjs:L682-720)
export function expansionTargetLegacy(
  materials: Array<{ tradeSymbol: string; required: number; fulfilled: number }>,
  markets: Record<string, Market>,
  OPERATING_RESERVE: number,
  SLIPPAGE_FACTOR: number,
  HAULER_PRICE: number,
  NEW_CELL_SEED: number,
  gateBuilt = false,
): { target: number; breakdown: Record<string, unknown> } {
  // cheapestSrc(markets, sym): lowest positive purchasePrice across all markets (bot2.mjs cheapestSrc)
  const cheapestSrc = (sym: string): { px: number } | null => {
    let best: { px: number } | null = null;
    for (const m of Object.values(markets))
      for (const g of m.tradeGoods || [])
        if (g.symbol === sym && g.purchasePrice > 0 && (!best || g.purchasePrice < best.px)) best = { px: g.purchasePrice };
    return best;
  };
  let gateCost = 0, gateUnits = 0;
  if (!gateBuilt)
    for (const m of materials) {
      const need = m.required - m.fulfilled; if (need <= 0) continue;
      gateUnits += need;
      const src = cheapestSrc(m.tradeSymbol);
      gateCost += need * (src ? src.px : 1000) * SLIPPAGE_FACTOR;
    }
  let haulerCost = 0, nHaul = 0;
  if (!gateBuilt) {
    const loads = Math.ceil(gateUnits / 80);
    nHaul = Math.min(3, Math.max(1, Math.round(loads / 8)));
    haulerCost = nHaul * HAULER_PRICE;
  }
  const target = Math.round(OPERATING_RESERVE + gateCost + haulerCost + NEW_CELL_SEED);
  const breakdown = {
    reserve: OPERATING_RESERVE,
    gateMaterials: Math.round(gateCost),
    storageSupplyShips: haulerCost,
    storageSupplyShipCount: nHaul,
    seedNewCell: NEW_CELL_SEED,
    gateBuilt,
    gateStatusKnown: true,
    total: target,
  };
  return { target, breakdown };
}

// ── OUTPROBE market-coverage arc partition (expansion.mjs:L327-330) ──────────────────────
// expansion.mjs:L327-330
export function partitionMarketsLegacy(wps: readonly string[], idx: number, n: number): string[] {
  const peersLen = n || 1;
  const i = Math.max(0, idx);
  const lo = Math.floor((i * wps.length) / peersLen);
  const hi = Math.max(Math.floor(((i + 1) * wps.length) / peersLen), lo + 1);
  return wps.slice(lo, hi);
}
