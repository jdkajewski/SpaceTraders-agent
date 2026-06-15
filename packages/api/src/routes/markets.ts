import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const MarketSnapshotSchema = Type.Object({
  waypoint: Type.String(),
  data: Type.Unknown(),
  updatedAt: Type.String({ format: 'date-time' }),
});

const MarketPutBody = Type.Object({
  data: Type.Unknown(),
});

const BulkPutBody = Type.Array(
  Type.Object({
    waypoint: Type.String(),
    data: Type.Unknown(),
  }),
);

const BulkPutResult = Type.Object({ upserted: Type.Integer() });

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/markets',
    {
      schema: {
        tags: ['markets'],
        summary: 'List all market snapshots',
        response: { 200: Type.Array(MarketSnapshotSchema) },
      },
    },
    async (_req, reply) => {
      const rows = await fastify.prisma.marketSnapshot.findMany({
        orderBy: { waypoint: 'asc' },
      });
      return reply.send(rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })));
    },
  );

  fastify.get(
    '/markets/:wp',
    {
      schema: {
        tags: ['markets'],
        summary: 'Get market snapshot for a waypoint',
        params: Type.Object({ wp: Type.String() }),
        response: {
          200: MarketSnapshotSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.marketSnapshot.findUnique({
        where: { waypoint: req.params.wp },
      });
      if (!row) return reply.code(404).send({ error: 'Not found' });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );

  fastify.put(
    '/markets/:wp',
    {
      schema: {
        tags: ['markets'],
        summary: 'Create or replace market snapshot for a waypoint',
        params: Type.Object({ wp: Type.String() }),
        body: MarketPutBody,
        response: { 200: MarketSnapshotSchema },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.marketSnapshot.upsert({
        where: { waypoint: req.params.wp },
        create: { waypoint: req.params.wp, data: req.body.data as object },
        update: { data: req.body.data as object },
      });
      return reply.send({ ...row, updatedAt: row.updatedAt.toISOString() });
    },
  );

  // Bulk PUT: accepts array of {waypoint, data} objects
  fastify.put(
    '/markets',
    {
      schema: {
        tags: ['markets'],
        summary: 'Bulk upsert market snapshots',
        body: BulkPutBody,
        response: { 200: BulkPutResult },
      },
    },
    async (req, reply) => {
      let upserted = 0;
      for (const item of req.body) {
        await fastify.prisma.marketSnapshot.upsert({
          where: { waypoint: item.waypoint },
          create: { waypoint: item.waypoint, data: item.data as object },
          update: { data: item.data as object },
        });
        upserted++;
      }
      return reply.send({ upserted });
    },
  );
};

export default plugin;
