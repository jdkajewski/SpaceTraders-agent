# 08 — Multi-system expansion (post-gate)

> **Status: designed, not yet executed.** Every behavior here is gated behind its own env flag,
> **default-OFF**, and only runs *after* the X1-PP30 jump gate (`I63`) is built. When only one system
> is configured the single-system code path stays byte-for-byte identical — the live earner is never
> put at risk by code that hasn't been switched on. Source design notes: the session
> `expansion-strategy.md` (Phase 5) and `expansion-prep-findings.md`.

Building the X1-PP30 gate **is** the win condition (docs 01). Expansion is what comes *after*: take
the capital + the proven playbook through the new portal and repeat the greenfield→portal loop in the
next system. This doc covers the three pieces the steady-state engine doesn't do today — **probe
coverage for live market data**, **relocating + pinning ships across the gate**, and **choosing which
ships to buy/send to expand**.

---

## 0. Why the current engine is single-system to the core

These are the load-bearing assumptions that expansion must lift (all in `bot2.mjs`):

- `SYSTEM='X1-PP30'` is a constant used everywhere.
- `coords` is loaded from `coords.csv` (X1-PP30 waypoints only); `D(a,b)` returns `1e9` for any
  cross-system pair — i.e. cross-system is treated as **infinitely far / unreachable by design**.
- `MARKET_WPS` = the one system's 27 markets; `getMarkets()` loops them against `/systems/X1-PP30/...`.
- **Probes are excluded from the worker pool** (`traders = ships.filter(cargo>0 …)`): today they are
  *static*, pre-positioned 1:1 with the 27 markets, and the bot only *reads* their markets. "Roaming
  probes" is therefore a **net-new subsystem**, not a tweak.
- Gate-supply / mining / input-feed / contracts all hardcode the in-system producer waypoints
  (`F51`=FAB, `D43`=ADV, `I63`=gate, `B9`=asteroid). There is **no jump / cross-system code** anywhere,
  and **no ship-purchase code at all** (the fleet is provisioned externally).

The gate `I63` connects to **6 candidate systems** (visible *before* completion via the jump-gate
endpoint): `X1-PP48`, `X1-K31`, `X1-VM80`, `X1-NV60`, `X1-XQ14`, `X1-FQ92`. None have been scouted —
their markets are unknown until a probe physically reaches the target gate. **Recon is the first
executable step post-gate.**

---

## 1. Probes for live market data — roaming, non-overlapping partition

**The role of probes.** A probe (`FRAME_PROBE`, cargo 0, fuel 0) is a *market sensor*. Because it has
no fuel cost (CRUISE is free for fuel-0 hulls) and jumps the gate for free, it's the cheapest way to
keep a market's live prices fresh. In X1-PP30 we run **1 probe per market** (27/27) — full coverage,
each probe sitting still on its waypoint, so the trade engine always reads current prices.

**The new system starts probe-sparse**, so a probe must *roam* a set of markets rather than sit on one.
The design (feature `PROBE_ROAM`, default off):

- **Partition the markets into disjoint, balanced arcs.** `partitionMarkets(systemMarketWps, probeSyms)`:
  1. Order the markets by a **nearest-neighbour proximity tour** from the system gate (uses `D()`/coords),
     so each arc is geographically compact and cheap to roam.
  2. Sort the probe symbols deterministically.
  3. Slice the tour into `N` **contiguous balanced arcs** `[floor(i*M/N), floor((i+1)*M/N))` → disjoint,
     union = all markets, sizes differ by ≤ 1.
- **Roam loop per probe:** cycle its arc, `goTo` each waypoint, dwell `PROBE_DWELL_MS` (~120 s), refresh
  that market, move on.
- **Converges to 1:1 automatically.** As probes are *bought* in-system, `N` rises, arcs shrink; when
  `N == M` each arc is a single market and probes sit still — exactly X1-PP30's current behavior.
  Re-partition deterministically whenever `N` (probes) or `M` (markets) changes.

> Enabling `PROBE_ROAM` in X1-PP30 is a **no-op** (already 1:1). The entire value is in the new,
> probe-sparse system. The partition function is pure → unit-testable now, with zero live effect.

This is deliberately **not** the v2 engine's model. v2 (`INKY_MIND_3`) uses a *shared lease pool*
(`scout_work_leases`) where any probe can claim any open market — overlap is possible over time. The
fixed-partition approach guarantees **no two probes ever cover the same market** and that coverage is
balanced, which is what you want when probes are scarce.

---

## 2. One-time send + permanent system pinning

Once the gate is built, relocate a chosen set of ships through it — **once** — and pin them to the new
system forever (never route back across the gate).

- **`jumpShip(sym, targetGateWp)` primitive** — POST `/my/ships/{sym}/jump`; handle cooldown. Probes
  are fuel-0 and jump for free; confirm fuel/antimatter cost for cargo hulls at execution time.
- **`expand_send.mjs` (one-time script, run with the bot stopped — like `buyFab.mjs`)**: for each
  chosen ship → `goTo(home gate I63)` → jump to the target system gate → optional `goTo` a target
  waypoint. This is a **batch relocation, not a steady-state loop**.
- **Residency store `residency.json`** `{ shipSym: systemSymbol }`, loaded at startup. A pin guard in
  the worker + lane/gate scoping restricts each ship to lanes/gate **in its resident system** and never
  lets it jump home. (`D()` cross-system = `1e9` already blocks physical cross-system *trades*; the pin
  adds residency tagging for fleet-split scoping and prevents an accidental jump-home.)
- **Probe sends are one-time.** After the initial batch, buy further probes *in* the target system
  (§3) — never shuttle probes back and forth, and never let two probes overlap (the partition in §1 is
  per-system over residents).

Env: `EXPAND_TARGET_SYSTEM`, `EXPAND_SEND="<ship list>"`.

**Recon flow (low-risk, do this first):** send a couple of probes through I63 → scout the target
system → write a target-system findings doc (markets, gate + its required materials, asteroids for a
mining colony, shipyards + what they sell). No trading until the new system is mapped.

---

## 3. Choosing which ships to buy / send to expand

`bot2.mjs` has **no purchase or refit code today** — it's all net-new, and budget-disciplined the same
way gate-supply is (spend only `availableForWork`, keep `OPERATING_RESERVE`, never starve trading).

**What the shipyards sell (X1-PP30 — A2 / C40 / H60):**

| Hull | Price | cargo | fuel | speed | Role |
|---|---|---|---|---|---|
| `PROBE` | ~$25.5k (A2) / $38.6k (C40) | 0 | 0 | 9 | Market sensor — coverage |
| `LIGHT_SHUTTLE` | ~$115k | 40 | 300 | 15 | Short-lane trader |
| `LIGHT_HAULER` | ~$321k | 80 | 600 | 15 | Long-range trade + **gate runs** (only hull whose 600 fuel covers the ~490–540 gate legs at CRUISE) |
| `MINING_DRONE` | ~$45k | 15 | — | — | Extraction |
| `SURVEYOR` | ~$34k | 0 | — | — | Survey (richer extraction) |
| `SIPHON_DRONE` | ~$38k | — | — | — | Gas |

**Buy policy — by *need*, not by hoarding cash** (mirrors `[RULE: expansion-saturation]`):

- **Probes first, for coverage.** Buy probes in the new system until `N == M` (one per market). They're
  cheap and they're what makes every other lane decision accurate. This is the highest-ROI expansion
  spend.
- **A `LIGHT_HAULER` for range + gate.** The new system will have its own gate to build; the 600-fuel /
  80-cargo hauler is the only hull that can run the long gate legs in one hop (a 300-fuel shuttle drifts
  or refuel-hops). One hauler unblocks the whole gate-supply loop in the new system.
- **Don't buy a trade hull while existing ones are parked.** The saturation guard: if active traders are
  realizing < ~60% of the best lane's net, the market is saturated — **adding a hull just splits the same
  pie**. Send/repurpose an idle ship instead of buying.

**Which *existing* ships to send over (fleet split):**

- Use **`probe_util.mjs`** (doc 06) to rank probes by how little their market is actually used in the
  logs — the **least-used probes are the expansion candidates** (sending them barely dents X1-PP30
  coverage). Keep the high-traffic probes (gate `I63`, producers `F51`/`D43`, ore market, contract
  destinations) in place.
- Send **idle traders/haulers** (parked under `PARK_MIN_NET`, or low realized net/min) — never pull a
  ship off a fat active lane. Keep enough hulls in X1-PP30 to sustain its own trading + any remaining
  gate/contract work.

**Upgrades / refits.** Refitting needs `installMount` / `installModule` **and** a market that sells
`MOUNT_` / `MODULE_` goods. **None are sold anywhere in X1-PP30**, so in this system "upgrade" = buy a
better whole hull. Whether the *target* system supports refits is unknown until recon — deprioritize
until then. (The v2 engine already has full outfitting — `outfittingPolicy.ts` — if expansion ever
targets that codebase instead.)

Env: `SHIP_BUY` (default 0) + per-type budget caps; `MULTI_SYSTEM` (default 0) gates the per-system
trade engine.

---

## 4. Suggested phasing (each step shippable + safe)

| Step | What | Risk |
|---|---|---|
| **E1** | Probe-partition module (§1) — pure, unit-testable now; no live effect until `PROBE_ROAM=1`. | none |
| **E2** | One-time send + pin + **recon** (§2): send a couple probes through I63, scout the target system, write its findings doc. No trading yet. | low |
| **E3** | Multi-system trade engine (§0 lifts): parameterize `coords`/`MARKET_WPS`/`getMarkets()` by system; scope lanes to the ship's resident system. | **high — core refactor** |
| **E4** | New-system gate build: parameterize gate-supply + feed + mining onto the new system's producer/asteroid waypoints (recursion of the playbook). | high |
| **E5** | In-system ship buying in the new system (§3): probes for coverage, a hauler for trade/gate. | medium |

**Open decisions (need user input before *executing*, not before coding E1):**

- Which of the 6 connected systems to target (requires E2 recon — none visited).
- Execution waits for gate completion (forced by mechanics).
- Appetite for the E3 multi-system refactor inside the single-file `bot2.mjs` vs. a more incremental
  approach — or targeting the v2 repo (`INKY_MIND_3`), which already has jump/warp, cross-system travel,
  probe-ML sizing, and outfitting built (but a *different* agent).

---

## Principles (carry into every new system)

1. **Map before you trade** — probes give live prices; an unmapped system is flown blind.
2. **Coverage is the cheapest ROI** — buy probes to 1:1 before buying expensive hulls.
3. **Send idle ships, don't buy redundant ones** — respect the saturation guard.
4. **Pin residency** — a relocated ship works its new system and never thrashes back across the gate.
5. **The playbook recurses** — Phases 0–5 (doc 01) run identically in the new system; only the
   waypoints change.
