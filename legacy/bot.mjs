// ============================================================================
//  SPACEJAM AUTOTRADER  —  standalone autonomous trading bot
//  Built from the manual-experiment scripts (st.mjs + trade.mjs). Runs the
//  calibrated methodology in a continuous loop, with market-recovery rest gaps.
//  Designed to eventually replace the existing runtime/orchestrator logic.
//
//  Loop per cycle:
//    1. refresh markets from probe-covered waypoints   (live prices)
//    2. snapshot fleet                                  (positions/cargo/fuel)
//    3. build + rank profitable lanes (dist<MAXD)       (calibrated fuel/time)
//    4. rotate: skip goods tapped in the last REST_CYCLES
//    5. allocate one distinct good per ship (freighters 2) + fold in contract
//    6. execute all ships concurrently under the shared 2 req/s limiter
//    7. contract pipeline: fulfil active → negotiate+accept next from a probe
//    8. write status (bot-status.json + tracker live log) → rest, repeat
//
//  Run:  node bot.mjs            (uses env SPACETRADERS_PLAYER_AGENT_TOKEN)
//  Stop: touch STOP  (graceful, finishes the cycle) — or kill the PID
// ============================================================================
import { api, getAllShips, getAllContracts, reqStats } from './st.mjs';
import { runPlans, getShip } from './trade.mjs';
import fs from 'node:fs';

const SYSTEM = 'X1-PP30';
const MAXD = 200;                  // max lane distance (fuel-reachable cluster)
const FUEL_PX = 72;
const MIN_NET_CYCLE = 3000;        // lane profitability floor
const REST_CYCLES = 2;             // cycles a tapped good rests before reuse
const REST_BETWEEN_MS = 90_000;    // pause between cycles → market recovery
const CREDIT_TARGET = Number(process.env.CREDIT_TARGET || 8_000_000);
const HQ = 'X1-PP30-A1';
const NEGOTIATOR = process.env.NEGOTIATOR || 'SPACEJAM-DK-2-15'; // parked probe
const here = (p) => new URL(p, import.meta.url);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const coords = {};
for (const l of fs.readFileSync(here('./coords.csv'), 'utf8').trim().split('\n').slice(1)) {
  const [w, x, y] = l.split(','); coords[w] = [+x, +y];
}
const D = (a, b) => (coords[a] && coords[b] ? Math.round(Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1])) : 1e9);

// waypoints we can price (probe-covered) = current markets.json keys
const MARKET_WPS = Object.keys(JSON.parse(fs.readFileSync(here('./markets.json'))));

async function refreshMarkets() {
  const out = {};
  for (const wp of MARKET_WPS) {
    try { out[wp] = (await api('GET', `/systems/${SYSTEM}/waypoints/${wp}/market`)).data; }
    catch { /* skip */ }
  }
  fs.writeFileSync(here('./markets.json'), JSON.stringify(out));
  return out;
}

function buildLanes(markets, avoid) {
  const goods = {};
  for (const [wp, m] of Object.entries(markets))
    for (const g of m.tradeGoods || []) (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  const best = {};
  for (const [sym, entries] of Object.entries(goods)) {
    if (avoid.has(sym)) continue;
    for (const b of entries) for (const s of entries) {
      if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
      const dist = D(b.wp, s.wp); if (dist > MAXD) continue;
      const tv = Math.min(b.tradeVolume, s.tradeVolume);
      const units = Math.min(tv, 20);
      const margin = s.sellPrice - b.purchasePrice;
      const netCyc = margin * units - dist * 2 * FUEL_PX;
      const cycS = 2 * (Math.round(dist * 25 / 15) + 60);
      if (netCyc < MIN_NET_CYCLE) continue;
      if (!best[sym] || netCyc > best[sym].netCyc)
        best[sym] = { sym, buyWp: b.wp, buy: b.purchasePrice, sellWp: s.wp, sell: s.sellPrice, margin, units, dist, netCyc, netMin: netCyc / (cycS / 60) };
    }
  }
  return Object.values(best).sort((a, b) => b.netMin - a.netMin);
}

const laneSteps = (l, units) => [
  { go: l.buyWp, mode: 'CRUISE' },
  { buy: l.sym, units, maxPx: Math.round(l.buy * 1.18) },
  { go: l.sellWp, mode: 'CRUISE' },
  { sell: l.sym },
];

function allocate(ships, lanes, contract) {
  const used = new Set();
  const freighters = ships.filter((s) => s.cargo.capacity >= 80);
  const shuttles = ships.filter((s) => s.cargo.capacity < 80);
  const order = [...freighters, ...shuttles];
  const plans = new Map(order.map((s) => [s.symbol, { ship: s.symbol, steps: [], lanes: [] }]));

  // contract → first freighter whose good is a profitable lane (source already on route)
  if (contract) {
    const cg = contract.deliver.tradeSymbol;
    const l = lanes.find((x) => x.sym === cg) || lanes[0];
    const src = lanes.find((x) => x.sym === cg)?.buyWp;
    const ship = freighters[0];
    if (ship && src) {
      const p = plans.get(ship.symbol);
      const sellRemainder = !!lanes.find((x) => x.sym === cg);
      const buyUnits = contract.deliver.unitsRemaining + (sellRemainder ? 20 : 0);
      p.steps.push({ go: src, mode: 'CRUISE' }, { buy: cg, units: buyUnits, maxPx: Math.round((lanes.find((x) => x.sym === cg)?.buy || 99999) * 1.3) });
      p.steps.push({ go: contract.deliver.destinationSymbol, mode: 'CRUISE' },
        { deliver: cg, contract: contract.id, units: contract.deliver.unitsRemaining }, { fulfill: contract.id });
      if (sellRemainder) p.steps.push({ sell: cg });
      p.lanes.push(`CONTRACT ${cg}`); used.add(cg);
    }
  }

  const pick = (ship) => {
    let best, bestScore = -1e9;
    for (const l of lanes) {
      if (used.has(l.sym)) continue;
      const score = l.netCyc - D(ship.nav.waypointSymbol, l.buyWp) * 2 * FUEL_PX;
      if (score > bestScore) { bestScore = score; best = l; }
    }
    return best;
  };
  const give = (ship) => {
    const l = pick(ship); if (!l) return false;
    used.add(l.sym);
    const p = plans.get(ship.symbol);
    p.steps.push(...laneSteps(l, l.units));
    p.lanes.push(`${l.sym} ${l.buyWp.slice(-3)}→${l.sellWp.slice(-3)} m${l.margin} nm${Math.round(l.netMin)}`);
    return true;
  };
  for (const s of order) if (plans.get(s.symbol).steps.length === 0) give(s);
  for (const s of freighters) if (plans.get(s.symbol).lanes.length === 1 && !plans.get(s.symbol).lanes[0].startsWith('CONTRACT')) give(s);

  return [...plans.values()].filter((p) => p.steps.length);
}

async function getContractState() {
  const cs = await getAllContracts();
  const active = cs.find((c) => c.accepted && !c.fulfilled);
  if (!active) return null;
  const d = active.terms.deliver[0];
  return { id: active.id, deliver: { tradeSymbol: d.tradeSymbol, destinationSymbol: d.destinationSymbol, unitsRemaining: d.unitsRequired - d.unitsFulfilled } };
}

async function ensureContract() {
  // if none active, negotiate + accept a fresh one from the parked probe
  let state = await getContractState();
  if (state) return state;
  try {
    const r = await api('POST', `/my/ships/${NEGOTIATOR}/negotiate/contract`);
    const c = r.data.contract;
    await api('POST', `/my/contracts/${c.id}/accept`);
    log(`contract negotiated+accepted ${c.id}: ${c.terms.deliver[0].unitsRequired} ${c.terms.deliver[0].tradeSymbol} -> ${c.terms.deliver[0].destinationSymbol} (pay ${c.terms.payment.onAccepted + c.terms.payment.onFulfilled})`);
    return await getContractState();
  } catch (e) { log('contract negotiate skipped:', e.message); return null; }
}

function tradeShips(ships) {
  return ships.filter((s) => s.cargo.capacity > 0 && s.frame.symbol !== 'FRAME_PROBE'
    && s.nav.status !== 'IN_TRANSIT' && s.fuel.capacity > 0);
}

let cycleNum = 0;
const recent = [];     // [{cycle, goods:[...]}] for rotation
const history = [];

async function cycle() {
  cycleNum++;
  const t0 = Date.now();
  const agent0 = (await api('GET', '/my/agent')).data;
  log(`──── CYCLE ${cycleNum}  credits=${agent0.credits.toLocaleString()} ────`);

  const markets = await refreshMarkets();
  const ships = await getAllShips();
  const traders = tradeShips(ships);

  const avoid = new Set();
  for (const r of recent.slice(-REST_CYCLES)) for (const g of r.goods) avoid.add(g);

  const contract = await ensureContract();
  const lanes = buildLanes(markets, avoid);
  if (!lanes.length) { log('no profitable lanes (all resting) — extending rest'); return { net: 0, lanes: 0 }; }

  const plans = allocate(traders, lanes, contract);
  const tappedGoods = new Set();
  for (const p of plans) { for (const s of p.steps) if (s.buy) tappedGoods.add(s.buy); }
  recent.push({ cycle: cycleNum, goods: [...tappedGoods] });

  log(`assigning ${plans.length} ships across ${lanes.length} lanes${contract ? ' (+contract)' : ''}`);
  for (const p of plans) log(`  ${p.ship.slice(-3)}: ${p.lanes.join(' | ')}`);

  const net = await runPlans(plans);
  const agent1 = (await api('GET', '/my/agent')).data;
  const rec = { cycle: cycleNum, net, credits: agent1.credits, lanes: lanes.length, ships: plans.length, durMin: ((Date.now() - t0) / 60000).toFixed(1), reqs: reqStats().reqCount };
  history.push(rec);
  writeStatus(agent1.credits, rec);
  log(`cycle ${cycleNum} net=${net.toLocaleString()} credits=${agent1.credits.toLocaleString()} (${rec.durMin}min)`);
  return rec;
}

function writeStatus(credits, rec) {
  fs.writeFileSync(here('./bot-status.json'), JSON.stringify({ updated: new Date().toISOString(), credits, target: CREDIT_TARGET, lastCycle: rec, history }, null, 1));
  // live log block appended to the tracker canvas
  const rows = history.slice(-12).map((h) => `| ${h.cycle} | ${h.net.toLocaleString()} | ${h.credits.toLocaleString()} | ${h.ships} | ${h.lanes} | ${h.durMin}m |`).join('\n');
  const pct = ((credits / CREDIT_TARGET) * 100).toFixed(1);
  const block = `\n\n## 🤖 AUTOTRADER live log\n_daemon running · target ${CREDIT_TARGET.toLocaleString()} · **${pct}%** · updated ${new Date().toISOString().slice(11, 19)}_\n\n| Cycle | Net | Credits | Ships | Lanes | Dur |\n|---|---:|---:|---:|---:|---:|\n${rows}\n`;
  const base = fs.readFileSync(here('./tracker.md'), 'utf8').split('\n## 🤖 AUTOTRADER live log')[0];
  fs.writeFileSync(here('./tracker.md'), base + block);
}

async function main() {
  log(`AUTOTRADER starting. target=${CREDIT_TARGET.toLocaleString()} rest=${REST_BETWEEN_MS / 1000}s`);
  fs.writeFileSync(here('./STOP.hint'), 'touch STOP to stop the bot gracefully\n');
  for (;;) {
    if (fs.existsSync(here('./STOP'))) { log('STOP file present — exiting gracefully'); break; }
    try {
      const rec = await cycle();
      const credits = (await api('GET', '/my/agent')).data.credits;
      if (credits >= CREDIT_TARGET) { log(`🎯 target ${CREDIT_TARGET.toLocaleString()} reached — stopping`); break; }
    } catch (e) { log('CYCLE ERROR:', e.message, e.data ? JSON.stringify(e.data).slice(0, 200) : ''); }
    log(`resting ${REST_BETWEEN_MS / 1000}s for market recovery…`);
    await new Promise((r) => setTimeout(r, REST_BETWEEN_MS));
  }
}

main().catch((e) => { log('FATAL', e.message); process.exit(1); });
