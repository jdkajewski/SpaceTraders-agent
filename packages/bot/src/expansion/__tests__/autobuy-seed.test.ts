import { describe, it, expect } from 'vitest';
import { loadConfig, type Ship, type GalaxyGraph, type RankedSystem } from '@st/shared';
import { createExpansion, type ExpansionCtx } from '../expansion.js';
import type { GalaxyProvider } from '../../galaxy/provider.js';

/**
 * Pins the FUELED-ENTRY autobuy seed ported from the legacy expansion.mjs (priority-0 autobuy,
 * L1283-1308) plus the BACKWARD-PATH local-buy preference (L1327: `op.path.slice(0,-1).reverse()`).
 *
 * The seed is closure-internal to `createExpansion`, so we drive it through the public surface:
 *   maybeTrigger() #1 → galaxy trigger + setupOutposts (zero-presence deep outpost)
 *   maybeTrigger() #2 → autoBuy() → entry-seed buy
 * and assert on the captured `buyShip(type, wp)` call.
 */

const HOME = 'X1-HOME';
const MID = 'X1-MID';
const DEEP = 'X1-DEEP';
const NOW = 1_000_000_000;

interface YardFix {
  /** system → SHIPYARD waypoint symbols */
  shipyardWps: Record<string, string[]>;
  /** shipyard waypoint → ships it sells */
  yardSells: Record<string, Array<{ type: string; purchasePrice?: number }>>;
}

function makeShip(
  symbol: string,
  sys: string,
  wp: string,
  opts: { frame?: string; mounts?: string[]; cargo?: number; fuelCap?: number } = {},
): Ship {
  return {
    symbol,
    nav: {
      systemSymbol: sys,
      waypointSymbol: wp,
      status: 'IN_ORBIT',
      flightMode: 'CRUISE',
      route: { origin: { symbol: wp, x: 0, y: 0 }, destination: { symbol: wp, x: 0, y: 0 }, departureTime: '', arrival: '' },
    },
    cargo: { capacity: opts.cargo ?? 0, units: 0, inventory: [] },
    engine: { speed: 30, condition: 1 },
    frame: { symbol: opts.frame ?? 'FRAME_DRONE', condition: 1, integrity: 1 },
    fuel: { current: 100, capacity: opts.fuelCap ?? 100 },
    mounts: (opts.mounts ?? ['MOUNT_MINING_LASER_I']).map((s) => ({ symbol: s })),
  };
}

/** A mining-frame ship: NEVER adopted by setupOutposts (not a probe/trader), only a yard anchor for pickBuy. */
const anchor = (symbol: string, sys: string, wp: string): Ship => makeShip(symbol, sys, wp);

function makeGalaxy(): GalaxyProvider {
  const gateOf: Record<string, string> = { [HOME]: `${HOME}-GATE`, [MID]: `${MID}-GATE`, [DEEP]: `${DEEP}-GATE` };
  const systems = Object.entries(gateOf).map(([symbol, gateWaypoint]) => ({
    symbol,
    x: 0,
    y: 0,
    hasGate: true,
    gateWaypoint,
    gateBuilt: true,
    hopsFromHome: symbol === HOME ? 0 : symbol === MID ? 1 : 2,
    reachable: true,
    isHome: symbol === HOME,
    firstSeenAt: '',
    lastCrawledAt: '',
    richnessRefreshedAt: null,
  }));
  const graph: GalaxyGraph = { systems, edges: [] };
  const ranked: RankedSystem[] = [
    {
      symbol: DEEP,
      score: 10,
      hopsFromHome: 2,
      reachable: true,
      gateWaypoint: `${DEEP}-GATE`,
      marketplaceCount: 3,
      shipyardCount: 1,
      importSiteCount: 0,
      premiumShipTypes: [],
      sellsFueledHull: false,
    },
  ];
  return {
    graph: async () => graph,
    rankedTargets: async () => ranked,
    // home → deep, ordered (matches galaxyRelayStep traversal). Backward = slice(0,-1).reverse() = [MID, HOME].
    gatePath: async (from, to) => (from === HOME && to === DEEP ? [HOME, MID, DEEP] : null),
    shipyardFor: async () => null,
  };
}

function makeCtx(fix: YardFix, ships: Ship[], buys: Array<{ type: string; wp: string }>): ExpansionCtx {
  const cfg = loadConfig({
    SYSTEM: HOME,
    AUTO_EXPAND: '1',
    EXPAND_AUTOBUY: '1',
    EXPAND_CREDIT_FLOOR: '100000', // FLOOR=100k → BUY_FLOOR=max(350k,700k)=700k
  });
  const api = async <T = unknown>(_method: string, path: string): Promise<T> => {
    if (path.includes('traits=SHIPYARD')) {
      const sys = path.split('/systems/')[1]!.split('/')[0]!;
      return { data: (fix.shipyardWps[sys] ?? []).map((symbol) => ({ symbol })) } as T;
    }
    const yardMatch = path.match(/\/waypoints\/([^/]+)\/shipyard$/);
    if (yardMatch) {
      const wp = yardMatch[1]!;
      return { data: { ships: fix.yardSells[wp] ?? [] } } as T;
    }
    // loadSystemInto / loadTargetSystem paging — no markets, no extra waypoints.
    if (path.includes('/waypoints?limit=20&page=')) return { data: [] } as T;
    if (path.endsWith('/market')) return { data: { symbol: 'x' } } as T;
    return { data: [] } as T;
  };
  return {
    cfg,
    api,
    log: () => {},
    sleep: async () => {},
    now: () => NOW,
    navigate: async () => ships[0]!,
    refuel: async () => ships[0]!,
    buy: async () => ({ bought: 0, spent: 0 }),
    sell: async () => ({ got: 0 }),
    jump: async () => ({}),
    getShip: async (sym) => ships.find((s) => s.symbol === sym) ?? ships[0]!,
    getAllShips: async () => ships,
    coords: {},
    D: () => 0,
    chooseMode: () => ({ mode: 'CRUISE', time: 0 }) as never,
    planRoute: () => null,
    record: () => {},
    homeSystem: HOME,
    gateWp: () => `${HOME}-GATE`,
    gateBuilt: () => true,
    getCredits: () => 5_000_000,
    reserve: () => 0,
    homeMarkets: () => ({}),
    fuelPx: () => 1,
    launchWorker: () => {},
    buyShip: async (type, wp) => {
      buys.push({ type, wp });
      return `SHIP-SEED-${buys.length}`;
    },
    negotiator: () => null,
    galaxy: makeGalaxy(),
  };
}

async function runTrigger(ctx: ExpansionCtx): Promise<ReturnType<typeof createExpansion>> {
  const exp = createExpansion(ctx);
  await exp.maybeTrigger(); // trigger + setupOutposts
  await exp.maybeTrigger(); // autoBuy
  return exp;
}

describe('entry-seed autobuy (legacy expansion.mjs priority-0)', () => {
  it('seeds a zero-presence outpost with a SEED_HULL bought at its LOCAL yard', async () => {
    const fix: YardFix = {
      shipyardWps: { [DEEP]: [`${DEEP}-YARD`] },
      yardSells: { [`${DEEP}-YARD`]: [{ type: 'SHIP_LIGHT_SHUTTLE', purchasePrice: 120_000 }] },
    };
    // mining-frame anchor parked at the deep yard so pickBuy has a ship present; never auto-adopted.
    const ships = [anchor('AN-DEEP', DEEP, `${DEEP}-YARD`)];
    const buys: Array<{ type: string; wp: string }> = [];

    const exp = await runTrigger(makeCtx(fix, ships, buys));

    expect(buys).toHaveLength(1);
    expect(buys[0]).toEqual({ type: 'SHIP_LIGHT_SHUTTLE', wp: `${DEEP}-YARD` });
    // the seeded hull is an OUTLIGHT resident of the deep outpost
    const seeded = exp.statusBlock().members as Array<{ role: string; opSys?: string }>;
    expect(seeded.some((m) => m.role === 'OUTLIGHT' && m.opSys === DEEP)).toBe(true);
  });

  it('prefers the NEAREST backward-path yard (MID) over home when the outpost has no local yard', async () => {
    const fix: YardFix = {
      shipyardWps: { [MID]: [`${MID}-YARD`], [HOME]: [`${HOME}-YARD`] }, // DEEP has NO yard
      yardSells: {
        [`${MID}-YARD`]: [{ type: 'SHIP_LIGHT_SHUTTLE', purchasePrice: 150_000 }],
        [`${HOME}-YARD`]: [{ type: 'SHIP_LIGHT_SHUTTLE', purchasePrice: 150_000 }],
      },
    };
    // anchors at BOTH the MID and HOME yards: old code ([target, home]) would buy at HOME; backward path buys at MID.
    const ships = [anchor('AN-MID', MID, `${MID}-YARD`), anchor('AN-HOME', HOME, `${HOME}-YARD`)];
    const buys: Array<{ type: string; wp: string }> = [];

    await runTrigger(makeCtx(fix, ships, buys));

    expect(buys).toHaveLength(1);
    expect(buys[0]).toEqual({ type: 'SHIP_LIGHT_SHUTTLE', wp: `${MID}-YARD` });
  });

  it('does NOT seed an outpost that already has a resident (non-zero presence)', async () => {
    const fix: YardFix = {
      shipyardWps: { [DEEP]: [`${DEEP}-YARD`] },
      yardSells: { [`${DEEP}-YARD`]: [{ type: 'SHIP_LIGHT_SHUTTLE', purchasePrice: 120_000 }] },
    };
    // a real trader already living in DEEP → setupOutposts adopts it as OUTLIGHT → presence > 0.
    const resident = makeShip('RES-DEEP', DEEP, `${DEEP}-MKT`, { frame: 'FRAME_FRIGATE', mounts: [], cargo: 40, fuelCap: 400 });
    const buys: Array<{ type: string; wp: string }> = [];

    await runTrigger(makeCtx(fix, [resident], buys));

    expect(buys).toHaveLength(0);
  });
});
