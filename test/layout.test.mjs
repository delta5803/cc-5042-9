// Layout tests: advance->arc mapping, tangent frames, overflow strategies,
// alignment/offset/reversal consistency, and parameter reproduction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BezierPath } from '../src/geometry.js';
import { layoutCurvedText, frameAt, buildPathFromParams } from '../src/core/layout.js';
import { DEFAULT_PATH } from '../src/state.js';
import { font, linePath, params, defaultPath, closeTo } from './helpers.mjs';

const noto = await font('notosans');
const dejavu = await font('dejavusans');

test('advance mapping: glyph arc equals blockStart + pen advance, exactly', () => {
  const path = linePath(0, 0, 1500, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'office déjà', fontSize: 40, align: 'start', overflow: 'clip' }));
  assert.equal(r.ok, true);
  const k = r.shaping.scale;
  const shaped = r.glyphs;
  // Reconstruct the pen position from the shaped glyph stream via cluster info.
  let pen = 0;
  for (const g of shaped) {
    closeTo(g.arc, r.metrics.blockStart + pen * k, 1e-6, `arc of glyph ${g.glyphIndex}`);
    if (!g.attachedToBase) pen += g.advanceFontUnits;
  }
  closeTo(r.metrics.blockStart + pen * k, r.metrics.blockEnd, 1e-6, 'block end equals last pen');
});

test('adjacent glyph spacing equals HarfBuzz advances at one scale', () => {
  const path = linePath(0, 0, 2000, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'office', fontSize: 60, align: 'start' }));
  const k = r.shaping.scale;
  for (let i = 1; i < r.glyphs.length; i++) {
    const prev = r.glyphs[i - 1];
    const cur = r.glyphs[i];
    if (cur.attachedToBase) continue;
    closeTo(cur.arc - prev.arc, prev.advanceFontUnits * k, 1e-6, `spacing before glyph ${i}`);
  }
});

test('tangent frame: matrix maps font units onto the path tangent', () => {
  const path = defaultPath();
  const r = layoutCurvedText(path, noto, params({ text: 'curvature test', fontSize: 44, align: 'center' }));
  assert.equal(r.ok, true);
  for (const g of r.glyphs) {
    const { a, b, c, d } = g.matrix;
    // Local +x maps to (a,b), which must be k*tangent.
    const k = r.shaping.scale;
    closeTo(a, k * g.tangent.x, 1e-9, 'matrix a');
    closeTo(b, k * g.tangent.y, 1e-9, 'matrix b');
    // Local +y maps to (c,d) = k*screen-up normal = k*(ty,-tx).
    closeTo(c, k * g.tangent.y, 1e-9, 'matrix c');
    closeTo(d, -k * g.tangent.x, 1e-9, 'matrix d');
    // Origin is on the path.
    const p = path.pointAt(g.arc);
    closeTo(g.matrix.e - g.point.x, 0, 1e-9, 'origin x shift');
  }
});

test('glyph angle equals atan2(tangent) modulo 360', () => {
  const r = layoutCurvedText(defaultPath(), noto, params({ text: 'angle check', fontSize: 44 }));
  for (const g of r.glyphs) {
    const expected = Math.atan2(g.tangent.y, g.tangent.x) * 180 / Math.PI;
    const norm = ((expected % 360) + 360) % 360;
    closeTo(g.angleDeg, norm, 1e-9, 'angleDeg');
  }
});

test('alignment start/center/end positions block consistently', () => {
  const path = linePath(0, 0, 1000, 0);
  const base = { text: 'align test', fontSize: 40, overflow: 'clip', startOffset: 100 };
  const start = layoutCurvedText(path, noto, params({ ...base, align: 'start' }));
  const center = layoutCurvedText(path, noto, params({ ...base, align: 'center' }));
  const end = layoutCurvedText(path, noto, params({ ...base, align: 'end' }));
  closeTo(start.metrics.blockStart, 100, 1e-9, 'start begins at offset');
  closeTo(center.metrics.blockStart, 100 + (900 - start.metrics.advancePx) / 2, 1e-9, 'center block start');
  closeTo(end.metrics.blockEnd, 1000, 1e-9, 'end block ends at path end');
});

test('start offset shifts every glyph by exactly the offset', () => {
  const path = linePath(0, 0, 1200, 0);
  const a = layoutCurvedText(path, noto, params({ text: 'offset', fontSize: 40, align: 'start', startOffset: 0 }));
  const b = layoutCurvedText(path, noto, params({ text: 'offset', fontSize: 40, align: 'start', startOffset: 137 }));
  for (let i = 0; i < a.glyphs.length; i++) {
    closeTo(b.glyphs[i].arc - a.glyphs[i].arc, 137, 1e-9, `glyph ${i} offset`);
  }
});

test('start offset is clamped to the path length', () => {
  const path = linePath(0, 0, 500, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'x', fontSize: 40, align: 'start', startOffset: 99999 }));
  assert.equal(r.metrics.offset, 500);
  closeTo(r.metrics.available, 0, 1e-9);
});

test('clip drops fully-outside clusters and counts them', () => {
  const path = linePath(0, 0, 200, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'this text is much longer than the path', fontSize: 40, align: 'center', overflow: 'clip' }));
  assert.equal(r.ok, true);
  assert.ok(r.metrics.droppedClusters > 0, 'expected dropped clusters');
  assert.ok(r.metrics.placedGlyphs < r.metrics.glyphCount);
  assert.ok(r.metrics.clippedGlyphs > 0, 'expected partially clipped glyphs at the boundary');
  for (const c of r.clusters) {
    if (c.dropped) assert.equal(c.arc, null);
  }
  // Every unclipped glyph lies within the clip interval. A glyph crossing the
  // boundary may have its origin slightly outside, but its retained geometry
  // must overlap the path.
  for (const g of r.glyphs) {
    if (g.clipped) {
      assert.ok(g.arcEnd > -1e-6 && g.arc < 200 + 1e-6, `clipped glyph ${g.glyphIndex} missed the path`);
    } else {
      assert.ok(g.arc >= -1e-6 && g.arc <= 200 + 1e-6, `glyph arc ${g.arc} escaped the path`);
    }
  }
});

test('clip glyphs at the boundary carry a local clip quad', () => {
  const path = linePath(0, 0, 180, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'boundary clipping', fontSize: 40, align: 'center', overflow: 'clip' }));
  const clipped = r.glyphs.filter((g) => g.clipped);
  assert.ok(clipped.length > 0, 'expected boundary glyphs to be clipped');
  for (const g of clipped) {
    assert.ok(g.clip, 'missing clip record');
    assert.ok(g.clip.width > 0, 'clip should retain some width');
    assert.ok(g.clip.x >= 0 && g.clip.x <= g.advanceFontUnits + 1e-9);
    assert.ok(g.clip.reason === 'path-start' || g.clip.reason === 'path-end');
  }
});

test('extend keeps every glyph on the endpoint tangent', () => {
  const path = linePath(0, 0, 300, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'extending well beyond the path end', fontSize: 40, align: 'center', overflow: 'extend' }));
  assert.equal(r.ok, true);
  assert.equal(r.metrics.droppedClusters, 0, 'extend must not drop clusters');
  assert.equal(r.metrics.placedGlyphs, r.metrics.glyphCount);
  assert.ok(r.metrics.extendedGlyphs > 0);
  const beyond = r.glyphs.filter((g) => g.arc > 300 + 1e-6);
  assert.ok(beyond.length > 0, 'expected glyphs past the end');
  for (const g of beyond) {
    closeTo(g.tangent.x, 1, 1e-9, 'extended tangent x');
    closeTo(g.tangent.y, 0, 1e-9, 'extended tangent y');
    closeTo(g.point.y, 0, 1e-9, 'extended glyph sits on the extrapolated line');
    closeTo(g.point.x, g.arc, 1e-6, 'extended glyph x equals arc');
  }
});

test('error mode returns a coded error, no glyphs, and the deficit', () => {
  const path = linePath(0, 0, 120, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'way too much text for this path', fontSize: 40, align: 'center', overflow: 'error' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'text-overflow');
  assert.deepEqual(r.glyphs, []);
  assert.deepEqual(r.clusters, []);
  assert.ok(r.error.detail.deficit > 0);
  closeTo(r.metrics.advancePx, r.error.detail.advancePx, 1e-9);
});

test('error mode succeeds when the text fits', () => {
  const path = linePath(0, 0, 1200, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'fits', fontSize: 40, align: 'center', overflow: 'error' }));
  assert.equal(r.ok, true);
  assert.equal(r.metrics.overflows, false);
});

test('invalid overflow and alignment are declared errors', () => {
  const path = linePath(0, 0, 500, 0);
  const a = layoutCurvedText(path, noto, params({ text: 'x', overflow: 'stretch' }));
  assert.equal(a.error.code, 'invalid-overflow');
  const b = layoutCurvedText(path, noto, params({ text: 'x', align: 'middle' }));
  assert.equal(b.error.code, 'invalid-align');
});

test('zero-length path is a declared error', () => {
  const path = new BezierPath([{ kind: 'cubic', p0: { x: 5, y: 5 }, c1: { x: 5, y: 5 }, c2: { x: 5, y: 5 }, p1: { x: 5, y: 5 } }]);
  path.rebuild();
  const r = layoutCurvedText(path, noto, params({ text: 'x' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'zero-length-path');
});

test('reversal mirrors arcs and negates tangents consistently', () => {
  const forward = defaultPath();
  const reversed = forward.reversed();
  reversed.rebuild({ mode: 'adaptive', tolerance: 0.05 });
  const text = 'reversal consistency';
  const f = layoutCurvedText(forward, noto, params({ text, fontSize: 44, align: 'start', startOffset: 60, overflow: 'clip' }));
  const r = layoutCurvedText(reversed, noto, params({ text, fontSize: 44, align: 'start', startOffset: 60, overflow: 'clip' }));
  assert.equal(f.ok, true); assert.equal(r.ok, true);
  closeTo(r.metrics.pathLength, f.metrics.pathLength, 1e-6, 'path length invariant');
  // The first glyph of the reversed run lives at the same arc offset from the
  // start (startOffset), but the tangent points the other way geometrically.
  const f0 = f.glyphs[0];
  const r0 = r.glyphs[0];
  closeTo(r0.arc, f0.arc, 1e-6, 'same arc from the declared origin');
  // Tangent frames are not simply negated at the same arc; compare frames from
  // the physical point on the reversed path instead.
  const sPhys = r.metrics.pathLength - r0.arc;
  const tf = forward.tangentAt(r0.arc);
  const tr = reversed.tangentAt(sPhys);
  closeTo(tr.x, -tf.x, 2e-3, 'reversed tangent x negates at the mirrored arc');
  closeTo(tr.y, -tf.y, 2e-3, 'reversed tangent y negates at the mirrored arc');
});

test('reversing with align=end places text at the opposite physical end', () => {
  const forward = defaultPath();
  const reversed = forward.reversed();
  reversed.rebuild({ mode: 'adaptive', tolerance: 0.05 });
  const f = layoutCurvedText(forward, noto, params({ text: 'opposite ends', fontSize: 48, align: 'end' }));
  const r = layoutCurvedText(reversed, noto, params({ text: 'opposite ends', fontSize: 48, align: 'end' }));
  closeTo(f.metrics.blockEnd, f.metrics.pathLength, 1e-6);
  closeTo(r.metrics.blockEnd, r.metrics.pathLength, 1e-6);
  // In both cases the block is flush with the declared end, which is a
  // different physical node after reversal.
  closeTo(r.metrics.blockStart, f.metrics.pathLength - r.metrics.advancePx, 1e-6);
});

test('ligature cluster keeps one arc origin and correct width', () => {
  const path = linePath(0, 0, 2000, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'office', fontSize: 50, align: 'start' }));
  const lig = r.clusters.find((c) => c.ligature);
  assert.ok(lig, 'expected the ffi ligature cluster');
  assert.equal(lig.source, 'ffi');
  const k = r.shaping.scale;
  closeTo(lig.advancePx, r.glyphs.find((g) => g.clusterIndex === lig.index).advanceFontUnits * k, 1e-9);
});

test('glyph ordering follows the visual run order', () => {
  const r = layoutCurvedText(linePath(0, 0, 2000, 0), dejavu, params({ text: 'abc שלום xyz', fontSize: 40, align: 'start', overflow: 'clip' }));
  assert.equal(r.ok, true);
  const runOrder = r.glyphs.map((g) => g.runIndex);
  for (let i = 1; i < runOrder.length; i++) assert.ok(runOrder[i] >= runOrder[i - 1], 'runs must stay in visual order');
  const arcs = r.glyphs.map((g) => g.arc);
  for (let i = 1; i < arcs.length; i++) assert.ok(arcs[i] >= arcs[i - 1] - 1e-9, 'arcs must not go backwards in visual order');
});

test('saved params reproduce the identical layout', () => {
  const pathParams = { ...DEFAULT_PATH, lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64 } };
  const p = params({ text: '“office” ffi déjà, PRINT’S', fontSize: 52, align: 'center', startOffset: 30, overflow: 'clip' });
  const round = JSON.parse(JSON.stringify(p));
  const a = layoutCurvedText(buildPathFromParams(pathParams), noto, p);
  const b = layoutCurvedText(buildPathFromParams(pathParams), noto, round);
  assert.equal(a.glyphs.length, b.glyphs.length);
  for (let i = 0; i < a.glyphs.length; i++) {
    closeTo(b.glyphs[i].arc, a.glyphs[i].arc, 1e-12, 'reproduced arc');
    closeTo(b.glyphs[i].angleDeg, a.glyphs[i].angleDeg, 1e-12, 'reproduced angle');
  }
});

test('frameAt extends beyond the ends along the endpoint tangents', () => {
  const path = linePath(0, 0, 100, 0);
  const before = frameAt(path, -25);
  assert.equal(before.extended, 'start');
  closeTo(before.point.x, -25, 1e-9);
  const after = frameAt(path, 140);
  assert.equal(after.extended, 'end');
  closeTo(after.point.x, 140, 1e-9);
});

test('tangent fallback warning fires for a glyph on a degenerate path', () => {
  const path = new BezierPath([{
    kind: 'cubic',
    p0: { x: 200, y: 200 }, c1: { x: 200, y: 200 }, c2: { x: 200, y: 200 }, p1: { x: 200, y: 200 },
  }, {
    kind: 'cubic',
    p0: { x: 200, y: 200 }, c1: { x: 260, y: 200 }, c2: { x: 320, y: 200 }, p1: { x: 400, y: 200 },
  }]);
  path.rebuild({ mode: 'adaptive', tolerance: 0.05 });
  // Place the first glyph exactly on arc 0, which is the degenerate segment.
  const r = layoutCurvedText(path, noto, params({ text: 'fallback', fontSize: 40, align: 'start', startOffset: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.glyphs[0].arc, 0);
  const w = r.warnings.find((x) => x.code === 'tangent-fallback');
  assert.ok(w, 'expected a tangent-fallback warning on the degenerate start');
  assert.ok(w.detail.kind, 'warning names the declared fallback kind');
});

test('tight bend emits a curvature warning without changing advances', () => {
  // A tiny-radius S-bend forces high curvature.
  const path = buildPathFromParams({
    nodes: [[100, 300], [300, 300], [500, 300]],
    controls: [{ c1: [200, 180], c2: [200, 420] }, { c1: [400, 180], c2: [400, 420] }],
    lengthTable: { mode: 'adaptive', tolerance: 0.02 },
  });
  const r = layoutCurvedText(path, noto, params({ text: 'tight', fontSize: 64, align: 'start', overflow: 'clip' }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'tight-curvature'), 'expected a tight-curvature warning');
  const k = r.shaping.scale;
  const expected = r.shaping.totalAdvanceFontUnits * k;
  closeTo(r.metrics.advancePx, expected, 1e-9);
});

test('very short path with centered text surfaces an overflow state', () => {
  const path = linePath(0, 0, 40, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'short', fontSize: 48, align: 'center', overflow: 'clip' }));
  assert.equal(r.ok, true);
  assert.equal(r.metrics.overflows, true);
  assert.ok(r.metrics.overflowStart > 0 && r.metrics.overflowEnd > 0);
});

test('ligature clusters are atomic for overflow decisions', () => {
  const path = linePath(0, 0, 150, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'office', fontSize: 60, align: 'center', overflow: 'clip' }));
  const lig = r.clusters.find((c) => c.ligature);
  assert.ok(lig);
  // A ligature either survives entirely or is dropped entirely.
  const glyph = r.glyphs.find((g) => g.clusterIndex === lig.index);
  if (lig.dropped) assert.equal(glyph, undefined);
  else assert.ok(glyph, 'placed ligature must have a glyph');
});
