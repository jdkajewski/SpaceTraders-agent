# 04 — Optimizations, Tricks & Hard-Won Lessons

This is the "interesting" document: the non-obvious design choices that make the bot robust,
profitable, and cheap to run. Most of these were paid for with real credits or downtime. Where a fix
maps to a checkpoint in the decision log, it's noted.

---

## 1. The shared token-bucket rate limiter (`st.mjs`)

**What.** Every API call from every worker and manager loop funnels through one module-level token
bucket (`take()`, `st.mjs` L12–36): capacity **2**, refill **2/sec**. `tokens` and `blockedUntil`
are shared globals; `take()` blocks (awaits) until a token is available.

**Why it matters.** ~20 ships hammering the API independently would instantly blow the SpaceTraders
rate limit and get 429-stormed. Because JS is single-threaded and the bucket is a shared global, the
*entire fleet* is throttled to ~2 req/s **without any locks** — the limiter is the one global
coordination point that makes 20-way concurrency safe on a shared budget.

**429-aware + layered retries.** On a 429, it reads `retryAfter` from the error body and sets
`blockedUntil` so *all* callers pause (not just the one that got 429'd). It also retries:
- **Network errors** (fetch rejected — internet down / ECONNRESET / DNS) — capped exponential backoff
  (`min(15s, 500·2^attempt)`), up to 8 tries, then throws a `.network`-tagged error the worker simply
  retries next loop. This is what lets a brief outage *not* abort a trip.
- **5xx / 408** — 4 retries with linear backoff.
- Errors are **structured-tagged** (`.status`, `.code`, `.data`, `.network`) so callers can
  distinguish a 429 (budget) from a 404 (not found) from a network flake.

`[RULE: rate-limit-retry]`. Also: extract/refine/survey cooldown errors carry `"<n> seconds"` — the
mining code parses that and sleeps exactly that long instead of busy-retrying.

---

## 2. Local-file-first monitoring (don't tax the bot's budget)

**The pattern.** The read-only monitors are designed to answer questions from **local files the bot
already writes**, not from the live API — because every API call a monitor makes is a call the bot
*can't* make against the shared ~2 req/s budget.

- `contracts.mjs` parses the **bot2 log files** + `bot-status.json` to reconstruct the full contract
  lifecycle (accept → deliveries → fulfill) with **zero API calls** in its default + watch modes. A
  `--live` flag opts into API enrichment only when explicitly wanted.
- `probe_util.mjs` ranks markets purely by counting log-line mentions — **zero API**.
- `status.mjs` / `mon3.mjs` read `bot-status.json`, `mine-history.jsonl` etc. for the parts the bot
  already records, hitting the API only for the live deltas.
- `market_diff.mjs` diffs two local snapshot files; `snap_markets.mjs` reads the *waypoint list* from
  local `markets.json` before sampling.

**A neat sub-trick** in `contracts.mjs`: a **monotonic-clock hack** detects log day-rollover (a
timestamp jumping backward > 2h) and accumulates +86400s per rollover, so multi-day cycle-duration
math works from logs alone, and restarts don't break it.

**Why it matters.** You can run a live dashboard on a 30s refresh *all day* and never steal throughput
from the bot. This is a deliberate, repo-wide philosophy, not an accident.

---

## 3. Fuel-aware multi-hop routing with refuel hops (`planRoute` → `goTo`)

**The failure it prevents.** A far ship told to go direct would exceed its tank and **DRIFT for hours**
(~10× slower). This was a real outage — a tender DRIFTed ~3 h before the fix.

**How.** `planRoute()` (~L1732–1755) runs **Dijkstra over fuel-stocked waypoints**: nodes =
{origin, dest, all fuel-selling waypoints}; an edge exists only if the hop is ≤ one tank (97% margin)
**and** lands on a fuel node (or the destination). It minimizes total CRUISE time and returns the
ordered hop list (e.g. `J66→I64→I63→F51`). `goTo()` then flies each hop with its own `chooseMode`. If
unreachable even multi-hop, the caller falls back to a single best-effort leg.

**Costing honesty.** `routeCost()` uses the *same* router to estimate fuel+time for lane scoring, so
an outer lane is costed as realistic CRUISE hops — not one giant DRIFT — and can fairly win over a thin
cluster lane. There's no hard distance cap on lanes; viability is decided by route-costed net/min.

**The fuel-cargo variant** (`planRouteFuelCargo`, used by orphan-gate delivery): when carrying FUEL as
cargo you can `refuelFromCargo` at *any* arrival, so *any* waypoint becomes a legal intermediate stop
(not just fuel markets). It just minimizes hop count.

### 3a. Per-leg flight-mode selection — `chooseMode()` (~L214–229)

For each leg, cost out every feasible mode and pick the cheapest by one money objective:

```
cost = fuel × FUEL_PX  +  time × VALUE_OF_TIME
```

- DRIFT burns flat 1 fuel (~free) but is ~10× slower; CRUISE burns `dist`; BURN burns `2×dist` but is
  fastest. A mode needing > 97% of the tank is skipped (3% margin absorbs coordinate/rounding drift).
- **These per-mode coefficients are empirically calibrated at bring-up, not guessed.** Before/early in a
  deployment, `calib.mjs` (see `06-tooling.md`) flies one real leg, captures the *actual* `fuel.consumed`
  and arrival duration from the API, and derives the fuel-per-distance and `time = round(dist × k / speed) + 15`
  constants — which are then baked into `legFuel()`/`chooseMode` (~L200–229). So the cost model reflects
  the real engine instead of hand-picked numbers. (It's a one-time tuning pass, not re-run every boot;
  only `FUEL_PX` below re-samples continuously.)
- **`FUEL_PX` is live**, not hardcoded: the **median** market FUEL price ÷ 100 (1 market FUEL unit =
  100 ship-fuel), re-sampled every market refresh. Median is robust to one pumped market. Because fuel
  is genuinely cheap (~0.7 cr/unit), CRUISE/BURN almost always beat DRIFT — DRIFT only wins when the
  tank literally can't afford the faster modes.
- **`VALUE_OF_TIME`** is a *tuning weight* (BURN aggressiveness), not a real cash cost — which is why a
  gross floor like `MIN_NET=2000` stays conservative even though true cash cost is just fuel.

### 3b. The `navigate` safety ladder (`trade.mjs`)

Even within a single leg, `navigate` is defensive: it tries the requested mode, then **downgrades** on
an insufficient-fuel error (BURN→CRUISE→DRIFT) rather than failing; auto-refuels at the start of a leg;
and is **idempotent** — an "already located at the destination" 400 (the ship raced its own arrival) is
treated as success. `[RULE: idempotent-nav]` — that uncaught 400 used to FATAL-kill the whole bot.

---

## 4. Credit-floor hysteresis (kill the sawtooth) — `gateCreditOk()` (~L457–470)

**The problem.** `GATE_CREDIT_FLOOR` is a hard stop on gate buying. Without a deadband, the moment
credits tick back above the floor the bot buys one batch and instantly falls under again →
buy/pause/buy/pause every cycle (a sawtooth that never accumulates a buffer).

**The fix.** A hysteresis latch: pause at `GATE_CREDIT_FLOOR`, but don't **resume** until credits
recover to `GATE_CREDIT_RESUME` (floor + `GATE_CREDIT_RESUME_GAP`). Between the two thresholds the
previous state holds (the deadband). That lets a real buffer rebuild, then buying runs **aggressively
down toward the floor in a sustained burst**. The gap tunes the burst size. (Checkpoint 13.)

**And it still delivers while paused.** When buying is paused but a ship already holds needed gate
material, it *delivers* it anyway — only *buying* is throttled by the floor, never delivery.

---

## 5. Price-settle patience — `gateBuyAllowed()` (~L927–940)

**The problem.** When a spiked, capped material drops back under its cap, buying the *first* tick is
often not the bottom.

**The fix.** A per-material state machine: ABOVE cap → `paused`. On the drop back under the cap →
`settling`: hold buys for `GATE_PRICE_SETTLE_MS`, tracking the observed low. Resume (`normal`) once the
price **rebounds** more than `GATE_PRICE_REBOUND_EPS` off that low (it bottomed) or the window elapses.
A good that was never above its cap stays `normal` and buys immediately. Monotonic, so concurrent
per-ship calls converge. Buys nearer the bottom.

---

## 6. The absolute price cap for single-producer goods

`[RULE: absolute-price-cap]`. A **relative** ceiling (`cheapest × factor`) can never *pause* buying
when there's a **sole supplier** — there's nothing cheaper to compare against, so the ceiling is always
"satisfied". `FAB_MATS` (only F51) and `ADVANCED_CIRCUITRY` (only D43) are exactly this case. The
**absolute** `GATE_MAX_PRICE` cap is what actually stops the bot overpaying during a spike and waits
for mining/restock to cool it. This is non-obvious and cost real money to learn.

---

## 7. FILL_BIAS tie-banding & gate drop-off weighting

Covered in [`03 §1d`](03-subsystems.md). The trick is *what it doesn't do*: it never detours or runs
the wrong direction to fill the hold. It only re-ranks lanes **already within `FILL_BIAS_EPS` of the
best score**, preferring fuller holds (more zero-detour ride-alongs) and deliveries that drop off at a
gate-material producer (restocking the gate's inputs for free). Profit sacrificed is bounded by the
epsilon band; travel added is zero.

---

## 8. Contract owner-election with re-election margin (anti-latch)

**The problem.** Latching the *first* hull that passes the efficiency gate often picks a far, slow ship
that then slow-walks the fill while a closer idle ship sits unused. But *constantly* re-picking the
closest ship would thrash ownership ("owner churn").

**The fix** (`contractManager` + `electContractOwner`, ~L633–729): centrally elect the idle, empty,
eligible hull **closest to the cheapest source**, but only **switch** owners if a candidate is closer
by more than `CONTRACT_REELECT_MARGIN` (40 dist units) — a hysteresis margin that prevents latch/churn.
And **never** re-elect away from an owner already *carrying* the contract good (it's mid-haul).

---

## 9. Post-travel ownership re-checks (anti double-source)

**The problem.** A ship sets itself owner, then flies a long multi-hop to the source. Meanwhile the
central election may reassign the contract to a closer idle hull. If the traveling ship blindly buys on
arrival, **two ships source the same contract** → wasted cargo + churned source price.

**The fix** (~L854–861): after the (possibly long) sourcing leg, the ship **re-checks ownership**. If
it's still empty and no longer the owner, it bails back to trading and lets the elected owner source.
It never abandons goods already aboard. A symmetric re-check happens *before delivering* (the contract
may have been fulfilled by another ship while this one hauled — deliver-to-closed throws a 400 loop).

---

## 10. Contract negotiation self-heal (adopt stranded offers)

**The problem.** A restart *between* `negotiate` and `accept` strands an offer at `accepted=false`. The
API then refuses a *new* negotiation ("already has an active contract"), so the bot loops forever and
contracts wedge. (This is the contract-stall bug — checkpoints 16–18.)

**The fix** (~L679–688): before negotiating, look for an already-negotiated-but-unaccepted offer and
**adopt it** (accept it). Self-heals the wedge. The manager also intentionally does *not* gate
negotiation on a stale `contractClaim` (its only consumer is disabled), which was a separate stall.

---

## 11. The salvage-guard (protect only still-needed gate materials)

`reconcileHeldCargo()` salvage-sells orphan cargo so a crash doesn't strand capital — **but** it must
not dump:

- the **active contract good** (discovered at startup *before* workers run, so the guard is armed
  before the first reconcile), nor
- **gate materials the gate still needs** — `gateMat` is built from `GATE_PROTECT_MATERIALS` *filtered
  to those with `remaining > 0`*. A ship holding FAB on a restart should **deliver** it to the gate
  (worth ~3800/unit there), not salvage it at ~1700 (a measured −83k mistake). It only protects what's
  *still needed* — once a material is fully supplied, holding it is just dead weight and salvage is fine.
- Colony hulls skip recovery entirely (`[RULE: colony-skips-recovery]`) — they intentionally hold cargo.

---

## 12. `CONTRACT_FORCE` — the banked-`onAccepted` trick

A contract's `onAccepted` payment is banked the instant you accept. So even if the source price spikes
above the `onFulfilled` breakeven, **fulfilling at a small marginal sourcing loss is still net-positive
overall** (onAccepted + onFulfilled − cost > 0) *and* frees the one-contract slot for a better one.
`CONTRACT_FORCE=<GOOD>` bypasses the margin gate (still distance-gated) to do exactly this. Knowing
*which* payment is already banked is the insight that makes a "losing" fulfill the right move.

### 12a. Auto-force — self-healing the dud-contract wedge

The manual `CONTRACT_FORCE` flag still requires a human to *notice* the wedge and restart with the
flag set. The failure mode it guards against is silent and expensive: a **dud** contract (one whose
`onFulfilled` is so low that net < the margin floor for *every* ship — e.g. `LIQUID_HYDROGEN` paying
2,484, or `AMMONIA_ICE` at 4,753) is never claimed, so it occupies the single contract slot until its
deadline — **blocking all new (often 25k–280k) contracts for days**.

`contractManager` now self-heals this: it tracks how long the active contract has been *continuously
unowned* (nobody passed the margin gate). Once that exceeds `CONTRACT_AUTOFORCE_MINS` (default 20),
the contract's id is added to a runtime `contractAutoForced` set and the shared `isForced(ci)` helper
makes the margin gate bypass it — identical mechanics to a manual force, but automatic and keyed on
the **contract id** (not the good), so it clears exactly the wedged contract and nothing else. The
20-minute grace is long enough that a normal contract (claimed within 1–2 cycles) never trips it; the
only real cost is that a *profitable-but-temporarily-unclaimed* contract sourced via auto-force skips
the price-settle buffer and banks slightly less — a rare, small price for never wedging the pipeline.
Emits `⚡ auto-force contract …` to the log when it fires.

---

## 13. Intent persistence for crash safety

Covered in [`02 §5`](02-architecture.md). The subtlety worth re-stating: the intent stores the **cost
basis** (and ride-along extras), so a resumed sell records the **true realized net**, not a corrupted
one. Without it, a crash mid-haul either strands the cargo (lost capital) or, if blindly salvaged,
mis-attributes profit. Combined with `run-stats.json` persistence, this is what makes a crash-restart
loop *not* look like a profit flatline.

---

## 14. Dynamic fleet sizing & speed-matched assignment

- **`fleetMaxSpeed`** is read from the live fleet at startup; far/fat lanes are score-discounted for
  slow ships so the fastest hull wins them on contention (`[D]`). Slow shuttles keep the near cluster.
- **`PARK_MIN_NET`**: a hull only trades if its best lane's *absolute* projected net clears this floor;
  otherwise it **parks** (0 holding cost in SpaceTraders — no upkeep, fuel only burns in transit).
  Uses absolute net, not net/min, so slow-but-fat far lanes are never wrongly parked. Measured
  diminishing returns (246k → 173k → 124k per added active ship) justify parking surplus hulls instead
  of scraping thin lanes. `[RULE: expansion-saturation]`: don't *buy* another hull when active ones
  realize < ~60% of the best lane.
- **Tenders / haulers auto-select** by capability (`pickMineTender`, `mineRoleOf`) so a freshly-bought
  hull slots into a role with no config.

---

## 15. Producer-only sourcing & the FAB supply-chain guard (`GATE_PROTECT`)

Two layers:

- **Gate buys only from EXPORT/EXCHANGE** (producers/neutral), **never IMPORT** (consumers): an IMPORT
  market's `purchasePrice` is a wrong-direction/scarce price (e.g. A4 importing ADV to make ANTIMATTER).
- **Profit trading never touches the gate supply chain**: never trades a gate material, and never
  sources a profit lane *out of* a gate-producer market (F51/D43) — pulling goods out depletes their
  production and drives the gate material's price *up*, working against our own fill. Contracts/mining
  *deliver to* producers (which helps) and are separate paths.

---

## 16. Self-correcting market model (adaptive cooldown + dead-lane penalty)

The cooldown EMA (`03 §1f`) is self-correcting: leaning into a thick good depletes it → its margin
drops below its EMA → cooldown re-extends automatically. The dead-lane penalty escalates with a
`deadStreak` so a price-moved lane is abandoned harder each time it disappoints. Together they let the
fleet *find equilibrium* across many goods rather than dogpiling and crashing one.

---

## 17. Fail-safe gate status (never collapse the goal on an outage)

`[A]` (computeExpansionTarget + targetWatch): the original code initialized `gateBuilt=true` and
swallowed fetch errors, so an outage made the construction fetch throw → the goal collapsed to ~1.1M →
a *phantom* "EXPANSION-READY" stopped the bot. The fix: **default UNBUILT**, remember the last *known*
status, never let an UNKNOWN status collapse the goal or authorize a stop (`gateStatusKnown` gate).
Also: the bot keeps trading + feeding even when the credit goal is met, as long as the gate is unbuilt
— because building the gate *is* the expansion.

---

## 18. Catalogue of bugs already paid for (don't relearn)

From `RULES_ENGINE.md` and the checkpoint log:

- **`transfer(fromSym, toSym, symbol, units)`** — wrong arg order (we shipped `transfer(from, GOOD,
  units, to)` at 3 sites) throws instantly and, swallowed by `catch {}`, **silently no-ops the entire
  mining pipeline for days** (0 feeds). Verify transfer signatures; log when a "normal" transfer keeps
  failing. `[RULE: transfer-argorder]`.
- **Transfers require co-location** — both ships at the same waypoint. Roles are designed so giver and
  receiver are co-located. `[RULE: co-location]`.
- **Single-good refine** — refining needs 30 of *one* ore; a mixed hold never accumulates 30 → the
  refiner clogs. Keep the refiner's hold pure; rotate the target. `[RULE: single-good-refine]`,
  `[RULE: rotate-target]`. (Moot here — no refinery — but kept for greenfield.)
- **Minimize restarts** — in-memory counters reset every boot; a crash loop looked like a flatline
  until `run-stats.json` persistence. Restarts also strand cargo without intent persistence.
- **`MINERAL_PROCESSOR` ≠ refinery** — only `MODULE_ORE_REFINERY` enables `refine()`. No amount of
  config fixes a missing module.

---

## Checkpoint history (the abridged "why" timeline)

| # | Title |
|---|---|
| 1 | Diagnosing bot flatline, implementing A–F fixes |
| 2 | Live fuel pricing and dynamic fleet |
| 3 | Crash-safe intent recovery |
| 4 | Opportunistic gate-supply |
| 5 | Dedicated gate-hauler + fill-then-haul |
| 6 | Multi-good loadouts + gate mechanics analysis |
| 7 | Gate fixes + fill/drop-off bias |
| 8 | Phase layer + INPUT_FEED build |
| 9 | Disabling INPUT_FEED after loss |
| 10 | Mining fuel fix + independent contract runner |
| 11 | Aggressive gate build + tooling |
| 12 | Contract deadlock fix + orphan cargo rule |
| 13 | Gate buy-pause (hysteresis) + contract election fixes |
| 14 | Diagnosing market/gate bottlenecks |
| 15 | Factory-feed + gate-push start |
| 16 | Expansion prep + contract-wedge fix |
| 17 | Contract negotiation stall fix |
| 18 | Fixing contract negotiation stall |
