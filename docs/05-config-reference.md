# 05 — Configuration Reference

Every knob is an environment variable read at process start (a few are re-derived live each cycle).
Defaults are from `bot2.mjs` as noted; the **Prod launch** column shows the value used by the current
production launch where it differs from the code default.

> ⚠️ **Accuracy note — these knobs are operator-tuned and change between launches.** Three different
> profiles exist in the source material, and they disagree. Values verified against the **live**
> `bot-status.json` + log header (launch `bot2.20260612-110854.log`) are authoritative; `STRATEGY.md`
> §6 is the **oldest** (Jun 11) and is now stale:
> - `GATE_CREDIT_FLOOR`: code default `1_500_000`; STRATEGY.md says `1_100_000`; **live = `900_000`** (resume `1_150_000`).
> - `GATE_MAX_PRICE`: no code default; STRATEGY.md says `FAB_MATS:3200,ADVANCED_CIRCUITRY:8000`; **last-known launch (SESSION-CONTEXT 00:28) = `FAB_MATS:3900,ADVANCED_CIRCUITRY:12500`** (not echoed in the live log — treat as approximate; ADV is now fully supplied so its cap is moot).
> - `MIN_NET`: code default `4000`; STRATEGY.md says `2000`; **last-known launch = `1200`** (lowered to wake parked ships during depletion; not echoed in the live log).
> - `MINE_TRANSPORT`: **live = `14,29`** (not `14,12,29` — ships 12 & 13 are the dedicated `GATE_HAULERS`).
>
> See [`07-doc-drift.md`](07-doc-drift.md) for the full drift analysis. Booleans below use the bot's
> idiom: `X !== '0'` means **default ON** (set `X=0` to disable); `X === '1'` means **default OFF**.

---

## Core trading

| Var | Default | Controls |
|---|---|---|
| `SYSTEM` | `X1-PP30` (const) | Operating system; not env-overridable. |
| `MAXD` | `2000` | Max lane distance *considered*; not a hard viability cap (router-costed net/min decides). |
| `MIN_NET` | `4000` | Per-lane gross-profit floor; below this a ship idles. **Live launch: `1200`.** |
| `PARK_MIN_NET` | `0` (off) | A hull parks unless its best lane's *absolute* projected net clears this. |
| `COOLDOWN_MS` | `300000` | Base per-good rest after a trade (price recovery + fleet spreading). |
| `COOLDOWN_MIN_MULT` | `0.33` | Thick goods rest as little as ⅓ base. |
| `COOLDOWN_MAX_MULT` | `4` | Thin goods rest up to 4× base. |
| `COOLDOWN_FLOOR_MS` | `60000` | Hard minimum cooldown. |
| `DEAD_LANE_PENALTY` | `3` | Multiplier escalation for lanes that disappoint (price moved). |
| `VALUE_OF_TIME` | `100` | cr/sec — BURN aggressiveness weight (a tuning weight, *not* real cash cost). |
| `SLIPPAGE_FACTOR` | `1.5` | Models how big buys move price; sizes buy lots. |
| `SPEED_FAR_DIST` | `250` | Distance beyond which a lane is "far" → speed-discounted for slow ships. |

## Multi-good ride-alongs & fill bias

| Var | Default | Controls |
|---|---|---|
| `MULTI_GOOD` | ON | Fill the hold with extra goods sold at source & sinkable at the same dest (zero detour). |
| `RIDEALONG_MIN_GROSS` | `1000` | Min per-good gross for a ride-along (filters dust). |
| `CONTRACT_RIDEALONG` | ON (with `MULTI_GOOD`) | Apply ride-along fill to contract hauls too — fill the spare hold (contract source → contract dest). `=0` keeps contract hauls single-purpose. |
| `FILL_BIAS` | ON | Tie-break lanes within `FILL_BIAS_EPS` toward fuller holds / gate drop-offs. |
| `FILL_BIAS_EPS` | `0.10` | Tie band: lanes within 10% of best net/min are re-ranked. |
| `GATE_DROPOFF_WEIGHT` | `0.5` | Drop-off nudge magnitude, in "holds" (0.5 = half a full hold). |

## Phase / expansion / budget

| Var | Default | Controls |
|---|---|---|
| `BOOTSTRAP_FLEET_MIN` | `2` | Below this many traders ⇒ still bootstrapping. |
| `CREDIT_TARGET` | `0` (dynamic) | Pin the credit goal; `0` = compute cost-to-expand live (`DYNAMIC_TARGET`). |
| `NEW_CELL_SEED` | `600000` | Est. cost to seed a new system (2 probes + hauler + antimatter). |
| `HAULER_PRICE` | `314345` | Assumed hauler cost in budgeting. |
| `GOODS_CUSHION` | `300000` | Working-capital cushion for in-flight/next cargo buys. |
| `OPERATING_RESERVE` | `200000` | Reserve floor; recomputed from live fleet at startup. |

## Gate supply

| Var | Default | Controls |
|---|---|---|
| `GATE_SUPPLY` | ON | Master switch for opportunistic + dedicated gate hauling. |
| `GATE_CREDIT_FLOOR` | `1500000` | Hard stop: pause gate buying below this cash. **Live: `900000`** (resume `1150000`). |
| `GATE_CREDIT_RESUME_GAP` | `250000` | Hysteresis gap; resume buying only at floor+gap. |
| `GATE_CREDIT_RESUME` | floor+gap | Explicit resume threshold (derived if unset). |
| `GATE_SUPPLY_MAX_UNITS` | `0` (=cargo cap) | Cap units per gate trip. |
| `GATE_PRICE_CEIL_FACTOR` | `2.0` | Skip sources pricier than cheapest×this ("only when cheap"). |
| `GATE_MAX_PRICE` | none | Absolute per-material cap. **Last-known launch `FAB_MATS:3900,ADVANCED_CIRCUITRY:12500`** — required for single-producer goods. |
| `GATE_PRICE_SETTLE_MS` | `240000` | Patience window after a capped good drops under cap. |
| `GATE_PRICE_REBOUND_EPS` | `0.02` | Resume once price rebounds this fraction off its observed low. |
| `GATE_MAX_SUPPLIERS` | `2` | Max ships sourcing the gate concurrently (opportunistic only; haulers bypass). |
| `GATE_HAULERS` | none | Ships pinned to gate-supply, excluded from trade pool while gate unbuilt. |
| `GATE_PROTECT` | ON | Forbid profit-trading gate materials / sourcing out of gate producers. |
| `GATE_PROTECT_MATERIALS` | `FAB_MATS,ADVANCED_CIRCUITRY,QUANTUM_STABILIZERS` | The protected/needed materials list. |
| `GATE_FUEL_CARGO` | OFF (`0`) | When a gate-bound leg can't be flown on one tank, carry FUEL in the *spare* slots left after the material buy and fly the more-direct fuel-cargo route (refuel-from-cargo on dry legs) instead of detouring through a fuel market. Material always has priority; only diverts when it saves a hop. Inert in a compact fuel-everywhere system (X1-PP30) — value is far sources / seeding a new system. |

## Orphan gate cargo

| Var | Default | Controls |
|---|---|---|
| `ORPHAN_GATE_DELIVERY` | ON | Rescue a non-hauler stuck holding gate materials (4-tier delivery). |
| `ORPHAN_MIN_UNITS` | `5` | Smallest held qty worth a dedicated run (a full hold always triggers). |

## Contracts

| Var | Default | Controls |
|---|---|---|
| `NEGOTIATOR` | `SPACEJAM-DK-2-15` | Ship used to negotiate new contracts. |
| `CONTRACT_RUNNER` | none | Pin specific ship(s) to run contracts. |
| `CONTRACT_BEST_SHIP` | ON | Centrally elect the closest idle/empty eligible hull as owner. |
| `CONTRACT_REELECT_MARGIN` | `40` | Only switch owners if a candidate is closer to source by > this (anti-latch). |
| `CONTRACT_MIN_MARGIN` | `1000` | Min net (payout − source − fuel) before claiming. |
| `CONTRACT_MIN_MARGIN_PCT` | `0.04` | Min margin as a fraction of payout. |
| `CONTRACT_MAX_SRC_DIST` | `500` | Straight-line cap: don't source if cheapest market is farther than this **unless** `FUEL_CARGO` is on and a refuel-aware route reaches it within `CONTRACT_MAX_HOPS` (see Universal fuel-cargo). |
| `CONTRACT_MAX_HOPS` | `6` | When `FUEL_CARGO` relaxes the distance gate, cap the refuel-route length (tank-hop or fuel-in-cargo) so we never chase a contract across endless hops. |
| `CONTRACT_FUEL_PX` | `2` | Rough cr/fuel for the contract profitability estimate. |
| `CONTRACT_FORCE` | none | Bypass the margin gate for these goods (still distance-gated) — banked-`onAccepted` trick. |
| `CONTRACT_AUTOFORCE_MINS` | `20` | If the active contract stays continuously **unclaimed** (no owner) this many minutes, auto-force it (margin gate bypassed) so the closest hull clears it and frees the slot. `0` disables (manual `CONTRACT_FORCE` only). |
| `CONTRACT_AVOID_GATE_PRODUCER` | ON | Skip gate-producer markets when sourcing a contract good/input. |
| `DEBUG_CONTRACT` | off | Verbose contract logging. |

## Input feed (Phase-4 accelerator — **disabled in prod**)

| Var | Default | Controls |
|---|---|---|
| `INPUT_FEED` | OFF | Master switch; feed a producer's imported inputs. **Off in prod** (caused a loss). |
| `INPUT_FEED_MAX` | `2` (hard-capped ≤2) | Concurrent opportunistic feeders. |
| `INPUT_FEED_MIN_GROSS` | `0` | Min per-trip net to feed. |
| `INPUT_FEED_GATE_PAUSE` | OFF | Re-couple feeding to the gate-buy credit pause (legacy). |
| `INPUT_FEED_MIN_CASH` | `0` | Extra free-cash cushion required to feed. |
| `INPUT_FEEDERS` | none | Dedicated feeder ships (bypass the cap). |

## Mining colony

| Var | Default | Controls |
|---|---|---|
| `MINE_FEED` | OFF | Master switch for the mining colony. **Prod: on (`1`).** |
| `MINE_FEEDERS` | none | Dedicated feeder/refiner ships. |
| `MINE_GOOD` | auto | Force target feed good; '' = auto-pick best value×scarcity input. |
| `MINE_BATCH` | `24` | Units to accumulate before hauling to the producer. |
| `MINE_PRODUCER` | auto | Target producer waypoint; '' = auto (FAB_MATS export = F51). |
| `MINE_TRANSPORT` | auto | Force the ferry/tender ship(s). **Live: `14,29`.** |
| `MINE_FUNNEL` | none | Cargo hull parked at the rock as a shared ore bin. **Prod: `28`.** |
| `MINE_FUEL_RESERVE` | `12` | FUEL cargo units the tender keeps to refuel parked miners. **Prod: `20`.** |
| `MINE_ORE_RESERVE` | `REFINE_IN` (30) | Ore left in the funnel for the refiner. |
| `MINE_CLOG_AT` | `32` | Only sell raw ore once the funnel holds ≥ this (else prefer refine→feed). |
| `MINE_RAW_RELIEF` | ON | Relief-valve: sell raw ore at H59 when the funnel clogs. |

## Ship repair (default OFF)

| Var | Default | Controls |
|---|---|---|
| `REPAIR` | OFF (`0`) | Master switch for ship maintenance. Set `1` to enable opportunistic + forced repair. |
| `REPAIR_COND_MIN` | `0.85` | Opportunistic: repair when min(frame/reactor/engine) **condition** < this *and* the ship is already docked at a shipyard (no detour). |
| `REPAIR_INTEG_FORCE` | `0.5` | Forced: divert to the nearest shipyard and repair when min **integrity** < this (prevents losing a hull). |
| `REPAIR_MAX_COST` | `100000` | Skip any single repair whose quote exceeds this (safety cap). Repairs spend only `growthBudget`, never the reserve. |

## Mining-colony expansion (default OFF)

| Var | Default | Controls |
|---|---|---|
| `MINE_EXPAND` | OFF (`0`) | Master switch. Buys colony ships only while `MINE_FEED` on **and the gate is unbuilt**. |
| `MINE_MAX_SURVEYORS` | `3` | Cap on total survey-mount hulls (existing 2 + room for 1). Surveyors are bought first. |
| `MINE_MAX_DRONES` | `4` | Cap on total mining drones (existing 2 + room for 2). Bought after the surveyor cap is met. |
| `MINE_EXPAND_CREDIT_FLOOR` | `600000` | Never buy if it would drop credits below this. Buys also gated by `growthBudget`. |
| `MINE_EXPAND_SCAN_MS` | `600000` | Expansion-manager scan cadence (≈10 min); at most one hull per scan. |

## Inter-system expansion fleet auto-buy (default OFF)

Grows the expansion fleet when idle ships can't fill outpost staffing/coverage. Existing idle ships are
always used first (`setupOutposts`); auto-buy fills only the shortfall. See `08-expansion.md` §3.

| Var | Default | Controls |
|---|---|---|
| `EXPAND_AUTOBUY` | OFF (`0`) | Master switch for fleet auto-buy (requires `AUTO_EXPAND=1`). |
| `EXPAND_BUY_FLOOR` | `max(EXPAND_CREDIT_FLOOR+250k, 700k)` | Never buy if it would drop credits below this (hard no-bankrupt). |
| `EXPAND_AUTOBUY_MS` | `90000` | Min interval between buy attempts (one hull per window, throttles retry on "no hull at shipyard"). |
| `EXPAND_MAX_BUY_TRADERS` | `8` | Lifetime cap on trader/hauler buys this run. |
| `EXPAND_MAX_BUY_PROBES` | `24` | Lifetime cap on probe buys this run. |
| `EXPAND_OUTPOST_TRADERS` | `1` | Target traders per outpost; auto-buy buys haulers up to this when idle ships run out. Set `2` for "1 hauler + 1 light". |
| `EXPAND_PROBE_TARGET` | `0` (=1:1 with markets) | Per-system probe target cap for coverage buys. |
| `EXPAND_TRADER_PREF` | heavy→refining freighter→light hauler→shuttle→frigate | Trader hull preference (best cargo/range first). |

## Universal fuel-cargo (default OFF)

Generalizes `GATE_FUEL_CARGO` to **every** haul (trade delivery, contract source/deliver) and relaxes the contract distance gate. See `03-subsystems.md` §9.

| Var | Default | Controls |
|---|---|---|
| `FUEL_CARGO` | OFF (`0`) | Master switch. On any haul where a leg can't be flown on one tank, carry FUEL in the slots left **after** the goods and fly the more-direct fuel-cargo route (refuel-from-cargo on dry legs) instead of detouring through a fuel market. Also relaxes the contract sourcing distance gate (far-but-reachable sources become eligible). |
| `CONTRACT_MAX_HOPS` | `6` | Cap on the refuel-route length when `FUEL_CARGO` admits a far contract source. |

Behaviour notes:
- **Goods always win.** Fuel only uses post-goods free slots. At a buy point, leftover carried fuel is burned into the tank, then sold (if the market buys FUEL) or jettisoned to reclaim the slot — never blocks sourcing.
- **Only diverts when it saves a hop** vs the tank-only route, and only when the source sells FUEL.
- **Range-aware contracts.** A source beyond `CONTRACT_MAX_SRC_DIST` is still eligible when a refuel-aware route (tank multi-hop or fuel-in-cargo) reaches it within `CONTRACT_MAX_HOPS`; the net-margin gate (costed on the real route) still rejects unprofitable far runs.
- Independent of `GATE_FUEL_CARGO`; either flag enables the gate-haul path.

## Ops / display

| Var | Default | Controls |
|---|---|---|
| `FLEET_TABLE` | ON | Periodic fleet status table to stderr. |
| `FLEET_TABLE_MS` | `60000` | Fleet-table refresh interval. |

---

## Reference: live launch profile (verified against `bot-status.json` + log, launch 11:08)

Values **confirmed live** are marked ✓; values not echoed by the bot are from the last-known launch
command (SESSION-CONTEXT.md, 00:28) and may have changed since:

```
MIN_NET=1200                 # last-known (not echoed live)
GATE_CREDIT_FLOOR=900000     # ✓ live
GATE_CREDIT_RESUME_GAP=250000  # ✓ (resume 1150000)
GATE_HAULERS=12,13           # ✓ live
GATE_MAX_SUPPLIERS=2
GATE_MAX_PRICE="FAB_MATS:3900,ADVANCED_CIRCUITRY:12500"  # last-known (not echoed live)
GATE_PROTECT=1
CONTRACT_AVOID_GATE_PRODUCER=1
CONTRACT_BEST_SHIP=1
CONTRACT_MIN_MARGIN_PCT=0.04
INPUT_FEED=0                 # ✓ live (disabled)
MINE_FEED=1                  # ✓ live
MINE_TRANSPORT=14,29         # ✓ live
MINE_FUNNEL=28               # ✓ (funnel role active at B9)
MINE_BATCH=30
MINE_FUEL_RESERVE=20
MINE_ORE_RESERVE=0
MINE_CLOG_AT=0
FILL_BIAS=1
FILL_BIAS_EPS=0.10
DEBUG_CONTRACT=1
# plus an active CONTRACT_FORCE=<good> at times (live: LIQUID_HYDROGEN)
```

> Live gate state at time of writing: only **FAB_MATS (~415)** remains — `ADVANCED_CIRCUITRY` and
> `QUANTUM_STABILIZERS` are fully supplied. So `ADVANCED_CIRCUITRY`'s price cap is currently moot.
