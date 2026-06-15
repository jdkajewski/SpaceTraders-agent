import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const TradeObservationRow = Type.Object({
  ts: Type.Optional(Type.String({ format: 'date-time' })),
  shipSym: Type.String(),
  good: Type.String(),
  buyWp: Type.String(),
  sellWp: Type.String(),
  projected: Type.Number(),
  realized: Type.Number(),
  units: Type.Integer(),
  buyPx: Type.Number(),
  sellPx: Type.Number(),
});

const TradeObservationItem = Type.Object({
  id: Type.String(),
  ts: Type.String({ format: 'date-time' }),
  shipSym: Type.String(),
  good: Type.String(),
  buyWp: Type.String(),
  sellWp: Type.String(),
  projected: Type.Number(),
  realized: Type.Number(),
  units: Type.Integer(),
  buyPx: Type.Number(),
  sellPx: Type.Number(),
});

const BatchResult = Type.Object({ inserted: Type.Integer() });

const FilterQuery = Type.Object({
  shipSym: Type.Optional(Type.String()),
  good: Type.Optional(Type.String()),
  since: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, default: 500 })),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/trade-observations',
    {
      schema: {
        tags: ['trade-observations'],
        summary: 'Batch insert trade observations',
        body: Type.Array(TradeObservationRow),
        response: { 201: BatchResult },
      },
    },
    async (req, reply) => {
      const rows = req.body;
      await fastify.prisma.tradeObservation.createMany({
        data: rows.map((r) => ({
          ts: r.ts ? new Date(r.ts) : new Date(),
          shipSym: r.shipSym,
          good: r.good,
          buyWp: r.buyWp,
          sellWp: r.sellWp,
          projected: r.projected,
          realized: r.realized,
          units: r.units,
          buyPx: r.buyPx,
          sellPx: r.sellPx,
        })),
      });
      return reply.code(201).send({ inserted: rows.length });
    },
  );

  fastify.get(
    '/trade-observations',
    {
      schema: {
        tags: ['trade-observations'],
        summary: 'Query trade observations',
        querystring: FilterQuery,
        response: { 200: Type.Array(TradeObservationItem) },
      },
    },
    async (req, reply) => {
      const { shipSym, good, since, limit = 500 } = req.query;
      const rows = await fastify.prisma.tradeObservation.findMany({
        where: {
          ...(shipSym && { shipSym }),
          ...(good && { good }),
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
