# Wave 10 — RECALL / RECALL_RELEASE consolidation modes

**Commits:** `809ed06` (add `EXPAND_RECALL`: consolidate all outpost crews onto the hub), `f9bdebe`
(`EXPAND_RECALL_RELEASE`: credit-triggered latched fan-out — concentrate, then auto fan-out).
**Depends on:** Wave 9 (recall exempts mine systems). **Blocks:** Wave 12. **Model:** standard.

## Goal
Let the operator "build a war chest on the fattest system, then fan back out with it" — fully
automatic, no manual restart. Reuses the existing 2-hop migration state machine **in reverse**.

## Port targets (`expansion/expansion.ts`)
- **RECALL (`809ed06`):** `EXPAND_RECALL=1` pulls every outpost crew back to the hub (target system)
  and converts them to hub roles.
  - `stepOutpost` (L522): when RECALL is set and the ship is in its outpost system, jump
    outpost-gate → hub-gate instead of trading locally (FLOOR-guarded by the same `jumpVia`;
    antimatter respects `EXPAND_CREDIT_FLOOR`).
  - on hub arrival, convert role in place: probe hull → PROBE, trader → LIGHT; normal hub logic takes
    over. Log "🪐 <ship> recalled to hub <sys> → <role>".
  - `autoBuy` under RECALL: `staffSystems` is **hub-only** (no outpost buys).
  - Outpost gates stay configured (`EXPAND_OUTPOSTS` kept) so the recall jump knows the route; ships
    already in outposts are re-adopted then recalled.
  - **Mine systems are exempt** (W9 seam): colony crews stay local.
- **RECALL_RELEASE (`f9bdebe`):** `EXPAND_RECALL_RELEASE=<credits>` — while recall active and credits
  below the threshold, keep concentrating; the moment credits reach it, recall **auto-releases**
  (latched, fires once):
  - `recallActive()` = `RECALL && !recallReleased`. `checkRecallRelease()` (L1430) runs each
    `maybeTrigger` tick: one-time restore of every recalled ship to its `OUTPROBE`/`OUTLIGHT` role for
    its origin system (tagged `recalledFrom`); the existing 2-hop migration jumps it hub→outpost next
    step (clean fan-out, reuses all existing code). Resets `outpostsReady` so `setupOutposts` re-fills
    shortfall. Outpost autobuy resumes (`staffSystems` includes outposts once `recallActive()` false).
  - Hub keeps its native crew (AUTO_EXPAND migrants + autobought hub probes).
  - `0` = never auto-release (recall stays until flag removed).
  - `statusBlock()` surfaces `recall {active, released, releaseAt}`.

## State (runtime/state.ts — additive)
`recalledFrom: Map<shipSym, originSys>`, `recallReleased: boolean` latch. `createState()` inits.

## Config (additive): `EXPAND_RECALL` (boolOff — default 0), `EXPAND_RECALL_RELEASE` (num credits,
def 0 = never). Confirm against decl sites.

## Tests (vitest — pure, minimal)
- `recallActive()` latch: active while below threshold; releases once at/above; stays released.
- `checkRecallRelease` restores `recalledFrom` ships to OUTPROBE/OUTLIGHT exactly once (idempotent).

## Acceptance
- [ ] `EXPAND_RECALL=0` ⇒ Wave-9 parity. [ ] RECALL hub-only autobuy; mine systems exempt. [ ]
  release latches once; fan-out reuses migration. [ ] build + vitest green + lint 0 + DRIFT entries.
