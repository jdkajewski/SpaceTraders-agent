/**
 * @st/bot — pino logger (replaces the bot2.mjs `console.error` timestamp logger).
 *
 * The legacy logger printed `HH:MM:SS message…`; pino preserves structured output
 * while keeping the emoji markers the monitors/dashboard parse.
 */

import { pino } from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: null,
});

export type Logger = typeof logger;
