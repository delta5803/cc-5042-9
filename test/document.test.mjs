// Document + CLI integration: saved parameters reproduce the layout exactly,
// including path, reversal, alignment, and overflow behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDocument, parseDocument, DEFAULT_PARAMS, DEFAULT_PATH, paramsToQuery, paramsFromQuery } from '../src/state.js';
import { buildPathFromParams, layoutCurvedText } from '../src/core/layout.js';
import { reversePathParams } from '../src/core/pathedit.js';
import { font, closeTo } from './helpers.mjs';

const exec = promisify(execFile);
const noto = await font('notosans');
const CLI = new URL('../cli/curvetext.mjs', import.meta.url).pathname;

test('makeDocument -> parseDocument preserves params and path', () => {
  const params = {
    ...DEFAULT_PARAMS,
    text: '“office” ffi déjà',
    fontSize: 51,
    startOffset: 73,
    align: 'end',
    overflow: 'extend',
    variation: { wght: 650 },
    lengthTable: { mode: 'uniform', tolerance: 0.02, samples: 24 },
  };
  const doc = makeDocument(params, DEFAULT_PATH);
  doc.reversed = true;
  const parsed = parseDocument(JSON.stringify(doc));
  assert.equal(parsed.params.text, params.text);
  assert.equal(parsed.params.fontSize, 51);
  assert.equal(parsed.params.align, 'end');
  assert.equal(parsed.params.overflow, 'extend');
  assert.equal(parsed.params.variation.wght, 650);
  assert.deepEqual(parsed.params.lengthTable, params.lengthTable);
  assert.deepEqual(parsed.path.nodes, DEFAULT_PATH.nodes);
  assert.equal(parsed.reversed, true);
});

test('parseDocument rejects wrong formats with a clear error', () => {
  assert.throws(() => parseDocument('{"format":"other"}'), /format mismatch/);
  assert.throws(() => parseDocument('{"format":"envelope-curve-type/1"}'), /missing path/);
  assert.throws(() => parseDocument('not json'), /JSON/);
});

test('query string round-trips the layout parameters', () => {
  const params = {
    ...DEFAULT_PARAMS,
    text: 'query round trip — ffi',
    fontId: 'dejavuserif',
    fontSize: 61,
    startOffset: 42,
    align: 'start',
    overflow: 'extend',
    baseDirection: 'ltr',
    language: 'fr',
    features: { liga: false, kern: true },
    variation: { wght: 800 },
    lengthTable: { mode: 'uniform', tolerance: 0.4, samples: 25 },
    color: '#ab12cd',
  };
  const restored = paramsFromQuery(paramsToQuery(params).toString());
  assert.equal(restored.text, params.text);
  assert.equal(restored.fontId, 'dejavuserif');
  assert.equal(restored.fontSize, 61);
  assert.equal(restored.startOffset, 42);
  assert.equal(restored.align, 'start');
  assert.equal(restored.overflow, 'extend');
  assert.equal(restored.baseDirection, 'ltr');
  assert.equal(restored.language, 'fr');
  assert.equal(restored.features.liga, false);
  assert.equal(restored.features.kern, true);
  assert.equal(restored.variation.wght, 800);
  assert.deepEqual(restored.lengthTable, params.lengthTable);
  assert.equal(restored.color, '#ab12cd');
});

test('CLI --doc reproduces the same SVG geometry as the in-process layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'curvetext-'));
  try {
    const params = {
      ...DEFAULT_PARAMS,
      text: 'reproduce me — ffi déjà',
      fontSize: 48,
      align: 'center',
      startOffset: 20,
      overflow: 'clip',
      variation: { wght: 500 },
      lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64 },
    };
    const doc = makeDocument(params, DEFAULT_PATH);
    doc.reversed = true;
    const docPath = join(dir, 'doc.json');
    const out1 = join(dir, 'a.svg');
    const out2 = join(dir, 'b.svg');
    await writeFile(docPath, JSON.stringify(doc, null, 2));

    await exec(process.execPath, [CLI, '--doc', docPath, '--out', out1, '--quiet']);
    await exec(process.execPath, [CLI, '--doc', docPath, '--out', out2, '--quiet']);

    // Determinism: two runs of the same document are byte-identical.
    assert.equal(await readFile(out1, 'utf8'), await readFile(out2, 'utf8'));

    // In-process reproduction using the parsed document.
    const parsed = parseDocument(JSON.stringify(doc));
    const handle = await font('notosans', parsed.params.variation);
    const pp = parsed.reversed ? reversePathParams(parsed.path) : parsed.path;
    const layout = layoutCurvedText(
      buildPathFromParams({ ...pp, lengthTable: parsed.params.lengthTable }),
      handle, parsed.params,
    );
    assert.equal(layout.ok, true);
    const svg = await readFile(out1, 'utf8');
    for (const g of layout.glyphs) {
      assert.ok(svg.includes(g.outline), `CLI SVG missing glyph ${g.glyphIndex} outline`);
    }
    // The glyph paths in the SVG match exactly as many as placed.
    const n = (svg.match(/<path[^>]*fill="#1d2430"/g) || []).length;
    assert.equal(n, layout.glyphs.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI prints a JSON report with per-glyph arcs and tangents', async () => {
  const { stdout } = await exec(process.execPath, [
    CLI, '--text', 'office ffi', '--json', '--size', '44', '--align', 'start', '--overflow', 'clip',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.glyphs.length > 0);
  for (const g of report.glyphs) {
    assert.ok(Number.isFinite(g.arc));
    assert.ok(Number.isFinite(g.tangent.x) && Number.isFinite(g.tangent.y));
    assert.ok(Number.isFinite(g.angleDeg));
  }
  assert.ok(report.shaping.charCount > report.shaping.glyphCount, 'office ffi should ligate');
});

test('CLI exits 3 for declared overflow in error mode', async () => {
  await assert.rejects(
    exec(process.execPath, [CLI, '--text', 'office office office office office office office office', '--overflow', 'error']),
    (err) => {
      assert.equal(err.code, 3);
      assert.match(err.stderr, /text-overflow/);
      return true;
    },
  );
});

test('CLI exits 2 for usage mistakes', async () => {
  await assert.rejects(exec(process.execPath, [CLI]), (err) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr, /--text or --doc/);
    return true;
  });
  await assert.rejects(exec(process.execPath, [CLI, '--text', 'x', '--align', 'middle']), (err) => {
    assert.equal(err.code, 2);
    return true;
  });
  await assert.rejects(exec(process.execPath, [CLI, '--text', 'x', '--bogus', '1']), (err) => {
    assert.equal(err.code, 2);
    return true;
  });
});

test('path reversal through the document is applied exactly once', () => {
  const doc = makeDocument({ ...DEFAULT_PARAMS, text: 'once', fontSize: 40 }, DEFAULT_PATH);
  doc.reversed = true;
  const parsed = parseDocument(JSON.stringify(doc));
  const effective = parsed.reversed ? reversePathParams(parsed.path) : parsed.path;
  const path = buildPathFromParams({ ...effective, lengthTable: parsed.params.lengthTable });
  // Reversing twice returns the original node sequence.
  const twice = reversePathParams(effective);
  assert.deepEqual(twice.nodes, DEFAULT_PATH.nodes);
  assert.ok(path.length > 0);
  closeTo(path.length, buildPathFromParams({ ...DEFAULT_PATH, lengthTable: parsed.params.lengthTable }).length, 1e-6, 'length invariant under reversal');
});
