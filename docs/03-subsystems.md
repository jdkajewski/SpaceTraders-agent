# 03 — Subsystems

This document covers each subsystem in depth: the trading engine, gate supply, the mining colony,
the contract pipeline, input-feed, and orphan-gate-cargo delivery. For *why* the clever bits exist,
cross-reference [`04-optimizations-and-tricks.md`](04-optimizations-and-tricks.md).

---

## 1. The trading engine (the profit loop)

### 1a. Building lanes — `buildLanes()` (~L301–324)

A **lane** is "buy good cheap at source → sell dearer at a co-reachable market". Each cycle, for
every good, the bot finds the buy/sell pair with the best **gross** profit, subject to:

- `s.sellPrice > b.purchasePrice` and `b.purchasePrice > 0` (real positive margin).
- `dist ≤ MAXD` (a soft system-wide bound; true viability is decided later by net/min, not this cap).
- `units = min(buy.tradeVolume, sell.tradeVolume, 20)` — one trade-volume lot keeps the buy off the
  slippage curve.
- `gross = margin × units ≥ MIN_NET` (the master throttle floor; below it, no lane).
- **FAB GUARD** (`GATE_PROTECT`): never builds a lane for a gate material itself, and never sources a
  lane *out of* a gate-material producer market (pulling goods out of F51/D43 depletes their
  production and drives the gate material's price up — working against our own gate fill).

### 1b. `MIN_NET` is the master throttle

`MIN_NET` (default **2000** in prod) is the single most important trading knob:

- **Lower it** → more ships active on thinner-but-still-positive lanes (good when many park).
- **Raise it** → fewer, fatter lanes, preserving margin.

It was tuned to 2000 after measuring the live lane distribution: ≥2000 unlocked ~20 lanes ≈ fleet
size; below that, only thin long-haul lanes remain. It's safe to be aggressive because the
`OPERATING_RESERVE` / `GATE_CREDIT_FLOOR` guards protect capital — but watch for **slippage**:
net/hour settles downward as fat lanes get traded down. *That's equilibrium, not a failure.*

### 1c. Claiming a lane — `claimLane()` (~L547–595)

For each candidate lane the bot computes **true round-trip net per minute**, route-costed with the
fuel-aware multi-hop router (`routeCost`):

```
fuelCr = routeCost(here → buyWp).fuelCr + routeCost(buyWp → sellWp).fuelCr
timeS  = those two times + 30
net    = lane.gross − fuelCr
score  = net / (timeS / 60)            // net per minute, full round-trip-aware
```

- Lanes whose travel ate the margin (`net ≤ 0`) are dropped.
- **Speed-matched assignment** (`[D]`): a *far* lane's score is discounted for *slow* ships
  (`score × shipSpeed / fleetMaxSpeed`) so the fast frigate wins far/fat lanes on contention while
  slow shuttles keep working the near cluster. Near lanes (`dist ≤ SPEED_FAR_DIST`) are unaffected.
- The lane is locked + cash committed **atomically** (no await between check and set).
- If the best lane's *absolute* projected net is below `PARK_MIN_NET`, the ship **parks** (0 cost)
  instead of scraping a thin lane.

### 1d. FILL_BIAS — detour-free tie-banding

Among lanes within `FILL_BIAS_EPS` (10%) of the top score, re-rank by a **bias** that prefers lanes
which (a) fill more of the hold via zero-detour ride-alongs (`fillFrac`) and (b) drop off at a
gate-material producer (`GATE_DROPOFF_WEIGHT`), so the delivery restocks the gate's inputs while the
gate is unbuilt. **No profit is sacrificed beyond the epsilon band, and no extra travel is added** —
it's pure re-ranking of already-profitable, already-on-route lanes.

### 1e. Multi-good ride-alongs — `planRideAlongs()` (~L329–359)

After buying the primary good, fill the rest of the hold with **other** goods that are sold at the
*same* source **and** sink profitably at the *same* destination — extra profit at **zero detour, zero
extra fuel**. Each ride-along is **one tradeVolume lot** (buying more would slip the price), greedy by
per-lot gross, bounded by free cargo and cash budget, filtered by `RIDEALONG_MIN_GROSS` (ignore dust;
the trip is already paid for by the primary). Adds ~39% gross on qualifying lanes. Ride-alongs are
recorded in the haul intent's `extras` so they replay correctly on a crash-resume.

`planRideAlongs()` is also reused by the **contract** path (see §4g) so contract hauls don't fly with
a half-empty hold. It is hardened by `GATE_PROTECT`: it never sources a ride-along **out of** a
gate-material producer market (F51/D43) and never rides a gate material itself — pulling goods out of
a producer would drive the gate material's price up and fight our own gate fill.

### 1f. Adaptive per-good cooldown — `cooldownFor()` (~L251–286)

After a good trades it rests, but the rest length is **symmetric and adaptive**, keyed off an EMA of
the good's *typical* margin:

- `current > typical` (thick/recovered) → **shorter** cooldown (down to `COOLDOWN_MIN_MULT` = 0.33×) →
  trade it more, capitalize.
- `current < typical` (thin/depleted) → **longer** cooldown (up to `COOLDOWN_MAX_MULT` = 4×) → let it
  recover.

It's self-correcting: leaning into a thick good depletes it → margin drops below typical → cooldown
re-extends. Plus a **dead-lane penalty** (`[C]`): a lane that bought 0 units or returned net ≤ 0 gets
a much longer rest that *escalates on repeats* (`deadStreak`), so ships stop re-picking a
depleted/price-moved lane and spread to live ones.

### 1g. Fresh-price-on-commit

`[RULE: fresh-price-on-commit]` — the buy uses a generous cap (`buy × 1.18`) and the lane execution
re-reads live prices; if nothing is bought (price moved past the cap / good depleted), the ship
**aborts the lane rather than sailing empty to the sink**, and the dead-lane penalty kicks in. This
guard saved the bot from −100k stale-market buys.

---

## 2. Gate supply (the win condition)

While the gate is unbuilt and `GATE_SUPPLY=1`, ships buy gate materials from **producers** and
deliver them to the construction site `I63`. Two ways a ship feeds the gate:

1. **Dedicated `GATE_HAULERS`** — pinned to gate supply, excluded from the trade pool while the gate
   is unbuilt (they bypass the concurrency cap). Guarantees the gate gets fed without taxing trade.
2. **Opportunistic divert-on-idle** — any trade hull with no profitable lane / parked diverts to a
   gate-supply trip (throttled by `GATE_MAX_SUPPLIERS`).

### 2a. `planGateFill()` (~L942–980) — the cheapest basket

Greedily fills free cargo with the cheapest units of still-needed materials across **all** source
markets, subject to:

- **Producers only:** EXPORT (makes the good) or EXCHANGE (neutral) markets. **Never IMPORT** markets
  — those are *consumers* (e.g. A4 imports ADVANCED_CIRCUITRY to make ANTIMATTER); their purchasePrice
  is a wrong-direction/scarce price.
- **Relative ceiling:** skip sources pricier than `cheapest × GATE_PRICE_CEIL_FACTOR`.
- **Absolute cap + price patience:** `gateBuyAllowed()` enforces `GATE_MAX_PRICE` per material with
  the settle/rebound state machine (see [`04`](04-optimizations-and-tricks.md)).
- Each buy is capped by the source's `tradeVolume` and the cash headroom (`credits − GATE_CREDIT_FLOOR`,
  with `SLIPPAGE_FACTOR` applied).
- Units are **reserved in `gateClaims`** so other idle/hauler ships pick different work.

### 2b. `gateSupplyTrip()` (~L982–1073) — the trip

- **Credit-floor hysteresis (`gateCreditOk`)**: if buying is paused, but the ship is *already holding*
  still-needed gate material (bought before the pause), it **delivers** it anyway — supplying is free,
  advances the gate, and frees the hauler. Only *buying* is throttled, never delivery.
- **Concurrency cap**: opportunistic hulls limited to `GATE_MAX_SUPPLIERS` simultaneous trips (heavy
  simultaneous pulling spikes the producer price — live: D43 ADV 3,958 → 9,549 once 8 hulls piled on).
  Dedicated haulers bypass it.
- Buys are grouped by waypoint (visit each source once), then the basket is hauled to the gate via
  `goTo` (fuel-aware), the ship **docks** (construction/supply requires DOCKED), and each material is
  POSTed to `construction/supply`. `gateCache.remaining` / `built` are patched immediately on success.
- On a mid-trip failure, materials stay aboard and `reconcileHeldCargo` salvages them next loop
  (recovering the cash; the 30s server snapshot re-plans).

### 2c. Driving a producer's price down

A producer's EXPORT price falls when its **supply** rises, which happens when it **produces more**,
which needs its **imports** stocked. So feeding a producer the inputs it imports → more output →
lower gate-material price. That's the rationale for the **input-feed** subsystem (§5) — only
worthwhile for inputs you can supply *profitably*.

### 2d. Fuel-cargo bridging — `GATE_FUEL_CARGO` (default OFF)

A gate hauler usually buys a `tradeVolume`-capped material batch (e.g. 43 of an 80-slot hold), so the
hold is half-empty on every run. When the leg to the gate (or back) can't be flown on a single tank,
the normal router **detours through a fuel market** (an extra hop). With `GATE_FUEL_CARGO=1`, the
hauler instead loads **FUEL into those idle slots** at the source and flies the more-direct
**fuel-cargo route** (`planRouteFuelCargo` → `haulWithFuelCargo`), topping the tank **from cargo**
before each dry leg (`refuelFromCargo`).

Guards (so it never hurts): **material has priority** — only slots left *after* the material buy are
used; it only diverts when the fuel-cargo route has **fewer hops** than the tank-only route; it only
loads fuel if the **source sells FUEL**; and it carries just enough (route deficit ÷ 100, +1 per hop
for refuel rounding), capped by free slots — if the slots can't cover the deficit it falls back to the
normal detour. Fuel quantity math: 1 FUEL cargo unit ≈ 100 tank units.

> **Mostly inert in X1-PP30**, where nearly every waypoint (including the gate I63) sells fuel, so the
> tank-only route never detours and every gate leg fits one tank. Its real payoff is **far/sparse
> sources** and **seeding a new system** after the gate opens (long jumps, scarce fuel).

---

## 3. The mining colony (park-and-ferry)

Enabled by `MINE_FEED=1`. **Its primary purpose is to drive down the cost of gate materials, not to
turn a profit.** By mining F51's feed minerals (IRON, COPPER, SILICON, QUARTZ) it keeps F51 well-fed,
which holds its `FAB_MATS` export price low — and FAB is where most of the gate spend goes, so cheaper
FAB buys move the gate far more than the mining cash itself does. It *is* a mildly positive lane on its
own (unusable COPPER/IRON ore is sold raw at H59 for cash), but treat that profit as a bonus on top of
the cost-suppression goal. Roles are **auto-detected by capability** (`mineRoleOf`, ~L1453–1465)
so freshly-bought hulls slot in with no config. While the gate is unbuilt, mining-capable hulls are
pinned to their role and excluded from trading.

| Role | Detection | Job |
|---|---|---|
| `REFINER` | `MINING_LASER` + `ORE_REFINERY` module | Park at the rock, refine 30 ore → 10 metal, hold metal. **(Currently impossible — see below.)** |
| `SURVEYOR` | `SURVEYOR` mount | Park at `B9`, keep a **rich shared survey** so drones target value goods. |
| `DRONE` | `MINING_LASER` only | Park at `B9`, extract, dump all ore to the funnel/refiner. |
| `FUNNEL` | `MINE_FUNNEL=<ship>` | A parked cargo hull = shared **ore bin** (drones dump in, refiner/tender pull out). |
| `TRANSPORT` | `MINE_TRANSPORT=<ships>` (or auto via `pickMineTender`) | Ferry feed goods to F51; carry spare FUEL for the colony. |

### 3a. CRITICAL REALITY: we cannot refine in X1-PP30

No ship has a `MODULE_ORE_REFINERY` (the `MINERAL_PROCESSOR` module does **not** enable `refine()`),
and no shipyard in-system sells one. So **COPPER_ORE / IRON_ORE can never become refined COPPER /
IRON here.** Consequently:

- **`SILICON_CRYSTALS` + `QUARTZ_SAND`** → ferried directly to **F51** (direct FAB inputs; the only
  gate-relevant mining we can do; also a small profit). `[RULE: direct-vs-refine]`.
- **`COPPER_ORE` + `IRON_ORE`** → sold raw at **H59** for cash (the relief valve), never refined.
- The "refiner" role is effectively retired; ship 1 (laser + surveyor) runs as the **SURVEYOR**. The
  refiner code path remains for a future greenfield system that *does* have a refinery.

### 3b. The funnel/relief-valve mechanics

- **Ore funnel** `[RULE: ore-funnel]`: a parked cargo hull (NOT a probe — probes have 0 cargo) is the
  shared bin. It decouples mining rate from processing rate so drones never idle.
- **Survey before extract** `[RULE: survey-before-extract]`: un-surveyed extraction yields random
  junk. The surveyor keeps a fresh survey scored by **density × size** (`bestSurveyFor`) in a
  *shared in-process pool* so a surveyor can survey while drones extract.
- **Relief valve / no clog**: raw ore that nothing consumes used to jam the funnel. Now tenders haul
  excess raw ore (above `MINE_ORE_RESERVE`, when the funnel passes `MINE_CLOG_AT`) out to its best
  market (H59) and sell it — profit + anti-clog. With no refiner, prod config sets
  `MINE_ORE_RESERVE=0` / `MINE_CLOG_AT=0` → all ore flows to H59.
- **Junk** (ICE_WATER, ALUMINUM_ORE, …) outside `MINE_KEEP` is **jettisoned** to keep mining.

### 3c. Fuel discipline (the colony's #1 hazard)

B9 sells **no fuel**, so a naive ferry can DRIFT for hours. The guards:

- **Tenders anchor on F51** (`[RULE: anchor-on-fuel]`) — it sells fuel *and* is the delivery point; a
  600-tank freighter covers the ~500 round trip. Sized so a 300-fuel shuttle is never assigned (it'd
  strand).
- Tenders use **`goTo`** (fuel-aware, hops via fuel stations) — never a giant DRIFT.
- **`refuelFromCargo`** before the return leg out of the fuel-less rock (`[RULE: refuel-from-cargo]`),
  and tenders carry `MINE_FUEL_RESERVE` FUEL units to **top up parked miners** that run low.
- **Fuel preflight**: a mining trip is only taken if the round trip fits the tank; otherwise top up at
  the nearest fuel node first, or bail.

> **Honest ROI**: B9 is distant and low-value; mining is *marginal*. Its real value is keeping FAB
> cheap and monetizing ore — not direct profit.

---

## 4. The contract pipeline (always-on, opportunistic, gated)

The agent holds **one contract at a time**. The pipeline: negotiate → accept → elect owner → source →
haul → deliver (partial) → fulfill. It runs **independent of trade-lane profitability** — a thin
market must never starve contracts.

### 4a. `contractManager()` (~L666–731) — the manager loop (every 20s)

- `getAllContracts()` **paginates all** pages — the active contract may be on a later page;
  page-1-only queries miss it (`[RULE: paginate-active-contract]`).
- **Self-heal**: if there's an already-negotiated-but-**unaccepted** offer (a restart stranded it
  `accepted=false`), it **adopts** it by accepting — otherwise the API refuses a new negotiation
  ("already has an active contract") and contracts wedge forever. This was the contract-stall bug.
- Otherwise, whenever no freighter is mid-delivery, it **negotiates** the next contract via the
  pinned `NEGOTIATOR` ship and accepts it.
- **Best-ship election** (`electContractOwner`): instead of latching the first hull that passes the
  gate (often a far, slow ship), it centrally picks the **idle, empty, eligible hull closest to the
  cheapest source**, and only switches owners if a candidate is closer by more than
  `CONTRACT_REELECT_MARGIN` — and **never** yanks an owner already *carrying* the contract good.

### 4b. The efficiency gate — `contractWorthIt()` (~L798–812)

A ship only sources a contract if, *from where it stands*:

- the cheapest source is within `CONTRACT_MAX_SRC_DIST` (don't fly across the system), **and**
- `onFulfilled payout − source cost − est. fuel ≥ max(CONTRACT_MIN_MARGIN, CONTRACT_MIN_MARGIN_PCT ×
  payout)` (a buffer scaled to contract size, so we don't pounce at bare breakeven).

### 4c. Marginal economics — why a contract "stuck at 0/N" is usually correct

The margin gate uses **`onFulfilled`** (the part still *owed*), NOT the total — because `onAccepted`
is already banked. So a contract can sit at "0/N" simply because its source price spiked above the
`onFulfilled / units` breakeven. **That's correct waiting, not a bug** — it auto-claims when the
source cools. Diagnose a "stuck" contract by comparing *source price × units vs onFulfilled*, and
report it as "waiting, X% from breakeven", not "stuck".

### 4d. `CONTRACT_FORCE` / auto-force — the escape hatch

`CONTRACT_FORCE=<GOOD>` bypasses the *margin* gate (still distance-gated) to fulfill an
already-accepted contract at a small marginal sourcing loss — worth it because `onAccepted` is banked
(so the contract is net-positive overall) and it frees the one-contract slot. Used to clear a
contract whose source spiked.

**Auto-force (`CONTRACT_AUTOFORCE_MINS`, default 20):** because the manual flag needs a human to spot
the wedge and restart, `contractManager` also clears duds on its own. It tracks how long the active
contract has been **continuously unowned** (no ship passed the margin gate); once that exceeds the
grace window it adds the contract's id to a runtime `contractAutoForced` set, and the shared
`isForced(ci)` helper bypasses the margin gate for *that contract only*. This prevents a low-payout
contract (e.g. `LIQUID_HYDROGEN` @ 2,484) from blocking the single slot — and all the lucrative
contracts behind it — until its deadline. Logs `⚡ auto-force contract …` when triggered. Set to `0`
to disable and rely solely on manual `CONTRACT_FORCE`.

### 4e. FAB guard for contract sourcing

`CONTRACT_AVOID_GATE_PRODUCER` (`cheapestContractSrc`): if the contract good is a gate material *or*
an input a gate producer imports, sourcing it *out of* the producer would deplete its supply / spike
the gate material's price. So sourcing **skips the gate-producer markets** and walks down to the
next-cheapest source — falling back to the producer only if nothing else sells it (better to overpay
once than forfeit the contract).

### 4f. `contractRunnerTrip()` (~L819–900) — execution with re-checks

Sources from the cheapest market (fresh read), hauls, delivers **partial** (the API accumulates
`unitsFulfilled` across visits), fulfills when complete. Two crucial post-travel re-checks:

- **After the sourcing leg**: re-check ownership — the central election may have reassigned the
  contract to a closer idle hull while this ship traveled; if so and still empty, **don't double-buy**.
- **Before delivering**: re-validate the contract is still open — another ship may have fulfilled it
  while this one hauled; if closed, release ownership and hold the cargo for salvage rather than
  looping on a 400.

### 4g. Contract ride-alongs — fill the spare hold (`CONTRACT_RIDEALONG`, on by default)

A contract usually needs **fewer units than the hull holds** — e.g. 18 `EQUIPMENT` in a cap-80
freighter leaves 62 empty slots. Because the trip (source → contract destination) is *already paid
for by the contract payout*, that spare hold can carry profitable cargo for free. After sourcing the
contract good, `contractRunnerTrip()` calls the same `planRideAlongs()` used by trade lanes —
treating the contract source as the buy waypoint and the contract destination as the sink — buys the
qualifying goods, hauls them on the same legs, and **sells them at the contract destination** (their
shared sink) before delivering the contract. The ride-along net is recorded separately from the
contract (whose payout is booked as credits, not lane net).

- **Reserved cash** is `commit()`-ed during the haul and released after the sell (same concurrency
  discipline as trade lanes), so concurrent ships don't oversubscribe credits.
- **No over-buy, no dedup salvage**: each ride-along good is capped to **one tradeVolume lot the
  destination actually buys** (`sellPrice > 0`), bounded by remaining free hold and cash, and
  **de-duplicated against everything already aboard** (an `excludeSyms` set passed to
  `planRideAlongs`) plus a running free-space counter. So a ride-along can never exceed what fits,
  what we can afford, or what the sink can absorb — and never stacks onto held cargo — which means
  there's nothing left over to salvage.
- **`GATE_PROTECT`-safe**: inherits the producer/gate-material exclusions from `planRideAlongs()`.
- **Crash-safe with no extra bookkeeping**: ride-along goods aren't the contract good, so a restart
  mid-haul lets `reconcileHeldCargo()` salvage-sell them at the best sink (the contract good itself
  stays protected and the contract path re-adopts it). Set `CONTRACT_RIDEALONG=0` to keep contract
  hauls single-purpose.

> **Why the gate haulers and mining ferries do *not* take ride-alongs.** Both are structurally
> single-purpose, not an oversight:
> - **Gate haulers** (`GATE_HAULERS`) source *from* F51/D43 — the protected gate producers — so
>   `GATE_PROTECT` forbids buying anything else there. Their "multi-order" efficiency instead comes
>   from **fill-then-haul baskets** (§2a): one trip buys a cheapest-first basket across *all* still-needed
>   gate materials, amortizing the long gate leg.
> - **Mining ferries** (`MINE_TRANSPORT`) source at the asteroid (B9), which **has no market to buy
>   from**, and return carrying mined feed goods. There is nothing to ride along with. Their batching
>   win is the **ore funnel** (§3b), which decouples mine-rate from ferry-rate.


---

## 5. Input-feed (Phase 4 accelerator — currently disabled)

`INPUT_FEED` actively restocks the **long-pole** gate material's producer by hauling its **imported
inputs** to it. It's profit-*positive* on its own (buy an input cheap at its source, sell into the
producer's IMPORT market) **and** raises the producer's output while pushing the gate material's
price down — accelerating the gate without a subsidy.

- **Scarcity-first** (`planInputFeed`): feeds the producer's *scarcest* inputs first (those throttle
  output the most), tie-broken by per-lot gross — so it doesn't dump everything into the single
  highest-margin input (COPPER) and starve IRON/QUARTZ/SILICON.
- **Never feeds at a loss** (margin > 0 required) and always respects `OPERATING_RESERVE`.
- **Guardrails after a real loss**: `INPUT_FEED_MAX` is hard-capped at **2**, and **only 1 feeder per
  producer** (`inputActiveProducers`) — because the prior loss came from 4 concurrent feeders piling
  onto one producer and crashing its import buy-price below our cost mid-flight. These two caps make a
  self-inflicted price crash structurally impossible.
- **Status: `INPUT_FEED=0` in production** — it lost money and was disabled (checkpoint 9). The code
  remains behind the guardrails for future use.

---

## 6. Orphan gate cargo delivery — `deliverOrphanGateCargo()` (~L1974–2039)

**The problem**: a *non-hauler* trade hull can end up holding gate materials (a restart preserved
in-flight gate cargo via the salvage-guard, or a fill-bias top-up), but no role routes a non-hauler's
gate cargo to the gate — and gate materials are protected from salvage. So the hull strands with a
full, unsellable hold.

**The fix**: route the stranded gate cargo to the gate by the **cheapest feasible means**, in priority
order:

1. **SELF** — fuel-aware multi-hop on the tank alone (`planRoute`); refuels at fuel-market nodes en
   route. Cheapest.
2. **SELF + FUEL CARGO** — if SELF is infeasible, carry FUEL in spare slots to bridge a dry leg the
   tank can't span (`planRouteFuelCargo` + `haulWithFuelCargo`, refuel-from-cargo at any arrival).
3. **TRANSFER** — if a gate hauler sits co-located right now, hand the cargo off (zero travel for us;
   the hauler is already routed to the gate).
4. **STAGE HOP** — can't reach the gate or a hauler now → stage one fuel-node hop closer and retry
   next loop (to meet a hauler / open a route).

If truly boxed in (no route, no hauler, no staging hop), it **holds position** — it never
salvage-sells protected gate cargo at a loss. Gated by `ORPHAN_GATE_DELIVERY` and `ORPHAN_MIN_UNITS`
(a full hold always triggers, since it can't trade anyway).

## 7. Ship repair — `maybeRepair()` / `repairAt()` (default OFF, `REPAIR=1`)

Ships have two independent health axes:

- **`condition`** (0..1) — *performance wear*. Drags engine speed and raises fuel burn. **Fully restored by
  repair.** This is the common, creeping problem (a hard-worked hull sits at 54–62% within days).
- **`integrity`** (0..1) — *structural life*. **Not restored** by routine repair beyond a point; at **0 the hull
  is destroyed.** Decays much more slowly than condition.

Repair (`POST /my/ships/{s}/repair`, must be **DOCKED at a SHIPYARD**; `GET` returns a quote) restores condition.
The system's shipyards (A2 / C40 / H60 in X1-PP30) are discovered + cached for 10 min by `getShipyards()`.

**Two tiers, both run inside the ship's OWN worker loop** (so repair never races an external manager for control of
a hull):

1. **Opportunistic** — when a ship is *already* sitting at a shipyard and `minCondition < REPAIR_COND_MIN` (default
   0.85), top it up. Zero detour — it only fires when the stop is free.
2. **Forced** — if `minIntegrity < REPAIR_INTEG_FORCE` (default 0.5), **divert** to the nearest shipyard and repair,
   so we never lose a hull mid-route. (Integrity decays slowly, so this rarely fires — condition wear is the usual
   trigger and it's handled opportunistically.)

**Budget discipline:** a repair only spends `growthBudget()` (free cash above the operating reserve — never the
reserve), uses `commit`/`uncommit` so concurrent buys don't oversubscribe, and is **capped per repair by
`REPAIR_MAX_COST`** (default 100k). A quote over the cap, or over the available budget, is skipped/deferred.

> `minCondition` / `minIntegrity` take the **min across frame/reactor/engine** — the worst component decides, since
> that's what's actually dragging the ship.

## 8. Minor mining-colony expansion — `mineExpandManager()` (default OFF, `MINE_EXPAND=1`)

A slow, hard-capped manager loop that **grows the park-and-ferry mining colony** by buying ships in-system. Its
purpose is the same as the colony's: keep F51 fed so **FAB_MATS stays cheap and the gate completes** — fresher
surveys and more extraction directly serve that, and it's a modest profit lane besides.

**When it considers a buy** (all must hold):

- `MINE_EXPAND=1`, **and**
- `MINE_FEED` on **and the gate is still unbuilt** (`gateCache.exists && !gateCache.built`) — once the gate
  completes, expansion stops entirely.

**What it buys** (priority, one hull per scan, scan every `MINE_EXPAND_SCAN_MS` ≈ 10 min):

1. **Surveyors first** — if `count(survey-mount hulls) < MINE_MAX_SURVEYORS` (default **3**) → `SHIP_SURVEYOR`
   (~$34k @ H60). Fresh, rich surveys make every drone's extraction more valuable.
2. **Then drones** — else if `count(mining-laser, non-survey hulls) < MINE_MAX_DRONES` (default **4**) →
   `SHIP_MINING_DRONE` (~$45k @ H60). More raw throughput when extraction is the bottleneck.
3. Both caps met → buys nothing.

> Caps are **targets, not increments** — they count *existing* hulls. With 2 surveyors + 2 drones today, the
> defaults allow at most **+1 surveyor and +2 drones**, then it stops.

**Affordability gates** (both must pass): price ≤ `growthBudget()`, **and** `credits − price ≥
MINE_EXPAND_CREDIT_FLOOR` (default 600k). It never touches the operating reserve and never drops below the floor.

**After a buy:** the new hull is handed its own supervised worker via `launchWorker()`. `mineRoleOf()` is
**capability-based**, so the fresh ship auto-slots into SURVEYOR / DRONE with zero extra config, and its role loop
drives it to the asteroid — there is no separate ferry step (which would race the role loop for control).

> **"If needed" = the four gates working together** (gate-unbuilt · budget floor · caps · one-per-scan). There is no
> blind buy-to-cap-now: it tops up slowly, only while affordable and the gate is unbuilt, and you can watch each buy
> in the log before the next scan.

## 8b. Colony migration on rock depletion — `mineMigrateManager()` (default OFF, `MINE_MIGRATE=1`)

Asteroids get **mined out**. Depletion is reported by the waypoint's `modifiers` (NOT its `traits`): a rock first
gains `CRITICAL_LIMIT` (nearly out, yields falling), then `STRIPPED` (exhausted — extractions return almost
nothing on a long cooldown). Before this manager, `mineSite` was memoized **once** and `loadAsteroids()` only
checked `traits` for `STRIPPED`, so the colony would happily extract a dead rock at near-zero yield forever.

**What it does** (scan every `MINE_MIGRATE_SCAN_MS`, default 5 min, only while `MINE_FEED` on and the gate is
unbuilt): fetch the active colony rock's `modifiers`. If `STRIPPED` (always) or `CRITICAL_LIMIT` (only when a
healthy alternative rock with the **same deposit** exists), it relocates the colony:

- adds the rock to `depletedSites` (excluded from every future asteroid pick),
- drops that rock's stale surveys from the shared pool,
- clears `mineSite` + the asteroid cache so the next pick is fresh and modifier-aware.

The colony role loops (refiner / drones / surveyor / funnel) and the solo mine-feed haulers re-pick the nearest
non-depleted rock on their **next cycle** and relocate there automatically — no explicit ferry. If a rock is
`STRIPPED` but it's the **only** one of its deposit type, the colony stays put (reduced yield beats no rock).

**In-transit redirect.** A ship already `IN_TRANSIT` (including a slow DRIFT) toward the old rock **cannot be turned
mid-flight** — SpaceTraders rejects a new `navigate` while in transit and has no cancel. So the redirect happens the
instant it **arrives** at the now-dead rock: every colony trip routes through `goToColonySite()`, which sees the
hull sitting on a `depletedSites` rock, logs `🪐 <ship> redirect <old>→<new> (rock mined out)`, and sends it
straight to the new site instead of mining. `loadAsteroids()` also now reads `modifiers` (skips `STRIPPED`) and
honours `depletedSites`, and `nearestAsteroid()` skips depleted rocks.

## 9. Universal fuel-cargo & range-aware contracts — `goToWithFuelCargo()` / `haulGoTo()` (default OFF, `FUEL_CARGO=1`)

§2d introduced fuel-as-cargo for **gate** haulers. `FUEL_CARGO=1` generalizes that to **every** haul and uses the
same idea to stop rejecting reachable contracts.

### 9a. Fuel in the spare slots, on any haul
A hauler rarely fills its hold (a `tradeVolume`-capped buy is often half the capacity). When a leg can't be flown on
one tank, the tank-only router **detours through a fuel market** (an extra hop). `haulGoTo()` (used by the trade
delivery leg and the contract source/deliver legs) instead calls `goToWithFuelCargo()`: top the tank at the source,
load **FUEL into the slots left after the goods**, and fly the more-direct fuel-cargo route (`planRouteFuelCargo` →
`haulWithFuelCargo`, topping the tank from cargo before each dry leg).

It only triggers when it **saves a hop** vs the tank route and the source sells FUEL — so on a fuel-dense lane it is
inert, but on a **long leg with a small tank** it removes a refuel stop (e.g. a cap-300 shuttle on a 900+ unit hop:
4 fuel-cargo hops vs 5 tank-only).

### 9b. Goods always outrank carried fuel (`shedSpareFuel`)
Fuel is the lowest-priority cargo. `goToWithFuelCargo(dest, { reserveUnits })` keeps `reserveUnits` slots free for
goods that will be bought at/after the destination, so fuel never crowds out cargo. And before sourcing goods after a
fuel-cargo arrival, `shedSpareFuel()` reclaims the slots: **burn the carried fuel into the tank** (`refuelFromCargo`),
then **sell** it if the market buys FUEL, else **jettison** the remainder. Net effect: carried fuel is used or shed
the moment a profitable good needs the slot.

### 9c. Range-aware contract gate (`contractSrcReachable`)
The contract eligibility gate used a flat straight-line cap (`CONTRACT_MAX_SRC_DIST=500`) as a stand-in for range —
so a ship 600–900 out was hard-rejected even when fuel-aware routing could reach the source. With `FUEL_CARGO` on,
`contractSrcReachable()` accepts a far source when a refuel-aware route reaches it within `CONTRACT_MAX_HOPS` (`6`):
first the tank multi-hop route (`planRoute`), else the fuel-in-cargo route (`planRouteFuelCargo`). The net-margin gate
is then **costed on the real route** (`routeCost` for both legs, not the straight line), so only far runs that are
genuinely profitable are claimed — and the hop cap still prevents chasing a contract across the system.

### 9d. Universal `goTo` DRIFT-avoidance + fuel-less-origin loading
The two pieces above are wired into specific trade/contract call sites via `haulGoTo()`. To cover **everything else**
— mining tenders, surveyors, freshly-bought colony hulls (`MINE_EXPAND`), any role that calls `goTo` directly —
`goTo()` itself now falls back to `goToWithFuelCargo()` (when `FUEL_CARGO` is on) the moment its tank-only route is
infeasible (`planRoute` returns `null`, i.e. the next leg would be a multi-hour DRIFT). DRIFT remains, but only as a
genuine last resort. This makes the fuel-aware/multi-hop behavior **universal across all expansions and transport**.

`goToWithFuelCargo()` also no longer requires the **origin** to sell fuel: if the current waypoint is fuel-less (e.g. a
shipyard), it hops to the nearest fuel market **within one tank** first (`loadWp`), tops tank + cargo there, then
bridges the dry leg. A `goTo(loadWp)` hop is always ≤ one tank, so there is no recursion.

> **Hard limit (by design):** fuel-in-cargo can only bridge a leg that is itself ≤ one tank — carried fuel just refills
> the tank between hops. If the destination is islanded **>1 tank from every other waypoint** (true of most asteroids
> in X1-PP30, e.g. `B9` is 84+ from its nearest neighbour and 198 from fuel), no fuel logic can avoid the DRIFT, and a
> **zero-cargo surveyor** can't carry bridging fuel at all. Reaching such a rock is a **one-time** DRIFT bring-up cost;
> the hull then parks at the rock and big-tank transports do the hauling, so it is a sunk cost, not a recurring drain.

> **All of §9 is behind `FUEL_CARGO` (default OFF)** and independent of `GATE_FUEL_CARGO`. Enabling is a
> deliberate restart decision; like the gate version it is largely inert in a compact fuel-everywhere system and pays
> off most on far sources, small-tank long hauls, and seeding a new system after the gate opens.
