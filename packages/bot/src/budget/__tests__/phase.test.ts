import { describe, it, expect } from 'vitest';
import { loadConfig, type Config, type GateLevers, type Market } from '@st/shared';
import { createState } from '../../runtime/state.js';
import { determinePhase, gateSupplyActive, gateCreditOk, reloadGateLevers, PHASES } from '../phase.js';
import type { PersistenceClient } from '../../interfaces.js';

const cfg: Config = loadConfig({});
const someMarkets: Record<string, Market> = { 'X1-A1': { symbol: 'X1-A1', tradeGoods: [] } };

function readyState(over: Partial<Config> = {}) {
  const c = { ...cfg, ...over } as Config;
  const s = createState(c, { marketsRef: () => someMarkets });
  s.fleetSize = 5; // ≥ BOOTSTRAP_FLEET_MIN
  return { c, s };
}

describe('phase: determinePhase truth table', () => {
  it('BOOTSTRAP when markets unknown', () => {
    const s = createState(cfg, { marketsRef: () => ({}) });
    s.fleetSize = 5;
    expect(determinePhase(s, cfg).name).toBe('BOOTSTRAP');
  });

  it('BOOTSTRAP when fleet below BOOTSTRAP_FLEET_MIN', () => {
    const { c, s } = readyState();
    s.fleetSize = 1;
    expect(determinePhase(s, c).name).toBe('BOOTSTRAP');
  });

  it('PROFIT when markets known, fleet built, no gate', () => {
    const { c, s } = readyState();
    expect(determinePhase(s, c).name).toBe('PROFIT');
  });

  it('PORTAL_OPEN when gate known + exists + built', () => {
    const { c, s } = readyState();
    s.gateCache = { exists: true, wp: 'G', built: true, remaining: {}, known: true };
    expect(determinePhase(s, c).name).toBe('PORTAL_OPEN');
  });

  it('GATE_SUPPLY when supply active (INPUT_FEED off)', () => {
    const { c, s } = readyState({ GATE_SUPPLY: true, INPUT_FEED: false });
    s.gateCache = { exists: true, wp: 'G', built: false, remaining: { FAB_MATS: 10 }, known: true };
    expect(gateSupplyActive(s, c)).toBe(true);
    expect(determinePhase(s, c).name).toBe('GATE_SUPPLY');
  });

  it('INPUT_FEED when supply active and INPUT_FEED on', () => {
    const { c, s } = readyState({ GATE_SUPPLY: true, INPUT_FEED: true });
    s.gateCache = { exists: true, wp: 'G', built: false, remaining: { FAB_MATS: 10 }, known: true };
    expect(determinePhase(s, c).name).toBe('INPUT_FEED');
  });

  it('GATE_DISCOVERY when gate exists+unbuilt but supply disabled', () => {
    const { c, s } = readyState({ GATE_SUPPLY: false });
    s.gateCache = { exists: true, wp: 'G', built: false, remaining: { FAB_MATS: 10 }, known: true };
    expect(determinePhase(s, c).name).toBe('GATE_DISCOVERY');
  });
});

describe('phase: gateCreditOk hysteresis latch (no sawtooth in band)', () => {
  it('pauses below floor, holds in the deadband, resumes only past resume', () => {
    const { s } = readyState();
    s.gateLevers = { floor: 1_500_000, resume: 1_750_000 };

    s.cachedCredits = 1_400_000; // below floor → hard stop
    expect(gateCreditOk(s)).toBe(false);
    expect(s.gateBuyPaused).toBe(true);

    s.cachedCredits = 1_600_000; // in the deadband → holds paused (no premature resume)
    expect(gateCreditOk(s)).toBe(false);

    s.cachedCredits = 1_800_000; // past resume → release
    expect(gateCreditOk(s)).toBe(true);
    expect(s.gateBuyPaused).toBe(false);

    s.cachedCredits = 1_600_000; // back in the deadband → holds released (no sawtooth)
    expect(gateCreditOk(s)).toBe(true);

    s.cachedCredits = 1_499_999; // below floor again → re-arm
    expect(gateCreditOk(s)).toBe(false);
  });
});

describe('phase: reloadGateLevers polls GET /gate-levers and keeps a deadband', () => {
  function persistenceReturning(levers: GateLevers | null): PersistenceClient {
    return { getGateLevers: async () => levers } as unknown as PersistenceClient;
  }

  it('accepts { floor, gap } → resume = floor + gap', async () => {
    const { c, s } = readyState();
    await reloadGateLevers(s, c, persistenceReturning({ floor: 2_000_000, gap: 300_000 } as unknown as GateLevers));
    expect(s.gateLevers.floor).toBe(2_000_000);
    expect(s.gateLevers.resume).toBe(2_300_000);
  });

  it('forces a real deadband when resume <= floor', async () => {
    const { c, s } = readyState();
    await reloadGateLevers(s, c, persistenceReturning({ floor: 2_000_000, resume: 1_900_000, gap: 0 }));
    expect(s.gateLevers.resume).toBe(2_000_000 + c.GATE_CREDIT_RESUME_GAP);
  });

  it('keeps current values when the fetch returns null', async () => {
    const { c, s } = readyState();
    const before = { ...s.gateLevers };
    await reloadGateLevers(s, c, persistenceReturning(null));
    expect(s.gateLevers).toEqual(before);
  });
});

describe('phase: PHASES table is progression-ordered', () => {
  it('numbers ascend BOOTSTRAP→PORTAL_OPEN', () => {
    expect(PHASES.BOOTSTRAP.n).toBeLessThan(PHASES.PROFIT.n);
    expect(PHASES.PORTAL_OPEN.n).toBe(5);
  });
});
