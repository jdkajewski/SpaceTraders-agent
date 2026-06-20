import type { GalaxyGraph, GateEdgeDto, GalaxySystemDto, RankedSystem, SystemRichnessDto } from '@st/shared';

/**
 * Detail payload returned by `GET /galaxy/system/:sym`. Composed from the shared
 * DTOs (the API returns this shape inline rather than as a single named DTO).
 */
export interface SystemDetail {
  system: GalaxySystemDto;
  richness: SystemRichnessDto | null;
  edgesOut: GateEdgeDto[];
  edgesIn: GateEdgeDto[];
}

// Same-origin by default (dev server proxies /galaxy → API). Set VITE_API_BASE
// to point a production build at an absolute API origin.
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText} (${path})`);
  }
  return (await res.json()) as T;
}

/** Compact topology: systems (nodes) + gate edges. One call renders the graph. */
export function fetchGraph(): Promise<GalaxyGraph> {
  return getJson<GalaxyGraph>('/galaxy/graph');
}

/**
 * Ranked rich-market systems. The `/galaxy/graph` payload carries no per-node
 * `score`, so we pull richness scores (+ premium-ship flags) from here and merge
 * them onto the graph nodes client-side, keyed by `symbol`.
 */
export function fetchRanked(limit = 500): Promise<RankedSystem[]> {
  return getJson<RankedSystem[]>(`/galaxy/ranked?limit=${String(limit)}`);
}

/** Full detail for one system (richness breakdown + gate edges) for the panel. */
export function fetchSystem(symbol: string): Promise<SystemDetail> {
  return getJson<SystemDetail>(`/galaxy/system/${encodeURIComponent(symbol)}`);
}
