# Wave 6 — Validation, drift reconciliation, docs, cutover

**Depends on:** Wave 5. **Suggested model:** mid-tier coding model (+ heavier for any parity diffs).
**Base branch:** integration branch after Wave 5.

## Goal
Confirm behavior parity with the legacy bot, apply the drift fixes the user approved, write the
operator/dev docs, and retire the legacy `.mjs` files cleanly.

## Tasks

### 6.1 Parity validation
- **Pure-function parity harness:** for the decision math (chooseMode, planRoute, routeCost,
  buildLanes ranking, cooldownFor, determinePhase, gateCreditOk, planGateFill, computeExpansionTarget,
  partitionMarkets), run the TS implementation and the legacy `.mjs` on the same fixtures and assert
  identical outputs. Keep this as a small, durable vitest suite (the most valuable regression guard).
- **Snapshot-shape parity:** assert the `POST /status` payload matches the legacy `bot-status.json`
  field-for-field (so existing monitors/dashboard can migrate with no shape changes).
- **Live spot-check (operator, not CI):** run the new bot against the live agent for a short window
  with the live flag profile; compare runNet accrual, phase, gate progress, and per-ship "doing" to a
  legacy run. Document results.

### 6.2 Drift reconciliation
- Resolve every entry in `rebuild/DRIFT-LOG.md` (accumulated during Waves 2–5): apply the
  user-approved fixes, or annotate "preserved as legacy behavior" with rationale.
- Refresh `docs/07-doc-drift.md` (or add `docs/09-ts-rebuild.md`) to describe the new architecture and
  note that the docs set now tracks the TS code. Update line-count/feature references.

### 6.3 Crash-safety verification
- Confirm the intents/run-stats **local write-through fallback** (MASTER-PLAN §6.5) behaves correctly
  under: API down at saveIntent, API down at boot, API back after reconnect (newest-wins reconcile).
  Add 1–2 targeted tests + a documented manual procedure.

### 6.4 Docs & ops
- Root `README.md`: monorepo layout, `pnpm install`, `docker compose up`, env/flag reference (link to
  `@st/shared` config), how to run bot vs api, how to migrate/seed the DB, how to stop gracefully.
- `packages/api/README.md` (route reference / Swagger link) and `packages/bot/README.md` (module map,
  operator flag profile, run instructions).
- Note the monitor/tooling migration (point `dashboard.mjs`/`contracts.mjs`/`status.mjs` at the API)
  as an **explicit follow-up** (own future wave) — not done here unless trivial.

### 6.5 Legacy cutover
- Move the legacy `.mjs` (bot2/bot/st/trade/expansion + the monitor scripts) into `legacy/` (kept for
  reference + the parity harness) or delete after the parity suite no longer needs them. Update
  `.gitignore`/paths. Ensure the repo's default run path is the TS stack.

## Acceptance checklist
- [ ] Parity vitest suite green (TS == legacy on shared fixtures for all listed pure functions).
- [ ] Status-snapshot shape matches legacy `bot-status.json`.
- [ ] `DRIFT-LOG.md` fully resolved; docs updated.
- [ ] Crash-safety fallback verified (down/boot/reconnect).
- [ ] READMEs complete; `docker compose up` from a clean checkout runs the full stack.
- [ ] Legacy files archived/removed; CI (`pnpm -r build && pnpm -r test && lint`) green.
