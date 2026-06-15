/**
 * expansion/expansion.ts — AUTO-EXPANSION + inter-system trading (YOLO mode), default OFF.
 *
 * Faithful TypeScript port of the legacy `expansion.mjs` (699 LOC). Fires ONCE the home
 * jump gate is BUILT (`maybeTrigger` self-gates on `AUTO_EXPAND` + `gateBuilt()`), migrates
 * a chosen set of ships through the gate into a CONNECTED system, then runs HAULER
 * (inter-system arbitrage), LIGHT (local buy-low/sell-high), and PROBE (market scouting)
 * roles — plus optional OUTPOST fan-out and FLEET AUTO-BUY. The home fleet keeps trading
 * untouched; this never halts it.
 *
 * HARD SAFETY INVARIANTS (preserved verbatim from the legacy header):
 *   1. Never buy/jump if it would drop credits below EXPAND_CREDIT_FLOOR.
 *   2. navigate() auto-refuels to full before every leg; we only traverse planRoute-feasible
 *      (tank-reachable) hops → never a surprise DRIFT.
 *   3. Jump only from a gate, in orbit; any jump/nav/trade error → PARK the ship (idle, fully
 *      recoverable) and retry next loop. Never throws up.
 *   4. The whole step is wrapped; an expansion ship can never crash the fleet.
 *   5. All of this is behind AUTO_EXPAND=1. With it off, this module is inert and the live
 *      earner is byte-for-byte unchanged.
 *
 * Parity note: the dependency object mirrors `bot2.mjs` main() L3180–3196 exactly. Mutable
 * runtime state (members/outposts/caches) lives in this closure, as in the legacy module.
 */

import type { Config, Market, Ship } from '@st/shared';
import type { ModeChoice } from '../interfaces.js';
import { partitionMarkets, sysOf } from './partition.js';

const SLEEP_MS = 8000;

// ── injected dependency contract (bot2 main L3180–3196) ──────────────────────

/** A scanned market snapshot (the raw market data + the epoch ms it was read). */
type ScannedMarket = Market & { at: number };

/** The transaction/cooldown block a jump returns (we read antimatter price + cooldown). */
interface JumpResult {
  transaction?: { totalPrice?: number };
  cooldown?: { remainingSeconds?: number };
}

/** Everything `createExpansion` needs, injected as closures over live bot state. */
export interface ExpansionCtx {
  cfg: Config;
  /** Rate-limited SpaceTraders request (the bot's shared client). */
  api: <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T>;
  /** String logger (pino-backed); preserves the legacy emoji markers. */
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  // ship primitives (trade.mjs)
  navigate: (sym: string, dest: string, mode?: 'CRUISE' | 'BURN' | 'DRIFT' | 'STEALTH') => Promise<Ship>;
  refuel: (sym: string) => Promise<Ship>;
  buy: (sym: string, good: string, units: number, maxPx?: number) => Promise<{ bought: number; spent: number }>;
  sell: (sym: string, good: string) => Promise<{ got: number }>;
  jump: (sym: string, destGateWp: string) => Promise<unknown>;
  getShip: (sym: string) => Promise<Ship>;
  getAllShips: () => Promise<Ship[]>;
  // routing / coords / accounting
  /** Mutable coords map — expansion injects new-system waypoint coords so D()/planRoute work there. */
  coords: Record<string, readonly [number, number]>;
  D: (a: string, b: string) => number;
  chooseMode: (dist: number, ship: Ship) => ModeChoice;
  planRoute: (from: string, to: string, fuelCap: number, markets: Record<string, Market>) => string[] | null;
  record: (sym: string, net: number, label: string) => void | Promise<void>;
  // home/gate accessors
  homeSystem: string;
  gateWp: () => string | null;
  gateBuilt: () => boolean;
  getCredits: () => number;
  reserve: () => number;
  homeMarkets: () => Record<string, Market>;
  fuelPx: () => number;
  launchWorker: (sym: string) => void;
  /** Generic POST /my/ships {shipType, waypointSymbol} → bought ship symbol or null. */
  buyShip?: (shipType: string, wp: string) => Promise<string | null>;
  /** Resolve the contract negotiator so outposts never poach it. */
  negotiator?: () => string | null;
}

type Role = 'HAULER' | 'LIGHT' | 'PROBE' | 'OUTPROBE' | 'OUTLIGHT';
interface Member {
  role: Role;
  opSys?: string;
  scanned?: Set<string>;
  last?: string;
}
interface Outpost {
  sys: string;
  gateWp: string;
  markets: Record<string, ScannedMarket>;
  marketWps: string[];
  loaded: boolean;
}
interface Lane {
  good: string;
  srcWp: string;
  dstWp: string;
  buyPx: number;
  sellPx: number;
  units: number;
  net: number;
  mins: number;
  rate: number;
  crossing: boolean;
}
interface Crossing {
  srcGate: string;
  dstGate: string;
  dstSys?: string;
}

/** The public surface `main()` wires into the worker + targetWatch + status. */
export interface Expansion {
  isMember: (sym: string) => boolean;
  step: (sym: string, ship: Ship) => Promise<void>;
  maybeTrigger: () => Promise<void>;
  statusBlock: () => Record<string, unknown>;
  readonly triggered: boolean;
}

/** Comma-separated env string → trimmed, non-empty Set (legacy `listEnv`). */
const toSet = (arr: readonly string[]): Set<string> => new Set(arr.map((s) => s.trim()).filter(Boolean));

export function createExpansion(ctx: ExpansionCtx): Expansion {
  const {
    cfg,
    api,
    log,
    sleep,
    now,
    navigate,
    refuel,
    buy,
    sell,
    jump,
    getShip,
    getAllShips,
    coords,
    D,
    chooseMode,
    planRoute,
    record,
    homeSystem,
    gateWp,
    gateBuilt,
    getCredits,
    reserve,
    homeMarkets,
    fuelPx,
    launchWorker,
    buyShip,
    negotiator,
  } = ctx;

  const AUTO = cfg.AUTO_EXPAND;
  const WANT_TARGET = cfg.EXPAND_TARGET_SYSTEM.trim(); // '' = auto-pick first connection
  const FLOOR = cfg.EXPAND_CREDIT_FLOOR || reserve() + 400_000;
  const EXPLICIT_HAULERS = toSet(cfg.EXPAND_HAULERS);
  const EXPLICIT_LIGHT = toSet(cfg.EXPAND_LIGHT);
  const EXPLICIT_PROBES = toSet(cfg.EXPAND_PROBES);
  const MAX_PROBES = cfg.EXPAND_MAX_PROBES;
  const MIN_NET = cfg.EXPAND_MIN_NET; // min realized net per trade (after fuel + antimatter)
  const PROBE_DWELL_MS = cfg.EXPAND_PROBE_DWELL_MS;
  const SCAN_TTL_MS = cfg.EXPAND_SCAN_TTL_MS;
  let antimatterPx = cfg.EXPAND_JUMP_COST; // est. for scoring; LEARNED from real jumps
  let jumpCooldownMin = cfg.EXPAND_JUMP_COOLDOWN_MIN; // est. cross-system jump dead-time; LEARNED
  const OP_OVERHEAD_MIN = cfg.EXPAND_OP_OVERHEAD_MIN; // buy+sell market handling baked into every lane

  // ---- OUTPOST FAN-OUT (default OFF) -----------------------------------------
  const OUTPOSTS = [...toSet(cfg.EXPAND_OUTPOSTS)];
  const OUTPOST_PROBES = cfg.EXPAND_OUTPOST_PROBES;
  const OUTPOST_TRADERS = cfg.EXPAND_OUTPOST_TRADERS;
  const outposts = new Map<string, Outpost>();
  let outpostsReady = false;

  // ---- AUTO-BUY (default OFF) -------------------------------------------------
  const AUTOBUY = cfg.EXPAND_AUTOBUY;
  const BUY_FLOOR = cfg.EXPAND_BUY_FLOOR || Math.max(FLOOR + 250_000, 700_000); // keep this much cash AFTER any buy
  const BUY_EVERY_MS = cfg.EXPAND_AUTOBUY_MS; // at most one buy attempt per window
  const MAX_BUY_PROBES = cfg.EXPAND_MAX_BUY_PROBES; // lifetime probe buys this run
  const MAX_BUY_TRADERS = cfg.EXPAND_MAX_BUY_TRADERS; // lifetime trader/hauler buys this run
  const PROBE_TARGET_CAP = cfg.EXPAND_PROBE_TARGET; // per-system probe target; 0 = 1:1 with markets
  const TRADER_PREF = cfg.EXPAND_TRADER_PREF.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let boughtProbes = 0;
  let boughtTraders = 0;
  let lastBuyAt = 0;

  let triggered = false;
  let triggerLogged = false;
  let target: { sys: string; gateWp: string } | null = null;
  const members = new Map<string, Member>();
  const cooldownUntil = new Map<string, number>(); // sym -> epoch ms (ship jump cooldown)
  const tgtMarkets: Record<string, ScannedMarket> = {}; // wp -> market data (target system, scanned)
  let tgtMarketWps: string[] = []; // MARKETPLACE waypoints in the target system
  let tgtLoaded = false;

  const isMember = (sym: string): boolean => members.has(sym);
  const id = (s: string): string => s.slice(-3);
  const affordable = (px: number): number => (px > 0 ? Math.max(0, Math.floor((getCredits() - FLOOR) / px)) : 0);
  const cd = (sym: string): number => cooldownUntil.get(sym) ?? 0;

  // shape of a /systems/{sys}/waypoints page item
  interface WpItem {
    symbol: string;
    x: number;
    y: number;
    type?: string;
    traits?: Array<{ symbol: string }>;
  }

  // ---- target-system bring-up: inject waypoint coords + list marketplaces ----
  async function loadTargetSystem(sys: string): Promise<void> {
    if (tgtLoaded || !target) return;
    const wps: string[] = [];
    for (let page = 1; page <= 10; page++) {
      let batch: WpItem[] | undefined;
      try {
        batch = (await api<{ data: WpItem[] }>('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`)).data;
      } catch (e) {
        log(`🪐 load ${sys} p${page} ERR ${(e as Error).message}`);
        break;
      }
      if (!batch || !batch.length) break;
      for (const w of batch) {
        coords[w.symbol] = [w.x, w.y]; // make D()/planRoute work in the new system
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE')) wps.push(w.symbol);
      }
      if (batch.length < 20) break;
    }
    tgtMarketWps = wps;
    tgtLoaded = true;
    log(`🪐 target system ${sys} mapped: ${wps.length} markets, gate ${id(target.gateWp)}`);
  }

  // scan a single target market (presence required for live prices; probes provide it as they roam)
  async function scanMarket(wp: string): Promise<Market | null> {
    try {
      const m = (await api<{ data: Market }>('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
      tgtMarkets[wp] = { ...m, at: now() };
      return m;
    } catch {
      return null;
    }
  }
  async function scanAllTargets(): Promise<void> {
    for (const wp of tgtMarketWps) {
      const cur = tgtMarkets[wp];
      if (!cur || now() - cur.at > SCAN_TTL_MS) await scanMarket(wp);
    }
  }

  // ---- generic per-system bring-up (used by outposts; hub uses loadTargetSystem above) ----
  async function loadSystemInto(op: Outpost): Promise<void> {
    if (op.loaded) return;
    const wps: string[] = [];
    for (let page = 1; page <= 10; page++) {
      let batch: WpItem[] | undefined;
      try {
        batch = (await api<{ data: WpItem[] }>('GET', `/systems/${op.sys}/waypoints?limit=20&page=${page}`)).data;
      } catch (e) {
        log(`🛰 load ${op.sys} p${page} ERR ${(e as Error).message}`);
        break;
      }
      if (!batch || !batch.length) break;
      for (const w of batch) {
        coords[w.symbol] = [w.x, w.y];
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE')) wps.push(w.symbol);
        if (w.type === 'JUMP_GATE' && !op.gateWp) op.gateWp = w.symbol;
      }
      if (batch.length < 20) break;
    }
    op.marketWps = wps;
    op.loaded = true;
    log(`🛰 outpost ${op.sys} mapped: ${wps.length} markets, gate ${op.gateWp ? id(op.gateWp) : '?'}`);
  }
  async function scanMarketInto(wp: string, op: Outpost): Promise<Market | null> {
    try {
      const m = (await api<{ data: Market }>('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
      if (m.tradeGoods || !op.markets[wp]) op.markets[wp] = { ...m, at: now() }; // never clobber priced data with a priceless far-scan
      return m;
    } catch {
      return null;
    }
  }
  async function scanAllInto(op: Outpost): Promise<void> {
    for (const wp of op.marketWps) {
      const cur = op.markets[wp];
      if (!cur || now() - cur.at > SCAN_TTL_MS) await scanMarketInto(wp, op);
    }
  }

  // fuel-credits for a within-system trip on the tank; null if not tank-reachable (would DRIFT) → lane rejected
  function routeFuelCr(from: string, to: string, ship: Ship, mkts: Record<string, Market>): number | null {
    if (from === to) return 0;
    const path = planRoute(from, to, ship.fuel.capacity, mkts);
    if (!path) return null;
    let cur = from;
    let cr = 0;
    for (const h of path) {
      cr += D(cur, h) * fuelPx();
      cur = h;
    }
    return cr;
  }

  // estimated minutes for a within-system trip (reuses the real chooseMode time model); null if not tank-reachable
  function routeMins(from: string, to: string, ship: Ship, mkts: Record<string, Market>): number | null {
    if (from === to) return 0;
    const path = planRoute(from, to, ship.fuel.capacity, mkts);
    if (!path) return null;
    let cur = from;
    let secs = 0;
    for (const h of path) {
      secs += chooseMode(D(cur, h), ship).time || 0;
      cur = h;
    }
    return secs / 60;
  }

  // within-system multi-hop nav (refuel-hop in CRUISE/BURN; never cross-system — callers guarantee same sys)
  async function goToSys(sym: string, dest: string, mkts: Record<string, Market>): Promise<void> {
    let ship = await getShip(sym);
    if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') return;
    if (sysOf(dest) !== sysOf(ship.nav.waypointSymbol)) {
      // guard: cross-system moves are jumps, not navigate
      log(`🪐 ${id(sym)} skip nav ${id(dest)} — different system than ${id(ship.nav.waypointSymbol)} (cross = jump only)`);
      return;
    }
    const path = planRoute(ship.nav.waypointSymbol, dest, ship.fuel.capacity, mkts) || [dest];
    for (const hop of path) {
      ship = await getShip(sym);
      await navigate(sym, hop, chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode);
    }
  }

  // sell whatever a ship is holding at the best-priced market in its current system (clears leftover cargo)
  async function dumpCargo(sym: string, ship: Ship, sys: string, mkts: Record<string, Market>): Promise<boolean> {
    const inv = (ship.cargo.inventory || []).filter((i) => i.symbol !== 'FUEL' && i.symbol !== 'ANTIMATTER');
    if (!inv.length) return false;
    let did = false;
    for (const it of inv) {
      let best: { wp: string; px: number } | null = null;
      for (const [wp, m] of Object.entries(mkts)) {
        if (sysOf(wp) !== sys) continue;
        const g = (m.tradeGoods || []).find((x) => x.symbol === it.symbol && x.sellPrice > 0);
        if (g && (!best || g.sellPrice > best.px)) best = { wp, px: g.sellPrice };
      }
      if (!best) continue;
      try {
        await goToSys(sym, best.wp, mkts);
        const r = await sell(sym, it.symbol);
        if (r.got > 0) {
          void record(sym, r.got, `expand dump ${it.units} ${it.symbol}@${id(best.wp)}`);
          did = true;
        }
      } catch (e) {
        log(`🪐 ${id(sym)} dump ERR ${(e as Error).message}`);
      }
    }
    return did;
  }

  // find the best lane. crossing=null → local within `sys`; crossing={srcGate,dstGate,dstSys} → A→jump→B.
  function bestLane(
    ship: Ship,
    srcMkts: Record<string, Market>,
    srcSys: string,
    dstMkts: Record<string, Market>,
    dstSys: string,
    crossing: Crossing | null,
  ): Lane | null {
    const capFree = (ship.cargo.capacity || 0) - (ship.cargo.units || 0);
    if (capFree <= 0) return null;
    let best: Lane | null = null;
    for (const [srcWp, sm] of Object.entries(srcMkts)) {
      if (sysOf(srcWp) !== srcSys) continue;
      for (const sg of sm.tradeGoods || []) {
        if (!(sg.type === 'EXPORT' || sg.type === 'EXCHANGE')) continue; // only producer/exchange sources
        if (!(sg.purchasePrice > 0)) continue;
        // find best sink for this good in the destination system
        for (const [dstWp, dm] of Object.entries(dstMkts)) {
          if (sysOf(dstWp) !== dstSys) continue;
          const dg = (dm.tradeGoods || []).find((x) => x.symbol === sg.symbol && x.sellPrice > sg.purchasePrice);
          if (!dg) continue;
          const units = Math.min(sg.tradeVolume, dg.tradeVolume, capFree, affordable(sg.purchasePrice));
          if (units <= 0) continue;
          let fuelCr: number;
          let jumpCr = 0;
          let mins: number;
          if (!crossing) {
            const fc = routeFuelCr(srcWp, dstWp, ship, srcMkts);
            if (fc === null) continue;
            fuelCr = fc;
            const mn = routeMins(srcWp, dstWp, ship, srcMkts);
            if (mn === null) continue;
            mins = mn;
          } else {
            const f1 = routeFuelCr(srcWp, crossing.srcGate, ship, srcMkts);
            const f2 = routeFuelCr(crossing.dstGate, dstWp, ship, dstMkts);
            if (f1 === null || f2 === null) continue; // either leg would strand → skip
            const m1 = routeMins(srcWp, crossing.srcGate, ship, srcMkts);
            const m2 = routeMins(crossing.dstGate, dstWp, ship, dstMkts);
            if (m1 === null || m2 === null) continue;
            fuelCr = f1 + f2;
            jumpCr = antimatterPx;
            mins = m1 + m2 + jumpCooldownMin; // gate legs + jump dead-time
          }
          const net = (dg.sellPrice - sg.purchasePrice) * units - fuelCr - jumpCr;
          if (net < MIN_NET) continue;
          const rate = net / Math.max(mins + OP_OVERHEAD_MIN, 0.5); // credits/min — the real money metric (time-aware)
          if (!best || rate > best.rate)
            best = {
              good: sg.symbol,
              srcWp,
              dstWp,
              buyPx: sg.purchasePrice,
              sellPx: dg.sellPrice,
              units,
              net,
              mins,
              rate,
              crossing: !!crossing,
            };
        }
      }
    }
    return best;
  }

  // ---------------------------- per-role drivers ----------------------------
  async function ensureAtTargetThenJump(sym: string, ship: Ship): Promise<void> {
    if (!target) return;
    // move to the HOME gate (home coords/markets) and jump to the target gate
    if (cd(sym) > now()) {
      await sleep(Math.min(cd(sym) - now() + 500, 30_000));
      return;
    }
    const gw = gateWp();
    if (!gw) return;
    if (ship.nav.waypointSymbol !== gw) {
      await goToSys(sym, gw, homeMarkets());
      return;
    }
    if (ship.fuel.capacity > 0 && getCredits() - antimatterPx < FLOOR) {
      // antimatter would breach the floor → wait
      log(`🪐 ${id(sym)} hold jump — credits ${Math.round(getCredits()).toLocaleString()} near floor ${FLOOR.toLocaleString()}`);
      await sleep(SLEEP_MS);
      return;
    }
    try {
      await refuel(sym);
    } catch {
      /* refuel best-effort */
    }
    try {
      const d = (await jump(sym, target.gateWp)) as JumpResult;
      if ((d.transaction?.totalPrice ?? 0) > 0) antimatterPx = d.transaction!.totalPrice!; // LEARN real antimatter cost
      if (d.cooldown?.remainingSeconds) cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000);
    } catch (e) {
      const msg = (e as Error).message;
      const mm = /(\d+)\s*second/i.exec(msg);
      if (/cooldown/i.test(msg) && mm) {
        cooldownUntil.set(sym, now() + Number(mm[1]) * 1000 + 500);
      } else {
        log(`🪐 ${id(sym)} jump→${sysOf(target.gateWp)} ERR ${msg} — parking`);
        await sleep(SLEEP_MS);
      }
    }
  }

  // help discover the new system faster: scan the nearest stale/unscanned market
  async function helpScan(sym: string, ship: Ship): Promise<boolean> {
    if (!target) return false;
    await loadTargetSystem(target.sys);
    const here = ship.nav.waypointSymbol;
    const todo = tgtMarketWps.filter((w) => {
      const cur = tgtMarkets[w];
      return !cur || now() - cur.at > SCAN_TTL_MS;
    });
    if (!todo.length) return false;
    todo.sort((a, b) => D(here, a) - D(here, b));
    const dest = todo[0];
    if (!dest) return false;
    try {
      await goToSys(sym, dest, tgtMarkets);
      await scanMarket(dest);
      log(`🛰 ${id(sym)} scanned ${id(dest)} (${Object.keys(tgtMarkets).length}/${tgtMarketWps.length})`);
    } catch (e) {
      log(`🛰 ${id(sym)} scout ERR ${(e as Error).message}`);
    }
    return true;
  }

  // generic FLOOR-guarded gate-to-gate jump. returns 'jumped'|'moving'|'wait'. Never throws.
  async function jumpVia(
    sym: string,
    ship: Ship,
    fromGate: string,
    toGate: string,
    mkts: Record<string, Market>,
  ): Promise<'jumped' | 'moving' | 'wait'> {
    if (cd(sym) > now()) {
      await sleep(Math.min(cd(sym) - now() + 500, 30_000));
      return 'wait';
    }
    if (ship.nav.waypointSymbol !== fromGate) {
      await goToSys(sym, fromGate, mkts);
      return 'moving';
    }
    if (ship.fuel.capacity > 0 && getCredits() - antimatterPx < FLOOR) {
      log(`🛰 ${id(sym)} hold jump — credits ${Math.round(getCredits()).toLocaleString()} near floor ${FLOOR.toLocaleString()}`);
      await sleep(SLEEP_MS);
      return 'wait';
    }
    try {
      await refuel(sym);
    } catch {
      /* refuel best-effort */
    }
    try {
      const d = (await jump(sym, toGate)) as JumpResult;
      if ((d.transaction?.totalPrice ?? 0) > 0) antimatterPx = d.transaction!.totalPrice!;
      if (d.cooldown?.remainingSeconds) {
        cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000);
        jumpCooldownMin = d.cooldown.remainingSeconds / 60;
      }
      return 'jumped';
    } catch (e) {
      const msg = (e as Error).message;
      const mm = /(\d+)\s*second/i.exec(msg);
      if (/cooldown/i.test(msg) && mm) cooldownUntil.set(sym, now() + Number(mm[1]) * 1000 + 500);
      else {
        log(`🛰 ${id(sym)} jump ${id(fromGate)}→${id(toGate)} ERR ${msg} — parking`);
        await sleep(SLEEP_MS);
      }
      return 'wait';
    }
  }

  // drive one outpost member: 2-hop migrate (home→hub→outer) then trade/scan PURELY LOCAL in the outer system.
  async function stepOutpost(sym: string, ship: Ship): Promise<void> {
    const m = members.get(sym);
    if (!m || !m.opSys) {
      await sleep(SLEEP_MS);
      return;
    }
    const op = outposts.get(m.opSys);
    if (!op) {
      m.last = 'no outpost';
      await sleep(SLEEP_MS);
      return;
    }
    const cur = sysOf(ship.nav.waypointSymbol);
    const hubSys = target ? target.sys : null; // hub
    const hubGate = target ? target.gateWp : null; // hub gate

    // ---- arrived at the outpost system → resident local trading ----
    if (cur === op.sys) {
      await loadSystemInto(op);
      if (!op.gateWp) op.gateWp = ship.nav.waypointSymbol; // fallback: we jumped in via the gate
      if (m.role === 'OUTPROBE') {
        // 1:1 market partition: each OUTPROBE owns a contiguous arc and only refreshes ITS arc when stale.
        const wps = op.marketWps;
        if (!wps.length) {
          await sleep(SLEEP_MS);
          m.last = `scanning ${op.sys.slice(-4)} (mapping)`;
          return;
        }
        const peers = [...members.entries()]
          .filter(([, mm]) => mm.role === 'OUTPROBE' && mm.opSys === op.sys)
          .map(([s]) => s)
          .sort();
        const idx = Math.max(0, peers.indexOf(sym));
        const n = peers.length || 1;
        const arc = partitionMarkets(wps, idx, n);
        m.scanned = new Set(arc);
        const stale = arc.filter((w) => {
          const c = op.markets[w];
          return !c || now() - c.at > SCAN_TTL_MS;
        });
        if (!stale.length) {
          await sleep(PROBE_DWELL_MS);
          m.last = `1:1 ${op.sys.slice(-4)} arc[${arc.length}] fresh`;
          return;
        }
        const here = ship.nav.waypointSymbol;
        stale.sort((a, b) => D(here, a) - D(here, b));
        const dest = stale[0];
        if (dest) {
          try {
            await goToSys(sym, dest, op.markets);
            await scanMarketInto(dest, op);
            log(`🛰 ${id(sym)} refreshed ${id(dest)} @${op.sys.slice(-4)} (arc ${arc.length}/${wps.length})`);
          } catch (e) {
            log(`🛰 ${id(sym)} scout ERR ${(e as Error).message}`);
          }
        }
        await sleep(2000);
        return;
      }
      // OUTLIGHT: local buy-low/sell-high inside the outpost
      await scanAllInto(op);
      if (await dumpCargo(sym, ship, cur, op.markets)) return;
      const lane = bestLane(ship, op.markets, cur, op.markets, cur, null);
      if (!lane) {
        const todo = op.marketWps.filter((w) => {
          const c = op.markets[w];
          return !c || now() - c.at > SCAN_TTL_MS;
        });
        if (todo.length) {
          const here = ship.nav.waypointSymbol;
          todo.sort((a, b) => D(here, a) - D(here, b));
          const dest = todo[0];
          if (dest) {
            try {
              await goToSys(sym, dest, op.markets);
              await scanMarketInto(dest, op);
            } catch {
              /* scan best-effort */
            }
          }
          m.last = `scanning ${op.sys.slice(-4)} (no lane)`;
          return;
        }
        m.last = `parked ${op.sys.slice(-4)} (no lane)`;
        await sleep(SLEEP_MS);
        return;
      }
      await runLane(sym, ship, lane, op.markets, op.markets, null);
      return;
    }

    // ---- migration: home → hub (hop 1), then hub → outpost (hop 2) ----
    if (!hubGate || !hubSys) {
      m.last = 'await hub';
      await sleep(SLEEP_MS);
      return;
    }
    if (cur === homeSystem) {
      const gw = gateWp();
      if (gw) {
        m.last = `migrating → ${hubSys} (hop1)`;
        await jumpVia(sym, ship, gw, hubGate, homeMarkets());
      }
      return;
    }
    if (cur === hubSys) {
      if (!op.gateWp) await loadSystemInto(op); // need the outpost gate wp before hop 2
      if (!op.gateWp) {
        m.last = 'await outpost gate';
        await sleep(SLEEP_MS);
        return;
      }
      m.last = `migrating → ${op.sys} (hop2)`;
      await jumpVia(sym, ship, hubGate, op.gateWp, tgtMarkets);
      return;
    }
    m.last = `stray in ${cur}`;
    await sleep(SLEEP_MS); // unexpected system → park (recoverable)
  }

  async function stepProbe(sym: string, ship: Ship): Promise<void> {
    if (!target) return;
    const cur = sysOf(ship.nav.waypointSymbol);
    if (cur === homeSystem && target.sys !== homeSystem) {
      await ensureAtTargetThenJump(sym, ship);
      return;
    }
    // in target system: roam to the next unscanned marketplace, dwell, scan it
    await loadTargetSystem(target.sys);
    const m = members.get(sym);
    if (!m) return;
    if (!m.scanned) m.scanned = new Set();
    const scanned = m.scanned;
    const todo = tgtMarketWps.filter((w) => !scanned.has(w));
    if (!todo.length) {
      await scanAllTargets();
      await sleep(PROBE_DWELL_MS);
      return;
    } // all covered → keep refreshing
    const here = ship.nav.waypointSymbol;
    todo.sort((a, b) => D(here, a) - D(here, b));
    const dest = todo[0];
    if (!dest) return;
    try {
      await goToSys(sym, dest, tgtMarkets);
      await scanMarket(dest);
      scanned.add(dest);
      log(`🛰 ${id(sym)} scanned ${id(dest)} (${scanned.size}/${tgtMarketWps.length})`);
    } catch (e) {
      log(`🛰 ${id(sym)} scout ERR ${(e as Error).message}`);
      scanned.add(dest);
    }
    await sleep(2000);
  }

  async function stepLight(sym: string, ship: Ship): Promise<void> {
    if (!target) return;
    const cur = sysOf(ship.nav.waypointSymbol);
    if (cur === homeSystem && target.sys !== homeSystem) {
      await ensureAtTargetThenJump(sym, ship);
      return;
    }
    await loadTargetSystem(target.sys);
    await scanAllTargets();
    if (await dumpCargo(sym, ship, cur, tgtMarkets)) return;
    const lane = bestLane(ship, tgtMarkets, cur, tgtMarkets, cur, null);
    if (!lane) {
      // no local lane yet → help scan the system instead of idling
      const m = members.get(sym);
      if (await helpScan(sym, ship)) {
        if (m) m.last = 'scanning (no local lane)';
        return;
      }
      if (m) m.last = 'parked (no local lane)';
      await sleep(SLEEP_MS);
      return;
    }
    await runLane(sym, ship, lane, tgtMarkets, tgtMarkets, null);
  }

  async function stepHauler(sym: string, ship: Ship): Promise<void> {
    if (!target) return;
    const cur = sysOf(ship.nav.waypointSymbol);
    await loadTargetSystem(target.sys);
    await scanAllTargets();
    const srcMkts: Record<string, Market> = cur === homeSystem ? homeMarkets() : tgtMarkets;
    if (await dumpCargo(sym, ship, cur, srcMkts)) return; // clear leftovers first

    // 1) CROSS-system lane sourced HERE (buy here → jump → sell there)
    const otherSys = cur === homeSystem ? target.sys : homeSystem;
    const otherMkts: Record<string, Market> = cur === homeSystem ? tgtMarkets : homeMarkets();
    const gw = gateWp();
    if (!gw) {
      await sleep(SLEEP_MS);
      return;
    }
    const srcGate = cur === homeSystem ? gw : target.gateWp;
    const dstGate = cur === homeSystem ? target.gateWp : gw;
    const cross = bestLane(ship, srcMkts, cur, otherMkts, otherSys, { srcGate, dstGate, dstSys: otherSys });
    // 2) LOCAL lane here
    const local = bestLane(ship, srcMkts, cur, srcMkts, cur, null);

    if (cross && (!local || cross.rate >= local.rate)) {
      await runLane(sym, ship, cross, srcMkts, otherMkts, { srcGate, dstGate });
      return;
    }
    if (local) {
      await runLane(sym, ship, local, srcMkts, srcMkts, null);
      return;
    }

    // 3) nothing here: if stranded in the target with no lane but HOME has markets, reposition home (empty jump)
    if (cur !== homeSystem) {
      const homeHasLane =
        bestLane(ship, homeMarkets(), homeSystem, tgtMarkets, target.sys, {
          srcGate: target.gateWp,
          dstGate: gw,
          dstSys: homeSystem,
        }) || bestLane(ship, homeMarkets(), homeSystem, homeMarkets(), homeSystem, null);
      if (homeHasLane) {
        if (cd(sym) > now()) {
          await sleep(Math.min(cd(sym) - now() + 500, 30_000));
          return;
        }
        if (getCredits() - antimatterPx < FLOOR) {
          await sleep(SLEEP_MS);
          return;
        }
        if (ship.nav.waypointSymbol !== target.gateWp) {
          await goToSys(sym, target.gateWp, tgtMarkets);
          return;
        }
        try {
          await refuel(sym);
        } catch {
          /* best-effort */
        }
        try {
          const d = (await jump(sym, gw)) as JumpResult;
          if ((d.transaction?.totalPrice ?? 0) > 0) antimatterPx = d.transaction!.totalPrice!;
          if (d.cooldown?.remainingSeconds) cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000);
        } catch (e) {
          log(`🪐 ${id(sym)} reposition-home jump ERR ${(e as Error).message}`);
          await sleep(SLEEP_MS);
        }
        return;
      }
    }
    const m = members.get(sym);
    if (m) m.last = 'parked (no lane)';
    await sleep(SLEEP_MS);
  }

  // execute a chosen lane. crossing={srcGate,dstGate} for inter-system; null for local.
  async function runLane(
    sym: string,
    ship: Ship,
    lane: Lane,
    srcMkts: Record<string, Market>,
    dstMkts: Record<string, Market>,
    crossing: Crossing | null,
  ): Promise<void> {
    const tag = crossing ? 'X-SYS' : 'local';
    log(
      `🪐 ${id(sym)} ${tag} ${lane.units} ${lane.good} ${id(lane.srcWp)}@${lane.buyPx}→${id(lane.dstWp)}@${lane.sellPx} est net=${Math.round(lane.net).toLocaleString()} ~${Math.round(lane.rate || 0)}cr/min (${Math.round(lane.mins || 0)}m)`,
    );
    let spent = 0;
    let amCr = 0;
    try {
      await goToSys(sym, lane.srcWp, srcMkts);
      const maxPx = Math.ceil(lane.buyPx * 1.08);
      const r = await buy(sym, lane.good, lane.units, maxPx);
      spent = r.spent;
      if (r.bought <= 0) {
        log(`🪐 ${id(sym)} ${lane.good} buy got 0 — abort`);
        await sleep(SLEEP_MS);
        return;
      }
      if (crossing) {
        await goToSys(sym, crossing.srcGate, srcMkts);
        if (cd(sym) > now()) await sleep(Math.min(cd(sym) - now() + 500, 30_000));
        try {
          await refuel(sym);
        } catch {
          /* best-effort */
        }
        const d = (await jump(sym, crossing.dstGate)) as JumpResult;
        amCr = d.transaction?.totalPrice || antimatterPx;
        if ((d.transaction?.totalPrice ?? 0) > 0) antimatterPx = d.transaction!.totalPrice!;
        if (d.cooldown?.remainingSeconds) {
          cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000);
          jumpCooldownMin = d.cooldown.remainingSeconds / 60;
        }
      }
      await goToSys(sym, lane.dstWp, dstMkts);
      const s = await sell(sym, lane.good);
      const net = s.got - spent - amCr;
      void record(sym, net, `${tag} ${lane.good}→${id(lane.dstWp)}${crossing ? ` (antimatter ${Math.round(amCr)})` : ''}`);
    } catch (e) {
      // mid-lane failure: the held goods aren't lost — dumpCargo on the next loop salvages them.
      log(`🪐 ${id(sym)} lane ERR ${(e as Error).message} — will salvage held cargo next loop`);
      await sleep(SLEEP_MS);
    }
  }

  // -------------------------------- public API --------------------------------
  async function step(sym: string, ship: Ship): Promise<void> {
    const m = members.get(sym);
    if (!m) return;
    try {
      if (m.role === 'PROBE') await stepProbe(sym, ship);
      else if (m.role === 'LIGHT') await stepLight(sym, ship);
      else if (m.role === 'OUTPROBE' || m.role === 'OUTLIGHT') await stepOutpost(sym, ship);
      else await stepHauler(sym, ship);
    } catch (e) {
      log(`🪐 ${id(sym)} expand step ERR ${(e as Error).message} — parking`);
      await sleep(SLEEP_MS);
    }
  }

  const isProbe = (s: Ship): boolean => s.frame?.symbol === 'FRAME_PROBE';
  const byId = (set: Set<string>, s: Ship): boolean => {
    for (const t of set) if (s.symbol === t || s.symbol.endsWith('-' + t)) return true;
    return false;
  };

  async function selectMembers(): Promise<boolean> {
    let all: Ship[];
    try {
      all = await getAllShips();
    } catch (e) {
      log(`🪐 fleet read ERR ${(e as Error).message}`);
      return false;
    }

    // HAULER: explicit, else largest-cargo non-probe with fuel>=400 (can clear the long gate legs)
    let haulers: Ship[];
    if (EXPLICIT_HAULERS.size) haulers = all.filter((s) => byId(EXPLICIT_HAULERS, s));
    else {
      const cand = all
        .filter((s) => !isProbe(s) && s.cargo.capacity >= 40 && s.fuel.capacity >= 400)
        .sort((a, b) => b.fuel.capacity - a.fuel.capacity || b.cargo.capacity - a.cargo.capacity);
      haulers = cand.slice(0, 1);
    }
    const haulerSet = new Set(haulers.map((s) => s.symbol));

    // LIGHT: explicit, else a smaller non-probe hull not already chosen as hauler
    let light: Ship[];
    if (EXPLICIT_LIGHT.size) light = all.filter((s) => byId(EXPLICIT_LIGHT, s));
    else {
      const cand = all
        .filter((s) => !isProbe(s) && !haulerSet.has(s.symbol) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200)
        .sort((a, b) => a.cargo.capacity - b.cargo.capacity);
      light = cand.slice(0, 1);
    }

    // PROBES: explicit, else up to MAX_PROBES idle probes
    let probes: Ship[];
    if (EXPLICIT_PROBES.size) probes = all.filter((s) => byId(EXPLICIT_PROBES, s));
    else probes = all.filter(isProbe).slice(0, MAX_PROBES);

    for (const s of haulers) members.set(s.symbol, { role: 'HAULER' });
    for (const s of light) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'LIGHT' });
    for (const s of probes) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'PROBE', scanned: new Set() });
    return members.size > 0;
  }

  // assign small resident crews to each configured outer system (drawn from idle ships not used by the hub).
  async function setupOutposts(): Promise<void> {
    if (!OUTPOSTS.length || outpostsReady || !target) return;
    let conns: string[] = [];
    try {
      conns =
        (await api<{ data?: { connections?: string[] } }>('GET', `/systems/${target.sys}/waypoints/${target.gateWp}/jump-gate`)).data
          ?.connections || [];
    } catch (e) {
      log(`🛰 outpost gate read ERR ${(e as Error).message} — will retry`);
      return;
    }
    if (!conns.length) {
      log('🛰 hub gate has no connections yet — will retry outposts');
      return;
    }
    let all: Ship[];
    try {
      all = await getAllShips();
    } catch (e) {
      log(`🛰 outpost fleet read ERR ${(e as Error).message}`);
      return;
    }
    const reserved = new Set<string>();
    for (const k of [
      cfg.GATE_HAULERS,
      cfg.INPUT_FEEDERS,
      cfg.MINE_TRANSPORT,
      cfg.MINE_FUNNEL,
      cfg.CONTRACT_RUNNER,
      cfg.EXPAND_HAULERS,
      cfg.EXPAND_LIGHT,
      cfg.EXPAND_PROBES,
    ])
      for (const t of k) reserved.add(t);
    // DRIFT #30 (FIXED in W6): the legacy reserved-keys list `listEnv`'d 'MINE_BATCH' alongside the real
    // ship rosters, but MINE_BATCH is a numeric batch SIZE (default 24), not a roster — so legacy reserved
    // the literal "24", wrongly excluding any ship whose symbol ends in `-24` from outpost crews. Dropped
    // here so outpost crewing is no longer corrupted by the batch size. (rebuild/DRIFT-LOG.md #30)
    // also reserve the resolved contract negotiator (its bot2 DEFAULT isn't visible via env) — never poach it.
    try {
      const neg = typeof negotiator === 'function' ? negotiator() : null;
      if (neg) reserved.add(neg);
    } catch {
      /* negotiator optional */
    }
    const isReserved = (s: Ship): boolean => [...reserved].some((t) => s.symbol === t || s.symbol.endsWith('-' + t));
    const free = (s: Ship): boolean => !members.has(s.symbol) && !isReserved(s);
    const isTrader = (s: Ship): boolean =>
      !isProbe(s) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200 && !/MINING_LASER|SURVEYOR/.test(JSON.stringify(s.mounts || []));
    const assign = (s: Ship, sys: string): string => {
      const probe = isProbe(s);
      members.set(s.symbol, probe ? { role: 'OUTPROBE', opSys: sys, scanned: new Set() } : { role: 'OUTLIGHT', opSys: sys });
      launchWorker(s.symbol);
      return s.symbol.slice(-3) + (probe ? ':P' : ':T');
    };

    for (const sys of OUTPOSTS) {
      const gw = conns.find((c) => sysOf(c) === sys);
      if (!gw) {
        log(`🛰 outpost ${sys} not among hub connections [${conns.map(sysOf).join(', ')}] — skip`);
        continue;
      }
      outposts.set(sys, { sys, gateWp: gw, markets: {}, marketWps: [], loaded: false });
    }
    const probeTgt = (sys: string): number => {
      const op = outposts.get(sys);
      const m = (op && op.marketWps.length) || 0;
      return m > 0 ? m : OUTPOST_PROBES;
    };
    // pass 1 — adopt ALL ships already sitting in an outpost system (local residents = zero migration).
    const crews: Record<string, string[]> = {};
    const probeCnt: Record<string, number> = {};
    const traderCnt: Record<string, number> = {};
    for (const sys of outposts.keys()) {
      crews[sys] = [];
      probeCnt[sys] = 0;
      traderCnt[sys] = 0;
    }
    for (const s of all) {
      if (!free(s)) continue;
      const sys = s.nav.systemSymbol;
      if (!outposts.has(sys)) continue;
      if (isProbe(s)) {
        crews[sys]!.push(assign(s, sys));
        probeCnt[sys] = (probeCnt[sys] ?? 0) + 1;
      } else if (isTrader(s)) {
        crews[sys]!.push(assign(s, sys));
        traderCnt[sys] = (traderCnt[sys] ?? 0) + 1;
      }
    }
    // pass 2 — fill the SHORTFALL from idle ships elsewhere.
    const idleProbes = all.filter((s) => isProbe(s) && free(s) && s.nav.systemSymbol !== homeSystem);
    const idleTraders = all.filter((s) => isTrader(s) && free(s)).sort((a, b) => a.cargo.capacity - b.cargo.capacity);
    let pi = 0;
    let ti = 0;
    for (const sys of outposts.keys()) {
      const ptgt = probeTgt(sys);
      while ((traderCnt[sys] ?? 0) < OUTPOST_TRADERS && ti < idleTraders.length) {
        crews[sys]!.push(assign(idleTraders[ti++]!, sys));
        traderCnt[sys] = (traderCnt[sys] ?? 0) + 1;
      }
      while ((probeCnt[sys] ?? 0) < ptgt && pi < idleProbes.length) {
        crews[sys]!.push(assign(idleProbes[pi++]!, sys));
        probeCnt[sys] = (probeCnt[sys] ?? 0) + 1;
      }
      const op = outposts.get(sys)!;
      log(
        `🛰 OUTPOST ${sys} (gate ${id(op.gateWp)}) crew[P${probeCnt[sys]}/${ptgt} T${traderCnt[sys]}/${OUTPOST_TRADERS}]: ${crews[sys]!.join(' ') || 'NONE (no idle ships)'}`,
      );
    }
    outpostsReady = true;
  }

  // Grow the fleet to fill the staffing/coverage SHORTFALL left after setupOutposts exhausted idle ships.
  const sysYardCache = new Map<string, { at: number; list: Array<{ wp: string; sells: Set<string>; price: Record<string, number> }> }>();
  async function shipyardsIn(sys: string): Promise<Array<{ wp: string; sells: Set<string>; price: Record<string, number> }>> {
    const c = sysYardCache.get(sys);
    if (c && now() - c.at < 600_000) return c.list;
    const list: Array<{ wp: string; sells: Set<string>; price: Record<string, number> }> = [];
    try {
      const wps = (await api<{ data?: WpItem[] }>('GET', `/systems/${sys}/waypoints?limit=20&traits=SHIPYARD`)).data || [];
      for (const w of wps) {
        try {
          const sy = (
            await api<{ data: { ships?: Array<{ type: string; purchasePrice?: number }>; shipTypes?: Array<{ type: string }> } }>(
              'GET',
              `/systems/${sys}/waypoints/${w.symbol}/shipyard`,
            )
          ).data;
          const sells = new Set<string>();
          const price: Record<string, number> = {};
          for (const s of sy.ships || []) {
            sells.add(s.type);
            if (s.purchasePrice != null) price[s.type] = s.purchasePrice;
          }
          for (const t of sy.shipTypes || []) sells.add(t.type);
          list.push({ wp: w.symbol, sells, price });
        } catch {
          /* skip unreadable yard */
        }
      }
    } catch {
      /* skip unreadable system */
    }
    sysYardCache.set(sys, { at: now(), list });
    return list;
  }

  async function pickBuy(
    type: string,
    prefSys: Array<string | null>,
    shipWps: Set<string>,
  ): Promise<{ wp: string; price: number | null; sys: string; local: boolean } | null> {
    for (const sys of prefSys) {
      if (!sys) continue;
      let list;
      try {
        list = await shipyardsIn(sys);
      } catch {
        continue;
      }
      const sell = list.filter((y) => y.sells.has(type));
      const here = sell.find((y) => shipWps.has(y.wp)); // a yard that sells it AND has our ship docked/in-orbit
      if (here) return { wp: here.wp, price: here.price[type] ?? null, sys, local: sys !== homeSystem };
    }
    return null;
  }

  async function autoBuy(): Promise<void> {
    if (!AUTOBUY || !triggered || !outpostsReady) return;
    if (!buyShip) return; // ctx not wired
    if (now() - lastBuyAt < BUY_EVERY_MS) return;
    if (boughtProbes >= MAX_BUY_PROBES && boughtTraders >= MAX_BUY_TRADERS) return;
    let credits: number;
    try {
      credits = getCredits();
    } catch {
      return;
    }
    if (credits <= BUY_FLOOR) return; // no surplus over the safety floor — never buy

    // current resident staffing per outpost (counts in-transit migrators too, so we never over-order)
    const probeN: Record<string, number> = {};
    const traderN: Record<string, number> = {};
    for (const sys of outposts.keys()) {
      probeN[sys] = 0;
      traderN[sys] = 0;
    }
    for (const [, m] of members) {
      if (!m.opSys || !outposts.has(m.opSys)) continue;
      if (m.role === 'OUTPROBE') probeN[m.opSys] = (probeN[m.opSys] ?? 0) + 1;
      else if (m.role === 'OUTLIGHT') traderN[m.opSys] = (traderN[m.opSys] ?? 0) + 1;
    }

    // waypoints where we have a ship present right now (purchase needs a hull at the yard)
    let shipWps: Set<string>;
    try {
      shipWps = new Set((await getAllShips()).filter((s) => s.nav.status !== 'IN_TRANSIT').map((s) => s.nav.waypointSymbol));
    } catch (e) {
      lastBuyAt = now();
      log(`🛒 AUTOBUY fleet read ERR ${(e as Error).message}`);
      return;
    }

    interface BuyAction {
      kind: 'trader' | 'probe';
      role: 'OUTLIGHT' | 'OUTPROBE';
      type: string;
      wp: string;
      price: number;
      sys: string;
      local: boolean;
    }
    let action: BuyAction | null = null;
    if (boughtTraders < MAX_BUY_TRADERS) {
      const starved = [...outposts.keys()].find((sys) => (traderN[sys] ?? 0) < OUTPOST_TRADERS);
      if (starved) {
        for (const t of TRADER_PREF) {
          // best hull first
          const loc = await pickBuy(t, [starved, homeSystem], shipWps);
          if (loc && credits - (loc.price || 320_000) >= BUY_FLOOR) {
            action = { kind: 'trader', role: 'OUTLIGHT', type: t, wp: loc.wp, price: loc.price || 320_000, sys: starved, local: loc.local };
            break;
          }
        }
      }
    }
    if (!action && boughtProbes < MAX_BUY_PROBES) {
      let worst: string | null = null;
      let worstGap = 0;
      for (const sys of outposts.keys()) {
        const op = outposts.get(sys)!;
        const markets = op.marketWps.length || 0;
        if (!markets) continue; // unmapped — don't buy probes blind
        const tgt = PROBE_TARGET_CAP > 0 ? Math.min(markets, PROBE_TARGET_CAP) : markets;
        const gap = tgt - (probeN[sys] ?? 0);
        if (gap > worstGap) {
          worstGap = gap;
          worst = sys;
        }
      }
      if (worst) {
        const loc = await pickBuy('SHIP_PROBE', [worst, homeSystem], shipWps);
        const price = loc ? loc.price || 26_000 : 0;
        if (loc && credits - price >= BUY_FLOOR)
          action = { kind: 'probe', role: 'OUTPROBE', type: 'SHIP_PROBE', wp: loc.wp, price, sys: worst, local: loc.local };
      }
    }
    if (!action) return;

    lastBuyAt = now(); // throttle regardless of outcome (avoid retry spam)
    let bought: string | null;
    try {
      bought = await buyShip(action.type, action.wp);
    } catch (e) {
      log(`🛒 AUTOBUY ${action.type} @${id(action.wp)} ERR ${(e as Error).message}`);
      return;
    }
    if (!bought) {
      log(`🛒 AUTOBUY ${action.type} @${id(action.wp)} → no hull (retry next window)`);
      return;
    }
    members.set(
      bought,
      action.role === 'OUTPROBE' ? { role: 'OUTPROBE', opSys: action.sys, scanned: new Set() } : { role: 'OUTLIGHT', opSys: action.sys },
    );
    launchWorker(bought);
    const where = action.local ? `LOCAL @${action.sys.slice(-4)}` : 'home→migrate';
    if (action.kind === 'trader') {
      boughtTraders++;
      log(
        `🛒 AUTOBUY trader ${action.type} ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; traders ${traderN[action.sys] ?? 0}→${(traderN[action.sys] ?? 0) + 1}/${OUTPOST_TRADERS}, bought ${boughtTraders}/${MAX_BUY_TRADERS}]`,
      );
    } else {
      boughtProbes++;
      const op = outposts.get(action.sys);
      log(
        `🛒 AUTOBUY probe ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; probes ${probeN[action.sys] ?? 0}→${(probeN[action.sys] ?? 0) + 1}/${op?.marketWps.length || '?'}, bought ${boughtProbes}/${MAX_BUY_PROBES}]`,
      );
    }
  }

  async function maybeTrigger(): Promise<void> {
    if (!AUTO) return;
    if (triggered) {
      if (OUTPOSTS.length && !outpostsReady) await setupOutposts();
      await autoBuy();
      return;
    }
    if (!gateBuilt()) return;
    const gw = gateWp();
    if (!gw) return;
    // resolve the target gate from the home gate's connections
    let conns: string[] = [];
    try {
      conns = (await api<{ data?: { connections?: string[] } }>('GET', `/systems/${homeSystem}/waypoints/${gw}/jump-gate`)).data?.connections || [];
    } catch (e) {
      if (!triggerLogged) {
        log(`🪐 jump-gate read ERR ${(e as Error).message} — will retry`);
        triggerLogged = true;
      }
      return;
    }
    if (!conns.length) {
      if (!triggerLogged) {
        log('🪐 gate has no connections yet — will retry');
        triggerLogged = true;
      }
      return;
    }
    const picked = WANT_TARGET ? conns.find((c) => sysOf(c) === WANT_TARGET) : conns[0];
    if (!picked) log(`🪐 EXPAND_TARGET_SYSTEM=${WANT_TARGET} not among connections [${conns.map(sysOf).join(', ')}] — using first`);
    const gwSel = picked || conns[0];
    if (!gwSel) return;
    target = { gateWp: gwSel, sys: sysOf(gwSel) };
    if (!(await selectMembers())) {
      log('🪐 no eligible ships to migrate — will retry');
      target = null;
      return;
    }
    await loadTargetSystem(target.sys);
    // probes aren't in the home `traders` pool → give them supervised workers.
    for (const [sym, m] of members) if (m.role === 'PROBE') launchWorker(sym);
    triggered = true;
    const roles = [...members].map(([s, m]) => `${s.slice(-3)}:${m.role}`).join(' ');
    log(
      `🪐🚀 AUTO-EXPAND TRIGGERED → ${target.sys} (gate ${picked ? picked.slice(-3) : '?'}). Migrating: ${roles}. Floor=${FLOOR.toLocaleString()} antimatter~${antimatterPx}.`,
    );
    await setupOutposts();
  }

  function statusBlock(): Record<string, unknown> {
    return {
      enabled: AUTO,
      triggered,
      target: target ? target.sys : WANT_TARGET || 'auto',
      floor: FLOOR,
      antimatterPx,
      members: [...members].map(([s, m]) => ({
        ship: s.slice(-3),
        role: m.role,
        opSys: m.opSys,
        scanned: m.scanned ? m.scanned.size : undefined,
        last: m.last,
      })),
      targetMarketsScanned: Object.keys(tgtMarkets).length,
      targetMarkets: tgtMarketWps.length,
      outposts: [...outposts.values()].map((o) => ({
        sys: o.sys,
        gate: o.gateWp ? id(o.gateWp) : '?',
        markets: o.marketWps.length,
        scanned: Object.keys(o.markets).length,
      })),
      autobuy: { enabled: AUTOBUY, floor: BUY_FLOOR, boughtProbes, boughtTraders, capProbes: MAX_BUY_PROBES, capTraders: MAX_BUY_TRADERS },
    };
  }

  return {
    isMember,
    step,
    maybeTrigger,
    statusBlock,
    get triggered() {
      return triggered;
    },
  };
}
