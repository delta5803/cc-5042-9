// Shared fixtures for the node test suite. Loads HarfBuzz and fonts once.

import { hbModule, FontStore, FONTS } from '../src/core/shaping.js';
import { BezierPath, makeLineSegment } from '../src/geometry.js';
import { buildPathFromParams, layoutCurvedText } from '../src/core/layout.js';
import { DEFAULT_PARAMS } from '../src/state.js';

let storePromise = null;

export async function fontStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const hb = await hbModule();
      return { hb, store: new FontStore(hb) };
    })();
  }
  const { hb, store } = await storePromise;
  return { hb, store };
}

export async function font(id = 'notosans', variation = {}) {
  const { store } = await fontStore();
  const meta = FONTS.find((f) => f.id === id);
  if (!meta) throw new Error(`unknown font ${id}`);
  return store.load(meta, variation);
}

export function linePath(x0, y0, x1, y1, table = {}) {
  const p = new BezierPath([makeLineSegment({ x: x0, y: y0 }, { x: x1, y: y1 })]);
  p.rebuild(table);
  return p;
}

export function params(patch = {}) {
  return {
    ...DEFAULT_PARAMS,
    features: { ...DEFAULT_PARAMS.features },
    variation: { ...DEFAULT_PARAMS.variation },
    lengthTable: { ...DEFAULT_PARAMS.lengthTable },
    ...patch,
  };
}

// Build the default six-node path with explicit length-table options.
export function defaultPath(table = {}) {
  return buildPathFromParams({
    nodes: [
      [110, 490], [400, 280], [700, 320], [940, 430], [1080, 390], [1200, 440],
    ],
    controls: [
      { c1: [220, 420], c2: [340, 310] }, { c1: [540, 265], c2: [650, 300] },
      { c1: [820, 360], c2: [900, 405] }, { c1: [1000, 448], c2: [1045, 400] },
      { c1: [1140, 407], c2: [1170, 423] },
    ],
    lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64, ...table },
  });
}

export function layout(path, handle, patch = {}) {
  return layoutCurvedText(path, handle, params(patch));
}

// Approximate cubic circle quadrant radius r using the standard kappa.
export function circleQuadrantTable(r = 100, table = {}) {
  const k = 0.5522847498307936;
  const seg = {
    kind: 'cubic',
    p0: { x: r, y: 0 },
    c1: { x: r, y: k * r },
    c2: { x: k * r, y: r },
    p1: { x: 0, y: r },
  };
  return { seg, quarterArc: (Math.PI * r) / 2 };
}

export function closeTo(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label ?? 'value'}: expected ${expected} ±${tol}, got ${actual} (Δ ${actual - expected})`);
  }
}
