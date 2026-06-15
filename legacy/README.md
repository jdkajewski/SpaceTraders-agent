# legacy/ — archived pre-rebuild scripts

These are the **original single-file SpaceTraders bot and its ops/analysis scripts**, archived here when
the TypeScript monorepo (Waves 0–6) became the canonical stack. **Nothing in production imports them.**
They are kept (not deleted) for two reasons:

1. **Parity reference.** The durable parity harness (`packages/bot/src/__tests__/parity/`) asserts the TS
   pure functions match the legacy math. Because `bot2.mjs` self-executes `main()` and reads files at
   import time, it can't be imported in a test — so the harness transcribes the legacy expressions
   verbatim into `legacy-shims.ts` with `bot2.mjs:Lxxx` line-ref comments. These files are the source of
   truth those line-refs point at; keep them in sync if you ever touch the shims.
2. **Provenance.** Docs 01–08 and many code comments cite legacy line numbers; this is where to read them.

## Contents

| File | Role |
|---|---|
| `bot2.mjs` | The 3206-line main bot (the thing the TS `@st/bot` is a port of). |
| `bot.mjs` | Earlier bot iteration. |
| `st.mjs` | SpaceTraders API client (rate limiting, request helpers). |
| `trade.mjs` | Ship actions (goTo/buy/sell/jump/…). |
| `expansion.mjs` | Inter-system expansion (outposts, probe partitioning). |
| `dashboard.mjs`, `contracts.mjs`, `status.mjs`, `markets.mjs`, `mon3.mjs`, `networth.mjs`, `health.mjs` | Read-only monitors over the old local JSON files. |
| `active_contract.mjs`, `allocate.mjs`, `buyFab.mjs`, `calib.mjs`, `expand.mjs`, `greenfield.mjs`, `market_diff.mjs`, `probe_util.mjs`, `snap_markets.mjs` | One-off ops/analysis helpers. |
| `*.sh` | Launch/monitor shell wrappers (`overnight_experiment.sh` is the live launch profile reproduced in `deploy/bot.env.example`). |
| `analyze.py` | Ad-hoc analysis script. |

## Do NOT run these against the live game anymore

The canonical run path is the TS stack: `docker compose up` (or `pnpm --filter @st/bot start`). The
monitors here still read the old local `*.json`/`*.jsonl` files; re-pointing them at the API
(`GET /status`, `/markets`, …) is an explicit **future follow-up wave** (the snapshot-shape parity test
guarantees the `data` block they consume is unchanged, so the migration is mechanical).
