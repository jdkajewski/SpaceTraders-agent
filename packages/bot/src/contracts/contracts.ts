import type { Config, Contract, Market, Ship } from '@st/shared';
import type { ContractHooks, SubsystemDeps } from '../subsystems/deps.js';
import { bestSink, cheapestSrc } from '../trade/marketHelpers.js';
import { buildLanes, peekLane, gateProducerWps, planRideAlongs } from '../trade/lanes.js';
import { availableForWork, commit, growthBudget, uncommit } from '../budget/budget.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'contracts' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MANAGER_SLEEP_MS = 20_000;
const IDLE_WAIT_MS = 12_000;

export interface ContractInfo {
  id: string;
  good: string;
  dest: string;
  units: number;
  pay: number;
}

export interface ContractSource {
  wp: string;
  px: number;
  tv: number;
}

export interface ContractOwnerPick {
  ship: string;
  src: ContractSource;
  dist: number;
  score: number;
}

interface RideCommit {
  good: string;
  units: number;
  costBasis: number;
}

export function cargoUnits(ship: Ship, sym: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === sym)?.units ?? 0;
}

export function sysOf(wp: string | null | undefined): string {
  return (wp || '').split('-').slice(0, 2).join('-');
}

export function contractHomeDeliverable(ci: Pick<ContractInfo, 'dest'> | null | undefined, cfg: Pick<Config, 'SYSTEM'>): boolean {
  return !!ci && sysOf(ci.dest) === cfg.SYSTEM;
}

export function isForced(ci: Pick<ContractInfo, 'id' | 'good'>, cfg: Pick<Config, 'CONTRACT_FORCE'>, autoForced: Set<string>): boolean {
  return cfg.CONTRACT_FORCE.includes(ci.good) || autoForced.has(ci.id);
}

export function isContractRunner(sym: string, cfg: Pick<Config, 'CONTRACT_RUNNER'>): boolean {
  for (const h of cfg.CONTRACT_RUNNER) if (sym === h || sym.endsWith(`-${h}`)) return true;
  return false;
}

export function cheapestContractSrc(
  markets: Record<string, Market>,
  good: string,
  dest: string | null,
  deps: Pick<SubsystemDeps, 'state' | 'cfg'>,
): ContractSource | null {
  const { state, cfg } = deps;
  if (!cfg.CONTRACT_AVOID_GATE_PRODUCER || !cfg.GATE_PROTECT) return cheapestSrc(markets, good);
  const producers = gateProducerWps(state, cfg, markets);
  if (!producers.size) return cheapestSrc(markets, good);

  let guarded = false;
  const activeMats = new Set(cfg.GATE_PROTECT_MATERIALS.filter((m) => (state.gateCache.remaining[m] || 0) > 0));
  if (!state.gateCache.known || !state.gateCache.exists) {
    for (const m of cfg.GATE_PROTECT_MATERIALS) activeMats.add(m);
  }
  if (state.gateCache.built) activeMats.clear();
  guarded = activeMats.has(good);
  if (!guarded) {
    for (const wp of producers) {
      const m = markets[wp];
      if (!m) continue;
      if ((m.tradeGoods ?? []).some((g) => g.symbol === good && g.type === 'IMPORT')) {
        guarded = true;
        break;
      }
    }
  }
  if (!guarded) return cheapestSrc(markets, good);

  const guardedSrc = cheapestSrc(markets, good, producers);
  if (guardedSrc && (!dest || guardedSrc.wp !== dest)) return guardedSrc;
  return cheapestSrc(markets, good);
}

export function contractSrcReachable(
  here: string,
  srcWp: string,
  fuelCap: number,
  markets: Record<string, Market>,
  deps: Pick<SubsystemDeps, 'cfg' | 'router' | 'D'>,
): boolean {
  const { cfg, router, D } = deps;
  if (D(here, srcWp) <= cfg.CONTRACT_MAX_SRC_DIST) return true;
  if (!cfg.FUEL_CARGO) return false;
  const tank = router.planRoute(here, srcWp, fuelCap, markets);
  if (tank && tank.length <= cfg.CONTRACT_MAX_HOPS) return true;
  const fc = router.planRouteFuelCargo(here, srcWp, fuelCap, markets);
  return !!(fc && fc.length <= cfg.CONTRACT_MAX_HOPS);
}

export function contractMargin(
  ship: Ship,
  ci: ContractInfo,
  src: ContractSource,
  deps: Pick<SubsystemDeps, 'cfg' | 'router' | 'D'>,
): { net: number; minMargin: number; clears: boolean } {
  const { cfg, router, D } = deps;
  const here = ship.nav.waypointSymbol;
  const srcLeg = D(here, src.wp);
  const units = Math.min(ci.units, ship.cargo.capacity);
  const fuelCr = cfg.FUEL_CARGO && srcLeg > cfg.CONTRACT_MAX_SRC_DIST
    ? router.routeCost(here, src.wp, ship).fuelCr + router.routeCost(src.wp, ci.dest, ship).fuelCr
    : (srcLeg + D(src.wp, ci.dest)) * cfg.CONTRACT_FUEL_PX;
  const net = (ci.pay || 0) - units * src.px - fuelCr;
  const minMargin = Math.max(cfg.CONTRACT_MIN_MARGIN, Math.round(cfg.CONTRACT_MIN_MARGIN_PCT * (ci.pay || 0)));
  return { net, minMargin, clears: net >= minMargin };
}

export function contractWorthIt(
  ship: Ship,
  ci: ContractInfo,
  markets: Record<string, Market>,
  deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'router' | 'D'>,
): { src: ContractSource; units: number; net: number } | null {
  if (!contractHomeDeliverable(ci, deps.cfg)) return null;
  const src = cheapestContractSrc(markets, ci.good, ci.dest, deps);
  if (!src || src.wp === ci.dest) return null;
  if (!contractSrcReachable(ship.nav.waypointSymbol, src.wp, ship.fuel?.capacity || 0, markets, deps)) return null;
  const margin = contractMargin(ship, ci, src, deps);
  if (!isForced(ci, deps.cfg, deps.state.contractAutoForced) && !margin.clears) return null;
  return { src, units: Math.min(ci.units, ship.cargo.capacity), net: margin.net };
}

export function electContractOwner(
  ci: ContractInfo,
  markets: Record<string, Market>,
  ships: Ship[],
  deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'router' | 'D'>,
): ContractOwnerPick | null {
  const { cfg, D } = deps;
  if (!contractHomeDeliverable(ci, cfg)) return null;
  const src = cheapestContractSrc(markets, ci.good, ci.dest, deps);
  if (!src || src.wp === ci.dest) return null;
  let best: ContractOwnerPick | null = null;
  for (const s of ships) {
    const sym = s.symbol;
    if (sym === cfg.NEGOTIATOR) continue;
    const eligible = cfg.CONTRACT_RUNNER.length ? isContractRunner(sym, cfg) : (s.cargo?.capacity || 0) >= 40;
    if (!eligible) continue;
    if (s.nav?.status === 'IN_TRANSIT') continue;
    if ((s.cargo?.units || 0) > 0) continue;
    const here = s.nav?.waypointSymbol;
    const dist = D(here, src.wp);
    if (!contractSrcReachable(here, src.wp, s.fuel?.capacity || 0, markets, deps)) continue;
    if (!isForced(ci, cfg, deps.state.contractAutoForced) && !contractMargin(s, ci, src, deps).clears) continue;
    const score = dist * 1000 - (s.cargo.capacity || 0) - (s.engine?.speed || 0) * 0.001;
    if (!best || score < best.score) best = { ship: sym, src, dist, score };
  }
  return best;
}

export function applyContractElection(
  ci: ContractInfo,
  markets: Record<string, Market>,
  ships: Ship[],
  deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'router' | 'D'>,
): ContractOwnerPick | null {
  const ownerShip = deps.state.contractOwner?.id === ci.id ? ships.find((s) => s.symbol === deps.state.contractOwner?.ship) : undefined;
  if (ownerShip && cargoUnits(ownerShip, ci.good) > 0) return null;
  const pick = electContractOwner(ci, markets, ships, deps);
  if (!pick) return null;
  const ownerDist = ownerShip ? deps.D(ownerShip.nav?.waypointSymbol, pick.src.wp) : Infinity;
  const switching = !deps.state.contractOwner || deps.state.contractOwner.id !== ci.id
    || (deps.state.contractOwner.ship !== pick.ship && pick.dist + deps.cfg.CONTRACT_REELECT_MARGIN < ownerDist);
  if (switching) deps.state.contractOwner = { id: ci.id, ship: pick.ship };
  return switching ? pick : null;
}

export function updateContractAutoForce(
  ci: ContractInfo | null,
  deps: Pick<SubsystemDeps, 'state' | 'cfg'>,
  now = Date.now(),
): boolean {
  const { state, cfg } = deps;
  if (!(cfg.CONTRACT_AUTOFORCE_MINS > 0) || !ci || ci.units <= 0 || !contractHomeDeliverable(ci, cfg)) return false;
  const claimed = !!(state.contractOwner && state.contractOwner.id === ci.id);
  if (claimed || isForced(ci, cfg, state.contractAutoForced)) {
    state.contractWedge = { id: null, since: 0 };
    return false;
  }
  if (state.contractWedge.id !== ci.id) {
    state.contractWedge = { id: ci.id, since: now };
    return false;
  }
  if (now - state.contractWedge.since >= cfg.CONTRACT_AUTOFORCE_MINS * 60_000) {
    state.contractAutoForced.add(ci.id);
    state.contractWedge = { id: null, since: 0 };
    return true;
  }
  return false;
}

function toInfo(c: Contract): ContractInfo | null {
  const d = c.terms.deliver[0];
  if (!d) return null;
  return {
    id: c.id,
    good: d.tradeSymbol,
    dest: d.destinationSymbol,
    units: d.unitsRequired - d.unitsFulfilled,
    pay: c.terms.payment.onFulfilled,
  };
}

async function contractRunnerTrip(shipSym: string, ship: Ship, markets: Record<string, Market>, deps: SubsystemDeps): Promise<boolean> {
  const { state, cfg, actions } = deps;
  const ci = state.activeContractInfo;
  if (!cfg.CONTRACTS || !ci || ci.units <= 0) return false;
  if (!contractHomeDeliverable(ci, cfg)) {
    const held = cargoUnits(ship, ci.good);
    if (held > 0) {
      try {
        const sink = bestSink(markets, ci.good);
        if (sink) {
          if (sink.wp !== ship.nav.waypointSymbol) await deps.goTo(shipSym, sink.wp, markets);
          const s = await actions.sell(shipSym, ci.good);
          await deps.record(shipSym, s.got || 0, `CONTRACT-SALVAGE ${ci.good}`);
        }
      } catch (e) { log.warn(`${shipSym.slice(-3)} cross-sys contract salvage ERR ${(e as Error).message}`); }
      if (state.contractOwner?.id === ci.id && state.contractOwner.ship === shipSym) state.contractOwner = null;
    }
    return false;
  }
  if (state.contractOwner && state.contractOwner.id === ci.id && state.contractOwner.ship !== shipSym) return false;
  let have = cargoUnits(ship, ci.good);
  const preElected = state.contractOwner?.id === ci.id && state.contractOwner.ship === shipSym;
  if (preElected && have <= 0 && (ship.cargo.units || 0) > 0) return false;
  if (have <= 0 && state.contractOwner?.ship !== shipSym) {
    if (isForced(ci, cfg, state.contractAutoForced)) {
      const src = cheapestContractSrc(markets, ci.good, ci.dest, deps);
      if (!src || src.wp === ci.dest || !contractSrcReachable(ship.nav.waypointSymbol, src.wp, ship.fuel?.capacity || 0, markets, deps)) return false;
    } else if (!contractWorthIt(ship, ci, markets, deps)) return false;
  }

  state.contractOwner = { id: ci.id, ship: shipSym };
  state.contractWorkingId = ci.id;
  const cap = ship.cargo.capacity;
  const want = Math.min(ci.units, cap);
  let rideAlongs: RideCommit[] = [];
  let rideCommitted = 0;
  try {
    if (have < want) {
      const fresh = await deps.markets.getMarkets();
      const src = cheapestContractSrc(fresh, ci.good, ci.dest, deps);
      if (src && src.wp !== ci.dest) {
        await deps.goTo(shipSym, src.wp, fresh);
        if (have <= 0 && state.contractOwner && state.contractOwner.id === ci.id && state.contractOwner.ship !== shipSym) return false;
        const unitPx = Math.max(1, Math.round(src.px * (1 + cfg.SLIPPAGE_FACTOR)));
        const affordable = Math.max(0, Math.floor(availableForWork(state) / unitPx));
        const qty = Math.min(want - have, affordable);
        if (qty > 0) {
          const estCost = qty * unitPx;
          commit(state, estCost);
          try { await actions.buy(shipSym, ci.good, qty, Math.round(src.px * 2)); }
          catch (e) { log.warn(`${shipSym.slice(-3)} contract source ERR ${(e as Error).message}`); }
          uncommit(state, estCost);
        }
        const sourced = await actions.getShip(shipSym);
        have = cargoUnits(sourced, ci.good);
        if (cfg.CONTRACT_RIDEALONG && have > 0) {
          let free = cap - (sourced.cargo.units || have);
          if (free > 0) {
            const heldSyms = new Set((sourced.cargo.inventory || []).map((i) => i.symbol));
            const laneLike = { sym: ci.good, buyWp: src.wp, buy: src.px, sellWp: ci.dest, sell: 0, margin: 0, units: have, dist: 0, gross: 0 };
            for (const p of planRideAlongs(fresh, laneLike, free, growthBudget(state), state, cfg, heldSyms)) {
              if (free <= 0) break;
              const units = Math.min(p.units, free);
              if (units <= 0) continue;
              try {
                const rb = await actions.buy(shipSym, p.sym, units, Math.round(p.buy * (1 + cfg.SLIPPAGE_FACTOR)));
                if (rb.bought > 0) {
                  commit(state, rb.spent || 0);
                  rideCommitted += rb.spent || 0;
                  rideAlongs.push({ good: p.sym, units: rb.bought, costBasis: rb.spent || 0 });
                  free -= rb.bought;
                  heldSyms.add(p.sym);
                }
              } catch (e) { log.warn(`${shipSym.slice(-3)} contract ride-along ${p.sym} ERR ${(e as Error).message}`); }
            }
          }
        }
      }
    }
    if (have <= 0) {
      state.perShip[shipSym] = state.perShip[shipSym] ?? { net: 0, lanes: 0, last: '' };
      state.perShip[shipSym].last = `CONTRACT ${ci.good} (no source now)`;
      await sleep(IDLE_WAIT_MS);
      return true;
    }
    state.perShip[shipSym] = state.perShip[shipSym] ?? { net: 0, lanes: 0, last: '' };
    state.perShip[shipSym].last = `CONTRACT ${ci.good} ${have}u→${ci.dest.slice(-3)}`;
    await deps.goTo(shipSym, ci.dest, markets);
    if (rideAlongs.length) {
      let rideNet = 0;
      for (const r of rideAlongs) {
        try {
          const rs = await actions.sell(shipSym, r.good);
          rideNet += (rs.got || 0) - (r.costBasis || 0);
        } catch (e) { log.warn(`${shipSym.slice(-3)} contract ride-along sell ${r.good} ERR ${(e as Error).message}`); }
      }
      uncommit(state, rideCommitted);
      rideCommitted = 0;
      await deps.record(shipSym, Math.round(rideNet), `ride-along×${rideAlongs.length}→${ci.dest.slice(-3)}`);
      rideAlongs = [];
    }
    const cPre = (await deps.client.getAllContracts()).find((x) => x.id === ci.id);
    if (!cPre || cPre.fulfilled || !cPre.accepted) {
      if (state.contractOwner?.id === ci.id && state.contractOwner.ship === shipSym) state.contractOwner = null;
      return false;
    }
    await actions.deliver(shipSym, ci.id, ci.good, have);
    const c = (await deps.client.getAllContracts()).find((x) => x.id === ci.id);
    const d = c?.terms.deliver[0];
    if (d && d.unitsFulfilled >= d.unitsRequired) {
      await actions.fulfill(shipSym, ci.id);
      await deps.record(shipSym, 0, `CONTRACT ${ci.good} ✓`);
      state.activeContractInfo = null;
      state.contractOwner = null;
    } else if (d) {
      state.activeContractInfo = { ...ci, units: d.unitsRequired - d.unitsFulfilled };
    }
  } catch (e) {
    log.warn(`${shipSym.slice(-3)} contract-runner ERR ${(e as Error).message}`);
  } finally {
    if (rideCommitted) uncommit(state, rideCommitted);
    state.contractWorkingId = null;
  }
  return true;
}

export function createContractHooks(deps: SubsystemDeps): ContractHooks {
  return {
    contracts: async (shipSym, ship, markets) => {
      if (!deps.cfg.CONTRACTS) return false;
      // [TRADE_FIRST] (default OFF) DRIFT #26: legacy gates the contract behind a lane *peek* —
      // if a profitable lane (or a park sentinel) is available this loop, skip the contract and
      // let the normal trade section (worker.ts) make the single real claim. peekLane is
      // NON-mutating, so unlike the old port this neither locks the good nor commits cash here
      // (no double-claim leak), while restoring the legacy skip-contract gate the port had dropped.
      if (deps.cfg.TRADE_FIRST) {
        const lanes = buildLanes(markets, deps.state, deps.cfg, deps.D);
        const lanePref = peekLane(ship, lanes, markets, { state: deps.state, cfg: deps.cfg, router: deps.router, D: deps.D });
        if (lanePref) return false; // lane available → defer to trade section, don't run contract
      }
      return contractRunnerTrip(shipSym, ship, markets, deps);
    },
  };
}

export async function contractManager(deps: SubsystemDeps): Promise<void> {
  const { state, cfg, client } = deps;
  if (!cfg.CONTRACTS) {
    log.info('📜 contracts DISABLED (CONTRACTS=0) — trading only');
    return;
  }
  while (!state.stop) {
    try {
      const cs = await client.getAllContracts();
      const active = cs.find((c) => c.accepted && !c.fulfilled);
      if (active) {
        const ci = toInfo(active);
        if (ci) state.activeContractInfo = ci;
        if (state.contractOwner && state.contractOwner.id !== active.id) state.contractOwner = null;
      } else {
        state.activeContractInfo = null;
        state.contractOwner = null;
        const pending = cs.find((c) => {
          const p = c as Contract & { deadlineToAccept?: string };
          return !c.accepted && !c.fulfilled && (!p.deadlineToAccept || Date.parse(p.deadlineToAccept) > Date.now());
        });
        if (pending) {
          await client.api('POST', `/my/contracts/${pending.id}/accept`);
          const ci = toInfo(pending);
          if (ci) state.activeContractInfo = ci;
        } else if (!state.contractWorkingId && cfg.NEGOTIATOR) {
          try { await client.api('POST', `/my/ships/${cfg.NEGOTIATOR}/dock`); } catch {}
          const r = await client.api<{ data: { contract: Contract } }>('POST', `/my/ships/${cfg.NEGOTIATOR}/negotiate/contract`);
          const c = r.data.contract;
          await client.api('POST', `/my/contracts/${c.id}/accept`);
          const ci = toInfo(c);
          if (ci) state.activeContractInfo = ci;
        }
      }
    } catch (e) { log.warn(`contractManager: ${(e as Error).message}`); }

    try {
      if (cfg.CONTRACT_BEST_SHIP && state.activeContractInfo && state.activeContractInfo.units > 0) {
        const markets = await deps.markets.getMarkets();
        const ships = await client.getAllShips();
        applyContractElection(state.activeContractInfo, markets, ships, deps);
      }
    } catch (e) { log.warn(`contractElect: ${(e as Error).message}`); }

    try {
      if (updateContractAutoForce(state.activeContractInfo, deps)) {
        const ci = state.activeContractInfo;
        if (ci) log.info(`⚡ auto-force contract ${ci.id.slice(-6)} ${ci.good}→${ci.dest.slice(-3)} pay ${ci.pay}`);
      }
    } catch (e) { log.warn(`contractAutoForce: ${(e as Error).message}`); }

    await sleep(MANAGER_SLEEP_MS);
  }
}

export const __test = { MANAGER_SLEEP_MS, IDLE_WAIT_MS, sleep, contractRunnerTrip, contractMarginWithD: contractMargin };
