import { buildApp } from './app.js';
import { loadConfig } from '@st/shared';

const config = loadConfig();

const app = await buildApp();

const port = config.API_PORT;
const host = config.API_HOST;

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down…`);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
  app.log.info(`🚀 API listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
