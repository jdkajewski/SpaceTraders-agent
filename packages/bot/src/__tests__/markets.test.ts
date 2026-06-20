import { describe, it, expect } from 'vitest';
import { createMarketsService } from '../market/markets.js';
import { loadConfig, type Config, type CoordsMap, type Market } from '@st/shared';
import type { ApiEnvelope, PersistenceClient, SpaceTradersClient } from '../interfaces.js';

const coords: CoordsMap = { A: [0, 0], B: [10, 0] };

const client = { api: async () => ({ data: {} }) } as unknown as SpaceTradersClient;
const persistence = {
  putMarkets: () => {},
  appendMarketHistory: () => {},
  getMarkets: async () => ({}),
} as unknown as PersistenceClient;

function svc() {
  return createMarketsService({ client, persistence, coords, maxd: 2000 });
}

function marketsWith(sellAtB: number): Record<string, Market> {
  return {
    A: { symbol: 'A', tradeGoods: [{ symbol: 'X', purchasePrice: 100, sellPrice: 90 }] },
    B: { symbol: 'B', tradeGoods: [{ symbol: 'X', purchasePrice: 200, sellPrice: sellAtB }] },
  } as unknown as Record<string, Market>;
}

describe('markets: goodMargins', () => {
  it('finds the best cross-market margin within MAXD', () => {
    // buy X @ A (100) → sell X @ B (180) = 80; reverse is unprofitable.
    expect(svc().goodMargins(marketsWith(180))).toEqual({ X: 80 });
  });

  it('drops pairs beyond MAXD', () => {
    const far = createMarketsService({ client, persistence, coords, maxd: 5 });
    // A↔B distance is 10 > 5 → no qualifying pair.
    expect(far.goodMargins(marketsWith(180))).toEqual({ X: 0 });
  });
});

describe('markets: updateBaselines', () => {
  it('seeds then EMA-smooths the per-good baseline (alpha 0.2)', () => {
    const m = svc();
    m.updateBaselines(marketsWith(180)); // margin 80 → ema 80
    expect(m.goodEMA().get('X')).toBe(80);

    m.updateBaselines(marketsWith(140)); // margin 40 → ema 80·0.8 + 40·0.2 = 72
    expect(m.goodEMA().get('X')).toBeCloseTo(72, 6);
    expect(m.lastMargins()['X']).toBe(40);
  });
});

describe('markets: coveragePlan (issue #2 phases 4+7 wiring)', () => {
  const cfg: Config = loadConfig({});

  it('returns null without a config (legacy callers see no coverage controller)', () => {
    expect(svc().coveragePlan(new Set(), { fleetSize: 1, marketCount: 2 })).toBeNull();
  });

  it('treats never-read markets as coverable at cold start (scan-once-to-classify)', async () => {
    // Boot snapshot with two known markets, value budget enabled.
    const boot = {
      getMarkets: async () => marketsWith(180),
      putMarkets: () => {},
      appendMarketHistory: () => {},
    } as unknown as PersistenceClient;
    const m = createMarketsService({ client, persistence: boot, coords, maxd: 2000, cfg, marketWaypoints: ['A', 'B'] });
    await m.loadSnapshot();
    const plan = m.coveragePlan(new Set(), { fleetSize: 1, marketCount: 2 });
    expect(plan).not.toBeNull();
    // Neither market has been scanned yet → both are eligible (unknown), none pruned.
    expect(plan!.shouldCover.sort()).toEqual(['A', 'B']);
    expect(plan!.toPrune).toEqual([]);
    expect(plan!.recheckDue.sort()).toEqual(['A', 'B']); // never read → re-check due
  });
});

describe('markets: scan-budget priority scheduler (issue #2 phase 5 wiring)', () => {
  const fresh: Market = { symbol: 'A', tradeGoods: [{ symbol: 'X', purchasePrice: 50, sellPrice: 70 }] } as unknown as Market;
  const counting = () => {
    let gets = 0;
    const c = {
      api: async (_m: string, path: string) => {
        if (path.includes('/market')) {
          gets += 1;
          return { data: fresh } as ApiEnvelope<Market>;
        }
        return { data: {} } as ApiEnvelope<unknown>;
      },
    } as unknown as SpaceTradersClient;
    return { client: c, gets: () => gets };
  };

  it('is null without the lever (legacy fetch-all-due, no budget metric)', async () => {
    // value budget on (cfg) but SCAN_BUDGET_ON unset → every due market fetched, no scanBudget status.
    const cfg = loadConfig({});
    const { client: c } = counting();
    const m = createMarketsService({ client: c, persistence, coords, maxd: 2000, cfg, marketWaypoints: ['A', 'B', 'C'] });
    await m.getMarkets();
    expect(m.scanBudgetStatus()).toBeNull();
  });

  it('caps a due-burst to the per-sweep budget and defers the rest', async () => {
    // Three never-scanned (all due) markets, budget hard-capped to 1 → fetch 1, defer 2.
    const cfg = loadConfig({ SCAN_BUDGET_ON: '1', SCAN_BUDGET_MAX_PER_SWEEP: '1' });
    const { client: c, gets } = counting();
    const m = createMarketsService({ client: c, persistence, coords, maxd: 2000, cfg, marketWaypoints: ['A', 'B', 'C'] });
    await m.getMarkets();
    expect(gets()).toBe(1); // spent exactly the budget, not all 3 due markets
    const st = m.scanBudgetStatus();
    expect(st).not.toBeNull();
    expect(st!.perSweep).toBe(1);
    expect(st!.due).toBe(3);
    expect(st!.granted).toBe(1);
    expect(st!.deferred).toBe(2);
  });
});


describe('markets: recheckScan (issue #2 phase 7)', () => {
  const cfg: Config = loadConfig({});

  it('returns null without a config', async () => {
    expect(await svc().recheckScan('A')).toBeNull();
  });

  it('reads one market, merges it, and counts a request', async () => {
    const fresh: Market = { symbol: 'A', tradeGoods: [{ symbol: 'X', purchasePrice: 50, sellPrice: 70 }] } as unknown as Market;
    const oneShot = {
      api: async (_method: string, path: string) =>
        path.includes('/market') ? ({ data: fresh } as ApiEnvelope<Market>) : ({ data: {} } as ApiEnvelope<unknown>),
    } as unknown as SpaceTradersClient;
    const m = createMarketsService({ client: oneShot, persistence, coords, maxd: 2000, cfg, marketWaypoints: ['A', 'B'] });
    const before = m.marketGets();
    const got = await m.recheckScan('A');
    expect(got).toEqual(fresh);
    expect(m.marketGets()).toBe(before + 1); // spent exactly one GET /market
    expect(m.scanStates().get('A')?.scans).toBe(1); // volatility/scan state updated
  });
});
