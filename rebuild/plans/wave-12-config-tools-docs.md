# Wave 12 — Operator config + diagnostic tooling + docs + DRIFT-LOG + final verify

**Commits:** `9fbc2d3` (tune expansion config for deep rich-market run + `seed-relay.mjs`), plus the
diagnostic tools introduced in `10edb67` (`gate-graph-dump.mjs`, `reach-check.mjs`).
**Depends on:** Waves 7–11 (consolidates all new flags). **Blocks:** none (final). **Model:** standard/light.

## Goal
Close out the expansion port: reflect the operator profile, port the diagnostic tooling (or document
as deferred), refresh docs, finalize the DRIFT-LOG, and verify the whole stack.

## Tasks
### 12.1 Operator profile → `deploy/bot.env.example` (NOT code defaults)
Reflect the live `.relaunch-uprising.sh` profile (`9fbc2d3` + range diff). Key operator values (example,
not defaults):
- Gate: `GATE_CREDIT_FLOOR=800000 GATE_CREDIT_RESUME=900000 GATE_AUTO_FINISH=0
  GATE_MAX_PRICE="FAB_MATS:1600,ADVANCED_CIRCUITRY:8500" GATE_RESUME_PRICE="FAB_MATS:1200,ADVANCED_CIRCUITRY:8200"`.
- Expansion: `AUTO_EXPAND=1 EXPAND_TARGET_SYSTEM=X1-YK2`, the full `EXPAND_OUTPOSTS=…` (34 systems),
  `EXPAND_MIN_MARKETS=0 EXPAND_RECALL=0 EXPAND_RECALL_RELEASE=1500000 EXPAND_CREDIT_FLOOR=300000
  EXPAND_AUTOBUY=1 EXPAND_BUY_FLOOR=1500000 EXPAND_MAX_BUY_TRADERS=90 EXPAND_MAX_BUY_PROBES=120
  EXPAND_TRADERS_PER_SYS=… EXPAND_MAX_PROBE_PRICE=50000 EXPAND_MAX_TRADER_PRICE=400000
  EXPAND_AUTOBUY_MS=12000 EXPAND_SCAN_TTL_MS=240000 EXPAND_RESERVE=UPRISING-D8,UPRISING-D9`.
- Chain-feed: `CHAIN_FEED=1 FEEDER_SHIPS=UPRISING-8F FEED_PREFER_MINED=1 FEED_MIN_MARGIN_PCT=25
  FEED_SATURATION_N=2`.
- Mining colony (disabled in this profile): `EXPAND_MINE= EXPAND_MINE_SURVEYORS=0 EXPAND_MINE_HAULERS=0
  EXPAND_MINE_DRONES=0 EXPAND_MAX_BUY_DRONES=0`.
Annotate each as an **example operator profile**, with code defaults still inert.

### 12.2 Diagnostic tooling (decide: port vs defer)
- `seed-relay.mjs` — relay-seed deep systems (preload pathing). `gate-graph-dump.mjs` — dump the
  charted gate graph to `gate-graph.json` (produces the W7 preload asset). `reach-check.mjs` — report
  which systems are reachable.
- **Option A (port):** TS one-shot scripts under `packages/bot/src/tools/`, run via `node dist/tools/…`
  using the shared client + config. `gate-graph-dump` should write the same `expansion/gate-graph.json`
  W7 consumes (closes the loop).
- **Option B (defer):** document under "future tooling follow-up" in the README (consistent with the
  Wave-6 monitor-tooling deferral). Pick by remaining effort; if deferring, still document how to
  regenerate `gate-graph.json`.

### 12.3 Docs
- `docs/09-ts-rebuild.md`: add a "Deep expansion (Waves 7–11)" section (gate charting, mining
  colonies, recall, chain-feed) + the new flag table. Root README: new operator knobs.

### 12.4 DRIFT-LOG + plan
- Append all DRIFT entries discovered in W7–W11 (gate-graph-file vs API, waitArrival mechanism,
  sell-cap ownership, any default mismatches). Update the header "Post-Wave-6" paragraph.
- Update `rebuild/MASTER-PLAN.md` + session `plan.md` with the expansion-port completion summary.

### 12.5 Final integration verify
- `pnpm --filter @st/api prisma:generate` (fresh worktree) → `pnpm -r build` → `pnpm -r typecheck` →
  `pnpm test` → `pnpm lint` all green.
- `docker compose config` valid; (optional) `docker compose up` smoke: postgres→api(healthy)→bot
  boots DRY_RUN, writes a StatusSnapshot, `GET /status` returns legacy-shaped data, with all new
  flags inert by default.

## Acceptance
- [ ] env-example reflects the operator profile; code defaults still inert. [ ] tools ported or
  deferral documented. [ ] docs + DRIFT-LOG + plans updated. [ ] full build/typecheck/test/lint green;
  compose valid. [ ] Open a PR `jdkajewski/ts-rewrite-plan` → `main` when the user wants.
