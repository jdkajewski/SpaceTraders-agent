# Wave 4 — Bot subsystems (gate, contracts, mining, input-feed, fleet)

**Depends on:** Wave 3 (worker skeleton + state + interfaces). **Blocks:** Wave 5.
**Suggested model:** heavier reasoning model (contracts + mining are the gnarliest). **Base branch:**
integration branch after Wave 3. **Highly parallel** — 4.1–4.5 are independent subsystems behind their
own env flags; they can be separate parallel sub-sessions that each plug a hook into `worker.ts`.

> Each subsystem is a `worker.ts` hook that returns `true` when it handled the ship this loop. Preserve
> the ordered priority from docs/02 §3. Every `[RULE:*]` and the isolate-ship try/catch must survive.

## 4.1 Gate supply + orphan delivery — `gate/gate.ts`, `gate/orphan.ts`
- `gateSupplyTrip` (producer-only sourcing EXPORT/EXCHANGE; `planGateFill` capped + ceil-factor +
  absolute `GATE_MAX_PRICE`; `gateBuyAllowed` price-settle patience state machine; deliver even when
  buy-paused). `GATE_PROTECT` supply-chain guard. gate caches/claims, `gateSinkWaypoints`.
- `deliverOrphanGateCargo` 4-tier (SELF route → SELF+fuel-cargo → TRANSFER to co-located hauler →
  stage one hop closer); `supplyHeldToGate`, `tryTransferToCoLocatedHauler`, `nearestHopTowardGate`,
  `planRouteFuelCargo`/`haulWithFuelCargo`, `goToWithFuelCargo`, `shedSpareFuel`, `refuelFromCargo`.
- Wire the `isGateHauler` pin + the Wave-3 recovery gate-material-delivery hook.
- **Vitest:** `planGateFill` respects abs cap + ceil factor + free slots; price-settle state machine
  (paused→settling→normal on rebound/window). ~5 tests.

## 4.2 Contracts — `contracts/contracts.ts`
- `contractManager` (negotiate via NEGOTIATOR; **self-heal** adopt unaccepted offer; election loop),
  `electContractOwner` (closest idle/empty eligible; `CONTRACT_REELECT_MARGIN` anti-latch; never
  re-elect a carrier), `contractRunnerTrip` (own→source→**post-travel ownership re-check**→deliver→
  **pre-delivery re-validate**→fulfill; ride-along fill), `isForced` (manual `CONTRACT_FORCE` ∪
  `contractAutoForced`), **auto-force** wedge self-heal (`CONTRACT_AUTOFORCE_MINS`), margin gates,
  `cheapestContractSrc`, `contractSrcReachable` (FUEL_CARGO range relax), `CONTRACT_AVOID_GATE_PRODUCER`,
  cross-system skip (`contractHomeDeliverable`).
- `CONTRACTS=0` master switch + `TRADE_FIRST` opportunistic ordering.
- **Vitest:** election re-elect margin (no churn within margin; switches beyond it; never away from
  carrier); auto-force fires after grace window; margin gate math. ~6 tests.

## 4.3 Mining colony — `mining/mining.ts`, `mining/expandMine.ts`
- Role auto-detect `mineRoleOf` (mounts/modules) → `refinerTrip`/`droneTrip`/`surveyorTrip`/
  `funnelTrip`/`transportTrip`; surveys pool (`surveyOnce`,`pruneSurveys`,`bestSurveyFor`),
  `extractOnce`/`refineOnce` (cooldown "<n> seconds" parse-sleep), `pickMineGood`, `pickMineTender`,
  co-located fuel tending, funnel ore-bin, raw-ore relief valve (`MINE_CLOG_AT`,`MINE_RAW_RELIEF`),
  `logMine`→mine-events via persistence client. Colony hulls skip recovery (Wave 3 already flags).
- `mineExpandManager` + `mineMigrateManager` + `buyMiningShip` (gated by `MINE_EXPAND`, gate-unbuilt).
- Preserve `[RULE: transfer-argorder]`, `[RULE: co-location]`, `[RULE: single-good-refine]`.
- **Vitest:** light — `mineRoleOf` classification, clog/relief decision, tender pick. ~4 tests.

## 4.4 Input feed — `feed/inputFeed.ts`
- `inputFeedTrip` + `planInputFeed` (feed producer imports; `INPUT_FEED_MAX` hard-capped ≤2;
  per-producer cap; `INPUT_FEED_GATE_PAUSE` decoupled by default; `INPUT_FEED_MIN_CASH`).
  `gateProducerInputTargets`, `gateInputGoods`. Default OFF (prod-disabled; preserve guardrails).
- **Vitest:** `INPUT_FEED_MAX` clamp + per-producer cap; min-cash gate. ~3 tests.

## 4.5 Fleet scale + repair — `fleet/scale.ts`, `fleet/repair.ts`
- `fleetScaleManager` (probe↔cargo balance autoscaler: `probeTarget = BASE + RATIO×(cargo-1)` capped
  at market count; buy probes then shuttles then haulers from `growthBudget` above `FLEET_SCALE_FLOOR`;
  anchor-ship buy mechanics). `getShipyards`, `nearestShipyardWp`, `isProbeHull`.
- `maybeRepair`/`repairAt` two-tier (opportunistic at-yard `REPAIR_COND_MIN`; forced-divert
  `REPAIR_INTEG_FORCE`; `REPAIR_MAX_COST`; spends growthBudget only). Default OFF.
- **Vitest:** probe/cargo target math; repair tier decision (opportunistic vs forced vs skip). ~4 tests.

## Integration into worker.ts
Replace the Wave-3 no-op hooks with the real subsystem calls, in the exact documented order:
recovery → gateHauler → inputFeeder → mining-role → orphan-gate → contracts(own/deliver) →
TRADE → (inputFeed → gateSupply → PARK) fallback. Keep each dispatch in its isolate-ship try/catch.

## Acceptance checklist
- [ ] Each subsystem behind its flag; flags OFF ⇒ behavior identical to Wave 3 trading-only bot.
- [ ] All subsystem vitest suites green; `tsc -b` + lint clean.
- [ ] Worker order matches docs/02 §3; one subsystem throwing never crashes the fleet (supervise +
      isolate-ship verified).
- [ ] Any behavior you suspect is a legacy bug is logged in `rebuild/DRIFT-LOG.md`, not silently changed.
