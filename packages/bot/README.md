# @st/bot — the trading & expansion bot

The continuously-running autotrader. It runs ~20 ship workers in parallel against the SpaceTraders game
API and persists all state to [`@st/api`](../api/README.md) over HTTP. This is the TypeScript port of the
legacy single-file `bot2.mjs` (archived under [`legacy/`](../../legacy/)); behaviour is parity-faithful
to the legacy bot except where [`rebuild/DRIFT-LOG.md`](../../rebuild/DRIFT-LOG.md) records an approved
fix.

## Run it

```bash
# Canonical: the whole stack via Docker (postgres → api → bot)
docker compose up --build            # from repo root; DRY_RUN=1 by default (no token needed)

# Local dev (needs a reachable @st/api + Postgres):
pnpm install
pnpm --filter @st/api prisma:generate     # REQUIRED first — Prisma client is gitignored
pnpm -r build
pnpm --filter @st/bot start               # node dist/main.js
```

> The entry point is **`dist/main.js`** (it has the `import.meta.url` run guard). `dist/index.js` is the
> library barrel — importing it runs nothing. `pnpm --filter @st/bot start` and the Docker CMD both use
> `dist/main.js`.

## DRY_RUN (offline smoke mode)

With **`DRY_RUN=1`** the bot swaps in `clients/dryRun.ts` — a client that makes **zero** game-API calls
(canned reads, no-op mutations). It derives the phase + lanes from the persistence snapshot, logs them,
writes one `StatusSnapshot`, and idles on the stop watcher. This lets `docker compose up` boot and
smoke-test the full stack **with no token**. The live path is byte-for-byte unchanged; set `DRY_RUN=0`
(and supply a token) for a real run. `DRY_RUN_CREDITS` seeds the pretend credit balance.

## Operator flag profile

Every flag is a field on the `@st/shared` config schema; `loadConfig(process.env)` is the single env
entry point. The catalogue is in [`docs/05-config-reference.md`](../../docs/05-config-reference.md). The
ready-to-edit launch profile (reproducing the legacy `overnight_experiment.sh` ENVLINE) is
[`deploy/bot.env.example`](../../deploy/bot.env.example):

```bash
cp deploy/bot.env.example deploy/bot.env
#   paste SPACETRADERS_PLAYER_AGENT_TOKEN, set DRY_RUN=0, tune MIN_NET / GATE_* / MINE_* …
docker compose up --build               # compose loads deploy/bot.env if present
```

Connection/identity vars: `SPACETRADERS_PLAYER_AGENT_TOKEN` (read **only** from env, never stored),
`API_BASE_URL`, `BOT_KEY` (optional `x-bot-key` auth), `SYSTEM`.

## Module map

One `BotState` (`runtime/state.ts`) is threaded explicitly through every module — no module-level
mutable globals (the legacy had ~30).

| Area | Module(s) | Legacy origin |
|---|---|---|
| Entry / supervisor | `main.ts`, `worker.ts` | bot2 `main`/`worker`/`supervise` |
| Runtime state | `runtime/state.ts` | bot2 module globals |
| Routing | `routing/flight.ts` (`chooseMode`/`legFuel`/`legTime`), `routing/route.ts` (`planRoute`/`routeCost`) | bot2 L312-345, L2229-2287 |
| Trading lanes | `trade/lanes.ts` (`buildLanes`/`selectLane`/`claimLane`/`peekLane`/`cooldownFor`), `trade/marketHelpers.ts` | bot2 L394-448 |
| Ship actions | `trade/shipActions.ts` (`goTo`/`buy`/`sell`/`jump`/…) | trade.mjs |
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
| Clients | `clients/spacetraders.ts`, `clients/persistence.ts`, `clients/dryRun.ts` | st.mjs |

## Graceful stop

`installStopHandlers()` wires `SIGTERM`/`SIGINT` to set `state.stop`; each worker finishes its in-flight
action then exits, so `docker compose stop` / `Ctrl-C` / `kill -TERM` drain without half-completed
trades. For environments that can't signal, set `STOP_POLL=1` and the bot also trips on `STOP=1` in the
env.

## Tests

```bash
pnpm --filter @st/bot test
```

The suite includes unit tests, the **parity harness** (`src/__tests__/parity/` — TS == legacy on shared
fixtures), the **status-shape parity** test (`src/__tests__/status-shape.test.ts` — the `/status` `data`
block matches the legacy `bot-status.json` shape field-for-field), and the **crash-safety** test
(`src/__tests__/crash-safety.test.ts`).

---

## Operator procedure — live spot-check (run manually, not in CI)

CI has no game token, so behavioural parity against a live run is operator-verified:

1. `cp deploy/bot.env.example deploy/bot.env`; paste a real `SPACETRADERS_PLAYER_AGENT_TOKEN` and set
   `DRY_RUN=0`. Tune the flags to match the legacy run you're comparing against.
2. `docker compose up --build`. Wait for `api` healthy, then `bot` to begin trading.
3. Read the written snapshot: `curl -s localhost:3000/status | jq .data`.
4. Diff its fields against a legacy `bot-status.json` from an equivalent run — confirm parity on:
   **phase**, **credits**, **reserve**, **lanes** (lane set + ranking), and **fleet counts**
   (gate haulers / mine transport / busy feeders). The snapshot-shape test already guarantees the *shape*
   matches; this confirms the *values* track a legacy run on the same `SYSTEM` + flags.
5. Let it run a few cycles and confirm `runNet` advances and the phase transitions match the legacy
   playbook (BOOTSTRAP → PROFIT → GATE_* → PORTAL_OPEN).

## Operator procedure — crash-safety drill (run manually)

The automated `crash-safety.test.ts` covers down-at-save / down-at-boot / reconnect-reconcile; to verify
end-to-end against the real stack:

1. With the stack live (`DRY_RUN=0`), let the bot pick up at least one haul (so an intent exists):
   `curl -s localhost:3000/intents | jq`.
2. Stop the api only: `docker compose stop api`. Confirm the bot keeps trading and that its local
   write-through cache advances — `intents.json` under the bot's `$BOT_STATE_DIR` (default `.bot-state`)
   keeps getting newer entries.
3. Restart the api: `docker compose start api`. In the bot log, confirm the boot reconcile line
   (`reconciled N local + M api intent(s)`), then `curl -s localhost:3000/intents | jq` and check the DB
   now matches the local survivor (newest-wins).

---

## Follow-up (not done in this wave)

The legacy monitor scripts (`legacy/dashboard.mjs`, `legacy/contracts.mjs`, `legacy/status.mjs`,
`legacy/markets.mjs`) still read the old local JSON files. Re-pointing them at the api (`GET /status`,
`/markets`, …) is an explicit **future follow-up wave** — the snapshot-shape parity test guarantees the
`data` block they consume is unchanged, so the migration is mechanical.
