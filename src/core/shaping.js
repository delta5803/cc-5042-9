// Real font shaping via HarfBuzz (WASM) with Unicode bidi segmentation.
// Cluster values are UTF-16 indices into the original string, so glyph groups
// can be mapped back to user text exactly — ligatures (many chars -> 1 glyph)
// and combining marks (1 char -> many glyphs) remain intact.

import { loadHarfBuzzModule, fetchFontBytes } from './platform.js';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

let hbPromise = null;
export function hbModule() {
  if (!hbPromise) hbPromise = loadHarfBuzzModule();
  return hbPromise;
}

export const FONTS = [
  {
    id: 'notosans',
    label: 'Noto Sans (variable)',
    url: '/fonts/NotoSans-VF.ttf',
    axes: { wght: [100, 900, 400], wdth: [62.5, 100, 100] },
  },
  {
    id: 'notoserif',
    label: 'Noto Serif (variable)',
    url: '/fonts/NotoSerif-VF.ttf',
    axes: { wght: [100, 900, 400], wdth: [62.5, 100, 100] },
  },
  {
    id: 'amiri',
    label: 'Amiri (Arabic)',
    url: '/fonts/Amiri-Regular.ttf',
    axes: {},
  },
  {
    id: 'dejavusans',
    label: 'DejaVu Sans',
    url: '/fonts/DejaVuSans.ttf',
    axes: {},
  },
  {
    id: 'dejavuserif',
    label: 'DejaVu Serif',
    url: '/fonts/DejaVuSerif.ttf',
    axes: {},
  },
  {
    id: 'dejavumono',
    label: 'DejaVu Sans Mono',
    url: '/fonts/DejaVuSansMono.ttf',
    axes: {},
  },
  {
    id: 'dejavusansbold',
    label: 'DejaVu Sans Bold',
    url: '/fonts/DejaVuSans-Bold.ttf',
    axes: {},
  },
];

const SCRIPT_TAGS = {
  Latin: 'Latn',
  Hebrew: 'Hebr',
  Arabic: 'Arab',
  Thai: 'Thai',
  Devanagari: 'Deva',
  Hangul: 'Hang',
  Cyrillic: 'Cyrl',
  Greek: 'Grek',
  Han: 'Hani',
};

// Minimal Unicode Script lookup over the blocks the app exercises.
const SCRIPT_RANGES = [
  [0x0041, 0x005a, 'Latin'], [0x0061, 0x007a, 'Latin'],
  [0x00c0, 0x024f, 'Latin'], [0x1e00, 0x1eff, 'Latin'],
  [0x0300, 0x036f, 'Inherited'],
  [0x0590, 0x05ff, 'Hebrew'], [0xfb1d, 0xfb4f, 'Hebrew'],
  [0x0600, 0x06ff, 'Arabic'], [0x0750, 0x077f, 'Arabic'],
  [0x08a0, 0x08ff, 'Arabic'], [0xfb50, 0xfdff, 'Arabic'],
  [0xfe70, 0xfeff, 'Arabic'], [0x1ee00, 0x1eeff, 'Arabic'],
  [0x2000, 0x206f, 'Common'], [0x20a0, 0x20cf, 'Common'],
  [0x2190, 0x21ff, 'Common'], [0x2200, 0x22ff, 'Common'],
  [0x25a0, 0x25ff, 'Common'], [0x2600, 0x27bf, 'Common'],
  [0x3000, 0x303f, 'Common'], [0xfe00, 0xfe0f, 'Inherited'],
  [0x1f000, 0x1faff, 'Common'], [0x20000, 0x2fa1f, 'Han'],
  [0x0e00, 0x0e7f, 'Thai'], [0x0900, 0x097f, 'Devanagari'],
  [0x1100, 0x11ff, 'Hangul'], [0xac00, 0xd7af, 'Hangul'],
  [0x0400, 0x04ff, 'Cyrillic'], [0x0370, 0x03ff, 'Greek'],
];

export function scriptOfCodePoint(cp) {
  for (const [lo, hi, s] of SCRIPT_RANGES) if (cp >= lo && cp <= hi) return s;
  return 'Unknown';
}

function resolveScripts(cps) {
  const raw = cps.map((c) => scriptOfCodePoint(c.cp));
  const out = raw.map((s) => (s === 'Inherited' || s === 'Common' || s === 'Unknown' ? null : s));
  // Common/Inherited attach to the preceding strong script. Only leading
  // neutrals (no strong script yet) take the following strong script.
  let carry = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i]) carry = out[i]; else out[i] = carry;
  }
  const firstStrong = out.find((s) => s) ?? 'Latin';
  for (let i = 0; i < out.length && !out[i]; i++) out[i] = firstStrong;
  return out;
}

// UTF-16 safe iteration: clusters are UTF-16 offsets because HB is fed UTF-16.
export function codePointsWithUtf16(text) {
  const cps = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const wide = cp > 0xffff;
    cps.push({ cp, start: i, end: i + (wide ? 2 : 1) });
    i += wide ? 2 : 1;
  }
  return cps;
}

// Split text into runs of constant bidi level + script. Returns runs already in
// visual (left-to-right) order per UAX #9 L2.
export function segmentRuns(text, baseDirection = 'auto', language = 'en') {
  const cps = codePointsWithUtf16(text);
  if (!cps.length) return [];
  const embedding = bidi.getEmbeddingLevels(text, baseDirection === 'auto' ? 'auto' : baseDirection);
  const levels = embedding.levels;
  const scripts = resolveScripts(cps);

  const runs = [];
  let cur = null;
  cps.forEach((c, idx) => {
    const level = levels[c.start] ?? 0;
    const dir = level % 2 ? 'rtl' : 'ltr';
    const script = scripts[idx];
    if (!cur || cur.dir !== dir || cur.script !== script) {
      cur = { dir, script, level, start: c.start, end: c.end };
      runs.push(cur);
    } else {
      cur.end = c.end;
    }
  });

  const visual = reorderRuns(runs);
  return visual.map((r) => ({
    ...r,
    text: text.slice(r.start, r.end),
    language,
    scriptTag: SCRIPT_TAGS[r.script] ?? null,
  }));
}

// UAX #9 L2 at run granularity: reverse contiguous runs at each level from the
// maximum down to the lowest odd level.
function reorderRuns(runs) {
  if (runs.length <= 1) return runs.map((r) => ({ ...r }));
  let maxLevel = 0;
  let minOdd = Infinity;
  for (const r of runs) {
    maxLevel = Math.max(maxLevel, r.level);
    minOdd = Math.min(minOdd, r.level | 1);
  }
  const out = runs.map((r) => ({ ...r }));
  for (let lvl = maxLevel; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < out.length) {
      if (out[i].level >= lvl) {
        let j = i;
        while (j + 1 < out.length && out[j + 1].level >= lvl) j++;
        if (j > i) {
          const rev = out.slice(i, j + 1).reverse();
          for (let k = 0; k < rev.length; k++) out[i + k] = rev[k];
        }
        i = j + 1;
      } else i++;
    }
  }
  return out;
}

export class FontHandle {
  constructor(hb, font, face, meta, { variation } = {}) {
    this.hb = hb;
    this.font = font;
    this.face = face;
    this.meta = meta;
    this.variation = variation ?? {};
    this.upem = face.upem;
    this._outlineCache = new Map();
  }

  setVariation(variation = {}) {
    this.variation = { ...variation };
    const vars = Object.entries(this.variation).map(([tag, value]) => new this.hb.Variation(tag, value));
    this.font.setVariations(vars);
    this._outlineCache.clear();
  }

  // Glyph outline in font units (y-up). Returns an array of commands:
  //   {type:'M',x,y} {type:'L',x,y} {type:'Q',cx,cy,x,y}
  //   {type:'C',c1x,c1y,c2x,c2y,x,y} {type:'Z'}
  outline(gid) {
    if (this._outlineCache.has(gid)) return this._outlineCache.get(gid);
    let cmds = [];
    try { cmds = this.font.glyphToJson(gid); } catch { cmds = []; }
    const norm = [];
    for (const c of cmds) {
      const v = c.values;
      if (c.type === 'M') norm.push({ type: 'M', x: v[0], y: v[1] });
      else if (c.type === 'L') norm.push({ type: 'L', x: v[0], y: v[1] });
      else if (c.type === 'Q') norm.push({ type: 'Q', cx: v[0], cy: v[1], x: v[2], y: v[3] });
      else if (c.type === 'C') norm.push({ type: 'C', c1x: v[0], c1y: v[1], c2x: v[2], c2y: v[3], x: v[4], y: v[5] });
      else if (c.type === 'Z') norm.push({ type: 'Z' });
    }
    this._outlineCache.set(gid, norm);
    return norm;
  }

  advance(gid) { return this.font.glyphHAdvance(gid); }
  extents(gid) { return this.font.glyphExtents(gid); }

  nominalGlyph(cp) {
    try { return this.font.nominalGlyph(cp) ?? 0; } catch { return 0; }
  }
}

export class FontStore {
  constructor(hb) {
    this.hb = hb;
    this.cache = new Map();
    this.byteCache = new Map();
  }

  async load(meta, variation = {}) {
    const key = `${meta.id}:${JSON.stringify(variation)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let bytes = this.byteCache.get(meta.url);
    if (!bytes) {
      bytes = await fetchFontBytes(meta.url);
      this.byteCache.set(meta.url, bytes);
    }
    const blob = new this.hb.Blob(bytes);
    const face = new this.hb.Face(blob);
    const font = new this.hb.Font(face);
    const handle = new FontHandle(this.hb, font, face, meta, { variation });
    if (Object.keys(variation).length) handle.setVariation(variation);
    this.cache.set(key, handle);
    return handle;
  }
}

export function shapeRun(fontHandle, text, start, end, { dir, scriptTag, language, features }) {
  const hb = fontHandle.hb;
  const buffer = new hb.Buffer();
  buffer.addText(text, start, end - start);
  buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_GRAPHEMES);
  buffer.setDirection(dir === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
  if (scriptTag) buffer.setScript(scriptTag);
  if (language) buffer.setLanguage(language);
  const feats = (features ?? []).map((f) => new hb.Feature(f.tag, f.value ?? 1, f.start ?? 0, f.end ?? 0xffffffff));
  hb.shape(fontHandle.font, buffer, feats.length ? feats : undefined);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  return infos.map((info, i) => ({
    gid: info.codepoint,
    cluster: info.cluster,
    flags: info.flags,
    xAdvance: positions[i].xAdvance,
    yAdvance: positions[i].yAdvance,
    xOffset: positions[i].xOffset,
    yOffset: positions[i].yOffset,
  }));
}

// Full pipeline: text -> bidi/script runs -> visual glyph list with penX in
// font units measured left-to-right within the visual string.
//
// HarfBuzz emits glyphs in visual order for the requested direction, so a run
// is simply placed left to right in the order returned. Runs are already in
// visual order from bidi. HarfBuzz also applies RTL mirroring for us, so we
// must not mirror again.
export function shapeText(fontHandle, text, opts = {}) {
  const { baseDirection = 'auto', language = 'en', features = [] } = opts;
  if (!text) return { runs: [], glyphs: [], totalAdvance: 0, levels: new Uint8Array(0) };
  const runs = segmentRuns(text, baseDirection, language);
  const embedding = bidi.getEmbeddingLevels(text, baseDirection === 'auto' ? 'auto' : baseDirection);

  let runPen = 0;
  const shapedRuns = [];
  const glyphs = [];
  runs.forEach((run, runIndex) => {
    const raw = shapeRun(fontHandle, text, run.start, run.end, {
      dir: run.dir,
      scriptTag: run.scriptTag,
      language: run.language,
      features,
    });
    const advance = raw.reduce((a, g) => a + g.xAdvance, 0);
    let pen = 0;
    const runGlyphs = raw.map((g, indexInRun) => {
      const out = {
        ...g,
        runIndex,
        indexInRun,
        penX: pen,
        runAdvance: advance,
        runPenStart: runPen,
        runStart: run.start,
        runEnd: run.end,
        dir: run.dir,
        script: run.script,
        level: run.level,
      };
      pen += g.xAdvance;
      return out;
    });
    shapedRuns.push({ ...run, runIndex, glyphs: runGlyphs, advance, penStart: runPen });
    glyphs.push(...runGlyphs);
    runPen += advance;
  });

  return {
    runs: shapedRuns,
    glyphs,
    totalAdvance: runPen,
    levels: embedding.levels,
  };
}

// Group glyphs into shaping clusters: same run + same cluster value and
// contiguous in the glyph stream. Each group is the atomic unit of layout —
// a ligature group is one glyph covering several characters, a mark group is
// one base plus its zero-advance marks.
export function clusterGroups(glyphs) {
  const groups = [];
  let cur = null;
  for (const g of glyphs) {
    const key = `${g.runIndex}:${g.cluster}`;
    if (!cur || cur.key !== key) {
      cur = {
        key,
        runIndex: g.runIndex,
        cluster: g.cluster,
        dir: g.dir,
        runStart: g.runStart,
        runEnd: g.runEnd,
        glyphs: [g],
        advance: 0,
        width: 0,
      };
      groups.push(cur);
    } else {
      cur.glyphs.push(g);
    }
    cur.advance += g.xAdvance;
    cur.width = Math.max(cur.width, g.penX + g.xAdvance);
  }
  return groups;
}
