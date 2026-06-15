import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness + DB ping',
        response: {
          200: Type.Object({
            status: Type.Literal('ok'),
            db: Type.Literal('ok'),
          }),
        },
      },
    },
    async (_req, reply) => {
      // DB ping
      await fastify.prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', db: 'ok' });
    },
  );
};

export default plugin;
