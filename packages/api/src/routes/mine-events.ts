import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const MineEventRow = Type.Object({
  ts: Type.Optional(Type.String({ format: 'date-time' })),
  type: Type.String(),
  shipSym: Type.String(),
  data: Type.Unknown(),
});

const MineEventItem = Type.Object({
  id: Type.String(),
  ts: Type.String({ format: 'date-time' }),
  type: Type.String(),
  shipSym: Type.String(),
  data: Type.Unknown(),
});

const BatchResult = Type.Object({ inserted: Type.Integer() });

const FilterQuery = Type.Object({
  shipSym: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  since: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, default: 500 })),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/mine-events',
    {
      schema: {
        tags: ['mine-events'],
        summary: 'Batch insert mine events',
        body: Type.Array(MineEventRow),
        response: { 201: BatchResult },
      },
    },
    async (req, reply) => {
      const rows = req.body;
      await fastify.prisma.mineEvent.createMany({
        data: rows.map((r) => ({
          ts: r.ts ? new Date(r.ts) : new Date(),
          type: r.type,
          shipSym: r.shipSym,
          data: r.data as object,
        })),
      });
      return reply.code(201).send({ inserted: rows.length });
    },
  );

  fastify.get(
    '/mine-events',
    {
      schema: {
        tags: ['mine-events'],
        summary: 'Query mine events',
        querystring: FilterQuery,
        response: { 200: Type.Array(MineEventItem) },
      },
    },
    async (req, reply) => {
      const { shipSym, type, since, limit = 500 } = req.query;
      const rows = await fastify.prisma.mineEvent.findMany({
        where: {
          ...(shipSym && { shipSym }),
          ...(type && { type }),
          ...(since && { ts: { gte: new Date(since) } }),
        },
        orderBy: { ts: 'desc' },
        take: limit,
      });
      return reply.send(rows.map((r) => ({ ...r, ts: r.ts.toISOString() })));
    },
  );
};

export default plugin;
