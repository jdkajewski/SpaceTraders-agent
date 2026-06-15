/**
 * clients/spacetraders.ts — rate-limited SpaceTraders v2 API client.
 *
 * Faithful port of `st.mjs`. The **token bucket is module-global** (CAPACITY 2,
 * REFILL 2/s) and shared across every client instance, so the whole bot honours
 * one ~2 req/s pace regardless of how many subsystems call the API. A 429 sets a
 * module-global `blockedUntil` that pauses *all* callers (server-driven backoff).
 *
 * Retry policy (unchanged from st.mjs):
 *   - 429              → pause-all until `retryAfter` (does not consume a retry).
 *   - network failure  → capped exponential backoff, `min(15s, 500·2^n)`, 8 tries.
 *   - 5xx / 408        → linear backoff `500·(n+1)`, 4 tries.
 *   - other non-2xx    → throw a structured error (`.status/.code/.data/.network`).
 */

import type {
  ApiEnvelope,
  HttpMethod,
  SpaceTradersClient,
  StructuredApiError,
} from '../interfaces.js';
import type { Contract, Ship } from '@st/shared';

const BASE_DEFAULT = 'https://api.spacetraders.io/v2';

// ---- Rate limiter: token bucket, ~2 req/s with a tiny burst, 429-aware --------
// Module-global so all client instances share one pace (matches st.mjs semantics).
const REFILL_PER_SEC = 2;
const CAPACITY = 2;
let tokens = CAPACITY;
let last = Date.now();
let blockedUntil = 0;
let reqCount = 0;

const NET_RETRIES = 8; // transient network failures (internet down, reset, timeout, DNS) → retry with backoff

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function take(): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (blockedUntil > now) {
      await sleep(blockedUntil - now);
      continue;
    }
    tokens = Math.min(CAPACITY, tokens + ((now - last) / 1000) * REFILL_PER_SEC);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / REFILL_PER_SEC) * 1000));
  }
}

/** Test-only: reset the shared token bucket + counters to a known state. */
export function __resetRateLimiter(): void {
  tokens = CAPACITY;
  last = Date.now();
  blockedUntil = 0;
  reqCount = 0;
}

export interface SpaceTradersClientOptions {
  /** Player agent token. Source it from `@st/shared` `Config.SPACETRADERS_PLAYER_AGENT_TOKEN`. */
  token?: string;
  /** API base URL (defaults to the public v2 endpoint). */
  baseUrl?: string;
  /** Injectable fetch (defaults to the global). Eases unit testing. */
  fetchImpl?: typeof fetch;
}

interface ErrorBody {
  error?: { code?: number; message?: string; data?: { retryAfter?: number } & Record<string, unknown> };
}

/**
 * Create a SpaceTraders client. The returned `api` shares the module-global token
 * bucket; only the token/baseUrl/fetch are per-instance.
 */
export function createSpaceTradersClient(opts: SpaceTradersClientOptions = {}): SpaceTradersClient {
  const token = opts.token; // sourced from shared Config (DRIFT #17); no direct process.env read
  if (!token) throw new Error('Missing SPACETRADERS_PLAYER_AGENT_TOKEN');
  const base = opts.baseUrl ?? BASE_DEFAULT;
  const doFetch = opts.fetchImpl ?? fetch;

  async function api<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await take();
      reqCount++;
      let res: Response;
      let text: string;
      try {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        res = await doFetch(`${base}${path}`, init);
        if (res.status === 429) {
          const data = (await res.json().catch(() => ({}))) as ErrorBody;
          const retry = (data?.error?.data?.retryAfter ?? 1) * 1000;
          blockedUntil = Date.now() + retry + 50;
          continue;
        }
        text = await res.text();
      } catch (netErr) {
        // fetch() itself rejected → no HTTP response (internet down / ECONNRESET / ETIMEDOUT / DNS). These are
        // transient: back off (capped exponential) and retry so a brief outage doesn't abort the trip. After
        // NET_RETRIES we throw a tagged error; the worker loop will simply retry the cycle next pass.
        if (attempt < NET_RETRIES) {
          const wait = Math.min(15000, 500 * 2 ** attempt);
          await sleep(wait);
          continue;
        }
        const e = new Error(
          `${method} ${path} -> network error after ${attempt} retries: ${(netErr as Error).message}`,
        ) as StructuredApiError;
        e.status = 0;
        e.network = true;
        throw e;
      }
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        const errBody = json as ErrorBody;
        const code = errBody?.error?.code;
        // Surface but let caller decide; throw with structured info.
        const err = new Error(
          `${method} ${path} -> ${res.status} ${errBody?.error?.message ?? text}`,
        ) as StructuredApiError;
        err.status = res.status;
        if (code !== undefined) err.code = code;
        err.data = errBody?.error?.data;
        if ((res.status >= 500 || res.status === 408) && attempt < 4) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw err;
      }
      return json as T;
    }
  }

  async function getAllShips(): Promise<Ship[]> {
    const ships: Ship[] = [];
    let page = 1;
    for (;;) {
      const r = await api<ApiEnvelope<Ship[]>>('GET', `/my/ships?limit=20&page=${page}`);
      ships.push(...r.data);
      if (!r.meta || ships.length >= r.meta.total) break;
      page++;
    }
    return ships;
  }

  async function getAllContracts(): Promise<Contract[]> {
    const out: Contract[] = [];
    let page = 1;
    for (;;) {
      const r = await api<ApiEnvelope<Contract[]>>('GET', `/my/contracts?limit=20&page=${page}`);
      out.push(...r.data);
      if (!r.meta || out.length >= r.meta.total) break;
      page++;
    }
    return out;
  }

  return { api, getAllShips, getAllContracts, reqStats: () => ({ reqCount }) };
}
