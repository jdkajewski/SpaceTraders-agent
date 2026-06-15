import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import autoload from '@fastify/autoload';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  /** Override DATABASE_URL for tests */
  databaseUrl?: string;
  /** Disable logger for tests */
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}) {
  const { databaseUrl, logger } = opts;

  if (databaseUrl) {
    process.env['DATABASE_URL'] = databaseUrl;
  }

  const loggerOpts =
    logger === false
      ? false
      : process.env['NODE_ENV'] !== 'production'
      ? {
          transport: {
            target: 'pino-pretty' as const,
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : true;

  const app = Fastify({ logger: loggerOpts }).withTypeProvider<TypeBoxTypeProvider>();

  // ── Swagger (optional self-documenting surface) ──────────────────────────
  await app.register(swagger, {
    openapi: {
      info: { title: 'SpaceTraders Agent API', version: '1.0.0' },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // ── fp plugins (config → prisma → sensible → auth) ──────────────────────
  await app.register(autoload, {
    dir: join(__dirname, 'plugins'),
    options: {},
  });

  // ── Route plugins (autoloaded from routes/) ──────────────────────────────
  await app.register(autoload, {
    dir: join(__dirname, 'routes'),
    options: {},
  });

  return app;
}
