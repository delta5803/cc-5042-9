// Cubic Bezier path geometry: flattening, arc-length tables, point/tangent lookup.
// All coordinates are in user units (CSS px); y grows downward.

export const EPS = 1e-9;

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ---------------------------------------------------------------------------
// Path model
// The editable path is a list of cubic segments with explicit on-curve nodes:
//   { kind: 'cubic', p0, c1, c2, p1 }
// Straight lines are encoded as cubics with control points at 1/3 and 2/3 to
// keep the geometry code single-purpose; the UI flags them as line-like when
// the control points are collinear and evenly spaced.
// ---------------------------------------------------------------------------

export function makeLineSegment(p0, p1) {
  return {
    kind: 'cubic',
    p0: { ...p0 },
    c1: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
    c2: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
    p1: { ...p1 },
    line: true,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function cubicPoint(seg, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * seg.p0.x + b * seg.c1.x + c * seg.c2.x + d * seg.p1.x,
    y: a * seg.p0.y + b * seg.c1.y + c * seg.c2.y + d * seg.p1.y,
  };
}

export function cubicDerivative(seg, t) {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
  return {
    x: a * (seg.c1.x - seg.p0.x) + b * (seg.c2.x - seg.c1.x) + c * (seg.p1.x - seg.c2.x),
    y: a * (seg.c1.y - seg.p0.y) + b * (seg.c2.y - seg.c1.y) + c * (seg.p1.y - seg.c2.y),
  };
}

export function cubicSecondDerivative(seg, t) {
  const mt = 1 - t;
  return {
    x: 6 * mt * (seg.c2.x - 2 * seg.c1.x + seg.p0.x) + 6 * t * (seg.p1.x - 2 * seg.c2.x + seg.c1.x),
    y: 6 * mt * (seg.c2.y - 2 * seg.c1.y + seg.p0.y) + 6 * t * (seg.p1.y - 2 * seg.c2.y + seg.c1.y),
  };
}

// Speed |B'(t)| for a cubic. Used for Gauss-Legendre integration and for
// locating stationary points (cusps / zero-derivative places).
export function cubicSpeed(seg, t) {
  const d = cubicDerivative(seg, t);
  return Math.hypot(d.x, d.y);
}

// ---------------------------------------------------------------------------
// Adaptive flattening (de Casteljau with flatness test).
// Includes a depth cap; deep subdivision near cusps is accepted rather than
// looping forever, which is the declared fallback for pathological segments.
// ---------------------------------------------------------------------------

export const FLATTEN_TOL = 0.02; // user units; controls polyline error
const FLATTEN_MAX_DEPTH = 24;

function flattenInto(seg, out, depth = 0) {
  const { p0, c1, c2, p1 } = seg;
  // Distance of control points from the chord; quadratic upper bound on error.
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const d1 = Math.abs((c1.x - p1.x) * dy - (c1.y - p1.y) * dx);
  const d2 = Math.abs((c2.x - p1.x) * dy - (c2.y - p1.y) * dx);
  const dd = d1 + d2;
  if (depth >= FLATTEN_MAX_DEPTH || dd * dd <= FLATTEN_TOL * FLATTEN_TOL * (dx * dx + dy * dy)) {
    out.push(p1);
    return;
  }
  const ab = lerp(p0, c1, 0.5);
  const bc = lerp(c1, c2, 0.5);
  const cd = lerp(c2, p1, 0.5);
  const abc = lerp(ab, bc, 0.5);
  const bcd = lerp(bc, cd, 0.5);
  const mid = lerp(abc, bcd, 0.5);
  flattenInto({ p0, c1: ab, c2: abc, p1: mid }, out, depth + 1);
  flattenInto({ p0: mid, c1: bcd, c2: cd, p1 }, out, depth + 1);
}

export function flattenSegment(seg, startPoint) {
  const pts = [startPoint ?? seg.p0];
  flattenInto(seg, pts);
  return pts;
}

// ---------------------------------------------------------------------------
// Arc-length sampling table.
// Each segment stores cumulative arc lengths at parameter samples. Two modes:
//   'uniform'  - n equal parameter steps (fast, predictable, good for smooth)
//   'adaptive' - parameter samples refined by chord-vs-arc error, so tight
//                bends get more samples than flat stretches.
// The table is rebuildable at any time; `precision` controls tolerance.
// ---------------------------------------------------------------------------

export function buildSegmentTable(seg, opts = {}) {
  const mode = opts.mode ?? 'adaptive';
  const tolerance = opts.tolerance ?? 0.05; // user units per-sample chord error
  const maxSamples = opts.maxSamples ?? 2000;
  const minSamples = opts.minSamples ?? 8;
  let params;
  if (mode === 'uniform') {
    const n = Math.max(minSamples, Math.min(maxSamples, opts.samples ?? 64));
    params = [0];
    for (let i = 1; i <= n; i++) params.push(i / n);
  } else {
    params = [0];
    // Recursive bisection by midpoint deviation from the chord. Uses the
    // control-point bound; near cusps it subdivides heavily, which is correct.
    const refine = (t0, t1) => {
      if (params.length >= maxSamples) { params.push(t1); return; }
      const tm = (t0 + t1) / 2;
      const a = cubicPoint(seg, t0), m = cubicPoint(seg, tm), b = cubicPoint(seg, t1);
      const chord = dist(a, b);
      const err = Math.abs((m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x)) / Math.max(chord, EPS);
      if (chord < tolerance * 0.5 || err < tolerance) {
        params.push(t1);
      } else {
        refine(t0, tm);
        refine(tm, t1);
      }
    };
    // Seed with a coarse split so recursion has structure; guard iterations.
    const seed = Math.max(minSamples, 4);
    let prev = 0;
    for (let i = 1; i <= seed; i++) {
      const t = i / seed;
      refine(prev, t);
      prev = t;
    }
  }
  params.sort((a, b) => a - b);
  // Deduplicate and force endpoints.
  const clean = [0];
  for (let i = 1; i < params.length; i++) {
    if (params[i] - clean[clean.length - 1] > 1e-12) clean.push(params[i]);
  }
  if (clean[clean.length - 1] !== 1) clean.push(1);

  const cum = [0];
  let total = 0;
  let prevPt = cubicPoint(seg, 0);
  for (let i = 1; i < clean.length; i++) {
    const pt = cubicPoint(seg, clean[i]);
    total += dist(prevPt, pt);
    cum.push(total);
    prevPt = pt;
  }
  return { mode, params: clean, cum, length: total };
}

// Map arc length s -> parameter t on one segment table.
export function segmentTAtLength(table, s) {
  const { params, cum, length } = table;
  if (s <= 0) return 0;
  if (s >= length) return 1;
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const c0 = cum[lo], c1 = cum[hi];
  const t0 = params[lo], t1 = params[hi];
  const f = c1 - c0 < EPS ? 0 : (s - c0) / (c1 - c0);
  return t0 + (t1 - t0) * f;
}

// ---------------------------------------------------------------------------
// Whole-path model
// ---------------------------------------------------------------------------

export class BezierPath {
  constructor(segments = []) {
    this.segments = segments;
    this.rebuild();
  }

  static fromPolylinePoints(points, closed = false) {
    const segs = [];
    for (let i = 0; i + 1 < points.length; i++) segs.push(makeLineSegment(points[i], points[i + 1]));
    if (closed && points.length > 2) segs.push(makeLineSegment(points[points.length - 1], points[0]));
    return new BezierPath(segs);
  }

  rebuild(opts = {}) {
    this.tableOpts = {
      mode: opts.mode ?? this.tableOpts?.mode ?? 'adaptive',
      tolerance: opts.tolerance ?? this.tableOpts?.tolerance ?? 0.05,
      samples: opts.samples ?? this.tableOpts?.samples ?? 64,
      maxSamples: opts.maxSamples ?? 2000,
    };
    this.tables = this.segments.map((s) => buildSegmentTable(s, this.tableOpts));
    this.starts = [];
    let acc = 0;
    for (const t of this.tables) { this.starts.push(acc); acc += t.length; }
    this.length = acc;
    this.stationary = this.segments.map((s) => findStationary(s));
    return this;
  }

  // Locate the segment containing arc length s (clamped), returning local t.
  locate(s) {
    const clamped = Math.max(0, Math.min(this.length, s));
    for (let i = 0; i < this.tables.length; i++) {
      const t = this.tables[i];
      if (clamped <= this.starts[i] + t.length + EPS) {
        const local = Math.min(t.length, clamped - this.starts[i]);
        return { seg: i, t: segmentTAtLength(t, local), s: clamped };
      }
    }
    const last = this.tables.length - 1;
    return { seg: last, t: 1, s: this.length };
  }

  pointAt(s) {
    const loc = this.locate(s);
    return cubicPoint(this.segments[loc.seg], loc.t);
  }

  tangentAt(s) {
    const loc = this.locate(s);
    const seg = this.segments[loc.seg];
    let d = cubicDerivative(seg, loc.t);
    let n = Math.hypot(d.x, d.y);
    if (n < 1e-7) {
      // Zero derivative: fall back to a one-sided secant inside the segment so
      // glyphs still get a defined orientation. Reported to the caller as a
      // degraded sample via `degraded`.
      const eps = 1e-4;
      const t0 = Math.max(0, loc.t - eps), t1 = Math.min(1, loc.t + eps);
      const a = cubicPoint(seg, t0), b = cubicPoint(seg, t1);
      d = { x: b.x - a.x, y: b.y - a.y };
      n = Math.hypot(d.x, d.y);
      if (n < 1e-7) {
        // Fully degenerate point: use the next nonzero derivative nearby, else +x.
        const probe = nearestNonZeroTangent(seg, loc.t);
        return { ...probe, degraded: 'degenerate-derivative' };
      }
      return { x: d.x / n, y: d.y / n, degraded: 'zero-derivative-secant' };
    }
    return { x: d.x / n, y: d.y / n };
  }

  // Signed curvature (1/radius) with sign of the turn; Infinity is avoided by
  // capping at a large value, flagged so callers can apply fallback layout.
  curvatureAt(s) {
    const loc = this.locate(s);
    const seg = this.segments[loc.seg];
    const d1 = cubicDerivative(seg, loc.t);
    const d2 = cubicSecondDerivative(seg, loc.t);
    const n1 = Math.hypot(d1.x, d1.y);
    if (n1 < 1e-7) return { curvature: 0, degraded: 'zero-derivative' };
    const cross = d1.x * d2.y - d1.y * d2.x;
    const k = cross / (n1 * n1 * n1);
    const capped = Math.max(-1e4, Math.min(1e4, k));
    return { curvature: capped, degraded: Math.abs(capped) === 1e4 ? 'capped-curvature' : null };
  }

  // Polyline approximation for drawing; returns array of {x,y} per segment.
  polylines(tolerance = FLATTEN_TOL) {
    return this.segments.map((seg, i) => {
      const start = i === 0 ? seg.p0 : undefined;
      return flattenSegment(seg, start);
    });
  }

  toSVGPath() {
    const parts = [];
    this.segments.forEach((s, i) => {
      if (i === 0) parts.push(`M${fmt(s.p0.x)},${fmt(s.p0.y)}`);
      parts.push(`C${fmt(s.c1.x)},${fmt(s.c1.y)} ${fmt(s.c2.x)},${fmt(s.c2.y)} ${fmt(s.p1.x)},${fmt(s.p1.y)}`);
    });
    return parts.join(' ');
  }

  nodes() {
    const out = [];
    this.segments.forEach((s, i) => {
      if (i === 0) out.push({ ...s.p0, node: 0 });
      out.push({ ...s.p1, node: i + 1 });
    });
    return out;
  }

  // Reverse the path while preserving its geometry exactly.
  reversed() {
    const segs = this.segments.slice().reverse().map((s) => ({
      kind: s.kind,
      p0: { ...s.p1 },
      c1: { ...s.c2 },
      c2: { ...s.c1 },
      p1: { ...s.p0 },
      line: s.line,
    }));
    return new BezierPath(segs);
  }

  // Arc-length of a sub-interval [s0, s1].
  subLength(s0, s1) { return Math.abs(s1 - s0); }

  samplePoints(n) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(this.pointAt((this.length * i) / n));
    return pts;
  }
}

function nearestNonZeroTangent(seg, t) {
  for (const dt of [1e-3, 1e-2, 1e-1]) {
    for (const cand of [t - dt, t + dt]) {
      if (cand < 0 || cand > 1) continue;
      const d = cubicDerivative(seg, cand);
      const n = Math.hypot(d.x, d.y);
      if (n > 1e-6) return { x: d.x / n, y: d.y / n };
    }
  }
  return { x: 1, y: 0 };
}

// Stationary points of |B'(t)|^2 where the tangent direction is undefined or
// the speed reaches zero. Solved as a quadratic in t for each component and
// verified numerically. These are the declared cusp fallbacks.
export function findStationary(seg) {
  const pts = [];
  // |B'|^2 = at^4+bt^3+ct^2+dt+e, roots of derivative give speed extrema.
  const d0 = { x: seg.c1.x - seg.p0.x, y: seg.c1.y - seg.p0.y };
  const d1 = { x: seg.c2.x - seg.c1.x, y: seg.c2.y - seg.c1.y };
  const d2 = { x: seg.p1.x - seg.c2.x, y: seg.p1.y - seg.c2.y };
  // B'(t)/3 = A t^2 + B t + C
  const A = { x: d0.x - 2 * d1.x + d2.x, y: d0.y - 2 * d1.y + d2.y };
  const B = { x: 2 * (d1.x - d0.x), y: 2 * (d1.y - d0.y) };
  const C = { x: d0.x, y: d0.y };
  // speed^2/9 = |A|^2 t^4 + 2 A·B t^3 + (2 A·C + |B|^2) t^2 + 2 B·C t + |C|^2
  const coef = [
    A.x * A.x + A.y * A.y,
    2 * (A.x * B.x + A.y * B.y),
    2 * (A.x * C.x + A.y * C.y) + B.x * B.x + B.y * B.y,
    2 * (B.x * C.x + B.y * C.y),
    C.x * C.x + C.y * C.y,
  ];
  const roots = quarticRealRoots(coef).filter((t) => t > 1e-6 && t < 1 - 1e-6);
  for (const t of roots) {
    const sp = cubicSpeed(seg, t);
    if (sp < 1e-4) pts.push({ t, kind: 'cusp', speed: sp });
    else pts.push({ t, kind: 'speed-extremum', speed: sp });
  }
  return pts;
}

// Real roots of a quartic a t^4 + b t^3 + c t^2 + d t + e via companion
// polynomial bisection on the derivative of the speed polynomial is complex;
// instead we use a robust numeric scan + Newton on the quartic itself.
function quarticRealRoots([a, b, c, d, e]) {
  const f = (t) => ((a * t + b) * t + c) * t * t + d * t + e;
  const fp = (t) => ((4 * a * t + 3 * b) * t + 2 * c) * t + d;
  const roots = [];
  const N = 256;
  let prevT = 0, prevV = f(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    let v = f(t);
    if (prevV === 0) roots.push(prevT);
    else if (prevV * v < 0) {
      let lo = prevT, hi = t, flo = prevV;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
      }
      roots.push((lo + hi) / 2);
    }
    prevT = t; prevV = v;
  }
  // Polish with Newton and dedupe.
  const polished = [];
  for (const r of roots) {
    let t = r;
    for (let k = 0; k < 8; k++) {
      const g = fp(t);
      if (Math.abs(g) < 1e-12) break;
      const nt = t - f(t) / g;
      if (nt < -0.01 || nt > 1.01) break;
      t = nt;
    }
    if (t >= -1e-6 && t <= 1 + 1e-6 && !polished.some((p) => Math.abs(p - t) < 1e-5)) polished.push(t);
  }
  return polished.sort((x, y) => x - y);
}

export function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
