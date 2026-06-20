/**
 * Galaxy provider — the read surface the AUTO_EXPAND engine consumes in place of
 * the hardcoded outpost list + hand-crawled `gate-graph.json`.
 *
 * Backed by the crawler's persisted galaxy map (served by the API):
 *  - `graph()`         — the whole systems+edges graph (cached) for pathfinding.
 *  - `rankedTargets()` — reachable rich-market systems, best-first, for outpost choice.
 *  - `gatePath()`      — UNBOUNDED all-built gate path (fixes the old 120-node guard).
 *  - `shipyardFor()`   — where a fueled hull can be bought LOCALLY at a target
 *                        (live read; expansion-time + low volume), powering the
 *                        fueled-relay seeding model (buy local probes/traders vs.
 *                        relaying everything from a spiked home yard).
 */

import type { GalaxyGraph, RankedSystem } from '@st/shared';
import { gatePath as bfsGatePath, buildAdjacency, type PathEdge } from './pathfind.js';
import { systemOf } from './home.js';

export interface ShipyardInfo {
  wp: string;
  sells: string[];
}

export interface GalaxyProvider {
  graph: () => Promise<GalaxyGraph>;
  rankedTargets: (limit: number) => Promise<RankedSystem[]>;
  gatePath: (from: string, to: string) => Promise<string[] | null>;
  shipyardFor: (sys: string) => Promise<ShipyardInfo | null>;
}

export interface GalaxyProviderDeps {
  api: <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T>;
  persistence: {
    getGalaxyGraph: () => Promise<GalaxyGraph>;
    getRankedSystems: (limit?: number, reachableOnly?: boolean) => Promise<RankedSystem[]>;
  };
  now: () => number;
  /** Graph cache TTL (ms). Default 60s — fresh enough for expansion, cheap. */
  graphTtlMs?: number;
}

interface WpItem {
  symbol: string;
  type?: string;
  traits?: Array<{ symbol: string }>;
}
interface ShipyardResp {
  shipTypes?: Array<{ type: string }>;
}

export function createGalaxyProvider(deps: GalaxyProviderDeps): GalaxyProvider {
  const { api, persistence, now } = deps;
  const ttl = deps.graphTtlMs ?? 60_000;

  let graphCache: GalaxyGraph | null = null;
  let graphAt = 0;
  let adj: Map<string, string[]> | null = null;
  const yardCache = new Map<string, ShipyardInfo | null>();

  async function graph(): Promise<GalaxyGraph> {
    if (graphCache && now() - graphAt < ttl) return graphCache;
    graphCache = await persistence.getGalaxyGraph();
    graphAt = now();
    adj = buildAdjacency(graphCache.edges as PathEdge[]);
    return graphCache;
  }

  async function rankedTargets(limit: number): Promise<RankedSystem[]> {
    return persistence.getRankedSystems(limit, true);
  }

  async function gatePath(from: string, to: string): Promise<string[] | null> {
    await graph();
    return bfsGatePath(adj ?? new Map(), from, to);
  }

  async function shipyardFor(sys: string): Promise<ShipyardInfo | null> {
    if (yardCache.has(sys)) return yardCache.get(sys) ?? null;
    let found: ShipyardInfo | null = null;
    for (let page = 1; page <= 15; page++) {
      let batch: WpItem[];
      try {
        batch = (await api<{ data: WpItem[] }>('GET', `/systems/${sys}/waypoints?limit=20&page=${page}`)).data;
      } catch {
        break;
      }
      if (!batch || batch.length === 0) break;
      const yard = batch.find((w) => (w.traits ?? []).some((t) => t.symbol === 'SHIPYARD'));
      if (yard) {
        let sells: string[] = [];
        try {
          const sy = (await api<{ data: ShipyardResp }>('GET', `/systems/${systemOf(yard.symbol)}/waypoints/${yard.symbol}/shipyard`)).data;
          sells = (sy.shipTypes ?? []).map((s) => s.type);
        } catch {
          /* shipyard listing needs a ship present for prices, but TYPES are public */
        }
        found = { wp: yard.symbol, sells };
        break;
      }
      if (batch.length < 20) break;
    }
    yardCache.set(sys, found);
    return found;
  }

  return { graph, rankedTargets, gatePath, shipyardFor };
}
