import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpaceTradersClient, __resetRateLimiter } from '../clients/spacetraders.js';
import type { StructuredApiError } from '../interfaces.js';
import { makeRes } from './fixtures.js';

const okEnvelope = { data: {}, meta: { total: 0, page: 1, limit: 20 } };

describe('spacetraders client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    __resetRateLimiter();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paces requests via the shared token bucket (cap 2, refill 2/s)', async () => {
    const callTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      callTimes.push(Date.now());
      return makeRes(200, okEnvelope);
    });
    const c = createSpaceTradersClient({ token: 't', fetchImpl });

    const p = Promise.all([
      c.api('GET', '/a'),
      c.api('GET', '/b'),
      c.api('GET', '/c'),
      c.api('GET', '/d'),
    ]);
    await vi.runAllTimersAsync();
    await p;

    // First two consume the burst immediately; then 1 token / 500ms.
    expect(callTimes[0]).toBe(0);
    expect(callTimes[1]).toBe(0);
    expect(callTimes[2]).toBeGreaterThanOrEqual(500);
    expect(callTimes[3]).toBeGreaterThanOrEqual(1000);
    expect(c.reqStats().reqCount).toBe(4);
  });

  it('pauses all callers on 429 until retryAfter', async () => {
    const callTimes: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      callTimes.push(Date.now());
      n++;
      if (n === 1) return makeRes(429, { error: { data: { retryAfter: 2 } } });
      return makeRes(200, okEnvelope);
    });
    const c = createSpaceTradersClient({ token: 't', fetchImpl });

    const p = c.api('GET', '/x');
    await vi.runAllTimersAsync();
    await p;

    expect(callTimes[0]).toBe(0);
    // blockedUntil = now + retryAfter*1000 + 50 → retried at ≥ 2050ms.
    expect(callTimes[1]).toBeGreaterThanOrEqual(2050);
  });

  it('retries network failures with capped backoff, then throws a tagged error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const c = createSpaceTradersClient({ token: 't', fetchImpl });

    const caught = c.api('GET', '/x').catch((e: StructuredApiError) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect((err as StructuredApiError).network).toBe(true);
    expect((err as StructuredApiError).status).toBe(0);
    // attempts 0..7 retry (8), attempt 8 throws → 9 fetch calls.
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('retries 5xx up to 4 times then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n <= 2) return makeRes(500, { error: { message: 'boom' } });
      return makeRes(200, okEnvelope);
    });
    const c = createSpaceTradersClient({ token: 't', fetchImpl });

    const p = c.api('GET', '/x');
    await vi.runAllTimersAsync();
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('tags structured errors on non-retryable 4xx', async () => {
    const fetchImpl = vi.fn(async () =>
      makeRes(400, { error: { code: 4216, message: 'bad', data: { foo: 1 } } }),
    );
    const c = createSpaceTradersClient({ token: 't', fetchImpl });

    const caught = c.api('GET', '/x').catch((e: StructuredApiError) => e);
    await vi.runAllTimersAsync();
    const err = (await caught) as StructuredApiError;

    expect(err.status).toBe(400);
    expect(err.code).toBe(4216);
    expect(err.data).toEqual({ foo: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
