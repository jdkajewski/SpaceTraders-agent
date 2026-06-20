// Fueled-relay seeder — TEMPORARY (bot OFF). Relays a LIGHT_SHUTTLE from home to each deep rich system via chained
// gate-to-gate JUMPS (no fuel/no within-system cruise between hops — just antimatter + cooldowns), charting every gate
// it passes (which ALSO unblocks the bot's pathfinder for that route). At the target it cruises gate→yard (fueled =
// fast) and buys probes + a local hauler. Targets run with capped concurrency to hide per-jump cooldowns.
//
// Paths are the all-built gate routes from reach-check.mjs (BFS over BUILT gates). Edit SEEDS / PROBES_PER as needed.
import fs from 'fs';
const TOK = fs.readFileSync(new URL('./.tok2', import.meta.url), 'utf8').trim();
const HOME_GATE = 'X1-DB23-I59';
const HOME_YARD = 'X1-DB23-A2';
const PROBES_PER = Number(process.env.PROBES_PER || 4);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function api(method, path, body) {
  const wait = 520 - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  for (let i = 0; i < 10; i++) {
    last = Date.now();
    const res = await fetch('https://api.spacetraders.io/v2' + path, {
      method, headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });
    if (res.status === 200 || res.status === 201) return res.json();
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(((j.error?.data?.retryAfter) || 1.5) * 1000); continue; }
    const txt = await res.text(); const e = new Error(`${res.status} ${txt.slice(0, 160)}`); e.status = res.status; e.body = txt; throw e;
  }
  throw new Error('rate-limit retries exhausted');
}
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()} ${m}`);
const ship = (s) => api('GET', `/my/ships/${s}`).then((r) => r.data);
const sysOf = (wp) => wp.split('-').slice(0, 2).join('-');
async function orbit(s) { try { await api('POST', `/my/ships/${s}/orbit`); } catch (e) { if (!/already|in orbit/i.test(e.message)) throw e; } }
async function dock(s) { try { await api('POST', `/my/ships/${s}/dock`); } catch (e) { if (!/already|docked/i.test(e.message)) throw e; } }
async function refuel(s) { try { await dock(s); await api('POST', `/my/ships/${s}/refuel`); } catch {} }
async function chart(s) { try { await api('POST', `/my/ships/${s}/chart`); } catch {} }

const gateCache = new Map();
async function gateOf(sys) {
  if (gateCache.has(sys)) return gateCache.get(sys);
  let gate = null;
  for (let pg = 1; pg <= 12; pg++) {
    const r = await api('GET', `/systems/${sys}/waypoints?limit=20&page=${pg}`);
    if (!r || !r.data || !r.data.length) break;
    const g = r.data.find((w) => w.type === 'JUMP_GATE');
    if (g) { gate = g.symbol; break; }
    if (r.data.length < 20) break;
  }
  gateCache.set(sys, gate);
  return gate;
}
const yardCache = new Map();
async function yardsOf(sys) {
  if (yardCache.has(sys)) return yardCache.get(sys);
  const out = [];
  for (let pg = 1; pg <= 12; pg++) {
    const r = await api('GET', `/systems/${sys}/waypoints?limit=20&page=${pg}`);
    if (!r || !r.data || !r.data.length) break;
    for (const w of r.data) if ((w.traits || []).some((t) => t.symbol === 'SHIPYARD')) {
      const sy = await api('GET', `/systems/${sys}/waypoints/${w.symbol}/shipyard`);
      const t = new Set((sy?.data?.shipTypes || []).map((x) => x.type));
      out.push({ wp: w.symbol, sells: t });
    }
    if (r.data.length < 20) break;
  }
  yardCache.set(sys, out);
  return out;
}
async function navTo(s, wp, mode = 'CRUISE') {
  let sh = await ship(s);
  if (sh.nav.waypointSymbol === wp && sh.nav.status !== 'IN_TRANSIT') return sh;
  await orbit(s);
  if (sh.nav.status !== 'IN_TRANSIT') {
    try { await api('POST', `/my/ships/${s}/navigate`, { waypointSymbol: wp, flightMode: mode }); }
    catch (e) { if (/fuel/i.test(e.message)) { await api('POST', `/my/ships/${s}/navigate`, { waypointSymbol: wp, flightMode: 'DRIFT' }); } else if (!/in[- ]?transit/i.test(e.message)) throw e; }
  }
  for (let i = 0; i < 240; i++) {
    sh = await ship(s);
    if (sh.nav.status !== 'IN_TRANSIT') return sh;
    const eta = sh.nav.route?.arrival ? Math.max(0, (new Date(sh.nav.route.arrival) - Date.now()) / 1000) : 5;
    await sleep(Math.min(Math.max(eta * 1000, 3000), 25000));
  }
  return sh;
}
async function jumpTo(s, toGate) {
  await orbit(s);
  for (let i = 0; i < 50; i++) {
    try { const r = await api('POST', `/my/ships/${s}/jump`, { waypointSymbol: toGate }); return r.data; }
    catch (e) { const mm = /(\d+)\s*second/i.exec(e.message); if (/cooldown/i.test(e.message) && mm) { await sleep((+mm[1]) * 1000 + 800); continue; } throw e; }
  }
  throw new Error('jump exhausted');
}
async function buyShip(type, yardWp) { const r = await api('POST', '/my/ships', { shipType: type, waypointSymbol: yardWp }); return r.data.ship.symbol; }

// Relay one shuttle from home to `path`'s end (target), charting each hop, then buy local probes + hauler.
async function seedTarget(cfg) {
  const { target, path } = cfg;
  const tag = target.slice(-5);
  try {
    log(`[${tag}] buy relay hauler @ home`);
    const s = await buyShip('SHIP_LIGHT_HAULER', HOME_YARD);
    await refuel(s);
    log(`[${tag}] ${s} bought → cruise to home gate`);
    await navTo(s, HOME_GATE);
    // relay: jump gate→gate along path (path[0]=home already). chart + opportunistic refuel each hop.
    for (let i = 1; i < path.length; i++) {
      const nextGate = await gateOf(path[i]);
      if (!nextGate) throw new Error(`no gate for ${path[i]}`);
      await jumpTo(s, nextGate);
      await chart(s);
      await refuel(s);                                          // top up whenever the gate is a fuel market (no-op otherwise)
      if (i % 3 === 0 || i === path.length - 1) log(`[${tag}] relayed ${i}/${path.length - 1} → ${path[i].slice(-5)}`);
    }
    // at target gate → cruise to yard (the relay HAULER stays as the resident earner), buy local probes
    const yards = await yardsOf(target);
    const probeYard = yards.find((y) => y.sells.has('SHIP_PROBE')) || yards[0];
    if (!probeYard) { log(`[${tag}] ⚠ no yard at target — relay hauler resident only`); return { target, ok: true, note: 'no-yard' }; }
    log(`[${tag}] at target → cruise to yard ${probeYard.wp.slice(-5)}`);
    await navTo(s, probeYard.wp);
    await dock(s); await refuel(s);
    let bought = [];
    for (let i = 0; i < PROBES_PER; i++) { try { const p = await buyShip('SHIP_PROBE', probeYard.wp); bought.push('probe ' + p.slice(-3)); } catch (e) { log(`[${tag}] probe ${i + 1} failed: ${e.message}`); break; } }
    log(`[${tag}] ✅ SEEDED — relay-hauler ${s.slice(-3)} (earner) + ${bought.join(', ')}`);
    return { target, ok: true, ships: bought.length + 1 };
  } catch (e) { log(`[${tag}] ✗ FAILED: ${e.message}`); return { target, ok: false, err: e.message }; }
}

// all-built gate paths from reach-check.mjs (system order, home-first)
const P = (s) => s.split(',').map((x) => 'X1-' + x);
const SEEDS = [
  { target: 'X1-NC29', path: P('DB23,YS20,FC30,ZU97,GU28,HN17,NC29') },
  { target: 'X1-P85', path: P('DB23,YS20,FC30,ZU97,GU28,PN15,YZ36,P85') },
  { target: 'X1-UG37', path: P('DB23,YK2,ZV87,HC40,N62,GR73,BM10,JK14,UG37') },
  { target: 'X1-JK86', path: P('DB23,YK2,ZV87,DM89,RS94,VA21,DZ76,QM27,VH36,BM60,JK86') },
  { target: 'X1-AA39', path: P('DB23,YK2,ZV87,HC40,N62,GR73,BM10,JK14,FR80,SG5,HZ73,AA39') },
  { target: 'X1-NM3', path: P('DB23,YK2,ZV87,HC40,N62,GR73,BM10,JK14,FR80,SG5,HZ73,NM3') },
  { target: 'X1-XH71', path: P('DB23,YS20,FC30,ZU97,GU28,PN15,FZ20,UZ75,PD56,AH43,PH2,XH71') },
  { target: 'X1-QD28', path: P('DB23,YK2,ZV87,DM89,RS94,VA21,PQ94,AM70,MV91,DM61,MC68,XF12,YJ68,QD28') },
  { target: 'X1-QS78', path: P('DB23,YK2,ZV87,DM89,RS94,VA21,PQ94,AM70,MV91,DM61,MC68,XF12,YJ68,QD28,QS78') },
  { target: 'X1-D26', path: P('DB23,YK2,ZV87,DM89,RS94,VA21,PQ94,AM70,MV91,DM61,MC68,XF12,FA43,QR57,D26') },
];

(async () => {
  const only = process.argv.slice(2);                       // optional: seed only these targets (e.g. X1-NC29 X1-P85)
  const queue = (only.length ? SEEDS.filter((c) => only.includes(c.target)) : SEEDS).slice();
  const ag = (await api('GET', '/my/agent')).data;
  log(`=== FUELED-RELAY SEED start — ${queue.length} targets, concurrency ${CONCURRENCY}, ${PROBES_PER} probes each. credits ${ag.credits.toLocaleString()} ===`);
  const results = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) { const cfg = queue.shift(); results.push(await seedTarget(cfg)); }
  });
  await Promise.all(workers);
  const ag2 = (await api('GET', '/my/agent')).data;
  log(`=== DONE. ok=${results.filter((r) => r.ok).length}/${results.length}, spent ${(ag.credits - ag2.credits).toLocaleString()}, credits ${ag2.credits.toLocaleString()} ===`);
  for (const r of results) log(`   ${r.ok ? '✅' : '✗'} ${r.target}${r.err ? ' — ' + r.err : ''}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
