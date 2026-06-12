// Ship health report: frame/reactor/engine condition + integrity, sorted worst-first.
// Read-only, rate-limited via st.mjs. Usage: SPACETRADERS_PLAYER_AGENT_TOKEN=... node health.mjs
import { getAllShips, reqStats } from './st.mjs';

const pct = (n) => (n == null ? '  -  ' : (n * 100).toFixed(0).padStart(3) + '%');
// SpaceTraders: condition (0..1) = wear that lowers performance; integrity (0..1) = structural, hits 0 => ship scrapped.
const bar = (n) => {
  if (n == null) return '';
  const v = Math.round(n * 10);
  return '█'.repeat(v) + '░'.repeat(10 - v);
};

const ships = await getAllShips();
const rows = ships.map((s) => {
  const f = s.frame || {}, r = s.reactor || {}, e = s.engine || {};
  const conds = [f.condition, r.condition, e.condition].filter((x) => x != null);
  const integs = [f.integrity, r.integrity, e.integrity].filter((x) => x != null);
  return {
    sym: s.symbol.replace('SPACEJAM-DK-2-', '-'),
    role: s.registration?.role || '',
    fc: f.condition, rc: r.condition, ec: e.condition,
    fi: f.integrity, ri: r.integrity, ei: e.integrity,
    minCond: conds.length ? Math.min(...conds) : null,
    minInteg: integs.length ? Math.min(...integs) : null,
  };
});
rows.sort((a, b) => (a.minInteg ?? 9) - (b.minInteg ?? 9) || (a.minCond ?? 9) - (b.minCond ?? 9));

console.log('SHIP HEALTH — SPACEJAM-DK-2   ' + new Date().toLocaleTimeString() + '   (' + ships.length + ' ships)');
console.log('condition = performance wear · integrity = structural life (0 ⇒ ship lost)\n');
console.log('ship  role         | frame  reactor engine | frame  reactor engine  worst');
console.log('                   |    --- CONDITION ---  |   --- INTEGRITY ---   integ  ' );
console.log('-'.repeat(86));
let warn = [];
for (const r of rows) {
  const flag = (r.minInteg != null && r.minInteg <= 0.5) ? ' ⚠' : (r.minInteg != null && r.minInteg < 0.85 ? ' ·' : '');
  console.log(
    `${r.sym.padEnd(5)} ${(r.role || '').slice(0, 11).padEnd(11)} | ${pct(r.fc)} ${pct(r.rc)} ${pct(r.ec)} | ${pct(r.fi)} ${pct(r.ri)} ${pct(r.ei)}  ${bar(r.minInteg)}${flag}`
  );
  if (r.minInteg != null && r.minInteg < 0.85) warn.push(r);
}
console.log('-'.repeat(86));
if (warn.length) {
  console.log(`\n${warn.length} ship(s) below 85% integrity (consider repair):`);
  for (const r of warn) console.log(`  ${r.sym}: integrity ${pct(r.minInteg)} (frame ${pct(r.fi)}/reactor ${pct(r.ri)}/engine ${pct(r.ei)})`);
} else {
  console.log('\nAll ships ≥85% integrity — no maintenance needed.');
}
console.log(`\napi requests: ${reqStats().reqCount}`);
