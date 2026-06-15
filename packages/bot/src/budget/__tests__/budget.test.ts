import { describe, it, expect } from 'vitest';
import { loadConfig, type Config, type Market, type Ship } from '@st/shared';
import { createState } from '../../runtime/state.js';
import { recomputeReserve, computeExpansionTarget, availableForWork, growthBudget } from '../budget.js';
import { makeShip } from '../../__tests__/fixtures.js';
import type { SpaceTradersClient } from '../../interfaces.js';

const cfg: Config = loadConfig({});

describe('budget: accounting', () => {
  it('availableForWork = credits - committed - reserve; growthBudget never negative', () => {
    const s = createState(cfg);
    s.cachedCredits = 1_000_000;
    s.committed = 100_000;
    s.operatingReserve = 200_000;
    expect(availableForWork(s)).toBe(700_000);
    s.cachedCredits = 100_000; // below reserve+committed
    expect(availableForWork(s)).toBeLessThan(0);
    expect(growthBudget(s)).toBe(0);
  });
});

describe('budget: recomputeReserve (rolling reserve math)', () => {
  it('= fleet fuel-topoff + GOODS_CUSHION + perLoad × min(cargoShips, RESERVE_CONCURRENCY)', async () => {
    const s = createState(cfg);
    const ships: Ship[] = [
      makeShip({ symbol: 'A', fuel: { current: 0, capacity: 400 }, cargo: { capacity: 40, units: 0, inventory: [] } }),
      makeShip({ symbol: 'B', fuel: { current: 0, capacity: 400 }, cargo: { capacity: 40, units: 0, inventory: [] } }),
    ];
    await recomputeReserve(s, cfg, { getAllShips: async () => ships, getFuelPx: () => 0.72 });
    // fuelReserve = 800 × 0.72 = 576; perLoad = GOODS_CUSHION_PER_SHIP (laneCostEMA=0); buffer = min(2,3)=2
    const expected = Math.round(576 + cfg.GOODS_CUSHION + cfg.GOODS_CUSHION_PER_SHIP * 2);
    expect(s.operatingReserve).toBe(expected);
  });

  it('keeps the prior reserve when the fleet fetch throws', async () => {
    const s = createState(cfg);
    s.operatingReserve = 12_345;
    await recomputeReserve(s, cfg, {
      getAllShips: async () => {
        throw new Error('boom');
      },
      getFuelPx: () => 0.72,
    });
    expect(s.operatingReserve).toBe(12_345);
  });
});

describe('budget: computeExpansionTarget [A] fail-safe gate status', () => {
  const throwingClient = { api: async () => { throw new Error('gate unreachable'); } } as unknown as SpaceTradersClient;

  it('never collapses the goal on an UNKNOWN/unreachable gate (never confirmed)', async () => {
    const s = createState(cfg);
    s.expansionTarget = 8_000_000;
    const out = await computeExpansionTarget(s, cfg, {}, { client: throwingClient });
    expect(out).toBe(8_000_000); // held, not collapsed
    expect((s.targetBreakdown as { gateStatusKnown?: boolean }).gateStatusKnown).toBe(false);
  });

  it('includes reserve + gate materials + dedicated haulers + new-cell seed while UNBUILT', async () => {
    const s = createState(cfg);
    s.operatingReserve = 200_000;
    const markets: Record<string, Market> = {
      SRC: { symbol: 'SRC', tradeGoods: [{ symbol: 'FAB_MATS', type: 'EXPORT', tradeVolume: 20, supply: 'MODERATE', purchasePrice: 1000, sellPrice: 1100 }] },
    };
    const client = {
      api: async (_m: string, path: string) => {
        if (path.includes('type=JUMP_GATE')) return { data: [{ symbol: 'GATE-1' }] };
        return { data: { isComplete: false, materials: [{ tradeSymbol: 'FAB_MATS', required: 100, fulfilled: 0 }] } };
      },
    } as unknown as SpaceTradersClient;
    const out = await computeExpansionTarget(s, cfg, markets, { client });
    const bd = s.targetBreakdown as { storageSupplyShipCount: number; gateMaterials: number; seedNewCell: number; gateStatusKnown: boolean };
    expect(bd.gateStatusKnown).toBe(true);
    expect(bd.storageSupplyShipCount).toBeGreaterThanOrEqual(1); // [STORAGE] at least one hauler while unbuilt
    expect(bd.gateMaterials).toBeGreaterThan(0);
    expect(out).toBe(Math.round(200_000 + bd.gateMaterials + cfg.HAULER_PRICE * bd.storageSupplyShipCount + cfg.NEW_CELL_SEED));
  });

  it('charges no hauler cost once the gate is BUILT', async () => {
    const s = createState(cfg);
    s.operatingReserve = 200_000;
    const client = {
      api: async (_m: string, path: string) => {
        if (path.includes('type=JUMP_GATE')) return { data: [{ symbol: 'GATE-1' }] };
        return { data: { isComplete: true, materials: [] } };
      },
    } as unknown as SpaceTradersClient;
    const out = await computeExpansionTarget(s, cfg, {}, { client });
    const bd = s.targetBreakdown as { storageSupplyShips: number };
    expect(bd.storageSupplyShips).toBe(0);
    expect(out).toBe(Math.round(200_000 + 0 + 0 + cfg.NEW_CELL_SEED));
  });
});
