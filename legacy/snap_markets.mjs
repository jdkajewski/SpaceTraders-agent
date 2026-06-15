// Snapshot every known market's pricing to a JSON file (for the cooldown experiment).
// Usage: SPACETRADERS_PLAYER_AGENT_TOKEN=... node snap_markets.mjs <outFile>
// Reads the market waypoint list from the live markets.json (keys) so it matches what the bot tracks.
import { api, reqStats } from './st.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const SYSTEM = 'X1-PP30';
const out = process.argv[2] || 'snap_markets.out.json';
const wps = Object.keys(JSON.parse(readFileSync(new URL('./markets.json', import.meta.url))));
const res = {};
for (const wp of wps) {
  try { res[wp] = (await api('GET', `/systems/${SYSTEM}/waypoints/${wp}/market`)).data; }
  catch (e) { console.error(`${wp}: ERR ${e.message}`); }
}
writeFileSync(new URL(`./${out}`, import.meta.url), JSON.stringify({ ts: new Date().toISOString(), markets: res }));
console.error(`snap -> ${out}: ${Object.keys(res).length}/${wps.length} markets, reqs=${reqStats().reqCount}`);
