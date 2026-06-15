/**
 * Wave 1 integration tests — run against the compose Postgres (localhost:5432).
 * Uses an isolated Postgres schema per test run to avoid collisions.
 *
 * Each test group builds a fresh Fastify app instance against the test schema.
 * The schema is wiped in beforeEach to guarantee test isolation.
 *
 * Run: DATABASE_URL="postgresql://st:st@localhost:5432/st" pnpm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { PrismaClient } from '../generated/prisma/index.js';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://st:st@localhost:5432/st';
// Use a dedicated test schema to isolate from the default schema
const TEST_SCHEMA = 'test_wave1';
const TEST_DB_URL = `${BASE_URL}?schema=${TEST_SCHEMA}`;

let prisma: PrismaClient;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['NODE_ENV'] = 'test';

  // Create schema + run migrations via prisma migrate deploy (uses DATABASE_URL)
  const { execSync } = await import('node:child_process');
  execSync('pnpm prisma:migrate:deploy', {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  app = await buildApp({ databaseUrl: TEST_DB_URL, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Drop test schema
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Truncate all tables between tests for isolation
  await prisma.$executeRaw`TRUNCATE TABLE "RunStats", "Intent", "StatusSnapshot", "MarketSnapshot", "MarketHistory", "TradeObservation", "MineEvent", "GateLevers", "Waypoint" RESTART IDENTITY CASCADE`;
  // Re-seed singletons
  await prisma.runStats.create({ data: { id: 1, totalNet: 0, lanesRun: 0 } });
  await prisma.gateLevers.create({ data: { id: 1, floor: 1_500_000, resume: 1_750_000, gap: 250_000 } });
});

// ── 1. Health ────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 with db: ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; db: string }>();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
  });
});

// ── 2. RunStats round-trip ───────────────────────────────────────────────────
describe('RunStats', () => {
  it('GET returns seeded singleton', async () => {
    const res = await app.inject({ method: 'GET', url: '/run-stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalNet: number; lanesRun: number }>();
    expect(body.totalNet).toBe(0);
    expect(body.lanesRun).toBe(0);
  });

  it('PUT updates and GET reflects changes', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/run-stats',
      payload: { totalNet: 12345.67, lanesRun: 42 },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/run-stats' });
    const body = get.json<{ totalNet: number; lanesRun: number }>();
    expect(body.totalNet).toBeCloseTo(12345.67);
    expect(body.lanesRun).toBe(42);
  });
});

// ── 3. Intents CRUD ──────────────────────────────────────────────────────────
describe('Intents', () => {
  const SHIP = 'SPACEJAM-DK-2-15';
  const intentBody = {
    phase: 'TRADE',
    good: 'IRON_ORE',
    units: 40,
    buyWp: 'X1-PP30-A1',
    sellWp: 'X1-PP30-B2',
    costBasis: 480.0,
  };

  it('PUT creates intent; GET retrieves it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/intents/${SHIP}`,
      payload: intentBody,
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: `/intents/${SHIP}` });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ shipSym: string; phase: string; good: string }>();
    expect(body.shipSym).toBe(SHIP);
    expect(body.phase).toBe('TRADE');
    expect(body.good).toBe('IRON_ORE');
  });

  it('GET list returns all intents', async () => {
    await app.inject({ method: 'PUT', url: `/intents/${SHIP}`, payload: intentBody });
    await app.inject({
      method: 'PUT',
      url: `/intents/SPACEJAM-DK-2-16`,
      payload: { ...intentBody, good: 'ALUMINUM' },
    });
    const res = await app.inject({ method: 'GET', url: '/intents' });
    const list = res.json<Array<{ shipSym: string }>>();
    expect(list.length).toBe(2);
  });

  it('DELETE removes intent; GET returns 404', async () => {
    await app.inject({ method: 'PUT', url: `/intents/${SHIP}`, payload: intentBody });
    const del = await app.inject({ method: 'DELETE', url: `/intents/${SHIP}` });
    expect(del.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: `/intents/${SHIP}` });
    expect(get.statusCode).toBe(404);
  });
});

// ── 4. GateLevers singleton ──────────────────────────────────────────────────
describe('GateLevers', () => {
  it('GET returns seeded defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/gate-levers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ floor: number; resume: number; gap: number }>();
    expect(body.floor).toBe(1_500_000);
    expect(body.gap).toBe(250_000);
  });

  it('PUT updates lever values; GET reflects changes', async () => {
    await app.inject({
      method: 'PUT',
      url: '/gate-levers',
      payload: { floor: 2_000_000, resume: 2_300_000, gap: 300_000 },
    });
    const res = await app.inject({ method: 'GET', url: '/gate-levers' });
    const body = res.json<{ floor: number }>();
    expect(body.floor).toBe(2_000_000);
  });
});

// ── 5. MarketHistory batch POST → filtered GET ───────────────────────────────
describe('MarketHistory', () => {
  const rows = [
    { waypoint: 'X1-PP30-A1', good: 'IRON_ORE', purchasePrice: 100, sellPrice: 120, tradeVolume: 50, supply: 'MODERATE' },
    { waypoint: 'X1-PP30-A1', good: 'ALUMINUM', purchasePrice: 200, sellPrice: 240, tradeVolume: 30, supply: 'HIGH' },
    { waypoint: 'X1-PP30-B2', good: 'IRON_ORE', purchasePrice: 105, sellPrice: 125, tradeVolume: 45, supply: 'MODERATE' },
  ];

  it('POST batch inserts rows; GET returns them', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/market-history',
      payload: rows,
    });
    expect(post.statusCode).toBe(201);
    expect(post.json<{ inserted: number }>().inserted).toBe(3);

    const get = await app.inject({ method: 'GET', url: '/market-history' });
    expect(get.statusCode).toBe(200);
    expect(get.json<unknown[]>().length).toBe(3);
  });

  it('GET filters by waypoint', async () => {
    await app.inject({ method: 'POST', url: '/market-history', payload: rows });

    const res = await app.inject({
      method: 'GET',
      url: '/market-history?waypoint=X1-PP30-A1',
    });
    expect(res.json<unknown[]>().length).toBe(2);
  });

  it('GET filters by good', async () => {
    await app.inject({ method: 'POST', url: '/market-history', payload: rows });

    const res = await app.inject({
      method: 'GET',
      url: '/market-history?good=IRON_ORE',
    });
    expect(res.json<unknown[]>().length).toBe(2);
  });
});
