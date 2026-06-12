# 02 — Architecture & Process Model

## 1. The process model

`bot2.mjs` is **a single long-running Node process** (`node bot2.mjs`). There is no cluster, no
worker threads, no external scheduler. Concurrency is pure `async`/`await` cooperative
multitasking on one event loop. Three things run concurrently inside `main()` (~L2344–2375):

```
main()
 ├── supervise(worker(ship))   × ~20   one async loop per cargo ship
 ├── contractManager()                 negotiates/accepts/elects the active contract
 ├── targetWatch()                     refreshes credits/reserve/goal/phase + gate status (every 30s)
 ├── fleetTable()                      logs a human-readable fleet table (every FLEET_TABLE_MS)
 └── stopWatch()                       polls for the STOP file → sets stop=true
```

All of these are launched together and awaited with `Promise.all`. The only external coordination
is the **shared ~2 req/s rate limiter** in `st.mjs` (see
[`04-optimizations-and-tricks.md`](04-optimizations-and-tricks.md) and
[`06-tooling.md`](06-tooling.md)) — every API call from every worker funnels through one token
bucket, so the whole fleet never exceeds the budget regardless of how many ships are active.

### Why "continuous workers" (the v1 → v2 upgrade)

The legacy `bot.mjs` (v1) used a **fleet-wide barrier**: build lanes, assign all ships, run a cycle,
*wait for the slowest ship*, then a global rest. That meant a fast frigate (speed 36) was held back
by a slow shuttle, and every ship dogpiled the single best lane.

`bot2.mjs` replaces that with **continuous per-ship workers**: the instant a ship finishes a lane it
claims the next-best *available* one and goes again. Two mechanisms make this work:

- **Per-good cooldown** instead of a global rest: after a good is traded, it "rests"
  (`cooldownUntil`) so its price pool recovers *and* ships naturally spread across many goods
  (including lower-margin ones) instead of all chasing the single best lane.
- **Per-leg flight mode**: each leg independently picks CRUISE/BURN/DRIFT from the ship's real engine
  speed + fuel headroom + value-of-time.

## 2. Shared in-memory state

Workers coordinate through module-level state (no DB; the live driver is stateless across restarts
except for the two persisted JSON files). The important shared structures:

| State | Purpose |
|---|---|
| `marketCache` (`{at,data}`) | Shared market snapshot, refreshed at most every `MARKET_TTL_MS` (75s). One refresher promise (`refreshing`) dedupes concurrent refreshes. |
| `goodState` (`Map sym → {lockedBy, cooldownUntil, deadStreak}`) | Per-good lock + cooldown so two ships can't claim the same good and depleted lanes are penalized. |
| `cachedCredits`, `committed` | Concurrency-safe budget: `committed` tracks in-flight buy cost so concurrent ships don't oversubscribe cash. |
| `gateCache` (`{exists,wp,built,remaining,known}`) | Live construction-site snapshot (refreshed every 30s by `targetWatch`); patched immediately on a successful supply. |
| `gateClaims` (`Map sym → units`) | In-memory per-material reservations so concurrently-idle ships split remaining materials instead of all hauling the same one. |
| `gateActiveSuppliers` / `inputActiveFeeders` / `inputActiveProducers` / `mineActive` | Concurrency caps + per-producer reservations for gate/feed/mining trips. |
| `activeContractInfo`, `contractOwner`, `contractWorkingId` | The single-contract pipeline state (one owner at a time). |
| `mineSurveys`, `refinerSym`, `funnelSym`, `colonyShips` | Mining-colony coordination (shared survey pool, role registration, co-located fuel tending). |
| `perShip` (`{net, lanes, last, projected}`) | Per-ship accounting + "what it's doing now", written into `bot-status.json`. |
| `totalNet`, `lanesRun` | Lifetime realized profit + lane count (persisted). |
| `plannedRoutes` | Last planned multi-hop route per ship, for the fleet table's route column. |

### The two persisted files (crash safety)

| File | Written | Read | Why |
|---|---|---|---|
| `run-stats.json` | on every `record()` (`persistRunStats`) | on boot | Lifetime `totalNet`/`lanesRun` survive restarts so a crash loop isn't a phantom flatline. |
| `intents.json` | at the buy→sell transition (`saveIntent`), cleared on sell/abort | on boot | Per-ship haul **intent** (good, units, buyWp, sellWp, cost basis, ride-along extras) so a crash mid-haul can resume the exact sell leg instead of stranding cargo. |

## 3. The worker loop — ordered decision steps

This is the heart of the bot. Each `worker(shipSym)` loops while `!stop` and runs these steps **in
order**, taking the first that applies and `continue`-ing (`bot2.mjs` ~L2041–2241). The ordering
encodes the priority of the dual goal:

```
0.  STOP check (STOP file) → break
    fetch ship + shared markets

1.  reconcileHeldCargo()         ─ unless this is a colony hull
       resume a persisted HAULING intent (with cost basis), else salvage-sell orphan cargo
       (NEVER salvages still-needed gate materials or the active contract good)

2.  isGateHauler?                ─ pinned to gate supply while gate unbuilt
       gateSupplyTrip(); else PARK ($0)

3.  isInputFeeder + inputFeedActive?
       inputFeedTrip(); else PARK

4.  MINE_FEED + mining role (auto-detected REFINER/DRONE/SURVEYOR/FUNNEL/TRANSPORT)?
       run the role trip (isolated in try/catch — one miner's error never crashes the fleet)

4b. legacy solo MINE_FEEDER override (testing only)

5.  deliverOrphanGateCargo()     ─ a trade hull holding gate materials self-delivers to the gate
       (SELF route → SELF+fuel-cargo → TRANSFER to co-located hauler → stage one hop closer)

6.  CONTRACTS: contractRunnerTrip()
       if eligible (CONTRACT_RUNNER, else cargo ≥ 40) and worth sourcing from here → own + chip away

6b. deliver-what-you-hold: already carrying the active contract good → route to dest + fulfill

7.  TRADE: buildLanes() → claimLane()
       atomically lock the best AFFORDABLE lane (net/min, route-costed, fill-bias tie-break)
       → goTo(buyWp) → buy → ride-along fill → saveIntent → goTo(sellWp) → sell → record()
       if no lane / parked:
           inputFeedTrip()  → gateSupplyTrip()  → PARK ($0)
```

Key properties of this ordering:

- **Recovery first.** Before any new work, a ship reconciles cargo a crash/STOP left mid-haul. This
  is skipped for colony hulls (which intentionally hold cargo) — `[RULE: colony-skips-recovery]`.
- **Dedicated roles short-circuit.** A `GATE_HAULER` / `INPUT_FEEDER` / mining-role hull is *pinned*
  and never falls through to trading while the gate is unbuilt. When the gate is built (or the role
  is disabled), it rejoins the trade pool.
- **Trade is the default; gate/feed are the idle fallback.** A normal trade hull only diverts to
  input-feed or gate-supply when it has *no profitable lane* or is parked under `PARK_MIN_NET`. This
  is the "trade-first, feed-the-gate-on-idle" principle that lets the two goals coexist.

## 4. Lane claiming is atomic

`claimLane()` (~L547–595) is written so there is **no `await` between checking and setting** a
lane's lock and the cash commit. It synchronously: scores every lane on true net/min (route-costed,
fuel-aware, multi-hop), applies the fill-bias tie-break, then locks the good (`lockedBy`) and
`commit()`s the estimated cost. Because JS is single-threaded and there's no await in the
check-then-set, two concurrent workers can't claim the same good or oversubscribe cash.

## 5. Crash-safe intent recovery

The full flow (the failure mode it closes: a power outage mid-haul stranding cargo and corrupting
net):

1. The instant a ship holds bought cargo, `saveIntent()` writes
   `{phase:'HAULING', good, units, buyWp, sellWp, costBasis, extras:[ride-alongs]}` to `intents.json`.
2. On the sell, `clearIntent()` removes it.
3. On boot (or any loop where a ship unexpectedly holds cargo), `reconcileHeldCargo()`:
   - If held cargo matches a saved `HAULING` intent → **resume the sell leg** at `sellWp` using the
     saved cost basis (prorated if partial), replaying ride-alongs at the shared sink, and `record()`
     the true net.
   - Else → **salvage-sell** orphan cargo at its best sink (`bestSink`), so capital isn't stranded.
   - **Never** salvages the active contract good (discovered at startup, see below) or still-needed
     gate materials (those should be *delivered*, not dumped at a loss).

The active contract is discovered in `main()` **before** workers start (~L2356–2359), specifically so
the first `reconcileHeldCargo` doesn't salvage-sell contract goods before `contractManager`'s first
(rate-limited, slow) cycle populates `activeContractInfo`.

## 6. Resilience: keeping the fleet alive

- **`[RULE: isolate-ship]`** — every per-ship role dispatch and the lane execution are wrapped in
  `try/catch`: one ship's error logs, idles, and retries next loop. It never propagates.
- **`[RULE: keep-fleet-alive]`** — each worker is wrapped in `supervise()` (~L2369): if `worker()`
  rejects, it logs and **restarts that worker after a 5s backoff** rather than letting the rejection
  bubble to `main().catch` and `process.exit` the whole bot.
- **`navigate` is idempotent + self-downgrading** (in `trade.mjs`): an "already at destination" 400 is
  treated as success (it used to FATAL-kill the bot); an "insufficient fuel" error downgrades the
  flight mode (BURN→CRUISE→DRIFT) rather than failing.
- **The API client retries** 429 (honoring `retryAfter`), network errors (capped exponential backoff,
  8 retries), and 5xx/408 (4 retries) — see [`06-tooling.md`](06-tooling.md).

## 7. STOP / drain / restart procedure

The bot supports a **graceful drain**:

- Creating a `STOP` file in the bot's files dir latches `stop = true` globally (via `stopWatch` and a
  per-worker check at the top of the loop). Workers finish their current action and exit; `main()`
  logs the final run net.
- **Operational gotchas** (from `[RULE]` 23 and the runbook):
  - **Do NOT** create a `STOP` file and quickly delete it to "no-op" — the flag latches globally and
    drains every worker. To restart, **kill the PID and relaunch fresh.**
  - Kill needs a **numeric PID** (`pgrep -f "node bot2.mjs"` first) — never `pkill`/`killall`.
  - **Only one driver at a time** on the live agent.
  - `bot-status.json` is **stale right after relaunch** (only rewritten on a completed lane) — trust
    the live API / log until the first lane closes.

## 8. Outputs

Everything is written into the bot's files directory:

- `bot-status.json` — live snapshot (phase, runNet, in-flight projected, goal + breakdown, credits,
  reserve, gate state, input-feed/mine-feed config, per-ship rows). Rewritten on each completed lane
  (throttled to ≥4s).
- `run-stats.json`, `intents.json` — the persisted crash-safety files (§2).
- `market-history.jsonl`, `trade-observations.jsonl`, `mine-history.jsonl` — append-only time-series
  (price/supply per good, per-lane realized vs projected, every extract/refine/feed) destined for an
  ML model / DB in v2.
- `tracker.md` — a human-readable markdown status block (note: this file grows huge; **do not open it
  in full** — tail it).
- `.current_log` — the name of the active log file (so the tools/tail can find it).
