# Wave 1 — Fastify persistence API

**Depends on:** Wave 0. **Blocks:** Wave 5 (bot integration). **Suggested model:** mid-tier coding model.
**Base branch:** integration branch after Wave 0 merges.

## Goal
A Fastify (TS, ESM) service that owns ALL persistence, using **fastify-autoload** to mount
plugins + routes and **fastify-plugin (fp)** to share `prisma`/`config` across the app. It exposes the
REST surface that replaces every file the bot used.

## Tasks

### 1.1 App bootstrap
- `packages/api/src/app.ts` — builds a Fastify instance, registers `@fastify/autoload` for
  `plugins/` then `routes/`. Export a `buildApp(opts)` factory (testable) separate from `server.ts`
  (listen).
- `packages/api/src/server.ts` — reads host/port from config, `buildApp().listen()`, graceful shutdown.
- pino logger config (pretty in dev, json in prod).

### 1.2 fp plugins (`src/plugins/`, wrapped in `fastify-plugin`)
- `config.ts` — parse env via `@st/shared` `loadConfig`, decorate `fastify.config`.
- `prisma.ts` — instantiate `PrismaClient`, `decorate('prisma', …)`, `onClose` disconnect.
- `sensible.ts` — register `@fastify/sensible` (httpErrors, etc.).
- (optional) `auth.ts` — a simple shared-secret header check (`x-bot-key`) so only the bot writes.
  Default off in dev; behind config flag.

### 1.3 Route plugins (`src/routes/`, autoloaded; one file/resource)
Implement each with **schema validation** (Typebox via `@fastify/type-provider-typebox`, or
zod-to-json-schema) and `fastify.prisma`:
- `health.ts` — `GET /health` (DB `SELECT 1`).
- `run-stats.ts` — `GET` + `PUT` singleton (`totalNet`, `lanesRun`, `updatedAt`).
- `intents.ts` — `GET /intents`, `GET/PUT/DELETE /intents/:ship`.
- `status.ts` — `POST /status` (insert snapshot), `GET /status` (latest by `createdAt`).
- `markets.ts` — `GET /markets`, `GET /markets/:wp`, `PUT /markets/:wp`, bulk `PUT /markets`.
- `gate-levers.ts` — `GET` + `PUT` singleton.
- `market-history.ts` — `POST` (batch insert array), `GET` (filter `wp`,`good`,`since`,`limit`).
- `trade-observations.ts` — `POST` batch, `GET` filterable.
- `mine-events.ts` — `POST` batch, `GET` filterable.
- `waypoints.ts` — `GET /waypoints` (coords; read-mostly), optional `PUT` for seeding.

### 1.4 Packaging & tests
- `packages/api/Dockerfile` finalized (build `@st/shared` + `@st/api`, run `prisma migrate deploy`
  on start via entrypoint, then `node dist/server.js`).
- Wire `api` service into `docker-compose.yml` (depends_on postgres healthy; env: DATABASE_URL,
  PORT, BOT_KEY).
- **Minimal vitest** (high-signal only): `buildApp` with a test Prisma (or a transactional/sqlite-less
  approach — prefer a disposable Postgres schema or `prisma` against the compose DB in CI). Cover:
  run-stats round-trip (PUT then GET), intent create/get/delete, history batch POST then filtered GET.
  ~5–8 tests total, not exhaustive per-route.

## Contract notes (must match what the bot expects)
- **Batch endpoints** accept arrays (the bot flushes append buffers): `POST /market-history` body =
  `MarketHistoryRow[]`. Return `{ inserted: n }`.
- Singletons (`run-stats`, `gate-levers`) are upserts on a fixed id; `GET` always returns a row
  (seeded in Wave 0).
- `POST /status` stores the full snapshot JSON the bot builds in `writeStatus()` (so the dashboard can
  later read `GET /status` instead of `bot-status.json`). Keep the JSON shape identical to today's
  `bot-status.json` to ease tool migration.
- All timestamps ISO-8601; server sets `createdAt` when absent.

## Acceptance checklist
- [ ] `pnpm --filter @st/api build` compiles; `docker compose up api` serves `/health` 200.
- [ ] Each route validates input (400 on bad body) and persists/reads via Prisma.
- [ ] Batch history POST inserts N rows; filtered GET returns them.
- [ ] Targeted vitest suite green (round-trips for run-stats, intents, one history table).
- [ ] OpenAPI/Swagger optional but nice: register `@fastify/swagger` for a self-documenting surface.
