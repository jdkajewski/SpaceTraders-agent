#!/usr/bin/env node
// Seed the galaxy API with a realistic fixture so the viz works before real
// crawl data exists. Bulk-PUTs to /galaxy/{systems,edges,richness}.
//
//   node scripts/seed-fixtures.mjs            # → http://localhost:3000
//   API_BASE=http://host:3000 node scripts/seed-fixtures.mjs
//
// (Plain .mjs on purpose: a dev tool, not part of the typed/linted src graph.)

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';

/** Home + four hop-rings; a couple of branches stay gated / unreachable. */
const systems = [
  { symbol: 'X1-HOME', x: 0, y: 0, hasGate: true, gateWaypoint: 'X1-HOME-G', gateBuilt: true, hopsFromHome: 0, reachable: true, isHome: true },
  { symbol: 'X1-AA', x: 220, y: 90, hasGate: true, gateWaypoint: 'X1-AA-G', gateBuilt: true, hopsFromHome: 1, reachable: true },
  { symbol: 'X1-AB', x: -180, y: 160, hasGate: true, gateWaypoint: 'X1-AB-G', gateBuilt: true, hopsFromHome: 1, reachable: true },
  { symbol: 'X1-AC', x: 60, y: -240, hasGate: true, gateWaypoint: 'X1-AC-G', gateBuilt: true, hopsFromHome: 1, reachable: true },
  { symbol: 'X1-BA', x: 430, y: 60, hasGate: true, gateWaypoint: 'X1-BA-G', gateBuilt: true, hopsFromHome: 2, reachable: true },
  { symbol: 'X1-BB', x: 360, y: 280, hasGate: true, gateWaypoint: 'X1-BB-G', gateBuilt: true, hopsFromHome: 2, reachable: true },
  { symbol: 'X1-BC', x: -380, y: 240, hasGate: true, gateWaypoint: 'X1-BC-G', gateBuilt: true, hopsFromHome: 2, reachable: true },
  { symbol: 'X1-BD', x: -120, y: -420, hasGate: true, gateWaypoint: 'X1-BD-G', gateBuilt: true, hopsFromHome: 2, reachable: true },
  { symbol: 'X1-CA', x: 640, y: 150, hasGate: true, gateWaypoint: 'X1-CA-G', gateBuilt: true, hopsFromHome: 3, reachable: true },
  { symbol: 'X1-CB', x: 560, y: 430, hasGate: true, gateWaypoint: 'X1-CB-G', gateBuilt: true, hopsFromHome: 3, reachable: true },
  { symbol: 'X1-CC', x: -600, y: 360, hasGate: true, gateWaypoint: 'X1-CC-G', gateBuilt: true, hopsFromHome: 3, reachable: true },
  // Gated frontier: gate to it is not fully built → unreachable from home.
  { symbol: 'X1-GATED', x: 820, y: 320, hasGate: true, gateWaypoint: 'X1-GATED-G', gateBuilt: false, hopsFromHome: null, reachable: false },
  { symbol: 'X1-FAR1', x: 980, y: 200, hasGate: true, gateWaypoint: 'X1-FAR1-G', gateBuilt: false, hopsFromHome: null, reachable: false },
  { symbol: 'X1-FAR2', x: 900, y: 520, hasGate: true, gateWaypoint: 'X1-FAR2-G', gateBuilt: false, hopsFromHome: null, reachable: false },
];

/** Edges: traversable derived server-side from builtFrom && builtTo. */
const edges = [
  ['X1-HOME', 'X1-AA', true, true],
  ['X1-HOME', 'X1-AB', true, true],
  ['X1-HOME', 'X1-AC', true, true],
  ['X1-AA', 'X1-BA', true, true],
  ['X1-AA', 'X1-BB', true, true],
  ['X1-AB', 'X1-BC', true, true],
  ['X1-AC', 'X1-BD', true, true],
  ['X1-BA', 'X1-CA', true, true],
  ['X1-BB', 'X1-CB', true, true],
  ['X1-BC', 'X1-CC', true, true],
  // Frontier: source gate built but destination gate not → not jumpable yet.
  ['X1-CA', 'X1-GATED', true, false],
  ['X1-GATED', 'X1-FAR1', false, false],
  ['X1-GATED', 'X1-FAR2', false, false],
].map(([fromSystem, toSystem, builtFrom, builtTo]) => ({
  fromSystem,
  toSystem,
  fromGateWp: `${fromSystem}-G`,
  toGateWp: `${toSystem}-G`,
  builtFrom,
  builtTo,
}));

/** Richness: a spread of scores, a couple of premium-ship hubs. */
const richness = [
  { systemSym: 'X1-HOME', marketplaceCount: 4, shipyardCount: 1, importSiteCount: 3, importGoodsTotal: 12, premiumShipTypes: ['COMMAND_FRIGATE'], premiumShipCount: 1, sellsFueledHull: true, score: 38.5, detailLevel: 'full' },
  { systemSym: 'X1-AA', marketplaceCount: 6, shipyardCount: 2, importSiteCount: 5, importGoodsTotal: 22, premiumShipTypes: ['HEAVY_FREIGHTER', 'ORE_HOUND'], premiumShipCount: 2, sellsFueledHull: true, score: 72.0, detailLevel: 'full' },
  { systemSym: 'X1-AB', marketplaceCount: 3, shipyardCount: 1, importSiteCount: 2, importGoodsTotal: 9, premiumShipTypes: [], premiumShipCount: 0, sellsFueledHull: false, score: 24.0, detailLevel: 'full' },
  { systemSym: 'X1-AC', marketplaceCount: 2, shipyardCount: 0, importSiteCount: 1, importGoodsTotal: 5, premiumShipTypes: [], premiumShipCount: 0, sellsFueledHull: false, score: 11.5, detailLevel: 'counts' },
  { systemSym: 'X1-BA', marketplaceCount: 7, shipyardCount: 3, importSiteCount: 6, importGoodsTotal: 28, premiumShipTypes: ['EXPLORER', 'REFINING_FREIGHTER', 'LIGHT_HAULER'], premiumShipCount: 3, sellsFueledHull: true, score: 91.0, detailLevel: 'full' },
  { systemSym: 'X1-BB', marketplaceCount: 4, shipyardCount: 1, importSiteCount: 3, importGoodsTotal: 14, premiumShipTypes: ['LIGHT_HAULER'], premiumShipCount: 1, sellsFueledHull: false, score: 41.0, detailLevel: 'full' },
  { systemSym: 'X1-BC', marketplaceCount: 3, shipyardCount: 1, importSiteCount: 2, importGoodsTotal: 8, premiumShipTypes: [], premiumShipCount: 0, sellsFueledHull: false, score: 19.0, detailLevel: 'counts' },
  { systemSym: 'X1-BD', marketplaceCount: 1, shipyardCount: 0, importSiteCount: 0, importGoodsTotal: 2, premiumShipTypes: [], premiumShipCount: 0, sellsFueledHull: false, score: 5.0, detailLevel: 'counts' },
  { systemSym: 'X1-CA', marketplaceCount: 5, shipyardCount: 2, importSiteCount: 4, importGoodsTotal: 18, premiumShipTypes: ['ORE_HOUND'], premiumShipCount: 1, sellsFueledHull: true, score: 63.0, detailLevel: 'full' },
  { systemSym: 'X1-CB', marketplaceCount: 2, shipyardCount: 0, importSiteCount: 1, importGoodsTotal: 4, premiumShipTypes: [], premiumShipCount: 0, sellsFueledHull: false, score: 9.0, detailLevel: 'counts' },
  { systemSym: 'X1-CC', marketplaceCount: 3, shipyardCount: 1, importSiteCount: 2, importGoodsTotal: 10, premiumShipTypes: ['EXPLORER'], premiumShipCount: 1, sellsFueledHull: false, score: 33.0, detailLevel: 'full' },
  // Rich but gated off — the kind of target you'd build toward.
  { systemSym: 'X1-GATED', marketplaceCount: 8, shipyardCount: 3, importSiteCount: 7, importGoodsTotal: 31, premiumShipTypes: ['HEAVY_FREIGHTER', 'COMMAND_FRIGATE'], premiumShipCount: 2, sellsFueledHull: true, score: 88.0, detailLevel: 'full' },
];

async function put(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log(`Seeding galaxy fixtures → ${API_BASE}`);
  const s = await put('/galaxy/systems', systems);
  const e = await put('/galaxy/edges', edges);
  const r = await put('/galaxy/richness', richness);
  console.log(`  systems upserted: ${s.upserted}`);
  console.log(`  edges upserted:   ${e.upserted}`);
  console.log(`  richness upserted: ${r.upserted}`);
  console.log('Done. Start the viz with: pnpm --filter @st/web dev');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
