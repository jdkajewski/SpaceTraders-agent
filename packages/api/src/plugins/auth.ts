/**
 * Optional shared-secret auth: checks `x-bot-key` header.
 * Enabled only when config.BOT_AUTH_ENABLED is true (default off).
 * Routes that require auth call `fastify.requireAuth()` as a preHandler.
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const enabled = fastify.config.BOT_AUTH_ENABLED;
  const botKey = fastify.config.BOT_KEY;

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!enabled) return;
    const key = req.headers['x-bot-key'];
    if (!key || key !== botKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  fastify.decorate('requireAuth', requireAuth);
};

export default fp(authPlugin, { name: 'auth', dependencies: ['config'] });
