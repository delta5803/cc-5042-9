// Path editing operations on the serializable node/control representation:
//   { nodes: [[x,y], ...], controls: [{c1:[x,y], c2:[x,y]}, ...] }
// Segment i runs from nodes[i] to nodes[i+1] with controls[i].
// Every operation returns fresh arrays so undo/serialization stay simple.

import { cubicPoint, dist } from '../geometry.js';

export function clonePathParams(p) {
  return {
    nodes: p.nodes.map(([x, y]) => [x, y]),
    controls: p.controls.map((c) => ({ c1: [c.c1[0], c.c1[1]], c2: [c.c2[0], c.c2[1]] })),
  };
}

export function segmentCount(p) { return p.nodes.length - 1; }

export function moveNode(p, index, x, y) {
  const out = clonePathParams(p);
  const dx = x - out.nodes[index][0];
  const dy = y - out.nodes[index][1];
  out.nodes[index] = [x, y];
  // Translate the two adjoining control points so neighbouring curves keep
  // their shape where they meet this node.
  if (index > 0) {
    const c = out.controls[index - 1].c2;
    out.controls[index - 1].c2 = [c[0] + dx, c[1] + dy];
  }
  if (index < out.controls.length) {
    const c = out.controls[index].c1;
    out.controls[index].c1 = [c[0] + dx, c[1] + dy];
  }
  return out;
}

export function moveControl(p, segIndex, which, x, y) {
  const out = clonePathParams(p);
  out.controls[segIndex][which] = [x, y];
  return out;
}

export function reversePathParams(p) {
  const n = p.nodes.length;
  const out = { nodes: [], controls: [] };
  for (let i = n - 1; i >= 0; i--) out.nodes.push([...p.nodes[i]]);
  for (let i = n - 2; i >= 0; i--) {
    // Segment i' in the reversed path corresponds to old segment i.
    out.controls.push({ c1: [...p.controls[i].c2], c2: [...p.controls[i].c1] });
  }
  return out;
}

// Remove a node. Interior nodes merge their two adjacent segments into one
// cubic using the outer control points; this is a declared approximation and
// is only used by explicit user edits.
export function deleteNode(p, index) {
  if (p.nodes.length <= 2) return clonePathParams(p);
  const out = clonePathParams(p);
  out.nodes.splice(index, 1);
  if (index === 0) {
    out.controls.splice(0, 1);
  } else if (index === out.nodes.length) {
    // index was the last node
    out.controls.splice(out.controls.length - 1, 1);
  } else {
    const left = out.controls[index - 1];
    const right = out.controls[index];
    out.controls.splice(index - 1, 2, { c1: [...left.c1], c2: [...right.c2] });
  }
  return out;
}

// De Casteljau split of segment i at t, inserting one new node.
export function splitSegment(p, segIndex, t) {
  const out = clonePathParams(p);
  const a = out.nodes[segIndex];
  const b = out.nodes[segIndex + 1];
  const c = out.controls[segIndex];
  const p0 = { x: a[0], y: a[1] };
  const c1 = { x: c.c1[0], y: c.c1[1] };
  const c2 = { x: c.c2[0], y: c.c2[1] };
  const p1 = { x: b[0], y: b[1] };

  const lerp = (u, v, k) => ({ x: u.x + (v.x - u.x) * k, y: u.y + (v.y - u.y) * k });
  const ab = lerp(p0, c1, t);
  const bc = lerp(c1, c2, t);
  const cd = lerp(c2, p1, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const mid = lerp(abc, bcd, t);

  out.nodes.splice(segIndex + 1, 0, [mid.x, mid.y]);
  out.controls.splice(segIndex, 1,
    { c1: [ab.x, ab.y], c2: [abc.x, abc.y] },
    { c1: [bcd.x, bcd.y], c2: [cd.x, cd.y] },
  );
  return out;
}

// Nearest point on the path to a document-space point, by dense sampling.
// Returns {segment, t, point, distance, arc}.
export function nearestOnPath(path, point, samplesPerSegment = 64) {
  let best = null;
  path.segments.forEach((seg, i) => {
    let prevT = 0;
    for (let k = 1; k <= samplesPerSegment; k++) {
      const t = k / samplesPerSegment;
      const pt = cubicPoint(seg, t);
      // Project onto the dense chord so the estimate is sub-sample accurate.
      const prevPt = cubicPoint(seg, prevT);
      const proj = projectOnSegment(point, prevPt, pt);
      const d = dist(point, proj.point);
      if (!best || d < best.distance) {
        const tt = prevT + (t - prevT) * proj.u;
        const exact = cubicPoint(seg, tt);
        const arc = path.starts[i] + localArc(path.tables[i], tt);
        best = { segment: i, t: tt, point: exact, distance: dist(point, exact), arc };
      }
      prevT = t;
    }
  });
  return best;
}

function projectOnSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const denom = abx * abx + aby * aby;
  const u = denom < 1e-12 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
  const cu = Math.max(0, Math.min(1, u));
  return { u: cu, point: { x: a.x + abx * cu, y: a.y + aby * cu } };
}

function localArc(table, t) {
  const { params, cum } = table;
  if (t <= 0) return 0;
  if (t >= 1) return table.length;
  let lo = 0, hi = params.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (params[mid] <= t) lo = mid; else hi = mid;
  }
  const span = params[hi] - params[lo];
  const f = span < 1e-12 ? 0 : (t - params[lo]) / span;
  return cum[lo] + (cum[hi] - cum[lo]) * f;
}

export function insertNodeAtPoint(p, path, point) {
  const near = nearestOnPath(path, point);
  if (!near) return { path: clonePathParams(p), inserted: false };
  return { path: splitSegment(p, near.segment, near.t), inserted: true, arc: near.arc, segment: near.segment, t: near.t };
}
