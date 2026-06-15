# 09 — The TypeScript Rebuild (monorepo architecture)

This page describes the **TypeScript monorepo** that, as of Wave 6, is the canonical SpaceTraders bot.
Docs [`01`](01-strategy.md)–[`08`](08-expansion.md) describe the original single-file `bot2.mjs` — they
remain the **behavioural spec** the TS port preserves (parity-first), but the code now lives under
`packages/`. The legacy `.mjs` files are archived under [`legacy/`](../legacy/) and are imported by
nothing in production; they survive only as the reference for the parity harness.

---

## 1. Workspace layout

A pnpm + TypeScript-project-references monorepo with three packages:

```
packages/
  shared/   @st/shared  — config (zod), domain types, constants, coords/distance math. No I/O.
  api/      @st/api     — Fastify + Prisma/Postgres persistence service (the bot's only datastore).
  bot/      @st/bot     — the trading/expansion bot; talks to the game API + @st/api over HTTP.
docs/                   — this documentation set.
rebuild/                — the rebuild plan (MASTER-PLAN.md), per-wave specs, and DRIFT-LOG.md.
legacy/                 — archived legacy .mjs (bot2/st/trade/expansion + monitors). Parity reference only.
deploy/                 — bot.env.example (operator flag profile).
docker-compose.yml      — postgres → api (healthcheck) → bot.
coords.csv              — waypoint coordinate seed (root; the API Docker seed depends on it).
```

`@st/shared` is dependency-free domain logic; `@st/api` and `@st/bot` both depend on it. The bot does
**not** import the api package — it speaks to it over HTTP via the persistence client, so the two deploy
and scale independently.

---

## 2. `@st/shared` — config & domain core

- **`config.ts`** — the single env entry point. `loadConfig(process.env)` parses a flat zod schema, then
  a post-transform fills cross-field derived defaults (e.g. `GATE_CREDIT_RESUME = FLOOR + GAP`,
  `FEED_*` mirroring `GATE_*`, `CONTRACT_RIDEALONG` coupling to `MULTI_GOOD`). This is the home of every
  operator flag — see [`05-config-reference.md`](05-config-reference.md) for the catalogue.
- **`types.ts`** — shared DTOs (`Ship`, `Market`, `MarketGood`, `Intent`, `RunStats`, `StatusSnapshot`,
  `GateLevers`, history rows). The bot and api exchange these, never Prisma types.
- **`constants.ts`** — ported legacy constants (`REFINE_IN`, etc.).
- **`coords.ts`** — `distance()` (rounded Euclidean, matches legacy `D`) over a `CoordsMap`.

## 3. `@st/api` — persistence service

Fastify server (`app.ts`/`server.ts`) backed by Prisma/Postgres. It replaces **all** of the bot's legacy
file I/O (`run-stats.json`, `intents.json`, `bot-status.json`, `markets.json`, `*-history.jsonl`,
`gate-levers.json`). Routes (`src/routes/`):

| Route | Replaces (legacy file) | Notes |
|---|---|---|
| `GET/PUT /run-stats` | `run-stats.json` | critical (bot write-through) |
| `GET/PUT/DELETE /intents` | `intents.json` | critical (bot write-through) |
| `POST /status` | `bot-status.json` | telemetry; body = legacy snapshot shape in `data` |
| `GET/PUT /markets`, `GET /markets/:wp` | `markets.json` | latest market snapshot |
| `GET/PUT /gate-levers` | `gate-levers.json` | operator credit-band control (polled) |
| `POST /market-history` | `market-history.jsonl` | append-only, batched |
| `POST /trade-observations` | `trade-observations.jsonl` | append-only, batched |
| `POST /mine-events` | `mine-history.jsonl` | append-only, batched |
| `GET /waypoints` | `coords.csv` | seeded from coords.csv |
| `GET /health` | — | compose healthcheck |

Interactive route docs are served by Fastify Swagger UI at **`/docs`** (see
[`packages/api/README.md`](../packages/api/README.md)). Bot→api writes can be authenticated with an
`x-bot-key` shared secret (`BOT_KEY`, `BOT_AUTH_ENABLED`).

## 4. `@st/bot` — the bot

The 3206-line `bot2.mjs` was decomposed into focused modules under `packages/bot/src/`. The runtime is
single-threaded-coherent: one `BotState` object (`runtime/state.ts`) is passed explicitly to every module
instead of the ~30 module-level `let`s the legacy used.

| Area | Module(s) | Legacy origin |
|---|---|---|
| Entry / supervisor loop | `main.ts`, `worker.ts` | bot2 `main`/`worker`/`supervise` |
| Runtime state | `runtime/state.ts` | bot2 module globals |
| Routing | `routing/flight.ts` (`chooseMode`/`legFuel`/`legTime`), `routing/route.ts` (`planRoute`/`routeCost`) | bot2 L312-345, L2229-2287 |
| Trading lanes | `trade/lanes.ts` (`buildLanes`/`selectLane`/`claimLane`/`peekLane`/`cooldownFor`), `trade/marketHelpers.ts` | bot2 L394-448 |
| Ship actions | `trade/shipActions.ts` (`goTo`, `buy`, `sell`, `jump`, …) | trade.mjs |
| Budget / phase | `budget/budget.ts` (reserve, growth, `computeExpansionTarget`), `budget/phase.ts` (`determinePhase`, `gateCreditOk`) | bot2 L635-722 |
| Gate supply | `gate/gate.ts` (`planGateFill`), `gate/orphan.ts` (orphan-cargo rescue) | bot2 L1291-1328, L2478 |
| Contracts | `contracts/contracts.ts` | bot2 contract suite |
| Mining | `mining/mining.ts`, `mining/expandMine.ts` | bot2 mine managers |
| Input feed | `feed/inputFeed.ts` | bot2 input-feed |
| Fleet | `fleet/scale.ts`, `fleet/repair.ts`, `fleet/table.ts` | bot2 FLEET_SCALE/REPAIR/fleet-table |
| Expansion | `expansion/expansion.ts`, `expansion/partition.ts` | expansion.mjs |
| Markets service | `market/markets.ts` | bot2 L349-364 `getMarkets` |
| Status snapshot | `status.ts` | bot2 `record`/`writeStatus` |
| Crash safety | `recovery.ts` (`FileLocalStore`, `saveIntent`, `reconcileLocalToApi`) | bot2 `saveIntent`/`clearIntent` |
| Clients | `clients/spacetraders.ts` (game API + rate limit), `clients/persistence.ts` (→ @st/api), `clients/dryRun.ts` | st.mjs |

### Persistence & crash-safety flow

`run-stats` and `intents` are **critical**: the persistence client writes them **through a local store
first** (`FileLocalStore`, atomic `*.tmp`→rename under `$BOT_STATE_DIR`), then best-effort to the API;
reads prefer the API and fall back to local on failure. On boot, `reconcileLocalToApi()` does a
newest-wins reconcile (local crash-survivor intents win; API-only intents are pulled back down) before
workers start. Status / markets / history writes are **fire-and-forget telemetry** (retry + drop) so a
flaky API never blocks a trade. This is verified by the durable `__tests__/crash-safety.test.ts`
(API-down-at-save / API-down-at-boot / reconnect-reconcile) — see [MASTER-PLAN §6.5](../rebuild/MASTER-PLAN.md).

### DRY_RUN smoke seam

`clients/dryRun.ts` provides an offline client (no `fetch`, canned reads, no-op mutations). When
`DRY_RUN=1` (the compose default) `main.ts` swaps it in: the bot derives phase + lanes from the
persistence snapshot, logs them, writes one `StatusSnapshot`, and idles on the stop watcher — so the full
stack can boot and be smoke-tested without a game token. The live path is byte-for-byte unchanged.

---

## 5. Parity & drift

- **Parity harness** (`packages/bot/src/__tests__/parity/`): asserts the TS pure decision functions
  produce output identical to the legacy math on shared fixtures. Because `bot2.mjs` self-executes
  `main()` and reads files at import time, it cannot be imported in a test; the harness instead uses a
  durable, line-referenced verbatim transcription (`legacy-shims.ts`, sanctioned option (a)) and the
  real exports from `st.mjs`/`trade.mjs` where available. Covers `chooseMode`, `planRoute`, `routeCost`,
  `buildLanes`, `cooldownFor`, `determinePhase`, `gateCreditOk`, `planGateFill`, `computeExpansionTarget`,
  `partitionMarkets`, plus a status-snapshot shape test pinning the `bot-status.json` field set.
- **Drift** (`rebuild/DRIFT-LOG.md`): every behaviour where the port differs from the legacy — all 35
  entries resolved in Wave 6 (applied fix, or preserved-as-designed with rationale, or
  resolved-with-pointer).

---

## 6. Running it

See the READMEs for the full reference:
- Root [`README.md`](../README.md) — install, `docker compose up`, env/flags, DB migrate/seed, graceful stop.
- [`packages/api/README.md`](../packages/api/README.md) — route reference + Swagger `/docs`.
- [`packages/bot/README.md`](../packages/bot/README.md) — module map, operator flag profile, `DRY_RUN`,
  live spot-check procedure.

> **Future follow-up (not done in W6):** the legacy monitor scripts (`dashboard.mjs`, `contracts.mjs`,
> `status.mjs`, `markets.mjs`) still read the old local JSON files. Re-pointing them at the API
> (`GET /status`, `/markets`, …) is an explicit follow-up wave — the snapshot-shape parity test guarantees
> the `data` block they consume is unchanged, so that migration is mechanical.
