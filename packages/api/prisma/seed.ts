/**
 * Prisma seed script — `prisma db seed`
 *
 * Populates:
 *  - Waypoint rows from coords.csv (X1-PP30 system geometry)
 *  - RunStats singleton (id = 1, zeroed)
 *  - GateLevers singleton (id = 1, code defaults)
 */

import { PrismaClient } from '../src/generated/prisma/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const prisma = new PrismaClient();
const __dirname = dirname(fileURLToPath(import.meta.url));

function findCoordsCsv(): string {
  // Try relative to this file first, then walk up to find the repo root
  const candidates = [
    resolve(__dirname, '../../coords.csv'),         // packages/api/prisma/ → repo root
    resolve(__dirname, '../../../coords.csv'),       // fallback one more level
    resolve(__dirname, '../../../../coords.csv'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `coords.csv not found. Expected it at repo root relative to ${__dirname}.\n` +
    `Searched: ${candidates.join(', ')}`,
  );
}

function parseCoords(csvPath: string): Array<{ symbol: string; x: number; y: number }> {
  const raw = readFileSync(csvPath, 'utf8').trim().split('\n');
  const rows: Array<{ symbol: string; x: number; y: number }> = [];
  for (const line of raw.slice(1)) {
    // line format: SYMBOL,x,y
    const [symbol, x, y] = line.split(',');
    if (symbol && x !== undefined && y !== undefined) {
      rows.push({ symbol: symbol.trim(), x: +x, y: +y });
    }
  }
  return rows;
}

async function main() {
  console.log('🌱 Seeding database…');

  // ── Waypoints ──────────────────────────────────────────────────────────────
  const csvPath = findCoordsCsv();
  const waypoints = parseCoords(csvPath);
  console.log(`  Upserting ${waypoints.length} waypoints from ${csvPath}`);

  let wpCount = 0;
  for (const wp of waypoints) {
    await prisma.waypoint.upsert({
      where: { symbol: wp.symbol },
      update: { x: wp.x, y: wp.y },
      create: wp,
    });
    wpCount++;
  }
  console.log(`  ✓ ${wpCount} waypoints upserted`);

  // ── RunStats singleton ─────────────────────────────────────────────────────
  await prisma.runStats.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, totalNet: 0, lanesRun: 0 },
  });
  console.log('  ✓ RunStats singleton ready (id=1)');

  // ── GateLevers singleton ───────────────────────────────────────────────────
  const gap = 250_000;
  const floor = 1_500_000;
  await prisma.gateLevers.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, floor, resume: floor + gap, gap, budgetFraction: 0.8 },
  });
  console.log('  ✓ GateLevers singleton ready (id=1)');

  console.log('🌱 Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
