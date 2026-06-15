import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { Prisma } from '../generated/prisma/index.js';

const IntentSchema = Type.Object({
  shipSym: Type.String(),
  phase: Type.String(),
  good: Type.String(),
  units: Type.Integer(),
  buyWp: Type.String(),
  sellWp: Type.String(),
  costBasis: Type.Number(),
  extras: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  updatedAt: Type.String({ format: 'date-time' }),
});

const IntentPutBody = Type.Object({
  phase: Type.String(),
  good: Type.String(),
  units: Type.Integer(),
  buyWp: Type.String(),
  sellWp: Type.String(),
  costBasis: Type.Number(),
  extras: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type IntentRow = {
  shipSym: string;
  phase: string;
  good: string;
  units: number;
  buyWp: string;
  sellWp: string;
  costBasis: number;
  extras: Prisma.JsonValue | null;
  updatedAt: Date;
};

function serializeIntent(r: IntentRow) {
  const { extras, updatedAt, ...rest } = r;
  return {
    ...rest,
    updatedAt: updatedAt.toISOString(),
    ...(extras !== null && { extras: extras as Record<string, unknown> }),
  };
}

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/intents',
    {
      schema: {
        tags: ['intents'],
        summary: 'List all per-ship intents',
        response: { 200: Type.Array(IntentSchema) },
      },
    },
    async (_req, reply) => {
      const rows = await fastify.prisma.intent.findMany({ orderBy: { shipSym: 'asc' } });
      return reply.send(rows.map(serializeIntent));
    },
  );

  fastify.get(
    '/intents/:ship',
    {
      schema: {
        tags: ['intents'],
        summary: 'Get intent for a specific ship',
        params: Type.Object({ ship: Type.String() }),
        response: { 200: IntentSchema, 404: Type.Object({ error: Type.String() }) },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.intent.findUnique({ where: { shipSym: req.params.ship } });
      if (!row) return reply.code(404).send({ error: 'Not found' });
      return reply.send(serializeIntent(row));
    },
  );

  fastify.put(
    '/intents/:ship',
    {
      schema: {
        tags: ['intents'],
        summary: 'Create or replace intent for a ship',
        params: Type.Object({ ship: Type.String() }),
        body: IntentPutBody,
        response: { 200: IntentSchema },
      },
    },
    async (req, reply) => {
      const { extras, ...fields } = req.body;
      const extrasValue: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue =
        extras !== undefined ? (extras as Prisma.InputJsonValue) : Prisma.JsonNull;
      const row = await fastify.prisma.intent.upsert({
        where: { shipSym: req.params.ship },
        create: { shipSym: req.params.ship, ...fields, extras: extrasValue },
        update: { ...fields, extras: extrasValue },
      });
      return reply.send(serializeIntent(row));
    },
  );

  fastify.delete(
    '/intents/:ship',
    {
      schema: {
        tags: ['intents'],
        summary: 'Delete intent for a ship',
        params: Type.Object({ ship: Type.String() }),
        response: {
          200: Type.Object({ deleted: Type.Boolean() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (req, reply) => {
      const existing = await fastify.prisma.intent.findUnique({
        where: { shipSym: req.params.ship },
      });
      if (!existing) return reply.code(404).send({ error: 'Not found' });
      await fastify.prisma.intent.delete({ where: { shipSym: req.params.ship } });
      return reply.send({ deleted: true });
    },
  );
};

export default plugin;
