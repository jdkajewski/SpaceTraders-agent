import type { ApiEnvelope } from '../interfaces.js';
import type { SubsystemDeps } from '../subsystems/deps.js';
import type { Ship } from '@st/shared';
import { growthBudget } from '../budget/budget.js';
import { logger } from '../core/logger.js';

const log = logger.child({ mod: 'fleet.scale' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SHIPYARD_TTL_MS = 600_000;
const STARTUP_DELAY_MS = 25_000;
const PROBE_PRICE_EST = 30_000;
const SHUTTLE_PRICE_EST = 82_000;
const HAULER_PRICE_EST = 291_000;

export interface ShipyardOffer {
  wp: string;
  price: number | null;
}

interface ShipyardShip {
  type: string;
  purchasePrice?: number;
}

interface ShipyardType {
  type: string;
}

interface ShipyardData {
  ships?: ShipyardShip[];
  shipTypes?: ShipyardType[];
}

export function isProbeHull(ship: Ship): boolean {
  return ship.frame?.symbol === 'FRAME_PROBE' || ((ship.fuel?.capacity ?? 0) === 0 && (ship.cargo?.capacity ?? 0) === 0);
}

export function probeTargetFor(cargoShipCount: number, base: number, ratio: number): number {
  return base + ratio * Math.max(0, cargoShipCount - 1);
}

export function cappedProbeTarget(cargoShipCount: number, marketCount: number, base: number, ratio: number, maxProbes = 0): number {
  const probeCap = maxProbes > 0 ? Math.min(maxProbes, marketCount) : marketCount;
  return Math.min(probeCap, probeTargetFor(cargoShipCount, base, ratio));
}

export function shipyardWps(yards: Record<string, ShipyardOffer>): string[] {
  return [...new Set(Object.values(yards).map((y) => y.wp).filter(Boolean))];
}

export function isShipyardWp(wp: string, yards: Record<string, ShipyardOffer>): boolean {
  return shipyardWps(yards).includes(wp);
}

export function nearestShipyardWp(fromWp: string, yards: Record<string, ShipyardOffer>, deps: Pick<SubsystemDeps, 'D'>): string | null {
  let best: string | null = null;
  let bd = Infinity;
  for (const wp of shipyardWps(yards)) {
    const d = deps.D(fromWp, wp);
    if (d < bd) {
      bd = d;
      best = wp;
    }
  }
  return best;
}

function yardsFromState(cached: Record<string, string[]> | null): Record<string, ShipyardOffer> {
  const out: Record<string, ShipyardOffer> = {};
  if (!cached) return out;
  for (const [type, wps] of Object.entries(cached)) {
    wps.forEach((wp, idx) => {
      out[idx === 0 ? type : `${type}#${idx}`] = { wp, price: null };
    });
  }
  return out;
}

export async function getShipyards(deps: Pick<SubsystemDeps, 'state' | 'cfg' | 'client'>, force = false): Promise<Record<string, ShipyardOffer>> {
  const { state, cfg, client } = deps;
  if (!force && state.fleet.lastScan && Date.now() - state.fleet.lastScan < SHIPYARD_TTL_MS && state.fleet.shipyards) {
    return yardsFromState(state.fleet.shipyards);
  }

  const yards: Record<string, ShipyardOffer> = {};
  const cache: Record<string, string[]> = {};
  try {
    const wps = (
      await client.api<ApiEnvelope<Array<{ symbol: string }>>>(
        'GET',
        `/systems/${cfg.SYSTEM}/waypoints?limit=20&traits=SHIPYARD`,
      )
    ).data ?? [];
    for (const w of wps) {
      try {
        const sy = (
          await client.api<ApiEnvelope<ShipyardData>>('GET', `/systems/${cfg.SYSTEM}/waypoints/${w.symbol}/shipyard`)
        ).data;
        for (const s of sy.ships ?? []) {
          const cachedWps = cache[s.type] ?? [];
          if (!cachedWps.includes(w.symbol)) cachedWps.push(w.symbol);
          cache[s.type] = cachedWps;
          const price = s.purchasePrice ?? null;
          const cur = yards[s.type];
          if (!cur || (price != null && price < (cur.price ?? Infinity))) yards[s.type] = { wp: w.symbol, price };
        }
        for (const t of sy.shipTypes ?? []) {
          const cachedWps = cache[t.type] ?? [];
          if (!cachedWps.includes(w.symbol)) cachedWps.push(w.symbol);
          cache[t.type] = cachedWps;
          if (!yards[t.type]) yards[t.type] = { wp: w.symbol, price: null };
        }
      } catch {
        /* keep scanning other shipyards */
      }
    }
  } catch {
    /* keep prior/empty cache on waypoint scan failure */
  }
  state.fleet.shipyards = cache;
  state.fleet.lastScan = Date.now();
  return yards;
}

async function buyShip(shipType: string, waypointSymbol: string, deps: Pick<SubsystemDeps, 'client'>): Promise<string | null> {
  try {
    const r = await deps.client.api<{ data?: { ship?: { symbol?: string } } }>('POST', '/my/ships', { shipType, waypointSymbol });
    return r.data?.ship?.symbol ?? null;
  } catch (e) {
    log.warn(`🛰 buy ${shipType} @ ${waypointSymbol.slice(-3)} failed: ${(e as Error).message}`);
    return null;
  }
}

function pickAnchorYards(yards: Record<string, ShipyardOffer>): { probeYard: string | null; cargoYard: string | null; anchorYard: string | null } {
  const byWp = new Map<string, Set<string>>();
  for (const [type, offer] of Object.entries(yards)) {
    const set = byWp.get(offer.wp) ?? new Set<string>();
    set.add(type);
    byWp.set(offer.wp, set);
  }
  const entries = [...byWp.entries()];
  const hasProbe = ([, types]: [string, Set<string>]) => types.has('SHIP_PROBE');
  const hasCargo = ([, types]: [string, Set<string>]) => types.has('SHIP_LIGHT_HAULER') || types.has('SHIP_LIGHT_SHUTTLE');
  const anchorYard = entries.find((e) => hasProbe(e) && hasCargo(e))?.[0] ?? null;
  const probeYard = anchorYard ?? entries.find(hasProbe)?.[0] ?? null;
  const cargoYard = anchorYard ?? entries.find(hasCargo)?.[0] ?? null;
  return { probeYard, cargoYard, anchorYard: anchorYard ?? probeYard };
}

export async function fleetScaleManager(deps: SubsystemDeps): Promise<void> {
  const { state, cfg, client } = deps;
  if (!cfg.FLEET_SCALE) return;
  await sleep(STARTUP_DELAY_MS);

  const yards = await getShipyards(deps, true);
  const { probeYard, cargoYard, anchorYard } = pickAnchorYards(yards);
  if (!probeYard || !anchorYard) {
    log.info('🛰 FLEET_SCALE: no probe-selling shipyard found — disabled');
    return;
  }
  log.info(`🛰 FLEET_SCALE armed — anchorYard ${anchorYard.slice(-3)} (probe ${probeYard.slice(-3)}, cargo ${cargoYard?.slice(-3) ?? 'none'}), floor ${cfg.FLEET_SCALE_FLOOR.toLocaleString()}`);

  let anchorSent = false;
  while (!state.stop) {
    try {
      if (state.gateCache.built) {
        log.info('🛰 FLEET_SCALE: gate built → expansion takes over, manager exiting');
        return;
      }
      const markets = await deps.markets.getMarkets();
      const marketWps = Object.keys(markets);
      const all = await client.getAllShips();
      const atYard = all.find((s) => s.nav.waypointSymbol === anchorYard && s.nav.status !== 'IN_TRANSIT');
      const headingYard = all.find((s) => s.nav.status === 'IN_TRANSIT' && s.nav.route?.destination?.symbol === anchorYard);
      if (!atYard && !headingYard && !anchorSent) {
        const freeProbe = all.find((s) => isProbeHull(s) && s.symbol !== cfg.NEGOTIATOR && s.nav.status !== 'IN_TRANSIT');
        if (freeProbe) {
          try {
            if (freeProbe.nav.status === 'DOCKED') await client.api('POST', `/my/ships/${freeProbe.symbol}/orbit`);
            await client.api('POST', `/my/ships/${freeProbe.symbol}/navigate`, { waypointSymbol: anchorYard });
            anchorSent = true;
            log.info(`🛰 FLEET_SCALE: anchoring ${freeProbe.symbol.slice(-3)} → ${anchorYard.slice(-3)} for buys`);
          } catch (e) {
            log.warn(`🛰 anchor ERR ${(e as Error).message}`);
          }
        }
      }

      if (growthBudget(state) < 1000 || state.cachedCredits < cfg.FLEET_SCALE_FLOOR) {
        await sleep(cfg.FLEET_SCALE_MS);
        continue;
      }

      const covered = new Set<string>();
      for (const s of all) {
        covered.add(s.nav.waypointSymbol);
        const dest = s.nav.route?.destination?.symbol;
        if (dest) covered.add(dest);
      }
      const uncovered = marketWps.filter((w) => !covered.has(w));
      const probeCount = all.filter(isProbeHull).length;
      const cargoShips = all.filter((s) => !isProbeHull(s) && (s.cargo?.capacity ?? 0) >= 30).length;
      const haulers = all.filter((s) => !isProbeHull(s) && (s.cargo?.capacity ?? 0) >= 80).length;
      const legacyProbeTarget = cappedProbeTarget(cargoShips, marketWps.length, cfg.FLEET_BASE_PROBES, cfg.FLEET_PROBE_RATIO, cfg.FLEET_MAX_PROBES);

      // [issue #2 phases 4+7] Value-driven coverage controller (opt-in). When FLEET_COVERAGE_ADAPTIVE
      // is on, probe TARGET + PLACEMENT follow live per-market value instead of ~1 probe per market.
      // FLEET_COVERAGE_PRUNE additionally redeploys probes off markets we've read and found DEAD. Both
      // default OFF → this whole block is inert and behaviour is byte-for-byte the legacy path.
      const plan = cfg.FLEET_COVERAGE_ADAPTIVE
        ? deps.markets.coveragePlan(covered, { fleetSize: all.length, marketCount: marketWps.length })
        : null;
      if (plan) {
        state.coverage = {
          tierCounts: plan.counts,
          target: plan.shouldCover.length,
          covered: marketWps.length - uncovered.length,
          probesSaved: plan.probesSaved,
          recheckDue: plan.recheckDue.length,
          adaptive: cfg.FLEET_COVERAGE_ADAPTIVE,
          prune: cfg.FLEET_COVERAGE_PRUNE,
          updatedAt: Date.now(),
        };
      }
      // Probe target: count of markets actually worth covering (value-driven), else the legacy 1:1 cap.
      const probeTarget = plan ? plan.shouldCover.length : legacyProbeTarget;
      // Placement order: highest-value uncovered first (value-driven), else legacy export-preferring + nearest.
      const placeOrder = (): string[] =>
        plan
          ? [...plan.toCover, ...plan.recheckDue].filter((w, i, a) => a.indexOf(w) === i && !covered.has(w))
          : uncovered
              .slice()
              .sort(
                (a, b) =>
                  (((markets[a]?.exports ?? []).length > 0 ? 0 : 1) - ((markets[b]?.exports ?? []).length > 0 ? 0 : 1)) ||
                  deps.D(anchorYard, a) - deps.D(anchorYard, b),
              );

      if (!atYard) {
        await sleep(cfg.FLEET_SCALE_MS);
        continue;
      }
      if (atYard.nav.status !== 'DOCKED') {
        try { await client.api('POST', `/my/ships/${atYard.symbol}/dock`); } catch {}
      }

      const freshYards = await getShipyards(deps, true);
      const probePx = freshYards.SHIP_PROBE?.price ?? PROBE_PRICE_EST;
      const shuttlePx = freshYards.SHIP_LIGHT_SHUTTLE?.price ?? SHUTTLE_PRICE_EST;
      const haulPx = freshYards.SHIP_LIGHT_HAULER?.price ?? HAULER_PRICE_EST;
      const canAfford = (px: number): boolean => state.cachedCredits - state.committed - px >= Math.max(cfg.FLEET_SCALE_FLOOR, state.operatingReserve);

      // [issue #2] Reversible prune: before buying, redeploy a probe parked on a read-DEAD market to the
      // highest-value market needing coverage. The vacated market isn't forgotten — it re-enters the cold
      // re-check schedule (recheckDue) and is promoted back if its lanes ever light up. FLEET_COVERAGE_PRUNE
      // gated; only fires when there's somewhere strictly better to put the probe (no churn otherwise).
      if (plan && cfg.FLEET_COVERAGE_PRUNE && plan.toPrune.length) {
        const dest = placeOrder()[0];
        const pruneWp = plan.toPrune[0];
        if (dest && pruneWp) {
          const probe = all.find(
            (s) => isProbeHull(s) && s.symbol !== cfg.NEGOTIATOR && s.nav.status !== 'IN_TRANSIT' && s.nav.waypointSymbol === pruneWp,
          );
          if (probe) {
            try {
              if (probe.nav.status === 'DOCKED') await client.api('POST', `/my/ships/${probe.symbol}/orbit`);
              await client.api('POST', `/my/ships/${probe.symbol}/navigate`, { waypointSymbol: dest });
              log.info(`🛰 FLEET_SCALE redeploy ${probe.symbol.slice(-3)}: DEAD ${pruneWp.slice(-3)} → ${dest.slice(-3)} (reversible; ${pruneWp.slice(-3)} keeps re-check)`);
              await sleep(cfg.FLEET_SCALE_MS);
              continue;
            } catch (e) {
              log.warn(`🛰 redeploy ERR ${(e as Error).message}`);
            }
          }
        }
      }

      if (probeCount < probeTarget && placeOrder().length && canAfford(probePx)) {
        const bought = await buyShip('SHIP_PROBE', anchorYard, deps);
        const dest = placeOrder()[0];
        if (bought && dest) {
          try {
            await client.api('POST', `/my/ships/${bought}/orbit`);
            await client.api('POST', `/my/ships/${bought}/navigate`, { waypointSymbol: dest });
          } catch (e) {
            log.warn(`🛰 ${bought.slice(-3)} place ERR ${(e as Error).message}`);
          }
          log.info(`🛰 FLEET_SCALE bought PROBE ${bought.slice(-3)} @ ${probePx.toLocaleString()} → ${dest.slice(-3)} (coverage ${marketWps.length - uncovered.length + 1}/${marketWps.length})`);
          await sleep(cfg.FLEET_SCALE_MS);
          continue;
        }
      }
      if (cargoShips < cfg.FLEET_TARGET_TRADERS && state.cachedCredits >= cfg.FLEET_SHUTTLE_MIN && canAfford(shuttlePx)) {
        const bought = await buyShip('SHIP_LIGHT_SHUTTLE', anchorYard, deps);
        if (bought) {
          log.info(`🛰 FLEET_SCALE bought LIGHT_SHUTTLE ${bought.slice(-3)} @ ${shuttlePx.toLocaleString()} → trade pool (cargo ships ${cargoShips + 1})`);
          deps.launchWorker(bought); // bought trader joins the supervised pool (bot2 L3062)
        }
        await sleep(cfg.FLEET_SCALE_MS);
        continue;
      }
      if (cargoShips < cfg.FLEET_TARGET_TRADERS && state.cachedCredits >= cfg.FLEET_HAULER_MIN && haulers < cfg.FLEET_MAX_HAULERS && canAfford(haulPx)) {
        const bought = await buyShip('SHIP_LIGHT_HAULER', anchorYard, deps);
        if (bought) {
          log.info(`🛰 FLEET_SCALE bought LIGHT_HAULER ${bought.slice(-3)} @ ${haulPx.toLocaleString()} → trade pool (cargo ships ${cargoShips + 1})`);
          deps.launchWorker(bought); // bought trader joins the supervised pool (bot2 L3062)
        }
        await sleep(cfg.FLEET_SCALE_MS);
        continue;
      }
    } catch (e) {
      log.warn(`🛰 FLEET_SCALE ERR ${(e as Error).message}`);
    }
    await sleep(cfg.FLEET_SCALE_MS);
  }
}

export const __test = { SHIPYARD_TTL_MS, STARTUP_DELAY_MS };
