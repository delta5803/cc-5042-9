// Render tests: exported SVG is vector geometry, clips are applied, and the
// canvas path rasterizes the same glyphs. No <text> elements are allowed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene, sceneToSVGString, drawSceneToCanvas } from '../src/core/render.js';
import { layoutCurvedText } from '../src/core/layout.js';
import { font, linePath, defaultPath, params } from './helpers.mjs';

const noto = await font('notosans');

function svgFor(text, opts = {}) {
  const path = defaultPath();
  const r = layoutCurvedText(path, noto, params({ text, fontSize: 44, ...opts.params }));
  assert.equal(r.ok, true, r.error?.message);
  const scene = buildScene(r, path, {
    width: 1280, height: 760, background: '#ffffff', color: '#1d2430',
    showBaseline: false, showTangents: false, showBoxes: false, showOutlines: false,
    showClusterLabels: false, showAnchors: false, includeGlyphs: true, includeClipDefs: true,
    idPrefix: 'test',
  });
  return { layout: r, path, scene, svg: sceneToSVGString(scene, 'test') };
}

test('SVG contains one filled path per placed glyph and no <text>', () => {
  const { layout, svg } = svgFor('office ffi déjà');
  assert.ok(!svg.includes('<text'), 'SVG must not use <text> elements');
  const glyphPaths = (svg.match(/<path[^>]*fill="#1d2430"/g) || []).length;
  assert.equal(glyphPaths, layout.glyphs.length, 'one path per glyph');
  assert.ok(svg.startsWith('<svg'), 'root element');
  assert.ok(svg.includes('width="1280"') && svg.includes('height="760"'));
});

test('each glyph path <d> is a transformed outline, not a bitmap', () => {
  const { layout, svg } = svgFor('office');
  for (const g of layout.glyphs) {
    assert.ok(g.outline.length > 0, 'glyph has outline data');
    assert.match(g.outline, /^M/);
    assert.ok(svg.includes(g.outline), 'outline is present verbatim in the SVG');
  }
});

test('exported geometry changes when the curve changes', () => {
  const text = 'curve response';
  const a = svgFor(text).svg;
  const b = svgFor(text, { params: { startOffset: 120, align: 'start' } }).svg;
  assert.notEqual(a, b, 'offset/align change should alter glyph transforms');
});

test('glyph attrs expose cluster and glyph identity for inspection', () => {
  const path = defaultPath();
  const r = layoutCurvedText(path, noto, params({ text: 'office ffi', fontSize: 44 }));
  const scene = buildScene(r, path, { glyphAttrs: true, includeGlyphs: true, idPrefix: 't' });
  const body = scene.body.join('');
  assert.ok(body.includes('data-cluster="'), 'cluster attribute present');
  assert.ok(body.includes('data-gid="'), 'gid attribute present');
  const n = (body.match(/data-glyph=/g) || []).length;
  assert.equal(n, r.glyphs.length);
});

test('clipped glyphs get a clipPath with a local quad', () => {
  const path = linePath(0, 0, 160, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'clipping at the boundary', fontSize: 40, align: 'center', overflow: 'clip' }));
  assert.ok(r.glyphs.some((g) => g.clipped));
  const scene = buildScene(r, path, { includeGlyphs: true, includeClipDefs: true, idPrefix: 't' });
  assert.ok(scene.defs.some((d) => d.startsWith('<clipPath')), 'clip definitions emitted');
  assert.ok(scene.body.some((b) => b.includes('clip-path="url(#t-clip-')), 'clipped glyph references the clip');
});

test('guides: baseline, tangents, advance boxes, annotations are real geometry', () => {
  const path = defaultPath();
  const r = layoutCurvedText(path, noto, params({ text: 'guides', fontSize: 44 }));
  const scene = buildScene(r, path, {
    showBaseline: true, showTangents: true, showBoxes: true, showClusterLabels: true,
    annotations: true, includeGlyphs: true, idPrefix: 'g',
  });
  const body = scene.body.join('');
  assert.ok(body.includes('class="baseline"'));
  assert.ok(body.includes('class="tangent"'));
  assert.ok(body.includes('class="normal"'));
  assert.ok(body.includes('class="advance-box"'));
  assert.ok(body.includes('cluster-badge'));
  assert.ok(body.includes('annotation-arrows'));
});

test('canvas rasterizer produces a non-empty buffer', async () => {
  const path = defaultPath();
  const r = layoutCurvedText(path, noto, params({ text: 'raster check', fontSize: 44 }));
  const canv = await import('@napi-rs/canvas');
  const countInk = (layout) => {
    const canvas = canv.createCanvas(640, 380);
    const ctx = canvas.getContext('2d');
    ctx.scale(0.5, 0.5); // world is 1280x760; half-scale raster
    drawSceneToCanvas(ctx, layout, path, { width: 1280, height: 760, path2d: canv.Path2D, showBaseline: false, showTangents: false });
    const data = ctx.getImageData(0, 0, 640, 380).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120 && data[i + 3] > 0) dark++;
    }
    const png = canvas.toBuffer('image/png');
    return { dark, png };
  };
  const withText = countInk(r);
  assert.ok(withText.png.length > 5000, 'PNG should contain real drawing');
  assert.ok(withText.dark > 200, `expected glyph pixels, saw ${withText.dark}`);
  // A layout with the same path but no glyphs must have materially less ink.
  const empty = countInk({ ...r, ok: true, glyphs: [], clusters: [] });
  assert.ok(withText.dark > empty.dark + 150, `glyph ink ${withText.dark} vs empty ${empty.dark}`);
});

test('rendering an empty/error layout yields no glyph layer', () => {
  const path = linePath(0, 0, 50, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'overflowing text', fontSize: 40, overflow: 'error' }));
  assert.equal(r.ok, false);
  const scene = buildScene(r, path, { includeGlyphs: true });
  assert.ok(!scene.body.some((b) => b.includes('class="glyphs"')));
});
