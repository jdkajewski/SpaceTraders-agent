# 06 — Tooling & Ops Scripts

A constellation of small Node scripts surrounds `bot2.mjs`. The dominant design philosophy:
**read-only, local-file-first, rate-limit-safe.** Most monitors answer from files the bot already
writes (`bot-status.json`, `*.log`, `mine-history.jsonl`, `run-stats.json`, `markets.json`) so they
**never steal throughput** from the bot's shared ~2 req/s budget. API access is opt-in (`--live`) and
narrow. See [`04 §2`](04-optimizations-and-tricks.md).

> ⚠️ The live bot is running. Anything that hits the API (`--live` flags, `health.mjs`, `snap_markets`,
> `calib`, raw `st.mjs` calls) competes with the bot for the rate budget. Prefer the local-only modes.

---

## Core library

### `st.mjs` — rate-limited API client
The shared foundation. Token-bucket limiter (CAPACITY 2, REFILL 2/s) as a module global so the whole
fleet is throttled without locks; 429-aware (`retryAfter`), capped exponential backoff on network
errors (8 tries), 5xx/408 retried 4×; structured error tags (`.status`, `.code`, `.network`).
Exports `api`, `getAllShips`, `getAllContracts`, `reqStats`. Imported by the bot **and** by any tool
that goes `--live`. Full design in [`04 §1`](04-optimizations-and-tricks.md).

### `trade.mjs` — safe ship-action helpers
Wraps `navigate / buy / sell / deliver / fulfill / getShip / refuel / transfer` with the
hard-won safety behaviors: navigate mode-downgrade ladder (BURN→CRUISE→DRIFT on low fuel), auto-refuel
at leg start, idempotent "already at destination" handling, buy slippage loop, and the **correct
`transfer(fromSym, toSym, symbol, units)` arg order** (`[RULE: transfer-argorder]`). Imported by the
bot; reused by tools that act.

---

## Live/operational monitors

### `contracts.mjs` — contract lifecycle viewer ⭐
Reconstructs the full contract lifecycle (negotiate → accept → per-good deliveries → fulfill, with
cycle durations and credits) **purely by parsing the bot logs + `bot-status.json` — zero API calls**
in default and watch modes. Includes the monotonic-clock day-rollover hack (see [`04 §2`](04-optimizations-and-tricks.md))
so multi-day timing survives log rollovers and restarts. `--live` opts into API enrichment. The
canonical "what are contracts doing right now?" tool, safe to leave running.

### `dashboard.mjs` — unified live TUI ⭐
The all-in-one operator screen, built on **blessed** (screen-diffing, in-place updates — **no
clear-screen flicker**, unlike the old `status.mjs --watch` / `mon3.mjs` refresh loops it replaces).
Five keyboard-navigable pages:

- **[1] Status** — header (agent · phase · run net · credits · lanes · clock), GATE construction
  progress bars (live), MINING COLONY summary, and a colorized FLEET table showing the **full
  multihop route** (e.g. `B6→H51→A4`) from the new `bot-status.json` `ships[].route` field, falling
  back to the live nav leg until the bot repopulates it.
- **[2] Logs** — live colorized scrollable tail of the active log (re-resolves `.current_log` so it
  follows rotation/restart). Colors by marker (✔ 💰 ⛽ ⛏️ 🪐 🧭 🛰 🎯 ↺ ⚠ 🚚, `ctr✓`/`ctr?`, errors)
  and highlights ship ids + credit deltas.
- **[3] Contracts** — live `GET /my/contracts`: type, per-good delivery progress bars, deadlines,
  accept/fulfill flags, and payments.
- **[4] Markets** — paginated per-waypoint price tables from `markets.json` (buy/sell/volume/supply).
- **[5] Surveys** — paginated recent `survey` events from `mine-history.jsonl` (asteroid, size, ship,
  deposits, freshness) — the only place surveys are visible since the API doesn't list them.

Keys: `1`-`5` switch page · `↑`/`↓` scroll · `PgUp`/`PgDn` or `←`/`→` paginate (Markets/Surveys) ·
`g`/`G` top/bottom · `r` force API refresh · `q`/`Ctrl-C` quit. Local files are polled every ~1.5s and
the log tailed continuously; the live API (agent/ships/contracts/gate) refreshes ~every 25s with
429-aware retry. Env: `BOT_DIR`, `ST_TOKEN`, optional `DASH_PAGE` (initial page). Launch via
`node dashboard.mjs` or `./monloop.sh`.

### `status.mjs` — point-in-time snapshot
Reads `bot-status.json` (+ other local artifacts) for fleet, phase, credits, gate progress, totals.
Local-first; minimal/no API. The one-shot/`--json` modes remain; for a live view use `dashboard.mjs`
(it supersedes `status.mjs --watch`).

### `mon3.mjs` — live dashboard (legacy)
Rolling dashboard view (refreshing) built mostly from local files plus small live deltas. Superseded
by `dashboard.mjs` for day-to-day monitoring.

### `health.mjs` — deeper health probe
More thorough check that **does** hit the API for live fleet/agent state — use sparingly while the bot
runs (it competes for the budget).

### `networth.mjs` — net-worth accounting
Computes total net worth (credits + ships + in-flight cargo valuation) from local data, for tracking
the real bottom line beyond sawtoothing liquid credits. Reinforces the "judge by `totalNet`, not
credits" principle from [`01`](01-strategy.md).

---

## Analysis & calibration (run occasionally, some hit the API)

### `trade.mjs` (as analysis) / `markets.mjs`
`markets.mjs` is a one-off market dumper/inspector. (`trade.mjs` is primarily the action library above.)

### `market_diff.mjs` — snapshot differ
Diffs two **local** market snapshot files to show price/supply movement over time. Zero API.

### `snap_markets.mjs` — market snapshotter
Samples markets and writes a snapshot file. Reads the *waypoint list* from local `markets.json` first,
then hits the API to sample — so it's API-using but minimizes calls. Run to feed `market_diff.mjs`.

### `calib.mjs` — flight-model calibration (bring-up step)
Run **at the beginning of a deployment** to calibrate the flight-mode fuel/time coefficients used by
`chooseMode`. It navigates a ship one real leg, captures the actual `fuel.consumed` and travel duration
from the API, compares them to the three candidate models, and derives the `fuel/dist` and
`time = round(dist × k / speed) + 15` constants that get baked into `bot2.mjs` (`legFuel`/`chooseMode`).
Hits the API to measure real travel; a one-time/occasional tuning pass, not part of the steady loop.

### `probe_util.mjs` — probe-utilization ranker (expansion pre-staging)
Ranks the 27 market-scout probes by **how little we actually trade at the market each one is parked on**,
combining (1) the live probe→waypoint station (API) with (2) a usage score = count of trade-context log
lines that reference each waypoint (**log analysis**). Essential markets (gate `I63`, producers
`F51`/`D43`, ore source, contract sinks) carry a `KEEP` reason; low-traffic probes (`hits < 100`) are
flagged `<< EXPANSION CANDIDATE`. `node probe_util.mjs --csv >> probe_util.csv` appends a timestamped
snapshot, and **`probe_sampler.sh` runs that every 30 min** to build a time-series. The point: we
**continuously track probe usage so that the moment the gate opens we already have a ranked list of idle
probes to peel off and seed the next system** — redeploying assets that are doing little here instead of
waiting to buy new ones (see `08-expansion.md` §3).

### `market_diff` + `snap_markets` + `calib` together
The "tune the model" toolkit: snapshot → diff to see depletion/recovery; calibrate flight costs.

---

## Advisory / planning

### `expand.mjs` — growth advisor
Advisory engine for fleet/expansion decisions: when to buy another hull, expansion saturation
(`[RULE: expansion-saturation]` — don't add a hull when active ones realize < ~60% of best lane), and
new-system seeding economics. Advisory output — does not act on the live agent by itself.

### `allocate.mjs` — (legacy) lane allocator
Older lane-allocation helper from the v1 era; superseded by the bot's in-process continuous lane
claiming. Kept for reference/experiments.

---

## One-offs / utilities

| Script | Role |
|---|---|
| `buyFab.mjs` | Manual one-shot: buy FAB_MATS (used during gate-supply experiments). API-using; manual. |
| `active_contract.mjs` | Print the current active contract (paginates the contracts endpoint correctly, `[RULE: paginate-active-contract]`). |
| `markets.mjs` | Inspect/dump market data for a waypoint. |

---

## Legacy

### `bot.mjs` — v1 autotrader
The original trader with a **fleet-wide barrier** (all ships rest together between rounds) and global
rest — the design `bot2.mjs` replaced with continuous per-ship workers + per-good cooldowns (see the
header comment in `bot2.mjs` and [`02`](02-architecture.md)). Kept for history; **not** what runs in
prod.

---

## Quick "what do I run?" guide

| I want to… | Run | API? |
|---|---|---|
| Live all-in-one dashboard | `node dashboard.mjs` / `./monloop.sh` | ~25s polls |
| See contract progress | `node contracts.mjs` (add `--watch`) | none |
| Glance at overall status | `node status.mjs` (one-shot) / `dashboard.mjs` (live) | minimal |
| Track true net worth | `node networth.mjs` | none/minimal |
| Deep health check | `node health.mjs` | **yes** (sparingly) |
| See market movement | `node snap_markets.mjs` then `node market_diff.mjs` | snap=yes |
| Decide whether to grow the fleet | `node expand.mjs` | advisory |
| Stop the bot gracefully | `touch STOP` (in the bot's dir) | n/a |

> Stopping: `touch STOP` triggers the graceful drain (workers finish their current trip, then exit);
> see [`02 §6`](02-architecture.md). A hard `kill <PID>` is safe too thanks to intent + run-stats
> persistence, but `STOP` avoids stranding in-flight cargo.

---

## `bot-status.json` `ships[].route` field

`writeStatus()` emits one entry per ship under `ships[]`: `{ ship, net, projected, lanes, doing,
route }`. The **`route`** field (string, e.g. `"B6→H51→A4"`, or `null`) is the ship's **full
multihop route** — the planned `from → …hops… → dest` chain, not just the current leg. It is captured
by the bot's `fleetTable()` loop (which already computes `routeStr()` from `plannedRoutes`) into a
shared `fleetRoutes` map and merged into each `ships[]` entry on write. The dashboard's FLEET table
reads it, falling back to the live nav origin→destination leg when `route` is `null` (e.g. right
after a restart, before the route loop has run). Removing the old periodic `📋 FLEET` log table from
the bot did **not** affect this — the loop still runs to keep `fleetRoutes` fresh; it just no longer
logs the table (the dashboard renders the fleet now).
