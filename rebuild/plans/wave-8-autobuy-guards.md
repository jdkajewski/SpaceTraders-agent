# Wave 8 — Autobuy overhaul + migration 400 guards + negotiator fix

**Commits:** `ceb0975` (autoBuy tick-stall fix: ONE fleet snapshot per tick threaded into
adoptMiners/adoptHubProbes/autoBuy; local-first buying coverage = markets ∪ shipyards; non-blocking
anchors; `adoptHubProbes()`; `EXPAND_TRADERS_PER_SYS`), `5957b46` (include the HUB in autobuy staffing,
YK2-first then fan out), `b9812e1`→**anchorBuy only** (local-buy anchor: divert nearest idle in-system
probe to a selling yard so the next buy window succeeds; throttled per yard), `4d79e3b`→**migrate-stray
only** (`migrateToMine`/stray self-recovery 2-hop home→hub→mine), `6f0d9cc` (stop cross-system navigate
400s: bot2 `worker()` park-guard + expansion `goToSys()` re-validate system every hop), `7e5494a`
(contracts: stop expansion poaching the negotiator + self-heal negotiation at HQ).
**Depends on:** Wave 7. **Blocks:** Wave 9. **Model:** standard (Sonnet).

## Goal
Make fleet auto-buy correct, non-stalling, and **local-first**, and stop the two cross-system
navigate-400 leaks. This is the buying/adoption substrate the mining colonies (W9) sit on.

## Port targets (`expansion/expansion.ts` unless noted)
- **Single tick snapshot:** `maybeTrigger()` (L1517) takes ONE fleet snapshot and threads it into
  `adoptMiners(fleet)` / `adoptHubProbes(fleet)` / `autoBuy(fleet)` — fixes the autobuy tick stall
  where each helper re-GET the fleet and raced.
- `autoBuy(fleet)` (L1235): **local-first** — coverage set = markets ∪ shipyards; buy at the
  ship's/colony's own system yard rather than the spiked home yard; **HUB included** in staffing,
  YK2(hub)-first then fan out; honor `EXPAND_TRADERS_PER_SYS` (per-system trader target),
  `EXPAND_MAX_PROBE_PRICE` / `EXPAND_MAX_TRADER_PRICE` caps.
- `anchorBuy(type, sys, allShips)` (L1218) + `pickBuy(type, prefSys, shipWps)` (L1201): purchases need a
  ship AT the yard; when we want a local buy but none parked, divert nearest idle in-system probe
  there (throttled per yard, **non-blocking**).
- `adoptHubProbes(fleet)` (L1496): adopt idle hub probes into PROBE role.
- `migrateToMine(sym, ship, sys)` (L762): stray hull self-recovers via 2-hop gate route home→hub→mine.
  (Full mining steps land in W9; the migration primitive lands here.)

## Cross-package touches (the two 400 fixes + negotiator)
- **`worker.ts`** (port of bot2 `worker()` guard, `6f0d9cc`): when `AUTO_EXPAND` is on and a ship is
  **outside the home system** but expansion hasn't adopted it yet, **park** ("awaiting expansion
  adopt") instead of running home recovery/trading. Prevents the boot-window cross-system navigate 400.
- **`expansion.ts goToSys()`** (L300): re-validate the destination's system on **every hop** and abort
  the nav if no longer in-system (defense-in-depth; "cross = jump only").
- **`main.ts` / contracts hook** (`7e5494a`): don't let expansion poach the configured `NEGOTIATOR`
  ship; self-heal contract negotiation at HQ when the negotiator is home.

## Config (additive): `EXPAND_TRADERS_PER_SYS` (kvMap sys→n), `EXPAND_MAX_PROBE_PRICE` (num),
`EXPAND_MAX_TRADER_PRICE` (num), `EXPAND_MAX_BUY_DRONES` (num).

## Tests (vitest — pure, minimal)
- `EXPAND_TRADERS_PER_SYS` parse (kvMap) + per-system target honored in a fixture autoBuy decision.
- worker park-guard truth table: outside-home-system + AUTO_EXPAND + not-adopted ⇒ park (no goTo).
- negotiator is excluded from expansion adoption.

## Acceptance
- [ ] Flags-off ⇒ Wave-7 parity. [ ] No cross-system `navigate` issued by worker for unadopted
  out-of-system ships. [ ] Negotiator never adopted. [ ] build + new vitest green + lint 0.
- [ ] DRIFT entries for any deviation (esp. the worker park-guard interaction with recovery).
