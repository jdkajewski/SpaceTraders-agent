/**
 * crash-safety.test.ts — durable crash-safety verification (Wave 6, spec §6.3 / MASTER-PLAN §6.5).
 *
 * Exercises the REAL persistence client ({@link createPersistenceClient}) write-through wired to a
 * REAL {@link FileLocalStore} (tmp dir) against a controllable in-memory API (an injectable `fetch`
 * with an `up`/`down` toggle). Covers the three failure modes Wave 3 only checked in an ad-hoc
 * harness:
 *   1. API DOWN at saveIntent      → the local store still has the intent (no resume-state loss).
 *   2. API DOWN at boot            → getIntents/loadIntents fall back to the local survivor.
 *   3. API BACK after reconnect    → reconcileLocalToApi pushes the local survivor up (newest-wins)
 *                                    and pulls API-only intents back down to local.
 *
 * Manual operator procedure (documented in packages/bot/README.md): stop the API container mid-run,
 * confirm the bot keeps trading and `.bot-state/intents.json` advances; restart the API and confirm
 * the boot reconcile log (`reconciled N local + M api intent(s)`) and that the DB matches local.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type Intent, type RunStats } from '@st/shared';
import { createPersistenceClient } from '../clients/persistence.js';
import { FileLocalStore, saveIntent, loadIntents, reconcileLocalToApi } from '../recovery.js';
import { createState } from '../runtime/state.js';

const cfg = loadConfig({});

function makeIntent(shipSym: string, good: string): Intent {
  return { shipSym, phase: 'HAULING', good, units: 10, buyWp: 'X1-AA1-BUY', sellWp: 'X1-AA1-SELL', costBasis: 1000, extras: { rideAlongs: [] } };
}

/** Controllable in-memory API: an injectable fetch backed by maps, with an up/down toggle. */
function makeFakeApi() {
  const intents = new Map<string, Intent>();
  let runStats: RunStats | null = null;
  const state = { up: true };

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!state.up) throw new Error('ECONNREFUSED'); // simulate API down
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const p = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const ok = (data: unknown): Response => new Response(data === undefined ? '' : JSON.stringify({ data }), { status: 200 });
    const notFound = (): Response => new Response('', { status: 404 });

    if (p === '/intents' && method === 'GET') return ok([...intents.values()]);
    if (p.startsWith('/intents/')) {
      const ship = decodeURIComponent(p.slice('/intents/'.length));
      if (method === 'PUT') { intents.set(ship, body as Intent); return ok(body); }
      if (method === 'DELETE') { intents.delete(ship); return ok(undefined); }
      if (method === 'GET') { const it = intents.get(ship); return it ? ok(it) : notFound(); }
    }
    if (p === '/run-stats') {
      if (method === 'GET') return runStats ? ok(runStats) : notFound();
      if (method === 'PUT') { runStats = body as RunStats; return ok(body); }
    }
    return notFound();
  }) as unknown as typeof fetch;

  return { fetchImpl, intents, state, getRunStats: () => runStats, setRunStats: (r: RunStats) => { runStats = r; } };
}

describe('crash-safety: intents/run-stats local write-through fallback', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-crash-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('1) API DOWN at saveIntent → the intent survives locally', async () => {
    const api = makeFakeApi();
    api.state.up = false; // API is down for the whole leg
    const local = new FileLocalStore({ dir });
    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, local, retries: 0 });
    const state = createState(cfg);

    await saveIntent(state, client, 'X1-AA1-A1B', { phase: 'HAULING', good: 'GOLD', units: 10, buyWp: 'X1-AA1-BUY', sellWp: 'X1-AA1-SELL', costBasis: 1000 });
    await client.flush(); // drain the (failed) fire-and-forget so nothing leaks into later tests

    // A fresh store reading the same dir proves it hit disk, not just memory.
    const reopened = new FileLocalStore({ dir });
    const survived = await reopened.getIntents();
    expect(survived.map((i) => i.shipSym)).toContain('X1-AA1-A1B');
    expect(api.intents.size).toBe(0); // API never received it
  });

  it('2) API DOWN at boot → loadIntents falls back to the local survivor', async () => {
    const api = makeFakeApi();
    const local = new FileLocalStore({ dir });
    await local.putIntent(makeIntent('X1-AA1-A1B', 'GOLD')); // crash survivor on disk
    api.state.up = false; // API unreachable at boot

    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, local, retries: 0 });
    const state = createState(cfg);
    await loadIntents(state, client); // real boot path

    expect(Object.keys(state.intents)).toContain('X1-AA1-A1B');
    expect(state.intents['X1-AA1-A1B']!.good).toBe('GOLD');
  });

  it('3) API BACK after reconnect → reconcile pushes the local survivor up and pulls API-only intents down', async () => {
    const api = makeFakeApi();
    const local = new FileLocalStore({ dir });

    // Local crash survivor (written while the API was down) + a NEWER local run-stats.
    await local.putIntent(makeIntent('X1-AA1-A1B', 'GOLD'));
    await local.putRunStats({ totalNet: 9000, lanesRun: 5, updatedAt: '2024-01-02T00:00:00.000Z' });

    // API came back holding an intent the local store never saw + an OLDER run-stats.
    api.intents.set('X1-AA1-B2C', makeIntent('X1-AA1-B2C', 'IRON'));
    api.setRunStats({ totalNet: 1000, lanesRun: 1, updatedAt: '2024-01-01T00:00:00.000Z' });

    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, local, retries: 0 });
    await reconcileLocalToApi(client, local);
    await client.flush(); // drain the best-effort PUTs to the API

    // local survivor pushed UP to the API…
    expect([...api.intents.keys()].sort()).toEqual(['X1-AA1-A1B', 'X1-AA1-B2C']);
    // …and the API-only intent pulled DOWN to local.
    const localAfter = await local.getIntents();
    expect(localAfter.map((i) => i.shipSym).sort()).toEqual(['X1-AA1-A1B', 'X1-AA1-B2C']);
    // newest-wins run-stats: local (newer) won on the API side.
    expect(api.getRunStats()?.totalNet).toBe(9000);
  });
});
