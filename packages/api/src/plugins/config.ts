import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { loadConfig, type Config } from '@st/shared';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

const configPlugin: FastifyPluginAsync = async (fastify) => {
  const config = loadConfig();
  fastify.decorate('config', config);
};

export default fp(configPlugin, { name: 'config' });
