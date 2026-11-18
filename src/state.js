// Document state: everything needed to reproduce a layout, plus defaults for
// the print "envelope" demo. Pure data — safe to serialize into the URL/hash,
// a JSON download, or the CLI.

export const DEFAULT_PATH = {
  nodes: [
    [110, 490],
    [400, 280],
    [700, 320],
    [940, 430],
    [1080, 390],
    [1200, 440],
  ],
  controls: [
    { c1: [220, 420], c2: [340, 310] },
    { c1: [540, 265], c2: [650, 300] },
    { c1: [820, 360], c2: [900, 405] },
    { c1: [1000, 448], c2: [1045, 400] },
    { c1: [1140, 407], c2: [1170, 423] },
  ],
};

export const DEFAULT_PARAMS = {
  text: '“office” ﬁx — déjà vu, q́ ffi! PRINT’S ﬁne',
  fontId: 'notosans',
  fontSize: 56,
  startOffset: 0,
  align: 'center',
  overflow: 'clip',
  baseDirection: 'auto',
  language: 'en',
  features: { liga: true, kern: true },
  variation: { wght: 500 },
  lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64 },
  color: '#1d2430',
  showBaseline: true,
  showTangents: true,
  showOutlines: false,
  showBoxes: false,
  showClusterInfo: true,
};

export const UI_DEFAULTS = {
  canvas: { width: 1280, height: 760 },
  pan: { x: 40, y: 20 },
  zoom: 1,
};

// Serialize/deserialize a full document. Path is included so a saved JSON is
// sufficient to reproduce the layout without any extra state.
export function makeDocument(state, pathParams) {
  return {
    format: 'envelope-curve-type/1',
    params: { ...state },
    path: { nodes: pathParams.nodes, controls: pathParams.controls },
    savedAt: new Date().toISOString(),
  };
}

export function parseDocument(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  if (!doc || doc.format !== 'envelope-curve-type/1') {
    throw new Error('Not an envelope-curve-type document (format mismatch).');
  }
  if (!Array.isArray(doc.path?.nodes) || !Array.isArray(doc.path?.controls)) {
    throw new Error('Document is missing path nodes/controls.');
  }
  return {
    params: { ...DEFAULT_PARAMS, ...doc.params, features: { ...DEFAULT_PARAMS.features, ...(doc.params?.features ?? {}) }, lengthTable: { ...DEFAULT_PARAMS.lengthTable, ...(doc.params?.lengthTable ?? {}) }, variation: { ...DEFAULT_PARAMS.variation, ...(doc.params?.variation ?? {}) } },
    path: doc.path,
    reversed: !!doc.reversed,
  };
}

export function paramsToQuery(params) {
  const q = new URLSearchParams();
  q.set('text', params.text);
  q.set('font', params.fontId);
  q.set('size', String(params.fontSize));
  q.set('offset', String(params.startOffset));
  q.set('align', params.align);
  q.set('overflow', params.overflow);
  q.set('dir', params.baseDirection);
  q.set('lang', params.language);
  q.set('liga', params.features.liga ? '1' : '0');
  q.set('kern', params.features.kern ? '1' : '0');
  q.set('wght', String(params.variation.wght ?? 400));
  q.set('ltmode', params.lengthTable.mode);
  q.set('lttol', String(params.lengthTable.tolerance));
  q.set('ltsamples', String(params.lengthTable.samples));
  q.set('color', params.color.replace('#', ''));
  return q;
}

export function paramsFromQuery(search) {
  const q = new URLSearchParams(search);
  const params = { ...DEFAULT_PARAMS, features: { ...DEFAULT_PARAMS.features }, lengthTable: { ...DEFAULT_PARAMS.lengthTable }, variation: { ...DEFAULT_PARAMS.variation } };
  if (q.has('text')) params.text = q.get('text');
  if (q.has('font')) params.fontId = q.get('font');
  if (q.has('size')) params.fontSize = clampNum(q.get('size'), 4, 400, params.fontSize);
  if (q.has('offset')) params.startOffset = clampNum(q.get('offset'), 0, 100000, params.startOffset);
  if (q.has('align') && ['start', 'center', 'end'].includes(q.get('align'))) params.align = q.get('align');
  if (q.has('overflow') && ['clip', 'extend', 'error'].includes(q.get('overflow'))) params.overflow = q.get('overflow');
  if (q.has('dir') && ['auto', 'ltr', 'rtl'].includes(q.get('dir'))) params.baseDirection = q.get('dir');
  if (q.has('lang')) params.language = q.get('lang');
  if (q.has('liga')) params.features.liga = q.get('liga') === '1';
  if (q.has('kern')) params.features.kern = q.get('kern') === '1';
  if (q.has('wght')) params.variation.wght = clampNum(q.get('wght'), 100, 900, params.variation.wght);
  if (q.has('ltmode') && ['uniform', 'adaptive'].includes(q.get('ltmode'))) params.lengthTable.mode = q.get('ltmode');
  if (q.has('lttol')) params.lengthTable.tolerance = clampNum(q.get('lttol'), 0.001, 5, params.lengthTable.tolerance);
  if (q.has('ltsamples')) params.lengthTable.samples = Math.round(clampNum(q.get('ltsamples'), 4, 2000, params.lengthTable.samples));
  if (q.has('color') && /^[0-9a-fA-F]{6}$/.test(q.get('color'))) params.color = `#${q.get('color')}`;
  return params;
}

function clampNum(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
