import { describe, it, expect } from 'vitest';
import { createRouter, marketSellsFuel } from '../routing/route.js';
import type { CoordsMap, Market } from '@st/shared';
import { makeShip } from './fixtures.js';

const coords: CoordsMap = {
  A: [0, 0],
  B: [100, 0],
  C: [200, 0],
  D: [300, 0],
  F: [2000, 0],
};

// FUEL sold at B and C only → they are the routable refuel hops.
const markets = {
  B: { symbol: 'B', tradeGoods: [{ symbol: 'FUEL' }] },
  C: { symbol: 'C', tradeGoods: [{ symbol: 'FUEL' }] },
} as unknown as Record<string, Market>;

function router() {
  return createRouter({ coords, getFuelPx: () => 0.72, valueOfTime: 100, marketsRef: () => markets });
}

describe('route: marketSellsFuel', () => {
  it('detects FUEL in tradeGoods and in structure', () => {
    expect(marketSellsFuel({ tradeGoods: [{ symbol: 'FUEL' }] } as unknown as Market)).toBe(true);
    expect(marketSellsFuel({ exchange: [{ symbol: 'FUEL' }] } as unknown as Market)).toBe(true);
    expect(marketSellsFuel({ tradeGoods: [{ symbol: 'IRON' }] } as unknown as Market)).toBe(false);
    expect(marketSellsFuel(undefined)).toBe(false);
  });
});

describe('route: planRoute', () => {
  it('returns the direct destination when it fits one tank', () => {
    expect(router().planRoute('A', 'B', 120, markets)).toEqual(['B']);
  });

  it('finds a multi-hop refuel path when the destination is beyond one tank', () => {
    // cap·0.97 = 116.4; A→D is 300, so it must hop A→B→C→D.
    expect(router().planRoute('A', 'D', 120, markets)).toEqual(['B', 'C', 'D']);
  });

  it('returns null when the destination is unreachable even multi-hop', () => {
    expect(router().planRoute('A', 'F', 120, markets)).toBeNull();
  });
});

describe('route: planRouteFuelCargo', () => {
  it('routes over all coords minimising hops', () => {
    expect(router().planRouteFuelCargo('A', 'D', 120, markets)).toEqual(['B', 'C', 'D']);
  });
  it('returns null when no chain of ≤1-tank hops reaches the destination', () => {
    expect(router().planRouteFuelCargo('A', 'F', 120, markets)).toBeNull();
  });
});

describe('route: routeCost', () => {
  it('is monotonic in distance (time + fuel grow with distance)', () => {
    const r = router();
    const ship = makeShip({ fuel: { current: 2000, capacity: 2000 }, engine: { speed: 15, condition: 1 } });
    const ab = r.routeCost('A', 'B', ship);
    const ac = r.routeCost('A', 'C', ship);
    const ad = r.routeCost('A', 'D', ship);
    expect(ab.timeS).toBeLessThan(ac.timeS);
    expect(ac.timeS).toBeLessThan(ad.timeS);
    expect(ab.fuelCr).toBeLessThan(ac.fuelCr);
    expect(ac.fuelCr).toBeLessThan(ad.fuelCr);
  });

  it('returns zero cost for a same-waypoint trip', () => {
    expect(router().routeCost('A', 'A', makeShip())).toEqual({ fuelCr: 0, timeS: 0 });
  });
});
