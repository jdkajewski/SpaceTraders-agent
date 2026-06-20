// Gate-graph dumper — BFS from home over BUILT jump-gates, writing gate-graph.json: a static map
//   sysSymbol -> { gateWp, built, conns:[fullWaypointSymbol...] }
// covering the whole reachable graph. The bot preloads this so its pathfinder is instant + unbounded
// (no slow per-node live API), which both lets it resolve DEEP reachable targets and de-starves autoBuy.
import fs from 'fs';
const TOK = fs.readFileSync(new URL('./.tok2', import.meta.url), 'utf8').trim();
const HOME = 'X1-DB23';
const OUT = new URL('./gate-graph.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function api(path) {
  const wait = 520 - (Date.now() - last);
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
const graph = {};
async function crawl(sys) {
  if (graph[sys]) return graph[sys];
  let gateWp = null, built = false;
  for (let pg = 1; pg <= 12; pg++) {
    const r = await api(`/systems/${sys}/waypoints?limit=20&page=${pg}`);
    if (!r || !r.data || !r.data.length) break;
    const g = r.data.find((w) => w.type === 'JUMP_GATE');
    if (g) { gateWp = g.symbol; built = !g.isUnderConstruction; break; }
    if (r.data.length < 20) break;
  }
  let conns = [];
  if (gateWp && built) {
    const jg = await api(`/systems/${sys}/waypoints/${gateWp}/jump-gate`);
    if (jg && jg.data && Array.isArray(jg.data.connections)) conns = jg.data.connections.map((c) => (typeof c === 'string' ? c : c.symbol));
  }
  const node = { gateWp, built, conns };
  graph[sys] = node;
  return node;
}
(async () => {
  console.log(`[graph] BFS from ${HOME} over BUILT gates…`);
  const queue = [HOME];
  const seen = new Set([HOME]);
  let n = 0;
  while (queue.length) {
    const cur = queue.shift();
    const node = await crawl(cur);
    n++;
    if (n % 20 === 0) { console.log(`[graph] crawled ${n}, queue ${queue.length}`); fs.writeFileSync(OUT, JSON.stringify(graph)); }
    if (!node.built) continue;                                   // dead-end: can't jump out of an unbuilt gate
    for (const cwp of node.conns) {
      const csys = cwp.split('-').slice(0, 2).join('-');
      if (!seen.has(csys)) { seen.add(csys); queue.push(csys); }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(graph));
  const built = Object.values(graph).filter((g) => g.built).length;
  console.log(`[graph] DONE — ${Object.keys(graph).length} systems (${built} with built gates). wrote ${OUT.pathname}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
