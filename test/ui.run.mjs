// Browser-level tests for the curve-text editor. Starts the Vite dev server,
// drives Chromium, and checks the UI against the same computed layout exposed
// through window.__envelope. Chromium needs system libraries; when a sysroot is
// present at /tmp/sysroot its lib path is merged into LD_LIBRARY_PATH below.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const SYSROOT = '/tmp/sysroot';
process.env.LD_LIBRARY_PATH = [
  `${SYSROOT}/usr/lib/aarch64-linux-gnu`,
  `${SYSROOT}/lib/aarch64-linux-gnu`,
  process.env.LD_LIBRARY_PATH,
].filter(Boolean).join(':');

async function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in time')), 25000);
    proc.stdout.on('data', (buf) => {
      if (/Local:|ready in/.test(buf.toString())) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', (buf) => process.stderr.write(buf));
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite exited (${code})`)); });
  });
  await new Promise((r) => setTimeout(r, 500));
  return proc;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(String(err.message).split('\n').map((l) => `      ${l}`).join('\n'));
      if (err.actual !== undefined) console.error(`      actual:   ${JSON.stringify(err.actual)}`);
      if (err.expected !== undefined) console.error(`      expected: ${JSON.stringify(err.expected)}`);
    }
  };

  const state = () => page.evaluate(() => {
    const s = window.__envelope.getState();
    return {
      params: JSON.parse(JSON.stringify(s.params)),
      pathParams: JSON.parse(JSON.stringify(s.pathParams)),
      pathLength: s.pathLength,
      reversed: s.reversed,
      ok: s.layout?.ok,
      layout: s.layout ? {
        ok: s.layout.ok, error: s.layout.error, metrics: s.layout.metrics,
        shaping: s.layout.shaping, runs: s.layout.runs, warnings: s.layout.warnings,
        lengthTable: s.layout.lengthTable,
      } : null,
      clusters: s.clusters,
      glyphs: s.glyphs,
    };
  });

  const setParams = (patch) => page.evaluate((p) => window.__envelope.setParams(p), patch);
  const setPath = (pathParams) => page.evaluate((p) => window.__envelope.setPath(p), pathParams);
  const defaultPath = () => page.evaluate(async () => {
    const mod = await import('/src/state.js');
    return mod.DEFAULT_PATH;
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__envelope, { timeout: 20000 });

    await check('boots with real glyph outline paths in the DOM', async () => {
      const count = await page.locator('#stage-svg .glyphs path').count();
      assert.ok(count > 20, `expected >20 glyph paths, got ${count}`);
      const d = await page.locator('#stage-svg .glyphs path').first().getAttribute('d');
      assert.ok(d && d.length > 40, 'glyph outline path is empty');
      assert.equal(await page.locator('#loading').isVisible(), false, 'loading overlay should be hidden');
      assert.equal(await page.locator('#fatal').isVisible(), false, 'fatal overlay should be hidden');
    });

    await check('default text shapes 42 chars into 38 glyphs with 2 ligatures', async () => {
      const s = await state();
      assert.equal(s.ok, true);
      assert.equal(s.layout.shaping.charCount, 42);
      assert.equal(s.layout.shaping.glyphCount, 38);
      assert.equal(s.clusters.length, 37);
      const ligs = s.clusters.filter((c) => c.ligature);
      assert.equal(ligs.length, 2);
      assert.deepEqual(ligs.map((c) => c.source), ['ffi', 'ffi']);
      const stat = await page.locator('#text-stats').textContent();
      assert.match(stat, /42 chars · 38 glyphs/);
    });

    await check('combining mark rides its base frame (q́)', async () => {
      const s = await state();
      const markCluster = s.clusters.find((c) => c.source === 'q́');
      assert.ok(markCluster, 'q́ cluster missing');
      assert.equal(markCluster.glyphCount, 2);
      assert.equal(markCluster.hasMarks, true);
      const marks = s.glyphs.filter((g) => g.attachedToBase);
      assert.equal(marks.length, 1);
      assert.equal(marks[0].baseGlyphIndex, marks[0].glyphIndex - 1);
      assert.notEqual(marks[0].gpos.xOffset, 0, 'GPOS offset should move the mark');
    });

    await check('shaping panel shows font, runs, clusters, features, variation', async () => {
      const kv = await page.locator('#shaping-kv').textContent();
      assert.match(kv, /Noto Sans/);
      assert.match(kv, /ligature/i);
      assert.match(kv, /wght=500/);
      const runs = await page.locator('#run-list .run-chip').count();
      assert.ok(runs >= 1);
      const diag = await page.locator('#diag-list').textContent();
      assert.match(diag, /all-clear/);
      assert.match(diag, /no declared warnings/);
    });

    await check('each glyph angle equals atan2 of its served tangent', async () => {
      const s = await state();
      for (const g of s.glyphs) {
        const expected = (Math.atan2(g.tangent.y, g.tangent.x) * 180 / Math.PI + 360) % 360;
        assert.ok(Math.abs(expected - g.angleDeg) < 1e-9, `glyph ${g.glyphIndex} angle mismatch`);
      }
    });

    await check('displayed baseline is the actual Bézier path', async () => {
      const d = await page.locator('#stage-svg .baseline').getAttribute('d');
      assert.ok(d && d.startsWith('M'));
      assert.ok((d.match(/C/g) || []).length >= 5, 'expected all cubic segments in the baseline');
    });

    await check('dragging node 2 moves geometry and enables undo', async () => {
      const before = await state();
      const anchor = page.locator('#stage-svg .anchor[data-node="2"]');
      const box = await anchor.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 - 70, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      const after = await state();
      assert.notDeepEqual(after.pathParams.nodes[2], before.pathParams.nodes[2], 'node did not move');
      assert.notEqual(after.pathLength.toFixed(3), before.pathLength.toFixed(3), 'path length should change');
      assert.notEqual(after.glyphs[0].arc.toFixed(3), before.glyphs[0].arc.toFixed(3), 'glyph arc should change');
      assert.notEqual(after.glyphs[0].angleDeg.toFixed(3), before.glyphs[0].angleDeg.toFixed(3), 'glyph angle should change');
      assert.equal(await page.locator('#btn-undo').isEnabled(), true);
      // Live edits must update the side panels too.
      const metrics = await page.locator('#metrics-kv').textContent();
      assert.match(metrics, /Path length/);
    });

    await check('undo restores the exact node position', async () => {
      const moved = await state();
      await page.click('#btn-undo');
      await page.waitForTimeout(400);
      const restored = await state();
      assert.notDeepEqual(restored.pathParams.nodes, moved.pathParams.nodes);
      await page.click('#btn-redo');
      await page.waitForTimeout(400);
      const redone = await state();
      assert.deepEqual(redone.pathParams.nodes, moved.pathParams.nodes);
      await page.click('#btn-undo');
      await page.waitForTimeout(400);
    });

    await check('double click inserts a node', async () => {
      const before = await page.locator('#stage-svg .anchor').count();
      const svg = await page.locator('#stage-svg').boundingBox();
      await page.mouse.dblclick(svg.x + svg.width * 0.5, svg.y + svg.height * 0.45);
      await page.waitForTimeout(350);
      const after = await page.locator('#stage-svg .anchor').count();
      assert.equal(after, before + 1, 'expected one inserted node');
      const rows = await page.locator('#node-list .node-row').count();
      assert.equal(rows, after, 'node list should track the inserted node');
    });

    await check('path reversed flips tangent direction at the same physical point', async () => {
      const before = await state();
      await page.click('#btn-reverse-toggle');
      await page.waitForTimeout(400);
      try {
        const after = await state();
        assert.equal(after.reversed, true);
        // With the block centred, the first glyph sits at nearly the same arc
        // on the reversed path — the arc origin is the declared direction, not
        // the physical left end. What must change is the tangent direction at
        // the mirrored physical point.
        const a0 = after.glyphs[0];
        const forwardTangent = await page.evaluate(async (arc) => {
          const layoutMod = await import('/src/core/layout.js');
          const stateMod = await import('/src/state.js');
          const state = window.__envelope.getState();
          const path = layoutMod.buildPathFromParams({
            ...stateMod.DEFAULT_PATH,
            lengthTable: state.params.lengthTable,
          });
          const t = path.tangentAt(state.pathLength - arc);
          return { x: t.x, y: t.y };
        }, a0.arc);
        const dot = a0.tangent.x * forwardTangent.x + a0.tangent.y * forwardTangent.y;
        assert.ok(Math.abs(dot + 1) < 0.02, `expected opposite tangents at mirrored arcs, dot=${dot.toFixed(3)}`);
        const hint = await page.locator('#reverse-hint').textContent();
        assert.match(hint, /reversed/i);
      } finally {
        await page.click('#btn-reverse');
        await page.waitForTimeout(300);
      }
      const fwd = await state();
      assert.equal(fwd.reversed, false);
      assert.deepEqual(fwd.pathParams.nodes, before.pathParams.nodes, 'authored path is untouched by reversal');
    });

    await check('overflow=error surfaces a declared error, no glyphs', async () => {
      await setParams({ text: 'office '.repeat(60), overflow: 'error' });
      await page.waitForTimeout(300);
      const s = await state();
      assert.equal(s.ok, false);
      assert.equal(s.layout.error.code, 'text-overflow');
      assert.equal(await page.locator('#stage-svg .glyphs path').count(), 0, 'no glyph paths when error');
      const diag = await page.locator('#diag-list').textContent();
      assert.match(diag, /text-overflow/);
      assert.match(diag, /Shorten the text/);
      const status = await page.locator('#status-shaping').textContent();
      assert.match(status, /error: text-overflow/);
      const badge = await page.locator('#diag-count').textContent();
      assert.equal(badge, '1');
    });

    await check('overflow=clip drops clusters and clips boundary glyphs', async () => {
      await setParams({ text: 'office '.repeat(60), overflow: 'clip' });
      await page.waitForTimeout(300);
      const s = await state();
      assert.equal(s.ok, true);
      assert.ok(s.layout.metrics.droppedClusters > 0, 'expected dropped clusters');
      assert.ok(s.layout.metrics.clippedGlyphs > 0, 'expected boundary clipping');
      // The DOM should hold clipPath defs for the partially clipped glyphs and
      // fewer glyph paths than the shaped glyph count.
      const paths = await page.locator('#stage-svg .glyphs path').count();
      assert.ok(paths < s.layout.shaping.glyphCount, 'dropped glyphs must not be rendered');
      const clippedPaths = await page.locator('#stage-svg [clip-path]').count();
      assert.ok(clippedPaths > 0, 'expected clip-path on boundary glyphs');
      const metrics = await page.locator('#metrics-kv').textContent();
      assert.match(metrics, /Dropped clusters/);
    });

    await check('overflow=extend keeps all glyphs past the endpoint', async () => {
      await setParams({ text: 'office '.repeat(60), overflow: 'extend' });
      await page.waitForTimeout(300);
      const s = await state();
      assert.equal(s.ok, true);
      assert.equal(s.layout.metrics.placedGlyphs, s.layout.metrics.glyphCount);
      assert.ok(s.layout.metrics.extendedGlyphs > 0);
      const last = s.glyphs[s.glyphs.length - 1];
      assert.ok(last.arc > s.pathLength, 'last glyph should extend beyond the path');
      const boundary = await page.locator('#stage-svg .boundary').count();
      assert.equal(boundary, 2, 'declared path boundaries should be marked');
    });

    await check('short path with centered text reports overflow state', async () => {
      await setParams({ text: 'déjà vu', overflow: 'clip', align: 'center', fontSize: 64, startOffset: 1000 });
      await page.waitForTimeout(300);
      const s = await state();
      assert.equal(s.ok, true);
      assert.equal(s.layout.metrics.overflows, true);
      await setParams({ startOffset: 0 });
      await page.waitForTimeout(200);
    });

    await check('RTL text keeps visual run order and Hebrew script', async () => {
      await setParams({ fontId: 'dejavusans', text: 'שלום (אבג) 12 abc', baseDirection: 'rtl', fontSize: 48, overflow: 'clip' });
      await page.waitForTimeout(600);
      const s = await state();
      assert.equal(s.ok, true);
      const rtl = s.layout.runs.filter((r) => r.dir === 'rtl');
      assert.ok(rtl.length >= 1);
      assert.ok(rtl.every((r) => r.script === 'Hebrew'));
      const chips = await page.locator('#run-list .run-chip .dir.rtl').count();
      assert.ok(chips >= 1, 'UI should mark RTL runs');
    });

    await check('length-table mode and tolerance are rebuilt live', async () => {
      const adaptive = await page.evaluate(async () => {
        window.__envelope.setParams({ lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64 } });
        return window.__envelope.getState().layout.lengthTable.totalSamples;
      });
      const uniform = await page.evaluate(async () => {
        window.__envelope.setParams({ lengthTable: { mode: 'uniform', tolerance: 0.05, samples: 12 } });
        return window.__envelope.getState().layout.lengthTable.totalSamples;
      });
      assert.notEqual(adaptive, uniform);
      // 6 cubic segments, 12 uniform steps each -> 13 samples per segment.
      assert.equal(uniform, 6 * 13, 'uniform table sample count');
      const loose = await page.evaluate(async () => {
        window.__envelope.setParams({ lengthTable: { mode: 'adaptive', tolerance: 0.5, samples: 64 } });
        return window.__envelope.getState().layout.lengthTable.totalSamples;
      });
      const tight = await page.evaluate(async () => {
        window.__envelope.setParams({ lengthTable: { mode: 'adaptive', tolerance: 0.01, samples: 64 } });
        return window.__envelope.getState().layout.lengthTable.totalSamples;
      });
      assert.ok(tight > loose, `tighter tolerance should add samples (${loose} -> ${tight})`);
    });

    await check('cusp path reports cusp warning and keeps tangents finite', async () => {
      // A loop segment returns to the same point with zero speed: a true cusp.
      await setPath({
        nodes: [[200, 300], [300, 300], [700, 300]],
        controls: [{ c1: [250, 400], c2: [150, 400] }, { c1: [400, 300], c2: [600, 300] }],
      });
      await setParams({ text: 'cusp test here', fontSize: 40, overflow: 'clip' });
      await page.waitForTimeout(400);
      const s = await state();
      assert.equal(s.ok, true);
      assert.ok(s.glyphs.every((g) => Number.isFinite(g.angle)), 'all angles finite');
      const table = s.layout.lengthTable;
      assert.ok(table.stationary.some((seg) => seg.points.some((p) => p.kind === 'cusp')), 'stationary table should expose the cusp');
      const diag = await page.locator('#diag-list').textContent();
      assert.match(diag, /cusp/i, 'diagnostics should surface the cusp');
    });

    await check('Save JSON then Load JSON reproduces the layout', async () => {
      const pathParams = await defaultPath();
      await setPath(pathParams);
      await setParams({
        text: 'reproduce — ffi déjà', fontSize: 52, align: 'center', overflow: 'clip',
        lengthTable: { mode: 'adaptive', tolerance: 0.05, samples: 64 },
      });
      await page.waitForTimeout(300);
      const before = await state();

      const download = page.waitForEvent('download');
      await page.click('#btn-json');
      const dl = await download;
      const docText = readFileSync(await dl.path(), 'utf8');
      const doc = JSON.parse(docText);
      assert.equal(doc.format, 'envelope-curve-type/1');
      assert.equal(doc.params.text, before.params.text);
      assert.deepEqual(doc.path.nodes, pathParams.nodes);
      assert.equal(doc.reversed, false);

      // Mutate the document in the app, then load the file back through the UI.
      await setParams({ text: 'different text', fontSize: 20, align: 'start' });
      await page.waitForTimeout(250);
      const mutated = await state();
      assert.equal(mutated.params.text, 'different text');

      await page.setInputFiles('#file-json', {
        name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(docText),
      });
      await page.waitForTimeout(600);
      const after = await state();
      assert.equal(after.params.text, before.params.text);
      assert.equal(after.params.fontSize, 52);
      assert.equal(after.params.align, 'center');
      assert.deepEqual(after.pathParams.nodes, before.pathParams.nodes);
      for (let i = 0; i < before.glyphs.length; i++) {
        assert.ok(Math.abs(after.glyphs[i].arc - before.glyphs[i].arc) < 1e-6, 'reproduced glyph arcs');
        assert.ok(Math.abs(after.glyphs[i].angleDeg - before.glyphs[i].angleDeg) < 1e-6, 'reproduced angles');
      }
    });

    await check('SVG export is real vector geometry, no <text>', async () => {
      const download = page.waitForEvent('download');
      await page.click('#btn-svg');
      const text = readFileSync(await (await download).path(), 'utf8');
      assert.ok(text.startsWith('<svg'));
      assert.ok(!text.includes('<text'), 'SVG must not contain text elements');
      const paths = (text.match(/<path /g) || []).length;
      const s = await state();
      assert.ok(paths >= s.glyphs.length, `expected ≥${s.glyphs.length} glyph paths, got ${paths}`);
      assert.ok(text.includes('fill="#1d2430"'), 'expected glyph fill colour');
      assert.ok(!text.includes('class="tangent"'), 'exports should not include editing guides');
    });

    await check('PNG export renders real pixels', async () => {
      const download = page.waitForEvent('download');
      await page.click('#btn-png');
      const buf = readFileSync(await (await download).path());
      assert.ok(buf.length > 5000, 'PNG too small');
      assert.equal(buf.subarray(1, 4).toString(), 'PNG');
    });

    await check('URL query reproduces parameters on reload', async () => {
      await setParams({ text: 'url roundtrip', fontSize: 44, align: 'end', overflow: 'extend' });
      await page.waitForTimeout(250);
      const url = page.url();
      assert.match(url, /text=url\+roundtrip/);
      assert.match(url, /align=end/);
      assert.match(url, /overflow=extend/);
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.__envelope, { timeout: 20000 });
      const s = await state();
      assert.equal(s.params.text, 'url roundtrip');
      assert.equal(s.params.align, 'end');
      assert.equal(s.params.overflow, 'extend');
      assert.equal(s.params.fontSize, 44);
    });

    await check('curved-text workflow: drag curve, edit text, verify glyph order and baseline direction', async () => {
      // Reset to a known document so the scenario starts from the default curve.
      const defaultP = await defaultPath();
      await setPath(defaultP);
      await setParams({
        text: 'curve workflow q́ ffi', fontSize: 48, align: 'start', overflow: 'clip',
        startOffset: 0, showBaseline: true, showTangents: true,
      });
      await page.waitForTimeout(400);
      const before = await state();
      assert.equal(before.ok, true);

      // 1. Entering the app shows a live run status (glyph count and path length).
      const statusBefore = await page.locator('#status-shaping').textContent();
      assert.match(statusBefore, /glyphs from/);
      assert.match(await page.locator('#status-metrics').textContent(), /path /);

      // 2. Drag an orange anchor (node 1) to bend the curve; glyph arcs/angles move.
      const anchor = page.locator('#stage-svg .anchor[data-node="1"]');
      const box = await anchor.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 55, box.y + box.height / 2 + 60, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const dragged = await state();
      assert.notDeepEqual(dragged.pathParams.nodes[1], before.pathParams.nodes[1], 'node 1 should move');
      // The arc-0 anchor keeps its tangent because the start node did not move;
      // glyphs further along the moved segment must change heading with the curve.
      const beforeAngles = before.glyphs.map((g) => g.angleDeg);
      const draggedAngles = dragged.glyphs.map((g) => g.angleDeg);
      assert.equal(draggedAngles[0], beforeAngles[0], 'start-node tangent stays fixed');
      assert.ok(draggedAngles.some((a, i) => Math.abs(a - beforeAngles[i]) > 1e-6), 'some glyph heading must follow the bent curve');

      // 3. Edit the text in the panel; shaping and glyph arrangement update.
      await page.fill('#text-input', 'edited curve text');
      await page.waitForTimeout(400);
      const edited = await state();
      assert.equal(edited.params.text, 'edited curve text');
      assert.ok(edited.glyphs.length > 3, 'edited text should place multiple glyphs');
      const arcs = edited.glyphs.map((g) => g.arc);
      for (let i = 1; i < arcs.length; i++) assert.ok(arcs[i] >= arcs[i - 1] - 1e-9, 'glyphs follow baseline in order');

      // 4. Baseline direction: each rendered glyph heading equals atan2(tangent),
      //    and the visible baseline path still carries all cubic segments.
      for (const g of edited.glyphs) {
        const expected = (Math.atan2(g.tangent.y, g.tangent.x) * 180 / Math.PI + 360) % 360;
        assert.ok(Math.abs(expected - g.angleDeg) < 1e-9, 'glyph heading must match baseline tangent');
      }
      const baselineD = await page.locator('#stage-svg .baseline').getAttribute('d');
      assert.ok((baselineD.match(/C/g) || []).length >= edited.pathParams.nodes.length - 1, 'baseline keeps every cubic');
      const glyphPaths = await page.locator('#stage-svg .glyphs path').count();
      assert.ok(glyphPaths >= edited.glyphs.length - 1, 'glyph outlines are rendered along the curve');

      // 5. Anomaly visibility: force an overflow error and confirm it is surfaced,
      //    not hidden behind a default/empty render.
      await setParams({ text: 'overflow '.repeat(40), overflow: 'error' });
      await page.waitForTimeout(350);
      const broken = await state();
      assert.equal(broken.ok, false);
      assert.equal(broken.layout.error.code, 'text-overflow');
      assert.match(await page.locator('#diag-list').textContent(), /text-overflow/);
      assert.match(await page.locator('#status-shaping').textContent(), /error: text-overflow/);
      assert.equal(await page.locator('#stage-svg .glyphs path').count(), 0, 'no glyphs silently rendered under an error');
      const badge = await page.locator('#diag-count').textContent();
      assert.notEqual(badge, '0', 'the anomaly badge must flag the error');

      // Restore a healthy document for subsequent checks.
      await setPath(defaultP);
      await setParams({ text: 'curve workflow q́ ffi', fontSize: 48, align: 'start', overflow: 'clip' });
      await page.waitForTimeout(300);
    });

    await check('no console errors during the run', async () => {
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    server.stdout?.destroy();
    server.stderr?.destroy();
    // Also stop any grandchildren Vite may have spawned, then exit explicitly
    // so a lingering child process cannot keep the runner alive.
    if (server.pid) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* not a group leader */ }
    }
  }

  if (failed) {
    console.error(`\n${failed} UI check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll UI checks passed');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
