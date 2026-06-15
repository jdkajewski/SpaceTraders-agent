import { describe, expect, it } from 'vitest';
import type { Config, Market, Ship } from '@st/shared';
import { loadConfig } from '@st/shared';
import { createState, type BotState } from '../../runtime/state.js';
import type { Router } from '../../interfaces.js';
import { makeShip } from '../../__tests__/fixtures.js';
import {
  applyContractElection,
  contractHomeDeliverable,
  contractWorthIt,
  electContractOwner,
  updateContractAutoForce,
  type ContractInfo,
} from '../contracts.js';

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ SYSTEM: 'X1-AA1' }), ...overrides };
}

const router: Router = {
  chooseMode: () => ({ mode: 'CRUISE', fuel: 0, time: 0 }),
  planRoute: () => null,
  planRouteFuelCargo: () => null,
  routeCost: () => ({ fuelCr: 0, timeS: 0 }),
};

function dist(a: string, b: string): number {
  const coords: Record<string, number> = {
    'X1-AA1-A': 0,
    'X1-AA1-B': 30,
    'X1-AA1-C': 50,
    'X1-AA1-D': 70,
    'X1-AA1-E': 100,
    'X1-AA1-SRC': 0,
    'X1-AA1-DST': 200,
    'X1-BB2-DST': 200,
  };
  return Math.abs((coords[a] ?? 0) - (coords[b] ?? 0));
}

function market(px = 10): Record<string, Market> {
  return {
    'X1-AA1-SRC': {
      symbol: 'X1-AA1-SRC',
      tradeGoods: [{ symbol: 'ORE', type: 'EXPORT', tradeVolume: 40, supply: 'ABUNDANT', purchasePrice: px, sellPrice: 1 }],
    },
    'X1-AA1-DST': {
      symbol: 'X1-AA1-DST',
      tradeGoods: [{ symbol: 'ORE', type: 'IMPORT', tradeVolume: 40, supply: 'LIMITED', purchasePrice: 100, sellPrice: 100 }],
    },
  };
}

function ship(symbol: string, waypointSymbol: string, patch: Partial<Ship> = {}): Ship {
  return makeShip({
    symbol,
    nav: { ...makeShip().nav, systemSymbol: 'X1-AA1', waypointSymbol },
    cargo: { capacity: 80, units: 0, inventory: [] },
    ...patch,
  });
}

function deps(state: BotState, c = cfg()) {
  return { state, cfg: c, router, D: dist };
}

const ci: ContractInfo = { id: 'ctr-1', good: 'ORE', dest: 'X1-AA1-DST', units: 40, pay: 5_000 };

describe('contracts helpers', () => {
  it('electContractOwner does not churn when challenger is within CONTRACT_REELECT_MARGIN', () => {
    const c = cfg({ CONTRACT_REELECT_MARGIN: 40 });
    const state = createState(c);
    state.contractOwner = { id: ci.id, ship: 'OWNER' };
    const ships = [ship('OWNER', 'X1-AA1-E'), ship('CHALLENGER', 'X1-AA1-D')];

    const switched = applyContractElection(ci, market(), ships, deps(state, c));

    expect(switched).toBeNull();
    expect(state.contractOwner).toEqual({ id: ci.id, ship: 'OWNER' });
  });

  it('electContractOwner switches owner when challenger beats incumbent beyond the margin', () => {
    const c = cfg({ CONTRACT_REELECT_MARGIN: 40 });
    const state = createState(c);
    state.contractOwner = { id: ci.id, ship: 'OWNER' };
    const ships = [ship('OWNER', 'X1-AA1-E'), ship('CHALLENGER', 'X1-AA1-C')];

    const switched = applyContractElection(ci, market(), ships, deps(state, c));

    expect(switched?.ship).toBe('CHALLENGER');
    expect(state.contractOwner).toEqual({ id: ci.id, ship: 'CHALLENGER' });
  });

  it('electContractOwner never re-elects away from a carrier holding the contract good', () => {
    const c = cfg({ CONTRACT_REELECT_MARGIN: 40 });
    const state = createState(c);
    state.contractOwner = { id: ci.id, ship: 'OWNER' };
    const owner = ship('OWNER', 'X1-AA1-E', { cargo: { capacity: 80, units: 10, inventory: [{ symbol: 'ORE', units: 10 }] } });
    const challenger = ship('CHALLENGER', 'X1-AA1-B');

    const switched = applyContractElection(ci, market(), [owner, challenger], deps(state, c));

    expect(switched).toBeNull();
    expect(state.contractOwner).toEqual({ id: ci.id, ship: 'OWNER' });
  });

  it('auto-force fires after the grace window and not before', () => {
    const c = cfg({ CONTRACT_AUTOFORCE_MINS: 20 });
    const state = createState(c);
    const d = deps(state, c);

    expect(updateContractAutoForce(ci, d, 1_000)).toBe(false);
    expect(updateContractAutoForce(ci, d, 1_000 + 19 * 60_000)).toBe(false);
    expect(state.contractAutoForced.has(ci.id)).toBe(false);
    expect(updateContractAutoForce(ci, d, 1_000 + 20 * 60_000)).toBe(true);
    expect(state.contractAutoForced.has(ci.id)).toBe(true);
  });

  it('margin gate skips thin contracts unless forced', () => {
    const c = cfg({ CONTRACT_MIN_MARGIN: 1_000, CONTRACT_MIN_MARGIN_PCT: 0.04, CONTRACT_FORCE: [] });
    const state = createState(c);
    const thin: ContractInfo = { ...ci, pay: 1_500 };
    const s = ship('RUNNER', 'X1-AA1-SRC');

    expect(contractWorthIt(s, thin, market(20), deps(state, c))).toBeNull();

    const forced = cfg({ CONTRACT_MIN_MARGIN: 1_000, CONTRACT_MIN_MARGIN_PCT: 0.04, CONTRACT_FORCE: ['ORE'] });
    expect(contractWorthIt(s, thin, market(20), deps(createState(forced), forced))?.src.wp).toBe('X1-AA1-SRC');
  });

  it('contractHomeDeliverable skips cross-system contracts', () => {
    const c = cfg();
    const state = createState(c);
    const cross = { ...ci, dest: 'X1-BB2-DST' };

    expect(contractHomeDeliverable(cross, c)).toBe(false);
    expect(electContractOwner(cross, market(), [ship('RUNNER', 'X1-AA1-A')], deps(state, c))).toBeNull();
  });
});
