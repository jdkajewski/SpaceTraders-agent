/**
 * expansion/partition.ts — pure helpers for the inter-system expansion subsystem.
 *
 * `partitionMarkets` is the OUTPROBE 1:1 market-coverage arc math, extracted verbatim
 * from `expansion.mjs` `stepOutpost` (DRIFT #29). Each resident probe owns a contiguous
 * arc of its outpost's markets and only refreshes ITS arc; when probes >= markets each
 * owns a single market and parks there (presence ⇒ live prices) — full 1:1 fresh coverage
 * at minimal API. Kept pure so it can be unit-tested in isolation.
 */

/** System symbol of a waypoint (`X1-PP30-D18A` → `X1-PP30`). */
export const sysOf = (wp: string): string => wp.split('-').slice(0, 2).join('-');

/**
 * The contiguous market arc owned by probe `idx` of `n` resident probes, over the
 * ordered `wps` list. (expansion.mjs `stepOutpost`)
 *
 * ```
 * lo = floor(idx * L / n)
 * hi = max(floor((idx + 1) * L / n), lo + 1)   // the `lo+1` guarantees ≥1 market per probe
 * arc = wps.slice(lo, hi)
 * ```
 *
 * Properties (for `n ≤ L`): the arcs are disjoint, balanced (sizes differ by ≤1), and
 * cover every market exactly once; they converge to exactly one market each when `n == L`.
 *
 * QUIRK (DRIFT #29): when `n > L` (more probes than markets) the `lo+1` floor forces an
 * arc onto probes whose natural slice is empty, so trailing probes share/overlap the last
 * market. Preserved verbatim for parity (resolved in Wave 6 if undesired).
 */
export function partitionMarkets(wps: readonly string[], idx: number, n: number): string[] {
  const L = wps.length;
  const divisor = n || 1;
  const i = Math.max(0, idx);
  const lo = Math.floor((i * L) / divisor);
  const hi = Math.max(Math.floor(((i + 1) * L) / divisor), lo + 1);
  return wps.slice(lo, hi);
}
