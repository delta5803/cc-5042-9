// Typesetting contract tests: glyph anchors and along-path distances are
// checked against independently recomputed values from the current evaluator.
// The suite covers the two historically fragile cases explicitly — reversed
// paths and combining-character clusters — and proves the checker fails on
// tampered evidence instead of letting a default value mask an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BezierPath } from '../src/geometry.js';
import { layoutCurvedText, buildPathFromParams } from '../src/core/layout.js';
import { verifyLayoutContract, verifyReversal } from '../src/core/contract.js';
import { DEFAULT_PATH, DEFAULT_PARAMS } from '../src/state.js';
import { font, linePath, params, defaultPath, closeTo } from './helpers.mjs';

const noto = await font('notosans');
const dejavu = await font('dejavusans');

function contract(path, patch = {}) {
  const layout = layoutCurvedText(path, noto, params(patch));
  assert.equal(layout.ok, true);
  return verifyLayoutContract(path, layout, {
    text: layout.params.text, fontId: 'notosans', pathLength: path.length,
    lengthTable: layout.params.lengthTable, reversed: false,
  });
}

test('contract: every glyph anchor matches blockStart + scale × pen distance', () => {
  const r = contract(linePath(0, 0, 2000, 0), { text: 'office déjà vu', fontSize: 44, align: 'start' });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  const arcChecks = r.checks.filter((c) => c.name.includes('arc equals blockStart'));
  assert.ok(arcChecks.length > 5);
  assert.ok(arcChecks.every((c) => c.pass));
});

test('contract: anchor point equals path.pointAt(arc) and frame is right-handed', () => {
  const r = contract(defaultPath(), { text: 'curved anchor contract', fontSize: 44 });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  assert.ok(r.checks.some((c) => c.name.includes('anchor point lies on the path') && c.pass));
  assert.ok(r.checks.some((c) => c.name.includes('frame matrix maps local axes') && c.pass));
  assert.ok(r.checks.some((c) => c.name.includes('screen-up normal') && c.pass));
});

test('contract: along-path distances between base glyphs equal shaped advances', () => {
  const r = contract(linePath(0, 0, 2000, 0), { text: 'kerning AVATAR office', fontSize: 50, align: 'start' });
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.name.startsWith('distance glyph#') && c.pass));
});

test('contract: combining mark shares the base anchor and carries GPOS through the frame', () => {
  const path = linePath(0, 0, 1000, 0);
  const layout = layoutCurvedText(path, dejavu, params({ text: 'q́', fontSize: 100, align: 'start' }));
  const r = verifyLayoutContract(path, layout, { text: 'q́', fontId: 'dejavusans', pathLength: path.length });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  const mark = layout.glyphs.find((g) => g.attachedToBase);
  assert.ok(mark, 'expected an attached mark glyph');
  const base = layout.glyphs[mark.baseGlyphIndex];
  closeTo(mark.arc, base.arc, 1e-9, 'mark consumes no arc length');
  assert.ok(r.checks.some((c) => c.name.includes('mark arc equals its base glyph') && c.pass));
  assert.ok(r.checks.some((c) => c.name.includes('GPOS offset through the base tangent frame') && c.pass));
});

test('contract: mark rides the base frame on a curved path, not a straight line only', () => {
  const layout = layoutCurvedText(defaultPath(), dejavu, params({ text: 'q́ office', fontSize: 48 }));
  assert.equal(layout.ok, true);
  const r = verifyLayoutContract(defaultPath(), layout, { text: 'q́ office', fontId: 'dejavusans' });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
});

test('contract: cluster source slices round-trip to the original text', () => {
  const r = contract(linePath(0, 0, 2000, 0), { text: '“office” — ﬁx… q́', fontSize: 40, align: 'start' });
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.name.startsWith('cluster source slices concatenate') && c.pass));
});

test('contract: reversed path preserves length, negates tangents and swaps endpoints', () => {
  const forward = defaultPath();
  const reversed = forward.reversed();
  reversed.rebuild({ mode: 'adaptive', tolerance: 0.05 });
  const p = params({ text: 'reversal contract q́', fontSize: 44, align: 'start', startOffset: 40 });
  const fl = layoutCurvedText(forward, noto, p);
  const rl = layoutCurvedText(reversed, noto, p);
  assert.equal(fl.ok, true);
  assert.equal(rl.ok, true);
  const r = verifyReversal(fl, rl, forward, reversed);
  assert.equal(r.ok, true, JSON.stringify(r.failures.slice(0, 3), null, 2));
  assert.ok(r.checks.some((c) => c.name.includes('same total arc length')));
  assert.ok(r.checks.some((c) => c.name.includes('tangent negates')));
  assert.ok(r.checks.some((c) => c.name.includes('swaps the declared start and end nodes')));
});

test('contract: geometric point identity s <-> L - s holds at every placed forward anchor', () => {
  const forward = defaultPath();
  const reversed = forward.reversed();
  reversed.rebuild({ mode: 'adaptive', tolerance: 0.05 });
  const p = params({ text: 'point identity', fontSize: 46 });
  const fl = layoutCurvedText(forward, noto, p);
  const rl = layoutCurvedText(reversed, noto, p);
  const r = verifyReversal(fl, rl, forward, reversed);
  assert.equal(r.ok, true);
  const identity = r.checks.filter((c) => c.name.includes('physical point is preserved'));
  assert.ok(identity.length > 3);
  assert.ok(identity.every((c) => c.pass));
});

test('contract: tampered arc is detected and never masked by a default', () => {
  const path = linePath(0, 0, 1500, 0);
  const layout = layoutCurvedText(path, noto, params({ text: 'office', fontSize: 48, align: 'start' }));
  const tampered = structuredClone(layout);
  tampered.glyphs[2].arc += 12;
  const r = verifyLayoutContract(path, tampered, { text: 'office', fontId: 'notosans' });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name.includes('arc equals blockStart')));
});

test('contract: empty glyph output fails instead of passing vacuously', () => {
  const path = linePath(0, 0, 1500, 0);
  const empty = { ok: true, params: { text: 'x' }, glyphs: [], clusters: [], shaping: { scale: 0.05 }, metrics: { blockStart: 0 } };
  const r = verifyLayoutContract(path, empty, { text: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name.includes('at least one placed glyph')));
});

test('contract: failed layout is reported, not silently treated as valid', () => {
  const path = linePath(0, 0, 80, 0);
  const layout = layoutCurvedText(path, noto, params({ text: 'way too much text here', overflow: 'error' }));
  assert.equal(layout.ok, false);
  const r = verifyLayoutContract(path, layout, { text: layout.params.text });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].name, 'layout is ok before anchor verification');
});

test('contract: extend beyond path ends keeps anchors on the endpoint tangent', () => {
  const path = linePath(0, 0, 200, 0);
  const layout = layoutCurvedText(path, noto, params({ text: 'extending beyond the path end strongly', fontSize: 40, overflow: 'extend', align: 'start' }));
  const r = verifyLayoutContract(path, layout, { text: layout.params.text, fontId: 'notosans' });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  const beyond = layout.glyphs.filter((g) => g.arc > path.length);
  assert.ok(beyond.length > 0);
  for (const g of beyond) closeTo(g.point.x, g.arc, 1e-6, 'extended anchor x equals arc');
});

test('contract: ligature cluster is one anchor covering several source characters', () => {
  const path = linePath(0, 0, 2000, 0);
  const layout = layoutCurvedText(path, noto, params({ text: 'office', fontSize: 50, align: 'start' }));
  const r = verifyLayoutContract(path, layout, { text: 'office', fontId: 'notosans' });
  assert.equal(r.ok, true);
  const lig = layout.clusters.find((c) => c.ligature);
  assert.ok(lig && lig.source === 'ffi');
  const ligGlyph = layout.glyphs.find((g) => g.clusterIndex === lig.index);
  closeTo(ligGlyph.arcEnd - ligGlyph.arc, ligGlyph.advancePx, 1e-9, 'ligature span equals its advance');
});

test('contract: document path with multiple cubic segments and mixed text', () => {
  const path = buildPathFromParams({ ...DEFAULT_PATH, lengthTable: { mode: 'uniform', tolerance: 0.05, samples: 48 } });
  const layout = layoutCurvedText(path, noto, params({
    text: '“office” ﬁx — déjà vu, q́ ffi!', fontSize: 52, align: 'center', startOffset: 20, overflow: 'clip',
  }));
  const r = verifyLayoutContract(path, layout, { text: layout.params.text, fontId: 'notosans', lengthTable: layout.params.lengthTable });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  assert.equal(r.summary.failed, 0);
  assert.ok(r.summary.total > 100, 'a mixed-text layout yields a substantial evidence set');
});

test('contract: angle convention atan2(tangent) normalized to 0..360', () => {
  const r = contract(defaultPath(), { text: 'angle convention', fontSize: 44 });
  assert.equal(r.ok, true);
  const angleChecks = r.checks.filter((c) => c.name.includes('angleDeg is normalized atan2'));
  assert.ok(angleChecks.every((c) => c.pass));
  for (const c of angleChecks) {
    assert.ok(c.evidence.actual >= 0 && c.evidence.actual < 360);
  }
});

// Keep BezierPath imported for readers tracing the path model in this suite.
test('contract module exports a versioned contract identifier', async () => {
  const mod = await import('../src/core/contract.js');
  assert.match(mod.CONTRACT_VERSION, /^envelope-typesetting-contract\//);
  assert.equal(typeof mod.verifyLayoutContract, 'function');
  assert.equal(typeof mod.verifyReversal, 'function');
  assert.ok(new BezierPath([]));
});
