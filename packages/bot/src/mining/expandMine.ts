import type { Ship } from '@st/shared';
import type { SubsystemDeps } from '../subsystems/deps.js';
import { hasMount } from './mining.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Shipyard = { shipTypes?: Array<{ type: string }>; ships?: Array<{ type: string; purchasePrice?: number }> };

async function getShipyards(deps: SubsystemDeps): Promise<Record<string, { wp: string; price: number }>> {
  const out: Record<string, { wp: string; price: number }> = {};
  let page = 1;
  while (page <= 5) {
    let wps: Array<{ symbol: string }> = [];
    try {
      const r = await deps.client.api<{ data?: Array<{ symbol: string }> }>('GET', `/systems/${deps.cfg.SYSTEM}/waypoints?limit=20&traits=SHIPYARD&page=${page}`);
      wps = r.data ?? [];
    } catch {
      break;
    }
    for (const w of wps) {
      try {
        const r = await deps.client.api<{ data?: Shipyard }>('GET', `/systems/${deps.cfg.SYSTEM}/waypoints/${w.symbol}/shipyard`);
        const sy = r.data;
        for (const t of sy?.shipTypes ?? []) {
          const sample = (sy?.ships ?? []).find((s) => s.type === t.type);
          out[t.type] ??= { wp: w.symbol, price: sample?.purchasePrice ?? (t.type === 'SHIP_SURVEYOR' ? 40_000 : 50_000) };
        }
      } catch {}
    }
    if (wps.length < 20) break;
    page += 1;
  }
  return out;
}

export async function buyMiningShip(deps: SubsystemDeps, shipType: string, wp: string): Promise<string | null> {
  try {
    const r = await deps.client.api<{ data?: { ship?: { symbol?: string } } }>('POST', '/my/ships', { shipType, waypointSymbol: wp });
    return r.data?.ship?.symbol ?? null;
  } catch {
    return null;
  }
}

function budget(deps: SubsystemDeps): number {
  return Math.max(0, deps.state.cachedCredits - deps.state.committed - deps.state.operatingReserve);
}

export async function mineExpandManager(deps: SubsystemDeps): Promise<void> {
  if (!deps.cfg.MINE_EXPAND || !deps.cfg.MINE_FEED || deps.state.gateCache.built) return;
  await sleep(20_000);
  while (!deps.state.stop) {
    try {
      if (deps.cfg.MINE_FEED && !deps.state.gateCache.built && deps.state.gateCache.exists) {
        const all = await deps.client.getAllShips();
        const surveyors = all.filter((s) => hasMount(s, /SURVEYOR/)).length;
        const drones = all.filter((s) => hasMount(s, /MINING_LASER/) && !hasMount(s, /SURVEYOR/)).length;
        const yards = await getShipyards(deps);
        let want: 'SHIP_SURVEYOR' | 'SHIP_MINING_DRONE' | null = null;
        if (surveyors < deps.cfg.MINE_MAX_SURVEYORS && yards.SHIP_SURVEYOR) want = 'SHIP_SURVEYOR';
        else if (drones < deps.cfg.MINE_MAX_DRONES && yards.SHIP_MINING_DRONE) want = 'SHIP_MINING_DRONE';
        if (want) {
          const yard = yards[want]!;
          const price = yard.price || (want === 'SHIP_SURVEYOR' ? 40_000 : 50_000);
          if (price <= budget(deps) && deps.state.cachedCredits - price >= deps.cfg.MINE_EXPAND_CREDIT_FLOOR) {
            const bought = await buyMiningShip(deps, want, yard.wp);
            // A bought hull gets its own supervised worker; its capability-detected mining role
            // then drives it to the asteroid — no explicit ferry here. (bot2 L2975)
            if (bought) deps.launchWorker(bought);
          }
        }
      }
    } catch {}
    await sleep(deps.cfg.MINE_EXPAND_SCAN_MS);
  }
}

async function waypointMods(deps: SubsystemDeps, wp: string): Promise<string[]> {
  try {
    const r = await deps.client.api<{ data?: { modifiers?: Array<{ symbol: string }> } }>('GET', `/systems/${deps.cfg.SYSTEM}/waypoints/${wp}`);
    return (r.data?.modifiers ?? []).map((m) => m.symbol);
  } catch {
    return [];
  }
}

function depositOfSite(deps: SubsystemDeps, site: string): string {
  for (const [trait, list] of Object.entries(deps.state.mining.asteroidCache)) if (list.includes(site)) return trait;
  return 'COMMON_METAL_DEPOSITS';
}

export async function mineMigrateManager(deps: SubsystemDeps): Promise<void> {
  if (!deps.cfg.MINE_MIGRATE || !deps.cfg.MINE_FEED || deps.state.gateCache.built) return;
  await sleep(30_000);
  while (!deps.state.stop) {
    try {
      const site = deps.state.mining.site;
      if (deps.cfg.MINE_FEED && !deps.state.gateCache.built && site) {
        const mods = await waypointMods(deps, site);
        const stripped = mods.includes('STRIPPED');
        const critical = mods.includes('CRITICAL_LIMIT');
        if (stripped || critical) {
          const dep = depositOfSite(deps, site);
          const alt = (deps.state.mining.asteroidCache[dep] ?? []).find((w) => w !== site && !deps.state.mining.depletedSites.has(w));
          if (alt) {
            deps.state.mining.depletedSites.add(site);
            deps.state.mining.surveys = deps.state.mining.surveys.filter((s) => s.symbol !== site);
            deps.state.mining.site = null;
            deps.state.mining.asteroidCache = {};
          } else if (stripped) {
            // preserve legacy reduced-yield stay-put behavior when no healthy replacement exists
          }
        }
      }
    } catch {}
    await sleep(deps.cfg.MINE_MIGRATE_SCAN_MS);
  }
}

export function countMiningHulls(all: Ship[]): { surveyors: number; drones: number } {
  return {
    surveyors: all.filter((s) => hasMount(s, /SURVEYOR/)).length,
    drones: all.filter((s) => hasMount(s, /MINING_LASER/) && !hasMount(s, /SURVEYOR/)).length,
  };
}
