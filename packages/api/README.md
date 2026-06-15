# @st/api — persistence service

The Fastify + Prisma/Postgres service that is the bot's **only** datastore. It replaces every file the
legacy `bot2.mjs` wrote to disk (`run-stats.json`, `intents.json`, `bot-status.json`, `markets.json`,
`*-history.jsonl`, `gate-levers.json`) with HTTP endpoints, so the bot holds no durable local state of
its own (beyond the crash-safety write-through cache — see the [bot README](../bot/README.md)).

## Run it

```bash
# from the repo root
pnpm install
pnpm --filter @st/api prisma:generate     # REQUIRED — the Prisma client is gitignored
pnpm db:up                                # start Postgres (docker compose)
pnpm db:migrate                           # apply migrations
pnpm db:seed                              # seed waypoints from coords.csv

pnpm --filter @st/api dev                 # tsx watch (hot reload)
#   or, built:
pnpm --filter @st/api build && pnpm --filter @st/api start
```

Under Docker the api is built and started for you by `docker compose up` (it waits for Postgres to be
healthy, runs migrations, then serves on `:3000`).

### Config

Sourced from `@st/shared` (`loadConfig(process.env)`): `DATABASE_URL`, `API_PORT` (default 3000),
`API_HOST`, and optional bot-auth `BOT_KEY` + `BOT_AUTH_ENABLED`. When auth is enabled, bot→api writes
must carry the `x-bot-key` header.

## Interactive docs — Swagger UI

With the server running, the full OpenAPI surface (every route, schema, and example) is served at:

> **<http://localhost:3000/docs>**

Each route is declared with a TypeBox schema, so the Swagger page is generated from the same types the
handlers validate against.

## Route reference

All routes are autoloaded from `src/routes/`. Critical records (run-stats, intents) are read by the bot
on boot and written through from a local cache; telemetry/history endpoints are append-only.

| Method | Path | Purpose | Replaces (legacy) |
|---|---|---|---|
| `GET` | `/health` | Liveness probe (used by the compose healthcheck). | — |
| `GET` | `/run-stats` | Latest run accounting (`totalNet`, `lanesRun`, `updatedAt`). | `run-stats.json` |
| `PUT` | `/run-stats` | Upsert run accounting. | `run-stats.json` |
| `GET` | `/intents` | All open haul intents (crash-resume state). | `intents.json` |
| `GET` | `/intents/:ship` | One ship's intent. | `intents.json` |
| `PUT` | `/intents/:ship` | Upsert a ship's intent. | `intents.json` |
| `DELETE` | `/intents/:ship` | Clear a ship's intent (on sell/abort). | `intents.json` |
| `POST` | `/status` | Write the live status snapshot (legacy `bot-status.json` shape rides in `data`). | `bot-status.json` |
| `GET` | `/status` | Read the latest status snapshot (for monitors/dashboards). | `bot-status.json` |
| `GET` | `/markets` | Latest market snapshot for all known waypoints. | `markets.json` |
| `GET` | `/markets/:wp` | Latest snapshot for one waypoint. | `markets.json` |
| `PUT` | `/markets/:wp` | Upsert one waypoint's market. | `markets.json` |
| `PUT` | `/markets` | Bulk-replace the market snapshot. | `markets.json` |
| `GET` | `/gate-levers` | Current operator credit-band (`floor`/`resume`). | `gate-levers.json` |
| `PUT` | `/gate-levers` | Set the credit-band (live operator control; the bot polls this). | `gate-levers.json` |
| `POST` | `/market-history` | Append market-history rows (batched). | `market-history.jsonl` |
| `GET` | `/market-history` | Query market-history rows. | `market-history.jsonl` |
| `POST` | `/trade-observations` | Append trade-observation rows (batched). | `trade-observations.jsonl` |
| `GET` | `/trade-observations` | Query trade-observation rows. | `trade-observations.jsonl` |
| `POST` | `/mine-events` | Append mine-event rows (batched). | `mine-history.jsonl` |
| `GET` | `/mine-events` | Query mine-event rows. | `mine-history.jsonl` |
| `GET` | `/waypoints` | Seeded waypoint coordinates. | `coords.csv` |

> The authoritative request/response schemas are on the Swagger page (`/docs`) — this table is the map,
> not the contract.

## Tests

```bash
pnpm --filter @st/api test
```

## Architecture

See [`docs/09-ts-rebuild.md`](../../docs/09-ts-rebuild.md) §3 for how the api fits the monorepo, and
[`rebuild/DRIFT-LOG.md`](../../rebuild/DRIFT-LOG.md) for the persistence-related drift decisions
(#12 Prisma JSON null, #13 generated-client path, #20 status snapshot shape).
