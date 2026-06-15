/**
 * routing/route.ts — multi-hop routing & lane-scoring cost (port of bot2.mjs
 * L2215–2287 + planRouteFuelCargo L2403–2425).
 *
 * `planRoute` is a Dijkstra over **fuel nodes** with ≤1-tank hops, minimising
 * CRUISE time. `planRouteFuelCargo` assumes carried fuel tops the tank on arrival,
 * so it routes over ALL coords minimising hop count. `routeCost` scores a
 * (possibly multi-hop) trip in fuel-credits + seconds for lane ranking.
 *
 * Differences from legacy (DRIFT-LOG): the sticky fuel-node set is **in-memory
 * only** — the `fuel-nodes.json` disk cache is dropped (no `fs`). The set is
 * re-seeded from the API markets snapshot on boot and grows as markets refresh.
 *
 * `FUEL_PX` / `VALUE_OF_TIME` / coords are injected, never module-global.
 */

import { distance } from '@st/shared';
import type { CoordsMap, Market, Ship } from '@st/shared';
import type { ModeChoice, RouteCost, Router } from '../interfaces.js';
import { chooseMode } from './flight.js';

export interface RouterOptions {
  coords: CoordsMap;
  /** Live per-ship-fuel-unit cost (cr) — read fresh each call (markets owns it). */
  getFuelPx: () => number;
  /** cr/sec BURN aggressiveness knob. */
  valueOfTime: number;
  /** Current cached markets snapshot (for routeCost's internal route planning). */
  marketsRef: () => Record<string, Market>;
}

/** True when a market sells FUEL — live (ship present) or structurally (always returned). */
export function marketSellsFuel(m: Market | undefined): boolean {
  if (!m) return false;
  if ((m.tradeGoods ?? []).some((g) => g.symbol === 'FUEL')) return true; // live (ship present)
  return [...(m.exports ?? []), ...(m.imports ?? []), ...(m.exchange ?? [])].some(
    (g) => g.symbol === 'FUEL',
  ); // structure (always returned)
}

export function createRouter(opts: RouterOptions): Router & { fuelNodes(markets: Record<string, Market>): Set<string>; seedFuelNodes(markets: Record<string, Market>): void } {
  const { coords, getFuelPx, valueOfTime, marketsRef } = opts;
  const D = (a: string, b: string): number => distance(a, b, coords);

  // Sticky union of every fuel node ever observed (in-memory; fuel stations never
  // move, so once seen a waypoint stays a fuel node for the process lifetime).
  const stickyFuelNodes = new Set<string>();

  function seedFuelNodes(markets: Record<string, Market>): void {
    for (const [w, m] of Object.entries(markets ?? {})) if (marketSellsFuel(m)) stickyFuelNodes.add(w);
  }

  function fuelNodes(markets: Record<string, Market>): Set<string> {
    for (const [w, m] of Object.entries(markets ?? {}))
      if (marketSellsFuel(m) && !stickyFuelNodes.has(w)) stickyFuelNodes.add(w);
    // Return only fuel nodes we have coordinates for (router needs coords).
    const s = new Set<string>();
    for (const w of stickyFuelNodes) if (coords[w]) s.add(w);
    return s;
  }

  function planRoute(from: string, to: string, fuelCap: number, markets: Record<string, Market>): string[] | null {
    const cap = (fuelCap || 0) * 0.97;
    if (cap <= 0 || D(from, to) <= cap) return [to]; // probes (cap 0 handled by caller) or direct-feasible
    const fuel = fuelNodes(markets);
    const nodes = [...new Set([from, to, ...fuel])].filter((n) => coords[n]);
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const seen = new Set<string>();
    for (const n of nodes) dist.set(n, Infinity);
    dist.set(from, 0);
    for (;;) {
      let u: string | null = null;
      let best = Infinity;
      for (const n of nodes) {
        const dn = dist.get(n)!;
        if (!seen.has(n) && dn < best) {
          best = dn;
          u = n;
        }
      }
      if (u === null || u === to) break;
      seen.add(u);
      for (const v of nodes) {
        if (v === u || seen.has(v)) continue;
        if (v !== to && !fuel.has(v)) continue; // can only stop to refuel at fuel nodes (or the dest)
        const d = D(u, v);
        if (d > cap) continue; // too far for one tank
        const t = Math.round((d * 25) / 15) + 15; // CRUISE time (relative ranking)
        if (dist.get(u)! + t < dist.get(v)!) {
          dist.set(v, dist.get(u)! + t);
          prev.set(v, u);
        }
      }
    }
    if (dist.get(to) === Infinity) return null; // unreachable even multi-hop
    const path: string[] = [];
    let c: string | undefined = to;
    while (c && c !== from) {
      path.unshift(c);
      c = prev.get(c);
    }
    return path;
  }

  function planRouteFuelCargo(from: string, to: string, fuelCap: number, _markets: Record<string, Market>): string[] | null {
    const cap = (fuelCap || 0) * 0.97;
    if (cap <= 0) return null;
    if (D(from, to) <= cap) return [to];
    const nodes = Object.keys(coords);
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const seen = new Set<string>();
    for (const n of nodes) dist.set(n, Infinity);
    dist.set(from, 0);
    for (;;) {
      let u: string | null = null;
      let best = Infinity;
      for (const n of nodes) {
        const dn = dist.get(n)!;
        if (!seen.has(n) && dn < best) {
          best = dn;
          u = n;
        }
      }
      if (u === null || u === to) break;
      seen.add(u);
      for (const v of nodes) {
        if (v === u || seen.has(v)) continue;
        const d = D(u, v);
        if (d > cap) continue; // one tankful per leg (topped from carried fuel on arrival)
        const t = d + 30; // +per-hop refuel overhead so we prefer fewer hops
        if (dist.get(u)! + t < dist.get(v)!) {
          dist.set(v, dist.get(u)! + t);
          prev.set(v, u);
        }
      }
    }
    if (dist.get(to) === Infinity) return null;
    const path: string[] = [];
    let c: string | undefined = to;
    while (c && c !== from) {
      path.unshift(c);
      c = prev.get(c);
    }
    return path;
  }

  // Estimate fuel-credits + seconds for a (possibly multi-hop) trip, for lane scoring.
  // Uses the refuel-aware route so OUTER lanes are costed realistically (CRUISE hops, not one DRIFT).
  function routeCost(from: string, to: string, ship: Ship): RouteCost {
    if (from === to) return { fuelCr: 0, timeS: 0 };
    const fuelPx = getFuelPx();
    const speed = ship.engine?.speed || 15;
    const path = planRoute(from, to, ship.fuel.capacity, marketsRef());
    if (!path) {
      const d = D(from, to);
      return { fuelCr: fuelPx, timeS: Math.round((d * 250) / speed) + 15 }; // DRIFT fallback
    }
    let cur = from;
    let fuelCr = 0;
    let timeS = 0;
    for (const hop of path) {
      const d = D(cur, hop);
      fuelCr += d * fuelPx;
      timeS += Math.round((d * 25) / speed) + 15;
      cur = hop;
    }
    return { fuelCr, timeS };
  }

  function chooseModeBound(dist: number, ship: Ship): ModeChoice {
    return chooseMode(dist, ship, getFuelPx(), valueOfTime);
  }

  return {
    chooseMode: chooseModeBound,
    planRoute,
    planRouteFuelCargo,
    routeCost,
    fuelNodes,
    seedFuelNodes,
  };
}
