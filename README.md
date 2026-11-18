# Envelope — curved type on Bézier paths

Print-oriented curved-text typesetting. Text is **really shaped** with HarfBuzz
(WASM), then each shaped glyph is placed on a **self-authored cubic Bézier
path** using a real arc-length table and tangent frame. Ligatures, combining
marks, and mixed-direction runs are preserved as shaping clusters; glyph
outlines are transformed by their own frame. Nothing is a bitmap warp, a
per-character rotation, or a fixed letter-spacing approximation.

---

## Graphical entry point (primary)

**Curved text is edited in the browser app.**

```bash
npm install
npm run dev
```

Open **<http://localhost:5173>** (or the URL Vite prints, e.g.
`http://localhost:5173/`). This is the graphical entry point for curved text.

The editor is a three-column workbench:

| Panel | What you can do |
| --- | --- |
| **Left** | Edit the text, choose a font and variable weight, set direction/language, toggle `liga`/`kern`, choose alignment, start offset, overflow strategy, reverse the path, set the arc-length table mode/precision, and edit node coordinates numerically. |
| **Center** | The Bézier path and the placed glyphs. Drag orange anchors to move nodes, drag grey dots to bend the curve, drag empty space to pan, Ctrl/⌘-scroll to zoom, double-click the baseline to insert a node, Alt-click a node to delete it. Toggle baseline, tangents, advance boxes, outline strokes, and the cluster readout. |
| **Right** | Measured shaping info (font, upem, runs, clusters, ligatures, marks, features, variation), the cluster list with source text and arc/angle, declared diagnostics, and layout metrics. |

Top bar: **Undo/Redo**, **Export SVG**, **Export PNG**, **Save JSON**,
**Load JSON**, **Fit**.

The URL query always encodes the text and layout parameters, so reloading
reproduces the current state. For an exact, portable reproduction of the
**path as well**, use **Save JSON** and **Load JSON** (or the CLI `--doc`).

---

## What is computed, not approximated

- **Shaping** — HarfBuzz shapes each bidi/script run. Cluster values are
  UTF-16 offsets into the original string, so a ligature (`ffi` → one glyph)
  and a base+mark cluster (`q́` → base + zero-advance mark) map back to exact
  source characters. GPOS offsets are carried through the glyph matrix.
- **Arc length** — each cubic gets its own arc-length table. `uniform` uses a
  fixed number of parameter steps; `adaptive` subdivides by chord error, so
  tight bends get more samples. The table is rebuilt on every edit and its
  sample count is shown in the UI and CLI report.
- **Placement** — a glyph's arc is
  `blockStart + scale × (runPenStart + penX)`. The tangent at that arc drives
  the matrix `(a,b) = k·tangent`, `(c,d) = k·screen-up normal`; the baseline
  normal is the screen-up direction, not the raw curve normal.
- **Fallbacks** — if a tangent derivative vanishes, the engine uses a
  one-sided secant, then the nearest non-zero derivative, then `+x`, and emits
  a `tangent-fallback` warning. Cusps are detected (quartic roots of the speed
  polynomial) and reported as `cusp` diagnostics.
- **Overflow** — declared strategies, never silent clipping:
  - `clip` — glyph geometry outside `[0, pathLength]` is cut with a local clip
    quad; clusters entirely outside are dropped and counted.
  - `extend` — every glyph is kept, continuing along the start/end tangent.
  - `error` — no glyphs are produced; a coded `text-overflow` error reports the
    deficit.
- **Alignment / offset / reversal** — `start` places the block at the offset,
  `center` centers it in the remaining path, `end` flushes it to the path end.
  Reversal is geometric (arcs measured from the new first node, tangents
  negated) and is reported so the UI can show its declared direction.

## Export

- **SVG** — `<path>` outlines only (no `<text>`, no images), with clip paths
  for boundary glyphs. Suitable for print/vector workflows.
- **PNG** — rasterized through the same glyph outlines at 2× (browser) or
  `--png-scale` (CLI).
- **JSON** — an `envelope-curve-type/1` document containing parameters, the
  authored path, and the reverse flag; loading it reproduces the layout.

---

## CLI (assistive only)

The command line is a helper for batch rendering and inspection. **Use the
browser app above for editing curved text** — path manipulation needs direct
manipulation.

```bash
npm run cli -- --text "office ffi — déjà vu" --out curved.svg
npm run cli -- --doc saved.json --out curved.png --png-scale 2
npm run cli -- --text "office" --json
```

Useful flags: `--font`, `--size`, `--weight`, `--offset`, `--align`,
`--overflow`, `--dir`, `--lang`, `--liga`, `--kern`, `--lt-mode`, `--lt-tol`,
`--lt-samples`, `--reverse`, `--guides`, `--width/--height`, `--color`,
`--background`, `--json`, `--quiet`. Run `npm run cli -- --help` for the full
list.

Exit codes: `0` success, `2` usage error, `3` declared layout error (e.g.
overflow under `--overflow error`), `4` file/IO error.

`--json` prints per-glyph `arc`, `point`, `tangent`, `angleDeg`, `advancePx`,
cluster mapping, and the length-table and metrics blocks — the same numbers the
UI shows, so batch jobs can be checked against the editor.

---

## Tests

```bash
npm test        # shaping, geometry, layout, render, document/CLI (Node)
npm run test:ui # Chromium UI integration (needs system libs, see below)
```

The Node suite covers:

- ligatures and marks with real cluster offsets (char count ≠ glyph count);
- mixed punctuation and quotes, astral characters, RTL visual order;
- exact advance→arc mapping and relative glyph spacing;
- tangent frames, curvature, cusps, and declared tangent fallbacks;
- uniform vs adaptive arc tables and precision control;
- clip / extend / error overflow semantics and boundary clipping;
- alignment, start offset, and path-reversal consistency;
- parameter reproduction through documents, query strings, and the CLI;
- SVG vector output (no `<text>`), clip paths, and canvas rasterization.

The UI suite drives the real app: it checks the DOM glyph outlines, cluster
readout, drag/undo/redo/insert/reverse interactions, the error/clip/extend
states, cusp diagnostics, SVG/PNG downloads, and JSON save→load reproduction.

### Chromium in minimal containers

Playwright's Chromium needs system libraries that may be absent. The UI runner
prepends `/tmp/sysroot/usr/lib/aarch64-linux-gnu` and
`/tmp/sysroot/lib/aarch64-linux-gnu` to `LD_LIBRARY_PATH`. If your environment
lacks them, install the usual Playwright dependencies or extract the packages
into a sysroot and adjust that path in `test/ui.run.mjs`.

---

## Layout of the repository

```
index.html              browser entry point (graphical curved-text editor)
src/
  main.js               UI wiring, stage interaction, history, export
  state.js              document model, defaults, query serialization
  styles.css            UI styling
  geometry.js           Bézier math, arc-length tables, tangents, cusps
  core/shaping.js       HarfBuzz shaping, bidi/script runs, clusters
  core/layout.js        advance→arc placement, overflow, metrics, warnings
  core/render.js        SVG scene + canvas rasterizer (shared)
  core/pathedit.js      node/control editing, split, reverse, hit-testing
  core/platform.js      Node/browser font + HarfBuzz loading
cli/curvetext.mjs       command-line assist (SVG/PNG/JSON reports)
public/fonts/           bundled fonts with licenses
public/vendor/harfbuzz/ HarfBuzz WASM build
test/                   node:test suites + Playwright UI runner
```

## Fonts

Noto Sans/Serif (variable, OFL), Amiri (OFL), and DejaVu Sans/Serif/Mono/Bold
(DejaVu license) are bundled with their license files under `public/fonts/`.
