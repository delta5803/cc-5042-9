// Real shaping tests: cluster integrity, ligatures, marks, mixed scripts.
// These run HarfBuzz for real; nothing here is a per-character approximation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeText, clusterGroups, segmentRuns, codePointsWithUtf16 } from '../src/core/shaping.js';
import { layoutCurvedText } from '../src/core/layout.js';
import { font, linePath, params, closeTo } from './helpers.mjs';

const dejavu = await font('dejavusans');
const noto = await font('notosans');

test('ligature: "office" shapes 6 chars into 4 glyphs, ffi is one cluster', () => {
  const s = shapeText(dejavu, 'office', { language: 'en', features: [{ tag: 'liga', value: 1 }] });
  assert.equal(s.glyphs.length, 4);
  assert.equal([...'office'].length, 6);
  const groups = clusterGroups(s.glyphs);
  const lig = groups.find((g) => g.glyphs.length === 1 && g.cluster === 1);
  assert.ok(lig, 'ffi ligature cluster missing');
  // The ligature covers "ffi": clusters 1..4 in UTF-16 offsets.
  const nextClusters = groups.map((g) => g.cluster).filter((c) => c > 1);
  assert.equal(Math.min(...nextClusters), 4, 'next cluster after the ligature should begin at index 4');
});

test('disabling liga gives per-glyph clusters (char count == glyph count for office)', () => {
  const s = shapeText(dejavu, 'office', { language: 'en', features: [{ tag: 'liga', value: 0 }] });
  assert.equal(s.glyphs.length, 6);
  assert.deepEqual(s.glyphs.map((g) => g.cluster), [0, 1, 2, 3, 4, 5]);
});

test('combining mark: base and mark share a cluster and keep GPOS offsets', () => {
  const text = 'q́'; // q + combining acute
  const s = shapeText(dejavu, text, { language: 'en', features: [] });
  assert.equal(s.glyphs.length, 2, 'HarfBuzz should emit base + mark');
  assert.equal([...text].length, 2, 'two code points');
  const [base, mark] = s.glyphs;
  assert.equal(base.cluster, mark.cluster, 'base and mark cluster must match');
  assert.ok(base.xAdvance > 0, 'base carries the advance');
  assert.equal(mark.xAdvance, 0, 'mark has zero advance');
  assert.notEqual(mark.xOffset, 0, 'GPOS moved the mark relative to its origin');
  const groups = clusterGroups(s.glyphs);
  assert.equal(groups.length, 1, 'mark cluster is atomic');
});

test('mark placement rides the base frame and preserves local GPOS offset', () => {
  const handle = dejavu;
  const path = linePath(0, 0, 1000, 0);
  const r = layoutCurvedText(path, handle, params({ text: 'q́', fontSize: 100, align: 'start' }));
  assert.equal(r.ok, true);
  const [base, mark] = r.glyphs;
  assert.equal(mark.attachedToBase, true);
  assert.equal(mark.baseGlyphIndex, base.glyphIndex);
  // On a straight horizontal path the tangent is +x, so the matrix reduces to
  // translation + scale; the mark's outline origin is the base origin plus the
  // GPOS offset carried through the frame.
  const k = r.shaping.scale;
  closeTo(mark.point.x, base.point.x, 1e-9, 'mark shares base frame x');
  closeTo(mark.point.y, base.point.y, 1e-9, 'mark shares base frame y');
  closeTo(mark.matrix.e - base.matrix.e, mark.gpos.xOffset * k, 1e-9, 'mark x origin offset');
  closeTo(mark.matrix.f - base.matrix.f, -mark.gpos.yOffset * k, 1e-9, 'mark y origin offset (screen-down)');
  assert.ok(Math.abs(mark.gpos.xOffset) > 0 || Math.abs(mark.gpos.yOffset) > 0, 'expected nonzero GPOS offset');
});

test('mixed punctuation and quotes keep source slices exact', () => {
  const text = '“office” — ﬁx…';
  const s = shapeText(noto, text, { language: 'en', features: [{ tag: 'liga', value: 1 }] });
  const groups = clusterGroups(s.glyphs);
  const sources = groups.map((g) => {
    const end = groups[groups.indexOf(g) + 1]?.cluster ?? text.length;
    return text.slice(g.cluster, end);
  });
  assert.equal(sources.join(''), text, 'cluster slices must concatenate back to the input');
  assert.ok(sources.includes('“'), 'opening quote is sourced');
  assert.ok(sources.includes('”'), 'closing quote is sourced');
  assert.ok(sources.includes('…'), 'ellipsis is sourced');
});

test('UTF-16 clusters stay correct with astral characters', () => {
  const text = 'a𝐀b'; // U+1D400 is two UTF-16 units
  const cps = codePointsWithUtf16(text);
  assert.equal(cps.length, 3);
  assert.deepEqual(cps.map((c) => c.start), [0, 1, 3]);
  const s = shapeText(noto, text, { language: 'en', features: [] });
  const clusters = s.glyphs.map((g) => g.cluster);
  assert.ok(clusters.every((c) => c === 0 || c === 1 || c === 3), `unexpected clusters ${clusters}`);
});

test('bidi runs: Hebrew + Latin order and RTL levels', () => {
  const text = 'abc שלום 12 xyz';
  const runs = segmentRuns(text, 'auto', 'en');
  assert.deepEqual(runs.map((r) => r.dir), ['ltr', 'ltr', 'rtl', 'ltr']);
  const rtl = runs.find((r) => r.dir === 'rtl');
  assert.equal(rtl.script, 'Hebrew');
  assert.equal(text.slice(rtl.start, rtl.end), 'שלום ');
  // Visual order per L2: the RTL run comes after the left-side Latin but
  // before the trailing Latin.
  const visual = runs.map((r) => text.slice(r.start, r.end)).join('');
  assert.equal(visual, 'abc 12 שלום xyz');
});

test('RTL glyph order is visual and clusters are absolute offsets', () => {
  const text = 'abc שלום xyz';
  const s = shapeText(dejavu, text, { language: 'he', features: [] });
  const rtlRun = s.runs.find((r) => r.dir === 'rtl');
  const clusters = rtlRun.glyphs.map((g) => g.cluster);
  // HarfBuzz returns RTL glyphs in visual (left-to-right) order, so clusters
  // descend within the run.
  assert.deepEqual(clusters, [...clusters].sort((a, b) => b - a));
  // Absolute offsets: they point into the original string, not the run slice.
  assert.ok(clusters.every((c) => c >= rtlRun.start && c < rtlRun.end));
  assert.equal(text.slice(clusters[0], clusters[0] + 1), 'ם', 'visual-leftmost glyph is final mem');
});

test('scripts: neutral punctuation attaches to the surrounding script', () => {
  const runs = segmentRuns('שלום (אבג) 12 abc', 'rtl', 'he');
  const heb = runs.filter((r) => r.script === 'Hebrew');
  assert.ok(heb.length >= 1, 'expected Hebrew runs');
  const latin = runs.find((r) => r.script === 'Latin');
  assert.ok(latin, 'trailing Latin should stay Latin');
});

test('multi-run clusters stay absolute across run boundaries', () => {
  const text = 'abc שלום 12 xyz';
  const s = shapeText(dejavu, text, { language: 'en', features: [] });
  // Every cluster value must point into the original string, and every run's
  // clusters must fall inside that run's [start, end) slice.
  for (const run of s.runs) {
    for (const g of run.glyphs) {
      assert.ok(g.cluster >= run.start && g.cluster < run.end,
        `run ${run.runIndex} cluster ${g.cluster} outside [${run.start},${run.end})`);
      // The source slice at the cluster must round-trip through the original.
      assert.ok(g.cluster + 1 <= text.length);
    }
  }
  const groups = clusterGroups(s.glyphs);
  for (const g of groups) {
    const src = text.slice(g.cluster, Math.min(g.cluster + 2, text.length));
    assert.ok(src.length > 0, 'group source slice is non-empty');
  }
  // The last Latin run's clusters are at the tail of the string.
  const lastRun = s.runs[s.runs.length - 1];
  assert.equal(lastRun.dir, 'ltr');
  assert.equal(Math.max(...lastRun.glyphs.map((g) => g.cluster)), text.length - 1);
});

test('missing glyphs are reported, not silently dropped', () => {
  const path = linePath(0, 0, 800, 0);
  const r = layoutCurvedText(path, noto, params({ text: 'abc 中', fontSize: 40, align: 'start', overflow: 'clip' }));
  assert.equal(r.ok, true);
  const w = r.warnings.find((x) => x.code === 'missing-glyphs');
  assert.ok(w, 'expected missing-glyphs warning for CJK in Noto Sans (Latin subset)');
  assert.ok(w.detail.characters.includes('中'));
});

test('kerning changes relative spacing without any synthetic tracking', () => {
  const text = 'AVATAR';
  const withKern = shapeText(dejavu, text, { language: 'en', features: [{ tag: 'kern', value: 1 }] });
  const noKern = shapeText(dejavu, text, { language: 'en', features: [{ tag: 'kern', value: 0 }] });
  const sum = (s) => s.glyphs.reduce((a, g) => a + g.xAdvance, 0);
  assert.notEqual(sum(withKern), sum(noKern), 'kerning should alter the total advance');
  // Advances are HarfBuzz values (font units) throughout; layout only scales.
  const r = layoutCurvedText(linePath(0, 0, 2000, 0), dejavu, params({ text, fontSize: 50, align: 'start' }));
  closeTo(r.metrics.advancePx, sum(withKern) * (50 / dejavu.upem), 1e-9, 'scaled advance');
});

test('zero-advance marks do not consume arc length at cluster level', () => {
  const path = linePath(0, 0, 2000, 0);
  const withMark = layoutCurvedText(path, dejavu, params({ text: 'q́', fontSize: 50, align: 'start' }));
  const plain = layoutCurvedText(path, dejavu, params({ text: 'q', fontSize: 50, align: 'start' }));
  closeTo(withMark.metrics.advancePx, plain.metrics.advancePx, 1e-9, 'advance with/without mark');
});
