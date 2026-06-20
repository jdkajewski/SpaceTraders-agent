import { describe, it, expect } from 'vitest';
import { buildAdjacency, gatePath, hopDistances, type PathEdge } from '../pathfind.js';

/** Build a directed traversable edge (both ends built unless overridden). */
const edge = (from: string, to: string, over: Partial<PathEdge> = {}): PathEdge => ({
  fromSystem: from,
  toSystem: to,
  builtFrom: true,
  builtTo: true,
  ...over,
});

/** A bidirectional pair of traversable edges. */
const link = (a: string, b: string, over: Partial<PathEdge> = {}): PathEdge[] => [edge(a, b, over), edge(b, a, over)];

describe('galaxy/pathfind', () => {
  describe('gatePath', () => {
    it('returns [from] when from === to', () => {
      expect(gatePath([], 'X1-A', 'X1-A')).toEqual(['X1-A']);
    });

    it('finds a direct one-hop path', () => {
      expect(gatePath(link('X1-A', 'X1-B'), 'X1-A', 'X1-B')).toEqual(['X1-A', 'X1-B']);
    });

    it('reaches a DEEP target with NO node guard (the old 120-cap bug)', () => {
      // chain of 200 systems: X1-S0 → X1-S1 → … → X1-S199 (well past the old 120 guard)
      const edges: PathEdge[] = [];
      for (let i = 0; i < 199; i++) edges.push(...link(`X1-S${i}`, `X1-S${i + 1}`));
      const path = gatePath(edges, 'X1-S0', 'X1-S199');
      expect(path).not.toBeNull();
      expect(path).toHaveLength(200);
      expect(path![0]).toBe('X1-S0');
      expect(path![199]).toBe('X1-S199');
    });

    it('treats an UNDER-CONSTRUCTION gate as a dead-end (not traversable)', () => {
      // A→B built, B→C has an unbuilt destination end → C unreachable via that edge
      const edges = [...link('X1-A', 'X1-B'), edge('X1-B', 'X1-C', { builtTo: false }), edge('X1-C', 'X1-B')];
      expect(gatePath(edges, 'X1-A', 'X1-C')).toBeNull();
      // B is still reachable
      expect(gatePath(edges, 'X1-A', 'X1-B')).toEqual(['X1-A', 'X1-B']);
    });

    it('returns null for a disconnected target', () => {
      expect(gatePath(link('X1-A', 'X1-B'), 'X1-A', 'X1-Z')).toBeNull();
    });

    it('prefers the shortest path when multiple exist', () => {
      // A→B→D (2 hops) vs A→C→E→D (3 hops)
      const edges = [...link('X1-A', 'X1-B'), ...link('X1-B', 'X1-D'), ...link('X1-A', 'X1-C'), ...link('X1-C', 'X1-E'), ...link('X1-E', 'X1-D')];
      expect(gatePath(edges, 'X1-A', 'X1-D')).toEqual(['X1-A', 'X1-B', 'X1-D']);
    });

    it('accepts a prebuilt adjacency map', () => {
      const adj = buildAdjacency(link('X1-A', 'X1-B'));
      expect(gatePath(adj, 'X1-A', 'X1-B')).toEqual(['X1-A', 'X1-B']);
    });
  });

  describe('buildAdjacency', () => {
    it('omits non-traversable edges', () => {
      const adj = buildAdjacency([edge('X1-A', 'X1-B', { builtFrom: false })]);
      expect(adj.get('X1-A')).toBeUndefined();
    });

    it('honors a server-derived traversable flag over built ends', () => {
      const adj = buildAdjacency([{ fromSystem: 'X1-A', toSystem: 'X1-B', traversable: true }]);
      expect(adj.get('X1-A')).toEqual(['X1-B']);
    });
  });

  describe('hopDistances', () => {
    it('computes BFS hop counts from home', () => {
      const edges = [...link('X1-A', 'X1-B'), ...link('X1-B', 'X1-C')];
      const dist = hopDistances(edges, 'X1-A');
      expect(dist.get('X1-A')).toBe(0);
      expect(dist.get('X1-B')).toBe(1);
      expect(dist.get('X1-C')).toBe(2);
    });

    it('excludes unreachable systems from the distance map', () => {
      const dist = hopDistances(link('X1-A', 'X1-B'), 'X1-A');
      expect(dist.has('X1-Z')).toBe(false);
    });
  });
});
