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
  const SCAN_TTL_MS = Number(process.env.EXPAND_SCAN_TTL_MS || 120_000);
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
  const OUTPOST_TRADERS = Number(process.env.EXPAND_OUTPOST_TRADERS || 1);      // local traders per outpost
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
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE')) wps.push(w.symbol);
      }
      if (batch.length < 20) break;
    }
    tgtMarketWps = wps;
    tgtLoaded = true;
    log(`🪐 target system ${sys} mapped: ${wps.length} markets, gate ${id(target.gateWp)}`);
  }

  // scan a single target market (presence required for live prices; probes provide it as they roam)
  async function scanMarket(wp) {
    try { const m = (await api('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data; tgtMarkets[wp] = { ...m, at: now() }; return m; }
    catch { return null; }
  }
  async function scanAllTargets() {
    for (const wp of tgtMarketWps) { if (!tgtMarkets[wp] || now() - tgtMarkets[wp].at > SCAN_TTL_MS) await scanMarket(wp); }
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
        if ((w.traits || []).some((t) => t.symbol === 'MARKETPLACE')) wps.push(w.symbol);
        if (w.type === 'JUMP_GATE' && !op.gateWp) op.gateWp = w.symbol;
      }
      if (batch.length < 20) break;
    }
    op.marketWps = wps;
    op.loaded = true;
    log(`🛰 outpost ${op.sys} mapped: ${wps.length} markets, gate ${op.gateWp ? id(op.gateWp) : '?'}`);
  }
  async function scanMarketInto(wp, op) {
    try {
      const m = (await api('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
      if (m.tradeGoods || !op.markets[wp]) op.markets[wp] = { ...m, at: now() };  // never clobber priced data with a priceless far-scan
      return m;
    } catch { return null; }
  }
  async function scanAllInto(op) {
    for (const wp of op.marketWps) { if (!op.markets[wp] || now() - op.markets[wp].at > SCAN_TTL_MS) await scanMarketInto(wp, op); }
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
    const todo = tgtMarketWps.filter((w) => !tgtMarkets[w] || now() - tgtMarkets[w].at > SCAN_TTL_MS);
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

  // drive one outpost member: 2-hop migrate (home→PP48→outer) then trade/scan PURELY LOCAL in the outer system.
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
        const stale = arc.filter((w) => !op.markets[w] || now() - op.markets[w].at > SCAN_TTL_MS);
        if (!stale.length) { await sleep(PROBE_DWELL_MS); m.last = `1:1 ${op.sys.slice(-4)} arc[${arc.length}] fresh`; return; }
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
        const todo = op.marketWps.filter((w) => !op.markets[w] || now() - op.markets[w].at > SCAN_TTL_MS);
        if (todo.length) { const here = ship.nav.waypointSymbol; todo.sort((a, b) => D(here, a) - D(here, b)); try { await goToSys(sym, todo[0], op.markets); await scanMarketInto(todo[0], op); } catch {} m.last = `scanning ${op.sys.slice(-4)} (no lane)`; return; }
        m.last = `parked ${op.sys.slice(-4)} (no lane)`; await sleep(SLEEP_MS); return;
      }
      await runLane(sym, ship, lane, op.markets, op.markets, null);
      return;
    }

    // ---- migration: home → PP48 (hop 1), then PP48 → outpost (hop 2) ----
    if (!hubGate) { m.last = 'await hub'; await sleep(SLEEP_MS); return; }
    if (cur === homeSystem) { m.last = `migrating → ${hubSys} (hop1)`; await jumpVia(sym, ship, gateWp(), hubGate, homeMarkets()); return; }
    if (cur === hubSys) {
      if (!op.gateWp) { await loadSystemInto(op); }     // need the outpost gate wp before hop 2
      if (!op.gateWp) { m.last = 'await outpost gate'; await sleep(SLEEP_MS); return; }
      m.last = `migrating → ${op.sys} (hop2)`;
      await jumpVia(sym, ship, hubGate, op.gateWp, tgtMarkets); return;
    }
    m.last = `stray in ${cur}`; await sleep(SLEEP_MS);   // unexpected system → park (recoverable)
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
    const hubGate = target ? target.gateWp : null, hubSys = target ? target.sys : null;
    const cur = sysOf(ship.nav.waypointSymbol);
    const m = members.get(sym);
    if (!hubGate || !op || !op.gateWp) { m.last = `await route → ${sys.slice(-4)}`; await sleep(SLEEP_MS); return; }
    if (cur === homeSystem) { m.last = `migrating → ${hubSys.slice(-4)} (hop1)`; await jumpVia(sym, ship, gateWp(), hubGate, homeMarkets()); return; }
    if (cur === hubSys) { m.last = `migrating → ${sys.slice(-4)} (hop2)`; await jumpVia(sym, ship, hubGate, op.gateWp, tgtMarkets); return; }
    m.last = `stray ${cur.slice(-4)}`; await sleep(SLEEP_MS);
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

    // HAULER: explicit, else largest-cargo non-probe with fuel>=400 (can clear the long gate legs)
    let haulers;
    if (EXPLICIT_HAULERS.size) haulers = all.filter((s) => byId(EXPLICIT_HAULERS, s) && !isNeg(s));
    else { const cand = all.filter((s) => !isProbe(s) && !isNeg(s) && s.cargo.capacity >= 40 && s.fuel.capacity >= 400).sort((a, b) => (b.fuel.capacity - a.fuel.capacity) || (b.cargo.capacity - a.cargo.capacity)); haulers = cand.slice(0, 1); }
    const haulerSet = new Set(haulers.map((s) => s.symbol));

    // LIGHT: explicit, else a smaller non-probe hull not already chosen as hauler
    let light;
    if (EXPLICIT_LIGHT.size) light = all.filter((s) => byId(EXPLICIT_LIGHT, s) && !isNeg(s));
    else { const cand = all.filter((s) => !isProbe(s) && !isNeg(s) && !haulerSet.has(s.symbol) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200).sort((a, b) => a.cargo.capacity - b.cargo.capacity); light = cand.slice(0, 1); }
    const lightSet = new Set(light.map((s) => s.symbol));

    // PROBES: explicit, else up to MAX_PROBES idle probes — never the negotiator (it must stay home to negotiate)
    let probes;
    if (EXPLICIT_PROBES.size) probes = all.filter((s) => byId(EXPLICIT_PROBES, s) && !isNeg(s));
    else probes = all.filter((s) => isProbe(s) && !isNeg(s)).slice(0, MAX_PROBES);

    for (const s of haulers) members.set(s.symbol, { role: 'HAULER' });
    for (const s of light) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'LIGHT' });
    for (const s of probes) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'PROBE', scanned: new Set() });
    return members.size > 0;
  }

  // assign small resident crews to each configured outer system (drawn from idle ships not used by the hub).
  // Position-aware: a free ship ALREADY in an outpost system resumes that outpost (restart-safe, no reshuffle);
  // remaining slots fill from idle ships at home/hub.
  async function setupOutposts() {
    if (!OUTPOSTS.length || outpostsReady) return;
    let conns = [];
    try { conns = (await api('GET', `/systems/${target.sys}/waypoints/${target.gateWp}/jump-gate`)).data?.connections || []; }
    catch (e) { log(`🛰 outpost gate read ERR ${e.message} — will retry`); return; }
    if (!conns.length) { log('🛰 hub gate has no connections yet — will retry outposts'); return; }
    let all;
    try { all = await getAllShips(); } catch (e) { log(`🛰 outpost fleet read ERR ${e.message}`); return; }
    const isProbe = (s) => s.frame?.symbol === 'FRAME_PROBE';
    const reserved = new Set();
    for (const k of ['GATE_HAULERS', 'INPUT_FEEDERS', 'MINE_TRANSPORT', 'MINE_FUNNEL', 'MINE_BATCH', 'CONTRACT_RUNNER', 'NEGOTIATOR', 'CONTRACT_NEGOTIATOR', 'EXPAND_HAULERS', 'EXPAND_LIGHT', 'EXPAND_PROBES'])
      for (const t of listEnv(k)) reserved.add(t);
    // also reserve the resolved contract negotiator (its bot2 DEFAULT isn't visible via env) — never poach it,
    // or contracts stall with "ship not docked" errors. Passed from bot2 ctx as negotiator().
    try { const neg = typeof negotiator === 'function' ? negotiator() : null; if (neg) reserved.add(neg); } catch {}
    const isReserved = (s) => [...reserved].some((t) => s.symbol === t || s.symbol.endsWith('-' + t));  // never poach a home-role ship
    const free = (s) => !members.has(s.symbol) && !isReserved(s);
    const isTrader = (s) => !isProbe(s) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200 && !/MINING_LASER|SURVEYOR/.test(JSON.stringify(s.mounts || []));
    const assign = (s, sys) => { const role = isProbe(s) ? 'OUTPROBE' : 'OUTLIGHT'; members.set(s.symbol, role === 'OUTPROBE' ? { role, opSys: sys, scanned: new Set() } : { role, opSys: sys }); launchWorker(s.symbol); return s.symbol.slice(-3) + (isProbe(s) ? ':P' : ':T'); };

    for (const sys of OUTPOSTS) {
      const gw = conns.find((c) => sysOf(c) === sys);
      if (!gw) { log(`🛰 outpost ${sys} not among hub connections [${conns.map(sysOf).join(', ')}] — skip`); continue; }
      outposts.set(sys, { sys, gateWp: gw, markets: {}, marketWps: [], loaded: false });
    }
    // Per-outpost probe target = 1:1 with markets (fresh data on every market); fall back to OUTPOST_PROBES until
    // the system's markets are mapped so pass-2 never over-pulls blindly.
    const probeTgt = (sys) => { const op = outposts.get(sys); const m = (op && op.marketWps.length) || 0; return m > 0 ? m : OUTPOST_PROBES; };
    // pass 1 — adopt ALL ships already sitting in an outpost system (local residents = zero migration: this is where
    // manually/locally-bought probes & haulers get put to work immediately, converging the system toward 1:1).
    const crews = {}; const probeCnt = {}, traderCnt = {};
    for (const sys of outposts.keys()) { crews[sys] = []; probeCnt[sys] = 0; traderCnt[sys] = 0; }
    for (const s of all) {
      if (!free(s)) continue; const sys = s.nav.systemSymbol;
      if (!outposts.has(sys)) continue;
      if (isProbe(s)) { crews[sys].push(assign(s, sys)); probeCnt[sys]++; }
      else if (isTrader(s)) { crews[sys].push(assign(s, sys)); traderCnt[sys]++; }
    }
    // pass 2 — fill the SHORTFALL from idle ships elsewhere. Probes: pull toward 1:1 but ONLY from non-home idle
    // probes (never strip the home system's market scanners); surplus hub probes flow to probe-starved outposts.
    // Traders: pull toward OUTPOST_TRADERS from any idle trader (home haulers ARE allowed to migrate out to fat lanes).
    const idleProbes = all.filter((s) => isProbe(s) && free(s) && s.nav.systemSymbol !== homeSystem);
    const idleTraders = all.filter((s) => isTrader(s) && free(s)).sort((a, b) => a.cargo.capacity - b.cargo.capacity);
    let pi = 0, ti = 0;
    for (const sys of outposts.keys()) {
      const ptgt = probeTgt(sys);
      while (traderCnt[sys] < OUTPOST_TRADERS && ti < idleTraders.length) { crews[sys].push(assign(idleTraders[ti++], sys)); traderCnt[sys]++; }
      while (probeCnt[sys] < ptgt && pi < idleProbes.length) { crews[sys].push(assign(idleProbes[pi++], sys)); probeCnt[sys]++; }
      const op = outposts.get(sys);
      log(`🛰 OUTPOST ${sys} (gate ${id(op.gateWp)}) crew[P${probeCnt[sys]}/${ptgt} T${traderCnt[sys]}/${OUTPOST_TRADERS}]: ${crews[sys].join(' ') || 'NONE (no idle ships)'}`);
    }
    outpostsReady = true;
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
    try { await goToSys(cand.symbol, yard, outposts.get(sys)?.markets || {}); log(`🛒 anchoring ${id(cand.symbol)} → ${id(yard)} (so local ${type.replace('SHIP_', '')} buys work)`); } catch {}
    return true;
  }

  async function autoBuy() {
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
    if (!recallActive()) for (const sys of outposts.keys()) { const op = outposts.get(sys); staffSystems.push({ sys, markets: op.marketWps.length || 0, gateWp: op.gateWp, hub: false }); }   // [RECALL] hub-only buys while concentrating

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
    try { allShips = await getAllShips(); shipWps = new Set(allShips.filter((s) => s.nav.status !== 'IN_TRANSIT').map((s) => s.nav.waypointSymbol)); }
    catch (e) { lastBuyAt = now(); log(`🛒 AUTOBUY fleet read ERR ${e.message}`); return; }

    // decide ONE action. PRIORITY: (1) build the mine colonies (renewable, non-diluting scaling lever), then
    // (2) trader-starved systems (arbitrage earners), then (3) probe coverage. Buy LOCAL when possible.
    let action = null;
    // 1) [MINE COLONY] staff each colony: surveyor (yield) → haulers (park-and-ferry) → drones (scale extraction).
    //    Mining hulls are sold ONLY at the colony's own shipyard (home can't), so always buy local (anchor if needed).
    if (boughtDrones < MAX_BUY_DRONES) {
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
          } else if (await anchorBuy(rs.type, sys, allShips)) { lastBuyAt = now(); return; }   // dispatch anchor, buy next window
        }
      }
    }
    // 2) trader-starved system
    if (!action && boughtTraders < MAX_BUY_TRADERS) {
      const starved = staffSystems.find((ss) => traderN[ss.sys] < OUTPOST_TRADERS);
      if (starved) {
        for (const t of TRADER_PREF) {                          // best hull first
          const loc = await pickBuy(t, [starved.sys, homeSystem], shipWps);
          if (!loc) continue;
          const px = loc.price || 320_000;
          if (MAX_TRADER_PRICE > 0 && loc.price && loc.price > MAX_TRADER_PRICE) continue;   // too pricey → try next hull / wait
          if (credits - px >= BUY_FLOOR) { action = { kind: 'trader', role: starved.hub ? 'LIGHT' : 'OUTLIGHT', type: t, wp: loc.wp, price: px, sys: starved.sys, local: loc.local }; break; }
        }
      }
    }
    if (!action && boughtProbes < MAX_BUY_PROBES) {
      let worst = null, worstGap = 0;
      for (const ss of staffSystems) {
        if (!ss.markets) continue;                              // unmapped — don't buy probes blind
        const tgt = PROBE_TARGET_CAP > 0 ? Math.min(ss.markets, PROBE_TARGET_CAP) : ss.markets;
        const gap = tgt - probeN[ss.sys];
        if (gap > worstGap) { worstGap = gap; worst = ss; }
      }
      if (worst) {
        const loc = await pickBuy('SHIP_PROBE', [worst.sys, homeSystem], shipWps);
        const price = loc ? (loc.price || 26_000) : 0;
        const tooPricey = loc && MAX_PROBE_PRICE > 0 && loc.price && loc.price > MAX_PROBE_PRICE;
        if (tooPricey) log(`🛒 AUTOBUY probe @${id(loc.wp)} ${loc.price.toLocaleString()} > cap ${MAX_PROBE_PRICE.toLocaleString()} — waiting for cheaper`);
        if (loc && !tooPricey && credits - price >= BUY_FLOOR) action = { kind: 'probe', role: worst.hub ? 'PROBE' : 'OUTPROBE', type: 'SHIP_PROBE', wp: loc.wp, price, sys: worst.sys, local: loc.local };
        else if ((!loc || tooPricey) && !worst.hub && worst.sys !== homeSystem) {
          // home is blocked (no local sink / above ceiling) → anchor a ship at the outpost's own probe-selling yard for cheap local buys
          if (await anchorBuy('SHIP_PROBE', worst.sys, allShips)) { lastBuyAt = now(); return; }
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
    if (action.kind === 'trader') { boughtTraders++; log(`🛒 AUTOBUY trader ${action.type} ${id(bought)} @${id(action.wp)} (~${action.price.toLocaleString()}) → ${action.sys} [${where}; traders ${traderN[action.sys]}→${traderN[action.sys] + 1}/${OUTPOST_TRADERS}, bought ${boughtTraders}/${MAX_BUY_TRADERS}]`); }
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
  async function adoptMiners() {
    if (!MINE_SYSTEMS.length) return;
    let all; try { all = await getAllShips(); } catch { return; }
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
  }

  async function maybeTrigger() {
    if (!AUTO) return;
    if (triggered) { checkRecallRelease(); if (OUTPOSTS.length && !outpostsReady) await setupOutposts(); await adoptMiners(); await autoBuy(); return; }
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
