#!/usr/bin/env node
// Live dashboard for the SpaceTraders bot (SPACEJAM-DK-2). Read-only: live API + local bot files.
// Usage:
//   node status.mjs                 one-shot dashboard
//   node status.mjs -w 30           refresh every 30s (clears screen)
//   node status.mjs --fleet         fleet table only
//   node status.mjs --json          machine-readable JSON
import fs from 'fs';
import chalk from 'chalk';
import Table from 'cli-table3';
import { program } from 'commander';

program
  .name('status')
  .description('Live color-coded dashboard for the SpaceTraders bot: header (phase/run-net/credits/lanes),\n' +
    'GATE construction progress, MINING COLONY summary, and a FLEET table\n' +
    '(ship, role, status, location, route, fuel, cargo, eta, parked). Read-only.')
  .option('-w, --watch <seconds>', 'auto-refresh every N seconds (clears screen)', (v) => parseInt(v, 10))
  .option('--fleet', 'show only the fleet table (skip header/gate/colony)')
  .option('--json', 'output machine-readable JSON instead of tables')
  .addHelpText('after', `
Environment:
  ST_TOKEN   agent token (else read from <BOT_DIR>/.tok2)
  BOT_DIR    dir holding .tok2 + bot-status.json + mine-history.jsonl
             (default: the session files dir)

Examples:
  node status.mjs                 one-shot dashboard
  node status.mjs -w 30           live monitor, refresh every 30s
  node status.mjs --fleet         fleet table only
  node status.mjs --json          JSON snapshot
  BOT_DIR=/path node status.mjs   point at a different bot files dir`)
  .parse();
const opts = program.opts();

const here = (f) => new URL('./' + f, import.meta.url);
// Bot files (token + live status/history) live in the session files dir; override with BOT_DIR env to run elsewhere.
const BOT_DIR = process.env.BOT_DIR || '/Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files';
const botFile = (f) => `${BOT_DIR}/${f}`;
const tok = (process.env.ST_TOKEN || fs.readFileSync(botFile('.tok2'), 'utf8')).trim();
const H = { Authorization: 'Bearer ' + tok };
const BASE = 'https://api.spacetraders.io/v2';
const SYS = 'X1-PP30';
const SH = (w) => (w || '').replace(SYS + '-', '');
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(botFile(f), 'utf8')); } catch { return null; } };

async function get(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await (await fetch(BASE + path, { headers: H })).json(); if (r.data) return r.data; } catch { /* retry */ }
    await new Promise((s) => setTimeout(s, 700));
  }
  return null;
}
async function allShips() {
  let out = [], p = 1;
  for (;;) {
    let page = null;
    for (let i = 0; i < 5; i++) {
      try { const r = await (await fetch(BASE + `/my/ships?limit=20&page=${p}`, { headers: H })).json(); if (r.data) { page = r.data; break; } } catch { /* retry */ }
      await new Promise((s) => setTimeout(s, 800));
    }
    if (!page || !page.length) break;
    out.push(...page); if (page.length < 20) break; p++;
  }
  return out;
}

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
  if (ship.frame.symbol === 'FRAME_PROBE') return 'PROBE';
  return 'TRADE';
}
const isParked = (d) => /no profitable lane|PARKED|idle/i.test(d || '');
const roleColor = (r) => ({ TENDER: chalk.magenta, DRONE: chalk.blue, SURVEYOR: chalk.cyan, FUNNEL: chalk.magentaBright, CONTRACT: chalk.green, GATE: chalk.yellow, TRADE: chalk.white, PROBE: chalk.gray }[r] || chalk.white)(r);
const etaStr = (ship) => {
  if (ship.nav.status !== 'IN_TRANSIT' || !ship.nav.route?.arrival) return '—';
  const x = Math.max(0, Math.round((new Date(ship.nav.route.arrival).getTime() - Date.now()) / 1000));
  return x >= 60 ? `${Math.floor(x / 60)}m${String(x % 60).padStart(2, '0')}s` : x + 's';
};

async function gather() {
  const bs = readJSON('bot-status.json') || {};
  const rs = readJSON('run-stats.json') || {};
  const doingBy = {};
  for (const s of bs.ships || []) doingBy[s.ship.replace(/^-/, '').replace(/^2-/, '')] = s;
  const [agent, ships, gateWp] = await Promise.all([get('/my/agent'), allShips(), get(`/systems/${SYS}/waypoints?type=JUMP_GATE`)]);
  let gate = null; if (gateWp?.[0]) gate = await get(`/systems/${SYS}/waypoints/${gateWp[0].symbol}/construction`);
  const fm = await get(`/systems/${SYS}/waypoints/${SYS}-F51/market`);
  const fab = fm?.tradeGoods?.find((x) => x.symbol === 'FAB_MATS') || null;
  return { bs, rs, doingBy, agent, ships, gate, fab };
}

function render({ bs, rs, doingBy, agent, ships, gate, fab }) {
  const credits = agent ? agent.credits : (bs.credits || 0);
  const net = rs.totalNet ?? bs.runNet ?? 0;
  const mf = bs.mineFeed || {};

  // ---- HEADER ----
  if (!opts.fleet) {
    const credCol = credits >= 1100000 ? chalk.green : credits >= 600000 ? chalk.yellow : chalk.red;
    console.log(chalk.bold.magenta('\n SPACEJAM-DK-2') + chalk.gray('  ·  ') + chalk.cyan(bs.phase || '?') +
      chalk.gray('  ·  ') + 'run net ' + chalk.green.bold('+' + net.toLocaleString()) +
      chalk.gray('  ·  ') + 'credits ' + credCol.bold(credits.toLocaleString()) +
      chalk.gray('  ·  lanes ') + chalk.blue(rs.lanesRun ?? bs.lanesRun ?? '?') +
      chalk.gray('  ·  ' + new Date().toLocaleTimeString()));
  }

  // ---- GATE ----
  if (!opts.fleet && gate) {
    let tot = 0, done = 0; gate.materials.forEach((m) => { tot += m.required; done += m.fulfilled; });
    const op = done / tot, opCol = op >= 0.75 ? chalk.cyan : op >= 0.5 ? chalk.yellow : chalk.red;
    const supplying = bs.gate?.supplying ? chalk.green('SUPPLYING') : chalk.yellow('paused');
    let fabNote = '';
    if (fab) fabNote = '  ·  FAB ' + (fab.purchasePrice <= 3900 ? chalk.green(fab.purchasePrice) : chalk.red(fab.purchasePrice)) + chalk.gray(`/cap3900 (${fab.supply})`);
    console.log('\n' + chalk.bold('GATE  ') + opCol.bold((op * 100).toFixed(1) + '%') + chalk.gray(` (${done}/${tot})  `) + supplying + fabNote);
    const gt = new Table({ head: ['Material', 'Progress', '', 'Have/Need'], style: { head: ['gray'] }, colWidths: [22, 26, 6, 14] });
    for (const m of gate.materials) {
      const pct = m.fulfilled / m.required, w = 22, fill = Math.round(pct * w);
      const col = pct >= 1 ? chalk.green : pct >= 0.75 ? chalk.cyan : pct >= 0.5 ? chalk.yellow : chalk.red;
      gt.push([m.tradeSymbol, col('█'.repeat(fill)) + chalk.gray('░'.repeat(w - fill)), (pct * 100).toFixed(0) + '%', `${m.fulfilled}/${m.required}`]);
    }
    console.log(gt.toString());
  }

  // ---- MINING COLONY ----
  if (!opts.fleet) {
    let feed, ore, surveys = 0;
    try {
      const lines = fs.readFileSync(botFile('mine-history.jsonl'), 'utf8').trim().split('\n').slice(-300).map((l) => JSON.parse(l));
      feed = [...lines].reverse().find((x) => x.ev === 'feed'); ore = [...lines].reverse().find((x) => x.ev === 'ore-sale'); surveys = lines.filter((x) => x.ev === 'survey').length;
    } catch { /* none */ }
    console.log('\n' + chalk.bold('MINING COLONY  ') + chalk.gray('site ') + chalk.cyan(SH(mf.site) || '?') + chalk.gray('  ·  ') + (mf.enabled ? chalk.green('ON') : chalk.gray('off')) +
      chalk.gray('  ·  last feed→F51 ') + (feed ? chalk.green('+' + (feed.revenue || 0).toLocaleString()) : '—') +
      chalk.gray('  ·  last ore→mkt ') + (ore ? chalk.green('+' + (ore.revenue || 0).toLocaleString() + ' ' + (ore.good || '')) : '—') +
      chalk.gray('  ·  surveys ') + surveys);
  }

  // ---- FLEET ----
  const rows = ships.filter((s) => s.cargo.capacity > 0).map((s) => {
    const d = doingBy[s.symbol.slice(-3).replace(/^-/, '')]?.doing || '';
    const role = roleOf(s, d, mf), parked = isParked(d);
    const stShort = { IN_TRANSIT: 'TRANSIT', IN_ORBIT: 'ORBIT', DOCKED: 'DOCKED' }[s.nav.status] || s.nav.status;
    const stCol = s.nav.status === 'IN_TRANSIT' ? chalk.cyan : s.nav.status === 'DOCKED' ? chalk.yellow : chalk.green;
    const route = s.nav.status === 'IN_TRANSIT' && s.nav.route ? `${SH(s.nav.route.origin?.symbol)}→${SH(s.nav.route.destination?.symbol)}` : '—';
    const fp = s.fuel.capacity ? s.fuel.current / s.fuel.capacity : 1;
    const fCol = fp < 0.25 ? chalk.red : fp < 0.5 ? chalk.yellow : chalk.green;
    const inv = (s.cargo.inventory || []).filter((i) => i.symbol !== 'FUEL').map((i) => i.units + i.symbol.replace(/_.*/, '').slice(0, 3)).join(',');
    return { sym: s.symbol.slice(-3), role, stShort, status: s.nav.status, stCol, loc: SH(s.nav.waypointSymbol), route: route.slice(0, 14),
      fuel: s.fuel.capacity ? fCol(`${s.fuel.current}/${s.fuel.capacity}`) : '—', cargo: `${s.cargo.units}/${s.cargo.capacity}${inv ? ' ' + inv : ''}`.slice(0, 23), eta: etaStr(s), parked };
  });
  rows.sort((a, b) => a.role.localeCompare(b.role) || a.sym.localeCompare(b.sym));
  const parkedN = rows.filter((r) => r.parked).length;
  console.log('\n' + chalk.bold('FLEET  ') + chalk.green(`${rows.length - parkedN} working`) + chalk.gray(' · ') + (parkedN ? chalk.red(`${parkedN} parked`) : chalk.gray('0 parked')) + chalk.gray(` · ${rows.length} hulls`));
  const ft = new Table({ head: ['Ship', 'Role', 'Status', 'Loc', 'Route', 'Fuel', 'Cargo', 'ETA', 'Parked'], style: { head: ['gray'] }, wordWrap: false, colWidths: [6, 10, 9, 6, 16, 10, 25, 8, 8] });
  for (const r of rows) ft.push([r.sym, roleColor(r.role), r.stCol(r.stShort), r.loc, r.route, r.fuel, r.cargo, r.eta, r.parked ? chalk.red('● yes') : chalk.gray('—')]);
  console.log(ft.toString());
}

async function once() {
  const data = await gather();
  if (opts.json) {
    const { bs, rs, agent, ships } = data;
    console.log(JSON.stringify({ credits: agent?.credits, runNet: rs.totalNet, phase: bs.phase, ships: ships.filter((s) => s.cargo.capacity > 0).map((s) => ({ sym: s.symbol.slice(-3), status: s.nav.status, loc: SH(s.nav.waypointSymbol), fuel: s.fuel.current, cargo: s.cargo.units })) }, null, 2));
    return;
  }
  render(data);
}

if (opts.watch) {
  const loop = async () => { process.stdout.write('\x1b[2J\x1b[H'); try { await once(); } catch (e) { console.error('err', e.message); } console.log(chalk.gray(`\n  refreshing every ${opts.watch}s — Ctrl-C to stop`)); };
  await loop(); setInterval(loop, opts.watch * 1000);
} else {
  await once();
}
