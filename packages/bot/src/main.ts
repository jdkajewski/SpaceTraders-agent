/**
 * main.ts — interim trading-only boot (port of bot2.mjs main L3153 + targetWatch L2841).
 *
 * Wires config + clients (SpaceTraders, persistence with the file write-through store),
 * the router, and the markets service; reconciles the local crash-safety store to the
 * API; loads the market snapshot + run-stats; recomputes reserve + the dynamic expansion
 * goal; discovers the active contract BEFORE workers start (so recovery can't salvage
 * contract goods); then launches a supervised trade worker per hull + the targetWatch
 * loop + graceful stop handlers. Full manager wiring (contracts/mining/expansion) is Wave 5.
 */

import { distance, loadConfig, type Config, type Market } from '@st/shared';
import { createSpaceTradersClient } from './clients/spacetraders.js';
import { createDryRunClient } from './clients/dryRun.js';
import { createPersistenceClient } from './clients/persistence.js';
import { createShipActions } from './trade/shipActions.js';
import { createRouter } from './routing/route.js';
import { createMarketsService } from './market/markets.js';
import { logger } from './core/logger.js';
import { createState, type BotState } from './runtime/state.js';
import { FileLocalStore, reconcileLocalToApi, loadIntents } from './recovery.js';
import { recomputeReserve, computeExpansionTarget } from './budget/budget.js';
import { determinePhase, reloadGateLevers } from './budget/phase.js';
import { supervise, installStopHandlers, type WorkerDeps, type StopOptions, type WorkerHook } from './worker.js';
import { makeSubsystemDeps, buildWorkerHooks, buildManagers } from './subsystems/index.js';
import { buyMiningShip } from './mining/expandMine.js';
import { fleetTableManager } from './fleet/table.js';
import { createExpansion, type Expansion, type ExpansionCtx } from './expansion/index.js';
import { resolveHome } from './galaxy/home.js';
import { createGalaxyCrawler, type GalaxyCrawler } from './galaxy/crawler.js';
import { createGalaxyProvider } from './galaxy/provider.js';
import { buildLanes } from './trade/lanes.js';
import { writeStatus } from './status.js';
import type { DistFn } from './trade/lanes.js';
import type { SpaceTradersClient } from './interfaces.js';

const log = logger.child({ mod: 'main' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function refreshCredits(state: BotState, client: SpaceTradersClient): Promise<void> {
  try {
    const r = await client.api<{ data: { credits: number } }>('GET', '/my/agent');
    state.cachedCredits = r.data.credits;
  } catch {
    /* keep last known credits on a transient agent-fetch failure */
  }
}

export async function main(): Promise<void> {
  const cfg: Config = loadConfig();
  // [DRY_RUN] swap the live game client for an offline no-op one — zero fetches to SpaceTraders,
  // no token required. Our own persistence API (below) is still used. (Wave 5.4)
  const client: SpaceTradersClient = cfg.DRY_RUN
    ? createDryRunClient({ credits: cfg.DRY_RUN_CREDITS })
    : createSpaceTradersClient({ token: cfg.SPACETRADERS_PLAYER_AGENT_TOKEN });
  if (cfg.DRY_RUN) log.info('🧪 DRY_RUN: live SpaceTraders API disabled (no fetches, no mutations).');

  // [HOME] Greenfield-safe home detection: when SYSTEM is not pinned, derive it from the live
  // agent's HQ (/my/agent.headquarters) so the bot works from any fresh account across weekly
  // resets — no hardcoded system symbol. Skipped under DRY_RUN (no live agent). A pinned SYSTEM
  // always wins; a detection failure on an unpinned greenfield is fatal (we can't trade home-less).
  if (!cfg.SYSTEM && !cfg.DRY_RUN) {
    const home = await resolveHome((m, p) => client.api(m as 'GET', p));
    if (!home) throw new Error('Home detection failed: /my/agent returned no headquarters and SYSTEM is unset');
    cfg.SYSTEM = home.homeSystem;
    log.info(`🏠 home auto-detected: ${home.homeSystem} (HQ ${home.hqWaypoint})`);
  } else if (cfg.SYSTEM) {
    log.info(`🏠 home system pinned: ${cfg.SYSTEM}`);
  }

  const local = new FileLocalStore();
  const persistence = createPersistenceClient({ local, baseUrl: cfg.API_BASE_URL, botKey: cfg.BOT_KEY });

  // [BOOT] reconcile the local crash-safety store forward before anything reads state.
  await reconcileLocalToApi(persistence, local);

  // static coords → distance function (seeded from the API waypoint table). MUTABLE: the expansion
  // subsystem injects new-system waypoint coords into this same map so D()/planRoute work there too.
  const wps = await persistence.getWaypoints();
  const coords: Record<string, readonly [number, number]> = Object.fromEntries(
    wps.map((w) => [w.symbol, [w.x, w.y] as const]),
  );
  const D: DistFn = (a, b) => distance(a, b, coords);

  // one shared, synchronously-readable market snapshot (mirrors bot2's marketCache.data).
  const marketHolder: { data: Record<string, Market> } = { data: {} };
  const marketsRef = (): Record<string, Market> => marketHolder.data;

  const markets = createMarketsService({ client, persistence, coords, maxd: cfg.MAXD, cfg });
  const router = createRouter({
    coords,
    getFuelPx: () => markets.getFuelPx(),
    valueOfTime: cfg.VALUE_OF_TIME,
    marketsRef,
  });
  const actions = createShipActions(client);
  const state = createState(cfg, { marketsRef });

  // [issue #2] Surface the value-weighted scan-budget metric in the status snapshot. credits-per-request
  // is the headline lever: realized run net ÷ market GETs spent. Higher = scan budget better allocated.
  state.scanStatus = (): unknown => {
    const gets = markets.marketGets();
    const states = markets.scanStates();
    let dueCount = 0;
    const tNow = Date.now();
    for (const st of states.values()) if (tNow - st.lastScanAt >= st.intervalMs) dueCount += 1;
    return {
      marketGets: gets,
      creditsPerRequest: gets > 0 ? Math.round(state.totalNet / gets) : 0,
      marketsTracked: states.size,
      dueNow: dueCount,
      topLanes: markets.topLanes(cfg.LANE_TOPK).map((l) => ({
        src: l.srcWp.slice(-4),
        good: l.good,
        sink: l.sinkWp.slice(-4),
        value: Math.round(l.value),
        trips: l.trips,
      })),
      ...(state.coverage !== undefined ? { coverage: state.coverage } : {}),
    };
  };

  // [BOOT] load the last market snapshot + seed the router's fuel nodes from it.
  marketHolder.data = await markets.loadSnapshot();
  router.seedFuelNodes(marketHolder.data);
  marketHolder.data = await markets.getMarkets();
  router.seedFuelNodes(marketHolder.data);

  // [BOOT] resume run-stats + intents (crash-safe continuity).
  const rs = await persistence.getRunStats();
  if (rs) {
    state.totalNet = rs.totalNet || 0;
    state.lanesRun = rs.lanesRun || 0;
    log.info(`↺ resumed run stats: +${state.totalNet.toLocaleString()} over ${state.lanesRun} lanes`);
  }
  await loadIntents(state, persistence);

  await refreshCredits(state, client);
  await recomputeReserve(state, cfg, { getAllShips: () => client.getAllShips(), getFuelPx: () => markets.getFuelPx() });

  const DYNAMIC_TARGET = !cfg.CREDIT_TARGET; // DRIFT #23: num default 0 ⇒ dynamic when unset
  if (DYNAMIC_TARGET) state.expansionTarget = await computeExpansionTarget(state, cfg, marketHolder.data, { client });
  // poll the operator gate-credit band once at boot so the hysteresis starts from live levers.
  await reloadGateLevers(state, cfg, persistence);

  log.info(
    `AUTOTRADER v2 starting. goal=${state.expansionTarget.toLocaleString()} ${DYNAMIC_TARGET ? `(dynamic ${JSON.stringify(state.targetBreakdown)})` : '(pinned)'} reserve=${state.operatingReserve.toLocaleString()} credits=${state.cachedCredits.toLocaleString()} cooldown=${cfg.COOLDOWN_MS / 1000}s`,
  );

  const all = await client.getAllShips();
  // [CONTRACT] Discover the active contract BEFORE workers start so reconcileHeldCargo doesn't salvage-sell goods
  // that belong to an in-flight contract on a mid-haul restart.
  try {
    const a0 = (await client.getAllContracts()).find((c) => c.accepted && !c.fulfilled);
    const d0 = a0?.terms.deliver[0];
    if (a0 && d0) {
      state.activeContractInfo = {
        id: a0.id,
        good: d0.tradeSymbol,
        dest: d0.destinationSymbol,
        units: d0.unitsRequired - d0.unitsFulfilled,
        pay: a0.terms.payment.onFulfilled,
      };
      log.info(`↺ active contract on startup: ${state.activeContractInfo.units} ${d0.tradeSymbol} → ${d0.destinationSymbol.slice(-3)} (protected from salvage)`);
    }
  } catch (e) {
    log.warn(`startup contract discovery: ${(e as Error).message}`);
  }

  // Probes (FRAME_PROBE) carry no cargo, so `cargo.capacity > 0` already excludes them — the shared
  // Ship.frame has no `symbol` to test (DRIFT #24); the cargo/fuel gates are behaviour-equivalent here.
  const traders = all.filter((s) => s.cargo.capacity > 0 && s.fuel.capacity > 0);
  state.fleetMaxSpeed = Math.max(1, ...traders.map((s) => s.engine?.speed || 1)); // [D] fastest hull → far-lane bias reference
  state.fleetSize = traders.length;
  state.currentPhase = determinePhase(state, cfg);
  log.info(`workers: ${traders.map((s) => `${s.symbol.slice(-3)}(spd${s.engine?.speed},cap${s.cargo.capacity})`).join(' ')}`);
  log.info(`🧭 phase ${state.currentPhase.name} — ${state.currentPhase.desc}`);

  const deps: WorkerDeps = { state, cfg, actions, router, markets, persistence, client, D };

  // [WAVE-4] Supervised-worker launcher (bot2 `launchWorker`): dedupe + fire-and-forget supervise, so a
  // hull bought by MINE_EXPAND / FLEET_SCALE joins the pool. Initial traders are pre-registered below so
  // a manager never double-spawns one. With every Wave-4 flag OFF no manager buys, so this never fires.
  const launchedWorkers = new Set<string>();
  const launchWorker = (sym: string): void => {
    if (launchedWorkers.has(sym)) return;
    launchedWorkers.add(sym);
    void supervise(sym, deps);
  };

  // [WAVE-4] Assemble the injected subsystem hooks + background managers. Each subsystem is internally
  // flag-guarded: with all Wave-4 flags OFF the hooks are no-ops and the managers idle/return, so the bot
  // behaves identically to the Wave-3 trading-only build (the key safety property).
  const subDeps = makeSubsystemDeps({ state, cfg, actions, router, markets, persistence, client, D, launchWorker });
  deps.hooks = buildWorkerHooks(subDeps);

  // [AUTO_EXPAND] Build the inter-system expansion subsystem (Wave 5). Self-gates on AUTO_EXPAND +
  // gateBuilt() at maybeTrigger; with AUTO_EXPAND OFF we never construct it, so it is fully inert.
  // The ctx mirrors bot2 main() L3180–3196 exactly (see plan.md ctx map).
  let expansion: Expansion | null = null;
  if (cfg.AUTO_EXPAND) {
    const xlog = logger.child({ mod: 'expansion' });
    const ctx: ExpansionCtx = {
      cfg,
      api: (method, path, body) => client.api(method, path, body),
      log: (m) => xlog.info(m),
      sleep,
      now: () => Date.now(),
      navigate: (sym, dest, mode) => actions.navigate(sym, dest, mode),
      refuel: (sym) => actions.refuel(sym),
      buy: (sym, good, units, maxPx) => actions.buy(sym, good, units, maxPx),
      sell: (sym, good) => actions.sell(sym, good),
      jump: (sym, destGateWp) => actions.jump(sym, destGateWp),
      getShip: (sym) => actions.getShip(sym),
      getAllShips: () => client.getAllShips(),
      coords,
      D,
      chooseMode: (dist, ship) => router.chooseMode(dist, ship),
      planRoute: (from, to, fuelCap, mkts) => router.planRoute(from, to, fuelCap, mkts),
      record: (sym, net, label) => subDeps.record(sym, net, label),
      homeSystem: cfg.SYSTEM,
      gateWp: () => state.gateCache.wp,
      gateBuilt: () => state.gateCache.built,
      getCredits: () => state.cachedCredits,
      reserve: () => state.operatingReserve,
      homeMarkets: () => marketHolder.data,
      fuelPx: () => markets.getFuelPx(),
      launchWorker,
      buyShip: (shipType, wp) => buyMiningShip(subDeps, shipType, wp),
      negotiator: () => cfg.NEGOTIATOR || null,
    };
    // [GALAXY] When the crawler system is enabled, feed AUTO_EXPAND from the persisted
    // galaxy map (ranked targets + unbounded gate paths + local-shipyard lookups) instead
    // of the hardcoded EXPAND_OUTPOSTS list. Absent ⇒ legacy behavior.
    if (cfg.GALAXY_CRAWL) {
      ctx.galaxy = createGalaxyProvider({
        api: (method, path, body) => client.api(method, path, body),
        persistence,
        now: () => Date.now(),
      });
    }
    expansion = createExpansion(ctx);
    // Surface the expansion status block in the persisted snapshot's `expand` field.
    state.expansionStatus = () => expansion!.statusBlock();
    // [EXPANSION] Inject the member-dispatch hook (runs first in the worker loop). isMember gates it,
    // so non-members fall straight through to the normal trading cascade.
    const expansionHook: WorkerHook = async (sym, ship) => {
      if (!expansion || !expansion.isMember(sym)) return false;
      await expansion.step(sym, ship);
      return true;
    };
    deps.hooks = { ...deps.hooks, expansion: expansionHook };
    log.info('🪐 AUTO_EXPAND armed (fires once the home gate is BUILT).');
  }

  // [DRY_RUN] Offline smoke: prove the stack is wired (boot → load markets/run-stats from the
  // persistence API → log planned phase + top lanes → write a StatusSnapshot row) without touching
  // the live game or buying anything. Then idle on the stop watcher. (Wave 5.4)
  if (cfg.DRY_RUN) {
    const lanes = buildLanes(marketHolder.data, state, cfg, D)
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 5);
    log.info(`🧪 DRY_RUN smoke — phase ${state.currentPhase.name} (${state.currentPhase.desc}), ${Object.keys(marketHolder.data).length} markets loaded`);
    if (lanes.length === 0) log.info('🧪 DRY_RUN smoke — no profitable lanes in the snapshot');
    for (const l of lanes)
      log.info(`🧪 lane ${l.sym}: ${l.buyWp.slice(-4)}→${l.sellWp.slice(-4)} ${l.units}u +${l.gross.toLocaleString()} (margin ${l.margin})`);
    state.lastStatusAt = 0; // force the throttled writeStatus to emit
    writeStatus(state, cfg, persistence);
    await persistence.flush();
    log.info('🧪 DRY_RUN smoke complete — status snapshot written. Idling on stop watcher.');
    const dryStopOpts: StopOptions = {};
    if (process.env['STOP_POLL'] === '1') dryStopOpts.poll = () => process.env['STOP'] === '1';
    await installStopHandlers(state, dryStopOpts);
    log.info('🧪 DRY_RUN exiting.');
    return;
  }

  const stopOpts: StopOptions = {};
  if (process.env['STOP_POLL'] === '1') stopOpts.poll = () => process.env['STOP'] === '1';
  const stopWatch = installStopHandlers(state, stopOpts);

  // [GALAXY] Gentle background galaxy crawler — BFS-maps + ranks the reachable galaxy at a
  // rate-limited pace (yields to trading on the shared 2 req/s ceiling), persisting incrementally
  // so the map is already built + ranked by the time the gate opens and AUTO_EXPAND fires.
  // Self-gated on GALAXY_CRAWL; never runs under DRY_RUN (no live game).
  let galaxyCrawler: GalaxyCrawler | null = null;
  if (cfg.GALAXY_CRAWL) {
    const glog = logger.child({ mod: 'galaxy' });
    galaxyCrawler = createGalaxyCrawler({
      api: (method, path, body) => client.api(method, path, body),
      persistence,
      cfg,
      log: (m) => glog.info(m),
      sleep,
      now: () => Date.now(),
      homeSystem: cfg.SYSTEM,
    });
    galaxyCrawler.start();
    log.info('🌌 galaxy crawler started (background, rate-limited).');
  }

  const tasks = traders.map((s) => {
    launchedWorkers.add(s.symbol); // register so a manager never double-spawns an existing hull (bot2 L3200)
    return supervise(s.symbol, deps);
  });
  tasks.push(targetWatch(state, cfg, client, markets, persistence, marketHolder, DYNAMIC_TARGET, expansion));
  tasks.push(fleetTableManager(subDeps));
  tasks.push(...buildManagers(subDeps).map((m) => m()));

  await Promise.all([...tasks, stopWatch]);
  if (galaxyCrawler) await galaxyCrawler.stop();
  await persistence.flush();
  log.info(`AUTOTRADER stopped. run net +${state.totalNet.toLocaleString()} over ${state.lanesRun} lanes`);
}

/**
 * Background watcher (30s): refresh credits + reserve + the dynamic goal, poll the gate
 * levers, re-derive the strategy phase (log on transition), and apply the `[A]` fail-safe
 * stop condition (only stop on a KNOWN gate status). (bot2 `targetWatch`)
 */
async function targetWatch(
  state: BotState,
  cfg: Config,
  client: SpaceTradersClient,
  markets: ReturnType<typeof createMarketsService>,
  persistence: ReturnType<typeof createPersistenceClient>,
  marketHolder: { data: Record<string, Market> },
  dynamicTarget: boolean,
  expansion: Expansion | null,
): Promise<void> {
  while (!state.stop) {
    await refreshCredits(state, client);
    await recomputeReserve(state, cfg, { getAllShips: () => client.getAllShips(), getFuelPx: () => markets.getFuelPx() });
    marketHolder.data = await markets.getMarkets();
    if (dynamicTarget) state.expansionTarget = await computeExpansionTarget(state, cfg, marketHolder.data, { client });
    await reloadGateLevers(state, cfg, persistence);

    const newPhase = determinePhase(state, cfg);
    if (newPhase.name !== state.currentPhase.name) {
      log.info(`🧭 phase ${state.currentPhase.name} → ${newPhase.name} (${newPhase.desc})`);
      state.currentPhase = newPhase;
    }
    const bd = state.targetBreakdown as { gateBuilt?: unknown; gateMaterials?: number; gateStatusKnown?: boolean };
    const gstate = JSON.stringify(bd.gateBuilt) + (bd.gateMaterials ?? '');
    if (gstate !== state.lastGateState) {
      state.lastGateState = gstate;
      log.info(`🛰 gate status: built=${String(bd.gateBuilt)} materials-cost=${(bd.gateMaterials || 0).toLocaleString()} → goal ${state.expansionTarget.toLocaleString()}`);
    }

    // [AUTO_EXPAND] As soon as the gate is BUILT, fire the one-time migration (self-gates internally).
    if (expansion) {
      try {
        await expansion.maybeTrigger();
      } catch (e) {
        log.warn(`🪐 maybeTrigger ERR ${(e as Error).message}`);
      }
    }

    if (state.cachedCredits >= state.expansionTarget && bd.gateStatusKnown) {
      // [A] Only stop when the gate status is actually KNOWN (an outage leaves it false → never a phantom stop).
      if (cfg.GATE_SUPPLY && state.gateCache.exists && !state.gateCache.built) {
        log.info(`🎯 cost-to-expand met (${state.cachedCredits.toLocaleString()} ≥ ${state.expansionTarget.toLocaleString()}) but gate UNBUILT — continuing to trade + supply the gate`);
      } else if (cfg.AUTO_EXPAND) {
        // [AUTO_EXPAND] YOLO mode: do NOT halt at the credit goal. Keep the home fleet trading AND run the
        // inter-system expansion (migrated ships trade across the gate). The run only ends on STOP.
      } else {
        log.info(`🎯 EXPANSION-READY: credits ${state.cachedCredits.toLocaleString()} ≥ cost-to-expand ${state.expansionTarget.toLocaleString()} ${JSON.stringify(state.targetBreakdown)}`);
        state.stop = true;
        break;
      }
    }
    await sleep(30_000);
  }
}

// Run when invoked directly (node dist/main.js).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    log.error(`FATAL ${(e as Error).message}`);
    process.exit(1);
  });
}
