/**
 * Galaxy map API integration tests — run against the compose Postgres (localhost:5432).
 * Uses a dedicated Postgres schema to isolate from other test files.
 *
 * Run: DATABASE_URL="postgresql://st:st@localhost:5432/st" pnpm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { PrismaClient } from '../generated/prisma/index.js';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://st:st@localhost:5432/st';
const TEST_SCHEMA = 'test_galaxy';
const TEST_DB_URL = `${BASE_URL}?schema=${TEST_SCHEMA}`;

let prisma: PrismaClient;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['NODE_ENV'] = 'test';

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
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE "SystemRichness", "GateEdge", "System" RESTART IDENTITY CASCADE`;
});

describe('Galaxy systems', () => {
  it('bulk upsert + graph round-trip', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/galaxy/systems',
      payload: [
        { symbol: 'X1-HOME', isHome: true, hasGate: true, gateWaypoint: 'X1-HOME-I1', gateBuilt: true, hopsFromHome: 0, reachable: true },
        { symbol: 'X1-NB1', hasGate: true, gateWaypoint: 'X1-NB1-I1', gateBuilt: true, hopsFromHome: 1, reachable: true },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ upserted: number }>().upserted).toBe(2);

    const graph = await app.inject({ method: 'GET', url: '/galaxy/graph' });
    expect(graph.statusCode).toBe(200);
    const body = graph.json<{ systems: Array<{ symbol: string; isHome: boolean }>; edges: unknown[] }>();
    expect(body.systems).toHaveLength(2);
    expect(body.systems.find((s) => s.symbol === 'X1-HOME')?.isHome).toBe(true);
  });

  it('upsert updates existing rows (not duplicate)', async () => {
    await app.inject({ method: 'PUT', url: '/galaxy/systems', payload: [{ symbol: 'X1-NB1', gateBuilt: false }] });
    await app.inject({ method: 'PUT', url: '/galaxy/systems', payload: [{ symbol: 'X1-NB1', gateBuilt: true }] });
    const get = await app.inject({ method: 'GET', url: '/galaxy/system/X1-NB1' });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ system: { gateBuilt: boolean } }>().system.gateBuilt).toBe(true);
  });

  it('GET /galaxy/systems?reachable filters', async () => {
    await app.inject({
      method: 'PUT',
      url: '/galaxy/systems',
      payload: [
        { symbol: 'X1-R', reachable: true },
        { symbol: 'X1-U', reachable: false },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/galaxy/systems?reachable=true' });
    const body = res.json<Array<{ symbol: string }>>();
    expect(body.map((s) => s.symbol)).toEqual(['X1-R']);
  });

  it('GET /galaxy/system/:sym returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/galaxy/system/X1-NOPE' });
    expect(res.statusCode).toBe(404);
  });
});

describe('Galaxy edges', () => {
  it('derives traversable from built ends and auto-creates referenced systems', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/galaxy/edges',
      payload: [
        { fromSystem: 'X1-A', toSystem: 'X1-B', builtFrom: true, builtTo: true },
        { fromSystem: 'X1-A', toSystem: 'X1-C', builtFrom: true, builtTo: false },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ upserted: number }>().upserted).toBe(2);

    const edges = await app.inject({ method: 'GET', url: '/galaxy/edges' });
    const body = edges.json<Array<{ fromSystem: string; toSystem: string; traversable: boolean }>>();
    expect(body.find((e) => e.toSystem === 'X1-B')?.traversable).toBe(true);
    expect(body.find((e) => e.toSystem === 'X1-C')?.traversable).toBe(false);

    // referenced systems were created
    const systems = await app.inject({ method: 'GET', url: '/galaxy/systems' });
    const syms = systems.json<Array<{ symbol: string }>>().map((s) => s.symbol);
    expect(syms).toEqual(expect.arrayContaining(['X1-A', 'X1-B', 'X1-C']));
  });

  it('re-upsert updates the edge in place', async () => {
    await app.inject({ method: 'PUT', url: '/galaxy/edges', payload: [{ fromSystem: 'X1-A', toSystem: 'X1-B', builtFrom: false, builtTo: true }] });
    await app.inject({ method: 'PUT', url: '/galaxy/edges', payload: [{ fromSystem: 'X1-A', toSystem: 'X1-B', builtFrom: true, builtTo: true }] });
    const edges = await app.inject({ method: 'GET', url: '/galaxy/edges' });
    const body = edges.json<Array<{ traversable: boolean }>>();
    expect(body).toHaveLength(1);
    expect(body[0]!.traversable).toBe(true);
  });
});

describe('Galaxy richness + ranking', () => {
  it('upserts richness and ranks by score desc', async () => {
    await app.inject({
      method: 'PUT',
      url: '/galaxy/systems',
      payload: [
        { symbol: 'X1-RICH', reachable: true },
        { symbol: 'X1-POOR', reachable: true },
        { symbol: 'X1-FAR', reachable: false },
      ],
    });
    await app.inject({
      method: 'PUT',
      url: '/galaxy/richness',
      payload: [
        { systemSym: 'X1-RICH', marketplaceCount: 39, score: 390, premiumShipTypes: ['EXPLORER', 'HEAVY_FREIGHTER'], sellsFueledHull: true },
        { systemSym: 'X1-POOR', marketplaceCount: 3, score: 30 },
        { systemSym: 'X1-FAR', marketplaceCount: 50, score: 500 },
      ],
    });

    const ranked = await app.inject({ method: 'GET', url: '/galaxy/ranked?limit=10' });
    const body = ranked.json<Array<{ symbol: string; score: number; premiumShipTypes: string[] }>>();
    expect(body[0]!.symbol).toBe('X1-FAR'); // highest score overall
    expect(body.map((r) => r.symbol)).toEqual(['X1-FAR', 'X1-RICH', 'X1-POOR']);
    expect(body.find((r) => r.symbol === 'X1-RICH')?.premiumShipTypes).toEqual(['EXPLORER', 'HEAVY_FREIGHTER']);

    const reachable = await app.inject({ method: 'GET', url: '/galaxy/ranked?reachableOnly=true' });
    const rb = reachable.json<Array<{ symbol: string }>>();
    expect(rb.map((r) => r.symbol)).toEqual(['X1-RICH', 'X1-POOR']); // X1-FAR excluded
  });
});
