import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';
import { loadCoordsFromCsv, distance } from '../coords.js';
import { CROSS_SYSTEM_DIST } from '../constants.js';

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  describe('empty env → code defaults', () => {
    const cfg = loadConfig({});

    it('SYSTEM defaults to X1-PP30', () => {
      expect(cfg.SYSTEM).toBe('X1-PP30');
    });

    it('MAXD defaults to 2000', () => {
      expect(cfg.MAXD).toBe(2000);
    });

    it('MIN_NET defaults to 4000', () => {
      expect(cfg.MIN_NET).toBe(4000);
    });

    it('COOLDOWN_MS defaults to 300000', () => {
      expect(cfg.COOLDOWN_MS).toBe(300_000);
    });

    // ── boolean idiom: default ON (!== '0') ─────────────────────────────────

    it('CONTRACTS is ON by default', () => {
      expect(cfg.CONTRACTS).toBe(true);
    });

    it('MULTI_GOOD is ON by default', () => {
      expect(cfg.MULTI_GOOD).toBe(true);
    });

    it('GATE_SUPPLY is ON by default', () => {
      expect(cfg.GATE_SUPPLY).toBe(true);
    });

    it('FILL_BIAS is ON by default', () => {
      expect(cfg.FILL_BIAS).toBe(true);
    });

    it('GATE_PROTECT is ON by default', () => {
      expect(cfg.GATE_PROTECT).toBe(true);
    });

    it('CONTRACT_AVOID_GATE_PRODUCER is ON by default', () => {
      expect(cfg.CONTRACT_AVOID_GATE_PRODUCER).toBe(true);
    });

    it('FEED_RESERVE_INPUTS is ON by default', () => {
      expect(cfg.FEED_RESERVE_INPUTS).toBe(true);
    });

    it('ORPHAN_GATE_DELIVERY is ON by default', () => {
      expect(cfg.ORPHAN_GATE_DELIVERY).toBe(true);
    });

    it('MINE_RAW_RELIEF is ON by default', () => {
      expect(cfg.MINE_RAW_RELIEF).toBe(true);
    });

    it('FLEET_TABLE is ON by default', () => {
      expect(cfg.FLEET_TABLE).toBe(true);
    });

    // ── boolean idiom: default OFF (=== '1') ─────────────────────────────────

    it('TRADE_FIRST is OFF by default', () => {
      expect(cfg.TRADE_FIRST).toBe(false);
    });

    it('FLEET_SCALE is OFF by default', () => {
      expect(cfg.FLEET_SCALE).toBe(false);
    });

    it('INPUT_FEED is OFF by default', () => {
      expect(cfg.INPUT_FEED).toBe(false);
    });

    it('MINE_FEED is OFF by default', () => {
      expect(cfg.MINE_FEED).toBe(false);
    });

    it('REPAIR is OFF by default', () => {
      expect(cfg.REPAIR).toBe(false);
    });

    it('MINE_EXPAND is OFF by default', () => {
      expect(cfg.MINE_EXPAND).toBe(false);
    });

    it('MINE_MIGRATE is OFF by default', () => {
      expect(cfg.MINE_MIGRATE).toBe(false);
    });

    it('FUEL_CARGO is OFF by default', () => {
      expect(cfg.FUEL_CARGO).toBe(false);
    });

    it('AUTO_EXPAND is OFF by default', () => {
      expect(cfg.AUTO_EXPAND).toBe(false);
    });

    it('GATE_FUEL_CARGO is OFF by default', () => {
      expect(cfg.GATE_FUEL_CARGO).toBe(false);
    });

    it('INPUT_FEED_GATE_PAUSE is OFF by default', () => {
      expect(cfg.INPUT_FEED_GATE_PAUSE).toBe(false);
    });
  });

  describe('boolean idiom flipping', () => {
    it('CONTRACTS=0 disables it', () => {
      expect(loadConfig({ CONTRACTS: '0' }).CONTRACTS).toBe(false);
    });

    it('CONTRACTS=1 keeps it on', () => {
      expect(loadConfig({ CONTRACTS: '1' }).CONTRACTS).toBe(true);
    });

    it('TRADE_FIRST=1 enables it', () => {
      expect(loadConfig({ TRADE_FIRST: '1' }).TRADE_FIRST).toBe(true);
    });

    it('TRADE_FIRST=0 keeps it off', () => {
      expect(loadConfig({ TRADE_FIRST: '0' }).TRADE_FIRST).toBe(false);
    });

    it('FLEET_SCALE=1 enables it', () => {
      expect(loadConfig({ FLEET_SCALE: '1' }).FLEET_SCALE).toBe(true);
    });

    it('GATE_SUPPLY=0 disables it', () => {
      expect(loadConfig({ GATE_SUPPLY: '0' }).GATE_SUPPLY).toBe(false);
    });
  });

  // ── INPUT_FEED_MAX hard clamp ≤ 2 ────────────────────────────────────────

  describe('INPUT_FEED_MAX clamp', () => {
    it('defaults to 2', () => {
      expect(loadConfig({}).INPUT_FEED_MAX).toBe(2);
    });

    it('INPUT_FEED_MAX=1 → 1', () => {
      expect(loadConfig({ INPUT_FEED_MAX: '1' }).INPUT_FEED_MAX).toBe(1);
    });

    it('INPUT_FEED_MAX=3 is clamped to 2', () => {
      expect(loadConfig({ INPUT_FEED_MAX: '3' }).INPUT_FEED_MAX).toBe(2);
    });

    it('INPUT_FEED_MAX=10 is clamped to 2', () => {
      expect(loadConfig({ INPUT_FEED_MAX: '10' }).INPUT_FEED_MAX).toBe(2);
    });
  });

  // ── GATE_CREDIT_RESUME derived from FLOOR + GAP ───────────────────────────

  describe('GATE_CREDIT_RESUME derivation', () => {
    it('defaults to GATE_CREDIT_FLOOR + GATE_CREDIT_RESUME_GAP', () => {
      const cfg = loadConfig({});
      expect(cfg.GATE_CREDIT_RESUME).toBe(cfg.GATE_CREDIT_FLOOR + cfg.GATE_CREDIT_RESUME_GAP);
    });

    it('defaults: 1_500_000 + 250_000 = 1_750_000', () => {
      expect(loadConfig({}).GATE_CREDIT_RESUME).toBe(1_750_000);
    });

    it('custom FLOOR + default GAP', () => {
      const cfg = loadConfig({ GATE_CREDIT_FLOOR: '1000000' });
      expect(cfg.GATE_CREDIT_RESUME).toBe(1_000_000 + 250_000);
    });

    it('explicit GATE_CREDIT_RESUME overrides derivation', () => {
      const cfg = loadConfig({ GATE_CREDIT_RESUME: '2000000' });
      expect(cfg.GATE_CREDIT_RESUME).toBe(2_000_000);
    });
  });

  // ── FEED_PRICE_* mirror GATE_PRICE_* ────────────────────────────────────────

  describe('FEED_PRICE_* derived defaults', () => {
    it('FEED_PRICE_SETTLE_MS mirrors GATE_PRICE_SETTLE_MS default', () => {
      const cfg = loadConfig({});
      expect(cfg.FEED_PRICE_SETTLE_MS).toBe(cfg.GATE_PRICE_SETTLE_MS);
    });

    it('FEED_PRICE_REBOUND_EPS mirrors GATE_PRICE_REBOUND_EPS default', () => {
      const cfg = loadConfig({});
      expect(cfg.FEED_PRICE_REBOUND_EPS).toBe(cfg.GATE_PRICE_REBOUND_EPS);
    });

    it('custom GATE_PRICE_SETTLE_MS propagates to FEED', () => {
      const cfg = loadConfig({ GATE_PRICE_SETTLE_MS: '60000' });
      expect(cfg.FEED_PRICE_SETTLE_MS).toBe(60_000);
    });

    it('explicit FEED_PRICE_SETTLE_MS overrides mirroring', () => {
      const cfg = loadConfig({ GATE_PRICE_SETTLE_MS: '60000', FEED_PRICE_SETTLE_MS: '30000' });
      expect(cfg.FEED_PRICE_SETTLE_MS).toBe(30_000);
    });
  });

  // ── CONTRACT_RIDEALONG tied to MULTI_GOOD ───────────────────────────────────

  describe('CONTRACT_RIDEALONG coupling to MULTI_GOOD', () => {
    it('default ON when MULTI_GOOD is ON', () => {
      expect(loadConfig({}).CONTRACT_RIDEALONG).toBe(true);
    });

    it('OFF when MULTI_GOOD is disabled', () => {
      expect(loadConfig({ MULTI_GOOD: '0' }).CONTRACT_RIDEALONG).toBe(false);
    });

    it('OFF when CONTRACT_RIDEALONG=0 even if MULTI_GOOD is ON', () => {
      expect(loadConfig({ CONTRACT_RIDEALONG: '0' }).CONTRACT_RIDEALONG).toBe(false);
    });
  });

  // ── GATE_PROTECT_MATERIALS default set ───────────────────────────────────────

  describe('GATE_PROTECT_MATERIALS', () => {
    it('defaults to the three gate materials', () => {
      expect(loadConfig({}).GATE_PROTECT_MATERIALS).toEqual([
        'FAB_MATS',
        'ADVANCED_CIRCUITRY',
        'QUANTUM_STABILIZERS',
      ]);
    });

    it('can be overridden', () => {
      expect(loadConfig({ GATE_PROTECT_MATERIALS: 'FOO,BAR' }).GATE_PROTECT_MATERIALS).toEqual([
        'FOO',
        'BAR',
      ]);
    });
  });
});

// ── coords / distance ────────────────────────────────────────────────────────

const FIXTURE_CSV = `symbol,x,y
X1-PP30-A1,0,0
X1-PP30-B1,3,4
X1-PP30-B2,0,100
`;

describe('loadCoordsFromCsv', () => {
  it('parses inline CSV string', () => {
    const m = loadCoordsFromCsv(FIXTURE_CSV);
    expect(m['X1-PP30-A1']).toEqual([0, 0]);
    expect(m['X1-PP30-B1']).toEqual([3, 4]);
  });

  it('skips the header row', () => {
    const m = loadCoordsFromCsv(FIXTURE_CSV);
    expect(Object.keys(m)).not.toContain('symbol');
  });
});

describe('distance', () => {
  const coords = loadCoordsFromCsv(FIXTURE_CSV);

  it('A→A = 0', () => {
    expect(distance('X1-PP30-A1', 'X1-PP30-A1', coords)).toBe(0);
  });

  it('A(0,0) → B(3,4) = 5 (3-4-5 triangle)', () => {
    expect(distance('X1-PP30-A1', 'X1-PP30-B1', coords)).toBe(5);
  });

  it('A(0,0) → B2(0,100) = 100', () => {
    expect(distance('X1-PP30-A1', 'X1-PP30-B2', coords)).toBe(100);
  });

  it('returns CROSS_SYSTEM_DIST (1e9) for unknown waypoint', () => {
    expect(distance('X1-PP30-A1', 'X1-UNKNOWN-Z1', coords)).toBe(CROSS_SYSTEM_DIST);
  });

  it('returns CROSS_SYSTEM_DIST when both unknown', () => {
    expect(distance('X1-UNKNOWN-A', 'X1-UNKNOWN-B', coords)).toBe(CROSS_SYSTEM_DIST);
  });
});
