/**
 * Gate levers singleton — operator control input.
 * Mirrors gate-levers.json hot-reload (DRIFT #4, #11).
 * GET always returns the seeded singleton; PUT upserts and returns updated row.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const GateLeversSchema = Type.Object({
  floor: Type.Number(),
  resume: Type.Number(),
  gap: Type.Number(),
  budgetFraction: Type.Number(),
  updatedAt: Type.String({ format: 'date-time' }),
});

const GateLeversPutBody = Type.Object({
  floor: Type.Number(),
  resume: Type.Number(),
  gap: Type.Number(),
  budgetFraction: Type.Optional(Type.Number()),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/gate-levers',
    {
      schema: {
        tags: ['gate-levers'],
        summary: 'Get gate lever settings (operator-controlled credit band)',
        response: { 200: GateLeversSchema },
      },
    },
    async (_req, reply) => {
      const row = await fastify.prisma.gateLevers.upsert({
        where: { id: 1 },
        create: { id: 1, floor: 1_500_000, resume: 1_750_000, gap: 250_000, budgetFraction: 0.8 },
        update: {},
      });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );

  fastify.put(
    '/gate-levers',
    {
      schema: {
        tags: ['gate-levers'],
        summary: 'Update gate lever settings',
        body: GateLeversPutBody,
        response: { 200: GateLeversSchema },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.gateLevers.upsert({
        where: { id: 1 },
        create: { id: 1, ...req.body },
        update: req.body,
      });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );
};

export default plugin;
