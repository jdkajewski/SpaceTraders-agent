# Wave 11 — Chain-Feed bulk freighter + API-budget reclaim + adaptive scan TTL

**Commit:** `9700356` (Chain-Feed cross-system feeder + API-budget reclaim + adaptive market-scan TTL +
per-transaction sell cap + export-claim contention guard). Touches **`expansion.mjs` + `trade.mjs`**.
**Depends on:** Wave 7 (cross-system reach). Parallel-safe with W8/W9. **Blocks:** Wave 12.
**Model:** heavy.

## Goal
Three independent efficiency levers from one commit:
1. **Chain-Feed:** a bulk-freighter feeder that hauls input goods cross-system to keep a downstream
   factory chain fed (so exports never starve).
2. **API-budget reclaim:** stop burning rate-limited GETs polling for arrival.
3. **Adaptive market-scan TTL:** scan volatile markets often, stable markets rarely.

## Port targets
### Chain-Feed (`expansion/expansion.ts`)
- `buildFeedPlan()` (L873) — compute the cross-system feed plan (which good, from which sink, to which
  consumer) for the configured `FEEDER_SHIPS`.
- `bestSinkLoop(good, fromSys)` (L913) / `localSinkLoop(good, sys)` (L929) — loop-safe best-sink
  selection (avoid A→B→A oscillation).
- `feederTrip(sym, ship)` (L939) — drive one feeder ship through its plan leg.
- Config: `CHAIN_FEED` (boolOff), `FEEDER_SHIPS` (csvSet), `FEED_GOODS` (csvSet),
  `FEED_MIN_MARGIN_PCT` (num), `FEED_PREFER_MINED` (bool), `FEED_SATURATION_N` (num).

### Adaptive scan TTL (`expansion/expansion.ts`)
- `priceDelta(prev, next)` (L61) + `nextScan(prevRec, freshM)` (L71) — compute next scan time from
  observed price volatility; TTL ranges `EXPAND_SCAN_TTL_MS` → `EXPAND_SCAN_TTL_MAX_MS` (legacy
  120s→900s), volatility threshold `EXPAND_SCAN_VOLATILE_PCT`; parked-probe dwell `EXPAND_PROBE_DWELL_MS`.
- Config: `EXPAND_SCAN_TTL_MAX_MS` (num), `EXPAND_SCAN_VOLATILE_PCT` (num), `EXPAND_PROBE_DWELL_MS` (num).
  (`EXPAND_SCAN_TTL_MS` already exists from W5.)

### API-budget reclaim (`trade/shipActions.ts` — port of `trade.mjs waitArrival`)
- `waitArrival`: when a nav is in transit, **sleep the full remaining transit locally** instead of
  re-GETting the ship repeatedly. Preserve the arrival-time math; this is a pure efficiency change with
  no behavior change to the trade decision. Add a small DRIFT entry (mechanism change, behavior-equal).

### Per-transaction sell cap + export-claim contention guard
- Sell at most `tradeVolume` units per transaction (legacy added this cap). The **export-claim
  contention guard in `stepMineHaul`** is shared with W9 — coordinate: if W9 already landed the hauler,
  add only the sell-cap here; otherwise the guard rides with the hauler in W9. Note in DRIFT which wave
  carried it.

## State (runtime/state.ts — additive)
Feeder loop-locks (recent (good,sys) to prevent oscillation); scan-record volatility fields if not
already on the scanned-market cache.

## Tests (vitest — pure, minimal)
- `nextScan`/`priceDelta`: volatile market ⇒ short TTL, stable ⇒ long TTL, clamped to
  [`SCAN_TTL_MS`, `SCAN_TTL_MAX_MS`].
- `bestSinkLoop`/`localSinkLoop` loop-guard: never returns the just-visited sink (no A→B→A).
- Parity shim for `nextScan` if math is non-trivial.

## Acceptance
- [ ] `CHAIN_FEED=0` ⇒ no feeder behavior (parity). [ ] `waitArrival` issues no per-poll GETs in
  transit (assert via injected clock/api spy). [ ] adaptive TTL clamps correctly. [ ] build + vitest
  green + lint 0 + DRIFT entries (waitArrival mechanism; sell-cap/contention ownership vs W9).
