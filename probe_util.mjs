// [PROBE-UTIL] Rank the 27 market-scout probes (FRAME_PROBE, cap0) by how little we actually trade at
// the market they're parked on. Least-used probes are the best candidates to peel off for expansion to a
// new system (cheap first-movers that just need to scout markets). Combines:
//   (1) live probe -> waypoint station (API), and
//   (2) a market-usage score = count of our trade-context log lines that reference each waypoint.
// Usage: node probe_util.mjs            -> prints ranking
//        node probe_util.mjs --csv >> probe_util.csv   -> append one timestamped snapshot (for time-series)
import { getAllShips } from './st.mjs';
import fs from 'fs';

const CODES = ['A1','A2','A3','A4','B6','B7','C40','C41','CA5A','D42','D43','E45','E46','E47','F50','F51','G55','G56','H59','H60','H61','H62','I63','I64','J65','J66','K93'];

function marketUsage() {
  const counts = Object.fromEntries(CODES.map((c) => [c, 0]));
  const logs = fs.readdirSync('.').filter((f) => /^bot2\..*\.log$/.test(f));
  for (const f of logs) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const ln of txt.split('\n')) {
      if (!/✔|bought|sold| sell | buy |→|@[A-Z]|ctr✓|ctr⚡|🏭|MINE/i.test(ln)) continue;
      for (const c of CODES) {
        const re = new RegExp('(^|[^A-Z0-9])' + c + '([^A-Z0-9]|$)');
        if (re.test(ln)) counts[c]++;
      }
    }
  }
  return counts;
}

const KEEP_REASON = {
  I63: 'gate construction site', F51: 'FAB_MATS producer (feed target)', D43: 'ADV_CIRCUITRY producer (feed target)',
  J66: 'ore/raw source', H59: 'IRON/COPPER refiner', A4: 'ADV import sink', I64: 'hub/transit',
};

const ships = await getAllShips();
const probes = ships.filter((s) => s.frame.symbol === 'FRAME_PROBE');
const usage = marketUsage();
const wpOf = {}; // code -> {probe, status}
for (const p of probes) {
  const code = p.nav.waypointSymbol.replace(/^X1-PP30-/, '');
  wpOf[code] = { probe: p.symbol.slice(-3), status: p.nav.status, wp: p.nav.waypointSymbol };
}
const rows = CODES.map((c) => ({ code: c, hits: usage[c], probe: wpOf[c]?.probe || '-', status: wpOf[c]?.status || '-', keep: KEEP_REASON[c] || '' }))
  .sort((a, b) => a.hits - b.hits);

if (process.argv.includes('--csv')) {
  const ts = new Date().toISOString();
  for (const r of rows) console.log(`${ts},${r.code},${r.probe},${r.hits},${r.keep ? 'KEEP' : 'CANDIDATE'}`);
} else {
  console.log(`PROBE UTILIZATION  (${probes.length} probes, ${new Date().toISOString()})`);
  console.log('rank probe  market  hits     role/keep-reason');
  rows.forEach((r, i) => {
    const tag = r.keep ? 'KEEP: ' + r.keep : (r.hits < 100 ? '<< EXPANSION CANDIDATE' : '');
    console.log(`${String(i + 1).padStart(2)}  ${r.probe.padEnd(5)} ${r.code.padEnd(6)} ${String(r.hits).padStart(6)}  ${tag}`);
  });
}
