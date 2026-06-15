import { describe, it, expect } from 'vitest';
import { partitionMarkets, sysOf } from '../expansion/partition.js';

/**
 * `partitionMarkets` is the OUTPROBE 1:1 coverage arc math ported from expansion.mjs.
 * These pins guarantee the documented properties for `n ≤ L` (disjoint, balanced,
 * full-coverage, converges 1:1 at n==L) and document the `n > L` overlap quirk (DRIFT #29).
 */
describe('partitionMarkets', () => {
  const wps = (n: number): string[] => Array.from({ length: n }, (_, i) => `X1-PP30-M${i}`);

  it('full coverage + disjoint + balanced for n ≤ L (n=3, L=10)', () => {
    const L = 10;
    const n = 3;
    const market = wps(L);
    const arcs = Array.from({ length: n }, (_, idx) => partitionMarkets(market, idx, n));

    // disjoint: no market appears in two arcs
    const seen = new Set<string>();
    for (const arc of arcs) for (const w of arc) {
      expect(seen.has(w)).toBe(false);
      seen.add(w);
    }
    // full coverage: every market is owned by exactly one arc, in order
    expect(arcs.flat()).toEqual(market);
    // balanced: arc sizes differ by at most 1
    const sizes = arcs.map((a) => a.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('converges to exactly one market each when n == L', () => {
    const L = 6;
    const market = wps(L);
    const arcs = Array.from({ length: L }, (_, idx) => partitionMarkets(market, idx, L));
    expect(arcs.every((a) => a.length === 1)).toBe(true);
    expect(arcs.flat()).toEqual(market); // each owns its own market, in order
  });

  it('produces contiguous arcs that tile the list (n=4, L=9)', () => {
    const L = 9;
    const n = 4;
    const market = wps(L);
    const arcs = Array.from({ length: n }, (_, idx) => partitionMarkets(market, idx, n));
    // contiguity: each arc is a slice of the original (indices increase by 1 within an arc)
    for (const arc of arcs) {
      const idxs = arc.map((w) => market.indexOf(w));
      for (let i = 1; i < idxs.length; i++) expect(idxs[i]).toBe(idxs[i - 1]! + 1);
    }
    // the arcs join end-to-end with no gap
    expect(arcs.flat()).toEqual(market);
  });

  it('QUIRK (DRIFT #29): n > L forces ≥1 market per probe → trailing probes overlap the last market', () => {
    const L = 2;
    const n = 4; // more probes than markets
    const market = wps(L);
    const arcs = Array.from({ length: n }, (_, idx) => partitionMarkets(market, idx, n));
    // every probe still gets a non-empty arc (the `lo+1` guarantee)
    expect(arcs.every((a) => a.length >= 1)).toBe(true);
    // and the last market is shared by more than one probe (overlap, not disjoint)
    const last = market[L - 1]!;
    const owners = arcs.filter((a) => a.includes(last)).length;
    expect(owners).toBeGreaterThan(1);
  });
});

describe('sysOf', () => {
  it('extracts the system symbol from a waypoint symbol', () => {
    expect(sysOf('X1-PP30-D18A')).toBe('X1-PP30');
    expect(sysOf('X1-PP48-B7')).toBe('X1-PP48');
  });
});
