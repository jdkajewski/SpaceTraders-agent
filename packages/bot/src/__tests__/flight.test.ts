import { describe, it, expect } from 'vitest';
import { chooseMode, computeFuelPx, legFuel, legTime } from '../routing/flight.js';
import { makeShip } from './fixtures.js';

describe('flight: legFuel / legTime', () => {
  it('legFuel: DRIFT=1, CRUISE=dist, BURN=2·dist', () => {
    expect(legFuel(100, 'DRIFT')).toBe(1);
    expect(legFuel(100, 'CRUISE')).toBe(100);
    expect(legFuel(100, 'BURN')).toBe(200);
  });
  it('legTime scales by TIME_FACTOR/speed (+15 overhead)', () => {
    expect(legTime(100, 15, 'CRUISE')).toBe(Math.round((100 * 25) / 15) + 15);
    expect(legTime(100, 15, 'BURN')).toBeLessThan(legTime(100, 15, 'CRUISE'));
  });
});

describe('flight: chooseMode', () => {
  it('prefers BURN when time is expensive (high VALUE_OF_TIME)', () => {
    const ship = makeShip({ fuel: { current: 400, capacity: 400 }, engine: { speed: 15, condition: 1 } });
    expect(chooseMode(100, ship, 0.72, 100).mode).toBe('BURN');
  });

  it('prefers CRUISE when fuel is expensive and time is cheap', () => {
    const ship = makeShip({ fuel: { current: 400, capacity: 400 }, engine: { speed: 15, condition: 1 } });
    expect(chooseMode(100, ship, 10, 1).mode).toBe('CRUISE');
  });

  it('returns free CRUISE for probes (zero fuel capacity)', () => {
    const ship = makeShip({ fuel: { current: 0, capacity: 0 } });
    const c = chooseMode(100, ship, 0.72, 100);
    expect(c.mode).toBe('CRUISE');
    expect(c.fuel).toBe(0);
  });

  it('skips BURN when the leg exceeds the 97% tank margin', () => {
    // cap 150 → BURN needs 200 (>145.5) infeasible; CRUISE needs 100 (ok).
    const ship = makeShip({ fuel: { current: 150, capacity: 150 } });
    expect(chooseMode(100, ship, 0.72, 100).mode).toBe('CRUISE');
  });

  it('falls back to DRIFT when no mode fits the tank', () => {
    const ship = makeShip({ fuel: { current: 1, capacity: 1 } });
    const c = chooseMode(100, ship, 0.72, 100);
    expect(c.mode).toBe('DRIFT');
    expect(c.fuel).toBe(1);
  });
});

describe('flight: computeFuelPx', () => {
  it('returns the median FUEL purchasePrice ÷ 100', () => {
    const markets = {
      A: { tradeGoods: [{ symbol: 'FUEL', purchasePrice: 200 }] },
      B: { tradeGoods: [{ symbol: 'FUEL', purchasePrice: 100 }] },
      C: { tradeGoods: [{ symbol: 'FUEL', purchasePrice: 300 }] },
    };
    expect(computeFuelPx(markets, 0.72)).toBe(2); // median 200 / 100
  });

  it('keeps the prior value when no market sells fuel', () => {
    const markets = { A: { tradeGoods: [{ symbol: 'IRON', purchasePrice: 50 }] } };
    expect(computeFuelPx(markets, 0.81)).toBe(0.81);
  });
});
