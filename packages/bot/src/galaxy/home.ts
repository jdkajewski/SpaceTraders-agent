/**
 * galaxy/home.ts — home-system auto-detection (greenfield-safe).
 *
 * The bot must work from ANY fresh account after a weekly reset, with no hardcoded
 * system symbol. `/my/agent` reports the agent's `headquarters` waypoint (e.g.
 * `X1-DB23-A1`); the home SYSTEM is its first two dash-segments (`X1-DB23`).
 *
 * `resolveHome` is intentionally tiny + defensive: a missing/malformed agent payload
 * returns `null` so the caller can fall back to a pinned `SYSTEM` (or fail loudly).
 */

/** System symbol of a waypoint (`X1-DB23-A1` → `X1-DB23`). */
export const systemOf = (waypoint: string): string => waypoint.split('-').slice(0, 2).join('-');

export interface HomeInfo {
  /** Home system symbol, e.g. `X1-DB23`. */
  homeSystem: string;
  /** HQ waypoint symbol, e.g. `X1-DB23-A1`. */
  hqWaypoint: string;
}

type AgentApi = <T = unknown>(method: 'GET', path: string) => Promise<T>;

interface AgentEnvelope {
  data?: { headquarters?: string };
}

/**
 * Resolve the home system from the live agent's headquarters. Returns `null` if the
 * agent payload lacks a usable `headquarters` (the caller decides the fallback).
 */
export async function resolveHome(api: AgentApi): Promise<HomeInfo | null> {
  const r = await api<AgentEnvelope>('GET', '/my/agent');
  const hq = r?.data?.headquarters;
  if (!hq || typeof hq !== 'string') return null;
  const homeSystem = systemOf(hq);
  if (!homeSystem) return null;
  return { homeSystem, hqWaypoint: hq };
}
