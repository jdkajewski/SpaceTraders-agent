// Contract lifecycle viewer — SPACEJAM-DK-2.  Read-only; safe to run anytime.
//
// Shows each contract's journey: ACCEPTED → DELIVERED (one or more) → FULFILLED, with wall-clock
// timestamps and the accept→fulfill cycle time.
//
// DATA SOURCE — by default this reads ONLY LOCAL FILES the bot already writes (bot2.*.log + bot-status.json),
// so it makes ZERO API calls and CANNOT cause rate-limit (429) trouble for the running bot. Safe to leave in
// `-w` watch mode all day. Pass --live to additionally hit the SpaceTraders API for authoritative current
// state (OFFERED contracts, exact deadlines, live progress) — that DOES share the bot's ~2 req/s budget, so
// use it for one-off checks, not continuous watching.
//
// Usage:  node contracts.mjs [N]        last N contracts (default 15; "all" = every one) — LOCAL, no API
//         node contracts.mjs -w 30      watch, refresh every 30s — LOCAL, no API (safe to leave running)
//         node contracts.mjs --active   only the currently-active contract
//         node contracts.mjs --live     enrich with the API (deadlines / offered) — uses the shared budget
import fs from 'fs';

const HERE = (p) => new URL(p, import.meta.url);
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(HERE(f), 'utf8')); } catch { return null; } };

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
let limit = 15, watch = 0, activeOnly = false, live = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-w' || a === '--watch') watch = Number(argv[++i] || 30) || 30;
  else if (a === '--active') activeOnly = true;
  else if (a === '--live') live = true;
  else if (/^all$/i.test(a)) limit = Infinity;
  else if (/^\d+$/.test(a)) limit = Number(a);
}

// ---- ansi ------------------------------------------------------------------
const C = { d: '\x1b[2m', r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', red: '\x1b[31m', mag: '\x1b[35m' };
const money = (n) => (n == null ? '—' : Number(n).toLocaleString());
const pad = (s, n) => { s = String(s); const len = s.replace(/\x1b\[[0-9;]*m/g, '').length; return len >= n ? s : s + ' '.repeat(n - len); };
const id6 = (id) => String(id).slice(-6);
function dur(sec) {
  if (sec == null || sec < 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}
function bar(done, req, w = 16) { const f = req ? Math.round((done / req) * w) : 0; return '█'.repeat(f) + '░'.repeat(Math.max(0, w - f)); }

// ---- parse bot logs into per-contract lifecycle events (LOCAL, no API) -----
// Log lines are time-only (HH:MM:SS, UTC). We process files in chronological (filename) order and keep a
// monotonic clock — when the time jumps backward we assume a day rolled over and add 24h — so accept→fulfill
// durations stay correct across midnight and across restarts. The 📜 accept line carries units/dest/total-pay,
// so the whole lifecycle table can be built without any API call. Insertion order = creation order.
function parseLogs() {
  let files;
  try { files = fs.readdirSync(HERE('.')).filter((f) => /^bot2\.\d{8}-\d{6}\.log$/.test(f)).sort(); }
  catch { return {}; }
  const ev = {};
  let prevSod = -1, dayBase = 0;
  const get = (k) => (ev[k] ||= { accept: null, acceptWall: null, delivers: [], fulfill: null, fulfillWall: null, good: null, dest: null, units: null, pay: null, ship: null });
  for (const file of files) {
    let text; try { text = fs.readFileSync(HERE('./' + file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const tm = line.match(/^(\d\d):(\d\d):(\d\d)\s/);
      if (!tm) continue;
      const sod = (+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3]);
      if (prevSod >= 0 && sod < prevSod - 7200) dayBase += 86400;
      prevSod = sod;
      const t = dayBase + sod, wall = tm[0].trim();
      let m;
      if ((m = line.match(/📜 contract (\S+): (\d+) (\w+) -> (\S+) pay (\d+)/))) {
        const e = get(id6(m[1]));
        if (e.accept == null) { e.accept = t; e.acceptWall = wall; }
        e.units = +m[2]; e.good = m[3]; e.dest = m[4]; e.pay = +m[5];
      } else if ((m = line.match(/📦 (\S+) delivered (\d+) (\w+) → contract (\w+)/))) {
        const e = get(m[4]); e.delivers.push({ t, wall, ship: m[1], units: +m[2] }); e.good ||= m[3]; e.ship = m[1];
      } else if ((m = line.match(/(\S+) FULFILLED (\S+) credits=(\d+)/))) {
        const e = get(id6(m[2])); e.fulfill = t; e.fulfillWall = wall; e.ship = m[1].split('-').pop();
      }
    }
  }
  return ev;
}

// ---- optional API enrichment (only with --live) ----------------------------
async function fetchLive() {
  const tok = fs.readFileSync(HERE('./.tok2'), 'utf8').trim();
  const H = { Authorization: 'Bearer ' + tok }, B = 'https://api.spacetraders.io/v2';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gg = async (p) => { for (let a = 0; a < 8; a++) { const res = await fetch(B + p, { headers: H }); if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(((j?.error?.data?.retryAfter ?? 1) * 1000) + 60); continue; } const j = await res.json().catch(() => ({})); await sleep(150); return j; } return {}; };
  const all = [];
  const first = await gg('/my/contracts?limit=20&page=1');
  all.push(...(first.data || []));
  const total = first.meta?.total ?? all.length;
  const pages = Math.ceil(total / 20);
  for (let p = 2; p <= pages; p++) { const j = await gg('/my/contracts?limit=20&page=' + p); all.push(...(j.data || [])); }
  return all;
}

// ---- render ----------------------------------------------------------------
async function render() {
  const ev = parseLogs();
  const status = readJSON('./bot-status.json') || {};
  const live = liveContracts;                          // null unless --live
  const nowU = Date.now();

  // Build a row from a log-event record (e) and/or a live API contract (c). Either may be absent.
  const mkRow = (id, e, c) => {
    e = e || {}; const ful = (e.delivers || []).reduce((s, d) => s + d.units, 0);
    const dlv = c?.terms?.deliver?.[0];
    const stat = c ? (c.fulfilled ? 'FULFILLED' : c.accepted ? 'ACTIVE' : (Date.parse(c.terms.deadline) < nowU ? 'EXPIRED' : 'OFFERED'))
                   : (e.fulfill != null ? 'FULFILLED' : 'ACTIVE');
    return {
      id, type: c?.type || 'PROCUREMENT', good: dlv?.tradeSymbol || e.good, dest: dlv?.destinationSymbol || e.dest,
      req: dlv?.unitsRequired ?? e.units, ful: dlv?.unitsFulfilled ?? ful,
      payout: c ? Math.round((c.terms.payment.onAccepted || 0) + (c.terms.payment.onFulfilled || 0)) : e.pay,
      status: stat, deadline: c?.terms?.deadline || null, e,
      cycle: (e.accept != null && e.fulfill != null) ? e.fulfill - e.accept : null,
    };
  };
  // Canonical order: API order (oldest→newest) when --live, else log/creation order.
  const rows = live
    ? live.map((c) => mkRow(id6(c.id), ev[id6(c.id)], c))
    : Object.entries(ev).map(([id, e]) => mkRow(id, e, null));

  const out = [];
  const src = live ? `${C.y}LIVE+log${C.r}` : `${C.g}local-only, no API${C.r}`;
  out.push(`${C.b}=== CONTRACT LIFECYCLE — SPACEJAM-DK-2 ===${C.r}  ${C.d}${new Date().toLocaleTimeString()} · ${src}${C.r}`);
  const age = status.updated ? Math.round((nowU - Date.parse(status.updated)) / 1000) : null;
  if (status.credits != null) out.push(`credits ${C.b}${money(status.credits)}${C.r}   runNet ${C.g}+${money(status.runNet)}${C.r}   ${C.d}status ${age != null ? dur(age) + ' old' : 'n/a'}${C.r}`);

  // ---- ACTIVE ----
  const active = rows.filter((r) => r.status === 'ACTIVE' || r.status === 'OFFERED');
  out.push(`\n${C.b}ACTIVE${C.r}`);
  if (!active.length) {
    const last = rows.filter((r) => r.status === 'FULFILLED').slice(-1)[0];
    out.push(`  ${C.d}none — between contracts${last ? ` (last: ${last.good} fulfilled ${last.e.fulfillWall || ''}, cycle ${dur(last.cycle)})` : ''}${C.r}`);
  } else for (const r of active) {
    const tag = r.status === 'OFFERED' ? `${C.d}[offered]${C.r}` : '';
    out.push(`  ${C.c}${r.id}${C.r} ${r.type} ${C.b}${r.good}${C.r} → ${String(r.dest).replace('X1-PP30-', '')} ${tag}`);
    const dl = r.deadline ? `  deadline in ${dur(Math.round((Date.parse(r.deadline) - nowU) / 1000))}` : '';
    out.push(`    ${C.g}${bar(r.ful, r.req)}${C.r} ${r.ful}/${r.req ?? '?'}  payout ${money(r.payout)}${r.e.acceptWall ? `  ${C.d}accepted ${r.e.acceptWall}${C.r}` : ''}${dl}`);
    for (const d of (r.e.delivers || [])) out.push(`      ${C.d}↳ ${d.wall}  ${String(d.ship).split('-').pop()} delivered ${d.units}${C.r}`);
  }
  if (activeOnly) return out.join('\n');

  // ---- LIFECYCLE TABLE ----
  const show = limit === Infinity ? rows : rows.slice(-limit);
  out.push(`\n${C.b}LIFECYCLE${C.r} ${C.d}(last ${show.length} of ${rows.length} seen in logs${live ? ' + API' : ''})${C.r}`);
  out.push(C.d + pad('id', 7) + pad('type', 12) + pad('good', 20) + pad('units', 8) + pad('payout', 10) + pad('accepted', 10) + pad('fulfilled', 10) + pad('cycle', 8) + 'status' + C.r);
  for (const r of show) {
    const stCol = r.status === 'FULFILLED' ? C.g : r.status === 'ACTIVE' ? C.y : r.status === 'EXPIRED' ? C.red : C.d;
    const nd = r.e.delivers?.length > 1 ? ` ${C.d}×${r.e.delivers.length}${C.r}` : '';
    out.push(
      pad(C.c + r.id + C.r, 7) + pad(r.type, 12) + pad(r.good || '—', 20) +
      pad(`${r.ful}/${r.req ?? '?'}`, 8) + pad(money(r.payout), 10) +
      pad(r.e.acceptWall || '—', 10) + pad(r.e.fulfillWall || '—', 10) +
      pad(dur(r.cycle), 8) + stCol + r.status + C.r + nd
    );
  }

  // ---- SUMMARY ----
  const done = rows.filter((r) => r.status === 'FULFILLED');
  const totalPay = done.reduce((s, r) => s + (r.payout || 0), 0);
  const cycles = done.map((r) => r.cycle).filter((x) => x != null);
  const avgCycle = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;
  const byGood = {}; for (const r of done) byGood[r.good] = (byGood[r.good] || 0) + (r.payout || 0);
  const topGood = Object.entries(byGood).sort((a, b) => b[1] - a[1])[0];
  const ftimes = done.map((r) => r.e.fulfill).filter((x) => x != null).sort((a, b) => a - b);
  const span = ftimes.length > 1 ? (ftimes[ftimes.length - 1] - ftimes[0]) / 3600 : 0;
  const perHr = span > 0 ? (ftimes.length - 1) / span : null;
  out.push(`\n${C.b}SUMMARY${C.r} ${C.d}(from ${done.length} logged fulfillments)${C.r}`);
  out.push(`  fulfilled ${C.b}${done.length}${C.r}   total payout ${C.g}${money(totalPay)}${C.r}   avg/contract ${money(done.length ? Math.round(totalPay / done.length) : 0)}`);
  out.push(`  avg cycle ${C.b}${dur(avgCycle)}${C.r}${perHr ? `   throughput ${C.b}~${perHr.toFixed(1)}${C.r}/hr` : ''}${topGood ? `   top earner ${C.mag}${topGood[0]}${C.r} (${money(topGood[1])})` : ''}`);
  return out.join('\n');
}

let liveContracts = null;
async function loop() {
  do {
    if (live) { try { liveContracts = await fetchLive(); } catch { liveContracts = null; } }
    let s; try { s = await render(); } catch (e) { s = 'render error: ' + e.message; }
    if (watch) process.stdout.write('\x1b[2J\x1b[H');
    console.log(s);
    if (watch) await new Promise((r) => setTimeout(r, watch * 1000));
  } while (watch);
}
loop();
