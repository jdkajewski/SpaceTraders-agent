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

  // Case 2: orphan cargo with no usable intent → salvage at the best sink so capital isn't stranded.
  const ps = (state.perShip[shipSym] = state.perShip[shipSym] || { net: 0, lanes: 0, last: '' });
  ps.last = `SALVAGE ${sellable.map((i) => i.symbol).join(',')}`;
  log.info(`⤓ ${shipSym.slice(-3)} salvaging orphan cargo: ${sellable.map((i) => `${i.units} ${i.symbol}`).join(', ')}`);
  for (const item of sellable) {
    const sink = bestSink(markets, item.symbol);
    try {
      if (sink && sink.wp !== ship.nav.waypointSymbol) await goTo(shipSym, sink.wp);
      const s = await sell(shipSym, item.symbol);
      log.info(`⤓ ${shipSym.slice(-3)} salvaged ${item.units} ${item.symbol} (+${(s.got || 0).toLocaleString()})`);
    } catch (e) {
      log.warn(`${shipSym} salvage ${item.symbol} ERR ${(e as Error).message}`);
    }
  }
  await clearIntent(state, persistence, shipSym);
  return true;
}
