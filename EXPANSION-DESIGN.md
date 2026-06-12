# SpaceTraders v2 — Expansion & Bootstrap Design

Encodes the agent-growth pattern (validated from SPACEJAM-DK-2's real history) as
reusable logic for BOTH (a) a newly created agent and (b) new-world (system) expansion.

## Real economics (X1-PP30 shipyards, live)
| Hull | Cost | Cargo | Speed | Fuel | Role |
|---|---:|---:|---:|---:|---|
| SHIP_PROBE | 26.7k–43k | 0 | 9 | 0 | scout / live market feed (no fuel cost) |
| SHIP_LIGHT_SHUTTLE | 105.5k | ~40 | 15 | 300 | early cargo / contract fulfillment |
| SHIP_LIGHT_HAULER | 314k | ~80 | 15 | 600 | throughput engine |
| (start) COMMAND_FRIGATE | given | ~40 | 36 | 400 | swiss-army: mine/trade/explore, only combat hull |

## Core insight: two ROI curves
- **Information ROI (probes):** earns 0 directly but unlocks a repeatable lane (~15–25k each). At 26.7k a probe pays back in ~1–2 enabled lanes → highest early ROI. Dominates early.
- **Throughput ROI (cargo):** payback = `ship_cost / net_per_hour_in_role`, BUT only realized while lanes are unsaturated. Dominates mid-game; collapses at the lane ceiling.

## The cell-based franchise model
A **cell** = one system's trade operation: probes (intel) + cargo ships (throughput) +
optional local contract pipeline + a hub waypoint. Each cell runs the same state machine.
Fresh-agent home and new-world cells are the SAME machine, different initial conditions.

### Per-cell state machine
1. **SCOUT** — gain market visibility. Commander charts + buy/seed probes at key markets
   (prioritize high-traffic EXCHANGE hubs + waypoints on contract routes). Probes are
   fuel-free, so they bounce/park cheaply.
   - Exit when ≥ N core markets visible (enough to identify ≥ K profitable lanes).
2. **CONTRACT-FUND** — *capital-poor cells only.* Run contracts with commander + first
   shuttle to build a war chest (guaranteed demand at known price = de-risked first cargo).
   - Skip entirely if the cell arrives funded (expansion case).
   - Exit when cash ≥ hauler threshold OR free-market net/hr > contract net/hr.
3. **TRADE-SCALE** — buy cargo ships by ROI payback (cheapest-payback first: shuttle → hauler),
   saturating local lanes. Continuous scheduler (bot2 model) runs all hulls.
   - Exit when lanes saturate: marginal next-hull payback > MAX_PAYBACK threshold.
4. **STEADY / EXPORT** — maintain throughput; route SURPLUS capital OUT (to the global
   allocator) rather than buying more local hulls that only deepen diminishing returns.

### Global capital allocator (the one rule that reproduces the whole history)
Each surplus credit goes to the option with the highest **marginal credits/hour per credit invested**:
- **Deepen** a cell — buy another local hull (value falls as lanes saturate).
- **Widen** — seed a new cell in a neighbor system (value rises once home lanes saturate).
- **Infrastructure** — build the jump gate (1600 FAB_MATS + 400 ADVANCED_CIRCUITRY) to unlock widening.
This automatically shifts spend from local haulers → expansion exactly when in-system returns diminish.

## Capital-aware, NOT a fixed sequence
- Fresh agent (scarce capital): SCOUT + CONTRACT-FUND tightly interleaved on the commander,
  probes bought as soon as affordable, then shuttles, then haulers. (= the user's real path.)
- Expansion (funded): jump in 1 scout (+1 hauler if affordable), SCOUT first (always — you
  arrive blind), then jump straight to TRADE-SCALE; contracts optional.

## New-world (cross-system) specifics
- **Always SCOUT before committing haulers** — you arrive with zero intel.
- **Seed with probes via the gate** (fuel-free travel) to build the price map cheaply, THEN
  commit a hauler once a profitable local lane (or cross-system spread) is proven.
- **Verify the new system sells FUEL** before stationing fuel-burning hulls (probes exempt).
- **Gate jumps consume antimatter** (bought at market) — budget it; no warp drive needed.
- **Shipyard gaps:** the new system may not sell the hull you want → buy at home, jump it over
  (add jump cost to that hull's ROI).
- **Cross-system arbitrage:** gate-connected systems may have inter-system lanes (buy A → carry
  through gate → sell B) fatter than intra-system; reserve for high-margin goods (gate runs are slow/costly).
- **Each cell self-sustains** then exports surplus; the mother system funds a new cell until it does.

## Gate-as-prerequisite (widening is BLOCKED until the gate is built)
Expansion to a neighbor system requires a built jump gate. If the gate is under
construction, **building/funding it is itself a phase** between local saturation and widening:

- New per-cell state inserted: `… → TRADE-SCALE → **BUILD-GATE** (if gate incomplete) → EXPAND`.
- `BUILD-GATE` triggers when local lanes saturate AND the system's jump gate has remaining
  construction materials (here I63: 1600 FAB_MATS + 400 ADVANCED_CIRCUITRY).
- Funding it = a **dedicated trade objective**: source each material at its cheapest market,
  haul to the gate's construction site, `POST …/construction/supply`. Treat it like a giant
  multi-trip contract. Use spare freighter capacity once normal lanes are saturated so it
  doesn't cannibalize positive-ROI trading.
- The capital allocator weighs **gate-build cost vs expected value of the unlocked system(s)**:
  only pour into the gate when `expected_new_cell_net/hr × horizon − gate_cost > marginal local deepen`.
- Edge cases: a material may have shallow/expensive markets (severe slippage on 1600 units) →
  spread purchases across cycles / multiple source markets, and let exports restock between trips.
- Scout the gate's destinations FIRST (probes are free to send once the gate opens) so we know a
  target system is worth the build before finishing it.

## Operating budget (MUST-HAVE before expansion)
The trade loop must never spend itself broke. Maintain:
- **OPERATING_RESERVE** — a sacred cash floor (e.g. 200k); working/cargo buys may only use funds above it.
- **Concurrency commitment** — with N ships buying at once, track `committed` (sum of in-flight buy
  cost) so combined spend can't exceed cash. Each ship reserves its est. buy cost on claim, releases on completion. (Prevents insufficient-funds API errors when many ships buy simultaneously.)
- **growthBudget = credits − reserve − committed** — the ONLY pool expansion (ships, gate materials)
  may draw from, so capital projects never starve day-to-day trading.
- Contracts get priority access (cheap buys, big payout) but still flow through the same accounting.
- Persist reserve/committed/growthBudget to the DB + status so the UI and allocator can see headroom.

## Dedicated gate-supply hauler(s) (don't cannibalize the trade fleet)
The gate site is far (I63 ≈ 490–540 from the cluster). Supplying 2000 units = ~25 hauler-loads ≈
**~11–12 hours of hauling for one ship**. Diverting a laned hauler forfeits its trade throughput
(~250–375k/hr) → ~3–4.5M of foregone profit, vs a hauler costing ~314k. So:
- **Buy dedicated hauler(s)** for the gate supply instead of pulling laned ships off routes.
  Rule: buy when `opportunity_cost(divert) > hauler_price`. Usually buy 2–3 to parallelize toward ~4h.
- **Use the fast frigate (spd36) for the far legs** — BURN to I63 ≈ 3min vs ~14min for a spd15 hull (4–5×).
- Dedicated haulers become permanent assets afterward (join lanes, or seed the new system cell).
- Fund them strictly from `growthBudget`, never from the operating reserve.

### Materials accumulation = dedicated ships are also the "warehouse"
SpaceTraders has NO storage/bank/warehouse mechanic — goods live ONLY in ship cargo. So the dedicated
gate ships own the full materials lifecycle, keeping the trade fleet untouched:
1. **Accumulate gradually (buy the dip):** track each material's baseline price from market-history; buy
   small lots (≈ tradeVolume) only when current price ≤ baseline × threshold, across many cycles, letting
   the EXPORT source restock between buys. Avoids the slippage/self-inflation of one big purchase.
2. **Store in the dedicated ships** (mobile warehouse) — locks in low-price inventory near the gate.
3. **Draw down to supply** the construction site from the stockpile, parallelized (frigate for far legs).
4. **Never touch the laned trade fleet** for any of this; stop trading the material goods speculatively
   once accumulation begins (prevents inflating the gate cost / the dynamic goal).
- Constraint: cargo caps mean you can't pre-buy all 2000 units (≈25 loads) — accumulate a partial buffer +
  top up from source during the supply burst. Log accumulation (price paid vs baseline) to DB for ML.

### Shared/global construction — poll it, others may build it
The jump-gate construction site is GLOBAL: other agents can supply it too. So the bot must treat the
gate as an external, changing resource — not something only it controls:
- **Poll `/construction` on an interval** (already in the goal computation). As other agents contribute,
  remaining materials drop → our `gateMaterials` cost drops → dynamic goal falls automatically.
- **If the gate completes externally**, `gateBuilt` flips true → goal collapses to `reserve + seedNewCell`
  and we get the gate FOR FREE (skip the ~6.4M build) → expansion-ready immediately. Surface this in logs/UI.
- **If we're mid-accumulation when it completes externally**, SELL the surplus gate materials we were
  holding (no longer needed) and reclaim that capital.
- **Strategy hedge:** don't dump everything into building the gate the instant we can afford it if external
  progress suggests it'll complete soon anyway — weigh "build it now" vs "wait, others may finish it" using
  the observed external fill-rate. Persist gate fill-rate as a time-series so this can be learned.

## Dynamic goal = cost-to-expand (not a magic number)
The bot's "goal" must not be a hard-coded credit target. It is the **live-computed cost to expand**,
recomputed on an interval and stored as a time-series in the DB:

```
goal = operating_reserve
     + gate_build_cost           (Σ remaining materials × cheapest price × slippage)   [if gate unbuilt]
     + gate_hauler_cost          (dedicated haulers to supply it)                       [if gate unbuilt]
     + seed_new_cell_cost        (probes + first hauler + antimatter for the new system)
```

- The goal **moves on its own**: as the gate is supplied, gate_build_cost shrinks → goal drops; once the
  gate is built it recomputes to `reserve + seed_new_cell` only.
- The bot grinds until `credits ≥ goal` — i.e. it has enough surplus *above working capital* to fund the
  whole expansion, then flips to EXPANSION-READY.
- Persist `{timestamp, credits, goal, breakdown{reserve, gateMaterials, gateHaulers, seedNewCell, gateBuilt}}`
  to the DB each interval → UI progress bar + ML can learn better cost estimates (real slippage, real seed cost).
- Tunables (env now, DB-config in v2): slippage factor, seed cost, hauler price; or pin a fixed target to override.
- Reference impl: bot2.mjs `computeExpansionTarget()` (e.g. current goal 7,355,235 = 544,800 reserve +
  5,267,400 gate materials + 943,035 gate haulers + 600,000 seed).

## Data-driven tuning (no hard-coded recovery/throttle constants)
Cooldown, profit floor, value-of-time, slippage, reserve — none should be magic numbers. Keep history
and LEARN them per good/market from observed data:
- **market price/supply time-series** (per good, per waypoint, sampled each refresh) → measure each good's
  **recovery curve**: how fast purchase/sell price returns toward baseline after a trade. Set that good's
  cooldown from its measured recovery time (fast-recovering goods → short cooldown; slow → long), instead of one flat COOLDOWN_MS.
- **trade observations** (each executed lane: buy/sell px, margin, units, realized net, mode) → learn the
  real per-good margin decay vs trade frequency → dynamic per-good profit floor (idle a good once its margin
  drops below its recovering baseline).
- Same for VALUE_OF_TIME (from realized net/hr), slippage (from observed price moves per unit bought),
  reserve sizing (from observed fuel burn + cargo float).
- Prototype now writes `market-history.jsonl` + `trade-observations.jsonl`; v2 must persist these as DB
  time-series tables and have the allocator read learned parameters (with safe defaults as cold-start fallback).
- **Lesson:** a duplicated execution block once made every lane trade TWICE — v2 must guarantee idempotent,
  single-execution lanes (the double-trade both wasted capital and accelerated depletion).
- **Watch:** trading a good that is ALSO a gate-build material inflates the gate cost (self-inflation). Once
  BUILD-GATE is near, reserve/exclude gate-material goods from speculative trading.

## ML data to capture (this is why the new DB exists)
Log every growth/gate decision + outcome so the thresholds become learnable, not hand-tuned:
- ship purchases: type, cost, system, the phase/state at purchase, realized net/hr afterward → true payback.
- gate supply: material, units, buy price (+slippage), trip fuel/time, cumulative cost-to-build, completion timestamp.
- per-cell economics over time: visibility, # lanes, saturation, net/hr, idle ratio.
- expansion events: when widened, cost to seed the new cell, time-to-self-sustaining, cross-system lane margins.
- Goal: train models to predict payback / best next capital action / which destination system to widen into.
- `payback_hours(hull) = cost / expected_net_per_hour(role, current_open_lanes)`
- buy hull when `payback_hours < BUY_THRESHOLD` (e.g. < 2h) AND an unassigned profitable lane exists.
- `contract_exit = free_market_net_per_hr > contract_net_per_hr`
- `lane_saturation = (# profitable lanes ≤ # idle-capable hulls)` for M consecutive cycles.
- `expand_signal = local marginal hull payback > remote cell expected payback` → fund new cell.
- Record per-cell, per-hull, per-lane economics so ML can later tune all thresholds.

## Critique of the original organic pattern (summary)
- ✅ Cheapest-capital-first ladder is correct under capital constraint.
- ➕ Elevate probes to a first-class *information* investment (highest early ROI), bought alongside early contracts, not strictly after.
- ➕ Replace the fixed sequence with a capital+intel-gated state machine (so expansion can skip the contract grind).
- ➕ Add explicit transition signals (contract→trade, deepen→widen) instead of intuition.
- ➕ Add the lane-ceiling caveat: stop buying local haulers when payback collapses; redirect capital to a new cell.
- ➕ Generalize to a cell-based franchise so fresh-agent and new-world reuse identical logic.
