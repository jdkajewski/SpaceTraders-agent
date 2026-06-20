import type { GalaxyGraph, RankedSystem } from '@st/shared';

/** Visual sizing/colour bounds, kept here so tests can assert exact behaviour. */
export const MIN_NODE_SIZE = 4;
export const MAX_NODE_SIZE = 20;

/** Colour for a system that has no richness row / a zero score. */
export const NEUTRAL_COLOR = '#5b6472';
/** Colour for the home system (always visually dominant). */
export const HOME_COLOR = '#36d1ff';

/** A renderer-agnostic node model derived purely from the API payloads. */
export interface VizNode {
  symbol: string;
  /** Real coords when the crawler knew them; null → needs force layout. */
  x: number | null;
  y: number | null;
  score: number;
  /** Whether a richness row existed for this system (score is meaningful). */
  hasRichness: boolean;
  size: number;
  color: string;
  reachable: boolean;
  isHome: boolean;
  hopsFromHome: number | null;
  gateBuilt: boolean;
  premiumShipTypes: string[];
  sellsFueledHull: boolean;
}

export interface VizEdge {
  key: string;
  from: string;
  to: string;
  traversable: boolean;
}

export interface GraphModel {
  nodes: VizNode[];
  edges: VizEdge[];
  /** True when at least one node lacks coords → run a force-directed fallback. */
  needsLayout: boolean;
  /** Highest score across nodes (0 when none) — used for legend/normalisation. */
  maxScore: number;
}

/** Index ranked rows by system symbol for an O(1) merge onto graph nodes. */
export function indexRanked(ranked: RankedSystem[]): Map<string, RankedSystem> {
  const map = new Map<string, RankedSystem>();
  for (const r of ranked) map.set(r.symbol, r);
  return map;
}

/** Map a score in `[0, maxScore]` to a node radius. Uses sqrt so area ~ score. */
export function scoreToSize(score: number, maxScore: number): number {
  if (maxScore <= 0 || score <= 0) return MIN_NODE_SIZE;
  const t = Math.sqrt(Math.min(score, maxScore) / maxScore);
  return MIN_NODE_SIZE + t * (MAX_NODE_SIZE - MIN_NODE_SIZE);
}

/**
 * Map a normalised score `t` in `[0, 1]` to a colour along a cool→gold ramp.
 * Low richness reads dim/blue-grey; high richness reads bright gold.
 */
export function scoreToColor(score: number, maxScore: number): string {
  if (maxScore <= 0 || score <= 0) return NEUTRAL_COLOR;
  const t = Math.min(Math.max(score / maxScore, 0), 1);
  // Hue 210° (steel blue) → 45° (gold); rising saturation + lightness.
  const hue = 210 - t * 165;
  const sat = 45 + t * 40;
  const light = 45 + t * 15;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

/**
 * Merge the topology payload with ranked richness scores into a pure, renderer-
 * agnostic model. `score` and premium flags come from `ranked` (the graph
 * endpoint omits them); systems without a ranked/richness row score 0.
 */
export function buildGraphModel(graph: GalaxyGraph, ranked: RankedSystem[]): GraphModel {
  const rankedBySymbol = indexRanked(ranked);

  let maxScore = 0;
  for (const r of ranked) maxScore = Math.max(maxScore, r.score);

  const nodes: VizNode[] = graph.systems.map((s) => {
    const r = rankedBySymbol.get(s.symbol);
    const score = r?.score ?? 0;
    const color = s.isHome ? HOME_COLOR : scoreToColor(score, maxScore);
    return {
      symbol: s.symbol,
      x: s.x,
      y: s.y,
      score,
      hasRichness: r !== undefined,
      size: scoreToSize(score, maxScore),
      color,
      reachable: s.reachable,
      isHome: s.isHome,
      hopsFromHome: s.hopsFromHome,
      gateBuilt: s.gateBuilt,
      premiumShipTypes: r?.premiumShipTypes ?? [],
      sellsFueledHull: r?.sellsFueledHull ?? false,
    };
  });

  const known = new Set(nodes.map((n) => n.symbol));
  const edges: VizEdge[] = graph.edges
    // Drop dangling edges so the renderer never references a missing node.
    .filter((e) => known.has(e.fromSystem) && known.has(e.toSystem))
    .map((e) => ({
      key: `${e.fromSystem}->${e.toSystem}`,
      from: e.fromSystem,
      to: e.toSystem,
      traversable: e.traversable,
    }));

  const needsLayout = nodes.some((n) => n.x === null || n.y === null);

  return { nodes, edges, needsLayout, maxScore };
}

/** Highlight band for the optional "shade by hops" toggle. */
export function hopsToColor(hops: number | null): string {
  if (hops === null) return NEUTRAL_COLOR;
  const capped = Math.min(hops, 8);
  const light = 70 - capped * 6;
  return `hsl(265, 55%, ${light.toFixed(0)}%)`;
}
