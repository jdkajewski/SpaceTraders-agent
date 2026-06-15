/**
 * Status snapshots — stores full `bot-status.json`-compatible JSON.
 * POST stores a new snapshot; GET returns the latest by createdAt.
 * The `data` column holds the full StatusSnapshot shape so monitors can
 * migrate from reading bot-status.json to GET /status unchanged.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

// The full snapshot shape is an opaque JSON object (bot2.mjs `writeStatus()` output).
// We only validate the mandatory top-level columns; `data` is pass-through.
const StatusPostBody = Type.Object({
  phase: Type.String(),
  runNet: Type.Number(),
  credits: Type.Number(),
  gate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  data: Type.Unknown(),
});

const StatusSnapshotSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
  phase: Type.String(),
  runNet: Type.Number(),
  credits: Type.Number(),
  gate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  data: Type.Unknown(),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/status',
    {
      schema: {
        tags: ['status'],
        summary: 'Write a new status snapshot (identical shape to bot-status.json)',
        body: StatusPostBody,
        response: { 201: StatusSnapshotSchema },
      },
    },
    async (req, reply) => {
      const { phase, runNet, credits, gate, data } = req.body;
      const row = await fastify.prisma.statusSnapshot.create({
        data: {
          phase,
          runNet,
          credits,
          gate: gate ?? null,
          data: data as object,
        },
      });
      return reply.code(201).send({ ...row, createdAt: row.createdAt.toISOString() });
    },
  );

  fastify.get(
    '/status',
    {
      schema: {
        tags: ['status'],
        summary: 'Get the latest status snapshot',
        response: {
          200: StatusSnapshotSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (_req, reply) => {
      const row = await fastify.prisma.statusSnapshot.findFirst({
        orderBy: { createdAt: 'desc' },
      });
      if (!row) return reply.code(404).send({ error: 'No snapshots yet' });
      return reply.send({ ...row, createdAt: row.createdAt.toISOString() });
    },
  );
};

export default plugin;
