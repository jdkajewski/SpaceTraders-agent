import { describe, it, expect } from 'vitest';
import { scoreRichness, premiumOf, PREMIUM_SHIP_TYPES, DEFAULT_WEIGHTS } from '../ranking.js';

describe('galaxy/ranking', () => {
  describe('premiumOf', () => {
    it('normalizes a SHIP_-prefixed premium type to its bare token', () => {
      expect(premiumOf('SHIP_ORE_HOUND')).toBe('ORE_HOUND');
      expect(premiumOf('SHIP_LIGHT_HAULER')).toBe('LIGHT_HAULER');
    });

    it('accepts an already-bare premium token', () => {
      expect(premiumOf('EXPLORER')).toBe('EXPLORER');
    });

    it('returns null for a non-premium hull', () => {
      expect(premiumOf('SHIP_PROBE')).toBeNull();
      expect(premiumOf('SHIP_MINING_DRONE')).toBeNull();
    });

    it('recognizes every declared premium type', () => {
      for (const t of PREMIUM_SHIP_TYPES) expect(premiumOf(t)).toBe(t);
    });
  });

  describe('scoreRichness', () => {
    it('applies the default weighted sum', () => {
      // 10*5 + 3*4 + 5*2 + 8*1 = 50 + 12 + 10 + 8 = 80
      const score = scoreRichness({ marketplaceCount: 5, importSiteCount: 4, shipyardCount: 2, premiumShipCount: 1 });
      expect(score).toBe(80);
    });

    it('makes marketplace count the dominant (primary) signal', () => {
      const rich = scoreRichness({ marketplaceCount: 39, importSiteCount: 0, shipyardCount: 0, premiumShipCount: 0 });
      const others = scoreRichness({ marketplaceCount: 0, importSiteCount: 10, shipyardCount: 3, premiumShipCount: 2 });
      expect(rich).toBeGreaterThan(others);
    });

    it('treats missing features as zero', () => {
      expect(scoreRichness({ marketplaceCount: 3 } as never)).toBe(DEFAULT_WEIGHTS.market * 3);
    });

    it('honors custom weights', () => {
      const w = { market: 1, import: 0, yard: 0, premium: 0 };
      expect(scoreRichness({ marketplaceCount: 7, importSiteCount: 9, shipyardCount: 9, premiumShipCount: 9 }, w)).toBe(7);
    });

    it('orders two systems by richness consistently', () => {
      const a = scoreRichness({ marketplaceCount: 20, importSiteCount: 5, shipyardCount: 2, premiumShipCount: 3 });
      const b = scoreRichness({ marketplaceCount: 8, importSiteCount: 5, shipyardCount: 2, premiumShipCount: 3 });
      expect(a).toBeGreaterThan(b);
    });
  });
});
