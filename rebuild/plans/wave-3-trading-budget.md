# Wave 3 — Trading core + budget/phase + worker skeleton

**Depends on:** Wave 2. **Blocks:** Wave 4. **Suggested model:** heavier reasoning model (intricate,
parity-critical decision logic). **Base branch:** integration branch after Wave 2.

## Goal
Port the heart of the bot: lane building/scoring/claiming, the budget + phase machine + gate credit
hysteresis, and a runnable **worker loop skeleton** that does pure trading (gate/contracts/mining are
stubbed hooks filled in Wave 4). After this wave a single trade hull can run end-to-end against the
API + DB.

## Tasks

### 3.1 Shared runtime state — `runtime/state.ts`
Consolidate the bot2 module-level mutable globals into one explicitly-passed state object:
`marketCache`, `goodState` (Map sym→{lockedBy,cooldownUntil,deadStreak}), `cachedCredits`,
`committed`, `gateCache`, `gateClaims`, `perShip`, `totalNet`, `lanesRun`, `plannedRoutes`,
`fleetRoutes`, `fleetMaxSpeed`, `fleetSize`, `currentPhase`, contract state, mining state, etc.
Provide typed accessors. Keep semantics identical (this is a refactor, not a behavior change).

### 3.2 Lanes — `trade/lanes.ts`
- `buildLanes(markets, state, cfg)` — candidate lanes (buy wp/sell wp/good), filtered by MAXD/known.
- `routeCost`-based **net/min** scoring (uses Wave 2 router), `cooldownFor` adaptive EMA cooldown,
  `goodState` lock + `deadStreak` dead-lane penalty.
- `planRideAlongs` (zero-detour multi-good fill, `RIDEALONG_MIN_GROSS`).
- `claimLane` — **atomic, no `await` between check and set**: score, apply `FILL_BIAS` tie-band +
  `GATE_DROPOFF_WEIGHT`, lock good, `commit()` est. cost. Preserve `[RULE]` atomicity comment.
- `commit/uncommit`, `availableForWork`, `growthBudget`.
- **Vitest (high value):** net/min ranking picks expected lane; fill-bias only re-ranks within EPS;
  cooldown extends for thin goods / shrinks for thick; claimLane locks + commits and a 2nd claim of
  the same good fails. ~8 tests.

### 3.3 Budget + phase — `budget/budget.ts`, `budget/phase.ts`
- `recomputeReserve` (fleet fuel cap × FUEL_PX + GOODS_CUSHION + per-ship cushion × RESERVE_CONCURRENCY).
- `computeExpansionTarget` (OPERATING_RESERVE + gateCost + haulerCost + NEW_CELL_SEED; **fail-safe gate
  status** — default UNBUILT, never collapse goal on unknown; `[A]` rule). Publish `goalBreakdown`.
- `determinePhase` (BOOTSTRAP→PROFIT→GATE_DISCOVERY→GATE_SUPPLY→INPUT_FEED→PORTAL_OPEN, derived;
  no lane-ranking effect), `PHASES`, `gateSupplyActive`.
- `gateCreditOk` **hysteresis latch** (pause at floor, resume at floor+gap; deadband holds previous
  state) + `reloadGateLevers` → now **polls `GET /gate-levers`** instead of file mtime.
- **Vitest (high value):** phase derivation truth table; hysteresis (no sawtooth: stays paused
  between floor and resume); expansion target never collapses when gate status unknown. ~8 tests.

### 3.4 Recovery + status — `recovery.ts`, `status.ts`
- `saveIntent/clearIntent` → persistence client **with local write-through fallback** (the crash-safety
  decision, MASTER-PLAN §6.5): write local file/SQLite-lite first, best-effort POST; reconcile on boot.
- `reconcileHeldCargo` — resume saved HAULING intent (prorated cost basis, replay ride-alongs) else
  salvage-sell orphan; **salvage-guard** (never dump active contract good or still-needed gate
  materials); colony hulls skip recovery. Stub the gate-material delivery branch to call a Wave-4 hook.
- `record(shipSym,net,label)` → update perShip/totalNet/lanesRun, `putRunStats`, `writeStatus`.
- `writeStatus` → build the snapshot object (identical shape to today's `bot-status.json`) and
  `POST /status`. Throttle ≥4s as today.

### 3.5 Worker skeleton — `worker.ts` + `supervise`
Implement the ordered decision loop from docs/02 §3, but with Wave-4 subsystems as injected,
no-op-by-default hooks (gateHauler, inputFeeder, mining, orphanGate, contracts). Implement the real
**recovery → TRADE** path now: `reconcileHeldCargo` → `buildLanes`/`claimLane` → goTo buy → buy →
ride-along → saveIntent → goTo sell → sell → record. `supervise()` restart-on-crash w/ 5s backoff.
STOP handling: replace the `STOP` file with a stop signal (SIGTERM/SIGINT handler **and** an optional
polled stop flag via the API or env) — preserve graceful drain semantics; document the change.

### 3.6 Minimal main wiring (interim)
A reduced `main.ts` that boots config, clients, loads markets + run-stats from API, discovers active
contract, launches supervised trade workers + `targetWatch`. Enough to run a trading-only bot for
validation. (Full manager wiring lands in Wave 5.)

## Acceptance checklist
- [ ] Lanes/budget/phase vitest suites green (the decision math is pinned).
- [ ] `tsc -b` clean; lint clean.
- [ ] Against compose (postgres + api), a single trade hull (or a dry-run/replay mode) completes a
      buy→sell→record cycle and the snapshot/run-stats land in the DB via the API.
- [ ] STOP/drain documented and working (graceful worker exit).
- [ ] Crash-safety: kill mid-haul (after saveIntent) → on restart the sell leg resumes with correct
      cost basis (manual or scripted check).
