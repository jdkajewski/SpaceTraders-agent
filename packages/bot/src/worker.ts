/**
 * worker.ts — per-ship decision loop + supervisor + stop handling
 * (port of bot2.mjs L2255–2270 goTo, L2545–2772 worker, L3150 supervise, and the
 * STOP-file → signal change in DRIFT #22).
 *
 * The loop is an ordered, first-match cascade (docs/02 §3): recovery → the Wave-4
 * subsystem hooks (gate hauler, input feeder, mining, orphan-gate, contracts) → TRADE.
 * Wave-4 subsystems are **injected** as `WorkerHooks`; the defaults are no-ops, so this
 * Wave-3 build runs the real recovery→TRADE path and cleanly grows into Wave 4/5 by
 * supplying live hooks. `supervise()` restarts a crashed worker (keep-fleet-alive).
 */

import type { Config, Market, Ship, TradeObservation } from '@st/shared';
import type { BotState } from './runtime/state.js';
import type { MarketsService, PersistenceClient, Router, ShipActions, SpaceTradersClient } from './interfaces.js';
import type { MarketsServiceExtra } from './market/markets.js';
import type { DistFn } from './trade/lanes.js';
import { buildLanes, claimLane, planRideAlongs, cooldownFor } from './trade/lanes.js';
import { gs } from './runtime/state.js';
import { commit, uncommit, growthBudget } from './budget/budget.js';
import { record } from './status.js';
import { saveIntent, clearIntent, reconcileHeldCargo, type StoredRideAlong } from './recovery.js';
import { logger } from './core/logger.js';

const log = logger.child({ mod: 'worker' });
const now = (): number => Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const IDLE_WAIT_MS = 12_000; // worker wait when no lane available (bot2 L142)

// ── injected Wave-4 subsystem hooks (default no-ops) ─────────────────────────

/** A subsystem step: acted? → caller should `continue` the loop. */
export type WorkerHook = (shipSym: string, ship: Ship, markets: Record<string, Market>) => Promise<boolean>;

/**
 * Wave-4 subsystems, injected so Wave 3 stays trading-only. Each returns true when it
 * handled the ship this loop (the worker then `continue`s). All default to no-ops.
 */
export interface WorkerHooks {
  /**
   * Inter-system expansion member dispatch (Wave 5). When a ship has been migrated to the
   * expansion fleet this handles it end-to-end and short-circuits the rest of the loop — runs
   * FIRST, before repair/recovery (bot2 worker top: `if (expansion.isMember) { step; continue }`).
   */
  expansion: WorkerHook;
  /** Two-tier ship maintenance (opportunistic/forced); runs before recovery (bot2 parity). */
  repair: WorkerHook;
  /** Dedicated gate hauler (pinned to gate-supply while unbuilt). */
  gateHauler: WorkerHook;
  /** Dedicated input feeder (long-pole producer inputs). */
  inputFeeder: WorkerHook;
  /** Mining colony role dispatch (refiner/drone/surveyor/transport). */
  mining: WorkerHook;
  /** Orphan gate cargo self-delivery. */
  orphanGate: WorkerHook;
  /** Contract pipeline (claim + deliver-held). */
  contracts: WorkerHook;
  /** Idle fallback: divert to a gate-supply trip ($0 but accelerates the gate). */
  gateSupplyTrip: WorkerHook;
  /** Idle fallback: profitable input-feed trip. */
  inputFeedTrip: WorkerHook;
  /** Mining colony hulls intentionally hold cargo → skip recovery salvage. */
  isColonyHull: (ship: Ship) => boolean;
}

const noHook: WorkerHook = () => Promise.resolve(false);

/** Default hooks: every Wave-4 subsystem disabled (no-op). */
export const noopHooks: WorkerHooks = {
  expansion: noHook,
  repair: noHook,
  gateHauler: noHook,
  inputFeeder: noHook,
  mining: noHook,
  orphanGate: noHook,
  contracts: noHook,
  gateSupplyTrip: noHook,
  inputFeedTrip: noHook,
  isColonyHull: () => false,
};

// ── worker dependencies ──────────────────────────────────────────────────────

export interface WorkerDeps {
  state: BotState;
  cfg: Config;
  actions: ShipActions;
  router: Router;
  markets: MarketsService & MarketsServiceExtra;
  persistence: PersistenceClient;
  /** Direct SpaceTraders client (Wave-4 subsystems: negotiate/extract/refine/shipyard/repair). */
  client: SpaceTradersClient;
  D: DistFn;
  hooks?: Partial<WorkerHooks>;
}

interface ResolvedDeps extends Omit<WorkerDeps, 'hooks'> {
  hooks: WorkerHooks;
}

// ── navigation (bot2 goTo L2255) ─────────────────────────────────────────────

/** Minimal deps for refuel-aware navigation — shared by the worker and Wave-4 subsystems. */
export interface NavDeps {
  state: BotState;
  actions: ShipActions;
  router: Router;
  D: DistFn;
}

/**
 * Refuel-aware navigation: plan a ≤1-tank-hop route and fly it (CRUISE/BURN/DRIFT per
 * leg). Records the planned route for the fleet table. A tank-only-infeasible route
 * DRIFTs the direct leg as the last resort (FUEL_CARGO bridging is a Wave-4 concern).
 * (bot2 `goTo`)
 */
export async function goTo(
  shipSym: string,
  dest: string,
  markets: Record<string, Market>,
  deps: NavDeps,
): Promise<void> {
  const { state, actions, router, D } = deps;
  let ship = await actions.getShip(shipSym);
  if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') {
    delete state.plannedRoutes[shipSym];
    return;
  }
  const path = router.planRoute(ship.nav.waypointSymbol, dest, ship.fuel.capacity, markets);
  if (!path) {
    state.plannedRoutes[shipSym] = { from: ship.nav.waypointSymbol, path: [dest], at: now() };
    await actions.navigate(shipSym, dest, router.chooseMode(D(ship.nav.waypointSymbol, dest), ship).mode);
    return;
  }
  state.plannedRoutes[shipSym] = { from: ship.nav.waypointSymbol, path: [...path], at: now() };
  if (path.length > 1)
    log.info(`${shipSym} routing ${ship.nav.waypointSymbol.slice(-3)}→${dest.slice(-3)} via ${path.map((p) => p.slice(-3)).join('→')} (refuel-hop)`);
  for (const hop of path) {
    ship = await actions.getShip(shipSym);
    await actions.navigate(shipSym, hop, router.chooseMode(D(ship.nav.waypointSymbol, hop), ship).mode);
  }
}

// ── per-ship worker (bot2 worker L2545) ──────────────────────────────────────

/**
 * The per-ship decision loop. Runs until `state.stop`. Ordered first-match cascade:
 * recovery → gate hauler → input feeder → mining → orphan-gate → contracts → TRADE →
 * idle fallbacks. Wave-3 ships only ever hit recovery + TRADE (the hooks are no-ops).
 */
export async function worker(shipSym: string, rawDeps: WorkerDeps): Promise<void> {
  const deps: ResolvedDeps = { ...rawDeps, hooks: { ...noopHooks, ...rawDeps.hooks } };
  const { state, cfg, actions, router, markets: marketsSvc, persistence, hooks } = deps;

  const recordFn = (sym: string, net: number, label: string): Promise<void> => record(state, cfg, persistence, sym, net, label);

  state.perShip[shipSym] = { net: 0, lanes: 0, last: '' };
  while (!state.stop) {
    let ship: Ship;
    try {
      ship = await actions.getShip(shipSym);
    } catch {
      await sleep(IDLE_WAIT_MS);
      continue;
    }
    const markets = await marketsSvc.getMarkets();
    const go = (sym: string, dest: string): Promise<void> => goTo(sym, dest, markets, deps);

    // [EXPANSION] If this ship has been migrated into the inter-system expansion fleet, the
    // expansion subsystem owns it end-to-end. Runs FIRST — before repair/recovery — so a member's
    // cross-system flight is never interrupted by home-system maintenance. (bot2 worker top, Wave 5)
    if (await hooks.expansion(shipSym, ship, markets)) continue;

    // [REPAIR] Two-tier ship maintenance (default OFF). Runs in the ship's OWN loop, BEFORE recovery, so a
    // forced-divert to a shipyard happens before any new work and never races an external manager. (bot2 L2562)
    if (await hooks.repair(shipSym, ship, markets)) continue;

    // [RECOVERY] Before any new work, resume/salvage cargo left by a crash or STOP mid-haul. Mining
    // colony hulls intentionally HOLD cargo, so they skip recovery and let their role manage it.
    const isColonyHull = hooks.isColonyHull(ship);
    if (
      !isColonyHull &&
      (await reconcileHeldCargo(shipSym, ship, markets, {
        state,
        cfg,
        persistence,
        sell: (s, g) => actions.sell(s, g),
        goTo: go,
        record: recordFn,
      }))
    )
      continue;

    // 0a–0c) Wave-4 subsystems (injected; no-op by default): dedicated gate hauler, input feeder,
    //        mining colony roles, orphan-gate self-delivery, contract pipeline. First to act wins.
    if (await hooks.gateHauler(shipSym, ship, markets)) continue;
    if (await hooks.inputFeeder(shipSym, ship, markets)) continue;
    if (await hooks.mining(shipSym, ship, markets)) continue;
    if (await hooks.orphanGate(shipSym, ship, markets)) continue;
    if (await hooks.contracts(shipSym, ship, markets)) continue;

    // 2) best available normal lane (the Wave-3 income path)
    const lanes = buildLanes(markets, state, cfg, deps.D);
    const claim = claimLane(ship, lanes, markets, { state, cfg, router, D: deps.D });
    if (!claim) {
      if (await hooks.inputFeedTrip(shipSym, ship, markets)) continue; // [INPUT_FEED] no lane → profitable feed
      if (await hooks.gateSupplyTrip(shipSym, ship, markets)) continue; // [GATE] still no work → supply the gate ($0)
      state.perShip[shipSym].last = 'PARKED (no profitable lane)';
      await sleep(IDLE_WAIT_MS);
      continue;
    }
    if ('park' in claim) {
      // [PARK] best lane below PARK_MIN_NET floor → idle, zero cost (prefer a feed/supply trip first)
      if (await hooks.inputFeedTrip(shipSym, ship, markets)) continue;
      if (await hooks.gateSupplyTrip(shipSym, ship, markets)) continue;
      state.perShip[shipSym].last = `PARKED (best net ${Math.round(claim.projectedNet)} < ${cfg.PARK_MIN_NET})`;
      state.perShip[shipSym].projected = 0;
      await sleep(IDLE_WAIT_MS);
      continue;
    }

    const { lane } = claim;
    const ps = state.perShip[shipSym];
    ps.last = `${lane.sym}`;
    ps.projected = claim.projectedNet; // expected net while in-flight (realized lands on sell)
    let realizedNet = 0;
    let bought = 0;
    let rideCommitted = 0;
    try {
      await go(shipSym, lane.buyWp); // refuel-hop to source (handles outer lanes)
      const b = await actions.buy(shipSym, lane.sym, lane.units, Math.round(lane.buy * 1.18));
      bought = b.bought || 0;
      if (!bought) {
        // [C] Price already moved past our cap / good depleted: nothing bought. Don't sail empty
        // to the sink — abort, let the finally-block penalize this lane so we stop re-picking it.
        log.info(`${shipSym.slice(-3)} ${lane.sym} bought 0 (price moved) — skipping, penalizing lane`);
      } else {
        // [MULTI-GOOD] Fill the rest of the hold with co-destination ride-alongs (same source, same sink).
        const rideAlongs: StoredRideAlong[] = [];
        const freeUnits = ship.cargo.capacity - bought;
        for (const p of planRideAlongs(markets, lane, freeUnits, growthBudget(state), state, cfg)) {
          try {
            const rb = await actions.buy(shipSym, p.sym, p.units, Math.round(p.buy * (1 + cfg.SLIPPAGE_FACTOR)));
            if (rb.bought > 0) {
              commit(state, rb.spent || 0);
              rideCommitted += rb.spent || 0;
              rideAlongs.push({ good: p.sym, units: rb.bought, costBasis: rb.spent || 0 });
            }
          } catch (e) {
            log.warn(`${shipSym.slice(-3)} ride-along ${p.sym} ERR ${(e as Error).message}`);
          }
        }
        if (rideAlongs.length)
          log.info(`＋ ${shipSym.slice(-3)} ride-along ${rideAlongs.map((r) => `${r.units} ${r.good}`).join(', ')} → ${lane.sellWp.slice(-3)}`);
        // [RECOVERY] Persist the haul intent the instant we hold cargo, so a crash before the sell can
        // resume this exact leg (with cost basis). Ride-alongs share the sink → replayed at the same sellWp.
        await saveIntent(state, persistence, shipSym, {
          phase: 'HAULING',
          good: lane.sym,
          units: bought,
          buyWp: lane.buyWp,
          sellWp: lane.sellWp,
          costBasis: b.spent || 0,
          rideAlongs,
        });
        await go(shipSym, lane.sellWp); // refuel-hop to sink
        const s = await actions.sell(shipSym, lane.sym);
        realizedNet = (s.got || 0) - (b.spent || 0);
        for (const r of rideAlongs) {
          try {
            const rs = await actions.sell(shipSym, r.good);
            realizedNet += (rs.got || 0) - r.costBasis;
          } catch (e) {
            log.warn(`${shipSym.slice(-3)} ride-along sell ${r.good} ERR ${(e as Error).message}`);
          }
        }
        await clearIntent(state, persistence, shipSym); // [RECOVERY] leg complete
        const tag = rideAlongs.length ? `${lane.sym}+${rideAlongs.length}` : lane.sym;
        await recordFn(shipSym, realizedNet, `${tag} ${lane.buyWp.slice(-3)}→${lane.sellWp.slice(-3)}`);
        const buyAvg = b.bought ? Math.round((b.spent || 0) / b.bought) : lane.buy;
        const sellAvg = b.bought ? Math.round((s.got || 0) / b.bought) : lane.sell;
        const obs: TradeObservation = {
          ts: new Date().toISOString(),
          ship: shipSym,
          good: lane.sym,
          buyWp: lane.buyWp,
          sellWp: lane.sellWp,
          projected: claim.projectedNet,
          realized: realizedNet,
          units: b.bought || 0,
          buyPx: buyAvg,
          sellPx: sellAvg,
        };
        persistence.appendTradeObservations([obs]);
      }
    } catch (e) {
      log.warn(`${shipSym} lane ERR ${(e as Error).message}`);
    } finally {
      ps.projected = 0;
      if (rideCommitted) uncommit(state, rideCommitted); // release ride-along reserved cash
      const st = gs(state, lane.sym);
      st.lockedBy = null;
      // [C] Adaptive cooldown keyed off the REALIZED outcome. A dead lane (bought 0 or net<=0) rests
      // far longer and escalates on repeats, so ships spread to live lanes instead of dogpiling.
      let cd = cooldownFor(lane.sym, marketsSvc.goodEMA(), marketsSvc.lastMargins(), cfg);
      if (bought === 0 || realizedNet <= 0) {
        st.deadStreak = (st.deadStreak || 0) + 1;
        cd = Math.max(cd, cfg.COOLDOWN_MS) * cfg.DEAD_LANE_PENALTY * (1 + 0.5 * (st.deadStreak - 1));
      } else st.deadStreak = 0;
      st.cooldownUntil = now() + Math.round(cd);
      uncommit(state, claim.cost); // release reserved cash
    }
  }
  log.info(`${shipSym} worker stopped`);
}

// ── supervisor (bot2 supervise L3150) ────────────────────────────────────────

/**
 * [RULE: keep-fleet-alive] supervise a worker — if it throws, log and restart after a
 * short backoff instead of letting the rejection kill every other ship.
 */
export async function supervise(shipSym: string, deps: WorkerDeps): Promise<void> {
  while (!deps.state.stop) {
    try {
      await worker(shipSym, deps);
      return;
    } catch (e) {
      log.warn(`${shipSym.slice(-3)} worker crashed: ${(e as Error).message} — restarting in 5s`);
      await sleep(5000);
    }
  }
}

// ── stop handling (DRIFT #22: STOP file → signals + optional polled flag) ─────

export interface StopOptions {
  /** Optional poll for an external stop signal (env/file/flag). Polled every 3s. */
  poll?: () => boolean | Promise<boolean>;
}

/**
 * Install graceful-stop handling. Replaces the legacy `touch STOP` file with SIGTERM/
 * SIGINT handlers (set `state.stop`; workers finish the current action then exit) AND
 * an optional polled flag for environments that prefer a sentinel. (DRIFT #22)
 * Returns the stop-watch promise (resolves once stop is observed) so `main` can await it.
 */
export function installStopHandlers(state: BotState, opts: StopOptions = {}): Promise<void> {
  const trip = (sig: string) => {
    if (state.stop) return;
    log.info(`${sig} received — draining workers (graceful stop)`);
    state.stop = true;
  };
  process.once('SIGTERM', () => trip('SIGTERM'));
  process.once('SIGINT', () => trip('SIGINT'));

  return (async () => {
    while (!state.stop) {
      if (opts.poll) {
        try {
          if (await opts.poll()) {
            trip('stop-flag');
            break;
          }
        } catch {
          /* poll failure is non-fatal */
        }
      }
      await sleep(3000);
    }
  })();
}
