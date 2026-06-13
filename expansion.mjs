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
    navigate, refuel, buy, sell, jump, getShip, getAllShips,
    coords, D, chooseMode, planRoute, record,
    homeSystem, gateWp, gateBuilt, getCredits, reserve, homeMarkets, launchWorker,
    fuelPx,
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
    for (const hop of path) { ship = await getShip(sym); await navigate(sym, hop, chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode); }
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

  // -------------------------------- public API --------------------------------
  async function step(sym, ship) {
    const m = members.get(sym);
    try {
      if (m.role === 'PROBE') await stepProbe(sym, ship);
      else if (m.role === 'LIGHT') await stepLight(sym, ship);
      else await stepHauler(sym, ship);
    } catch (e) { log(`🪐 ${id(sym)} expand step ERR ${e.message} — parking`); await sleep(SLEEP_MS); }
  }

  async function selectMembers() {
    let all;
    try { all = await getAllShips(); } catch (e) { log(`🪐 fleet read ERR ${e.message}`); return false; }
    const isProbe = (s) => s.frame?.symbol === 'FRAME_PROBE';
    const byId = (set, s) => { for (const t of set) if (s.symbol === t || s.symbol.endsWith('-' + t)) return true; return false; };

    // HAULER: explicit, else largest-cargo non-probe with fuel>=400 (can clear the long gate legs)
    let haulers;
    if (EXPLICIT_HAULERS.size) haulers = all.filter((s) => byId(EXPLICIT_HAULERS, s));
    else { const cand = all.filter((s) => !isProbe(s) && s.cargo.capacity >= 40 && s.fuel.capacity >= 400).sort((a, b) => (b.fuel.capacity - a.fuel.capacity) || (b.cargo.capacity - a.cargo.capacity)); haulers = cand.slice(0, 1); }
    const haulerSet = new Set(haulers.map((s) => s.symbol));

    // LIGHT: explicit, else a smaller non-probe hull not already chosen as hauler
    let light;
    if (EXPLICIT_LIGHT.size) light = all.filter((s) => byId(EXPLICIT_LIGHT, s));
    else { const cand = all.filter((s) => !isProbe(s) && !haulerSet.has(s.symbol) && s.cargo.capacity >= 20 && s.fuel.capacity >= 200).sort((a, b) => a.cargo.capacity - b.cargo.capacity); light = cand.slice(0, 1); }
    const lightSet = new Set(light.map((s) => s.symbol));

    // PROBES: explicit, else up to MAX_PROBES idle probes
    let probes;
    if (EXPLICIT_PROBES.size) probes = all.filter((s) => byId(EXPLICIT_PROBES, s));
    else probes = all.filter(isProbe).slice(0, MAX_PROBES);

    for (const s of haulers) members.set(s.symbol, { role: 'HAULER' });
    for (const s of light) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'LIGHT' });
    for (const s of probes) if (!members.has(s.symbol)) members.set(s.symbol, { role: 'PROBE', scanned: new Set() });
    return members.size > 0;
  }

  async function maybeTrigger() {
    if (!AUTO || triggered) return;
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
  }

  function statusBlock() {
    return {
      enabled: AUTO, triggered,
      target: target ? target.sys : (WANT_TARGET || 'auto'),
      floor: FLOOR, antimatterPx,
      members: [...members].map(([s, m]) => ({ ship: s.slice(-3), role: m.role, scanned: m.scanned ? m.scanned.size : undefined, last: m.last })),
      targetMarketsScanned: Object.keys(tgtMarkets).length, targetMarkets: tgtMarketWps.length,
    };
  }

  return { isMember, step, maybeTrigger, statusBlock, get triggered() { return triggered; } };
}
