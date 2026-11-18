#!/usr/bin/env node
// Command-line helper for the curved-text engine. This is deliberately an
// assist — the graphical editor (npm run dev, see README) is the primary entry
// point for curved text, because path editing needs direct manipulation.
//
// Usage:
//   node cli/curvetext.mjs --text "office ffi" --out out.svg
//   node cli/curvetext.mjs --doc saved.json --out out.png --size 2
//   node cli/curvetext.mjs --text "..." --path path.json --json
//
// Options:
//   --text <s>            Text to place (mutually exclusive with --doc)
//   --doc <file>          Load an envelope-curve-type/1 JSON document
//   --path <file>         Path JSON {nodes:[[x,y]], controls:[{c1,c2}]}
//   --font <id>           Font id from the built-in list (default notosans)
//   --size <px>           Font size in px (default 56)
//   --weight <n>          Variable font wght axis (default 500)
//   --offset <px>         Start offset along the path (default 0)
//   --align start|center|end
//   --overflow clip|extend|error
//   --dir auto|ltr|rtl    Base direction
//   --lang <tag>          BCP-47 language (default en)
//   --liga 0|1            Ligatures (default 1)
//   --kern 0|1            Kerning (default 1)
//   --lt-mode uniform|adaptive
//   --lt-tol <n>          Adaptive arc-length tolerance (default 0.05)
//   --lt-samples <n>      Uniform samples per segment (default 64)
//   --reverse             Reverse the authored path
//   --out <file>          Output file; extension selects svg or png
//   --png-scale <n>       PNG scale factor (default 2)
//   --width/--height <px> Canvas size (default 1280x760)
//   --color <#rrggbb>     Glyph fill (default #1d2430)
//   --background <#rrggbb>
//   --guides              Include baseline/tangents in output
//   --json                Print measured layout as JSON (to stdout)
//   --quiet               Suppress the human-readable report
//
// Exit codes: 0 success; 2 usage error; 3 layout error (declared overflow
// with --overflow error, invalid params); 4 file/IO error.

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { hbModule, FontStore, FONTS } from '../src/core/shaping.js';
import { buildPathFromParams, layoutCurvedText } from '../src/core/layout.js';
import { buildScene, sceneToSVGString, drawSceneToCanvas } from '../src/core/render.js';
import { DEFAULT_PARAMS, DEFAULT_PATH, parseDocument } from '../src/state.js';

const USAGE = `Usage: node cli/curvetext.mjs --text "..." --out file.svg [options]
       node cli/curvetext.mjs --doc saved.json --out file.png

Text and layout:
  --text <s>            Text to place (mutually exclusive with --doc)
  --font <id>           Font id: ${FONTS.map((f) => f.id).join(', ')}
  --size <px>           Font size in px (default 56)
  --weight <n>          Variable font wght axis (default 500)
  --offset <px>         Start offset along the path (default 0)
  --align <a>           start | center | end (default center)
  --overflow <s>        clip | extend | error (default clip)
  --dir <d>             auto | ltr | rtl (default auto)
  --lang <tag>          BCP-47 language tag (default en)
  --liga <0|1>          Ligatures (default 1)
  --kern <0|1>          Kerning (default 1)
  --lt-mode <m>         uniform | adaptive (default adaptive)
  --lt-tol <n>          Adaptive arc-length tolerance (default 0.05)
  --lt-samples <n>      Uniform samples per segment (default 64)

Path and output:
  --path <file>         Path JSON {nodes:[[x,y]], controls:[{c1,c2}]}
  --doc <file>          envelope-curve-type/1 JSON document
  --reverse             Reverse the authored path
  --out <file>          .svg or .png output
  --png-scale <n>       PNG scale factor (default 2)
  --width <px>          Canvas width (default 1280)
  --height <px>         Canvas height (default 760)
  --color <#rrggbb>     Glyph fill (default #1d2430)
  --background <#rrggbb>
  --guides              Include baseline/tangents in the output
  --json                Print the measured layout as JSON
  --quiet               Suppress the human-readable report
  --help, -h            Show this help

Exit codes: 0 success, 2 usage error, 3 layout error, 4 file/IO error.
The graphical editor (npm run dev) is the primary entry point for curved text.`;

function parseArgs(argv) {
  const opts = { pngScale: 2, width: 1280, height: 760, json: false, quiet: false, guides: false };
  const takesValue = new Set([
    'text', 'doc', 'path', 'font', 'size', 'weight', 'offset', 'align', 'overflow',
    'dir', 'lang', 'liga', 'kern', 'lt-mode', 'lt-tol', 'lt-samples', 'out',
    'png-scale', 'width', 'height', 'color', 'background',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--reverse') opts.reverse = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--guides') opts.guides = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!takesValue.has(key)) throw new UsageError(`Unknown option --${key}`);
      if (i + 1 >= argv.length) throw new UsageError(`Option --${key} needs a value`);
      const value = argv[++i];
      if (key in opts && key !== 'pngScale') throw new UsageError(`Option --${key} given more than once`);
      opts[camel(key)] = value;
    } else {
      throw new UsageError(`Unexpected argument "${arg}"`);
    }
  }
  return opts;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class UsageError extends Error {}

function num(raw, name, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
  return n;
}

function bool(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new UsageError(`--${name} must be 0 or 1, got "${raw}"`);
}

function choice(raw, name, allowed, fallback) {
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) throw new UsageError(`--${name} must be one of ${allowed.join(', ')}; got "${raw}"`);
  return raw;
}

function hexColor(raw, name, fallback) {
  if (raw === undefined) return fallback;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(raw);
  if (!m) throw new UsageError(`--${name} must be a 6-digit hex colour, got "${raw}"`);
  return `#${m[1].toLowerCase()}`;
}

// Only options that were actually supplied override a base document, so
// `--doc saved.json --out x.svg` reproduces the saved layout exactly.
function applyOverrides(base, opts) {
  const p = {
    ...base,
    features: { ...base.features },
    variation: { ...base.variation },
    lengthTable: { ...base.lengthTable },
  };
  if (opts.text !== undefined) p.text = opts.text;
  if (opts.font !== undefined) p.fontId = choice(opts.font, 'font', FONTS.map((f) => f.id));
  if (opts.size !== undefined) p.fontSize = num(opts.size, 'size');
  if (opts.offset !== undefined) p.startOffset = num(opts.offset, 'offset');
  if (opts.align !== undefined) p.align = choice(opts.align, 'align', ['start', 'center', 'end']);
  if (opts.overflow !== undefined) p.overflow = choice(opts.overflow, 'overflow', ['clip', 'extend', 'error']);
  if (opts.dir !== undefined) p.baseDirection = choice(opts.dir, 'dir', ['auto', 'ltr', 'rtl']);
  if (opts.lang !== undefined) p.language = opts.lang;
  if (opts.liga !== undefined) p.features.liga = bool(opts.liga, 'liga');
  if (opts.kern !== undefined) p.features.kern = bool(opts.kern, 'kern');
  if (opts.weight !== undefined) p.variation.wght = num(opts.weight, 'weight');
  if (opts.ltMode !== undefined) p.lengthTable.mode = choice(opts.ltMode, 'lt-mode', ['uniform', 'adaptive']);
  if (opts.ltTol !== undefined) p.lengthTable.tolerance = num(opts.ltTol, 'lt-tol');
  if (opts.ltSamples !== undefined) p.lengthTable.samples = num(opts.ltSamples, 'lt-samples');
  if (opts.color !== undefined) p.color = hexColor(opts.color, 'color');
  p.showBaseline = false;
  p.showTangents = false;
  p.showClusterInfo = false;
  return p;
}

async function readJSON(file, what) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { throw new IOError(`Cannot read ${what} "${file}": ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new IOError(`${what} "${file}" is not valid JSON: ${err.message}`); }
}

class IOError extends Error {}

function validatePath(pathParams, what) {
  if (!Array.isArray(pathParams?.nodes) || !Array.isArray(pathParams?.controls)) {
    throw new IOError(`${what} must contain "nodes" and "controls" arrays`);
  }
  if (pathParams.nodes.length < 2) throw new IOError(`${what} needs at least two nodes`);
  if (pathParams.controls.length !== pathParams.nodes.length - 1) {
    throw new IOError(`${what} needs exactly nodes.length - 1 controls`);
  }
  for (const n of pathParams.nodes) {
    if (!Array.isArray(n) || n.length !== 2 || !n.every(Number.isFinite)) {
      throw new IOError(`${what}: every node must be [x, y] with finite numbers`);
    }
  }
  for (const c of pathParams.controls) {
    if (!Array.isArray(c?.c1) || !Array.isArray(c?.c2) || c.c1.length !== 2 || c.c2.length !== 2) {
      throw new IOError(`${what}: every control must be {c1:[x,y], c2:[x,y]}`);
    }
  }
}

function reversePath(p) {
  const n = p.nodes.length;
  const out = { nodes: [], controls: [] };
  for (let i = n - 1; i >= 0; i--) out.nodes.push([...p.nodes[i]]);
  for (let i = n - 2; i >= 0; i--) out.controls.push({ c1: [...p.controls[i].c2], c2: [...p.controls[i].c1] });
  return out;
}

function report(layout) {
  const lines = [];
  const s = layout.shaping;
  lines.push(`Font:        ${s.fontLabel} (upem ${s.upem}, ${s.scale.toFixed(5)} px/unit)`);
  lines.push(`Shaping:     ${s.charCount} chars -> ${s.glyphCount} glyphs, ${s.runCount} run(s), ${s.clusterCount} clusters`);
  lines.push(`Features:    ${s.features.length ? s.features.map((f) => f.tag).join(' ') : 'none'}   Variation: ${Object.entries(s.variation).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}`);
  const ligs = layout.clusters.filter((c) => c.ligature).length;
  const marks = layout.clusters.filter((c) => c.hasMarks).length;
  lines.push(`Clusters:    ${layout.clusters.length} (${ligs} ligature, ${marks} with marks)`);
  lines.push(`Path:        ${layout.metrics.pathLength.toFixed(2)} px, ${layout.lengthTable.totalSamples} arc samples (${layout.lengthTable.mode})`);
  lines.push(`Layout:      advance ${layout.metrics.advancePx.toFixed(2)} px, align ${layout.metrics.align}, overflow ${layout.metrics.strategy}`);
  lines.push(`             block [${layout.metrics.blockStart.toFixed(1)}, ${layout.metrics.blockEnd.toFixed(1)}] px, offset ${layout.metrics.offset.toFixed(1)} px`);
  if (layout.metrics.overflows) {
    lines.push(`Overflow:    start ${layout.metrics.overflowStart.toFixed(2)} px, end ${layout.metrics.overflowEnd.toFixed(2)} px (declared strategy: ${layout.metrics.strategy})`);
  }
  lines.push(`Placed:      ${layout.metrics.placedGlyphs}/${layout.metrics.glyphCount} glyphs, ${layout.metrics.clippedGlyphs} partially clipped, ${layout.metrics.droppedClusters} clusters dropped, ${layout.metrics.extendedGlyphs} extended`);
  for (const w of layout.warnings) lines.push(`Warning:     [${w.code}] ${w.message}`);
  return lines.join('\n');
}

function jsonReport(layout) {
  return JSON.stringify({
    ok: layout.ok,
    error: layout.error,
    warnings: layout.warnings,
    shaping: layout.shaping,
    metrics: layout.metrics,
    lengthTable: layout.lengthTable,
    runs: layout.runs,
    clusters: layout.clusters.map((c) => ({
      index: c.index, source: c.source, dir: c.dir, script: c.script,
      glyphCount: c.glyphCount, ligature: c.ligature, hasMarks: c.hasMarks,
      advancePx: c.advancePx, arc: c.arc, arcEnd: c.arcEnd, angleDeg: c.angleDeg,
      clipped: c.clipped, dropped: c.dropped,
    })),
    glyphs: layout.glyphs.map((g) => ({
      glyphIndex: g.glyphIndex, gid: g.gid, clusterIndex: g.clusterIndex,
      source: g.source, arc: g.arc, point: g.point, tangent: g.tangent,
      angleDeg: g.angleDeg, advancePx: g.advancePx, attachedToBase: g.attachedToBase,
      clipped: g.clipped, extended: g.extended,
    })),
  }, null, 2);
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(`error: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.text && !opts.doc) {
    console.error(`error: give --text or --doc\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.text && opts.doc) {
    console.error(`error: --text and --doc are mutually exclusive\n\n${USAGE}`);
    process.exit(2);
  }

  let baseParams = DEFAULT_PARAMS;
  let params = null;
  let pathParams = null;
  let reversed = false;
  try {
    if (opts.doc) {
      const doc = parseDocument(await readFile(opts.doc, 'utf8').catch((err) => {
        throw new IOError(`Cannot read document "${opts.doc}": ${err.message}`);
      }));
      baseParams = doc.params;
      pathParams = doc.path;
      reversed = doc.reversed;
    }
    if (opts.path) {
      pathParams = await readJSON(opts.path, 'path file');
    }
    if (!pathParams) pathParams = DEFAULT_PATH;
    validatePath(pathParams, opts.path ? `Path file "${opts.path}"` : 'Default path');
    params = applyOverrides(baseParams, opts);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(err instanceof IOError ? 4 : 2);
  }
  if (opts.reverse) reversed = !reversed;

  const fontMeta = FONTS.find((f) => f.id === params.fontId);
  if (!fontMeta) {
    console.error(`error: unknown font "${params.fontId}"`);
    process.exit(2);
  }

  const hb = await hbModule();
  const store = new FontStore(hb);
  const font = await store.load(fontMeta, params.variation);
  if (fontMeta.axes?.wght) font.setVariation({ wght: params.variation.wght });

  const path = buildPathFromParams({ ...(reversed ? reversePath(pathParams) : pathParams), lengthTable: params.lengthTable });
  const layout = layoutCurvedText(path, font, params);

  if (!layout.ok) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: layout.error, metrics: layout.metrics, warnings: layout.warnings }, null, 2));
    else console.error(`layout error [${layout.error.code}]: ${layout.error.message}`);
    process.exit(3);
  }

  if (opts.json) console.log(jsonReport(layout));
  else if (!opts.quiet) console.log(report(layout));

  if (opts.out) {
    const width = num(opts.width, 'width', 1280);
    const height = num(opts.height, 'height', 760);
    const background = hexColor(opts.background, 'background', '#ffffff');
    const ext = extname(opts.out).toLowerCase();
    try {
      if (ext === '.svg') {
        const scene = buildScene(layout, path, {
          width, height,
          background,
          color: params.color,
          showBaseline: opts.guides,
          showTangents: opts.guides,
          showBoxes: false,
          showOutlines: false,
          showClusterLabels: false,
          showAnchors: false,
          includeGlyphs: true,
          includeClipDefs: true,
          idPrefix: 'cli',
        });
        await writeFile(opts.out, sceneToSVGString(scene, `Curved text: ${params.text.slice(0, 60)}`), 'utf8');
      } else if (ext === '.png') {
        const scale = num(opts.pngScale, 'png-scale', 2);
        if (scale <= 0 || scale > 8) throw new UsageError('--png-scale must be between 0 and 8');
        const { createCanvas, Path2D } = await import('@napi-rs/canvas');
        const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        drawSceneToCanvas(ctx, layout, path, {
          width, height, background,
          color: params.color,
          showBaseline: opts.guides,
          showTangents: opts.guides,
          showNodes: false,
          path2d: Path2D,
        });
        await writeFile(opts.out, canvas.toBuffer('image/png'));
      } else {
        throw new UsageError('--out must end in .svg or .png');
      }
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(err instanceof UsageError ? 2 : 4);
    }
    if (!opts.quiet && !opts.json) console.log(`Wrote ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.stack ?? err}`);
  process.exit(1);
});
