import { describe, it, expect } from 'vitest';
import { createLaneRegistry } from '../laneRegistry.js';
import type { TradeObservation } from '@st/shared';

function obs(p: Partial<TradeObservation>): TradeObservation {
  return {
    ts: p.ts ?? '2026-01-01T00:00:00.000Z',
    ship: p.ship ?? 'S1',
    good: p.good ?? 'IRON',
    buyWp: p.buyWp ?? 'A',
    sellWp: p.sellWp ?? 'B',
    projected: p.projected ?? 0,
    realized: p.realized ?? 0,
    units: p.units ?? 10,
    buyPx: p.buyPx ?? 0,
    sellPx: p.sellPx ?? 0,
  };
}

const t0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('laneRegistry: ingest + EWMA', () => {
  it('seeds a lane on first observation, then EWMA-smooths realized net', () => {
    const reg = createLaneRegistry({ alpha: 0.5, halfLifeMs: 60_000 });
    reg.ingest(obs({ realized: 1000 }));
    expect(reg.lanes()[0]!.ewmaNet).toBe(1000);
    reg.ingest(obs({ realized: 0 })); // ema = 1000*0.5 + 0*0.5 = 500
    expect(reg.lanes()[0]!.ewmaNet).toBe(500);
    expect(reg.lanes()[0]!.trips).toBe(2);
  });

  it('keys lanes by (src, good, sink) — different endpoints are distinct lanes', () => {
    const reg = createLaneRegistry({ alpha: 0.5, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: 'A', sellWp: 'B', realized: 500 }));
    reg.ingest(obs({ buyWp: 'A', sellWp: 'C', realized: 900 }));
    expect(reg.lanes()).toHaveLength(2);
  });

  it('ignores malformed rows (missing endpoints)', () => {
    const reg = createLaneRegistry({ alpha: 0.5, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: '', realized: 1000 }));
    expect(reg.lanes()).toHaveLength(0);
  });
});

describe('laneRegistry: topLanes (decayed ranking)', () => {
  it('ranks lanes by decayed value descending, excluding non-positive', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: 'A', sellWp: 'B', good: 'IRON', realized: 1000 }));
    reg.ingest(obs({ buyWp: 'C', sellWp: 'D', good: 'GOLD', realized: 3000 }));
    reg.ingest(obs({ buyWp: 'E', sellWp: 'F', good: 'COAL', realized: -50 }));
    const top = reg.topLanes(10, t0);
    expect(top.map((l) => l.good)).toEqual(['GOLD', 'IRON']); // COAL excluded (value <= 0)
    expect(top[0]!.value).toBe(3000);
  });

  it('applies half-life staleness decay at query time', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    reg.ingest(obs({ realized: 800 }));
    // one half-life later → value halves
    expect(reg.topLanes(1, t0 + 60_000)[0]!.value).toBeCloseTo(400, 6);
    // two half-lives → quarter
    expect(reg.topLanes(1, t0 + 120_000)[0]!.value).toBeCloseTo(200, 6);
  });

  it('honours the K limit', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    for (let i = 0; i < 5; i++) reg.ingest(obs({ buyWp: `A${i}`, sellWp: `B${i}`, realized: 100 + i }));
    expect(reg.topLanes(2, t0)).toHaveLength(2);
  });
});

describe('laneRegistry: marketRealizedValue (endpoint attribution)', () => {
  it('credits both src and sink with the decayed lane value', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: 'A', sellWp: 'B', realized: 1000 }));
    const v = reg.marketRealizedValue(t0);
    expect(v.get('A')).toBe(1000);
    expect(v.get('B')).toBe(1000);
  });

  it('sums value across multiple lanes sharing an endpoint', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: 'A', sellWp: 'B', good: 'IRON', realized: 1000 }));
    reg.ingest(obs({ buyWp: 'A', sellWp: 'C', good: 'GOLD', realized: 500 }));
    const v = reg.marketRealizedValue(t0);
    expect(v.get('A')).toBe(1500); // endpoint of both lanes
    expect(v.get('B')).toBe(1000);
    expect(v.get('C')).toBe(500);
  });

  it('drops money-losing lanes from attribution', () => {
    const reg = createLaneRegistry({ alpha: 1, halfLifeMs: 60_000 });
    reg.ingest(obs({ buyWp: 'A', sellWp: 'B', realized: -200 }));
    expect(reg.marketRealizedValue(t0).size).toBe(0);
  });
});
