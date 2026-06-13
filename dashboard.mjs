#!/usr/bin/env node
// Unified live TUI dashboard for the SpaceTraders bot (SPACEJAM-DK-2, system X1-PP30).
// Read-only: reads the bot's local files + the live API. Replaces `status.mjs --watch`.
//
// Pages (number keys 1-5):
//   [1] Status    header + GATE progress + MINING COLONY + FLEET table (full multihop route)
//   [2] Logs      live colorized scrollable tail of the active bot log
//   [3] Contracts live GET /my/contracts with delivery progress bars
//   [4] Markets   paginated per-waypoint price tables (markets.json)
//   [5] Surveys   paginated recent survey events (mine-history.jsonl)
//
// Keys: 1-5 switch page · ↑/↓ scroll · PgUp/PgDn or ←/→ paginate (Markets/Surveys) · g/G top/bottom · r force API refresh · q / Ctrl-C quit
//
// Env:
//   ST_TOKEN  agent token (else read from <BOT_DIR>/.tok2)
//   BOT_DIR   dir holding .tok2 + bot-status.json + .current_log + markets.json + mine-history.jsonl
//   DASH_PAGE optional initial page number (1-5)
import fs from 'fs';
import blessed from 'blessed';

// blessed crashes while compiling xterm-256color's `Setulc` (set-underline-color) terminfo capability. Remap to an
// equivalent 256-color terminfo that doesn't declare it — keeps full color, dodges the crash. Override via DASH_TERM.
if (process.env.DASH_TERM) process.env.TERM = process.env.DASH_TERM;
else if (/^xterm-256color$/.test(process.env.TERM || '')) process.env.TERM = 'screen-256color';

const BOT_DIR = process.env.BOT_DIR || '/Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files';
const botFile = (f) => `${BOT_DIR}/${f}`;
const BASE = 'https://api.spacetraders.io/v2';
const SYS = 'X1-PP30';
const SH = (w) => (w || '').replace(SYS + '-', '');
let TOKEN = '';
try { TOKEN = (process.env.ST_TOKEN || fs.readFileSync(botFile('.tok2'), 'utf8')).trim(); } catch { TOKEN = ''; }
const H = { Authorization: 'Bearer ' + TOKEN };
const esc = blessed.escape;
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(botFile(f), 'utf8')); } catch { return null; } };

// ---- API helpers (retry + 429-aware) ----
async function get(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, { headers: H });
      if (res.status === 429) { await sleep(1200); continue; }
      const r = await res.json();
      if (r.data) return r.data;
    } catch { /* retry */ }
    await sleep(700);
  }
  return null;
}
async function allShips() {
  const out = []; let p = 1;
  for (;;) {
    let page = null;
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(BASE + `/my/ships?limit=20&page=${p}`, { headers: H });
        if (res.status === 429) { await sleep(1200); continue; }
        const r = await res.json();
        if (r.data) { page = r.data; break; }
      } catch { /* retry */ }
      await sleep(800);
    }
    if (!page || !page.length) break;
    out.push(...page); if (page.length < 20) break; p++;
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- shared state ----
const state = {
  bs: {}, rs: {}, agent: null, ships: [], contracts: [], gate: null, markets: {}, surveys: [],
  colony: { feed: null, ore: null, surveys: 0 },
  log: { file: '', lines: [], follow: true },
  apiAt: 0, localAt: 0, apiBusy: false, apiErr: '',
};
let page = 1;
const svPerPage = 14; let svIdx = 0; // surveys pagination
let mkIdx = 0;                        // markets pagination

// ---- role / colour helpers ----
function roleOf(ship, doing, mf) {
  const m = (ship.mounts || []).map((x) => x.symbol).join(',');
  const hasLaser = /MINING_LASER/.test(m), hasSurvey = /SURVEYOR/.test(m);
  const inSet = (arr) => (arr || []).some((h) => ship.symbol === h || ship.symbol.endsWith('-' + h));
  if (hasSurvey) return 'SURVEYOR';
  if (hasLaser) return 'DRONE';
  if (inSet(mf?.transport)) return 'TENDER';
  if (/FUNNEL/.test(doing || '')) return 'FUNNEL';
  if (/CONTRACT/.test(doing || '')) return 'CONTRACT';
  if (/gate|SUPPLY_GATE/i.test(doing || '')) return 'GATE';
  if (ship.frame?.symbol === 'FRAME_PROBE') return 'PROBE';
  return 'TRADE';
}
const ROLE_TAG = { TENDER: 'magenta', DRONE: 'blue', SURVEYOR: 'cyan', FUNNEL: 'magenta', CONTRACT: 'green', GATE: 'yellow', TRADE: 'white', PROBE: 'gray' };
const isParked = (d) => /no profitable lane|PARKED|idle/i.test(d || '');
function etaStr(ship) {
  if (ship.nav?.status !== 'IN_TRANSIT' || !ship.nav.route?.arrival) return '—';
  const x = Math.max(0, Math.round((new Date(ship.nav.route.arrival).getTime() - Date.now()) / 1000));
  return x >= 60 ? `${Math.floor(x / 60)}m${String(x % 60).padStart(2, '0')}s` : x + 's';
}
const tag = (t, s) => t ? `{${t}-fg}${s}{/${t}-fg}` : s;
const bar = (pct, w, tagName) => {
  const fill = Math.max(0, Math.min(w, Math.round(pct * w)));
  return tag(tagName, '█'.repeat(fill)) + tag('gray', '░'.repeat(w - fill));
};
// pad a *plain* string to width then optionally wrap in a colour tag (so tags don't break alignment)
function cell(text, w, tagName) {
  let s = String(text == null ? '' : text);
  if (s.length > w) s = s.slice(0, w);
  else s = s + ' '.repeat(w - s.length);
  return tagName ? tag(tagName, s) : s;
}

// ---- log colourizer ----
function colorLog(line) {
  const m = line.match(/^(\d\d:\d\d:\d\d)\s?([\s\S]*)$/);
  let ts = '', body = line;
  if (m) { ts = m[1]; body = m[2]; }
  let base = null;
  if (/\bERR\b|error|throw|unhandled|reject|fail/i.test(body)) base = 'red';
  else if (/ctr✓/.test(body)) base = 'green';
  else if (/ctr\?/.test(body)) base = 'red';
  else if (/✔|💰|↺/.test(body)) base = 'green';
  else if (/⛽|🎯|⚠/.test(body)) base = 'yellow';
  else if (/⛏️|⛏/.test(body)) base = 'blue';
  else if (/🪐|🚚/.test(body)) base = 'magenta';
  else if (/🧭|🛰/.test(body)) base = 'cyan';
  let b = esc(body);
  b = b.replace(/SPACEJAM-DK-2-([0-9A-Za-z]{1,3})/g, '{bold}{cyan-fg}$1{/cyan-fg}{/bold}');
  b = b.replace(/(^|[\s(])([+\-]\d[\d,]*)\b/g, (mm, pre, num) => pre + (num[0] === '-' ? `{red-fg}${num}{/red-fg}` : `{green-fg}${num}{/green-fg}`));
  let out = ts ? `{gray-fg}${ts}{/gray-fg} ` : '';
  out += base ? `{${base}-fg}${b}{/${base}-fg}` : b;
  return out;
}

// ---- blessed layout ----
const screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'SPACEJAM-DK-2 dashboard', autoPadding: false });
const header = blessed.box({ parent: screen, top: 0, left: 0, height: 1, width: '100%', tags: true, style: { bg: 'black' } });
const tabs = blessed.box({ parent: screen, top: 1, left: 0, height: 1, width: '100%', tags: true });
const footer = blessed.box({ parent: screen, bottom: 0, left: 0, height: 1, width: '100%', tags: true, style: { fg: 'gray' } });
const body = blessed.box({
  parent: screen, top: 2, left: 0, bottom: 1, width: '100%', tags: true, scrollable: true, alwaysScroll: true,
  keys: true, mouse: true, scrollbar: { ch: ' ', style: { bg: 'cyan' } }, padding: { left: 1, right: 1 },
});

const PAGES = ['Status', 'Logs', 'Contracts', 'Markets', 'Surveys'];
function renderTabs() {
  tabs.setContent(PAGES.map((p, i) => {
    const n = i + 1;
    return n === page ? `{black-fg}{cyan-bg} ${n} ${p} {/cyan-bg}{/black-fg}` : `{gray-fg} ${n} ${p} {/gray-fg}`;
  }).join(' '));
}
function renderHeader() {
  const bs = state.bs, rs = state.rs;
  const credits = state.agent?.credits ?? bs.credits ?? 0;
  const net = rs.totalNet ?? bs.runNet ?? 0;
  const lanes = rs.lanesRun ?? bs.lanesRun ?? '?';
  const credTag = credits >= 1100000 ? 'green' : credits >= 600000 ? 'yellow' : 'red';
  header.setContent(
    `{bold}{magenta-fg} SPACEJAM-DK-2{/magenta-fg}{/bold}{gray-fg} · {/gray-fg}{cyan-fg}${bs.phase || '?'}{/cyan-fg}` +
    `{gray-fg} · net {/gray-fg}{bold}{green-fg}+${net.toLocaleString()}{/green-fg}{/bold}` +
    `{gray-fg} · credits {/gray-fg}{bold}${tag(credTag, credits.toLocaleString())}{/bold}` +
    `{gray-fg} · lanes {/gray-fg}{blue-fg}${lanes}{/blue-fg}` +
    `{gray-fg} · ${new Date().toLocaleTimeString()}{/gray-fg}`);
}
function renderFooter() {
  const age = (t) => t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s` : '—';
  const apiNote = state.apiBusy ? '{yellow-fg}refreshing…{/yellow-fg}' : (state.apiErr ? `{red-fg}api:${esc(state.apiErr)}{/red-fg}` : `api ${age(state.apiAt)} ago`);
  footer.setContent(` {bold}1-5{/bold} page · {bold}j/k{/bold} scroll · {bold}u/d{/bold} page · {bold}h/l{/bold} ◀▶ paginate · {bold}g/G{/bold} top/bot · {bold}r{/bold} refresh · {bold}q{/bold} quit  ·  files ${age(state.localAt)} ago · ${apiNote}`);
}

// ---- page renderers ----
function pageStatus() {
  const bs = state.bs, mf = bs.mineFeed || {};
  const out = [];
  // GATE
  if (state.gate) {
    let tot = 0, done = 0; state.gate.materials.forEach((m) => { tot += m.required; done += m.fulfilled; });
    const op = tot ? done / tot : 0;
    const opTag = op >= 0.75 ? 'cyan' : op >= 0.5 ? 'yellow' : 'red';
    const supplying = bs.gate?.supplying ? '{green-fg}SUPPLYING{/green-fg}' : '{yellow-fg}paused{/yellow-fg}';
    out.push(`{bold}GATE{/bold}  ${tag(opTag, (op * 100).toFixed(1) + '%')} {gray-fg}(${done}/${tot}){/gray-fg}  ${supplying}`);
    for (const m of state.gate.materials) {
      const pct = m.required ? m.fulfilled / m.required : 0;
      const t = pct >= 1 ? 'green' : pct >= 0.75 ? 'cyan' : pct >= 0.5 ? 'yellow' : 'red';
      out.push(`  ${cell(m.tradeSymbol, 20)} ${bar(pct, 24, t)} ${cell((pct * 100).toFixed(0) + '%', 4)} {gray-fg}${m.fulfilled}/${m.required}{/gray-fg}`);
    }
  } else {
    out.push(`{bold}GATE{/bold}  {gray-fg}awaiting live construction…{/gray-fg}`);
  }
  // MINING COLONY
  const c = state.colony;
  out.push('');
  out.push(`{bold}MINING COLONY{/bold}  {gray-fg}site{/gray-fg} {cyan-fg}${SH(mf.site) || '?'}{/cyan-fg} {gray-fg}·{/gray-fg} ${mf.enabled ? '{green-fg}ON{/green-fg}' : '{gray-fg}off{/gray-fg}'}` +
    ` {gray-fg}· last feed{/gray-fg} ${c.feed ? '{green-fg}+' + (c.feed.revenue || 0).toLocaleString() + '{/green-fg}' : '—'}` +
    ` {gray-fg}· last ore{/gray-fg} ${c.ore ? '{green-fg}+' + (c.ore.revenue || 0).toLocaleString() + ' ' + (c.ore.good || '') + '{/green-fg}' : '—'}` +
    ` {gray-fg}· surveys{/gray-fg} ${c.surveys}`);
  // FLEET
  const doingBy = {}, routeBy = {};
  for (const s of bs.ships || []) { const k = s.ship.replace(/^-/, ''); doingBy[k] = s.doing; if (s.route) routeBy[k] = s.route; }
  const rows = (state.ships || []).filter((s) => s.cargo?.capacity > 0).map((s) => {
    const short = s.symbol.slice(-3);
    const key = short.replace(/^-/, '');
    const doing = doingBy[key] || doingBy[short] || '';
    const role = roleOf(s, doing, mf);
    const liveLeg = s.nav?.status === 'IN_TRANSIT' && s.nav.route ? `${SH(s.nav.route.origin?.symbol)}→${SH(s.nav.route.destination?.symbol)}` : '—';
    const route = routeBy[key] || routeBy[short] || liveLeg;
    const stShort = { IN_TRANSIT: 'TRANSIT', IN_ORBIT: 'ORBIT', DOCKED: 'DOCKED' }[s.nav?.status] || s.nav?.status || '?';
    const stTag = s.nav?.status === 'IN_TRANSIT' ? 'cyan' : s.nav?.status === 'DOCKED' ? 'yellow' : 'green';
    const fp = s.fuel?.capacity ? s.fuel.current / s.fuel.capacity : 1;
    const fTag = fp < 0.25 ? 'red' : fp < 0.5 ? 'yellow' : 'green';
    const inv = (s.cargo.inventory || []).filter((i) => i.symbol !== 'FUEL').map((i) => i.units + i.symbol.replace(/_.*/, '').slice(0, 3)).join(',');
    return { short, role, stShort, stTag, loc: SH(s.nav?.waypointSymbol), route,
      fuel: s.fuel?.capacity ? `${s.fuel.current}/${s.fuel.capacity}` : '—', fTag,
      cargo: `${s.cargo.units}/${s.cargo.capacity}${inv ? ' ' + inv : ''}`, eta: etaStr(s), parked: isParked(doing) };
  });
  rows.sort((a, b) => a.role.localeCompare(b.role) || a.short.localeCompare(b.short));
  out.push('');
  if (!rows.length) {
    out.push('{bold}FLEET{/bold}  {gray-fg}awaiting live ship data…{/gray-fg}');
  } else {
    const parkedN = rows.filter((r) => r.parked).length;
    out.push(`{bold}FLEET{/bold}  {green-fg}${rows.length - parkedN} working{/green-fg} {gray-fg}·{/gray-fg} ${parkedN ? '{red-fg}' + parkedN + ' parked{/red-fg}' : '{gray-fg}0 parked{/gray-fg}'} {gray-fg}· ${rows.length} hulls{/gray-fg}`);
    out.push('{gray-fg}' + cell('SHIP', 5) + cell('ROLE', 9) + cell('STATUS', 9) + cell('LOC', 5) + cell('ROUTE', 22) + cell('FUEL', 10) + cell('CARGO', 22) + 'ETA{/gray-fg}');
    for (const r of rows) {
      out.push(
        cell(r.short, 5, r.parked ? 'gray' : null) + cell(r.role, 9, ROLE_TAG[r.role] || 'white') +
        cell(r.stShort, 9, r.stTag) + cell(r.loc, 5) + cell(r.route, 22, 'white') +
        cell(r.fuel, 10, r.fTag) + cell(r.cargo, 22) + (r.eta === '—' ? '{gray-fg}—{/gray-fg}' : '{cyan-fg}' + r.eta + '{/cyan-fg}'));
    }
  }
  return out.join('\n');
}

function pageLogs() {
  const L = state.log;
  if (!L.lines.length) return '{gray-fg}no log lines yet (file: ' + esc(L.file || '?') + '){/gray-fg}';
  return L.lines.map(colorLog).join('\n');
}

function progressBarText(filled, total, w = 20) {
  const pct = total ? filled / total : 0;
  const t = pct >= 1 ? 'green' : pct >= 0.5 ? 'cyan' : 'yellow';
  return `${bar(pct, w, t)} {bold}${(pct * 100).toFixed(0)}%{/bold} {gray-fg}${filled}/${total}{/gray-fg}`;
}
function pageContracts() {
  const cs = state.contracts;
  if (!cs) return '{gray-fg}awaiting contracts…{/gray-fg}';
  if (!cs.length) return '{gray-fg}no contracts.{/gray-fg}';
  const out = [];
  for (const c of cs) {
    const st = c.fulfilled ? '{green-fg}FULFILLED{/green-fg}' : c.accepted ? '{yellow-fg}ACCEPTED{/yellow-fg}' : '{cyan-fg}OFFERED{/cyan-fg}';
    out.push(`{bold}${esc(c.type)}{/bold} {gray-fg}${esc(c.id.slice(-8))}{/gray-fg}  ${st}  {gray-fg}faction{/gray-fg} ${esc(c.factionSymbol || '?')}`);
    const pay = c.terms?.payment || {};
    out.push(`  {gray-fg}pay{/gray-fg} on-accept {green-fg}+${(pay.onAccepted || 0).toLocaleString()}{/green-fg} {gray-fg}·{/gray-fg} on-fulfill {green-fg}+${(pay.onFulfilled || 0).toLocaleString()}{/green-fg}`);
    for (const d of c.terms?.deliver || []) {
      out.push(`  {white-fg}${esc(d.tradeSymbol)}{/white-fg} {gray-fg}→{/gray-fg} {cyan-fg}${SH(d.destinationSymbol)}{/cyan-fg}  ${progressBarText(d.unitsFulfilled, d.unitsRequired)}`);
    }
    const dl = c.terms?.deadline ? new Date(c.terms.deadline) : null;
    const acc = c.deadlineToAccept ? new Date(c.deadlineToAccept) : null;
    const fmt = (d) => d ? d.toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
    out.push(`  {gray-fg}deadline{/gray-fg} ${fmt(dl)}${!c.accepted && acc ? '  {gray-fg}accept-by{/gray-fg} ' + fmt(acc) : ''}`);
    out.push('');
  }
  return out.join('\n');
}

function pageMarkets() {
  const entries = Object.entries(state.markets || {});
  if (!entries.length) return '{gray-fg}no markets.json data.{/gray-fg}';
  if (mkIdx >= entries.length) mkIdx = entries.length - 1;
  if (mkIdx < 0) mkIdx = 0;
  const [wp, m] = entries[mkIdx];
  const out = [];
  out.push(`{bold}MARKET{/bold} {cyan-fg}${esc(SH(wp))}{/cyan-fg} {gray-fg}(${mkIdx + 1}/${entries.length})  ←/→ or PgUp/PgDn to page{/gray-fg}`);
  const tags = (arr) => (arr || []).map((x) => x.symbol || x).join(', ');
  if (m.exports?.length) out.push(`  {gray-fg}exports{/gray-fg} {green-fg}${esc(tags(m.exports))}{/green-fg}`);
  if (m.imports?.length) out.push(`  {gray-fg}imports{/gray-fg} {yellow-fg}${esc(tags(m.imports))}{/yellow-fg}`);
  if (m.exchange?.length) out.push(`  {gray-fg}exchange{/gray-fg} {cyan-fg}${esc(tags(m.exchange))}{/cyan-fg}`);
  out.push('');
  const goods = m.tradeGoods || [];
  if (!goods.length) { out.push('  {gray-fg}no trade goods listed.{/gray-fg}'); return out.join('\n'); }
  out.push('{gray-fg}' + cell('GOOD', 22) + cell('BUY', 9) + cell('SELL', 9) + cell('VOL', 7) + 'SUPPLY{/gray-fg}');
  for (const g of goods) {
    out.push(cell(esc(g.symbol), 22, 'white') + cell((g.purchasePrice ?? '—'), 9, 'yellow') +
      cell((g.sellPrice ?? '—'), 9, 'green') + cell((g.tradeVolume ?? '—'), 7) + `{gray-fg}${esc(g.supply || '—')}{/gray-fg}`);
  }
  return out.join('\n');
}

function pageSurveys() {
  const sv = state.surveys;
  if (!sv.length) return '{gray-fg}no survey events in mine-history.jsonl.{/gray-fg}';
  const pages = Math.ceil(sv.length / svPerPage);
  if (svIdx >= pages) svIdx = pages - 1; if (svIdx < 0) svIdx = 0;
  const slice = sv.slice(svIdx * svPerPage, svIdx * svPerPage + svPerPage);
  const out = [];
  out.push(`{bold}SURVEYS{/bold} {gray-fg}(page ${svIdx + 1}/${pages}, ${sv.length} events, newest first)  ←/→ or PgUp/PgDn to page{/gray-fg}`);
  out.push('{gray-fg}' + cell('AGE', 8) + cell('ASTEROID', 8) + cell('SIZE', 8) + cell('SHIP', 6) + 'DEPOSITS{/gray-fg}');
  const now = Date.now();
  for (const s of slice) {
    const ageS = Math.max(0, Math.round((now - new Date(s.t).getTime()) / 1000));
    const age = ageS >= 3600 ? `${Math.floor(ageS / 3600)}h${Math.floor((ageS % 3600) / 60)}m` : ageS >= 60 ? `${Math.floor(ageS / 60)}m${ageS % 60}s` : `${ageS}s`;
    const sizeTag = s.size === 'LARGE' ? 'green' : s.size === 'MODERATE' ? 'cyan' : 'gray';
    const deps = {};
    for (const d of s.deposits || []) deps[d] = (deps[d] || 0) + 1;
    const depStr = Object.entries(deps).map(([k, v]) => `${v}×${k.replace(/_.*/, '').slice(0, 4)}`).join(' ');
    out.push(cell(age, 8, 'gray') + cell(SH(s.ast), 8, 'white') + cell(s.size || '?', 8, sizeTag) + cell(s.ship || '?', 6, 'magenta') + esc(depStr));
  }
  return out.join('\n');
}

// ---- render orchestration ----
function renderBody() {
  let content = '';
  if (page === 1) content = pageStatus();
  else if (page === 2) content = pageLogs();
  else if (page === 3) content = pageContracts();
  else if (page === 4) content = pageMarkets();
  else if (page === 5) content = pageSurveys();
  body.setContent(content);
  if (page === 2 && state.log.follow) body.setScrollPerc(100);
}
function renderAll() { renderHeader(); renderTabs(); renderFooter(); renderBody(); screen.render(); }

// ---- data polling ----
function pollLocal() {
  state.bs = readJSON('bot-status.json') || state.bs;
  state.rs = readJSON('run-stats.json') || state.rs;
  state.markets = readJSON('markets.json') || state.markets;
  // mine-history: surveys + colony summary
  try {
    const all = fs.readFileSync(botFile('mine-history.jsonl'), 'utf8').trim().split('\n');
    const recent = all.slice(-4000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    state.surveys = recent.filter((x) => x.ev === 'survey').reverse();
    state.colony.surveys = recent.filter((x) => x.ev === 'survey').length;
    state.colony.feed = [...recent].reverse().find((x) => x.ev === 'feed') || null;
    state.colony.ore = [...recent].reverse().find((x) => x.ev === 'ore-sale') || null;
  } catch { /* none */ }
  // log tail (re-resolve active file every poll to follow rotation)
  try {
    const file = fs.readFileSync(botFile('.current_log'), 'utf8').trim();
    state.log.file = file;
    const txt = fs.readFileSync(botFile(file), 'utf8');
    state.log.lines = txt.split('\n').filter((l) => l.length).slice(-1500);
  } catch { /* none */ }
  state.localAt = Date.now();
  renderAll();
}

async function pollApi(force = false) {
  if (state.apiBusy) return;
  if (!TOKEN) { state.apiErr = 'no token'; return; }
  if (!force && Date.now() - state.apiAt < 24000) return;
  state.apiBusy = true; state.apiErr = ''; renderFooter(); screen.render();
  try {
    const [agent, ships, contracts, gateWp] = await Promise.all([
      get('/my/agent'), allShips(), get('/my/contracts'), get(`/systems/${SYS}/waypoints?type=JUMP_GATE`),
    ]);
    if (agent) state.agent = agent;
    if (ships?.length) state.ships = ships;
    if (contracts) state.contracts = contracts;
    if (gateWp?.[0]) { const g = await get(`/systems/${SYS}/waypoints/${gateWp[0].symbol}/construction`); if (g) state.gate = g; }
    state.apiAt = Date.now();
  } catch (e) { state.apiErr = (e.message || 'error').slice(0, 24); }
  state.apiBusy = false;
  renderAll();
}

// ---- key bindings ----
// body has blessed's built-in keys:true → up/down/pageup/pagedown/home/end + mouse-wheel
// scroll it natively (most robust across terminals). We add page digits, vi keys, and
// Markets/Surveys pagination on top, and track log-follow from the body 'scroll' event.
function setPage(n) { page = n; state.log.follow = (n === 2); body.setScroll(0); renderAll(); }
for (let n = 1; n <= 5; n++) screen.key([String(n)], () => setPage(n));
screen.key(['q', 'C-c'], () => process.exit(0));
screen.key(['r'], () => pollApi(true));
screen.key(['k'], () => { body.scroll(-1); screen.render(); });
screen.key(['j'], () => { body.scroll(1); screen.render(); });
// page-scroll on LETTER keys (u/d) — arrows/PgUp/PgDn are eaten by some embedded
// terminals (e.g. the Copilot terminal canvas), but letters always reach the app.
const pgLines = () => Math.max(1, ((body.height | 0) || 20) - 2);
screen.key(['u', 'C-u'], () => { body.scroll(-pgLines()); screen.render(); });
screen.key(['d', 'C-d'], () => { body.scroll(pgLines()); screen.render(); });
screen.key(['g'], () => { body.setScroll(0); screen.render(); });
screen.key(['S-g', 'G'], () => { body.setScrollPerc(100); screen.render(); });
function paginate(delta) {
  if (page === 4) { mkIdx += delta; renderAll(); }
  else if (page === 5) { svIdx += delta; renderAll(); }
  else { body.scroll(delta * 10); screen.render(); }
}
// ←/→ (and h/l) paginate Markets/Surveys; on other pages they do a 10-line jump.
screen.key(['left', 'h'], () => paginate(-1));
screen.key(['right', 'l'], () => paginate(1));
// keep log-follow in sync with whatever moved the scroll (keys, wheel, pagedown-to-bottom)
body.on('scroll', () => { if (page === 2) state.log.follow = body.getScrollPerc() >= 100; });

// ---- boot ----
if (process.env.DASH_PAGE) page = Number(process.env.DASH_PAGE) || 1;
body.focus();
pollLocal();
renderAll();
pollApi(true);
setInterval(pollLocal, 1500);
setInterval(() => pollApi(false), 5000);
setInterval(() => { renderHeader(); renderFooter(); screen.render(); }, 1000); // live clock + eta refresh
