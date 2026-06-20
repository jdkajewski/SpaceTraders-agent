/**
 * clients/persistence.ts — typed HTTP client from the bot to the Fastify API.
 *
 * Replaces ALL of the bot's local file I/O (run-stats.json, intents.json,
 * bot-status.json, markets.json, *-history.jsonl, gate-levers.json). The bot
 * never touches disk except via the optional {@link LocalStore} crash-safety hook.
 *
 * Resilience model (per Wave 2 spec):
 *   - run-stats + intents are **critical**: written through to an optional local
 *     store first, then best-effort to the API. Reads prefer the API, fall back to
 *     local on failure. (Full boot reconcile lives in Wave 3 `recovery.ts`.)
 *   - status / markets / *-history are **telemetry**: fire-and-forget with retry +
 *     drop-on-fail so a flaky API never blocks a trade. Append endpoints are
 *     batched (flush on size or time) to match the JSONL append cadence.
 *
 * NOTE (reconciliation): the API base URL, `x-bot-key`, and the SpaceTraders token
 * are not yet part of `@st/shared` `Config`; they are read from options/env here.
 * When Wave 1 lands shared request/response types, fold these in.
 */

import type {
  RunStats,
  Intent,
  GateLevers,
  StatusSnapshot,
  Market,
  MarketHistoryRow,
  TradeObservation,
  MineEvent,
  GalaxyGraph,
  RankedSystem,
  GalaxySystemUpsert,
  GateEdgeUpsert,
  SystemRichnessUpsert,
} from '@st/shared';
import type { HttpMethod, LocalStore, PersistenceClient, Waypoint } from '../interfaces.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'persistence' });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PersistenceClientOptions {
  /** Base URL of the Fastify API. Source it from `@st/shared` `Config.API_BASE_URL`. */
  baseUrl?: string;
  /** Optional shared-secret header (`x-bot-key`). Source it from `Config.BOT_KEY`. */
  botKey?: string;
  /** Injectable fetch (defaults to the global). Eases unit testing. */
  fetchImpl?: typeof fetch;
  /** Crash-safety write-through store for run-stats + intents. */
  local?: LocalStore;
  /** Batch size that triggers an append flush (default 100). */
  batchMaxSize?: number;
  /** Max time (ms) rows wait before an append flush (default 5000). */
  batchMaxMs?: number;
  /** Retry attempts for fire-and-forget writes (default 4). */
  retries?: number;
}

/** Unwrap a `{ data }` envelope if the API wraps responses; else pass through. */
function unwrap<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

/**
 * A simple size/time batcher for append-only endpoints. Accumulates rows and
 * flushes via `flushFn` when the queue hits `maxSize` or `maxMs` elapses.
 */
class Batcher<T> {
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushFn: (rows: T[]) => void,
    private readonly maxSize: number,
    private readonly maxMs: number,
  ) {}

  add(rows: T[]): void {
    if (!rows.length) return;
    this.queue.push(...rows);
    if (this.queue.length >= this.maxSize) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxMs);
      // Don't keep the event loop alive solely for a telemetry flush.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.flushFn(batch);
  }
}

export function createPersistenceClient(opts: PersistenceClientOptions = {}): PersistenceClient {
  const base = (opts.baseUrl ?? 'http://localhost:3000').replace(/\/$/, ''); // from shared Config (DRIFT #17)
  const botKey = opts.botKey; // from shared Config.BOT_KEY; no direct process.env read
  const doFetch = opts.fetchImpl ?? fetch;
  const local = opts.local;
  const retries = opts.retries ?? 4;
  const batchMaxSize = opts.batchMaxSize ?? 100;
  const batchMaxMs = opts.batchMaxMs ?? 5000;

  /** In-flight fire-and-forget writes, awaited by `flush()`. */
  const pending = new Set<Promise<void>>();

  function headers(hasBody: boolean): Record<string, string> {
    return {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(botKey ? { 'x-bot-key': botKey } : {}),
    };
  }

  /** Awaited request; throws on non-2xx (except the caller-handled 404). */
  async function request(method: HttpMethod, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: headers(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return doFetch(`${base}${path}`, init);
  }

  async function getJson<T>(path: string): Promise<T | null> {
    const res = await request('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    const text = await res.text();
    return text ? unwrap<T>(JSON.parse(text)) : null;
  }

  /** Best-effort write: retry with linear backoff, then drop + warn. Tracked by flush(). */
  function fireAndForget(method: HttpMethod, path: string, body: unknown, label: string): void {
    const task = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await request(method, path, body);
          if (res.ok) return;
          if (attempt < retries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          log.warn({ label, status: res.status }, 'telemetry write dropped after retries');
          return;
        } catch (e) {
          if (attempt < retries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          log.warn({ label, err: (e as Error).message }, 'telemetry write dropped after retries');
          return;
        }
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  const marketHistory = new Batcher<MarketHistoryRow>(
    (rows) => fireAndForget('POST', '/market-history', rows, 'market-history'),
    batchMaxSize,
    batchMaxMs,
  );
  const tradeObs = new Batcher<TradeObservation>(
    (rows) => fireAndForget('POST', '/trade-observations', rows, 'trade-observations'),
    batchMaxSize,
    batchMaxMs,
  );
  const mineEvents = new Batcher<MineEvent>(
    (rows) => fireAndForget('POST', '/mine-events', rows, 'mine-events'),
    batchMaxSize,
    batchMaxMs,
  );

  return {
    // ── run-stats (critical) ──────────────────────────────────────────────────
    async getRunStats(): Promise<RunStats | null> {
      try {
        return await getJson<RunStats>('/run-stats');
      } catch (e) {
        if (local) return local.getRunStats();
        throw e;
      }
    },
    async putRunStats(stats: RunStats): Promise<void> {
      if (local) {
        await local.putRunStats(stats);
        fireAndForget('PUT', '/run-stats', stats, 'run-stats');
        return;
      }
      const res = await request('PUT', '/run-stats', stats);
      if (!res.ok) throw new Error(`PUT /run-stats -> ${res.status}`);
    },

    // ── intents (critical) ────────────────────────────────────────────────────
    async getIntents(): Promise<Intent[]> {
      try {
        return (await getJson<Intent[]>('/intents')) ?? [];
      } catch (e) {
        if (local) return local.getIntents();
        throw e;
      }
    },
    async getIntent(shipSym: string): Promise<Intent | null> {
      return getJson<Intent>(`/intents/${shipSym}`);
    },
    async putIntent(intent: Intent): Promise<void> {
      if (local) {
        await local.putIntent(intent);
        fireAndForget('PUT', `/intents/${intent.shipSym}`, intent, 'intent');
        return;
      }
      const res = await request('PUT', `/intents/${intent.shipSym}`, intent);
      if (!res.ok) throw new Error(`PUT /intents/${intent.shipSym} -> ${res.status}`);
    },
    async deleteIntent(shipSym: string): Promise<void> {
      if (local) {
        await local.deleteIntent(shipSym);
        fireAndForget('DELETE', `/intents/${shipSym}`, undefined, 'intent-delete');
        return;
      }
      const res = await request('DELETE', `/intents/${shipSym}`);
      if (!res.ok && res.status !== 404) throw new Error(`DELETE /intents/${shipSym} -> ${res.status}`);
    },

    // ── status (telemetry) ────────────────────────────────────────────────────
    postStatus(snapshot: StatusSnapshot): void {
      fireAndForget('POST', '/status', snapshot, 'status');
    },

    // ── markets (latest snapshot) ─────────────────────────────────────────────
    // The api stores each snapshot as a row `{ waypoint, data, updatedAt }` and the bulk
    // endpoints speak `Array<{ waypoint, data }>` (see `MarketSnapshotSchema` / `BulkPutBody`
    // in packages/api/src/routes/markets.ts). The bot caches markets as a `Record<wp, Market>`,
    // so this client translates between the two shapes on every read/write. (issue #8: sending
    // the bare Record 400s against `BulkPutBody`, and the write is fire-and-forget so it was
    // silently dropped — no market snapshot ever persisted.)
    async getMarkets(): Promise<Record<string, Market>> {
      const rows = (await getJson<Array<{ waypoint: string; data: Market }>>('/markets')) ?? [];
      const out: Record<string, Market> = {};
      for (const r of rows) out[r.waypoint] = r.data;
      return out;
    },
    async getMarket(waypoint: string): Promise<Market | null> {
      // The snapshot row is `{ waypoint, data, updatedAt }`; note `unwrap` already strips a literal
      // top-level `data` field, so tolerate either the unwrapped Market or the raw row.
      const row = await getJson<{ data?: Market } & Partial<Market>>(`/markets/${waypoint}`);
      if (!row) return null;
      return (row.data ?? (row as Market));
    },
    putMarkets(markets: Record<string, Market>): void {
      const body = Object.entries(markets).map(([waypoint, data]) => ({ waypoint, data }));
      fireAndForget('PUT', '/markets', body, 'markets');
    },

    // ── gate-levers (operator control) ────────────────────────────────────────
    async getGateLevers(): Promise<GateLevers | null> {
      return getJson<GateLevers>('/gate-levers');
    },
    async putGateLevers(levers: GateLevers): Promise<void> {
      const res = await request('PUT', '/gate-levers', levers);
      if (!res.ok) throw new Error(`PUT /gate-levers -> ${res.status}`);
    },

    // ── append-only history (batched telemetry) ───────────────────────────────
    appendMarketHistory(rows: MarketHistoryRow[]): void {
      marketHistory.add(rows);
    },
    appendTradeObservations(rows: TradeObservation[]): void {
      tradeObs.add(rows);
    },
    appendMineEvents(rows: MineEvent[]): void {
      mineEvents.add(rows);
    },

    // ── static coords ─────────────────────────────────────────────────────────
    async getWaypoints(): Promise<Waypoint[]> {
      return (await getJson<Waypoint[]>('/waypoints')) ?? [];
    },

    // ── galaxy map (crawler graph + ranked rich systems) ──────────────────────
    async getGalaxyGraph(): Promise<GalaxyGraph> {
      return (await getJson<GalaxyGraph>('/galaxy/graph')) ?? { systems: [], edges: [] };
    },
    async getRankedSystems(limit = 50, reachableOnly = false): Promise<RankedSystem[]> {
      const q = `?limit=${limit}${reachableOnly ? '&reachableOnly=true' : ''}`;
      return (await getJson<RankedSystem[]>(`/galaxy/ranked${q}`)) ?? [];
    },
    async upsertSystems(systems: GalaxySystemUpsert[]): Promise<void> {
      if (!systems.length) return;
      const res = await request('PUT', '/galaxy/systems', systems);
      if (!res.ok) throw new Error(`PUT /galaxy/systems -> ${res.status}`);
    },
    async upsertEdges(edges: GateEdgeUpsert[]): Promise<void> {
      if (!edges.length) return;
      const res = await request('PUT', '/galaxy/edges', edges);
      if (!res.ok) throw new Error(`PUT /galaxy/edges -> ${res.status}`);
    },
    async upsertRichness(rows: SystemRichnessUpsert[]): Promise<void> {
      if (!rows.length) return;
      const res = await request('PUT', '/galaxy/richness', rows);
      if (!res.ok) throw new Error(`PUT /galaxy/richness -> ${res.status}`);
    },

    // ── flush all batchers + pending writes ───────────────────────────────────
    async flush(): Promise<void> {
      marketHistory.flush();
      tradeObs.flush();
      mineEvents.flush();
      await Promise.allSettled([...pending]);
    },
  };
}
