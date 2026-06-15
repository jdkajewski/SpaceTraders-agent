import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { MarketHistory } from '../generated/prisma/index.js';

const MarketHistoryRow = Type.Object({
  ts: Type.Optional(Type.String({ format: 'date-time' })),
  waypoint: Type.String(),
  good: Type.String(),
  purchasePrice: Type.Number(),
  sellPrice: Type.Number(),
  tradeVolume: Type.Integer(),
  supply: Type.String(),
  activity: Type.Optional(Type.String()),
});

const MarketHistoryItem = Type.Object({
  id: Type.String(),
  ts: Type.String({ format: 'date-time' }),
  waypoint: Type.String(),
  good: Type.String(),
  purchasePrice: Type.Number(),
  sellPrice: Type.Number(),
  tradeVolume: Type.Integer(),
  supply: Type.String(),
  activity: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const BatchResult = Type.Object({ inserted: Type.Integer() });

const FilterQuery = Type.Object({
  waypoint: Type.Optional(Type.String()),
  good: Type.Optional(Type.String()),
  since: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, default: 500 })),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/market-history',
    {
      schema: {
        tags: ['market-history'],
        summary: 'Batch insert market history rows',
        body: Type.Array(MarketHistoryRow),
        response: { 201: BatchResult },
      },
    },
    async (req, reply) => {
      const rows = req.body;
      await fastify.prisma.marketHistory.createMany({
        data: rows.map((r) => ({
          ts: r.ts ? new Date(r.ts) : new Date(),
          waypoint: r.waypoint,
          good: r.good,
          purchasePrice: r.purchasePrice,
          sellPrice: r.sellPrice,
          tradeVolume: r.tradeVolume,
          supply: r.supply,
          activity: r.activity ?? null,
        })),
      });
      return reply.code(201).send({ inserted: rows.length });
    },
  );

  fastify.get(
    '/market-history',
    {
      schema: {
        tags: ['market-history'],
        summary: 'Query market history (filter by waypoint, good, since)',
        querystring: FilterQuery,
        response: { 200: Type.Array(MarketHistoryItem) },
      },
    },
    async (req, reply) => {
      const { waypoint, good, since, limit = 500 } = req.query;
      const rows = await fastify.prisma.marketHistory.findMany({
        where: {
          ...(waypoint && { waypoint }),
          ...(good && { good }),
          ...(since && { ts: { gte: new Date(since) } }),
        },
        orderBy: { ts: 'desc' },
        take: limit,
      });
      return reply.send(rows.map((r: MarketHistory) => ({ ...r, ts: r.ts.toISOString() })));
    },
  );
};

export default plugin;
