/**
 * persistence.markets.test.ts — CONTRACT test for the bot↔api markets write-through (issue #8).
 *
 * The bot caches markets as a `Record<wp, Market>`, but the api's bulk `PUT /markets` speaks
 * `BulkPutBody = Array<{ waypoint, data }>` and `GET /markets` returns
 * `Array<{ waypoint, data, updatedAt }>` (see packages/api/src/routes/markets.ts). Before the fix
 * `putMarkets` sent the bare Record → Fastify schema validation 400 → fire-and-forget dropped it,
 * so no snapshot ever persisted. These tests pin the wire shape on the bot side so the two can't
 * drift apart again: the fake api below validates the body EXACTLY as the api's TypeBox
 * `BulkPutBody` schema would (reject anything that isn't an array of `{ waypoint: string, data }`),
 * and we assert both the PUT body shape and that a written snapshot round-trips back through GET.
 */
import { describe, it, expect } from 'vitest';
import type { Market } from '@st/shared';
import { createPersistenceClient } from '../persistence.js';

/** True iff `body` conforms to the api's `BulkPutBody` (Array<{ waypoint: string, data }>). */
function isBulkPutBody(body: unknown): body is Array<{ waypoint: string; data: unknown }> {
  return (
    Array.isArray(body) &&
    body.every(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as { waypoint?: unknown }).waypoint === 'string' &&
        'data' in (r as object),
    )
  );
}

/**
 * In-memory api that mirrors packages/api/src/routes/markets.ts: bulk PUT validates the body
 * against `BulkPutBody` (400 on mismatch, like Fastify) and upserts by waypoint; GET returns the
 * stored snapshots as `Array<{ waypoint, data, updatedAt }>`.
 */
function makeMarketsApi() {
  const store = new Map<string, Market>();
  const calls: { putBodies: unknown[] } = { putBodies: [] };

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const p = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });

    if (p === '/markets' && method === 'PUT') {
      calls.putBodies.push(body);
      if (!isBulkPutBody(body)) return new Response(JSON.stringify({ error: 'body must be array' }), { status: 400 });
      for (const row of body) store.set(row.waypoint, row.data as Market);
      return json({ upserted: body.length });
    }
    if (p === '/markets' && method === 'GET') {
      const rows = [...store.entries()].map(([waypoint, data]) => ({ waypoint, data, updatedAt: new Date(0).toISOString() }));
      return json(rows);
    }
    if (p.startsWith('/markets/') && method === 'GET') {
      const wp = decodeURIComponent(p.slice('/markets/'.length));
      const data = store.get(wp);
      if (!data) return new Response('', { status: 404 });
      return json({ waypoint: wp, data, updatedAt: new Date(0).toISOString() });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, store, calls };
}

const mkt = (symbol: string): Market => ({ symbol, exports: [{ symbol: 'FUEL' }], tradeGoods: [] });

describe('persistence markets write-through (issue #8 contract)', () => {
  it('putMarkets sends BulkPutBody (Array<{waypoint,data}>), not a Record', async () => {
    const api = makeMarketsApi();
    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, retries: 0 });

    const snapshot: Record<string, Market> = { 'X1-AA1-A1': mkt('X1-AA1-A1'), 'X1-AA1-B2': mkt('X1-AA1-B2') };
    client.putMarkets(snapshot);
    await client.flush();

    expect(api.calls.putBodies).toHaveLength(1);
    const sent = api.calls.putBodies[0];
    expect(isBulkPutBody(sent)).toBe(true); // matches the api schema → would NOT 400
    expect(sent).toEqual([
      { waypoint: 'X1-AA1-A1', data: snapshot['X1-AA1-A1'] },
      { waypoint: 'X1-AA1-B2', data: snapshot['X1-AA1-B2'] },
    ]);
    // …and the write actually persisted (no silent drop).
    expect(api.store.size).toBe(2);
    expect(api.store.get('X1-AA1-A1')).toEqual(mkt('X1-AA1-A1'));
  });

  it('the OLD bare-Record body would be rejected (400) by the BulkPutBody schema — regression guard', () => {
    const recordBody: Record<string, Market> = { 'X1-AA1-A1': mkt('X1-AA1-A1') };
    expect(isBulkPutBody(recordBody)).toBe(false); // exactly why issue #8 dropped the write
  });

  it('GET /markets round-trips: putMarkets → getMarkets reconstitutes the Record', async () => {
    const api = makeMarketsApi();
    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, retries: 0 });

    const snapshot: Record<string, Market> = { 'X1-AA1-A1': mkt('X1-AA1-A1'), 'X1-AA1-B2': mkt('X1-AA1-B2') };
    client.putMarkets(snapshot);
    await client.flush();

    const reread = await client.getMarkets();
    expect(reread).toEqual(snapshot); // array-of-rows folded back into Record<wp, Market>
  });

  it('getMarket(wp) unwraps the snapshot row to a bare Market', async () => {
    const api = makeMarketsApi();
    const client = createPersistenceClient({ baseUrl: 'http://api.test', fetchImpl: api.fetchImpl, retries: 0 });

    client.putMarkets({ 'X1-AA1-A1': mkt('X1-AA1-A1') });
    await client.flush();

    expect(await client.getMarket('X1-AA1-A1')).toEqual(mkt('X1-AA1-A1'));
    expect(await client.getMarket('X1-AA1-ZZ')).toBeNull(); // 404 → null
  });
});
