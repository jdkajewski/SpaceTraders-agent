// ============================================================================
//  expand.mjs  —  TEMPORARY growth/expansion advisor (bootstrap state machine)
//  Implements the cell-based franchise logic from EXPANSION-DESIGN.md as a
//  standalone decision engine, until v2 productionizes it.
//
//  Assesses current state → reports the current PHASE and the single best
//  capital action (scout / contract-fund / buy hull / save-for-gate / expand),
//  with the ROI math. Advisory by default.
//
//    node expand.mjs                 # dry-run: phase + recommended action + ROI
//    node expand.mjs --execute --max-spend 120000
//                                    # also performs the SAFE recommended buy
//                                    #   (probe+deploy, or a hull) within the cap
//
//  Trading itself is handled by bot2.mjs; this only makes GROWTH decisions.
// ============================================================================
import { api, getAllShips, getAllContracts } from './st.mjs';
import fs from 'node:fs';

const SYSTEM = process.env.SYSTEM || 'X1-PP30';
const MAXD = 200, FUEL_PX = 0.72, MIN_NET = 2000;   // FUEL_PX: cr per fuel unit (72/100-unit lot), was 72 (100× high)
const here = (p) => new URL(p, import.meta.url);
const EXECUTE = process.argv.includes('--execute');
const MAX_SPEND = Number((process.argv[process.argv.indexOf('--max-spend') + 1]) || 0);

// growth tuning
const VISIBILITY_TARGET = 0.6;      // fraction of system markets that should have a probe
const HAULER_CASH_FLOOR = 314_345;  // don't buy a hauler below this safety cash
const BUY_PAYBACK_MAX_H = 2.5;      // buy a cargo hull only if it pays back within this
const GATE_MATERIALS = { FAB_MATS: 1600, ADVANCED_CIRCUITRY: 400 };
// [E] Probe cap. Probes feed prices; beyond ~one per market they're dead capital (the fleet
// drifted to 27). Cap total probes and redirect surplus scout spend toward the gate fund.
const MAX_PROBES = Number(process.env.MAX_PROBES || 12);
// [F] Autonomous gate-supply guards: keep at least this much cash while feeding the gate
// (construction supply pays $0), and optionally pin a dedicated hull.
const GATE_CREDIT_FLOOR = Number(process.env.GATE_CREDIT_FLOOR || 1_500_000);
const GATE_HAULER = process.env.GATE_HAULER || '';   // pin a specific hull, else pick largest idle
// observed role economics (credits/hour at unsaturated lanes) — refine from DB later
const NET_PER_HR = { SHIP_LIGHT_HAULER: 180_000, SHIP_LIGHT_SHUTTLE: 95_000 };

const coords = {};
for (const l of fs.readFileSync(here('./coords.csv'), 'utf8').trim().split('\n').slice(1)) {
  const [w, x, y] = l.split(','); coords[w] = [+x, +y];
}
const D = (a, b) => (coords[a] && coords[b] ? Math.round(Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1])) : 1e9);

async function shipyards() {
  // find shipyard waypoints + their offerings/prices
  const wps = (await api('GET', `/systems/${SYSTEM}/waypoints?limit=20&traits=SHIPYARD`)).data;
  const out = {};
  for (const w of wps) {
    try {
      const sy = (await api('GET', `/systems/${SYSTEM}/waypoints/${w.symbol}/shipyard`)).data;
      for (const s of sy.ships || []) out[s.type] = { wp: w.symbol, price: s.purchasePrice, cargo: s.cargo?.capacity, speed: s.engine?.speed };
      for (const t of sy.shipTypes || []) if (!out[t.type]) out[t.type] = { wp: w.symbol, price: null };
    } catch {}
  }
  return out;
}

function buildLanes(markets) {
  const goods = {};
  for (const [wp, m] of Object.entries(markets)) for (const g of m.tradeGoods || []) (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  const best = {};
  for (const [sym, entries] of Object.entries(goods)) for (const b of entries) for (const s of entries) {
    if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
    const dist = D(b.wp, s.wp); if (dist > MAXD) continue;
    const units = Math.min(Math.min(b.tradeVolume, s.tradeVolume), 20);
    const gross = (s.sellPrice - b.purchasePrice) * units;
    if (gross < MIN_NET) continue;
    if (!best[sym] || gross > best[sym].gross) best[sym] = { sym, gross };
  }
  return Object.values(best);
}

async function gateStatus() {
  let gateWp;
  try { const gs = (await api('GET', `/systems/${SYSTEM}/waypoints?limit=20&type=JUMP_GATE`)).data; gateWp = gs[0]?.symbol; } catch {}
  if (!gateWp) return { exists: false };
  let built = false, remaining = {}, known = false;
  try {
    const cs = (await api('GET', `/systems/${SYSTEM}/waypoints/${gateWp}/construction`)).data;
    built = cs.isComplete; known = true;
    for (const m of cs.materials || []) { const need = m.required - m.fulfilled; if (need > 0) remaining[m.tradeSymbol] = need; }
  } catch { built = false; known = false; }   // [A] fail-SAFE: unknown ≠ built
  return { exists: true, wp: gateWp, built, remaining, known };
}

function cheapestMarket(markets, sym) {
  let wp, px = Infinity;
  for (const [w, m] of Object.entries(markets)) { const g = (m.tradeGoods || []).find((x) => x.symbol === sym); if (g && g.purchasePrice > 0 && g.purchasePrice < px) { px = g.purchasePrice; wp = w; } }
  return wp ? { wp, px } : null;
}

async function assess() {
  const agent = (await api('GET', '/my/agent')).data;
  const ships = await getAllShips();
  const contracts = await getAllContracts();
  const markets = JSON.parse(fs.readFileSync(here('./markets.json')));
  const allWps = (await api('GET', `/systems/${SYSTEM}/waypoints?limit=20&traits=MARKETPLACE`)).data.map((w) => w.symbol);

  const probes = ships.filter((s) => s.frame.symbol === 'FRAME_PROBE');
  const cargo = ships.filter((s) => s.cargo.capacity > 0 && s.frame.symbol !== 'FRAME_PROBE');
  const commander = ships.find((s) => s.frame.symbol === 'FRAME_FRIGATE');
  const visibleMarkets = new Set(probes.map((p) => p.nav.waypointSymbol));
  const visibility = allWps.length ? [...visibleMarkets].filter((w) => allWps.includes(w)).length / allWps.length : 0;
  const lanes = buildLanes(markets);
  const idleCargo = cargo.filter((s) => s.nav.status !== 'IN_TRANSIT').length;
  const activeContract = contracts.find((c) => c.accepted && !c.fulfilled);
  const unvisited = allWps.filter((w) => !visibleMarkets.has(w));
  const gate = await gateStatus();

  return { agent, ships, probes, cargo, commander, markets, allWps, visibility, lanes, idleCargo, activeContract, unvisited, gate };
}

function decidePhase(s) {
  if (s.visibility < VISIBILITY_TARGET && s.unvisited.length) return 'SCOUT';
  if (s.agent.credits < HAULER_CASH_FLOOR && s.cargo.length <= 2) return 'CONTRACT-FUND';
  if (s.lanes.length > s.cargo.length) return 'TRADE-SCALE';   // unassigned profitable lanes remain
  // lanes saturated → if a gate is unbuilt, building/funding it is the path to widen
  if (s.gate?.exists && !s.gate.built && Object.keys(s.gate.remaining).length) return 'BUILD-GATE';
  return 'STEADY/EXPORT';
}

function paybackHours(cost, role) { const r = NET_PER_HR[role] || 80_000; return cost / r; }

async function recommend(s, yard) {
  const phase = decidePhase(s);
  const recs = [];

  // information ROI: a probe enabling a new market — but only up to the probe cap. Beyond it,
  // extra probes are dead capital (no off-ship storage, prices already fed), so redirect to gate.
  const probeCap = Math.min(MAX_PROBES, s.allWps.length || MAX_PROBES);
  if (yard.SHIP_PROBE?.price && s.unvisited.length && s.probes.length < probeCap) {
    recs.push({ action: 'BUY_PROBE', why: `scout ${s.unvisited.length} unseen markets (info ROI ~1-2 lanes); ${s.probes.length}/${probeCap} probes`, cost: yard.SHIP_PROBE.price, at: yard.SHIP_PROBE.wp, deployTo: s.unvisited[0], priority: phase === 'SCOUT' ? 100 : 40 });
  } else if (s.probes.length >= probeCap && s.gate?.exists && !s.gate.built) {
    recs.push({ action: 'REDIRECT_TO_GATE', why: `probe cap reached (${s.probes.length} ≥ ${probeCap}) — stop buying scouts; redirect that capital to the gate fund`, cost: 0, priority: 50 });
  }
  // throughput: cargo hull if lanes remain unassigned
  if (s.lanes.length > s.cargo.length) {
    const hauler = yard.SHIP_LIGHT_HAULER, shuttle = yard.SHIP_LIGHT_SHUTTLE;
    if (shuttle?.price) recs.push({ action: 'BUY_SHUTTLE', why: `${s.lanes.length} lanes > ${s.cargo.length} hulls; payback ${paybackHours(shuttle.price, 'SHIP_LIGHT_SHUTTLE').toFixed(1)}h`, cost: shuttle.price, at: shuttle.wp, priority: phase === 'TRADE-SCALE' ? 80 : 30, payback: paybackHours(shuttle.price, 'SHIP_LIGHT_SHUTTLE') });
    if (hauler?.price && s.agent.credits > HAULER_CASH_FLOOR * 1.5) recs.push({ action: 'BUY_HAULER', why: `payback ${paybackHours(hauler.price, 'SHIP_LIGHT_HAULER').toFixed(1)}h`, cost: hauler.price, at: hauler.wp, priority: phase === 'TRADE-SCALE' ? 70 : 25, payback: paybackHours(hauler.price, 'SHIP_LIGHT_HAULER') });
  }
  // saturated → save for gate / expand
  if (phase === 'STEADY/EXPORT') {
    recs.push({ action: 'SAVE_FOR_GATE', why: `lanes saturated (${s.lanes.length} lanes ≤ ${s.cargo.length} hulls); accumulate for gate ${JSON.stringify(GATE_MATERIALS)} then expand`, cost: 0, priority: 60 });
  }
  // saturated → build/fund the gate to unlock widening, else save & expand
  if (phase === 'BUILD-GATE') {
    let estCost = 0, totalUnits = 0; const lines = [];
    for (const [sym, need] of Object.entries(s.gate.remaining)) {
      const src = cheapestMarket(s.markets, sym);
      const c = src ? need * src.px : null; if (c) estCost += c;
      totalUnits += need;
      lines.push(`${need}× ${sym}${src ? ` @${src.wp.slice(-3)} ~${src.px} = ${(need * src.px).toLocaleString()}` : ' (no market!)'}`);
    }
    recs.push({ action: 'SUPPLY_GATE', why: `gate ${s.gate.wp.slice(-3)} needs: ${lines.join('; ')} | est materials ${estCost.toLocaleString()} (slippage will raise this)`, cost: 0, priority: 90, gate: s.gate });

    // DEDICATED GATE-HAULER: diverting a laned ship to the (far) gate run forfeits its
    // trade throughput. If that opportunity cost over the haul exceeds a hauler's price,
    // buy dedicated hull(s) instead of stealing trade capacity.
    const loads = Math.ceil(totalUnits / 80);
    const gateDist = D(cheapestMarket(s.markets, Object.keys(s.gate.remaining)[0])?.wp || 'X1-PP30-F51', s.gate.wp);
    const rtMin = 2 * (Math.round(gateDist * 25 / 15) + 60) / 60;   // CRUISE round-trip minutes/load (spd15)
    const haulHours = loads * rtMin / 60;
    const TRADE_NET_PER_HR = 250_000;                                // conservative per-ship trade rate
    const oppCost = Math.round(haulHours * TRADE_NET_PER_HR);
    const haulerCost = yard.SHIP_LIGHT_HAULER?.price || 314_345;
    if (oppCost > haulerCost) {
      const nShips = Math.min(3, Math.max(1, Math.round(haulHours / 4)));  // parallelize toward ~4h
      recs.push({ action: 'BUY_GATE_HAULER', why: `${loads} loads ≈ ${haulHours.toFixed(1)}h hauling; diverting a trader forfeits ~${oppCost.toLocaleString()} > hauler ${haulerCost.toLocaleString()}. Buy ${nShips} dedicated hauler(s) (and use the spd36 frigate for the far leg) to keep laned ships trading.`, cost: haulerCost * nShips, at: yard.SHIP_LIGHT_HAULER?.wp, priority: 95 });
    }
  }
  if (phase === 'STEADY/EXPORT') {
    recs.push({ action: s.gate?.built ? 'EXPAND' : 'SAVE_FOR_GATE', why: s.gate?.built ? `gate ${s.gate.wp?.slice(-3)} OPERATIONAL → seed a new-system cell (jump scout+hauler, scout-first)` : `accumulate capital toward gate build`, cost: 0, priority: 60 });
  }
  recs.sort((a, b) => b.priority - a.priority);
  return { phase, recs };
}

// One supply trip: load a freighter with the neediest material from its cheapest market
// and deliver it to the gate construction site. Repeat manually until remaining = 0.
async function supplyGateTrip(s) {
  const g = s.gate;
  if (!g?.exists || g.built) { console.error('gate already built or none'); return; }
  const [sym, need] = Object.entries(g.remaining).sort((a, b) => b[1] - a[1])[0];
  const src = cheapestMarket(s.markets, sym);
  if (!src) { console.error(`no market sells ${sym}`); return; }
  const freighter = pickGateHauler(s);
  if (!freighter) { console.error('no available hauler for gate supply'); return; }
  const load = Math.min(freighter.cargo.capacity, need);
  console.error(`supply trip: ${freighter.symbol.slice(-3)} buy ${load} ${sym} @${src.wp.slice(-3)} → deliver to ${g.wp}`);
  const { runPlan } = await import('./trade.mjs');
  await runPlan({ ship: freighter.symbol, steps: [
    { go: src.wp, mode: 'CRUISE' },
    { buy: sym, units: load, maxPx: Math.round(src.px * 1.4) },
    { go: g.wp, mode: 'CRUISE' },
  ] });
  // supply to construction site (ship must be docked at the gate with the goods)
  const have = (await api('GET', `/my/ships/${freighter.symbol}`)).data.cargo.inventory.find((i) => i.symbol === sym)?.units || 0;
  if (have > 0) {
    const r = await api('POST', `/systems/${SYSTEM}/waypoints/${g.wp}/construction/supply`, { shipSymbol: freighter.symbol, tradeSymbol: sym, units: have });
    const m = r.data.construction.materials.find((x) => x.tradeSymbol === sym);
    console.error(`  ✔ supplied ${have} ${sym} → ${m.fulfilled}/${m.required}`);
  }
}

// [F] Pick the dedicated gate hauler: the pinned hull if set, else the largest-cargo idle hull
// (the frigate's spd36 is best for the far gate leg). Never grabs an in-transit ship.
function pickGateHauler(s) {
  if (GATE_HAULER) return s.cargo.find((c) => c.symbol.endsWith(GATE_HAULER) || c.symbol === GATE_HAULER) || null;
  const idle = s.cargo.filter((c) => c.nav.status !== 'IN_TRANSIT' && c.cargo.capacity > 0);
  if (!idle.length) return null;
  return idle.sort((a, b) => b.cargo.capacity - a.cargo.capacity)[0];
}

// [F] Autonomous gate build-out: loop supply trips (neediest material, cheapest market) until
// the gate is complete. Guards a credit floor (supply pays $0) and re-reads live state each loop
// so other agents' contributions and price moves are picked up. Caps loops as a safety stop.
async function supplyGateLoop(maxTrips = 40) {
  for (let i = 0; i < maxTrips; i++) {
    const s = await assess();
    if (!s.gate?.exists) { console.error('no gate in system'); return; }
    if (s.gate.built || !Object.keys(s.gate.remaining).length) { console.error('🎉 gate COMPLETE'); return; }
    if (s.agent.credits < GATE_CREDIT_FLOOR) {
      console.error(`⛔ credit floor: ${s.agent.credits.toLocaleString()} < ${GATE_CREDIT_FLOOR.toLocaleString()} — pausing gate supply so trading rebuilds cash`);
      return;
    }
    const remainStr = Object.entries(s.gate.remaining).map(([k, v]) => `${v}× ${k}`).join(', ');
    console.error(`\n— gate trip ${i + 1}/${maxTrips} | remaining: ${remainStr} | credits ${s.agent.credits.toLocaleString()}`);
    try { await supplyGateTrip(s); } catch (e) { console.error('  trip ERR', e.message, e.data ? JSON.stringify(e.data) : ''); }
  }
  console.error(`reached maxTrips ${maxTrips} — re-run to continue`);
}

async function execute(rec, s, capRemaining) {
  if (!rec || rec.cost > capRemaining) { console.error(`  (skip exec: cost ${rec?.cost} > cap ${capRemaining})`); return 0; }
  if (rec.action === 'BUY_PROBE' || rec.action === 'BUY_SHUTTLE' || rec.action === 'BUY_HAULER') {
    const typeMap = { BUY_PROBE: 'SHIP_PROBE', BUY_SHUTTLE: 'SHIP_LIGHT_SHUTTLE', BUY_HAULER: 'SHIP_LIGHT_HAULER' };
    const shipType = typeMap[rec.action];
    // need one of our ships docked at the shipyard to purchase; move a probe/idle hull there if needed
    const r = await api('POST', '/my/ships', { shipType, waypointSymbol: rec.at });
    const bought = r.data.ship.symbol;
    console.error(`  ✔ purchased ${shipType} -> ${bought} @ ${rec.at} for ${r.data.transaction.price}`);
    if (rec.deployTo) {
      try { await api('POST', `/my/ships/${bought}/orbit`); await api('POST', `/my/ships/${bought}/navigate`, { waypointSymbol: rec.deployTo }); console.error(`  → deploying ${bought} to unvisited market ${rec.deployTo}`); } catch (e) { console.error('  deploy err', e.message); }
    }
    return r.data.transaction.price;
  }
  console.error('  (no executable action for', rec.action, ')');
  return 0;
}

(async () => {
  const s = await assess();
  const yard = await shipyards();
  const { phase, recs } = await recommend(s, yard);

  console.log(`\n=== GROWTH ADVISOR · system ${SYSTEM} ===`);
  console.log(`credits ${s.agent.credits.toLocaleString()} | ships: ${s.probes.length} probes, ${s.cargo.length} cargo, commander=${s.commander ? s.commander.symbol.slice(-3) : 'none'}`);
  console.log(`market visibility ${(s.visibility * 100).toFixed(0)}% (${s.allWps.length - s.unvisited.length}/${s.allWps.length}) | profitable lanes ${s.lanes.length} | idle cargo ${s.idleCargo} | contract ${s.activeContract ? 'ACTIVE' : 'none'}`);
  if (s.gate?.exists) console.log(`jump gate ${s.gate.wp.slice(-3)}: ${s.gate.built ? '✅ OPERATIONAL' : '🚧 ' + JSON.stringify(s.gate.remaining) + ' remaining'}`);
  console.log(`\nPHASE: ${phase}`);
  console.log('Recommended actions (by priority):');
  for (const r of recs) console.log(`  [${r.priority}] ${r.action} — ${r.why}${r.cost ? ` (cost ${r.cost.toLocaleString()})` : ''}`);

  if (process.argv.includes('--supply-gate-loop')) {
    const i = process.argv.indexOf('--max-trips');
    const maxTrips = i > -1 ? Number(process.argv[i + 1]) : 40;
    console.log(`\n--supply-gate-loop: autonomously building the gate (≤${maxTrips} trips, credit floor ${GATE_CREDIT_FLOOR.toLocaleString()})…`);
    await supplyGateLoop(maxTrips);
  } else if (process.argv.includes('--supply-gate')) {
    console.log('\n--supply-gate: running one gate-supply trip…');
    await supplyGateTrip(s);
  } else if (EXECUTE && recs.length) {
    console.log(`\n--execute: performing top SAFE action within cap ${MAX_SPEND.toLocaleString()}`);
    let cap = MAX_SPEND;
    for (const r of recs) { if (['BUY_PROBE', 'BUY_SHUTTLE', 'BUY_HAULER'].includes(r.action)) { const spent = await execute(r, s, cap); cap -= spent; if (spent) break; } }
  } else {
    console.log('\n(advisory only — pass --execute --max-spend N to act)');
  }
})().catch((e) => { console.error('ERR', e.message, e.data ? JSON.stringify(e.data) : ''); process.exit(1); });
