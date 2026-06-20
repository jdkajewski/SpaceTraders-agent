/**
 * Standalone galaxy-crawler CLI — the TS replacement for the legacy `.mjs`
 * crawl tools (`gate-graph-dump.mjs`, `reach-check.mjs`).
 *
 * Usage (from packages/bot, after `pnpm build`):
 *   node dist/galaxy/cli.js                 # one full mapping pass + full-tier enrich, then exit
 *   node dist/galaxy/cli.js --refresh        # re-crawl the stalest systems once
 *   node dist/galaxy/cli.js --watch          # run the perpetual background loop (Ctrl-C to stop)
 *   node dist/galaxy/cli.js --path A B        # print the unbounded all-built gate path A→B
 *
 * Honors the same env config as the bot (SYSTEM auto-detect, API_BASE_URL, token).
 */

import { loadConfig, type Config } from '@st/shared';
import { createSpaceTradersClient } from '../clients/spacetraders.js';
import { createPersistenceClient } from '../clients/persistence.js';
import { logger } from '../core/logger.js';
import { resolveHome } from './home.js';
import { createGalaxyCrawler } from './crawler.js';
import { createGalaxyProvider } from './provider.js';
import type { SpaceTradersClient } from '../interfaces.js';

const log = logger.child({ mod: 'galaxy-cli' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resolveHomeSystem(cfg: Config, client: SpaceTradersClient): Promise<string> {
  if (cfg.SYSTEM) return cfg.SYSTEM;
  const home = await resolveHome((m, p) => client.api(m as 'GET', p));
  if (!home) throw new Error('Home detection failed: /my/agent returned no headquarters and SYSTEM is unset');
  return home.homeSystem;
}

export async function runCli(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const client = createSpaceTradersClient({ token: cfg.SPACETRADERS_PLAYER_AGENT_TOKEN });
  const persistence = createPersistenceClient({ baseUrl: cfg.API_BASE_URL, botKey: cfg.BOT_KEY });
  const homeSystem = await resolveHomeSystem(cfg, client);
  log.info(`🌌 galaxy CLI — home ${homeSystem}`);

  const api = <T>(m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, b?: unknown): Promise<T> => client.api<T>(m, p, b);

  // --path A B : pure pathfinding over the already-persisted graph (no crawl).
  if (argv[0] === '--path') {
    const [, from, to] = argv;
    if (!from || !to) throw new Error('usage: --path <fromSystem> <toSystem>');
    const provider = createGalaxyProvider({ api, persistence, now: () => Date.now() });
    const path = await provider.gatePath(from, to);
    if (!path) log.info(`🪐 no all-built gate path ${from} → ${to}`);
    else log.info(`🪐 ${from} → ${to} (${path.length - 1} hops): ${path.join(' → ')}`);
    return;
  }

  const crawler = createGalaxyCrawler({
    api,
    persistence,
    cfg,
    log: (m) => log.info(m),
    sleep,
    now: () => Date.now(),
    homeSystem,
  });

  if (argv.includes('--watch')) {
    crawler.start();
    const stop = async (): Promise<void> => {
      log.info('🌌 stopping…');
      await crawler.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    // keep the process alive
    for (;;) await sleep(60_000);
  }

  if (argv.includes('--refresh')) {
    const n = await crawler.refreshStalest(cfg.GALAXY_CRAWL_BATCH);
    log.info(`🌌 refreshed ${n} stale system(s)`);
  } else {
    const summary = await crawler.runFullPass();
    log.info(`🌌 mapped ${summary.systems} systems, ${summary.builtGates} built gates, ${summary.reachable} reachable, ${summary.edges} edges`);
    const upgraded = await crawler.fullRichnessPass(cfg.GALAXY_FULL_TOP_N);
    log.info(`🌌 full-tier enriched ${upgraded} top candidate(s)`);
  }

  const s = crawler.snapshot();
  log.info('🏆 top ranked:');
  for (const t of s.topRanked) log.info(`   ${t.symbol}  score=${t.score}  markets=${t.marketplaceCount}`);
  await persistence.flush();
}

// Run when invoked directly (node dist/galaxy/cli.js …)
const invokedDirectly = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((e) => {
    log.error(`FATAL ${(e as Error).message}`);
    process.exit(1);
  });
}
