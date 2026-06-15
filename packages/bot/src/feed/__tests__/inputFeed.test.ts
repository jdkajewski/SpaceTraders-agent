import { describe, it, expect } from 'vitest';
import { loadConfig, type Config, type Market, type MarketGood } from '@st/shared';
import { createState } from '../../runtime/state.js';
import { makeShip } from '../../__tests__/fixtures.js';
import { canStartInputFeed, feedBuyAllowed, gateProducerInputTargets, inputFeedMax, planInputFeed } from '../inputFeed.js';

const baseCfg: Config = loadConfig({ INPUT_FEED: '1', GATE_SUPPLY: '1' });

function good(symbol: string, type: MarketGood['type'], purchasePrice: number, sellPrice: number, tradeVolume = 20, supply = 'MODERATE'): MarketGood {
  return { symbol, type, tradeVolume, supply, purchasePrice, sellPrice };
}
function mkt(symbol: string, goods: MarketGood[]): Market {
  return { symbol, tradeGoods: goods };
}
function activeState(c: Config, markets: Record<string, Market>) {
  const s = createState(c, { marketsRef: () => markets });
  s.gateCache = { exists: true, built: false, known: true, wp: 'GATE', remaining: { FAB_MATS: 100 } };
  s.cachedCredits = 10_000_000;
  s.operatingReserve = 0;
  return s;
}

describe('input feed: caps', () => {
  it('clamps opportunistic feeders at ≤2 and reserves one feeder per producer', () => {
    const c = { ...baseCfg, INPUT_FEED_MAX: 99 } as Config;
    const markets: Record<string, Market> = {
      PROD: mkt('PROD', [good('FAB_MATS', 'EXPORT', 1000, 1100), good('IRON', 'IMPORT', 100, 150)]),
      SRC: mkt('SRC', [good('IRON', 'EXPORT', 50, 70)]),
    };
    const s = activeState(c, markets);
    expect(inputFeedMax(c)).toBe(2);
    s.inputActiveFeeders.add('SHIP-A');
    s.inputActiveFeeders.add('SHIP-B');
    expect(canStartInputFeed('SHIP-C', s, c)).toBe(false);
    expect(gateProducerInputTargets(s, c, markets)).toHaveLength(1);
    s.inputActiveProducers.add('PROD');
    const t = gateProducerInputTargets(s, c, markets)[0]!;
    const availableProducer = s.inputActiveProducers.has(t.producerWp) ? null : t;
    expect(availableProducer).toBeNull();
  });
});

describe('input feed: cash gate', () => {
  it('INPUT_FEED_MIN_CASH blocks planning below the free-cash threshold', () => {
    const c = { ...baseCfg, INPUT_FEED_MIN_CASH: 50_000 } as Config;
    const markets: Record<string, Market> = {
      PROD: mkt('PROD', [good('FAB_MATS', 'EXPORT', 1000, 1100), good('IRON', 'IMPORT', 100, 150)]),
      SRC: mkt('SRC', [good('IRON', 'EXPORT', 50, 70)]),
    };
    const s = activeState(c, markets);
    s.cachedCredits = 40_000;
    s.operatingReserve = 0;
    const freeCashOk = s.cachedCredits - s.committed - s.operatingReserve >= c.INPUT_FEED_MIN_CASH;
    const plan = freeCashOk ? planInputFeed('PROD', ['IRON'], markets, { free: makeShip().cargo.capacity, headroom: 40_000 }, s, c) : [];
    expect(freeCashOk).toBe(false);
    expect(plan).toEqual([]);
  });
});

describe('input feed: price settle FSM', () => {
  it('mirrors gate patience: paused → settling → normal on rebound or timeout', () => {
    const c = { ...baseCfg, FEED_PRICE_SETTLE_MS: 1000, FEED_PRICE_REBOUND_EPS: 0.1 } as Config;
    const s = createState(c);
    expect(feedBuyAllowed(s, c, 'IRON', 120, 100, 0)).toBe(false);
    expect(s.feedPxState.get('IRON')?.state).toBe('paused');
    expect(feedBuyAllowed(s, c, 'IRON', 90, 100, 100)).toBe(false);
    expect(s.feedPxState.get('IRON')?.state).toBe('settling');
    expect(feedBuyAllowed(s, c, 'IRON', 80, 100, 200)).toBe(false);
    expect(s.feedPxState.get('IRON')?.low).toBe(80);
    expect(feedBuyAllowed(s, c, 'IRON', 89, 100, 300)).toBe(true);
    expect(s.feedPxState.get('IRON')?.state).toBe('normal');

    expect(feedBuyAllowed(s, c, 'COPPER', 120, 100, 0)).toBe(false);
    expect(feedBuyAllowed(s, c, 'COPPER', 90, 100, 100)).toBe(false);
    expect(feedBuyAllowed(s, c, 'COPPER', 85, 100, 1200)).toBe(true);
    expect(s.feedPxState.get('COPPER')?.state).toBe('normal');
  });
});
