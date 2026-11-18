import { hbModule, FontStore, FONTS } from './core/shaping.js';
import { buildPathFromParams, layoutCurvedText } from './core/layout.js';
import { buildScene, sceneToSVGString } from './core/render.js';
import { DEFAULT_PATH, DEFAULT_PARAMS, UI_DEFAULTS, paramsToQuery, paramsFromQuery, makeDocument, parseDocument } from './state.js';
import {
  clonePathParams, moveNode, moveControl, reversePathParams, deleteNode,
  splitSegment, nearestOnPath, insertNodeAtPoint,
} from './core/pathedit.js';

const WORLD = { width: 1280, height: 760 };

const els = {};
function $(id) { return document.getElementById(id); }

const app = {
  hb: null,
  store: null,
  params: { ...DEFAULT_PARAMS, features: { ...DEFAULT_PARAMS.features }, lengthTable: { ...DEFAULT_PARAMS.lengthTable }, variation: { ...DEFAULT_PARAMS.variation } },
  pathParams: clonePathParams(DEFAULT_PATH),
  pathReversed: false,
  path: null,
  font: null,
  layout: null,
  scene: null,
  view: { pan: { ...UI_DEFAULTS.pan }, zoom: 1 },
  history: [],
  historyIndex: -1,
  drag: null,
  hoverCluster: null,
  fontEpoch: 0,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  cacheElements();
  wireStaticControls();
  try {
    app.hb = await hbModule();
    app.store = new FontStore(app.hb);
    populateFontSelect();
    app.params = paramsFromQuery(window.location.search);
    syncControlsFromParams();
    await reloadFont();
    hideLoading();
    window.addEventListener('resize', () => { applyStageAspect(); if (app.view.zoom === 1) app.view.pan = { ...UI_DEFAULTS.pan }; renderStage(); });
    recompute();
    app.history = [snapshot()];
    app.historyIndex = 0;
    updateHistoryButtons();
    syncHash();
    exposeTestHooks();
  } catch (err) {
    console.error(err);
    showFatal(err);
  }
}

function exposeTestHooks() {
  window.__envelope = {
    getState: () => ({
      params: app.params,
      pathParams: app.pathParams,
      layout: app.layout,
      metrics: app.layout?.metrics,
      shaping: app.layout?.shaping,
      clusters: app.layout?.clusters,
      glyphs: app.layout?.glyphs,
      warnings: app.layout?.warnings,
      error: app.layout?.error,
      pathLength: app.path?.length,
      reversed: app.pathReversed,
    }),
    setParams: async (patch) => {
      const prevFont = app.params.fontId;
      const prevVariation = JSON.stringify(app.params.variation);
      Object.assign(app.params, patch);
      syncControlsFromParams();
      if (app.params.fontId !== prevFont || JSON.stringify(app.params.variation) !== prevVariation) {
        await reloadFont();
      }
      recompute();
    },
    setPath: (pathParams) => { app.pathParams = clonePathParams(pathParams); recompute(); },
    recompute,
  };
}

function cacheElements() {
  const ids = [
    'app', 'loading', 'fatal', 'fatal-message', 'text-input', 'text-stats', 'font-select',
    'font-size', 'font-wght', 'wght-value', 'wght-field', 'direction', 'language',
    'feat-liga', 'feat-kern', 'align', 'overflow', 'start-offset', 'offset-value',
    'btn-reverse', 'btn-reverse-toggle', 'reverse-hint', 'lt-mode', 'lt-tol', 'lt-tol-field', 'lt-samples',
    'lt-samples-field', 'lt-summary', 'node-list', 'stage-svg', 'canvas-wrap', 'toast',
    'show-baseline', 'show-tangents', 'show-boxes', 'show-outlines', 'show-clusters',
    'zoom-in', 'zoom-out', 'zoom-label', 'status-shaping', 'status-metrics', 'status-cursor',
    'shaping-kv', 'run-list', 'cluster-count', 'cluster-list', 'diag-count', 'diag-list',
    'metrics-kv', 'btn-undo', 'btn-redo', 'btn-svg', 'btn-png', 'btn-json', 'file-json', 'btn-fit',
  ];
  for (const id of ids) els[id] = $(id);
}

function hideLoading() { els.loading.hidden = true; els.app.hidden = false; }

function showFatal(err) {
  els.loading.hidden = true;
  els.fatal.hidden = false;
  els['fatal-message'].textContent =
    `${err?.message ?? err}\n\nThis app needs WebAssembly and ES modules. Serve the folder with “npm run dev”.`;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function populateFontSelect() {
  els['font-select'].innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
}

async function reloadFont() {
  const meta = FONTS.find((f) => f.id === app.params.fontId) ?? FONTS[0];
  const supportsVar = meta.axes && Object.keys(meta.axes).length > 0;
  const variation = supportsVar ? app.params.variation : {};
  if (!supportsVar) app.params.variation = {};
  els['wght-field'].hidden = !meta.axes?.wght;
  const epoch = ++app.fontEpoch;
  app.font = await app.store.load(meta, variation);
  if (epoch !== app.fontEpoch) return; // a newer load won
  els['wght-value'].textContent = String(app.params.variation.wght ?? 400);
  const hasWght = !!meta.axes?.wght;
  els['font-wght'].disabled = !hasWght;
}

function applyVariation() {
  if (!app.font) return;
  const meta = FONTS.find((f) => f.id === app.params.fontId);
  if (!meta?.axes?.wght) return;
  app.font.setVariation({ wght: Number(app.params.variation.wght ?? 400) });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function syncControlsFromParams() {
  els['text-input'].value = app.params.text;
  els['font-select'].value = app.params.fontId;
  els['font-size'].value = String(app.params.fontSize);
  els['font-wght'].value = String(app.params.variation.wght ?? 400);
  els['wght-value'].textContent = String(app.params.variation.wght ?? 400);
  els.direction.value = app.params.baseDirection;
  els.language.value = app.params.language;
  els['feat-liga'].checked = !!app.params.features.liga;
  els['feat-kern'].checked = !!app.params.features.kern;
  els.align.value = app.params.align;
  els.overflow.value = app.params.overflow;
  els['start-offset'].value = String(app.params.startOffset);
  els['offset-value'].textContent = String(Math.round(app.params.startOffset));
  els['lt-mode'].value = app.params.lengthTable.mode;
  els['lt-tol'].value = String(app.params.lengthTable.tolerance);
  els['lt-samples'].value = String(app.params.lengthTable.samples);
  els['lt-tol-field'].hidden = app.params.lengthTable.mode !== 'adaptive';
  els['lt-samples-field'].hidden = app.params.lengthTable.mode !== 'uniform';
  els['show-baseline'].checked = app.params.showBaseline;
  els['show-tangents'].checked = app.params.showTangents;
  els['show-boxes'].checked = app.params.showBoxes;
  els['show-outlines'].checked = app.params.showOutlines;
  els['show-clusters'].checked = app.params.showClusterInfo;
  updateReverseButtons();
}

function updateReverseButtons() {
  els['btn-reverse'].classList.toggle('active', !app.pathReversed);
  els['btn-reverse-toggle'].classList.toggle('active', app.pathReversed);
  els['reverse-hint'].innerHTML = app.pathReversed
    ? 'Path is <b>reversed</b>. Arcs are measured from the visual left end and every tangent is negated. Alignment follows this declared direction.'
    : 'Path is <b>forward</b>. Arcs are measured from the first node; alignment follows the drawn direction.';
}

function wireStaticControls() {
  els['text-input'].addEventListener('input', debounce(() => {
    app.params.text = els['text-input'].value;
    pushHistory();
    recompute();
  }, 90));

  els['font-select'].addEventListener('change', async () => {
    app.params.fontId = els['font-select'].value;
    pushHistory();
    await reloadFont();
    recompute();
  });

  els['font-size'].addEventListener('input', () => {
    app.params.fontSize = clamp(Number(els['font-size'].value), 4, 400);
    recompute();
  });
  els['font-size'].addEventListener('change', pushHistory);

  els['font-wght'].addEventListener('input', () => {
    app.params.variation.wght = Number(els['font-wght'].value);
    els['wght-value'].textContent = String(app.params.variation.wght);
    applyVariation();
    recompute();
  });
  els['font-wght'].addEventListener('change', pushHistory);

  els.direction.addEventListener('change', () => { app.params.baseDirection = els.direction.value; pushHistory(); recompute(); });
  els.language.addEventListener('change', () => { app.params.language = els.language.value || 'en'; pushHistory(); recompute(); });
  els['feat-liga'].addEventListener('change', () => { app.params.features.liga = els['feat-liga'].checked; pushHistory(); recompute(); });
  els['feat-kern'].addEventListener('change', () => { app.params.features.kern = els['feat-kern'].checked; pushHistory(); recompute(); });
  els.align.addEventListener('change', () => { app.params.align = els.align.value; pushHistory(); recompute(); });
  els.overflow.addEventListener('change', () => { app.params.overflow = els.overflow.value; pushHistory(); recompute(); });

  els['start-offset'].addEventListener('input', () => {
    app.params.startOffset = Number(els['start-offset'].value);
    els['offset-value'].textContent = String(Math.round(app.params.startOffset));
    recompute();
  });
  els['start-offset'].addEventListener('change', pushHistory);

  els['lt-mode'].addEventListener('change', () => {
    app.params.lengthTable.mode = els['lt-mode'].value;
    els['lt-tol-field'].hidden = app.params.lengthTable.mode !== 'adaptive';
    els['lt-samples-field'].hidden = app.params.lengthTable.mode !== 'uniform';
    pushHistory(); recompute();
  });
  els['lt-tol'].addEventListener('input', () => {
    app.params.lengthTable.tolerance = clamp(Number(els['lt-tol'].value), 0.001, 5);
    recompute();
  });
  els['lt-tol'].addEventListener('change', pushHistory);
  els['lt-samples'].addEventListener('input', () => {
    app.params.lengthTable.samples = Math.round(clamp(Number(els['lt-samples'].value), 4, 2000));
    recompute();
  });
  els['lt-samples'].addEventListener('change', pushHistory);

  els['btn-reverse'].addEventListener('click', () => setReversed(false));
  els['btn-reverse-toggle'].addEventListener('click', () => setReversed(true));

  for (const [id, key] of [
    ['show-baseline', 'showBaseline'], ['show-tangents', 'showTangents'],
    ['show-boxes', 'showBoxes'], ['show-outlines', 'showOutlines'],
    ['show-clusters', 'showClusterInfo'],
  ]) {
    els[id].addEventListener('change', () => { app.params[key] = els[id].checked; recompute(); });
  }

  els['zoom-in'].addEventListener('click', () => zoomBy(1.15));
  els['zoom-out'].addEventListener('click', () => zoomBy(1 / 1.15));
  els['btn-fit'].addEventListener('click', () => fitToViewport(true));

  els['btn-undo'].addEventListener('click', undo);
  els['btn-redo'].addEventListener('click', redo);
  els['btn-svg'].addEventListener('click', exportSVG);
  els['btn-png'].addEventListener('click', exportPNG);
  els['btn-json'].addEventListener('click', exportJSON);
  els['file-json'].addEventListener('change', loadJSONFile);

  window.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
    } else if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault(); redo();
    } else if (ev.key === '=' || ev.key === '+') zoomBy(1.15);
    else if (ev.key === '-') zoomBy(1 / 1.15);
  });

  window.addEventListener('popstate', () => {
    app.params = paramsFromQuery(window.location.search);
    syncControlsFromParams();
    reloadFont().then(recompute);
  });
}

function setReversed(reversed) {
  if (reversed === app.pathReversed) return;
  pushHistory();
  app.pathReversed = reversed;
  updateReverseButtons();
  recompute();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function snapshot() {
  return JSON.stringify({ params: app.params, pathParams: app.pathParams, reversed: app.pathReversed });
}

function pushHistory() {
  const snap = snapshot();
  if (app.history[app.historyIndex] === snap) return;
  app.history = app.history.slice(0, app.historyIndex + 1);
  app.history.push(snap);
  if (app.history.length > 80) app.history.shift();
  app.historyIndex = app.history.length - 1;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  els['btn-undo'].disabled = app.historyIndex <= 0;
  els['btn-redo'].disabled = app.historyIndex >= app.history.length - 1;
}

function restore(snap) {
  const s = JSON.parse(snap);
  app.params = s.params;
  app.pathParams = s.pathParams;
  app.pathReversed = s.reversed;
  syncControlsFromParams();
  reloadFont().then(() => recompute());
}

function undo() {
  if (app.historyIndex <= 0) return;
  app.historyIndex--;
  restore(app.history[app.historyIndex]);
  updateHistoryButtons();
}

function redo() {
  if (app.historyIndex >= app.history.length - 1) return;
  app.historyIndex++;
  restore(app.history[app.historyIndex]);
  updateHistoryButtons();
}

// ---------------------------------------------------------------------------
// Compute + render
// ---------------------------------------------------------------------------

function effectivePathParams() {
  return app.pathReversed ? reversePathParams(app.pathParams) : app.pathParams;
}

function recompute() {
  if (!app.font) return;
  const pp = effectivePathParams();
  app.path = buildPathFromParams({
    ...pp,
    lengthTable: app.params.lengthTable,
  });
  app.layout = layoutCurvedText(app.path, app.font, app.params);
  renderStage();
  renderSidePanels();
  updateStatusBar();
  syncHash();
}

function renderStage() {
  const wrap = els['canvas-wrap'];
  const width = wrap.clientWidth || WORLD.width;
  const height = wrap.clientHeight || WORLD.height;
  const { pan, zoom } = app.view;

  const scene = buildScene(app.layout, app.path, {
    width: WORLD.width,
    height: WORLD.height,
    background: '#f7f2e8',
    color: app.params.color,
    showBaseline: app.params.showBaseline,
    showTangents: app.params.showTangents,
    showBoxes: app.params.showBoxes,
    showOutlines: app.params.showOutlines,
    showAnchors: false,
    showClusterLabels: app.params.showClusterInfo,
    showBoundaries: app.layout?.metrics?.overflows,
    glyphAttrs: true,
    idPrefix: 'stage',
  });
  app.scene = scene;

  const glyphLayer = scene.body.join('\n');
  const nodes = app.path.nodes();
  const anchors = nodes.map((n, i) => `<g class="node-group" data-node="${i}">
      <circle class="anchor" data-node="${i}" cx="${n.x}" cy="${n.y}" r="7"/>
      <text class="node-label" x="${n.x + 10}" y="${n.y - 9}">${i}</text>
    </g>`).join('');
  const controls = app.path.segments.map((s, i) => {
    const lines = `<path class="ctrl-line" d="M${s.p0.x},${s.p0.y}L${s.c1.x},${s.c1.y}M${s.p1.x},${s.p1.y}L${s.c2.x},${s.c2.y}"/>`;
    const c1 = `<circle class="ctrl" data-seg="${i}" data-which="c1" cx="${s.c1.x}" cy="${s.c1.y}" r="5"/>`;
    const c2 = `<circle class="ctrl" data-seg="${i}" data-which="c2" cx="${s.c2.x}" cy="${s.c2.y}" r="5"/>`;
    return lines + c1 + c2;
  }).join('');

  els['stage-svg'].setAttribute('viewBox', `0 0 ${WORLD.width} ${WORLD.height}`);
  els['stage-svg'].setAttribute('preserveAspectRatio', 'xMidYMid meet');
  els['stage-svg'].innerHTML = `
    <rect id="stage-bg" width="${WORLD.width}" height="${WORLD.height}" fill="#f7f2e8"/>
    <g id="viewport" transform="translate(${pan.x},${pan.y}) scale(${zoom})">
      <rect class="hit" x="0" y="0" width="${WORLD.width}" height="${WORLD.height}" fill="transparent" id="stage-hit"/>
      ${glyphLayer}
      <g id="anchor-layer">
        ${controls}
        ${anchors}
      </g>
    </g>
  `;
  applyStageAspect();
  wireStageInteractions();
  els['zoom-label'].textContent = `${Math.round(zoom * 100)}%`;
}

// ---------------------------------------------------------------------------
// Stage interaction: drag anchors and control points, pan, insert, delete
// ---------------------------------------------------------------------------

function applyStageAspect() {
  // Size the SVG element itself to the world aspect, centered in its stage.
  // Then the browser's own coordinate mapping is 1:1 with the viewBox and
  // pointer maths stay exact at any zoom.
  const wrap = els['canvas-wrap'];
  const aw = wrap.clientWidth;
  const ah = wrap.clientHeight;
  if (!aw || !ah) return;
  const fit = Math.min(aw / WORLD.width, ah / WORLD.height);
  const w = Math.max(1, Math.round(WORLD.width * fit));
  const h = Math.max(1, Math.round(WORLD.height * fit));
  els['stage-svg'].style.width = `${w}px`;
  els['stage-svg'].style.height = `${h}px`;
  els['stage-svg'].style.marginLeft = `${Math.round((aw - w) / 2)}px`;
  els['stage-svg'].style.marginTop = `${Math.round((ah - h) / 2)}px`;
  els['stage-svg'].style.display = 'block';
}

function clientToWorld(ev) {
  const rect = els['stage-svg'].getBoundingClientRect();
  const scale = rect.width / WORLD.width;
  const offX = (rect.width - WORLD.width * scale) / 2;
  const offY = (rect.height - WORLD.height * scale) / 2;
  const sx = (ev.clientX - rect.left - offX) / scale;
  const sy = (ev.clientY - rect.top - offY) / scale;
  const { pan, zoom } = app.view;
  return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom };
}

function wireStageInteractions() {
  const svg = els['stage-svg'];
  // Delegated listeners are attached once. Inner markup is replaced on every
  // render, so per-element listeners would accumulate and fire many times.
  if (svg.dataset.wired === '1') return;
  svg.dataset.wired = '1';

  svg.addEventListener('pointerdown', onStagePointerDown);
  svg.addEventListener('pointermove', onStagePointerMove);
  svg.addEventListener('pointerup', onStagePointerUp);
  svg.addEventListener('pointercancel', onStagePointerUp);
  svg.addEventListener('pointerleave', () => {
    if (!app.drag) els['status-cursor'].textContent = '';
  });
  svg.addEventListener('dblclick', onStageDoubleClick);
  svg.addEventListener('wheel', onStageWheel, { passive: false });
  svg.addEventListener('pointerover', (ev) => {
    const el = ev.target.closest?.('[data-cluster]');
    if (el) highlightCluster(Number(el.dataset.cluster));
  });
  svg.addEventListener('pointerout', (ev) => {
    const el = ev.target.closest?.('[data-cluster]');
    if (el) highlightCluster(null);
  });
  svg.addEventListener('click', (ev) => {
    const anchor = ev.target.closest?.('.anchor');
    if (anchor && ev.altKey) {
      ev.stopPropagation();
      const i = Number(anchor.dataset.node);
      if (app.pathParams.nodes.length > 2) {
        app.pathParams = deleteNode(app.pathParams, i);
        recompute();
        pushHistory();
        toast('Node deleted');
      } else {
        toast('A path needs at least two nodes', 'error');
      }
    }
  });
  svg.oncontextmenu = (e) => e.preventDefault();
}

function hitTarget(ev) {
  const anchor = ev.target.closest?.('.anchor');
  if (anchor) return { kind: 'node', index: Number(anchor.dataset.node) };
  const ctrl = ev.target.closest?.('.ctrl');
  if (ctrl) return { kind: 'control', seg: Number(ctrl.dataset.seg), which: ctrl.dataset.which };
  return null;
}

function onStagePointerDown(ev) {
  if (app.drag) return;
  const hit = hitTarget(ev);
  if (hit) {
    ev.preventDefault();
    ev.stopPropagation();
    app.drag = { ...hit, moved: false, startClient: { x: ev.clientX, y: ev.clientY } };
    ev.target.classList?.add('drag');
    els['stage-svg'].setPointerCapture?.(ev.pointerId);
    return;
  }
  // Middle/right/shift, or any empty area, pans the view.
  app.drag = { kind: 'pan', start: { x: ev.clientX, y: ev.clientY }, orig: { ...app.view.pan }, moved: false };
  els['stage-svg'].setPointerCapture?.(ev.pointerId);
}

function onStagePointerMove(ev) {
  const p = clientToWorld(ev);
  els['status-cursor'].textContent = `x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)}`;
  const drag = app.drag;
  if (!drag) return;
  if (drag.kind === 'node') {
    app.pathParams = moveNode(app.pathParams, drag.index, round2(p.x), round2(p.y));
    if (Math.hypot(ev.clientX - drag.startClient.x, ev.clientY - drag.startClient.y) > 2) drag.moved = true;
    recomputeLive();
  } else if (drag.kind === 'control') {
    app.pathParams = moveControl(app.pathParams, drag.seg, drag.which, round2(p.x), round2(p.y));
    if (Math.hypot(ev.clientX - drag.startClient.x, ev.clientY - drag.startClient.y) > 2) drag.moved = true;
    recomputeLive();
  } else if (drag.kind === 'pan') {
    const dx = ev.clientX - drag.start.x;
    const dy = ev.clientY - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    app.view.pan = { x: drag.orig.x + dx, y: drag.orig.y + dy };
    updateViewportTransform();
  }
}

function onStagePointerUp(ev) {
  const drag = app.drag;
  app.drag = null;
  document.querySelectorAll('.drag').forEach((el) => el.classList.remove('drag'));
  if (drag && (drag.kind === 'node' || drag.kind === 'control') && drag.moved) {
    pushHistory();
    renderStage();
  }
}

function onStageDoubleClick(ev) {
  if (ev.target.classList.contains('anchor') || ev.target.classList.contains('ctrl')) return;
  const p = clientToWorld(ev);
  const res = insertNodeAtPoint(app.pathParams, app.path, p);
  if (res.inserted) {
    pushHistory();
    app.pathParams = res.path;
    recompute();
    renderNodeList();
    toast(`Node inserted at ${res.arc.toFixed(1)} px`);
  }
}

function onStageWheel(ev) {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  const factor = Math.exp(-ev.deltaY * 0.002);
  zoomBy(factor, { x: ev.clientX, y: ev.clientY });
}

function recomputeLive() {
  const pp = effectivePathParams();
  app.path = buildPathFromParams({ ...pp, lengthTable: app.params.lengthTable });
  app.layout = layoutCurvedText(app.path, app.font, app.params);
  const pan = app.view.pan;
  const zoom = app.view.zoom;
  const scene = buildScene(app.layout, app.path, {
    width: WORLD.width, height: WORLD.height, background: '#f7f2e8', color: app.params.color,
    showBaseline: app.params.showBaseline, showTangents: app.params.showTangents,
    showBoxes: app.params.showBoxes, showOutlines: app.params.showOutlines,
    showClusterLabels: app.params.showClusterInfo,
    showBoundaries: app.layout?.metrics?.overflows, glyphAttrs: true, idPrefix: 'stage',
  });
  app.scene = scene;
  const nodes = app.path.nodes();
  const anchors = nodes.map((n, i) => `<g class="node-group" data-node="${i}"><circle class="anchor" data-node="${i}" cx="${n.x}" cy="${n.y}" r="7"/><text class="node-label" x="${n.x + 10}" y="${n.y - 9}">${i}</text></g>`).join('');
  const controls = app.path.segments.map((s, i) => {
    const lines = `<path class="ctrl-line" d="M${s.p0.x},${s.p0.y}L${s.c1.x},${s.c1.y}M${s.p1.x},${s.p1.y}L${s.c2.x},${s.c2.y}"/>`;
    return lines + `<circle class="ctrl" data-seg="${i}" data-which="c1" cx="${s.c1.x}" cy="${s.c1.y}" r="5"/><circle class="ctrl" data-seg="${i}" data-which="c2" cx="${s.c2.x}" cy="${s.c2.y}" r="5"/>`;
  }).join('');
  els['stage-svg'].innerHTML = `
    <rect id="stage-bg" width="${WORLD.width}" height="${WORLD.height}" fill="#f7f2e8"/>
    <g id="viewport" transform="translate(${pan.x},${pan.y}) scale(${zoom})">
      <rect class="hit" x="0" y="0" width="${WORLD.width}" height="${WORLD.height}" fill="transparent" id="stage-hit"/>
      ${scene.body.join('\n')}
      <g id="anchor-layer">${controls}${anchors}</g>
    </g>`;
  wireStageInteractions();
  renderSidePanels();
  updateStatusBar();
}

function updateViewportTransform() {
  const vp = document.getElementById('viewport');
  if (vp) vp.setAttribute('transform', `translate(${app.view.pan.x},${app.view.pan.y}) scale(${app.view.zoom})`);
  els['zoom-label'].textContent = `${Math.round(app.view.zoom * 100)}%`;
}

function highlightCluster(index) {
  app.hoverCluster = index;
  document.querySelectorAll('#stage-svg .glyphs [data-cluster]').forEach((el) => {
    el.style.fill = index === null ? '' : Number(el.dataset.cluster) === index ? '#d9480f' : '';
  });
  document.querySelectorAll('.cluster-row').forEach((el) => {
    el.classList.toggle('hover', index !== null && Number(el.dataset.cluster) === index);
  });
}

function zoomBy(factor, anchor) {
  const next = clamp(app.view.zoom * factor, 0.25, 6);
  if (next === app.view.zoom) return;
  // Keep the anchor (or view centre) stable while zooming.
  const rect = els['stage-svg'].getBoundingClientRect();
  const cx = (anchor?.x ?? rect.left + rect.width / 2) - rect.left;
  const cy = (anchor?.y ?? rect.top + rect.height / 2) - rect.top;
  const scale = rect.width / WORLD.width;
  const wx = cx / scale;
  const wy = cy / scale;
  const ratio = next / app.view.zoom;
  app.view.pan = {
    x: wx - (wx - app.view.pan.x) * ratio,
    y: wy - (wy - app.view.pan.y) * ratio,
  };
  app.view.zoom = next;
  updateViewportTransform();
}

function fitToViewport(mark) {
  app.view = { pan: { ...UI_DEFAULTS.pan }, zoom: 1 };
  renderStage();
  if (mark) toast('View reset');
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

function renderSidePanels() {
  const layout = app.layout;
  const fontMeta = FONTS.find((f) => f.id === app.params.fontId);
  els['text-stats'].textContent = `${layout?.shaping?.charCount ?? 0} chars · ${layout?.shaping?.glyphCount ?? 0} glyphs`;
  els['text-stats'].className = 'pill';

  // Shaping summary
  if (layout?.ok) {
    const s = layout.shaping;
    els['shaping-kv'].innerHTML = [
      kv('Font', s.fontLabel),
      kv('Units/em', s.upem),
      kv('Size', `${s.fontSize} px`),
      kv('Scale', `${s.scale.toFixed(5)} px/unit`),
      kv('Runs', `${s.runCount} (${layout.runs.map((r) => `${r.dir}/${r.script}`).join(', ')})`),
      kv('Clusters', s.clusterCount),
      kv('Ligatures', layout.clusters.filter((c) => c.ligature).length),
      kv('Mark clusters', layout.clusters.filter((c) => c.hasMarks).length),
      kv('Features', s.features.length ? s.features.map((f) => f.tag).join(' ') : 'none'),
      kv('Variation', Object.entries(s.variation).map(([k, v]) => `${k}=${v}`).join(' ') || '—'),
    ].join('');
    els['run-list'].innerHTML = layout.runs.map((r) => `
      <div class="run-chip">
        <span class="dir ${r.dir}">${r.dir.toUpperCase()}</span>
        <span class="txt" dir="${r.dir}">${escapeHtml(r.text)}</span>
        <span>${r.glyphCount}g</span>
      </div>`).join('');

    els['cluster-count'].textContent = `${layout.clusters.length}`;
    const maxAdv = Math.max(1, ...layout.clusters.map((c) => c.advancePx));
    els['cluster-list'].innerHTML = layout.clusters.map((c) => {
      const cls = ['cluster-row'];
      if (c.ligature) cls.push('lig');
      if (c.hasMarks) cls.push('marks');
      if (c.clipped) cls.push('clipped');
      const label = c.source === ' ' ? '␠' : escapeHtml(c.source);
      const detail = c.dropped
        ? 'dropped'
        : `${c.arc === null ? '—' : c.arc.toFixed(1)}px · ${c.angleDeg === null ? '—' : c.angleDeg.toFixed(1)}°`;
      const adv = c.advancePx ? c.advancePx.toFixed(1) : '0';
      return `<div class="cluster-row ${cls.join(' ')}" data-cluster="${c.index}">
        <span class="src">${label}</span>
        <span class="meta">${detail}<br>adv ${adv}</span>
        <span class="bar"><i style="width:${(c.advancePx / maxAdv) * 100}%"></i></span>
      </div>`;
    }).join('');
    els['cluster-list'].querySelectorAll('.cluster-row').forEach((row) => {
      const idx = Number(row.dataset.cluster);
      row.addEventListener('pointerenter', () => highlightCluster(idx));
      row.addEventListener('pointerleave', () => highlightCluster(null));
    });

    els['metrics-kv'].innerHTML = [
      kv('Path length', `${layout.metrics.pathLength.toFixed(2)} px`),
      kv('Text advance', `${layout.metrics.advancePx.toFixed(2)} px`),
      kv('Offset', `${layout.metrics.offset.toFixed(1)} px`),
      kv('Align', layout.metrics.align),
      kv('Block start', `${layout.metrics.blockStart.toFixed(2)} px`),
      kv('Block end', `${layout.metrics.blockEnd.toFixed(2)} px`),
      kv('Overflow', `${layout.metrics.strategy}${layout.metrics.overflows ? ' (active)' : ''}`),
      kv('Placed', `${layout.metrics.placedGlyphs}/${layout.metrics.glyphCount}`),
      kv('Clipped', `${layout.metrics.clippedGlyphs}`),
      kv('Dropped clusters', `${layout.metrics.droppedClusters}`),
      kv('Extended glyphs', `${layout.metrics.extendedGlyphs}`),
      kv('Arc samples', `${layout.lengthTable.totalSamples}`),
      kv('Table mode', layout.lengthTable.mode),
    ].join('');
    els['lt-summary'].textContent = `${layout.lengthTable.totalSamples} samples`;
  } else {
    els['shaping-kv'].innerHTML = '';
    els['run-list'].innerHTML = '';
    els['cluster-list'].innerHTML = '';
    els['cluster-count'].textContent = '0';
    els['metrics-kv'].innerHTML = layout?.metrics ? [
      kv('Path length', `${layout.metrics.pathLength.toFixed(2)} px`),
      kv('Text advance', `${layout.metrics.advancePx.toFixed(2)} px`),
      kv('Deficit', `${Math.max(layout.metrics.overflowStart, layout.metrics.overflowEnd).toFixed(2)} px`),
    ].join('') : '';
    els['lt-summary'].textContent = '';
  }

  // Diagnostics: hard errors first, then warnings, then an info line.
  const diags = [];
  if (layout?.error) {
    diags.push(`<div class="diag error"><span class="code">${layout.error.code}</span>${escapeHtml(layout.error.message)}</div>`);
  }
  for (const w of layout?.warnings ?? []) {
    diags.push(`<div class="diag"><span class="code">${w.code}</span>${escapeHtml(w.message)}</div>`);
  }
  if (!diags.length && layout?.ok) {
    diags.push(`<div class="diag info"><span class="code">all-clear</span>Shaping and placement completed with no declared warnings.</div>`);
  }
  els['diag-list'].innerHTML = diags.join('');
  els['diag-count'].textContent = String((layout?.warnings?.length ?? 0) + (layout?.error ? 1 : 0));
  els['diag-count'].className = `pill ${layout?.error ? 'bad' : (layout?.warnings?.length ? 'warn' : 'ok')}`;

  renderNodeList();
}

function renderNodeList() {
  const nodes = app.pathParams.nodes;
  els['node-list'].innerHTML = nodes.map(([x, y], i) => `
    <div class="node-row">
      <span class="idx">${i}</span>
      <input type="number" step="1" value="${round2(x)}" data-node="${i}" data-axis="x" aria-label="Node ${i} x"/>
      <input type="number" step="1" value="${round2(y)}" data-node="${i}" data-axis="y" aria-label="Node ${i} y"/>
      <button data-del="${i}" title="Delete node" ${nodes.length <= 2 ? 'disabled' : ''}>×</button>
    </div>`).join('');

  els['node-list'].querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.dataset.node);
      const axis = inp.dataset.axis;
      const [x, y] = app.pathParams.nodes[idx];
      const val = Number(inp.value);
      pushHistory();
      app.pathParams = moveNode(app.pathParams, idx, axis === 'x' ? val : x, axis === 'y' ? val : y);
      recompute();
    });
  });
  els['node-list'].querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (app.pathParams.nodes.length <= 2) return;
      pushHistory();
      app.pathParams = deleteNode(app.pathParams, Number(btn.dataset.del));
      recompute();
    });
  });
}

function updateStatusBar() {
  const l = app.layout;
  if (!l) {
    els['status-shaping'].textContent = '';
    els['status-metrics'].textContent = '';
    return;
  }
  if (l.ok) {
    els['status-shaping'].textContent = `HarfBuzz ${app.hb.versionString()} · ${l.shaping.glyphCount} glyphs from ${l.shaping.charCount} chars · ${l.shaping.runCount} run(s)`;
    els['status-metrics'].textContent = `path ${l.metrics.pathLength.toFixed(1)}px · text ${l.metrics.advancePx.toFixed(1)}px · ${l.metrics.align} · ${l.metrics.strategy}`;
  } else {
    els['status-shaping'].textContent = `error: ${l.error?.code ?? 'unknown'}`;
    els['status-metrics'].textContent = l.metrics ? `path ${l.metrics.pathLength.toFixed(1)}px · text ${l.metrics.advancePx.toFixed(1)}px` : '';
  }
}

function kv(k, v) { return `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`; }

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportSVG() {
  if (!app.layout?.ok) { toast('Cannot export: fix the layout error first', 'error'); return; }
  const scene = buildScene(app.layout, app.path, {
    width: WORLD.width, height: WORLD.height,
    background: '#ffffff', color: app.params.color,
    showBaseline: false, showTangents: false,
    showBoxes: false, showOutlines: false,
    showClusterLabels: false, showAnchors: false,
    includeGlyphs: true, includeClipDefs: true,
    idPrefix: 'export',
  });
  const svg = sceneToSVGString(scene, `Curved text: ${app.params.text.slice(0, 60)}`);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'curved-text.svg');
  toast('SVG exported (real glyph outlines)', 'ok');
}

function exportPNG() {
  if (!app.layout?.ok) { toast('Cannot export: fix the layout error first', 'error'); return; }
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = WORLD.width * scale;
  canvas.height = WORLD.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  for (const g of app.layout.glyphs) {
    ctx.save();
    if (g.clip) {
      // Reproduce the same local clip quad exported to SVG.
      const { matrix } = g;
      const upem = app.layout.shaping.upem;
      const x0 = g.clip.x, x1 = g.clip.x + g.clip.width;
      const y0 = -upem * 1.5, y1 = upem * 1.5;
      const pt = (x, y) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
      const poly = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
    }
    ctx.fillStyle = app.params.color;
    ctx.fill(new Path2D(g.outline));
    ctx.restore();
  }
  canvas.toBlob((blob) => {
    downloadBlob(blob, 'curved-text.png');
    toast('PNG exported at 2×', 'ok');
  }, 'image/png');
}

function exportJSON() {
  // Store the authored (unreversed) path plus the reverse flag; loading then
  // reproduces the same effective path exactly once.
  const doc = makeDocument(app.params, app.pathParams);
  doc.reversed = app.pathReversed;
  downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), 'curved-text.json');
  toast('Parameters saved — reloading this JSON reproduces the layout', 'ok');
}

async function loadJSONFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const doc = parseDocument(text);
    pushHistory();
    app.params = doc.params;
    app.pathParams = doc.path;
    app.pathReversed = !!doc.reversed;
    syncControlsFromParams();
    await reloadFont();
    recompute();
    toast('Document loaded', 'ok');
  } catch (err) {
    toast(`Could not load JSON: ${err.message}`, 'error');
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function syncHash() {
  const q = paramsToQuery(app.params).toString();
  const next = `${window.location.pathname}?${q}`;
  window.history.replaceState(null, '', next);
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = els.toast;
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round(n * 100) / 100; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
