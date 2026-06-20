/**
 * Unbounded gate-path BFS over a preloaded galaxy graph.
 *
 * The legacy in-memory pathfinder carried a 120-system guard that silently cut
 * off deep-but-reachable targets (it failed to reach systems 11–14 jumps out in
 * a 237+ system graph). Because the crawler persists the whole traversable-edge
 * set up front, this BFS can run with NO node cap and still terminate (the graph
 * is finite) — fixing that reachability bug.
 *
 * "Traversable" = both gate ends BUILT (`builtFrom && builtTo`); you cannot jump
 * out of, or into, an under-construction gate. We accept either the server-derived
 * `traversable` flag or compute it from the built ends, so callers can pass raw
 * edges or DTOs.
 */

export interface PathEdge {
  fromSystem: string;
  toSystem: string;
  builtFrom?: boolean;
  builtTo?: boolean;
  traversable?: boolean;
}

function isTraversable(e: PathEdge): boolean {
  return e.traversable ?? Boolean(e.builtFrom && e.builtTo);
}

/** Build a forward adjacency map over traversable edges only. */
export function buildAdjacency(edges: readonly PathEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!isTraversable(e)) continue;
    const list = adj.get(e.fromSystem);
    if (list) list.push(e.toSystem);
    else adj.set(e.fromSystem, [e.toSystem]);
  }
  return adj;
}

/**
 * Shortest all-built gate path `from → … → to` (inclusive of both ends), or null
 * if unreachable. Unbounded BFS — no node-count guard. `from === to` yields `[from]`.
 *
 * Pass a prebuilt adjacency (from {@link buildAdjacency}) when pathing many targets
 * over the same graph to avoid rebuilding it each call.
 */
export function gatePath(
  edges: readonly PathEdge[] | Map<string, string[]>,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const adj = edges instanceof Map ? edges : buildAdjacency(edges);

  const parent = new Map<string, string | null>([[from, null]]);
  const queue: string[] = [from];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === to) break;
    for (const nx of adj.get(cur) ?? []) {
      if (parent.has(nx)) continue;
      parent.set(nx, cur);
      queue.push(nx);
    }
  }
  if (!parent.has(to)) return null;

  const path: string[] = [];
  let c: string | null = to;
  while (c != null) {
    path.unshift(c);
    c = parent.get(c) ?? null;
  }
  return path;
}

/**
 * BFS hop-distance + reachability map from `home` over traversable edges.
 * A system is reachable iff an all-built gate path exists from home AND its own
 * gate is built (you must be able to jump INTO it) — the latter is enforced by
 * the caller only feeding edges whose `builtTo` end is built (traversable).
 * Returns `Map<system, hops>` for every system reachable from home (home = 0).
 */
export function hopDistances(edges: readonly PathEdge[] | Map<string, string[]>, home: string): Map<string, number> {
  const adj = edges instanceof Map ? edges : buildAdjacency(edges);
  const dist = new Map<string, number>([[home, 0]]);
  const queue: string[] = [home];
  while (queue.length) {
    const cur = queue.shift() as string;
    const d = dist.get(cur) as number;
    for (const nx of adj.get(cur) ?? []) {
      if (dist.has(nx)) continue;
      dist.set(nx, d + 1);
      queue.push(nx);
    }
  }
  return dist;
}
