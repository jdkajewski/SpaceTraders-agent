# SpaceTraders-agent — TypeScript Monorepo Rebuild (Master Plan)

> This is the source-of-truth plan for porting the file-based `bot2.mjs` system into a maintainable,
> modular TypeScript monorepo with a Fastify + Prisma + Postgres persistence API. Each **wave** below
> has a detailed spec in `rebuild/plans/wave-N-*.md`. Sub-sessions implement one wave at a time.

## 1. Target architecture

```
                       ┌─────────────────────────────┐
   SpaceTraders v2 API │  packages/bot (TS, ESM)     │
   (direct, rate-      │  - per-ship workers + mgrs  │
    limited 2 req/s) ◄─┤  - SpaceTraders client      │
                       │  - all persistence via HTTP ├──► packages/api (Fastify TS)
                       └─────────────────────────────┘        - fastify-autoload
                                     ▲                          - fastify-plugin (fp)
                       packages/shared (types + zod config)     - Prisma ──► PostgreSQL
```

- **bot → api → prisma → postgres** for ALL persistence. The bot never touches disk/DB directly
  (one exception: an optional local **crash-safety fallback** for intents/run-stats — see §6.5).
- The bot keeps the **shared module-global token-bucket rate limiter** for direct SpaceTraders calls.
- Three Docker images: `postgres`, `api`, `bot`. `bot` depends on `api`; `api` depends on `postgres`.

### Workspace layout
```
package.json (workspaces, root scripts)
pnpm-workspace.yaml
tsconfig.base.json
docker-compose.yml
packages/
  shared/   # @st/shared  — types, zod config, constants, coords loader
  api/      # @st/api     — Fastify app, plugins, routes, Prisma
  bot/      # @st/bot     — bot runtime (ports of bot2/st/trade/expansion)
rebuild/    # this plan (kept in repo for sub-sessions)
docs/       # existing design docs (07 = doc-drift)
legacy .mjs # kept until Wave 6 cutover, then archived/removed
```

## 2. Tooling & conventions (apply repo-wide)
- **Node 20+, ESM, TypeScript strict.** `"type":"module"`, `moduleResolution: "NodeNext"`.
- **pnpm** workspaces. Root `tsconfig.base.json`; each package extends it with project references.
- **Lint/format:** ESLint (typescript-eslint) + Prettier. Keep config minimal.
- **Tests:** **Vitest**, *minimal and high-signal* — only pure/decision logic (routing, lane scoring,
  cooldown EMA, phase derivation, credit hysteresis, gate-fill planning, market partition, config
  parsing). **No** API-mock soup, no hundreds of trivial tests. A handful that pin the math/decisions.
- **Logging:** `pino` (replaces the `console.error` timestamp logger). Preserve the emoji markers in
  messages (the monitors/dashboard parse them).
- **Config:** one `zod` schema in `@st/shared` parsing all ~106 env flags, grouped by subsystem, with
  the **code defaults** from `bot2.mjs` (NOT the operator live-launch values). Booleans keep the
  bot's idioms (`X !== '0'` = default-on, `X === '1'` = default-off).
- **IDs/strings:** preserve waypoint/ship symbol conventions and the `slice(-3)` short-id display.

## 3. File → database mapping (Prisma models)
The API replaces every file the bot reads/writes. Authoritative list (from `bot2.mjs`):

| Legacy file | Direction | Prisma model | Notes |
|---|---|---|---|
| `run-stats.json` | bot RW, boot read | `RunStats` (singleton row) | `totalNet`, `lanesRun`, `updatedAt`. Crash-safety. |
| `intents.json` | bot RW per ship | `Intent` (PK `shipSym`) | phase, good, units, buyWp, sellWp, costBasis, `extras` JSON. Crash-safety. |
| `bot-status.json` | bot W, tools R | `StatusSnapshot` (latest + optional history) | full live snapshot JSON + key columns (phase, runNet, credits, gate...). |
| `markets.json` | bot RW | `MarketSnapshot` (PK `waypoint`) | latest market data per wp (`data` JSON) + `updatedAt`. |
| `market-history.jsonl` | bot append | `MarketHistory` | ts, waypoint, good, purchase/sell px, volume, supply, activity. |
| `trade-observations.jsonl` | bot append | `TradeObservation` | ts, ship, good, buyWp, sellWp, projected, realized, etc. |
| `mine-history.jsonl` | bot append | `MineEvent` | ts, type, ship, `data` JSON (extract/refine/survey/feed). |
| `gate-levers.json` | operator W, bot R(poll) | `GateLevers` (singleton) | floor, resume, gap. Operator control input. |
| `fuel-nodes.json` | bot W (derived) | (optional) `FuelNodes` | derived cache; may stay in-memory. Low priority. |
| `coords.csv` | static input | `Waypoint` (seed) | x/y per waypoint; seed at migrate time. |
| `tracker.md` | bot W (human) | — | DROP (replace with API/DB + pino). Flagged §6.6. |
| `.current_log` | bot W (ops) | — | DROP (pino). |

> History tables (`MarketHistory`, `TradeObservation`, `MineEvent`) take **batch append** endpoints so
> the bot can flush arrays in one request (matching the append-only JSONL pattern, fewer API calls).

## 4. API surface (REST, grouped by resource, autoloaded)
Each becomes a route plugin file under `packages/api/src/routes/`. fastify-autoload mounts them.

- `GET /health` — liveness/readiness (DB ping).
- `GET /run-stats` · `PUT /run-stats` — read/replace the singleton.
- `GET /intents` · `GET /intents/:ship` · `PUT /intents/:ship` · `DELETE /intents/:ship`.
- `GET /status` (latest) · `POST /status` (write snapshot).
- `GET /markets` · `GET /markets/:wp` · `PUT /markets/:wp` (or bulk `PUT /markets`).
- `GET /gate-levers` · `PUT /gate-levers`.
- `POST /market-history` (batch) · `GET /market-history` (filter wp/good/since).
- `POST /trade-observations` (batch) · `GET /trade-observations`.
- `POST /mine-events` (batch) · `GET /mine-events`.
- `GET /waypoints` (coords) — seeded, read-mostly.

**Plugin structure (fastify-plugin / fp):** `plugins/config.ts` (zod env → `fastify.config`),
`plugins/prisma.ts` (decorate `fastify.prisma`, graceful shutdown), `plugins/sensible.ts`
(`@fastify/sensible`). Routes use `fastify.prisma` + schema validation (Typebox or zod-to-json-schema).

## 5. Bot module decomposition (ports of the `.mjs` files)
Target tree for `packages/bot/src/`:

```
config.ts            ← from @st/shared (re-export typed config)
clients/
  spacetraders.ts    ← st.mjs: token bucket, retries, structured errors, getAllShips/Contracts
  persistence.ts     ← NEW: typed HTTP client to the Fastify API (replaces all fs RW)
core/
  logger.ts          ← pino
  coords.ts          ← from shared (D(), coords map)
routing/
  flight.ts          ← chooseMode, legFuel, legTime, computeFuelPx, TIME_FACTOR
  route.ts           ← planRoute, planRouteFuelCargo, routeCost, fuelNodes, marketSellsFuel
market/
  markets.ts         ← getMarkets cache + TTL, fuelPx, updateBaselines, goodMargins, history feed
trade/
  shipActions.ts     ← trade.mjs: navigate/buy/sell/deliver/fulfill/transfer/refuel/jump (+ladders)
  lanes.ts           ← buildLanes, planRideAlongs, claimLane, cooldownFor, goodState, commit/uncommit
budget/
  budget.ts          ← recomputeReserve, availableForWork, growthBudget, computeExpansionTarget
  phase.ts           ← determinePhase, PHASES, gateSupplyActive
gate/
  gate.ts            ← gateCreditOk hysteresis, reloadGateLevers(→poll), planGateFill, gateBuyAllowed,
                       gateSupplyTrip, gate caches/claims
  orphan.ts          ← deliverOrphanGateCargo + fuel-cargo haul helpers + transfer-to-co-located
contracts/
  contracts.ts       ← contractManager, electContractOwner, contractRunnerTrip, isForced, self-heal
mining/
  mining.ts          ← roles: refiner/drone/surveyor/funnel/transport, surveys, extract/refine
  expandMine.ts      ← mineExpandManager, mineMigrateManager, buyMiningShip
feed/
  inputFeed.ts       ← inputFeedTrip, planInputFeed
fleet/
  scale.ts           ← fleetScaleManager (probe↔cargo balance, hauler/shuttle buys)
  repair.ts          ← maybeRepair, repairAt, getShipyards
expansion/           ← port of expansion.mjs (createExpansion, jump orchestration, residency)
recovery.ts          ← reconcileHeldCargo, saveIntent/clearIntent (via persistence client + fallback)
worker.ts            ← the ordered per-ship decision loop (doc 02 §3) + supervise()
status.ts            ← writeStatus → POST /status; fleetTable route capture
main.ts              ← bootstrap + Promise.all(managers + supervised workers + stopWatch)
```

Each module exposes pure functions where possible and takes its dependencies (clients, config,
shared state) explicitly so it is unit-testable and reusable. Shared mutable runtime state (caches,
claims, goodState) is consolidated into a small `runtime/state.ts` passed in, rather than 30
module-level `let`s.

## 6. Drift, quirks & decisions (parity-first; defaults proposed)
The user asked to surface where code behavior diverges from the docs. Findings:

1. **Docs lag the code (~2404 → 3206 lines).** Present in code, thin/absent in docs: `FLEET_SCALE`
   (`fleetScaleManager`, probe↔cargo balance autoscaler), `AUTO_EXPAND` + `expansion.mjs` (699 LOC),
   `REPAIR` two-tier maintenance, `mineMigrateManager`, ship purchasing (`buyMiningShip`,
   `getShipyards`), `TRADE_FIRST`, `CONTRACTS` master switch. **Decision:** port everything (parity).
2. **`trade.mjs` `jump()` exists** — doc 08 lists it as a primitive to build. Port as-is.
3. **Config defaults vs live-launch values differ** (docs 05/07: `MIN_NET` 4000 vs 1200,
   `GATE_CREDIT_FLOOR` 1.5M vs 900k, etc.). **Decision:** TS config uses the **code defaults**;
   operators override via env (compose env-file). Document the live profile in the README.
4. **`gate-levers.json` hot-reload** (`reloadGateLevers` polls file mtime so operators tune the credit
   band live). New mechanism: bot polls `GET /gate-levers` on the same cadence; operators `PUT` it
   (or a small admin script). Same observable behavior.
5. **Crash-safety regression (NEEDS CONFIRMATION).** Today `intents.json` + `run-stats.json` are local
   files, so a crash mid-haul resumes the exact sell leg and net survives restarts (docs 02 §5, 04
   §13). Behind the API, an API outage at the buy→sell transition could drop an intent and strand
   cargo / corrupt net. **Proposed default:** the bot keeps a **local write-through fallback** for
   exactly these two records (write local + best-effort POST; on boot, reconcile local↔API, newest
   wins). Everything else (history, status, markets) is fire-and-forget to the API. *Confirm or override.*
6. **`tracker.md` + `.current_log`.** Human/ops file artifacts. **Proposed:** drop; the dashboard/
   monitors move to reading the API/DB (out of scope for the bot port; tools migration is a later
   wave/optional). *Confirm.*
7. **Monitors/tools (`dashboard.mjs`, `contracts.mjs`, `status.mjs`, etc.)** read local files today.
   They are **out of scope** for the initial port; after cutover they can be pointed at the API. Noted
   in Wave 6 as a follow-up, not blocking.

## 7. Sub-session handoff protocol
- The integration branch is **`jdkajewski/ts-rewrite-plan`**. Each wave's sub-session branches **off the
  integration branch** (stacked) so later waves see earlier waves' code. Waves that are independent of
  each other (e.g. Wave 4 subsystems) may run in parallel off the same base once Wave 3 lands.
- **Kick-off mode:** open each sub-session in **plan mode** with a thinking model so it expands its
  wave spec into concrete todos first, then implement.
- **Right-sized models (suggested):**
  - Wave 0 / Wave 1 (scaffold, schema, CRUD routes): mid-tier coding model.
  - Wave 2 routing/markets, Wave 3 lanes/budget/phase, Wave 4 contracts/mining, Wave 5 expansion:
    heavier reasoning model (intricate ported logic + parity).
  - Vitest authoring: mid-tier.
- **Definition of done per wave:** code compiles (`tsc -b`), lint passes, the wave's targeted vitest
  passes, and the wave's checklist in its spec is complete. Update the SQL todo to `done`.
- **Parity rule:** when porting a function, keep its `[RULE:*]` comments and behavior; if you believe a
  behavior is a bug, do NOT silently change it — note it in `rebuild/DRIFT-LOG.md` for review.

## 8. Wave index
| Wave | Spec | Depends on |
|---|---|---|
| 0 Foundation | `plans/wave-0-foundation.md` | — |
| 1 API | `plans/wave-1-api.md` | 0 |
| 2 Bot core | `plans/wave-2-bot-core.md` | 0 |
| 3 Trading + budget | `plans/wave-3-trading-budget.md` | 2 |
| 4 Subsystems | `plans/wave-4-subsystems.md` | 3 |
| 5 Expansion + integration | `plans/wave-5-expansion-integration.md` | 4, 1 |
| 6 Validation + cutover | `plans/wave-6-validation-cutover.md` | 5 |
