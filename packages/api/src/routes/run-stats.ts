import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const RunStatsSchema = Type.Object({
  totalNet: Type.Number(),
  lanesRun: Type.Integer(),
  updatedAt: Type.String({ format: 'date-time' }),
});

const RunStatsPutBody = Type.Object({
  totalNet: Type.Number(),
  lanesRun: Type.Integer(),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/run-stats',
    {
      schema: {
        tags: ['run-stats'],
        summary: 'Get singleton run statistics',
        response: { 200: RunStatsSchema },
      },
    },
    async (_req, reply) => {
      const row = await fastify.prisma.runStats.upsert({
        where: { id: 1 },
        create: { id: 1, totalNet: 0, lanesRun: 0 },
        update: {},
      });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );

  fastify.put(
    '/run-stats',
    {
      schema: {
        tags: ['run-stats'],
        summary: 'Replace singleton run statistics',
        body: RunStatsPutBody,
        response: { 200: RunStatsSchema },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.runStats.upsert({
        where: { id: 1 },
        create: { id: 1, ...req.body },
        update: req.body,
      });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );
};

export default plugin;
