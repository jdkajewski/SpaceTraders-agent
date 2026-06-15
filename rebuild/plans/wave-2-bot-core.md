# Wave 2 — Bot core libraries

**Depends on:** Wave 0 (`@st/shared`). **Blocks:** Wave 3. **Suggested model:** heavier reasoning model
for routing; mid-tier for clients. **Base branch:** integration branch after Wave 0.
Internally parallelizable (2.1–2.5 are mostly independent; agree interfaces first).

## Goal
Port the foundational, mostly-stateless bot libraries to TS: the SpaceTraders client, the persistence
client (bot → Fastify), ship actions, routing/flight math, and the markets cache. These have the
clearest unit-test value.

## Tasks

### 2.1 SpaceTraders client — `clients/spacetraders.ts` (port of `st.mjs`)
- Module-global **token bucket** (CAPACITY 2, REFILL 2/s) + `blockedUntil` (429 `retryAfter`).
- `api(method, path, body)` with: 429 pause-all, **network-error capped exponential backoff** (8
  tries, `min(15s, 500·2^n)`), **5xx/408** 4 retries, **structured error** tags (`.status`,`.code`,
  `.data`,`.network`).
- `getAllShips()`, `getAllContracts()` (pagination), `reqStats()`.
- Token from `SPACETRADERS_PLAYER_AGENT_TOKEN`.
- **Vitest:** token-bucket pacing (fake timers — N calls take ≥ expected time), backoff schedule,
  error tagging (mock `fetch`). ~4–6 tests.

### 2.2 Persistence client — `clients/persistence.ts` (NEW)
- Typed wrapper over the Fastify API (`@st/shared` types). Methods mirror the API surface:
  `getRunStats/putRunStats`, `getIntents/putIntent/deleteIntent`, `postStatus`,
  `getMarkets/putMarkets`, `getGateLevers/putGateLevers`, `appendMarketHistory(rows[])`,
  `appendTradeObservations(rows[])`, `appendMineEvents(rows[])`, `getWaypoints`.
- **Resilience:** history/status/markets writes are **fire-and-forget with retry + drop-on-fail**
  (never block a trade on telemetry). `getRunStats`/intents are **critical**: see crash-safety
  fallback in `recovery.ts` (Wave 3/4) — this client exposes a `local` write-through hook for those
  two. Use the same base URL + optional `x-bot-key` header from config.
- Small internal queue/batcher for append endpoints (flush on size/time) to match the JSONL append
  cadence without spamming the API.

### 2.3 Ship actions — `trade/shipActions.ts` (port of `trade.mjs`)
- `navigate` (refuel-first, BURN→CRUISE→DRIFT downgrade ladder, idempotent "already at destination"
  400, `waitArrival`), `buy` (slippage/tradeVolume loop, maxPx stop), `sell` (per-symbol/ALL),
  `refuel`, `transfer(fromSym,toSym,symbol,units)` **[RULE: transfer-argorder]**, `deliver`,
  `fulfill`, `jump` (orbit, antimatter cost, cooldown), `getShip`, `ensureDocked/ensureOrbit/setMode`.
- Keep the `[RULE: idempotent-nav]` and fuel-downgrade comments verbatim.
- Uses `clients/spacetraders.ts`. No persistence here.
- **Vitest:** light — the navigate downgrade-ladder decision and idempotent-400 handling with a
  mocked client. Don't over-test API plumbing.

### 2.4 Routing/flight — `routing/flight.ts` + `routing/route.ts`
- `flight.ts`: `TIME_FACTOR`, `legFuel`, `legTime`, `computeFuelPx`, `chooseMode` (cheapest feasible
  mode by `fuel*FUEL_PX + time*VALUE_OF_TIME`, 97% tank margin, probes free).
- `route.ts`: `marketSellsFuel`, `fuelNodes`, `planRoute` (Dijkstra over fuel nodes, ≤1-tank hops,
  minimize CRUISE time), `planRouteFuelCargo` (any-arrival refuel, minimize hops), `routeCost`
  (same router for lane scoring). `FUEL_PX`/`VALUE_OF_TIME` injected, not module-global.
- **Vitest (high value):** `chooseMode` picks correct mode across fuel/speed/distance cases;
  `planRoute` finds a multi-hop path and returns `1e9`/unreachable correctly; `routeCost` monotonic
  with distance. ~6–8 tests. This is the math most worth pinning.

### 2.5 Markets — `market/markets.ts`
- `getMarkets()` cache with `MARKET_TTL_MS`, single-flight `refreshing` dedupe; on refresh: update
  `FUEL_PX` (median), **PUT markets to the persistence client** (replaces `markets.json` write),
  `appendMarketHistory` via client (replaces JSONL), `updateBaselines`, `goodMargins`.
- Boot read: load last market snapshot from the API instead of `markets.json`.
- Holds shared market cache state (move into `runtime/state.ts` in Wave 3 if cleaner).
- **Vitest:** `computeFuelPx` median logic; baseline/margin update. ~3 tests.

## Interface agreement (do this first)
Define and commit the TS interfaces for: `SpaceTradersClient`, `PersistenceClient`, `ShipActions`,
`Router` (`planRoute`/`routeCost`/`chooseMode`), `MarketsService`. Waves 3–5 depend on these shapes.

## Acceptance checklist
- [ ] `pnpm --filter @st/bot build` compiles these modules with `@st/shared` types.
- [ ] Token-bucket + routing vitest suites green.
- [ ] Persistence client compiles against the Wave 1 route contracts (shared request/response types).
- [ ] No `fs` reads/writes in these modules (markets persistence goes through the API client).
