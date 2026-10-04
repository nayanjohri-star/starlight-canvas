// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVIDENCE, evidence, bootIndependent, openDirector, dualCharacters, characterXInput, projectOf, activeScene, noModelCalls } from './fixtures/director-independent-browser.mjs';
import { waitUiCondition } from './fixtures/director-ui-wait.mjs';
import { inspectDirectorSceneBudget } from './fixtures/director-scene-budget.mjs';

// Observe native draws on the real stage canvas, rather than counting rAF
// callbacks as rendered 3D frames. All observations stay in the current iframe.
function observeStageDraws() {
  if (parent === window || !/\/director\/index\.html$/.test(location.pathname)) return;
  const state = window.__fStageDraw = { active: false, frames: [], responses: [], expectedX: null, pending: null, tick: 0, lastTick: -1 };
  const tick = () => { state.tick++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('.number-field input') && state.expectedX != null) {
      state.pending = { expectedX: state.expectedX, start: performance.now(), trusted: event.isTrusted };
    }
  }, true);
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const native = prototype[method]; if (!native) continue;
      prototype[method] = function (...args) {
        const result = native.apply(this, args);
        if (!this.canvas.closest('#stage')) return result;
        const now = performance.now();
        if (state.active && state.lastTick !== state.tick) { state.lastTick = state.tick; state.frames.push(now); }
        const pending = state.pending, rig = window.__cozyclay?.rigA;
        // Three updates the world matrix before issuing its native draws.
        // The measured response ends only after the edited character transform
        // is actually submitted, not at an unrelated browser paint.
        if (pending && rig && Math.abs(rig.matrixWorld.elements[12] - pending.expectedX) < 0.0001) {
          state.responses.push({ expectedX: pending.expectedX, latencyMs: now - pending.start, trusted: pending.trusted });
          state.pending = null;
        }
        return result;
      };
    }
  }
}
async function command(frame, id, args) {
  const result = await frame.evaluate(({ id, args }) => window.__starlightDirector.run(id, args), { id, args });
  assert.equal(result.ok, true, `${id}: ${JSON.stringify(result)}`); return result;
}

test('V20: real hardware draws of two characters, 20 props, three cameras and twelve shots reach 30fps and 100 trusted edits P95 <=100ms',
  { timeout: 360000 }, async t => {
  const run = await bootIndependent(t, { width: 1920, height: 1080, hardware: true, initScript: observeStageDraws });
  try {
    const { frame } = await openDirector(run.page);
    await dualCharacters(frame);
    const gpu = await frame.evaluate(() => {
      const canvas = document.querySelector('#stage canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
        vendor: extension && gl.getParameter(extension.UNMASKED_VENDOR_WEBGL), version: gl.getParameter(gl.VERSION) };
    });
    assert.ok(gpu.renderer, 'the actual GPU renderer must be observable');
    assert.doesNotMatch(gpu.renderer, /SwiftShader|llvmpipe|software|Microsoft Basic|WARP/i, 'hardware performance cannot use software rendering');
    assert.match(gpu.renderer, /NVIDIA|GeForce/i, 'the fixed reference computer must actually render on its NVIDIA hardware');
    const hardware = { cpu: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem(), gpu };
    evidence(`v20-${run.identity.browser}-identity.json`, { identity: run.identity, hardware });
    t.diagnostic(`hardware=${JSON.stringify(hardware)}`);
    await command(frame, 'shot.setFps', { fps: 30 }); await command(frame, 'shot.setDuration', { seconds: 30 });
    for (let i = 0; i < 20; i++) await command(frame, 'object.add', { kind: ['chair', 'cube', 'sphere', 'cylinder'][i % 4],
      name: `F合成道具${i + 1}`, placement: { x: (i % 5 - 2) * 1.5, y: 0, z: -2 - Math.floor(i / 5) * 1.5 } });
    let scene = activeScene(await projectOf(frame));
    if (!scene.shotDocument.shots.length) await command(frame, 'shot.create', {});
    scene = activeScene(await projectOf(frame));
    const first = scene.shotDocument.shots[0], cameras = scene.shotDocument.cameraLibrary.cameras;
    assert.equal(cameras.length, 3, 'fixed reference scene has exactly three independent cameras');
    const shots = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(first), id: `f-performance-shot-${index + 1}`,
      name: `F合成镜头${index + 1}`, startFrame: index * 75, endFrame: index * 75 + 74, cameraId: cameras[index % 3].id,
      camera: { ...structuredClone(cameras[index % 3].framing), mode: 'keys' }, cameraKeys: [] }));
    // The benchmark scene is synthetic preparation, not a command receipt
    // test. Import through the actual project parser/rehydration path so a
    // separate batch-summary bug cannot prevent hardware measurement.
    const prepared = await projectOf(frame); activeScene(prepared).shotDocument.shots = shots;
    const imported = await frame.evaluate(text => window.__cozyclayProject.open(text), JSON.stringify(prepared));
    assert.equal(imported.ok, true, JSON.stringify(imported));
    await waitUiCondition(frame, async () => {
      const project = JSON.parse(await window.__cozyclayProject.export('F benchmark import observation'));
      const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId);
      return scene.shotDocument.shots.length === 12 && window.__cozyclay?.frameCount === 900
        && ['f-independent-a', 'f-independent-b'].every(id => window.__cozyclayMcpRigReady?.includes(id));
    }, null, { description: 'benchmark project has twelve shots, 900 frames and both ready rigs' });
    const baselineProject = await projectOf(frame); scene = activeScene(baselineProject);
    assert.equal(scene.stage.characters.length, 2); assert.equal(scene.objects.length, 20);
    assert.equal(scene.shotDocument.shots.length, 12); assert.equal(scene.shotDocument.cameraLibrary.cameras.length, 3);
    assert.equal(scene.shotDocument.fps, 30); assert.equal(scene.shotDocument.frameCount, 900);
    const projectBytes = Buffer.from(JSON.stringify(baselineProject, null, 2));
    await writeFile(join(EVIDENCE, `v20-${run.identity.browser}-synthetic.cclayproject`), projectBytes);
    const projectMeasurement = { byteLength: projectBytes.byteLength, sha256: createHash('sha256').update(projectBytes).digest('hex') };
    // One read-only real main-camera render during warmup. Never request an
    // extra render or read scene assets during the 3x10-second timing windows.
    await frame.evaluate('window.__fInspectBudget=' + inspectDirectorSceneBudget.toString());
    await frame.evaluate(() => {
      let scene = window.__cozyclay.rigA; while (scene.parent) scene = scene.parent;
      if (!scene.isScene) throw Error('Actual stage scene is unavailable');
      const before = scene.onAfterRender;
      const observed = function (renderer, actualScene, camera) {
        try {
          if (actualScene === scene && camera === window.__cozyclay.activeCam && scene.overrideMaterial === null && renderer.getRenderTarget() === null) {
            try { window.__fSceneBudget = { result: window.__fInspectBudget(scene, renderer, camera) }; }
            catch (error) { window.__fSceneBudget = { error: error.stack || error.message }; }
            finally { scene.onAfterRender = before; }
          }
        } finally { before?.call(this, renderer, actualScene, camera); }
      };
      scene.onAfterRender = observed;
      window.__fBudgetDispose = () => { if (scene.onAfterRender === observed) scene.onAfterRender = before; delete window.__fInspectBudget; };
    });
    const windows = []; let sceneBudget;
    for (let iteration = 0; iteration < 3; iteration++) {
      await command(frame, 'timeline.seek', { frame: 0 }); await command(frame, 'timeline.play', { playing: true });
      const ready = await frame.waitForFunction(() => document.querySelector('#stage').dataset.actualRenderLoop === 'always'); await ready.dispose();
      await frame.waitForTimeout(iteration === 0 ? 5000 : 1000);
      if (iteration === 0) {
        await waitUiCondition(frame, () => {
          if (window.__fSceneBudget?.error) throw Error(window.__fSceneBudget.error);
          return !!window.__fSceneBudget?.result;
        }, null, { description: 'one actual main-camera rendered scene inventory during warmup' });
        sceneBudget = await frame.evaluate(() => { window.__fBudgetDispose(); delete window.__fBudgetDispose; return window.__fSceneBudget.result; });
        evidence(`v20-${run.identity.browser}-scene-budget.json`, { identity: run.identity, project: projectMeasurement, sceneBudget });
        assert.ok(sceneBudget.actualDrawCounters.triangles > 0, 'recorded triangle count comes from a real rendered main scene');
        assert.ok(sceneBudget.uniqueGeometries > 0); assert.equal(sceneBudget.texturesWithUnknownDimensions, 0, 'all referenced baseline texture dimensions are recorded');
      }
      const measured = await frame.evaluate(async () => {
        const state = window.__fStageDraw; state.frames = []; state.lastTick = -1; state.active = true;
        const start = performance.now(); await new Promise(resolve => setTimeout(resolve, 10000));
        state.active = false; const durationMs = performance.now() - start;
        return { drawnFrames: state.frames.length, durationMs, fps: state.frames.length * 1000 / durationMs, timestamps: state.frames };
      });
      windows.push(measured); await command(frame, 'timeline.play', { playing: false });
    }
    const input = await characterXInput(frame);
    for (let index = 0; index < 100; index++) {
      const x = Number((-1.19 + index * 0.01).toFixed(2));
      await input.fill(String(x)); await frame.evaluate(x => { window.__fStageDraw.expectedX = x; }, x);
      await input.press('Enter');
      const ready = await frame.waitForFunction(count => window.__fStageDraw.responses.length === count, index + 1, { timeout: 5000 }); await ready.dispose();
      await input.blur();
    }
    const responses = await frame.evaluate(() => window.__fStageDraw.responses);
    assert.equal(responses.length, 100); assert.ok(responses.every(row => row.trusted));
    const latencies = responses.map(row => row.latencyMs).sort((a, b) => a - b), p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
    const result = { identity: run.identity, hardware, baseline: { characters: 2, props: 20, cameras: 3, shots: 12, fps: 30, frames: 900 }, project: projectMeasurement, sceneBudget, windows, responses, responseP95Ms: p95 };
    evidence(`v20-${run.identity.browser}-performance.json`, result);
    t.diagnostic(`v20Result=${JSON.stringify(result)}`);
    for (const window of windows) assert.ok(window.fps >= 30, `actual stage draw FPS ${window.fps} is below 30`);
    assert.ok(p95 <= 100, `100 real edit responses have P95=${p95}ms`);
    noModelCalls(run);
  } finally { await run.close(); }
});
