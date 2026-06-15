# Wave 5 — Expansion subsystem + main() wiring + bot Docker + end-to-end

**Depends on:** Wave 4 (subsystems) + Wave 1 (API live). **Blocks:** Wave 6. **Suggested model:**
heavier reasoning model. **Base branch:** integration branch after Wave 4.

## Goal
Port the inter-system expansion subsystem, wire the full `main()` orchestration, containerize the bot,
and prove the whole stack runs together (postgres + api + bot) end-to-end.

## Tasks

### 5.1 Expansion port — `expansion/` (port of `expansion.mjs`, 699 LOC)
- `createExpansion(deps)` factory taking injected closures (api, log, navigate/refuel/buy/sell/jump/
  getShip, coords/D/chooseMode/planRoute/record, gate accessors, credits/reserve/markets, launchWorker,
  getShipyards, buyShip, negotiator). Mirror the exact dependency object built in `bot2.mjs` main()
  (~L3180–3196).
- Members: `isMember`, `step` (drives migrated ships' cross-system arbitrage/scouting), residency
  pinning (`residency.json` → persistence client / DB), `setupOutposts`, `EXPAND_AUTOBUY` fleet
  auto-buy (floor-guarded, lifetime-capped, one/interval), probe partition (`partitionMarkets` —
  **pure, unit-test it**), `jumpShip` orchestration, `statusBlock()`.
- All behind `AUTO_EXPAND` / `EXPAND_AUTOBUY` / `MULTI_SYSTEM` flags (default OFF) — inert in the
  single-system live config.
- **Vitest (high value, pure):** `partitionMarkets` produces disjoint, balanced, full-coverage arcs;
  converges to 1:1 when N==M. ~4 tests.

### 5.2 `main.ts` — full orchestration
Port `bot2.mjs` main() faithfully:
- Boot: clear stop signal, refresh credits, recompute reserve, load markets (from API), compute
  dynamic expansion target, discover active contract **before** workers (salvage guard), classify
  traders (cargo>0, not probe, fuel>0), `fleetMaxSpeed`/`fleetSize`, initial phase log.
- Build expansion (if `AUTO_EXPAND`) with the dependency object.
- Launch supervised trade workers + managers: `contractManager`, `targetWatch`, `fleetTable`
  (route capture for status), `mineExpandManager`, `mineMigrateManager`, `fleetScaleManager`,
  stop watcher. `Promise.all` to keep alive. Final run-net log.
- `launchWorker`/`launchedWorkers` dedupe (so MINE_EXPAND/expansion don't double-spawn).
- `targetWatch`: 30s cadence — refresh credits/reserve/goal/phase + gate status; **done** check only
  when gate status known and not (unbuilt & GATE_SUPPLY on).

### 5.3 Bot Docker + compose
- `packages/bot/Dockerfile` (multi-stage: build `@st/shared`+`@st/bot`, runtime node:20-alpine).
- Compose: `bot` service depends_on `api` healthy; env: `SPACETRADERS_PLAYER_AGENT_TOKEN`, `API_BASE_URL`,
  `BOT_KEY`, plus the operator flag profile via `env_file`. `restart: unless-stopped`.
- A documented operator `env_file` template reproducing the live launch profile (MIN_NET=1200,
  GATE_CREDIT_FLOOR=900000, GATE_HAULERS=12,13, MINE_FEED=1, MINE_TRANSPORT=14,29, etc.) — as an
  example file, NOT as code defaults.

### 5.4 Offline / dry-run smoke
- Add a `DRY_RUN`/replay capability (no real SpaceTraders mutations, or a recorded-fixtures mode) so
  the full stack can be smoke-tested in CI/compose without touching the live agent. At minimum: bot
  boots, connects to API, loads markets/run-stats, logs a planned phase + lanes, and writes a status
  snapshot — without executing buys. Keep it behind a flag; the real run path is unchanged.

## Acceptance checklist
- [ ] `docker compose up` brings up postgres → api (healthy) → bot; bot boots, reads state from API,
      writes a status snapshot to the DB.
- [ ] Expansion subsystem compiles + is inert with flags OFF; `partitionMarkets` vitest green.
- [ ] `main()` launches all managers; STOP/SIGTERM drains gracefully.
- [ ] Full `tsc -b` + lint clean across all three packages.
- [ ] With real token + flags (operator-run, not in CI), a short live run trades + persists exactly as
      the legacy bot would (spot-check status snapshot fields vs legacy `bot-status.json`).
