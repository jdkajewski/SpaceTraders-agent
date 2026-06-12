# SpaceTraders-agent

A headless, continuously-running autotrader for [SpaceTraders](https://spacetraders.io).
One Node process runs ~20 ship workers in parallel to drive a single agent through the
**greenfield → jump-gate → seed-next-system** playbook: maximize per-lane trading profit
while building the system's jump gate, with mining, contracts, input-feeding, and
opportunistic gate supply all running as cooperating loops.

> ⚠️ The agent token is read **only** from `SPACETRADERS_PLAYER_AGENT_TOKEN`. It is never
> stored in the repo, and all local state (`markets.json`, `tracker.md`, `*.log`, `*.jsonl`, …)
> is git-ignored.

## Quick start

```bash
npm install
export SPACETRADERS_PLAYER_AGENT_TOKEN="your-agent-token"
node markets.mjs X1-PP30-A1 X1-PP30-A2 ...   # seed markets.json (your stationed waypoints)
echo "# tracker" > tracker.md                 # status file the bot appends to
node bot2.mjs                                  # add config flags as needed
```

`touch STOP` to drain gracefully; remove it before relaunching. Full flag set and the
production launch profile are in [`docs/05-config-reference.md`](docs/05-config-reference.md).

## Documentation

**Start here → [`docs/README.md`](docs/README.md)** for the full guided set. In depth:

- **[01 — Strategy](docs/01-strategy.md):** the dual profit+gate goal, why `runNet` (not credits) is the metric, the phase state machine, and the cost-to-expand budget.
- **[02 — Architecture](docs/02-architecture.md):** single process, continuous ship workers, shared state, crash-safe recovery, graceful drain.
- **[03 — Subsystems](docs/03-subsystems.md):** trading engine, gate supply, mining colony, contract pipeline, input-feed, orphan-cargo delivery, ride-alongs.
- **[04 — Optimizations & tricks](docs/04-optimizations-and-tricks.md):** shared token bucket, fuel-aware routing, fill-bias, credit hysteresis, price-settle patience, contract auto-force.
- **[05 — Config reference](docs/05-config-reference.md):** every env flag by subsystem + the prod launch profile.
- **[06 — Tooling](docs/06-tooling.md):** the ops/analysis scripts and the local-first, rate-limit-safe philosophy.
- **[07 — Doc drift](docs/07-doc-drift.md):** where older notes disagree with the live code (code wins).
- **[08 — Expansion](docs/08-expansion.md):** the multi-system roadmap (probe partitioning, one-time send + residency pinning, ship-buy policy).

Raw design notes captured while building: [`RULES_ENGINE.md`](RULES_ENGINE.md),
[`EXPANSION-DESIGN.md`](EXPANSION-DESIGN.md).

## Code map

| Path | Purpose |
|---|---|
| `bot2.mjs` | The main bot — all worker loops and managers. |
| `st.mjs` / `trade.mjs` | API client (token, rate-limit bucket, retry) / ship primitives. |
| `markets.mjs` | One-shot market snapshot → `markets.json`. |
| `expand.mjs`, `contracts.mjs`, `networth.mjs`, `status.mjs`, `health.mjs`, `probe_util.mjs`, … | Ops & analysis tools — see [`docs/06-tooling.md`](docs/06-tooling.md). |
| `*.sh`, `analyze.py` | Monitoring loops and offline analysis. |
| `coords.csv` | Static home-system waypoint geometry (bot input). |

> The bot is tuned around one home system (`X1-PP30`) and an externally-provisioned
> fleet; treat the hard-coded waypoints/ship IDs as a worked example. The rationale lives
> in `docs/`.
