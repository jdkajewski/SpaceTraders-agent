/**
 * recovery.ts — crash-safe intent persistence + held-cargo reconciliation
 * (port of bot2.mjs L504–512 saveIntent/clearIntent, L2317–2374 reconcileHeldCargo).
 *
 * Crash-safety model (MASTER-PLAN §6.5 / DRIFT #5): all run-stats + intent writes go
 * **write-through** — local first, best-effort API after — so a brief API outage can't
 * lose the resume state that `intents.json`/`run-stats.json` gave us on disk. On boot,
 * `reconcileLocalToApi()` pushes the local survivor forward (newest-wins) before the
 * workers start. `FileLocalStore` is the allowed `fs` exception for this package.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config, Intent, Market, RunStats, Ship } from '@st/shared';
import type { BotState } from './runtime/state.js';
import type { LocalStore, PersistenceClient } from './interfaces.js';
import { bestSink } from './trade/marketHelpers.js';
import { logger } from './core/logger.js';

const log = logger.child({ mod: 'recovery' });

/**
 * [RECOVERY] Max at-sink resell attempts on the same orphan-cargo signature before recovery gives up
 * and releases the ship to the normal loop. Bounds the salvage path so a stale/unsupplied sink can't
 * make a ship re-fly + re-`sell` forever. Not an env lever (kept local; the marketless case never
 * even reaches a sink, so this only guards the rarer stale-sink loop).
 */
const SALVAGE_MAX_ATTEMPTS = 3;

/** Ride-along entry stored inside `intent.extras.rideAlongs` (DRIFT #21). */
export interface StoredRideAlong {
  good: string;
  units: number;
  costBasis: number;
}

interface IntentExtras {
  rideAlongs?: StoredRideAlong[];
}

/** Read the ride-along list from an intent's `extras` (legacy stored a bare array). */
function readRideAlongs(intent: Intent): StoredRideAlong[] {
  return (intent.extras as IntentExtras | undefined)?.rideAlongs ?? [];
}

// ── local write-through store (the only fs in @st/bot) ───────────────────────

export interface FileLocalStoreOptions {
  /** Directory for run-stats.json + intents.json. Default `$BOT_STATE_DIR` or `.bot-state`. */
  dir?: string;
}

/**
 * File-backed `LocalStore` — the crash-safety fallback the persistence client writes
 * through. Writes are atomic-swapped (`*.tmp` → rename) so a kill mid-write can't
 * corrupt the resume state.
 */
export class FileLocalStore implements LocalStore {
  private readonly dir: string;
  private readonly runStatsFile: string;
  private readonly intentsFile: string;

  constructor(opts: FileLocalStoreOptions = {}) {
    this.dir = opts.dir ?? process.env.BOT_STATE_DIR ?? '.bot-state';
    this.runStatsFile = path.join(this.dir, 'run-stats.json');
    this.intentsFile = path.join(this.dir, 'intents.json');
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, file); // atomic swap — a crash mid-write leaves the prior file intact
  }

  async getRunStats(): Promise<RunStats | null> {
    return this.readJson<RunStats>(this.runStatsFile);
  }

  async putRunStats(stats: RunStats): Promise<void> {
    await this.writeJson(this.runStatsFile, stats);
  }

  async getIntents(): Promise<Intent[]> {
    const m = await this.readJson<Record<string, Intent>>(this.intentsFile);
    return m ? Object.values(m) : [];
  }

  async putIntent(intent: Intent): Promise<void> {
    const m = (await this.readJson<Record<string, Intent>>(this.intentsFile)) ?? {};
    m[intent.shipSym] = intent;
    await this.writeJson(this.intentsFile, m);
  }

  async deleteIntent(shipSym: string): Promise<void> {
    const m = (await this.readJson<Record<string, Intent>>(this.intentsFile)) ?? {};
    if (m[shipSym]) {
      delete m[shipSym];
      await this.writeJson(this.intentsFile, m);
    }
  }
}

// ── boot reconcile (local survivor → API, newest-wins) ───────────────────────

/**
 * Boot step: reconcile the local crash-safety store with the API. Run-stats use a
 * newest-wins by `updatedAt`; intents treat **local as the crash survivor** (the
 * process may have written locally but died before the POST), so local upserts win and
 * any API-only intents are pulled back down. Best-effort throughout.
 */
export async function reconcileLocalToApi(persistence: PersistenceClient, local: LocalStore): Promise<void> {
  const [lr, ar] = await Promise.all([
    local.getRunStats().catch(() => null),
    persistence.getRunStats().catch(() => null),
  ]);
  const lt = lr ? Date.parse(lr.updatedAt) : -Infinity;
  const at = ar ? Date.parse(ar.updatedAt) : -Infinity;
  if (lr && lt >= at) {
    try {
      await persistence.putRunStats(lr);
    } catch (e) {
      log.warn(`reconcile run-stats → API failed: ${(e as Error).message}`);
    }
  } else if (ar && at > lt) {
    try {
      await local.putRunStats(ar);
    } catch {
      /* local write best-effort */
    }
  }

  const [li, ai] = await Promise.all([
    local.getIntents().catch(() => [] as Intent[]),
    persistence.getIntents().catch(() => [] as Intent[]),
  ]);
  const localByShip = new Set(li.map((i) => i.shipSym));
  for (const it of li) {
    try {
      await persistence.putIntent(it); // local wins (it survived the crash)
    } catch (e) {
      log.warn(`reconcile intent ${it.shipSym} → API failed: ${(e as Error).message}`);
    }
  }
  for (const it of ai) {
    if (!localByShip.has(it.shipSym)) {
      try {
        await local.putIntent(it);
      } catch {
        /* best-effort */
      }
    }
  }
  if (li.length || ai.length) log.info(`reconciled ${li.length} local + ${ai.length} api intent(s)`);
}

/** Load persisted intents into the in-memory mirror at boot. */
export async function loadIntents(state: BotState, persistence: PersistenceClient): Promise<void> {
  let list: Intent[] = [];
  try {
    list = await persistence.getIntents();
  } catch (e) {
    log.warn(`load intents failed: ${(e as Error).message}`);
    return;
  }
  for (const it of list) state.intents[it.shipSym] = it;
  if (list.length) log.info(`↺ resumed ${list.length} ship intent(s)`);
}

// ── intent write-through (in-mem mirror + client) ────────────────────────────

export interface SaveIntentInput {
  phase: string;
  good: string;
  units: number;
  buyWp: string;
  sellWp: string;
  costBasis: number;
  rideAlongs?: StoredRideAlong[];
}

/**
 * Persist the haul intent the instant we hold cargo, so a crash before the sell can
 * resume this exact leg (with cost basis). Ride-alongs share the sink and ride in
 * `extras.rideAlongs`, replayed at the same `sellWp` on resume. (bot2 `saveIntent`)
 */
export async function saveIntent(
  state: BotState,
  persistence: PersistenceClient,
  shipSym: string,
  input: SaveIntentInput,
): Promise<void> {
  const intent: Intent = {
    shipSym,
    phase: input.phase,
    good: input.good,
    units: input.units,
    buyWp: input.buyWp,
    sellWp: input.sellWp,
    costBasis: input.costBasis,
    extras: { rideAlongs: input.rideAlongs ?? [] },
  };
  state.intents[shipSym] = intent;
  try {
    await persistence.putIntent(intent); // write-through (local first inside the client)
  } catch (e) {
    log.warn(`saveIntent ${shipSym} persist failed: ${(e as Error).message}`);
  }
}

/** Clear a ship's intent on sell/abort. (bot2 `clearIntent`) */
export async function clearIntent(state: BotState, persistence: PersistenceClient, shipSym: string): Promise<void> {
  if (!state.intents[shipSym]) return;
  delete state.intents[shipSym];
  try {
    await persistence.deleteIntent(shipSym);
  } catch (e) {
    log.warn(`clearIntent ${shipSym} persist failed: ${(e as Error).message}`);
  }
}

// ── held-cargo reconciliation ────────────────────────────────────────────────

export interface ReconcileDeps {
  state: BotState;
  cfg: Config;
  persistence: PersistenceClient;
  sell: (shipSym: string, good: string) => Promise<{ got: number }>;
  goTo: (shipSym: string, dest: string) => Promise<unknown>;
  record: (shipSym: string, net: number, label: string) => Promise<void>;
}

/**
 * [RECOVERY] On boot (or any loop where a ship unexpectedly holds cargo), resume the
 * persisted SELL leg with the saved cost basis, or salvage-sell orphan cargo. Returns
 * true if it acted (caller should `continue`). No-op when the ship is empty — normal
 * claim flow proceeds. (bot2 `reconcileHeldCargo`)
 */
export async function reconcileHeldCargo(
  shipSym: string,
  ship: Ship,
  markets: Record<string, Market>,
  deps: ReconcileDeps,
): Promise<boolean> {
  const { state, cfg, persistence, sell, goTo, record } = deps;
  const contractGood = state.activeContractInfo?.good;
  // [GATE PROTECT] Don't salvage-sell gate materials while the gate is unbuilt — a ship holding them mid-haul on a
  // restart should still deliver them to the gate, not dump them at a loss. (FAB bought @~3800 sold @~1700 = -83k.)
  const gateMat =
    cfg.GATE_SUPPLY && state.gateCache.exists && !state.gateCache.built
      ? new Set(cfg.GATE_PROTECT_MATERIALS.filter((m) => (state.gateCache.remaining[m] || 0) > 0)) // only protect what the gate STILL needs
      : new Set<string>();
  const sellable = (ship.cargo?.inventory || []).filter(
    (i) => i.symbol !== 'FUEL' && i.symbol !== contractGood && !gateMat.has(i.symbol) && i.units > 0,
  );
  const intent = state.intents[shipSym];
  if (!sellable.length) {
    if (intent) await clearIntent(state, persistence, shipSym); // nothing held → stale intent is moot
    delete state.salvageGuard[shipSym]; // hold is clear → reset the loop-break guard
    return false;
  }

  // Case 1: held cargo matches a saved HAULING intent → finish the planned sell with its cost basis.
  if (intent && intent.phase === 'HAULING') {
    const held = ship.cargo.inventory.find((i) => i.symbol === intent.good)?.units || 0;
    if (held > 0) {
      const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
      ps.last = `RESUME ${intent.good}→${intent.sellWp.slice(-3)}`;
      log.info(
        `↻ ${shipSym.slice(-3)} resuming ${held} ${intent.good} → ${intent.sellWp.slice(-3)} (cost ${Math.round(intent.costBasis || 0).toLocaleString()})`,
      );
      const rideAlongs = readRideAlongs(intent);
      try {
        await goTo(shipSym, intent.sellWp);
        const s = await sell(shipSym, intent.good);
        const basis = (intent.costBasis || 0) * (held / (intent.units || held)); // prorate if partial
        let net = (s.got || 0) - basis;
        for (const ex of rideAlongs) {
          // [MULTI-GOOD] replay ride-alongs at the shared sink
          const exHeld = ship.cargo.inventory.find((i) => i.symbol === ex.good)?.units || 0;
          if (exHeld <= 0) continue;
          try {
            const rs = await sell(shipSym, ex.good);
            net += (rs.got || 0) - (ex.costBasis || 0);
          } catch (e) {
            log.warn(`${shipSym.slice(-3)} resume ride-along ${ex.good} ERR ${(e as Error).message}`);
          }
        }
        await record(shipSym, Math.round(net), `RESUMED ${intent.good}${rideAlongs.length ? `+${rideAlongs.length}` : ''}→${intent.sellWp.slice(-3)}`);
      } catch (e) {
        log.warn(`${shipSym} resume ERR ${(e as Error).message} — salvage-selling`);
        try {
          await sell(shipSym, intent.good);
        } catch {
          /* best-effort dump */
        }
      } finally {
        await clearIntent(state, persistence, shipSym);
      }
      return true;
    }
    await clearIntent(state, persistence, shipSym); // intent good not actually held → drop stale intent, fall through to salvage
  }

  // Case 2: orphan cargo with no usable intent → salvage at a market that BUYS it so capital isn't
  // stranded. Two loop-breaks (issue: marketless-waypoint salvage): (1) NEVER sell in place at a
  // waypoint with no buyer — a mining hull parked at an asteroid would 404 `GET /market` every tick
  // forever; instead step aside and let the normal loop route the cargo. (2) Cap at-sink resell
  // retries so a stale/unsupplied sink can't loop us either.
  const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
  const here = ship.nav.waypointSymbol;
  const sig = sellable.map((i) => i.symbol).slice().sort().join(',');
  let guard = state.salvageGuard[shipSym];
  if (!guard || guard.sig !== sig) guard = state.salvageGuard[shipSym] = { sig, attempts: 0 };

  // Partition held goods into "a known market buys this" vs "nothing buys it yet".
  const targets: { item: { symbol: string; units: number }; wp: string }[] = [];
  for (const item of sellable) {
    const sink = bestSink(markets, item.symbol);
    if (sink) targets.push({ item, wp: sink.wp });
  }

  // [MARKETLESS LOOP-BREAK] No known buyer for ANY held good (e.g. mined ore sitting at a marketless
  // asteroid on a cold DB). Selling in place would 404 forever, so release the ship to the normal
  // loop (mining/trade routes cargo) and don't re-attempt until a buyer is actually known. Cheap to
  // re-check each tick, so it auto-promotes to salvage once a market for the good is discovered.
  if (!targets.length) {
    if (!guard.released) {
      guard.released = true;
      ps.last = `HOLD ${sellable.map((i) => i.symbol).join(',')} (no buyer)`;
      log.info(
        `⤓ ${shipSym.slice(-3)} holding orphan cargo no market buys yet (${sellable.map((i) => `${i.units} ${i.symbol}`).join(', ')}) — releasing to normal loop`,
      );
    }
    await clearIntent(state, persistence, shipSym);
    return false; // step aside; recovery did not act
  }

  // [RETRY CAP] A real sink exists but resells keep failing (stale price / no supply) → don't re-fly
  // and re-404 forever. After the cap, release to the normal loop instead of looping.
  if (guard.attempts >= SALVAGE_MAX_ATTEMPTS) {
    log.warn(`⤓ ${shipSym.slice(-3)} salvage gave up after ${guard.attempts} attempt(s) on ${sig} — releasing to normal loop`);
    await clearIntent(state, persistence, shipSym);
    return false;
  }
  guard.attempts++;

  ps.last = `SALVAGE ${targets.map((t) => t.item.symbol).join(',')}`;
  log.info(`⤓ ${shipSym.slice(-3)} salvaging orphan cargo: ${targets.map((t) => `${t.item.units} ${t.item.symbol}`).join(', ')}`);
  let soldAny = false;
  for (const { item, wp } of targets) {
    try {
      if (wp !== here) await goTo(shipSym, wp);
      const s = await sell(shipSym, item.symbol);
      if ((s.got || 0) > 0) {
        soldAny = true;
        log.info(`⤓ ${shipSym.slice(-3)} salvaged ${item.units} ${item.symbol} (+${(s.got || 0).toLocaleString()})`);
      } else {
        // Don't log a phantom `(+0)` success — the good is still aboard; the retry cap bounds re-tries.
        log.warn(`⤓ ${shipSym.slice(-3)} salvage ${item.symbol}: market did not buy (kept aboard)`);
      }
    } catch (e) {
      log.warn(`${shipSym} salvage ${item.symbol} ERR ${(e as Error).message}`);
    }
  }
  if (soldAny) delete state.salvageGuard[shipSym]; // made progress → fresh slate (cargo sig changes next tick anyway)
  await clearIntent(state, persistence, shipSym);
  return true;
}
