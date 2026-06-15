/**
 * trade/shipActions.ts — trade-execution primitives (faithful port of trade.mjs).
 *
 * Drives a ship through buy/navigate/sell steps with fuel management, flight-mode
 * selection, slippage-aware buying, and real-time arrival waiting. Shares the
 * module-global rate limiter via the injected {@link SpaceTradersClient}. No
 * persistence here.
 *
 * `[RULE:*]` comments are preserved verbatim from the legacy source.
 */

import type { ApiEnvelope, FlightMode, HttpMethod, ShipActions, SpaceTradersClient } from '../interfaces.js';
import type { Market, MarketGood, Ship } from '@st/shared';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'ship' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Derive the system from the waypoint symbol (X1-PP30-A4 → X1-PP30) so buy/sell work in ANY system
// (home or a jumped-to expansion system), not just the hardcoded SYSTEM. Home behavior is unchanged.
const sysOf = (wp: string): string => wp.split('-').slice(0, 2).join('-');

export function createShipActions(client: SpaceTradersClient): ShipActions {
  // Wrapper (not a bare method reference) so `this` stays bound to the client.
  const api = <T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> =>
    client.api<T>(method, path, body);

  async function getShip(sym: string): Promise<Ship> {
    return (await api<ApiEnvelope<Ship>>('GET', `/my/ships/${sym}`)).data;
  }

  async function waitArrival(sym: string, ship?: Ship): Promise<Ship> {
    for (;;) {
      ship = ship ?? (await getShip(sym));
      if (ship.nav.status !== 'IN_TRANSIT') return ship;
      const arrivalMs = Date.parse(ship.nav.route.arrival);
      const waitMs = arrivalMs - Date.now();
      if (waitMs > 0) {
        log.info(`${sym} in transit -> ${ship.nav.route.destination.symbol}, ETA ${Math.ceil(waitMs / 1000)}s`);
        await sleep(Math.min(waitMs + 1500, 60000));
      }
      ship = await getShip(sym);
      if (ship.nav.status !== 'IN_TRANSIT') return ship;
    }
  }

  async function ensureDocked(sym: string, shipState?: Ship): Promise<Ship> {
    let ship = shipState ?? (await getShip(sym));
    if (ship.nav.status === 'IN_TRANSIT') ship = await waitArrival(sym, ship);
    if (ship.nav.status !== 'DOCKED') {
      await api('POST', `/my/ships/${sym}/dock`);
      ship = await getShip(sym);
    }
    return ship;
  }

  async function ensureOrbit(sym: string): Promise<void> {
    const ship = await getShip(sym);
    if (ship.nav.status === 'DOCKED') await api('POST', `/my/ships/${sym}/orbit`);
  }

  async function refuel(sym: string): Promise<Ship> {
    const ship = await ensureDocked(sym);
    if (ship.fuel.capacity === 0) return ship; // probes
    if (ship.fuel.current >= ship.fuel.capacity) return ship;
    try {
      const r = await api<ApiEnvelope<{ fuel: { current: number; capacity: number } }>>(
        'POST',
        `/my/ships/${sym}/refuel`,
      );
      log.info(`${sym} refueled -> ${r.data.fuel.current}/${r.data.fuel.capacity}`);
      return await getShip(sym);
    } catch (e) {
      log.info(`${sym} refuel skipped: ${(e as Error).message}`);
      return ship;
    }
  }

  async function setMode(sym: string, mode: FlightMode): Promise<void> {
    const ship = await getShip(sym);
    if (ship.nav.flightMode === mode) return;
    await api('PATCH', `/my/ships/${sym}/nav`, { flightMode: mode });
  }

  async function navigate(sym: string, dest: string, mode: FlightMode = 'CRUISE'): Promise<Ship> {
    const ship = await getShip(sym);
    if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') {
      log.info(`${sym} already at ${dest}`);
      return ship;
    }
    await refuel(sym);
    // try the requested mode, then downgrade on insufficient-fuel (handles coords/rounding drift)
    const ladder: FlightMode[] =
      mode === 'BURN' ? ['BURN', 'CRUISE', 'DRIFT'] : mode === 'CRUISE' ? ['CRUISE', 'DRIFT'] : ['DRIFT'];
    for (let i = 0; i < ladder.length; i++) {
      const m = ladder[i]!;
      await setMode(sym, m);
      await ensureOrbit(sym);
      try {
        const r = await api<ApiEnvelope<{ fuel: { current: number }; nav: { route: { arrival: string } } }>>(
          'POST',
          `/my/ships/${sym}/navigate`,
          { waypointSymbol: dest },
        );
        log.info(`${sym} -> ${dest} (${m}) fuel=${r.data.fuel.current} ETA ${r.data.nav.route.arrival}`);
        return await waitArrival(sym, await getShip(sym));
      } catch (e) {
        const msg = (e as Error).message;
        // [RULE: idempotent-nav] transit→arrival race: ship arrives between our status read and the POST → API 400
        // "located at the destination". Treat as success (we're already there) instead of throwing/crashing.
        if (/located at the destination/i.test(msg)) {
          log.info(`${sym} already at ${dest} (arrived mid-call)`);
          return await getShip(sym);
        }
        if (/requires \d+ more fuel/.test(msg) && i < ladder.length - 1) {
          log.info(`${sym} ${m} short on fuel for ${dest}, downgrading to ${ladder[i + 1]!}`);
          continue;
        }
        throw e;
      }
    }
    // Ladder exhausted (all modes failed without a thrown error) — return current state.
    return getShip(sym);
  }

  async function marketGood(wp: string, symbol: string): Promise<MarketGood | undefined> {
    const m = (await api<ApiEnvelope<Market>>('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
    return m.tradeGoods?.find((g) => g.symbol === symbol);
  }

  async function buy(sym: string, symbol: string, units: number, maxPx?: number): Promise<{ bought: number; spent: number }> {
    let ship = await ensureDocked(sym);
    const wp = ship.nav.waypointSymbol;
    let bought = 0;
    let spent = 0;
    while (bought < units) {
      const g = await marketGood(wp, symbol);
      if (!g) {
        log.info(`${sym} ${symbol} not sold at ${wp}`);
        break;
      }
      if (maxPx && g.purchasePrice > maxPx) {
        log.info(`${sym} ${symbol} px ${g.purchasePrice} > max ${maxPx}, stop (bought ${bought})`);
        break;
      }
      const space = ship.cargo.capacity - ship.cargo.units;
      const lot = Math.min(g.tradeVolume, units - bought, space);
      if (lot <= 0) {
        if (space <= 0) log.info(`${sym} ${symbol} buy stalled: cargo FULL (${ship.cargo.units}/${ship.cargo.capacity})`);
        break;
      }
      const r = await api<ApiEnvelope<{ transaction: { totalPrice: number; pricePerUnit: number } }>>(
        'POST',
        `/my/ships/${sym}/purchase`,
        { symbol, units: lot },
      );
      bought += lot;
      spent += r.data.transaction.totalPrice;
      ship = await getShip(sym);
      log.info(`${sym} bought ${lot} ${symbol} @ ${r.data.transaction.pricePerUnit} (cargo ${ship.cargo.units}/${ship.cargo.capacity})`);
      if (lot < g.tradeVolume) break;
    }
    return { bought, spent };
  }

  async function sell(sym: string, symbol: string): Promise<{ got: number }> {
    let ship = await ensureDocked(sym);
    const wp = ship.nav.waypointSymbol;
    const items = symbol === 'ALL' ? ship.cargo.inventory.map((i) => i.symbol) : [symbol];
    let got = 0;
    for (const it of items) {
      let inv = ship.cargo.inventory.find((i) => i.symbol === it);
      while (inv && inv.units > 0) {
        const g = await marketGood(wp, it);
        if (!g) {
          log.info(`${sym} ${it} not bought at ${wp} (keep ${inv.units})`);
          break;
        }
        const lot = Math.min(g.tradeVolume, inv.units);
        const r = await api<ApiEnvelope<{ transaction: { totalPrice: number; pricePerUnit: number } }>>(
          'POST',
          `/my/ships/${sym}/sell`,
          { symbol: it, units: lot },
        );
        got += r.data.transaction.totalPrice;
        ship = await getShip(sym);
        log.info(`${sym} sold ${lot} ${it} @ ${r.data.transaction.pricePerUnit} (+${r.data.transaction.totalPrice})`);
        inv = ship.cargo.inventory.find((i) => i.symbol === it);
        if (lot < g.tradeVolume) break;
      }
    }
    return { got };
  }

  async function transfer(fromSym: string, toSym: string, symbol: string, units: number): Promise<unknown> {
    // both ships must be co-located (same waypoint), in orbit or docked
    // [RULE: transfer-argorder] (fromSym, toSym, symbol, units)
    await ensureOrbit(fromSym);
    await ensureOrbit(toSym);
    const r = await api<ApiEnvelope<unknown>>('POST', `/my/ships/${fromSym}/transfer`, {
      tradeSymbol: symbol,
      units,
      shipSymbol: toSym,
    });
    log.info(`${fromSym} -> ${toSym} transferred ${units} ${symbol}`);
    return r.data;
  }

  async function deliver(sym: string, contractId: string, tradeSymbol: string, units: number): Promise<unknown> {
    await ensureDocked(sym);
    const r = await api<ApiEnvelope<{ contract: { terms: { deliver: Array<{ unitsFulfilled: number; unitsRequired: number }> } } }>>(
      'POST',
      `/my/contracts/${contractId}/deliver`,
      { shipSymbol: sym, tradeSymbol, units },
    );
    const d = r.data.contract.terms.deliver[0]!;
    log.info(`${sym} delivered ${units} ${tradeSymbol} (${d.unitsFulfilled}/${d.unitsRequired})`);
    return r.data;
  }

  async function fulfill(sym: string, contractId: string): Promise<unknown> {
    const r = await api<ApiEnvelope<{ agent: { credits: number } }>>('POST', `/my/contracts/${contractId}/fulfill`);
    log.info(`${sym} FULFILLED ${contractId} credits=${r.data.agent.credits}`);
    return r.data;
  }

  // Jump a ship through a BUILT jump gate to a CONNECTED gate waypoint in another system.
  // Authoritative v2 mechanic: POST /my/ships/{sym}/jump { waypointSymbol }. The ship must be IN ORBIT;
  // a single unit of ANTIMATTER is auto-purchased+consumed from the market (a credit cost, returned in
  // `transaction`); a cooldown then applies to the ship. Returns the full data block (nav/cooldown/
  // transaction/agent) so the caller can learn the antimatter price + honor the cooldown.
  async function jump(sym: string, destGateWp: string): Promise<unknown> {
    const ship = await getShip(sym);
    if (ship.nav.status === 'DOCKED') {
      await api('POST', `/my/ships/${sym}/orbit`);
    } else if (ship.nav.status === 'IN_TRANSIT') await waitArrival(sym, ship);
    const r = await api<ApiEnvelope<{ transaction?: { totalPrice: number }; cooldown?: { remainingSeconds: number }; agent?: { credits: number } }>>(
      'POST',
      `/my/ships/${sym}/jump`,
      { waypointSymbol: destGateWp },
    );
    const cost = r.data.transaction?.totalPrice;
    const cd = r.data.cooldown?.remainingSeconds;
    log.info(`${sym} JUMPED → ${destGateWp} (antimatter ${cost ?? '?'}cr, cooldown ${cd ?? '?'}s, credits ${r.data.agent?.credits})`);
    return r.data;
  }

  return {
    getShip,
    ensureDocked,
    ensureOrbit,
    setMode,
    waitArrival,
    refuel,
    navigate,
    buy,
    sell,
    transfer,
    deliver,
    fulfill,
    jump,
  };
}
