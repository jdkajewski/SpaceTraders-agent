import type { Config, Market, MarketGood, Ship } from '@st/shared';
import type { GateHooks, SubsystemDeps } from '../subsystems/deps.js';
import type { BotState, PriceSettleState } from '../runtime/state.js';
import { gateSupplyActive, gateCreditOk } from '../budget/phase.js';
import { growthBudget } from '../budget/budget.js';
import { logger } from '../core/logger.js';
import { createOrphanGateHook, goToWithFuelCargo, supplyHeldToGate } from './orphan.js';

const log = logger.child({ mod: 'gate' });

export interface GateFillPlan {
  sym: string;
  wp: string;
  units: number;
  px: number;
}

export interface PlanGateFillOptions {
  free: number;
  headroom: number;
  slippage: number;
  ceilFactor: number;
  absMax?: Record<string, number>;
  state: BotState;
  cfg: Config;
  nowMs?: number;
}

function isGateHauler(cfg: Config, shipSym: string): boolean {
  for (const h of cfg.GATE_HAULERS) if (shipSym === h || shipSym.endsWith(`-${h}`)) return true;
  return false;
}

function cargoUnits(ship: Ship, sym: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === sym)?.units || 0;
}

function gateMaterialSet(cfg: Config): Set<string> {
  return new Set(cfg.GATE_PROTECT_MATERIALS);
}

function heldNeededGateCargo(ship: Ship, state: BotState, cfg: Config): Array<{ symbol: string; units: number }> {
  const mats = gateMaterialSet(cfg);
  const remaining = state.gateCache.remaining;
  return ship.cargo.inventory.filter((i) => mats.has(i.symbol) && (remaining[i.symbol] || 0) > 0 && i.units > 0);
}

export function deliverWhenPaused(ship: Ship, state: BotState, cfg: Config): boolean {
  return state.gateBuyPaused && heldNeededGateCargo(ship, state, cfg).length > 0;
}

// [GATE PRICE PATIENCE] Per capped material state machine. ABOVE cap → 'paused'. On the drop back UNDER the cap we
// enter 'settling' and hold buys for GATE_PRICE_SETTLE_MS, tracking the low; we resume ('normal') once the price
// rebounds >GATE_PRICE_REBOUND_EPS off that low (it bottomed) or the window elapses. A good never paused stays
// 'normal' (buys immediately). Monotonic, so concurrent per-ship calls converge. Note: only advances while
// planGateFill runs (i.e. credits >= floor); in practice credits recover before a spiked good cools to its cap.
export function gateBuyAllowed(
  state: BotState,
  cfg: Config,
  sym: string,
  curMinPx: number,
  cap: number | undefined,
  nowMs = Date.now(),
): boolean {
  if (!cap || !(cfg.GATE_PRICE_SETTLE_MS > 0)) return !cap ? true : curMinPx <= cap; // patience off → cap is a hard line
  let st: PriceSettleState | undefined = state.gatePxState.get(sym);
  if (!st) {
    st = { state: 'normal' };
    state.gatePxState.set(sym, st);
  }
  if (curMinPx > cap) {
    st.state = 'paused';
    delete st.since;
    delete st.low;
    return false;
  }
  if (st.state === 'paused') {
    st.state = 'settling';
    st.since = nowMs;
    st.low = curMinPx;
    log.info(`gate ${sym} dropped under cap ${cap} @${curMinPx} → settling (watch for a lower entry)`);
    return false;
  }
  if (st.state === 'settling') {
    st.low = Math.min(st.low ?? curMinPx, curMinPx);
    const waited = nowMs - (st.since ?? nowMs) >= cfg.GATE_PRICE_SETTLE_MS;
    const rebounded = curMinPx > st.low * (1 + cfg.GATE_PRICE_REBOUND_EPS);
    if (waited || rebounded) {
      st.state = 'normal';
      log.info(`gate ${sym} price settled @${curMinPx} (low ${st.low}, ${rebounded ? 'rebounded' : 'timeout'}) → resuming buys`);
      return true;
    }
    return false;
  }
  return true;
}

export function planGateFill(
  remaining: Record<string, number>,
  claims: Map<string, number>,
  markets: Record<string, Market>,
  opts: PlanGateFillOptions,
): GateFillPlan[] {
  if (opts.free <= 0 || opts.headroom <= 0) return [];
  const minPx: Record<string, number> = {};
  const cands: Array<{ sym: string; wp: string; px: number; tv: number }> = [];
  for (const [sym, need] of Object.entries(remaining)) {
    const open = need - (claims.get(sym) || 0);
    if (open <= 0) continue;
    for (const [wp, m] of Object.entries(markets)) {
      const gg = (m.tradeGoods ?? []).find((x): x is MarketGood => x.symbol === sym);
      if (!gg || !(gg.purchasePrice > 0)) continue;
      // Only buy from PRODUCERS: EXPORT markets make the good (price reflects production), EXCHANGE is
      // neutral. IMPORT markets are CONSUMERS (e.g. A4 imports ADVANCED_CIRCUITRY to make ANTIMATTER) —
      // their listed purchasePrice is a wrong-direction/scarce price, so never source the gate there.
      if (gg.type !== 'EXPORT' && gg.type !== 'EXCHANGE') continue;
      cands.push({ sym, wp, px: gg.purchasePrice, tv: gg.tradeVolume || 0 });
      if (minPx[sym] === undefined || gg.purchasePrice < minPx[sym]) minPx[sym] = gg.purchasePrice;
    }
  }

  const capOK: Record<string, boolean> = {};
  for (const [sym, px] of Object.entries(minPx)) capOK[sym] = gateBuyAllowed(opts.state, opts.cfg, sym, px, opts.absMax?.[sym], opts.nowMs);
  const cheap = cands
    .filter((o) => {
      const floor = minPx[o.sym] ?? o.px;
      if (o.px > floor * opts.ceilFactor) return false;
      const am = opts.absMax?.[o.sym];
      if (!am) return true; // no absolute cap for this good
      return o.px <= am && capOK[o.sym] === true;
    })
    .sort((a, b) => a.px - b.px);

  const buys: GateFillPlan[] = [];
  const planned: Record<string, number> = {};
  let free = opts.free;
  let headroom = opts.headroom;
  for (const o of cheap) {
    if (free <= 0 || headroom <= 0) break;
    const open = (remaining[o.sym] || 0) - (claims.get(o.sym) || 0) - (planned[o.sym] || 0);
    if (open <= 0) continue;
    const unitCost = o.px * opts.slippage;
    const affordable = Math.floor(headroom / Math.max(1, unitCost));
    const cap = o.tv > 0 ? o.tv : free;
    const units = Math.min(free, cap, open, affordable);
    if (units <= 0) continue;
    buys.push({ sym: o.sym, wp: o.wp, units, px: o.px });
    planned[o.sym] = (planned[o.sym] || 0) + units;
    free -= units;
    headroom -= Math.ceil(units * unitCost);
  }
  return buys;
}

async function gateGoTo(shipSym: string, dest: string, markets: Record<string, Market>, deps: SubsystemDeps): Promise<void> {
  if ((deps.cfg.GATE_FUEL_CARGO || deps.cfg.FUEL_CARGO) && (await goToWithFuelCargo(shipSym, dest, markets, deps))) return;
  await deps.goTo(shipSym, dest, markets);
}

async function deliverHeld(shipSym: string, ship: Ship, markets: Record<string, Market>, deps: SubsystemDeps, reason: string): Promise<boolean> {
  const held = heldNeededGateCargo(ship, deps.state, deps.cfg);
  if (!held.length) return false;
  const ps = (deps.state.perShip[shipSym] = deps.state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
  const total = held.reduce((s, i) => s + i.units, 0);
  ps.last = `SUPPLY_GATE(held) ${total}u`;
  log.info(`⛏ ${shipSym.slice(-3)} delivering held ${total}u [${held.map((i) => `${i.units} ${i.symbol}`).join(', ')}] → ${deps.state.gateCache.wp?.slice(-3) ?? '???'} (${reason})`);
  const gateWp = deps.state.gateCache.wp;
  if (!gateWp) return false;
  await gateGoTo(shipSym, gateWp, markets, deps);
  await supplyHeldToGate(shipSym, held.map((i) => i.symbol), deps, '⛏');
  return true;
}

async function gateSupplyTripCore(shipSym: string, ship: Ship, markets: Record<string, Market>, deps: SubsystemDeps): Promise<boolean> {
  const { state, cfg } = deps;
  const g = state.gateCache;
  if (!gateSupplyActive(state, cfg)) return false;
  if (!gateCreditOk(state)) return deliverHeld(shipSym, ship, markets, deps, 'buy paused');
  if (!isGateHauler(cfg, shipSym) && !state.gateActiveSuppliers.has(shipSym) && state.gateActiveSuppliers.size >= cfg.GATE_MAX_SUPPLIERS) return false;

  let free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (cfg.GATE_SUPPLY_MAX_UNITS > 0) free = Math.min(free, cfg.GATE_SUPPLY_MAX_UNITS);
  const buys = planGateFill(g.remaining, state.gateClaims, markets, {
    free,
    // [RESERVE] Gate spend goes through the operating reserve like every other expense: cap headroom by
    // BOTH the gate credit-floor (overspend guard) AND growthBudget() (= credits − committed in-flight −
    // OPERATING_RESERVE). Whichever is more restrictive binds, so gate buying can never dip working capital
    // below the rolling reserve (fuel + lane buffer) or double-spend cash already committed to trades.
    headroom: Math.min(growthBudget(state), state.cachedCredits - state.gateLevers.floor),
    slippage: cfg.SLIPPAGE_FACTOR,
    ceilFactor: cfg.GATE_PRICE_CEIL_FACTOR,
    absMax: cfg.GATE_MAX_PRICE,
    state,
    cfg,
  });
  if (!buys.length) return deliverHeld(shipSym, ship, markets, deps, 'no new buys');

  const reserved: Record<string, number> = {};
  for (const b of buys) reserved[b.sym] = (reserved[b.sym] || 0) + b.units;
  for (const [sym, u] of Object.entries(reserved)) state.gateClaims.set(sym, (state.gateClaims.get(sym) || 0) + u);
  state.gateActiveSuppliers.add(shipSym);

  const total = buys.reduce((s, b) => s + b.units, 0);
  const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
  ps.last = `SUPPLY_GATE ${total}u`;
  log.info(`⛏ ${shipSym.slice(-3)} gate-fill ${total}u [${buys.map((b) => `${b.units} ${b.sym}@${b.wp.slice(-3)}`).join(', ')}] → ${g.wp?.slice(-3) ?? '???'} (credits ${state.cachedCredits.toLocaleString()})`);
  try {
    const byWp: Record<string, GateFillPlan[]> = {};
    for (const b of buys) (byWp[b.wp] = byWp[b.wp] ?? []).push(b);
    for (const [wp, list] of Object.entries(byWp)) {
      await deps.goTo(shipSym, wp, markets);
      await shedSpareFuel(shipSym, deps);
      for (const b of list) {
        try {
          await deps.actions.buy(shipSym, b.sym, b.units, Math.round(b.px * (1 + cfg.SLIPPAGE_FACTOR)));
        } catch (e) {
          log.warn(`${shipSym.slice(-3)} gate buy ERR ${b.units} ${b.sym}@${wp.slice(-3)}: ${(e as Error).message}`);
        }
      }
    }
    if (g.wp) await gateGoTo(shipSym, g.wp, markets, deps);
    const fresh = await deps.actions.getShip(shipSym);
    await supplyHeldToGate(shipSym, Object.keys(reserved).filter((sym) => cargoUnits(fresh, sym) > 0), deps, '⛏');
  } catch (e) {
    log.warn(`${shipSym} gate-supply ERR ${(e as Error).message}`);
  } finally {
    for (const [sym, u] of Object.entries(reserved)) state.gateClaims.set(sym, Math.max(0, (state.gateClaims.get(sym) || 0) - u));
    state.gateActiveSuppliers.delete(shipSym);
  }
  return true;
}

// [FUEL_CARGO] At a buy point, reclaim slots held by leftover carried FUEL so goods always win: first burn fuel
// into the tank (refuelFromCargo), then sell the rest if this market buys FUEL, else jettison. No-op when not
// carrying any FUEL cargo. Called right before sourcing goods after a fuel-cargo arrival.
export async function shedSpareFuel(shipSym: string, deps: SubsystemDeps): Promise<void> {
  let ship = await deps.actions.getShip(shipSym);
  if (cargoUnits(ship, 'FUEL') <= 0) return;
  await deps.client.api('POST', `/my/ships/${shipSym}/refuel`, { fromCargo: true }).catch(() => undefined);
  ship = await deps.actions.getShip(shipSym);
  if (cargoUnits(ship, 'FUEL') <= 0) return;
  try {
    await deps.actions.sell(shipSym, 'FUEL');
  } catch {
    /* best-effort */
  }
  ship = await deps.actions.getShip(shipSym);
  const left = cargoUnits(ship, 'FUEL');
  if (left > 0) await deps.client.api('POST', `/my/ships/${shipSym}/jettison`, { symbol: 'FUEL', units: left }).catch(() => undefined);
}

export function createGateHooks(deps: SubsystemDeps): GateHooks {
  return {
    gateHauler: async (shipSym, ship, markets) => {
      if (!isGateHauler(deps.cfg, shipSym)) return false;
      if (!(deps.cfg.GATE_SUPPLY && deps.state.gateCache.exists && !deps.state.gateCache.built)) return false;
      return gateSupplyTripCore(shipSym, ship, markets, deps);
    },
    gateSupplyTrip: async (shipSym, ship, markets) => {
      if (isGateHauler(deps.cfg, shipSym)) return false;
      if (deps.cfg.GATE_MAX_SUPPLIERS <= 0) return false;
      return gateSupplyTripCore(shipSym, ship, markets, deps);
    },
    orphanGate: createOrphanGateHook(deps, (sym) => isGateHauler(deps.cfg, sym)),
  };
}
