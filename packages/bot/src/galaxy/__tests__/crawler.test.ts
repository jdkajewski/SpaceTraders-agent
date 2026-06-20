import { describe, it, expect } from 'vitest';
import { loadConfig, type GalaxyGraph, type GalaxySystemUpsert, type GateEdgeUpsert, type SystemRichnessUpsert } from '@st/shared';
import { createGalaxyCrawler } from '../crawler.js';

// ── a tiny fixture galaxy ────────────────────────────────────────────────────
//   X1-HOME ──┬─→ X1-MID ──→ X1-FAR        (all gates BUILT)
//             └─→ X1-DEAD                  (gate UNDER CONSTRUCTION → unreachable)
type Waypoint = { symbol: string; type?: string; isUnderConstruction?: boolean; traits?: Array<{ symbol: string }> };
const mk = (symbol: string, type?: string, traits: string[] = [], isUnderConstruction = false): Waypoint => {
  const w: Waypoint = { symbol, traits: traits.map((t) => ({ symbol: t })) };
  if (type !== undefined) w.type = type;
  if (isUnderConstruction) w.isUnderConstruction = true;
  return w;
};

const WP: Record<string, Waypoint[]> = {
  'X1-HOME': [mk('X1-HOME-G', 'JUMP_GATE'), mk('X1-HOME-M', undefined, ['MARKETPLACE'])],
  'X1-MID': [
    mk('X1-MID-G', 'JUMP_GATE'),
    mk('X1-MID-M1', undefined, ['MARKETPLACE']),
    mk('X1-MID-M2', undefined, ['MARKETPLACE']),
    mk('X1-MID-Y', undefined, ['SHIPYARD', 'MARKETPLACE']),
  ],
  'X1-FAR': [mk('X1-FAR-G', 'JUMP_GATE'), mk('X1-FAR-M', undefined, ['MARKETPLACE'])],
  'X1-DEAD': [mk('X1-DEAD-G', 'JUMP_GATE', [], true)],
};
const CONN: Record<string, string[]> = {
  'X1-HOME-G': ['X1-MID-G', 'X1-DEAD-G'],
  'X1-MID-G': ['X1-HOME-G', 'X1-FAR-G'],
  'X1-FAR-G': ['X1-MID-G'],
  'X1-DEAD-G': [],
};
const MARKET: Record<string, { imports?: Array<{ symbol: string }> }> = {
  'X1-MID-M1': { imports: [{ symbol: 'IRON' }, { symbol: 'COPPER' }] },
  'X1-MID-M2': { imports: [{ symbol: 'FUEL' }] },
  'X1-MID-Y': { imports: [] },
};
const SHIPYARD: Record<string, { shipTypes?: Array<{ type: string }> }> = {
  'X1-MID-Y': { shipTypes: [{ type: 'SHIP_LIGHT_HAULER' }, { type: 'SHIP_EXPLORER' }, { type: 'SHIP_PROBE' }] },
};

function buildApi(conn: Record<string, string[]> = CONN, wp: Record<string, Waypoint[]> = WP) {
  let calls = 0;
  const api = async <T = unknown>(_method: string, path: string): Promise<T> => {
    calls++;
    let m: RegExpExecArray | null;
    if ((m = /^\/systems\/([^/?]+)$/.exec(path))) return { data: { symbol: m[1], x: 10, y: 20 } } as T;
    if ((m = /^\/systems\/([^/]+)\/waypoints\?/.exec(path))) {
      const page = Number(/page=(\d+)/.exec(path)?.[1] ?? '1');
      return { data: page === 1 ? (wp[m[1]!] ?? []) : [] } as T;
    }
    if ((m = /\/waypoints\/([^/]+)\/jump-gate$/.exec(path))) return { data: { connections: conn[m[1]!] ?? [] } } as T;
    if ((m = /\/waypoints\/([^/]+)\/market$/.exec(path))) return { data: MARKET[m[1]!] ?? { imports: [] } } as T;
    if ((m = /\/waypoints\/([^/]+)\/shipyard$/.exec(path))) return { data: SHIPYARD[m[1]!] ?? { shipTypes: [] } } as T;
    throw new Error('unmocked ' + path);
  };
  return { api, calls: () => calls };
}

function buildPersistence(initial: GalaxyGraph = { systems: [], edges: [] }) {
  const systems = new Map<string, GalaxySystemUpsert>();
  const edges = new Map<string, GateEdgeUpsert>();
  const richness = new Map<string, SystemRichnessUpsert>();
  return {
    store: { systems, edges, richness },
    client: {
      getGalaxyGraph: async (): Promise<GalaxyGraph> => initial,
      upsertSystems: async (rows: GalaxySystemUpsert[]) => {
        for (const r of rows) systems.set(r.symbol, r);
      },
      upsertEdges: async (rows: GateEdgeUpsert[]) => {
        for (const r of rows) edges.set(`${r.fromSystem}->${r.toSystem}`, r);
      },
      upsertRichness: async (rows: SystemRichnessUpsert[]) => {
        for (const r of rows) richness.set(r.systemSym, r);
      },
    },
  };
}

const cfg = loadConfig({ GALAXY_CRAWL_GAP_MS: '0', GALAXY_CRAWL_BATCH: '2' });
const noop = (): void => {};

describe('galaxy/crawler', () => {
  it('BFS-maps every discovered system + builds directional edges', async () => {
    const { api } = buildApi();
    const p = buildPersistence();
    const crawler = createGalaxyCrawler({
      api,
      persistence: p.client,
      cfg,
      log: noop,
      sleep: async () => {},
      now: () => Date.now(),
      homeSystem: 'X1-HOME',
    });
    const sum = await crawler.runFullPass();
    expect(sum.systems).toBe(4); // HOME, MID, FAR, DEAD all discovered
    // edges HOME→MID, HOME→DEAD, MID→HOME, MID→FAR, FAR→MID
    expect(p.store.edges.has('X1-HOME->X1-MID')).toBe(true);
    expect(p.store.edges.has('X1-MID->X1-FAR')).toBe(true);
  });

  it('computes all-built reachability, excluding under-construction gate systems', async () => {
    const { api } = buildApi();
    const p = buildPersistence();
    const crawler = createGalaxyCrawler({
      api,
      persistence: p.client,
      cfg,
      log: noop,
      sleep: async () => {},
      now: () => Date.now(),
      homeSystem: 'X1-HOME',
    });
    await crawler.runFullPass();
    const sys = (s: string) => p.store.systems.get(s)!;
    expect(sys('X1-HOME').reachable).toBe(true);
    expect(sys('X1-MID').reachable).toBe(true);
    expect(sys('X1-FAR').reachable).toBe(true);
    expect(sys('X1-FAR').hopsFromHome).toBe(2);
    expect(sys('X1-DEAD').reachable).toBe(false); // gate under construction → cannot jump in
    expect(sys('X1-DEAD').gateBuilt).toBe(false);
    // the HOME→DEAD edge exists but is not traversable
    expect(p.store.edges.get('X1-HOME->X1-DEAD')!.builtTo).toBe(false);
  });

  it('paces calls through the min-gap gate (yields to trading)', async () => {
    const { api } = buildApi();
    const p = buildPersistence();
    const waits: number[] = [];
    const paced = loadConfig({ GALAXY_CRAWL_GAP_MS: '500', GALAXY_CRAWL_BATCH: '2' });
    let t = 0;
    const crawler = createGalaxyCrawler({
      api,
      persistence: p.client,
      cfg: paced,
      log: noop,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
      now: () => t,
      homeSystem: 'X1-HOME',
    });
    await crawler.runFullPass();
    // every paced call after the first should have waited ~500ms
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((w) => w <= 500)).toBe(true);
    expect(Math.max(...waits)).toBe(500);
  });

  it('resumes from a previously persisted graph', async () => {
    // home has no gate connections → BFS only crawls HOME; FAR comes from the DB.
    const { api } = buildApi({ 'X1-HOME-G': [] });
    const prior: GalaxyGraph = {
      systems: [
        {
          symbol: 'X1-FAR',
          x: 1,
          y: 2,
          hasGate: true,
          gateWaypoint: 'X1-FAR-G',
          gateBuilt: true,
          hopsFromHome: 2,
          reachable: true,
          isHome: false,
          firstSeenAt: new Date().toISOString(),
          lastCrawledAt: new Date().toISOString(),
          richnessRefreshedAt: null,
        },
      ],
      edges: [],
    };
    const p = buildPersistence(prior);
    const crawler = createGalaxyCrawler({
      api,
      persistence: p.client,
      cfg,
      log: noop,
      sleep: async () => {},
      now: () => Date.now(),
      homeSystem: 'X1-HOME',
    });
    const sum = await crawler.runFullPass();
    expect(sum.systems).toBe(2); // HOME (crawled) + X1-FAR (resumed)
  });

  it('promotes top systems to FULL-tier richness (imports + premium hulls)', async () => {
    const { api } = buildApi();
    const p = buildPersistence();
    const crawler = createGalaxyCrawler({
      api,
      persistence: p.client,
      cfg,
      log: noop,
      sleep: async () => {},
      now: () => Date.now(),
      homeSystem: 'X1-HOME',
    });
    await crawler.runFullPass();
    const upgraded = await crawler.fullRichnessPass(10);
    expect(upgraded).toBeGreaterThan(0);
    const mid = p.store.richness.get('X1-MID')!;
    expect(mid.detailLevel).toBe('full');
    expect(mid.marketplaceCount).toBe(3); // M1, M2, Y(market+yard)
    expect(mid.importSiteCount).toBe(2); // M1 and M2 import goods; Y imports none
    expect(mid.premiumShipTypes).toEqual(expect.arrayContaining(['LIGHT_HAULER', 'EXPLORER']));
    expect(mid.sellsFueledHull).toBe(true);
  });
});
