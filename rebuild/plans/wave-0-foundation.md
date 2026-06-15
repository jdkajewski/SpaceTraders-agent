# Wave 0 — Foundation (monorepo, shared, Prisma, Docker base)

**Depends on:** nothing. **Blocks:** everything. **Suggested model:** mid-tier coding model.
**Base branch:** `jdkajewski/ts-rewrite-plan`.

## Goal
Stand up the empty-but-wired monorepo: workspaces, shared types + zod config, Prisma schema +
Postgres, and the Docker baseline. No bot/API logic yet — just the skeleton everything else builds on.

## Tasks

### 0.1 Monorepo scaffold
- Root `package.json` with pnpm `workspaces: ["packages/*"]`, `"type":"module"`, root scripts
  (`build`, `lint`, `test`, `typecheck`) that fan out to packages.
- `pnpm-workspace.yaml`.
- `tsconfig.base.json` (strict, `NodeNext`, `target ES2022`, `composite: true`, declaration maps).
- ESLint (typescript-eslint flat config) + Prettier + `.editorconfig`. Keep minimal.
- Root `vitest.config.ts` (workspace mode) — projects discover `packages/*/vitest.config.ts`.
- `.gitignore` additions (`dist/`, `node_modules/`, `.env`, prisma generated client).
- `.env.example` enumerating env vars (DB URL, ST token, API base URL, key bot flags).

### 0.2 `packages/shared` (`@st/shared`)
- `tsconfig.json` (extends base, composite).
- `src/config.ts` — a **zod schema** parsing all ~106 env flags from `bot2.mjs`, grouped by subsystem
  (core-trade, ride-along, phase/budget, gate, contracts, input-feed, mining, repair, fleet-scale,
  expansion, ops). Use the **code defaults** from `bot2.mjs`, and the boolean idioms
  (`X !== '0'` default-on, `X === '1'` default-off). Export `loadConfig(env): Config` + `Config` type.
  Source the defaults by reading the top of `bot2.mjs` (lines ~22–298) — enumerate exhaustively.
- `src/types.ts` — domain types: `Ship`, `Market`, `MarketGood`, `Lane`, `RideAlong`, `Intent`,
  `GateState`, `GateLevers`, `ContractInfo`, `Phase`, `StatusSnapshot`, `PerShip`, `Survey`,
  `MineEvent`, `TradeObservation`, `MarketHistoryRow`. (SpaceTraders response shapes can be partial
  interfaces — only fields the bot uses.)
- `src/coords.ts` — parse `coords.csv` → `Record<wp,[x,y]>`; export `distance(a,b)` (the `D()` fn,
  returns `1e9` cross-system). Allow loading from a path or a passed-in CSV string (testable).
- `src/constants.ts` — `SYSTEM` default, `TIME_FACTOR`, gate material list, etc.
- Barrel `src/index.ts`.

### 0.3 Prisma schema (`packages/api/prisma/` — schema lives with the API package)
- `schema.prisma`: datasource postgres, generator client. Models per MASTER-PLAN §3:
  `RunStats` (singleton, fixed id), `Intent` (`shipSym` PK, `extras Json`), `StatusSnapshot`
  (`id`, `createdAt`, `data Json` + denormalized phase/runNet/credits for querying), `MarketSnapshot`
  (`waypoint` PK, `data Json`, `updatedAt`), `MarketHistory`, `TradeObservation`, `MineEvent`
  (indexes on `createdAt`, plus `waypoint`/`good`/`shipSym` where queried), `GateLevers` (singleton),
  `Waypoint` (`symbol` PK, `x`, `y`). Optional `FuelNodes`.
- Initial migration (`prisma migrate dev --name init`) — runnable against the compose Postgres.
- A seed script (`prisma/seed.ts`) that loads `coords.csv` into `Waypoint` and inserts singleton rows
  (`RunStats {0,0}`, default `GateLevers`).

### 0.4 Docker baseline
- `docker-compose.yml` with a `postgres:16` service (named volume, healthcheck, env from `.env`).
- Placeholder `packages/api/Dockerfile` and `packages/bot/Dockerfile` (multi-stage node:20-alpine,
  pnpm, build → runtime) — can be finalized in Waves 1/5 but commit the skeleton now.
- A `Makefile` or root scripts: `db:up`, `db:migrate`, `db:seed`.

## Acceptance checklist
- [ ] `pnpm install` succeeds at root; `pnpm -r build` compiles `@st/shared` (api/bot may be empty stubs).
- [ ] `docker compose up postgres` healthy; `pnpm db:migrate && pnpm db:seed` populates Waypoints + singletons.
- [ ] `loadConfig` parses an empty env to all code defaults; a couple of vitest cases pin tricky flags
      (boolean idioms, `INPUT_FEED_MAX` clamp ≤2, `GATE_CREDIT_RESUME` derive-from-gap).
- [ ] `@st/shared` exports types consumed by a trivial import in api/bot stubs.

## Notes for the implementer
- Enumerate env flags from `bot2.mjs` top matter exhaustively — `grep -oE "process\.env\.[A-Z_]+" bot2.mjs | sort -u`
  yields ~106; cross-check each default and idiom against its declaration line.
- Do NOT bake operator live-launch values as defaults (see MASTER-PLAN §6.3).
