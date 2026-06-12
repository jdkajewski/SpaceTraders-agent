# 01 — Overall Strategy & Economic Phases

## 1. The dual goal

`bot2.mjs` pursues **two goals at once**, and the design keeps them from fighting each other:

1. **Build the system jump gate** (the *win condition*). The gate at `X1-PP30-I63` is a
   construction site that needs three materials delivered: **`FAB_MATS`**,
   **`ADVANCED_CIRCUITRY`**, and **`QUANTUM_STABILIZERS`**. Completing it *is* the expansion.
2. **Maximize trading profit** and keep growing net worth (credits + fleet + cargo).

Trading is the *engine* that funds gate buys and ship purchases; the gate is the *destination*.
Because profitable lanes almost always exist, the bot can run the gate supply "opportunistically"
(on idle hulls) without ever stalling the profit loop — see [`03-subsystems.md`](03-subsystems.md).

### The real profit metric: `runNet`, not credits

The single most important operating principle:

> **Judge health by `runNet` (a.k.a. `totalNet`) — cumulative *realized* lane profit — not by
> liquid credits.**

Liquid credits **sawtooth**: when a ship buys cargo, credits drop; when it sells, they jump back
up plus the margin. A momentary credit dip is in-flight inventory (`committed`), **not a loss**.
`runNet` is persisted in `run-stats.json` and reloaded on boot (`bot2.mjs` ~L367–370) so a
crash-restart loop doesn't read as a profit flatline. This `[RULE: net-not-liquid]` was learned the
hard way (an overnight crash loop *looked* like a flatline because in-memory counters reset every
boot).

## 2. The system map (X1-PP30)

| Waypoint | Role |
|---|---|
| `I63` | **Jump gate** — the construction site we supply (the win condition). |
| `F51` | **`FAB_MATS` producer** (EXPORT). Imports IRON, COPPER, SILICON_CRYSTALS, QUARTZ_SAND. Sells FUEL — so it doubles as the mining colony's fuel anchor + delivery point. |
| `D43` | **`ADVANCED_CIRCUITRY` producer** (EXPORT). Imports ALUMINUM, MACHINERY, ELECTRONICS, MICROPROCESSORS. |
| `B9` | **Mining asteroid** (~250 from F51). Silicon/quartz-rich, copper/iron-poor. **Sells no fuel.** |
| `H59` | Buys raw COPPER_ORE / IRON_ORE — where the colony dumps unrefinable ore for cash. |
| `A4` | Example contract delivery destination (imports many goods). ⚠️ Contract goods/destinations **rotate** per negotiated contract — e.g. the live contract delivers `LIQUID_HYDROGEN → G55` sourced at C40. A4 is illustrative, not fixed. |

`FAB_MATS` and `ADVANCED_CIRCUITRY` each have a **single producer** in-system. That single-producer
fact drives several design choices (see the absolute price cap in §5 and
[`04-optimizations-and-tricks.md`](04-optimizations-and-tricks.md)).

## 3. The phase state machine

The strategy is modeled as an explicit, **observable** state machine. The active phase is *derived*
from live state every ~30s by `determinePhase()` (`bot2.mjs` ~L472–481) — it is never a hard switch
a human flips. The phase **labels** the run and **drives the gate/fill levers** (via
`gateSupplyActive()`), so the reported phase and actual behavior can never diverge. Critically, the
phase **does not change lane ranking** — the proven trade loop runs in every phase.

```
BOOTSTRAP ──► PROFIT ──► GATE_DISCOVERY ──► GATE_SUPPLY ──► (INPUT_FEED) ──► PORTAL_OPEN
   │            │             │                  │              │               │
 map +       grow fleet,   gate site found,  producer-only   overlap: feed   gate built →
 starter     run best      awareness only    gate feed,      producer        seed the next
 contracts   net/min lanes (supply off)      capped + bias   inputs          system cell
```

| Phase | `n` | Trigger (derived) | Behavior |
|---|---|---|---|
| `BOOTSTRAP` | 0 | markets unknown **or** fleet `< BOOTSTRAP_FLEET_MIN` (2) | Map markets, run starter contracts. |
| `PROFIT` | 1 | default once bootstrapped | Grow fleet, run best net/min lanes (multi-route + ride-alongs). |
| `GATE_DISCOVERY` | 2 | gate found + known + unbuilt, but `GATE_SUPPLY` off | Awareness only — supply disabled. |
| `GATE_SUPPLY` | 3 | `gateSupplyActive()` true | Producer-only gate feed, capped + fill/drop-off bias. |
| `INPUT_FEED` | 4 | as GATE_SUPPLY **and** `INPUT_FEED=1` | Overlap: also feed the producer's inputs to restock the long pole. |
| `PORTAL_OPEN` | 5 | gate known + exists + built | Gate complete → seed the next system cell. |

The phase is logged on every transition (`🧭 phase X → Y`) and surfaced in `bot-status.json`, so the
run is self-documenting.

## 4. The dynamic "cost-to-expand" budget (the goal number)

Rather than a magic credit target, the bot computes the **actual cost to expand** each cycle
(`computeExpansionTarget`, `bot2.mjs` ~L482–524). With `CREDIT_TARGET` unset (the default,
`DYNAMIC_TARGET=true`):

```
expansionTarget = OPERATING_RESERVE                       // near-term working capital
                + gateCost                                // remaining gate materials × cheapest src × SLIPPAGE_FACTOR
                + haulerCost                              // dedicated storage/supply ships (ships ARE the warehouse)
                + NEW_CELL_SEED                           // ~2 probes + 1 hauler + antimatter to seed a new system
```

- **`gateCost`** is recomputed from the live construction site's *remaining* materials and the
  *current* cheapest source price (so as the gate fills or prices fall — possibly because *another
  agent* contributed to the shared site — the goal drops).
- **`haulerCost`** exists because SpaceTraders has **no off-ship storage** — ships *are* the
  warehouse. Dedicated hulls that accumulate-the-dip and supply the gate are a mandatory expansion
  cost (`nHaul` is clamped to 1–3).
- The breakdown is published in `bot-status.json.goalBreakdown` for observability.

### Operating reserve & goods cushion

`OPERATING_RESERVE` (`recomputeReserve`, ~L406–412) is recomputed from the *live fleet* each cycle:

```
OPERATING_RESERVE = (sum of every hull's fuel capacity × live FUEL_PX)   // one full fleet refuel
                  + GOODS_CUSHION                                         // working capital for next cargo buys
```

Working buys may only consume cash **above** `OPERATING_RESERVE` (`availableForWork()` /
`growthBudget()`, ~L397–398). This is the **primary bankruptcy guard** — trading can never spend the
fleet into being unable to refuel.

## 5. Credit floors, reserves & "prefer-low" gate discipline

There are **two** distinct capital floors, layered:

1. **`OPERATING_RESERVE`** — the absolute floor *all* working buys respect (trading, input-feed).
2. **`GATE_CREDIT_FLOOR`** — a *higher* floor that **gate buying** respects. Because gate supply pays
   $0 (it's pure expenditure), it's gated separately so it can never eat the trading capital that
   *generates* the credits. With **hysteresis**: once credits dip below the floor, gate buying
   pauses and won't resume until credits rebuild to `GATE_CREDIT_RESUME` (floor + gap) — preventing a
   buy/pause/buy sawtooth (see [`04`](04-optimizations-and-tricks.md)).

The bot only wants to buy gate materials **when they're cheap** ("prefer-low discipline"):

- **`GATE_PRICE_CEIL_FACTOR`** — relative ceiling vs the cheapest source (skip pricier markets).
- **`GATE_MAX_PRICE`** — an *absolute* per-material cap. **Essential** because single-producer
  materials never trigger the relative ceiling (there's nothing cheaper to compare against), so only
  an absolute cap can ever pause buying during a price spike.
- **Price-settle patience** (`GATE_PRICE_SETTLE_MS` / `GATE_PRICE_REBOUND_EPS`) — when a capped
  material first dips under its cap, don't pounce; wait to see if it falls further, then resume once
  it rebounds off its observed low or the window elapses. Buys nearer the bottom.

## 6. How the bot decides it's "done"

`targetWatch()` (~L2316–2342) checks `cachedCredits >= expansionTarget` every 30s, **but**:

- It only stops when the **gate status is actually known** (`gateStatusKnown`) — an outage that makes
  the construction fetch fail must never collapse the goal into a phantom "EXPANSION-READY" stop
  (`[RULE]` learned: a swallowed fetch error once dropped the goal to ~1.1M and stopped the bot).
- **If the gate is still unbuilt and `GATE_SUPPLY` is on, the bot does NOT stop** even when the credit
  goal is met — it keeps trading and feeding the gate, because *building the gate is the expansion*.
  Only once the gate is built does the credit goal become the meaningful stop.

## 7. Phase transitions in practice (observed)

From the decision log / checkpoints, the live progression has been roughly:

- **Bootstrap → Profit:** map markets via probes, run starter contracts, grow to a working fleet.
- **Profit → Gate supply:** discover the gate site, enable `GATE_SUPPLY`, begin opportunistic +
  dedicated-hauler feeding while trading continues. Aggressive buy-downs toward the floor in bursts.
- **Input-feed overlap (tried, then disabled):** feeding producer inputs to restock the long pole
  was implemented (Phase 4) but **disabled after it lost money** (concurrent feeders crashed a
  producer's import buy-price mid-flight). It remains in the code behind guardrails (`INPUT_FEED=0`).
- **Portal open (future):** once the gate completes, seed the next system cell — the franchise/cell
  expansion model described in `EXPANSION-DESIGN.md`.

> **Honest ROI note from the operators:** the mining colony is only a *mildly* profitable lane on its
> own (B9 is distant and low-value) — its real job is **cost suppression, not profit**: keeping F51's
> FAB price cheap so gate buying is cheaper, while monetizing leftover ore on the side. Cheap-FAB
> **buying** has historically driven the gate more than the mining profit itself has.
