// Curved-text layout: map shaped glyph advances onto path arc length, attach
// every glyph to a real tangent frame, and preserve HarfBuzz shaping clusters.
//
// Declared rules (all observable in output + tests):
//  * Advances are HarfBuzz font-unit advances times one scale factor. No
//    synthetic tracking, no per-character rotation fallback.
//  * A shaping cluster (base + marks, or a ligature covering several chars) is
//    atomic for overflow decisions. Zero-advance marks ride on their base's
//    frame so GPOS-relative offsets survive curvature.
//  * Alignment along [startOffset, pathLength]:
//      start -> startOffset; center -> centered in the remainder; end -> flush
//      to the path end.
//  * Overflow is explicit and declared:
//      clip   - geometry outside [0, pathLength] is cut at the boundary;
//               clusters entirely outside are dropped.
//      extend - the baseline continues along the end (or start) tangent.
//      error  - no glyph frame is produced; a coded error explains the deficit.
//  * Zero-derivative tangents and cusps use a declared fallback chain
//    (one-sided secant, then nearest non-zero derivative, then +x) and emit
//    warnings instead of silently guessing.
//  * Reversing the path is geometric: arcs mirror as L - arc - advance and
//    tangents negate. The result is reported so the UI can show it.

import { BezierPath, fmt } from '../geometry.js';
import { shapeText, clusterGroups } from './shaping.js';

export const OVERFLOW_STRATEGIES = ['clip', 'extend', 'error'];
export const ALIGNMENTS = ['start', 'center', 'end'];

const ANCHOR = { start: 0, center: 0.5, end: 1 };
const EPS = 1e-6;

export function buildPathFromParams(pathParams) {
  const nodes = pathParams.nodes.map(([x, y]) => ({ x, y }));
  const segs = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const c = pathParams.controls[i];
    const p0 = nodes[i];
    const p1 = nodes[i + 1];
    segs.push({
      kind: 'cubic',
      p0: { ...p0 },
      c1: { x: c.c1[0], y: c.c1[1] },
      c2: { x: c.c2[0], y: c.c2[1] },
      p1: { ...p1 },
    });
  }
  const path = new BezierPath(segs);
  path.rebuild({
    mode: pathParams.lengthTable?.mode ?? 'adaptive',
    tolerance: pathParams.lengthTable?.tolerance ?? 0.05,
    samples: pathParams.lengthTable?.samples ?? 64,
  });
  return path;
}

function lengthAtParam(table, t) {
  const { params, cum } = table;
  if (t <= 0) return 0;
  if (t >= 1) return table.length;
  let lo = 0, hi = params.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (params[mid] <= t) lo = mid; else hi = mid;
  }
  const f = params[hi] - params[lo] < EPS ? 0 : (t - params[lo]) / (params[hi] - params[lo]);
  return cum[lo] + (cum[hi] - cum[lo]) * f;
}

// Frame at arc length s. Outside [0, L], extend along the endpoint tangent.
function frameAtPath(path, s) {
  if (s < 0) {
    const p0 = path.pointAt(0);
    const t0 = path.tangentAt(0);
    return {
      point: { x: p0.x + t0.x * s, y: p0.y + t0.y * s },
      tangent: { x: t0.x, y: t0.y },
      degraded: t0.degraded ?? null,
      extended: 'start',
    };
  }
  if (s > path.length) {
    const p1 = path.pointAt(path.length);
    const t1 = path.tangentAt(path.length);
    const d = s - path.length;
    return {
      point: { x: p1.x + t1.x * d, y: p1.y + t1.y * d },
      tangent: { x: t1.x, y: t1.y },
      degraded: t1.degraded ?? null,
      extended: 'end',
    };
  }
  const t = path.tangentAt(s);
  return {
    point: path.pointAt(s),
    tangent: { x: t.x, y: t.y },
    degraded: t.degraded ?? null,
    extended: null,
  };
}

// Glyph outline (font units, y-up) -> curved-text user-space SVG path data.
//   local x -> k * tangent
//   local y -> k * screen-up normal
function transformOutline(cmds, a, b, c, d, e, f) {
  const tx = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  let out = '';
  for (const cmd of cmds) {
    if (cmd.type === 'M') {
      const [x, y] = tx(cmd.x, cmd.y); out += `M${fmt(x)},${fmt(y)}`;
    } else if (cmd.type === 'L') {
      const [x, y] = tx(cmd.x, cmd.y); out += `L${fmt(x)},${fmt(y)}`;
    } else if (cmd.type === 'Q') {
      const [cx, cy] = tx(cmd.cx, cmd.cy);
      const [x, y] = tx(cmd.x, cmd.y);
      out += `Q${fmt(cx)},${fmt(cy)} ${fmt(x)},${fmt(y)}`;
    } else if (cmd.type === 'C') {
      const [c1x, c1y] = tx(cmd.c1x, cmd.c1y);
      const [c2x, c2y] = tx(cmd.c2x, cmd.c2y);
      const [x, y] = tx(cmd.x, cmd.y);
      out += `C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(x)},${fmt(y)}`;
    } else if (cmd.type === 'Z') out += 'Z';
  }
  return out;
}

function clusterSourceRanges(run) {
  const starts = [...new Set(run.glyphs.map((g) => g.cluster))].sort((a, b) => a - b);
  const map = new Map();
  for (const c of starts) {
    const next = starts.find((v) => v > c) ?? run.end;
    map.set(c, { start: c, end: next });
  }
  return map;
}

function makeWarning(code, message, detail = {}) {
  return { code, message, detail };
}

export function featureList(features) {
  if (!features) return [];
  if (Array.isArray(features)) return features.map((t) => ({ tag: t, value: 1 }));
  return Object.entries(features)
    .filter(([, on]) => on)
    .map(([tag]) => ({ tag, value: 1 }));
}

export function layoutCurvedText(path, fontHandle, params) {
  const warnings = [];
  const fontSize = params.fontSize;
  const k = fontSize / fontHandle.upem;
  const strategy = params.overflow;
  const align = params.align;

  if (!OVERFLOW_STRATEGIES.includes(strategy)) {
    return errorResult(warnings, 'invalid-overflow', `Unknown overflow strategy "${strategy}". Use clip, extend, or error.`);
  }
  if (!ALIGNMENTS.includes(align)) {
    return errorResult(warnings, 'invalid-align', `Unknown alignment "${align}". Use start, center, or end.`);
  }
  if (!path || !path.segments.length || path.length <= EPS) {
    return errorResult(warnings, 'zero-length-path', 'The path has no measurable length. Add nodes or lengthen it.');
  }

  const features = featureList(params.features);
  const shaped = shapeText(fontHandle, params.text, {
    baseDirection: params.baseDirection,
    language: params.language,
    features,
  });

  const glyphCount = shaped.glyphs.length;
  const charCount = [...params.text].length;
  const advancePx = shaped.totalAdvance * k;
  const pathLength = path.length;

  if (!params.text) {
    warnings.push(makeWarning('empty-text', 'No text to place. Glyph count is zero.'));
  }

  const missing = [];
  for (const cp of new Set([...params.text])) {
    if (/\s/.test(cp)) continue;
    if (fontHandle.nominalGlyph(cp.codePointAt(0)) === 0) missing.push(cp);
  }
  if (missing.length) {
    warnings.push(makeWarning(
      'missing-glyphs',
      `Font “${fontHandle.meta.label}” has no glyph for ${missing.length} character(s): ${missing.map((c) => `“${c}”`).join(' ')}. ` +
      'Those clusters render as .notdef. Pick a font that covers the script.',
      { characters: missing },
    ));
  }

  const offset = Math.max(0, Math.min(pathLength, params.startOffset));
  const available = Math.max(0, pathLength - offset);
  const anchor = ANCHOR[align];
  const blockStart = offset + (available - advancePx) * anchor;
  const blockEnd = blockStart + advancePx;
  const overflowStart = Math.max(0, -blockStart);
  const overflowEnd = Math.max(0, blockEnd - pathLength);
  const overflows = overflowStart > EPS || overflowEnd > EPS;

  const baseMetrics = {
    pathLength,
    advancePx,
    blockStart,
    blockEnd,
    offset,
    available,
    align,
    strategy,
    overflowStart,
    overflowEnd,
    overflows,
    extendedBy: Math.max(overflowStart, overflowEnd),
    clippedGlyphs: 0,
    partialClippedGlyphs: 0,
    droppedClusters: 0,
    placedGlyphs: 0,
    extendedGlyphs: 0,
    glyphCount,
    charCount,
    missingGlyphs: missing,
  };

  const shapingInfo = () => ({
    glyphCount,
    charCount,
    totalAdvanceFontUnits: shaped.totalAdvance,
    features,
    fontId: fontHandle.meta.id,
    fontLabel: fontHandle.meta.label,
    upem: fontHandle.upem,
    variation: fontHandle.variation,
    fontSize,
    scale: k,
    runCount: shaped.runs.length,
    clusterCount: shaped.glyphs.length ? clusterGroups(shaped.glyphs).length : 0,
    markClusters: clusterGroups(shaped.glyphs).filter((g) => g.glyphs.some((x) => x.xAdvance === 0)).length,
  });

  if (strategy === 'error' && overflows) {
    return {
      ok: false,
      error: {
        code: 'text-overflow',
        message:
          `Text needs ${advancePx.toFixed(1)} px but the path segment available is ${available.toFixed(1)} px ` +
          `(path ${pathLength.toFixed(1)} px, start offset ${offset.toFixed(1)} px, align “${align}”). ` +
          `Shorten the text, reduce the size, choose “clip” or “extend”, or lengthen the path.`,
        detail: { advancePx, pathLength, offset, overflowStart, overflowEnd, deficit: Math.max(overflowStart, overflowEnd) },
      },
      warnings,
      params,
      metrics: baseMetrics,
      glyphs: [],
      clusters: [],
      runs: shaped.runs.map(runInfo(k)),
      shaping: shapingInfo(),
      lengthTable: lengthTableInfo(path),
    };
  }

  const groups = clusterGroups(shaped.glyphs);
  const rangeByRun = new Map(shaped.runs.map((r) => [r.runIndex, clusterSourceRanges(r)]));

  const placed = [];
  const clustersOut = [];
  const seenTangentFallback = new Set();
  let partialClipped = 0;
  let dropped = 0;
  let extendedCount = 0;

  groups.forEach((group, groupIndex) => {
    const run = shaped.runs[group.runIndex];
    const range = rangeByRun.get(group.runIndex)?.get(group.cluster);
    const sourceStart = range?.start ?? group.cluster;
    const sourceEnd = range?.end ?? group.cluster;
    const source = params.text.slice(sourceStart, sourceEnd);

    const clusterInfo = {
      index: groupIndex,
      key: group.key,
      runIndex: group.runIndex,
      cluster: group.cluster,
      sourceStart,
      sourceEnd,
      source,
      dir: group.dir,
      script: run?.script ?? null,
      advancePx: group.advance * k,
      glyphCount: group.glyphs.length,
      ligature: group.glyphs.length === 1 && sourceEnd - sourceStart > 1,
      hasMarks: group.glyphs.length > 1 && group.glyphs.some((g) => g.xAdvance === 0),
      arc: null,
      arcEnd: null,
      angleDeg: null,
      clipped: false,
      dropped: false,
      extended: null,
      glyphs: [],
    };

    let baseFrame = null;
    let baseSourceAdvance = 0;

    for (const g of group.glyphs) {
      const own = g.xAdvance > 0 || !baseFrame;
      let frame;
      let s0;
      if (own) {
        s0 = blockStart + k * (g.runPenStart + g.penX);
        frame = frameAtPath(path, s0);
        baseFrame = { ...frame, s: s0 };
        baseSourceAdvance = 0;
      } else {
        s0 = baseFrame.s + k * baseSourceAdvance;
        frame = baseFrame;
        baseSourceAdvance += g.xAdvance;
      }

      if (frame.degraded && !seenTangentFallback.has(frame.degraded)) {
        seenTangentFallback.add(frame.degraded);
        warnings.push(makeWarning(
          'tangent-fallback',
          `Tangent fallback used at arc ${s0.toFixed(1)} px: ${describeDegraded(frame.degraded)}. ` +
          'Glyph orientation at that point is approximate by declaration.',
          { arc: s0, kind: frame.degraded },
        ));
      }

      const advanceFont = g.xAdvance;
      const glyphSpanPx = advanceFont * k;
      const glyphStart = s0;
      const glyphEnd = s0 + glyphSpanPx;

      const before = glyphEnd <= -EPS;
      const after = glyphStart >= pathLength + EPS;
      const fullyOutside = before || after;
      const crossesStart = glyphStart < -EPS && glyphEnd > EPS;
      const crossesEnd = glyphEnd > pathLength + EPS && glyphStart < pathLength - EPS;

      // Only the clip strategy removes whole glyphs. `extend` keeps every
      // glyph by continuing the baseline along the endpoint tangent; `error`
      // never reaches this loop with overflow.
      if (strategy === 'clip' && fullyOutside) {
        if (!clusterInfo.dropped) dropped++;
        clusterInfo.clipped = true;
        clusterInfo.dropped = true;
        clusterInfo.glyphs.push({ gid: g.gid, dropped: true });
        continue;
      }

      let clip = null;
      if (strategy === 'clip' && (crossesStart || crossesEnd)) {
        // Clip in the glyph's local frame: x runs along the advance. The local
        // x limits correspond exactly to the path's arc interval.
        const localMin = crossesStart ? (0 - glyphStart) / k : 0;
        const localMax = crossesEnd ? (pathLength - glyphStart) / k : advanceFont;
        clip = {
          x: Math.max(0, localMin),
          width: Math.max(0, Math.min(advanceFont, localMax) - Math.max(0, localMin)),
          reason: crossesStart ? 'path-start' : 'path-end',
        };
        clusterInfo.clipped = true;
        partialClipped++;
      }

      if (strategy === 'extend' && (frame.extended || s0 < 0 || glyphEnd > pathLength)) {
        extendedCount++;
        clusterInfo.extended = s0 < 0 ? 'start' : 'end';
      }

      // Placement: tangent along path, normal = screen-up.
      const tx = frame.tangent.x;
      const ty = frame.tangent.y;
      const dpx = (g.xOffset) * k;
      const dpy = g.yOffset * k;
      const a = k * tx;
      const b = k * ty;
      const c = k * ty;
      const dd = -k * tx;
      const e = frame.point.x + tx * dpx + ty * dpy;
      const f = frame.point.y + ty * dpx - tx * dpy;

      const outline = fontHandle.outline(g.gid);
      const d = transformOutline(outline, a, b, c, dd, e, f);
      const angleRad = Math.atan2(ty, tx);

      const glyph = {
        glyphIndex: placed.length,
        gid: g.gid,
        cluster: g.cluster,
        clusterIndex: groupIndex,
        runIndex: g.runIndex,
        indexInRun: g.indexInRun,
        dir: g.dir,
        script: run?.script ?? null,
        source,
        advanceFontUnits: advanceFont,
        advancePx: glyphSpanPx,
        penFontUnits: g.runPenStart + g.penX,
        arc: s0,
        arcEnd: glyphEnd,
        angle: angleRad,
        angleDeg: normalizeDeg((angleRad * 180) / Math.PI),
        point: { x: frame.point.x, y: frame.point.y },
        tangent: { x: tx, y: ty },
        normal: { x: ty, y: -tx },
        matrix: { a, b, c, d: dd, e, f },
        gpos: { xOffset: g.xOffset, yOffset: g.yOffset },
        attachedToBase: !own,
        baseGlyphIndex: own ? null : findBaseIndex(placed, groupIndex),
        glyphFlags: g.flags,
        degraded: frame.degraded ?? null,
        clipped: !!clip,
        clip,
        extended: strategy === 'extend' ? clusterInfo.extended : null,
        outline: d,
      };
      placed.push(glyph);
      clusterInfo.glyphs.push({ gid: g.gid, glyphIndex: glyph.glyphIndex });
      if (clusterInfo.arc === null) {
        clusterInfo.arc = s0;
        clusterInfo.arcEnd = glyphEnd;
        clusterInfo.angleDeg = glyph.angleDeg;
      } else {
        clusterInfo.arcEnd = Math.max(clusterInfo.arcEnd ?? -Infinity, glyphEnd);
      }
    }
    clustersOut.push(clusterInfo);
  });

  // Cusp and extreme-curvature reporting.
  path.segments.forEach((seg, segIndex) => {
    for (const sp of path.stationary?.[segIndex] ?? []) {
      if (sp.kind !== 'cusp') continue;
      const localLen = lengthAtParam(path.tables[segIndex], sp.t);
      const arc = path.starts[segIndex] + localLen;
      warnings.push(makeWarning(
        'cusp',
        `Cusp on segment ${segIndex + 1} at t=${sp.t.toFixed(4)} (arc ${arc.toFixed(1)} px, speed ${sp.speed.toExponential(2)}). ` +
        'Tangent direction is undefined there; the declared fallback is applied only to glyphs landing on it.',
        { segment: segIndex, t: sp.t, arc, speed: sp.speed },
      ));
      break;
    }
  });

  for (const c of clustersOut) {
    if (c.arc === null) continue;
    const arc = c.arc;
    const kappa = path.curvatureAt(arc).curvature;
    if (Math.abs(kappa) > 0.02) {
      warnings.push(makeWarning(
        'tight-curvature',
        `Cluster “${c.source}” sits where curvature is ${Math.abs(kappa).toFixed(3)} px⁻¹ (radius ${(1 / Math.abs(kappa)).toFixed(1)} px). ` +
        'Glyph outlines stay rigid, so neighbours may collide at this bend; check the preview.',
        { clusterIndex: c.index, arc, curvature: kappa },
      ));
    }
  }

  const metrics = {
    ...baseMetrics,
    clippedGlyphs: partialClipped,
    partialClippedGlyphs: partialClipped,
    droppedClusters: dropped,
    placedGlyphs: placed.length,
    extendedGlyphs: extendedCount,
  };

  return {
    ok: true,
    error: null,
    warnings,
    params,
    metrics,
    glyphs: placed,
    clusters: clustersOut,
    runs: shaped.runs.map(runInfo(k)),
    shaping: shapingInfo(),
    lengthTable: lengthTableInfo(path),
  };
}

function runInfo(k) {
  return (r) => ({
    runIndex: r.runIndex,
    dir: r.dir,
    script: r.script,
    level: r.level,
    start: r.start,
    end: r.end,
    text: r.text,
    advancePx: r.advance * k,
    glyphCount: r.glyphs.length,
  });
}

function findBaseIndex(placed, clusterIndex) {
  for (let i = placed.length - 1; i >= 0; i--) {
    if (placed[i].clusterIndex === clusterIndex && !placed[i].attachedToBase) return placed[i].glyphIndex;
    if (placed[i].clusterIndex !== clusterIndex) break;
  }
  return null;
}

function describeDegraded(kind) {
  switch (kind) {
    case 'degenerate-derivative': return 'derivative was numerically zero on both sides (degenerate point); +x used';
    case 'zero-derivative-secant': return 'derivative vanished at the sample; a one-sided secant replaced it';
    default: return kind;
  }
}

function lengthTableInfo(path) {
  return {
    mode: path.tableOpts.mode,
    tolerance: path.tableOpts.tolerance,
    samplesOption: path.tableOpts.samples,
    pathLength: path.length,
    segmentSamples: path.tables.map((t) => t.params.length),
    totalSamples: path.tables.reduce((a, t) => a + t.params.length, 0),
    stationary: path.stationary.map((list, i) => ({ segment: i, points: list })),
  };
}

function normalizeDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function errorResult(warnings, code, message) {
  return {
    ok: false,
    error: { code, message, detail: {} },
    warnings,
    glyphs: [],
    clusters: [],
    runs: [],
    metrics: null,
    shaping: null,
    lengthTable: null,
  };
}

export function frameAt(path, s) {
  return frameAtPath(path, s);
}
