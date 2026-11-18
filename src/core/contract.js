// Typesetting contract verification.
//
// Every check here re-derives an expected value from the *current* evaluator
// inputs (the shaped output, the arc-length table, the authored path) and
// compares it against the placement the engine produced. Nothing is a frozen
// golden number and nothing falls back to a default that could mask a broken
// layout: a check with no evidence to compare against fails loudly instead of
// passing.
//
// Conventions under contract (see docs/TYPESETTING.md):
//   * Arc length s is measured from the first node of the *effective* path;
//     the effective path is the authored path, or its geometric reversal when
//     the document's reverse flag is set.
//   * y grows downward. The glyph frame is right-handed on screen: local +x
//     maps to k*tangent, local +y maps to k*(ty, -tx) (the screen-up normal).
//   * A base glyph anchor is arc = blockStart + k*(runPenStart + penX), and its
//     anchor point equals path.pointAt(arc) (or the endpoint-tangent
//     extrapolation when extend places it beyond [0, length]).
//   * Zero-advance combining marks consume no arc length: they share their
//     base glyph's anchor and only move by their GPOS offset through the frame.
//   * Reversal is geometric: the length is invariant and tangents at mirrored
//     physical points negate.

import { frameAt } from './layout.js';

export const CONTRACT_VERSION = 'envelope-typesetting-contract/1';

const APPROX = 1e-6;

function approx(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

// Run one predicate, recording evidence regardless of outcome.
function check(report, name, pass, evidence, detail = null) {
  report.checks.push({ name, pass: !!pass, evidence, detail });
  if (!pass) report.failures.push({ name, evidence, detail });
  return pass;
}

// Expected frame for an arc, including the extend strategy's endpoint-tangent
// continuation. Reuses the evaluator's own rule so the comparison is against
// the declared contract rather than a second independent guess.
function expectedFrame(path, arc) {
  const f = frameAt(path, arc);
  return { point: f.point, tangent: f.tangent, extended: f.extended };
}

// Verify a single glyph's anchor (arc origin), anchor point, tangent frame and
// screen-up normal against independently recomputed values.
function verifyGlyphAnchor(report, path, layout, glyph, glyphByIndex) {
  const k = layout.shaping.scale;
  const tol = Math.max(APPROX, path.length * 1e-10);
  const gid = `glyph#${glyph.glyphIndex}(gid ${glyph.gid}, cluster ${glyph.cluster})`;

  // 1. Arc distance from the shaping pen. A zero-advance mark consumes no arc:
  //    it is anchored on its base frame, so its arc equals the base glyph's arc
  //    (the engine sets s0 = baseFrame.s for attached glyphs).
  const expectedArc = glyph.attachedToBase
    ? glyphByIndex?.get(glyph.baseGlyphIndex)?.arc
    : layout.metrics.blockStart + k * glyph.penFontUnits;
  check(
    report,
    glyph.attachedToBase
      ? `${gid} mark arc equals its base glyph's arc (no arc length consumed)`
      : `${gid} arc equals blockStart + scale × pen distance`,
    expectedArc !== undefined && approx(glyph.arc, expectedArc, tol),
    { expected: expectedArc, actual: glyph.arc, tolerance: tol, penFontUnits: glyph.penFontUnits },
  );

  // 2. Anchor point on the curve (or its declared extension beyond the ends).
  const frame = expectedFrame(path, glyph.arc);
  check(
    report,
    `${gid} anchor point lies on the path at its arc`,
    approx(glyph.point.x, frame.point.x, tol) && approx(glyph.point.y, frame.point.y, tol),
    { expected: frame.point, actual: glyph.point, extended: frame.extended },
  );

  // 3. Tangent is the unit tangent at that arc.
  const t = frame.tangent;
  check(
    report,
    `${gid} tangent is the unit path tangent at the anchor`,
    approx(glyph.tangent.x, t.x, tol) && approx(glyph.tangent.y, t.y, tol) &&
      approx(Math.hypot(glyph.tangent.x, glyph.tangent.y), 1, tol),
    { expected: t, actual: glyph.tangent },
  );

  // 4. Matrix: local +x -> k tangent, local +y -> k screen-up normal (ty,-tx).
  const { a, b, c, d } = glyph.matrix;
  check(
    report,
    `${gid} frame matrix maps local axes onto tangent and screen-up normal`,
    approx(a, k * t.x, tol) && approx(b, k * t.y, tol) &&
      approx(c, k * t.y, tol) && approx(d, -k * t.x, tol),
    { expectedMatrix: { a: k * t.x, b: k * t.y, c: k * t.y, d: -k * t.x }, actualMatrix: { a, b, c, d } },
  );

  // 5. Declared normal is perpendicular and screen-up relative to the tangent.
  check(
    report,
    `${gid} normal is the screen-up normal (ty, -tx) and unit length`,
    approx(glyph.normal.x, t.y, tol) && approx(glyph.normal.y, -t.x, tol) &&
      approx(Math.hypot(glyph.normal.x, glyph.normal.y), 1, tol),
    { expected: { x: t.y, y: -t.x }, actual: glyph.normal },
  );

  // 6. Angle convention: normalized atan2(tangent), 0..360, screen degrees.
  const expectedAngle = ((Math.atan2(t.y, t.x) * 180) / Math.PI + 360) % 360;
  check(
    report,
    `${gid} angleDeg is normalized atan2 of the tangent`,
    approx(glyph.angleDeg, expectedAngle, 1e-9),
    { expected: expectedAngle, actual: glyph.angleDeg },
  );

  // 7. Along-path distance: a base glyph's arcEnd is its anchor plus advance;
  //    an attached mark spans no arc length and keeps the same arc interval.
  const expectedArcEnd = glyph.attachedToBase ? glyph.arc : glyph.arc + glyph.advancePx;
  check(
    report,
    glyph.attachedToBase
      ? `${gid} mark arcEnd stays at the base arc`
      : `${gid} arcEnd is anchor arc plus its scaled advance`,
    approx(glyph.arcEnd, expectedArcEnd, tol),
    { expected: expectedArcEnd, actual: glyph.arcEnd, advancePx: glyph.advancePx },
  );
}

// Combining marks must ride their base frame: identical anchor, base link
// present, and the GPOS offset carried through the tangent frame exactly.
function verifyMarkAttachment(report, layout, glyph, glyphByIndex) {
  if (!glyph.attachedToBase) return;
  const base = glyphByIndex.get(glyph.baseGlyphIndex);
  const label = `mark glyph#${glyph.glyphIndex}`;
  check(
    report,
    `${label} links to a real preceding base glyph`,
    !!base && !base.attachedToBase && base.clusterIndex === glyph.clusterIndex,
    { baseGlyphIndex: glyph.baseGlyphIndex, found: !!base },
  );
  if (!base) return;

  check(
    report,
    `${label} shares its base glyph's anchor point`,
    approx(glyph.point.x, base.point.x, APPROX) && approx(glyph.point.y, base.point.y, APPROX),
    { basePoint: base.point, markPoint: glyph.point },
  );

  const k = layout.shaping.scale;
  // Matrix origin shift = R(k) applied to (xOffset, yOffset); screen y is down,
  // so the font's y-up offset enters with a minus.
  const dx = glyph.gpos.xOffset * k;
  const dy = glyph.gpos.yOffset * k;
  const ex = base.matrix.e + base.tangent.x * dx + base.tangent.y * dy;
  const ef = base.matrix.f + base.tangent.y * dx - base.tangent.x * dy;
  check(
    report,
    `${label} carries its GPOS offset through the base tangent frame`,
    approx(glyph.matrix.e, ex, APPROX) && approx(glyph.matrix.f, ef, APPROX),
    { expectedOrigin: { e: ex, f: ef }, actualOrigin: { e: glyph.matrix.e, f: glyph.matrix.f }, gpos: glyph.gpos },
  );
}

// Cluster-level contract: source slices concatenate back to the input, arcs are
// monotone in visual order, and zero-advance marks add no cluster span.
function verifyClusters(report, layout) {
  const joined = layout.clusters
    .filter((c) => c.arc !== null)
    .map((c) => c.source)
    .join('');
  check(
    report,
    'cluster source slices concatenate back to the shaped text',
    joined === layout.params.text,
    { expected: layout.params.text, actual: joined },
  );

  let previousArc = -Infinity;
  for (const c of layout.clusters) {
    if (c.arc === null) continue;
    check(
      report,
      `cluster#${c.index} “${c.source}” arc is not before the previous cluster's arc`,
      c.arc >= previousArc - APPROX,
      { previousArc, arc: c.arc },
    );
    previousArc = c.arc;
  }

  for (const c of layout.clusters) {
    if (!c.hasMarks) continue;
    const markGlyphs = c.glyphs.filter((g) => g.glyphIndex != null)
      .map((g) => layout.glyphs[g.glyphIndex])
      .filter((g) => g && g.attachedToBase);
    for (const g of markGlyphs) {
      check(
        report,
        `mark in cluster#${c.index} has zero advance and consumes no arc length`,
        approx(g.advancePx, 0, APPROX) && approx(g.arcEnd, g.arc, APPROX),
        { arc: g.arc, arcEnd: g.arcEnd, advancePx: g.advancePx },
      );
    }
  }
}

// Geometric reversal contract between a forward path and its reversal, using
// the same text and parameters on both effective paths. The two layouts place
// their text block relative to opposite declared ends, so glyphs with the same
// index do not share a physical point; instead each forward anchor is mapped
// through the geometric reversal (physical point identity) and its arc on the
// reversed path is recovered with the arc-length table.
export function verifyReversal(forwardLayout, reversedLayout, forwardPath, reversedPath) {
  const report = makeReport({ kind: 'reversal' });
  const L = forwardPath.length;
  check(
    report,
    'reversed path keeps the same total arc length',
    approx(reversedPath.length, L, 1e-6),
    { forwardLength: L, reversedLength: reversedPath.length },
  );
  check(
    report,
    'both layouts place the same number of glyphs',
    forwardLayout.glyphs.length === reversedLayout.glyphs.length && forwardLayout.glyphs.length > 0,
    { forward: forwardLayout.glyphs.length, reversed: reversedLayout.glyphs.length },
  );

  // Geometric identity: the point at forward arc s is the point at reversed
  // arc L - s. Verify on the anchors the forward layout actually placed, so
  // the check follows real execution evidence rather than a synthetic sample.
  const baseGlyphs = forwardLayout.glyphs.filter((g) => !g.attachedToBase);
  for (const fg of baseGlyphs) {
    const mirroredArc = L - fg.arc;
    const pr = reversedPath.pointAt(mirroredArc);
    const pf = forwardPath.pointAt(fg.arc);
    check(
      report,
      `forward glyph#${fg.glyphIndex} physical point is preserved at reversed arc L - s`,
      approx(pr.x, pf.x, 1e-3) && approx(pr.y, pf.y, 1e-3),
      { forwardArc: fg.arc, mirroredArc, forwardPoint: pf, reversedPoint: pr },
    );
    const tr = reversedPath.tangentAt(mirroredArc);
    const tf = forwardPath.tangentAt(fg.arc);
    check(
      report,
      `forward glyph#${fg.glyphIndex} tangent negates at the mirrored point`,
      approx(tr.x, -tf.x, 2e-3) && approx(tr.y, -tf.y, 2e-3),
      { forwardTangent: tf, reversedTangent: tr },
    );
  }

  // The same identity must hold for every glyph the reversed layout placed:
  // reversed arc s maps back to forward arc L - s with the negated tangent.
  for (const rg of reversedLayout.glyphs) {
    if (rg.attachedToBase) continue;
    const forwardArc = L - rg.arc;
    const pf = forwardPath.pointAt(forwardArc);
    const pr = reversedPath.pointAt(rg.arc);
    check(
      report,
      `reversed glyph#${rg.glyphIndex} maps back to the same physical point`,
      approx(pr.x, pf.x, 1e-3) && approx(pr.y, pf.y, 1e-3),
      { reversedArc: rg.arc, forwardArc, reversedPoint: pr, forwardPoint: pf },
    );
  }

  // Endpoint conventions: the reversed path's first node is the forward path's
  // last node, and the start tangents oppose each other.
  check(
    report,
    'reversal swaps the declared start and end nodes',
    approx(reversedPath.pointAt(0).x, forwardPath.pointAt(L).x, APPROX) &&
      approx(reversedPath.pointAt(0).y, forwardPath.pointAt(L).y, APPROX),
    { reversedStart: reversedPath.pointAt(0), forwardEnd: forwardPath.pointAt(L) },
  );
  return finalize(report);
}

export function makeReport(meta = {}) {
  return {
    contract: CONTRACT_VERSION,
    kind: meta.kind ?? 'layout',
    checkedAt: new Date().toISOString(),
    ok: false,
    checks: [],
    failures: [],
    summary: { total: 0, passed: 0, failed: 0 },
    inputs: meta.inputs ?? null,
  };
}

// Full contract check for one computed layout. `evidence` (font id, text,
// path length, table mode) is recorded so a report without real glyphs cannot
// be mistaken for a passing verification.
export function verifyLayoutContract(path, layout, inputs = {}) {
  const report = makeReport({ kind: 'layout', inputs });
  if (!layout?.ok) {
    check(report, 'layout is ok before anchor verification', false, {
      error: layout?.error ?? 'no layout',
    });
    return finalize(report);
  }
  check(report, 'layout produced at least one placed glyph', layout.glyphs.length > 0, {
    placed: layout.glyphs.length,
  });
  check(report, 'path has measurable arc length', path.length > 0, { pathLength: path.length });

  const glyphByIndex = new Map(layout.glyphs.map((g) => [g.glyphIndex, g]));
  for (const glyph of layout.glyphs) {
    verifyGlyphAnchor(report, path, layout, glyph, glyphByIndex);
    verifyMarkAttachment(report, layout, glyph, glyphByIndex);
  }
  verifyClusters(report, layout);

  // Arc-distance continuity: consecutive base glyphs are separated by exactly
  // the previous base glyph's scaled advance (HarfBuzz pen, no synthetic
  // tracking). Attached marks sit between them but consume no arc length.
  let lastBase = null;
  for (const glyph of layout.glyphs) {
    if (glyph.attachedToBase) continue;
    if (lastBase !== null) {
      check(
        report,
        `distance glyph#${lastBase.glyphIndex} -> glyph#${glyph.glyphIndex} equals the shaped advance`,
        approx(glyph.arc - lastBase.arc, lastBase.advancePx, Math.max(APPROX, path.length * 1e-10)),
        { arcDelta: glyph.arc - lastBase.arc, expectedAdvance: lastBase.advancePx },
      );
    }
    lastBase = glyph;
  }
  return finalize(report);
}

function finalize(report) {
  report.summary = {
    total: report.checks.length,
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.failures.length,
  };
  report.ok = report.failures.length === 0;
  return report;
}
