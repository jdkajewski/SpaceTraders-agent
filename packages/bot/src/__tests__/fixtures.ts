import type { Ship } from '@st/shared';

/** Minimal Ship fixture; override any nested slice via `patch`. */
export function makeShip(patch: Partial<Ship> = {}): Ship {
  const base: Ship = {
    symbol: 'SHIP-1',
    nav: {
      systemSymbol: 'X1-PP30',
      waypointSymbol: 'X1-PP30-A1',
      status: 'IN_ORBIT',
      flightMode: 'CRUISE',
      route: {
        origin: { symbol: 'X1-PP30-A1', x: 0, y: 0 },
        destination: { symbol: 'X1-PP30-A1', x: 0, y: 0 },
        departureTime: '2024-01-01T00:00:00.000Z',
        arrival: '2024-01-01T00:00:00.000Z',
      },
    },
    cargo: { capacity: 40, units: 0, inventory: [] },
    engine: { speed: 15, condition: 1 },
    frame: { condition: 1, integrity: 1 },
    fuel: { current: 400, capacity: 400 },
    mounts: [],
  };
  return { ...base, ...patch };
}

/** A Response-like object for the injected fetch in client tests. */
export function makeRes(status: number, jsonBody: unknown): Response {
  const text = JSON.stringify(jsonBody);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    text: async () => text,
  } as unknown as Response;
}
