# Wave 7 — Deep-system gate charting & N-deep traversal (FOUNDATION)

**Commits:** `f95b9b0` (N-deep gate traversal via charting), `10edb67` (static gate-graph preload +
raise BFS guard 120→600), `32f3191` (seed deep outposts from nearest path-system), `7dee7a9`
(`EXPAND_MIN_MARKETS` seedWorthy threshold + gatePath skips under-construction gates + `EXPAND_RESERVE`).
**Depends on:** integration tip. **Blocks:** Waves 8, 9, 11. **Model:** heavy (graph/BFS).
**Source of truth:** `files/main-expansion-fixes.diff` + `git show origin/main:expansion.mjs`.

## Goal
Today's TS expansion can only reach **directly gate-adjacent** systems (single `jumpVia`). This wave
adds **N-deep** reach: discover the jump-gate graph by charting, BFS a multi-hop path, and hop it
gate-by-gate. This is the prerequisite for frontier mining colonies (W9) and cross-system feeders (W11).

## Port targets
New functions in legacy `expansion.mjs` (port into `expansion/expansion.ts`):
- `gateInfo(sys)` (L453) — resolve a system's own jump gate (via waypoint listing) and its
  connections (via the jump-gate endpoint); set a `readable` flag (gate charted/listable yet).
- `gatePath(from, to)` (L477) — **BFS** over the charted gate graph; guard raised to **600** nodes
  (was 120); **skip gates still UNDER_CONSTRUCTION**; returns the hop sequence.
- `followPath(sym, ship, path)` (L500) — hop-by-hop jumps along a `gatePath` result.
- `chartGate(sym, ship, sys)` (L515) — issue a CHART when a gate is uncharted/unreadable.
- `resolvePending()` (L1146) + `pendingOutposts` set — outposts whose gate wasn't reachable/charted
  yet are queued and retried (~45s) instead of dropped.
- `seedWorthy(op)` (L256) — only seed an outpost if it has ≥ `EXPAND_MIN_MARKETS` markets.
- `32f3191`: seed deep outposts from the **nearest path-system** (walk the gate path backward from
  target), not the price-spiked home yard.

## State (runtime/state.ts — additive)
- `gateGraph: Map<string, { gate?: string; conns: string[]; readable: boolean }>` — charted-graph cache.
- `pendingOutposts: Set<string>` + last-resolve timestamp.
- Preload: bundle a static `expansion/gate-graph.json` (from `10edb67`) and seed `gateGraph` at factory
  init for instant unbounded pathfinding; **fall back to live discovery** on miss. Docker: COPY the
  JSON into the bot image. **DRIFT:** note future option to move the graph behind the persistence API /
  a Prisma `GateGraph` model — keep the file for now (parity-first).

## Config (@st/shared/config.ts — additive, defaults from bot2 decl sites)
`EXPAND_MIN_MARKETS` (num, 0), `EXPAND_RESERVE` (csvSet — ships never adopted as traders, e.g. reserved
warp EXPLORERs), `EXPAND_SEED_HULLS` (num), `EXPAND_SEED_FUELED` (bool). Verify each default against
`git show origin/main:expansion.mjs | grep -n`.

## Tests (vitest — high value, pure only)
- `gatePath` BFS: shortest hop path on a fixture graph; respects the 600 guard; **skips
  under-construction gates**; returns null when unreachable. ~3–4 tests.
- `seedWorthy` threshold honored. 1 test.
- Parity shim: transcribe legacy `gatePath` into `legacy-shims.ts` and assert TS == shim on a fixture
  graph (sanctioned option (a); legacy self-executes on import).

## Acceptance
- [ ] `EXPAND_*` new flags inert by default → expansion byte-for-byte unchanged when unset.
- [ ] gate-graph preload loads at init, live fallback on cache miss.
- [ ] BFS + followPath + chartGate + pending/resolve ported with `bot2.mjs:Lxxx` comments.
- [ ] `pnpm --filter @st/bot build` clean; new vitest green; root `pnpm lint` 0.
- [ ] DRIFT entries for the gate-graph-file→API future option + any behavioral deviation.
