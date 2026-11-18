#!/usr/bin/env node
// Curve-text contract validator (standalone).
//
// Two modes:
//   1. Evaluate a document (or text + path) with the current engine and verify
//      the typesetting contract: glyph anchors, along-path distances, tangent
//      frames, screen-up normals, mark attachment, cluster mapping and the
//      geometric reversal rules.
//   2. Reproduce a position-data record produced by cli/position-data.mjs:
//      re-evaluate the SAME text and curve and diff every glyph anchor and
//      frame against the stored evidence. This proves the layout reproduces in
//      a new environment.
//
// The validator never substitutes a default to make a check pass: a missing
// glyph, a failed layout or any numeric mismatch is a hard failure with exit
// code 5 and a printed list of offending checks.
//
// Exit codes: 0 contract holds; 2 usage error; 3 declared layout error;
//             4 file/IO error; 5 contract violation / reproduction mismatch.

import { readFile } from 'node:fs/promises';
import { hbModule, FontStore, FONTS } from '../src/core/shaping.js';
import { buildPathFromParams, layoutCurvedText } from '../src/core/layout.js';
import { DEFAULT_PATH, DEFAULT_PARAMS, parseDocument } from '../src/state.js';
import { verifyLayoutContract, verifyReversal } from '../src/core/contract.js';

const TAKES_VALUE = new Set([
  'doc', 'path', 'text', 'position-data', 'font', 'tol', 'size', 'weight',
  'offset', 'align', 'overflow', 'dir', 'lang', 'liga', 'kern',
  'lt-mode', 'lt-tol', 'lt-samples',
]);

function num(raw, name, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return n;
}

function choice(raw, name, allowed, fallback) {
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return raw;
}

function parseArgs(argv) {
  const opts = { tol: 1e-6 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--reverse') { opts.reverse = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!TAKES_VALUE.has(key)) throw new Error(`Unknown option --${key}`);
      if (i + 1 >= argv.length) throw new Error(`Option --${key} needs a value`);
      opts[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }
  return opts;
}

function reversePathParams(p) {
  const n = p.nodes.length;
  const out = { nodes: [], controls: [] };
  for (let i = n - 1; i >= 0; i--) out.nodes.push([...p.nodes[i]]);
  for (let i = n - 2; i >= 0; i--) out.controls.push({ c1: [...p.controls[i].c2], c2: [...p.controls[i].c1] });
  return out;
}

async function readJSON(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { throw new IOError(`cannot read "${file}": ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new IOError(`"${file}" is not valid JSON: ${err.message}`); }
}
class IOError extends Error {}

async function loadFont(params) {
  const meta = FONTS.find((f) => f.id === params.fontId);
  if (!meta) throw new Error(`unknown font "${params.fontId}"`);
  const hb = await hbModule();
  const store = new FontStore(hb);
  const handle = await store.load(meta, params.variation);
  if (meta.axes?.wght) handle.setVariation({ wght: params.variation.wght });
  return { meta, handle };
}

// Reproduction: re-evaluate the inputs recorded in a position-data file and
// diff every anchor/frame value against its stored evidence.
function diffPositionData(record, path, layout, tol) {
  const failures = [];
  const checks = [];
  const push = (name, pass, evidence) => {
    checks.push({ name, pass, evidence });
    if (!pass) failures.push({ name, evidence });
  };

  push(
    'record text matches the re-evaluated text',
    record.text === layout.params.text,
    { expected: record.text, actual: layout.params.text },
  );
  push(
    'glyph counts match the stored evidence',
    record.glyphs.length === layout.glyphs.length && record.glyphs.length > 0,
    { stored: record.glyphs?.length ?? 0, actual: layout.glyphs.length },
  );

  const n = Math.min(record.glyphs?.length ?? 0, layout.glyphs.length);
  for (let i = 0; i < n; i++) {
    const stored = record.glyphs[i];
    const actual = layout.glyphs[i];
    const label = `glyph#${i}`;
    push(`${label} gid matches`, stored.gid === actual.gid, { stored: stored.gid, actual: actual.gid });
    push(`${label} arc (along-path distance) reproduces`,
      Math.abs(stored.arc - actual.arc) <= tol, { stored: stored.arc, actual: actual.arc, tolerance: tol });
    push(`${label} anchor point reproduces`,
      Math.abs(stored.point.x - actual.point.x) <= tol && Math.abs(stored.point.y - actual.point.y) <= tol,
      { stored: stored.point, actual: actual.point });
    push(`${label} tangent reproduces`,
      Math.abs(stored.tangent.x - actual.tangent.x) <= tol && Math.abs(stored.tangent.y - actual.tangent.y) <= tol,
      { stored: stored.tangent, actual: actual.tangent });
    push(`${label} angleDeg reproduces`,
      Math.abs(stored.angleDeg - actual.angleDeg) <= 1e-6,
      { stored: stored.angleDeg, actual: actual.angleDeg });
    push(`${label} advance reproduces`,
      Math.abs(stored.advancePx - actual.advancePx) <= tol,
      { stored: stored.advancePx, actual: actual.advancePx });
  }
  push(
    'path length reproduces',
    Math.abs(record.path.length - path.length) <= 1e-4,
    { stored: record.path.length, actual: path.length },
  );
  return {
    contract: record.contract,
    kind: 'reproduction',
    ok: failures.length === 0,
    checks,
    failures,
    summary: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: failures.length },
  };
}

function printHuman(report, heading) {
  console.log(heading);
  console.log(`  ${report.summary.passed}/${report.summary.total} checks passed`);
  if (!report.ok) {
    for (const f of report.failures) {
      console.error(`  FAIL ${f.name}`);
      console.error(`       ${JSON.stringify(f.evidence)}`);
    }
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(2); }
  if (opts.help) {
    console.log('Usage:');
    console.log('  node cli/verify-curve-text.mjs --doc saved.json [--json]');
    console.log('  node cli/verify-curve-text.mjs --text "..." [--path path.json] [--font id]');
    console.log('    layout options: --size --weight --offset --align --overflow --dir --lang');
    console.log('                    --liga --kern --lt-mode --lt-tol --lt-samples --reverse');
    console.log('  node cli/verify-curve-text.mjs --position-data data.json [--doc saved.json | --path path.json]');
    return;
  }

  try {
    if (opts.positionData) {
      const record = await readJSON(opts.positionData);
      if (!record?.text || !Array.isArray(record.glyphs)) {
        throw new IOError('position-data file lacks text/glyphs evidence');
      }
      // Reconstruct parameters from the record; nothing is silently defaulted.
      const params = {
        ...DEFAULT_PARAMS,
        text: record.text,
        fontId: record.font.id,
        fontSize: record.params.fontSize,
        align: record.params.align,
        startOffset: record.params.startOffset,
        overflow: record.params.overflow,
        baseDirection: record.params.baseDirection,
        language: record.params.language,
        features: record.params.features,
        variation: record.font.variation,
        lengthTable: record.path.lengthTable.mode
          ? { mode: record.path.lengthTable.mode, tolerance: record.path.lengthTable.tolerance, samples: record.path.lengthTable.samplesOption }
          : { ...DEFAULT_PARAMS.lengthTable },
      };
      const { handle } = await loadFont(params);
      // Curve resolution order: explicit --doc, explicit --path, then the
      // authored path embedded in the record. No silent default curve.
      let pathParams = null;
      let reversed = record.conventions?.reversed ?? false;
      if (opts.doc) {
        const doc = parseDocument(await readFile(opts.doc));
        pathParams = doc.path;
        reversed = doc.reversed;
      } else if (opts.path) {
        pathParams = await readJSON(opts.path);
      } else if (record.authoredPath?.nodes && record.authoredPath?.controls) {
        pathParams = record.authoredPath;
      } else {
        throw new IOError('position-data record has no embedded curve; pass --doc or --path with the matching curve');
      }
      const effective = reversed ? reversePathParams(pathParams) : pathParams;
      const path = buildPathFromParams({ ...effective, lengthTable: params.lengthTable });
      const layout = layoutCurvedText(path, handle, params);
      if (!layout.ok) {
        console.error(`layout error [${layout.error.code}]: ${layout.error.message}`);
        process.exit(3);
      }
      const report = diffPositionData(record, path, layout, Number(opts.tol));
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else printHuman(report, `Reproduction of ${opts.positionData}`);
      process.exit(report.ok ? 0 : 5);
    }

    if (!opts.doc && !opts.text) { console.error('error: give --doc, --text or --position-data'); process.exit(2); }

    let params = { ...DEFAULT_PARAMS, features: { ...DEFAULT_PARAMS.features }, variation: { ...DEFAULT_PARAMS.variation }, lengthTable: { ...DEFAULT_PARAMS.lengthTable } };
    let pathParams = DEFAULT_PATH;
    let reversed = false;
    if (opts.doc) {
      const doc = parseDocument(await readJSON(opts.doc));
      params = doc.params;
      pathParams = doc.path;
      reversed = doc.reversed;
    }
    if (opts.path) pathParams = await readJSON(opts.path);
    if (opts.text) params.text = opts.text;
    if (opts.font) params.fontId = opts.font;
    if (opts.size !== undefined) params.fontSize = num(opts.size, 'size');
    if (opts.weight !== undefined) params.variation.wght = num(opts.weight, 'weight');
    if (opts.offset !== undefined) params.startOffset = num(opts.offset, 'offset');
    if (opts.align !== undefined) params.align = choice(opts.align, 'align', ['start', 'center', 'end']);
    if (opts.overflow !== undefined) params.overflow = choice(opts.overflow, 'overflow', ['clip', 'extend', 'error']);
    if (opts.dir !== undefined) params.baseDirection = choice(opts.dir, 'dir', ['auto', 'ltr', 'rtl']);
    if (opts.lang !== undefined) params.language = opts.lang;
    if (opts.liga !== undefined) params.features.liga = opts.liga === '1';
    if (opts.kern !== undefined) params.features.kern = opts.kern === '1';
    if (opts.ltMode !== undefined) params.lengthTable.mode = choice(opts.ltMode, 'lt-mode', ['uniform', 'adaptive']);
    if (opts.ltTol !== undefined) params.lengthTable.tolerance = num(opts.ltTol, 'lt-tol');
    if (opts.ltSamples !== undefined) params.lengthTable.samples = num(opts.ltSamples, 'lt-samples');
    if (opts.reverse) reversed = !reversed;

    const { meta, handle } = await loadFont(params);
    const effective = reversed ? reversePathParams(pathParams) : pathParams;
    const path = buildPathFromParams({ ...effective, lengthTable: params.lengthTable });
    const layout = layoutCurvedText(path, handle, params);
    if (!layout.ok) {
      console.error(`layout error [${layout.error.code}]: ${layout.error.message}`);
      process.exit(3);
    }

    const report = verifyLayoutContract(path, layout, {
      text: params.text, fontId: meta.id, pathLength: path.length,
      lengthTable: params.lengthTable, reversed,
    });
    let reversalReport = null;
    if (reversed) {
      const forwardPath = buildPathFromParams({ ...pathParams, lengthTable: params.lengthTable });
      const forwardLayout = layoutCurvedText(forwardPath, handle, params);
      if (forwardLayout.ok) reversalReport = verifyReversal(forwardLayout, layout, forwardPath, path);
    }
    const ok = report.ok && (!reversalReport || reversalReport.ok);
    if (opts.json) {
      console.log(JSON.stringify({ contract: report, reversal: reversalReport }, null, 2));
    } else {
      printHuman(report, `Typesetting contract: "${params.text}" (${meta.label})`);
      if (reversalReport) printHuman(reversalReport, 'Geometric reversal contract');
      console.log(ok ? '\nContract holds.' : '\nContract violated.');
    }
    process.exit(ok ? 0 : 5);
  } catch (err) {
    if (err instanceof IOError) { console.error(`error: ${err.message}`); process.exit(4); }
    console.error(`error: ${err.stack ?? err}`);
    process.exit(1);
  }
}

main();
