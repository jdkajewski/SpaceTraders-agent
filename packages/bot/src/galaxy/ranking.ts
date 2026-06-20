/**
 * Galaxy market-richness ranking — a deterministic weighted score over a few
 * scalar features. Marketplace count is the primary signal (the single best
 * system seen in live operation had 39 markets); import-site density, shipyard
 * count, and premium-ship availability refine it.
 *
 * Pure + dependency-free so it is trivially unit-testable and can run identically
 * in the crawler (to persist `score`) and anywhere a re-rank is wanted.
 */

/** Premium ship hull types that make a system a high-value expansion target. */
export const PREMIUM_SHIP_TYPES = [
  'EXPLORER',
  'HEAVY_FREIGHTER',
  'REFINING_FREIGHTER',
  'ORE_HOUND',
  'COMMAND_FRIGATE',
  'LIGHT_HAULER',
] as const;

export type PremiumShipType = (typeof PREMIUM_SHIP_TYPES)[number];

/** The premium set normalized for membership checks (`SHIP_` prefix tolerated). */
const PREMIUM_SET = new Set<string>(PREMIUM_SHIP_TYPES);

/** Normalize a shipyard `shipTypes[].type` (e.g. `SHIP_ORE_HOUND`) to bare premium token, or null. */
export function premiumOf(shipType: string): PremiumShipType | null {
  const bare = shipType.replace(/^SHIP_/, '');
  return PREMIUM_SET.has(bare) ? (bare as PremiumShipType) : null;
}

/** Scalar features that feed the rank score. */
export interface RichnessFeatures {
  marketplaceCount: number;
  importSiteCount: number;
  shipyardCount: number;
  premiumShipCount: number;
}

/** Weighted-sum coefficients (configurable via GALAXY_W_* env). */
export interface RankWeights {
  market: number;
  import: number;
  yard: number;
  premium: number;
}

export const DEFAULT_WEIGHTS: RankWeights = { market: 10, import: 3, yard: 5, premium: 8 };

/**
 * `score = w_market·marketplaceCount + w_import·importSiteCount
 *        + w_yard·shipyardCount + w_premium·premiumShipCount`.
 * Reachability gating is applied by the caller (the API `ranked` query / provider),
 * not here, so the raw richness score is preserved for every system.
 */
export function scoreRichness(f: RichnessFeatures, w: RankWeights = DEFAULT_WEIGHTS): number {
  return (
    w.market * (f.marketplaceCount || 0) +
    w.import * (f.importSiteCount || 0) +
    w.yard * (f.shipyardCount || 0) +
    w.premium * (f.premiumShipCount || 0)
  );
}
