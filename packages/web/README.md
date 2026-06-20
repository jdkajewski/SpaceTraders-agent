# @st/web — Galaxy Map

Interactive node + edge visualization of the SpaceTraders jump-gate network crawled
by the galaxy crawler. Systems are nodes, gate connections are edges, and market
**richness** drives the visual weight — so you can see at a glance where home is,
what's reachable, where the rich markets are, and what's still gated off.

## Stack

- **[sigma.js](https://www.sigmajs.org/) v3 + [graphology](https://graphology.github.io/)** —
  WebGL rendering that stays smooth at 500+ nodes with pan/zoom.
- Real `x,y` coordinates when the crawler knows them; **force-directed fallback**
  (`graphology-layout-forceatlas2`) when any system lacks coordinates.
- Plain **TypeScript + Vite** (no framework) so every source file is `.ts` and is
  covered by the repo's existing eslint + tsc + vitest tooling.
- Types come from `@st/shared` (the galaxy DTOs); nothing is redefined.

## Data contract

The app reads the galaxy API (Fastify + Prisma) and merges two endpoints:

| Endpoint | Used for |
| --- | --- |
| `GET /galaxy/graph` | systems (nodes) + gate edges (topology) |
| `GET /galaxy/ranked?limit=500` | per-system `score` + premium-ship flags |
| `GET /galaxy/system/:sym` | click-through detail panel |

> **Note:** `/galaxy/graph` does **not** carry a per-node `score` (score lives in
> `SystemRichness`), so scores are pulled from `/galaxy/ranked` and merged
> client-side by `symbol`. Systems without a richness row score `0`.

## Visual encodings

- **Node size + colour** → richness `score` (cool/dim → gold as richness rises).
- **Home** system → bright cyan, always emphasized.
- **Unreachable** systems (no all-built gate path from home) → de-emphasized.
- **Edges** → solid/bright when `traversable` (both gate ends built), faint/thin
  when not yet jumpable.
- **Shade by hops** toggle → recolour reachable nodes by `hopsFromHome`.
- Click a node (or a row in the **Top systems** panel) → focus it + load its detail
  panel (richness breakdown, gate state, edges in/out, premium ships).

## Develop

The viz needs the galaxy API running. From the repo root:

```bash
pnpm db:up                              # Postgres (docker compose)
pnpm db:migrate                         # apply Prisma schema
pnpm --filter @st/api dev               # API on :3000

# Seed fixture data so the map has something to show before a real crawl:
pnpm --filter @st/web seed:fixtures     # bulk-PUTs systems/edges/richness

pnpm --filter @st/web dev               # Vite dev server on :5173
```

The dev server proxies `/galaxy` (and `/docs`) to `http://localhost:3000`
(override with `VITE_API_PROXY_TARGET`), so no CORS config is needed on the API.

### Scripts

| Script | Purpose |
| --- | --- |
| `dev` | Vite dev server (with API proxy) |
| `build` | Production bundle to `dist/` |
| `preview` | Preview the production build |
| `typecheck` | `tsc --noEmit` |
| `test` | Vitest (pure graph-model logic) |
| `seed:fixtures` | Seed the galaxy API with dev fixture data |

A production build can point at an absolute API origin via `VITE_API_BASE`.
