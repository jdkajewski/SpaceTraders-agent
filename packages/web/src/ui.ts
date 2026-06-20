import type { RankedSystem } from '@st/shared';
import type { SystemDetail } from './api.js';
import { scoreToColor } from './graph.js';

/** Query a required element, throwing early if the markup drifts. */
export function requireEl<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

interface ElOptions {
  className?: string;
  text?: string;
  title?: string;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: HTMLElement[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className !== undefined) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title !== undefined) node.title = opts.title;
  for (const child of children) node.appendChild(child);
  return node;
}

function badge(label: string, kind: string): HTMLElement {
  return h('span', { className: `badge badge-${kind}`, text: label });
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { className: 'stat' }, [
    h('span', { className: 'stat-label', text: label }),
    h('span', { className: 'stat-value', text: value }),
  ]);
}

/** Render the colour/size legend so encodings are self-explanatory. */
export function renderLegend(container: HTMLElement, maxScore: number): void {
  container.replaceChildren();
  container.appendChild(h('h2', { text: 'Legend' }));

  const ramp = h('div', { className: 'legend-ramp' });
  for (let i = 0; i <= 5; i++) {
    const score = (i / 5) * (maxScore || 1);
    const swatch = h('span', { className: 'legend-swatch', title: `score ≈ ${score.toFixed(1)}` });
    swatch.style.background = scoreToColor(score, maxScore || 1);
    ramp.appendChild(swatch);
  }
  container.appendChild(
    h('div', { className: 'legend-row' }, [
      h('span', { className: 'muted', text: 'low' }),
      ramp,
      h('span', { className: 'muted', text: 'rich' }),
    ]),
  );

  container.appendChild(
    h('ul', { className: 'legend-list' }, [
      legendItem('legend-dot home', 'Home system'),
      legendItem('legend-dot unreachable', 'Unreachable (no built gate path)'),
      legendItem('legend-line traversable', 'Traversable gate (both ends built)'),
      legendItem('legend-line blocked', 'Gate not yet jumpable'),
    ]),
  );
}

function legendItem(markClass: string, label: string): HTMLElement {
  return h('li', {}, [h('span', { className: markClass }), h('span', { text: label })]);
}

/** Render the ranked colonization shortlist; clicking a row focuses its node. */
export function renderRanked(
  listEl: HTMLElement,
  ranked: RankedSystem[],
  onSelect: (symbol: string) => void,
): void {
  listEl.replaceChildren();
  for (const r of ranked.slice(0, 25)) {
    const item = h('li', { className: 'ranked-item' });
    const button = h('button', { className: 'ranked-btn', title: r.symbol });
    button.type = 'button';
    button.appendChild(h('span', { className: 'ranked-sym', text: r.symbol }));
    button.appendChild(h('span', { className: 'ranked-score', text: r.score.toFixed(1) }));
    if (!r.reachable) button.appendChild(badge('gated', 'warn'));
    if (r.sellsFueledHull) button.appendChild(badge('hull', 'good'));
    button.addEventListener('click', () => {
      onSelect(r.symbol);
    });
    item.appendChild(button);
    listEl.appendChild(item);
  }
  if (ranked.length === 0) {
    listEl.appendChild(h('li', { className: 'muted', text: 'No ranked systems yet.' }));
  }
}

/** Render the click-through detail panel for a single system. */
export function renderDetail(container: HTMLElement, detail: SystemDetail): void {
  const { system, richness, edgesOut, edgesIn } = detail;
  container.replaceChildren();

  const badges = h('div', { className: 'badge-row' });
  if (system.isHome) badges.appendChild(badge('home', 'home'));
  badges.appendChild(badge(system.reachable ? 'reachable' : 'unreachable', system.reachable ? 'good' : 'warn'));
  badges.appendChild(badge(system.gateBuilt ? 'gate built' : 'gate unbuilt', system.gateBuilt ? 'good' : 'muted'));

  container.appendChild(h('h2', { className: 'detail-title', text: system.symbol }));
  container.appendChild(badges);

  container.appendChild(
    h('div', { className: 'stat-grid' }, [
      stat('Hops from home', system.hopsFromHome === null ? '—' : String(system.hopsFromHome)),
      stat('Coords', system.x === null || system.y === null ? 'unknown' : `${system.x}, ${system.y}`),
      stat('Gate waypoint', system.gateWaypoint ?? '—'),
      stat('Last crawled', formatDate(system.lastCrawledAt)),
    ]),
  );

  if (richness) {
    container.appendChild(h('h3', { text: 'Market richness' }));
    container.appendChild(
      h('div', { className: 'stat-grid' }, [
        stat('Score', richness.score.toFixed(2)),
        stat('Marketplaces', String(richness.marketplaceCount)),
        stat('Shipyards', String(richness.shipyardCount)),
        stat('Import sites', String(richness.importSiteCount)),
        stat('Import goods', String(richness.importGoodsTotal)),
        stat('Detail level', richness.detailLevel),
      ]),
    );
    if (richness.premiumShipTypes.length > 0) {
      const ships = h('div', { className: 'badge-row' });
      for (const t of richness.premiumShipTypes) ships.appendChild(badge(t, 'ship'));
      container.appendChild(h('h3', { text: `Premium ships (${String(richness.premiumShipCount)})` }));
      container.appendChild(ships);
    }
    if (richness.sellsFueledHull) {
      container.appendChild(h('p', { className: 'note', text: 'Sells a fueled hull (buy local).' }));
    }
  } else {
    container.appendChild(h('p', { className: 'muted', text: 'No richness data crawled yet.' }));
  }

  container.appendChild(h('h3', { text: `Gates (${String(edgesOut.length)} out · ${String(edgesIn.length)} in)` }));
  container.appendChild(renderEdgeList('Out', edgesOut.map((e) => ({ sym: e.toSystem, traversable: e.traversable }))));
  container.appendChild(renderEdgeList('In', edgesIn.map((e) => ({ sym: e.fromSystem, traversable: e.traversable }))));
}

function renderEdgeList(heading: string, edges: { sym: string; traversable: boolean }[]): HTMLElement {
  const wrap = h('div', { className: 'edge-list' }, [h('h4', { text: heading })]);
  if (edges.length === 0) {
    wrap.appendChild(h('p', { className: 'muted', text: 'none' }));
    return wrap;
  }
  const ul = h('ul');
  for (const e of edges) {
    ul.appendChild(
      h('li', { className: e.traversable ? 'edge-ok' : 'edge-blocked' }, [
        h('span', { text: e.sym }),
        badge(e.traversable ? 'open' : 'blocked', e.traversable ? 'good' : 'muted'),
      ]),
    );
  }
  wrap.appendChild(ul);
  return wrap;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Show / clear the top status banner (loading + error surface). */
export function setStatus(banner: HTMLElement, message: string | null, kind: 'info' | 'error' = 'info'): void {
  if (message === null) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.className = `status-${kind}`;
  banner.textContent = message;
}
