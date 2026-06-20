import { describe, it, expect } from 'vitest';
import type { GalaxyGraph, RankedSystem } from '@st/shared';
import { createGalaxyProvider } from '../provider.js';

const GRAPH: GalaxyGraph = {
  systems: [
    sys('X1-HOME', 'X1-HOME-G'),
    sys('X1-MID', 'X1-MID-G'),
    sys('X1-FAR', 'X1-FAR-G'),
  ],
  edges: [
    edge('X1-HOME', 'X1-MID'),
    edge('X1-MID', 'X1-HOME'),
    edge('X1-MID', 'X1-FAR'),
    edge('X1-FAR', 'X1-MID'),
  ],
};

function sys(symbol: string, gateWaypoint: string) {
  return {
    symbol,
    x: 0,
    y: 0,
    hasGate: true,
    gateWaypoint,
    gateBuilt: true,
    hopsFromHome: 0,
    reachable: true,
    isHome: symbol === 'X1-HOME',
    firstSeenAt: '2024-01-01T00:00:00.000Z',
    lastCrawledAt: '2024-01-01T00:00:00.000Z',
    richnessRefreshedAt: null,
  };
}
function edge(fromSystem: string, toSystem: string) {
  return { fromSystem, toSystem, fromGateWp: null, toGateWp: null, builtFrom: true, builtTo: true, traversable: true };
}

describe('galaxy/provider', () => {
  it('resolves an UNBOUNDED gate path over the cached graph', async () => {
    const provider = createGalaxyProvider({
      api: async () => ({ data: null }) as never,
      persistence: { getGalaxyGraph: async () => GRAPH, getRankedSystems: async () => [] },
      now: () => Date.now(),
    });
    expect(await provider.gatePath('X1-HOME', 'X1-FAR')).toEqual(['X1-HOME', 'X1-MID', 'X1-FAR']);
    expect(await provider.gatePath('X1-HOME', 'X1-NOPE')).toBeNull();
  });

  it('caches the graph (one persistence read within TTL)', async () => {
    let reads = 0;
    const provider = createGalaxyProvider({
      api: async () => ({ data: null }) as never,
      persistence: {
        getGalaxyGraph: async () => {
          reads++;
          return GRAPH;
        },
        getRankedSystems: async () => [],
      },
      now: () => 1000,
    });
    await provider.graph();
    await provider.gatePath('X1-HOME', 'X1-FAR');
    expect(reads).toBe(1);
  });

  it('passes ranked targets through reachable-only', async () => {
    const ranked: RankedSystem[] = [
      { symbol: 'X1-MID', score: 99, hopsFromHome: 1, reachable: true, gateWaypoint: 'X1-MID-G', marketplaceCount: 39, shipyardCount: 2, importSiteCount: 5, premiumShipTypes: ['EXPLORER'], sellsFueledHull: true },
    ];
    let reachableOnly: boolean | undefined;
    const provider = createGalaxyProvider({
      api: async () => ({ data: null }) as never,
      persistence: {
        getGalaxyGraph: async () => GRAPH,
        getRankedSystems: async (_limit, ro) => {
          reachableOnly = ro;
          return ranked;
        },
      },
      now: () => Date.now(),
    });
    const out = await provider.rankedTargets(5);
    expect(out).toEqual(ranked);
    expect(reachableOnly).toBe(true);
  });

  it('finds a local shipyard via a live waypoint read and caches it', async () => {
    let yardCalls = 0;
    const api = async <T,>(_m: string, path: string): Promise<T> => {
      if (/\/waypoints\?/.test(path)) {
        return { data: [{ symbol: 'X1-MID-Y', traits: [{ symbol: 'SHIPYARD' }] }] } as T;
      }
      if (/\/shipyard$/.test(path)) {
        yardCalls++;
        return { data: { shipTypes: [{ type: 'SHIP_LIGHT_HAULER' }, { type: 'SHIP_PROBE' }] } } as T;
      }
      throw new Error('unmocked ' + path);
    };
    const provider = createGalaxyProvider({
      api: api as never,
      persistence: { getGalaxyGraph: async () => GRAPH, getRankedSystems: async () => [] },
      now: () => Date.now(),
    });
    const yard = await provider.shipyardFor('X1-MID');
    expect(yard).toEqual({ wp: 'X1-MID-Y', sells: ['SHIP_LIGHT_HAULER', 'SHIP_PROBE'] });
    await provider.shipyardFor('X1-MID'); // cached → no extra shipyard read
    expect(yardCalls).toBe(1);
  });
});
