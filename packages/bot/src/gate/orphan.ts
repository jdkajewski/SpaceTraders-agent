import type { Market, Ship } from '@st/shared';
import type { SubsystemDeps } from '../subsystems/deps.js';
import type { WorkerHook } from '../worker.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'gate.orphan' });
const IDLE_WAIT_MS = 12_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sysOf = (wp: string): string => wp.split('-').slice(0, 2).join('-');


function marketSellsFuel(m: Market | undefined): boolean {
  if (!m) return false;
  if ((m.tradeGoods ?? []).some((g) => g.symbol === 'FUEL')) return true;
  return [...(m.exchange ?? []), ...(m.imports ?? []), ...(m.exports ?? [])].some((g) => g.symbol === 'FUEL');
}

function fuelNodes(markets: Record<string, Market>): Set<string> {
  const out = new Set<string>();
  for (const [wp, m] of Object.entries(markets)) if (marketSellsFuel(m)) out.add(wp);
  return out;
}

// Dock at the gate and hand over every still-needed gate material this hull holds. Mirrors the supply leg of
// gateSupplyTrip (keeps gateCache.remaining / built in sync). Returns true if anything was supplied.
export async function supplyHeldToGate(shipSym: string, syms: string[], deps: SubsystemDeps, icon = '📦'): Promise<boolean> {
  const g = deps.state.gateCache;
  if (!g.wp) return false;
  try {
    await deps.client.api('POST', `/my/ships/${shipSym}/dock`);
  } catch {
    /* construction/supply requires DOCKED */
  }
  let inv: Array<{ symbol: string; units: number }> = [];
  try {
    inv = (await deps.client.api<{ data: Ship }>('GET', `/my/ships/${shipSym}`)).data.cargo.inventory;
  } catch {
    return false;
  }
  let any = false;
  for (const sym of syms) {
    const have = inv.find((i) => i.symbol === sym)?.units || 0;
    if (have <= 0) continue;
    try {
      const r = await deps.client.api<{
        data: { construction: { isComplete: boolean; materials?: Array<{ tradeSymbol: string; required: number; fulfilled: number }> } };
      }>('POST', `/systems/${deps.cfg.SYSTEM}/waypoints/${g.wp}/construction/supply`, { shipSymbol: shipSym, tradeSymbol: sym, units: have });
      const m = (r.data.construction.materials ?? []).find((x) => x.tradeSymbol === sym);
      if (m) {
        const left = Math.max(0, m.required - m.fulfilled);
        if (left > 0) g.remaining[sym] = left;
        else delete g.remaining[sym];
      }
      g.built = r.data.construction.isComplete || g.built;
      await deps.record(shipSym, 0, `SUPPLY_GATE ${sym} ${have}`);
      log.info(`${icon} ${shipSym.slice(-3)} delivered orphan ${have} ${sym} → ${m ? `${m.fulfilled}/${m.required}` : 'ok'}${g.built ? ' 🎉 GATE COMPLETE' : ''}`);
      any = true;
    } catch (e) {
      log.warn(`${shipSym.slice(-3)} orphan supply ERR ${sym}: ${(e as Error).message}`);
    }
  }
  return any;
}

// Refuel a ship from FUEL units already in its OWN cargo (how the tender refuels parked/scouting miners).
export async function refuelFromCargo(shipSym: string, deps: SubsystemDeps): Promise<boolean> {
  try {
    await deps.client.api('POST', `/my/ships/${shipSym}/refuel`, { fromCargo: true });
    return true;
  } catch {
    return false;
  }
}

// Self-haul along a fuel-cargo route: top tank from carried FUEL before any leg the tank can't cover on its own.
export async function haulWithFuelCargo(shipSym: string, path: string[], deps: SubsystemDeps): Promise<void> {
  for (const hop of path) {
    let ship = await deps.actions.getShip(shipSym);
    if (ship.nav.waypointSymbol === hop && ship.nav.status !== 'IN_TRANSIT') continue;
    if (ship.fuel.current < deps.D(ship.nav.waypointSymbol, hop)) await refuelFromCargo(shipSym, deps).catch(() => false);
    ship = await deps.actions.getShip(shipSym);
    await deps.actions.navigate(shipSym, hop, deps.router.chooseMode(deps.D(ship.nav.waypointSymbol, hop), ship).mode);
  }
}

// [GATE_FUEL_CARGO] Drive a gate-bound hull to `dest`, using carried FUEL to bridge dry legs when that saves a
// fuel-market detour. Returns true if it took the ship to dest (caller skips its own goTo); false → caller should
// goTo normally. Only ever uses cargo slots left free AFTER the material buy, and only diverts when it cuts a hop.
export async function goToWithFuelCargo(
  shipSym: string,
  dest: string,
  markets: Record<string, Market>,
  deps: SubsystemDeps,
  opts: { reserveUnits?: number } = {},
): Promise<boolean> {
  let ship = await deps.actions.getShip(shipSym);
  const origin = ship.nav.waypointSymbol;
  if (origin === dest && ship.nav.status !== 'IN_TRANSIT') return true;
  const cap = ship.fuel.capacity || 0;
  if (cap <= 0) return false;
  if (deps.D(origin, dest) <= Math.floor(cap * 0.97)) return false;
  let loadWp = origin;
  if (!marketSellsFuel(markets[origin])) {
    let best: string | null = null;
    let bd = Infinity;
    for (const f of fuelNodes(markets)) {
      if (f === origin) continue;
      const d = deps.D(origin, f);
      if (d <= Math.floor(cap * 0.97) && d < bd) {
        bd = d;
        best = f;
      }
    }
    if (!best) return false;
    loadWp = best;
  }
  const tankPath = deps.router.planRoute(loadWp, dest, cap, markets);
  const fcPath = deps.router.planRouteFuelCargo(loadWp, dest, cap, markets);
  if (!fcPath) return false;
  if (tankPath && fcPath.length >= tankPath.length) return false;
  if (loadWp !== origin) await deps.goTo(shipSym, loadWp, markets);
  const from = (await deps.actions.getShip(shipSym)).nav.waypointSymbol;
  const fuelGood = (markets[from]?.tradeGoods ?? []).find((g) => g.symbol === 'FUEL');
  if (!fuelGood) return false;
  try {
    await deps.actions.refuel(shipSym);
  } catch {
    /* best-effort */
  }
  ship = await deps.actions.getShip(shipSym);
  const reserve = Math.max(0, opts.reserveUnits || 0);
  const free = ship.cargo.capacity - (ship.cargo.units || 0) - reserve;
  if (free <= 0) return false;
  const totalDist = fcPath.reduce((s, wp, i) => s + deps.D(i === 0 ? from : (fcPath[i - 1] ?? from), wp), 0);
  const minNeed = Math.ceil(Math.max(0, totalDist - Math.floor(cap * 0.97)) / 100);
  const want = minNeed + Math.max(0, fcPath.length - 1);
  if (minNeed <= 0) return false;
  const carry = Math.min(want, free);
  if (carry < minNeed) return false;
  try {
    await deps.actions.buy(shipSym, 'FUEL', carry, Math.round((fuelGood.purchasePrice || 500) * 2));
  } catch (e) {
    log.warn(`⛽ ${shipSym.slice(-3)} fuel-cargo buy ERR: ${(e as Error).message}`);
    return false;
  }
  log.info(`⛽ ${shipSym.slice(-3)} carrying ${carry} FUEL to bridge ${from.slice(-3)}→${dest.slice(-3)} via ${fcPath.map((p) => p.slice(-3)).join('→')} (${fcPath.length} hops vs ${tankPath ? tankPath.length : '∞'} tank-only)`);
  await haulWithFuelCargo(shipSym, fcPath, deps);
  return true;
}

// Strategy 3: if a gate hauler (or any gate-bound hull) is parked at our waypoint with free space, hand it the
// cargo — zero travel for us, and the hauler is already routed to the gate. Returns units transferred (0 = none).
async function tryTransferToCoLocatedHauler(
  shipSym: string,
  ship: Ship,
  held: Array<{ symbol: string; units: number }>,
  deps: SubsystemDeps,
  isGateHauler: (shipSym: string) => boolean,
): Promise<number> {
  let fleet: Ship[] = [];
  try {
    fleet = await deps.client.getAllShips();
  } catch {
    return 0;
  }
  const wp = ship.nav.waypointSymbol;
  // [RULE: co-location]
  const candidates = fleet.filter(
    (o) => o.symbol !== shipSym && isGateHauler(o.symbol) && o.nav.waypointSymbol === wp && o.nav.status !== 'IN_TRANSIT' && o.cargo.capacity - (o.cargo.units || 0) > 0,
  );
  if (!candidates.length) return 0;
  let moved = 0;
  for (const tgt of candidates) {
    let free = tgt.cargo.capacity - (tgt.cargo.units || 0);
    for (const item of held) {
      if (free <= 0) break;
      const give = Math.min(item.units, free);
      if (give <= 0) continue;
      try {
        /** [RULE: transfer-argorder] (fromSym, toSym, symbol, units) */
        await deps.actions.transfer(shipSym, tgt.symbol, item.symbol, give);
        moved += give;
        free -= give;
        item.units -= give;
        log.info(`📦 ${shipSym.slice(-3)} handed ${give} ${item.symbol} → hauler ${tgt.symbol.slice(-3)} (co-located @${wp.slice(-3)})`);
      } catch (e) {
        log.warn(`${shipSym.slice(-3)} orphan transfer ERR ${item.symbol}→${tgt.symbol.slice(-3)}: ${(e as Error).message}`);
      }
    }
  }
  return moved;
}

// Strategy 4 helper: nearest fuel node we can reach now that gets us closest to the gate (staging hop).
export function nearestHopTowardGate(from: string, gateWp: string, fuelCap: number, markets: Record<string, Market>, deps: SubsystemDeps): string | null {
  const cap = (fuelCap || 0) * 0.97;
  const fuel = fuelNodes(markets);
  let best: string | null = null;
  let bestD = deps.D(from, gateWp);
  for (const n of fuel) {
    if (n === from) continue;
    if (deps.D(from, n) > cap) continue;
    const dg = deps.D(n, gateWp);
    if (dg < bestD) {
      bestD = dg;
      best = n;
    }
  }
  return best;
}

// Route a non-hauler's stranded gate cargo to the gate by the cheapest feasible means (see config comment).
// Returns true if it took ownership of this loop (worker should `continue`).
export function createOrphanGateHook(deps: SubsystemDeps, isGateHauler: (shipSym: string) => boolean): WorkerHook {
  return async function deliverOrphanGateCargo(shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
    if (!deps.cfg.ORPHAN_GATE_DELIVERY) return false;
    if (!(deps.cfg.GATE_SUPPLY && deps.state.gateCache.exists && !deps.state.gateCache.built && deps.state.gateCache.known)) return false;
    if (isGateHauler(shipSym)) return false;
    const g = deps.state.gateCache;
    const held = ship.cargo.inventory.filter((i) => deps.cfg.GATE_PROTECT_MATERIALS.includes(i.symbol) && i.units > 0 && (g.remaining[i.symbol] || 0) > 0);
    if (!held.length) return false;
    const units = held.reduce((s, i) => s + i.units, 0);
    const free = ship.cargo.capacity - (ship.cargo.units || 0);
    if (units < deps.cfg.ORPHAN_MIN_UNITS && free > 0) return false;
    const syms = held.map((i) => i.symbol);
    const from = ship.nav.waypointSymbol;
    const ps = (deps.state.perShip[shipSym] = deps.state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });

    if (from === g.wp) {
      ps.last = `ORPHAN→GATE ${units}u`;
      try {
        if (ship.nav.status === 'IN_TRANSIT' && g.wp) await deps.goTo(shipSym, g.wp, markets);
        await supplyHeldToGate(shipSym, syms, deps);
      } catch (e) {
        log.warn(`${shipSym.slice(-3)} orphan supply ERR ${(e as Error).message}`);
      }
      return true;
    }

    const gateWp = g.wp;
    if (!gateWp) return false;
    const selfPath = deps.router.planRoute(from, gateWp, ship.fuel.capacity, markets);
    if (selfPath) {
      ps.last = `ORPHAN→GATE ${units}u self`;
      log.info(`📦 ${shipSym.slice(-3)} orphan gate cargo [${held.map((i) => `${i.units} ${i.symbol}`).join(', ')}] → ${gateWp.slice(-3)} via ${selfPath.map((p) => p.slice(-3)).join('→')} (self-haul)`);
      try {
        await deps.goTo(shipSym, gateWp, markets);
        await supplyHeldToGate(shipSym, syms, deps);
      } catch (e) {
        log.warn(`${shipSym.slice(-3)} orphan self-haul ERR ${(e as Error).message}`);
      }
      return true;
    }

    if (free > 0) {
      const augPath = deps.router.planRouteFuelCargo(from, gateWp, ship.fuel.capacity, markets);
      if (augPath) {
        try {
          const wantFuel = Math.min(free, augPath.reduce((s, h, idx) => s + deps.D(idx ? (augPath[idx - 1] ?? from) : from, h), 0));
          if (fuelNodes(markets).has(from) && wantFuel > 0) {
            try {
              await deps.actions.buy(shipSym, 'FUEL', wantFuel);
            } catch {
              /* best-effort */
            }
          }
          ps.last = `ORPHAN→GATE ${units}u self+fuel`;
          log.info(`📦 ${shipSym.slice(-3)} orphan gate cargo → ${gateWp.slice(-3)} via ${augPath.map((p) => p.slice(-3)).join('→')} (self+fuel-cargo)`);
          await haulWithFuelCargo(shipSym, augPath, deps);
          await supplyHeldToGate(shipSym, syms, deps);
        } catch (e) {
          log.warn(`${shipSym.slice(-3)} orphan self+fuel ERR ${(e as Error).message}`);
        }
        return true;
      }
    }

    if (await tryTransferToCoLocatedHauler(shipSym, ship, held.map((i) => ({ ...i })), deps, isGateHauler)) {
      ps.last = `ORPHAN xfer ${units}u`;
      return true;
    }

    const hop = nearestHopTowardGate(from, gateWp, ship.fuel.capacity, markets, deps);
    if (hop && hop !== from) {
      ps.last = `ORPHAN stage→${hop.slice(-3)}`;
      log.info(`📦 ${shipSym.slice(-3)} orphan gate cargo: ${gateWp.slice(-3)} unreachable from ${from.slice(-3)} — staging to ${hop.slice(-3)} (await hauler / route)`);
      try {
        await deps.goTo(shipSym, hop, markets);
      } catch (e) {
        log.warn(`${shipSym.slice(-3)} orphan stage ERR ${(e as Error).message}`);
      }
      return true;
    }

    ps.last = `ORPHAN stuck ${units}u`;
    log.warn(`⚠ ${shipSym.slice(-3)} orphan gate cargo ${units}u stuck @${from.slice(-3)} (no route/hauler) — holding`);
    await sleep(IDLE_WAIT_MS);
    return true;
  };
}

export { sysOf };
