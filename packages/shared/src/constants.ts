/**
 * @st/shared — domain constants
 * Sourced from bot2.mjs (lines 310–313 and related).
 */

/** Seconds of flight time per distance unit per speed point, per mode. */
export const TIME_FACTOR: Readonly<Record<string, number>> = {
  DRIFT: 250,
  CRUISE: 25,
  STEALTH: 30,
  BURN: 12.5,
} as const;

/**
 * Gate construction materials.
 * Mirrors GATE_PROTECT_MATERIALS default in bot2.mjs.
 */
export const GATE_MATERIALS = ['FAB_MATS', 'ADVANCED_CIRCUITRY', 'QUANTUM_STABILIZERS'] as const;
export type GateMaterial = (typeof GATE_MATERIALS)[number];

/** Default system symbol (overridden by env SYSTEM). */
export const DEFAULT_SYSTEM = 'X1-PP30';

/** Value returned by D() when either waypoint is missing from coords (cross-system). */
export const CROSS_SYSTEM_DIST = 1e9;

/** Game constant: 30 ore → 10 refined per refine action (60s cooldown). */
export const REFINE_IN = 30;
export const REFINE_OUT = 10;

/** Shared market cache lifetime in ms (not env-tunable in bot2). */
export const MARKET_TTL_MS = 75_000;

/** Worker wait when no lane available (ms). */
export const IDLE_WAIT_MS = 12_000;

/** Supply tiers ranked by scarcity (lower = scarcer = more urgent to feed). */
export const SUPPLY_RANK: Readonly<Record<string, number>> = {
  SCARCE: 0,
  LIMITED: 1,
  MODERATE: 2,
  HIGH: 3,
  ABUNDANT: 4,
} as const;

/** Bot rate-limit target (SpaceTraders v2 allows 2 req/s sustained). */
export const RATE_LIMIT_RPS = 2;
