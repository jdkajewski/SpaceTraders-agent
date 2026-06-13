// ============================================================================
//  SPACEJAM AUTOTRADER v2  —  continuous per-ship scheduler
//  Upgrades over v1:
//   • CONTINUOUS workers: each ship, the instant it finishes, claims the next
//     best AVAILABLE lane and goes again — no fleet-wide barrier, no global rest.
//     Fast ships (frigate spd36) are never held back by a slow straggler.
//   • PER-GOOD COOLDOWN replaces the global rest: after a ship trades a good,
//     that good rests COOLDOWN_MS so its price pool recovers AND ships naturally
//     spread across many goods (incl. lower-margin ones) instead of dogpiling
//     the single best lane.
//   • PER-LEG FLIGHT MODE: chooseMode() picks CRUISE/BURN/DRIFT from the ship's
//     REAL engine speed + fuel headroom + value-of-time (BURN only when the
//     time saved outweighs the extra fuel; DRIFT as a limp-home).
//
//  Run:  node bot.mjs       Stop: touch STOP (graceful) or kill PID
// ============================================================================
import { api, getAllShips, getAllContracts, reqStats } from './st.mjs';
import { navigate, buy, sell, deliver, fulfill, getShip, refuel, transfer, jump } from './trade.mjs';
import { createExpansion } from './expansion.mjs';
import fs from 'node:fs';

const SYSTEM = 'X1-PP30';
const MAXD = Number(process.env.MAXD || 2000);   // consider lanes system-wide; true viability decided by net/min (router-costed), not a hard cap
let FUEL_PX = 0.72;     // cr per FUEL UNIT — LIVE-updated from market FUEL price each cycle (see computeFuelPx).
                        // 0.72 is only the boot fallback (verified: a 100-unit refuel costs 72 cr → 0.72/unit).
                        // NOT hardcoded for decisions: routeCost/chooseMode/reserve read this live value.
// Market-recovery tuning. Measured depletion: at 150s cooldown, per-lane net fell ~62% over a run
// (extracting faster than markets heal). Longer cooldown + higher floor makes ships idle (letting
// prices recover) instead of scraping depleted lanes. Both env-tunable.
const MIN_NET = Number(process.env.MIN_NET || 4000);          // per-lane gross-profit floor; below this a ship idles
// [MULTI-GOOD] Ride-along loadouts: after buying the primary good, fill the rest of the hold with OTHER
// goods that are ALSO sold at the source AND profitably sink at the SAME destination (zero detour, zero
// extra fuel). Data: cap-80 hulls run ~33% full because high-margin goods cap at tradeVolume ~20; ~27% of
// profitable lanes have a co-destination 2nd good (+~39% gross). Each ride-along is one tradeVolume lot to
// avoid slippage. RIDEALONG_MIN_GROSS filters dust (the trip is already paid for by the primary).
const MULTI_GOOD = process.env.MULTI_GOOD !== '0';
const RIDEALONG_MIN_GROSS = Number(process.env.RIDEALONG_MIN_GROSS || 1000);
// [MULTI-GOOD] Apply the same zero-detour ride-along fill to CONTRACT hauls: a contract often needs fewer
// units than the hull holds (e.g. 18 units in a cap-80 freighter), so the spare hold rides for free with
// profitable goods sold at the contract SOURCE that also sink at the contract DESTINATION. Default tied to
// MULTI_GOOD; set CONTRACT_RIDEALONG=0 to keep contract hauls single-purpose.
const CONTRACT_RIDEALONG = MULTI_GOOD && process.env.CONTRACT_RIDEALONG !== '0';
// [FILL-BIAS] Detour-free "fill the hold / drop off where it helps" tie-breaker for lane selection. We
// NEVER detour or run the wrong direction to fill — instead, among lanes whose net/min is within
// FILL_BIAS_EPS of the best, we prefer the one that (a) fills more of the hold via zero-detour ride-alongs
// and (b) drops off at a gate-material producer (so the delivery restocks the gate's inputs) while the gate
// is unbuilt. Pure re-ranking of already-profitable, already-on-route lanes — no profit sacrificed beyond
// the epsilon band, no extra travel. FILL_BIAS=0 disables; GATE_DROPOFF_WEIGHT scales the drop-off nudge.
const FILL_BIAS = process.env.FILL_BIAS !== '0';
const FILL_BIAS_EPS = Number(process.env.FILL_BIAS_EPS || 0.10);   // tie band: lanes within 10% of best net/min
const GATE_DROPOFF_WEIGHT = Number(process.env.GATE_DROPOFF_WEIGHT || 0.5); // drop-off nudge, in "holds" (0.5 = half a full hold)
// [PHASE] Greenfield→portal strategy as an explicit, OBSERVABLE state machine. The active phase is
// DERIVED from live state each cycle (fleet size, market graph, gate status); it never hard-gates the
// proven trade loop — it is the single source of truth the gate/fill levers read from, it is logged so
// the run is self-documenting, and it is surfaced in bot-status.json. See files/expansion-strategy.md.
const BOOTSTRAP_FLEET_MIN = Number(process.env.BOOTSTRAP_FLEET_MIN || 2); // < this many traders ⇒ still bootstrapping
const INPUT_FEED = process.env.INPUT_FEED === '1';                       // Phase 4 accelerator (feed producer inputs); off until built
// [INPUT_FEED] Phase 4: actively restock the LONG-POLE gate material's producer by hauling its IMPORTED
// inputs to it. This is profit-POSITIVE on its own (buy an input cheap at its source, sell it into the
// producer's IMPORT market) AND it raises the producer's output rate while pushing the gate material's
// price DOWN — so it accelerates gate completion without a subsidy. Opportunistic idle hulls are throttled
// by INPUT_FEED_MAX (so we don't spike the input SOURCE prices); dedicated INPUT_FEEDERS (like GATE_HAULERS)
// are pinned to feeding and bypass the cap. Only ever feeds at a per-trip net ≥ INPUT_FEED_MIN_GROSS.
// [GUARDRAIL] HARD-capped at 2 regardless of env. The prior feed loss came from 4 opportunistic feeders
// piling onto ONE producer and crashing its IMPORT buy-price below our cost mid-flight. Combined with the
// per-producer cap below (1 feeder/producer), this makes a self-inflicted price crash structurally impossible.
const INPUT_FEED_MAX = Math.min(2, Number(process.env.INPUT_FEED_MAX || 2)); // concurrent opportunistic feeders (dedicated bypass), capped ≤2
const INPUT_FEED_MIN_GROSS = Number(process.env.INPUT_FEED_MIN_GROSS || 0); // min per-trip net to feed (0 = any non-negative)
// [INPUT_FEED] Input-feed is profit-positive (margin>0) and bounded by growthBudget() (which already protects
// OPERATING_RESERVE), so by default it runs INDEPENDENTLY of the gate-buy credit pause: while expensive finished-
// good gate buying rests (credits in the hysteresis deadband), we still cheaply lift the producer's INPUT supply
// so its finished output is cheaper/abundant once gate-buy resumes. Set INPUT_FEED_GATE_PAUSE=1 to re-couple it to
// gateCreditOk() (old behavior). INPUT_FEED_MIN_CASH is an optional extra free-cash cushion (default 0 = reserve only).
const INPUT_FEED_GATE_PAUSE = process.env.INPUT_FEED_GATE_PAUSE === '1'; // re-couple input-feed to the gate-buy pause (default: independent)
const INPUT_FEED_MIN_CASH = Number(process.env.INPUT_FEED_MIN_CASH || 0); // require this much free cash (above reserve) to input-feed
const INPUT_FEEDERS = new Set((process.env.INPUT_FEEDERS || '').split(',').map((s) => s.trim()).filter(Boolean));
const isInputFeeder = (s) => { for (const h of INPUT_FEEDERS) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
// [MINE_FEED] Data-driven mining: mine F51's inputs ourselves (ore is ~free) → refine ore→metal on a ship with
// a MINERAL_PROCESSOR (ship 1) → feed F51. Turns input-feeding from a LOSS (buying IRON/COPPER costs more than
// F51 pays) into pure profit AND restocks the SCARCE producer without spiking input source prices. Every
// extract/refine/feed is logged to mine-history.jsonl so the target good / asteroid / batch self-calibrate.
const MINE_FEED = process.env.MINE_FEED === '1';                          // master switch; off until enabled
const MINE_FEEDERS = new Set((process.env.MINE_FEEDERS || '').split(',').map((s) => s.trim()).filter(Boolean));
const isMineFeeder = (s) => { for (const h of MINE_FEEDERS) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
const MINE_GOOD = process.env.MINE_GOOD || '';                            // force target good; '' = auto (best value×scarcity F51 input we can mine)
const MINE_BATCH = Number(process.env.MINE_BATCH || 24);                  // accumulate ~this many units of the feed good before hauling
const MINE_PRODUCER = process.env.MINE_PRODUCER || '';                    // target producer wp; '' = auto (FAB_MATS EXPORT producer)
// [MINE_FEED] Park-and-ferry colony roles. Mining ships are AUTO-detected by capability (see mineRoleOf):
// REFINER = MINING_LASER + MINERAL_PROCESSOR (ship 1), DRONE = MINING_LASER only, SURVEYOR = SURVEYOR mount.
// The TRANSPORT/tender ferries metal out + fuel back. It's AUTO-selected (pickMineTender): prefer a hauler,
// else any cargo+range hull, else none (ferry just doesn't run). MINE_TRANSPORT env can force a specific ship.
const MINE_TRANSPORT = new Set((process.env.MINE_TRANSPORT || '').split(',').map((s) => s.trim()).filter(Boolean));
const MINE_FUEL_RESERVE = Number(process.env.MINE_FUEL_RESERVE || 12);    // FUEL cargo units the tender keeps to refuel parked/scouting miners (1 unit ≈ 100 ship-fuel)
let mineTenderSym = null;   // auto-selected fuel-tender/ferry hull (see pickMineTender); null = no suitable ship → ferry simply doesn't run
const isMineTransport = (s) => { if (s === mineTenderSym) return true; for (const h of MINE_TRANSPORT) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
// [MINE_FEED] FUNNEL/ore-storage role: a cargo hull (NOT a probe — probes have 0 cargo) parked permanently at the
// rock as a shared ore bin. Drones dump ALL ore here; the refiner pulls single-good 30-batches out, refines, and
// pushes the finished metal + non-target goods back; the tender pulls finished FEED_GOODS from here → F51. Lets the
// refiner run continuous single-good refine loops (rotating target) while drones never idle. MINE_FUNNEL=<ship>.
const MINE_FUNNEL = new Set((process.env.MINE_FUNNEL || '').split(',').map((s) => s.trim()).filter(Boolean));
const isMineFunnel = (s) => { for (const h of MINE_FUNNEL) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
// [INPUT_FEED] Supply-tier rank (lower = scarcer = more urgent to feed). Used to bias the feed toward the
// producer's SCARCEST inputs so we don't starve IRON/QUARTZ/SILICON by only chasing COPPER's high margin.
const SUPPLY_RANK = { SCARCE: 0, LIMITED: 1, MODERATE: 2, HIGH: 3, ABUNDANT: 4 };
// [PARK] Dynamic-fleet knob: a hull only trades if its BEST lane's projected net (after fuel) clears
// this floor — otherwise it PARKS in orbit (zero holding cost in SpaceTraders: no upkeep, fuel burns
// only in transit). Uses ABSOLUTE net, NOT net/min, so slow-but-fat far lanes are never wrongly parked.
// Default 0 = off (still requires net>0). Raise it to keep surplus hulls parked instead of scraping thin
// lanes, preserving margin (measured diminishing returns: 246k→173k→124k per added active ship).
const PARK_MIN_NET = Number(process.env.PARK_MIN_NET || 0);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 300_000); // a good rests this long after being traded (recovery)
const VALUE_OF_TIME = Number(process.env.VALUE_OF_TIME || 100); // cr/sec — BURN aggressiveness knob.
                                                               // ~85→always CRUISE (fuel-saving); ~110→slow ships BURN.
                                                               // 100 ≈ near break-even, slight fuel-conserving lean.
const MARKET_TTL_MS = 75_000;      // shared market cache lifetime
const IDLE_WAIT_MS = 12_000;       // worker wait when no lane available

// ===================== [REPAIR] ship maintenance =====================
// SpaceTraders ships have two health axes: condition (0..1) = performance wear (drags speed / raises fuel use,
// fully restored by repair) and integrity (0..1) = structural life (NOT restored by repair beyond a point; at 0
// the hull is DESTROYED). `POST /my/ships/{s}/repair` (must be DOCKED at a SHIPYARD; `GET` returns a quote)
// restores condition. Two race-free tiers, BOTH run inside the ship's own worker loop (never an external manager
// driving someone else's hull): (1) OPPORTUNISTIC — when the ship is already sitting at a shipyard and is worn,
// top it up (zero detour); (2) FORCED — if integrity is critically low, divert to the nearest shipyard and repair
// so we never LOSE a hull mid-route. Budget: a repair only spends growthBudget (never the reserve) and is capped
// per repair by REPAIR_MAX_COST. Default OFF → enabling is a deliberate restart decision.
const REPAIR = process.env.REPAIR === '1';
const REPAIR_COND_MIN = Number(process.env.REPAIR_COND_MIN || 0.85);       // opportunistic: repair when min condition < this
const REPAIR_INTEG_FORCE = Number(process.env.REPAIR_INTEG_FORCE || 0.5);  // forced divert when min integrity < this
const REPAIR_MAX_COST = Number(process.env.REPAIR_MAX_COST || 100_000);    // skip a repair whose quote exceeds this (safety)

// ===================== [MINE_EXPAND] minor mining-colony expansion =====================
// Grow the park-and-ferry mining colony by BUYING surveyors + mining drones in-system (X1-PP30 shipyards sell
// SHIP_SURVEYOR ~$34k and SHIP_MINING_DRONE ~$45k). The colony's purpose is to keep F51 fed (silicon/quartz direct,
// raw ore sold at H59) so FAB_MATS stays cheap and the gate completes — fresher surveys + more extraction directly
// serve that. mineRoleOf() is capability-based, so a freshly-bought hull auto-slots into its role (SURVEYOR / DRONE)
// with zero extra config; the only new work is the BUY + spawning its worker (the role loop then drives it to the
// asteroid). Conservative: hard caps, gate-unbuilt only, funded ONLY from growthBudget above MINE_EXPAND_CREDIT_FLOOR.
// Default OFF → enabling is a deliberate restart decision.
const MINE_EXPAND = process.env.MINE_EXPAND === '1';
const MINE_MAX_SURVEYORS = Number(process.env.MINE_MAX_SURVEYORS || 3);    // cap total survey hulls (existing 2 + room for 1 more if needed)
const MINE_MAX_DRONES = Number(process.env.MINE_MAX_DRONES || 4);          // cap total mining drones (existing 2 + room for more if extraction-bound)
const MINE_EXPAND_CREDIT_FLOOR = Number(process.env.MINE_EXPAND_CREDIT_FLOOR || 600_000); // keep ≥ this cash before buying a colony ship
const MINE_EXPAND_SCAN_MS = Number(process.env.MINE_EXPAND_SCAN_MS || 600_000);           // expansion-manager scan cadence
// [MINE_MIGRATE] When the colony's rock gets mined out, relocate to a fresh rock with the same deposit instead of
// extracting near-zero yields forever. Depletion is read from the waypoint's `modifiers`: CRITICAL_LIMIT (nearly
// out, yields falling) → STRIPPED (exhausted). We migrate on STRIPPED always, and proactively on CRITICAL_LIMIT
// IF a healthy alternative rock exists. Default OFF → enabling is a deliberate restart decision.
const MINE_MIGRATE = process.env.MINE_MIGRATE === '1';
const MINE_MIGRATE_SCAN_MS = Number(process.env.MINE_MIGRATE_SCAN_MS || 300_000);         // colony-rock depletion scan cadence
const CREDIT_TARGET = Number(process.env.CREDIT_TARGET || 0);   // 0 = dynamic (compute the cost-to-expand)
const DYNAMIC_TARGET = !process.env.CREDIT_TARGET;             // override with CREDIT_TARGET env to pin it
const SLIPPAGE_FACTOR = Number(process.env.SLIPPAGE_FACTOR || 1.5);   // big material buys move price
const NEW_CELL_SEED = Number(process.env.NEW_CELL_SEED || 600_000);   // ~2 probes + 1 hauler + antimatter to seed a new system
const HAULER_PRICE = Number(process.env.HAULER_PRICE || 314_345);
// [GATE] Opportunistic gate-supply: when a hull would otherwise idle (no profitable lane / parked),
// and the system JUMP_GATE is unbuilt, divert it to haul the neediest construction material to the
// gate. Trade-first (only fires on idle), credit-floored (construction supply pays $0, so never dip
// below GATE_CREDIT_FLOOR), and work is split across idle ships via in-memory unit reservations.
const GATE_SUPPLY = process.env.GATE_SUPPLY !== '0';                              // default ON; set GATE_SUPPLY=0 to disable
const GATE_CREDIT_FLOOR = Number(process.env.GATE_CREDIT_FLOOR || 1_500_000);     // keep ≥ this cash while feeding the gate
// [GATE] Hysteresis on the credit floor. The floor is a HARD stop: once credits dip below GATE_CREDIT_FLOOR we
// pause gate buying. WITHOUT a deadband, the moment credits tick back above the floor we buy one batch and
// instantly fall under again → sawtooth (buy/pause/buy/pause every cycle). With hysteresis we DON'T resume
// until credits recover to GATE_CREDIT_RESUME (floor + GAP). That lets a real buffer rebuild, then we can buy
// AGGRESSIVELY down toward the floor in a sustained burst before pausing again. Tune the gap to set burst size.
const GATE_CREDIT_RESUME_GAP = Number(process.env.GATE_CREDIT_RESUME_GAP || 250_000);
const GATE_CREDIT_RESUME = Number(process.env.GATE_CREDIT_RESUME || (GATE_CREDIT_FLOOR + GATE_CREDIT_RESUME_GAP));
const GATE_SUPPLY_MAX_UNITS = Number(process.env.GATE_SUPPLY_MAX_UNITS || 0);     // 0 = up to free cargo capacity
// [GATE_FUEL_CARGO] When a gate-bound leg can't be flown on a single tank, the tank-only router detours through a
// FUEL market (extra hop). If the hauler has spare cargo slots (the per-trip material buy is usually tradeVolume-
// capped, leaving the hold half-empty) and the current source market sells FUEL, instead carry FUEL in those idle
// slots and fly the (often more direct) fuel-cargo route, topping the tank from cargo before each dry leg. Material
// ALWAYS has priority — only slots left AFTER the material buy are ever used, and we only divert when it actually
// saves a hop. Mostly inert in a compact system (every gate leg fits one tank) — its real value is far sources and
// seeding a new system. Default OFF.
const GATE_FUEL_CARGO = process.env.GATE_FUEL_CARGO === '1';
// [FUEL_CARGO] Universal generalization of GATE_FUEL_CARGO: on ANY haul (trade delivery, contract source/deliver),
// when a leg can't be flown on one tank and the hold has spare slots AFTER the goods, carry FUEL in those slots and
// fly the more-direct fuel-cargo route (refuel-from-cargo on dry legs) instead of detouring through a fuel market.
// Goods ALWAYS outrank carried fuel: fuel only uses post-goods free slots, and at a buy point any leftover carried
// fuel is burned into the tank then sold/jettisoned to reclaim the slot (shedSpareFuel). Also relaxes the contract
// sourcing distance gate: a far source counts as eligible when a refuel-aware route (tank or fuel-in-cargo) reaches
// it within CONTRACT_MAX_HOPS (the net-margin gate, costed on the real route, still rejects unprofitable far runs).
// Default OFF → enabling is a deliberate restart decision.
const FUEL_CARGO = process.env.FUEL_CARGO === '1';
const CONTRACT_MAX_HOPS = Number(process.env.CONTRACT_MAX_HOPS || 6);   // when FUEL_CARGO relaxes the contract distance gate, cap refuel-route length so we never chase a contract across endless hops
const GATE_PRICE_CEIL_FACTOR = Number(process.env.GATE_PRICE_CEIL_FACTOR || 2.0); // per-material: skip sources pricier than cheapest×this ("only when cheap")
// [GATE] Absolute per-material price cap: pause buying a gate material when its price exceeds this, so we don't
// overpay during a spike — wait for mining/restock to cool it. Format "FAB_MATS:3200,ADVANCED_CIRCUITRY:7000".
// Empty = no absolute cap (relative ceiling only).
const GATE_MAX_PRICE = (() => { const out = {}; for (const p of (process.env.GATE_MAX_PRICE || '').split(',')) { const [k, v] = p.split(':'); if (k && v && Number(v) > 0) out[k.trim()] = Number(v); } return out; })();
// [GATE] Price-settle PATIENCE: when a capped material drops back under its cap, don't pounce on the first tick —
// wait up to GATE_PRICE_SETTLE_MS to see if it falls further (better entry/buffer), resuming buys once it rebounds
// off its observed low (GATE_PRICE_REBOUND_EPS) or the window elapses. A good that was never above its cap buys
// normally with no delay. Set GATE_PRICE_SETTLE_MS=0 to disable (instant buy at the cap, legacy behavior).
const GATE_PRICE_SETTLE_MS = Number(process.env.GATE_PRICE_SETTLE_MS ?? 240000);
const GATE_PRICE_REBOUND_EPS = Number(process.env.GATE_PRICE_REBOUND_EPS ?? 0.02);
// [FAB GUARD] Protect the gate-material supply chain from PROFIT trading. The profit engine must never (a) trade
// a gate material itself, nor (b) buy ANY good OUT OF a gate-material producer market (F51 makes FAB_MATS, D43
// makes ADVANCED_CIRCUITRY) — pulling goods out of those markets depletes their production throughput and drives
// the gate material's price UP, working against our own gate fill. Contracts/mining are separate paths that
// DELIVER to the producer (which helps), and the contract runner only buys the units it needs (no active trading).
// Set GATE_PROTECT=0 to disable. GATE_PROTECT_MATERIALS overrides the protected list.
const GATE_PROTECT = process.env.GATE_PROTECT !== '0';
const GATE_PROTECT_MATERIALS = new Set((process.env.GATE_PROTECT_MATERIALS || 'FAB_MATS,ADVANCED_CIRCUITRY,QUANTUM_STABILIZERS').split(',').map((s) => s.trim()).filter(Boolean));
// [FAB GUARD / CONTRACT] Extend the producer-protection to CONTRACT sourcing. When the contract good is either
// (a) a gate material itself, or (b) an INPUT the gate-material producer imports to MAKE that material, the
// cheapest market is often the gate producer (e.g. F51 makes FAB_MATS). Buying the contract units OUT OF that
// producer depletes its supply / spikes the gate-material price — working against our own gate fill. With this
// on, contract sourcing SKIPS the gate-material producer markets for those goods and walks down the market list
// to the next-cheapest source that still clears the contract margin gate. Set =0 to allow buying from producers.
const CONTRACT_AVOID_GATE_PRODUCER = process.env.CONTRACT_AVOID_GATE_PRODUCER !== '0';
// [GATE] Cap how many ships gate-supply CONCURRENTLY. Buying an EXPORT depletes its supply → price spikes
// (live: D43 ADVANCED_CIRCUITRY 3,958→9,549 once 8 idle hulls piled on). Limiting simultaneous suppliers
// lets the producer restock between pulls so materials stay cheap. Dedicated GATE_HAULERS always bypass
// this cap (they're explicitly assigned); only opportunistic divert-on-idle hulls are throttled.
const GATE_MAX_SUPPLIERS = Number(process.env.GATE_MAX_SUPPLIERS || 2);
// [GATE] Dedicated gate hauler(s): ships pinned to gate-supply, EXCLUDED from the trade pool while the
// gate is unbuilt. Because profitable lanes ~always exist, opportunistic divert-on-idle ~never fires; a
// dedicated hull guarantees the gate actually gets fed without taxing trade throughput. Accepts full
// symbols or dash-suffixes, e.g. GATE_HAULERS="SPACEJAM-DK-2-13,2-14" or "13,14". Once the gate is built
// (or gate-supply is off), the hauler rejoins normal trading; with no gate work right now, it parks ($0).
const GATE_HAULERS = new Set((process.env.GATE_HAULERS || '').split(',').map((s) => s.trim()).filter(Boolean));
const isGateHauler = (s) => { for (const h of GATE_HAULERS) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
// [ORPHAN GATE CARGO] A NON-hauler trade hull can end up holding gate materials (a restart preserved in-flight
// gate cargo via the salvage-guard, or a fill-bias top-up), but no role routes a non-hauler's gate cargo to the
// gate — so the hull strands with a full, unsellable hold (gate materials are GATE_PROTECTed from salvage).
// deliverOrphanGateCargo rescues it by the cheapest feasible means, priority order: (1) SELF fuel-aware multi-hop,
// (2) SELF + carried FUEL cargo across dry legs, (3) TRANSFER to a co-located gate hauler, (4) stage one hop
// toward the gate to meet a hauler / open a route next loop. ORPHAN_GATE_DELIVERY=0 disables; ORPHAN_MIN_UNITS is
// the smallest held quantity worth a dedicated run (a FULL hold always triggers — it can't trade anyway).
const ORPHAN_GATE_DELIVERY = process.env.ORPHAN_GATE_DELIVERY !== '0';
const ORPHAN_MIN_UNITS = Number(process.env.ORPHAN_MIN_UNITS || 5);
// [AUTO_EXPAND] YOLO inter-system expansion (default OFF). When the home gate is BUILT, migrate a hauler +
// light + idle probes through it and run inter-system arbitrage. Instantiated in main() (needs runtime
// closures over gateCache/cachedCredits/etc.). With the flag off, `expansion` stays null and nothing changes.
const AUTO_EXPAND = process.env.AUTO_EXPAND === '1';
let expansion = null;
let expansionTarget = CREDIT_TARGET || 8_000_000;             // recomputed live when DYNAMIC_TARGET
// Operating reserve = guesstimate of near-term needs: FUEL to keep the whole fleet
// moving + GOODS working capital (a cushion of cargo buys). Recomputed from the live
// fleet (changes over time). v2 should persist this time-series to the DB + refine via ML.
const GOODS_CUSHION = Number(process.env.GOODS_CUSHION || 300_000); // working capital for in-flight/next cargo buys
let OPERATING_RESERVE = Number(process.env.OPERATING_RESERVE || 200_000); // recomputed at startup from fleet
const NEGOTIATOR = process.env.NEGOTIATOR || 'SPACEJAM-DK-2-15';
const here = (p) => new URL(p, import.meta.url);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const now = () => Date.now();

const coords = {};
for (const l of fs.readFileSync(here('./coords.csv'), 'utf8').trim().split('\n').slice(1)) {
  const [w, x, y] = l.split(','); coords[w] = [+x, +y];
}
const D = (a, b) => (coords[a] && coords[b] ? Math.round(Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1])) : 1e9);
const MARKET_WPS = Object.keys(JSON.parse(fs.readFileSync(here('./markets.json'))));

// ---- flight-mode selection (calibrated coefficients) -----------------------
const TIME_FACTOR = { DRIFT: 250, CRUISE: 25, STEALTH: 30, BURN: 12.5 };
function legFuel(dist, mode) { return mode === 'DRIFT' ? 1 : mode === 'BURN' ? 2 * dist : dist; }
function legTime(dist, speed, mode) { return Math.round(dist * TIME_FACTOR[mode] / Math.max(1, speed)) + 15; }

// Live fuel price: 1 market unit of FUEL = 100 ship-fuel, so per-unit cost = purchasePrice/100.
// Sampled across all markets (median is robust to one outlier pump). Falls back to last value if
// no market sells fuel this cycle. Keeps routeCost/chooseMode honest as fuel prices drift.
function computeFuelPx(markets) {
  const px = [];
  for (const m of Object.values(markets)) for (const g of m.tradeGoods || [])
    if (g.symbol === 'FUEL' && g.purchasePrice > 0) px.push(g.purchasePrice);
  if (!px.length) return FUEL_PX;                 // keep prior value if none sell fuel now
  px.sort((a, b) => a - b);
  return px[Math.floor(px.length / 2)] / 100;     // median market price → per-ship-fuel-unit cost
}

// Pick the cheapest feasible mode by total cost = fuelCredits + time×valueOfTime.
// Feasible = leg fuel fits the ship's tank (we refuel to full at every dock).
function chooseMode(dist, ship) {
  const cap = ship.fuel.capacity || 0;
  const speed = ship.engine?.speed || 15;
  if (cap === 0) return { mode: 'CRUISE', fuel: 0, time: legTime(dist, speed, 'CRUISE') }; // probes: free fuel
  const cands = [];
  for (const mode of ['CRUISE', 'BURN', 'DRIFT']) {
    const fuel = legFuel(dist, mode);
    if (fuel > cap * 0.97) continue;                // 3% margin: avoid brim-full legs (coords/rounding drift)
    const time = legTime(dist, speed, mode);
    const cost = fuel * FUEL_PX + time * VALUE_OF_TIME;
    cands.push({ mode, fuel, time, cost });
  }
  if (!cands.length) return { mode: 'DRIFT', fuel: 1, time: legTime(dist, speed, 'DRIFT') };
  cands.sort((a, b) => a.cost - b.cost);
  return cands[0];
}

// ---- shared market cache ----------------------------------------------------
let marketCache = { at: 0, data: {} };
let refreshing = null;
async function getMarkets() {
  if (now() - marketCache.at < MARKET_TTL_MS) return marketCache.data;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const out = {};
    for (const wp of MARKET_WPS) { try { out[wp] = (await api('GET', `/systems/${SYSTEM}/waypoints/${wp}/market`)).data; } catch {} }
    marketCache = { at: now(), data: out };
    FUEL_PX = computeFuelPx(out);  // refresh live fuel price (no hardcode) for routeCost/chooseMode/reserve
    fs.writeFileSync(here('./markets.json'), JSON.stringify(out));
    appendMarketHistory(out);     // time-series price/supply per good → recovery model (DB in v2)
    updateBaselines(out);         // refresh per-good margin baseline for adaptive cooldown
    refreshing = null;
    return out;
  })();
  return refreshing;
}

// --- adaptive per-good cooldown (SYMMETRIC: lean into thick margins, back off thin) ---
// Reference = each good's *typical* margin (EMA), so current can be above OR below it:
//   current > typical (thick/recovered) → shorter cooldown → trade it more, capitalize.
//   current < typical (thin/depleted)   → longer cooldown  → let it recover.
// Self-correcting: leaning into a thick good depletes it → margin drops below typical → cooldown re-extends.
const COOLDOWN_MAX_MULT = Number(process.env.COOLDOWN_MAX_MULT || 4);     // thin goods rest up to 4× base
const COOLDOWN_MIN_MULT = Number(process.env.COOLDOWN_MIN_MULT || 0.33);  // thick goods rest as little as 1/3 base
const COOLDOWN_FLOOR_MS = Number(process.env.COOLDOWN_FLOOR_MS || 60_000);// never below this
const EMA_ALPHA = 0.2;
const goodEMA = new Map();        // sym -> EMA of best margin (typical)
let lastMargins = {};             // sym -> current best margin
function goodMargins(markets) {
  const goods = {};
  for (const [wp, m] of Object.entries(markets)) for (const g of m.tradeGoods || []) (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  const cur = {};
  for (const [sym, es] of Object.entries(goods)) {
    let best = 0;
    for (const b of es) for (const s of es)
      if (s.sellPrice > b.purchasePrice && b.purchasePrice > 0 && D(b.wp, s.wp) <= MAXD) best = Math.max(best, s.sellPrice - b.purchasePrice);
    cur[sym] = best;
  }
  return cur;
}
function updateBaselines(markets) {
  lastMargins = goodMargins(markets);
  for (const [sym, m] of Object.entries(lastMargins)) {
    if (m <= 0) continue;
    goodEMA.set(sym, goodEMA.has(sym) ? goodEMA.get(sym) * (1 - EMA_ALPHA) + m * EMA_ALPHA : m);
  }
}
function cooldownFor(sym) {
  const typical = goodEMA.get(sym) || 0, cur = lastMargins[sym] ?? typical;
  if (typical <= 0 || cur <= 0) return COOLDOWN_MS;
  const mult = Math.min(COOLDOWN_MAX_MULT, Math.max(COOLDOWN_MIN_MULT, typical / cur)); // thick→<1, thin→>1
  return Math.max(COOLDOWN_FLOOR_MS, Math.round(COOLDOWN_MS * mult));
}

// --- observation history (local JSONL now; v2 persists to DB for ML) --------
function appendMarketHistory(markets) {
  const t = new Date().toISOString();
  const rows = [];
  for (const [wp, m] of Object.entries(markets))
    for (const g of m.tradeGoods || [])
      rows.push(JSON.stringify({ t, wp, sym: g.symbol, type: g.type, buy: g.purchasePrice, sell: g.sellPrice, tv: g.tradeVolume, supply: g.supply, activity: g.activity }));
  if (rows.length) fs.appendFileSync(here('./market-history.jsonl'), rows.join('\n') + '\n');
}
function appendTradeObs(obs) {
  fs.appendFileSync(here('./trade-observations.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...obs }) + '\n');
}

function buildLanes(markets) {
  const goods = {};
  for (const [wp, m] of Object.entries(markets))
    for (const g of m.tradeGoods || []) (goods[g.symbol] = goods[g.symbol] || []).push({ wp, ...g });
  // [FAB GUARD] waypoints that PRODUCE still-needed gate materials — never source profit lanes out of these
  // (would spike the gate). Completed materials are excluded so their producers/co-products trade freely again.
  const activeMats = activeGateMaterials();
  const protectedWps = new Set();
  if (GATE_PROTECT) for (const mat of activeMats) { const w = findProducerWp(markets, mat); if (w) protectedWps.add(w); }
  const best = {};
  for (const [sym, entries] of Object.entries(goods)) {
    if (GATE_PROTECT && activeMats.has(sym)) continue;                       // never profit-trade a still-needed gate material
    for (const b of entries) for (const s of entries) {
      if (GATE_PROTECT && protectedWps.has(b.wp)) continue;                   // don't buy OUT OF a gate-material producer market
      if (s.sellPrice <= b.purchasePrice || b.purchasePrice <= 0) continue;
      const dist = D(b.wp, s.wp); if (dist > MAXD) continue;
      const units = Math.min(Math.min(b.tradeVolume, s.tradeVolume), 20);
      const margin = s.sellPrice - b.purchasePrice;
      const gross = margin * units;
      if (gross < MIN_NET) continue;
      if (!best[sym] || gross > best[sym].gross)
        best[sym] = { sym, buyWp: b.wp, buy: b.purchasePrice, sellWp: s.wp, sell: s.sellPrice, margin, units, dist, gross };
    }
  }
  return Object.values(best);
}

// [MULTI-GOOD] Plan zero-detour ride-along buys for a chosen lane: goods sold at lane.buyWp that also sink
// profitably at lane.sellWp. Greedy by per-lot gross, one tradeVolume lot each (avoids slippage), bounded
// by remaining cargo space and cash budget. Returns [{ sym, buy, sell, margin, tv, units }].
function planRideAlongs(markets, lane, freeUnits, cashBudget, excludeSyms = null) {
  if (!MULTI_GOOD || freeUnits <= 0 || cashBudget <= 0) return [];
  const src = markets[lane.buyWp], dst = markets[lane.sellWp];
  if (!src || !dst) return [];
  // [GATE PROTECT] Never source ride-alongs out of a gate-material producer market (depleting it drives the
  // gate material's price up). Trade lanes already exclude producer sources upstream, so this only guards the
  // contract caller (whose source is chosen separately).
  if (GATE_PROTECT && gateProducerWps(markets).has(lane.buyWp)) return [];
  const dstSell = {};
  for (const g of dst.tradeGoods || []) dstSell[g.symbol] = g;
  const activeMats = activeGateMaterials();
  const cands = [];
  for (const g of src.tradeGoods || []) {
    if (g.symbol === lane.sym || !(g.purchasePrice > 0)) continue;
    if (excludeSyms && excludeSyms.has(g.symbol)) continue;                 // [DEDUP] don't stack onto goods already aboard
    if (GATE_PROTECT && activeMats.has(g.symbol)) continue;                 // never ride-along a still-needed gate material
    const d = dstSell[g.symbol];
    if (!d || !(d.sellPrice > 0)) continue;
    const margin = d.sellPrice - g.purchasePrice;
    if (margin <= 0) continue;
    const tv = Math.min(g.tradeVolume || 20, d.tradeVolume || 20);
    cands.push({ sym: g.symbol, buy: g.purchasePrice, sell: d.sellPrice, margin, tv });
  }
  cands.sort((a, b) => b.margin * Math.min(b.tv, freeUnits) - a.margin * Math.min(a.tv, freeUnits));
  const picks = [];
  let space = freeUnits, cash = cashBudget;
  for (const c of cands) {
    if (space <= 0 || cash <= 0) break;
    const aff = Math.floor(cash / Math.max(1, c.buy * SLIPPAGE_FACTOR));
    const units = Math.min(space, c.tv, aff);          // one trade-volume lot keeps each buy off the slippage curve
    if (units <= 0) continue;
    if (c.margin * units < RIDEALONG_MIN_GROSS) continue;
    picks.push({ ...c, units });
    space -= units;
    cash -= Math.ceil(units * c.buy * SLIPPAGE_FACTOR);
  }
  return picks;
}

// ---- shared scheduler state -------------------------------------------------
const goodState = new Map();   // sym -> { lockedBy, cooldownUntil, deadStreak }
const gs = (sym) => { if (!goodState.has(sym)) goodState.set(sym, { lockedBy: null, cooldownUntil: 0, deadStreak: 0 }); return goodState.get(sym); };
// [B] Persist cumulative run stats across restarts. In-memory counters reset on every boot,
// so a crash-restart loop (e.g. the overnight power outage) looked like a profit FLATLINE even
// while trading continued. Reload prior totals on start so the tracker shows true lifetime net.
const RUN_STATS = here('./run-stats.json');
let totalNet = 0, lanesRun = 0;
try { const s = JSON.parse(fs.readFileSync(RUN_STATS, 'utf8')); totalNet = s.totalNet || 0; lanesRun = s.lanesRun || 0; log(`↺ resumed run stats: +${totalNet.toLocaleString()} over ${lanesRun} lanes`); } catch {}
function persistRunStats() { try { fs.writeFileSync(RUN_STATS, JSON.stringify({ totalNet, lanesRun, updated: new Date().toISOString() })); } catch {} }

// [RECOVERY] Per-ship INTENT, persisted so a crash/STOP/Docker-kill mid-haul can be resumed instead
// of stranding cargo (and losing its cost basis → corrupting net). Written at the buy→sell transition,
// cleared on sell/abort. On boot, reconcileHeldCargo() replays the SELL leg with the saved cost basis,
// or salvage-sells anything held with no usable intent. This closes the power-loss failure mode.
const INTENTS = here('./intents.json');
let intents = {};
try { intents = JSON.parse(fs.readFileSync(INTENTS, 'utf8')); if (Object.keys(intents).length) log(`↺ resumed ${Object.keys(intents).length} ship intent(s)`); } catch {}
function persistIntents() { try { fs.writeFileSync(INTENTS, JSON.stringify(intents, null, 1)); } catch {} }
function saveIntent(shipSym, intent) { intents[shipSym] = { ...intent, at: new Date().toISOString() }; persistIntents(); }
function clearIntent(shipSym) { if (intents[shipSym]) { delete intents[shipSym]; persistIntents(); } }
// [D] Speed-matched assignment: far fat lanes are reserved for fast hulls so a slow shuttle
// can't tie one up while the frigate idles. Set from the live fleet at startup.
let fleetMaxSpeed = 36;
const SPEED_FAR_DIST = Number(process.env.SPEED_FAR_DIST || 250);
// [C] Dead-lane feedback: a lane that returns net<=0 or buys 0 units (price already moved /
// depleted) is penalized so ships stop re-picking it. Escalates on repeats.
const DEAD_LANE_PENALTY = Number(process.env.DEAD_LANE_PENALTY || 3);
const perShip = {};

// ---- operating budget (concurrency-safe) -----------------------------------
// cachedCredits refreshed periodically; `committed` tracks in-flight buy cost so
// concurrent ships don't oversubscribe cash. Working buys may only use funds
// above OPERATING_RESERVE. growthBudget() = what's free for ships/gate/expansion.
let cachedCredits = 0;
let committed = 0;
const availableForWork = () => cachedCredits - committed - OPERATING_RESERVE;
const growthBudget = () => Math.max(0, cachedCredits - committed - OPERATING_RESERVE);
function commit(amount) { committed += amount; }
function uncommit(amount) { committed = Math.max(0, committed - amount); }
async function refreshCredits() { try { cachedCredits = (await api('GET', '/my/agent')).data.credits; } catch {} }

// Recompute the operating reserve from the live fleet: fuel to fully top off every
// hull (keep everyone moving) + a goods working-capital cushion. Guesstimate; v2 will
// refine from observed fuel burn + lane buy-cost distributions and store the series in DB.
async function recomputeReserve() {
  try {
    const ships = await getAllShips();
    const fuelReserve = ships.reduce((a, s) => a + (s.fuel?.capacity || 0), 0) * FUEL_PX; // one full fleet refuel
    OPERATING_RESERVE = Math.round(fuelReserve + GOODS_CUSHION);
  } catch {}
}

// Dynamic goal = the actual COST TO EXPAND (not a magic number):
//   operating reserve + gate build (remaining materials × slippage + dedicated haulers) + seed a new-system cell.
// When credits clear this, we have enough surplus (above working capital) to fund expansion.
let targetBreakdown = {};
// [A] FAIL-SAFE gate status. The original initialized gateBuilt=true and swallowed fetch
// errors, so an outage made the construction fetch throw → goal collapsed to ~1.1M → a phantom
// EXPANSION-READY stopped the bot. Now: default UNBUILT, remember the last KNOWN status, and
// never let an UNKNOWN status collapse the goal or authorize a stop (see targetWatch gate).
let gateKnown = false;
let lastGate = { gateBuilt: false, gateCost: 0, gateUnits: 0 };
// [GATE] Live construction-site cache (populated by computeExpansionTarget each cycle) + in-memory
// per-material unit reservations so concurrently-idle ships split the remaining materials instead of
// all hauling the same one. The server snapshot (every 30s) is authoritative and reconciles other
// agents' contributions; supply trips also patch `remaining`/`built` immediately on success.
let gateCache = { exists: false, wp: null, built: false, remaining: {}, known: false };
// [FAB GUARD] The gate materials the build STILL needs (remaining > 0). The static GATE_PROTECT_MATERIALS list
// also carries already-COMPLETED materials (e.g. ADVANCED_CIRCUITRY once its quota is filled). Guarding a
// completed material's producer/inputs needlessly blocks unrelated trades — e.g. ELECTRONICS (a D43 input for
// ADVANCED_CIRCUITRY) gets locked out of contracts long after the circuitry is done. Guard only what's still
// needed vs the market. Unknown gate state → protect all (safe default); built → protect nothing.
function activeGateMaterials() {
  if (!GATE_PROTECT) return new Set();
  if (!gateCache.known || !gateCache.exists) return new Set(GATE_PROTECT_MATERIALS);
  if (gateCache.built) return new Set();
  return new Set([...GATE_PROTECT_MATERIALS].filter((m) => (gateCache.remaining[m] || 0) > 0));
}
const gateClaims = new Map();   // tradeSymbol -> units reserved by in-flight supply trips
const gateActiveSuppliers = new Set();   // shipSyms currently on a gate-supply trip (concurrency cap)
const inputActiveFeeders = new Set();    // shipSyms currently on an input-feed trip (concurrency cap)
const inputActiveProducers = new Set();  // [GUARDRAIL] producerWps with a feeder EN ROUTE — 1 feeder/producer so our own concurrent sells can't crash its import price (the cause of the prior feed loss)

// [INPUT_FEED] Active only while we're feeding an unbuilt gate (Phase 4 accelerator turned on).
function inputFeedActive() { return INPUT_FEED && gateSupplyActive(); }

// [PHASE] Strategy phases (greenfield → open portal). Order = progression. The active phase is computed
// by determinePhase() from live signals; it labels the run and drives the gate/fill levers via
// gateSupplyActive() so behavior and the reported phase can never diverge. It does NOT change ranking.
const PHASES = {
  BOOTSTRAP:      { n: 0, name: 'BOOTSTRAP',      desc: 'map markets + run starter contracts' },
  PROFIT:         { n: 1, name: 'PROFIT',         desc: 'grow fleet, run best net/min lanes (multi-route/ride-along)' },
  GATE_DISCOVERY: { n: 2, name: 'GATE_DISCOVERY', desc: 'gate site found — awareness only (supply disabled)' },
  GATE_SUPPLY:    { n: 3, name: 'GATE_SUPPLY',    desc: 'producer-only gate feed, capped + fill/drop-off bias' },
  INPUT_FEED:     { n: 4, name: 'INPUT_FEED',     desc: 'overlap: feed producer inputs to restock the long pole' },
  PORTAL_OPEN:    { n: 5, name: 'PORTAL_OPEN',    desc: 'gate built → seed the next system cell' },
};
let fleetSize = 0;                 // active traders (set in main)
let currentPhase = PHASES.BOOTSTRAP;

// Canonical "are we actively supplying the gate?" predicate = the GATE_SUPPLY phase condition. The gate
// levers (sink waypoints, supply trips) read from this so the live behavior and the reported phase agree.
function gateSupplyActive() {
  return GATE_SUPPLY && gateCache.exists && !gateCache.built && gateCache.known;
}

// [GATE] Hysteresis latch for the credit floor. HARD stop at GATE_CREDIT_FLOOR; only RESUME once credits
// recover to GATE_CREDIT_RESUME. Between the two thresholds we hold the previous state (the deadband), which
// kills the at-floor sawtooth and lets buying run in sustained bursts. Updated each loop from cachedCredits.
let gateBuyPaused = false;
function gateCreditOk() {
  const was = gateBuyPaused;
  if (cachedCredits < GATE_CREDIT_FLOOR) gateBuyPaused = true;              // hard stop: arm the latch
  else if (cachedCredits >= GATE_CREDIT_RESUME) gateBuyPaused = false;     // recovered past resume band: release
  if (was !== gateBuyPaused) {
    if (gateBuyPaused) log(`💰 gate-buy PAUSED — credits ${Math.round(cachedCredits).toLocaleString()} < floor ${GATE_CREDIT_FLOOR.toLocaleString()} (rebuild to ${GATE_CREDIT_RESUME.toLocaleString()} to resume)`);
    else log(`💰 gate-buy RESUMED — credits ${Math.round(cachedCredits).toLocaleString()} ≥ resume ${GATE_CREDIT_RESUME.toLocaleString()} (buy down to floor ${GATE_CREDIT_FLOOR.toLocaleString()})`);
  }
  return !gateBuyPaused;
}

// Derive the strategy phase purely from live state. No side effects; progression-ordered.
function determinePhase() {
  const marketKnown = !!(marketCache && marketCache.data && Object.keys(marketCache.data).length);
  if (!marketKnown || fleetSize < BOOTSTRAP_FLEET_MIN) return PHASES.BOOTSTRAP;
  const g = gateCache;
  if (g.known && g.exists && g.built) return PHASES.PORTAL_OPEN;
  if (gateSupplyActive()) return INPUT_FEED ? PHASES.INPUT_FEED : PHASES.GATE_SUPPLY;
  if (g.known && g.exists && !g.built) return PHASES.GATE_DISCOVERY; // discovered but supply disabled
  return PHASES.PROFIT;
}
async function computeExpansionTarget(markets) {
  let gateCost = 0, gateUnits = 0, gateBuilt = false, fetched = false;
  try {
    const gsd = (await api('GET', `/systems/${SYSTEM}/waypoints?limit=20&type=JUMP_GATE`)).data;
    const gateWp = gsd[0]?.symbol;
    if (gateWp) {
      const cs = (await api('GET', `/systems/${SYSTEM}/waypoints/${gateWp}/construction`)).data;
      gateBuilt = cs.isComplete;
      const remaining = {};
      if (!gateBuilt) for (const m of cs.materials || []) {
        const need = m.required - m.fulfilled; if (need <= 0) continue;
        remaining[m.tradeSymbol] = need;
        gateUnits += need;
        const src = cheapestSrc(markets, m.tradeSymbol);
        gateCost += need * (src ? src.px : 1000) * SLIPPAGE_FACTOR;
      }
      gateCache = { exists: true, wp: gateWp, built: gateBuilt, remaining, known: true };
      fetched = true;
    } else {
      gateCache = { exists: false, wp: null, built: false, remaining: {}, known: true };
    }
  } catch (e) { log(`⚠ gate status fetch failed (${e.message}) — NOT collapsing goal`); }

  if (!fetched && !gateKnown) {
    // Unknown and never confirmed: hold the current goal (do not collapse), block any stop.
    targetBreakdown = { ...targetBreakdown, gateBuilt: null, gateStatusKnown: false };
    return expansionTarget;
  }
  if (!fetched) ({ gateBuilt, gateCost, gateUnits } = lastGate);  // reuse last KNOWN status
  else { gateKnown = true; lastGate = { gateBuilt, gateCost, gateUnits }; }

  let haulerCost = 0, nHaul = 0;
  if (!gateBuilt) {
    const loads = Math.ceil(gateUnits / 80);
    // No off-ship storage exists in SpaceTraders → ships ARE the warehouse. These dedicated
    // hulls store (accumulate-the-dip) AND supply the gate; they are a MANDATORY expansion cost.
    nHaul = Math.min(3, Math.max(1, Math.round(loads / 8)));
    haulerCost = nHaul * HAULER_PRICE;
  }
  const target = Math.round(OPERATING_RESERVE + gateCost + haulerCost + NEW_CELL_SEED);
  targetBreakdown = { reserve: OPERATING_RESERVE, gateMaterials: Math.round(gateCost), storageSupplyShips: haulerCost, storageSupplyShipCount: nHaul, seedNewCell: NEW_CELL_SEED, gateBuilt, gateStatusKnown: true, total: target };
  return target;
}

// [FILL-BIAS] Waypoints whose drop-off helps the gate: the EXPORT producers of still-needed gate
// materials. Selling a profitable lane INTO one of these (i.e. delivering an input it imports) restocks
// the gate material there. Empty while the gate is built/unknown/off, so the bias self-disables.
function gateSinkWaypoints(markets) {
  const set = new Set();
  const g = gateCache;
  if (!gateSupplyActive()) return set;
  const needed = Object.keys(g.remaining || {});
  if (!needed.length) return set;
  for (const [wp, m] of Object.entries(markets)) {
    for (const tg of m.tradeGoods || []) {
      if (tg.type === 'EXPORT' && needed.includes(tg.symbol)) { set.add(wp); break; }
    }
  }
  return set;
}

// Atomically (no await between check and set) claim the best AFFORDABLE lane.
// Scores every lane (incl. outer) on true net/min using refuel-aware multi-hop routing,
// so a fat outer trade can win over a thin cluster one — no hard distance cap. A detour-free
// fill/drop-off tie-breaker then re-ranks lanes within FILL_BIAS_EPS of the best (see FILL_BIAS).
function claimLane(ship, lanes, markets) {
  const cand = [];
  for (const l of lanes) {
    const st = gs(l.sym);
    if (st.lockedBy || now() < st.cooldownUntil) continue;       // locked or cooling down
    const estCost = Math.ceil(l.units * l.buy * 1.1);            // buy cost + slippage headroom
    if (estCost > availableForWork()) continue;                  // would breach operating reserve
    const repo = routeCost(ship.nav.waypointSymbol, l.buyWp, ship);
    const haul = routeCost(l.buyWp, l.sellWp, ship);
    const fuelCr = repo.fuelCr + haul.fuelCr;
    const timeS = repo.timeS + haul.timeS + 30;
    const net = l.gross - fuelCr;
    if (net <= 0) continue;                                      // travel ate the margin
    let score = net / (timeS / 60);                              // net per minute, full round-trip-aware
    // [D] Far lanes favor fast hulls: discount a far lane's score for slow ships so the frigate
    // wins it on contention. Near lanes are unaffected (slow shuttles keep working the cluster).
    if (l.dist > SPEED_FAR_DIST) score *= (ship.engine?.speed || fleetMaxSpeed) / fleetMaxSpeed;
    cand.push({ l, score, estCost, net });
  }
  if (!cand.length) return null;

  // [FILL-BIAS] Pick the top-scoring lane, but break near-ties toward fuller hold + gate-helpful drop-off.
  let chosen;
  if (FILL_BIAS && cand.length > 1) {
    const top = Math.max(...cand.map((c) => c.score));
    const band = cand.filter((c) => c.score >= top * (1 - FILL_BIAS_EPS));
    const sinks = gateSinkWaypoints(markets);
    const cap = ship.cargo?.capacity || 0;
    for (const c of band) {
      const primary = Math.min(c.l.units, cap);
      let rideUnits = 0;
      if (cap > primary) for (const p of planRideAlongs(markets, c.l, cap - primary, growthBudget())) rideUnits += p.units;
      const fillFrac = cap > 0 ? (primary + rideUnits) / cap : 0;          // 0..1 projected hold utilisation
      const dropoff = sinks.has(c.l.sellWp) ? GATE_DROPOFF_WEIGHT : 0;     // delivery restocks a gate material
      c.bias = fillFrac + dropoff;
    }
    band.sort((a, b) => (b.bias - a.bias) || (b.score - a.score));         // fuller/gate-helpful first, score breaks ties
    chosen = band[0];
  } else {
    cand.sort((a, b) => b.score - a.score);
    chosen = cand[0];
  }

  const best = chosen.l, bestScore = chosen.score, bestCost = chosen.estCost, bestProjected = chosen.net;
  if (PARK_MIN_NET > 0 && bestProjected < PARK_MIN_NET) return { park: true, score: bestScore, projectedNet: bestProjected }; // best lane too thin → park
  gs(best.sym).lockedBy = ship.symbol;                            // lock synchronously
  commit(bestCost);                                               // reserve the cash synchronously
  return { lane: best, score: bestScore, cost: bestCost, projectedNet: bestProjected };
}

// ---- contract pipeline (serial, single-claim) ------------------------------
let contractClaim = null;        // {id,good,dest,units} awaiting a freighter
let contractWorkingId = null;    // id currently being executed by ONE freighter (prevents dup-claim race)
let activeContractInfo = null;   // {id,good,dest,units,pay} of the current active contract (for deliver-what-you-hold)
let contractOwner = null;        // {id, ship}: the ONE ship currently committed to sourcing/hauling this contract
const contractFails = new Map(); // id -> failure count (abandon after MAX_CONTRACT_FAILS)
const MAX_CONTRACT_FAILS = 3;
// [CONTRACT] Contracts run on whatever ship is best-positioned, NOT a single pinned hull. Any eligible freighter
// may claim the active contract, but only when it's actually worth it FROM THAT SHIP'S POSITION — gated by an
// efficiency check (see contractWorthIt): the cheapest source must be within CONTRACT_MAX_SRC_DIST and the trip
// must net positive (don't fly across the system to source a thin-margin good). The first ship that passes the
// gate becomes the contractOwner and keeps chipping (partial delivery OK) until fulfilled; everyone else trades.
// CONTRACT_RUNNER (optional) restricts eligibility to specific hulls; empty = any freighter (cargo >= 40).
const CONTRACT_RUNNER = new Set((process.env.CONTRACT_RUNNER || '').split(',').map((s) => s.trim()).filter(Boolean));
const isContractRunner = (s) => { for (const h of CONTRACT_RUNNER) { if (s === h || s.endsWith('-' + h)) return true; } return false; };
const CONTRACT_MAX_SRC_DIST = Number(process.env.CONTRACT_MAX_SRC_DIST || 500);   // don't source a contract good if the cheapest market is farther than this from the ship
const CONTRACT_MIN_MARGIN = Number(process.env.CONTRACT_MIN_MARGIN || 1000);      // require at least this net (payout - source cost - est. fuel) before claiming
// [CONTRACT BUFFER] Also require net ≥ this FRACTION of the onFulfilled payout, so we don't pounce the instant a
// contract is barely profitable — we wait for the source price to drop a bit more and bank a slight profit.
// Scales with contract size (a flat floor would block small contracts). Effective floor = max(abs, pct×onFulfilled).
const CONTRACT_MIN_MARGIN_PCT = Number(process.env.CONTRACT_MIN_MARGIN_PCT || 0.04);
const CONTRACT_FUEL_PX = Number(process.env.CONTRACT_FUEL_PX || 2);               // rough credits per fuel unit (~distance) for the profitability estimate
const DBG_CONTRACT = process.env.DEBUG_CONTRACT === '1';                          // verbose per-ship contract-gate decisions
// [CONTRACT FORCE] Goods listed here bypass the MARGIN gate (still distance-gated to avoid a cross-galaxy DRIFT) —
// used to clear an already-accepted contract whose source price spiked: the onAccepted payment is banked, so
// fulfilling at a small marginal sourcing loss is still net-positive overall AND frees the one-contract slot.
const CONTRACT_FORCE = new Set((process.env.CONTRACT_FORCE || '').split(',').map((s) => s.trim()).filter(Boolean));
// [CONTRACT AUTO-FORCE] A "dud" contract (payout so low that net < the margin floor for every ship) is never claimed,
// so it wedges the single contract slot until its deadline — blocking ALL new (often lucrative) contracts for days.
// To self-heal that, if the active contract goes CONTINUOUSLY unclaimed (no owner) for this many minutes, we auto-add
// its id to the forced set: the margin gate is then bypassed (same banked-onAccepted logic as a manual CONTRACT_FORCE)
// so the closest eligible hull sources & fulfills it to free the slot. 0 disables (manual CONTRACT_FORCE only).
const CONTRACT_AUTOFORCE_MINS = Number(process.env.CONTRACT_AUTOFORCE_MINS || 20);
const contractAutoForced = new Set();          // contract ids auto-forced after sitting unclaimed past the grace window
let contractWedge = { id: null, since: 0 };    // tracks how long the current contract has gone continuously unowned
// A contract bypasses the margin gate if its good is manually forced OR it was auto-forced after wedging.
const isForced = (ci) => CONTRACT_FORCE.has(ci.good) || contractAutoForced.has(ci.id);
// [CONTRACT] Best-ship election. Instead of latching the FIRST hull that happens to pass the gate (often a far,
// slow ship), pick the AVAILABLE hull CLOSEST to the cheapest source — so idle/unused ships near the source do
// the work. "Available" = not a dedicated gate/feed/mining hull, empty hold, not mid-transit, eligible (cargo
// ≥ 40 or a CONTRACT_RUNNER), within CONTRACT_MAX_SRC_DIST, and the trip clears the margin floor. We also
// RE-ELECT away from an owner that hasn't sourced yet (cargo empty of the good) when a meaningfully closer idle
// ship exists — but never yank an owner already CARRYING the contract good (mid-haul). Set =0 for legacy first-come.
const CONTRACT_BEST_SHIP = process.env.CONTRACT_BEST_SHIP !== '0';
const CONTRACT_REELECT_MARGIN = Number(process.env.CONTRACT_REELECT_MARGIN || 40);  // only switch owners if a candidate is closer to source by > this (dist units)

// [FUEL_CARGO] Contract sourcing range check. Legacy: straight-line distance must be ≤ CONTRACT_MAX_SRC_DIST.
// With FUEL_CARGO on, a farther source still counts as reachable when a refuel-aware route gets there within
// CONTRACT_MAX_HOPS — either the tank-only multi-hop route (planRoute, refuels at fuel markets) or, failing that,
// the fuel-in-cargo route (planRouteFuelCargo, bridges dry legs from carried fuel). The profitability (net-margin)
// gate still applies and is costed on the real route, so this only ADMITS far runs that are actually worth it.
function contractSrcReachable(here, srcWp, fuelCap, markets) {
  if (D(here, srcWp) <= CONTRACT_MAX_SRC_DIST) return true;
  if (!FUEL_CARGO) return false;
  const tank = planRoute(here, srcWp, fuelCap, markets);
  if (tank && tank.length <= CONTRACT_MAX_HOPS) return true;
  const fc = planRouteFuelCargo(here, srcWp, fuelCap, markets);
  return !!(fc && fc.length <= CONTRACT_MAX_HOPS);
}

// [CONTRACT] Elect the best available hull to source `ci` — the eligible, idle, empty hull CLOSEST to the
// cheapest source that still clears the margin floor. Returns { ship, src, dist } or null when none qualify.
function electContractOwner(ci, markets, ships) {
  const src = cheapestContractSrc(markets, ci.good, ci.dest);
  if (!src || src.wp === ci.dest) return null;
  const gateHaulPinned = GATE_SUPPLY && gateCache.exists && !gateCache.built;
  let best = null;
  for (const s of ships) {
    const sym = s.symbol;
    if (sym === NEGOTIATOR) continue;
    if (gateHaulPinned && isGateHauler(sym)) continue;            // pinned to the gate
    if (inputFeedActive() && isInputFeeder(sym)) continue;         // pinned to feeding
    if (MINE_FEED && !gateCache.built && mineRoleOf(s)) continue;  // pinned to the mining colony
    const eligible = CONTRACT_RUNNER.size ? isContractRunner(sym) : ((s.cargo?.capacity || 0) >= 40);
    if (!eligible) continue;
    if (s.nav?.status === 'IN_TRANSIT') continue;                  // busy moving — not "idle/unused"
    if ((s.cargo?.units || 0) > 0) continue;                       // carrying cargo — leave it on its lane
    const here = s.nav?.waypointSymbol;
    const dist = D(here, src.wp);
    if (!contractSrcReachable(here, src.wp, s.fuel?.capacity || 0, markets)) continue;
    if (!isForced(ci)) {                                           // forced clears skip the margin gate
      const units = Math.min(ci.units, s.cargo.capacity);
      // far runs are multi-hop → cost fuel on the real refuel-aware route, not the straight line
      const fuelCr = (FUEL_CARGO && dist > CONTRACT_MAX_SRC_DIST)
        ? routeCost(here, src.wp, s).fuelCr + routeCost(src.wp, ci.dest, s).fuelCr
        : (dist + D(src.wp, ci.dest)) * CONTRACT_FUEL_PX;
      const net = (ci.pay || 0) - units * src.px - fuelCr;
      const minMargin = Math.max(CONTRACT_MIN_MARGIN, Math.round(CONTRACT_MIN_MARGIN_PCT * (ci.pay || 0)));
      if (net < minMargin) continue;
    }
    // closest wins; tie-break larger capacity, then faster engine
    const score = dist * 1000 - (s.cargo.capacity || 0) - (s.engine?.speed || 0) * 0.001;
    if (!best || score < best.score) best = { ship: sym, src, dist, score };
  }
  return best;
}

async function contractManager() {
  while (!stop) {
    try {
      const cs = await getAllContracts();
      const active = cs.find((c) => c.accepted && !c.fulfilled);
      if (active) {
        const d = active.terms.deliver[0];
        const remaining = d.unitsRequired - d.unitsFulfilled;
        activeContractInfo = { id: active.id, good: d.tradeSymbol, dest: d.destinationSymbol, units: remaining, pay: active.terms.payment.onFulfilled };
        if (contractOwner && contractOwner.id !== active.id) contractOwner = null;   // a new contract → release the prior owner
      } else {
        activeContractInfo = null;
        contractOwner = null;
        // First adopt any already-negotiated-but-UNACCEPTED offer. A restart between negotiate (below) and accept
        // strands the offer accepted=false; the API then refuses a NEW negotiation with "already has an active
        // contract", so the bot loops forever and contracts wedge. Accepting the pending offer self-heals that.
        const pending = cs.find((c) => !c.accepted && !c.fulfilled
          && (!c.deadlineToAccept || Date.parse(c.deadlineToAccept) > Date.now()));
        if (pending) {
          await api('POST', `/my/contracts/${pending.id}/accept`);
          const d = pending.terms.deliver[0];
          log(`📜 adopted unaccepted contract ${pending.id}: ${d.unitsRequired} ${d.tradeSymbol} -> ${d.destinationSymbol} pay ${pending.terms.payment.onAccepted + pending.terms.payment.onFulfilled}`);
          activeContractInfo = { id: pending.id, good: d.tradeSymbol, dest: d.destinationSymbol, units: d.unitsRequired - d.unitsFulfilled, pay: pending.terms.payment.onFulfilled };
        } else if (!contractWorkingId) {
          // Negotiate the next contract whenever no freighter is mid-delivery. (We intentionally do NOT gate on
          // contractClaim here: contractClaim's only consumer, tryClaimContract, is disabled, so a stale claim would
          // otherwise permanently block negotiation — the bug that stalled contracts after 00:54.)
          const r = await api('POST', `/my/ships/${NEGOTIATOR}/negotiate/contract`);
          const c = r.data.contract; await api('POST', `/my/contracts/${c.id}/accept`);
          const d = c.terms.deliver[0];
          log(`📜 contract ${c.id}: ${d.unitsRequired} ${d.tradeSymbol} -> ${d.destinationSymbol} pay ${c.terms.payment.onAccepted + c.terms.payment.onFulfilled}`);
          activeContractInfo = { id: c.id, good: d.tradeSymbol, dest: d.destinationSymbol, units: d.unitsRequired - d.unitsFulfilled, pay: c.terms.payment.onFulfilled };
        }
      }
    } catch (e) { log('contractManager:', e.message); }
    // [CONTRACT] Best-ship election: assign / re-assign the active contract to the idle hull closest to the
    // cheapest source. Runs centrally each cycle so a far/slow first-claimer doesn't latch a slow fill.
    try {
      if (CONTRACT_BEST_SHIP && activeContractInfo && activeContractInfo.units > 0) {
        const markets = await getMarkets();
        const ships = await getAllShips();
        const ci = activeContractInfo;
        const ownerShip = contractOwner && contractOwner.id === ci.id
          ? ships.find((s) => s.symbol === contractOwner.ship) : null;
        const ownerHasGood = ownerShip ? cargoUnits(ownerShip, ci.good) > 0 : false;
        // Don't disturb an owner that's already CARRYING the contract good (mid-haul). Otherwise (no owner, or an
        // owner that hasn't sourced yet) elect the closest idle hull and switch only if it's meaningfully closer.
        if (!ownerHasGood) {
          const pick = electContractOwner(ci, markets, ships);
          if (pick) {
            const ownerDist = ownerShip
              ? D(ownerShip.nav?.waypointSymbol, pick.src.wp) : Infinity;
            const switching = !contractOwner || contractOwner.id !== ci.id
              || (contractOwner.ship !== pick.ship && pick.dist + CONTRACT_REELECT_MARGIN < ownerDist);
            if (switching) {
              const prev = contractOwner?.ship;
              contractOwner = { id: ci.id, ship: pick.ship };
              if (prev !== pick.ship)
                log(`🎯 contract ${ci.good} → ${pick.ship.slice(-3)} (idle, ${pick.dist} from src ${pick.src.wp.slice(-3)}${prev ? `, was ${prev.slice(-3)}@${Number.isFinite(ownerDist) ? ownerDist : '?'}` : ''})`);
            }
          }
        }
      }
    } catch (e) { log('contractElect:', e.message); }
    // [CONTRACT AUTO-FORCE] Detect a wedged "dud" contract: it has stayed continuously unowned (nobody passed the
    // margin gate) for CONTRACT_AUTOFORCE_MINS. Once past the grace window, auto-force it so the closest hull sources
    // & fulfills it — banking the onAccepted payment and freeing the single slot for the next (often lucrative) one.
    try {
      const ci = activeContractInfo;
      if (CONTRACT_AUTOFORCE_MINS > 0 && ci && ci.units > 0) {
        const claimed = contractOwner && contractOwner.id === ci.id;   // some hull is committed to it
        if (claimed || isForced(ci)) {
          contractWedge = { id: null, since: 0 };                      // progressing or already forced → not wedged
        } else if (contractWedge.id !== ci.id) {
          contractWedge = { id: ci.id, since: Date.now() };            // first cycle we've seen it unclaimed → start clock
        } else if (Date.now() - contractWedge.since >= CONTRACT_AUTOFORCE_MINS * 60_000) {
          contractAutoForced.add(ci.id);
          contractWedge = { id: null, since: 0 };
          log(`⚡ auto-force contract ${ci.id.slice(-6)} ${ci.good}→${ci.dest.slice(-3)} pay ${ci.pay}: unclaimed ${CONTRACT_AUTOFORCE_MINS}min (all ships THIN/busy) → margin gate bypassed to free the slot`);
        }
      }
    } catch (e) { log('contractAutoForce:', e.message); }
    await sleep(20_000);
  }
}

// One freighter atomically claims the queued contract (no other ship can take it).
function tryClaimContract(ship, markets) {
  if (!contractClaim || contractWorkingId || ship.cargo.capacity < 80) return null;
  const c = contractClaim;
  const src = cheapestContractSrc(markets, c.good, c.dest);
  if (!src || c.units > ship.cargo.capacity) return null;
  contractClaim = null;             // dequeue
  contractWorkingId = c.id;         // lock: only this freighter works it now
  return { ...c, src: src.wp, px: src.px };
}

function cheapestSrc(markets, good, excludeWps = null) {
  let wp, px = Infinity, tv = 0;
  for (const [w, m] of Object.entries(markets)) {
    if (excludeWps && excludeWps.has(w)) continue;
    const g = (m.tradeGoods || []).find((x) => x.symbol === good);
    if (g && g.purchasePrice > 0 && g.purchasePrice < px) { px = g.purchasePrice; wp = w; tv = g.tradeVolume || 0; }
  }
  return wp ? { wp, px, tv } : null;
}

// [FAB GUARD / CONTRACT] The waypoints that PRODUCE still-NEEDED gate materials (their EXPORT markets). Excludes
// producers of already-completed materials so their markets/co-products are tradeable again.
function gateProducerWps(markets) {
  const set = new Set();
  if (GATE_PROTECT) for (const mat of activeGateMaterials()) { const w = findProducerWp(markets, mat); if (w) set.add(w); }
  return set;
}

// [FAB GUARD / CONTRACT] Cheapest source for a CONTRACT good, honoring CONTRACT_AVOID_GATE_PRODUCER: if the good
// is a gate material OR an input a gate-material producer IMPORTS to make that material, skip the gate-producer
// markets and return the next-cheapest source. Falls back to the unrestricted cheapest only if NOTHING else
// sells it (so a contract is never made unsourceable by the guard — better to overpay once than DRIFT/forfeit).
function cheapestContractSrc(markets, good, dest = null) {
  if (!CONTRACT_AVOID_GATE_PRODUCER || !GATE_PROTECT) return cheapestSrc(markets, good);
  const producers = gateProducerWps(markets);
  if (!producers.size) return cheapestSrc(markets, good);
  // Is `good` a still-needed gate material or one of those producers' imported inputs?
  let guarded = activeGateMaterials().has(good);
  if (!guarded) for (const wp of producers) {
    const m = markets[wp]; if (!m) continue;
    if ((m.tradeGoods || []).some((g) => g.symbol === good && g.type === 'IMPORT')) { guarded = true; break; }
  }
  if (!guarded) return cheapestSrc(markets, good);
  const guardedSrc = cheapestSrc(markets, good, producers);
  // Usable only if it exists AND isn't the delivery point itself (can't "haul" from dest to dest — that path is
  // rejected upstream, which would otherwise strand the contract). When unusable, fall back to the producer.
  if (guardedSrc && (!dest || guardedSrc.wp !== dest)) {
    const raw = cheapestSrc(markets, good);
    if (DBG_CONTRACT && raw && raw.wp !== guardedSrc.wp)
      log(`ctrG ${good} skip producer ${raw.wp.slice(-3)}@${raw.px} → ${guardedSrc.wp.slice(-3)}@${guardedSrc.px} (FAB GUARD)`);
    return guardedSrc;
  }
  // Guard left no haulable option (only the producer sells it, or the only alternative IS the delivery point) —
  // buy from the producer as a last resort rather than forfeit the contract.
  const fallback = cheapestSrc(markets, good);
  if (DBG_CONTRACT && fallback)
    log(`ctrG ${good} LAST-RESORT buy producer ${fallback.wp.slice(-3)}@${fallback.px} (no other haulable source)`);
  return fallback;
}

// [CONTRACT] Efficiency gate: is it worth THIS ship sourcing the contract good from where it stands? Returns the
// plan {src, units, net} when worthwhile, else null. Enforces the user's rule — don't fly across the system to
// source a thin-margin good: the cheapest market must be within CONTRACT_MAX_SRC_DIST, and payout must beat
// source cost + a rough fuel estimate by CONTRACT_MIN_MARGIN. Only relevant when the ship still needs to SOURCE.
function contractWorthIt(shipSym, ship, ci, markets) {
  const src = cheapestContractSrc(markets, ci.good, ci.dest);
  if (!src || src.wp === ci.dest) { if (DBG_CONTRACT) log(`ctr? ${shipSym.slice(-3)} ${ci.good} NO-SRC (src=${src?.wp || 'none'} dest=${ci.dest})`); return null; }
  const here = ship.nav.waypointSymbol;
  const srcLeg = D(here, src.wp);
  if (!contractSrcReachable(here, src.wp, ship.fuel?.capacity || 0, markets)) { if (DBG_CONTRACT) log(`ctr? ${shipSym.slice(-3)} ${ci.good} TOO-FAR srcLeg=${srcLeg} (${here.slice(-3)}→${src.wp.slice(-3)}) cap=${CONTRACT_MAX_SRC_DIST}${FUEL_CARGO ? ' (no fuel-route ≤'+CONTRACT_MAX_HOPS+' hops)' : ''}`); return null; }
  const units = Math.min(ci.units, ship.cargo.capacity);
  const tripDist = srcLeg + D(src.wp, ci.dest);
  // far runs are multi-hop → cost fuel on the real refuel-aware route, not the straight line
  const fuelCr = (FUEL_CARGO && srcLeg > CONTRACT_MAX_SRC_DIST)
    ? routeCost(here, src.wp, ship).fuelCr + routeCost(src.wp, ci.dest, ship).fuelCr
    : tripDist * CONTRACT_FUEL_PX;
  const net = (ci.pay || 0) - units * src.px - fuelCr;
  // Buffer: hold out for a slight profit (don't claim at bare breakeven). Floor scales with contract size.
  const minMargin = Math.max(CONTRACT_MIN_MARGIN, Math.round(CONTRACT_MIN_MARGIN_PCT * (ci.pay || 0)));
  if (net < minMargin) { if (DBG_CONTRACT) log(`ctr? ${shipSym.slice(-3)} ${ci.good} THIN net=${Math.round(net)} < floor ${minMargin} (pay=${ci.pay} cost=${units * src.px} src=${src.wp.slice(-3)}@${src.px} units=${units})`); return null; }
  if (DBG_CONTRACT) log(`ctr✓ ${shipSym.slice(-3)} ${ci.good} net=${Math.round(net)} (floor ${minMargin}) src=${src.wp.slice(-3)}@${src.px} units=${units}`);
  return { src, units, net };
}

// [CONTRACT] Source the active contract good from the cheapest market, haul it to the delivery point, deliver
// PARTIAL (the API accumulates unitsFulfilled across visits), fulfill when complete. The FIRST eligible ship that
// passes contractWorthIt() becomes the contractOwner and keeps chipping each loop until done; other ships skip.
// Returns false when there's no active contract, the ship isn't the owner, or it isn't worth sourcing from here —
// so the ship falls through to normal trading instead of being pinned to a far/unprofitable contract.
async function contractRunnerTrip(shipSym, ship, markets) {
  const ci = activeContractInfo;
  if (!ci || ci.units <= 0) { if (DBG_CONTRACT && ship.cargo.capacity >= 40) log(`ctr? ${shipSym.slice(-3)} no-active-contract (ci=${ci ? ci.good + ':' + ci.units : 'null'})`); return false; }
  if (contractOwner && contractOwner.id === ci.id && contractOwner.ship !== shipSym) return false;  // another ship owns it
  let have = cargoUnits(ship, ci.good);
  const preElected = contractOwner && contractOwner.id === ci.id && contractOwner.ship === shipSym;
  // If we were pre-elected but are still carrying OTHER (trade) cargo, finish/sell that lane first — don't pile
  // contract goods on top of unsold cargo. Keep ownership; we'll source once the hold is clear.
  if (preElected && have <= 0 && (ship.cargo.units || 0) > 0) {
    if (DBG_CONTRACT) log(`ctr… ${shipSym.slice(-3)} elected but holding ${ship.cargo.units} other cargo → sell first`);
    return false;
  }
  // Claim/gate: if we don't already hold the good, only commit when it's worth sourcing from our position.
  if (have <= 0 && !(contractOwner && contractOwner.ship === shipSym)) {
    if (isForced(ci)) {
      // forced clear: ignore the margin floor, but still avoid a cross-galaxy DRIFT (require a near source).
      const src = cheapestContractSrc(markets, ci.good, ci.dest);
      if (!src || src.wp === ci.dest || !contractSrcReachable(ship.nav.waypointSymbol, src.wp, ship.fuel?.capacity || 0, markets)) return false;
      if (DBG_CONTRACT) log(`ctr⚡ ${shipSym.slice(-3)} FORCE ${ci.good} src ${src.wp.slice(-3)}@${src.px} (margin gate bypassed)`);
    } else {
      const plan = contractWorthIt(shipSym, ship, ci, markets);
      if (!plan) return false;                                  // not worth it from here → trade instead
    }
  }
  contractOwner = { id: ci.id, ship: shipSym };               // we own it now (persists across loops until fulfilled)
  contractWorkingId = ci.id;                                  // lock out the legacy opportunistic claimer this loop
  const cap = ship.cargo.capacity;
  const want = Math.min(ci.units, cap);                       // fill up to remaining-or-capacity
  let rideAlongs = [], rideCommitted = 0;                     // [MULTI-GOOD] spare-hold cargo riding source→dest
  try {
    // 1) source more if we have room and still need it (fresh market read)
    if (have < want) {
      const fresh = await getMarkets();
      const src = cheapestContractSrc(fresh, ci.good, ci.dest);
      if (src && src.wp !== ci.dest) {
        await haulGoTo(shipSym, src.wp, fresh, { reserveUnits: want - have });   // far source → fuel-in-cargo bridge; keep room for the buy
        if (FUEL_CARGO) await shedSpareFuel(shipSym);                            // reclaim slots from any leftover carried fuel before sourcing
        // Re-check ownership AFTER the (possibly long, multi-hop) sourcing leg. The central election may have
        // reassigned this contract to a closer idle hull while we traveled (this ship set itself owner before the
        // trip, but contractManager can overwrite it). If we're empty AND no longer the owner, don't double-buy —
        // bail back to trading and let the elected owner source. (We never abandon goods already aboard.)
        if (have <= 0 && contractOwner && contractOwner.id === ci.id && contractOwner.ship !== shipSym) {
          if (DBG_CONTRACT) log(`ctr↩ ${shipSym.slice(-3)} de-elected mid-source (now ${contractOwner.ship.slice(-3)}) → skip buy`);
          return false;
        }
        perShip[shipSym].last = `CONTRACT src ${ci.good}@${src.wp.slice(-3)}`;
        try { await buy(shipSym, ci.good, want - have, Math.round(src.px * 2)); } catch (e) { log(`${shipSym.slice(-3)} contract source ERR ${e.message}`); }
        const sourced = await getShip(shipSym);
        have = cargoUnits(sourced, ci.good);
        // [MULTI-GOOD] The contract rarely fills the hold (e.g. 18 units in a cap-80 hull). While we're standing
        // at the source, fill the spare hold with profitable goods that also sink at the contract DESTINATION —
        // the trip is already paid for by the contract, so these ride for free. Sold at ci.dest after delivery.
        if (CONTRACT_RIDEALONG && have > 0) {
          let free = cap - (sourced.cargo.units || have);
          if (free > 0) {
            // [DEDUP] Exclude everything already aboard (the contract good + any residual cargo) so a ride-along
            // never stacks onto held cargo. planRideAlongs caps each good to ONE tradeVolume lot the destination
            // actually buys, so we never over-buy past what fits, what we can afford, or what the sink absorbs.
            const heldSyms = new Set((sourced.cargo.inventory || []).map((i) => i.symbol));
            const laneLike = { sym: ci.good, buyWp: src.wp, sellWp: ci.dest };
            for (const p of planRideAlongs(fresh, laneLike, free, growthBudget(), heldSyms)) {
              if (free <= 0) break;                                    // hold full — stop (defensive double-bound)
              const units = Math.min(p.units, free);
              if (units <= 0) continue;
              try {
                const rb = await buy(shipSym, p.sym, units, Math.round(p.buy * (1 + SLIPPAGE_FACTOR)));
                if (rb.bought > 0) { commit(rb.spent || 0); rideCommitted += rb.spent || 0; rideAlongs.push({ good: p.sym, units: rb.bought, costBasis: rb.spent || 0 }); free -= rb.bought; heldSyms.add(p.sym); }
              } catch (e) { log(`${shipSym.slice(-3)} contract ride-along ${p.sym} ERR ${e.message}`); }
            }
            if (rideAlongs.length) log(`＋ ${shipSym.slice(-3)} contract ride-along ${rideAlongs.map((r) => `${r.units} ${r.good}`).join(', ')} → ${ci.dest.slice(-3)}`);
          }
        }
      }
    }
    if (have <= 0) { perShip[shipSym].last = `CONTRACT ${ci.good} (no source now)`; await sleep(IDLE_WAIT_MS); return true; }
    // 2) haul to the delivery point and deliver what we have (partial OK)
    perShip[shipSym].last = `CONTRACT ${ci.good} ${have}u→${ci.dest.slice(-3)}`;
    await haulGoTo(shipSym, ci.dest, marketCache.data || {});   // spare slots (after the contract good + ride-alongs) carry bridging fuel
    // [MULTI-GOOD] Sell the ride-alongs here (their shared sink) regardless of the contract's outcome below.
    if (rideAlongs.length) {
      let rideNet = 0;
      for (const r of rideAlongs) {
        try { const rs = await sell(shipSym, r.good); rideNet += (rs.got || 0) - (r.costBasis || 0); }
        catch (e) { log(`${shipSym.slice(-3)} contract ride-along sell ${r.good} ERR ${e.message}`); }
      }
      uncommit(rideCommitted); rideCommitted = 0;
      record(shipSym, Math.round(rideNet), `ride-along×${rideAlongs.length}→${ci.dest.slice(-3)}`);
      rideAlongs = [];
    }
    // Re-validate the contract is still open BEFORE delivering. Another ship may have fulfilled it (or it may have
    // been replaced) while we hauled the long multi-hop. Delivering to a fulfilled/closed contract throws 400 in a
    // loop; instead release ownership and hold the cargo for reconcile/orphan salvage on the next pass.
    const cPre = (await getAllContracts()).find((x) => x.id === ci.id);
    if (!cPre || cPre.fulfilled || !cPre.accepted) {
      if (DBG_CONTRACT) log(`ctr↩ ${shipSym.slice(-3)} contract ${ci.id.slice(-6)} already closed → holding ${have} ${ci.good} for salvage`);
      if (contractOwner && contractOwner.id === ci.id && contractOwner.ship === shipSym) contractOwner = null;
      return false;
    }
    await deliver(shipSym, ci.id, ci.good, have);
    log(`📦 ${shipSym.slice(-3)} delivered ${have} ${ci.good} → contract ${ci.id.slice(-6)}`);
    // 3) fulfilled? collect the payout
    const c = (await getAllContracts()).find((x) => x.id === ci.id);
    const d = c && c.terms.deliver[0];
    if (d && d.unitsFulfilled >= d.unitsRequired) {
      await fulfill(shipSym, ci.id);
      record(shipSym, 0, `CONTRACT ${ci.good} ✓`);
      log(`✔ ${shipSym.slice(-3)} fulfilled contract ${ci.good}`);
      activeContractInfo = null;                               // let contractManager negotiate the next one
      contractOwner = null;                                    // release ownership for the next contract
    } else if (d) {
      activeContractInfo = { ...ci, units: d.unitsRequired - d.unitsFulfilled };   // refresh remaining
    }
  } catch (e) {
    log(`${shipSym.slice(-3)} contract-runner ERR ${e.message}`);
  } finally {
    if (rideCommitted) uncommit(rideCommitted);                  // release any unsold ride-along reservation
    contractWorkingId = null;
  }
  return true;
}

// Highest-sellPrice market for a good — used to salvage-sell recovered cargo at the best sink.
function bestSink(markets, good) {
  let wp, px = -Infinity;
  for (const [w, m] of Object.entries(markets)) {
    const g = (m.tradeGoods || []).find((x) => x.symbol === good);
    if (g && g.sellPrice > px) { px = g.sellPrice; wp = w; }
  }
  return wp ? { wp, px } : null;
}

// [GATE] One opportunistic gate-supply trip for an otherwise-idle hull: pick the neediest material
// with unreserved demand + a known market source, buy what fits (capped so credits never fall below
// GATE_CREDIT_FLOOR), haul it to the construction site, and POST it to construction/supply. Patches
// the live gateCache on success. Returns true if it ran (caller should `continue`), false to fall
// through to normal idle/park. Never sells anything — pure expansion contribution (supply pays $0).
// [GATE] Pure fill planner: cheapest basket of still-needed gate materials across ALL source markets,
// greedily filling `free` cargo (cheapest units first) until full or credit headroom is exhausted. Each
// buy is capped by the source market's tradeVolume; pricey markets (> cheapest×ceil per material) are
// skipped so we only buy when it's cheap. Returns [{ sym, wp, units, px }] spanning markets/materials.
// [GATE PRICE PATIENCE] Per capped material state machine. ABOVE cap → 'paused'. On the drop back UNDER the cap we
// enter 'settling' and hold buys for GATE_PRICE_SETTLE_MS, tracking the low; we resume ('normal') once the price
// rebounds >GATE_PRICE_REBOUND_EPS off that low (it bottomed) or the window elapses. A good never paused stays
// 'normal' (buys immediately). Monotonic, so concurrent per-ship calls converge. Note: only advances while
// planGateFill runs (i.e. credits >= floor); in practice credits recover before a spiked good cools to its cap.
const gatePxState = {}; // sym -> { state:'paused'|'settling'|'normal', since, low }
function gateBuyAllowed(sym, curMinPx, cap) {
  if (!cap || !(GATE_PRICE_SETTLE_MS > 0)) return !cap ? true : curMinPx <= cap;   // patience off → cap is a hard line
  const st = gatePxState[sym] || (gatePxState[sym] = { state: 'normal' });
  if (curMinPx > cap) { st.state = 'paused'; return false; }
  if (st.state === 'paused') { st.state = 'settling'; st.since = Date.now(); st.low = curMinPx; log(`gate ${sym} dropped under cap ${cap} @${curMinPx} → settling (watch for a lower entry)`); return false; }
  if (st.state === 'settling') {
    st.low = Math.min(st.low, curMinPx);
    const waited = Date.now() - st.since >= GATE_PRICE_SETTLE_MS;
    const rebounded = curMinPx > st.low * (1 + GATE_PRICE_REBOUND_EPS);
    if (waited || rebounded) { st.state = 'normal'; log(`gate ${sym} price settled @${curMinPx} (low ${st.low}, ${rebounded ? 'rebounded' : 'timeout'}) → resuming buys`); return true; }
    return false;
  }
  return true;
}

function planGateFill(remaining, claims, markets, { free, headroom, slippage, ceilFactor, absMax = {} }) {
  if (free <= 0 || headroom <= 0) return [];
  const minPx = {};
  const opts = [];
  for (const [sym, need] of Object.entries(remaining)) {
    const open = need - (claims.get(sym) || 0);
    if (open <= 0) continue;
    for (const [wp, m] of Object.entries(markets)) {
      const gg = (m.tradeGoods || []).find((x) => x.symbol === sym);
      if (!gg || !(gg.purchasePrice > 0)) continue;
      // Only buy from PRODUCERS: EXPORT markets make the good (price reflects production), EXCHANGE is
      // neutral. IMPORT markets are CONSUMERS (e.g. A4 imports ADVANCED_CIRCUITRY to make ANTIMATTER) —
      // their listed purchasePrice is a wrong-direction/scarce price, so never source the gate there.
      if (gg.type !== 'EXPORT' && gg.type !== 'EXCHANGE') continue;
      opts.push({ sym, wp, px: gg.purchasePrice, tv: gg.tradeVolume || 0 });
      if (minPx[sym] === undefined || gg.purchasePrice < minPx[sym]) minPx[sym] = gg.purchasePrice;
    }
  }
  const capOK = {};
  for (const sym of Object.keys(minPx)) capOK[sym] = gateBuyAllowed(sym, minPx[sym], absMax[sym]);
  const cheap = opts.filter((o) => o.px <= (minPx[o.sym] ?? o.px) * ceilFactor && (!absMax[o.sym] || (o.px <= absMax[o.sym] && capOK[o.sym]))).sort((a, b) => a.px - b.px);
  const buys = [];
  const planned = {};
  let f = free, h = headroom;
  for (const o of cheap) {
    if (f <= 0 || h <= 0) break;
    const open = (remaining[o.sym] || 0) - (claims.get(o.sym) || 0) - (planned[o.sym] || 0);
    if (open <= 0) continue;
    const unitCost = o.px * slippage;
    const affordable = Math.floor(h / Math.max(1, unitCost));
    const cap = o.tv > 0 ? o.tv : f;
    const units = Math.min(f, cap, open, affordable);
    if (units <= 0) continue;
    buys.push({ sym: o.sym, wp: o.wp, units, px: o.px });
    planned[o.sym] = (planned[o.sym] || 0) + units;
    f -= units; h -= Math.ceil(units * unitCost);
  }
  return buys;
}

// [GATE_FUEL_CARGO] Drive a gate-bound hull to `dest`, using carried FUEL to bridge dry legs when that saves a
// fuel-market detour. Returns true if it took the ship to dest (caller skips its own goTo); false → caller should
// goTo normally. Only ever uses cargo slots left free AFTER the material buy, and only diverts when it cuts a hop.
async function goToWithFuelCargo(shipSym, dest, markets, opts = {}) {
  let ship = await getShip(shipSym);
  const origin = ship.nav.waypointSymbol;
  if (origin === dest && ship.nav.status !== 'IN_TRANSIT') return true;   // already at the destination
  const cap = ship.fuel.capacity || 0;
  if (cap <= 0) return false;                                             // probes / fuel-less hulls
  if (D(origin, dest) <= Math.floor(cap * 0.97)) return false;           // one-tank leg → carrying fuel adds nothing
  // Where can we LOAD fuel into the hold? The current waypoint if it sells fuel; otherwise the nearest fuel-selling
  // node within one tank. This lets a freshly-bought colony hull sitting at a fuel-less shipyard hop to an adjacent
  // fuel market, top tank + cargo, then bridge a long dry leg to the mine/asteroid instead of a multi-hour DRIFT.
  const sellsFuel = (wp) => { const m = markets[wp]; return !!(m && (m.tradeGoods || []).find((g) => g.symbol === 'FUEL')); };
  let loadWp = origin;
  if (!sellsFuel(origin)) {
    let best = null, bd = Infinity;
    for (const f of fuelNodes(markets)) { if (!coords[f] || f === origin) continue; const d = D(origin, f); if (d <= Math.floor(cap * 0.97) && d < bd) { bd = d; best = f; } }
    if (!best) return false;                                              // no fuel within range → let normal detour/DRIFT handle it
    loadWp = best;
  }
  const tankPath = planRoute(loadWp, dest, cap, markets);                 // tank-only route from the load point
  const fcPath = planRouteFuelCargo(loadWp, dest, cap, markets);          // bridge dry legs with carried fuel
  if (!fcPath) return false;
  if (tankPath && fcPath.length >= tankPath.length) return false;        // no hop saved → not worth the slots
  if (loadWp !== origin) await goTo(shipSym, loadWp);                      // hop to the fuel market first (within one tank)
  const from = (await getShip(shipSym)).nav.waypointSymbol;               // now at the load point
  const mk = markets[from];
  const fuelGood = mk && (mk.tradeGoods || []).find((g) => g.symbol === 'FUEL');
  if (!fuelGood) return false;                                            // can't buy fuel here → let normal detour handle it
  try { await refuel(shipSym); } catch {}                                 // top the tank from the market first (no slots used)
  ship = await getShip(shipSym);
  const reserve = Math.max(0, opts.reserveUnits || 0);                    // slots to keep free for goods picked up later / at the destination
  const free = ship.cargo.capacity - (ship.cargo.units || 0) - reserve;
  if (free <= 0) return false;                                            // no spare slots after the goods → normal detour
  // Fuel needed beyond a full tank, in cargo units (1 FUEL cargo unit ≈ 100 tank), + 1 per extra hop for refuel rounding.
  const totalDist = fcPath.reduce((s, wp, i) => s + D(i === 0 ? from : fcPath[i - 1], wp), 0);
  const minNeed = Math.ceil(Math.max(0, totalDist - Math.floor(cap * 0.97)) / 100);
  const want = minNeed + Math.max(0, fcPath.length - 1);
  if (minNeed <= 0) return false;
  const carry = Math.min(want, free);
  if (carry < minNeed) return false;                                      // not enough spare slots to bridge → normal detour
  try { await buy(shipSym, 'FUEL', carry, Math.round((fuelGood.purchasePrice || 500) * 2)); }
  catch (e) { log(`⛽ ${shipSym.slice(-3)} fuel-cargo buy ERR: ${e.message}`); return false; }
  log(`⛽ ${shipSym.slice(-3)} carrying ${carry} FUEL to bridge ${from.slice(-3)}→${dest.slice(-3)} via ${fcPath.map((p) => p.slice(-3)).join('→')} (${fcPath.length} hops vs ${tankPath ? tankPath.length : '∞'} tank-only)`);
  await haulWithFuelCargo(shipSym, fcPath);
  return true;
}
// Gate-haul wrapper: fuel-cargo route when enabled + beneficial, else the normal refuel-hop goTo.
async function gateGoTo(shipSym, dest, markets) {
  if ((GATE_FUEL_CARGO || FUEL_CARGO) && await goToWithFuelCargo(shipSym, dest, markets)) return;
  await goTo(shipSym, dest);
}
// Universal haul wrapper: any trade/contract leg that should use fuel-in-cargo when FUEL_CARGO is on. `opts.reserveUnits`
// keeps that many slots free for goods to be loaded at/after the destination (so fuel never crowds out cargo).
async function haulGoTo(shipSym, dest, markets, opts = {}) {
  if (FUEL_CARGO && await goToWithFuelCargo(shipSym, dest, markets, opts)) return;
  await goTo(shipSym, dest);
}

async function gateSupplyTrip(shipSym, ship, markets) {
  const g = gateCache;
  if (!gateSupplyActive()) return false;
  if (!gateCreditOk()) {
    // Buying is paused by the credit-floor hysteresis. But if we're ALREADY holding still-needed gate material
    // (bought before the pause), DELIVER it — supplying is free, advances the gate, and frees the hauler instead
    // of stranding bought cargo in its hold. Only BUYING is throttled by the floor, never delivery.
    const heldNeeded = (ship.cargo.inventory || []).filter((i) => GATE_PROTECT_MATERIALS.has(i.symbol) && (g.remaining?.[i.symbol] > 0) && i.units > 0);
    if (heldNeeded.length) {
      perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
      const tot = heldNeeded.reduce((s, i) => s + i.units, 0);
      perShip[shipSym].last = `SUPPLY_GATE(held) ${tot}u`;
      log(`⛏ ${shipSym.slice(-3)} delivering held ${tot}u [${heldNeeded.map((i) => `${i.units} ${i.symbol}`).join(', ')}] → ${g.wp.slice(-3)} (buy paused)`);
      await gateGoTo(shipSym, g.wp, markets);
      await supplyHeldToGate(shipSym, heldNeeded.map((i) => i.symbol));
      return true;
    }
    return false;
  }
  // Concurrency cap: throttle simultaneous gate-supply trips so heavy pulling doesn't spike the producer's
  // price. Dedicated GATE_HAULERS bypass the cap; opportunistic idle hulls are limited to GATE_MAX_SUPPLIERS.
  if (!isGateHauler(shipSym) && !gateActiveSuppliers.has(shipSym) && gateActiveSuppliers.size >= GATE_MAX_SUPPLIERS) return false;

  let free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (GATE_SUPPLY_MAX_UNITS > 0) free = Math.min(free, GATE_SUPPLY_MAX_UNITS);
  const buys = planGateFill(g.remaining, gateClaims, markets, {
    free,
    headroom: cachedCredits - GATE_CREDIT_FLOOR,
    slippage: SLIPPAGE_FACTOR,
    ceilFactor: GATE_PRICE_CEIL_FACTOR,
    absMax: GATE_MAX_PRICE,
  });
  if (!buys.length) {
    // No new buys (price-capped / unaffordable). If we're still holding needed gate material, deliver it rather
    // than stranding it; otherwise nothing to do.
    const heldNeeded = (ship.cargo.inventory || []).filter((i) => GATE_PROTECT_MATERIALS.has(i.symbol) && (g.remaining?.[i.symbol] > 0) && i.units > 0);
    if (heldNeeded.length) {
      perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
      const tot = heldNeeded.reduce((s, i) => s + i.units, 0);
      perShip[shipSym].last = `SUPPLY_GATE(held) ${tot}u`;
      log(`⛏ ${shipSym.slice(-3)} delivering held ${tot}u [${heldNeeded.map((i) => `${i.units} ${i.symbol}`).join(', ')}] → ${g.wp.slice(-3)} (no new buys)`);
      await gateGoTo(shipSym, g.wp, markets);
      await supplyHeldToGate(shipSym, heldNeeded.map((i) => i.symbol));
      return true;
    }
    return false;
  }

  // Reserve planned units per material so other idle/hauler ships pick different work.
  const reserved = {};
  for (const b of buys) reserved[b.sym] = (reserved[b.sym] || 0) + b.units;
  for (const [sym, u] of Object.entries(reserved)) gateClaims.set(sym, (gateClaims.get(sym) || 0) + u);
  gateActiveSuppliers.add(shipSym);   // count toward the concurrency cap for the duration of this trip

  const total = buys.reduce((s, b) => s + b.units, 0);
  perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
  perShip[shipSym].last = `SUPPLY_GATE ${total}u`;
  log(`⛏ ${shipSym.slice(-3)} gate-fill ${total}u [${buys.map((b) => `${b.units} ${b.sym}@${b.wp.slice(-3)}`).join(', ')}] → ${g.wp.slice(-3)} (credits ${cachedCredits.toLocaleString()})`);
  try {
    // Visit each source market once (group buys by waypoint), then haul the basket to the gate.
    const byWp = {};
    for (const b of buys) (byWp[b.wp] ||= []).push(b);
    for (const [wp, list] of Object.entries(byWp)) {
      await goTo(shipSym, wp);                                        // refuel-hop to the source
      for (const b of list) {
        try { await buy(shipSym, b.sym, b.units, Math.round(b.px * (1 + SLIPPAGE_FACTOR))); }
        catch (e) { log(`${shipSym.slice(-3)} gate buy ERR ${b.units} ${b.sym}@${wp.slice(-3)}: ${e.message}`); }
      }
    }
    await gateGoTo(shipSym, g.wp, markets);                          // one trip to the gate (fuel-cargo when enabled+useful)
    try { await api('POST', `/my/ships/${shipSym}/dock`); } catch {}  // construction/supply requires DOCKED (goTo leaves us in orbit)
    const inv = (await api('GET', `/my/ships/${shipSym}`)).data.cargo.inventory;
    for (const sym of Object.keys(reserved)) {
      const have = inv.find((i) => i.symbol === sym)?.units || 0;
      if (have <= 0) continue;
      const r = await api('POST', `/systems/${SYSTEM}/waypoints/${g.wp}/construction/supply`, { shipSymbol: shipSym, tradeSymbol: sym, units: have });
      const m = (r.data.construction.materials || []).find((x) => x.tradeSymbol === sym);
      if (m) { const left = Math.max(0, m.required - m.fulfilled); if (left > 0) g.remaining[sym] = left; else delete g.remaining[sym]; }
      g.built = r.data.construction.isComplete || g.built;
      record(shipSym, 0, `SUPPLY_GATE ${sym} ${have}`);
      log(`⛏ ${shipSym.slice(-3)} supplied ${have} ${sym} → ${m ? `${m.fulfilled}/${m.required}` : 'ok'}${g.built ? ' 🎉 GATE COMPLETE' : ''}`);
    }
  } catch (e) {
    // On a mid-trip failure the materials stay aboard; reconcileHeldCargo will salvage-sell them next
    // loop (recovers the cash, forfeits that gate progress — acceptable, the server snapshot re-plans).
    log(`${shipSym} gate-supply ERR ${e.message}`);
  } finally {
    for (const [sym, u] of Object.entries(reserved)) gateClaims.set(sym, Math.max(0, (gateClaims.get(sym) || 0) - u));
    gateActiveSuppliers.delete(shipSym);
  }
  return true;
}

// [INPUT_FEED] Targets for the Phase 4 accelerator: the EXPORT producer(s) of still-needed gate materials,
// long-pole first (most units remaining), each paired with the inputs it IMPORTS. Feeding those inputs is
// what restocks the gate material at its source. Empty unless inputFeedActive().
function gateProducerInputTargets(markets) {
  const out = [];
  if (!inputFeedActive()) return out;
  const needed = Object.entries(gateCache.remaining || {}).sort((a, b) => b[1] - a[1]); // long pole first
  for (const [mat, remaining] of needed) {
    for (const [wp, m] of Object.entries(markets)) {
      const prod = (m.tradeGoods || []).find((x) => x.symbol === mat && x.type === 'EXPORT');
      if (!prod) continue;
      const inputs = (m.tradeGoods || []).filter((x) => x.type === 'IMPORT').map((x) => x.symbol);
      if (inputs.length) out.push({ producerWp: wp, material: mat, remaining, inputs });
    }
  }
  return out;
}

// [INPUT_FEED] Plan a profitable basket of a producer's imported inputs: for each input the producer buys
// (its IMPORT entry's sellPrice = what we receive), find the cheapest EXTERNAL producer source and keep it
// only if margin > 0. Greedy by per-lot gross, one tradeVolume lot each (off the slippage curve), bounded
// by free cargo + cash headroom. Returns [{ sym, srcWp, buyPx, sellPx, margin, tv, units }].
function planInputFeed(producerWp, inputs, markets, { free, headroom }) {
  if (free <= 0 || headroom <= 0) return [];
  const dst = markets[producerWp];
  if (!dst) return [];
  const dstBuy = {};
  for (const g of dst.tradeGoods || []) if (g.type === 'IMPORT') dstBuy[g.symbol] = g;
  const cands = [];
  for (const sym of inputs) {
    const d = dstBuy[sym];
    if (!d || !(d.sellPrice > 0)) continue;
    let bestSrc = null;
    for (const [wp, m] of Object.entries(markets)) {
      if (wp === producerWp) continue;
      const s = (m.tradeGoods || []).find((x) => x.symbol === sym && (x.type === 'EXPORT' || x.type === 'EXCHANGE'));
      if (!s || !(s.purchasePrice > 0)) continue;
      if (!bestSrc || s.purchasePrice < bestSrc.px) bestSrc = { wp, px: s.purchasePrice, tv: s.tradeVolume || 0 };
    }
    if (!bestSrc) continue;
    const margin = d.sellPrice - bestSrc.px;
    if (margin <= 0) continue;   // never feed at a loss — the accelerator must pay for itself
    const tv = Math.min(bestSrc.tv || 20, d.tradeVolume || 20);
    cands.push({ sym, srcWp: bestSrc.wp, buyPx: bestSrc.px, sellPx: d.sellPrice, margin, tv, scarce: SUPPLY_RANK[d.supply] ?? 2 });
  }
  // [INPUT_FEED] Scarcity-FIRST: feed the producer's SCARCEST inputs first (those throttle its output the
  // most). Only profitable inputs reach here, so this never trades a loss — it just rebalances WHICH input
  // we haul so we don't dump everything into the single highest-margin good (e.g. COPPER) and starve the
  // others (IRON/QUARTZ/SILICON). Tie-break by per-lot gross so among equally-scarce inputs we take the
  // most lucrative. As an input tiers up (SCARCE→LIMITED→…), it falls behind, so the feed rotates.
  cands.sort((a, b) => (a.scarce - b.scarce) || (b.margin * Math.min(b.tv, free) - a.margin * Math.min(a.tv, free)));
  const buys = [];
  let f = free, h = headroom;
  for (const c of cands) {
    if (f <= 0 || h <= 0) break;
    const aff = Math.floor(h / Math.max(1, c.buyPx * SLIPPAGE_FACTOR));
    const units = Math.min(f, c.tv, aff);
    if (units <= 0) continue;
    buys.push({ ...c, units });
    f -= units; h -= Math.ceil(units * c.buyPx * SLIPPAGE_FACTOR);
  }
  return buys;
}

// [INPUT_FEED] One profitable input-feed trip: source the long-pole producer's inputs across markets, haul
// them to the producer, and sell into its IMPORT market. Mirrors gateSupplyTrip's structure but RECORDS net
// (it's a profit lane) — the gate-acceleration is a free side effect. Returns true if it ran.
async function inputFeedTrip(shipSym, ship, markets) {
  if (!inputFeedActive()) return false;
  if (INPUT_FEED_GATE_PAUSE && !gateCreditOk()) return false;   // (opt-in) re-couple to the gate-buy floor + resume hysteresis
  if (availableForWork() < INPUT_FEED_MIN_CASH) return false;   // always respect OPERATING_RESERVE (+ optional cushion); profit-positive lane
  if (!isInputFeeder(shipSym) && !inputActiveFeeders.has(shipSym) && inputActiveFeeders.size >= INPUT_FEED_MAX) return false;
  const free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (free <= 0) return false;

  let chosen = null, plan = null;
  for (const t of gateProducerInputTargets(markets)) {
    if (inputActiveProducers.has(t.producerWp)) continue;   // [GUARDRAIL] 1 feeder per producer — never let two of our ships sell into the same import market at once
    const p = planInputFeed(t.producerWp, t.inputs, markets, { free, headroom: growthBudget() });
    const estNet = p.reduce((s, b) => s + b.margin * b.units, 0);
    if (p.length && estNet >= INPUT_FEED_MIN_GROSS) { chosen = t; plan = p; break; }
  }
  if (!chosen) return false;

  inputActiveFeeders.add(shipSym);
  inputActiveProducers.add(chosen.producerWp);   // [GUARDRAIL] reserve this producer for the duration of the trip
  const total = plan.reduce((s, b) => s + b.units, 0);
  const estNet = plan.reduce((s, b) => s + b.margin * b.units, 0);
  const estCost = plan.reduce((s, b) => s + Math.ceil(b.units * b.buyPx * SLIPPAGE_FACTOR), 0);
  perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
  perShip[shipSym].last = `FEED ${chosen.material} ${total}u→${chosen.producerWp.slice(-3)}`;
  perShip[shipSym].projected = estNet;
  log(`🏭 ${shipSym.slice(-3)} input-feed ${total}u [${plan.map((b) => `${b.units} ${b.sym}@${b.srcWp.slice(-3)}`).join(', ')}] → ${chosen.producerWp.slice(-3)} (feeds ${chosen.material}, est net +${Math.round(estNet).toLocaleString()})`);
  commit(estCost);
  let realized = 0, spentTotal = 0;
  const paid = {}, boughtUnits = {};   // [GUARDRAIL] per-good cost basis for the sell-time margin re-check
  try {
    const byWp = {};
    for (const b of plan) (byWp[b.srcWp] ||= []).push(b);
    for (const [wp, list] of Object.entries(byWp)) {
      await goTo(shipSym, wp);
      for (const b of list) {
        try {
          const r = await buy(shipSym, b.sym, b.units, Math.round(b.buyPx * (1 + SLIPPAGE_FACTOR)));
          spentTotal += r.spent || 0;
          paid[b.sym] = (paid[b.sym] || 0) + (r.spent || 0);
          boughtUnits[b.sym] = (boughtUnits[b.sym] || 0) + (r.bought || 0);
        }
        catch (e) { log(`${shipSym.slice(-3)} feed buy ERR ${b.units} ${b.sym}@${wp.slice(-3)}: ${e.message}`); }
      }
    }
    await goTo(shipSym, chosen.producerWp);
    // [GUARDRAIL] Sell-time margin re-check on FRESH producer data: the plan's margin was computed on a market
    // SNAPSHOT; re-fetch the producer's live IMPORT buy-prices right before selling. If a good's current buy
    // price has fallen below what we actually paid, HOLD it (leave aboard) instead of dumping at a loss —
    // reconcileHeldCargo salvages it at the best sink next loop. Net is computed over goods we actually sold.
    let fresh = null;
    try { fresh = (await api('GET', `/systems/${SYSTEM}/waypoints/${chosen.producerWp}/market`)).data; } catch {}
    const freshBuy = {};
    if (fresh) for (const g of fresh.tradeGoods || []) if (g.type === 'IMPORT') freshBuy[g.symbol] = g.sellPrice;
    let spentSold = 0;
    for (const b of plan) {
      const got = boughtUnits[b.sym] || 0;
      if (got <= 0) continue;
      const avgCost = (paid[b.sym] || 0) / got;
      const cur = fresh ? (freshBuy[b.sym] ?? 0) : null;   // null ⇒ refetch failed, fall back to selling
      if (cur != null && cur > 0 && cur * got < (paid[b.sym] || 0)) {
        log(`🛡️ ${shipSym.slice(-3)} HOLD ${b.sym}: producer buy ${cur} < cost ${Math.round(avgCost)} — salvaging later, not dumping at a loss`);
        continue;
      }
      try { const rs = await sell(shipSym, b.sym); realized += rs.got || 0; spentSold += paid[b.sym] || 0; }
      catch (e) { log(`${shipSym.slice(-3)} feed sell ERR ${b.sym}: ${e.message}`); }
    }
    const net = realized - spentSold;
    record(shipSym, net, `FEED ${chosen.material} inputs`);
    log(`🏭 ${shipSym.slice(-3)} fed ${chosen.material} producer ${chosen.producerWp.slice(-3)} net=${net.toLocaleString()}`);
  } catch (e) {
    // Mid-trip failure: inputs stay aboard; reconcileHeldCargo salvage-sells them next loop (recovers cash).
    log(`${shipSym} input-feed ERR ${e.message}`);
  } finally {
    uncommit(estCost);
    inputActiveFeeders.delete(shipSym);
    inputActiveProducers.delete(chosen.producerWp);   // [GUARDRAIL] release the producer reservation
    perShip[shipSym].projected = 0;
  }
  return true;
}

// ============================ [MINE_FEED] data-driven mining ============================
// F51's inputs and how we mine each. COMMON_METAL asteroids yield IRON_ORE/COPPER_ORE/ALUMINUM_ORE (mixed →
// we refine the F51-relevant ones, ALUMINUM is salvaged by reconcileHeldCargo). MINERAL asteroids yield
// QUARTZ_SAND/SILICON_CRYSTALS directly (no refine). Refine is a fixed 30 ore→10 metal, 60s cooldown.
const MINE_CATALOG = {
  COPPER:           { ore: 'COPPER_ORE',       deposit: 'COMMON_METAL_DEPOSITS', refine: true },
  IRON:             { ore: 'IRON_ORE',         deposit: 'COMMON_METAL_DEPOSITS', refine: true },
  SILICON_CRYSTALS: { ore: 'SILICON_CRYSTALS', deposit: 'MINERAL_DEPOSITS',      refine: false },
  QUARTZ_SAND:      { ore: 'QUARTZ_SAND',      deposit: 'MINERAL_DEPOSITS',      refine: false },
};
const REFINE_IN = 30, REFINE_OUT = 10;     // game constant: 30 ore → 10 refined per refine action (60s cd)
const mineActive = new Set();              // shipSyms currently on a mine-feed trip
let asteroidCache = null;                  // { TRAIT: [wp,...] } — also injects asteroid coords into the router
// [MINE_MIGRATE] Rocks we've abandoned because they were mined out (STRIPPED, or CRITICAL_LIMIT with a healthy
// alternative). Excluded from every asteroid pick so the colony never re-selects an exhausted rock.
const depletedSites = new Set();
// Waypoint `modifiers` that signal mining depletion (per the SpaceTraders waypoint model).
const DEPLETION_MODS = new Set(['STRIPPED', 'CRITICAL_LIMIT']);
// Fetch a waypoint's current modifier symbols (depletion state lives here, NOT in traits). [] on any error.
async function waypointMods(wp) {
  try { return ((await api('GET', `/systems/${SYSTEM}/waypoints/${wp}`)).data?.modifiers || []).map((m) => m.symbol); }
  catch { return []; }
}

// Discover asteroids: index by deposit trait and inject coords so D()/planRoute work (asteroids aren't markets, so
// they're absent from coords.csv). Skip rocks that are already mined out — flagged either by a STRIPPED modifier
// reported by the API or by depletedSites (rocks MINE_MIGRATE has abandoned this run).
// We scan every minable waypoint TYPE — plain ASTEROID *and* ENGINEERED_ASTEROID / ASTEROID_FIELD — because a much
// closer engineered rock (e.g. CA5A, 75 from F51 vs B9 at 250) is otherwise never seen, stranding the colony far away.
const ASTEROID_TYPES = ['ASTEROID', 'ENGINEERED_ASTEROID', 'ASTEROID_FIELD'];
async function loadAsteroids() {
  if (asteroidCache) return asteroidCache;
  const cache = {};
  for (const type of ASTEROID_TYPES) {
    for (let page = 1; page <= 5; page++) {
      let r; try { r = await api('GET', `/systems/${SYSTEM}/waypoints?type=${type}&limit=20&page=${page}`); } catch { break; }
      for (const w of r.data || []) {
        if (w.x != null && coords[w.symbol] == null) coords[w.symbol] = [w.x, w.y];   // always inject coords (router needs them even for stripped rocks)
        const mods = (w.modifiers || []).map((m) => m.symbol);
        if (mods.includes('STRIPPED') || depletedSites.has(w.symbol)) continue;       // mined out → not a candidate
        for (const t of w.traits) if (/DEPOSIT/.test(t.symbol)) (cache[t.symbol] ||= []).push(w.symbol);
      }
      if (!r.data || r.data.length < 20) break;
    }
  }
  asteroidCache = cache;
  return asteroidCache;
}
function nearestAsteroid(fromWp, trait) {
  const list = (asteroidCache && asteroidCache[trait]) || [];
  let best = null, bd = Infinity;
  for (const wp of list) { if (depletedSites.has(wp)) continue; const d = D(fromWp, wp); if (d < bd) { bd = d; best = wp; } }
  return best;
}
// [MINE_MIGRATE] The deposit trait a rock is indexed under (so we re-pick a same-deposit replacement). Falls back
// to COMMON_METAL_DEPOSITS (the colony's default rock type) when the cache doesn't know the rock.
function depositOfSite(site) {
  if (asteroidCache) for (const [trait, list] of Object.entries(asteroidCache)) if (list.includes(site)) return trait;
  return 'COMMON_METAL_DEPOSITS';
}
// [MINE_FEED] Calibration log — one JSON line per extract/refine/feed so target good / asteroid / batch / survey
// ROI can be tuned from real yields (consumed by the auto-calibration stage; v2 will persist this to the DB).
function logMine(rec) {
  try { fs.appendFileSync(here('./mine-history.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}
// Pick the feed good: highest (F51 sellPrice × scarcity weight) among catalog goods F51 imports. MINE_GOOD overrides.
function pickMineGood(producer) {
  if (MINE_GOOD) return MINE_GOOD;
  const imports = {};
  for (const g of producer.tradeGoods || []) if (g.type === 'IMPORT') imports[g.symbol] = g;
  let best = null, bestScore = -1;
  for (const good of Object.keys(MINE_CATALOG)) {
    const im = imports[good]; if (!im || !(im.sellPrice > 0)) continue;
    const score = im.sellPrice * (1 + (4 - (SUPPLY_RANK[im.supply] ?? 2)) * 0.25);   // scarcer → higher priority
    if (score > bestScore) { bestScore = score; best = good; }
  }
  return best;
}
function findProducerWp(markets, good) {
  for (const [wp, m] of Object.entries(markets)) if ((m.tradeGoods || []).some((x) => x.symbol === good && x.type === 'EXPORT')) return wp;
  return null;
}
// [MINE_FEED] Auto-pick the fuel-tender/ferry: prefer a HAULER/freighter; else any non-mining hull with enough
// cargo (≥40) AND range (fuel ≥200); else null → the ferry role simply doesn't run (colony still mines/refines,
// it just can't deliver — graceful no-op). MINE_TRANSPORT env overrides. Excludes mining hulls + the negotiator.
function pickMineTender(all) {
  if (MINE_TRANSPORT.size) return null;   // explicit override in play → don't auto-pick
  const cand = all.filter((s) => s.cargo.capacity > 0 && s.fuel.capacity > 0 && !hasMount(s, /MINING_LASER/) && !hasMount(s, /SURVEYOR/) && s.symbol !== NEGOTIATOR);
  const isHauler = (s) => /FREIGHTER|HAULER/.test(s.frame.symbol) || s.registration?.role === 'HAULER';
  let pool = cand.filter(isHauler);
  if (!pool.length) pool = cand.filter((s) => s.cargo.capacity >= 40 && s.fuel.capacity >= 200);
  if (!pool.length) return null;
  pool.sort((a, b) => (b.cargo.capacity - a.cargo.capacity) || (b.fuel.capacity - a.fuel.capacity));
  return pool[0].symbol;
}
function cargoUnits(ship, sym) { return (ship.cargo.inventory.find((i) => i.symbol === sym)?.units) || 0; }

// One extract action (ship must be in orbit at the asteroid). Pass a `survey` to bias yield toward its deposits
// (essential — un-surveyed extraction returns RANDOM materials). Returns extraction data or null on cooldown
// (waited) / spent survey (dropped). 
async function extractOnce(shipSym, survey) {
  try { await api('POST', `/my/ships/${shipSym}/orbit`); } catch {}
  try { return (await api('POST', `/my/ships/${shipSym}/extract`, survey ? { survey } : undefined)).data; }
  catch (e) {
    const m = e.message.match(/(\d+) second/); if (m) { await sleep((+m[1] + 1) * 1000); return null; }
    if (/survey/i.test(e.message)) { mineSurveys = mineSurveys.filter((s) => s !== survey); return null; }  // exhausted/expired
    throw e;
  }
}
// One refine action (30 ore → 10 metal); returns refine data or null on cooldown (waited).
async function refineOnce(shipSym, produce) {
  try { return (await api('POST', `/my/ships/${shipSym}/refine`, { produce })).data; }
  catch (e) { const m = e.message.match(/(\d+) second/); if (m) { await sleep((+m[1] + 1) * 1000); return null; } throw e; }
}
// [MINE_FEED] Survey support: a ship with a SURVEYOR mount maps an asteroid's deposits so extraction can TARGET
// a specific ore (vs random yield). Surveys are shared across mining ships via mineSurveys (so a dedicated
// surveyor can survey while a drone extracts — the plan-3 split). Surveys expire, so we prune them.
let mineSurveys = [];
const SURVEY_SIZE_RANK = { SMALL: 1, MODERATE: 2, LARGE: 3 };   // bigger size ⇒ more extractions before exhausting
const shipHasSurveyor = (ship) => (ship.mounts || []).some((m) => /SURVEYOR/.test(m.symbol));
function pruneSurveys() { const t = Date.now(); mineSurveys = mineSurveys.filter((s) => new Date(s.expiration).getTime() > t + 5000); }
// Score surveys by ORE DENSITY (fraction of the survey's deposits that are our target ore — drives how often an
// extraction yields it) × SIZE (how many extractions it survives). So a LARGE survey that's mostly COPPER_ORE
// beats a SMALL one with a single COPPER_ORE entry. Surveys with no matching deposit are ignored.
function bestSurveyFor(ast, ore) {
  pruneSurveys();
  let best = null, bestScore = 0;
  for (const s of mineSurveys) {
    if (s.symbol !== ast) continue;
    const deposits = s.deposits || [];
    const match = deposits.filter((d) => d.symbol === ore).length;
    if (!match) continue;
    const density = match / (deposits.length || 1);
    const score = density * (SURVEY_SIZE_RANK[s.size] || 1);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
async function surveyOnce(shipSym) {
  try { await api('POST', `/my/ships/${shipSym}/orbit`); } catch {}
  try {
    const d = (await api('POST', `/my/ships/${shipSym}/survey`)).data;
    for (const s of d.surveys || []) { mineSurveys.push(s);
      logMine({ ev: 'survey', ast: s.symbol, size: s.size, deposits: (s.deposits || []).map((x) => x.symbol), ship: shipSym.slice(-3) }); }
    return d;
  }
  catch (e) { const m = e.message.match(/(\d+) second/); if (m) { await sleep((+m[1] + 1) * 1000); return null; } throw e; }
}
// Navigate that tolerates "already at the destination" (mining hops between an asteroid and the producer).
async function safeGoTo(shipSym, dest) {
  try { await goTo(shipSym, dest); }
  catch (e) { if (!/located at the destination/i.test(e.message)) throw e; }
}

// [MINE_FEED] One mine→(refine)→haul→feed cycle. Ship mines its target good's ore at the nearest live deposit,
// refines it to the metal if needed, then hauls the metal to the producer and sells it in (feed). Ore is ~free
// so revenue ≈ net. Cooldown-bound: a single cycle may only partially fill before hauling — that's fine, the
// worker calls it again. Returns true if it did mining work this cycle.
async function mineFeedTrip(shipSym, ship, markets) {
  if (!MINE_FEED || gateCache.built) return false;
  await loadAsteroids();
  const producerWp = MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  if (!producerWp || !markets[producerWp]) return false;
  const good = pickMineGood(markets[producerWp]);
  if (!good) return false;
  const spec = MINE_CATALOG[good];
  const ast = nearestAsteroid(ship.nav.waypointSymbol, spec.deposit);
  if (!ast) return false;

  mineActive.add(shipSym);
  perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
  perShip[shipSym].last = `MINE ${good}→${producerWp.slice(-3)}`;
  log(`⛏️ ${shipSym.slice(-3)} mine-feed ${good} @ ${ast.slice(-3)} → ${producerWp.slice(-3)} (batch ${MINE_BATCH})`);
  try {
    // [MINE_FEED] FUEL PREFLIGHT — asteroids sell NO fuel, so a mining ship can strand itself into a slow DRIFT.
    // Require the round trip (here→asteroid→producer, which DOES sell fuel) to fit the tank; if we're short,
    // top up at the nearest fuel node first. If even a full tank can't make the round trip, bail (pick again later).
    const roundTrip = D(ship.nav.waypointSymbol, ast) + D(ast, producerWp);
    if (roundTrip + 40 > ship.fuel.capacity) { log(`⛏️ ${shipSym.slice(-3)} skip ${ast.slice(-3)}: round-trip ${roundTrip} > tank ${ship.fuel.capacity}`); return false; }
    if (ship.fuel.current < roundTrip + 40) {
      let fwp = null, fd = Infinity;
      for (const w of fuelNodes(markets)) { const d = D(ship.nav.waypointSymbol, w); if (d < fd) { fd = d; fwp = w; } }
      if (fwp) { await safeGoTo(shipSym, fwp); try { await refuel(shipSym); } catch {} ship = await getShip(shipSym); }
    }
    await safeGoTo(shipSym, ast);
    // 1) mine (+ refine) until we hold MINE_BATCH of the feed good or can make no further progress this cycle.
    let guard = 0;
    for (;;) {
      if (stop) break;
      ship = await getShip(shipSym);
      if (cargoUnits(ship, good) >= MINE_BATCH) break;
      const free = ship.cargo.capacity - ship.cargo.units;
      if (guard++ > 80) break;                                   // safety bound on a single cycle
      if (spec.refine && cargoUnits(ship, spec.ore) >= REFINE_IN) {
        const rr = await refineOnce(shipSym, good);
        if (rr) { logMine({ ev: 'refine', good, in: REFINE_IN, out: REFINE_OUT, ship: shipSym.slice(-3) });
                  const cd = rr.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
        continue;
      }
      if (free <= 0) break;                                      // cargo full and nothing left to refine
      // Target the ore via a survey (random yield otherwise). Self-survey if this hull has a surveyor.
      let survey = bestSurveyFor(ast, spec.ore);
      if (!survey && shipHasSurveyor(ship)) {
        const sd = await surveyOnce(shipSym);
        if (sd) { const cd = sd.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); survey = bestSurveyFor(ast, spec.ore); }
      }
      const ex = await extractOnce(shipSym, survey);
      if (ex) { const y = ex.extraction?.yield;
                logMine({ ev: 'extract', ast, deposit: spec.deposit, surveyed: !!survey, yield: y?.symbol, units: y?.units, ship: shipSym.slice(-3) });
                const cd = ex.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
    }
    // 2) haul to the producer and feed in the mined/refined good.
    ship = await getShip(shipSym);
    const feedUnits = cargoUnits(ship, good);
    if (feedUnits <= 0) return true;                             // nothing yet (cooldown-bound) — run again next cycle
    await safeGoTo(shipSym, producerWp);
    let got = 0;
    try { const rs = await sell(shipSym, good); got = rs.got || 0; }
    catch (e) { log(`${shipSym.slice(-3)} mine-feed sell ERR ${good}: ${e.message}`); }
    record(shipSym, got, `MINE-FEED ${good}`);                  // ore ~free → revenue ≈ net
    logMine({ ev: 'feed', good, units: feedUnits, revenue: got, producer: producerWp.slice(-3) });
    log(`⛏️ ${shipSym.slice(-3)} fed ${feedUnits} ${good} → ${producerWp.slice(-3)} (+${got.toLocaleString()})`);
  } catch (e) {
    log(`${shipSym} mine-feed ERR ${e.message}`);
  } finally {
    mineActive.delete(shipSym);
    perShip[shipSym].projected = 0;
  }
  return true;
}

// ===================== [MINE_FEED] PARK-AND-FERRY COLONY (roles auto-detected) =====================
// Ships are assigned a mining role by CAPABILITY (so freshly-bought hulls slot in with no config):
//   REFINER  = has MINING_LASER + MINERAL_PROCESSOR (ship 1) — parks at the rock, extracts + refines ore→metal, holds it.
//   DRONE    = has MINING_LASER only — parks, extracts metal ore, transfers it to the refiner.
//   SURVEYOR = has a SURVEYOR mount, no laser — parks/roves, keeps the shared survey pool fresh + rich.
//   TRANSPORT= a named freighter (MINE_TRANSPORT) — ferries refined metal to the producer (feed) and returns.
// Parked hulls burn NO fuel (fuel is only spent navigating), so once on-site they mine indefinitely; only the
// transport commutes (and refuels at the producer, which sells fuel). mineSurveys is shared in-process across roles.
const MINE_ORES = { COPPER_ORE: 'COPPER', IRON_ORE: 'IRON' };   // ores we refine 30→10 (both are F51 inputs)
const MINE_DIRECT = ['SILICON_CRYSTALS', 'QUARTZ_SAND'];        // F51 inputs minable DIRECTLY (no refine)
const MINE_KEEP = new Set([...Object.keys(MINE_ORES), ...MINE_DIRECT]);   // everything else (ICE_WATER, ALUMINUM_ORE…) = junk → jettison
const FEED_GOODS = [...Object.values(MINE_ORES), ...MINE_DIRECT];         // what we ferry into F51: COPPER, IRON, SILICON_CRYSTALS, QUARTZ_SAND
// [RELIEF VALVE] Raw ore (COPPER_ORE/IRON_ORE) only leaves the colony by being refined (30→10). A single refiner
// can't keep up, so raw ore jams the funnel + refiner (deadlock) and starves the silicon/quartz feed. Fix: tenders
// haul EXCESS raw ore (above MINE_ORE_RESERVE left for the refiner) to its best market and sell it for profit —
// the funnel can never fully jam, refining keeps feeding F51 (FAB), and overflow ore still earns. Off via MINE_RAW_RELIEF=0.
const RAW_ORE = Object.keys(MINE_ORES);                                   // ['COPPER_ORE','IRON_ORE']
const MINE_RAW_RELIEF = process.env.MINE_RAW_RELIEF !== '0';
const MINE_ORE_RESERVE = Number(process.env.MINE_ORE_RESERVE || REFINE_IN);   // leave this many of each ore in the funnel for the refiner
const MINE_CLOG_AT = Number(process.env.MINE_CLOG_AT || 32);              // only sell raw ore once the funnel holds ≥ this (else PREFER refining→F51 feed)
const hasMount = (ship, re) => (ship.mounts || []).some((m) => re.test(m.symbol));
const hasModule = (ship, re) => (ship.modules || []).some((m) => re.test(m.symbol));
function mineRoleOf(ship) {
  if (!MINE_FEED || gateCache.built) return null;
  const miner = hasMount(ship, /MINING_LASER/);
  // REFINER requires a real ORE_REFINERY module (MINERAL_PROCESSOR does NOT enable refine()). No ship in X1-PP30
  // has one and none are for sale here, so refining is impossible in-system — we mine direct goods + sell raw ore.
  if (miner && hasModule(ship, /ORE_REFINERY/)) return 'REFINER';
  // A surveyor hull (ship 1: SURVEYOR_II) keeps rich surveys so drones target silicon/quartz; it doesn't hoard ore.
  if (hasMount(ship, /SURVEYOR/)) return 'SURVEYOR';
  if (miner) return 'DRONE';
  if (isMineFunnel(ship.symbol)) return 'FUNNEL';
  if (isMineTransport(ship.symbol)) return 'TRANSPORT';
  return null;
}
let mineSite = null;       // the chosen COMMON_METAL asteroid the colony works
let refinerSym = null;     // registered by refinerTrip so drones/transport can find + transfer to it
let funnelSym = null;      // registered by funnelTrip; drones push ore here, refiner pulls 30-batches, tender pulls finished
const ORE_LIST = Object.keys(MINE_ORES);   // ['COPPER_ORE','IRON_ORE'] — the refiner rotates its target through these
let refineTarget = ORE_LIST[0];            // current single-good refine target (rotates so the hold stays pure)
const rotateRefineTarget = () => { refineTarget = ORE_LIST[(ORE_LIST.indexOf(refineTarget) + 1) % ORE_LIST.length]; };
const colonyShips = {};    // shipSym -> {wp, fuel, cap} updated each cycle so the fuel-tender can refuel co-located low miners
function colonySite(markets, fromWp) {
  if (mineSite) return mineSite;
  const prod = MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  mineSite = nearestAsteroid(prod || fromWp, 'COMMON_METAL_DEPOSITS');   // richest-rock selection is a calibration upgrade
  return mineSite;
}
// [MINE_MIGRATE] Move a colony hull onto the (possibly newly-chosen) site. If the hull is sitting on a rock we've
// since abandoned, log the redirect — this is the arrival-time turnaround for a ship that was in transit to the old
// rock when migration happened (it can't be turned mid-flight, so it's redirected the moment it lands). No-op when
// already on site. fuel-preflights the leg, then navigates.
async function goToColonySite(shipSym, ship, markets, site) {
  if (ship.nav.waypointSymbol === site) return ship;
  if (depletedSites.has(ship.nav.waypointSymbol)) log(`🪐 ${shipSym.slice(-3)} redirect ${ship.nav.waypointSymbol.slice(-3)}→${site.slice(-3)} (rock mined out)`);
  await fuelTopUp(shipSym, ship, markets, D(ship.nav.waypointSymbol, site) + 30);
  await safeGoTo(shipSym, site);
  return await getShip(shipSym);
}
async function jettison(shipSym, sym, units) {
  try { await api('POST', `/my/ships/${shipSym}/jettison`, { symbol: sym, units }); logMine({ ev: 'jettison', sym, units, ship: shipSym.slice(-3) }); }
  catch (e) { /* non-fatal */ }
}
// Top up fuel at the nearest fuel-selling waypoint if we can't cover `need` units (asteroids sell none).
async function fuelTopUp(shipSym, ship, markets, need) {
  if (ship.fuel.current >= Math.min(need + 20, ship.fuel.capacity)) return;
  let fwp = null, fd = Infinity;
  for (const w of fuelNodes(markets)) { const d = D(ship.nav.waypointSymbol, w); if (d < fd) { fd = d; fwp = w; } }
  if (fwp && fwp !== ship.nav.waypointSymbol) { await safeGoTo(shipSym, fwp); try { await refuel(shipSym); } catch {} }
  else { try { await refuel(shipSym); } catch {} }
}
// Refuel a ship from FUEL units already in its OWN cargo (how the tender refuels parked/scouting miners).
async function refuelFromCargo(shipSym) { try { await api('POST', `/my/ships/${shipSym}/refuel`, { fromCargo: true }); return true; } catch { return false; } }
// [FUEL_CARGO] At a buy point, reclaim slots held by leftover carried FUEL so goods always win: first burn fuel
// into the tank (refuelFromCargo), then sell the rest if this market buys FUEL, else jettison. No-op when not
// carrying any FUEL cargo. Called right before sourcing goods after a fuel-cargo arrival.
async function shedSpareFuel(shipSym) {
  let ship = await getShip(shipSym);
  if (cargoUnits(ship, 'FUEL') <= 0) return;
  await refuelFromCargo(shipSym).catch(() => {});                 // absorb what the tank can take (frees those slots)
  ship = await getShip(shipSym);
  if (cargoUnits(ship, 'FUEL') <= 0) return;
  try { await sell(shipSym, 'FUEL'); } catch {}                   // recoup credits if this market buys fuel
  ship = await getShip(shipSym);
  const left = cargoUnits(ship, 'FUEL');
  if (left > 0) await jettison(shipSym, 'FUEL', left);            // last resort: dump so the slot is free for goods
}
// Register a colony hull's location + fuel so the tender can find low ones to top up.
function registerColony(shipSym, ship) { colonyShips[shipSym] = { wp: ship.nav.waypointSymbol, fuel: ship.fuel.current, cap: ship.fuel.capacity }; }
const bestSiteSurvey = (site) => bestSurveyFor(site, 'COPPER_ORE') || bestSurveyFor(site, 'IRON_ORE') || bestSurveyFor(site, 'SILICON_CRYSTALS') || bestSurveyFor(site, 'QUARTZ_SAND');

// REFINER (ship 1): park at the rock; keep a survey fresh (it has SURVEYOR_II); refine COPPER/IRON ore→metal;
// extract more when out of ore; jettison non-metal junk (ICE etc.). Holds metal for the transport to collect.
async function refinerTrip(shipSym, ship, markets) {
  await loadAsteroids();
  const site = colonySite(markets, ship.nav.waypointSymbol);
  if (!site) return false;
  refinerSym = shipSym;
  ship = await goToColonySite(shipSym, ship, markets, site);
  registerColony(shipSym, ship);
  perShip[shipSym].last = `REFINE @ ${site.slice(-3)}`;

  // [FUNNEL MODE] Continuous single-good refine loop against the shared ore bin (the parked funnel ship).
  // The refiner keeps ONLY the current target ore in its own hold (everything else is pushed to the funnel),
  // refines a 30-batch → 10 metal, ships the metal back to the funnel, then ROTATES to the next ore. This is
  // the user's "only the target is kept, everything else is transferred; rotate what we refine" design.
  if (funnelSym && funnelSym !== shipSym && ship.nav.waypointSymbol === site) {
    // 1) keep the hold pure: push out anything that isn't the current target ore (finished metal, other ore,
    //    direct minerals like silicon/quartz) to the funnel so the tender can collect it and our hold stays clear.
    for (const it of [...ship.cargo.inventory]) {
      if (it.symbol === refineTarget || it.symbol === 'FUEL') continue;
      try { await transfer(shipSym, funnelSym, it.symbol, it.units); } catch { /* funnel full/elsewhere */ }
    }
    ship = await getShip(shipSym);
    // 2) have a full batch of the target ore? refine it, ship the metal to the funnel, rotate target.
    if (cargoUnits(ship, refineTarget) >= REFINE_IN) {
      const metal = MINE_ORES[refineTarget];
      const rr = await refineOnce(shipSym, metal);
      if (rr) { logMine({ ev: 'refine', good: metal, ship: shipSym.slice(-3) }); const cd = rr.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
      try { const u = cargoUnits(await getShip(shipSym), metal); if (u > 0) await transfer(shipSym, funnelSym, metal, u); } catch {}
      rotateRefineTarget();
      perShip[shipSym].last = `REFINED ${metal} → next ${MINE_ORES[refineTarget]}`;
      return true;
    }
    // 3) top up the target ore from the funnel toward a 30-batch (single-good pull keeps the hold pure).
    const funnel = await getShip(funnelSym);
    const need = REFINE_IN - cargoUnits(ship, refineTarget);
    const free = ship.cargo.capacity - ship.cargo.units;
    const take = Math.min(cargoUnits(funnel, refineTarget), need, free);
    if (take > 0) { try { await transfer(funnelSym, shipSym, refineTarget, take); return true; } catch {} }
    // 4) funnel can't fill this target but the OTHER ore already has a batch waiting → switch to it now.
    const other = ORE_LIST.find((o) => o !== refineTarget);
    if (other && cargoUnits(funnel, other) >= REFINE_IN) { refineTarget = other; return true; }
    // 5) no ore to refine anywhere → use the idle time to survey / extract ourselves (frigate has laser+surveyor).
    perShip[shipSym].last = `REFINE idle @ ${site.slice(-3)} (await ${MINE_ORES[refineTarget]} ore)`;
    if (shipHasSurveyor(ship) && !bestSiteSurvey(site)) { const sd = await surveyOnce(shipSym); if (sd) { const cd = sd.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); } return true; }
    if (free > 1) {
      const ex = await extractOnce(shipSym, bestSiteSurvey(site));
      if (ex) { const y = ex.extraction?.yield; logMine({ ev: 'extract', role: 'REFINER', ast: site, surveyed: !!bestSiteSurvey(site), yield: y?.symbol, units: y?.units, ship: shipSym.slice(-3) });
                if (y && !MINE_KEEP.has(y.symbol)) await jettison(shipSym, y.symbol, y.units);
                const cd = ex.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
      return true;
    }
    await sleep(IDLE_WAIT_MS); return true;
  }

  // [LEGACY MODE — no funnel] refine whatever ore we have (COPPER first — highest value)
  for (const [ore, metal] of Object.entries(MINE_ORES)) {
    if (cargoUnits(ship, ore) >= REFINE_IN) {
      const rr = await refineOnce(shipSym, metal);
      if (rr) { logMine({ ev: 'refine', good: metal, ship: shipSym.slice(-3) }); const cd = rr.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
      return true;
    }
  }
  // keep a fresh, rich survey in the shared pool for the whole colony
  if (shipHasSurveyor(ship) && !bestSiteSurvey(site)) {
    const sd = await surveyOnce(shipSym); if (sd) { const cd = sd.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
    return true;
  }
  // otherwise extract more ore ourselves (frees nothing if cargo is full of metal awaiting pickup)
  if (ship.cargo.capacity - ship.cargo.units <= 1) { perShip[shipSym].last = `HOLD feed @ ${site.slice(-3)} (awaiting ferry)`; return true; }
  const ex = await extractOnce(shipSym, bestSiteSurvey(site));
  if (ex) { const y = ex.extraction?.yield;
            logMine({ ev: 'extract', role: 'REFINER', ast: site, surveyed: !!bestSiteSurvey(site), yield: y?.symbol, units: y?.units, ship: shipSym.slice(-3) });
            if (y && !MINE_KEEP.has(y.symbol) && y.symbol !== 'COPPER' && y.symbol !== 'IRON') await jettison(shipSym, y.symbol, y.units);   // dump junk (ICE/ALUMINUM); keep ore + direct F51 minerals + refined metal
            const cd = ex.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
  return true;
}

// DRONE: park at the rock, extract metal ore against the shared survey, transfer it to the refiner; jettison junk.
async function droneTrip(shipSym, ship, markets) {
  await loadAsteroids();
  const site = colonySite(markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(shipSym, ship, markets, site);
  registerColony(shipSym, ship);
  perShip[shipSym].last = `MINE @ ${site.slice(-3)}`;
  // hand ore + direct F51 minerals to the SINK: the funnel (shared ore bin) if one exists, else the refiner.
  const sink = (funnelSym && funnelSym !== shipSym) ? funnelSym : refinerSym;
  if (sink && sink !== shipSym) {
    let moved = false;
    for (const g of MINE_KEEP) { const u = cargoUnits(ship, g); if (u > 0) { try { await transfer(shipSym, sink, g, u); moved = true; } catch { /* sink full/elsewhere */ } } }
    if (moved) return true;
  }
  if (ship.cargo.capacity - ship.cargo.units <= 0) {                 // full and couldn't hand off → dump junk to keep mining
    for (const it of ship.cargo.inventory) if (!MINE_KEEP.has(it.symbol)) { await jettison(shipSym, it.symbol, it.units); return true; }
    perShip[shipSym].last = `FULL @ ${site.slice(-3)} (sink busy)`; return true;
  }
  const ex = await extractOnce(shipSym, bestSiteSurvey(site));
  if (ex) { const y = ex.extraction?.yield;
            logMine({ ev: 'extract', role: 'DRONE', ast: site, surveyed: !!bestSiteSurvey(site), yield: y?.symbol, units: y?.units, ship: shipSym.slice(-3) });
            if (y && !MINE_KEEP.has(y.symbol)) await jettison(shipSym, y.symbol, y.units);
            const cd = ex.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
  return true;
}

// SURVEYOR: keep the shared pool stocked with rich, large surveys for the colony's rock.
async function surveyorTrip(shipSym, ship, markets) {
  await loadAsteroids();
  const site = colonySite(markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(shipSym, ship, markets, site);
  registerColony(shipSym, ship);
  perShip[shipSym].last = `SURVEY @ ${site.slice(-3)}`;
  const sd = await surveyOnce(shipSym);
  if (sd) { const cd = sd.cooldown?.remainingSeconds; if (cd) await sleep((cd + 1) * 1000); }
  else await sleep(IDLE_WAIT_MS);   // on cooldown with nothing else to do
  return true;
}

// FUNNEL: a parked cargo hull that serves as the colony's shared ore bin. It does no work itself — drones push
// ore in, the refiner pulls 30-batches out + pushes finished metal back, the tender pulls finished goods out. We
// just park it on the rock once (fuel-preflight the one-way leg) and keep it registered so the others can find it.
// [RULE: park-once] the rock sells no fuel, so a funnel reaching it stays put indefinitely (parked hulls burn 0 fuel).
async function funnelTrip(shipSym, ship, markets) {
  await loadAsteroids();
  const site = colonySite(markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(shipSym, ship, markets, site);
  registerColony(shipSym, ship);
  funnelSym = shipSym;
  perShip[shipSym].last = `FUNNEL @ ${site.slice(-3)} (${ship.cargo.units}/${ship.cargo.capacity})`;
  perShip[shipSym].projected = 0;
  await sleep(IDLE_WAIT_MS);
  return true;
}

// TRANSPORT: ferry refined metal from the parked refiner to the producer and feed it in. Two-phase: if holding
// metal, deliver+sell to the producer; else go to the rock and pull metal off the refiner.
async function transportTrip(shipSym, ship, markets) {
  await loadAsteroids();
  const producerWp = MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  const site = mineSite;
  if (!producerWp || !site) return false;
  // [FUEL/DISTANCE FIX] Anchor the ferry on the PRODUCER (F51): it sells fuel AND is the delivery point, and
  // the freighter's tank covers the round trip to the rock and back. navigate() auto-refuels at its start and
  // flies CRUISE direct (no BURN fuel-doubling, no detour to the nearest fuel node). The rock (asteroid) sells
  // NO fuel, so before the return leg we top the tank from carried FUEL cargo (refuelFromCargo) as a fallback.
  const legBack = D(site, producerWp);
  const carryFeed = FEED_GOODS.reduce((a, m) => a + cargoUnits(ship, m), 0);
  const carryRaw = MINE_RAW_RELIEF ? RAW_ORE.reduce((a, m) => a + cargoUnits(ship, m), 0) : 0;
  if (carryFeed > 0 || carryRaw > 0) {              // ---- deliver phase ----
    if (carryFeed > 0) {                            // 1) feed F51 (boosts FAB production + profit)
      await goTo(shipSym, producerWp);              // [ROUTE] fuel-aware multi-hop + burn-efficient (no 3hr DRIFT)
      let got = 0;
      for (const m of FEED_GOODS) { const u = cargoUnits(await getShip(shipSym), m); if (u > 0) { try { const rs = await sell(shipSym, m); got += rs.got || 0; } catch (e) { log(`${shipSym.slice(-3)} ferry sell ERR ${m}: ${e.message}`); } } }
      if (got) { record(shipSym, got, 'MINE-FERRY feed'); logMine({ ev: 'feed', via: 'ferry', revenue: got, producer: producerWp.slice(-3) }); log(`🚚 ${shipSym.slice(-3)} ferried feed → ${producerWp.slice(-3)} (+${got.toLocaleString()})`); }
      await refuel(shipSym);                         // FILL at F51 (anchor) for the next round trip
      const fuelHave = cargoUnits(await getShip(shipSym), 'FUEL');
      if (fuelHave < MINE_FUEL_RESERVE) { try { await buy(shipSym, 'FUEL', MINE_FUEL_RESERVE - fuelHave); } catch {} }
    }
    if (MINE_RAW_RELIEF) {                           // 2) sell overflow raw ore at its best market (profit + anti-clog)
      for (const m of RAW_ORE) {
        const u = cargoUnits(await getShip(shipSym), m);
        if (u <= 0) continue;
        const sink = bestSink(markets, m);
        if (!sink || !(sink.px > 0)) { await jettison(shipSym, m, u); log(`🗑 ${shipSym.slice(-3)} no buyer for ${m} → jettisoned ${u}`); continue; }
        await goTo(shipSym, sink.wp);                // [ROUTE] fuel-aware to the ore's best market (e.g. H59)
        try { const rs = await sell(shipSym, m); if (rs.got) { record(shipSym, rs.got, `MINE-ORE ${m}→${sink.wp.slice(-3)}`); logMine({ ev: 'ore-sale', good: m, units: u, revenue: rs.got, wp: sink.wp.slice(-3) }); log(`💰 ${shipSym.slice(-3)} sold ${u} ${m} → ${sink.wp.slice(-3)} (+${(rs.got || 0).toLocaleString()})`); } } catch (e) { log(`${shipSym.slice(-3)} ore-sale ERR ${m}: ${e.message}`); }
      }
      await refuel(shipSym);                          // top up wherever we ended (next loop's goTo is fuel-aware anyway)
    }
    return true;
  }
  // ---- collect phase ----
  // If our tank can't cover the round trip to the rock and back, fill at F51 first (it sells fuel).
  const roundTrip = D(ship.nav.waypointSymbol, site) + legBack;
  if (ship.nav.waypointSymbol !== site && ship.fuel.current < roundTrip + 40) {
    await goTo(shipSym, producerWp);                // [ROUTE] fuel-aware hop to the F51 anchor to fill up first
    await refuel(shipSym);
    const fuelHave = cargoUnits(await getShip(shipSym), 'FUEL');
    if (fuelHave < MINE_FUEL_RESERVE) { try { await buy(shipSym, 'FUEL', MINE_FUEL_RESERVE - fuelHave); } catch {} }
  }
  await goTo(shipSym, site);                         // [ROUTE] fuel-aware to the rock (hops via a fuel node if far)
  perShip[shipSym].last = `FERRY collect @ ${site.slice(-3)}`;
  // [TENDER] refuel any co-located colony hull that's low, from our carried FUEL cargo
  for (const [sym, info] of Object.entries(colonyShips)) {
    if (sym === shipSym || info.wp !== site || info.fuel >= info.cap * 0.5) continue;
    const have = cargoUnits(await getShip(shipSym), 'FUEL');
    const give = Math.min(Math.ceil((info.cap - info.fuel) / 100), have);
    if (give > 0) { try { await transfer(shipSym, sym, 'FUEL', give); await refuelFromCargo(sym); log(`⛽ ${shipSym.slice(-3)} fueled ${sym.slice(-3)} (+${give}u)`); } catch {} }
  }
  // collect finished FEED_GOODS (refined metal + direct minerals) from the SOURCE: the funnel bin if one exists,
  // else the refiner. Raw *_ORE is intentionally NOT in FEED_GOODS, so it stays at the rock for the refiner.
  const source = (funnelSym && funnelSym !== shipSym) ? funnelSym : refinerSym;
  let moved = 0;
  if (source && source !== shipSym) {
    for (const m of FEED_GOODS) {
      const u = cargoUnits(await getShip(source), m);
      const free = ship.cargo.capacity - (await getShip(shipSym)).cargo.units;
      const take = Math.min(u, free);
      if (take > 0) { try { await transfer(source, shipSym, m, take); moved += take; } catch { /* not co-located yet */ } }
    }
    // [RELIEF VALVE] PREFER feeding F51 (refine→metal→F51). Only when the funnel is genuinely clogging (≥ MINE_CLOG_AT)
    // do we haul EXCESS raw ore (above the refiner's active-target reserve) out to its best market — prevents the
    // funnel jamming with ore the single refiner can't process fast enough, while keeping a batch to refine for FAB.
    const funnelLoad = (await getShip(source)).cargo.units;
    if (MINE_RAW_RELIEF && funnelLoad >= MINE_CLOG_AT) {
      for (const m of RAW_ORE) {
        const inSrc = cargoUnits(await getShip(source), m);
        const reserve = (m === refineTarget) ? MINE_ORE_RESERVE : 0;   // keep a batch of the ACTIVE target for the refiner; drain the other ore (refiner rotates targets, so both get refined over time)
        const free = ship.cargo.capacity - (await getShip(shipSym)).cargo.units;
        const take = Math.min(Math.max(0, inSrc - reserve), free);
        if (take > 0) { try { await transfer(source, shipSym, m, take); moved += take; } catch { /* not co-located */ } }
      }
    }
  }
  // [FUEL] The rock has no fuel station — top our tank from carried FUEL cargo before the return leg so we
  // never strand here. Delivery happens next loop (held>0 → deliver phase).
  ship = await getShip(shipSym);
  if (ship.fuel.current < legBack + 40) await refuelFromCargo(shipSym);
  if (moved > 0) return true;
  perShip[shipSym].last = `FERRY wait @ ${site.slice(-3)} (no feed yet)`;
  await sleep(IDLE_WAIT_MS);
  return true;
}

// --- refuel-aware shortest-path router (Dijkstra over fuel-stocked waypoints) ---
// A long leg that exceeds one fuel tank should hop through fuel-selling waypoints in CRUISE
// instead of DRIFTing the whole way (which is ~10× slower). Edge A→B exists if dist ≤ tank and
// B is a fuel node (or the destination). Minimizes total CRUISE time.
function fuelNodes(markets) {
  const s = new Set();
  for (const [w, m] of Object.entries(markets)) if ((m.tradeGoods || []).some((g) => g.symbol === 'FUEL')) s.add(w);
  return s;
}
function planRoute(from, to, fuelCap, markets) {
  const cap = (fuelCap || 0) * 0.97;
  if (cap <= 0 || D(from, to) <= cap) return [to];     // probes (cap 0 handled by caller) or direct-feasible
  const fuel = fuelNodes(markets);
  const nodes = [...new Set([from, to, ...fuel])].filter((n) => coords[n]);
  const dist = {}, prev = {}, seen = new Set();
  for (const n of nodes) dist[n] = Infinity; dist[from] = 0;
  for (;;) {
    let u = null, best = Infinity;
    for (const n of nodes) if (!seen.has(n) && dist[n] < best) { best = dist[n]; u = n; }
    if (u === null || u === to) break;
    seen.add(u);
    for (const v of nodes) {
      if (v === u || seen.has(v)) continue;
      if (v !== to && !fuel.has(v)) continue;          // can only stop to refuel at fuel nodes (or the dest)
      const d = D(u, v); if (d > cap) continue;         // too far for one tank
      const t = Math.round(d * 25 / 15) + 15;           // CRUISE time (relative ranking)
      if (dist[u] + t < dist[v]) { dist[v] = dist[u] + t; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return null;               // unreachable even multi-hop
  const path = []; let c = to; while (c && c !== from) { path.unshift(c); c = prev[c]; }
  return path;
}

// Navigate possibly-far: route through refuel stops in CRUISE rather than one long DRIFT.
async function goTo(shipSym, dest) {
  let ship = await getShip(shipSym);
  if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') { delete plannedRoutes[shipSym]; return; }
  const path = planRoute(ship.nav.waypointSymbol, dest, ship.fuel.capacity, marketCache.data || {});
  if (!path) {
    // Tank-only route infeasible (a long dry leg with no in-range fuel node) → this would DRIFT. When fuel-cargo is
    // enabled, bridge the dry leg with FUEL carried in the hold first (covers freshly-bought colony hulls + any far
    // transport leg) — only DRIFT as the genuine last resort.
    if (FUEL_CARGO && await goToWithFuelCargo(shipSym, dest, marketCache.data || {})) return;
    plannedRoutes[shipSym] = { from: ship.nav.waypointSymbol, path: [dest], at: now() }; await navigate(shipSym, dest, chooseMode(D(ship.nav.waypointSymbol, dest), ship).mode); return;
  }
  plannedRoutes[shipSym] = { from: ship.nav.waypointSymbol, path: [...path], at: now() };   // [TABLE] remember the full planned route for the fleet table
  if (path.length > 1) log(`${shipSym} routing ${ship.nav.waypointSymbol.slice(-3)}→${dest.slice(-3)} via ${path.map((p) => p.slice(-3)).join('→')} (refuel-hop)`);
  for (const hop of path) {
    ship = await getShip(shipSym);
    await navigate(shipSym, hop, chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode);
  }
}

// Estimate fuel-credits + seconds for a (possibly multi-hop) trip, for lane scoring.
// Uses the refuel-aware route so OUTER lanes are costed realistically (CRUISE hops, not one DRIFT).
function routeCost(from, to, ship) {
  if (from === to) return { fuelCr: 0, timeS: 0 };
  const speed = ship.engine?.speed || 15;
  const path = planRoute(from, to, ship.fuel.capacity, marketCache.data || {});
  if (!path) { const d = D(from, to); return { fuelCr: FUEL_PX, timeS: Math.round(d * 250 / speed) + 15 }; } // DRIFT fallback
  let cur = from, fuelCr = 0, timeS = 0;
  for (const hop of path) { const d = D(cur, hop); fuelCr += d * FUEL_PX; timeS += Math.round(d * 25 / speed) + 15; cur = hop; }
  return { fuelCr, timeS };
}

// Robust contract execution: re-check source LIVE, buy with generous pricing,
// VERIFY cargo before delivering, and never blind-deliver.
async function runContract(shipSym, cc) {
  // re-pick source from a fresh market read (cache may be stale)
  const fresh = await getMarkets();
  const src = cheapestContractSrc(fresh, cc.good, cc.dest) || { wp: cc.src, px: cc.px };
  await haulGoTo(shipSym, src.wp, fresh, { reserveUnits: cc.units });   // far source → fuel-in-cargo bridge; keep room for the buy
  if (FUEL_CARGO) await shedSpareFuel(shipSym);                         // reclaim slots from leftover carried fuel before sourcing
  // contracts justify paying up — generous cap so we actually source it
  await buy(shipSym, cc.good, cc.units, Math.round(src.px * 1.8));
  const have = (await getShip(shipSym)).cargo.inventory.find((i) => i.symbol === cc.good)?.units || 0;
  if (have < cc.units) {
    log(`⚠ ${shipSym} under-sourced ${cc.good} ${have}/${cc.units} @ ${src.wp.slice(-3)} (px~${src.px}) — aborting delivery`);
    if (have > 0) { try { await sell(shipSym, cc.good); } catch {} }
    throw new Error(`under-sourced ${cc.good} ${have}/${cc.units}`);
  }
  await haulGoTo(shipSym, cc.dest, fresh);             // refuel-hop to the (possibly far) delivery point; spare slots carry bridging fuel
  await deliver(shipSym, cc.id, cc.good, cc.units);
  await fulfill(shipSym, cc.id);
  // sell any surplus we bought
  const surplus = (await getShip(shipSym)).cargo.inventory.find((i) => i.symbol === cc.good)?.units || 0;
  if (surplus > 0) { try { await sell(shipSym, cc.good); } catch {} }
}

// ---- per-ship worker --------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stop = false;

// [RECOVERY] On boot (or any loop where a ship unexpectedly holds cargo), resume the persisted
// SELL leg with the saved cost basis, or salvage-sell orphan cargo. Returns true if it acted
// (caller should `continue`). No-op when the ship is empty — normal claim flow proceeds.
async function reconcileHeldCargo(shipSym, ship, markets) {
  const contractGood = activeContractInfo?.good;
  // [GATE PROTECT] Don't salvage-sell gate materials while the gate is unbuilt — a ship holding them mid-haul on a
  // restart should still deliver them to the gate, not dump them at a loss. (FAB bought @~3800 sold @~1700 = -83k.)
  const gateMat = (GATE_SUPPLY && gateCache.exists && !gateCache.built)
    ? new Set([...GATE_PROTECT_MATERIALS].filter((m) => (gateCache.remaining[m] || 0) > 0))   // only protect what the gate STILL needs
    : new Set();
  const sellable = (ship.cargo?.inventory || []).filter((i) => i.symbol !== 'FUEL' && i.symbol !== contractGood && !gateMat.has(i.symbol) && i.units > 0);
  const intent = intents[shipSym];
  if (!sellable.length) { if (intent) clearIntent(shipSym); return false; }  // nothing held → stale intent is moot

  // Case 1: held cargo matches a saved HAULING intent → finish the planned sell with its cost basis.
  if (intent && intent.phase === 'HAULING') {
    const held = ship.cargo.inventory.find((i) => i.symbol === intent.good)?.units || 0;
    if (held > 0) {
      perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
      perShip[shipSym].last = `RESUME ${intent.good}→${intent.sellWp.slice(-3)}`;
      log(`↻ ${shipSym.slice(-3)} resuming ${held} ${intent.good} → ${intent.sellWp.slice(-3)} (cost ${Math.round(intent.costBasis || 0).toLocaleString()})`);
      try {
        await goTo(shipSym, intent.sellWp);
        const s = await sell(shipSym, intent.good);
        const basis = (intent.costBasis || 0) * (held / (intent.units || held));   // prorate if partial
        let net = (s.got || 0) - basis;
        for (const ex of intent.extras || []) {                        // [MULTI-GOOD] replay ride-alongs at the shared sink
          const exHeld = ship.cargo.inventory.find((i) => i.symbol === ex.good)?.units || 0;
          if (exHeld <= 0) continue;
          try { const rs = await sell(shipSym, ex.good); net += (rs.got || 0) - (ex.costBasis || 0); }
          catch (e) { log(`${shipSym.slice(-3)} resume ride-along ${ex.good} ERR ${e.message}`); }
        }
        record(shipSym, Math.round(net), `RESUMED ${intent.good}${(intent.extras || []).length ? `+${intent.extras.length}` : ''}→${intent.sellWp.slice(-3)}`);
      } catch (e) {
        log(`${shipSym} resume ERR ${e.message} — salvage-selling`);
        try { await sell(shipSym, intent.good); } catch {}
      } finally { clearIntent(shipSym); }
      return true;
    }
    clearIntent(shipSym);   // intent good not actually held → drop stale intent, fall through to salvage
  }

  // Case 2: orphan cargo with no usable intent → salvage at the best sink so capital isn't stranded.
  perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };
  perShip[shipSym].last = `SALVAGE ${sellable.map((i) => i.symbol).join(',')}`;
  log(`⤓ ${shipSym.slice(-3)} salvaging orphan cargo: ${sellable.map((i) => `${i.units} ${i.symbol}`).join(', ')}`);
  for (const item of sellable) {
    const sink = bestSink(markets, item.symbol);
    try {
      if (sink && sink.wp !== ship.nav.waypointSymbol) await goTo(shipSym, sink.wp);
      const s = await sell(shipSym, item.symbol);
      log(`⤓ ${shipSym.slice(-3)} salvaged ${item.units} ${item.symbol} (+${(s.got || 0).toLocaleString()})`);
    } catch (e) { log(`${shipSym} salvage ${item.symbol} ERR ${e.message}`); }
  }
  clearIntent(shipSym);
  return true;
}

// ============================================================================
//  [ORPHAN GATE CARGO] deliver gate materials stranded on a non-hauler hull
// ============================================================================

// Dock at the gate and hand over every still-needed gate material this hull holds. Mirrors the supply leg of
// gateSupplyTrip (keeps gateCache.remaining / built in sync). Returns true if anything was supplied.
async function supplyHeldToGate(shipSym, syms) {
  const g = gateCache;
  try { await api('POST', `/my/ships/${shipSym}/dock`); } catch {}   // construction/supply requires DOCKED
  let inv = [];
  try { inv = (await api('GET', `/my/ships/${shipSym}`)).data.cargo.inventory; } catch { return false; }
  let any = false;
  for (const sym of syms) {
    const have = inv.find((i) => i.symbol === sym)?.units || 0;
    if (have <= 0) continue;
    try {
      const r = await api('POST', `/systems/${SYSTEM}/waypoints/${g.wp}/construction/supply`, { shipSymbol: shipSym, tradeSymbol: sym, units: have });
      const m = (r.data.construction.materials || []).find((x) => x.tradeSymbol === sym);
      if (m) { const left = Math.max(0, m.required - m.fulfilled); if (left > 0) g.remaining[sym] = left; else delete g.remaining[sym]; }
      g.built = r.data.construction.isComplete || g.built;
      record(shipSym, 0, `SUPPLY_GATE ${sym} ${have}`);
      log(`📦 ${shipSym.slice(-3)} delivered orphan ${have} ${sym} → ${m ? `${m.fulfilled}/${m.required}` : 'ok'}${g.built ? ' 🎉 GATE COMPLETE' : ''}`);
      any = true;
    } catch (e) { log(`${shipSym.slice(-3)} orphan supply ERR ${sym}: ${e.message}`); }
  }
  return any;
}

// planRoute variant for when we carry FUEL as cargo: we can refuelFromCargo at ANY arrival waypoint, so any node
// (not just fuel markets) is a legal intermediate stop. Returns the hop list, or null if even a full tank can't
// cover the longest single leg between adjacent reachable nodes.
function planRouteFuelCargo(from, to, fuelCap, markets) {
  const cap = (fuelCap || 0) * 0.97;
  if (cap <= 0) return null;
  if (D(from, to) <= cap) return [to];
  const nodes = Object.keys(coords);
  const dist = {}, prev = {}, seen = new Set();
  for (const n of nodes) dist[n] = Infinity; dist[from] = 0;
  for (;;) {
    let u = null, best = Infinity;
    for (const n of nodes) if (!seen.has(n) && dist[n] < best) { best = dist[n]; u = n; }
    if (u === null || u === to) break;
    seen.add(u);
    for (const v of nodes) {
      if (v === u || seen.has(v)) continue;
      const d = D(u, v); if (d > cap) continue;          // one tankful per leg (topped from carried fuel on arrival)
      const t = d + 30;                                   // +per-hop refuel overhead so we prefer fewer hops
      if (dist[u] + t < dist[v]) { dist[v] = dist[u] + t; prev[v] = u; }
    }
  }
  if (dist[to] === Infinity) return null;
  const path = []; let c = to; while (c && c !== from) { path.unshift(c); c = prev[c]; }
  return path;
}

// Self-haul along a fuel-cargo route: top tank from carried FUEL before any leg the tank can't cover on its own.
async function haulWithFuelCargo(shipSym, path) {
  for (const hop of path) {
    let ship = await getShip(shipSym);
    if (ship.nav.waypointSymbol === hop && ship.nav.status !== 'IN_TRANSIT') continue;
    if (ship.fuel.current < D(ship.nav.waypointSymbol, hop)) await refuelFromCargo(shipSym).catch(() => {});
    ship = await getShip(shipSym);
    await navigate(shipSym, hop, chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode);
  }
}

// Strategy 3: if a gate hauler (or any gate-bound hull) is parked at our waypoint with free space, hand it the
// cargo — zero travel for us, and the hauler is already routed to the gate. Returns units transferred (0 = none).
async function tryTransferToCoLocatedHauler(shipSym, ship, held) {
  let fleet = [];
  try { fleet = await getAllShips(); } catch { return 0; }
  const wp = ship.nav.waypointSymbol;
  const candidates = fleet.filter((o) => o.symbol !== shipSym && isGateHauler(o.symbol)
    && o.nav.waypointSymbol === wp && o.nav.status !== 'IN_TRANSIT'
    && (o.cargo.capacity - (o.cargo.units || 0)) > 0);
  if (!candidates.length) return 0;
  let moved = 0;
  for (const tgt of candidates) {
    let free = tgt.cargo.capacity - (tgt.cargo.units || 0);
    for (const item of held) {
      if (free <= 0) break;
      const give = Math.min(item.units, free);
      if (give <= 0) continue;
      try { await transfer(shipSym, tgt.symbol, item.symbol, give); moved += give; free -= give; item.units -= give; log(`📦 ${shipSym.slice(-3)} handed ${give} ${item.symbol} → hauler ${tgt.symbol.slice(-3)} (co-located @${wp.slice(-3)})`); }
      catch (e) { log(`${shipSym.slice(-3)} orphan transfer ERR ${item.symbol}→${tgt.symbol.slice(-3)}: ${e.message}`); }
    }
  }
  return moved;
}

// Strategy 4 helper: nearest fuel node we can reach now that gets us closest to the gate (staging hop).
function nearestHopTowardGate(from, gateWp, fuelCap, markets) {
  const cap = (fuelCap || 0) * 0.97;
  const fuel = fuelNodes(markets);
  let best = null, bestD = D(from, gateWp);
  for (const n of fuel) {
    if (n === from || !coords[n]) continue;
    if (D(from, n) > cap) continue;                       // must be reachable on the current tank
    const dg = D(n, gateWp);
    if (dg < bestD) { bestD = dg; best = n; }
  }
  return best;
}

// Route a non-hauler's stranded gate cargo to the gate by the cheapest feasible means (see config comment).
// Returns true if it took ownership of this loop (worker should `continue`).
async function deliverOrphanGateCargo(shipSym, ship, markets) {
  if (!ORPHAN_GATE_DELIVERY) return false;
  if (!(GATE_SUPPLY && gateCache.exists && !gateCache.built && gateCache.known)) return false;
  if (isGateHauler(shipSym)) return false;                // dedicated haulers self-deliver via gateSupplyTrip
  const g = gateCache;
  const held = (ship.cargo.inventory || []).filter((i) => GATE_PROTECT_MATERIALS.has(i.symbol) && i.units > 0 && (g.remaining[i.symbol] || 0) > 0);
  if (!held.length) return false;
  const units = held.reduce((s, i) => s + i.units, 0);
  const free = ship.cargo.capacity - (ship.cargo.units || 0);
  if (units < ORPHAN_MIN_UNITS && free > 0) return false; // too little to justify a dedicated run; keep trading
  const syms = held.map((i) => i.symbol);
  const from = ship.nav.waypointSymbol;
  perShip[shipSym] = perShip[shipSym] || { net: 0, lanes: 0, last: '' };

  // Already at the gate → just hand it over.
  if (from === g.wp) {
    perShip[shipSym].last = `ORPHAN→GATE ${units}u`;
    try { if (ship.nav.status === 'IN_TRANSIT') await goTo(shipSym, g.wp); await supplyHeldToGate(shipSym, syms); }
    catch (e) { log(`${shipSym.slice(-3)} orphan supply ERR ${e.message}`); }
    return true;
  }

  // (1) SELF — fuel-aware multi-hop on the tank alone (cheapest; refuels at fuel-market nodes en route).
  const selfPath = planRoute(from, g.wp, ship.fuel.capacity, markets);
  if (selfPath) {
    perShip[shipSym].last = `ORPHAN→GATE ${units}u self`;
    log(`📦 ${shipSym.slice(-3)} orphan gate cargo [${held.map((i) => `${i.units} ${i.symbol}`).join(', ')}] → ${g.wp.slice(-3)} via ${selfPath.map((p) => p.slice(-3)).join('→')} (self-haul)`);
    try { await goTo(shipSym, g.wp); await supplyHeldToGate(shipSym, syms); }
    catch (e) { log(`${shipSym.slice(-3)} orphan self-haul ERR ${e.message}`); }
    return true;
  }

  // (3) TRANSFER — SELF is infeasible on the tank; if a gate hauler sits with us right now, hand off (no travel).
  if (await tryTransferToCoLocatedHauler(shipSym, ship, held)) { perShip[shipSym].last = `ORPHAN xfer ${units}u`; return true; }

  // (2) SELF + FUEL CARGO — carry FUEL in spare slots to bridge a dry leg the tank can't span.
  if (free > 0) {
    const augPath = planRouteFuelCargo(from, g.wp, ship.fuel.capacity, markets);
    if (augPath) {
      try {
        const wantFuel = Math.min(free, augPath.reduce((s, h, idx) => s + D(idx ? augPath[idx - 1] : from, h), 0));
        if (fuelNodes(markets).has(from) && wantFuel > 0) { try { await buy(shipSym, 'FUEL', wantFuel); } catch {} }
        perShip[shipSym].last = `ORPHAN→GATE ${units}u self+fuel`;
        log(`📦 ${shipSym.slice(-3)} orphan gate cargo → ${g.wp.slice(-3)} via ${augPath.map((p) => p.slice(-3)).join('→')} (self+fuel-cargo)`);
        await haulWithFuelCargo(shipSym, augPath);
        await supplyHeldToGate(shipSym, syms);
      } catch (e) { log(`${shipSym.slice(-3)} orphan self+fuel ERR ${e.message}`); }
      return true;
    }
  }

  // (4) TRANSFER + HOP — can't reach the gate or a hauler now; stage one fuel-node hop closer and retry next loop.
  const hop = nearestHopTowardGate(from, g.wp, ship.fuel.capacity, markets);
  if (hop && hop !== from) {
    perShip[shipSym].last = `ORPHAN stage→${hop.slice(-3)}`;
    log(`📦 ${shipSym.slice(-3)} orphan gate cargo: ${g.wp.slice(-3)} unreachable from ${from.slice(-3)} — staging to ${hop.slice(-3)} (await hauler / route)`);
    try { await goTo(shipSym, hop); } catch (e) { log(`${shipSym.slice(-3)} orphan stage ERR ${e.message}`); }
    return true;
  }

  // Truly boxed in (no route, no hauler, no staging hop). Hold position — never salvage protected gate cargo.
  perShip[shipSym].last = `ORPHAN stuck ${units}u`;
  log(`⚠ ${shipSym.slice(-3)} orphan gate cargo ${units}u stuck @${from.slice(-3)} (no route/hauler) — holding`);
  await sleep(IDLE_WAIT_MS);
  return true;
}

async function worker(shipSym) {
  perShip[shipSym] = { net: 0, lanes: 0, last: '' };
  while (!stop) {
    if (fs.existsSync(here('./STOP'))) break;
    let ship;
    try { ship = (await api('GET', `/my/ships/${shipSym}`)).data; } catch { await sleep(IDLE_WAIT_MS); continue; }
    const markets = await getMarkets();

    // [AUTO_EXPAND] Migrated ships are fully owned by the expansion subsystem: it drives their cross-system
    // arbitrage / local trading / scouting and manages their cargo. Route them here BEFORE recovery (so their
    // in-flight goods aren't salvage-sold) and before any home role. Wrapped so a member can never crash the fleet.
    if (expansion && expansion.isMember(shipSym)) {
      await expansion.step(shipSym, ship);
      continue;
    }
    // [REPAIR] Two-tier ship maintenance (default OFF). Runs in the ship's OWN loop so it never races an external
    // manager for control. Forced (integrity critical) diverts to a shipyard; opportunistic (worn) only fires when
    // already at one. Acted → re-loop with fresh state.
    if (REPAIR) { try { const yards = await getShipyards(); if (await maybeRepair(shipSym, ship, yards)) continue; } catch (e) { log(`🔧 ${shipSym.slice(-3)} repair check ERR ${e.message}`); } }

    // [RECOVERY] Before any new work, resume/salvage cargo left by a crash or STOP mid-haul. EXCEPTION: mining
    // colony hulls intentionally HOLD cargo (refiner holds feed for the tender, drones hold ore, tender holds
    // FUEL+feed) — salvaging it would yank them off-station, so they skip recovery and let their role manage cargo.
    const isColonyHull = MINE_FEED && !gateCache.built && !!mineRoleOf(ship);
    if (!isColonyHull && await reconcileHeldCargo(shipSym, ship, markets)) continue;

    // 0a) dedicated gate hauler: while the gate is unbuilt, this hull is pinned to gate-supply and
    //     skips contracts/trading entirely. Once the gate is built (or supply is off / no gate), it
    //     falls through and rejoins the normal trade pool. No gate work right now → park ($0).
    if (isGateHauler(shipSym)) {
      if (GATE_SUPPLY && gateCache.exists && !gateCache.built) {
        if (await gateSupplyTrip(shipSym, ship, markets)) continue;
        perShip[shipSym].last = 'PARKED (gate hauler, no supply now)';
        perShip[shipSym].projected = 0;
        await sleep(IDLE_WAIT_MS); continue;
      }
      // gate built / disabled → rejoin trading below
    }

    // 0b) dedicated INPUT_FEEDER: while the gate is unbuilt and Phase 4 is on, this hull is pinned to
    //     hauling the long-pole producer's inputs (a profit lane that restocks the gate material). Falls
    //     through to normal trading once the gate is built / INPUT_FEED is off / no feed is profitable now.
    if (isInputFeeder(shipSym) && inputFeedActive()) {
      if (await inputFeedTrip(shipSym, ship, markets)) continue;
      perShip[shipSym].last = 'PARKED (input feeder, no profitable feed now)';
      perShip[shipSym].projected = 0;
      await sleep(IDLE_WAIT_MS); continue;
    }

    // 0c) MINING COLONY: while the gate is unbuilt and MINE_FEED is on, any mining-capable hull (auto-detected
    //     by mounts/modules) is pinned to its role — REFINER / DRONE / SURVEYOR / TRANSPORT — and excluded from
    //     trading. Parked miners burn no fuel; only the transport commutes. Falls through to trading otherwise.
    if (MINE_FEED && !gateCache.built) {
      const role = mineRoleOf(ship);
      if (role) {
        let did = false;
        try {
          if (role === 'REFINER') did = await refinerTrip(shipSym, ship, markets);
          else if (role === 'DRONE') did = await droneTrip(shipSym, ship, markets);
          else if (role === 'SURVEYOR') did = await surveyorTrip(shipSym, ship, markets);
          else if (role === 'FUNNEL') did = await funnelTrip(shipSym, ship, markets);
          else if (role === 'TRANSPORT') did = await transportTrip(shipSym, ship, markets);
        } catch (e) {
          // [RULE: isolate-ship] one mining hull's error must NEVER crash the fleet — log, idle, retry next loop.
          log(`${shipSym.slice(-3)} ${role} ERR ${e.message}`); await sleep(IDLE_WAIT_MS); continue;
        }
        if (did) continue;
        perShip[shipSym].last = `PARKED (${role}, idle)`;
        perShip[shipSym].projected = 0;
        await sleep(IDLE_WAIT_MS); continue;
      }
    }
    // 0c-legacy) explicit solo MINE_FEEDER override (single ship does the whole loop) — kept for testing.
    if (isMineFeeder(shipSym) && MINE_FEED && !gateCache.built && !mineRoleOf(ship)) {
      if (await mineFeedTrip(shipSym, ship, markets)) continue;
      perShip[shipSym].last = 'PARKED (mine feeder, nothing minable now)';
      perShip[shipSym].projected = 0;
      await sleep(IDLE_WAIT_MS); continue;
    }

    // 0c-orphan) ORPHAN GATE CARGO: a trade-pool hull (not a dedicated hauler) holding gate materials —
    //    restart-preserved by the salvage-guard, or a fill-bias top-up — self-delivers to the gate by the
    //    cheapest feasible means before considering contracts/trading, so it never strands with a full,
    //    unsellable hold. See deliverOrphanGateCargo (SELF → SELF+fuel → TRANSFER → stage-hop).
    if (await deliverOrphanGateCargo(shipSym, ship, markets)) continue;

    // 0) CONTRACTS: run on whichever ship is best-positioned, gated by efficiency (contractWorthIt). Pinned hulls
    //    if CONTRACT_RUNNER is set, else ANY freighter (cargo >= 40). The runner self-gates and self-locks (one
    //    owner at a time), so ships for which sourcing isn't worth it from here simply fall through to trading.
    const contractEligible = CONTRACT_RUNNER.size ? isContractRunner(shipSym) : (ship.cargo.capacity >= 40);
    if (contractEligible) {
      if (await contractRunnerTrip(shipSym, ship, markets)) continue;
    }

    // 0b) deliver-what-you-hold: if this ship already carries the active contract's goods
    //    (e.g. left in-transit by a restart), route to the destination and fulfill — never re-source.
    if (activeContractInfo) {
      const held = ship.cargo.inventory.find((i) => i.symbol === activeContractInfo.good)?.units || 0;
      if (held >= activeContractInfo.units && contractWorkingId !== activeContractInfo.id) {
        contractWorkingId = activeContractInfo.id;
        perShip[shipSym].last = `DELIVER ${activeContractInfo.good}`;
        try {
          await goTo(shipSym, activeContractInfo.dest);
          await deliver(shipSym, activeContractInfo.id, activeContractInfo.good, activeContractInfo.units);
          await fulfill(shipSym, activeContractInfo.id);
          log(`✔ ${shipSym.slice(-3)} delivered held contract ${activeContractInfo.good}`);
        } catch (e) {
          log(`${shipSym} deliver-held ERR ${e.message}`);
          // contract likely already fulfilled by another ship → offload the now-useless surplus
          try { await sell(shipSym, activeContractInfo.good); } catch {}
        } finally { contractWorkingId = null; }
        continue;
      }
    }

    // 1) legacy opportunistic single-claim — DISABLED: contractRunnerTrip (above) now handles contracts for any
    //    eligible freighter with the efficiency gate. Kept off to avoid dup-claim races.
    const cc = null;
    if (cc) {
      const estCost = Math.ceil(cc.units * cc.px * 1.8);  // generous (contracts justify paying up)
      commit(estCost);
      perShip[shipSym].last = `CONTRACT ${cc.good}`;
      try {
        await runContract(shipSym, cc);
        contractFails.delete(cc.id);
        record(shipSym, 0, `CONTRACT ${cc.good} ✓`);   // contract payout lands on agent, not per-lane net
      } catch (e) {
        contractFails.set(cc.id, (contractFails.get(cc.id) || 0) + 1);
        log(`${shipSym} contract ERR ${e.message} (fail ${contractFails.get(cc.id)}/${MAX_CONTRACT_FAILS})`);
      } finally {
        contractWorkingId = null;                       // release lock so it can retry / re-queue
        uncommit(estCost);
      }
      continue;
    }

    // 2) best available normal lane
    const lanes = buildLanes(markets);
    const claim = claimLane(ship, lanes, markets);
    if (!claim) {
      if (await inputFeedTrip(shipSym, ship, markets)) continue;      // [INPUT_FEED] no lane → profitable input-feed (also accelerates the gate)
      if (await gateSupplyTrip(shipSym, ship, markets)) continue;     // [GATE] still no work → divert idle hull to supply the gate ($0)
      perShip[shipSym].last = 'PARKED (no profitable lane)'; await sleep(IDLE_WAIT_MS); continue;
    }
    if (claim.park) {                                                // [PARK] best lane below PARK_MIN_NET floor → idle, zero cost
      if (await inputFeedTrip(shipSym, ship, markets)) continue;      // [INPUT_FEED] prefer a profitable feed over parking
      if (await gateSupplyTrip(shipSym, ship, markets)) continue;     // [GATE] parked surplus hull → supply the gate instead of idling
      perShip[shipSym].last = `PARKED (best net ${Math.round(claim.projectedNet)} < ${PARK_MIN_NET})`;
      perShip[shipSym].projected = 0;
      await sleep(IDLE_WAIT_MS); continue;
    }
    const { lane } = claim;
    perShip[shipSym].last = `${lane.sym}`;
    perShip[shipSym].projected = claim.projectedNet;                  // expected net while in-flight (realized lands on sell)
    let realizedNet = 0, bought = 0, rideCommitted = 0;
    try {
      await goTo(shipSym, lane.buyWp);                                   // refuel-hop to source (handles outer lanes)
      const b = await buy(shipSym, lane.sym, lane.units, Math.round(lane.buy * 1.18));
      bought = b.bought || 0;
      if (!bought) {
        // [C] Price already moved past our cap / good depleted: nothing bought. Don't sail empty
        // to the sink — abort, let the finally-block penalize this lane so we stop re-picking it.
        log(`${shipSym.slice(-3)} ${lane.sym} bought 0 (price moved) — skipping, penalizing lane`);
      } else {
        // [MULTI-GOOD] Fill the rest of the hold with co-destination ride-alongs (same source, same sink).
        const rideAlongs = [];
        const freeUnits = ship.cargo.capacity - bought;
        for (const p of planRideAlongs(markets, lane, freeUnits, growthBudget())) {
          try {
            const rb = await buy(shipSym, p.sym, p.units, Math.round(p.buy * (1 + SLIPPAGE_FACTOR)));
            if (rb.bought > 0) {
              commit(rb.spent || 0); rideCommitted += rb.spent || 0;
              rideAlongs.push({ good: p.sym, units: rb.bought, costBasis: rb.spent || 0 });
            }
          } catch (e) { log(`${shipSym.slice(-3)} ride-along ${p.sym} ERR ${e.message}`); }
        }
        if (rideAlongs.length) log(`＋ ${shipSym.slice(-3)} ride-along ${rideAlongs.map((r) => `${r.units} ${r.good}`).join(', ')} → ${lane.sellWp.slice(-3)}`);
        // [RECOVERY] Persist the haul intent the instant we hold cargo, so a crash before the sell
        // can resume this exact leg (with cost basis) instead of stranding the goods. Ride-alongs share
        // the sink, so they ride in intent.extras and are replayed at the same sellWp on resume.
        saveIntent(shipSym, { phase: 'HAULING', good: lane.sym, units: bought, buyWp: lane.buyWp, sellWp: lane.sellWp, costBasis: b.spent || 0, extras: rideAlongs });
        await haulGoTo(shipSym, lane.sellWp, markets);                  // refuel-hop to sink; spare slots after goods carry bridging fuel
        const s = await sell(shipSym, lane.sym);
        realizedNet = (s.got || 0) - (b.spent || 0);
        for (const r of rideAlongs) {                                   // sell each ride-along at the shared sink
          try { const rs = await sell(shipSym, r.good); realizedNet += (rs.got || 0) - r.costBasis; }
          catch (e) { log(`${shipSym.slice(-3)} ride-along sell ${r.good} ERR ${e.message}`); }
        }
        clearIntent(shipSym);                                           // [RECOVERY] leg complete
        const tag = rideAlongs.length ? `${lane.sym}+${rideAlongs.length}` : lane.sym;
        record(shipSym, realizedNet, `${tag} ${lane.buyWp.slice(-3)}→${lane.sellWp.slice(-3)}`);
        const buyAvg = b.bought ? Math.round(b.spent / b.bought) : lane.buy;
        const sellAvg = b.bought ? Math.round((s.got || 0) / b.bought) : lane.sell;
        appendTradeObs({ good: lane.sym, buyWp: lane.buyWp, quotedBuy: lane.buy, buyAvg, slippage: buyAvg - lane.buy, sellWp: lane.sellWp, quotedSell: lane.sell, sellAvg, margin: lane.margin, units: b.bought, dist: lane.dist, projectedNet: claim.projectedNet, net: realizedNet, netVsProjected: realizedNet - claim.projectedNet, cooldownMs: cooldownFor(lane.sym), rideAlongs: rideAlongs.length });
      }
    } catch (e) { log(`${shipSym} lane ERR ${e.message}`); }
    finally {
      perShip[shipSym].projected = 0;
      if (rideCommitted) uncommit(rideCommitted);                          // release ride-along reserved cash
      const st = gs(lane.sym);
      st.lockedBy = null;
      // [C] Adaptive cooldown keyed off the REALIZED outcome (not just snapshot margin EMA).
      // A dead lane (bought 0 or net<=0) rests far longer and escalates on repeats, so ships
      // spread to live lanes instead of dogpiling a depleted/price-moved one.
      let cd = cooldownFor(lane.sym);
      if (bought === 0 || realizedNet <= 0) {
        st.deadStreak = (st.deadStreak || 0) + 1;
        cd = Math.max(cd, COOLDOWN_MS) * DEAD_LANE_PENALTY * (1 + 0.5 * (st.deadStreak - 1));
      } else st.deadStreak = 0;
      st.cooldownUntil = now() + Math.round(cd);
      uncommit(claim.cost);                                                  // release reserved cash
    }
  }
  log(`${shipSym} worker stopped`);
}

function record(shipSym, net, label) {
  perShip[shipSym].net += net; perShip[shipSym].lanes += 1;
  totalNet += net; lanesRun += 1;
  persistRunStats();   // [B] survive restarts — crash loop must not read as a flatline
  log(`✔ ${shipSym.slice(-3)} ${label} net=${net.toLocaleString()} | run total +${totalNet.toLocaleString()} over ${lanesRun} lanes`);
  writeStatus();
}

let lastStatusAt = 0;
const plannedRoutes = {};   // [TABLE] shipSym -> {from, path:[hops], at} captured by goTo for the fleet table's route column
const fleetRoutes = {};     // [ROUTE] short ship id (last 3) -> full multihop route string, refreshed by fleetTable() for the dashboard
function writeStatus() {
  if (now() - lastStatusAt < 4000) return; lastStatusAt = now();
  const ships = Object.entries(perShip).map(([s, v]) => ({ ship: s.slice(-3), net: v.net, projected: v.projected || 0, lanes: v.lanes, doing: v.last, route: fleetRoutes[s.slice(-3)] || null }));
  const inFlightProjected = ships.reduce((a, s) => a + (s.projected || 0), 0);   // expected net of trades currently mid-flight
  fs.writeFileSync(here('./bot-status.json'), JSON.stringify({ updated: new Date().toISOString(), phase: currentPhase.name, phaseDesc: currentPhase.desc, runNet: totalNet, inFlightProjected, projectedTotal: totalNet + inFlightProjected, lanesRun, goal: expansionTarget, goalBreakdown: targetBreakdown, credits: cachedCredits, reserve: OPERATING_RESERVE, committed, growthBudget: growthBudget(), gate: { exists: gateCache.exists, built: gateCache.built, known: gateCache.known, remaining: gateCache.remaining, haulers: [...GATE_HAULERS], supplying: gateSupplyActive() && gateCreditOk(), buyPaused: gateBuyPaused, creditFloor: GATE_CREDIT_FLOOR, creditResume: GATE_CREDIT_RESUME }, inputFeed: { enabled: INPUT_FEED, active: inputFeedActive(), feeders: [...INPUT_FEEDERS], busy: [...inputActiveFeeders].map((s) => s.slice(-3)) }, mineFeed: { enabled: MINE_FEED, feeders: [...MINE_FEEDERS], busy: [...mineActive].map((s) => s.slice(-3)), good: MINE_GOOD || 'auto', site: mineSite, refiner: refinerSym && refinerSym.slice(-3), transport: [...MINE_TRANSPORT] }, expand: expansion ? expansion.statusBlock() : { enabled: false }, ships }, null, 1));
  const rows = ships.sort((a, b) => b.net - a.net).map((s) => `| ${s.ship} | ${s.net.toLocaleString()} | ${(s.projected || 0) ? '+' + s.projected.toLocaleString() : '—'} | ${s.lanes} | ${s.doing} |`).join('\n');
  const block = `\n\n## 🤖 AUTOTRADER v2 live (continuous)\n_run net **+${totalNet.toLocaleString()}** + in-flight projected **+${inFlightProjected.toLocaleString()}** · updated ${new Date().toISOString().slice(11, 19)}_\n\n| Ship | Run net | In-flight proj | Lanes | Last/now |\n|---|---:|---:|---:|---|\n${rows}\n`;
  const base = fs.readFileSync(here('./tracker.md'), 'utf8').split('\n## 🤖 AUTOTRADER')[0];
  fs.writeFileSync(here('./tracker.md'), base + block);
}

let lastGateState = null;

// [FLEET TABLE] Periodically log a human-readable table: ship, role, status, location, route plan (src→stops→dest),
// fuel, cargo, eta. Reads the fleet in one paginated pass (~3 API calls) every FLEET_TABLE_MS. Off via FLEET_TABLE=0.
const FLEET_TABLE = process.env.FLEET_TABLE !== '0';
const FLEET_TABLE_MS = Number(process.env.FLEET_TABLE_MS || 60000);
const SH = (w) => (w || '').replace('X1-PP30-', '');
function tableRoleOf(ship) {
  const r = mineRoleOf(ship); if (r) return r;
  if (contractOwner && contractOwner.ship === ship.symbol) return 'CONTRACT';
  if (typeof isGateHauler === 'function' && isGateHauler(ship.symbol)) return 'GATE';
  if (typeof isInputFeeder === 'function' && isInputFeeder(ship.symbol)) return 'FEEDER';
  return 'TRADE';
}
function routeStr(ship) {
  const pr = plannedRoutes[ship.symbol];
  if (pr && now() - pr.at < 20 * 60 * 1000 && (ship.nav.status === 'IN_TRANSIT' || ship.nav.waypointSymbol !== pr.path[pr.path.length - 1])) {
    return [pr.from, ...pr.path].map(SH).join('→');
  }
  if (ship.nav.status === 'IN_TRANSIT' && ship.nav.route) return `${SH(ship.nav.route.origin?.symbol)}→${SH(ship.nav.route.destination?.symbol)}`;
  return '—';
}
function etaStr(ship) {
  if (ship.nav.status !== 'IN_TRANSIT' || !ship.nav.route?.arrival) return '—';
  const s = Math.max(0, Math.round((new Date(ship.nav.route.arrival).getTime() - Date.now()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
function cargoStr(ship) {
  const inv = (ship.cargo.inventory || []).filter((i) => i.symbol !== 'FUEL').map((i) => i.units + i.symbol.replace(/_.*/, '').slice(0, 3)).join(',');
  return `${ship.cargo.units}/${ship.cargo.capacity}${inv ? ' ' + inv : ''}`;
}
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
async function fleetTable() {
  if (!FLEET_TABLE) return;
  while (!stop) {
    await sleep(FLEET_TABLE_MS);
    try {
      const all = await getAllShips();
      const rows = all.filter((s) => s.cargo.capacity > 0).map((s) => ({
        ship: s.symbol.slice(-3), role: tableRoleOf(s), status: s.nav.status, loc: SH(s.nav.waypointSymbol),
        route: routeStr(s), fuel: s.fuel.capacity ? `${s.fuel.current}/${s.fuel.capacity}` : '—', cargo: cargoStr(s), eta: etaStr(s),
      }));
      // [ROUTE] stash each ship's full multihop route for writeStatus()/the dashboard (replaces the old 📋 FLEET log table)
      for (const r of rows) fleetRoutes[r.ship] = r.route;
    } catch (e) { log('fleetTable:', e.message); }
  }
}

async function targetWatch() {
  while (!stop) {
    await refreshCredits();
    await recomputeReserve();   // reserve tracks the fleet over time (time-series → DB in v2)
    if (DYNAMIC_TARGET) expansionTarget = await computeExpansionTarget(marketCache.data || {});
    // [PHASE] Re-derive the strategy phase from fresh live state; log only on transition.
    const newPhase = determinePhase();
    if (newPhase !== currentPhase) { log(`🧭 phase ${currentPhase.name} → ${newPhase.name} (${newPhase.desc})`); currentPhase = newPhase; }
    // surface gate progress changes (shared site — other agents may build it, dropping our cost)
    const gstate = JSON.stringify(targetBreakdown.gateBuilt) + (targetBreakdown.gateMaterials ?? '');
    if (gstate !== lastGateState) { lastGateState = gstate; log(`🛰 gate status: built=${targetBreakdown.gateBuilt} materials-cost=${(targetBreakdown.gateMaterials||0).toLocaleString()} → goal ${expansionTarget.toLocaleString()}`); }
    // [AUTO_EXPAND] As soon as the gate is BUILT, trigger the one-time migration (self-gates on gateBuilt + flag).
    if (expansion) { try { await expansion.maybeTrigger(); } catch (e) { log(`🪐 maybeTrigger ERR ${e.message}`); } }
    if (cachedCredits >= expansionTarget && targetBreakdown.gateStatusKnown) {
      // [A] Only stop when the gate status is actually KNOWN. An unknown/unreachable gate
      // (outage) leaves gateStatusKnown=false → never a phantom EXPANSION-READY stop.
      // [GATE] When opportunistic gate-supply is enabled and the gate is still UNBUILT, don't stop:
      // keep trading + feeding the gate until it completes (the build IS the expansion). Once the
      // gate is built (by us or the shared system), the credit goal becomes the meaningful stop.
      if (GATE_SUPPLY && gateCache.exists && !gateCache.built) {
        log(`🎯 cost-to-expand met (${cachedCredits.toLocaleString()} ≥ ${expansionTarget.toLocaleString()}) but gate UNBUILT — continuing to trade + supply the gate (${Object.entries(gateCache.remaining).map(([k, v]) => `${v}× ${k}`).join(', ') || 'finalizing'})`);
      } else if (AUTO_EXPAND) {
        // YOLO mode: do NOT halt at the credit goal. Keep the home fleet trading AND run the inter-system
        // expansion (migrated ships trade across the gate). The run only ends on STOP.
      } else {
        log(`🎯 EXPANSION-READY: credits ${cachedCredits.toLocaleString()} ≥ cost-to-expand ${expansionTarget.toLocaleString()} ${JSON.stringify(targetBreakdown)}`);
        stop = true; break;
      }
    }
    await sleep(30_000);
  }
}

// ============================ [REPAIR + MINE_EXPAND] shipyards, repair, colony growth ============================
// Discover the system's shipyards once (cached 10min): merge each yard's offerings into a { SHIP_TYPE: {wp, price} }
// map (cheapest wp per type). `ships[]` carries live price; `shipTypes[]` lists types sold even when no example ship
// is docked (price unknown until one is). Used by both repair (nearest shipyard) and mine-expand (where to buy).
let shipyardCache = { at: 0, yards: {} };
async function getShipyards(force = false) {
  if (!force && shipyardCache.at && now() - shipyardCache.at < 600_000) return shipyardCache.yards;
  const yards = {};
  try {
    const wps = (await api('GET', `/systems/${SYSTEM}/waypoints?limit=20&traits=SHIPYARD`)).data || [];
    for (const w of wps) {
      try {
        const sy = (await api('GET', `/systems/${SYSTEM}/waypoints/${w.symbol}/shipyard`)).data;
        for (const s of sy.ships || []) if (!yards[s.type] || s.purchasePrice < (yards[s.type].price ?? Infinity)) yards[s.type] = { wp: w.symbol, price: s.purchasePrice };
        for (const t of sy.shipTypes || []) if (!yards[t.type]) yards[t.type] = { wp: w.symbol, price: null }; // sold here, price unknown until a ship is present
      } catch {}
    }
  } catch {}
  shipyardCache = { at: now(), yards };
  return yards;
}
const shipyardWps = (yards) => [...new Set(Object.values(yards).map((y) => y.wp).filter(Boolean))];
const isShipyardWp = (wp, yards) => shipyardWps(yards).includes(wp);
function nearestShipyardWp(fromWp, yards) {
  let best = null, bd = Infinity;
  for (const wp of shipyardWps(yards)) { const d = D(fromWp, wp); if (d < bd) { bd = d; best = wp; } }
  return best;
}
// min across the 3 wearable components; missing components default to healthy (1) so they never falsely trigger.
const minCondition = (s) => Math.min(1, ...[s.frame?.condition, s.reactor?.condition, s.engine?.condition].filter((x) => x != null));
const minIntegrity = (s) => Math.min(1, ...[s.frame?.integrity, s.reactor?.integrity, s.engine?.integrity].filter((x) => x != null));

// Repair a ship that is DOCKED at a shipyard (caller must dock first). Quotes, budget/cap-gates, then repairs.
// Spends only growthBudget (commit/uncommit so concurrent buys don't oversubscribe). Returns credits spent (0 = skipped).
async function repairAt(shipSym) {
  let cost = 0;
  try { const q = (await api('GET', `/my/ships/${shipSym}/repair`)).data; cost = q.transaction?.totalPrice ?? q.transaction?.price ?? 0; }
  catch (e) { log(`🔧 ${shipSym.slice(-3)} repair quote failed: ${e.message}`); return 0; }
  if (cost <= 0) return 0;
  if (cost > REPAIR_MAX_COST) { log(`🔧 ${shipSym.slice(-3)} repair quote ${cost.toLocaleString()} > cap ${REPAIR_MAX_COST.toLocaleString()} — skip`); return 0; }
  if (cost > growthBudget()) { log(`🔧 ${shipSym.slice(-3)} repair ${cost.toLocaleString()} > growthBudget — defer`); return 0; }
  commit(cost);
  try { await api('POST', `/my/ships/${shipSym}/repair`); log(`🔧 ${shipSym.slice(-3)} repaired for ${cost.toLocaleString()}`); }
  catch (e) { log(`🔧 ${shipSym.slice(-3)} repair failed: ${e.message}`); uncommit(cost); return 0; }
  uncommit(cost);
  await refreshCredits();
  return cost;
}
// Two-tier repair, called early in each worker loop (the ship's own loop → race-free). Returns true if it acted
// (caller should `continue` to re-read fresh state next cycle).
async function maybeRepair(shipSym, ship, yards) {
  if (!REPAIR || !shipyardWps(yards).length) return false;
  const cond = minCondition(ship), integ = minIntegrity(ship);
  const forced = integ < REPAIR_INTEG_FORCE, worn = cond < REPAIR_COND_MIN;
  if (!forced && !worn) return false;
  const wp = ship.nav.waypointSymbol, atYard = ship.nav.status !== 'IN_TRANSIT' && isShipyardWp(wp, yards);
  if (!forced && worn && !atYard) return false;            // opportunistic only fires when ALREADY at a shipyard (no detour)
  if (forced && !atYard) {                                  // forced: divert to nearest shipyard
    const dest = nearestShipyardWp(wp, yards);
    if (!dest) return false;
    log(`🔧 ${shipSym.slice(-3)} integrity ${(integ * 100).toFixed(0)}% < ${(REPAIR_INTEG_FORCE * 100).toFixed(0)}% — diverting to shipyard ${dest.slice(-3)}`);
    await goTo(shipSym, dest);
  }
  try { await api('POST', `/my/ships/${shipSym}/dock`); } catch {}   // repair requires DOCKED
  const spent = await repairAt(shipSym);
  return forced || spent > 0;
}

// Buy a colony ship at a shipyard (requires one of our hulls present at that waypoint — we keep probes at the
// system shipyards). Returns the new ship symbol or null.
async function buyMiningShip(shipType, wp) {
  try {
    const r = await api('POST', '/my/ships', { shipType, waypointSymbol: wp });
    await refreshCredits();
    return r.data?.ship?.symbol || null;
  } catch (e) { log(`🪐 buy ${shipType} @ ${wp.slice(-3)} failed: ${e.message}`); return null; }
}

// Manager loop: grow the mining colony with surveyors (first) then drones, under hard caps, only while the gate is
// unbuilt, funded purely from growthBudget above MINE_EXPAND_CREDIT_FLOOR. A bought hull is given its own supervised
// worker (launchWorker); its capability-detected mining role then drives it to the asteroid — no explicit ferry here
// (that would race the role loop for control of the ship).
async function mineExpandManager() {
  if (!MINE_EXPAND) return;
  await sleep(20_000);                                     // let startup + first credit refresh settle
  while (!stop) {
    try {
      if (MINE_FEED && !gateCache.built && gateCache.exists) {
        await refreshCredits();
        const all = await getAllShips();
        const surveyors = all.filter((s) => hasMount(s, /SURVEYOR/)).length;
        const drones = all.filter((s) => hasMount(s, /MINING_LASER/) && !hasMount(s, /SURVEYOR/)).length;
        const yards = await getShipyards();
        let want = null;
        if (surveyors < MINE_MAX_SURVEYORS && yards.SHIP_SURVEYOR) want = 'SHIP_SURVEYOR';
        else if (drones < MINE_MAX_DRONES && yards.SHIP_MINING_DRONE) want = 'SHIP_MINING_DRONE';
        if (want) {
          const yard = yards[want];
          const price = yard.price || (want === 'SHIP_SURVEYOR' ? 40_000 : 50_000);   // estimate when no example ship is docked
          if (price <= growthBudget() && cachedCredits - price >= MINE_EXPAND_CREDIT_FLOOR) {
            const bought = await buyMiningShip(want, yard.wp);
            if (bought) { log(`🪐 MINE_EXPAND bought ${want} ${bought.slice(-3)} @ ${yard.wp.slice(-3)} (surveyors ${surveyors}→, drones ${drones}→)`); launchWorker(bought); }
          }
        }
      }
    } catch (e) { log(`🪐 MINE_EXPAND ERR ${e.message}`); }
    await sleep(MINE_EXPAND_SCAN_MS);
  }
}

// [MINE_MIGRATE] Watch the colony's rock for depletion and relocate when it's mined out. Depletion is read from the
// waypoint's `modifiers`: migrate on STRIPPED always, and proactively on CRITICAL_LIMIT when a healthy alternative
// rock with the same deposit exists. Migration just invalidates the cached site/asteroid list + stale surveys; the
// colony role loops (refiner/drones/surveyor/funnel) re-pick the nearest non-depleted rock on their next cycle and
// relocate there. In-transit hulls can't be turned mid-flight (no API cancel) — they're redirected on arrival.
async function mineMigrateManager() {
  if (!MINE_MIGRATE) return;
  await sleep(30_000);                                    // let the colony pick + reach its first rock
  while (!stop) {
    try {
      if (MINE_FEED && !gateCache.built && mineSite) {
        const site = mineSite;
        const mods = await waypointMods(site);
        const stripped = mods.includes('STRIPPED');
        const critical = mods.includes('CRITICAL_LIMIT');
        if (stripped || critical) {
          const dep = depositOfSite(site);
          await loadAsteroids();
          const alt = (asteroidCache[dep] || []).find((w) => w !== site && !depletedSites.has(w));
          if (alt) {
            depletedSites.add(site);
            mineSurveys = mineSurveys.filter((s) => s.symbol !== site);   // drop stale surveys for the dead rock
            mineSite = null;                                              // colony role loops re-pick next cycle
            asteroidCache = null;                                         // force a fresh modifier-aware reload
            await loadAsteroids();
            const prod = MINE_PRODUCER || findProducerWp(marketCache.data || {}, 'FAB_MATS');
            const next = nearestAsteroid(prod || site, dep);
            let inflight = [];
            try { inflight = (await getAllShips()).filter((s) => s.nav.status === 'IN_TRANSIT' && s.nav.route?.destination?.symbol === site).map((s) => s.symbol.slice(-3)); } catch {}
            log(`🪐 MINE_MIGRATE ${site.slice(-3)} ${stripped ? 'STRIPPED' : 'CRITICAL_LIMIT'} → relocating colony to ${next ? next.slice(-3) : '??'}${inflight.length ? ` (redirect on arrival: ${inflight.join(',')})` : ''}`);
          } else if (stripped) {
            log(`🪐 MINE_MIGRATE ${site.slice(-3)} STRIPPED but no healthy alternative rock — staying (reduced yield)`);
          }
        }
      }
    } catch (e) { log(`🪐 MINE_MIGRATE ERR ${e.message}`); }
    await sleep(MINE_MIGRATE_SCAN_MS);
  }
}

// [RULE: keep-fleet-alive] supervise each worker — if one throws, log and restart it after a short backoff instead
// of letting the rejection bubble up and kill every other ship. Hoisted to module scope so a dynamically-bought hull
// (MINE_EXPAND) can be given its own supervised worker via launchWorker without double-spawning an existing one.
const launchedWorkers = new Set();
const supervise = async (sym) => { while (!stop) { try { await worker(sym); return; } catch (e) { log(`${sym.slice(-3)} worker crashed: ${e.message} — restarting in 5s`); await sleep(5000); } } };
function launchWorker(sym) { if (launchedWorkers.has(sym)) return; launchedWorkers.add(sym); supervise(sym); }

async function main() {
  fs.rmSync(here('./STOP'), { force: true });
  await refreshCredits();
  await recomputeReserve();
  await getMarkets();
  if (DYNAMIC_TARGET) expansionTarget = await computeExpansionTarget(marketCache.data || {});
  log(`AUTOTRADER v2 starting. goal=${expansionTarget.toLocaleString()} ${DYNAMIC_TARGET ? '(dynamic cost-to-expand ' + JSON.stringify(targetBreakdown) + ')' : '(pinned)'} reserve=${OPERATING_RESERVE.toLocaleString()} credits=${cachedCredits.toLocaleString()} cooldown=${COOLDOWN_MS / 1000}s VoT=${VALUE_OF_TIME}/s`);
  const all = await getAllShips();
  // [CONTRACT] Discover the active contract BEFORE workers start so reconcileHeldCargo doesn't salvage-sell goods
  // that belong to an in-flight contract on a mid-haul restart (that both loses the goods and churns the source
  // market's price). The guard at reconcileHeldCargo keys off activeContractInfo, which contractManager otherwise
  // wouldn't populate until its first (rate-limited, ~slow) cycle — after the first reconcile has already run.
  try {
    const a0 = (await getAllContracts()).find((c) => c.accepted && !c.fulfilled);
    if (a0) { const d0 = a0.terms.deliver[0]; activeContractInfo = { id: a0.id, good: d0.tradeSymbol, dest: d0.destinationSymbol, units: d0.unitsRequired - d0.unitsFulfilled, pay: a0.terms.payment.onFulfilled }; log(`↺ active contract on startup: ${activeContractInfo.units} ${d0.tradeSymbol} → ${d0.destinationSymbol.slice(-3)} (protected from salvage)`); }
  } catch (e) { log('startup contract discovery:', e.message); }
  const traders = all.filter((s) => s.cargo.capacity > 0 && s.frame.symbol !== 'FRAME_PROBE' && s.fuel.capacity > 0);
  fleetMaxSpeed = Math.max(1, ...traders.map((s) => s.engine?.speed || 1));   // [D] fastest hull → far-lane bias reference
  if (MINE_FEED) { mineTenderSym = [...MINE_TRANSPORT][0] ? null : pickMineTender(all); const t = mineTenderSym || [...MINE_TRANSPORT].join(','); log(`⛏️ mining colony ON — tender: ${t || 'NONE (ferry disabled, miners still extract/refine)'}`); }
  log(`workers: ${traders.map((s) => s.symbol.slice(-3) + '(spd' + s.engine.speed + ',cap' + s.cargo.capacity + ')').join(' ')}`);
  fleetSize = traders.length;            // [PHASE] feed determinePhase before the loops/targetWatch start
  currentPhase = determinePhase();
  log(`🧭 phase ${currentPhase.name} — ${currentPhase.desc}`);
  // [AUTO_EXPAND] Build the expansion subsystem with runtime closures over live state. Inert unless AUTO_EXPAND=1
  // AND the gate is built (maybeTrigger self-gates). Members are routed at the top of worker(); probes get their
  // own supervised workers (they're excluded from the home `traders` pool).
  if (AUTO_EXPAND) {
    expansion = createExpansion({
      api, log, sleep, now,
      navigate, refuel, buy, sell, jump, getShip, getAllShips,
      coords, D, chooseMode, planRoute, record,
      homeSystem: SYSTEM,
      gateWp: () => gateCache.wp,
      gateBuilt: () => gateCache.built,
      getCredits: () => cachedCredits,
      reserve: () => OPERATING_RESERVE,
      homeMarkets: () => marketCache.data || {},
      fuelPx: () => FUEL_PX,
      launchWorker,
    });
    log(`🪐 AUTO_EXPAND armed — will migrate ships through the gate once it is BUILT (target ${process.env.EXPAND_TARGET_SYSTEM || 'auto'}).`);
  }
  // [RULE: keep-fleet-alive] supervise hoisted to module scope (see above). Register initial hulls so MINE_EXPAND
  // never double-spawns one, and keep their supervised promises in `tasks` so Promise.all keeps the process alive.
  const tasks = traders.map((s) => { launchedWorkers.add(s.symbol); return supervise(s.symbol); });
  tasks.push(contractManager(), targetWatch(), fleetTable(), mineExpandManager(), mineMigrateManager());
  const stopWatch = (async () => { while (!stop) { if (fs.existsSync(here('./STOP'))) { stop = true; break; } await sleep(3000); } })();
  await Promise.all([...tasks, stopWatch]);
  log(`AUTOTRADER stopped. run net +${totalNet.toLocaleString()} over ${lanesRun} lanes`);
}
main().catch((e) => { log('FATAL', e.message, e.data ? JSON.stringify(e.data) : ''); process.exit(1); });
