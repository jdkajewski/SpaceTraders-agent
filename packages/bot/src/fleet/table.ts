/**
 * fleet/table.ts — route-capture background manager (bot2 `fleetTable` L2825).
 *
 * The legacy `fleetTable` printed a periodic 📋 fleet table; that log was removed, but it
 * still serves one live purpose: stashing each cargo hull's full multi-hop planned route into
 * `state.fleetRoutes[shortId]` so `writeStatus()`/the dashboard can show where every ship is
 * headed. This is the minimal faithful port — route-string capture only, no table log.
 *
 * Self-gated on `FLEET_TABLE` (default on); a transient `getAllShips` failure is swallowed so
 * the loop never dies. Pure telemetry — it makes no game mutations.
 */

import type { Ship } from '@st/shared';
import type { SubsystemDeps } from '../subsystems/deps.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'fleetTable' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Date.now();

/**
 * The ship's current route string (`A1→B7→D18`), preferring the captured multi-hop plan and
 * falling back to the live in-transit origin→destination. (bot2 `routeStr` L2807)
 */
export function routeStr(ship: Ship, deps: Pick<SubsystemDeps, 'state' | 'cfg'>): string {
  const SH = (wp: string | undefined): string => (wp ? wp.replace(`${deps.cfg.SYSTEM}-`, '') : '?');
  const pr = deps.state.plannedRoutes[ship.symbol];
  const last = pr && pr.path.length > 0 ? pr.path[pr.path.length - 1] : undefined;
  if (
    pr &&
    now() - pr.at < 20 * 60 * 1000 &&
    (ship.nav.status === 'IN_TRANSIT' || ship.nav.waypointSymbol !== last)
  ) {
    return [pr.from, ...pr.path].map(SH).join('→');
  }
  if (ship.nav.status === 'IN_TRANSIT' && ship.nav.route) {
    return `${SH(ship.nav.route.origin?.symbol)}→${SH(ship.nav.route.destination?.symbol)}`;
  }
  return '—';
}

/**
 * Background loop: every `FLEET_TABLE_MS`, snapshot each cargo hull's planned route into
 * `state.fleetRoutes` (keyed by the 3-char short id used across status). Inert when
 * `FLEET_TABLE` is off. (bot2 `fleetTable`)
 */
export async function fleetTableManager(deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'client'>): Promise<void> {
  const { state, cfg, client } = deps;
  if (!cfg.FLEET_TABLE) return;
  while (!state.stop) {
    await sleep(cfg.FLEET_TABLE_MS);
    try {
      const all = await client.getAllShips();
      for (const s of all) {
        if (s.cargo.capacity <= 0) continue;
        // [ROUTE] stash the ship's full multihop route for writeStatus()/the dashboard.
        state.fleetRoutes[s.symbol.slice(-3)] = routeStr(s, deps);
      }
    } catch (e) {
      log.info(`fleetTable: ${(e as Error).message}`);
    }
  }
}
