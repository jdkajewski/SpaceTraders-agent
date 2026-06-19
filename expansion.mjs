// ============================================================================
//  AUTO-EXPANSION  +  INTER-SYSTEM TRADING   (YOLO mode)        default OFF
// ----------------------------------------------------------------------------
//  Fires ONCE the home jump gate is BUILT. Migrates a chosen set of ships
//  (>=1 hauler + >=1 light + idle probes) through the gate into a CONNECTED
//  system, then runs:
//    • HAULER  — inter-system arbitrage (buy in A, jump, sell in B), antimatter
//                cost folded into the lane math (a jump auto-buys 1 ANTIMATTER
//                from the market = a credit cost).
//    • LIGHT   — local buy-low/sell-high inside the new system.
//    • PROBES  — roam the new system's markets to populate live price data.
//  The HOME fleet keeps trading untouched (this never halts it).
//
//  Jump mechanic (authoritative SpaceTraders v2):
//    POST /my/ships/{sym}/jump { waypointSymbol }  — destination must be a
//    CONNECTED gate waypoint; ship must be IN ORBIT; ONE unit of ANTIMATTER is
//    auto-purchased + consumed from the market (credit cost in `transaction`);
//    a cooldown then applies. No antimatter need be carried in cargo.
//
//  HARD SAFETY INVARIANTS (so a YOLO expansion can never bankrupt or strand):
//    1. Never buy/jump if it would drop credits below EXPAND_CREDIT_FLOOR.
//    2. navigate() auto-refuels to full before every leg; we only traverse
//       planRoute-feasible (tank-reachable) hops → never a surprise DRIFT.
//    3. Jump only from a gate, in orbit; any jump/nav/trade error → PARK the
//       ship (idle, fully recoverable) and retry next loop. Never throws up.
//    4. Whole step is wrapped; an expansion ship can never crash the fleet.
//    5. All of this is behind AUTO_EXPAND=1. With it off, this module is inert
//       and the live earner is byte-for-byte unchanged.
// ============================================================================

const sysOf = (wp) => wp.split('-').slice(0, 2).join('-');
const listEnv = (k) => new Set((process.env[k] || '').split(',').map((s) => s.trim()).filter(Boolean));
const SLEEP_MS = 8000;

export function createExpansion(ctx) {
  const {
    api, log, sleep, now,
    navigate, refuel, buy, sell, jump, getShip, getAllShips, transfer,
    coords, D, chooseMode, planRoute, record,
    homeSystem, gateWp, gateBuilt, getCredits, reserve, homeMarkets, launchWorker,
    fuelPx, getShipyards, buyShip, negotiator,
  } = ctx;

  const AUTO = process.env.AUTO_EXPAND === '1';
  const WANT_TARGET = (process.env.EXPAND_TARGET_SYSTEM || '').trim();          // '' = auto-pick first connection
  const FLOOR = Number(process.env.EXPAND_CREDIT_FLOOR || 0) || (reserve() + 400_000);
  const EXPLICIT_HAULERS = listEnv('EXPAND_HAULERS');
  const EXPLICIT_LIGHT = listEnv('EXPAND_LIGHT');
  const EXPLICIT_PROBES = listEnv('EXPAND_PROBES');
  const MAX_PROBES = Number(process.env.EXPAND_MAX_PROBES || 4);
  const MIN_NET = Number(process.env.EXPAND_MIN_NET || 1000);                   // min realized net per trade (after fuel + antimatter)
  const PROBE_DWELL_MS = Number(process.env.EXPAND_PROBE_DWELL_MS || 90_000);
  const SCAN_TTL_MS = Number(process.env.EXPAND_SCAN_TTL_MS || 120_000);          // MIN rescan interval (volatile markets)
  const SCAN_TTL_MAX_MS = Number(process.env.EXPAND_SCAN_TTL_MAX_MS || 900_000);  // MAX interval — calm markets back off to here
  const SCAN_VOLATILE_PCT = Number(process.env.EXPAND_SCAN_VOLATILE_PCT || 3);    // price move ≥ this% since last scan → snap back to MIN
  // [ADAPTIVE SCAN] Fixed 2-min rescans of every market burned ~a third of the 2 req/s budget re-reading prices that
  // hadn't moved. Instead, back OFF stable markets (scan rarely) and snap volatile ones to the floor (scan often).
  // This never goes blind on what matters: any market we actively trade shifts >SCAN_VOLATILE_PCT → it auto-refreshes;
  // and execution always re-reads the live market before buying/selling, so a stale cache only affects lane *scoring*.
  function priceDelta(prev, next) {
    if (!prev?.tradeGoods || !next?.tradeGoods) return Infinity;                   // no baseline → treat as volatile
    const pm = new Map(prev.tradeGoods.map((g) => [g.symbol, g]));
    let max = 0;
    for (const g of next.tradeGoods) {
      const p = pm.get(g.symbol); if (!p) { max = 100; break; }
      for (const k of ['purchasePrice', 'sellPrice']) { const a = p[k], b = g[k]; if (a > 0 && b > 0) max = Math.max(max, Math.abs(b - a) / a * 100); }
    }
    return max;
  }
  function nextScan(prevRec, freshM) {
    if (!freshM?.tradeGoods) return { ttl: SCAN_TTL_MS, nextAt: now() + SCAN_TTL_MS };  // priceless far-scan → re-check soon
    const moved = priceDelta(prevRec, freshM);
    const ttl = moved >= SCAN_VOLATILE_PCT ? SCAN_TTL_MS : Math.min(SCAN_TTL_MAX_MS, Math.round((prevRec?.ttl || SCAN_TTL_MS) * 1.8));
    return { ttl, nextAt: now() + ttl };
  }
  const isStale = (rec) => !rec || now() >= (rec.nextAt || 0);
  let antimatterPx = Number(process.env.EXPAND_JUMP_COST || 12_000);            // est. for scoring; LEARNED from real jumps
  let jumpCooldownMin = Number(process.env.EXPAND_JUMP_COOLDOWN_MIN || 8.2);    // est. cross-system jump dead-time; LEARNED from real cooldowns
  const OP_OVERHEAD_MIN = Number(process.env.EXPAND_OP_OVERHEAD_MIN || 1.5);    // buy+sell market handling baked into every lane

  // ---- OUTPOST FAN-OUT (default OFF) -----------------------------------------
  // The hub target (PP48) is the ONLY system the home gate reaches. PP48's gate, in turn, connects to N fresh
  // outer systems. An "outpost" is an outer system we colonize with a small resident crew (probes + 1 light
  // trader) that 2-hops out (home→PP48→outer) and then trades PURELY LOCALLY in that fresh, uncongested market
  // (the proven high-rate pattern). Same hard safety invariants: every jump/buy is FLOOR-guarded; any error parks
  // the ship (recoverable). Fully additive — with EXPAND_OUTPOSTS unset the hub/home earner is byte-for-byte same.
  const OUTPOSTS = [...listEnv('EXPAND_OUTPOSTS')];                              // e.g. "X1-DF86,X1-MB89" ('' = off)
  const OUTPOST_PROBES = Number(process.env.EXPAND_OUTPOST_PROBES || 2);        // probes per outpost (live market data)
  const OUTPOST_TRADERS = Number(process.env.EXPAND_OUTPOST_TRADERS || 1);      // default local traders per system
  // [LARGE-MARKETS-ONLY] Only SEED (staff probes/traders + autobuy) a system once we've confirmed it has at least this
  // many markets+yards. A candidate outpost is still CHARTED (cheap drift-probe) so exploration keeps revealing the
  // frontier, but small systems are skipped for colonization so the 2 req/s budget concentrates on the fat markets.
  // 0 = off (seed every configured outpost regardless of size — original behavior). Set via EXPAND_MIN_MARKETS.
  const MIN_MARKETS = Number(process.env.EXPAND_MIN_MARKETS || 0);
  // [PER-SYSTEM TRADERS] Optional override of trader target per system, sized to each system's profitable intra-system
  // lane count (more lanes → more traders without saturating any single good). Format: "X1-ZV87:7,X1-JH56:6,X1-YK2:6,X1-YS20:1".
  // Any system not listed falls back to OUTPOST_TRADERS. Set via EXPAND_TRADERS_PER_SYS.
  const TRADERS_PER_SYS = {};
  for (const pair of (process.env.EXPAND_TRADERS_PER_SYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [sys, n] = pair.split(':'); const v = Number(n);
    if (sys && Number.isFinite(v)) TRADERS_PER_SYS[sys.trim()] = v;
  }
  const traderTarget = (sys) => (TRADERS_PER_SYS[sys] !== undefined ? TRADERS_PER_SYS[sys] : OUTPOST_TRADERS);
  // [RECALL] Consolidate everything onto the HUB (target system): pull every outpost crew back to the hub and convert
  // them to hub roles (probe→PROBE, trader→LIGHT), and stop autobuy from staffing outposts. Use when we want to
  // concentrate all firepower on the fattest system before expanding again. Outpost gates stay configured (so the
  // recall jump knows the route); only the resident-trade behavior flips to "jump home to the hub".
  // [RECALL RELEASE] EXPAND_RECALL_RELEASE = a credit threshold. While recall is active and credits are BELOW it, we
  // keep concentrating on the hub. The moment credits reach it, recall auto-releases (latched ON-release): every ship
  // that was recalled is sent BACK to its origin outpost (fan-out), and outpost autobuy resumes. 0 = never auto-release
  // (recall stays until the flag is removed). This implements "concentrate to build a war chest, then fan out with it".
  const RECALL = process.env.EXPAND_RECALL === '1';
  const RECALL_RELEASE = Number(process.env.EXPAND_RECALL_RELEASE || 0);
  let recallReleased = false;
  const recallActive = () => RECALL && !recallReleased;
  const outposts = new Map();          // sys -> { sys, gateWp, markets:{}, marketWps:[], loaded:false }
  const pendingOutposts = new Set();   // configured systems not yet path-resolved (deep/frontier — retried over time)
  let lastResolveAt = 0;
  let outpostsReady = false;

  // ---- AUTO-BUY (default OFF) -------------------------------------------------
  // Grow the fleet instead of only reshuffling parked ships: keep every outpost staffed with a local trader and
  // converge each outpost toward 1:1 probe:market coverage (live data). Existing idle ships are always used FIRST
  // (setupOutposts/selectMembers); auto-buy only fills the SHORTFALL. New hulls are bought at a HOME shipyard
  // (our market-sensor probes sit at those waypoints, so a hull is present to satisfy the purchase API), then
  // assigned an outpost role and migrated out by the same 2-hop state machine. Hard safety: every buy is
  // FLOOR-guarded (never drop below EXPAND_BUY_FLOOR), lifetime-capped, and throttled to one attempt per window.
  const AUTOBUY = process.env.EXPAND_AUTOBUY === '1';
  const BUY_FLOOR = Number(process.env.EXPAND_BUY_FLOOR || 0) || Math.max(FLOOR + 250_000, 700_000); // keep this much cash AFTER any buy
  const BUY_EVERY_MS = Number(process.env.EXPAND_AUTOBUY_MS || 90_000);         // at most one buy attempt per window
  const MAX_BUY_PROBES = Number(process.env.EXPAND_MAX_BUY_PROBES || 24);       // lifetime probe buys this run
  const MAX_BUY_TRADERS = Number(process.env.EXPAND_MAX_BUY_TRADERS || 8);      // lifetime trader/hauler buys this run
  const PROBE_TARGET_CAP = Number(process.env.EXPAND_PROBE_TARGET || 0);        // per-system probe target; 0 = 1:1 with markets
  // [BUY CEILING] don't overpay: skip a buy whose price exceeds the ceiling (0 = no ceiling). Repeatedly buying probes
  // at ONE home shipyard exhausts its stock and spikes the price (we watched it climb 78k→120k), which both wastes the
  // war chest and inflates home contract-sourcing costs. A ceiling makes autobuy wait for a cheaper (local/recovered)
  // option instead of paying through the nose — crucial when scaling the fleet hard.
  const MAX_PROBE_PRICE = Number(process.env.EXPAND_MAX_PROBE_PRICE || 0);      // 0 = no cap
  const MAX_TRADER_PRICE = Number(process.env.EXPAND_MAX_TRADER_PRICE || 0);    // 0 = no cap
  // trader preference: biggest cargo + best range/engine first (gate-capable LIGHT_HAULER beats a 300-fuel shuttle)
  const TRADER_PREF = (process.env.EXPAND_TRADER_PREF || 'SHIP_HEAVY_FREIGHTER,SHIP_REFINING_FREIGHTER,SHIP_LIGHT_HAULER,SHIP_LIGHT_SHUTTLE,SHIP_COMMAND_FRIGATE').split(',').map((s) => s.trim()).filter(Boolean);
  let boughtProbes = 0, boughtTraders = 0, lastBuyAt = 0;

  // [MINE COLONY] The renewable BOTTOM of the supply chain: in systems with asteroid fields + a local refinery that
  // imports ore, field cheap mining drones that extract COMMON_METAL ore and SELL it to the best local sink (the
  // refinery). Ore is ~free (mined, not bought) and asteroids regenerate, so this scales without the price-compression
  // that caps pure arbitrage — exactly how the brute-scale agents field thousands of ships. Drones are bought LOCALLY
  // at the mine system's own shipyard (no migration). Off by default; enable per-system via EXPAND_MINE.
  const MINE_SYSTEMS = [...listEnv('EXPAND_MINE')];                             // e.g. "X1-UZ64,X1-ZV87" ('' = off). Multiple colonies DON'T dilute — each mines its own asteroids → its own refinery.
  const MINE_DRONES_PER = Number(process.env.EXPAND_MINE_DRONES || 6);          // mining drones per colony (the renewable extractor core)
  const MINE_SURVEYORS_PER = Number(process.env.EXPAND_MINE_SURVEYORS || 1);    // surveyors per colony (fresh surveys → 2-3× yield)
  const MINE_HAULERS_PER = Number(process.env.EXPAND_MINE_HAULERS || 2);        // ore-ferry haulers per colony (so drones stay parked)
  const MAX_BUY_DRONES = Number(process.env.EXPAND_MAX_BUY_DRONES || 40);       // lifetime mining-ship buys this run (drones+surveyors+haulers)
  const MINE_DRONE_TYPE = process.env.EXPAND_MINE_DRONE_TYPE || 'SHIP_MINING_DRONE';
  const MINE_SURVEYOR_TYPE = process.env.EXPAND_MINE_SURVEYOR_TYPE || 'SHIP_SURVEYOR';
  const MINE_HAUL_TYPE = process.env.EXPAND_MINE_HAUL_TYPE || 'SHIP_LIGHT_HAULER';
  const mineCd = new Map();            // sym -> epoch ms (extraction/survey cooldown)
  const asteroidCache = new Map();     // sys -> { at, list:[wp] } COMMON_METAL asteroids
  const mineColony = new Map();        // sys -> { asteroid:wp, surveys:[] } shared colony state
  let boughtDrones = 0;

  // [CHAIN-FEED] Cross-system distribution layer: bulk freighters carry goods (ideally our MINED metal, cost~0) from a
  // source/colony to STARVED factory sinks across systems, multi-dropping so no single market saturates. Validated live:
  // a single feed trip netted +170k; mining-integrated feed captures ~2.4x margin (no source-price climb). Feeders are
  // RESERVED hulls (never trade-pool members). Off by default; enable with CHAIN_FEED=1 + FEEDER_SHIPS=<symbols>.
  const CHAIN_FEED = process.env.CHAIN_FEED === '1';
  const FEEDER_SHIPS = new Set((process.env.FEEDER_SHIPS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const isFeeder = (sym) => { for (const f of FEEDER_SHIPS) { if (sym === f || sym.endsWith('-' + f)) return true; } return false; };
  // [RESERVE] Hulls that the expansion engine must NEVER adopt into any role — parked for a special purpose (e.g. a
  // warp-capable EXPLORER kept free for off-gate missions). Excluded from hauler/light/probe selection AND outpost crews.
  const RESERVE_SHIPS = new Set((process.env.EXPAND_RESERVE || '').split(',').map((s) => s.trim()).filter(Boolean));
  const isReservedShip = (sym) => { for (const r of RESERVE_SHIPS) { if (sym === r || sym.endsWith('-' + r)) return true; } return false; };
  const FEED_MIN_MARGIN_PCT = Number(process.env.FEED_MIN_MARGIN_PCT || 25);    // ignore loops thinner than this
  const FEED_SATURATION_N = Number(process.env.FEED_SATURATION_N || 2);         // per-market sell cap = tradeVolume × N
  const FEED_PREFER_MINED = process.env.FEED_PREFER_MINED !== '0';              // bias source toward our mined metals
  const FEED_GOODS = (process.env.FEED_GOODS || 'IRON,COPPER,ALUMINUM,MACHINERY,ELECTRONICS,EQUIPMENT,FABRICS,FAB_MATS').split(',').map((s) => s.trim()).filter(Boolean);
  let feedPlan = [];                   // ranked loops built by the scanner (shared)
  const exportClaims = new Map();      // mineSys -> { good, feederSym, qty, until } active export reservation (contention guard)

  let triggered = false;
  let triggerLogged = false;
  let target = null;                  // { sys, gateWp }
  const members = new Map();          // sym -> { role:'HAULER'|'LIGHT'|'PROBE', scanned:Set }
  const cooldownUntil = new Map();    // sym -> epoch ms (ship jump cooldown)
  const tgtMarkets = {};              // wp -> market data (target system, scanned)
  let tgtMarketWps = [];              // MARKETPLACE waypoints in the target system
  let tgtLoaded = false;

  const isMember = (sym) => members.has(sym);
  const id = (s) => s.slice(-3);
  const affordable = (px) => (px > 0 ? Math.max(0, Math.floor((getCredits() - FLOOR) / px)) : 0);

  // ---- target-system bring-up: inject waypoint coords + list marketplaces ----
  async function loadTargetSystem(sys) {
    if (tgtLoaded) return;
    const wps = [];
    for (let page = 1; page <= 10; page++) {
      let batch;
      try { batch = (await api('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`)).data; }
      catch (e) { log(`🪐 load ${sys} p${page} ERR ${e.message}`); break; }
      if (!batch || !batch.length) break;
      for (const w of batch) {
        coords[w.symbol] = [w.x, w.y];                                          // make D()/planRoute work in the new system
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE' || t.symbol === 'SHIPYARD')) wps.push(w.symbol);  // cover every market AND shipyard (a probe at a yard also unlocks live ship-purchase prices)
      }
      if (batch.length < 20) break;
    }
    tgtMarketWps = wps;
    tgtLoaded = true;
    log(`🪐 target system ${sys} mapped: ${wps.length} markets+yards, gate ${id(target.gateWp)}`);
  }

  // scan a single target market (presence required for live prices; probes provide it as they roam)
  async function scanMarket(wp) {
    try { const m = (await api('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data; const ns = nextScan(tgtMarkets[wp], m); tgtMarkets[wp] = { ...m, at: now(), ttl: ns.ttl, nextAt: ns.nextAt }; return m; }
    catch { return null; }
  }
  async function scanAllTargets() {
    for (const wp of tgtMarketWps) { if (isStale(tgtMarkets[wp])) await scanMarket(wp); }
  }

  // ---- generic per-system bring-up (used by outposts; hub uses loadTargetSystem above) ----
  async function loadSystemInto(op) {
    if (op.loaded) return;
    const wps = [];
    for (let page = 1; page <= 10; page++) {
      let batch;
      try { batch = (await api('GET', `/systems/${op.sys}/waypoints?limit=20&page=${page}`)).data; }
      catch (e) { log(`🛰 load ${op.sys} p${page} ERR ${e.message}`); break; }
      if (!batch || !batch.length) break;
      for (const w of batch) {
        coords[w.symbol] = [w.x, w.y];
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE' || t.symbol === 'SHIPYARD')) wps.push(w.symbol);  // cover every market AND shipyard
        if (w.type === 'JUMP_GATE' && !op.gateWp) op.gateWp = w.symbol;
      }
      if (batch.length < 20) break;
    }
    op.marketWps = wps;
    op.loaded = true;
    log(`🛰 outpost ${op.sys} mapped: ${wps.length} markets+yards, gate ${op.gateWp ? id(op.gateWp) : '?'}`);
  }
  // [LARGE-MARKETS-ONLY] Map a freshly-resolved outpost (public waypoint listing — needs no ship present) and decide
  // whether it's worth colonizing. Sets op.tooSmall when its market+yard count is below MIN_MARKETS so every staffing
  // path (crew adoption, idle-fill, autobuy) skips it. Returns true when the outpost should be SEEDED. With MIN_MARKETS=0
  // this always returns true (original behavior). Failures to map default to KEEP (don't strand a system on a transient
  // listing error) — it'll be re-evaluated by the lazy worker mapping.
  async function seedWorthy(op) {
    if (!MIN_MARKETS) return true;
    if (op.tooSmall) return false;
    if (!op.loaded) { try { await loadSystemInto(op); } catch { return true; } }
    const n = op.marketWps.length;
    if (n > 0 && n < MIN_MARKETS) {
      op.tooSmall = true;
      log(`🛰 SKIP-SEED ${op.sys} — only ${n} markets+yards (< EXPAND_MIN_MARKETS=${MIN_MARKETS}); charted but not colonized`);
      return false;
    }
    return true;
  }
  async function scanMarketInto(wp, op) {
    try {
      const m = (await api('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
      if (m.tradeGoods || !op.markets[wp]) { const ns = nextScan(op.markets[wp], m); op.markets[wp] = { ...m, at: now(), ttl: ns.ttl, nextAt: ns.nextAt }; }  // never clobber priced data with a priceless far-scan
      return m;
    } catch { return null; }
  }
  async function scanAllInto(op) {
    for (const wp of op.marketWps) { if (isStale(op.markets[wp])) await scanMarketInto(wp, op); }
  }

  // fuel-credits for a within-system trip on the tank; null if not tank-reachable (would DRIFT) → lane rejected
  function routeFuelCr(from, to, ship, mkts) {
    if (from === to) return 0;
    const path = planRoute(from, to, ship.fuel.capacity, mkts);
    if (!path) return null;
    let cur = from, cr = 0;
    for (const h of path) { cr += D(cur, h) * fuelPx(); cur = h; }
    return cr;
  }

  // estimated minutes for a within-system trip (reuses the real chooseMode time model); null if not tank-reachable
  function routeMins(from, to, ship, mkts) {
    if (from === to) return 0;
    const path = planRoute(from, to, ship.fuel.capacity, mkts);
    if (!path) return null;
    let cur = from, secs = 0;
    for (const h of path) { secs += (chooseMode(D(cur, h), ship).time || 0); cur = h; }
    return secs / 60;
  }

  // within-system multi-hop nav (refuel-hop in CRUISE/BURN; never cross-system — callers guarantee same sys)
  async function goToSys(sym, dest, mkts) {
    let ship = await getShip(sym);
    if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') return;
    if (sysOf(dest) !== sysOf(ship.nav.waypointSymbol)) {                         // guard: cross-system moves are jumps, not navigate
      log(`🪐 ${id(sym)} skip nav ${id(dest)} — different system than ${id(ship.nav.waypointSymbol)} (cross = jump only)`); return;
    }
    const path = planRoute(ship.nav.waypointSymbol, dest, ship.fuel.capacity, mkts) || [dest];
    for (const hop of path) {
      ship = await getShip(sym);
      if (sysOf(hop) !== sysOf(ship.nav.waypointSymbol)) {                        // re-validate each hop: a jump/race can land us in another system mid-route
        log(`🪐 ${id(sym)} abort nav ${id(hop)} — now in ${sysOf(ship.nav.waypointSymbol)} (cross = jump only)`); return;
      }
      await navigate(sym, hop, chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode);
    }
  }

  // sell whatever a ship is holding at the best-priced market in its current system (clears leftover cargo)
  async function dumpCargo(sym, ship, sys, mkts) {
    const inv = (ship.cargo?.inventory || []).filter((i) => i.symbol !== 'FUEL' && i.symbol !== 'ANTIMATTER');
    if (!inv.length) return false;
    let did = false;
    for (const it of inv) {
      let best = null;
      for (const [wp, m] of Object.entries(mkts)) {
        if (sysOf(wp) !== sys) continue;
        const g = (m.tradeGoods || []).find((x) => x.symbol === it.symbol && x.sellPrice > 0);
        if (g && (!best || g.sellPrice > best.px)) best = { wp, px: g.sellPrice };
      }
      if (!best) continue;
      try { await goToSys(sym, best.wp, mkts); const r = await sell(sym, it.symbol); if (r.got > 0) { record(sym, r.got, `expand dump ${it.units} ${it.symbol}@${id(best.wp)}`); did = true; } }
      catch (e) { log(`🪐 ${id(sym)} dump ERR ${e.message}`); }
    }
    return did;
  }

  // find the best lane. crossing=null → local within `sys`; crossing={srcGate,dstGate,dstSys} → A→jump→B.
  function bestLane(ship, srcMkts, srcSys, dstMkts, dstSys, crossing) {
    const capFree = (ship.cargo?.capacity || 0) - (ship.cargo?.units || 0);
    if (capFree <= 0) return null;
    let best = null;
    for (const [srcWp, sm] of Object.entries(srcMkts)) {
      if (sysOf(srcWp) !== srcSys) continue;
      for (const sg of sm.tradeGoods || []) {
        if (!(sg.type === 'EXPORT' || sg.type === 'EXCHANGE')) continue;        // only producer/exchange sources (price moves the right way)
        if (!(sg.purchasePrice > 0)) continue;
        // find best sink for this good in the destination system
        for (const [dstWp, dm] of Object.entries(dstMkts)) {
          if (sysOf(dstWp) !== dstSys) continue;
          const dg = (dm.tradeGoods || []).find((x) => x.symbol === sg.symbol && x.sellPrice > sg.purchasePrice);
          if (!dg) continue;
          const units = Math.min(sg.tradeVolume, dg.tradeVolume, capFree, affordable(sg.purchasePrice));
          if (units <= 0) continue;
          let fuelCr, jumpCr = 0, mins;
          if (!crossing) {
            const fc = routeFuelCr(srcWp, dstWp, ship, srcMkts); if (fc === null) continue; fuelCr = fc;
            mins = routeMins(srcWp, dstWp, ship, srcMkts); if (mins === null) continue;
          } else {
            const f1 = routeFuelCr(srcWp, crossing.srcGate, ship, srcMkts);
            const f2 = routeFuelCr(crossing.dstGate, dstWp, ship, dstMkts);
            if (f1 === null || f2 === null) continue;                            // either leg would strand → skip
            const m1 = routeMins(srcWp, crossing.srcGate, ship, srcMkts);
            const m2 = routeMins(crossing.dstGate, dstWp, ship, dstMkts);
            if (m1 === null || m2 === null) continue;
            fuelCr = f1 + f2; jumpCr = antimatterPx; mins = m1 + m2 + jumpCooldownMin; // gate legs + jump dead-time
          }
          const net = (dg.sellPrice - sg.purchasePrice) * units - fuelCr - jumpCr;
          if (net < MIN_NET) continue;
          const rate = net / Math.max(mins + OP_OVERHEAD_MIN, 0.5);              // credits/min — the real money metric (time-aware)
          if (!best || rate > best.rate) best = { good: sg.symbol, srcWp, dstWp, buyPx: sg.purchasePrice, sellPx: dg.sellPrice, units, net, mins, rate, crossing: !!crossing };
        }
      }
    }
    return best;
  }

  // ---------------------------- per-role drivers ----------------------------
  async function ensureAtTargetThenJump(sym, ship) {
    // move to the HOME gate (home coords/markets) and jump to the target gate
    if (cooldownUntil.get(sym) > now()) { await sleep(Math.min(cooldownUntil.get(sym) - now() + 500, 30_000)); return; }
    const gw = gateWp();
    if (ship.nav.waypointSymbol !== gw) { await goToSys(sym, gw, homeMarkets()); return; }
    if (ship.fuel.capacity > 0 && getCredits() - antimatterPx < FLOOR) {        // antimatter would breach the floor → wait
      log(`🪐 ${id(sym)} hold jump — credits ${Math.round(getCredits()).toLocaleString()} near floor ${FLOOR.toLocaleString()}`);
      await sleep(SLEEP_MS); return;
    }
    try { await refuel(sym); } catch {}
    try {
      const d = await jump(sym, target.gateWp);
      if (d.transaction?.totalPrice > 0) antimatterPx = d.transaction.totalPrice; // LEARN real antimatter cost
      if (d.cooldown?.remainingSeconds) cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000);
    } catch (e) {
      const mm = /(\d+)\s*second/i.exec(e.message);
      if (/cooldown/i.test(e.message) && mm) { cooldownUntil.set(sym, now() + (+mm[1]) * 1000 + 500); }
      else { log(`🪐 ${id(sym)} jump→${sysOf(target.gateWp)} ERR ${e.message} — parking`); await sleep(SLEEP_MS); }
    }
  }

  // help discover the new system faster: scan the nearest stale/unscanned market (shared freshness, so ships divide work)
  async function helpScan(sym, ship) {
    await loadTargetSystem(target.sys);
    const here = ship.nav.waypointSymbol;
    const todo = tgtMarketWps.filter((w) => isStale(tgtMarkets[w]));
    if (!todo.length) return false;
    todo.sort((a, b) => D(here, a) - D(here, b));
    const dest = todo[0];
    try { await goToSys(sym, dest, tgtMarkets); await scanMarket(dest); log(`🛰 ${id(sym)} scanned ${id(dest)} (${Object.keys(tgtMarkets).length}/${tgtMarketWps.length})`); }
    catch (e) { log(`🛰 ${id(sym)} scout ERR ${e.message}`); }
    return true;
  }

  // generic FLOOR-guarded gate-to-gate jump: ensures orbit at fromGate (same-system nav), then jumps to toGate.
  // returns 'jumped' | 'moving' | 'wait' (caller just returns after). Never throws.
  async function jumpVia(sym, ship, fromGate, toGate, mkts) {
    if (cooldownUntil.get(sym) > now()) { await sleep(Math.min(cooldownUntil.get(sym) - now() + 500, 30_000)); return 'wait'; }
    if (ship.nav.waypointSymbol !== fromGate) { await goToSys(sym, fromGate, mkts); return 'moving'; }
    if (ship.fuel.capacity > 0 && getCredits() - antimatterPx < FLOOR) {
      log(`🛰 ${id(sym)} hold jump — credits ${Math.round(getCredits()).toLocaleString()} near floor ${FLOOR.toLocaleString()}`);
      await sleep(SLEEP_MS); return 'wait';
    }
    try { await refuel(sym); } catch {}
    try {
      const d = await jump(sym, toGate);
      if (d.transaction?.totalPrice > 0) antimatterPx = d.transaction.totalPrice;
      if (d.cooldown?.remainingSeconds) { cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000); jumpCooldownMin = d.cooldown.remainingSeconds / 60; }
      return 'jumped';
    } catch (e) {
      const mm = /(\d+)\s*second/i.exec(e.message);
      if (/cooldown/i.test(e.message) && mm) cooldownUntil.set(sym, now() + (+mm[1]) * 1000 + 500);
      else { log(`🛰 ${id(sym)} jump ${id(fromGate)}→${id(toGate)} ERR ${e.message} — parking`); await sleep(SLEEP_MS); }
      return 'wait';
    }
  }

  // ===================== [N-DEEP GATE TRAVERSAL + EXPLORATION] =====================
  // The gate network is a graph we DISCOVER by charting: reading a gate's connections requires the gate to be charted
  // (or a ship present). So a seed PROBE explores outward — each gate it reaches we chart, revealing the next frontier.
  // To JUMP cur→next we use the destination gate WAYPOINT from cur's connection list (cur must be charted; it is, since
  // it's on our occupied frontier). gateInfo caches: gateWp (own gate, from public waypoint listing — works uncharted),
  // conns [{sys,wp}] (needs charted), readable. We only persist-cache READABLE results so uncharted gates retry later.
  const gateGraph = new Map();         // sys -> { gateWp, conns:[{sys,wp}], readable, underCon }
  async function gateInfo(sys) {
    const cached = gateGraph.get(sys);
    if (cached && cached.readable) return cached;                 // only trust a readable (charted) cache
    const info = { gateWp: cached?.gateWp || null, conns: [], readable: false, underCon: cached?.underCon };
    try {
      if (!info.gateWp || info.underCon === undefined) {
        let page = 1, total = Infinity, seen = 0;                 // find own gate via public waypoint listing (works uncharted)
        while (seen < total && (!info.gateWp || info.underCon === undefined)) {
          const r = await api('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`);
          total = r.meta?.total ?? (r.data || []).length; seen += (r.data || []).length;
          const g = (r.data || []).find((w) => w.type === 'JUMP_GATE'); if (g) { info.gateWp = g.symbol; info.underCon = !!g.isUnderConstruction; }
          if (!r.data || !r.data.length) break; page++;
        }
      }
      if (info.gateWp) {                                          // read connections (needs charted / ship present)
        const jg = await api('GET', `/systems/${sys}/waypoints/${info.gateWp}/jump-gate`);
        if (jg.data && jg.data.connections) { info.conns = jg.data.connections.map((c) => ({ sys: sysOf(c), wp: c })); info.readable = true; }
      }
    } catch { /* uncharted/no-ship → not readable, will retry */ }
    gateGraph.set(sys, info);
    return info;
  }
  // BFS the CHARTED gate graph for the shortest system path from→to. Only expands through readable (charted) systems,
  // so it can always resolve targets up to 1 hop beyond our charted frontier — exactly how far a seed probe can reach.
  async function gatePath(from, to) {
    if (from === to) return [from];
    const prev = { [from]: null }; const q = [from]; let guard = 0;
    while (q.length && guard++ < 120) {
      const s = q.shift();
      const info = await gateInfo(s);
      if (!info.readable) continue;                              // can't see past an uncharted gate
      // [REACHABILITY] A jump needs BOTH gates BUILT: you jump OUT of s's gate INTO c's gate. An under-construction
      // gate still LISTS its connections (the API returns them), but any jump from/into it is rejected. So: (a) never
      // expand OUT of an under-construction transit system, and (b) never accept a destination whose own gate is unbuilt
      // (the UZ64 trap). This is what stranded the GX17/UG37 probes — the bot routed THROUGH unbuilt HC40/XM56 gates.
      if (info.underCon && s !== from) continue;                 // (a) can't jump out of an unbuilt gate
      for (const { sys: c } of info.conns) {
        if (prev[c] !== undefined) continue;
        prev[c] = s;
        if (c === to) { const ci = await gateInfo(to); if (ci.underCon) { prev[c] = undefined; continue; } const p = []; let n = to; while (n !== null) { p.unshift(n); n = prev[n]; } return p; }  // (b) dest gate must be built to jump IN
        q.push(c);
      }
    }
    return null;
  }
  // advance a ship one hop along `path`. Jumps cur→next using the destination gate WAYPOINT from cur's connection list
  // (cur is charted). Charts the gate on arrival at a new system so the next frontier becomes visible.
  async function followPath(sym, ship, path) {
    const cur = sysOf(ship.nav.waypointSymbol);
    let idx = path.indexOf(cur);
    if (idx === -1) { if (cur === path[0]) idx = 0; else return 'stray'; }
    if (idx >= path.length - 1) return 'arrived';
    const next = path[idx + 1];
    const ci = await gateInfo(cur);
    const fromG = ci.gateWp;
    const toG = (ci.conns.find((c) => c.sys === next) || {}).wp;  // exact next-gate waypoint from cur's charted connections
    if (!fromG || !toG) return 'no-gate';
    const mkts = cur === homeSystem ? homeMarkets() : (target && cur === target.sys ? tgtMarkets : (outposts.get(cur)?.markets || {}));
    await jumpVia(sym, ship, fromG, toG, mkts);
    return 'moving';
  }
  // chart a gate we're sitting on but can't yet read (extends the frontier for the next expansion).
  async function chartGate(sym, ship, sys) {
    const gi = await gateInfo(sys);
    if (gi.readable) return;
    if (gi.gateWp && ship.nav.waypointSymbol === gi.gateWp) { try { await api('POST', `/my/ships/${sym}/chart`); gateGraph.delete(sys); } catch { /* already charted or not at gate */ } }
  }

  // drive one outpost member: migrate along the gate path (N-deep) then trade/scan PURELY LOCAL in the outpost system.
  async function stepOutpost(sym, ship) {
    const m = members.get(sym);
    const op = outposts.get(m.opSys);
    if (!op) { m.last = 'no outpost'; await sleep(SLEEP_MS); return; }
    const cur = sysOf(ship.nav.waypointSymbol);
    const hubSys = target ? target.sys : null;          // PP48
    const hubGate = target ? target.gateWp : null;      // PP48 D18A

    // [RECALL] consolidate onto the hub. Arrived at the hub → convert to a hub role and let normal hub logic run.
    // Tag the member with recalledFrom = its origin outpost so RECALL RELEASE can fan it back out to that system.
    // Mine systems are EXEMPT from recall — they keep their local crew (probes anchor mining buys, traders move the
    // refined goods), so concentrating the thin arbitrage outposts on the hub doesn't gut the mining colony.
    const recalling = recallActive() && !MINE_SYSTEMS.includes(m.opSys);
    if (recalling && hubSys && cur === hubSys) {
      const isP = ship.frame?.symbol === 'FRAME_PROBE';
      members.set(sym, isP ? { role: 'PROBE', scanned: new Set(), recalledFrom: m.opSys } : { role: 'LIGHT', recalledFrom: m.opSys });
      log(`🪐 ${id(sym)} recalled to hub ${hubSys} → ${isP ? 'PROBE' : 'LIGHT'}`);
      return;
    }

    // ---- arrived at the outpost system → resident local trading ----
    if (cur === op.sys) {
      await loadSystemInto(op);
      if (!op.gateWp) op.gateWp = ship.nav.waypointSymbol; // fallback: we jumped in via the gate
      if (op.deep && m.role === 'OUTPROBE' && !gateGraph.get(op.sys)?.readable) await chartGate(sym, ship, op.sys);  // chart on arrival → opens the next frontier
      // [RECALL] don't trade here — jump back to the hub (outpost gate → hub gate); role converts on hub arrival above.
      if (recalling && hubGate) {
        m.last = `recall ${op.sys.slice(-4)}→${hubSys.slice(-4)}`;
        await jumpVia(sym, ship, op.gateWp, hubGate, op.markets);
        return;
      }
      if (m.role === 'OUTPROBE') {
        // 1:1 market partition: each OUTPROBE owns a contiguous arc of this outpost's markets and only refreshes
        // ITS arc when stale. When probes>=markets each owns ONE market → it parks there (presence = live prices)
        // → full 1:1 fresh coverage at MINIMAL API (no redundant fleet-wide rescans that would starve haulers).
        const wps = op.marketWps;
        if (!wps.length) { await sleep(SLEEP_MS); m.last = `scanning ${op.sys.slice(-4)} (mapping)`; return; }
        const peers = [...members.entries()].filter(([, mm]) => mm.role === 'OUTPROBE' && mm.opSys === op.sys).map(([s]) => s).sort();
        const idx = Math.max(0, peers.indexOf(sym)), n = peers.length || 1;
        const lo = Math.floor((idx * wps.length) / n), hi = Math.max(Math.floor(((idx + 1) * wps.length) / n), lo + 1);
        const arc = wps.slice(lo, hi);
        m.scanned = new Set(arc);
        const stale = arc.filter((w) => isStale(op.markets[w]));
        if (!stale.length) {
          // [BUDGET] Dwell until the SOONEST arc market actually needs a refresh (its adaptive nextAt), not a fixed 90s.
          // A probe parked on calm markets shouldn't wake — and burn a worker ship-GET — every 90s. Capped at 4 min so
          // it still re-evaluates (and stays STOP-responsive) reasonably often.
          const soon = Math.min(...arc.map((w) => op.markets[w]?.nextAt || 0));
          const dwell = Math.max(PROBE_DWELL_MS, Math.min(240_000, (Number.isFinite(soon) && soon > 0 ? soon - now() : PROBE_DWELL_MS)));
          await sleep(dwell); m.last = `1:1 ${op.sys.slice(-4)} arc[${arc.length}] fresh`; return;
        }
        const here = ship.nav.waypointSymbol; stale.sort((a, b) => D(here, a) - D(here, b));
        const dest = stale[0];
        try { await goToSys(sym, dest, op.markets); await scanMarketInto(dest, op); log(`🛰 ${id(sym)} refreshed ${id(dest)} @${op.sys.slice(-4)} (arc ${arc.length}/${wps.length})`); }
        catch (e) { log(`🛰 ${id(sym)} scout ERR ${e.message}`); }
        await sleep(2000); return;
      }
      // OUTLIGHT: local buy-low/sell-high inside the outpost
      await scanAllInto(op);
      if (await dumpCargo(sym, ship, cur, op.markets)) return;
      const lane = bestLane(ship, op.markets, cur, op.markets, cur, null);
      if (!lane) {
        const todo = op.marketWps.filter((w) => isStale(op.markets[w]));
        if (todo.length) { const here = ship.nav.waypointSymbol; todo.sort((a, b) => D(here, a) - D(here, b)); try { await goToSys(sym, todo[0], op.markets); await scanMarketInto(todo[0], op); } catch {} m.last = `scanning ${op.sys.slice(-4)} (no lane)`; return; }
        m.last = `parked ${op.sys.slice(-4)} (no lane)`; await sleep(SLEEP_MS); return;
      }
      await runLane(sym, ship, lane, op.markets, op.markets, null);
      return;
    }

    // ---- migration: follow the gate path home → ... → outpost (N-deep) ----
    if (!op.path || !op.path.length) { m.last = 'await path'; await sleep(SLEEP_MS); return; }
    const r = await followPath(sym, ship, op.path);
    if (r === 'moving') { const i = op.path.indexOf(cur); m.last = `migrating → ${op.sys.slice(-4)} (hop ${i + 1}/${op.path.length - 1})`; return; }
    // [STRAY RECOVERY] A ship sitting OFF the outpost's gate path (e.g. parked at the hub on the wrong branch) returns
    // 'stray' from followPath and would park forever. Re-route it onto the path: walk it back toward home (path[0]) via a
    // fresh gate route from where it actually is, so it can then follow op.path correctly. This rescues hub-stranded crews.
    if (r === 'stray' && cur !== op.path[0]) {
      let back = null; try { back = await gatePath(cur, op.path[0]); } catch {}
      if (back && back.length > 1) { const mv = await followPath(sym, ship, back); m.last = `stray→home (${mv}) to rejoin ${op.sys.slice(-4)}`; if (mv === 'moving') return; }
    }
    m.last = `${r} → ${op.sys.slice(-4)}`; await sleep(SLEEP_MS);   // no-gate / unrecoverable → park (recoverable next tick)
  }

  async function stepProbe(sym, ship) {
    const cur = sysOf(ship.nav.waypointSymbol);
    if (cur === homeSystem && target.sys !== homeSystem) { await ensureAtTargetThenJump(sym, ship); return; }
    // in target system: roam to the next unscanned marketplace, dwell, scan it
    await loadTargetSystem(target.sys);
    const m = members.get(sym); if (!m.scanned) m.scanned = new Set();
    const todo = tgtMarketWps.filter((w) => !m.scanned.has(w));
    if (!todo.length) { await scanAllTargets(); await sleep(PROBE_DWELL_MS); return; } // all covered → keep refreshing
    // nearest unscanned by D() from current position
    const here = ship.nav.waypointSymbol;
    todo.sort((a, b) => D(here, a) - D(here, b));
    const dest = todo[0];
    try { await goToSys(sym, dest, tgtMarkets); await scanMarket(dest); m.scanned.add(dest); log(`🛰 ${id(sym)} scanned ${id(dest)} (${m.scanned.size}/${tgtMarketWps.length})`); }
    catch (e) { log(`🛰 ${id(sym)} scout ERR ${e.message}`); m.scanned.add(dest); }
    await sleep(2000);
  }

  async function stepLight(sym, ship) {
    const cur = sysOf(ship.nav.waypointSymbol);
    if (cur === homeSystem && target.sys !== homeSystem) { await ensureAtTargetThenJump(sym, ship); return; }
    await loadTargetSystem(target.sys);
    await scanAllTargets();
    if (await dumpCargo(sym, ship, cur, tgtMarkets)) return;
    const lane = bestLane(ship, tgtMarkets, cur, tgtMarkets, cur, null);
    if (!lane) {                                                                 // no local lane yet → help scan the system instead of idling
      if (await helpScan(sym, ship)) { members.get(sym).last = 'scanning (no local lane)'; return; }
      members.get(sym).last = 'parked (no local lane)'; await sleep(SLEEP_MS); return;
    }
    await runLane(sym, ship, lane, tgtMarkets, tgtMarkets, null);
  }

  async function stepHauler(sym, ship) {
    const cur = sysOf(ship.nav.waypointSymbol);
    await loadTargetSystem(target.sys);
    await scanAllTargets();
    const srcMkts = cur === homeSystem ? homeMarkets() : tgtMarkets;
    if (await dumpCargo(sym, ship, cur, srcMkts)) return;                       // clear leftovers first

    // 1) CROSS-system lane sourced HERE (buy here → jump → sell there) — the headline inter-system arbitrage
    const otherSys = cur === homeSystem ? target.sys : homeSystem;
    const otherMkts = cur === homeSystem ? tgtMarkets : homeMarkets();
    const srcGate = cur === homeSystem ? gateWp() : target.gateWp;
    const dstGate = cur === homeSystem ? target.gateWp : gateWp();
    const cross = bestLane(ship, srcMkts, cur, otherMkts, otherSys, { srcGate, dstGate, dstSys: otherSys });
    // 2) LOCAL lane here
    const local = bestLane(ship, srcMkts, cur, srcMkts, cur, null);

    if (cross && (!local || cross.rate >= local.rate)) { await runLane(sym, ship, cross, srcMkts, otherMkts, { srcGate, dstGate }); return; }
    if (local) { await runLane(sym, ship, local, srcMkts, srcMkts, null); return; }

    // 3) nothing here: if we're stranded in the target with no lane but HOME has markets, reposition home (empty jump)
    if (cur !== homeSystem) {
      const homeHasLane = bestLane(ship, homeMarkets(), homeSystem, tgtMarkets, target.sys, { srcGate: target.gateWp, dstGate: gateWp(), dstSys: homeSystem })
                       || bestLane(ship, homeMarkets(), homeSystem, homeMarkets(), homeSystem, null);
      if (homeHasLane) {
        if (cooldownUntil.get(sym) > now()) { await sleep(Math.min(cooldownUntil.get(sym) - now() + 500, 30_000)); return; }
        if (getCredits() - antimatterPx < FLOOR) { await sleep(SLEEP_MS); return; }
        if (ship.nav.waypointSymbol !== target.gateWp) { await goToSys(sym, target.gateWp, tgtMarkets); return; }
        try { await refuel(sym); } catch {}
        try { const d = await jump(sym, gateWp()); if (d.transaction?.totalPrice > 0) antimatterPx = d.transaction.totalPrice; if (d.cooldown?.remainingSeconds) cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000); }
        catch (e) { log(`🪐 ${id(sym)} reposition-home jump ERR ${e.message}`); await sleep(SLEEP_MS); }
        return;
      }
    }
    members.get(sym).last = 'parked (no lane)';
    await sleep(SLEEP_MS);
  }

  // execute a chosen lane. crossing={srcGate,dstGate} for inter-system; null for local.
  async function runLane(sym, ship, lane, srcMkts, dstMkts, crossing) {
    const tag = crossing ? 'X-SYS' : 'local';
    log(`🪐 ${id(sym)} ${tag} ${lane.units} ${lane.good} ${id(lane.srcWp)}@${lane.buyPx}→${id(lane.dstWp)}@${lane.sellPx} est net=${Math.round(lane.net).toLocaleString()} ~${Math.round(lane.rate || 0)}cr/min (${Math.round(lane.mins || 0)}m)`);
    let spent = 0, amCr = 0;
    try {
      await goToSys(sym, lane.srcWp, srcMkts);
      const maxPx = Math.ceil(lane.buyPx * 1.08);
      const r = await buy(sym, lane.good, lane.units, maxPx);
      spent = r.spent;
      if (r.bought <= 0) { log(`🪐 ${id(sym)} ${lane.good} buy got 0 — abort`); await sleep(SLEEP_MS); return; }
      if (crossing) {
        await goToSys(sym, crossing.srcGate, srcMkts);
        if (cooldownUntil.get(sym) > now()) await sleep(Math.min(cooldownUntil.get(sym) - now() + 500, 30_000));
        try { await refuel(sym); } catch {}
        const d = await jump(sym, crossing.dstGate);
        amCr = d.transaction?.totalPrice || antimatterPx;
        if (d.transaction?.totalPrice > 0) antimatterPx = d.transaction.totalPrice;
        if (d.cooldown?.remainingSeconds) { cooldownUntil.set(sym, now() + d.cooldown.remainingSeconds * 1000); jumpCooldownMin = d.cooldown.remainingSeconds / 60; }
      }
      await goToSys(sym, lane.dstWp, dstMkts);
      const s = await sell(sym, lane.good);
      const net = s.got - spent - amCr;
      record(sym, net, `${tag} ${lane.good}→${id(lane.dstWp)}${crossing ? ` (antimatter ${Math.round(amCr)})` : ''}`);
    } catch (e) {
      // mid-lane failure: the held goods aren't lost — dumpCargo on the next loop salvages them at the best sink.
      log(`🪐 ${id(sym)} lane ERR ${e.message} — will salvage held cargo next loop`);
      await sleep(SLEEP_MS);
    }
  }

  // -------------------------------- MINE COLONY --------------------------------
  // COMMON_METAL asteroids in a system (cached 30min — asteroid layout is static). These yield IRON/COPPER/ALUMINUM
  // ore on un-surveyed extraction, all of which the local refinery imports (buys), so no surveyor is needed for the
  // basic loop. We page through the system's waypoints once and keep the asteroid list.
  async function commonMetalAsteroids(sys) {
    const c = asteroidCache.get(sys);
    if (c && now() - c.at < 1_800_000) return c.list;
    const list = [];
    try {
      let page = 1, total = Infinity, seen = 0;
      while (seen < total) {
        const r = await api('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`);
        total = r.meta?.total ?? (r.data || []).length; seen += (r.data || []).length;
        for (const w of r.data || []) {
          if (!/ASTEROID/.test(w.type)) continue;
          const traits = (w.traits || []).map((t) => t.symbol);
          const mods = (w.modifiers || []).map((m) => m.symbol);
          if (traits.includes('COMMON_METAL_DEPOSITS') && !mods.includes('CRITICAL_LIMIT')) list.push(w.symbol);
        }
        if (!r.data || !r.data.length) break;
        page++;
      }
    } catch (e) { log(`⛏ asteroid scan ${sys} ERR ${e.message}`); }
    asteroidCache.set(sys, { at: now(), list });
    return list;
  }

  // One mining drone: shuttle between a COMMON_METAL asteroid (extract) and the best local ore sink (sell). Pure
  // local loop — drones are bought in-system so they never migrate. Ore is mined (≈free); selling it to the refinery
  // that imports it is almost pure margin. Renewable + parallel: the scaling lever.
  //
  // PARK-AND-FERRY: drones stay glued to ONE shared asteroid extracting continuously and PUSH ore to a co-located
  // hauler (transfer); the hauler ferries full loads to the refinery so drones never lose mining time. A surveyor keeps
  // fresh surveys so extraction targets IRON/COPPER/ALUMINUM (2-3× the random yield). All colony ships converge on the
  // same rock (mineColony[sys].asteroid) so transfers always co-locate.
  const MINE_ORES = ['IRON_ORE', 'COPPER_ORE', 'ALUMINUM_ORE'];
  function pruneMineSurveys(c) { const t = now(); c.surveys = (c.surveys || []).filter((s) => new Date(s.expiration).getTime() > t + 5000); }
  function bestSurvey(c) { pruneMineSurveys(c); let best = null, bd = -1; for (const s of c.surveys) { const dep = s.deposits || []; const density = dep.filter((d) => MINE_ORES.includes(d.symbol)).length / (dep.length || 1); if (density > bd) { bd = density; best = s; } } return best; }
  async function colonyAsteroid(sys) {
    let c = mineColony.get(sys);
    if (c && c.asteroid) return c.asteroid;
    const asts = await commonMetalAsteroids(sys);
    if (!asts.length) return null;
    if (!c) { c = { asteroid: asts[0], surveys: [] }; mineColony.set(sys, c); } else c.asteroid = asts[0];
    return c.asteroid;
  }
  async function ensureAtRock(sym, ship, sys, op) {
    const ast = await colonyAsteroid(sys);
    if (!ast) return null;
    if (ship.nav.waypointSymbol !== ast) { await goToSys(sym, ast, op ? op.markets : {}); return false; }
    if (ship.nav.status === 'DOCKED') { try { await api('POST', `/my/ships/${sym}/orbit`); } catch {} }
    return ast;
  }

  // Migrate a stray mining hull to its colony via the 2-hop gate route (home → hub → mine system). Mirrors the outpost
  // migration. Returns true if it handled (caller should return). Mining hulls bought locally never need this, but a
  // hull stranded by an earlier home-buy (or any displacement) self-recovers here instead of parking forever.
  async function migrateToMine(sym, ship, sys) {
    const op = outposts.get(sys);
    const m = members.get(sym);
    let path = op && op.path;
    if (!path) { try { path = await gatePath(homeSystem, sys); if (op && path) op.path = path; } catch {} }
    if (!path || !path.length) { m.last = `await route → ${sys.slice(-4)}`; await sleep(SLEEP_MS); return; }
    const r = await followPath(sym, ship, path);
    if (r === 'moving') { const i = path.indexOf(sysOf(ship.nav.waypointSymbol)); m.last = `migrating → ${sys.slice(-4)} (mine hop ${i + 1}/${path.length - 1})`; return; }
    m.last = `${r} → ${sys.slice(-4)}`; await sleep(SLEEP_MS);
  }

  // SURVEYOR: park on the colony rock and keep producing surveys into the shared pool (drones consume them).
  async function stepSurveyor(sym, ship) {
    const m = members.get(sym); const sys = m.mineSys; const op = outposts.get(sys);
    if (sysOf(ship.nav.waypointSymbol) !== sys) return migrateToMine(sym, ship, sys);
    const ast = await ensureAtRock(sym, ship, sys, op);
    if (ast === null) { m.last = `no asteroid ${sys.slice(-4)}`; await sleep(SLEEP_MS); return; }
    if (ast === false) { m.last = '→ rock'; return; }
    if (mineCd.get(sym) > now()) { await sleep(Math.min(mineCd.get(sym) - now() + 500, 30_000)); m.last = 'survey cd'; return; }
    try {
      const d = (await api('POST', `/my/ships/${sym}/survey`)).data;
      const c = mineColony.get(sys); if (c) for (const s of d.surveys || []) c.surveys.push(s);
      if (d.cooldown?.remainingSeconds) mineCd.set(sym, now() + d.cooldown.remainingSeconds * 1000);
      m.last = `surveyed +${(d.surveys || []).length}`;
    } catch (e) { const mm = /(\d+)\s*second/i.exec(e.message); if (mm) mineCd.set(sym, now() + (+mm[1]) * 1000 + 500); else { m.last = `survey ERR ${e.message}`; await sleep(SLEEP_MS); } }
  }

  // DRONE: park on the rock, extract (survey-biased), and PUSH ore to a co-located hauler. Falls back to selling itself
  // only if no hauler shows up (so it never deadlocks holding a full hold).
  async function stepMiner(sym, ship) {
    const m = members.get(sym); const sys = m.mineSys; const op = outposts.get(sys);
    if (sysOf(ship.nav.waypointSymbol) !== sys) return migrateToMine(sym, ship, sys);
    if (op && !op.loaded) await loadSystemInto(op);
    const ast = await ensureAtRock(sym, ship, sys, op);
    if (ast === null) { m.last = `no COMMON_METAL asteroid`; await sleep(SLEEP_MS); return; }
    if (ast === false) { m.last = `→ rock`; return; }

    const capFree = (ship.cargo?.capacity || 0) - (ship.cargo?.units || 0);
    const ore = (ship.cargo?.inventory || []).filter((i) => i.symbol !== 'FUEL');
    const oreUnits = ore.reduce((a, i) => a + i.units, 0);
    if (oreUnits > 0 && capFree <= 3) {
      // push ore to a co-located hauler (keeps mining without leaving the rock)
      const haulers = [...members.entries()].filter(([, mm]) => mm.role === 'MINEHAUL' && mm.mineSys === sys).map(([s]) => s);
      for (const hs of haulers) {
        try { const h = await getShip(hs); if (h.nav.waypointSymbol !== ast || h.nav.status === 'IN_TRANSIT') continue; let hFree = h.cargo.capacity - h.cargo.units; if (hFree <= 0) continue;
          for (const it of ore) { const give = Math.min(it.units, hFree); if (give > 0) { await transfer(sym, hs, it.symbol, give); hFree -= give; } }
          m.last = `pushed ore→${hs.slice(-3)}`; return;
        } catch {}
      }
      // no hauler ready → sell ore ourselves at the local sink (fallback)
      if (op) { await scanAllInto(op); if (await dumpCargo(sym, ship, sysOf(ship.nav.waypointSymbol), op.markets)) { m.last = 'sold ore (no hauler)'; return; } }
      m.last = `full, awaiting hauler`; await sleep(SLEEP_MS); return;
    }

    if (mineCd.get(sym) > now()) { await sleep(Math.min(mineCd.get(sym) - now() + 500, 30_000)); m.last = `cooldown`; return; }
    const c = mineColony.get(sys); const survey = c ? bestSurvey(c) : null;
    try {
      const r = (await api('POST', `/my/ships/${sym}/extract`, survey ? { survey } : undefined)).data;
      if (r.cooldown?.remainingSeconds) mineCd.set(sym, now() + r.cooldown.remainingSeconds * 1000);
      const y = r.extraction?.yield; m.last = y ? `mined ${y.units} ${y.symbol}` : `extracted`;
    } catch (e) {
      const mm = /(\d+)\s*second/i.exec(e.message);
      if (/survey/i.test(e.message)) { if (c && survey) c.surveys = c.surveys.filter((s) => s !== survey); }   // exhausted/expired survey → drop it
      else if (mm && /cooldown/i.test(e.message)) mineCd.set(sym, now() + (+mm[1]) * 1000 + 500);
      else if (/cargo|full|capacity/i.test(e.message)) { /* push/sell next loop */ }
      else { m.last = `mine ERR ${e.message}`; await sleep(SLEEP_MS); }
    }
  }

  // HAULER: park on the rock collecting ore the drones push; when full (or after a wait, to clear partial loads) ferry
  // to the best local sink (refinery), sell, return. Keeps the drones extracting full-time.
  async function stepMineHaul(sym, ship) {
    const m = members.get(sym); const sys = m.mineSys; const op = outposts.get(sys);
    if (sysOf(ship.nav.waypointSymbol) !== sys) return migrateToMine(sym, ship, sys);
    if (op && !op.loaded) await loadSystemInto(op);
    const cap = ship.cargo?.capacity || 0;
    const oreUnits = (ship.cargo?.inventory || []).filter((i) => i.symbol !== 'FUEL').reduce((a, i) => a + i.units, 0);
    const capFree = cap - (ship.cargo?.units || 0);
    const fullEnough = capFree <= Math.max(2, Math.floor(cap * 0.12));
    // ferry when full, or when holding ore past the collection deadline (so partial loads still get sold)
    if (oreUnits > 0 && (fullEnough || (m.ferryBy && now() > m.ferryBy))) {
      // [CHAIN-FEED contention guard] If a feeder has an active export claim on this colony, TRANSFER our ore to it
      // (co-located at the rock) instead of selling to the local sink — preserves the mined metal for high-margin export.
      const claim = exportClaims.get(sys);
      if (claim && now() < claim.until) {
        try {
          const f = await getShip(claim.feederSym);
          if (f && f.nav.waypointSymbol === ship.nav.waypointSymbol && f.nav.status !== 'IN_TRANSIT') {
            let fFree = (f.cargo.capacity || 0) - (f.cargo.units || 0);
            if (fFree > 0) { for (const it of (ship.cargo?.inventory || []).filter((i) => i.symbol !== 'FUEL')) { const give = Math.min(it.units, fFree); if (give > 0) { await transfer(sym, claim.feederSym, it.symbol, give); fFree -= give; } } m.last = `staged ore→feeder ${id(claim.feederSym)}`; return; }
          }
        } catch {}
        // feeder not co-located / full → keep collecting; only spill to local sink if we're truly maxed (drones must not deadlock)
        if (!fullEnough) { m.last = `holding for feeder (${oreUnits})`; await sleep(SLEEP_MS); return; }
      }
      if (op) { await scanAllInto(op); if (await dumpCargo(sym, ship, sysOf(ship.nav.waypointSymbol), op.markets)) { m.last = `ferried ${oreUnits} ore`; m.ferryBy = null; return; } }
      m.last = `holding ${oreUnits} ore (no sink scanned)`; await sleep(SLEEP_MS); return;
    }
    // park at the rock and collect (drones push to us)
    const ast = await ensureAtRock(sym, ship, sys, op);
    if (ast === null) { m.last = `no asteroid`; await sleep(SLEEP_MS); return; }
    if (ast === false) { m.last = `→ rock to collect`; return; }
    if (oreUnits > 0 && !m.ferryBy) m.ferryBy = now() + 180_000;   // ferry a partial load if drones are slow
    m.last = `collecting @rock (${oreUnits}/${cap})`; await sleep(SLEEP_MS);
  }

  // -------------------------------- [CHAIN-FEED] feeder executor --------------------------------
  // Build a ranked list of cross-system feed loops from live (probe-covered) market data. Each loop:
  // { good, srcSys, srcWp, srcPrice, mined, sinkSys, sinks:[{wp,price,vol}], margin, pct, cap }.
  // Prefers MINED goods (a colony exports the metal we mine → source cost ~0, no buy-climb → full margin).
  let lastPlanAt = 0, lastPlanLog = 0;
  async function buildFeedPlan() {
    if (now() - lastPlanAt < 30_000 && feedPlan.length) return;           // refresh from cache every 30s (cheap)
    lastPlanAt = now();
    // [PERF] Read the market data our PROBES already cache (op.markets / tgtMarkets) — no live API calls, so the scan is
    // instant and never competes with the fleet's rate budget. Falls back to skipping a system if its markets aren't loaded yet.
    const src = {}, sink = {};                                            // good -> best source / [sinks]
    const minedGoods = new Set();
    for (const sys of MINE_SYSTEMS) for (const g of ['IRON', 'COPPER', 'ALUMINUM']) minedGoods.add(g + '@' + sys);
    const sysMarkets = [];                                                // [{sys, markets:{wp:{tradeGoods}}}]
    if (target?.sys && tgtMarketWps.length) sysMarkets.push({ sys: target.sys, markets: tgtMarkets });
    for (const sys of outposts.keys()) { const op = outposts.get(sys); if (op?.markets) sysMarkets.push({ sys, markets: op.markets }); }
    for (const { sys, markets } of sysMarkets) {
      for (const wp of Object.keys(markets)) {
        const g = markets[wp]?.tradeGoods; if (!g) continue;
        for (const t of g) {
          if (!FEED_GOODS.includes(t.symbol)) continue;
          if (t.type === 'EXPORT' || t.type === 'EXCHANGE') { const mined = minedGoods.has(t.symbol + '@' + sys); if (!src[t.symbol] || (mined && !src[t.symbol].mined) || t.purchasePrice < src[t.symbol].p) src[t.symbol] = { sys, wp, p: t.purchasePrice, vol: t.tradeVolume, mined }; }
          if (t.type === 'IMPORT' || t.type === 'EXCHANGE') { (sink[t.symbol] = sink[t.symbol] || []).push({ sys, wp, p: t.sellPrice, vol: t.tradeVolume }); }
        }
      }
    }
    const loops = [];
    for (const good of FEED_GOODS) {
      const s = src[good]; if (!s || !sink[good]) continue;
      const xs = sink[good].filter((x) => x.sys !== s.sys).sort((a, b) => b.p - a.p);   // cross-system sinks only
      if (!xs.length) continue;
      const best = xs[0]; const refCost = s.mined && FEED_PREFER_MINED ? Math.round(s.p * 0.25) : s.p;   // mined ≈ near-free
      const margin = best.p - refCost; if (margin <= 0) continue;
      const pct = Math.round(margin / Math.max(1, refCost) * 100); if (pct < FEED_MIN_MARGIN_PCT) continue;
      const cap = xs.slice(0, 6).reduce((a, x) => a + (x.vol || 0) * FEED_SATURATION_N, 0);
      loops.push({ good, srcSys: s.sys, srcWp: s.wp, srcPrice: s.p, mined: !!s.mined, sinkSys: best.sys, sinks: xs.slice(0, 6), margin, pct, cap });
    }
    loops.sort((a, b) => (b.margin * Math.min(b.cap, 490)) - (a.margin * Math.min(a.cap, 490)));
    if (loops.length) { feedPlan = loops; if (now() - (lastPlanLog || 0) > 60_000) { lastPlanLog = now(); log(`🚚 feedPlan: ${loops.slice(0, 3).map((l) => `${l.good} ${l.srcSys.slice(-4)}→${l.sinkSys.slice(-4)} +${l.margin}(${l.pct}%)${l.mined ? '⛏' : ''}`).join(' | ')}`); } }
  }

  // [DELIVER-WHAT-YOU-HOLD] Build a delivery loop for a good we ALREADY carry. The purchase is a sunk cost, so we ignore
  // the profit-margin threshold entirely — ANY sink beats hauling it forever as ballast. Scans cached markets for the
  // best sellPrice (cross-system preferred so we don't just dump back where we bought, but same-system allowed as a last
  // resort). Returns a loop shaped like buildFeedPlan's, or null if no market anywhere imports the good.
  function bestSinkLoop(good, fromSys) {
    const sysMarkets = [];
    if (target?.sys && tgtMarketWps.length) sysMarkets.push({ sys: target.sys, markets: tgtMarkets });
    for (const sys of outposts.keys()) { const op = outposts.get(sys); if (op?.markets) sysMarkets.push({ sys, markets: op.markets }); }
    const sinks = [];
    for (const { sys, markets } of sysMarkets) for (const wp of Object.keys(markets)) {
      for (const t of (markets[wp]?.tradeGoods || [])) { if (t.symbol === good && (t.type === 'IMPORT' || t.type === 'EXCHANGE')) sinks.push({ sys, wp, p: t.sellPrice, vol: t.tradeVolume }); }
    }
    if (!sinks.length) return null;
    const cross = sinks.filter((x) => x.sys !== fromSys);
    const pool = (cross.length ? cross : sinks).sort((a, b) => b.p - a.p);
    const best = pool[0];
    return { good, srcSys: fromSys, srcWp: null, srcPrice: 0, mined: false, sinkSys: best.sys, sinks: pool.slice(0, 6), margin: best.p, pct: 0, cap: 0, deliverOnly: true };
  }
  // [LOCAL DELIVERY] If the system we're STANDING IN already imports the good we hold, deliver it here — no cross-system
  // haul. Used for stranded-cargo recovery so a feeder sitting on a valid sink sells in place instead of jumping away.
  function localSinkLoop(good, sys) {
    const op = sys === target?.sys ? { markets: tgtMarkets } : outposts.get(sys);
    if (!op?.markets) return null;
    const sinks = [];
    for (const wp of Object.keys(op.markets)) for (const t of (op.markets[wp]?.tradeGoods || [])) { if (t.symbol === good && (t.type === 'IMPORT' || t.type === 'EXCHANGE')) sinks.push({ sys, wp, p: t.sellPrice, vol: t.tradeVolume }); }
    if (!sinks.length) return null;
    sinks.sort((a, b) => b.p - a.p);
    return { good, srcSys: sys, srcWp: null, srcPrice: 0, mined: false, sinkSys: sys, sinks: sinks.slice(0, 6), margin: sinks[0].p, pct: 0, cap: 0, deliverOnly: true };
  }
  // path to the sink system → multi-DROP across sinks (per-market cap = tradeVolume × N, the saturation guard) → repeat.
  async function feederTrip(sym, ship) {
    const m = members.get(sym);
    await buildFeedPlan();
    if (!feedPlan.length) { m.last = 'no feed loop'; await sleep(SLEEP_MS); return; }
    // [LOOP LOCK] Pick a fresh loop ONLY when idle (no loop yet, or a stale empty-handed LOAD). Never re-pick while we're
    // already carrying cargo for the current loop — feedPlan re-sorts every 30s, and switching mid-load would strand a
    // half-loaded good (e.g. drop a FABRICS loop for EQUIPMENT and never deliver the FABRICS). Cargo commits the loop.
    const carrying = (ship.cargo?.units || 0) > 0;
    if (!m.loop || (!carrying && m.phase === 'LOAD' && now() - (m.loopAt || 0) > 120_000) || (carrying && m.loop && m.phase === 'LOAD' && !((ship.cargo.inventory || []).some((i) => i.symbol === m.loop.good)))) {
      // [CARGO RECOVERY] After a restart (m.loop gone) or when we're holding a good whose profit-loop fell off the plan
      // (our own buy raised its source price below threshold), DELIVER what we hold rather than strand it. bestSinkLoop
      // ignores the margin gate — the buy is sunk cost, so any sink beats ballast. Empty hold → pick a fresh feedPlan loop.
      let pick;
      if (carrying) {
        const heldGood = (ship.cargo.inventory || []).sort((a, b) => b.units - a.units)[0]?.symbol;
        const cs = sysOf(ship.nav.waypointSymbol);
        // Prefer selling in the system we're ALREADY in (no wasted cross-system haul); then a matching profit loop; then
        // any reachable sink. All ignore the margin gate — held cargo is sunk cost, so any delivery beats ballast.
        pick = localSinkLoop(heldGood, cs) || feedPlan.find((l) => l.good === heldGood) || bestSinkLoop(heldGood, cs) || feedPlan[0];
        m.phase = 'HAUL';
      } else { pick = feedPlan[0]; m.phase = 'LOAD'; }
      m.loop = pick; m.loopAt = now(); m.soldHere = 0;
    }
    const loop = m.loop; const curSys = sysOf(ship.nav.waypointSymbol);
    const held = (ship.cargo?.inventory || []).filter((i) => i.symbol === loop.good).reduce((a, i) => a + i.units, 0);
    const cap = ship.cargo?.capacity || 0;
    if (now() - (m.dbgAt || 0) > 25_000) { m.dbgAt = now(); log(`🚚dbg ${id(sym)} ${m.phase} loop=${loop.good} src=${loop.srcWp ? id(loop.srcWp) : 'deliver'}(${loop.srcSys.slice(-4)}) sink=${loop.sinkSys.slice(-4)} cap=${loop.cap} held=${held} at=${id(ship.nav.waypointSymbol)}/${ship.nav.status}`); }

    // ---- LOAD phase ----
    if (m.phase === 'LOAD') {
      if (held >= Math.min(cap, loop.cap)) { m.phase = 'HAUL'; m.last = `loaded ${held} ${loop.good}`; return; }
      if (curSys !== loop.srcSys) { const path = await gatePath(curSys, loop.srcSys); if (path) { const r = await followPath(sym, ship, path); m.last = `→ source ${loop.srcSys.slice(-4)} (${r})`; return; } m.last = `no path → ${loop.srcSys.slice(-4)}`; await sleep(SLEEP_MS); return; }
      // at source system: set an export claim if mined (so local haulers stage for us, not sell out from under us)
      if (loop.mined && MINE_SYSTEMS.includes(loop.srcSys)) exportClaims.set(loop.srcSys, { good: loop.good, feederSym: sym, qty: Math.min(cap, loop.cap), until: now() + 300_000 });
      if (ship.nav.waypointSymbol !== loop.srcWp) { await goToSys(sym, loop.srcWp, outposts.get(loop.srcSys)?.markets || {}); m.last = `→ ${id(loop.srcWp)}`; return; }
      if (ship.nav.status !== 'DOCKED') { try { await api('POST', `/my/ships/${sym}/dock`); } catch {} }
      // buy up to cap (mined goods still buyable at the export market; the claim keeps haulers from draining it)
      try {
        const mk = (await api('GET', `/systems/${loop.srcSys}/waypoints/${loop.srcWp}/market`)).data;
        const g = (mk.tradeGoods || []).find((x) => x.symbol === loop.good);
        const free = cap - (ship.cargo?.units || 0);
        if (g && free > 0 && g.purchasePrice <= loop.srcPrice * 1.6) { const units = Math.min(g.tradeVolume, free); await api('POST', `/my/ships/${sym}/purchase`, { symbol: loop.good, units }); m.last = `+${units} ${loop.good}@${g.purchasePrice}`; return; }
        m.phase = 'HAUL'; m.last = `load done (${held})`; return;                  // price climbed or full → haul what we have
      } catch (e) { m.last = `load ERR ${e.message}`; await sleep(SLEEP_MS); return; }
    }

    // ---- HAUL phase ----
    if (m.phase === 'HAUL') {
      if (held <= 0) { m.phase = 'LOAD'; return; }
      if (curSys !== loop.sinkSys) { const path = await gatePath(curSys, loop.sinkSys); if (path) { const r = await followPath(sym, ship, path); m.last = `haul → ${loop.sinkSys.slice(-4)} (${r})`; return; } m.last = `no path → ${loop.sinkSys.slice(-4)}`; await sleep(SLEEP_MS); return; }
      m.phase = 'SELL'; m.sinkIdx = 0; return;
    }

    // ---- SELL phase: multi-drop across sinks, capped per market ----
    if (m.phase === 'SELL') {
      if (held <= 0) { m.phase = 'LOAD'; m.last = `circuit done`; m.soldHere = 0; if (exportClaims.get(loop.srcSys)?.feederSym === sym) exportClaims.delete(loop.srcSys); return; }
      const sink = loop.sinks[m.sinkIdx || 0];
      if (!sink) { /* out of sinks but still holding → dump at best local */ const op = outposts.get(curSys); if (op) { await scanAllInto(op); await dumpCargo(sym, ship, curSys, op.markets); } m.phase = 'LOAD'; m.soldHere = 0; return; }
      if (ship.nav.waypointSymbol !== sink.wp) { await goToSys(sym, sink.wp, outposts.get(loop.sinkSys)?.markets || {}); m.last = `→ sink ${id(sink.wp)}`; return; }
      if (ship.nav.status !== 'DOCKED') { try { await api('POST', `/my/ships/${sym}/dock`); } catch (e) { log(`🚚 ${id(sym)} dock ERR @${id(sink.wp)}: ${e.message}`); await sleep(SLEEP_MS); return; } }
      try {
        const mk = (await api('GET', `/systems/${curSys}/waypoints/${sink.wp}/market`)).data;
        const g = (mk.tradeGoods || []).find((x) => x.symbol === loop.good);
        if (g && (g.type === 'IMPORT' || g.type === 'EXCHANGE')) {
          // [SELL CAP] API rejects any single sell larger than tradeVolume, so each transaction is capped at tradeVolume.
          // FEED_SATURATION_N is the TOTAL we'll dump at THIS market across repeated ticks (m.soldHere) before moving on —
          // that's the anti-saturation guard (don't crash one market's price), not a per-transaction size.
          const perMarketCap = g.tradeVolume * FEED_SATURATION_N;
          const room = perMarketCap - (m.soldHere || 0);
          const units = Math.max(0, Math.min(g.tradeVolume, held, room));
          if (units > 0) {
            const r = (await api('POST', `/my/ships/${sym}/sell`, { symbol: loop.good, units })).data;
            m.soldHere = (m.soldHere || 0) + units;
            log(`🚚 ${id(sym)} sold ${units} ${loop.good} @${g.sellPrice} ${id(sink.wp)} (${m.soldHere}/${perMarketCap} here, ${held - units} left)`);
            if (units >= held) { m.phase = 'LOAD'; m.soldHere = 0; if (exportClaims.get(loop.srcSys)?.feederSym === sym) exportClaims.delete(loop.srcSys); }  // circuit done
            else if (m.soldHere >= perMarketCap || units < g.tradeVolume) { m.sinkIdx = (m.sinkIdx || 0) + 1; m.soldHere = 0; }  // this market full → next sink
            return;
          }
        }
        m.sinkIdx = (m.sinkIdx || 0) + 1; m.soldHere = 0; log(`🚚 ${id(sym)} skip ${id(sink.wp)} — ${g ? g.type : 'no '+loop.good} (not importer) → next sink`); return;   // not an importer / capped → next sink
      } catch (e) { log(`🚚 ${id(sym)} sell ERR @${id(sink.wp)}: ${e.message} — next sink`); m.sinkIdx = (m.sinkIdx || 0) + 1; m.soldHere = 0; await sleep(SLEEP_MS); return; }
    }
    m.phase = 'LOAD';
  }

  // -------------------------------- public API --------------------------------
  async function step(sym, ship) {
    const m = members.get(sym);
    try {
      if (m.role === 'PROBE') await stepProbe(sym, ship);
      else if (m.role === 'LIGHT') await stepLight(sym, ship);
      else if (m.role === 'MINEDRONE') await stepMiner(sym, ship);
      else if (m.role === 'MINESURVEY') await stepSurveyor(sym, ship);
      else if (m.role === 'MINEHAUL') await stepMineHaul(sym, ship);
      else if (m.role === 'OUTPROBE' || m.role === 'OUTLIGHT') await stepOutpost(sym, ship);
      else if (m.role === 'FEEDER') await feederTrip(sym, ship);
      else await stepHauler(sym, ship);
    } catch (e) { log(`🪐 ${id(sym)} expand step ERR ${e.message} — parking`); await sleep(SLEEP_MS); }
  }

  async function selectMembers() {
    let all;
    try { all = await getAllShips(); } catch (e) { log(`🪐 fleet read ERR ${e.message}`); return false; }
    const isProbe = (s) => s.frame?.symbol === 'FRAME_PROBE';
    const byId = (set, s) => { for (const t of set) if (s.symbol === t || s.symbol.endsWith('-' + t)) return true; return false; };

    // [NEGOTIATOR GUARD] Never migrate the contract negotiator into the hub. Unlike gate haulers/feeders (which are
    // legitimately repurposed for expansion once the gate is built), the negotiator has a HOME-ONLY job: contract
    // negotiation requires it DOCKED at a faction-presence waypoint (the HQ system). If it gets poached to another
    // system, every negotiate/contract call 400s with "does not have a faction presence" and contracts stall.
    const negSet = new Set();
    for (const k of ['NEGOTIATOR', 'CONTRACT_NEGOTIATOR']) for (const t of listEnv(k)) negSet.add(t);
    try { const neg = typeof negotiator === 'function' ? negotiator() : null; if (neg) negSet.add(neg); } catch {}
    const isNeg = (s) => [...negSet].some((t) => s.symbol === t || s.symbol.endsWith('-' + t));

    // HAULER: explicit, else largest-cargo non-probe with fuel>=400 (can clear the long gate legs). [CHAIN-FEED] never a feeder.
    let haulers;
    if (EXPLICIT_HAULERS.size) haulers = all.filter((s) => byId(EXPLICIT_HAULERS, s) && !isNeg(s) && !isFeeder(s.symbol) && !isReservedShip(s.symbol));
    else { const cand = all.filter((s) => !isProbe(s) && !isNeg(s) && !isFeeder(s.symbol) && !isReservedShip(s.symbol) && s.cargo.capacity >= 40 && s.fuel.capacity >= 400).sort((a, b) => (b.fuel.capacity - a.fuel.capacity) || (b.cargo.capacity - a.cargo.capacity)); haulers = cand.slice(0, 1); }
    const haulerSet = new Set(haulers.map((s) => s.symbol));

    // LIGHT: explicit, else a smaller non-probe hull not already chosen as hauler. [CHAIN-FEED] never a feeder.
    let light;
    if (EXPLICIT_LIGHT.size) light = all.filter((s) => byId(EXPLICIT_LIGHT, s) && !isNeg(s) && !isFeeder(s.symbol) && !isReservedShip(s.symbol));
    else { const cand = all.filter((s) => !isProbe(s) && !isNeg(s) && !isFeeder(s.symbol) && !isReservedShip(s.symbol) && !haulerSet.has(s.symbol) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200).sort((a, b) => a.cargo.capacity - b.cargo.capacity); light = cand.slice(0, 1); }
    const lightSet = new Set(light.map((s) => s.symbol));

    // PROBES: explicit, else up to MAX_PROBES idle probes — never the negotiator (it must stay home to negotiate)
    let probes;
    if (EXPLICIT_PROBES.size) probes = all.filter((s) => byId(EXPLICIT_PROBES, s) && !isNeg(s));
    else probes = all.filter((s) => isProbe(s) && !isNeg(s)).slice(0, MAX_PROBES);

    for (const s of haulers) members.set(s.symbol, { role: 'HAULER' });
    for (const s of light) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'LIGHT' });
    for (const s of probes) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'PROBE', scanned: new Set() });
    // [CHAIN-FEED] adopt reserved feeders as FEEDER members (so bot2 routes them through expansion.step, not the home trade loop)
    if (CHAIN_FEED) for (const s of all) if (isFeeder(s.symbol) && !members.has(s.symbol)) members.set(s.symbol, { role: 'FEEDER' });
    return members.size > 0;
  }

  // assign small resident crews to each configured outer system (drawn from idle ships not used by the hub).
  // Position-aware: a free ship ALREADY in an outpost system resumes that outpost (restart-safe, no reshuffle);
  // remaining slots fill from idle ships at home/hub.
  async function setupOutposts() {
    if (!OUTPOSTS.length || outpostsReady) return;
    let all;
    try { all = await getAllShips(); } catch (e) { log(`🛰 outpost fleet read ERR ${e.message}`); return; }
    const isProbe = (s) => s.frame?.symbol === 'FRAME_PROBE';
    const reserved = new Set();
    for (const k of ['GATE_HAULERS', 'INPUT_FEEDERS', 'MINE_TRANSPORT', 'MINE_FUNNEL', 'MINE_BATCH', 'CONTRACT_RUNNER', 'NEGOTIATOR', 'CONTRACT_NEGOTIATOR', 'EXPAND_HAULERS', 'EXPAND_LIGHT', 'EXPAND_PROBES', 'EXPAND_RESERVE'])
      for (const t of listEnv(k)) reserved.add(t);
    // also reserve the resolved contract negotiator (its bot2 DEFAULT isn't visible via env) — never poach it,
    // or contracts stall with "ship not docked" errors. Passed from bot2 ctx as negotiator().
    try { const neg = typeof negotiator === 'function' ? negotiator() : null; if (neg) reserved.add(neg); } catch {}
    const isReserved = (s) => [...reserved].some((t) => s.symbol === t || s.symbol.endsWith('-' + t));  // never poach a home-role ship
    const free = (s) => !members.has(s.symbol) && !isReserved(s);
    const isTrader = (s) => !isProbe(s) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200 && !/MINING_LASER|SURVEYOR/.test(JSON.stringify(s.mounts || []));
    const assign = (s, sys) => { const role = isProbe(s) ? 'OUTPROBE' : 'OUTLIGHT'; members.set(s.symbol, role === 'OUTPROBE' ? { role, opSys: sys, scanned: new Set() } : { role, opSys: sys }); launchWorker(s.symbol); return s.symbol.slice(-3) + (isProbe(s) ? ':P' : ':T'); };

    // [N-DEEP] resolve a gate PATH home→outpost for each configured system (any depth, not just hub-adjacent).
    // A path needs every intermediate gate CHARTED; deep frontier systems may not resolve at boot (gates not charted
    // yet) → park them in pendingOutposts and resolvePending() retries over time as our probes chart the frontier.
    for (const sys of OUTPOSTS) {
      if (outposts.has(sys)) continue;
      let path = null; try { path = await gatePath(homeSystem, sys); } catch {}
      if (!path) { pendingOutposts.add(sys); log(`🛰 outpost ${sys} — path not chartable yet → pending (will retry as frontier charts)`); continue; }
      const gInfo = await gateInfo(sys);
      const deep = (path.length - 1) > 2;
      const op = { sys, gateWp: gInfo.gateWp, path, deep, markets: {}, marketWps: [], loaded: false };
      outposts.set(sys, op);
      await seedWorthy(op);   // [LARGE-MARKETS-ONLY] map now + flag tooSmall so staffing below skips small systems
      log(`🛰 outpost ${sys} path ${path.map((s) => s.slice(-4)).join('→')} (${path.length - 1} jumps${deep ? ', DEEP→probe-seed+buy-local' : ''}${op.tooSmall ? ', TOO-SMALL→skip-seed' : ''})`);
    }
    if (!outposts.size) { log('🛰 no reachable outposts yet — will retry'); return; }
    // Per-outpost probe target = 1:1 with markets (fresh data on every market); fall back to OUTPOST_PROBES until
    // the system's markets are mapped so pass-2 never over-pulls blindly. Deep systems seed only a couple probes.
    const probeTgt = (sys) => { const op = outposts.get(sys); const m = (op && op.marketWps.length) || 0; const base = m > 0 ? m : OUTPOST_PROBES; return op && op.deep ? Math.min(base, 2) : base; };
    // pass 1 — adopt ALL ships already sitting in an outpost system (local residents = zero migration: this is where
    // manually/locally-bought probes & haulers get put to work immediately, converging the system toward 1:1).
    const crews = {}; const probeCnt = {}, traderCnt = {};
    for (const sys of outposts.keys()) { crews[sys] = []; probeCnt[sys] = 0; traderCnt[sys] = 0; }
    for (const s of all) {
      if (!free(s)) continue; const sys = s.nav.systemSymbol;
      if (!outposts.has(sys)) continue;
      if (outposts.get(sys).tooSmall) continue;                 // [LARGE-MARKETS-ONLY] don't colonize small systems
      if (isProbe(s)) { crews[sys].push(assign(s, sys)); probeCnt[sys]++; }
      else if (isTrader(s)) { crews[sys].push(assign(s, sys)); traderCnt[sys]++; }
    }
    // pass 2 — fill the SHORTFALL from idle ships elsewhere. Probes: pull toward target ONLY from non-home idle probes
    // (never strip the home system's market scanners). Traders: migrate idle traders to NEAR (≤2-jump) outposts only;
    // DEEP outposts get NO migrated traders — autobuy buys them LOCALLY (cheap), seeded by the migrated probe.
    const idleProbes = all.filter((s) => isProbe(s) && free(s) && s.nav.systemSymbol !== homeSystem);
    const idleTraders = all.filter((s) => isTrader(s) && free(s)).sort((a, b) => a.cargo.capacity - b.cargo.capacity);
    let pi = 0, ti = 0;
    for (const sys of outposts.keys()) {
      const op = outposts.get(sys); const ptgt = probeTgt(sys);
      if (op.tooSmall) continue;                                // [LARGE-MARKETS-ONLY] skip idle-fill for small systems
      if (!op.deep) while (traderCnt[sys] < traderTarget(sys) && ti < idleTraders.length) { crews[sys].push(assign(idleTraders[ti++], sys)); traderCnt[sys]++; }
      while (probeCnt[sys] < ptgt && pi < idleProbes.length) { crews[sys].push(assign(idleProbes[pi++], sys)); probeCnt[sys]++; }
      log(`🛰 OUTPOST ${sys} (gate ${id(op.gateWp)}${op.deep ? ', DEEP' : ''}) crew[P${probeCnt[sys]}/${ptgt} T${traderCnt[sys]}/${op.deep ? 'local' : traderTarget(sys)}]: ${crews[sys].join(' ') || 'NONE (seed by autobuy)'}`);
    }
    outpostsReady = true;
  }

  // [FRONTIER RETRY] resolve pending (deep/frontier) outposts as our probes chart the way. Once a path resolves, add the
  // outpost and seed it with the nearest idle probe (it traverses the gate path, charting the destination on arrival).
  // Rate-limited. This is what makes expansion N-deep AND automatic: each newly-charted system opens the next frontier.
  async function resolvePending() {
    if (!pendingOutposts.size || now() - lastResolveAt < 45_000) return;
    lastResolveAt = now();
    let all = null;
    for (const sys of [...pendingOutposts]) {
      let path = null; try { path = await gatePath(homeSystem, sys); } catch {}
      if (!path) continue;                                       // still not chartable — keep pending
      const gInfo = await gateInfo(sys);
      const deep = (path.length - 1) > 2;
      const op = { sys, gateWp: gInfo.gateWp, path, deep, markets: {}, marketWps: [], loaded: false };
      outposts.set(sys, op);
      pendingOutposts.delete(sys);
      if (!(await seedWorthy(op))) {                              // [LARGE-MARKETS-ONLY] charted but too small — don't seed
        log(`🛰 RESOLVED frontier ${sys} (${path.length - 1} jumps) — TOO-SMALL (${op.marketWps.length} markets), charted not seeded`);
        continue;
      }
      log(`🛰 RESOLVED frontier ${sys} path ${path.map((s) => s.slice(-4)).join('→')} (${path.length - 1} jumps) — seeding probe`);
      // seed: assign the nearest idle non-home probe to this new outpost (it migrates + charts on arrival)
      try { all = all || await getAllShips(); } catch { all = []; }
      const seed = all.find((s) => s.frame?.symbol === 'FRAME_PROBE' && !members.has(s.symbol) && s.nav.status !== 'IN_TRANSIT' && s.nav.systemSymbol !== homeSystem)
                || all.find((s) => s.frame?.symbol === 'FRAME_PROBE' && !members.has(s.symbol) && s.nav.status !== 'IN_TRANSIT');
      if (seed) { members.set(seed.symbol, { role: 'OUTPROBE', opSys: sys, scanned: new Set() }); launchWorker(seed.symbol); log(`🛰 seed ${id(seed.symbol)} → ${sys.slice(-4)} (deep probe)`); }
      else log(`🛰 no idle probe to seed ${sys.slice(-4)} — autobuy will buy/migrate one`);
    }
  }

  // Grow the fleet to fill the staffing/coverage SHORTFALL left after setupOutposts exhausted idle ships. One
  // FLOOR-guarded, lifetime-capped buy attempt per window. Priority: (1) a trader for any trader-starved outpost
  // (directly earns), then (2) a probe for the most coverage-deficient outpost (cheap, sharpens every lane).
  // Per-system shipyard discovery (cached 10min): array of { wp, sells:Set<type>, price:{type:px} }. Used to buy
  // LOCALLY in an outpost's own system (no 2-hop migration) and only where we have a ship present (purchase API).
  const sysYardCache = new Map();
  async function shipyardsIn(sys) {
    const c = sysYardCache.get(sys);
    if (c && now() - c.at < 600_000) return c.list;
    const list = [];
    try {
      const wps = (await api('GET', `/systems/${sys}/waypoints?limit=20&traits=SHIPYARD`)).data || [];
      for (const w of wps) {
        try {
          const sy = (await api('GET', `/systems/${sys}/waypoints/${w.symbol}/shipyard`)).data;
          const sells = new Set(), price = {};
          for (const s of sy.ships || []) { sells.add(s.type); if (s.purchasePrice != null) price[s.type] = s.purchasePrice; }
          for (const t of sy.shipTypes || []) sells.add(t.type);
          list.push({ wp: w.symbol, sells, price });
        } catch {}
      }
    } catch {}
    sysYardCache.set(sys, { at: now(), list });
    return list;
  }

  // Pick where to buy `type`: walk `prefSys` in order (outpost-local first → home fallback), require one of our
  // ships PRESENT at the yard waypoint (the purchase API needs it) so the buy actually succeeds. Returns
  // { wp, price, sys, local } or null. `shipWps` = waypoints where we currently have a non-transit ship.
  async function pickBuy(type, prefSys, shipWps) {
    for (const sys of prefSys) {
      if (!sys) continue;
      let list; try { list = await shipyardsIn(sys); } catch { continue; }
      const sell = list.filter((y) => y.sells.has(type));
      const here = sell.find((y) => shipWps.has(y.wp));         // a yard that sells it AND has our ship docked/in-orbit
      if (here) return { wp: here.wp, price: here.price[type] ?? null, sys, local: sys !== homeSystem };
    }
    return null;
  }

  // [LOCAL-BUY ANCHOR] Purchases need one of our ships AT the yard. When we want to buy `type` in `sys` but no ship is
  // parked at a selling yard, divert the nearest idle in-system ship (prefer a probe — the yard is also a market, so it
  // keeps feeding prices) to that yard so the NEXT window's buy succeeds. This unblocks LOCAL buying of mining drones
  // (which home can't sell) and cheap frontier probes (avoiding the spiked home shipyard). Returns true if it dispatched
  // an anchor (caller should treat as "not ready this window"). Throttled per yard via anchorSent.
  const anchorSent = new Map();   // yardWp -> epoch ms last dispatched
  async function anchorBuy(type, sys, allShips) {
    let list; try { list = await shipyardsIn(sys); } catch { return false; }
    const selling = list.filter((y) => y.sells.has(type));
    if (!selling.length) return false;
    const present = new Set(allShips.filter((s) => s.nav.status !== 'IN_TRANSIT').map((s) => s.nav.waypointSymbol));
    if (selling.some((y) => present.has(y.wp))) return false;   // already have a ship at a selling yard — pickBuy will use it
    const yard = selling[0].wp;
    if (now() - (anchorSent.get(yard) || 0) < 120_000) return true;  // recently dispatched — give it time to arrive
    const inSys = allShips.filter((s) => s.nav.systemSymbol === sys && s.nav.status !== 'IN_TRANSIT' && !cooldownUntil.get(s.symbol));
    const cand = inSys.find((s) => s.frame?.symbol === 'FRAME_PROBE') || inSys[0];
    if (!cand) return false;
    anchorSent.set(yard, now());
    try { await goToSys(cand.symbol, yard, outposts.get(sys)?.markets || {}); log(`🛒 anchoring ${id(cand.symbol)} → ${id(yard)} (so local ${type.replace('SHIP_', '')} buys work)`); }
    catch (e) { log(`🛒 anchor ${id(cand.symbol)} → ${id(yard)} FAILED: ${e.message}`); }
    return true;
  }

  async function autoBuy(fleet) {
    if (!AUTOBUY || !triggered || !outpostsReady) return;
    if (!buyShip) return;                                        // ctx not wired (older bot2)
    if (now() - lastBuyAt < BUY_EVERY_MS) return;
    if (boughtProbes >= MAX_BUY_PROBES && boughtTraders >= MAX_BUY_TRADERS) return;
    let credits; try { credits = getCredits(); } catch { return; }
    if (credits <= BUY_FLOOR) return;                            // no surplus over the safety floor — never buy

    // [HUB + OUTPOSTS] Staff the HUB (target.sys — the primary new system, most markets+shipyards) AND every outpost.
    // Including the hub here means the worst-coverage-gap logic naturally PRIORITIZES it first (it has the biggest gap),
    // then fans OUTWARD to the outposts as the hub saturates — exactly the "concentrate on the fattest system first,
    // then expand outward" strategy. Hub crew use roles PROBE / LIGHT|HAULER (system = target.sys); outposts use
    // OUTPROBE / OUTLIGHT (system = m.opSys). Previously the hub was skipped entirely, so YK2 got NO autobuy coverage.
    const staffSystems = [];
    if (target && target.sys) staffSystems.push({ sys: target.sys, markets: tgtMarketWps.length, gateWp: target.gateWp, hub: true });
    if (!recallActive()) for (const sys of outposts.keys()) { const op = outposts.get(sys); if (op.tooSmall) continue; staffSystems.push({ sys, markets: op.marketWps.length || 0, gateWp: op.gateWp, hub: false }); }   // [RECALL] hub-only buys while concentrating; [LARGE-MARKETS-ONLY] never autobuy crew for small systems

    // current resident staffing per system (counts in-transit migrators too, so we never over-order)
    const probeN = {}, traderN = {};
    const droneN = {}, surveyorN = {}, haulerN = {};
    for (const s of MINE_SYSTEMS) { droneN[s] = 0; surveyorN[s] = 0; haulerN[s] = 0; }
    for (const ss of staffSystems) { probeN[ss.sys] = 0; traderN[ss.sys] = 0; }
    for (const [, m] of members) {
      if (m.role === 'MINEDRONE') { if (droneN[m.mineSys] !== undefined) droneN[m.mineSys]++; continue; }
      if (m.role === 'MINESURVEY') { if (surveyorN[m.mineSys] !== undefined) surveyorN[m.mineSys]++; continue; }
      if (m.role === 'MINEHAUL') { if (haulerN[m.mineSys] !== undefined) haulerN[m.mineSys]++; continue; }
      let sys = null, isP = false, isT = false;
      if (m.role === 'OUTPROBE') { sys = m.opSys; isP = true; }
      else if (m.role === 'OUTLIGHT') { sys = m.opSys; isT = true; }
      else if (m.role === 'PROBE') { sys = target && target.sys; isP = true; }     // hub probe
      else if (m.role === 'LIGHT' || m.role === 'HAULER') { sys = target && target.sys; isT = true; }  // hub trader
      if (sys == null || probeN[sys] === undefined) continue;
      if (isP) probeN[sys]++; else if (isT) traderN[sys]++;
    }

    // waypoints where we have a ship present right now (purchase needs a hull at the yard)
    let allShips, shipWps;
    allShips = fleet; if (!allShips) { try { allShips = await getAllShips(); } catch (e) { lastBuyAt = now(); log(`🛒 AUTOBUY fleet read ERR ${e.message}`); return; } }
    shipWps = new Set(allShips.filter((s) => s.nav.status !== 'IN_TRANSIT').map((s) => s.nav.waypointSymbol));

    // decide ONE action. PRIORITY (user-set): (1) probe 1:1 coverage FIRST — establish market visibility everywhere,
    // then (2) trader-starved systems (arbitrage earners), then (3) the mine colony fills LAST. Buy LOCAL when possible.
    let action = null;
    // 1) probe 1:1 coverage — buy LOCAL & cheap (anchor a ship at the system's own probe yard; hub included).
    if (!action && boughtProbes < MAX_BUY_PROBES) {
      let worst = null, worstGap = 0;
      for (const ss of staffSystems) {
        if (!ss.markets) continue;                              // unmapped — don't buy probes blind
        const tgt = PROBE_TARGET_CAP > 0 ? Math.min(ss.markets, PROBE_TARGET_CAP) : ss.markets;
        const gap = tgt - probeN[ss.sys];
        if (gap > worstGap) { worstGap = gap; worst = ss; }
      }
      if (worst) {
        // LOCAL-FIRST: buy the probe IN the system it will live (find the local shipyard that sells probes) so it needs no
        // migration. [NEAR-SEED] If the target has NO probe yard of its own, DON'T drag a probe from the spiked home yard
        // 7-11 jumps away — walk the outpost's gate path BACKWARD (target → … → home) and buy at the NEAREST system that
        // sells probes where we have a ship. Migration becomes the shortest possible (often a single hop). Home stays the
        // last-resort tail (it's the final element of every path). Hub/home coverage still buys at home (no op.path).
        const op = outposts.get(worst.sys);
        const localYards = await shipyardsIn(worst.sys);
        const hasLocalProbeYard = localYards.some((y) => y.sells.has('SHIP_PROBE'));
        const pathBack = (op && op.path && op.path.length > 1) ? op.path.slice(0, -1).reverse() : [homeSystem];  // nearest→…→home
        const srcSystems = hasLocalProbeYard ? [worst.sys] : [worst.sys, ...pathBack];
        const loc = await pickBuy('SHIP_PROBE', srcSystems, shipWps);
        const price = loc ? (loc.price || 26_000) : 0;
        const tooPricey = loc && MAX_PROBE_PRICE > 0 && loc.price && loc.price > MAX_PROBE_PRICE;
        if (tooPricey) log(`🛒 AUTOBUY probe @${id(loc.wp)} ${loc.price.toLocaleString()} > cap ${MAX_PROBE_PRICE.toLocaleString()} — waiting for cheaper`);
        if (loc && !tooPricey && credits - price >= BUY_FLOOR) action = { kind: 'probe', role: worst.hub ? 'PROBE' : 'OUTPROBE', type: 'SHIP_PROBE', wp: loc.wp, price, sys: worst.sys, local: loc.local };
        else if (!loc || tooPricey) {
          // No buyable yard with a ship present (or only the over-priced home yard). Anchor a ship at the NEAREST
          // path-system that sells probes (target first, then back toward home) so next window buys there cheaply.
          const anchorCandidates = hasLocalProbeYard ? [worst.sys] : [worst.sys, ...pathBack];
          for (const cs of anchorCandidates) {
            let ys; try { ys = await shipyardsIn(cs); } catch { continue; }
            if (!ys.some((y) => y.sells.has('SHIP_PROBE'))) continue;   // this path-system can't sell probes — try next
            if (await anchorBuy('SHIP_PROBE', cs, allShips)) break;      // dispatched/awaiting an anchor here → stop
          }
        }
      }
    }
    // 2) trader-starved system. LOCAL-FIRST (same rule as probes): if the system has a yard selling a preferred trader
    //    hull, buy IN-SYSTEM (anchor a ship at the yard to unlock live prices) — never home+migrate. Only systems with NO
    //    local trader yard at all fall back to a home buy + migration.
    if (!action && boughtTraders < MAX_BUY_TRADERS) {
      const starved = staffSystems.find((ss) => traderN[ss.sys] < traderTarget(ss.sys));
      if (starved) {
        const op = outposts.get(starved.sys);
        const deep = op && op.deep;
        const yards = await shipyardsIn(starved.sys);
        const localHulls = TRADER_PREF.filter((t) => yards.some((y) => y.sells.has(t)));   // preferred hulls this system sells
        const hasLocalTraderYard = localHulls.length > 0;
        const buyInSystem = deep || hasLocalTraderYard;
        const prefSys = buyInSystem ? [starved.sys] : [starved.sys, homeSystem];
        const hullList = hasLocalTraderYard ? localHulls : TRADER_PREF;
        let anyYard = false;
        for (const t of hullList) {                             // best available hull first
          const loc = await pickBuy(t, prefSys, shipWps);
          if (!loc) continue;
          anyYard = true;
          const px = loc.price || 320_000;
          if (MAX_TRADER_PRICE > 0 && loc.price && loc.price > MAX_TRADER_PRICE) continue;   // too pricey → try next hull / wait
          if (credits - px >= BUY_FLOOR) { action = { kind: 'trader', role: starved.hub ? 'LIGHT' : 'OUTLIGHT', type: t, wp: loc.wp, price: px, sys: starved.sys, local: loc.local }; break; }
        }
        // local trader yard exists but no ship parked there yet → anchor one (side-effect, NON-blocking) so a NEXT window buys in-system
        if (!action && buyInSystem && !anyYard) { for (const t of hullList) { if (await anchorBuy(t, starved.sys, allShips)) break; } }
      }
    }
    // 3) [MINE COLONY] LAST priority: staff each colony surveyor (yield) → haulers (park-and-ferry) → drones (scale).
    //    Mining hulls are sold ONLY at the colony's own shipyard (home can't), so always buy local (anchor if needed).
    //    Anchors are dispatched as a side-effect even when this isn't the chosen buy, so the yard is ready when its turn comes.
    if (!action && boughtDrones < MAX_BUY_DRONES) {
      const roleSpec = [
        { type: MINE_SURVEYOR_TYPE, role: 'MINESURVEY', have: surveyorN, want: MINE_SURVEYORS_PER, dflt: 40_000 },
        { type: MINE_HAUL_TYPE, role: 'MINEHAUL', have: haulerN, want: MINE_HAULERS_PER, dflt: 180_000 },
        { type: MINE_DRONE_TYPE, role: 'MINEDRONE', have: droneN, want: MINE_DRONES_PER, dflt: 80_000 },
      ];
      for (const sys of MINE_SYSTEMS) {
        if (action) break;
        if (!outposts.has(sys)) continue;                       // need market data to sink ore
        for (const rs of roleSpec) {
          if (rs.have[sys] >= rs.want) continue;
          const loc = await pickBuy(rs.type, [sys], shipWps);   // LOCAL-ONLY: a home-bought mining hull can't reach the colony
          if (loc) {
            const px = loc.price || rs.dflt;
            if (MAX_TRADER_PRICE > 0 && loc.price && loc.price > MAX_TRADER_PRICE) continue;
            if (credits - px >= BUY_FLOOR) { action = { kind: 'mine', role: rs.role, type: rs.type, wp: loc.wp, price: px, sys, local: loc.local, have: rs.have[sys], want: rs.want }; break; }
          } else { await anchorBuy(rs.type, sys, allShips); }   // dispatch a mining anchor (side-effect); don't block
        }
      }
    }
    if (!action) return;

    lastBuyAt = now();                                          // throttle regardless of outcome (avoid retry spam)
    let bought; try { bought = await buyShip(action.type, action.wp); } catch (e) { log(`🛒 AUTOBUY ${action.type} @${id(action.wp)} ERR ${e.message}`); return; }
    if (!bought) { log(`🛒 AUTOBUY ${action.type} @${id(action.wp)} → no hull (retry next window)`); return; }
    const m = action.role === 'OUTPROBE' ? { role: 'OUTPROBE', opSys: action.sys, scanned: new Set() }
            : action.role === 'PROBE' ? { role: 'PROBE', scanned: new Set() }
            : action.role === 'MINEDRONE' ? { role: 'MINEDRONE', mineSys: action.sys }
            : action.role === 'MINESURVEY' ? { role: 'MINESURVEY', mineSys: action.sys }
            : action.role === 'MINEHAUL' ? { role: 'MINEHAUL', mineSys: action.sys }
            : action.role === 'LIGHT' ? { role: 'LIGHT' }
            : { role: 'OUTLIGHT', opSys: action.sys };
    members.set(bought, m);
    launchWorker(bought);
    const where = action.local ? `LOCAL @${action.sys.slice(-4)}` : 'home→migrate';
    const mktCount = action.sys === (target && target.sys) ? tgtMarketWps.length : (outposts.get(action.sys)?.marketWps.length || '?');
    if (action.kind === 'trader') { boughtTraders++; log(`🛒 AUTOBUY trader ${action.type} ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; traders ${traderN[action.sys]}→${traderN[action.sys] + 1}/${traderTarget(action.sys)}, bought ${boughtTraders}/${MAX_BUY_TRADERS}]`); }
    else if (action.kind === 'mine') { boughtDrones++; const tag = action.role === 'MINESURVEY' ? 'surveyor' : action.role === 'MINEHAUL' ? 'ore-hauler' : 'mining drone'; log(`⛏ AUTOBUY ${tag} ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; ${action.have}→${action.have + 1}/${action.want}, mine-buys ${boughtDrones}/${MAX_BUY_DRONES}]`); }
    else { boughtProbes++; log(`🛒 AUTOBUY probe ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; probes ${probeN[action.sys]}→${probeN[action.sys] + 1}/${mktCount}, bought ${boughtProbes}/${MAX_BUY_PROBES}]`); }
  }

  // [RECALL RELEASE] Once credits reach EXPAND_RECALL_RELEASE, end concentration and fan the fleet back out: every
  // ship we recalled (tagged recalledFrom) is restored to its origin outpost role. It's physically at the hub, so the
  // existing migration state machine jumps it hub→outpost on the next step. Outpost autobuy also resumes (staffSystems
  // includes outposts once recallActive() is false). Latched: fires exactly once. Idempotent/no-op when not recalling.
  function checkRecallRelease() {
    if (!RECALL || recallReleased || RECALL_RELEASE <= 0) return;
    let credits; try { credits = getCredits(); } catch { return; }
    if (credits < RECALL_RELEASE) return;
    recallReleased = true;
    outpostsReady = false;                                        // let setupOutposts re-run to fill any remaining shortfall
    let restored = 0;
    for (const [sym, m] of members) {
      if (!m.recalledFrom) continue;
      const sys = m.recalledFrom;
      const isP = m.role === 'PROBE';
      members.set(sym, isP ? { role: 'OUTPROBE', opSys: sys, scanned: new Set() } : { role: 'OUTLIGHT', opSys: sys });
      restored++;
    }
    log(`🪐🟢 RECALL RELEASED at ${Math.round(credits).toLocaleString()}cr (≥ ${RECALL_RELEASE.toLocaleString()}) — fanning out: ${restored} ship(s) returning to outposts + outpost autobuy resumes.`);
  }

  // [MINE] Adopt any non-member mining hull (MINING_LASER → MINEDRONE, SURVEYOR → MINESURVEY) ANYWHERE — in a mine
  // system (resume), or stranded at home/hub (e.g. an earlier home-buy, or idle gate-era drones) → assign to a colony
  // and let migrateToMine ferry it over. Safe because home mining (MINE_FEED) is off once the gate is built, so these
  // hulls are otherwise idle. Restart-safe; pulls every spare mining hull into the colonies.
  async function adoptMiners(fleet) {
    if (!MINE_SYSTEMS.length) return;
    let all = fleet; if (!all) { try { all = await getAllShips(); } catch { return; } }
    for (const s of all) {
      if (members.has(s.symbol)) continue;
      if (s.nav.status === 'IN_TRANSIT') continue;
      const mounts = (s.mounts || []).map((m) => m.symbol || m);
      const isDrone = mounts.some((x) => /MINING_LASER/.test(x));
      const isSurvey = mounts.some((x) => /SURVEYOR/.test(x));
      if (!isDrone && !isSurvey) continue;
      const sys = MINE_SYSTEMS.includes(s.nav.systemSymbol) ? s.nav.systemSymbol : MINE_SYSTEMS[0];
      const role = isDrone ? 'MINEDRONE' : 'MINESURVEY';
      members.set(s.symbol, { role, mineSys: sys });
      launchWorker(s.symbol);
      log(`⛏ adopted ${id(s.symbol)} → ${role} @${sys.slice(-4)}${s.nav.systemSymbol !== sys ? ` (migrating from ${s.nav.systemSymbol.slice(-4)})` : ''}`);
    }
    // [MINEHAUL] Adopt a non-member, non-probe cargo hull that is PHYSICALLY IN a mine system as an ore-ferry (MINEHAUL),
    // up to MINE_HAULERS_PER. Mine-system yards on the frontier don't sell haulers, so the only way a colony gets a ferry
    // is a MANUALLY MIGRATED hauler — this adopts it. Guards: only ships already in the mine system (zero migration), and
    // existing trader members are skipped (they were claimed by setupOutposts first), so this never strips a trade fleet.
    if (MINE_HAULERS_PER > 0) {
      const haulN = {}; for (const s of MINE_SYSTEMS) haulN[s] = 0;
      for (const [, m] of members) if (m.role === 'MINEHAUL' && haulN[m.mineSys] !== undefined) haulN[m.mineSys]++;
      for (const s of all) {
        if (members.has(s.symbol)) continue;
        if (s.nav.status === 'IN_TRANSIT') continue;
        const sys = s.nav.systemSymbol;
        if (!MINE_SYSTEMS.includes(sys)) continue;               // only adopt a hauler already AT a colony (no migration)
        if (haulN[sys] >= MINE_HAULERS_PER) continue;
        if (s.frame?.symbol === 'FRAME_PROBE') continue;
        if (isFeeder(s.symbol) || isReservedShip(s.symbol)) continue;   // never poach a feeder/reserved (e.g. warp EXPLORER)
        const mounts = (s.mounts || []).map((m) => m.symbol || m);
        if (mounts.some((x) => /MINING_LASER|SURVEYOR/.test(x))) continue;   // mining hulls handled above
        if ((s.cargo?.capacity || 0) < 20) continue;             // must actually carry ore
        members.set(s.symbol, { role: 'MINEHAUL', mineSys: sys });
        launchWorker(s.symbol);
        haulN[sys]++;
        log(`⛏ adopted ${id(s.symbol)} → MINEHAUL @${sys.slice(-4)} (ore-ferry; ${haulN[sys]}/${MINE_HAULERS_PER})`);
      }
    }
  }

  // [HUB ADOPTION] The hub (target.sys) — unlike outposts — has no pass-1 "adopt in-system idle probes" step; selectMembers
  // only claims MAX_PROBES at trigger time, so probes that ARRIVE at the hub later (e.g. migrated/redistributed) sit idle.
  // This adopts free idle probes already AT the hub as PROBE-role scanners (zero migration), up to 1:1 with hub markets+yards.
  async function adoptHubProbes(fleet) {
    if (!target || !target.sys || !tgtMarketWps.length || recallActive()) return;
    let all = fleet; if (!all) { try { all = await getAllShips(); } catch { return; } }
    let have = 0; for (const [, m] of members) if (m.role === 'PROBE') have++;
    const want = tgtMarketWps.length;
    if (have >= want) return;
    let neg = null; try { neg = typeof negotiator === 'function' ? negotiator() : null; } catch {}
    for (const s of all) {
      if (have >= want) break;
      if (members.has(s.symbol)) continue;
      if (s.frame?.symbol !== 'FRAME_PROBE') continue;
      if (s.nav.status === 'IN_TRANSIT') continue;
      if (s.nav.systemSymbol !== target.sys) continue;        // only probes already at the hub → zero migration
      if (neg && (s.symbol === neg || s.symbol.endsWith('-' + neg))) continue;
      members.set(s.symbol, { role: 'PROBE', scanned: new Set() });
      launchWorker(s.symbol);
      have++;
      log(`🛰 adopted ${id(s.symbol)} → PROBE @${target.sys.slice(-4)} (hub coverage ${have}/${want})`);
    }
  }

  async function maybeTrigger() {
    if (!AUTO) return;
    if (triggered) {
      checkRecallRelease();
      if (OUTPOSTS.length && !outpostsReady) await setupOutposts();
      await resolvePending();
      // [PERF] One fleet snapshot shared by adoptMiners + adoptHubProbes + autoBuy. Previously each call did its own
      // getAllShips() (3 paginated reads/tick); under 100+ ship API contention that starved the 2 req/s limit and the
      // expansion tick stalled (autoBuy entered but never finished). Sharing one read keeps the tick fast + responsive.
      let fleet = null; try { fleet = await getAllShips(); } catch {}
      await adoptMiners(fleet);
      await adoptHubProbes(fleet);
      await autoBuy(fleet);
      return;
    }
    if (!gateBuilt()) return;
    // resolve the target gate from the home gate's connections
    let conns = [];
    try { conns = (await api('GET', `/systems/${homeSystem}/waypoints/${gateWp()}/jump-gate`)).data?.connections || []; }
    catch (e) { if (!triggerLogged) { log(`🪐 jump-gate read ERR ${e.message} — will retry`); triggerLogged = true; } return; }
    if (!conns.length) { if (!triggerLogged) { log('🪐 gate has no connections yet — will retry'); triggerLogged = true; } return; }
    const gw = WANT_TARGET ? conns.find((c) => sysOf(c) === WANT_TARGET) : conns[0];
    if (!gw) { log(`🪐 EXPAND_TARGET_SYSTEM=${WANT_TARGET} not among connections [${conns.map(sysOf).join(', ')}] — using first`); }
    target = { gateWp: gw || conns[0], sys: sysOf(gw || conns[0]) };
    if (!(await selectMembers())) { log('🪐 no eligible ships to migrate — will retry'); return; }
    await loadTargetSystem(target.sys);
    // probes aren't in the home `traders` pool → give them supervised workers; haulers/light already have workers.
    for (const [sym, m] of members) if (m.role === 'PROBE') launchWorker(sym);
    triggered = true;
    const roles = [...members].map(([s, m]) => `${s.slice(-3)}:${m.role}`).join(' ');
    log(`🪐🚀 AUTO-EXPAND TRIGGERED → ${target.sys} (gate ${gw ? gw.slice(-3) : '?'}). Migrating: ${roles}. Floor=${FLOOR.toLocaleString()} antimatter~${antimatterPx}.`);
    await setupOutposts();
  }

  function statusBlock() {
    return {
      enabled: AUTO, triggered,
      target: target ? target.sys : (WANT_TARGET || 'auto'),
      floor: FLOOR, antimatterPx,
      members: [...members].map(([s, m]) => ({ ship: s.slice(-3), role: m.role, opSys: m.opSys, scanned: m.scanned ? m.scanned.size : undefined, last: m.last })),
      targetMarketsScanned: Object.keys(tgtMarkets).length, targetMarkets: tgtMarketWps.length,
      outposts: [...outposts.values()].map((o) => ({ sys: o.sys, gate: o.gateWp ? id(o.gateWp) : '?', markets: o.marketWps.length, scanned: Object.keys(o.markets).length })),
      autobuy: { enabled: AUTOBUY, floor: BUY_FLOOR, boughtProbes, boughtTraders, capProbes: MAX_BUY_PROBES, capTraders: MAX_BUY_TRADERS },
      recall: RECALL ? { active: recallActive(), released: recallReleased, releaseAt: RECALL_RELEASE || null } : undefined,
      mine: MINE_SYSTEMS.length ? {
        systems: MINE_SYSTEMS, want: { surveyors: MINE_SURVEYORS_PER, haulers: MINE_HAULERS_PER, drones: MINE_DRONES_PER }, boughtMineShips: boughtDrones, capMineShips: MAX_BUY_DRONES,
        colonies: MINE_SYSTEMS.map((sys) => {
          const crew = [...members].filter(([, m]) => m.mineSys === sys);
          const c = mineColony.get(sys);
          return { sys: sys.slice(-4), asteroid: c && c.asteroid ? id(c.asteroid) : '?', surveys: c ? (c.surveys || []).length : 0,
            surveyors: crew.filter(([, m]) => m.role === 'MINESURVEY').length, haulers: crew.filter(([, m]) => m.role === 'MINEHAUL').length, drones: crew.filter(([, m]) => m.role === 'MINEDRONE').length,
            ships: crew.map(([s, m]) => ({ ship: s.slice(-3), role: m.role.replace('MINE', ''), last: m.last })) };
        }),
      } : undefined,
    };
  }

  return { isMember, step, maybeTrigger, statusBlock, get triggered() { return triggered; } };
}
