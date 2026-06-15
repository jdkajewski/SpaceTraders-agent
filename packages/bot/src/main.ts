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
import type { CoordsMap } from '@st/shared';
import { createSpaceTradersClient } from './clients/spacetraders.js';
import { createPersistenceClient } from './clients/persistence.js';
import { createShipActions } from './trade/shipActions.js';
import { createRouter } from './routing/route.js';
import { createMarketsService } from './market/markets.js';
import { logger } from './core/logger.js';
import { createState, type BotState } from './runtime/state.js';
import { FileLocalStore, reconcileLocalToApi, loadIntents } from './recovery.js';
import { recomputeReserve, computeExpansionTarget } from './budget/budget.js';
import { determinePhase, reloadGateLevers } from './budget/phase.js';
import { supervise, installStopHandlers, type WorkerDeps, type StopOptions } from './worker.js';
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
  const client = createSpaceTradersClient();
  const local = new FileLocalStore();
  const persistence = createPersistenceClient({ local });

  // [BOOT] reconcile the local crash-safety store forward before anything reads state.
  await reconcileLocalToApi(persistence, local);

  // static coords → distance function (seeded from the API waypoint table).
  const wps = await persistence.getWaypoints();
  const coords: CoordsMap = Object.fromEntries(wps.map((w) => [w.symbol, [w.x, w.y] as const]));
  const D: DistFn = (a, b) => distance(a, b, coords);

  // one shared, synchronously-readable market snapshot (mirrors bot2's marketCache.data).
  const marketHolder: { data: Record<string, Market> } = { data: {} };
  const marketsRef = (): Record<string, Market> => marketHolder.data;

  const markets = createMarketsService({ client, persistence, coords, maxd: cfg.MAXD });
  const router = createRouter({
    coords,
    getFuelPx: () => markets.getFuelPx(),
    valueOfTime: cfg.VALUE_OF_TIME,
    marketsRef,
  });
  const actions = createShipActions(client);
  const state = createState(cfg, { marketsRef });

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

  const stopOpts: StopOptions = {};
  if (process.env['STOP_POLL'] === '1') stopOpts.poll = () => process.env['STOP'] === '1';
  const stopWatch = installStopHandlers(state, stopOpts);
  const tasks = traders.map((s) => supervise(s.symbol, deps));
  tasks.push(targetWatch(state, cfg, client, markets, persistence, marketHolder, DYNAMIC_TARGET));

  await Promise.all([...tasks, stopWatch]);
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
  client: ReturnType<typeof createSpaceTradersClient>,
  markets: ReturnType<typeof createMarketsService>,
  persistence: ReturnType<typeof createPersistenceClient>,
  marketHolder: { data: Record<string, Market> },
  dynamicTarget: boolean,
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

    if (state.cachedCredits >= state.expansionTarget && bd.gateStatusKnown) {
      // [A] Only stop when the gate status is actually KNOWN (an outage leaves it false → never a phantom stop).
      if (cfg.GATE_SUPPLY && state.gateCache.exists && !state.gateCache.built) {
        log.info(`🎯 cost-to-expand met (${state.cachedCredits.toLocaleString()} ≥ ${state.expansionTarget.toLocaleString()}) but gate UNBUILT — continuing to trade + supply the gate`);
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
