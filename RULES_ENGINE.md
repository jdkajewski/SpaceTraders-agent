# SpaceTraders Bot — Rules Engine / Conditions

Hard-won invariants. Each is a **condition → action** guard that prevents a failure we actually hit in
production. Treat this as the checklist a *greenfield* bot must satisfy on day one — most of these cost real
credits / downtime to learn. Tags like `[RULE: x]` are mirrored in code comments (bot2.mjs / trade.mjs).

---

## A. Movement & fuel (the #1 source of stranding + crashes)

1. **[RULE: idempotent-nav]** A `navigate` call can race the ship's own arrival.
   - COND: we read `nav.status === IN_TRANSIT` (guard passes), ship arrives, then our POST /navigate fires.
   - FAIL: API 400 `"located at the destination"` → **uncaught → whole bot FATAL-exits.**
   - ACTION: in `navigate()` catch, if message matches `/located at the destination/i` → treat as success
     (`return getShip(sym)`). Never let "already there" throw. (Same guard already exists in `extractOnce`.)

2. **[RULE: refuel-before-leg]** Asteroids / many waypoints sell **no fuel**.
   - COND: ship must traverse a leg longer than its remaining fuel, or end at a fuel-less node.
   - FAIL: ship strands and falls back to DRIFT (~10× slower) or sits dead.
   - ACTION: top the tank *before* departing (`fuelTopUp` at nearest fuel node, or `navigate` auto-refuel at
     start). Anchor commuters on a **fuel-selling** waypoint (e.g. the producer F51), not on the rock.

3. **[RULE: anchor-on-fuel]** A ferry/tender that shuttles to a fuel-less rock must base itself at the fuel+sell
   node and round-trip from there; size the run to the tank (600-fuel freighter covers the ~500 B9 round trip;
   a 300-fuel shuttle does not → it strands).

4. **[RULE: refuel-from-cargo]** Before the return leg out of a fuel-less node, refuel from carried FUEL cargo
   (`POST /refuel {fromCargo:true}`). Keep a FUEL reserve on the tender for this + to top up parked miners.

5. **[RULE: park-once]** Parked hulls burn **0 fuel** (fuel is only spent navigating). A storage/funnel ship
   sent one-way to a rock stays usable indefinitely — just preflight the single inbound leg.

## B. Cargo transfers

6. **[RULE: transfer-argorder]** `transfer(fromSym, toSym, symbol, units)` — **ship symbols first, then good,
   then count.** We shipped `transfer(from, GOOD, units, toShip)` at 3 sites; every call threw instantly
   (`ensureOrbit('COPPER_ORE')` → 404), was swallowed by `try/catch`, and the **entire mining pipeline silently
   did nothing for days** (0 feeds). Lesson: a `catch {}` around a transfer hides arg-order bugs — verify the
   signature, and log at least once when a "normal" transfer keeps failing.

7. **[RULE: co-location]** Transfers require both ships at the **same waypoint** (orbit or docked). Design roles
   so the giver and receiver are co-located (drones + refiner + funnel + tender all at the rock; tender commutes).

## C. Mining colony (park-and-ferry)

8. **[RULE: single-good-refine]** Refining needs **30 units of ONE ore** (→10 metal, ~60–70s cd). A mixed hold
   never accumulates 30 of one type → refiner clogs at capacity and stalls everything behind it.
   - ACTION: keep the refiner's hold **pure** — hold only the current target ore; push everything else out.

9. **[RULE: ore-funnel]** Use a parked cargo hull (NOT a probe — **probes have 0 cargo**) as a shared ore bin:
   drones dump all ore in; refiner pulls single-good 30-batches, refines, pushes finished metal back; tender
   pulls finished goods out. Decouples mining rate from refine rate so drones never idle and the refiner runs
   continuous loops. Bin must be co-located at the rock.

10. **[RULE: rotate-target]** Refiner cycles its target ore (copper→iron→…) so a scarce ore doesn't block a
    plentiful one. Switch early if the funnel already has a full batch of the *other* ore.

11. **[RULE: direct-vs-refine]** Some mined goods are sellable/feedable **directly** (SILICON_CRYSTALS,
    QUARTZ_SAND for F51) — never refine those; route them straight to the ferry. Only `*_ORE` goes through the
    refiner. (At B9 the direct minerals are the real value; copper/iron ore is the low-% bycatch.)

12. **[RULE: survey-before-extract]** Un-surveyed extraction yields random low-value junk. Keep a fresh, rich
    survey (density×size scored) in the shared pool; target extraction against it.

13. **[RULE: colony-skips-recovery]** Mining hulls intentionally HOLD cargo. The generic "salvage orphan cargo"
    recovery must **skip** colony hulls or it yanks them off-station and sells their feed.

## D. Resilience

14. **[RULE: isolate-ship]** One ship's error must never crash the fleet. Wrap each per-ship role dispatch in
    `try/catch` → log, idle, retry next loop.

15. **[RULE: keep-fleet-alive]** Supervise each worker task: if `worker()` rejects, log + restart it after a
    short backoff instead of letting the rejection bubble to `main().catch` and `process.exit` the whole bot.

16. **[RULE: rate-limit-retry]** API client must back off + retry on 429 / network / 5xx (capped). Parse the
    `"<n> seconds"` cooldown out of extract/refine/survey errors and sleep that long.

## E. Trading / contracts / gate (economic guards)

17. **[RULE: contracts-always-on]** Contracts run on a **dedicated** runner, independent of trade-lane
    profitability; never abandon permanently on a sourcing fail. Source the contract good from the **cheapest**
    market (fresh read), deliver partial (the API accumulates `unitsFulfilled`), fulfill only when complete.

18. **[RULE: paginate-active-contract]** The agent holds ONE contract but `getAllContracts` paginates ALL — the
    active one may be on a later page. Page-1-only queries miss it.

19. **[RULE: fresh-price-on-commit]** Re-fetch source+dest prices **at buy-commit** (market read TTL ~10 min is
    stale under concurrency). Abort a lane that's no longer net-positive. Saved us from −100k stale-market buys.

20. **[RULE: absolute-price-cap]** Relative ceilings never *pause* buying when there's a sole supplier. Add an
    absolute per-material cap (`GATE_MAX_PRICE`) so we stop buying a spiking input and wait for it to cool.

21. **[RULE: expansion-saturation]** Don't buy another trader/hull when active ones realize < ~60% of the best
    lane (≥ N samples) — a saturated market makes new hulls park, not earn.

22. **[RULE: net-not-liquid]** Judge profit by **run net (totalNet, persisted across restarts)**, not liquid
    credits — credits sawtooth as ships commit cargo (in-flight `committed` ≠ loss).

## F. Operational

23. One driver at a time on the live agent. `bot-status.json` is stale right after relaunch (only rewritten on a
    completed lane) — trust the live API / log. Kill needs a numeric PID (pgrep first). Launch detached with the
    token from `.tok2`; latest log name in `.current_log`.

---
*Origin: 18a148a9 "Ship lifecycle UI" debugging arc. Verified live 2026-06-11: idempotent-nav stopped the FATAL
loop; transfer-argorder fix produced the first-ever mining ferry (+321 to F51) and funnel-mode unclog.*
