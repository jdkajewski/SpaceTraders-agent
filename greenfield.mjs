// ============================ GREENFIELD / COLD-START MODULE ============================
// Run ONCE before launching bot2 on a fresh reset. Idempotent + self-skipping. Steps:
//   1) Detect the home SYSTEM from the agent's headquarters (no hardcode).
//   2) Build system data files (coords.csv + markets.json) for that system if missing/mismatched.
//   3) Buy probes (budget-aware) and park them 1:1 at the highest-connectivity markets so the bot has
//      live price visibility (lanes can only form where a ship is stationed).
// Writes the detected system to .greenfield-system so the relaunch script can export SYSTEM=<it>.
//
// Usage: SPACETRADERS_PLAYER_AGENT_TOKEN=... node greenfield.mjs
// Env knobs: GF_PROBE_BUFFER (min credits to keep, default 45000), GF_MAX_PROBES (default 8),
//            GF_FORCE=1 (rebuild data even if present).
import { api } from './st.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), '[GREENFIELD]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUFFER = Number(process.env.GF_PROBE_BUFFER || 45000);
const MAX_PROBES = Number(process.env.GF_MAX_PROBES || 8);
const FORCE = process.env.GF_FORCE === '1';

async function agent() { return (await api('GET', '/my/agent')).data; }
async function allShips() {
  const out = []; let page = 1;
  for (;;) { const r = await api('GET', `/my/ships?limit=20&page=${page}`); out.push(...r.data); if (page * 20 >= r.meta.total) break; page++; }
  return out;
}
async function allWaypoints(sys) {
  const out = []; let page = 1;
  for (;;) { const r = await api('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`); out.push(...r.data); if (page * 20 >= r.meta.total) break; page++; }
  return out;
}

async function buildSystemData(sys) {
  const haveMarkets = existsSync(here('./markets.json'));
  let mismatch = true;
  if (haveMarkets) { try { mismatch = !Object.keys(JSON.parse(readFileSync(here('./markets.json')))).some((w) => w.startsWith(sys + '-')); } catch {} }
  if (!FORCE && haveMarkets && !mismatch) { log(`system data already present for ${sys} — skip rebuild`); return; }
  const wps = await allWaypoints(sys);
  writeFileSync(here('./coords.csv'), ['waypoint,x,y', ...wps.map((w) => `${w.symbol},${w.x},${w.y}`)].join('\n') + '\n');
  log(`coords.csv ← ${wps.length} waypoints`);
  const markets = wps.filter((w) => (w.traits || []).some((t) => t.symbol === 'MARKETPLACE'));
  const out = {};
  for (const w of markets) { try { out[w.symbol] = (await api('GET', `/systems/${sys}/waypoints/${w.symbol}/market`)).data; } catch (e) { log(`${w.symbol} mkt ERR ${e.message}`); } }
  writeFileSync(here('./markets.json'), JSON.stringify(out));
  log(`markets.json ← ${Object.keys(out).length} markets`);
  return { wps, markets };
}

// Rank markets by export+import connectivity (best lane potential) for probe placement.
async function rankMarkets(sys, wps) {
  const markets = wps.filter((w) => (w.traits || []).some((t) => t.symbol === 'MARKETPLACE'));
  const scored = [];
  for (const w of markets) {
    try {
      const m = (await api('GET', `/systems/${sys}/waypoints/${w.symbol}/market`)).data;
      scored.push({ wp: w.symbol, score: (m.exports?.length || 0) * 2 + (m.imports?.length || 0) + (m.exchange?.length || 0) });
    } catch { scored.push({ wp: w.symbol, score: 0 }); }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.wp);
}

async function main() {
  const a = await agent();
  const sys = a.headquarters.split('-').slice(0, 2).join('-');
  writeFileSync(here('./.greenfield-system'), sys);
  log(`agent ${a.symbol} HQ ${a.headquarters} → SYSTEM ${sys}, credits ${a.credits}`);

  const built = await buildSystemData(sys);
  const wps = built?.wps || await allWaypoints(sys);

  // current fleet: where are ships / which markets already covered
  const ships = await allShips();
  const probes = ships.filter((s) => (s.frame?.symbol === 'FRAME_PROBE') || (s.fuel?.capacity === 0 && s.cargo?.capacity === 0));
  const traders = ships.filter((s) => s.cargo?.capacity >= 20);
  log(`fleet: ${ships.length} ships (${probes.length} probes, ${traders.length} traders)`);

  // [NEGOTIATOR] designate the lowest-numbered probe as the permanent contract negotiator (agent-agnostic). It stays
  // docked to negotiate; bot2 reads this from .greenfield-negotiator so NEGOTIATOR is never hardcoded per-agent.
  const negProbe = probes.map((s) => s.symbol).sort((a, b) => {
    const na = parseInt(a.split('-').pop(), 36), nb = parseInt(b.split('-').pop(), 36);
    return (isNaN(na) ? 1e9 : na) - (isNaN(nb) ? 1e9 : nb);
  })[0] || ships[0]?.symbol;
  if (negProbe) { writeFileSync(here('./.greenfield-negotiator'), negProbe); log(`negotiator → ${negProbe}`); }

  // find a probe-selling shipyard + a hull present there to buy from
  const yards = wps.filter((w) => (w.traits || []).some((t) => t.symbol === 'SHIPYARD'));
  let buyYard = null;
  for (const y of yards) {
    try { const sy = (await api('GET', `/systems/${sys}/waypoints/${y.symbol}/shipyard`)).data; if (sy.shipTypes.some((t) => t.type === 'SHIP_PROBE')) { buyYard = y.symbol; break; } } catch {}
  }
  if (!buyYard) { log('no probe-selling shipyard found — skip probe buys'); }

  // ranked target markets for coverage
  const ranked = await rankMarkets(sys, wps);
  const covered = new Set(probes.map((p) => p.nav.waypointSymbol));
  const targets = ranked.filter((wp) => !covered.has(wp));

  // buy probes up to budget/cap, station each at the next uncovered ranked market
  const bought = [];
  if (buyYard) {
    // move a trader (or any hull) to the yard if none present
    let atYard = ships.find((s) => s.nav.waypointSymbol === buyYard && s.nav.status !== 'IN_TRANSIT');
    if (!atYard && traders[0]) {
      const t = traders[0];
      try { if (t.nav.status === 'DOCKED') await api('POST', `/my/ships/${t.symbol}/orbit`); await api('POST', `/my/ships/${t.symbol}/navigate`, { waypointSymbol: buyYard }); log(`moving ${t.symbol} → ${buyYard} to enable probe buys (re-run after arrival)`); } catch (e) { log(`reposition ERR ${e.message}`); }
    }
    if (atYard) {
      if (atYard.nav.status !== 'DOCKED') await api('POST', `/my/ships/${atYard.symbol}/dock`);
      // Coverage-aware: only buy enough probes to cover currently-uncovered markets, and never exceed MAX_PROBES
      // TOTAL probes. This makes greenfield idempotent across restarts (no re-buying when coverage is already good).
      const deficit = Math.max(0, Math.min(targets.length, MAX_PROBES - probes.length));
      if (deficit === 0) log(`coverage ok (${probes.length} probes, ${targets.length} uncovered) — no probe buys`);
      for (let i = 0; i < deficit; i++) {
        const c = (await agent()).credits;
        const sy = (await api('GET', `/systems/${sys}/waypoints/${buyYard}/shipyard`)).data;
        const probe = sy.ships?.find((s) => s.type === 'SHIP_PROBE');
        if (!probe) { log('no SHIP_PROBE example at yard (price unknown) — stop'); break; }
        if (c - probe.purchasePrice < BUFFER) { log(`stop buys: ${c} - ${probe.purchasePrice} < buffer ${BUFFER}`); break; }
        try { const r = await api('POST', '/my/ships', { shipType: 'SHIP_PROBE', waypointSymbol: buyYard }); bought.push(r.data.ship.symbol); log(`bought ${r.data.ship.symbol} @ ${probe.purchasePrice} (→${r.data.agent.credits})`); } catch (e) { log(`buy ERR ${e.message}`); break; }
        await sleep(700);
      }
    }
  }

  // distribute probes 1:1 to ranked uncovered markets. Only place NEWLY-BOUGHT probes + idle probes that are NOT
  // already sitting on a marketplace (so a restart never reshuffles probes already doing their job → no churn).
  const mktSet = new Set(ranked);
  const idleUnplaced = probes.filter((p) => p.nav.status !== 'IN_TRANSIT' && !mktSet.has(p.nav.waypointSymbol)).map((p) => p.symbol);
  const toPlace = [...bought, ...idleUnplaced];
  let ti = 0;
  for (const sym of toPlace) {
    while (ti < targets.length && covered.has(targets[ti])) ti++;
    if (ti >= targets.length) break;
    const dest = targets[ti++];
    try {
      let s = (await api('GET', `/my/ships/${sym}`)).data;
      if (s.nav.waypointSymbol === dest) { covered.add(dest); continue; }
      if (s.nav.status === 'DOCKED') await api('POST', `/my/ships/${sym}/orbit`);
      const r = await api('POST', `/my/ships/${sym}/navigate`, { waypointSymbol: dest });
      covered.add(dest);
      log(`${sym} → ${dest} (rank-placed) ETA ${r.data.nav.route.arrival}`);
    } catch (e) { log(`${sym} place ERR ${e.message}`); }
    await sleep(500);
  }
  log(`done. SYSTEM=${sys}; ${covered.size} markets covered by probes. Launch bot2 with SYSTEM=${sys} TRADE_FIRST=1.`);
}
main().catch((e) => log('FATAL', e.message));
