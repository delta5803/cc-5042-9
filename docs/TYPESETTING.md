# Typesetting contract — curved text on Bézier paths

This is the maintained contract between the curved-text evaluator
(`src/core/`, `cli/`) and its documentation, tests and saved documents. Every
number below is produced by the current evaluator and re-checked by
`test/contract.test.mjs` and `cli/verify-curve-text.mjs`. If the engine
changes, regenerate the evidence with `cli/position-data.mjs` and update this
file — do not hand-edit values to make a check pass.

Contract identifier: `envelope-typesetting-contract/1` (see
`src/core/contract.js`).

---

## 1. Coordinate system, direction and the start point

- All coordinates are CSS user units (px). **y grows downward**, as in SVG.
- A path is an ordered list of cubic segments joining explicit on-curve
  nodes. Arc length `s` is measured **from the first node of the effective
  path** and grows in the drawn node order, from `s = 0` to
  `s = pathLength`.
- The *effective* path is the authored path, or its geometric reversal when
  the document's `reversed` flag (or `--reverse`) is set. Reversal rebuilds
  the node list back-to-front and swaps each segment's control points; it
  never mutates the authored path stored in a document.
- Measured on the default six-node path (`src/state.js`, `DEFAULT_PATH`):
  - `pathLength ≈ 1208.793 px` (adaptive table, tolerance 0.05).
  - Start point `(110, 490)`; unit start tangent `(0.843661, -0.536875)`.
  - The tangent points up-right because y is screen-down; the same vector is
    an angle of `327.53°` under the angle convention below.

### Reversal rules (geometric, declared)

For a forward path of length `L` and its reversal:

1. Length is invariant: `reversedLength = L`.
2. The physical point at forward arc `s` is the point at reversed arc
   `L - s`: `forwardPath.pointAt(s) === reversedPath.pointAt(L - s)`.
3. The tangent there is negated:
   `reversedPath.tangentAt(L - s) = -forwardPath.tangentAt(s)`.
4. The reversed path's first node is the forward path's last node, so the
   declared start point moves to the opposite physical end.

Alignment (`start` / `center` / `end`) is always interpreted against the
**effective** path's declared direction, which is why reversing a path keeps
the same arc offsets while moving the text block to the other physical end.

## 2. Arc-length tables

Each cubic owns an arc-length table mapping its parameter `t ∈ [0, 1]` to
cumulative chord-sampled arc length (`src/geometry.js`).

- `uniform` — `n` equal parameter steps per segment (`samples`, default 64),
  giving `n + 1` samples including both endpoints.
- `adaptive` — recursive bisection by midpoint deviation from the chord;
  `tolerance` (default 0.05 px) tightens sampling on bends. The default path
  yields 109 total samples across its five segments at the default tolerance.
- Arc `s` maps back to `t` by binary search plus linear interpolation between
  the bracketing samples. The table is rebuilt on every edit; the sample
  count is surfaced in the UI, the CLI report and the JSON layout.

Line segments are cubics with controls at the 1/3 and 2/3 points, so both
table modes recover an exact line length.

## 3. Baseline, frames and baseline offset

- The **baseline is the Bézier path itself**. A glyph's anchor is the point
  on the path at its arc, never a warped bitmap or a per-character rotation
  around a fixed centre.
- The scale factor is `k = fontSize / upem` (e.g. 56 px on a 1000-upem font
  gives `k = 0.056`).
- Each glyph gets its own tangent frame. With unit tangent `T = (tx, ty)`:
  - local `+x` (the advance direction) maps to `k·T`;
  - local `+y` (font up) maps to `k·(ty, -tx)` — the **screen-up normal**,
    which is the baseline normal used for placement. It is deliberately not
    the raw curve normal, so glyphs stay upright relative to the screen.
- Glyph matrix produced by the engine (`layoutCurvedText`):
  `a = k·tx`, `b = k·ty`, `c = k·ty`, `d = -k·tx`, with `(e, f)` the anchor
  translated by the GPOS offset carried through the same frame.
- The angle reported per glyph is the screen-degree heading of the tangent,
  normalized to `[0, 360)`: `angleDeg = normalize(atan2(ty, tx))`.

### Baseline offset and alignment

- `startOffset` (px) is measured along the path from `s = 0` and is clamped
  to `[0, pathLength]`. The usable interval is
  `[offset, pathLength]`, of length `available = pathLength - offset`.
- The shaped block has width `advancePx = totalAdvance · k`. Its start is
  `blockStart = offset + (available - advancePx) · anchor`, where the anchor
  is `0` for `start`, `0.5` for `center`, `1` for `end`.
- A base glyph's anchor arc is therefore
  `arc = blockStart + k · (runPenStart + penX)`, where `penX` is the
  HarfBuzz pen position inside its run and `runPenStart` the run's offset in
  the visual string. `arcEnd = arc + xAdvance · k`.
- Beyond `[0, pathLength]` the frame continues along the endpoint tangent
  (used by the `extend` overflow strategy); the record flags such anchors as
  `extended: "start" | "end"`.

### Degenerate tangents

If the curve derivative vanishes at an anchor, the engine uses a declared
fallback chain — one-sided secant, nearest non-zero derivative, then `+x` —
and emits a `tangent-fallback` warning with the fallback kind. Cusps are
detected from the speed polynomial and reported as `cusp` diagnostics; every
returned tangent is still finite and unit length.

## 4. Shaping, mixed fonts and combining characters

- HarfBuzz (WASM) shapes each bidi/script run independently. Cluster values
  are **UTF-16 offsets into the original string**, so a ligature
  (`ffi` → one glyph covering source characters 1–3) and a base+mark cluster
  map back to exact source text. Concatenating the clusters' `source` slices
  reproduces the input string.
- Runs are returned in visual order per UAX #9; HarfBuzz already applies RTL
  mirroring, so the engine does not mirror again. Glyph arcs are monotone
  non-decreasing in visual order.
- **Mixed fonts** are selected per document via `fontId`; each layout uses
  one `FontHandle`, and variable fonts honour the `wght` axis through
  `setVariation`. The seven bundled fonts and their ids are the only valid
  references (see §7); an unknown id is a usage error, not a silent fallback.
- **Combining marks** (zero `xAdvance`) consume no arc length:
  - they are attached to their base glyph (`attachedToBase`,
    `baseGlyphIndex`) and share its anchor point and frame;
  - only their GPOS `(xOffset, yOffset)` moves them, transformed through the
    base frame. Example on DejaVu Sans at 100 px: the combining acute in
    `q́` has `arc = 0` (same as its base) and `gpos.xOffset = -165` font
    units, which the frame rotates onto the curve.
- Missing glyphs are reported with a `missing-glyphs` warning naming the
  characters; they render as `.notdef` rather than disappearing.

## 5. Overflow contract

Overflow is explicit; nothing is clipped silently.

| Strategy | Behaviour |
| --- | --- |
| `clip` | Geometry outside `[0, pathLength]` is cut by a local clip quad in the glyph's own baseline frame. Clusters entirely outside are dropped and counted; boundary glyphs keep a `clip` record with a positive retained width. |
| `extend` | Every glyph is kept; anchors past an end continue along that endpoint's tangent and are flagged `extended`. |
| `error` | No glyphs are produced. A coded `text-overflow` error reports the advance, available length and deficit; the CLI exits `3`. |

A shaping cluster (ligature or base+marks) is atomic for overflow: it is
either placed whole or dropped whole.

## 6. Worked evidence (current evaluator)

Command:

```bash
node cli/position-data.mjs --text "office" --size 56 --align start
```

On the default path, Noto Sans variable at `wght=500`, `liga`/`kern` on:

| glyph | source | arc (px) | advance (px) | angleDeg | anchor point |
| --- | --- | --- | --- | --- | --- |
| 0 | `o` | 0.000 | 34.216 | 327.529 | (110, 490) |
| 1 | `ffi` (ligature) | 34.216 | 55.048 | 325.654 | (138.536, 471.143) |
| 2 | `c` | 89.264 | 27.496 | 323.615 | (183.377, 439.218) |
| 3 | `e` | 116.760 | 32.144 | 322.935 | (205.430, 422.756) |

Each row's arc equals the previous arc plus the previous glyph's scaled
HarfBuzz advance; the point equals `path.pointAt(arc)` and the angle equals
`normalize(atan2(tangent))`. These are the exact fields
`verify-curve-text.mjs` diffs when reproducing a record.

## 7. Verification tooling

- `cli/position-data.mjs` — generates the positioning record for a text and
  curve: conventions, the authored path and reverse flag, per-cluster and
  per-glyph arcs, anchor points, tangents, normals, angles, advances and GPOS
  offsets, plus an embedded contract check (and a reversal check when
  `--reverse` is used). Exit `5` if the embedded contract fails.
- `cli/verify-curve-text.mjs` — the curve-text validator.
  - `--doc file.json` / `--text "…" [options]`: re-evaluate and verify the
    full contract, including the geometric reversal rules.
  - `--position-data record.json`: re-evaluate the same text and curve and
    diff every anchor, tangent, angle and advance against the stored
    evidence. The embedded `authoredPath` makes the record self-contained;
    `--doc`/`--path` override it.
  - Exit codes: `0` contract holds; `2` usage; `3` declared layout error;
    `4` IO; `5` contract violation or reproduction mismatch.
- The validator never substitutes a default to force a pass: a failed
  layout, zero placed glyphs, a missing embedded curve or any numeric
  mismatch is a hard failure with the offending evidence printed.
- `test/contract.test.mjs` codifies the same checks under `node:test`,
  including reversed paths, combining marks, ligatures, extend anchors and
  tamper/empty-output negative cases.

## 8. Font references (maintained list)

Only these fonts are bundled under `public/fonts/` and referenced by
`FONTS` in `src/core/shaping.js`. A reference to any other file is stale and
must be updated to one of these or removed:

| id | File | License |
| --- | --- | --- |
| `notosans` | `NotoSans-VF.ttf` (variable) | OFL (`NotoSans-OFL.txt`) |
| `notoserif` | `NotoSerif-VF.ttf` (variable) | OFL (`NotoSerif-OFL.txt`) |
| `amiri` | `Amiri-Regular.ttf` | OFL (`Amiri-OFL.txt`) |
| `dejavusans` | `DejaVuSans.ttf` | DejaVu (`DejaVu-LICENSE.txt`) |
| `dejavuserif` | `DejaVuSerif.ttf` | DejaVu |
| `dejavumono` | `DejaVuSansMono.ttf` | DejaVu |
| `dejavusansbold` | `DejaVuSans-Bold.ttf` | DejaVu |

## 9. Reproducing in a new environment

```bash
npm install
node cli/position-data.mjs --doc saved.json --out record.json
node cli/verify-curve-text.mjs --position-data record.json
```

A zero exit code and `129/129`-style passing counts mean the same text,
curve, anchors and baseline direction reproduce exactly. For interactive
verification use the browser editor (`npm run dev`, see `README.md`): drag a
curve anchor, edit the text, and confirm in the vector stage that glyph
ordering follows the baseline tangent and the diagnostics panel shows no
contract-relevant warnings.
