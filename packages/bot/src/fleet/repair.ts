import type { Config, Market, Ship } from '@st/shared';
import type { ApiEnvelope } from '../interfaces.js';
import type { FleetHooks, SubsystemDeps } from '../subsystems/deps.js';
import { commit, growthBudget, uncommit } from '../budget/budget.js';
import { logger } from '../core/logger.js';
import { getShipyards, isShipyardWp, nearestShipyardWp, shipyardWps, type ShipyardOffer } from './scale.js';

const log = logger.child({ mod: 'fleet.repair' });

export type RepairTier = 'none' | 'opportunistic' | 'forced';

export interface RepairDecision {
  tier: RepairTier;
  atYard: boolean;
  worn: boolean;
  forced: boolean;
  skipReason?: 'healthy' | 'not-at-yard' | 'no-yard' | 'over-cost' | 'budget';
}

interface RepairQuote {
  transaction?: {
    totalPrice?: number;
    price?: number;
  };
}

export function minCondition(ship: Ship): number {
  return Math.min(1, ...[ship.frame?.condition, ship.engine?.condition].filter((x): x is number => x != null));
}

export function minIntegrity(ship: Ship): number {
  // Our Ship model exposes integrity on the frame only (ShipEngine = {speed, condition}).
  return Math.min(1, ...[ship.frame?.integrity].filter((x): x is number => x != null));
}

export function repairTierDecision(
  ship: Ship,
  yardWps: readonly string[],
  cfg: Pick<Config, 'REPAIR_COND_MIN' | 'REPAIR_INTEG_FORCE' | 'REPAIR_MAX_COST'>,
  quoteCost?: number,
  freeBudget?: number,
): RepairDecision {
  if (!yardWps.length) return { tier: 'none', atYard: false, worn: false, forced: false, skipReason: 'no-yard' };
  const cond = minCondition(ship);
  const integ = minIntegrity(ship);
  const forced = integ < cfg.REPAIR_INTEG_FORCE;
  const worn = cond < cfg.REPAIR_COND_MIN;
  const atYard = ship.nav.status !== 'IN_TRANSIT' && yardWps.includes(ship.nav.waypointSymbol);
  if (!forced && !worn) return { tier: 'none', atYard, worn, forced, skipReason: 'healthy' };
  if (!forced && worn && !atYard) return { tier: 'none', atYard, worn, forced, skipReason: 'not-at-yard' };
  if (quoteCost != null && quoteCost > cfg.REPAIR_MAX_COST) return { tier: 'none', atYard, worn, forced, skipReason: 'over-cost' };
  if (quoteCost != null && freeBudget != null && quoteCost > freeBudget) return { tier: 'none', atYard, worn, forced, skipReason: 'budget' };
  return { tier: forced ? 'forced' : 'opportunistic', atYard, worn, forced };
}

async function repairAt(shipSym: string, deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'client'>): Promise<number> {
  let cost = 0;
  try {
    const q = (await deps.client.api<ApiEnvelope<RepairQuote>>('GET', `/my/ships/${shipSym}/repair`)).data;
    cost = q.transaction?.totalPrice ?? q.transaction?.price ?? 0;
  } catch (e) {
    log.warn(`🔧 ${shipSym.slice(-3)} repair quote failed: ${(e as Error).message}`);
    return 0;
  }
  if (cost <= 0) return 0;
  if (cost > deps.cfg.REPAIR_MAX_COST) {
    log.info(`🔧 ${shipSym.slice(-3)} repair quote ${cost.toLocaleString()} > cap ${deps.cfg.REPAIR_MAX_COST.toLocaleString()} — skip`);
    return 0;
  }
  if (cost > growthBudget(deps.state)) {
    log.info(`🔧 ${shipSym.slice(-3)} repair ${cost.toLocaleString()} > growthBudget — defer`);
    return 0;
  }
  commit(deps.state, cost);
  try {
    await deps.client.api('POST', `/my/ships/${shipSym}/repair`);
    log.info(`🔧 ${shipSym.slice(-3)} repaired for ${cost.toLocaleString()}`);
  } catch (e) {
    log.warn(`🔧 ${shipSym.slice(-3)} repair failed: ${(e as Error).message}`);
    uncommit(deps.state, cost);
    return 0;
  }
  uncommit(deps.state, cost);
  return cost;
}

async function maybeRepair(
  shipSym: string,
  ship: Ship,
  markets: Record<string, Market>,
  yards: Record<string, ShipyardOffer>,
  deps: SubsystemDeps,
): Promise<boolean> {
  const decision = repairTierDecision(ship, shipyardWps(yards), deps.cfg);
  if (decision.tier === 'none') return false;
  const wp = ship.nav.waypointSymbol;
  if (decision.tier === 'forced' && !decision.atYard) {
    const dest = nearestShipyardWp(wp, yards, deps);
    if (!dest) return false;
    log.info(`🔧 ${shipSym.slice(-3)} integrity ${(minIntegrity(ship) * 100).toFixed(0)}% < ${(deps.cfg.REPAIR_INTEG_FORCE * 100).toFixed(0)}% — diverting to shipyard ${dest.slice(-3)}`);
    await deps.goTo(shipSym, dest, markets);
  } else if (!isShipyardWp(wp, yards)) {
    return false;
  }
  try { await deps.client.api('POST', `/my/ships/${shipSym}/dock`); } catch {}
  const spent = await repairAt(shipSym, deps);
  return decision.tier === 'forced' || spent > 0;
}

export function createFleetHooks(deps: SubsystemDeps): FleetHooks {
  return {
    repair: async (shipSym, ship, markets) => {
      if (!deps.cfg.REPAIR) return false;
      const yards = await getShipyards(deps);
      if (!shipyardWps(yards).length) return false;
      return maybeRepair(shipSym, ship, markets, yards, deps);
    },
  };
}

export const __test = { repairAt, maybeRepair };
