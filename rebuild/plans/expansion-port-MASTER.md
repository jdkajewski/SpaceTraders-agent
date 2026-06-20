# Expansion-port master plan (Waves 7–12)

**Source:** 17 commits on `origin/main` (range `24cd54d..9fbc2d3`) — the post-competition deep-system
expansion evolution made against **legacy** `expansion.mjs` (699 → 1576 LOC, +877), plus smaller
touches to `bot2.mjs`, `trade.mjs`, operator `.relaunch-uprising.sh`, and three new standalone tool
scripts.

**Authoritative diff artifact:** session `files/main-expansion-fixes.diff` (1601 lines;
`git diff 24cd54d origin/main -- expansion.mjs bot2.mjs trade.mjs .relaunch-uprising.sh`). Re-derive
any time with that command against `origin/main`.

**Port target (TS):** `packages/bot/src/expansion/expansion.ts` (current 1279 LOC, the Wave-5 port of
the 699-LOC legacy), plus `runtime/state.ts` (new expansion state slices), `@st/shared/config.ts`
(~23 new flags), `trade/shipActions.ts` (`waitArrival`), `worker.ts` + `main.ts` (migration guards +
negotiator), and `deploy/bot.env.example` (operator profile).

**Convention reminder (all waves):**
- Config gets bot2 **code declaration-time defaults** (mostly OFF/inert), NOT operator
  `.relaunch-uprising.sh` live values. Operator values → `deploy/bot.env.example` only.
- `@st/shared/config.ts` idioms: `boolOn` = `!== '0'` (default-on), `boolOff` = `=== '1'`
  (default-off); helpers `num`, `csvSet`, `kvMap`. Keep additive (don't touch existing fields).
- Preserve `bot2.mjs:Lxxx` / `[RULE:*]` reference comments; every behavioral deviation → a new
  `rebuild/DRIFT-LOG.md` entry (#39+).
- Each subsystem stays behind its env flag and is **byte-for-byte inert when the flag is unset**
  (legacy parity), exactly like Waves 4–5.
- "Apply" = **port the behavior into TS**, never `git merge origin/main` (legacy lives in `legacy/`
  on this branch and is not the live code path).

## Commit → wave map

| Wave | Commits | Theme |
|------|---------|-------|
| **7** | `f95b9b0` `10edb67` `32f3191` `7dee7a9` | Deep-system gate charting & N-deep traversal (foundation) |
| **8** | `ceb0975` `5957b46` `4d79e3b`(migrate) `6f0d9cc` `7e5494a` + anchorBuy(`b9812e1`) | Autobuy overhaul: single-snapshot tick, local-first buys, anchors, per-system traders, hub probes, migration 400 guards, negotiator fix |
| **9** | `b9812e1` `ab9ec55` `0a08d69` `6d41644` | Mining colonies (park-and-ferry: surveyor + drones + haulers) + stray recovery |
| **10** | `809ed06` `f9bdebe` | RECALL / RECALL_RELEASE consolidation modes |
| **11** | `9700356` | Chain-Feed bulk freighter + API-budget reclaim + adaptive scan TTL |
| **12** | `9fbc2d3` + tools (`seed-relay`/`gate-graph-dump`/`reach-check`) | Operator config → bot.env.example, diagnostic tooling, docs, DRIFT-LOG, final verify |

(Commits that span two themes are split: `b9812e1` base mining colony lands in Wave 9, its
`anchorBuy` local-buy primitive lands in Wave 8 because Wave 9 depends on it. `4d79e3b` migrate-stray
in Wave 8, its mining-local-autobuy in Wave 9.)

## Dependency / parallelization

```
Wave 7 (foundation: reach deep systems)
  ├─► Wave 8 (autobuy + anchors + guards)  ──► Wave 9 (mining colonies) ──► Wave 10 (recall, exempts mines)
  └─► Wave 11 (chain-feed, needs cross-system reach)         │
                                                             ▼
                                              Wave 12 (config + tools + docs + verify)  [last]
```

- **Serial spine:** 7 → 8 → 9. **Wave 11** can run in parallel with 8/9 (only needs 7's reach).
  **Wave 10** after 9 (recall exempts mine systems). **Wave 12** strictly last (consolidates all
  flags into the env-example + verifies the full stack).

## Suggested model sizing (per the "thinking-LLM plan, right-sized-LLM build" rule)
- Each wave sub-session opens in **plan mode** (thinking model — Opus/heavy) to expand its spec from
  the legacy diff, then implements with the sized model below.
- W7 mining/graph BFS, W9 colonies, W11 feeder: **heavy** (Sonnet high / Opus).
- W8 autobuy, W10 recall: **standard** (Sonnet).
- W12 config/tools/docs: **standard/light**.

## New config flags introduced (by wave) — all additive, default inert
- **W7:** `EXPAND_MIN_MARKETS` (num, def 0), `EXPAND_RESERVE` (csvSet), `EXPAND_SEED_HULLS` (num),
  `EXPAND_SEED_FUELED` (bool).
- **W8:** `EXPAND_TRADERS_PER_SYS` (kvMap sys→n), `EXPAND_MAX_PROBE_PRICE` (num),
  `EXPAND_MAX_TRADER_PRICE` (num), `EXPAND_MAX_BUY_DRONES` (num).
- **W9:** `EXPAND_MINE` (csvSet), `EXPAND_MINE_SURVEYORS`/`_HAULERS`/`_DRONES` (num, def 1/2/6),
  `EXPAND_MINE_SURVEYOR_TYPE`/`_HAUL_TYPE`/`_DRONE_TYPE` (str).
- **W10:** `EXPAND_RECALL` (boolOff), `EXPAND_RECALL_RELEASE` (num credits, def 0).
- **W11:** `CHAIN_FEED` (boolOff), `FEEDER_SHIPS` (csvSet), `FEED_GOODS` (csvSet),
  `FEED_MIN_MARGIN_PCT` (num), `FEED_PREFER_MINED` (bool), `FEED_SATURATION_N` (num),
  `EXPAND_SCAN_TTL_MAX_MS` (num), `EXPAND_SCAN_VOLATILE_PCT` (num), `EXPAND_PROBE_DWELL_MS` (num).

Confirm exact defaults against the bot2/expansion **declaration sites** (not the operator `.sh`) when
implementing each wave — `git show origin/main:expansion.mjs | grep -n 'EXPAND_…'`.

## Open scoping decisions (resolved here unless a wave says otherwise)
1. **`gate-graph.json` preload (W7).** Legacy bundles a static JSON of charted gate connections and
   preloads it into the in-memory `gateGraph` cache for instant unbounded pathfinding, falling back to
   live discovery. TS approach: bundle the JSON as a `packages/bot/src/expansion/gate-graph.json`
   asset loaded at factory init (Docker-copy it), **and** log a DRIFT noting the future option to move
   it behind the persistence API / a `GateGraph` Prisma model. Do NOT add a DB model in W7 — keep the
   file, parity-first.
2. **The 3 new tool scripts (W12).** `seed-relay.mjs`, `gate-graph-dump.mjs`, `reach-check.mjs` are
   standalone **operator/diagnostic** tools. Port them as TS one-shot scripts under
   `packages/bot/src/tools/` (run via `tsx`/`node dist/tools/...`) **or** document as a deferred
   tooling follow-up — decide in W12 by effort. They are not part of the core bot run loop.
3. **`MINE_*` (no EXPAND_ prefix) flags** (`MINE_EXPAND`, `MINE_MIGRATE`, `MINE_FEED`, …) already exist
   from Wave 4 and are a *different* subsystem (home-system mining) — do NOT conflate with the new
   `EXPAND_MINE` colony system in W9.

## Per-wave specs
`rebuild/plans/wave-7-deep-gate.md` … `wave-12-config-tools-docs.md`.
