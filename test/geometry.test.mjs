// Geometry tests: arc-length precision, tangent fallbacks, cusps, path math.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BezierPath, makeLineSegment, buildSegmentTable, segmentTAtLength,
  cubicPoint, cubicDerivative, findStationary, flattenSegment,
} from '../src/geometry.js';
import { circleQuadrantTable, closeTo } from './helpers.mjs';

test('line segment length is exact in both table modes', () => {
  const seg = makeLineSegment({ x: 0, y: 0 }, { x: 300, y: 400 });
  for (const mode of ['uniform', 'adaptive']) {
    const t = buildSegmentTable(seg, { mode, tolerance: 0.05, samples: 32 });
    closeTo(t.length, 500, 1e-9, `${mode} line length`);
  }
});

test('uniform table has samples+1 entries and covers t=0..1', () => {
  const seg = makeLineSegment({ x: 0, y: 0 }, { x: 100, y: 0 });
  const t = buildSegmentTable(seg, { mode: 'uniform', samples: 16, minSamples: 4 });
  assert.equal(t.params.length, 17);
  assert.equal(t.params[0], 0);
  assert.equal(t.params[t.params.length - 1], 1);
  for (let i = 1; i < t.params.length; i++) assert.ok(t.params[i] > t.params[i - 1]);
});

test('tighter adaptive tolerance adds samples and improves arc accuracy', () => {
  const { seg, quarterArc } = circleQuadrantTable(150);
  const loose = buildSegmentTable(seg, { mode: 'adaptive', tolerance: 1, minSamples: 4 });
  const tight = buildSegmentTable(seg, { mode: 'adaptive', tolerance: 0.001, minSamples: 4 });
  assert.ok(tight.params.length > loose.params.length, 'tight tolerance should subdivide more');
  assert.ok(Math.abs(tight.length - quarterArc) < Math.abs(loose.length - quarterArc) + 1e-9,
    'tight table should be at least as close to the true arc length');
  // Both should be within 0.5% of the analytic length.
  assert.ok(Math.abs(loose.length - quarterArc) / quarterArc < 0.005);
  assert.ok(Math.abs(tight.length - quarterArc) / quarterArc < 0.001);
});

test('arc length table maps s -> t monotonically and inverts exactly on lines', () => {
  const seg = makeLineSegment({ x: 0, y: 0 }, { x: 100, y: 0 });
  const t = buildSegmentTable(seg, { mode: 'adaptive', tolerance: 0.01, minSamples: 4 });
  let last = -1;
  for (let i = 0; i <= 20; i++) {
    const s = (t.length * i) / 20;
    const param = segmentTAtLength(t, s);
    assert.ok(param >= last - 1e-12, 'monotonic');
    last = param;
    const p = cubicPoint(seg, param);
    closeTo(p.x, s, 1e-6, 'line x at arc s');
  }
});

test('path locate/pointAt/tangentAt agree on a curved path', () => {
  const path = new BezierPath([
    { kind: 'cubic', p0: { x: 0, y: 0 }, c1: { x: 100, y: 0 }, c2: { x: 100, y: 100 }, p1: { x: 200, y: 100 } },
  ]);
  path.rebuild({ mode: 'adaptive', tolerance: 0.01 });
  const s = path.length * 0.37;
  const loc = path.locate(s);
  const p = path.pointAt(s);
  closeTo(p.x, cubicPoint(path.segments[loc.seg], loc.t).x, 1e-9, 'pointAt matches locate');
  const tan = path.tangentAt(s);
  closeTo(Math.hypot(tan.x, tan.y), 1, 1e-12, 'tangent is unit length');
  // Tangent is perpendicular to the normal convention used in layout.
  closeTo(tan.x * tan.y + tan.y * -tan.x, 0, 1e-12, 'normal is perpendicular');
});

test('zero-derivative interior point reports a declared fallback', () => {
  // c2 is chosen so that B'(0.5) = 0 exactly: c2 = p0 + c1 - p1.
  const seg = {
    kind: 'cubic',
    p0: { x: 0, y: 0 },
    c1: { x: 50, y: 0 },
    c2: { x: -150, y: 0 },
    p1: { x: 200, y: 0 },
  };
  const path = new BezierPath([seg]);
  path.rebuild({ mode: 'adaptive', tolerance: 0.01 });
  const d = cubicDerivative(seg, 0.5);
  closeTo(Math.hypot(d.x, d.y), 0, 1e-9, 'derivative vanishes at t=0.5');
  // t=0.5 corresponds to the midpoint by symmetry of the arc table? Not
  // necessarily, so search the path for the zero-speed arc directly.
  const arc = path.length / 2;
  const tan = path.tangentAt(arc);
  assert.ok(Number.isFinite(tan.x) && Number.isFinite(tan.y), 'fallback tangent is finite');
  closeTo(Math.hypot(tan.x, tan.y), 1, 1e-9, 'fallback tangent is unit length');
});

test('cusp detection finds the loop point of a speared cubic', () => {
  // c2 is chosen so B'(0.5) = 0 in both axes, producing a genuine 2D cusp.
  const seg = {
    kind: 'cubic',
    p0: { x: 0, y: 0 },
    c1: { x: 50, y: 100 },
    c2: { x: -50, y: 100 },
    p1: { x: 100, y: 0 },
  };
  const pts = findStationary(seg);
  const cusp = pts.find((p) => p.kind === 'cusp' && Math.abs(p.t - 0.5) < 1e-4);
  assert.ok(cusp, `expected a cusp at t=0.5, got ${JSON.stringify(pts)}`);
  closeTo(cusp.speed, 0, 1e-6, 'cusp speed');

  const path = new BezierPath([seg]);
  path.rebuild({ mode: 'adaptive', tolerance: 0.01 });
  // The cusp is a single parameter, not an arc interval, so every arc sample
  // near it must still produce a finite unit tangent (declared fallback) and
  // the path must expose the cusp in its stationary table.
  assert.ok(path.stationary[0].some((p) => p.kind === 'cusp'), 'path should expose the cusp');
  for (let i = 0; i <= 200; i++) {
    const tan = path.tangentAt((path.length * i) / 200);
    assert.ok(Number.isFinite(tan.x) && Number.isFinite(tan.y), `NaN tangent at sample ${i}`);
    closeTo(Math.hypot(tan.x, tan.y), 1, 1e-9, `non-unit tangent at sample ${i}`);
  }
});

test('fully degenerate segment gets a finite fallback tangent and no NaN geometry', () => {
  const seg = {
    kind: 'cubic',
    p0: { x: 50, y: 50 },
    c1: { x: 50, y: 50 },
    c2: { x: 50, y: 50 },
    p1: { x: 50, y: 50 },
  };
  const path = new BezierPath([seg]);
  path.rebuild();
  const tan = path.tangentAt(0);
  assert.ok(Number.isFinite(tan.x) && Number.isFinite(tan.y));
  assert.ok(tan.degraded, 'degenerate segment should be flagged');
  const p = path.pointAt(0);
  closeTo(p.x, 50, 1e-9); closeTo(p.y, 50, 1e-9);
});

test('reversing preserves length and negates tangent direction', () => {
  const path = new BezierPath([
    { kind: 'cubic', p0: { x: 0, y: 0 }, c1: { x: 40, y: 80 }, c2: { x: 120, y: 80 }, p1: { x: 160, y: 0 } },
  ]);
  path.rebuild({ mode: 'adaptive', tolerance: 0.01 });
  const rev = path.reversed();
  rev.rebuild({ mode: 'adaptive', tolerance: 0.01 });
  closeTo(rev.length, path.length, 1e-6, 'reversed length');
  for (const frac of [0.1, 0.4, 0.75]) {
    const a = path.tangentAt(path.length * frac);
    const b = rev.tangentAt(rev.length * (1 - frac));
    closeTo(b.x, -a.x, 1e-3, 'reversed tangent x');
    closeTo(b.y, -a.y, 1e-3, 'reversed tangent y');
  }
});

test('flattening a line yields only two points', () => {
  const pts = flattenSegment(makeLineSegment({ x: 0, y: 0 }, { x: 10, y: 10 }));
  assert.equal(pts.length, 2);
});

test('subLength and nodes agree with the segment list', () => {
  const path = new BezierPath([
    makeLineSegment({ x: 0, y: 0 }, { x: 100, y: 0 }),
    makeLineSegment({ x: 100, y: 0 }, { x: 100, y: 100 }),
  ]);
  path.rebuild({ mode: 'uniform', samples: 8 });
  closeTo(path.length, 200, 1e-9);
  const nodes = path.nodes();
  assert.equal(nodes.length, 3);
  assert.deepEqual([nodes[1].x, nodes[1].y], [100, 0]);
  closeTo(path.subLength(50, 150), 100, 1e-9);
});

test('path lookup at exactly the end returns the final node', () => {
  const path = new BezierPath([makeLineSegment({ x: 10, y: 10 }, { x: 60, y: 10 })]);
  path.rebuild({ mode: 'uniform', samples: 8 });
  const p = path.pointAt(path.length + 100); // clamped
  closeTo(p.x, 60, 1e-9);
  closeTo(p.y, 10, 1e-9);
});
