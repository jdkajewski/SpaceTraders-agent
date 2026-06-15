import { IDLE_WAIT_MS, REFINE_IN, REFINE_OUT, SUPPLY_RANK } from '@st/shared';
import type { Market, MineEvent, Ship, Survey } from '@st/shared';
import type { SubsystemDeps } from '../subsystems/deps.js';
import type { MiningHooks } from '../subsystems/deps.js';
import { bestSink, findProducerWp } from '../trade/marketHelpers.js';
import { marketSellsFuel } from '../routing/route.js';

export const MINE_ORES: Readonly<Record<'COPPER_ORE' | 'IRON_ORE', 'COPPER' | 'IRON'>> = {
  COPPER_ORE: 'COPPER',
  IRON_ORE: 'IRON',
} as const;
export const MINE_DIRECT = ['SILICON_CRYSTALS', 'QUARTZ_SAND'] as const;
export const MINE_KEEP = new Set<string>([...Object.keys(MINE_ORES), ...MINE_DIRECT]);
export const FEED_GOODS = [...Object.values(MINE_ORES), ...MINE_DIRECT] as const;
export const RAW_ORE = Object.keys(MINE_ORES) as Array<keyof typeof MINE_ORES>;

export type MineRole = 'REFINER' | 'SURVEYOR' | 'DRONE' | 'FUNNEL' | 'TRANSPORT';

const ASTEROID_TYPES = ['ASTEROID', 'ENGINEERED_ASTEROID', 'ASTEROID_FIELD'] as const;
const SURVEY_SIZE_RANK: Record<Survey['size'], number> = { SMALL: 1, MODERATE: 2, LARGE: 3 };
const ORE_LIST = Object.keys(MINE_ORES) as Array<keyof typeof MINE_ORES>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ApiData<T> = { data?: T };
type ExtractData = { extraction?: { yield?: { symbol?: string; units?: number } }; cooldown?: { remainingSeconds?: number } };
type RefineData = { cooldown?: { remainingSeconds?: number } };
type SurveyData = { surveys?: Survey[]; cooldown?: { remainingSeconds?: number } };
type Waypoint = { symbol: string; x?: number; y?: number; traits?: Array<{ symbol: string }>; modifiers?: Array<{ symbol: string }> };

interface RoleOptions {
  mineFeed?: boolean;
  gateBuilt?: boolean;
  funnelSyms?: readonly string[];
  transportSyms?: readonly string[];
  tenderSym?: string | null;
}

export function parseCooldownMs(message: string): number | null {
  const m = message.match(/(\d+) second/);
  return m?.[1] ? (Number(m[1]) + 1) * 1000 : null;
}

export function cargoUnits(ship: Ship, sym: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === sym)?.units ?? 0;
}

export function hasMount(ship: Ship, re: RegExp): boolean {
  return (ship.mounts ?? []).some((m) => re.test(m.symbol));
}

export function hasModule(ship: Ship, re: RegExp): boolean {
  return (ship.modules ?? []).some((m) => re.test(m.symbol));
}

function pinned(sym: string, pins: readonly string[] | undefined): boolean {
  for (const h of pins ?? []) if (sym === h || sym.endsWith(`-${h}`)) return true;
  return false;
}

export function mineRoleOf(ship: Ship, opts: RoleOptions = {}): MineRole | null {
  if (opts.mineFeed === false || opts.gateBuilt === true) return null;
  const miner = hasMount(ship, /MINING_LASER/);
  if (miner && hasModule(ship, /ORE_REFINERY/)) return 'REFINER';
  if (hasMount(ship, /SURVEYOR/)) return 'SURVEYOR';
  if (miner) return 'DRONE';
  if (pinned(ship.symbol, opts.funnelSyms)) return 'FUNNEL';
  if (ship.symbol === opts.tenderSym || pinned(ship.symbol, opts.transportSyms)) return 'TRANSPORT';
  return null;
}

export function shouldRelieveRawOre(args: {
  rawUnits: number;
  funnelLoad: number;
  freeCapacity: number;
  ore: string;
  refineTarget: string | null;
  clogAt: number;
  oreReserve: number;
  rawRelief: boolean;
}): number {
  if (!args.rawRelief || args.funnelLoad < args.clogAt || args.freeCapacity <= 0) return 0;
  const reserve = args.ore === args.refineTarget ? args.oreReserve : 0;
  return Math.min(Math.max(0, args.rawUnits - reserve), args.freeCapacity);
}

export function pickMineTender(all: Ship[], opts: { transportPins?: readonly string[]; negotiator?: string } = {}): string | null {
  if ((opts.transportPins?.length ?? 0) > 0) return null;
  const cand = all.filter(
    (s) =>
      s.cargo.capacity > 0 &&
      s.fuel.capacity > 0 &&
      !hasMount(s, /MINING_LASER/) &&
      !hasMount(s, /SURVEYOR/) &&
      s.symbol !== opts.negotiator,
  );
  const isHauler = (s: Ship) => /FREIGHTER|HAULER/.test(s.frame.symbol ?? '');
  let pool = cand.filter(isHauler);
  if (!pool.length) pool = cand.filter((s) => s.cargo.capacity >= 40 && s.fuel.capacity >= 200);
  if (!pool.length) return null;
  pool.sort((a, b) => b.cargo.capacity - a.cargo.capacity || b.fuel.capacity - a.fuel.capacity);
  return pool[0]?.symbol ?? null;
}

function mineCfg(deps: SubsystemDeps): RoleOptions {
  return {
    mineFeed: deps.cfg.MINE_FEED,
    gateBuilt: deps.state.gateCache.built,
    funnelSyms: deps.cfg.MINE_FUNNEL,
    transportSyms: deps.cfg.MINE_TRANSPORT,
    tenderSym: deps.state.mining.tenderSym,
  };
}

function ensurePerShip(deps: SubsystemDeps, shipSym: string): void {
  deps.state.perShip[shipSym] ??= { net: 0, lanes: 0, last: '' };
}

function logMine(deps: SubsystemDeps, type: MineEvent['type'], ship: string, data: Record<string, unknown>): void {
  deps.persistence.appendMineEvents([{ ts: new Date().toISOString(), type, ship, data }]);
}

async function safeGoTo(deps: SubsystemDeps, shipSym: string, dest: string, markets: Record<string, Market>): Promise<void> {
  try {
    await deps.goTo(shipSym, dest, markets);
  } catch (e) {
    if (!(e instanceof Error) || !/located at the destination/i.test(e.message)) throw e;
  }
}

function fuelNodes(markets: Record<string, Market>): string[] {
  return Object.entries(markets)
    .filter(([, m]) => marketSellsFuel(m))
    .map(([w]) => w);
}

async function loadAsteroids(deps: SubsystemDeps): Promise<Record<string, string[]>> {
  const cache = deps.state.mining.asteroidCache;
  if (Object.keys(cache).length) return cache;
  for (const type of ASTEROID_TYPES) {
    for (let page = 1; page <= 5; page++) {
      let r: ApiData<Waypoint[]>;
      try {
        r = await deps.client.api<ApiData<Waypoint[]>>('GET', `/systems/${deps.cfg.SYSTEM}/waypoints?type=${type}&limit=20&page=${page}`);
      } catch {
        break;
      }
      const rows = r.data ?? [];
      for (const w of rows) {
        const mods = (w.modifiers ?? []).map((m) => m.symbol);
        if (mods.includes('STRIPPED') || deps.state.mining.depletedSites.has(w.symbol)) continue;
        for (const t of w.traits ?? []) if (/DEPOSIT/.test(t.symbol)) (cache[t.symbol] ??= []).push(w.symbol);
      }
      if (rows.length < 20) break;
    }
  }
  return cache;
}

export function nearestAsteroid(deps: SubsystemDeps, fromWp: string, trait: string): string | null {
  const list = deps.state.mining.asteroidCache[trait] ?? [];
  let best: string | null = null;
  let bd = Infinity;
  for (const wp of list) {
    if (deps.state.mining.depletedSites.has(wp)) continue;
    const d = deps.D(fromWp, wp);
    if (d < bd) {
      bd = d;
      best = wp;
    }
  }
  return best;
}

function colonySite(deps: SubsystemDeps, markets: Record<string, Market>, fromWp: string): string | null {
  if (deps.state.mining.site) return deps.state.mining.site;
  const prod = deps.cfg.MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  const site = nearestAsteroid(deps, prod || fromWp, 'COMMON_METAL_DEPOSITS');
  deps.state.mining.site = site;
  return site;
}

async function fuelTopUp(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>, need: number): Promise<void> {
  if (ship.fuel.current >= Math.min(need + 20, ship.fuel.capacity)) return;
  let fwp: string | null = null;
  let fd = Infinity;
  for (const w of fuelNodes(markets)) {
    const d = deps.D(ship.nav.waypointSymbol, w);
    if (d < fd) {
      fd = d;
      fwp = w;
    }
  }
  if (fwp && fwp !== ship.nav.waypointSymbol) {
    await safeGoTo(deps, shipSym, fwp, markets);
    try { await deps.actions.refuel(shipSym); } catch {}
  } else {
    try { await deps.actions.refuel(shipSym); } catch {}
  }
}

async function goToColonySite(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>, site: string): Promise<Ship> {
  if (ship.nav.waypointSymbol === site) return ship;
  await fuelTopUp(deps, shipSym, ship, markets, deps.D(ship.nav.waypointSymbol, site) + 30);
  await safeGoTo(deps, shipSym, site, markets);
  return deps.actions.getShip(shipSym);
}

function registerColony(deps: SubsystemDeps, shipSym: string, ship: Ship): void {
  deps.state.mining.colonyShips[shipSym] = { wp: ship.nav.waypointSymbol, fuel: ship.fuel.current, cap: ship.fuel.capacity };
}

async function jettison(deps: SubsystemDeps, shipSym: string, sym: string, units: number): Promise<void> {
  try {
    await deps.client.api('POST', `/my/ships/${shipSym}/jettison`, { symbol: sym, units });
    logMine(deps, 'extract', shipSym, { ev: 'jettison', sym, units });
  } catch {}
}

async function refuelFromCargo(deps: SubsystemDeps, shipSym: string): Promise<boolean> {
  try {
    await deps.client.api('POST', `/my/ships/${shipSym}/refuel`, { fromCargo: true });
    return true;
  } catch {
    return false;
  }
}

async function extractOnce(deps: SubsystemDeps, shipSym: string, survey: Survey | null): Promise<ExtractData | null> {
  try { await deps.actions.ensureOrbit(shipSym); } catch {}
  try {
    const r = await deps.client.api<ApiData<ExtractData>>('POST', `/my/ships/${shipSym}/extract`, survey ? { survey } : undefined);
    return r.data ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ms = parseCooldownMs(msg);
    if (ms !== null) { await sleep(ms); return null; }
    if (/survey/i.test(msg) && survey) deps.state.mining.surveys = deps.state.mining.surveys.filter((s) => s !== survey);
    else throw e;
    return null;
  }
}

async function refineOnce(deps: SubsystemDeps, shipSym: string, produce: string): Promise<RefineData | null> {
  try {
    const r = await deps.client.api<ApiData<RefineData>>('POST', `/my/ships/${shipSym}/refine`, { produce });
    return r.data ?? null;
  } catch (e) {
    const ms = parseCooldownMs(e instanceof Error ? e.message : String(e));
    if (ms !== null) { await sleep(ms); return null; }
    throw e;
  }
}

export function pruneSurveys(deps: SubsystemDeps): void {
  const t = Date.now();
  deps.state.mining.surveys = deps.state.mining.surveys.filter((s) => new Date(s.expiration).getTime() > t + 5000);
}

export function bestSurveyFor(deps: SubsystemDeps, ast: string, ore: string): Survey | null {
  pruneSurveys(deps);
  let best: Survey | null = null;
  let bestScore = 0;
  for (const s of deps.state.mining.surveys) {
    if (s.symbol !== ast) continue;
    const deposits = s.deposits ?? [];
    const match = deposits.filter((d) => d.symbol === ore).length;
    if (!match) continue;
    const score = (match / (deposits.length || 1)) * (SURVEY_SIZE_RANK[s.size] ?? 1);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

async function surveyOnce(deps: SubsystemDeps, shipSym: string): Promise<SurveyData | null> {
  try { await deps.actions.ensureOrbit(shipSym); } catch {}
  try {
    const r = await deps.client.api<ApiData<SurveyData>>('POST', `/my/ships/${shipSym}/survey`);
    const d = r.data ?? {};
    for (const s of d.surveys ?? []) {
      deps.state.mining.surveys.push(s);
      logMine(deps, 'survey', shipSym, { ast: s.symbol, size: s.size, deposits: (s.deposits ?? []).map((x) => x.symbol) });
    }
    return d;
  } catch (e) {
    const ms = parseCooldownMs(e instanceof Error ? e.message : String(e));
    if (ms !== null) { await sleep(ms); return null; }
    throw e;
  }
}

function bestSiteSurvey(deps: SubsystemDeps, site: string): Survey | null {
  return bestSurveyFor(deps, site, 'COPPER_ORE') ?? bestSurveyFor(deps, site, 'IRON_ORE') ?? bestSurveyFor(deps, site, 'SILICON_CRYSTALS') ?? bestSurveyFor(deps, site, 'QUARTZ_SAND');
}

function pickMineGood(deps: SubsystemDeps, producer: Market): string | null {
  if (deps.cfg.MINE_GOOD) return deps.cfg.MINE_GOOD;
  const imports: Record<string, NonNullable<Market['tradeGoods']>[number]> = {};
  for (const g of producer.tradeGoods ?? []) if (g.type === 'IMPORT') imports[g.symbol] = g;
  let best: string | null = null;
  let bestScore = -1;
  for (const good of FEED_GOODS) {
    const im = imports[good];
    if (!im || !(im.sellPrice > 0)) continue;
    const score = im.sellPrice * (1 + (4 - (SUPPLY_RANK[im.supply] ?? 2)) * 0.25);
    if (score > bestScore) { bestScore = score; best = good; }
  }
  return best;
}

async function mineFeedTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  if (!deps.cfg.MINE_FEED || deps.state.gateCache.built) return false;
  await loadAsteroids(deps);
  const producerWp = deps.cfg.MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  if (!producerWp || !markets[producerWp]) return false;
  const good = pickMineGood(deps, markets[producerWp]);
  if (!good) return false;
  const spec = Object.entries(MINE_ORES).find(([, metal]) => metal === good);
  const deposit = spec ? 'COMMON_METAL_DEPOSITS' : 'COMMON_MINERAL_DEPOSITS';
  const ore = spec?.[0] ?? good;
  const ast = nearestAsteroid(deps, ship.nav.waypointSymbol, deposit);
  if (!ast) return false;
  deps.state.mining.active.add(shipSym);
  ensurePerShip(deps, shipSym);
  try {
    await safeGoTo(deps, shipSym, ast, markets);
    let guard = 0;
    while (!deps.state.stop && cargoUnits(await deps.actions.getShip(shipSym), good) < deps.cfg.MINE_BATCH && guard++ <= 80) {
      ship = await deps.actions.getShip(shipSym);
      const free = ship.cargo.capacity - ship.cargo.units;
      if (spec && cargoUnits(ship, ore) >= REFINE_IN) {
        const rr = await refineOnce(deps, shipSym, good);
        if (rr) logMine(deps, 'refine', shipSym, { good, in: REFINE_IN, out: REFINE_OUT });
        if (rr?.cooldown?.remainingSeconds) await sleep((rr.cooldown.remainingSeconds + 1) * 1000);
        continue;
      }
      if (free <= 0) break;
      let survey = bestSurveyFor(deps, ast, ore);
      if (!survey && hasMount(ship, /SURVEYOR/)) {
        const sd = await surveyOnce(deps, shipSym);
        if (sd?.cooldown?.remainingSeconds) await sleep((sd.cooldown.remainingSeconds + 1) * 1000);
        survey = bestSurveyFor(deps, ast, ore);
      }
      const ex = await extractOnce(deps, shipSym, survey);
      if (ex) {
        const y = ex.extraction?.yield;
        logMine(deps, 'extract', shipSym, { ast, deposit, surveyed: !!survey, yield: y?.symbol, units: y?.units });
        if (ex.cooldown?.remainingSeconds) await sleep((ex.cooldown.remainingSeconds + 1) * 1000);
      }
    }
    ship = await deps.actions.getShip(shipSym);
    const feedUnits = cargoUnits(ship, good);
    if (feedUnits <= 0) return true;
    await safeGoTo(deps, shipSym, producerWp, markets);
    const rs = await deps.actions.sell(shipSym, good);
    await deps.record(shipSym, rs.got || 0, `MINE-FEED ${good}`);
    logMine(deps, 'feed', shipSym, { good, units: feedUnits, revenue: rs.got || 0, producer: producerWp });
  } finally {
    deps.state.mining.active.delete(shipSym);
    ensurePerShip(deps, shipSym);
    deps.state.perShip[shipSym]!.projected = 0;
  }
  return true;
}

async function refinerTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  await loadAsteroids(deps);
  const site = colonySite(deps, markets, ship.nav.waypointSymbol);
  if (!site) return false;
  deps.state.mining.refinerSym = shipSym;
  ship = await goToColonySite(deps, shipSym, ship, markets, site);
  registerColony(deps, shipSym, ship);
  ensurePerShip(deps, shipSym);
  deps.state.perShip[shipSym]!.last = `REFINE @ ${site.slice(-3)}`;
  deps.state.mining.refineTarget ??= ORE_LIST[0] ?? null;
  const refineTarget = deps.state.mining.refineTarget;
  const funnelSym = deps.state.mining.funnelSym;
  if (funnelSym && funnelSym !== shipSym && refineTarget && ship.nav.waypointSymbol === site) {
    // [RULE: single-good-refine] keep the hold pure: one refine target at a time, with all other goods pushed out.
    for (const it of [...ship.cargo.inventory]) {
      if (it.symbol === refineTarget || it.symbol === 'FUEL') continue;
      // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
      try { await deps.actions.transfer(shipSym, funnelSym, it.symbol, it.units); } catch {}
    }
    ship = await deps.actions.getShip(shipSym);
    if (cargoUnits(ship, refineTarget) >= REFINE_IN) {
      const metal = MINE_ORES[refineTarget as keyof typeof MINE_ORES];
      const rr = await refineOnce(deps, shipSym, metal);
      if (rr) logMine(deps, 'refine', shipSym, { good: metal, in: REFINE_IN, out: REFINE_OUT });
      try {
        const u = cargoUnits(await deps.actions.getShip(shipSym), metal);
        if (u > 0) await deps.actions.transfer(shipSym, funnelSym, metal, u);
      } catch {}
      const idx = ORE_LIST.indexOf(refineTarget as keyof typeof MINE_ORES);
      deps.state.mining.refineTarget = ORE_LIST[(idx + 1) % ORE_LIST.length] ?? null;
      return true;
    }
    const funnel = await deps.actions.getShip(funnelSym);
    const need = REFINE_IN - cargoUnits(ship, refineTarget);
    const take = Math.min(cargoUnits(funnel, refineTarget), need, ship.cargo.capacity - ship.cargo.units);
    // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
    if (take > 0) { try { await deps.actions.transfer(funnelSym, shipSym, refineTarget, take); return true; } catch {} }
    const other = ORE_LIST.find((o) => o !== refineTarget);
    if (other && cargoUnits(funnel, other) >= REFINE_IN) { deps.state.mining.refineTarget = other; return true; }
    if (hasMount(ship, /SURVEYOR/) && !bestSiteSurvey(deps, site)) { await surveyOnce(deps, shipSym); return true; }
    if (ship.cargo.capacity - ship.cargo.units > 1) {
      const survey = bestSiteSurvey(deps, site);
      const ex = await extractOnce(deps, shipSym, survey);
      const y = ex?.extraction?.yield;
      if (y) {
        logMine(deps, 'extract', shipSym, { role: 'REFINER', ast: site, surveyed: !!survey, yield: y.symbol, units: y.units });
        if (y.symbol && y.units && !MINE_KEEP.has(y.symbol)) await jettison(deps, shipSym, y.symbol, y.units);
      }
      return true;
    }
    await sleep(IDLE_WAIT_MS);
    return true;
  }
  for (const [ore, metal] of Object.entries(MINE_ORES)) {
    if (cargoUnits(ship, ore) >= REFINE_IN) {
      const rr = await refineOnce(deps, shipSym, metal);
      if (rr) logMine(deps, 'refine', shipSym, { good: metal, in: REFINE_IN, out: REFINE_OUT });
      return true;
    }
  }
  if (hasMount(ship, /SURVEYOR/) && !bestSiteSurvey(deps, site)) { await surveyOnce(deps, shipSym); return true; }
  if (ship.cargo.capacity - ship.cargo.units <= 1) return true;
  const survey = bestSiteSurvey(deps, site);
  const ex = await extractOnce(deps, shipSym, survey);
  const y = ex?.extraction?.yield;
  if (y) {
    logMine(deps, 'extract', shipSym, { role: 'REFINER', ast: site, surveyed: !!survey, yield: y.symbol, units: y.units });
    if (y.symbol && y.units && !MINE_KEEP.has(y.symbol) && y.symbol !== 'COPPER' && y.symbol !== 'IRON') await jettison(deps, shipSym, y.symbol, y.units);
  }
  return true;
}

async function droneTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  await loadAsteroids(deps);
  const site = colonySite(deps, markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(deps, shipSym, ship, markets, site);
  registerColony(deps, shipSym, ship);
  ensurePerShip(deps, shipSym);
  deps.state.perShip[shipSym]!.last = `MINE @ ${site.slice(-3)}`;
  const sink = deps.state.mining.funnelSym && deps.state.mining.funnelSym !== shipSym ? deps.state.mining.funnelSym : deps.state.mining.refinerSym;
  if (sink && sink !== shipSym) {
    let moved = false;
    for (const g of MINE_KEEP) {
      const u = cargoUnits(ship, g);
      // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
      if (u > 0) { try { await deps.actions.transfer(shipSym, sink, g, u); moved = true; } catch {} }
    }
    if (moved) return true;
  }
  if (ship.cargo.capacity - ship.cargo.units <= 0) {
    for (const it of ship.cargo.inventory) if (!MINE_KEEP.has(it.symbol)) { await jettison(deps, shipSym, it.symbol, it.units); return true; }
    return true;
  }
  const survey = bestSiteSurvey(deps, site);
  const ex = await extractOnce(deps, shipSym, survey);
  const y = ex?.extraction?.yield;
  if (y) {
    logMine(deps, 'extract', shipSym, { role: 'DRONE', ast: site, surveyed: !!survey, yield: y.symbol, units: y.units });
    if (y.symbol && y.units && !MINE_KEEP.has(y.symbol)) await jettison(deps, shipSym, y.symbol, y.units);
  }
  return true;
}

async function surveyorTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  await loadAsteroids(deps);
  const site = colonySite(deps, markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(deps, shipSym, ship, markets, site);
  registerColony(deps, shipSym, ship);
  ensurePerShip(deps, shipSym);
  deps.state.perShip[shipSym]!.last = `SURVEY @ ${site.slice(-3)}`;
  const sd = await surveyOnce(deps, shipSym);
  if (sd?.cooldown?.remainingSeconds) await sleep((sd.cooldown.remainingSeconds + 1) * 1000);
  else if (!sd) await sleep(IDLE_WAIT_MS);
  return true;
}

async function funnelTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  await loadAsteroids(deps);
  const site = colonySite(deps, markets, ship.nav.waypointSymbol);
  if (!site) return false;
  ship = await goToColonySite(deps, shipSym, ship, markets, site);
  registerColony(deps, shipSym, ship);
  deps.state.mining.funnelSym = shipSym;
  ensurePerShip(deps, shipSym);
  deps.state.perShip[shipSym]!.last = `FUNNEL @ ${site.slice(-3)} (${ship.cargo.units}/${ship.cargo.capacity})`;
  deps.state.perShip[shipSym]!.projected = 0;
  await sleep(IDLE_WAIT_MS);
  return true;
}

async function transportTrip(deps: SubsystemDeps, shipSym: string, ship: Ship, markets: Record<string, Market>): Promise<boolean> {
  await loadAsteroids(deps);
  const producerWp = deps.cfg.MINE_PRODUCER || findProducerWp(markets, 'FAB_MATS');
  const site = deps.state.mining.site;
  if (!producerWp || !site) return false;
  const carryFeed = FEED_GOODS.reduce<number>((a, m) => a + cargoUnits(ship, m), 0);
  const carryRaw = deps.cfg.MINE_RAW_RELIEF ? RAW_ORE.reduce<number>((a, m) => a + cargoUnits(ship, m), 0) : 0;
  if (carryFeed > 0 || carryRaw > 0) {
    if (carryFeed > 0) {
      await deps.goTo(shipSym, producerWp, markets);
      let got = 0;
      for (const m of FEED_GOODS) {
        const u = cargoUnits(await deps.actions.getShip(shipSym), m);
        if (u > 0) { try { const rs = await deps.actions.sell(shipSym, m); got += rs.got || 0; } catch {} }
      }
      if (got) { await deps.record(shipSym, got, 'MINE-FERRY feed'); logMine(deps, 'feed', shipSym, { via: 'ferry', revenue: got, producer: producerWp }); }
      await deps.actions.refuel(shipSym);
      const fuelHave = cargoUnits(await deps.actions.getShip(shipSym), 'FUEL');
      if (fuelHave < deps.cfg.MINE_FUEL_RESERVE) { try { await deps.actions.buy(shipSym, 'FUEL', deps.cfg.MINE_FUEL_RESERVE - fuelHave); } catch {} }
    }
    if (deps.cfg.MINE_RAW_RELIEF) {
      for (const m of RAW_ORE) {
        const u = cargoUnits(await deps.actions.getShip(shipSym), m);
        if (u <= 0) continue;
        const sink = bestSink(markets, m);
        if (!sink || !(sink.px > 0)) { await jettison(deps, shipSym, m, u); continue; }
        await deps.goTo(shipSym, sink.wp, markets);
        try { const rs = await deps.actions.sell(shipSym, m); if (rs.got) await deps.record(shipSym, rs.got, `MINE-ORE ${m}→${sink.wp.slice(-3)}`); } catch {}
      }
      await deps.actions.refuel(shipSym);
    }
    return true;
  }
  const legBack = deps.D(site, producerWp);
  const roundTrip = deps.D(ship.nav.waypointSymbol, site) + legBack;
  if (ship.nav.waypointSymbol !== site && ship.fuel.current < roundTrip + 40) {
    await deps.goTo(shipSym, producerWp, markets);
    await deps.actions.refuel(shipSym);
    const fuelHave = cargoUnits(await deps.actions.getShip(shipSym), 'FUEL');
    if (fuelHave < deps.cfg.MINE_FUEL_RESERVE) { try { await deps.actions.buy(shipSym, 'FUEL', deps.cfg.MINE_FUEL_RESERVE - fuelHave); } catch {} }
  }
  await deps.goTo(shipSym, site, markets);
  for (const [sym, unknownInfo] of Object.entries(deps.state.mining.colonyShips)) {
    const info = unknownInfo as { wp?: string; fuel?: number; cap?: number };
    // [RULE: co-location] only tender fuel colony hulls registered at this exact rock.
    if (sym === shipSym || info.wp !== site || (info.fuel ?? 0) >= (info.cap ?? 0) * 0.5) continue;
    const have = cargoUnits(await deps.actions.getShip(shipSym), 'FUEL');
    const give = Math.min(Math.ceil(((info.cap ?? 0) - (info.fuel ?? 0)) / 100), have);
    // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
    if (give > 0) { try { await deps.actions.transfer(shipSym, sym, 'FUEL', give); await refuelFromCargo(deps, sym); } catch {} }
  }
  const source = deps.state.mining.funnelSym && deps.state.mining.funnelSym !== shipSym ? deps.state.mining.funnelSym : deps.state.mining.refinerSym;
  let moved = 0;
  if (source && source !== shipSym) {
    for (const m of FEED_GOODS) {
      const u = cargoUnits(await deps.actions.getShip(source), m);
      const free = ship.cargo.capacity - (await deps.actions.getShip(shipSym)).cargo.units;
      const take = Math.min(u, free);
      // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
      if (take > 0) { try { await deps.actions.transfer(source, shipSym, m, take); moved += take; } catch {} }
    }
    const funnelLoad = (await deps.actions.getShip(source)).cargo.units;
    if (deps.cfg.MINE_RAW_RELIEF && funnelLoad >= deps.cfg.MINE_CLOG_AT) {
      for (const m of RAW_ORE) {
        const inSrc = cargoUnits(await deps.actions.getShip(source), m);
        const free = ship.cargo.capacity - (await deps.actions.getShip(shipSym)).cargo.units;
        const take = shouldRelieveRawOre({ rawUnits: inSrc, funnelLoad, freeCapacity: free, ore: m, refineTarget: deps.state.mining.refineTarget, clogAt: deps.cfg.MINE_CLOG_AT, oreReserve: deps.cfg.MINE_ORE_RESERVE, rawRelief: deps.cfg.MINE_RAW_RELIEF });
        // [RULE: transfer-argorder] transfer(fromSym,toSym,symbol,units)
        if (take > 0) { try { await deps.actions.transfer(source, shipSym, m, take); moved += take; } catch {} }
      }
    }
  }
  ship = await deps.actions.getShip(shipSym);
  if (ship.fuel.current < legBack + 40) await refuelFromCargo(deps, shipSym);
  if (moved > 0) return true;
  ensurePerShip(deps, shipSym);
  deps.state.perShip[shipSym]!.last = `FERRY wait @ ${site.slice(-3)} (no feed yet)`;
  await sleep(IDLE_WAIT_MS);
  return true;
}

export function createMiningHooks(deps: SubsystemDeps): MiningHooks {
  if (deps.cfg.MINE_FEED && !deps.state.mining.tenderSym && deps.cfg.MINE_TRANSPORT.length === 0) {
    deps.client.getAllShips().then((all) => { deps.state.mining.tenderSym = pickMineTender(all); }).catch(() => {});
  }
  const isColonyHull = (ship: Ship): boolean => deps.cfg.MINE_FEED && !deps.state.gateCache.built && !!mineRoleOf(ship, mineCfg(deps));
  return {
    isColonyHull,
    mining: async (shipSym, ship, markets) => {
      if (!deps.cfg.MINE_FEED || deps.state.gateCache.built) return false;
      const role = mineRoleOf(ship, mineCfg(deps));
      if (role) {
        let did = false;
        try {
          if (role === 'REFINER') did = await refinerTrip(deps, shipSym, ship, markets);
          else if (role === 'DRONE') did = await droneTrip(deps, shipSym, ship, markets);
          else if (role === 'SURVEYOR') did = await surveyorTrip(deps, shipSym, ship, markets);
          else if (role === 'FUNNEL') did = await funnelTrip(deps, shipSym, ship, markets);
          else if (role === 'TRANSPORT') did = await transportTrip(deps, shipSym, ship, markets);
        } catch {
          // [RULE: isolate-ship] one mining hull's error must NEVER crash the fleet — log, idle, retry next loop.
          await sleep(IDLE_WAIT_MS);
          return true;
        }
        if (did) return true;
        ensurePerShip(deps, shipSym);
        deps.state.perShip[shipSym]!.last = `PARKED (${role}, idle)`;
        deps.state.perShip[shipSym]!.projected = 0;
        await sleep(IDLE_WAIT_MS);
        return true;
      }
      if (pinned(shipSym, deps.cfg.MINE_FEEDERS) && !mineRoleOf(ship, mineCfg(deps))) {
        if (await mineFeedTrip(deps, shipSym, ship, markets)) return true;
        ensurePerShip(deps, shipSym);
        deps.state.perShip[shipSym]!.last = 'PARKED (mine feeder, nothing minable now)';
        deps.state.perShip[shipSym]!.projected = 0;
        await sleep(IDLE_WAIT_MS);
        return true;
      }
      return false;
    },
  };
}
