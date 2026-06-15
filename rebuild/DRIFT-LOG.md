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
| 6 | plan | tracker.md/.current_log | Human/ops file artifacts. | Drop; pino + API/DB. | open |
