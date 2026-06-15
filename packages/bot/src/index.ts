/**
 * @st/bot — public surface of the Wave 2 core libraries.
 *
 * Interfaces (committed for Waves 3–5) + concrete factories for the SpaceTraders
 * client, persistence client, ship actions, routing, and the markets service.
 */

export * from './interfaces.js';
export { logger } from './core/logger.js';
export type { Logger } from './core/logger.js';

export { createSpaceTradersClient, __resetRateLimiter } from './clients/spacetraders.js';
export type { SpaceTradersClientOptions } from './clients/spacetraders.js';

export { createPersistenceClient } from './clients/persistence.js';
export type { PersistenceClientOptions } from './clients/persistence.js';

export { createShipActions } from './trade/shipActions.js';

export { TIME_FACTOR, legFuel, legTime, computeFuelPx, chooseMode } from './routing/flight.js';
export { createRouter, marketSellsFuel } from './routing/route.js';
export type { RouterOptions } from './routing/route.js';

export { createMarketsService } from './market/markets.js';
export type { MarketsServiceOptions, MarketsServiceExtra } from './market/markets.js';
