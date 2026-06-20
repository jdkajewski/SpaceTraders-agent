/**
 * recovery.salvage.test.ts — orphan-cargo salvage loop-break (marketless-waypoint fix).
 *
 * Regression for the live bug: a ship holding mined ore at a MARKETLESS waypoint (asteroid field on
 * a cold DB) fell into an infinite salvage loop — `reconcileHeldCargo` tried to sell in place,
 * `GET /market` 404'd, nothing sold, the cargo stayed aboard, and the next tick re-detected it as
 * orphan → re-salvage forever (starving the trade/expansion loop). The fix: never sell where no
 * market buys the good — release the ship to the normal loop instead — and cap at-sink resell
 * retries so a stale sink can't loop us either.
 */

import { describe, it, expect, vi } from 'vitest';
import { loadConfig, type Market, type Ship } from '@st/shared';
import { reconcileHeldCargo, type ReconcileDeps } from '../recovery.js';
import { createState } from '../runtime/state.js';

const cfg = loadConfig({});

function makeShip(waypointSymbol: string, inventory: Array<{ symbol: string; units: number }>): Ship {
  const units = inventory.reduce((n, i) => n + i.units, 0);
  return {
    symbol: 'X1-AGENT-7A',
    nav: {
      systemSymbol: 'X1-ZD86',
      waypointSymbol,
      status: 'IN_ORBIT',
      flightMode: 'CRUISE',
      route: {
        origin: { symbol: waypointSymbol, x: 0, y: 0 },
        destination: { symbol: waypointSymbol, x: 0, y: 0 },
        departureTime: '',
        arrival: '',
      },
    },
    cargo: { capacity: 40, units, inventory },
    engine: { speed: 30, condition: 1 },
    frame: { condition: 1, integrity: 1 },
    fuel: { current: 400, capacity: 400 },
    mounts: [],
  };
}

/** A market that BUYS `good` at `sellPrice` (so bestSink returns it). */
function buyerMarket(symbol: string, good: string, sellPrice: number): Market {
  return {
    symbol,
    tradeGoods: [
      { symbol: good, type: 'IMPORT', tradeVolume: 100, supply: 'MODERATE', purchasePrice: sellPrice + 10, sellPrice },
    ],
  };
}

function makeDeps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    state: createState(cfg),
    cfg,
    persistence: {
      deleteIntent: vi.fn(async () => {}),
      putIntent: vi.fn(async () => {}),
      getIntents: vi.fn(async () => []),
    } as unknown as ReconcileDeps['persistence'],
    sell: vi.fn(async () => ({ got: 0 })),
    goTo: vi.fn(async () => undefined),
    record: vi.fn(async () => {}),
    ...over,
  };
}

describe('reconcileHeldCargo — orphan salvage loop-break', () => {
  it('marketless waypoint (no buyer anywhere): releases without selling, and never re-attempts across ticks', async () => {
    const deps = makeDeps();
    const sell = deps.sell as ReturnType<typeof vi.fn>;
    const goTo = deps.goTo as ReturnType<typeof vi.fn>;
    const markets: Record<string, Market> = {}; // cold DB: no market knows IRON_ORE

    // Simulate many worker ticks on the same un-sellable cargo at a marketless asteroid.
    for (let tick = 0; tick < 25; tick++) {
      const ship = makeShip('X1-ZD86-B22X', [{ symbol: 'IRON_ORE', units: 30 }]);
      const acted = await reconcileHeldCargo(ship.symbol, ship, markets, deps);
      expect(acted).toBe(false); // recovery steps aside → ship released to the normal loop
    }

    // The whole point: zero wasted sell/goTo requests — no 404 loop, no phantom salvage.
    expect(sell).not.toHaveBeenCalled();
    expect(goTo).not.toHaveBeenCalled();
  });

  it('buyer exists elsewhere: navigates to the sink, sells, and reports it acted', async () => {
    const deps = makeDeps({ sell: vi.fn(async () => ({ got: 4200 })) });
    const sell = deps.sell as ReturnType<typeof vi.fn>;
    const goTo = deps.goTo as ReturnType<typeof vi.fn>;
    const markets = { 'X1-ZD86-MKT': buyerMarket('X1-ZD86-MKT', 'IRON_ORE', 140) };
    const ship = makeShip('X1-ZD86-B22X', [{ symbol: 'IRON_ORE', units: 30 }]);

    const acted = await reconcileHeldCargo(ship.symbol, ship, markets, deps);

    expect(acted).toBe(true);
    expect(goTo).toHaveBeenCalledWith(ship.symbol, 'X1-ZD86-MKT');
    expect(sell).toHaveBeenCalledWith(ship.symbol, 'IRON_ORE');
  });

  it('stale sink that never actually buys (got 0): retries are bounded, then releases — no infinite loop', async () => {
    const deps = makeDeps({ sell: vi.fn(async () => ({ got: 0 })) }); // market claims to buy but sell yields nothing
    const sell = deps.sell as ReturnType<typeof vi.fn>;
    const markets = { 'X1-ZD86-MKT': buyerMarket('X1-ZD86-MKT', 'IRON_ORE', 140) };

    let lastActed = true;
    for (let tick = 0; tick < 25; tick++) {
      const ship = makeShip('X1-ZD86-MKT', [{ symbol: 'IRON_ORE', units: 30 }]); // already at the sink
      lastActed = await reconcileHeldCargo(ship.symbol, ship, markets, deps);
    }

    // Bounded: a handful of capped attempts, NOT one sell per tick.
    expect(sell.mock.calls.length).toBeLessThanOrEqual(3);
    expect(lastActed).toBe(false); // eventually released to the normal loop
  });

  it('mixed cargo: salvages the good a market buys, releases the rest without a phantom sale', async () => {
    const deps = makeDeps({
      sell: vi.fn(async (_s: string, good: string) => ({ got: good === 'IRON_ORE' ? 4200 : 0 })),
    });
    const sell = deps.sell as ReturnType<typeof vi.fn>;
    const markets = { 'X1-ZD86-MKT': buyerMarket('X1-ZD86-MKT', 'IRON_ORE', 140) };
    const ship = makeShip('X1-ZD86-MKT', [
      { symbol: 'IRON_ORE', units: 20 }, // a market buys this
      { symbol: 'SILICON_CRYSTALS', units: 10 }, // nothing buys this
    ]);

    const acted = await reconcileHeldCargo(ship.symbol, ship, markets, deps);

    expect(acted).toBe(true);
    // Only the sellable good is attempted; the unsellable one is never sold in place.
    const soldGoods = sell.mock.calls.map((c) => c[1]);
    expect(soldGoods).toContain('IRON_ORE');
    expect(soldGoods).not.toContain('SILICON_CRYSTALS');
  });
});
