#!/usr/bin/env node
// Net-worth estimator for ANY SpaceTraders agent. Read-only.
//   node networth.mjs                      # uses token in ./.tok2
//   node networth.mjs --token <AGENT_TOKEN>
//   ST_TOKEN=<tok> node networth.mjs
//   node networth.mjs --json
// Net worth = credits + fleet value + cargo value.
//  - fleet value: each owned ship valued at the AVERAGE purchase price of its frame across all VISIBLE shipyards
//    (frames not sold anywhere visible fall back to the mean of known frame prices, flagged "~est").
//  - cargo value: each carried good valued at the AVERAGE sellPrice across all VISIBLE markets (price data only
//    shows where the agent has a presence, so we average over what's available).
import fs from 'fs';
import chalk from 'chalk';
import Table from 'cli-table3';
import { program } from 'commander';

program
  .name('networth')
  .description('Net-worth estimator for ANY SpaceTraders agent. Read-only.\n' +
    'Net worth = credits + fleet value + cargo value.\n' +
    '  fleet: each ship valued at the AVERAGE purchase price of its frame across visible shipyards\n' +
    '         (frames not sold anywhere visible fall back to the mean of known frames, flagged ~est).\n' +
    '  cargo: each carried good valued at the AVERAGE sellPrice across visible markets\n' +
    '         (works without full probe coverage; unpriceable goods flagged ~? and valued 0).')
  .option('--token <token>', 'agent token to value (else ST_TOKEN env, else <BOT_DIR>/.tok2)')
  .option('--json', 'output machine-readable JSON')
  .addHelpText('after', `
Environment:
  ST_TOKEN   agent token (used if --token is omitted)
  BOT_DIR    dir holding the fallback .tok2 (default: the session files dir)

Examples:
  node networth.mjs                       value the default agent (.tok2)
  node networth.mjs --token eyJ...         value any coworker's agent
  ST_TOKEN=eyJ... node networth.mjs        same, via env
  node networth.mjs --json                 JSON output for scripting`)
  .parse();
const opts = program.opts();

let TOKEN = opts.token || process.env.ST_TOKEN;
if (!TOKEN) { const BOT_DIR = process.env.BOT_DIR || '/Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files'; try { TOKEN = fs.readFileSync(`${BOT_DIR}/.tok2`, 'utf8').trim(); } catch { /* none */ } }
if (!TOKEN) { console.error(chalk.red('No token. Use --token, ST_TOKEN, or a .tok2 file.')); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN };
const BASE = 'https://api.spacetraders.io/v2';

async function get(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await (await fetch(BASE + path, { headers: H })).json(); if (r.data) return r.data; if (r.error) { if (r.error.code === 404) return null; } } catch { /* retry */ }
    await new Promise((s) => setTimeout(s, 700));
  }
  return null;
}
async function getPaged(path) {
  let out = [], p = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    let page = null;
    for (let i = 0; i < 5; i++) {
      try { const r = await (await fetch(BASE + `${path}${sep}limit=20&page=${p}`, { headers: H })).json(); if (r.data) { page = r.data; break; } } catch { /* retry */ }
      await new Promise((s) => setTimeout(s, 800));
    }
    if (!page || !page.length) break;
    out.push(...page); if (page.length < 20) break; p++;
  }
  return out;
}
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

(async () => {
  const agent = await get('/my/agent');
  if (!agent) { console.error(chalk.red('Could not fetch agent (bad token?)')); process.exit(1); }
  const ships = await getPaged('/my/ships');
  const systems = [...new Set(ships.map((s) => s.nav.systemSymbol))];

  // ---- build shipyard frame prices + market good sell prices across visible waypoints in the agent's systems ----
  const framePrices = {};   // frameSymbol -> [purchasePrice,...]
  const goodSell = {};      // goodSymbol  -> [sellPrice,...]
  for (const sys of systems) {
    const yards = await getPaged(`/systems/${sys}/waypoints?traits=SHIPYARD`);
    for (const y of yards) {
      const sy = await get(`/systems/${sys}/waypoints/${y.symbol}/shipyard`);
      for (const sh of (sy?.ships || [])) { const f = sh.frame?.symbol; if (f && sh.purchasePrice > 0) (framePrices[f] ||= []).push(sh.purchasePrice); }
    }
    const mkts = await getPaged(`/systems/${sys}/waypoints?traits=MARKETPLACE`);
    for (const w of mkts) {
      const m = await get(`/systems/${sys}/waypoints/${w.symbol}/market`);
      for (const g of (m?.tradeGoods || [])) { if (g.sellPrice > 0) (goodSell[g.symbol] ||= []).push(g.sellPrice); }
    }
  }
  const avgFrame = {}; for (const f in framePrices) avgFrame[f] = avg(framePrices[f]);
  const meanFramePrice = avg(Object.values(avgFrame));
  const avgGood = {}; for (const g in goodSell) avgGood[g] = avg(goodSell[g]);

  // ---- fleet value ----
  const byFrame = {};  // frame -> {count, unit, est}
  for (const s of ships) {
    const f = s.frame.symbol;
    byFrame[f] ||= { count: 0, unit: avgFrame[f] ?? meanFramePrice, est: avgFrame[f] === undefined };
    byFrame[f].count++;
  }
  let fleetValue = 0; for (const f in byFrame) fleetValue += byFrame[f].count * byFrame[f].unit;

  // ---- cargo value ----
  const cargoAgg = {};  // good -> units
  for (const s of ships) for (const it of (s.cargo.inventory || [])) cargoAgg[it.symbol] = (cargoAgg[it.symbol] || 0) + it.units;
  let cargoValue = 0; const cargoRows = [];
  for (const [g, u] of Object.entries(cargoAgg)) { const px = avgGood[g] ?? 0; const val = px * u; cargoValue += val; cargoRows.push({ g, u, px, val, est: avgGood[g] === undefined }); }

  const credits = agent.credits;
  const netWorth = credits + fleetValue + cargoValue;

  if (opts.json) {
    console.log(JSON.stringify({ agent: agent.symbol, credits, fleetValue: Math.round(fleetValue), cargoValue: Math.round(cargoValue), netWorth: Math.round(netWorth), ships: ships.length }, null, 2));
    return;
  }

  // ---- output ----
  console.log('\n' + chalk.bold.magenta(` ${agent.symbol}`) + chalk.gray(`  ·  ${ships.length} ships  ·  systems: ${systems.join(', ')}`));
  console.log(chalk.gray(' ' + '─'.repeat(60)));
  const fmt = (n) => chalk.green(Math.round(n).toLocaleString().padStart(14));
  console.log(' ' + chalk.bold('Credits      ') + fmt(credits));
  console.log(' ' + chalk.bold('Fleet value  ') + fmt(fleetValue) + chalk.gray('   (avg shipyard price per frame)'));
  console.log(' ' + chalk.bold('Cargo value  ') + fmt(cargoValue) + chalk.gray('   (avg market sell price)'));
  console.log(chalk.gray(' ' + '─'.repeat(60)));
  console.log(' ' + chalk.bold.yellow('NET WORTH    ') + chalk.bold.greenBright(Math.round(netWorth).toLocaleString().padStart(14)));

  // fleet breakdown
  const ft = new Table({ head: ['Frame', 'Qty', 'Avg unit', 'Subtotal'], style: { head: ['gray'] }, colAligns: ['left', 'right', 'right', 'right'], colWidths: [26, 6, 14, 16] });
  for (const [f, v] of Object.entries(byFrame).sort((a, b) => b[1].count * b[1].unit - a[1].count * a[1].unit))
    ft.push([f.replace('FRAME_', '') + (v.est ? chalk.yellow(' ~est') : ''), v.count, Math.round(v.unit).toLocaleString(), Math.round(v.count * v.unit).toLocaleString()]);
  console.log('\n' + chalk.bold(' FLEET')); console.log(ft.toString());

  // cargo breakdown
  if (cargoRows.length) {
    const ct = new Table({ head: ['Good', 'Units', 'Avg sell', 'Value'], style: { head: ['gray'] }, colAligns: ['left', 'right', 'right', 'right'], colWidths: [26, 8, 12, 14] });
    for (const r of cargoRows.sort((a, b) => b.val - a.val)) ct.push([r.g + (r.est ? chalk.yellow(' ~?') : ''), r.u, Math.round(r.px).toLocaleString(), Math.round(r.val).toLocaleString()]);
    console.log('\n' + chalk.bold(' CARGO')); console.log(ct.toString());
  } else { console.log('\n' + chalk.gray(' CARGO: (empty)')); }
  console.log(chalk.gray(`\n ~est = frame not sold at any visible shipyard (used mean of known frames: ${Math.round(meanFramePrice).toLocaleString()})`));
  console.log(chalk.gray(' ~?  = good not sold at any visible market (valued 0)\n'));
})().catch((e) => console.error('networth error:', e.message));
