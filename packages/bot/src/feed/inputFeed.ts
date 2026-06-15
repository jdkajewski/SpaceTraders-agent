import type { Config, Market, MarketGood, Ship } from '@st/shared';
import type { BotState, PerShipState, PriceSettleState } from '../runtime/state.js';
import type { ApiEnvelope } from '../interfaces.js';
import type { SubsystemDeps, FeedHooks } from '../subsystems/deps.js';
import { availableForWork, commit, growthBudget, uncommit } from '../budget/budget.js';
import { gateCreditOk, gateSupplyActive } from '../budget/phase.js';
import { focusProducerWps } from '../trade/lanes.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'feed' });
const SUPPLY_RANK: Record<string, number> = { SCARCE: 0, LIMITED: 1, MODERATE: 2, HIGH: 3, ABUNDANT: 4 };

function ensurePerShip(state: BotState, shipSym: string): PerShipState {
  const ps = state.perShip[shipSym] ?? { net: 0, lanes: 0, last: '' };
  state.perShip[shipSym] = ps;
  return ps;
}

export interface GateProducerInputTarget {
  producerWp: string;
  material: string;
  remaining: number;
  inputs: string[];
}

export interface InputFeedBuy {
  sym: string;
  srcWp: string;
  buyPx: number;
  sellPx: number;
  margin: number;
  tv: number;
  scarce: number;
  units: number;
}

export interface PlanInputFeedOptions {
  free: number;
  headroom: number;
  maxLoss?: number;
}

export function isInputFeeder(shipSym: string, cfg: Config): boolean {
  for (const h of cfg.INPUT_FEEDERS) if (shipSym === h || shipSym.endsWith(`-${h}`)) return true;
  return false;
}

export function inputFeedActive(state: BotState, cfg: Config): boolean {
  return cfg.INPUT_FEED && gateSupplyActive(state, cfg);
}

export function inputFeedMax(cfg: Config): number {
  return Math.min(2, cfg.INPUT_FEED_MAX);
}

export function canStartInputFeed(shipSym: string, state: BotState, cfg: Config): boolean {
  return isInputFeeder(shipSym, cfg) || state.inputActiveFeeders.has(shipSym) || state.inputActiveFeeders.size < inputFeedMax(cfg);
}

export function gateProducerInputTargets(state: BotState, cfg: Config, markets: Record<string, Market>): GateProducerInputTarget[] {
  const out: GateProducerInputTarget[] = [];
  if (!inputFeedActive(state, cfg)) return out;
  const needed = Object.entries(state.gateCache.remaining || {}).sort((a, b) => b[1] - a[1]); // long pole first
  for (const [mat, remaining] of needed) {
    for (const [wp, m] of Object.entries(markets)) {
      const prod = (m.tradeGoods || []).find((x) => x.symbol === mat && x.type === 'EXPORT');
      if (!prod) continue;
      const inputs = (m.tradeGoods || []).filter((x) => x.type === 'IMPORT').map((x) => x.symbol);
      if (inputs.length) out.push({ producerWp: wp, material: mat, remaining, inputs });
    }
  }
  return out;
}

export function feedBuyAllowed(state: BotState, cfg: Config, sym: string, curPx: number, cap: number, now = Date.now()): boolean {
  if (!cap || !(cfg.FEED_PRICE_SETTLE_MS > 0)) return !cap ? true : curPx <= cap; // patience off → cap is a hard line
  let st: PriceSettleState | undefined = state.feedPxState.get(sym);
  if (!st) {
    st = { state: 'normal' };
    state.feedPxState.set(sym, st);
  }
  if (curPx > cap) {
    st.state = 'paused';
    return false;
  }
  if (st.state === 'paused') {
    st.state = 'settling';
    st.since = now;
    st.low = curPx;
    log.info(`feed ${sym} dropped under cap ${cap} @${curPx} → settling (watch for a lower entry)`);
    return false;
  }
  if (st.state === 'settling') {
    st.low = Math.min(st.low ?? curPx, curPx);
    const waited = now - (st.since ?? now) >= cfg.FEED_PRICE_SETTLE_MS;
    const rebounded = curPx > st.low * (1 + cfg.FEED_PRICE_REBOUND_EPS);
    if (waited || rebounded) {
      st.state = 'normal';
      log.info(`feed ${sym} price settled @${curPx} (low ${st.low}, ${rebounded ? 'rebounded' : 'timeout'}) → resuming feed buys`);
      return true;
    }
    return false;
  }
  return true;
}

// [INPUT_FEED] Plan a profitable basket of a producer's imported inputs: for each input the producer buys
// (its IMPORT entry's sellPrice = what we receive), find the cheapest EXTERNAL producer source and keep it
// only if margin > 0. Greedy by per-lot gross, one tradeVolume lot each (off the slippage curve), bounded
// by free cargo + cash headroom. Returns [{ sym, srcWp, buyPx, sellPx, margin, tv, units }].
export function planInputFeed(
  producerWp: string,
  inputs: string[],
  markets: Record<string, Market>,
  opts: PlanInputFeedOptions,
  state: BotState,
  cfg: Config,
): InputFeedBuy[] {
  const { free, headroom, maxLoss = 0 } = opts;
  if (free <= 0 || headroom <= 0) return [];
  const dst = markets[producerWp];
  if (!dst) return [];
  const dstBuy: Record<string, MarketGood> = {};
  for (const g of dst.tradeGoods || []) if (g.type === 'IMPORT') dstBuy[g.symbol] = g;
  const cands: Array<Omit<InputFeedBuy, 'units'>> = [];
  for (const sym of inputs) {
    const d = dstBuy[sym];
    if (!d || !(d.sellPrice > 0)) continue;
    let bestSrc: { wp: string; px: number; tv: number } | null = null;
    for (const [wp, m] of Object.entries(markets)) {
      if (wp === producerWp) continue;
      const s = (m.tradeGoods || []).find((x) => x.symbol === sym && (x.type === 'EXPORT' || x.type === 'EXCHANGE'));
      if (!s || !(s.purchasePrice > 0)) continue;
      if (!bestSrc || s.purchasePrice < bestSrc.px) bestSrc = { wp, px: s.purchasePrice, tv: s.tradeVolume || 0 };
    }
    if (!bestSrc) continue;
    const margin = d.sellPrice - bestSrc.px;
    if (margin < -maxLoss) continue; // [FEED FOCUS] feed down to a capped LOSS/unit for focus producers (maxLoss>0); never below
    // [FEED FOCUS] Buy-timing: cap = what the producer pays + the allowed loss (or a tighter FEED_MAX_PRICE override).
    // Pause this input when its source is above the cap; once under, the settle window waits for the low before buying.
    const cap = cfg.FEED_MAX_PRICE[sym] ?? d.sellPrice + maxLoss;
    if (!feedBuyAllowed(state, cfg, sym, bestSrc.px, cap)) continue;
    const tv = Math.min(bestSrc.tv || 20, d.tradeVolume || 20);
    cands.push({ sym, srcWp: bestSrc.wp, buyPx: bestSrc.px, sellPx: d.sellPrice, margin, tv, scarce: SUPPLY_RANK[d.supply] ?? 2 });
  }
  // [INPUT_FEED] Scarcity-FIRST: feed the producer's SCARCEST inputs first (those throttle its output the
  // most). Only profitable inputs reach here, so this never trades a loss — it just rebalances WHICH input
  // we haul so we don't dump everything into the single highest-margin good (e.g. COPPER) and starve the
  // others (IRON/QUARTZ/SILICON). Tie-break by per-lot gross so among equally-scarce inputs we take the
  // most lucrative. As an input tiers up (SCARCE→LIMITED→…), it falls behind, so the feed rotates.
  cands.sort((a, b) => a.scarce - b.scarce || b.margin * Math.min(b.tv, free) - a.margin * Math.min(a.tv, free));
  const buys: InputFeedBuy[] = [];
  let f = free;
  let h = headroom;
  for (const c of cands) {
    if (f <= 0 || h <= 0) break;
    const aff = Math.floor(h / Math.max(1, c.buyPx * cfg.SLIPPAGE_FACTOR));
    const units = Math.min(f, c.tv, aff);
    if (units <= 0) continue;
    buys.push({ ...c, units });
    f -= units;
    h -= Math.ceil(units * c.buyPx * cfg.SLIPPAGE_FACTOR);
  }
  return buys;
}

async function inputFeedTripImpl(shipSym: string, ship: Ship, markets: Record<string, Market>, deps: SubsystemDeps): Promise<boolean> {
  const { state, cfg, actions } = deps;
  if (!inputFeedActive(state, cfg)) return false;
  if (cfg.INPUT_FEED_GATE_PAUSE && !gateCreditOk(state)) return false; // (opt-in) re-couple to the gate-buy floor + resume hysteresis
  if (availableForWork(state) < cfg.INPUT_FEED_MIN_CASH) return false; // always respect OPERATING_RESERVE (+ optional cushion); profit-positive lane
  if (!canStartInputFeed(shipSym, state, cfg)) return false;
  const free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (free <= 0) return false;

  let chosen: GateProducerInputTarget | null = null;
  let plan: InputFeedBuy[] | null = null;
  let chosenMaxLoss = 0;
  const focusSet = focusProducerWps(state, cfg, markets);
  for (const t of gateProducerInputTargets(state, cfg, markets)) {
    if (state.inputActiveProducers.has(t.producerWp)) continue; // [GUARDRAIL] 1 feeder per producer — never let two of our ships sell into the same import market at once
    const maxLoss = focusSet.has(t.producerWp) ? cfg.FEED_MAX_LOSS_PER_UNIT : 0; // [FEED FOCUS] long-pole producer may be fed at a capped loss
    const p = planInputFeed(t.producerWp, t.inputs, markets, { free, headroom: growthBudget(state), maxLoss }, state, cfg);
    const estNet = p.reduce((s, b) => s + b.margin * b.units, 0);
    // Focus producers: accept even a (capped) net-negative feed — it's a gate investment, per-unit loss already bounded
    // by maxLoss in planInputFeed. Non-focus producers must still clear INPUT_FEED_MIN_GROSS (profit-only).
    if (p.length && (maxLoss > 0 || estNet >= cfg.INPUT_FEED_MIN_GROSS)) {
      chosen = t;
      plan = p;
      chosenMaxLoss = maxLoss;
      break;
    }
  }
  if (!chosen || !plan) return false;

  state.inputActiveFeeders.add(shipSym);
  state.inputActiveProducers.add(chosen.producerWp); // [GUARDRAIL] reserve this producer for the duration of the trip
  const total = plan.reduce((s, b) => s + b.units, 0);
  const estNet = plan.reduce((s, b) => s + b.margin * b.units, 0);
  const estCost = plan.reduce((s, b) => s + Math.ceil(b.units * b.buyPx * cfg.SLIPPAGE_FACTOR), 0);
  const ps = ensurePerShip(state, shipSym);
  ps.last = `FEED ${chosen.material} ${total}u→${chosen.producerWp.slice(-3)}`;
  ps.projected = estNet;
  log.info(
    `🏭 ${shipSym.slice(-3)} input-feed ${total}u [${plan.map((b) => `${b.units} ${b.sym}@${b.srcWp.slice(-3)}`).join(', ')}] → ${chosen.producerWp.slice(-3)} (feeds ${chosen.material}, est net +${Math.round(estNet).toLocaleString()})`,
  );
  commit(state, estCost);
  let realized = 0;
  const paid: Record<string, number> = {};
  const boughtUnits: Record<string, number> = {}; // [GUARDRAIL] per-good cost basis for the sell-time margin re-check
  try {
    const byWp: Record<string, InputFeedBuy[]> = {};
    for (const b of plan) (byWp[b.srcWp] = byWp[b.srcWp] ?? []).push(b);
    for (const [wp, list] of Object.entries(byWp)) {
      await deps.goTo(shipSym, wp, markets);
      for (const b of list) {
        try {
          const r = await actions.buy(shipSym, b.sym, b.units, Math.round(b.buyPx * (1 + cfg.SLIPPAGE_FACTOR)));
          paid[b.sym] = (paid[b.sym] || 0) + (r.spent || 0);
          boughtUnits[b.sym] = (boughtUnits[b.sym] || 0) + (r.bought || 0);
        } catch (e) {
          log.warn(`${shipSym.slice(-3)} feed buy ERR ${b.units} ${b.sym}@${wp.slice(-3)}: ${(e as Error).message}`);
        }
      }
    }
    await deps.goTo(shipSym, chosen.producerWp, markets);
    // [GUARDRAIL] Sell-time margin re-check on FRESH producer data: the plan's margin was computed on a market
    // SNAPSHOT; re-fetch the producer's live IMPORT buy-prices right before selling. If a good's current buy
    // price has fallen below what we actually paid, HOLD it (leave aboard) instead of dumping at a loss —
    // reconcileHeldCargo salvages it at the best sink next loop. Net is computed over goods we actually sold.
    let fresh: Market | null = null;
    try {
      fresh = (await deps.client.api<ApiEnvelope<Market>>('GET', `/systems/${cfg.SYSTEM}/waypoints/${chosen.producerWp}/market`)).data;
    } catch {
      /* fall back to selling */
    }
    const freshBuy: Record<string, number> = {};
    if (fresh) for (const g of fresh.tradeGoods || []) if (g.type === 'IMPORT') freshBuy[g.symbol] = g.sellPrice;
    let spentSold = 0;
    for (const b of plan) {
      const got = boughtUnits[b.sym] || 0;
      if (got <= 0) continue;
      const avgCost = (paid[b.sym] || 0) / got;
      const cur = fresh ? freshBuy[b.sym] ?? 0 : null; // null ⇒ refetch failed, fall back to selling
      // [FEED FOCUS] HOLD only if the live loss EXCEEDS the allowed cap. For focus feeds we INTEND to accept up to
      // chosenMaxLoss/unit, so a small loss is fine to sell; a deeper drop means HOLD + salvage later (don't dump).
      if (cur != null && cur > 0 && avgCost - cur > chosenMaxLoss) {
        log.info(
          `🛡️ ${shipSym.slice(-3)} HOLD ${b.sym}: producer buy ${cur} < cost ${Math.round(avgCost)} (loss > cap ${chosenMaxLoss}) — salvaging later, not dumping`,
        );
        continue;
      }
      try {
        const rs = await actions.sell(shipSym, b.sym);
        realized += rs.got || 0;
        spentSold += paid[b.sym] || 0;
      } catch (e) {
        log.warn(`${shipSym.slice(-3)} feed sell ERR ${b.sym}: ${(e as Error).message}`);
      }
    }
    const net = realized - spentSold;
    await deps.record(shipSym, net, `FEED ${chosen.material} inputs`);
    log.info(`🏭 ${shipSym.slice(-3)} fed ${chosen.material} producer ${chosen.producerWp.slice(-3)} net=${net.toLocaleString()}`);
  } catch (e) {
    // Mid-trip failure: inputs stay aboard; reconcileHeldCargo salvage-sells them next loop (recovers cash).
    log.warn(`${shipSym} input-feed ERR ${(e as Error).message}`);
  } finally {
    uncommit(state, estCost);
    state.inputActiveFeeders.delete(shipSym);
    state.inputActiveProducers.delete(chosen.producerWp); // [GUARDRAIL] release the producer reservation
    ps.projected = 0;
  }
  return true;
}

export function createFeedHooks(deps: SubsystemDeps): FeedHooks {
  const noHook = (): Promise<boolean> => Promise.resolve(false);
  if (!deps.cfg.INPUT_FEED) return { inputFeeder: noHook, inputFeedTrip: noHook };
  return {
    inputFeeder: async (shipSym, ship, markets) => {
      if (!isInputFeeder(shipSym, deps.cfg) || !inputFeedActive(deps.state, deps.cfg)) return false;
      if (await inputFeedTripImpl(shipSym, ship, markets, deps)) return true;
      const ps = ensurePerShip(deps.state, shipSym);
      ps.last = 'PARKED (input feeder, no profitable feed now)';
      ps.projected = 0;
      return true;
    },
    inputFeedTrip: (shipSym, ship, markets) => inputFeedTripImpl(shipSym, ship, markets, deps),
  };
}
