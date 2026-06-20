# Wave 9 — Mining colonies (park-and-ferry: surveyor + drones + haulers)

**Commits:** `b9812e1` (frontier mining colony base: `MINEDRONE`/`stepMiner`/`commonMetalAsteroids` +
local-buy anchor — anchor primitive already in W8), `ab9ec55` (full park-and-ferry:
`MINESURVEY`/`MINEDRONE`/`MINEHAUL` roles, shared survey pool, ore-push transfer, per-colony status
breakdown), `0a08d69` (RECALL exempts mine systems — keep colony crew local), `6d41644` (stray-ship
recovery BFS-route toward home path[0] + new outpost waypoints in operator config).
**Depends on:** Wave 8 (anchorBuy/local autobuy) + Wave 7 (reach deep frontier systems).
**Blocks:** Wave 10. **Model:** heavy.

## Goal
Add a renewable, **non-diluting** scaling lever: per-system mining colonies. Multiple colonies don't
compress each other's prices (each mines its own asteroids → sells to its own local refinery). All
colony ships converge on one shared asteroid so ore transfers always co-locate.

## Roles (all bought LOCALLY at the colony's own shipyard via W8 `anchorBuy`)
- **MINESURVEY** `stepSurveyor` (L774): parks on the shared rock, produces surveys into a shared pool;
  survey-density scored (`bestSurvey`/`pruneMineSurveys` L741–742), expired surveys pruned.
- **MINEDRONE** `stepMiner` (L791): parks, extracts full-time (survey-biased), **PUSHES** ore to a
  co-located hauler via `transfer`; falls back to selling itself only if no hauler (no deadlock).
- **MINEHAUL** `stepMineHaul` (L833): collects pushed ore; when full (or after a 3-min partial-load
  deadline) ferries to the best **local** sink (refinery imports the ore) and sells. Keeps drones at
  100% uptime. Includes the **export-claim contention guard** (note: the sell-cap/contention details
  also touched in W11 `9700356` — coordinate; the guard belongs with the hauler).

## Supporting functions
- `commonMetalAsteroids(sys)` (L709) — cached per-system asteroid finder, skips CRITICAL_LIMIT depleted
  rocks. `colonyAsteroid(sys)` (L743) — choose the one shared rock. `ensureAtRock` (L751),
  `migrateToMine` (L762, primitive from W8). `MINE_ORES` const (IRON/COPPER/ALUMINUM…).
- `adoptMiners(fleet)` (L1451) — restart-safe role assignment by hull capability (surveyor vs drone vs
  hauler), adopts mining hulls **anywhere** (stranded home hulls migrate over). Safe since home mining
  (`MINE_FEED`) is off post-gate.
- `autoBuy`: colonies are **priority #1** (surveyor → haulers → drones) before trader migration.
- `statusBlock()`: per-colony breakdown (asteroid, survey count, surveyor/hauler/drone counts).
- `0a08d69`: `RECALL` (W10) must **exempt** mine systems — leave the exempt hook/flag check here so W10
  composes cleanly.

## State (runtime/state.ts — additive)
`mineColony: Map<sys, { asteroid?: string; surveys: Survey[]; surveyors/haulers/drones counts }>`,
plus a `Survey` interface. `createState()` initializes empty.

## Config (additive, defaults from decl sites): `EXPAND_MINE` (csvSet of systems),
`EXPAND_MINE_SURVEYORS`/`_HAULERS`/`_DRONES` (num, def 1/2/6), `EXPAND_MINE_SURVEYOR_TYPE`/`_HAUL_TYPE`/
`_DRONE_TYPE` (str defaults SHIP_SURVEYOR / SHIP_LIGHT_HAULER? / SHIP_MINING_DRONE — confirm), reuse
`EXPAND_MAX_BUY_DRONES` (W8). Requires a `transfer` ctx dep added to `ExpansionCtx`.

## Tests (vitest — pure, minimal)
- `bestSurvey` density scoring + `pruneMineSurveys` expiry.
- `commonMetalAsteroids` skips CRITICAL_LIMIT rocks (fixture).
- `adoptMiners` role-by-hull-capability assignment (fixture ships).

## Acceptance
- [ ] `EXPAND_MINE` unset ⇒ Wave-8 parity (no colony, no buys, no side-effects). [ ] transfer wired
  into ctx. [ ] RECALL-exempt seam present for W10. [ ] build + new vitest green + lint 0 + DRIFT
  entries (esp. the W11 sell-cap/contention coordination).
