import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { System, GateEdge, SystemRichness } from '../generated/prisma/index.js';

// ── serialization helpers ────────────────────────────────────────────────────

const SystemSchema = Type.Object({
  symbol: Type.String(),
  x: Type.Union([Type.Number(), Type.Null()]),
  y: Type.Union([Type.Number(), Type.Null()]),
  hasGate: Type.Boolean(),
  gateWaypoint: Type.Union([Type.String(), Type.Null()]),
  gateBuilt: Type.Boolean(),
  hopsFromHome: Type.Union([Type.Integer(), Type.Null()]),
  reachable: Type.Boolean(),
  isHome: Type.Boolean(),
  firstSeenAt: Type.String({ format: 'date-time' }),
  lastCrawledAt: Type.String({ format: 'date-time' }),
  richnessRefreshedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

const EdgeSchema = Type.Object({
  fromSystem: Type.String(),
  toSystem: Type.String(),
  fromGateWp: Type.Union([Type.String(), Type.Null()]),
  toGateWp: Type.Union([Type.String(), Type.Null()]),
  builtFrom: Type.Boolean(),
  builtTo: Type.Boolean(),
  traversable: Type.Boolean(),
});

const RichnessSchema = Type.Object({
  systemSym: Type.String(),
  marketplaceCount: Type.Integer(),
  shipyardCount: Type.Integer(),
  importSiteCount: Type.Integer(),
  importGoodsTotal: Type.Integer(),
  premiumShipTypes: Type.Array(Type.String()),
  premiumShipCount: Type.Integer(),
  sellsFueledHull: Type.Boolean(),
  score: Type.Number(),
  detailLevel: Type.String(),
});

const RankedSchema = Type.Object({
  symbol: Type.String(),
  score: Type.Number(),
  hopsFromHome: Type.Union([Type.Integer(), Type.Null()]),
  reachable: Type.Boolean(),
  gateWaypoint: Type.Union([Type.String(), Type.Null()]),
  marketplaceCount: Type.Integer(),
  shipyardCount: Type.Integer(),
  importSiteCount: Type.Integer(),
  premiumShipTypes: Type.Array(Type.String()),
  sellsFueledHull: Type.Boolean(),
});

const GraphSchema = Type.Object({
  systems: Type.Array(SystemSchema),
  edges: Type.Array(EdgeSchema),
});

const UpsertResult = Type.Object({ upserted: Type.Integer() });

function toSystemDto(s: System) {
  return {
    symbol: s.symbol,
    x: s.x,
    y: s.y,
    hasGate: s.hasGate,
    gateWaypoint: s.gateWaypoint,
    gateBuilt: s.gateBuilt,
    hopsFromHome: s.hopsFromHome,
    reachable: s.reachable,
    isHome: s.isHome,
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastCrawledAt: s.lastCrawledAt.toISOString(),
    richnessRefreshedAt: s.richnessRefreshedAt ? s.richnessRefreshedAt.toISOString() : null,
  };
}

function toEdgeDto(e: GateEdge) {
  return {
    fromSystem: e.fromSystem,
    toSystem: e.toSystem,
    fromGateWp: e.fromGateWp,
    toGateWp: e.toGateWp,
    builtFrom: e.builtFrom,
    builtTo: e.builtTo,
    traversable: e.traversable,
  };
}

function toRichnessDto(r: SystemRichness) {
  return {
    systemSym: r.systemSym,
    marketplaceCount: r.marketplaceCount,
    shipyardCount: r.shipyardCount,
    importSiteCount: r.importSiteCount,
    importGoodsTotal: r.importGoodsTotal,
    premiumShipTypes: r.premiumShipTypes,
    premiumShipCount: r.premiumShipCount,
    sellsFueledHull: r.sellsFueledHull,
    score: r.score,
    detailLevel: r.detailLevel,
  };
}

// ── upsert bodies ─────────────────────────────────────────────────────────────

const SystemUpsertBody = Type.Array(
  Type.Object({
    symbol: Type.String(),
    x: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    y: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    hasGate: Type.Optional(Type.Boolean()),
    gateWaypoint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    gateBuilt: Type.Optional(Type.Boolean()),
    hopsFromHome: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    reachable: Type.Optional(Type.Boolean()),
    isHome: Type.Optional(Type.Boolean()),
    richnessRefreshedAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  }),
);

const EdgeUpsertBody = Type.Array(
  Type.Object({
    fromSystem: Type.String(),
    toSystem: Type.String(),
    fromGateWp: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toGateWp: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    builtFrom: Type.Optional(Type.Boolean()),
    builtTo: Type.Optional(Type.Boolean()),
  }),
);

const RichnessUpsertBody = Type.Array(
  Type.Object({
    systemSym: Type.String(),
    marketplaceCount: Type.Optional(Type.Integer()),
    shipyardCount: Type.Optional(Type.Integer()),
    importSiteCount: Type.Optional(Type.Integer()),
    importGoodsTotal: Type.Optional(Type.Integer()),
    premiumShipTypes: Type.Optional(Type.Array(Type.String())),
    premiumShipCount: Type.Optional(Type.Integer()),
    sellsFueledHull: Type.Optional(Type.Boolean()),
    score: Type.Optional(Type.Number()),
    detailLevel: Type.Optional(Type.String()),
  }),
);

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── reads ──────────────────────────────────────────────────────────────────

  fastify.get(
    '/galaxy/graph',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Compact galaxy graph (systems + gate edges) for pathfinding + visualization',
        response: { 200: GraphSchema },
      },
    },
    async (_req, reply) => {
      const [systems, edges] = await Promise.all([
        fastify.prisma.system.findMany({ orderBy: { symbol: 'asc' } }),
        fastify.prisma.gateEdge.findMany({ orderBy: [{ fromSystem: 'asc' }, { toSystem: 'asc' }] }),
      ]);
      return reply.send({ systems: systems.map(toSystemDto), edges: edges.map(toEdgeDto) });
    },
  );

  fastify.get(
    '/galaxy/systems',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'List system nodes (optionally only reachable)',
        querystring: Type.Object({
          reachable: Type.Optional(Type.Boolean()),
        }),
        response: { 200: Type.Array(SystemSchema) },
      },
    },
    async (req, reply) => {
      const where = req.query.reachable === undefined ? {} : { reachable: req.query.reachable };
      const rows = await fastify.prisma.system.findMany({ where, orderBy: { symbol: 'asc' } });
      return reply.send(rows.map(toSystemDto));
    },
  );

  fastify.get(
    '/galaxy/system/:sym',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Get a single system with its richness + gate edges',
        params: Type.Object({ sym: Type.String() }),
        response: {
          200: Type.Object({
            system: SystemSchema,
            richness: Type.Union([RichnessSchema, Type.Null()]),
            edgesOut: Type.Array(EdgeSchema),
            edgesIn: Type.Array(EdgeSchema),
          }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (req, reply) => {
      const row = await fastify.prisma.system.findUnique({
        where: { symbol: req.params.sym },
        include: { richness: true, edgesOut: true, edgesIn: true },
      });
      if (!row) return reply.code(404).send({ error: 'Not found' });
      return reply.send({
        system: toSystemDto(row),
        richness: row.richness ? toRichnessDto(row.richness) : null,
        edgesOut: row.edgesOut.map(toEdgeDto),
        edgesIn: row.edgesIn.map(toEdgeDto),
      });
    },
  );

  fastify.get(
    '/galaxy/edges',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'List all gate edges',
        response: { 200: Type.Array(EdgeSchema) },
      },
    },
    async (_req, reply) => {
      const rows = await fastify.prisma.gateEdge.findMany({
        orderBy: [{ fromSystem: 'asc' }, { toSystem: 'asc' }],
      });
      return reply.send(rows.map(toEdgeDto));
    },
  );

  fastify.get(
    '/galaxy/ranked',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Ranked rich-market systems (AUTO_EXPAND target candidates)',
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
          reachableOnly: Type.Optional(Type.Boolean()),
        }),
        response: { 200: Type.Array(RankedSchema) },
      },
    },
    async (req, reply) => {
      const take = req.query.limit ?? 50;
      const rows = await fastify.prisma.systemRichness.findMany({
        where: req.query.reachableOnly ? { system: { reachable: true } } : {},
        orderBy: { score: 'desc' },
        take,
        include: { system: true },
      });
      return reply.send(
        rows.map((r) => ({
          symbol: r.systemSym,
          score: r.score,
          hopsFromHome: r.system.hopsFromHome,
          reachable: r.system.reachable,
          gateWaypoint: r.system.gateWaypoint,
          marketplaceCount: r.marketplaceCount,
          shipyardCount: r.shipyardCount,
          importSiteCount: r.importSiteCount,
          premiumShipTypes: r.premiumShipTypes,
          sellsFueledHull: r.sellsFueledHull,
        })),
      );
    },
  );

  // ── writes (crawler upserts) ─────────────────────────────────────────────────

  fastify.put(
    '/galaxy/systems',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Bulk upsert system nodes',
        body: SystemUpsertBody,
        response: { 200: UpsertResult },
      },
    },
    async (req, reply) => {
      let upserted = 0;
      for (const s of req.body) {
        const { symbol, richnessRefreshedAt, ...rest } = s;
        const data = {
          ...rest,
          ...(richnessRefreshedAt !== undefined
            ? { richnessRefreshedAt: richnessRefreshedAt ? new Date(richnessRefreshedAt) : null }
            : {}),
        };
        await fastify.prisma.system.upsert({
          where: { symbol },
          create: { symbol, ...data },
          update: data,
        });
        upserted++;
      }
      return reply.send({ upserted });
    },
  );

  fastify.put(
    '/galaxy/edges',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Bulk upsert gate edges (traversable derived from built ends)',
        body: EdgeUpsertBody,
        response: { 200: UpsertResult },
      },
    },
    async (req, reply) => {
      // Ensure referenced systems exist (FK) without disturbing crawled rows.
      const syms = new Set<string>();
      for (const e of req.body) {
        syms.add(e.fromSystem);
        syms.add(e.toSystem);
      }
      if (syms.size) {
        await fastify.prisma.system.createMany({
          data: [...syms].map((symbol) => ({ symbol })),
          skipDuplicates: true,
        });
      }
      let upserted = 0;
      for (const e of req.body) {
        const builtFrom = e.builtFrom ?? false;
        const builtTo = e.builtTo ?? false;
        const data = {
          fromGateWp: e.fromGateWp ?? null,
          toGateWp: e.toGateWp ?? null,
          builtFrom,
          builtTo,
          traversable: builtFrom && builtTo,
        };
        await fastify.prisma.gateEdge.upsert({
          where: { fromSystem_toSystem: { fromSystem: e.fromSystem, toSystem: e.toSystem } },
          create: { fromSystem: e.fromSystem, toSystem: e.toSystem, ...data },
          update: data,
        });
        upserted++;
      }
      return reply.send({ upserted });
    },
  );

  fastify.put(
    '/galaxy/richness',
    {
      schema: {
        tags: ['galaxy'],
        summary: 'Bulk upsert per-system richness',
        body: RichnessUpsertBody,
        response: { 200: UpsertResult },
      },
    },
    async (req, reply) => {
      const syms = new Set(req.body.map((r) => r.systemSym));
      if (syms.size) {
        await fastify.prisma.system.createMany({
          data: [...syms].map((symbol) => ({ symbol })),
          skipDuplicates: true,
        });
      }
      let upserted = 0;
      for (const r of req.body) {
        const { systemSym, ...rest } = r;
        await fastify.prisma.systemRichness.upsert({
          where: { systemSym },
          create: { systemSym, ...rest },
          update: rest,
        });
        upserted++;
      }
      return reply.send({ upserted });
    },
  );
};

export default plugin;
