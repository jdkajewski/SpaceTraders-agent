// Cycle allocator: reads live markets.json + fleet snapshot, ranks profitable
// cluster lanes, and assigns each cargo-capable ship a DISTINCT good (≈tradeVolume
// units to avoid slippage). Freighters get a 2-good basket. Emits a runmany plan.
//
// Rotation: pass --avoid SYM1,SYM2 to skip depleted goods from the previous cycle.
// Contract: pass --contract id:GOOD:units:dest to route one ship through deliver+fulfill.
import fs from 'node:fs';

const MAXD = 200;
const markets = JSON.parse(fs.readFileSync(new URL('./markets.json', import.meta.url)));
const snapPath = process.argv.find((a) => a.endsWith('.json') && a.includes('snap')) || './snap4.json';
const snap = JSON.parse(fs.readFileSync(new URL(snapPath, import.meta.url)));
const ships = (snap.ships || snap).filter((s) => s.frame.symbol !== 'FRAME_PROBE');

const coords = {};
for (const l of fs.readFileSync(new URL('./coords.csv', import.meta.url), 'utf8').trim().split('\n').slice(1)) {
  const [w, x, y] = l.split(','); coords[w] = [+x, +y];
}
const D = (a, b) => (coords[a] && coords[b] ? Math.round(Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1])) : 1e9);

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const avoid = new Set((arg('--avoid') || '').split(',').filter(Boolean));
const contract = arg('--contract'); // id:GOOD:units:dest

// Build lanes: for each good, best buy (export/exchange) and best sell (import/exchange)
const goods = {};
for (const [wp, m] of Object.entries(markets)) {
  for (const g of m.tradeGoods || []) {
    (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  }
}
const lanes = [];
for (const [sym, entries] of Object.entries(goods)) {
  if (avoid.has(sym)) continue;
  for (const b of entries) for (const s of entries) {
    if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
    const dist = D(b.wp, s.wp);
    if (dist > MAXD) continue;
    const tv = Math.min(b.tradeVolume, s.tradeVolume);
    const margin = s.sellPrice - b.purchasePrice;
    const units = Math.min(tv, 20); // 1x tradeVolume, capped 20, to avoid slippage
    const netCyc = margin * units - dist * 2 * 72;
    const cycS = 2 * (Math.round(dist * 25 / 15) + 60);
    lanes.push({ sym, buyWp: b.wp, buy: b.purchasePrice, sellWp: s.wp, sell: s.sellPrice, margin, tv, units, dist, netCyc, netMin: netCyc / (cycS / 60) });
  }
}
// best lane per good
const bestPerGood = {};
for (const l of lanes) if (!bestPerGood[l.sym] || l.netCyc > bestPerGood[l.sym].netCyc) bestPerGood[l.sym] = l;
const ranked = Object.values(bestPerGood).filter((l) => l.netCyc > 3000).sort((a, b) => b.netMin - a.netMin);

// Assign: freighters (cap>=80) take 2 goods, shuttles take 1. Pick lanes minimizing reposition.
const used = new Set();
const plans = [];
const freighters = ships.filter((s) => s.cargo.capacity >= 80);
const shuttles = ships.filter((s) => s.cargo.capacity < 80);

function pickLane(ship, exclude) {
  let best, bestScore = -1e9;
  for (const l of ranked) {
    if (used.has(l.sym) || exclude.has(l.sym)) continue;
    const reposition = D(ship.nav.waypointSymbol, l.buyWp);
    const score = l.netCyc - reposition * 2 * 72; // penalize travel to source
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return best;
}

function laneSteps(l, units) {
  return [
    { go: l.buyWp, mode: 'CRUISE' },
    { buy: l.sym, units, maxPx: Math.round(l.buy * 1.18) },
    { go: l.sellWp, mode: 'CRUISE' },
    { sell: l.sym },
  ];
}

// contract ship first
let contractAssigned = false;
let cparts;
if (contract) { const [id, good, units, dest] = contract.split(':'); cparts = { id, good, units: +units, dest }; }

const order = [...freighters, ...shuttles];
const shipSteps = new Map(order.map((s) => [s.symbol, []]));
const shipLanes = new Map(order.map((s) => [s.symbol, []]));

// Contract: fold into first freighter
if (cparts) {
  for (const ship of freighters) {
    const l = bestPerGood[cparts.good];
    if (!l) break;
    const buyUnits = cparts.units + l.units;
    const steps = [
      { go: l.buyWp, mode: 'CRUISE' }, { buy: l.sym, units: buyUnits, maxPx: Math.round(l.buy * 1.25) },
      { go: cparts.dest, mode: 'CRUISE' }, { deliver: cparts.good, contract: cparts.id, units: cparts.units }, { fulfill: cparts.id }, { sell: l.sym },
    ];
    shipSteps.get(ship.symbol).push(...steps);
    shipLanes.get(ship.symbol).push(`CONTRACT ${cparts.good}+sell`);
    used.add(l.sym); contractAssigned = true; break;
  }
}

// Pass 1: every ship gets one lane (proximity-greedy). Pass 2: freighters get a 2nd.
function assignOne(ship) {
  if (shipLanes.get(ship.symbol).some((x) => x.startsWith('CONTRACT'))) return false;
  const l = pickLane(ship, new Set([...used]));
  if (!l) return false;
  used.add(l.sym);
  shipSteps.get(ship.symbol).push(...laneSteps(l, l.units));
  shipLanes.get(ship.symbol).push(`${l.sym} ${l.buyWp.slice(-3)}->${l.sellWp.slice(-3)} m${l.margin} x${l.units} nm${Math.round(l.netMin)}`);
  return true;
}
for (const ship of order) if (shipSteps.get(ship.symbol).length === 0) assignOne(ship);
for (const ship of freighters) if (shipLanes.get(ship.symbol).length === 1 && !shipLanes.get(ship.symbol)[0].startsWith('CONTRACT')) assignOne(ship);

for (const ship of order) {
  const steps = shipSteps.get(ship.symbol);
  if (steps.length) plans.push({ ship: ship.symbol, steps, _lanes: shipLanes.get(ship.symbol) });
}

// report
console.error('=== CYCLE ALLOCATION ===');
for (const p of plans) console.error(`${p.ship.slice(-3).padEnd(4)} ${p._lanes.join('  |  ')}`);
const est = plans.reduce((a, p) => a + (p._lanes.join('').includes('CONTRACT') ? 0 : 0), 0);
const plansClean = plans.map(({ ship, steps }) => ({ ship, steps }));
fs.writeFileSync(new URL('./cycle.json', import.meta.url), JSON.stringify(plansClean, null, 1));
console.error(`\nwrote cycle.json with ${plansClean.length} ship plans`);
