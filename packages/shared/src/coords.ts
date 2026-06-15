/**
 * @st/shared — waypoint coordinates + distance function
 *
 * Mirrors the coords logic from bot2.mjs lines 303–307:
 *   const coords = {};
 *   for (const l of fs.readFileSync('./coords.csv').trim().split('\n').slice(1))
 *     { const [w,x,y] = l.split(','); coords[w] = [+x, +y]; }
 *   const D = (a,b) => (coords[a]&&coords[b] ? Math.round(Math.hypot(...)) : 1e9);
 *
 * The exported `distance()` function is pure: it accepts the coords map as a
 * parameter so it is unit-testable without touching the filesystem.
 *
 * `loadCoordsFromCsv(source)` accepts either a file path (string ending in .csv)
 * OR a raw CSV string — letting tests inject fixture data directly.
 */

import { readFileSync } from 'node:fs';
import { CROSS_SYSTEM_DIST } from './constants.js';

export type CoordsMap = Readonly<Record<string, readonly [number, number]>>;

/**
 * Parse a coords CSV string (or file path) into a waypoint→[x,y] map.
 * CSV format: header row, then `SYMBOL,x,y` per line.
 *
 * @param source  A raw CSV string OR a filesystem path to a .csv file.
 */
export function loadCoordsFromCsv(source: string): CoordsMap {
  const raw =
    source.trim().includes('\n') || !source.endsWith('.csv')
      ? source // inline CSV content
      : readFileSync(source, 'utf8');

  const coords: Record<string, [number, number]> = {};
  const lines = raw.trim().split('\n');
  // skip header row
  for (const line of lines.slice(1)) {
    const [w, x, y] = line.split(',');
    if (w && x !== undefined && y !== undefined) {
      coords[w.trim()] = [+x, +y];
    }
  }
  return coords;
}

/**
 * Distance between two waypoints (rounded integer).
 * Returns `CROSS_SYSTEM_DIST` (1e9) if either waypoint is absent from the map
 * (i.e. different system or unknown). Mirrors `D()` in bot2.mjs exactly.
 *
 * @param a       Source waypoint symbol.
 * @param b       Destination waypoint symbol.
 * @param coords  Coordinate map produced by `loadCoordsFromCsv`.
 */
export function distance(a: string, b: string, coords: CoordsMap): number {
  const ca = coords[a];
  const cb = coords[b];
  if (ca === undefined || cb === undefined) return CROSS_SYSTEM_DIST;
  return Math.round(Math.hypot(ca[0] - cb[0], ca[1] - cb[1]));
}
