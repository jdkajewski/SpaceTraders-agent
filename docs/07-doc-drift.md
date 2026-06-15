# 07 — Documentation Drift (what the old docs got wrong)

> **⚠️ Wave 6 update — this docs set now tracks the TypeScript monorepo.**
> As of the TS rebuild (Waves 0–6), the canonical bot is the **TypeScript stack** under `packages/`
> (`@st/shared`, `@st/api`, `@st/bot`), run via `docker compose up` or `pnpm --filter @st/bot start`.
> The legacy `.mjs` files (`bot2.mjs`, `st.mjs`, `trade.mjs`, `expansion.mjs`, monitors) are archived
> under [`legacy/`](../legacy/) and kept **only** as the parity reference for the durable parity harness
> (`packages/bot/src/__tests__/parity/`). **Docs 01–08 still describe the legacy `bot2.mjs` behaviour** —
> they remain the behavioural spec the TS port preserves, but the line-count / file-path / "as it runs
> now" references in them point at the old `.mjs` and are *historical*. For the TS architecture, run
> paths, and the legacy→TS map, read the new **[`09-ts-rebuild.md`](09-ts-rebuild.md)**. For every place
> the TS port intentionally or incidentally diverges from the legacy behaviour (and how each was
> resolved), read **[`rebuild/DRIFT-LOG.md`](../rebuild/DRIFT-LOG.md)** (all 35 entries resolved in W6).
>
> The sections below are the *original* legacy-era drift notes (legacy docs vs legacy code). They are
> retained verbatim for provenance; the absolute `~/.copilot/session-state/...bot2.mjs` paths and the
> "2404 vs 3206 line" counts refer to the legacy file now living at `legacy/bot2.mjs`.

---

These docs describe `bot2.mjs` **as it actually runs now**, verified against the live source at
`/Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files/bot2.mjs`
(**2404 lines** as of the 11:41 CT launch) and the live `bot-status.json` + current log. This page
flags where the **pre-existing docs and code comments disagree with the current code**, so you know
what to trust.

## How this was verified

- **Code diff:** the older snapshot `~/Desktop/SpaceTraders/context/bot2.mjs` (2341 lines, dated
  **Jun 12 00:29**) was diffed against the live file. The live file has since grown to **2404 lines**
  (the auto-force feature, §1, shipped at 11:41 CT after the initial diff). The live file is newer and
  is the source of truth.
- **Runtime truth:** live `bot-status.json` and the current log (now `bot2.20260612-114117.log`,
  launched 11:41 CT) confirm the running phase, gate progress, credit floor, hauler/transport
  assignments, and the active contract.

---

## 1. Code added since the Jun 12 00:29 snapshot (5 changes)

The snapshot predates these — any doc/comment older than it describes the **old** behavior. All five
are present in the live code and are documented in [`03`](03-subsystems.md) / [`04`](04-optimizations-and-tricks.md):

| Change | Live code | What the old snapshot did instead |
|---|---|---|
| **Contract self-heal** — adopt an already-negotiated but **unaccepted** offer before negotiating a new one | `contractManager`, ~L679–692 | Only negotiated when idle; a restart between negotiate→accept wedged contracts forever (the API refuses a new negotiation while an unaccepted one exists). |
| **Post-travel ownership re-check** — after the sourcing leg, if empty & no longer owner, bail instead of double-buying | ~L854–861 | Blindly bought on arrival → two ships could source the same contract. |
| **Pre-delivery contract re-validation** — re-fetch the contract before delivering; if closed/fulfilled, hold cargo for salvage instead of looping on a 400 | ~L871–879 | Delivered without re-checking → 400-loop if another ship fulfilled it mid-haul. |
| **Input-feed decoupled from the gate credit pause** — `INPUT_FEED_GATE_PAUSE` (default off) + `INPUT_FEED_MIN_CASH` | L63–69, ~L1144–1145 | Input-feed was hard-gated on `gateCreditOk()` (`if (!gateCreditOk()) return false`), so it paused whenever gate buying paused. |
| **Contract auto-force for wedged duds** (newest, shipped 11:41 CT) — `CONTRACT_AUTOFORCE_MINS` (default 20, 0=off) + runtime `contractAutoForced` set + `isForced(ci)` helper | `CONTRACT_AUTOFORCE_MINS` L629, `contractAutoForced` L630, `isForced` L633, wedge-grace L745–754, bypass points L663 & L861 | No auto-force: a dud contract whose payout left net < margin floor for *every* ship (e.g. `LIQUID_HYDROGEN @ 2484`) wedged the single contract slot until its deadline, blocking all new lucrative contracts. `contractManager` now tracks how long the active contract has sat **continuously unowned** (nobody passed the margin gate); past the grace window it adds the contract **id** to `contractAutoForced`, and `isForced()` (which replaced the prior `CONTRACT_FORCE.has(ci.good)` checks) bypasses the margin gate so the closest hull sources it — self-healing the wedge without a manual `CONTRACT_FORCE` restart. Keyed on **id** so it clears only the wedged contract. Logs `⚡ auto-force contract …`. |

> These are exactly the features this documentation set already describes — the docs you're reading are
> built from the **live** code, so they're correct. The point of this table is that **`SESSION-CONTEXT.md`
> and any comment dated ≤ 00:29 omit them.** (Post-travel re-check and pre-delivery re-validation are
> confirmed firing in production — `ctr↩ … de-elected mid-source → skip buy` observed live.)

---

## 2. `STRATEGY.md` (Jun 11) — stale areas

`STRATEGY.md` is the oldest source (dated **Jun 11 14:54**, before even the snapshot). It's an excellent
conceptual narrative and ~90% still accurate, but it **predates** several mechanisms:

- **No gate credit-floor hysteresis.** It describes `GATE_CREDIT_FLOOR` as a simple "don't buy below
  this" line (§4, §6) with **no mention of the resume/deadband** (`GATE_CREDIT_RESUME`,
  `GATE_CREDIT_RESUME_GAP`) or the price-settle patience state machine. Both exist in live code
  ([`04 §4`](04-optimizations-and-tricks.md), [`§5`](04-optimizations-and-tricks.md)). The live bot
  shows `creditFloor:900000, creditResume:1150000`.
- **No contract election / self-heal / re-check machinery.** `STRATEGY.md` doesn't mention
  `electContractOwner`, `CONTRACT_REELECT_MARGIN`, post-travel re-checks, or unaccepted-offer adoption.
- **Stale config values (§6 table + launch command):** see §4 below.
- ✅ It *does* already cover orphan-gate-cargo and the absolute-price-cap rationale (those were
  back-ported into it).

## 3. `V2-HANDOFF.md` — identifies the problem, predates the fix

`V2-HANDOFF.md` correctly notes (L20): *"an unaccepted negotiated offer also blocks re-roll."* That is
precisely the bug the **contract self-heal** (§1) now fixes — the handoff names the hazard but predates
the remedy. Treat it as a "known issue" doc, not a description of current behavior.

## 4. Config-value drift (three disagreeing profiles)

The same handful of knobs appear with **different values** in each source. They are operator-tuned and
change between launches; trust the live runtime. Full table in [`05`](05-config-reference.md).

| Knob | `bot2.mjs` default | `STRATEGY.md` §6 (Jun 11) | `SESSION-CONTEXT.md` (00:28) | **Live (11:08 launch)** |
|---|---|---|---|---|
| `MIN_NET` | 4000 | 2000 | 1200 | 1200¹ |
| `GATE_CREDIT_FLOOR` | 1,500,000 | 1,100,000 | 900,000 | **900,000** ✓ |
| `GATE_CREDIT_RESUME` | floor+gap | — (not mentioned) | 1,150,000 | **1,150,000** ✓ |
| `GATE_MAX_PRICE` | none | FAB:3200,ADV:8000 | FAB:3900,ADV:12500 | FAB:3900,ADV:12500¹ |
| `GATE_HAULERS` | none | — | 12,13 | **12,13** ✓ |
| `MINE_TRANSPORT` | auto | — | 14,29 | **14,29** ✓ |
| `INPUT_FEED` | off | 0 | 0 | **0 (off)** ✓ |
| `MINE_FEED` | off | 1 | 1 | **1 (on)** ✓ |

✓ = confirmed in live `bot-status.json`. ¹ = `MIN_NET` and `GATE_MAX_PRICE` are **not echoed** in the
live log; values shown are the last-known launch command and may have changed. Don't treat them as
gospel.

## 5. System-map drift — contract destinations rotate

`STRATEGY.md` §3 (and earlier drafts of these docs) list **`A4` as "the contract delivery
destination."** In reality the contract good and its destination **rotate** with each negotiated
contract. The live contract is **`LIQUID_HYDROGEN` → `G55`, sourced at `C40`** — neither A4 nor any of
the gate/mining waypoints. Treat A4 as one illustrative example, not a fixed role. The **gate/mining**
waypoints *are* stable: I63 (gate), F51 (FAB_MATS + fuel + mining anchor), D43 (ADV_CIRCUITRY), B9
(asteroid), H59 (raw-ore sink).

## 6. Live progress note (not drift, but context)

The gate is **nearly complete**: live `bot-status.json` shows `remaining: { FAB_MATS: 415 }` —
`ADVANCED_CIRCUITRY` and `QUANTUM_STABILIZERS` are **fully supplied**. Older docs (SESSION-CONTEXT:
"ADV 43 left", STRATEGY: all three outstanding) reflect earlier states. Consequently
`ADVANCED_CIRCUITRY`'s price cap is currently moot, and FAB_MATS is the sole long pole. `runNet` is
~**6.03M** and the dynamic expansion goal floats around **3.5–3.6M** (it's recomputed live as material
costs move).

---

## TL;DR — what to trust

1. **The live `bot2.mjs` (18a148a9 path) is truth.** These docs follow it.
2. **`STRATEGY.md` is great background but predates** hysteresis, price-settle patience, the contract
   election/self-heal/re-check suite, and input-feed decoupling.
3. **All specific credit/price/ship-assignment numbers are operator-tuned** — verify against
   `bot-status.json` and the current log, not against any `.md` table.
4. **The five §1 features are the freshest code** (the contract auto-force is newest, 11:41 CT) and are
   absent from any source dated ≤ Jun 12 00:29.
