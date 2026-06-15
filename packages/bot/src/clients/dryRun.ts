/**
 * clients/dryRun.ts — offline no-op SpaceTraders client for the DRY_RUN smoke (Wave 5.4).
 *
 * Swapped in for `createSpaceTradersClient` when `cfg.DRY_RUN` is on. It NEVER contacts the
 * live SpaceTraders v2 game API: `api()` performs zero `fetch`es — every GET returns a canned
 * empty/agent envelope and every mutation (POST/PUT/PATCH/DELETE: buy/sell/jump/navigate/
 * purchase/…) is a logged no-op. `getAllShips`/`getAllContracts` return empty fixtures. So in
 * DRY_RUN the game world is read-only-empty and untouched, and no agent token is required.
 *
 * The bot's OWN persistence API (Fastify + postgres in compose) is a different service and is
 * still used by `main()` — loading the market snapshot + run-stats and writing a StatusSnapshot
 * row is the whole point of the smoke. This seam only isolates the *game* API.
 */

import type { Contract, Ship } from '@st/shared';
import type { HttpMethod, SpaceTradersClient } from '../interfaces.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'dryRun' });

export interface DryRunClientOptions {
  /** Credits the canned `/my/agent` reports (so phase/reserve math has a number). */
  credits?: number;
  /** Optional ship fixtures the bot will treat as its fleet (default none). */
  ships?: Ship[];
  /** Optional contract fixtures (default none). */
  contracts?: Contract[];
}

/**
 * Build a SpaceTraders client that makes no network calls. Reads return canned data; writes
 * are logged no-ops. Used only under `DRY_RUN`; the live path keeps the real client.
 */
export function createDryRunClient(opts: DryRunClientOptions = {}): SpaceTradersClient {
  const credits = opts.credits ?? 0;
  const ships = opts.ships ?? [];
  const contracts = opts.contracts ?? [];
  let reqCount = 0;

  function api<T = unknown>(method: HttpMethod, path: string, _body?: unknown): Promise<T> {
    reqCount++;
    if (method !== 'GET') {
      log.info(`DRY_RUN no-op ${method} ${path}`);
      return Promise.resolve({ data: {} } as T);
    }
    // Canned GETs — only the few the boot path reads need realistic shapes.
    if (path === '/my/agent') return Promise.resolve({ data: { credits } } as T);
    if (path.startsWith('/my/ships')) return Promise.resolve({ data: ships } as T);
    if (path.startsWith('/my/contracts')) return Promise.resolve({ data: contracts } as T);
    return Promise.resolve({ data: {} } as T);
  }

  return {
    api,
    getAllShips: () => Promise.resolve(ships),
    getAllContracts: () => Promise.resolve(contracts),
    reqStats: () => ({ reqCount }),
  };
}
