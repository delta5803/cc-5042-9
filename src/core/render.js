// Vector scene generation shared by the editor preview, the SVG exporter, and
// the CLI. Everything downstream of layout is real geometry: each glyph is a
// filled path whose outline comes from the font, transformed by its own
// tangent frame. Nothing is a bitmap warp or per-character rotation shortcut.

import { fmt } from '../geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the local clip quad for a glyph that crosses the path boundary.
// The clip is applied in the glyph's own baseline frame (local x = advance
// direction), which is the same frame the layout used to compute limits.
function clipPolygon(glyph, upem) {
  const { clip, matrix } = glyph;
  if (!clip) return null;
  const x0 = clip.x;
  const x1 = clip.x + clip.width;
  const y0 = -upem * 1.5;
  const y1 = upem * 1.5;
  const pt = (x, y) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
  return [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
}

function polyToPath(poly) {
  return 'M' + poly.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join('L') + 'Z';
}

export function buildScene(layout, path, opts = {}) {
  const o = {
    width: opts.width ?? 1280,
    height: opts.height ?? 760,
    background: opts.background ?? '#f0ebe1',
    color: opts.color ?? '#1d2430',
    showBaseline: opts.showBaseline ?? true,
    showTangents: opts.showTangents ?? true,
    showBoxes: opts.showBoxes ?? false,
    showNodes: opts.showNodes ?? false,
    showOutlines: opts.showOutlines ?? false,
    showAnchors: opts.showAnchors ?? false,
    showGuides: opts.showGuides ?? true,
    showClusterLabels: opts.showClusterLabels ?? false,
    showBoundaries: opts.showBoundaries ?? false,
    glyphAttrs: opts.glyphAttrs ?? false,
    includeGlyphs: opts.includeGlyphs ?? true,
    includeClipDefs: opts.includeClipDefs ?? true,
    upem: layout?.shaping?.upem ?? 1000,
    idPrefix: opts.idPrefix ?? 'ct',
    annotations: opts.annotations ?? false,
  };

  const defs = [];
  const body = [];

  if (o.includeGlyphs && layout?.ok) {
    const clipDefs = [];
    const clipGroups = [];
    const plain = [];

    for (const g of layout.glyphs) {
      const attrs = o.glyphAttrs
        ? ` data-cluster="${g.clusterIndex}" data-glyph="${g.glyphIndex}" data-gid="${g.gid}"`
        : '';
      if (g.clipped && g.clip && o.includeClipDefs) {
        const id = `${o.idPrefix}-clip-${g.glyphIndex}`;
        clipDefs.push(`<clipPath id="${id}"><path d="${polyToPath(clipPolygon(g, o.upem))}"/></clipPath>`);
        clipGroups.push(`<path${attrs} d="${g.outline}" fill="${o.color}" clip-path="url(#${id})"/>`);
      } else {
        plain.push(`<path${attrs} d="${g.outline}" fill="${o.color}"/>`);
      }
    }
    if (clipDefs.length) defs.push(...clipDefs);
    if (plain.length) body.push(`<g class="glyphs" id="${o.idPrefix}-glyphs">${plain.join('')}</g>`);
    if (clipGroups.length) body.push(`<g class="glyphs" id="${o.idPrefix}-glyphs-clipped">${clipGroups.join('')}</g>`);

    if (o.showOutlines) {
      const strokes = layout.glyphs.map((g) => `<path d="${g.outline}"/>`);
      body.push(`<g id="${o.idPrefix}-outlines" class="glyph-outline">${strokes.join('')}</g>`);
    }

    if (o.showBoxes) {
      const boxes = [];
      layout.clusters.forEach((c, i) => {
        if (c.arc === null || c.dropped) return;
        const hue = (i * 47) % 360;
        for (const gg of c.glyphs) {
          if (gg.glyphIndex == null) continue;
          const glyph = layout.glyphs.find((x) => x.glyphIndex === gg.glyphIndex);
          if (!glyph) continue;
          boxes.push(`<path class="advance-box" data-cluster="${i}" d="${polyToPath(advanceQuad(glyph, o.upem))}" fill="hsla(${hue},70%,55%,0.08)" stroke="hsla(${hue},65%,45%,0.65)"/>`);
        }
      });
      body.push(`<g id="${o.idPrefix}-boxes">${boxes.join('')}</g>`);
    }
  }

  if (layout?.ok && o.showGuides) {
    const tangents = [];
    const normals = [];
    if (o.showTangents) {
      for (const g of layout.glyphs) {
        if (g.attachedToBase) continue;
        const len = layout.shaping.fontSize * 0.22;
        tangents.push(`<line class="tangent" x1="${fmt(g.point.x)}" y1="${fmt(g.point.y)}" x2="${fmt(g.point.x + g.tangent.x * len)}" y2="${fmt(g.point.y + g.tangent.y * len)}"/>`);
        normals.push(`<line class="normal" x1="${fmt(g.point.x)}" y1="${fmt(g.point.y)}" x2="${fmt(g.point.x + g.normal.x * len * 0.7)}" y2="${fmt(g.point.y + g.normal.y * len * 0.7)}"/>`);
      }
    }
    if (tangents.length) {
      body.push(`<g id="${o.idPrefix}-tangents" class="tangents">${tangents.join('')}</g>`);
      body.push(`<g id="${o.idPrefix}-normals" class="normals">${normals.join('')}</g>`);
    }
  }

  if (path && o.showBaseline) {
    body.push(`<path id="${o.idPrefix}-baseline" class="baseline" d="${path.toSVGPath()}" fill="none" stroke="${o.annotations ? '#0b7285' : '#8f887b'}" stroke-width="${o.annotations ? 1.6 : 1.4}" stroke-dasharray="${o.annotations ? '' : '6 4'}"/>`);
    if (o.showAnchors) {
      const controls = [];
      path.segments.forEach((s) => {
        controls.push(`<path d="M${fmt(s.p0.x)},${fmt(s.p0.y)}L${fmt(s.c1.x)},${fmt(s.c1.y)}M${fmt(s.p1.x)},${fmt(s.p1.y)}L${fmt(s.c2.x)},${fmt(s.c2.y)}" stroke="#b6ad9c" stroke-width="0.9" stroke-dasharray="2 3"/>`);
        for (const c of [s.c1, s.c2]) controls.push(`<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="2.6" fill="#f2ede1" stroke="#8c8578"/>`);
      });
      const dots = path.nodes().map((n) => `<circle cx="${fmt(n.x)}" cy="${fmt(n.y)}" r="3.4" fill="#fffdf7" stroke="#d9480f" stroke-width="2"/>`).join('');
      body.push(`<g id="${o.idPrefix}-anchors">${controls.join('')}${dots}</g>`);
    }
  }

  if (o.showBoundaries && layout?.ok && layout.metrics?.overflows) {
    const marks = [];
    for (const [s, label] of [[0, 'path start'], [path.length, 'path end']]) {
      const p = path.pointAt(s);
      const t = path.tangentAt(s);
      const L = 26;
      const nx = t.y, ny = -t.x;
      marks.push(`<line class="boundary" x1="${fmt(p.x - nx * L)}" y1="${fmt(p.y - ny * L)}" x2="${fmt(p.x + nx * L)}" y2="${fmt(p.y + ny * L)}"/>`);
      marks.push(`<text class="boundary-label" x="${fmt(p.x + nx * 8 + 6)}" y="${fmt(p.y + ny * 8 - 6)}">${label}</text>`);
    }
    body.push(`<g id="${o.idPrefix}-boundaries">${marks.join('')}</g>`);
  }

  if (o.showClusterLabels && layout?.ok) {
    // Baseline-tangent ticks for every cluster, and numeric labels only for
    // every Nth cluster so the readout stays legible without hiding any.
    const marks = [];
    const every = Math.max(1, Math.ceil(layout.clusters.length / 12));
    let lastLabelY = -Infinity;
    layout.clusters.forEach((c, i) => {
      if (c.arc === null || c.dropped) return;
      const glyph = layout.glyphs.find((g) => g.clusterIndex === i);
      if (!glyph) return;
      const tick = 6;
      marks.push(`<line class="cluster-leader" x1="${fmt(glyph.point.x)}" y1="${fmt(glyph.point.y)}" x2="${fmt(glyph.point.x + glyph.normal.x * tick)}" y2="${fmt(glyph.point.y + glyph.normal.y * tick)}"/>`);
      if (i % every) return;
      const off = 20;
      const bx = glyph.point.x + glyph.normal.x * off + glyph.tangent.x * 3;
      const by = glyph.point.y + glyph.normal.y * off + glyph.tangent.y * 3;
      if (Math.abs(by - lastLabelY) < 11) return;
      lastLabelY = by;
      marks.push(`<line class="cluster-leader" x1="${fmt(glyph.point.x + glyph.normal.x * tick)}" y1="${fmt(glyph.point.y + glyph.normal.y * tick)}" x2="${fmt(bx)}" y2="${fmt(by)}"/>`);
      marks.push(`<circle cx="${fmt(glyph.point.x)}" cy="${fmt(glyph.point.y)}" r="1.5" fill="#0b7285"/>`);
      marks.push(`<text class="cluster-badge" x="${fmt(bx + 2)}" y="${fmt(by - 2)}">#${i} ${glyph.angleDeg.toFixed(0)}°</text>`);
    });
    body.push(`<g id="${o.idPrefix}-cluster-labels">${marks.join('')}</g>`);
  }

  if (o.annotations && layout?.ok) {
    // Baseline-direction arrows at regular intervals plus arc labels.
    const arrows = [];
    const step = Math.max(1, Math.floor(layout.glyphs.length / 10));
    layout.glyphs.forEach((g, i) => {
      if (i % step) return;
      if (g.attachedToBase) return;
      const len = 34;
      const tipX = g.point.x + g.tangent.x * len;
      const tipY = g.point.y + g.tangent.y * len;
      const leftX = tipX - g.tangent.x * 9 + g.normal.x * 4;
      const leftY = tipY - g.tangent.y * 9 + g.normal.y * 4;
      const rightX = tipX - g.tangent.x * 9 - g.normal.x * 4;
      const rightY = tipY - g.tangent.y * 9 - g.normal.y * 4;
      arrows.push(`<path d="M${fmt(g.point.x)},${fmt(g.point.y)}L${fmt(tipX)},${fmt(tipY)}M${fmt(tipX)},${fmt(tipY)}L${fmt(leftX)},${fmt(leftY)}M${fmt(tipX)},${fmt(tipY)}L${fmt(rightX)},${fmt(rightY)}" stroke="#0b7285" stroke-width="1.4" fill="none" opacity="0.75"/>`);
      arrows.push(`<text x="${fmt(tipX + g.normal.x * 12)}" y="${fmt(tipY + g.normal.y * 12)}" font-family="ui-monospace, monospace" font-size="9" fill="#0b7285">${fmt(g.arc)}px · ${g.angleDeg.toFixed(1)}°</text>`);
    });
    if (arrows.length) body.push(`<g id="${o.idPrefix}-annotation-arrows">${arrows.join('')}</g>`);
  }

  return { defs, body, options: o };
}

function advanceQuad(glyph, upem) {
  const { matrix } = glyph;
  const x0 = 0, x1 = glyph.advanceFontUnits;
  const y0 = -upem * 0.55, y1 = upem * 0.12;
  const pt = (x, y) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
  return [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
}

export function sceneToSVGString(scene, title = 'Curved text') {
  const { defs, body, options } = scene;
  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : '';
  return [
    `<svg xmlns="${SVG_NS}" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    defsBlock,
    `<rect width="100%" height="100%" fill="${options.background}"/>`,
    body.join('\n'),
    '</svg>',
  ].join('\n');
}

// Rasterize a scene's glyphs through a Canvas2D-like interface. The browser
// preview uses the SVG directly; the CLI supplies @napi-rs/canvas.
export function drawSceneToCanvas(ctx, layout, path, opts = {}) {
  const o = {
    width: opts.width ?? 1280,
    height: opts.height ?? 760,
    background: opts.background ?? '#f0ebe1',
    color: opts.color ?? '#1d2430',
    showBaseline: opts.showBaseline ?? true,
    showTangents: opts.showTangents ?? true,
    showBoxes: opts.showBoxes ?? false,
    showNodes: opts.showNodes ?? false,
    path2d: opts.path2d,
  };
  if (!o.path2d) throw new Error('drawSceneToCanvas requires a Path2D implementation');
  const Path2DImpl = o.path2d;
  ctx.save();
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, o.width, o.height);

  if (layout?.ok) {
    for (const g of layout.glyphs) {
      const p = new Path2DImpl(g.outline);
      ctx.save();
      if (g.clip) {
        const poly = clipPolygon(g, layout.shaping.upem);
        ctx.beginPath();
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.clip();
      }
      ctx.fillStyle = o.color;
      ctx.fill(p, 'nonzero');
      ctx.restore();
    }
    if (o.showBoxes) {
      layout.clusters.forEach((c, i) => {
        c.glyphs.forEach((gg) => {
          if (gg.glyphIndex == null) return;
          const glyph = layout.glyphs.find((x) => x.glyphIndex === gg.glyphIndex);
          if (!glyph) return;
          const poly = advanceQuad(glyph, layout.shaping.upem);
          ctx.beginPath();
          poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.fillStyle = `hsla(${(i * 47) % 360}, 70%, 55%, 0.08)`;
          ctx.fill();
          ctx.strokeStyle = `hsla(${(i * 47) % 360}, 65%, 45%, 0.65)`;
          ctx.lineWidth = 1;
          ctx.stroke();
        });
      });
    }
    if (o.showTangents) {
      ctx.strokeStyle = '#d9480f';
      ctx.lineWidth = 1.1;
      for (const g of layout.glyphs) {
        if (g.attachedToBase) continue;
        const len = layout.shaping.fontSize * 0.22;
        ctx.beginPath();
        ctx.moveTo(g.point.x, g.point.y);
        ctx.lineTo(g.point.x + g.tangent.x * len, g.point.y + g.tangent.y * len);
        ctx.stroke();
        ctx.save();
        ctx.strokeStyle = '#2b8a3e';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(g.point.x, g.point.y);
        ctx.lineTo(g.point.x + g.normal.x * len * 0.7, g.point.y + g.normal.y * len * 0.7);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  if (path && o.showBaseline) {
    const p = new Path2DImpl(path.toSVGPath());
    ctx.save();
    ctx.strokeStyle = '#8b8377';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.stroke(p);
    ctx.restore();
    if (o.showNodes) {
      ctx.fillStyle = '#0b7285';
      for (const n of path.nodes()) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
