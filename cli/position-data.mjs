#!/usr/bin/env node
// Positioning-data generator for curved text.
//
// Produces machine-readable placement data from the SAME text and curve the
// editor/CLI evaluate: every glyph's along-path distance (arc), anchor point,
// tangent/normal frame, angle, advance and cluster mapping, plus the path's
// direction and start-point conventions. The output is the evidence input for
// the contract checker (test/contract.test.mjs) and can be diffed across
// environments to prove a layout reproduces.
//
// Usage:
//   node cli/position-data.mjs --text "office ffi" [--path path.json] [--out data.json]
//   node cli/position-data.mjs --doc saved.json --out data.json
// Run with --help for the full option list; layout options mirror curvetext.mjs.

import { writeFile, readFile } from 'node:fs/promises';
import { hbModule, FontStore, FONTS } from '../src/core/shaping.js';
import { buildPathFromParams, layoutCurvedText } from '../src/core/layout.js';
import { DEFAULT_PARAMS, DEFAULT_PATH, parseDocument } from '../src/state.js';
import { verifyLayoutContract, verifyReversal, CONTRACT_VERSION } from '../src/core/contract.js';

const TAKES_VALUE = new Set([
  'text', 'doc', 'path', 'font', 'size', 'weight', 'offset', 'align', 'overflow',
  'dir', 'lang', 'liga', 'kern', 'lt-mode', 'lt-tol', 'lt-samples', 'out',
]);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
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

function reversePathParams(p) {
  const n = p.nodes.length;
  const out = { nodes: [], controls: [] };
  for (let i = n - 1; i >= 0; i--) out.nodes.push([...p.nodes[i]]);
  for (let i = n - 2; i >= 0; i--) out.controls.push({ c1: [...p.controls[i].c2], c2: [...p.controls[i].c1] });
  return out;
}

function round(n, digits = 6) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundPoint(p) { return { x: round(p.x), y: round(p.y) }; }

// Build the serializable positioning record. No field is fabricated: every
// value comes from the evaluated layout or the path model.
function buildPositionRecord(path, layout, params, { reversed, fontMeta, pathParams }) {
  const start = path.pointAt(0);
  const end = path.pointAt(path.length);
  const startTangent = path.tangentAt(0);
  const endTangent = path.tangentAt(path.length);
  return {
    contract: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    conventions: {
      arcOrigin: 'first node of the effective path; arc length s grows in the drawn node order',
      reversed,
      coordinateSystem: 'y grows downward; angles are screen degrees, normalized 0..360 = atan2(tangent.y, tangent.x)',
      frame: 'local +x -> scale*tangent; local +y -> scale*screen-up normal (ty, -tx)',
      baselineNormal: 'screen-up (ty, -tx), never the raw curve normal',
    },
    // Authored (unreversed) curve plus the reverse flag, so a validator can
    // reconstruct the exact effective path with no external file.
    authoredPath: pathParams,
    path: {
      startPoint: roundPoint(start),
      endPoint: roundPoint(end),
      startTangent: roundPoint(startTangent),
      endTangent: roundPoint(endTangent),
      length: round(path.length),
      segmentCount: path.segments.length,
      lengthTable: layout.lengthTable,
    },
    text: params.text,
    font: { id: fontMeta.id, label: fontMeta.label, upem: layout.shaping.upem, variation: params.variation },
    params: {
      fontSize: params.fontSize,
      scale: layout.shaping.scale,
      align: params.align,
      startOffset: params.startOffset,
      overflow: params.overflow,
      baseDirection: params.baseDirection,
      language: params.language,
      features: params.features,
    },
    metrics: layout.metrics,
    runs: layout.runs,
    clusters: layout.clusters.map((c) => ({
      index: c.index, source: c.source, dir: c.dir, script: c.script,
      runIndex: c.runIndex, cluster: c.cluster, sourceStart: c.sourceStart, sourceEnd: c.sourceEnd,
      ligature: c.ligature, hasMarks: c.hasMarks, clipped: c.clipped, dropped: c.dropped,
      advancePx: round(c.advancePx), arc: c.arc === null ? null : round(c.arc),
      arcEnd: c.arcEnd === null ? null : round(c.arcEnd), angleDeg: c.angleDeg,
    })),
    glyphs: layout.glyphs.map((g) => ({
      glyphIndex: g.glyphIndex,
      gid: g.gid,
      clusterIndex: g.clusterIndex,
      runIndex: g.runIndex,
      source: g.source,
      dir: g.dir,
      penFontUnits: g.penFontUnits,
      advanceFontUnits: g.advanceFontUnits,
      advancePx: round(g.advancePx),
      arc: round(g.arc),
      arcEnd: round(g.arcEnd),
      point: roundPoint(g.point),
      tangent: roundPoint(g.tangent),
      normal: roundPoint(g.normal),
      angleDeg: round(g.angleDeg),
      gpos: g.gpos,
      attachedToBase: g.attachedToBase,
      baseGlyphIndex: g.baseGlyphIndex,
      degraded: g.degraded,
      clipped: g.clipped,
      extended: g.extended,
    })),
    warnings: layout.warnings,
  };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(2); }
  if (opts.help) {
    console.log('Usage: node cli/position-data.mjs (--text "..." | --doc file.json) [options] [--out file.json]');
    console.log('Options mirror curvetext.mjs: --font --size --weight --offset --align --overflow');
    console.log('  --dir --lang --liga --kern --lt-mode --lt-tol --lt-samples --path --reverse');
    return;
  }
  if (!opts.text && !opts.doc) { console.error('error: give --text or --doc'); process.exit(2); }

  let baseParams = DEFAULT_PARAMS;
  let pathParams = DEFAULT_PATH;
  let reversed = false;
  if (opts.doc) {
    const doc = parseDocument(await readFile(opts.doc, 'utf8'));
    baseParams = doc.params;
    pathParams = doc.path;
    reversed = doc.reversed;
  }
  if (opts.path) {
    pathParams = JSON.parse(await readFile(opts.path, 'utf8'));
  }
  if (opts.reverse) reversed = !reversed;

  const params = {
    ...baseParams,
    features: { ...baseParams.features },
    variation: { ...baseParams.variation },
    lengthTable: { ...baseParams.lengthTable },
  };
  if (opts.text !== undefined) params.text = opts.text;
  if (opts.font !== undefined) params.fontId = choice(opts.font, 'font', FONTS.map((f) => f.id));
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

  const fontMeta = FONTS.find((f) => f.id === params.fontId);
  if (!fontMeta) { console.error(`error: unknown font "${params.fontId}"`); process.exit(2); }

  const hb = await hbModule();
  const store = new FontStore(hb);
  const font = await store.load(fontMeta, params.variation);
  if (fontMeta.axes?.wght) font.setVariation({ wght: params.variation.wght });

  const effectivePathParams = reversed ? reversePathParams(pathParams) : pathParams;
  const path = buildPathFromParams({ ...effectivePathParams, lengthTable: params.lengthTable });
  const layout = layoutCurvedText(path, font, params);
  if (!layout.ok) {
    console.error(`layout error [${layout.error.code}]: ${layout.error.message}`);
    process.exit(3);
  }

  const record = buildPositionRecord(path, layout, params, { reversed, fontMeta, pathParams });
  record.contractCheck = verifyLayoutContract(path, layout, {
    text: params.text, fontId: params.fontId, pathLength: path.length,
    lengthTable: params.lengthTable, reversed,
  });

  // Reversal evidence on the same text/curve: the forward effective path and
  // its geometric reversal, with the mirrored-arc tangent contract checked.
  if (reversed) {
    const forwardPath = buildPathFromParams({ ...pathParams, lengthTable: params.lengthTable });
    const forwardLayout = layoutCurvedText(forwardPath, font, params);
    if (forwardLayout.ok) {
      record.reversalCheck = verifyReversal(forwardLayout, layout, forwardPath, path);
    }
  }

  const json = JSON.stringify(record, null, 2);
  if (opts.out) await writeFile(opts.out, json, 'utf8');
  else process.stdout.write(`${json}\n`);

  if (!record.contractCheck.ok) {
    console.error(`contract check FAILED: ${record.contractCheck.summary.failed} of ${record.contractCheck.summary.total} checks`);
    process.exit(5);
  }
  if (opts.out) console.error(`Wrote ${opts.out} (${record.glyphs.length} glyphs, contract ${record.contractCheck.summary.passed}/${record.contractCheck.summary.total} checks passed)`);
}

main().catch((err) => { console.error(err.stack ?? err); process.exit(1); });
