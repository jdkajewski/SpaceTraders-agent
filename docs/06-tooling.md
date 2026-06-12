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

### `status.mjs` — point-in-time snapshot
Reads `bot-status.json` (+ other local artifacts) for fleet, phase, credits, gate progress, totals.
Local-first; minimal/no API.

### `mon3.mjs` — live dashboard
Rolling dashboard view (refreshing) built mostly from local files plus small live deltas. The
day-to-day "is the bot healthy?" screen.

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

### `probe_util.mjs` — market-utility ranker
Ranks markets/waypoints by how often they appear in the logs (a cheap proxy for usefulness) — **zero
API**, pure log analysis.

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
| See contract progress | `node contracts.mjs` (add `--watch`) | none |
| Glance at overall status | `node status.mjs` / `node mon3.mjs` | minimal |
| Track true net worth | `node networth.mjs` | none/minimal |
| Deep health check | `node health.mjs` | **yes** (sparingly) |
| See market movement | `node snap_markets.mjs` then `node market_diff.mjs` | snap=yes |
| Decide whether to grow the fleet | `node expand.mjs` | advisory |
| Stop the bot gracefully | `touch STOP` (in the bot's dir) | n/a |

> Stopping: `touch STOP` triggers the graceful drain (workers finish their current trip, then exit);
> see [`02 §6`](02-architecture.md). A hard `kill <PID>` is safe too thanks to intent + run-stats
> persistence, but `STOP` avoids stranding in-flight cargo.
