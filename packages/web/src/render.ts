import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types';
import { HOME_COLOR, hopsToColor, type GraphModel, type VizEdge, type VizNode } from './graph.js';

const DIM_NODE = '#2f343d';
const UNREACHABLE_NODE = '#3a3f47';
const EDGE_TRAVERSABLE = 'rgba(120, 200, 255, 0.45)';
const EDGE_BLOCKED = 'rgba(140, 150, 170, 0.16)';
const EDGE_FOCUS = 'rgba(120, 200, 255, 0.85)';

export interface RendererHandlers {
  onClickNode: (symbol: string) => void;
}

export interface Renderer {
  sigma: Sigma;
  setShowUnreachable: (show: boolean) => void;
  setShadeByHops: (shade: boolean) => void;
  focus: (symbol: string | null) => void;
  destroy: () => void;
}

interface RenderState {
  showUnreachable: boolean;
  shadeByHops: boolean;
  hovered: string | null;
  selected: string | null;
  focusNeighbors: Set<string>;
}

function buildGraphologyGraph(model: GraphModel): {
  graph: Graph;
  nodeIndex: Map<string, VizNode>;
  edgeIndex: Map<string, VizEdge>;
} {
  const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
  const nodeIndex = new Map<string, VizNode>();
  const edgeIndex = new Map<string, VizEdge>();

  for (const n of model.nodes) {
    nodeIndex.set(n.symbol, n);
    // Seed positions: real coords when known, random otherwise (force layout relaxes).
    const x = n.x ?? Math.random() * 1000;
    const y = n.y ?? Math.random() * 1000;
    graph.addNode(n.symbol, {
      x,
      y,
      size: n.size,
      color: n.color,
      label: n.symbol,
    });
  }

  for (const e of model.edges) {
    if (graph.hasDirectedEdge(e.from, e.to)) continue;
    edgeIndex.set(e.key, e);
    graph.addDirectedEdgeWithKey(e.key, e.from, e.to, {
      size: e.traversable ? 1.4 : 0.7,
      color: e.traversable ? EDGE_TRAVERSABLE : EDGE_BLOCKED,
    });
  }

  return { graph, nodeIndex, edgeIndex };
}

function applyForceLayout(graph: Graph): void {
  const settings = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, { iterations: 220, settings });
}

export function createRenderer(
  container: HTMLElement,
  model: GraphModel,
  handlers: RendererHandlers,
): Renderer {
  const { graph, nodeIndex, edgeIndex } = buildGraphologyGraph(model);

  // Real coords when every node had them; force-directed fallback otherwise.
  if (model.needsLayout) applyForceLayout(graph);

  const state: RenderState = {
    showUnreachable: true,
    shadeByHops: false,
    hovered: null,
    selected: null,
    focusNeighbors: new Set(),
  };

  const sigma = new Sigma(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 10,
    labelColor: { color: '#d7dce5' },
    defaultEdgeColor: EDGE_BLOCKED,
    nodeReducer: (node) => nodeReducer(node, nodeIndex, state),
    edgeReducer: (edge) => edgeReducer(edge, edgeIndex, state),
  });

  sigma.on('enterNode', ({ node }) => {
    state.hovered = node;
    sigma.refresh({ skipIndexation: true });
  });
  sigma.on('leaveNode', () => {
    state.hovered = null;
    sigma.refresh({ skipIndexation: true });
  });
  sigma.on('clickNode', ({ node }) => {
    handlers.onClickNode(node);
  });

  function setFocus(symbol: string | null): void {
    state.selected = symbol;
    state.focusNeighbors = new Set(symbol ? graph.neighbors(symbol) : []);
    if (symbol && graph.hasNode(symbol)) {
      const display = sigma.getNodeDisplayData(symbol);
      if (display) {
        void sigma.getCamera().animate({ x: display.x, y: display.y, ratio: 0.45 }, { duration: 400 });
      }
    }
    sigma.refresh({ skipIndexation: true });
  }

  return {
    sigma,
    setShowUnreachable: (show) => {
      state.showUnreachable = show;
      sigma.refresh({ skipIndexation: true });
    },
    setShadeByHops: (shade) => {
      state.shadeByHops = shade;
      sigma.refresh({ skipIndexation: true });
    },
    focus: setFocus,
    destroy: () => {
      sigma.kill();
    },
  };
}

function nodeReducer(
  node: string,
  index: Map<string, VizNode>,
  state: RenderState,
): Partial<NodeDisplayData> {
  const meta = index.get(node);
  const res: Partial<NodeDisplayData> = {};
  if (!meta) return res;

  if (!meta.reachable && !state.showUnreachable) {
    res.hidden = true;
    return res;
  }

  // Base colour: hops shading toggle, then home override, then richness colour.
  if (meta.isHome) {
    res.color = HOME_COLOR;
  } else if (state.shadeByHops) {
    res.color = hopsToColor(meta.hopsFromHome);
  } else if (!meta.reachable) {
    res.color = UNREACHABLE_NODE;
  } else {
    res.color = meta.color;
  }

  // Home always reads larger; expansion targets get a touch more presence.
  res.size = meta.isHome ? Math.max(meta.size, 14) : meta.size;

  const focus = state.selected ?? state.hovered;
  if (focus) {
    const isFocus = node === focus;
    const isNeighbor = state.focusNeighbors.has(node);
    if (isFocus) {
      res.zIndex = 2;
      res.size = res.size * 1.3;
      res.forceLabel = true;
    } else if (isNeighbor) {
      res.zIndex = 1;
      res.forceLabel = true;
    } else {
      res.color = DIM_NODE;
      res.label = '';
      res.zIndex = 0;
    }
  }

  return res;
}

function edgeReducer(
  edge: string,
  index: Map<string, VizEdge>,
  state: RenderState,
): Partial<EdgeDisplayData> {
  const meta = index.get(edge);
  const res: Partial<EdgeDisplayData> = {};
  if (!meta) return res;

  const focus = state.selected ?? state.hovered;
  if (focus) {
    const incident = meta.from === focus || meta.to === focus;
    if (incident) {
      res.color = meta.traversable ? EDGE_FOCUS : EDGE_BLOCKED;
      res.size = meta.traversable ? 2 : 1;
      res.zIndex = 1;
    } else {
      res.hidden = true;
    }
    return res;
  }

  res.color = meta.traversable ? EDGE_TRAVERSABLE : EDGE_BLOCKED;
  res.size = meta.traversable ? 1.4 : 0.7;
  return res;
}
