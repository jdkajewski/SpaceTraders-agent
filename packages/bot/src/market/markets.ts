/**
 * market/markets.ts — shared market cache + price/baseline derivation + value-weighted scan budget
 * (port of bot2.mjs L346–414 getMarkets/updateBaselines/goodMargins/history, extended by issue #2).
 *
 * `getMarkets()` serves a cache. When a {@link Config} is supplied it runs a **value-weighted
 * per-market scan budget** (issue #2): instead of re-fetching every waypoint past one global TTL, a
 * throttled sweep re-fetches only the markets the {@link ScanScheduler} reports as DUE — interval =
 * `base / (value × volatility)` clamped — so scarce `GET /market` budget concentrates on the markets
 * feeding the best lanes and starves dead ones. With no config it falls back to the legacy uniform
 * `MARKET_TTL_MS` refresh (used by unit tests / minimal callers).
 *
 * On a sweep it: (1) re-fetches each DUE market, (2) recomputes the live fuel price, (3) PUTs the
 * merged snapshot, (4) appends history for the scanned markets, (5) refreshes per-good baselines.
 * Realized lane value is fed in via {@link MarketsServiceExtra.ingestTrade} from the worker.
 *
 * Boot read loads the last snapshot from the API (no `fs` anywhere).
 */

import { MARKET_TTL_MS, distance } from '@st/shared';
import type { Config, CoordsMap, Market, MarketHistoryRow, TradeObservation } from '@st/shared';
import type { ApiEnvelope, MarketsService, PersistenceClient, SpaceTradersClient } from '../interfaces.js';
import { computeFuelPx } from '../routing/flight.js';
import { createLaneRegistry, type LaneRegistry, type RankedLane } from '../trade/laneRegistry.js';
import { scoreMarkets, type ValueWeights } from './value.js';
import { createScanScheduler, type ScanScheduler, type MarketScanState } from './scanScheduler.js';
import {
  planCoverage,
  coverageTarget,
  type CoveragePlan,
  type CoverageWeights,
  type PhaseSignals,
  type RecheckOptions,
} from './coverage.js';
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
  /**
   * Full config. When supplied, enables the value-weighted scan budget (issue #2). Omit for the
   * legacy uniform `MARKET_TTL_MS` refresh (minimal callers / unit tests).
   */
  cfg?: Config;
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
  /** Fold a completed trade into the realized lane-value registry (issue #2). No-op without cfg. */
  ingestTrade(obs: TradeObservation): void;
  /** Total `GET /market` requests spent this run (scan-budget metric). */
  marketGets(): number;
  /** Per-market scan scheduler state (diagnostics / metric). */
  scanStates(): Map<string, MarketScanState>;
  /** Top-K realized lanes by decayed value (diagnostics / metric). */
  topLanes(k: number): RankedLane[];
  /**
   * Value-driven coverage plan (issue #2, phases 4+7): which markets are worth a parked probe, which
   * DEAD probes to redeploy, and which uncovered markets are re-check-due. `null` when the value
   * budget is disabled (no cfg). Pure read — `fleet/scale` decides whether to act on it.
   */
  coveragePlan(covered: ReadonlySet<string>, signals: Omit<PhaseSignals, 'activeLanes'>, now?: number): CoveragePlan | null;
  /**
   * Deliberately re-read one market NOW (cold re-check). The caller MUST ensure a ship is present at
   * `wp` (otherwise the API returns stale prices). Merges the read into the cache, updates volatility,
   * and counts a request. Returns the fresh market, or null on a transient failure / when disabled.
   */
  recheckScan(wp: string, now?: number): Promise<Market | null>;
}

export function createMarketsService(opts: MarketsServiceOptions): MarketsService & MarketsServiceExtra {
  const { client, persistence, coords, maxd, cfg } = opts;
  const D = (a: string, b: string): number => distance(a, b, coords);

  let marketWps: string[] = opts.marketWaypoints ? [...opts.marketWaypoints] : [];
  let fuelPx = opts.fuelPxInit ?? FUEL_PX_DEFAULT;

  let marketCache: { at: number; data: Record<string, Market> } = { at: 0, data: {} };
  let refreshing: Promise<Record<string, Market>> | null = null;

  // adaptive per-good baseline state (consumed by Wave 3 lanes/cooldown)
  const goodEMA = new Map<string, number>();
  let lastMargins: Record<string, number> = {};

  // ── value-weighted scan budget (issue #2) — only when a config is supplied ──────────────────
  const registry: LaneRegistry | null = cfg
    ? createLaneRegistry({ alpha: cfg.LANE_VALUE_ALPHA, halfLifeMs: cfg.LANE_VALUE_HALFLIFE_MS })
    : null;
  const scheduler: ScanScheduler | null = cfg
    ? createScanScheduler({
        baseMs: cfg.SCAN_BASE_MS,
        minMs: cfg.SCAN_MIN_MS,
        maxMs: cfg.SCAN_MAX_MS,
        valFactorMin: cfg.SCAN_VAL_FACTOR_MIN,
        valFactorMax: cfg.SCAN_VAL_FACTOR_MAX,
        volAlpha: cfg.SCAN_VOL_ALPHA,
        volGain: cfg.SCAN_VOL_GAIN,
        volFactorMin: cfg.SCAN_VOL_FACTOR_MIN,
        volFactorMax: cfg.SCAN_VOL_FACTOR_MAX,
      })
    : null;
  const valueWeights: ValueWeights = {
    realized: cfg?.SCAN_VALUE_REALIZED_WEIGHT ?? 1,
    structural: cfg?.SCAN_VALUE_STRUCTURAL_WEIGHT ?? 1,
    volume: cfg?.SCAN_VALUE_VOLUME_WEIGHT ?? 0,
  };
  const sweepMs = cfg?.SCAN_SWEEP_MS ?? MARKET_TTL_MS;
  let marketGets = 0;
  let lastSweepAt = 0;

  // ── value-driven coverage tiering + reversible pruning + cold re-check (issue #2, phases 4+7) ──
  const coverageWeights: CoverageWeights = {
    hotMult: cfg?.COVERAGE_HOT_MULT ?? 2,
    warmMult: cfg?.COVERAGE_WARM_MULT ?? 0.75,
    coldMult: cfg?.COVERAGE_COLD_MULT ?? 0.2,
  };
  const recheckOpts: RecheckOptions = {
    baseMs: cfg?.COVERAGE_RECHECK_BASE_MS ?? 1_800_000,
    minMs: cfg?.COVERAGE_RECHECK_MIN_MS ?? 600_000,
    maxMs: cfg?.COVERAGE_RECHECK_MAX_MS ?? 21_600_000,
  };

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

  function buildHistoryRows(markets: Record<string, Market>, only?: Set<string>): MarketHistoryRow[] {
    const ts = new Date().toISOString();
    const rows: MarketHistoryRow[] = [];
    for (const [wp, m] of Object.entries(markets)) {
      if (only && !only.has(wp)) continue;
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
    }
    return rows;
  }

  /** Fetch one market waypoint; null on a transient failure. Counts a request against scan budget. */
  async function fetchMarket(wp: string): Promise<Market | null> {
    try {
      marketGets += 1;
      return (await client.api<ApiEnvelope<Market>>('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
    } catch {
      return null; // skip unreachable market this cycle
    }
  }

  /** Shared post-fetch bookkeeping for both refresh paths. */
  function finishSweep(out: Record<string, Market>, scanned: Set<string> | undefined): void {
    marketCache = { at: now(), data: out };
    fuelPx = computeFuelPx(out, fuelPx); // refresh live fuel price for routeCost/chooseMode/reserve
    persistence.putMarkets(out); // replaces markets.json write (fire-and-forget)
    const rows = buildHistoryRows(out, scanned); // history only for freshly-scanned markets on a partial sweep
    if (rows.length) persistence.appendMarketHistory(rows); // replaces market-history.jsonl
    updateBaselines(out); // refresh per-good margin baseline for adaptive cooldown
  }

  /** Legacy uniform refresh: re-fetch EVERY known market past the global TTL (no config supplied). */
  async function refreshAll(): Promise<Record<string, Market>> {
    const out: Record<string, Market> = {};
    for (const wp of marketWps) {
      const m = await fetchMarket(wp);
      if (m) out[wp] = m;
    }
    finishSweep(out, undefined);
    return out;
  }

  /** Value-weighted sweep: re-fetch only the markets the scheduler reports DUE (issue #2). */
  async function refreshDue(): Promise<Record<string, Market>> {
    const t = now();
    const scored = scoreMarkets(marketCache.data, registry!.marketRealizedValue(t), valueWeights);
    const scoreByWp = new Map<string, number>();
    for (const [wp, v] of scored) scoreByWp.set(wp, v.score);
    const due = scheduler!.selectDue(scoreByWp, marketWps, t);
    const out: Record<string, Market> = { ...marketCache.data }; // keep un-refreshed markets warm
    const scanned = new Set<string>();
    for (const wp of due) {
      const m = await fetchMarket(wp);
      if (!m) continue;
      out[wp] = m;
      scanned.add(wp);
      scheduler!.noteScan(wp, m, now());
    }
    if (scanned.size)
      log.info(`scan sweep: refreshed ${scanned.size}/${marketWps.length} due market(s) (${marketGets} gets total)`);
    finishSweep(out, scanned);
    return out;
  }

  async function getMarkets(): Promise<Record<string, Market>> {
    if (!scheduler) {
      // legacy: single global TTL, refresh ALL markets uniformly
      if (now() - marketCache.at < MARKET_TTL_MS) return marketCache.data;
      if (refreshing) return refreshing;
      refreshing = refreshAll().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }
    // value-weighted: throttle the due-check to one sweep per SCAN_SWEEP_MS, then refresh only DUE markets
    if (now() - lastSweepAt < sweepMs) return marketCache.data;
    if (refreshing) return refreshing;
    lastSweepAt = now();
    refreshing = refreshDue().finally(() => {
      refreshing = null;
    });
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

  /**
   * Value-driven coverage plan (issue #2, phases 4+7). Scores every known market, normalises against
   * the fleet mean, derives a phase-adaptive probe target from live signals (fleet size + active
   * lanes), and asks {@link planCoverage} which markets are worth covering, which DEAD probes to
   * redeploy, and which uncovered markets are re-check-due. Pure read — no fetch, no mutation.
   * Returns `null` when the value budget is disabled (no cfg) so callers keep legacy behaviour.
   */
  function coveragePlan(
    covered: ReadonlySet<string>,
    signals: Omit<PhaseSignals, 'activeLanes'>,
    at: number = now(),
  ): CoveragePlan | null {
    if (!scheduler || !registry || !cfg) return null;
    const scored = scoreMarkets(marketCache.data, registry.marketRealizedValue(at), valueWeights);
    const scoreByWp = new Map<string, number>();
    for (const [wp, v] of scored) scoreByWp.set(wp, v.score);
    // Ensure every known waypoint is represented (un-scored ⇒ 0 ⇒ DEAD until first read).
    for (const wp of marketWps) if (!scoreByWp.has(wp)) scoreByWp.set(wp, 0);

    const lastScanAtByWp = new Map<string, number>();
    for (const [wp, st] of scheduler.states()) if (st.scans > 0) lastScanAtByWp.set(wp, st.lastScanAt);

    const activeLanes = registry.topLanes(cfg.LANE_TOPK, at).filter((l) => l.value > 0).length;
    const target = coverageTarget(
      { fleetSize: signals.fleetSize, activeLanes, marketCount: signals.marketCount },
      {
        base: cfg.COVERAGE_TARGET_BASE,
        laneBonus: cfg.COVERAGE_LANE_BONUS,
        fleetBonus: cfg.COVERAGE_FLEET_BONUS,
        min: cfg.COVERAGE_TARGET_MIN,
        maxProbes: cfg.FLEET_MAX_PROBES,
      },
    );

    return planCoverage({
      scoreByWp,
      valueRef: scheduler.valueRef(scoreByWp),
      covered,
      lastScanAtByWp,
      now: at,
      target,
      weights: coverageWeights,
      recheck: recheckOpts,
    });
  }

  /**
   * Cold re-check: deliberately re-read one market NOW and merge it into the cache (issue #2, phase 7).
   * The caller MUST have a ship present at `wp`. Counts a request, updates volatility/history/baselines,
   * and returns the fresh market (or null on a transient failure / when the value budget is disabled).
   */
  async function recheckScan(wp: string, at: number = now()): Promise<Market | null> {
    if (!scheduler) return null;
    const m = await fetchMarket(wp);
    if (!m) return null;
    const out: Record<string, Market> = { ...marketCache.data, [wp]: m };
    scheduler.noteScan(wp, m, at);
    finishSweep(out, new Set([wp]));
    return m;
  }

  return {
    getMarkets,
    getFuelPx: () => fuelPx,
    loadSnapshot,
    goodMargins,
    updateBaselines,
    lastMargins: () => lastMargins,
    goodEMA: () => goodEMA,
    ingestTrade: (obs: TradeObservation) => registry?.ingest(obs),
    marketGets: () => marketGets,
    scanStates: () => scheduler?.states() ?? new Map<string, MarketScanState>(),
    topLanes: (k: number) => registry?.topLanes(k, now()) ?? [],
    coveragePlan,
    recheckScan,
  };
}
