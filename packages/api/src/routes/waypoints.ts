import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

const WaypointSchema = Type.Object({
  symbol: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/waypoints',
    {
      schema: {
        tags: ['waypoints'],
        summary: 'Get all seeded waypoint coordinates',
        querystring: Type.Object({
          system: Type.Optional(Type.String()),
        }),
        response: { 200: Type.Array(WaypointSchema) },
      },
    },
    async (req, reply) => {
      const { system } = req.query;
      const rows = system
        ? await fastify.prisma.waypoint.findMany({
            where: { symbol: { startsWith: system } },
            orderBy: { symbol: 'asc' },
          })
        : await fastify.prisma.waypoint.findMany({
            orderBy: { symbol: 'asc' },
          });
      return reply.send(rows);
    },
  );
};

export default plugin;
