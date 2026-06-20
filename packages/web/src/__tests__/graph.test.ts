import { describe, it, expect } from 'vitest';
import type { GalaxyGraph, GalaxySystemDto, GateEdgeDto, RankedSystem } from '@st/shared';
import {
  buildGraphModel,
  hopsToColor,
  indexRanked,
  MAX_NODE_SIZE,
  MIN_NODE_SIZE,
  NEUTRAL_COLOR,
  scoreToColor,
  scoreToSize,
} from '../graph.js';

function sys(partial: Partial<GalaxySystemDto> & { symbol: string }): GalaxySystemDto {
  return {
    symbol: partial.symbol,
    x: partial.x ?? null,
    y: partial.y ?? null,
    hasGate: partial.hasGate ?? true,
    gateWaypoint: partial.gateWaypoint ?? null,
    gateBuilt: partial.gateBuilt ?? true,
    hopsFromHome: partial.hopsFromHome ?? null,
    reachable: partial.reachable ?? true,
    isHome: partial.isHome ?? false,
    firstSeenAt: '2024-01-01T00:00:00.000Z',
    lastCrawledAt: '2024-01-01T00:00:00.000Z',
    richnessRefreshedAt: null,
  };
}

function edge(from: string, to: string, traversable: boolean): GateEdgeDto {
  return {
    fromSystem: from,
    toSystem: to,
    fromGateWp: null,
    toGateWp: null,
    builtFrom: traversable,
    builtTo: traversable,
    traversable,
  };
}

function ranked(symbol: string, score: number, extra: Partial<RankedSystem> = {}): RankedSystem {
  return {
    symbol,
    score,
    hopsFromHome: extra.hopsFromHome ?? 1,
    reachable: extra.reachable ?? true,
    gateWaypoint: extra.gateWaypoint ?? null,
    marketplaceCount: extra.marketplaceCount ?? 1,
    shipyardCount: extra.shipyardCount ?? 0,
    importSiteCount: extra.importSiteCount ?? 0,
    premiumShipTypes: extra.premiumShipTypes ?? [],
    sellsFueledHull: extra.sellsFueledHull ?? false,
  };
}

describe('scoreToSize', () => {
  it('floors to MIN for zero or no scale', () => {
    expect(scoreToSize(0, 100)).toBe(MIN_NODE_SIZE);
    expect(scoreToSize(50, 0)).toBe(MIN_NODE_SIZE);
  });

  it('reaches MAX at the top score and stays within bounds', () => {
    expect(scoreToSize(100, 100)).toBeCloseTo(MAX_NODE_SIZE);
    const mid = scoreToSize(50, 100);
    expect(mid).toBeGreaterThan(MIN_NODE_SIZE);
    expect(mid).toBeLessThan(MAX_NODE_SIZE);
  });

  it('clamps scores above the max', () => {
    expect(scoreToSize(500, 100)).toBeCloseTo(MAX_NODE_SIZE);
  });
});

describe('scoreToColor', () => {
  it('returns the neutral colour for zero score', () => {
    expect(scoreToColor(0, 100)).toBe(NEUTRAL_COLOR);
    expect(scoreToColor(10, 0)).toBe(NEUTRAL_COLOR);
  });

  it('returns distinct hsl colours across the ramp', () => {
    const low = scoreToColor(10, 100);
    const high = scoreToColor(100, 100);
    expect(low).toMatch(/^hsl\(/);
    expect(high).toMatch(/^hsl\(/);
    expect(low).not.toBe(high);
  });
});

describe('indexRanked', () => {
  it('keys ranked rows by symbol', () => {
    const map = indexRanked([ranked('A', 1), ranked('B', 2)]);
    expect(map.get('B')?.score).toBe(2);
    expect(map.size).toBe(2);
  });
});

describe('buildGraphModel', () => {
  const graph: GalaxyGraph = {
    systems: [
      sys({ symbol: 'HOME', x: 0, y: 0, isHome: true, hopsFromHome: 0 }),
      sys({ symbol: 'A', x: 10, y: 10, hopsFromHome: 1 }),
      sys({ symbol: 'B', x: 20, y: 20, reachable: false, hopsFromHome: null }),
    ],
    edges: [edge('HOME', 'A', true), edge('A', 'B', false), edge('A', 'GHOST', true)],
  };
  const rankedRows: RankedSystem[] = [
    ranked('A', 80, { premiumShipTypes: ['EXPLORER'], sellsFueledHull: true }),
    ranked('HOME', 30),
  ];

  it('merges ranked scores onto nodes and defaults missing richness to 0', () => {
    const model = buildGraphModel(graph, rankedRows);
    const a = model.nodes.find((n) => n.symbol === 'A');
    const b = model.nodes.find((n) => n.symbol === 'B');
    expect(a?.score).toBe(80);
    expect(a?.hasRichness).toBe(true);
    expect(a?.premiumShipTypes).toEqual(['EXPLORER']);
    expect(a?.sellsFueledHull).toBe(true);
    expect(b?.score).toBe(0);
    expect(b?.hasRichness).toBe(false);
  });

  it('computes maxScore from ranked rows', () => {
    expect(buildGraphModel(graph, rankedRows).maxScore).toBe(80);
  });

  it('drops edges that reference unknown nodes', () => {
    const model = buildGraphModel(graph, rankedRows);
    expect(model.edges).toHaveLength(2);
    expect(model.edges.some((e) => e.to === 'GHOST')).toBe(false);
    expect(model.edges.find((e) => e.from === 'A' && e.to === 'B')?.traversable).toBe(false);
  });

  it('uses home colour for the home node regardless of score', () => {
    const model = buildGraphModel(graph, rankedRows);
    const home = model.nodes.find((n) => n.symbol === 'HOME');
    expect(home?.color).toBe('#36d1ff');
  });

  it('flags needsLayout only when a node lacks coords', () => {
    expect(buildGraphModel(graph, rankedRows).needsLayout).toBe(false);
    const missing: GalaxyGraph = { systems: [sys({ symbol: 'P' })], edges: [] };
    expect(buildGraphModel(missing, []).needsLayout).toBe(true);
  });

  it('handles an empty galaxy', () => {
    const model = buildGraphModel({ systems: [], edges: [] }, []);
    expect(model.nodes).toHaveLength(0);
    expect(model.edges).toHaveLength(0);
    expect(model.maxScore).toBe(0);
    expect(model.needsLayout).toBe(false);
  });
});

describe('hopsToColor', () => {
  it('returns neutral for null hops and darkens with distance', () => {
    expect(hopsToColor(null)).toBe(NEUTRAL_COLOR);
    expect(hopsToColor(0)).toMatch(/^hsl\(/);
    expect(hopsToColor(0)).not.toBe(hopsToColor(5));
  });
});
