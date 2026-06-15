/**
 * market/markets.ts — shared market cache + price/baseline derivation
 * (port of bot2.mjs L346–414 getMarkets/updateBaselines/goodMargins/history).
 *
 * `getMarkets()` serves a cache that refreshes past `MARKET_TTL_MS` with a
 * single-flight `refreshing` dedupe. On refresh it:
 *   1. re-fetches each known market waypoint from the SpaceTraders API,
 *   2. recomputes the live fuel price (`FUEL_PX`, median),
 *   3. **PUTs the snapshot to the persistence client** (replaces markets.json),
 *   4. **appends market-history via the client** (replaces market-history.jsonl),
 *   5. refreshes per-good margin EMA baselines.
 *
 * Boot read loads the last snapshot from the API (no `fs` anywhere).
 */

import { MARKET_TTL_MS, distance } from '@st/shared';
import type { CoordsMap, Market, MarketHistoryRow } from '@st/shared';
import type { ApiEnvelope, MarketsService, PersistenceClient, SpaceTradersClient } from '../interfaces.js';
import { computeFuelPx } from '../routing/flight.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'markets' });
const now = (): number => Date.now();
const sysOf = (wp: string): string => wp.split('-').slice(0, 2).join('-');

const EMA_ALPHA = 0.2;
const FUEL_PX_DEFAULT = 0.72; // cr per FUEL UNIT — LIVE-updated from market FUEL price each cycle.

export interface MarketsServiceOptions {
  client: SpaceTradersClient;
  persistence: PersistenceClient;
  coords: CoordsMap;
  /** MAXD — max router distance a good's buy/sell pair may span for margin scoring. */
  maxd: number;
  /** Initial market waypoint list; otherwise seeded from the boot snapshot keys. */
  marketWaypoints?: string[];
  /** Initial fuel price (defaults to 0.72). */
  fuelPxInit?: number;
}

export interface MarketsServiceExtra {
  /** Current per-good best margin (set by updateBaselines). Used by Wave 3 lanes. */
  lastMargins(): Record<string, number>;
  /** Per-good typical-margin EMA (set by updateBaselines). Used by Wave 3 lanes. */
  goodEMA(): Map<string, number>;
}

export function createMarketsService(opts: MarketsServiceOptions): MarketsService & MarketsServiceExtra {
  const { client, persistence, coords, maxd } = opts;
  const D = (a: string, b: string): number => distance(a, b, coords);

  let marketWps: string[] = opts.marketWaypoints ? [...opts.marketWaypoints] : [];
  let fuelPx = opts.fuelPxInit ?? FUEL_PX_DEFAULT;

  let marketCache: { at: number; data: Record<string, Market> } = { at: 0, data: {} };
  let refreshing: Promise<Record<string, Market>> | null = null;

  // adaptive per-good baseline state (consumed by Wave 3 lanes/cooldown)
  const goodEMA = new Map<string, number>();
  let lastMargins: Record<string, number> = {};

  function goodMargins(markets: Record<string, Market>): Record<string, number> {
    const goods: Record<string, Array<{ wp: string } & { purchasePrice: number; sellPrice: number }>> = {};
    for (const [wp, m] of Object.entries(markets))
      for (const g of m.tradeGoods ?? [])
        (goods[g.symbol] = goods[g.symbol] ?? []).push({ wp, purchasePrice: g.purchasePrice, sellPrice: g.sellPrice });
    const cur: Record<string, number> = {};
    for (const [sym, es] of Object.entries(goods)) {
      let best = 0;
      for (const b of es)
        for (const s of es)
          if (s.sellPrice > b.purchasePrice && b.purchasePrice > 0 && D(b.wp, s.wp) <= maxd)
            best = Math.max(best, s.sellPrice - b.purchasePrice);
      cur[sym] = best;
    }
    return cur;
  }

  function updateBaselines(markets: Record<string, Market>): void {
    lastMargins = goodMargins(markets);
    for (const [sym, m] of Object.entries(lastMargins)) {
      if (m <= 0) continue;
      goodEMA.set(sym, goodEMA.has(sym) ? goodEMA.get(sym)! * (1 - EMA_ALPHA) + m * EMA_ALPHA : m);
    }
  }

  function buildHistoryRows(markets: Record<string, Market>): MarketHistoryRow[] {
    const ts = new Date().toISOString();
    const rows: MarketHistoryRow[] = [];
    for (const [wp, m] of Object.entries(markets))
      for (const g of m.tradeGoods ?? [])
        rows.push({
          ts,
          waypoint: wp,
          good: g.symbol,
          purchasePrice: g.purchasePrice,
          sellPrice: g.sellPrice,
          tradeVolume: g.tradeVolume,
          supply: g.supply,
          ...(g.activity !== undefined ? { activity: g.activity } : {}),
        });
    return rows;
  }

  async function getMarkets(): Promise<Record<string, Market>> {
    if (now() - marketCache.at < MARKET_TTL_MS) return marketCache.data;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const out: Record<string, Market> = {};
      for (const wp of marketWps) {
        try {
          out[wp] = (await client.api<ApiEnvelope<Market>>('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
        } catch {
          /* skip unreachable market this cycle */
        }
      }
      marketCache = { at: now(), data: out };
      fuelPx = computeFuelPx(out, fuelPx); // refresh live fuel price for routeCost/chooseMode/reserve
      persistence.putMarkets(out); // replaces markets.json write (fire-and-forget)
      const rows = buildHistoryRows(out);
      if (rows.length) persistence.appendMarketHistory(rows); // replaces market-history.jsonl
      updateBaselines(out); // refresh per-good margin baseline for adaptive cooldown
      refreshing = null;
      return out;
    })();
    return refreshing;
  }

  async function loadSnapshot(): Promise<Record<string, Market>> {
    const snap = await persistence.getMarkets();
    marketCache = { at: now(), data: snap };
    if (!marketWps.length) marketWps = Object.keys(snap);
    fuelPx = computeFuelPx(snap, fuelPx);
    log.info(`boot: loaded ${Object.keys(snap).length} markets from API (fuelPx=${fuelPx})`);
    return snap;
  }

  return {
    getMarkets,
    getFuelPx: () => fuelPx,
    loadSnapshot,
    goodMargins,
    updateBaselines,
    lastMargins: () => lastMargins,
    goodEMA: () => goodEMA,
  };
}
