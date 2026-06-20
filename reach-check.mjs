// Authoritative reachability BFS over BUILT jump-gates from home. Definitively answers "can our gated fleet reach
// system X" — independent of the bot's internal pathfinder and the offline crawls (which differed). For each target
// reports REACHABLE (with hop count + path) or the reason (target gate under-construction / no all-built route).
import fs from 'fs';
const TOK = fs.readFileSync(new URL('./.tok2', import.meta.url), 'utf8').trim();
const HOME = 'X1-DB23';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function api(path) {
  const wait = 600 - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  for (let i = 0; i < 8; i++) {
    last = Date.now();
    const res = await fetch('https://api.spacetraders.io/v2' + path, { headers: { Authorization: 'Bearer ' + TOK } });
    if (res.status === 200) return res.json();
    if (res.status === 404) return { __404: true };
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(((j.error?.data?.retryAfter) || 1.5) * 1000); continue; }
    return null;
  }
  return null;
}
// cache: sys -> { gateWp, built, conns:[sys...] }  (conns only meaningful when built)
const G = new Map();
async function gateOf(sys) {
  if (G.has(sys)) return G.get(sys);
  let gateWp = null, built = false, conns = [];
  for (let pg = 1; pg <= 12; pg++) {
    const r = await api(`/systems/${sys}/waypoints?limit=20&page=${pg}`);
    if (!r || !r.data || !r.data.length) break;
    const g = r.data.find((w) => w.type === 'JUMP_GATE');
    if (g) { gateWp = g.symbol; built = !g.isUnderConstruction; break; }
    if (r.data.length < 20) break;
  }
  if (gateWp && built) {
    const jg = await api(`/systems/${sys}/waypoints/${gateWp}/jump-gate`);
    if (jg && jg.data && Array.isArray(jg.data.connections)) conns = jg.data.connections.map((c) => (typeof c === 'string' ? c : c.symbol)).map((w) => w.split('-').slice(0, 2).join('-'));
  }
  const info = { gateWp, built, conns };
  G.set(sys, info);
  return info;
}

(async () => {
  const targets = process.argv.slice(2);
  console.log(`[reach] BFS over BUILT gates from ${HOME}. targets: ${targets.join(', ')}`);
  // BFS outward from home, only traversing BUILT gates. Records parent for path reconstruction.
  const parent = new Map([[HOME, null]]);
  const depth = new Map([[HOME, 0]]);
  const queue = [HOME];
  const targetSet = new Set(targets);
  const found = new Map();
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift();
    visited++;
    const info = await gateOf(cur);
    if (!info.built) continue;                 // can't jump OUT of an unbuilt gate
    if (targetSet.has(cur) && !found.has(cur)) found.set(cur, depth.get(cur));
    if (found.size === targetSet.size) break;  // got them all
    if (depth.get(cur) >= 14) continue;        // safety bound
    for (const nx of info.conns) {
      if (parent.has(nx)) continue;
      // to actually ARRIVE at nx we must be able to jump INTO it → nx's gate must be built. We'll check when we pop it,
      // but record the edge now; if nx gate is unbuilt, gateOf(nx).built=false and it becomes a dead-end (can't continue).
      parent.set(nx, cur); depth.set(nx, depth.get(cur) + 1); queue.push(nx);
    }
  }
  const pathTo = (s) => { const p = []; let c = s; while (c != null) { p.unshift(c); c = parent.get(c); } return p; };
  console.log(`\n[reach] visited ${visited} systems. RESULTS:`);
  for (const t of targets) {
    const info = await gateOf(t);
    if (found.has(t)) {
      console.log(`  ✅ ${t.padEnd(9)} REACHABLE hop ${found.get(t)}  path: ${pathTo(t).map((s) => s.slice(-4)).join('→')}`);
    } else if (parent.has(t) && info.gateWp && !info.built) {
      console.log(`  ⛔ ${t.padEnd(9)} target gate UNDER-CONSTRUCTION (can reach its neighbor but can't jump IN)`);
    } else if (parent.has(t)) {
      console.log(`  ⚠ ${t.padEnd(9)} edge seen but not confirmed reachable (intermediate gate unbuilt on the only route)`);
    } else {
      console.log(`  ❌ ${t.padEnd(9)} NO all-built route found from home`);
    }
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
