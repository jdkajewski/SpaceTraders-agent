# SpaceTraders Autotrader — Strategy & Engineering Documentation

This is the engineering documentation set for **`bot2.mjs`**, a headless, long-running
SpaceTraders trading & automation bot driving the live agent **`SPACEJAM-DK-2`** in system
**`X1-PP30`**.

> **One-paragraph overview.** `bot2.mjs` is a single Node process that runs the entire fleet:
> ~20 concurrent per-ship "workers" plus a few manager loops. It has a **dual goal** — maximize
> per-lane trading profit *and* build the system **jump gate** (deliver `FAB_MATS` +
> `ADVANCED_CIRCUITRY` + `QUANTUM_STABILIZERS` to the construction site) — while also running a
> small **mining colony**, fulfilling **procurement contracts**, and never going bankrupt. All
> behavior is driven by dozens of environment flags. Every ship shares a single ~2 req/s
> rate-limited API budget, so the design is obsessed with *not wasting requests* and *not
> stepping on its own market*. The whole thing is engineered to survive crashes/restarts without
> stranding cargo or corrupting its profit accounting.

## Table of contents

**This page**
- [One-paragraph overview](#spacetraders-autotrader--strategy--engineering-documentation)
- [How these docs are organized](#how-these-docs-are-organized)
- [Key facts to anchor on](#key-facts-to-anchor-on)
- [Related references](#related-references)

**The documentation set**
1. [`01-strategy.md`](01-strategy.md) — Overall economic strategy, phases & budgeting
2. [`02-architecture.md`](02-architecture.md) — Process model, workers, crash-safe recovery, STOP/drain
3. [`03-subsystems.md`](03-subsystems.md) — Trading, gate supply, mining colony, contracts, orphan cargo
4. [`04-optimizations-and-tricks.md`](04-optimizations-and-tricks.md) — The clever, hard-won design choices
5. [`05-config-reference.md`](05-config-reference.md) — Every environment flag, grouped by subsystem
6. [`06-tooling.md`](06-tooling.md) — Monitoring/ops scripts & the rate-limit-safe philosophy
7. [`07-doc-drift.md`](07-doc-drift.md) — Where the old docs disagree with the current code (read to know what to trust)
8. [`08-expansion.md`](08-expansion.md) — Multi-system expansion (post-gate): roaming probes, ship relocation/pinning, what to buy/send

**New here? Suggested reading order:** [`01`](01-strategy.md) → [`02`](02-architecture.md) → [`03`](03-subsystems.md) → [`04`](04-optimizations-and-tricks.md), with [`05`](05-config-reference.md)/[`06`](06-tooling.md) as references, [`07`](07-doc-drift.md) before trusting any specific numbers, and [`08`](08-expansion.md) for the post-gate roadmap.

## How these docs are organized

| File | What it covers |
|---|---|
| [`01-strategy.md`](01-strategy.md) | The overall economic strategy: the dual profit + gate goal, the phase state machine (bootstrap → profit → gate supply → input feed → portal open), the dynamic "cost-to-expand" budget, credit floors & reserves, and how the bot decides it's "done". |
| [`02-architecture.md`](02-architecture.md) | The process model: one Node process, ~20 ship workers + manager loops (`contractManager`, `targetWatch`, `fleetTable`), shared in-memory state, the worker loop's **ordered decision steps**, crash-safe intent recovery, and the graceful STOP/drain restart procedure. |
| [`03-subsystems.md`](03-subsystems.md) | Each subsystem in depth: the trading engine (lanes, net/min routing, cooldowns, ride-alongs, fill-bias), the gate-supply system, the mining colony (funnel/drone/surveyor/tender roles), the contract pipeline, input-feed, and orphan-gate-cargo delivery. |
| [`04-optimizations-and-tricks.md`](04-optimizations-and-tricks.md) | **The interesting one.** The non-obvious, hard-won design choices — the shared token bucket, local-file-first monitoring, fuel-aware multi-hop routing, fill-bias tie-banding, owner-election with re-election margin, post-travel ownership re-checks, contract self-heal, the salvage-guard, `CONTRACT_FORCE`, intent persistence, hysteresis, price-settle patience, and more — with *why each matters*. |
| [`05-config-reference.md`](05-config-reference.md) | A reference table of every environment flag, grouped by subsystem, with defaults and what each controls. |
| [`06-tooling.md`](06-tooling.md) | The monitoring/ops scripts (`st.mjs`, `contracts.mjs`, `status.mjs`, `mon3.mjs`, `health.mjs`, `networth.mjs`, `expand.mjs`, etc.), their usage, and the local-file-first / rate-limit-safe design philosophy they share. |
| [`07-doc-drift.md`](07-doc-drift.md) | **Read this to know what to trust.** Where the pre-existing docs (`STRATEGY.md`, `SESSION-CONTEXT.md`, `V2-HANDOFF.md`) and code comments disagree with the *current* code — features added since the snapshot, three disagreeing config profiles, and rotated waypoints — all verified against the live source + `bot-status.json`. |
| [`08-expansion.md`](08-expansion.md) | **Post-gate roadmap (designed, default-OFF).** Multi-system expansion: roaming non-overlapping probe partitions for live market data, one-time ship relocation + permanent system pinning across the gate, and how to choose which ships to buy/send. Why the engine is single-system today and the phased E1–E5 plan to lift that. |

## Key facts to anchor on

- **The win condition is building the jump gate** at `X1-PP30-I63`. Trading profit is the *means*
  (it funds the gate buys and keeps the fleet productive); the gate build *is* the expansion.
- **Judge health by `runNet` (cumulative realized lane profit, persisted in `run-stats.json`), not
  by liquid credits.** Credits sawtooth as ships commit cargo (buy) then sell — a credit dip is
  in-flight inventory, not a loss.
- **Source of truth for the live code + artifacts** is the running session folder:
  `…/session-state/18a148a9-…/files/` (`bot2.mjs`, `st.mjs`, `trade.mjs`, the monitors, the JSONL
  history files, `bot-status.json`). The copies under `~/Desktop/SpaceTraders/` are reference
  snapshots and may lag.
- **There is only ever ONE driver** on the live agent at a time. A Dockerized "v2" UI exists for
  visualization but does **not** drive the agent (it lost money and was reverted).

## Related references

- `~/Desktop/SpaceTraders/STRATEGY.md` — the original long-form strategy narrative (this doc set
  expands and reorganizes it for engineers).
- `RULES_ENGINE.md` (next to the bot code) — the terse condition→action invariant list.
- The session `plan.md` — the running, dated decision log explaining *why* features were added.
