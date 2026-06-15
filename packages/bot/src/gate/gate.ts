import type { Config, Market, MarketGood, Ship } from '@st/shared';
import type { GateHooks, SubsystemDeps } from '../subsystems/deps.js';
import type { BotState } from '../runtime/state.js';
import { gateSupplyActive, gateCreditOk } from '../budget/phase.js';
import { commit, growthBudget, uncommit } from '../budget/budget.js';
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

// [GATE PRICE HYSTERESIS] Per-capped-material LATCH (anti-sawtooth at the price ceiling). PAUSE buys when the cheapest
// source exceeds GATE_MAX_PRICE; do NOT resume until it COOLS to the resume price (an explicit GATE_RESUME_PRICE
// override, or max × GATE_RESUME_PRICE_FACTOR) — a deadband below the cap. Between resume-price and cap we HOLD the
// prior state. Mirrors the credit floor/resume latch, inverted for price. (Replaces the old settle-FSM; FEED keeps it.)
export function gateBuyAllowed(state: BotState, cfg: Config, sym: string, curMinPx: number, cap: number | undefined): boolean {
  if (!cap) return true; // no cap configured → always allowed
  const resume = cfg.GATE_RESUME_PRICE[sym] || Math.round(cap * cfg.GATE_RESUME_PRICE_FACTOR);
  const was = state.gatePxPaused.get(sym) === true;
  if (curMinPx > cap) state.gatePxPaused.set(sym, true); // spiked above the hard cap → arm the latch
  else if (curMinPx <= resume) state.gatePxPaused.set(sym, false); // cooled to the resume price → release
  // else: in the deadband (resume < px <= cap) → hold previous state
  const paused = state.gatePxPaused.get(sym) === true;
  if (was !== paused) {
    if (paused) log.info(`💲 gate ${sym} buy PAUSED — price ${curMinPx} > cap ${cap} (resume when ≤ ${resume})`);
    else log.info(`💲 gate ${sym} buy RESUMED — price ${curMinPx} ≤ resume ${resume} (cap ${cap})`);
  }
  return !paused;
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
  for (const [sym, px] of Object.entries(minPx)) capOK[sym] = gateBuyAllowed(opts.state, opts.cfg, sym, px, opts.absMax?.[sym]);
  const cheap = cands
    .filter((o) => {
      const floor = minPx[o.sym] ?? o.px;
      if (o.px > floor * opts.ceilFactor) return false;
      const am = opts.absMax?.[o.sym];
      if (!am) return true; // no absolute cap for this good
      return o.px <= am && capOK[o.sym] === true;
    })
    .sort((a, b) => a.px - b.px);

  // [GATE FILL] Pack the hold: add tradeVolume-sized lots cheapest-first, cycling across all still-needed materials,
  // until the hold (free) or the headroom is exhausted (or nothing still needs units). Previously each material was
  // capped at ONE tradeVolume lot per trip, which left big haulers HALF-EMPTY (e.g. 20 FAB + 20 ADV = 40/80) and
  // doubled the number of gate trips (and fuel). Cycling one lot per material per pass naturally balances the basket
  // (→ 40 FAB + 40 ADV on an 80 hull) while favoring the cheaper long-pole. The per-lot price ceiling enforced in
  // buy() (GATE_MAX_PRICE) still aborts a run if a source spikes, so packing the hold while cheap/abundant is safe.
  const order: Record<string, number> = {}; // "sym@wp" -> accumulated units
  let free = opts.free;
  let headroom = opts.headroom;
  let progress = true;
  while (free > 0 && headroom > 0 && progress) {
    progress = false;
    for (const o of cheap) {
      if (free <= 0 || headroom <= 0) break;
      const plannedSym = Object.entries(order)
        .filter(([k]) => k.startsWith(o.sym + '@'))
        .reduce((s, [, u]) => s + u, 0);
      const open = (remaining[o.sym] || 0) - (claims.get(o.sym) || 0) - plannedSym;
      if (open <= 0) continue;
      const unitCost = o.px * opts.slippage;
      const affordable = Math.floor(headroom / Math.max(1, unitCost));
      const lot = Math.min(free, o.tv > 0 ? o.tv : free, open, affordable); // one tradeVolume lot this pass
      if (lot <= 0) continue;
      const key = o.sym + '@' + o.wp;
      order[key] = (order[key] || 0) + lot;
      free -= lot;
      headroom -= Math.ceil(lot * unitCost);
      progress = true;
    }
  }
  const buys: GateFillPlan[] = [];
  for (const [key, units] of Object.entries(order)) {
    const at = key.lastIndexOf('@');
    const sym = key.slice(0, at);
    const wp = key.slice(at + 1);
    const o = cheap.find((x) => x.sym === sym && x.wp === wp);
    if (o) buys.push({ sym, wp, units, px: o.px });
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
  // [GATE DELIVER-FIRST] If we're already standing AT the gate holding still-needed material (a restart caught us here
  // mid-trip, or a prior leg ended at the gate), DELIVER it NOW rather than planning a buy trip that hauls it away on a
  // wasteful detour. Delivery is free, ungated by the credit floor, and always advances the gate. After dropping off we
  // fall through next loop to a fresh (empty-hold) buy trip.
  if (ship.nav.waypointSymbol === g.wp && ship.nav.status !== 'IN_TRANSIT') {
    const heldNeeded = heldNeededGateCargo(ship, state, cfg);
    if (heldNeeded.length) {
      const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
      ps.last = `SUPPLY_GATE(at-gate) ${heldNeeded.reduce((s, i) => s + i.units, 0)}u`;
      log.info(`⛏ ${shipSym.slice(-3)} at gate holding ${heldNeeded.map((i) => `${i.units} ${i.symbol}`).join(', ')} → deliver first`);
      await supplyHeldToGate(shipSym, heldNeeded.map((i) => i.symbol), deps, '⛏');
      return true;
    }
  }
  if (!gateCreditOk(state)) return deliverHeld(shipSym, ship, markets, deps, 'buy paused');
  if (!isGateHauler(cfg, shipSym) && !state.gateActiveSuppliers.has(shipSym) && state.gateActiveSuppliers.size >= cfg.GATE_MAX_SUPPLIERS) return false;

  let free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (cfg.GATE_SUPPLY_MAX_UNITS > 0) free = Math.min(free, cfg.GATE_SUPPLY_MAX_UNITS);
  const buys = planGateFill(g.remaining, state.gateClaims, markets, {
    free,
    // [RESERVE + BUDGET FRACTION] Gate spend goes through the operating reserve like every other expense, AND is limited
    // to budgetFraction (default 0.8) of the free growth budget so it never starves the trading/contract/feed engine
    // that refills the pool. headroom = min( fraction × growthBudget , credits − gate floor ). growthBudget already =
    // credits − committed in-flight − OPERATING_RESERVE, so the reserve and committed cash are protected; the fraction
    // leaves the rest liquid for the earners; the gate credit-floor is the separate nest-egg overspend guard.
    headroom: Math.min(Math.floor(state.gateLevers.budgetFraction * growthBudget(state)), state.cachedCredits - state.gateLevers.floor),
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
  // [RESERVE] Commit the estimated spend SYNCHRONOUSLY before buying — like trade lanes / input-feed do — so a
  // concurrent gate hauler or trade claim sees the reduced growthBudget and can't oversubscribe the same cash below the
  // operating reserve. Reconciled to the real spend after the buys (uncommit estimate; the actual cash already left the
  // agent). estCost uses the per-lot price cap (worst case) × slippage so we never under-commit.
  let estCost = 0;
  for (const b of buys) {
    const px = cfg.GATE_MAX_PRICE[b.sym] || Math.round(b.px * (1 + cfg.SLIPPAGE_FACTOR));
    estCost += Math.ceil(b.units * px);
  }
  commit(state, estCost);
  const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
  ps.last = `SUPPLY_GATE ${total}u`;
  log.info(`⛏ ${shipSym.slice(-3)} gate-fill ${total}u [${buys.map((b) => `${b.units} ${b.sym}@${b.wp.slice(-3)}`).join(', ')}] → ${g.wp?.slice(-3) ?? '???'} (credits ${state.cachedCredits.toLocaleString()}, committed ${estCost.toLocaleString()})`);
  try {
    const byWp: Record<string, GateFillPlan[]> = {};
    for (const b of buys) (byWp[b.wp] = byWp[b.wp] ?? []).push(b);
    for (const [wp, list] of Object.entries(byWp)) {
      await deps.goTo(shipSym, wp, markets);
      await shedSpareFuel(shipSym, deps);
      for (const b of list) {
        // [GATE FILL] Per-lot price ceiling = the configured GATE_MAX_PRICE abs cap (the "only buy when ≤ this" price),
        // NOT just first-lot+slippage. buy() re-reads price each tradeVolume lot and stops if it climbs past this — so a
        // packed multi-lot hold keeps buying while the source stays under the real cap, instead of stalling ~10% above
        // the first lot's price (which left holds half-filled). Falls back to px+slippage when no abs cap is configured.
        const maxPx = cfg.GATE_MAX_PRICE[b.sym] || Math.round(b.px * (1 + cfg.SLIPPAGE_FACTOR));
        try {
          await deps.actions.buy(shipSym, b.sym, b.units, maxPx);
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
    uncommit(state, estCost); // [RESERVE] release the estimate; the real cash already left the agent (refreshCredits reconciles)
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
