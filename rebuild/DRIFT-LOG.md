# Drift Log — legacy behavior vs. TS port

Append-only log used by sub-sessions during Waves 2–5. When porting a function, if you find a behavior
that looks like a bug, an inconsistency with the docs, or a quirk worth a decision, **record it here
instead of silently changing it.** Resolved in Wave 6.

| # | Wave | Location (legacy) | Observation | Proposed action | Status |
|---|------|-------------------|-------------|-----------------|--------|
| 1 | plan | docs vs code | Docs describe ~2404-line bot; live is 3206. FLEET_SCALE, AUTO_EXPAND/expansion.mjs, REPAIR, mineMigrateManager, ship-purchase, TRADE_FIRST, CONTRACTS switch are in code but thin/absent in docs. | Port all (parity); refresh docs in W6. | open |
| 2 | plan | trade.mjs jump() | `jump()` already implemented; doc 08 lists it as TODO. | Port as-is; correct doc. | open |
| 3 | plan | config | Code defaults differ from operator live-launch values. | Keep code defaults; ship live profile as example env_file. | open |
| 4 | plan | gate-levers.json | File-mtime hot-reload of credit band. | Re-implement as polled GET /gate-levers. | open |
| 5 | plan | intents/run-stats | Local-file crash safety would regress behind the API. | Local write-through fallback + boot reconcile. | open |
| 7 | W0 | bot2.mjs line 194 | `GATE_CREDIT_RESUME` default is `GATE_CREDIT_FLOOR + GATE_CREDIT_RESUME_GAP` (derived at runtime), but env override is also honoured. Zod schema can't express cross-field defaults in a single pass. | Two-step parse in `loadConfig()`: raw schema captures scalar fields; post-transform fills derived fields. `Config` type uses `Omit` to replace the raw `string \| undefined` with `number`. | resolved |
| 8 | W0 | bot2.mjs line 231-232 | `FEED_PRICE_SETTLE_MS` / `FEED_PRICE_REBOUND_EPS` defaults silently mirror the GATE counterparts at declaration time. If GATE is overridden via env, FEED picks up that value unless its own env is also set. Same cross-field derivation pattern as #7. | Same post-transform approach: FEED mirrors GATE unless FEED env var is explicitly present. Behaviour parity confirmed by tests. | resolved |
| 9 | W0 | bot2.mjs line 68 | `CONTRACT_RIDEALONG` default is `MULTI_GOOD && env.CONTRACT_RIDEALONG !== '0'` — it's off when MULTI_GOOD is off, even if CONTRACT_RIDEALONG env is unset. Zod can't express this dependency in a flat schema. | Same post-transform: raw schema parses CONTRACT_RIDEALONG as a standalone bool; loadConfig() re-derives it coupling to MULTI_GOOD. Parity confirmed by tests. | resolved |
| 10 | W0 | bot2.mjs line 1895 | `MINE_ORE_RESERVE` default is `REFINE_IN` (the JS const = 30), not a numeric literal. Anyone reading the env line without the constant context would see `|| REFINE_IN` and not know it's 30. | Hardcoded to 30 (= REFINE_IN) in the zod schema default. REFINE_IN constant exported from `@st/shared/constants.ts` so later ports can reference it. | resolved |
| 11 | W0 | bot2.mjs line 194 | `let GATE_CREDIT_FLOOR` and `let GATE_CREDIT_RESUME` are declared with `let` not `const` — they're mutated live by `reloadGateLevers()` reading gate-levers.json. In the TS port these will be read-only from `Config` and the live values come from polling `GET /gate-levers` (DRIFT entry #4). | No action in W0; noted for Wave 1 (gate-levers endpoint) and Wave 3 (gate.ts). | open |
