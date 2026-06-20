import { fetchGraph, fetchRanked, fetchSystem } from './api.js';
import { buildGraphModel } from './graph.js';
import { createRenderer, type Renderer } from './render.js';
import { renderDetail, renderLegend, renderRanked, requireEl, setStatus } from './ui.js';
import './style.css';

async function main(): Promise<void> {
  const banner = requireEl<HTMLDivElement>('#status-banner');
  const graphContainer = requireEl<HTMLDivElement>('#graph');
  const detailContainer = requireEl<HTMLElement>('#detail');
  const legendContainer = requireEl<HTMLElement>('#legend');
  const rankedList = requireEl<HTMLOListElement>('#ranked-list');
  const search = requireEl<HTMLInputElement>('#search');
  const toggleUnreachable = requireEl<HTMLInputElement>('#toggle-unreachable');
  const toggleHops = requireEl<HTMLInputElement>('#toggle-hops');
  const resetView = requireEl<HTMLButtonElement>('#reset-view');

  setStatus(banner, 'Loading galaxy…', 'info');

  let graphData;
  let ranked;
  try {
    [graphData, ranked] = await Promise.all([fetchGraph(), fetchRanked(500)]);
  } catch (err) {
    setStatus(banner, `Failed to load galaxy: ${describeError(err)}`, 'error');
    return;
  }

  const model = buildGraphModel(graphData, ranked);
  if (model.nodes.length === 0) {
    setStatus(banner, 'No systems yet — run the crawler or seed fixtures (pnpm --filter @st/web seed:fixtures).', 'info');
    return;
  }

  let activeDetail: string | null = null;

  const renderer: Renderer = createRenderer(graphContainer, model, {
    onClickNode: (symbol) => {
      void selectSystem(symbol);
    },
  });

  renderLegend(legendContainer, model.maxScore);
  renderRanked(rankedList, ranked, (symbol) => {
    void selectSystem(symbol);
  });

  setStatus(
    banner,
    `${String(model.nodes.length)} systems · ${String(model.edges.length)} gates` +
      (model.needsLayout ? ' · force layout (missing coords)' : ''),
    'info',
  );

  async function selectSystem(symbol: string): Promise<void> {
    activeDetail = symbol;
    renderer.focus(symbol);
    detailContainer.replaceChildren();
    detailContainer.textContent = `Loading ${symbol}…`;
    try {
      const detail = await fetchSystem(symbol);
      if (activeDetail !== symbol) return; // a newer selection won
      renderDetail(detailContainer, detail);
    } catch (err) {
      detailContainer.textContent = `Failed to load ${symbol}: ${describeError(err)}`;
    }
  }

  toggleUnreachable.addEventListener('change', () => {
    renderer.setShowUnreachable(toggleUnreachable.checked);
  });
  toggleHops.addEventListener('change', () => {
    renderer.setShadeByHops(toggleHops.checked);
  });
  resetView.addEventListener('click', () => {
    activeDetail = null;
    renderer.focus(null);
    void renderer.sigma.getCamera().animatedReset();
  });

  const symbols = model.nodes.map((n) => n.symbol);
  search.addEventListener('change', () => {
    const term = search.value.trim().toUpperCase();
    if (!term) return;
    const match = symbols.find((s) => s.toUpperCase() === term) ?? symbols.find((s) => s.toUpperCase().includes(term));
    if (match) void selectSystem(match);
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void main();
