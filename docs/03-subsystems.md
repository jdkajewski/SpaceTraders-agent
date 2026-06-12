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
