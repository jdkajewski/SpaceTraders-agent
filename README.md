# SpaceTraders-agent

A headless, continuously-running autotrader for [SpaceTraders](https://spacetraders.io).
It drives a single agent through the **greenfield → jump-gate → seed-next-system** playbook:
maximize per-lane trading profit while building the system's jump gate, with mining, contracts,
input-feeding, and opportunistic gate supply running as cooperating loops.

> **As of the TypeScript rebuild (Waves 0–6), the canonical stack is the TS monorepo under
> [`packages/`](packages/).** The original single-file `bot2.mjs` and its monitors are archived under
> [`legacy/`](legacy/) and are used only as the parity reference for the test harness. New architecture:
> **[`docs/09-ts-rebuild.md`](docs/09-ts-rebuild.md)**.

## Monorepo layout

```
packages/shared   @st/shared  — config (zod), domain types, constants, coords/distance. No I/O.
packages/api      @st/api     — Fastify + Prisma/Postgres persistence service (the bot's datastore).
packages/bot      @st/bot     — the trading/expansion bot; talks to the game API + @st/api over HTTP.
docs/                          — guided documentation set (01–09).
rebuild/                       — MASTER-PLAN.md, per-wave specs, DRIFT-LOG.md.
legacy/                        — archived legacy .mjs (bot2/st/trade/expansion + monitors).
deploy/bot.env.example         — operator launch profile for the bot service.
docker-compose.yml             — postgres → api (healthcheck) → bot.
coords.csv                     — waypoint coordinate seed (consumed by the api Docker seed).
```

Package READMEs: **[api](packages/api/README.md)** (route reference + Swagger) ·
**[bot](packages/bot/README.md)** (module map, flags, DRY_RUN, live spot-check).

## Quick start (Docker — the canonical run path)

```bash
docker compose up --build
```

That brings up **postgres → api (waits for healthy) → bot**. With no `deploy/bot.env` present the bot
boots in **`DRY_RUN=1`**: it makes **no live game calls and needs no token**, so this smoke-tests the
whole stack out of the box. The API serves interactive route docs at <http://localhost:3000/docs>.

To run **live**, supply the operator profile and a real token:

```bash
cp deploy/bot.env.example deploy/bot.env
#   edit deploy/bot.env: paste SPACETRADERS_PLAYER_AGENT_TOKEN, set DRY_RUN=0
docker compose up --build
```

`docker-compose.yml` loads `./deploy/bot.env` if present (`env_file` `required: false`).

## Local development (pnpm)

```bash
pnpm install
pnpm --filter @st/api prisma:generate     # REQUIRED first — the Prisma client is gitignored
pnpm -r build                             # build all three packages (project references)
pnpm -r typecheck
pnpm test                                 # vitest workspace (parity, crash-safety, unit)
pnpm lint
```

> **Gotcha:** in a fresh checkout you **must** run `pnpm --filter @st/api prisma:generate` before any
> `build`/`typecheck`, or you get `Cannot find module '../generated/prisma/index.js'`.

### Database (Postgres via Prisma)

```bash
pnpm db:up          # docker compose up postgres -d
pnpm db:migrate     # prisma migrate dev   (@st/api)
pnpm db:seed        # seed waypoints from coords.csv
pnpm db:studio      # Prisma Studio
```

### Run the services locally

```bash
# API (needs DATABASE_URL; defaults to the compose Postgres):
pnpm --filter @st/api start         # or: pnpm --filter @st/api dev   (tsx watch)

# Bot (needs API_BASE_URL + SPACETRADERS_PLAYER_AGENT_TOKEN for a live run, or DRY_RUN=1):
pnpm --filter @st/bot start         # node dist/main.js
```

## Configuration & flags

Every operator flag is a field on the `@st/shared` config schema
([`packages/shared/src/config.ts`](packages/shared/src/config.ts)); `loadConfig(process.env)` is the
**single** env entry point. The catalogue lives in
[`docs/05-config-reference.md`](docs/05-config-reference.md); the ready-to-edit launch profile is
[`deploy/bot.env.example`](deploy/bot.env.example).

Key connection vars: `SPACETRADERS_PLAYER_AGENT_TOKEN` (live token — read only from env, never stored),
`API_BASE_URL`, `BOT_KEY`/`BOT_AUTH_ENABLED` (optional `x-bot-key` auth), `SYSTEM`, `DRY_RUN`.

## Graceful stop

The bot replaces the legacy `touch STOP` file with **signal handlers**: `SIGTERM`/`SIGINT` set
`state.stop`, and each ship worker finishes its in-flight action then exits (no half-completed trades).
So `docker compose stop` / `Ctrl-C` / `kill -TERM` all drain cleanly. For environments that can't signal,
set `STOP_POLL=1` and the bot also polls `STOP=1` from the env as a fallback trip.

## Documentation

**Start here → [`docs/README.md`](docs/README.md).** Highlights:

- **[01 — Strategy](docs/01-strategy.md)**, **[02 — Architecture](docs/02-architecture.md)**,
  **[03 — Subsystems](docs/03-subsystems.md)**, **[04 — Optimizations](docs/04-optimizations-and-tricks.md)**,
  **[05 — Config reference](docs/05-config-reference.md)**, **[06 — Tooling](docs/06-tooling.md)**.
- **[07 — Doc drift](docs/07-doc-drift.md):** where older notes disagree with the code (and the W6 banner
  on the legacy→TS move).
- **[08 — Expansion](docs/08-expansion.md):** the multi-system roadmap.
- **[09 — TS rebuild](docs/09-ts-rebuild.md):** the monorepo architecture, persistence/crash-safety flow,
  parity harness, and run paths.

Docs 01–08 describe the legacy `bot2.mjs` behaviour, which the TS port preserves (parity-first); every
intentional divergence is logged and resolved in [`rebuild/DRIFT-LOG.md`](rebuild/DRIFT-LOG.md).
