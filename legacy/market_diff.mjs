// Keyed comparison of two market snapshots to gauge "cooldown" recovery.
// Usage: node market_diff.mjs <startFile> <endFile>
// Accepts either a raw {wp:marketData} object or the snap_markets format {ts,markets:{...}}.
import { readFileSync } from 'node:fs';

function load(p) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return j.markets ? j.markets : j;
}
const A = load(process.argv[2]);   // start (depleted)
const B = load(process.argv[3]);   // end (rested)

// Build keyed maps: "WP|GOOD" -> {purchase, sell, supply, activity}
function index(m) {
  const out = {};
  for (const [wp, data] of Object.entries(m)) {
    for (const g of (data.tradeGoods || [])) {
      out[`${wp}|${g.symbol}`] = { p: g.purchasePrice, s: g.sellPrice, supply: g.supply, activity: g.activity, type: g.type };
    }
  }
  return out;
}
const ia = index(A), ib = index(B);
const keys = Object.keys(ia).filter((k) => k in ib);

const SUPPLY_RANK = { SCARCE: 1, LIMITED: 2, MODERATE: 3, HIGH: 4, ABUNDANT: 5 };
let pStartSum = 0, pEndSum = 0, sStartSum = 0, sEndSum = 0;
let purchaseDropped = 0, sellRose = 0, supplyUp = 0, supplyDown = 0;
let supRankStart = 0, supRankEnd = 0;
const supStart = {}, supEnd = {};
for (const k of keys) {
  const a = ia[k], b = ib[k];
  pStartSum += a.p; pEndSum += b.p;
  sStartSum += a.s; sEndSum += b.s;
  if (b.p < a.p) purchaseDropped++;
  if (b.s > a.s) sellRose++;
  const ra = SUPPLY_RANK[a.supply] || 0, rb = SUPPLY_RANK[b.supply] || 0;
  supRankStart += ra; supRankEnd += rb;
  if (rb > ra) supplyUp++; else if (rb < ra) supplyDown++;
  supStart[a.supply] = (supStart[a.supply] || 0) + 1;
  supEnd[b.supply] = (supEnd[b.supply] || 0) + 1;
}
const n = keys.length;
const pct = (a, b) => (((b - a) / a) * 100);
const r2 = (x) => Math.round(x * 100) / 100;

const summary = {
  pairs: n,
  avgPurchase: { start: Math.round(pStartSum / n), end: Math.round(pEndSum / n), pctChange: r2(pct(pStartSum, pEndSum)) },   // negative = cheaper to buy = recovery
  avgSell: { start: Math.round(sStartSum / n), end: Math.round(sEndSum / n), pctChange: r2(pct(sStartSum, sEndSum)) },        // positive = sell higher = recovery
  avgSupplyRank: { start: r2(supRankStart / n), end: r2(supRankEnd / n) },                                                    // higher = more stock
  goodsCheaperToBuy: purchaseDropped, goodsSellHigher: sellRose, goodsSupplyUp: supplyUp, goodsSupplyDown: supplyDown,
  supplyDistStart: supStart, supplyDistEnd: supEnd,
};
console.log('=== MARKET COOLDOWN DIFF (start=depleted, end=rested) ===');
console.log(`matched pairs: ${n}`);
console.log(`avg PURCHASE price: ${summary.avgPurchase.start} -> ${summary.avgPurchase.end} (${summary.avgPurchase.pctChange}%)  [negative = recovery]`);
console.log(`avg SELL price:     ${summary.avgSell.start} -> ${summary.avgSell.end} (${summary.avgSell.pctChange}%)  [positive = recovery]`);
console.log(`avg SUPPLY rank:    ${summary.avgSupplyRank.start} -> ${summary.avgSupplyRank.end}  (1=SCARCE..5=ABUNDANT)`);
console.log(`goods cheaper to buy: ${purchaseDropped}/${n} | goods sell higher: ${sellRose}/${n} | supply up: ${supplyUp} down: ${supplyDown}`);
console.log(`supply dist start: ${JSON.stringify(supStart)}`);
console.log(`supply dist end:   ${JSON.stringify(supEnd)}`);
console.log('JSON ' + JSON.stringify(summary));
