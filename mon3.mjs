// One-shot monitor: active contract, mining colony (B9), FAB_MATS market. Read-only; safe to run anytime.
import fs from 'fs';
const tok = fs.readFileSync(new URL('./.tok2', import.meta.url), 'utf8').trim();
const H = { Authorization: 'Bearer ' + tok };
const B = 'https://api.spacetraders.io/v2';
const g = async (p) => (await (await fetch(B + p, { headers: H })).json());

const all = [];
for (let p = 1; ; p++) { const j = await g('/my/contracts?limit=20&page=' + p); if (!j.data?.length) break; all.push(...j.data); if (j.data.length < 20) break; }
const act = all.filter((c) => c.accepted && !c.fulfilled);
console.log('=== CONTRACT ===');
if (act.length) for (const c of act) { const d = c.terms.deliver[0]; console.log(c.type, d.tradeSymbol, d.unitsFulfilled + '/' + d.unitsRequired, '->', d.destinationSymbol, '| onFulfill', c.terms.payment.onFulfilled); }
else { const recent = all.filter((c) => c.fulfilled).slice(-1)[0]; console.log('no active contract; last fulfilled:', recent ? recent.terms.deliver[0].tradeSymbol : 'n/a'); }

console.log('=== MINING COLONY (B9) ===');
for (const s of ['1', '28', '14', '2F', '30']) {
  const r = await g('/my/ships/SPACEJAM-DK-2-' + s);
  const d = r.data;
  if (!d) { console.log(s.padEnd(3), '(no data:', (r.error?.message || 'unknown') + ')'); continue; }
  const hold = d.cargo.inventory.map((i) => i.units + i.symbol.replace(/_.*/, '')).join(',') || '-';
  console.log(s.padEnd(3), d.nav.status.padEnd(10), d.nav.waypointSymbol.replace('X1-PP30-', '').padEnd(5), 'cargo ' + d.cargo.units + '/' + d.cargo.capacity, hold);
}

console.log('=== FAB_MATS @ F51 ===');
const m = (await g('/systems/X1-PP30/waypoints/X1-PP30-F51/market')).data;
const f = m.tradeGoods.find((x) => x.symbol === 'FAB_MATS');
console.log('buy@' + f.purchasePrice, 'sell@' + f.sellPrice, 'supply=' + f.supply, 'activity=' + f.activity, 'vol=' + f.tradeVolume, '| CAP 3900', f.purchasePrice <= 3900 ? '✅ would buy' : '⛔ paused');
const a = (await g('/my/agent')).data;
if (a) console.log('credits:', a.credits.toLocaleString(), '| floor 1.1M', a.credits >= 1100000 ? '✅' : '⛔ below');
else console.log('credits: (rate-limited read)');
