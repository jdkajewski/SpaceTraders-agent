import { api, reqStats } from './st.mjs';
import { writeFileSync } from 'node:fs';

const SYSTEM = 'X1-PP30';
// Waypoints with a stationed ship (probes + traders) so getMarket returns full pricing.
const WAYPOINTS = process.argv.slice(2);

const out = {};
for (const wp of WAYPOINTS) {
  try {
    const r = await api('GET', `/systems/${SYSTEM}/waypoints/${wp}/market`);
    out[wp] = r.data;
    const goods = r.data.tradeGoods?.length ?? 0;
    console.error(`${wp}: ${goods} goods`);
  } catch (e) {
    console.error(`${wp}: ERR ${e.message}`);
  }
}
writeFileSync(new URL('./markets.json', import.meta.url), JSON.stringify(out));
console.error(`done. markets=${Object.keys(out).length} reqs=${reqStats().reqCount}`);
