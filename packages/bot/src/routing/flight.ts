/**
 * routing/flight.ts — single-leg flight-mode math (port of bot2.mjs L310–344).
 *
 * `FUEL_PX` (live per-fuel-unit cost) and `VALUE_OF_TIME` (cr/sec BURN
 * aggressiveness knob) are **injected**, never module-global — the markets
 * service owns the live fuel price and passes it in. `TIME_FACTOR` is the
 * calibrated seconds-per-distance-per-speed table, re-exported from `@st/shared`.
 */

import { TIME_FACTOR } from '@st/shared';
import type { Ship } from '@st/shared';
import type { FlightMode, ModeChoice } from '../interfaces.js';

export { TIME_FACTOR };

/** Fuel burned for a leg of `dist` units in `mode`. */
export function legFuel(dist: number, mode: FlightMode): number {
  return mode === 'DRIFT' ? 1 : mode === 'BURN' ? 2 * dist : dist;
}

/** Seconds in transit for a leg of `dist` units at `speed` in `mode` (+15s overhead). */
export function legTime(dist: number, speed: number, mode: FlightMode): number {
  return Math.round((dist * (TIME_FACTOR[mode] ?? TIME_FACTOR['CRUISE']!)) / Math.max(1, speed)) + 15;
}

/**
 * Live fuel price: 1 market unit of FUEL = 100 ship-fuel, so per-unit cost =
 * purchasePrice/100. Sampled across all markets (median is robust to one outlier
 * pump). Falls back to `prior` if no market sells fuel this cycle. Keeps
 * routeCost/chooseMode honest as fuel prices drift.
 */
export function computeFuelPx(markets: Record<string, { tradeGoods?: Array<{ symbol: string; purchasePrice: number }> }>, prior: number): number {
  const px: number[] = [];
  for (const m of Object.values(markets))
    for (const g of m.tradeGoods ?? [])
      if (g.symbol === 'FUEL' && g.purchasePrice > 0) px.push(g.purchasePrice);
  if (!px.length) return prior; // keep prior value if none sell fuel now
  px.sort((a, b) => a - b);
  return px[Math.floor(px.length / 2)]! / 100; // median market price → per-ship-fuel-unit cost
}

/**
 * Pick the cheapest feasible mode by total cost = fuelCredits + time×valueOfTime.
 * Feasible = leg fuel fits the ship's tank (we refuel to full at every dock).
 *
 * @param fuelPx        live per-ship-fuel-unit cost (cr).
 * @param valueOfTime   cr/sec — BURN aggressiveness knob.
 */
export function chooseMode(dist: number, ship: Ship, fuelPx: number, valueOfTime: number): ModeChoice {
  const cap = ship.fuel.capacity || 0;
  const speed = ship.engine?.speed || 15;
  if (cap === 0) return { mode: 'CRUISE', fuel: 0, time: legTime(dist, speed, 'CRUISE') }; // probes: free fuel
  const cands: Array<Required<ModeChoice>> = [];
  for (const mode of ['CRUISE', 'BURN', 'DRIFT'] as const) {
    const fuel = legFuel(dist, mode);
    if (fuel > cap * 0.97) continue; // 3% margin: avoid brim-full legs (coords/rounding drift)
    const time = legTime(dist, speed, mode);
    const cost = fuel * fuelPx + time * valueOfTime;
    cands.push({ mode, fuel, time, cost });
  }
  if (!cands.length) return { mode: 'DRIFT', fuel: 1, time: legTime(dist, speed, 'DRIFT') };
  cands.sort((a, b) => a.cost - b.cost);
  return cands[0]!;
}
