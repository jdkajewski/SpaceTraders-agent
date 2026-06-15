import { describe, it, expect, vi } from 'vitest';
import { createShipActions } from '../trade/shipActions.js';
import type { ApiEnvelope, SpaceTradersClient } from '../interfaces.js';
import type { Ship } from '@st/shared';

type NavOutcome = 'arrived' | 'nofuel' | 'ok';

/**
 * Stateful mock SpaceTraders client for navigate() flow tests. Tracks dock/orbit
 * status + flight mode; `/navigate` POSTs are driven by a scripted outcome list.
 */
function mockClient(navScript: NavOutcome[]) {
  const state = { status: 'IN_ORBIT' as Ship['nav']['status'], flightMode: 'CRUISE' as Ship['nav']['flightMode'], wp: 'X1-PP30-A1' };
  let navIdx = 0;

  function shipEnvelope(): ApiEnvelope<Ship> {
    return {
      data: {
        symbol: 'SHIP-1',
        nav: {
          systemSymbol: 'X1-PP30',
          waypointSymbol: state.wp,
          status: state.status,
          flightMode: state.flightMode,
          route: {
            origin: { symbol: state.wp, x: 0, y: 0 },
            destination: { symbol: 'X1-PP30-B1', x: 0, y: 0 },
            departureTime: '2024-01-01T00:00:00.000Z',
            arrival: '2024-01-01T00:00:00.000Z',
          },
        },
        cargo: { capacity: 40, units: 0, inventory: [] },
        engine: { speed: 15, condition: 1 },
        frame: { condition: 1, integrity: 1 },
        fuel: { current: 400, capacity: 400 },
        mounts: [],
      },
    };
  }

  const api = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (method === 'GET' && path.includes('/my/ships/')) return shipEnvelope();
    if (method === 'POST' && path.endsWith('/dock')) {
      state.status = 'DOCKED';
      return { data: {} };
    }
    if (method === 'POST' && path.endsWith('/orbit')) {
      state.status = 'IN_ORBIT';
      return { data: {} };
    }
    if (method === 'POST' && path.endsWith('/refuel')) {
      return { data: { fuel: { current: 400, capacity: 400 } } };
    }
    if (method === 'PATCH' && path.endsWith('/nav')) {
      state.flightMode = (body as { flightMode: Ship['nav']['flightMode'] }).flightMode;
      return { data: {} };
    }
    if (method === 'POST' && path.endsWith('/navigate')) {
      const outcome = navScript[navIdx++];
      if (outcome === 'arrived') throw new Error('Ship is currently located at the destination.');
      if (outcome === 'nofuel') throw new Error('Navigate failed. Ship requires 50 more fuel for navigation.');
      return { data: { fuel: { current: 399 }, nav: { route: { arrival: '2024-01-01T00:00:00.000Z' } } } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  return { client: { api } as unknown as SpaceTradersClient, api, state };
}

const navCalls = (api: ReturnType<typeof mockClient>['api']): number =>
  api.mock.calls.filter((c) => c[0] === 'POST' && String(c[1]).endsWith('/navigate')).length;

describe('shipActions: navigate', () => {
  it('[RULE: idempotent-nav] treats a "located at the destination" 400 as success', async () => {
    const { client, api } = mockClient(['arrived']);
    const actions = createShipActions(client);

    const ship = await actions.navigate('SHIP-1', 'X1-PP30-B1', 'CRUISE');

    expect(ship.symbol).toBe('SHIP-1');
    expect(navCalls(api)).toBe(1); // did not retry — handled as already-there
  });

  it('downgrades BURN→CRUISE→DRIFT on insufficient-fuel and then succeeds', async () => {
    const { client, api, state } = mockClient(['nofuel', 'ok']);
    const actions = createShipActions(client);

    await actions.navigate('SHIP-1', 'X1-PP30-B1', 'CRUISE');

    expect(navCalls(api)).toBe(2); // CRUISE failed for fuel → retried in DRIFT
    expect(state.flightMode).toBe('DRIFT'); // downgraded to the next rung
  });

  it('returns immediately when already at the destination', async () => {
    const { client, api } = mockClient([]);
    // ship starts at A1; navigate to A1 → no-op
    const actions = createShipActions(client);
    const ship = await actions.navigate('SHIP-1', 'X1-PP30-A1', 'CRUISE');
    expect(ship.nav.waypointSymbol).toBe('X1-PP30-A1');
    expect(navCalls(api)).toBe(0);
  });
});
