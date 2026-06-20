/**
 * Home-rooted galaxy crawler.
 *
 * BFS-traverses the jump-gate network from the auto-detected home system,
 * perpetually expanding until the whole reachable galaxy is mapped, then keeps
 * it fresh. For each system it records the gate (+ build state), the gate's
 * connections (as directional edges), and market richness (two tiers), and
 * persists everything incrementally so a crash resumes from the DB.
 *
 * Design constraints honored:
 *  - **Gentle background consumer.** Every API call goes through the shared
 *    module-global 2 req/s client AND an internal min-gap pace gate
 *    (`GALAXY_CRAWL_GAP_MS`) so trading ships keep priority. 429 backoff is
 *    handled by the shared client.
 *  - **Unbounded reach.** No node-count guard; the persisted graph + the
 *    {@link pathfind} BFS resolve deep (11–14-hop) targets the old 120-guard cut.
 *  - **Map ahead of visiting.** The `/jump-gate` endpoint returns connections for
 *    systems we have not physically reached, so we enqueue neighbors regardless of
 *    our ability to currently jump there; `reachable` is computed from all-built paths.
 *  - **Resumable + perpetual.** Loads the prior graph on start; when the frontier
 *    drains it re-enqueues the stalest systems forever, at the same gentle pace.
 */

import type { Config, Market, GalaxySystemUpsert, GateEdgeUpsert, SystemRichnessUpsert } from '@st/shared';
import type { PersistenceClient } from '../interfaces.js';
import { scoreRichness, premiumOf, type RankWeights } from './ranking.js';
import { hopDistances, type PathEdge } from './pathfind.js';
import { systemOf } from './home.js';

// ── minimal API shapes (the live game responses we read) ──────────────────────

interface WpItem {
  symbol: string;
  type?: string;
  x?: number;
  y?: number;
  isUnderConstruction?: boolean;
  traits?: Array<{ symbol: string }>;
}
interface SystemResp {
  symbol: string;
  x?: number;
  y?: number;
  waypoints?: WpItem[];
}
interface JumpGateResp {
  connections?: Array<string | { symbol: string }>;
}
interface ShipyardResp {
  shipTypes?: Array<{ type: string }>;
}

// ── in-memory node ────────────────────────────────────────────────────────────

interface SysNode {
  symbol: string;
  x: number | null;
  y: number | null;
  hasGate: boolean;
  gateWp: string | null;
  gateBuilt: boolean;
  conns: string[]; // neighbor system symbols (from last jump-gate read)
  hopsFromHome: number | null;
  reachable: boolean;
  marketplaceCount: number;
  shipyardCount: number;
  importSiteCount: number;
  importGoodsTotal: number;
  premiumShipTypes: string[];
  premiumShipCount: number;
  sellsFueledHull: boolean;
  detailLevel: 'counts' | 'full';
  score: number;
  lastCrawledAt: number; // ms epoch; 0 = never
}

export interface CrawlSummary {
  systems: number;
  builtGates: number;
  reachable: number;
  edges: number;
  topRanked: Array<{ symbol: string; score: number; marketplaceCount: number }>;
}

export interface GalaxyCrawlerDeps {
  api: <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T>;
  persistence: Pick<PersistenceClient, 'getGalaxyGraph' | 'upsertSystems' | 'upsertEdges' | 'upsertRichness'>;
  cfg: Config;
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  homeSystem: string;
}

export interface GalaxyCrawler {
  /** Start the perpetual background loop (map → drain → refresh forever). */
  start(): void;
  /** Signal stop and flush pending writes. */
  stop(): Promise<void>;
  /** Map from the frontier until it drains (one full pass). Returns a summary. */
  runFullPass(): Promise<CrawlSummary>;
  /** Re-enqueue + recrawl up to `max` stalest systems (build-state/richness refresh). */
  refreshStalest(max: number): Promise<number>;
  /** Promote the top-N reachable systems to FULL-tier richness. Returns # upgraded. */
  fullRichnessPass(topN: number): Promise<number>;
  /** Current in-memory summary (for status). */
  snapshot(): CrawlSummary;
  readonly running: boolean;
}

const PREMIUM_PROBE_TYPES = new Set(['SHIP_PROBE', 'PROBE']);

export function createGalaxyCrawler(deps: GalaxyCrawlerDeps): GalaxyCrawler {
  const { api, persistence, cfg, log, sleep, now, homeSystem } = deps;

  const weights: RankWeights = {
    market: cfg.GALAXY_W_MARKET,
    import: cfg.GALAXY_W_IMPORT,
    yard: cfg.GALAXY_W_YARD,
    premium: cfg.GALAXY_W_PREMIUM,
  };
  const gapMs = Math.max(0, cfg.GALAXY_CRAWL_GAP_MS);
  const batchSize = Math.max(1, cfg.GALAXY_CRAWL_BATCH);
  const refreshMs = Math.max(60_000, cfg.GALAXY_REFRESH_MS);

  const nodes = new Map<string, SysNode>();
  const edges = new Map<string, PathEdge & { fromGateWp: string | null; toGateWp: string | null }>(); // key `${from}->${to}`
  const queue: string[] = [];
  const queued = new Set<string>();

  // dirty sets accumulate upserts between flushes
  const dirtySystems = new Set<string>();
  const dirtyEdges = new Set<string>();
  const dirtyRichness = new Set<string>();

  let stopped = false;
  let isRunning = false;
  let lastCallAt = 0;

  // ── pacing: yield priority to trading on the shared 2 req/s account ceiling ──
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const wait = gapMs - (now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
    return fn();
  }
  const get = <T>(path: string): Promise<T> => paced(() => api<T>('GET', path));

  function node(sym: string): SysNode {
    let n = nodes.get(sym);
    if (!n) {
      n = {
        symbol: sym,
        x: null,
        y: null,
        hasGate: false,
        gateWp: null,
        gateBuilt: false,
        conns: [],
        hopsFromHome: null,
        reachable: false,
        marketplaceCount: 0,
        shipyardCount: 0,
        importSiteCount: 0,
        importGoodsTotal: 0,
        premiumShipTypes: [],
        premiumShipCount: 0,
        sellsFueledHull: false,
        detailLevel: 'counts',
        score: 0,
        lastCrawledAt: 0,
      };
      nodes.set(sym, n);
    }
    return n;
  }

  function enqueue(sym: string): void {
    if (queued.has(sym)) return;
    queued.add(sym);
    queue.push(sym);
  }

  function edgeKey(from: string, to: string): string {
    return `${from}->${to}`;
  }

  function upsertEdge(from: string, to: string, fromGateWp: string | null): void {
    const key = edgeKey(from, to);
    const builtFrom = node(from).gateBuilt;
    const builtTo = nodes.get(to)?.gateBuilt ?? false;
    const toGateWp = nodes.get(to)?.gateWp ?? null;
    const existing = edges.get(key);
    const next = {
      fromSystem: from,
      toSystem: to,
      fromGateWp,
      toGateWp,
      builtFrom,
      builtTo,
      traversable: builtFrom && builtTo,
    };
    if (
      !existing ||
      existing.builtFrom !== next.builtFrom ||
      existing.builtTo !== next.builtTo ||
      existing.fromGateWp !== next.fromGateWp ||
      existing.toGateWp !== next.toGateWp
    ) {
      edges.set(key, next);
      dirtyEdges.add(key);
    }
  }

  /** When a system's gate build-state becomes known, refresh `builtTo` on edges INTO it. */
  function refreshInboundEdges(to: string): void {
    for (const [key, e] of edges) {
      if (e.toSystem !== to) continue;
      const builtTo = node(to).gateBuilt;
      const toGateWp = node(to).gateWp;
      if (e.builtTo !== builtTo || e.toGateWp !== toGateWp) {
        e.builtTo = builtTo;
        e.toGateWp = toGateWp;
        e.traversable = Boolean(e.builtFrom) && builtTo;
        dirtyEdges.add(key);
      }
    }
  }

  // ── one system: counts-tier crawl ───────────────────────────────────────────
  async function crawlSystem(sym: string): Promise<void> {
    const n = node(sym);

    // universe coords (best-effort, for the visualization) + quick gate hint
    try {
      const sysResp = await get<{ data: SystemResp }>(`/systems/${sym}`);
      if (typeof sysResp.data?.x === 'number') n.x = sysResp.data.x;
      if (typeof sysResp.data?.y === 'number') n.y = sysResp.data.y;
    } catch {
      /* uncharted/unknown system coords — leave null */
    }

    // paginate waypoints for traits + gate build-state
    let marketplaceCount = 0;
    let shipyardCount = 0;
    let gateWp: string | null = null;
    let gateBuilt = false;
    let hasGate = false;
    for (let page = 1; page <= 15; page++) {
      let batch: WpItem[];
      try {
        batch = (await get<{ data: WpItem[] }>(`/systems/${sym}/waypoints?limit=20&page=${page}`)).data;
      } catch (e) {
        log(`🌌 ${sym} waypoints p${page} ERR ${(e as Error).message}`);
        break;
      }
      if (!batch || batch.length === 0) break;
      for (const w of batch) {
        const traits = w.traits ?? [];
        if (traits.some((t) => t.symbol === 'MARKETPLACE')) marketplaceCount++;
        if (traits.some((t) => t.symbol === 'SHIPYARD')) shipyardCount++;
        if (w.type === 'JUMP_GATE' && !gateWp) {
          gateWp = w.symbol;
          hasGate = true;
          gateBuilt = !w.isUnderConstruction;
        }
      }
      if (batch.length < 20) break;
    }

    const gateBuiltChanged = n.gateBuilt !== gateBuilt;
    n.hasGate = hasGate;
    n.gateWp = gateWp;
    n.gateBuilt = gateBuilt;
    n.marketplaceCount = marketplaceCount;
    n.shipyardCount = shipyardCount;
    n.lastCrawledAt = now();

    // gate connections → directional edges + frontier expansion
    if (gateWp) {
      let conns: string[] = [];
      try {
        const jg = (await get<{ data: JumpGateResp }>(`/systems/${sym}/waypoints/${gateWp}/jump-gate`)).data;
        conns = (jg?.connections ?? []).map((c) => (typeof c === 'string' ? c : c.symbol)).map(systemOf);
      } catch {
        /* under-construction or uncharted gate may not expose connections yet */
      }
      n.conns = conns;
      for (const nb of conns) {
        node(nb); // ensure node exists
        upsertEdge(sym, nb, gateWp);
        enqueue(nb);
      }
    }

    // our own gate build-state may have changed → fix inbound edges' builtTo
    if (gateBuiltChanged) refreshInboundEdges(sym);

    // counts-tier score (premium/import default 0 until a full pass)
    n.score = scoreRichness(
      {
        marketplaceCount: n.marketplaceCount,
        importSiteCount: n.importSiteCount,
        shipyardCount: n.shipyardCount,
        premiumShipCount: n.premiumShipCount,
      },
      weights,
    );

    dirtySystems.add(sym);
    dirtyRichness.add(sym);
  }

  // ── full-tier richness for one system (markets + shipyards) ──────────────────
  async function fullRichness(sym: string): Promise<void> {
    const n = node(sym);
    const marketWps: string[] = [];
    const yardWps: string[] = [];
    for (let page = 1; page <= 15; page++) {
      let batch: WpItem[];
      try {
        batch = (await get<{ data: WpItem[] }>(`/systems/${sym}/waypoints?limit=20&page=${page}`)).data;
      } catch (e) {
        log(`🌌 ${sym} full p${page} ERR ${(e as Error).message}`);
        break;
      }
      if (!batch || batch.length === 0) break;
      for (const w of batch) {
        const traits = w.traits ?? [];
        if (traits.some((t) => t.symbol === 'MARKETPLACE')) marketWps.push(w.symbol);
        if (traits.some((t) => t.symbol === 'SHIPYARD')) yardWps.push(w.symbol);
      }
      if (batch.length < 20) break;
    }

    let importSiteCount = 0;
    let importGoodsTotal = 0;
    for (const wp of marketWps) {
      try {
        const m = (await get<{ data: Market }>(`/systems/${sym}/waypoints/${wp}/market`)).data;
        const imports = m.imports ?? [];
        if (imports.length > 0) importSiteCount++;
        importGoodsTotal += imports.length;
      } catch {
        /* skip unreadable market */
      }
    }

    const premium = new Set<string>();
    let sellsFueledHull = false;
    for (const wp of yardWps) {
      try {
        const sy = (await get<{ data: ShipyardResp }>(`/systems/${sym}/waypoints/${wp}/shipyard`)).data;
        for (const st of sy.shipTypes ?? []) {
          const p = premiumOf(st.type);
          if (p) premium.add(p);
          // any non-probe hull sold locally = a fueled hull we can buy at the target
          if (!PREMIUM_PROBE_TYPES.has(st.type)) sellsFueledHull = true;
        }
      } catch {
        /* shipyard requires a ship in-system to read prices, but ship TYPES are public */
      }
    }

    n.marketplaceCount = marketWps.length;
    n.shipyardCount = yardWps.length;
    n.importSiteCount = importSiteCount;
    n.importGoodsTotal = importGoodsTotal;
    n.premiumShipTypes = [...premium];
    n.premiumShipCount = premium.size;
    n.sellsFueledHull = sellsFueledHull;
    n.detailLevel = 'full';
    n.score = scoreRichness(
      {
        marketplaceCount: n.marketplaceCount,
        importSiteCount: n.importSiteCount,
        shipyardCount: n.shipyardCount,
        premiumShipCount: n.premiumShipCount,
      },
      weights,
    );
    dirtySystems.add(sym);
    dirtyRichness.add(sym);
  }

  // ── reachability + hops (all-built BFS from home) ────────────────────────────
  function recomputeReach(): void {
    const dist = hopDistances([...edges.values()], homeSystem);
    // home is reachable at hop 0 even with no edges yet
    if (!dist.has(homeSystem)) dist.set(homeSystem, 0);
    for (const n of nodes.values()) {
      const hops = dist.get(n.symbol);
      const reachable = hops !== undefined;
      const newHops = hops ?? null;
      if (n.hopsFromHome !== newHops || n.reachable !== reachable) {
        n.hopsFromHome = newHops;
        n.reachable = reachable;
        dirtySystems.add(n.symbol);
      }
    }
  }

  // ── persistence flush ────────────────────────────────────────────────────────
  function systemUpsert(n: SysNode): GalaxySystemUpsert {
    return {
      symbol: n.symbol,
      x: n.x,
      y: n.y,
      hasGate: n.hasGate,
      gateWaypoint: n.gateWp,
      gateBuilt: n.gateBuilt,
      hopsFromHome: n.hopsFromHome,
      reachable: n.reachable,
      isHome: n.symbol === homeSystem,
    };
  }

  async function flush(): Promise<void> {
    if (dirtySystems.size) {
      const rows: GalaxySystemUpsert[] = [...dirtySystems].map((s) => systemUpsert(node(s)));
      dirtySystems.clear();
      try {
        await persistence.upsertSystems(rows);
      } catch (e) {
        log(`🌌 upsertSystems failed (${rows.length}): ${(e as Error).message}`);
      }
    }
    if (dirtyEdges.size) {
      const rows: GateEdgeUpsert[] = [...dirtyEdges].map((k) => {
        const e = edges.get(k)!;
        return {
          fromSystem: e.fromSystem,
          toSystem: e.toSystem,
          fromGateWp: e.fromGateWp,
          toGateWp: e.toGateWp,
          builtFrom: Boolean(e.builtFrom),
          builtTo: Boolean(e.builtTo),
        };
      });
      dirtyEdges.clear();
      try {
        await persistence.upsertEdges(rows);
      } catch (e) {
        log(`🌌 upsertEdges failed (${rows.length}): ${(e as Error).message}`);
      }
    }
    if (dirtyRichness.size) {
      const rows: SystemRichnessUpsert[] = [...dirtyRichness].map((s) => {
        const n = node(s);
        return {
          systemSym: n.symbol,
          marketplaceCount: n.marketplaceCount,
          shipyardCount: n.shipyardCount,
          importSiteCount: n.importSiteCount,
          importGoodsTotal: n.importGoodsTotal,
          premiumShipTypes: n.premiumShipTypes,
          premiumShipCount: n.premiumShipCount,
          sellsFueledHull: n.sellsFueledHull,
          score: n.score,
          detailLevel: n.detailLevel,
        };
      });
      dirtyRichness.clear();
      try {
        await persistence.upsertRichness(rows);
      } catch (e) {
        log(`🌌 upsertRichness failed (${rows.length}): ${(e as Error).message}`);
      }
    }
  }

  // ── resume from DB ────────────────────────────────────────────────────────────
  let loaded = false;
  async function loadFromDb(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const graph = await persistence.getGalaxyGraph();
      for (const s of graph.systems) {
        const n = node(s.symbol);
        n.x = s.x;
        n.y = s.y;
        n.hasGate = s.hasGate;
        n.gateWp = s.gateWaypoint;
        n.gateBuilt = s.gateBuilt;
        n.lastCrawledAt = Date.parse(s.lastCrawledAt) || 0;
        n.hopsFromHome = s.hopsFromHome;
        n.reachable = s.reachable;
      }
      for (const e of graph.edges) {
        edges.set(edgeKey(e.fromSystem, e.toSystem), {
          fromSystem: e.fromSystem,
          toSystem: e.toSystem,
          fromGateWp: e.fromGateWp,
          toGateWp: e.toGateWp,
          builtFrom: e.builtFrom,
          builtTo: e.builtTo,
          traversable: e.traversable,
        });
      }
      if (graph.systems.length) log(`🌌 resumed galaxy map: ${graph.systems.length} systems, ${graph.edges.length} edges`);
    } catch (e) {
      log(`🌌 resume load failed (fresh start): ${(e as Error).message}`);
    }
  }

  // ── passes ────────────────────────────────────────────────────────────────────
  async function runFullPass(): Promise<CrawlSummary> {
    await loadFromDb();
    // seed frontier: never-crawled known systems first, then home
    const never = [...nodes.values()].filter((n) => n.lastCrawledAt === 0).map((n) => n.symbol);
    for (const s of never) enqueue(s);
    enqueue(homeSystem);

    let processed = 0;
    while (queue.length && !stopped) {
      const sym = queue.shift()!;
      queued.delete(sym);
      await crawlSystem(sym);
      processed++;
      if (processed % batchSize === 0) {
        recomputeReach();
        await flush();
        log(`🌌 crawled ${processed} (frontier ${queue.length}, systems ${nodes.size})`);
      }
    }
    recomputeReach();
    await flush();
    return snapshot();
  }

  async function refreshStalest(max: number): Promise<number> {
    await loadFromDb();
    const cutoff = now() - refreshMs;
    const stale = [...nodes.values()]
      .filter((n) => n.lastCrawledAt < cutoff)
      .sort((a, b) => a.lastCrawledAt - b.lastCrawledAt)
      .slice(0, max);
    for (const n of stale) {
      if (stopped) break;
      await crawlSystem(n.symbol);
    }
    if (stale.length) {
      recomputeReach();
      await flush();
    }
    return stale.length;
  }

  async function fullRichnessPass(topN: number): Promise<number> {
    await loadFromDb();
    const candidates = [...nodes.values()]
      .filter((n) => n.reachable)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    let upgraded = 0;
    for (const n of candidates) {
      if (stopped) break;
      await fullRichness(n.symbol);
      upgraded++;
      if (upgraded % batchSize === 0) await flush();
    }
    await flush();
    return upgraded;
  }

  function snapshot(): CrawlSummary {
    let builtGates = 0;
    let reachable = 0;
    for (const n of nodes.values()) {
      if (n.gateBuilt) builtGates++;
      if (n.reachable) reachable++;
    }
    const topRanked = [...nodes.values()]
      .filter((n) => n.reachable)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((n) => ({ symbol: n.symbol, score: n.score, marketplaceCount: n.marketplaceCount }));
    return { systems: nodes.size, builtGates, reachable, edges: edges.size, topRanked };
  }

  // ── perpetual background loop ─────────────────────────────────────────────────
  async function loop(): Promise<void> {
    isRunning = true;
    try {
      await runFullPass();
      // opportunistic full-tier enrich for the best candidates
      if (!stopped) await fullRichnessPass(cfg.GALAXY_FULL_TOP_N);
      // perpetual refresh: stalest-first, forever, at the gentle pace
      while (!stopped) {
        const n = await refreshStalest(batchSize);
        if (n === 0) await sleep(Math.min(refreshMs, 60_000));
      }
    } catch (e) {
      log(`🌌 crawler loop error: ${(e as Error).message}`);
    } finally {
      isRunning = false;
    }
  }

  return {
    start(): void {
      if (isRunning || stopped) return;
      void loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      await flush();
    },
    runFullPass,
    refreshStalest,
    fullRichnessPass,
    snapshot,
    get running(): boolean {
      return isRunning;
    },
  };
}
