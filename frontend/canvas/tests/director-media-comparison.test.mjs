// SPDX-License-Identifier: AGPL-3.0-or-later
// CPU counterexamples for observation/comparison. These mocks are not GPU proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { COMPOSITION_LIMITS, compareAddressedFrames, compareRgbaComposition, isModelRequestPath, assertHostedMediaTarget } from '../../director/test/fixtures/starlight-media-comparison.mjs';
import { installCaptureObserver } from '../../director/test/fixtures/starlight-capture-observer.mjs';

function image(width = 400, height = 250) {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < rgba.length; at += 4) rgba.set([80, 90, 100, 255], at);
  return { width, height, rgba };
}
const cloneImage = value => ({ ...value, rgba: value.rgba.slice() });
test('model request classification matches actual hosted routes without conflating identity or asset storage', () => {
  for (const path of ['/canvas-api/v1/chat/completions', '/canvas-api/v1/images/generations', '/canvas-api/v1/images/edits', '/canvas-api/v1/videos', '/canvas-api/v1/videos/job/content', '/v1/chat/completions']) assert.equal(isModelRequestPath(path), true, path);
  for (const path of ['/canvas-api/identity', '/canvas-api/v1/models', '/canvas-api/reference-assets', '/canvas-api/projects', '/canvas/releases/test/fonts/font.woff']) assert.equal(isModelRequestPath(path), false, path);
});
function addressed() {
  return { ...image(), frameIndex: 14, fps: 30, timestamp: 466667, duration: 33333, authoredSha256: 'a'.repeat(64),
    renderState: { camera: { matrix: '0123', focus: { fStop: 2.8 } }, objects: [{ uuid: 'small-object', world: 'abcd', material: { roughness: '1234' }, skeleton: { boneMatrices: 'f32-9876' } }], productionTarget: { type: 1016, samples: 4 }, actualFramebuffer: { observedIn: 'cpu-stub', samples: 4, status: 36053, componentType: 5126, channelBits: [16, 16, 16, 16] } } };
}
test('hosted media identity rejects old immutable tabs, wrong parent/context and foreign baseURI', () => {
  const hash = 'a'.repeat(64), root = `http://127.0.0.1:34080/canvas/releases/${hash}/director/`;
  const input = { artifact: { sourceDirty: false, mode: 'hosted', basePath: '/canvas/', assetPath: `releases/${hash}/` }, hostUrl: 'http://127.0.0.1:34080/canvas/', parentUrl: 'http://127.0.0.1:34080/canvas/', frameUrl: root + 'index.html?sessionId=fixture', realmUrl: root + 'index.html?sessionId=fixture', baseURI: root + 'index.html?sessionId=fixture' };
  assert.equal(assertHostedMediaTarget(input).immutableEntry, root + 'index.html');
  assert.doesNotThrow(() => assertHostedMediaTarget({ ...input, baseURI: root }));
  for (const bad of [ { frameUrl: input.frameUrl.replace(hash, 'b'.repeat(64)) }, { artifact: { ...input.artifact, assetPath: `releases/${'b'.repeat(64)}/` } }, { parentUrl: root + 'index.html' }, { realmUrl: input.realmUrl.replace('fixture', 'other-context') }, { baseURI: input.baseURI.replace(hash, 'b'.repeat(64)) }, { baseURI: 'http://localhost:34080/canvas/' }, { artifact: { ...input.artifact, sourceDirty: true } } ]) assert.throws(() => assertHostedMediaTarget({ ...input, ...bad }));
});
test('composition policy is fixed at one RGB byte / alpha exact / ten ppm', () => {
  assert.deepEqual(COMPOSITION_LIMITS, { maxRgbByteDelta: 1, maxChangedPixelRatio: .00001, alphaExact: true });
  assert.equal(Object.isFrozen(COMPOSITION_LIMITS), true);
  const baseline = addressed(), observed = { ...baseline, rgba: baseline.rgba.slice() };
  observed.rgba[0]++;
  assert.equal(compareAddressedFrames(baseline, observed).allowedChangedPixels, 1);
  observed.rgba[4]++;
  assert.throws(() => compareAddressedFrames(baseline, observed), /10 ppm/);
});
test('unchanged frames pass; a whole-image single-step color change fails', () => {
  const baseline = image(), observed = cloneImage(baseline);
  assert.equal(compareRgbaComposition(baseline, observed).changedPixels, 0);
  for (let at = 0; at < observed.rgba.length; at += 4) observed.rgba[at]++;
  assert.throws(() => compareRgbaComposition(baseline, observed), /10 ppm/);
});
test('a one-pixel motion or tiny high-contrast object deletion fails independently of global PSNR', () => {
  const baseline = image(); baseline.rgba.set([150, 160, 170, 255], 404);
  const moved = cloneImage(baseline); moved.rgba.set([80, 90, 100, 255], 404); moved.rgba.set([150, 160, 170, 255], 408);
  assert.throws(() => compareRgbaComposition(baseline, moved), /RGB delta/);
  const deleted = cloneImage(baseline); deleted.rgba.set([80, 90, 100, 255], 404);
  assert.throws(() => compareRgbaComposition(baseline, deleted), /RGB delta/);
});
test('even a one-pixel one-byte local change fails when its source object/world state changes', () => {
  const baseline = addressed(), observed = structuredClone(baseline);
  observed.rgba[404]++; observed.renderState.objects[0].world = 'abce';
  assert.throws(() => compareAddressedFrames(baseline, observed), /exact camera\/bone\/world\/material\/asset state/);
});
test('wrong frame address, time, fps and asset version each fail with identical pixels', () => {
  const baseline = addressed();
  for (const [key, value] of [['frameIndex', 15], ['timestamp', 500000], ['duration', 33334], ['fps', 24], ['authoredSha256', 'new-asset']]) {
    assert.throws(() => compareAddressedFrames(baseline, { ...baseline, [key]: value }));
  }
});
test('subpixel camera, bone and material differences fail even below the RGB quality limit', () => {
  const baseline = addressed();
  for (const mutate of [state => { state.camera.matrix = '0124'; }, state => { state.objects[0].skeleton.boneMatrices = 'f32-9877'; }, state => { state.objects[0].material.roughness = '1235'; }]) {
    const observed = structuredClone(baseline); mutate(observed.renderState);
    assert.throws(() => compareAddressedFrames(baseline, observed), /exact camera\/bone\/world\/material\/asset state/);
  }
});
test('alpha, dimensions and incomplete RGBA are never tolerated', () => {
  const baseline = image(), observed = cloneImage(baseline); observed.rgba[3]--;
  assert.throws(() => compareRgbaComposition(baseline, observed), /Alpha changed/);
  assert.throws(() => compareRgbaComposition(baseline, { ...baseline, width: 401 }), /width/);
  assert.throws(() => compareRgbaComposition(baseline, { ...baseline, height: 251 }), /height/);
  assert.throws(() => compareRgbaComposition(baseline, { ...baseline, rgba: baseline.rgba.subarray(4) }), /incomplete/);
});

function queryStub(options = {}) {
  // CPU-only query schema, explicitly marked cpu-stub by the observer.
  const gl = { SAMPLES: 0x80A9, DRAW_FRAMEBUFFER: 0x8CA9, COLOR_ATTACHMENT0: 0x8CE0, FRAMEBUFFER_COMPLETE: 0x8CD5, FLOAT: 0x1406,
    FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: 0x8211, FRAMEBUFFER_ATTACHMENT_RED_SIZE: 0x8212, FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: 0x8213, FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: 0x8214, FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: 0x8215, FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0,
    getParameter(key) { assert.equal(key, this.SAMPLES); return options.samples ?? 4; },
    checkFramebufferStatus(target) { assert.equal(target, this.DRAW_FRAMEBUFFER); return options.status ?? this.FRAMEBUFFER_COMPLETE; },
    getFramebufferAttachmentParameter(target, attachment, key) { assert.equal(target, this.DRAW_FRAMEBUFFER); assert.equal(attachment, this.COLOR_ATTACHMENT0); return key === this.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE ? options.componentType ?? this.FLOAT : key === this.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE ? 0x8D41 : options.channelBits ?? 16; } };
  return gl;
}
function observation(options = {}) {
  const vec = values => ({ toArray: () => values.slice() });
  const matrix = vec([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const cameraValues = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const camera = { type: 'PerspectiveCamera', layers: { mask: 1 }, matrixWorld: vec(cameraValues), matrixWorldInverse: matrix, projectionMatrix: matrix, projectionMatrixInverse: matrix, aspect: 1, fov: 40, near: .1, far: 100, zoom: 1, userData: { focus: { fStop: 2.8 } } };
  const mesh = { isMesh: true, uuid: 'rig-mesh', type: 'SkinnedMesh', visible: true, name: 'original-synthetic-rig', matrixWorld: matrix, layers: { mask: 1 }, renderOrder: 0, castShadow: true, receiveShadow: true,
    geometry: { uuid: 'synthetic-geometry', drawRange: { start: 0, count: Infinity }, attributes: { position: { version: 0, itemSize: 3, count: 4, array: new Float32Array(12) } } },
    material: { uuid: 'material', type: 'MeshStandardMaterial', version: 0, color: vec([.4, .4, .4]), roughness: .8 },
    skeleton: { bones: [{ uuid: 'bone', name: 'LeftArm', matrixWorld: matrix }], boneMatrices: new Float32Array([1, -0, 3, 4]) }, children: [] };
  let calls = 0;
  const originalAfter = function () { calls++; options.after?.(cameraValues, mesh); };
  const scene = { isScene: true, children: [mesh], onAfterRender: originalAfter, overrideMaterial: null };
  const byte = { texture: { type: 1009 }, samples: 0, depthBuffer: false, width: 2, height: 2 };
  const color = { texture: { type: 1016 }, samples: 4, width: 2, height: 2 };
  const gl = queryStub(options.gl);
  const renderer = { target: null, toneMapping: 0, toneMappingExposure: 1, outputColorSpace: 'srgb', shadowMap: { type: 3 }, getContext() { return gl; }, getRenderTarget() { return this.target; }, setRenderTarget(target) { this.target = target; } };
  const originalSet = renderer.setRenderTarget;
  const observer = installCaptureObserver({ scene, renderer, width: 2, height: 2, fps: 30, frameCount: 1, authoredSha256: 'project-sha', ...options });
  const draw = (owned = true) => { renderer.setRenderTarget(owned ? byte : null); renderer.setRenderTarget(owned ? color : { ...color }); scene.onAfterRender(renderer, scene, camera); renderer.setRenderTarget(null); };
  const input = (index = 0) => observer.frame(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: Math.round(index * 1e6 / 30), duration: Math.round((index + 1) * 1e6 / 30) - Math.round(index * 1e6 / 30) });
  return { observer, renderer, scene, draw, input, cameraValues, mesh, camera, byte, color, originalAfter, originalSet, calls: () => calls };
}
test('owned color draw latches before live pose restoration and native VideoFrame construction', async () => {
  const fixture = observation({ retainPixels: true });
  const expectedMatrix = Buffer.from(Float64Array.from(fixture.cameraValues).buffer).toString('hex');
  fixture.draw(); fixture.cameraValues[12] = 999; fixture.mesh.skeleton.boneMatrices[1] = 0;
  fixture.input(); const result = await fixture.observer.finish();
  assert.equal(result.captures, 1); assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].renderState.camera.matrixWorld, expectedMatrix, 'capture retains the camera before live restoration');
  assert.notEqual(result.frames[0].renderState.camera.matrixWorld, Buffer.from(Float64Array.from(fixture.cameraValues).buffer).toString('hex'));
  const frozenBoneBits = result.frames[0].renderState.objects[0].skeleton.boneMatrices;
  assert.ok(frozenBoneBits.includes('0000000000000080'), 'negative zero stays exact in the latched state');
  assert.deepEqual(inflateSync(result.frames[0].compressedRgba), Buffer.alloc(16), 'compression preserves actual bytes');
  fixture.observer.dispose(); assert.equal(fixture.scene.onAfterRender, fixture.originalAfter); assert.equal(fixture.renderer.setRenderTarget, fixture.originalSet); assert.equal(fixture.calls(), 1);
});
test('formal visible/hidden scopes reject a changed actual document state at owned draw or native input', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
    for (const expectedVisibility of ['visible', 'hidden']) {
      globalThis.document.visibilityState = expectedVisibility;
      const matching = observation({ expectedVisibility }); matching.draw(); matching.input();
      assert.equal((await matching.observer.finish()).frames[0].visibility, expectedVisibility); matching.observer.dispose();
      const changed = observation({ expectedVisibility }); changed.draw();
      globalThis.document.visibilityState = expectedVisibility === 'visible' ? 'hidden' : 'visible';
      assert.throws(changed.input, /actual visibility/); changed.observer.dispose();
      const wrongDraw = observation({ expectedVisibility }); assert.throws(wrongDraw.draw, /actual visibility/); wrongDraw.observer.dispose();
    }
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  }
});
test('equal-size live and PiP HalfFloat renders cannot supply an owned capture state', () => {
  const fixture = observation(); fixture.draw(false);
  assert.throws(fixture.input, /exactly one owned color draw; got 0/); fixture.observer.dispose();
});
test('the observer reads completed draw state before delegating a callback that restores live values', async () => {
  const fixture = observation({ after: values => { values[12] = 999; } });
  const expectedMatrix = Buffer.from(Float64Array.from(fixture.cameraValues).buffer).toString('hex');
  fixture.draw(); fixture.input(); const result = await fixture.observer.finish();
  assert.equal(result.frames[0].renderState.camera.matrixWorld, expectedMatrix);
  assert.equal(fixture.cameraValues[12], 999); assert.equal(fixture.calls(), 1); fixture.observer.dispose();
});
test('live draws between capture and VideoFrame cannot overwrite or add to its owned state', async () => {
  const fixture = observation(); fixture.draw(); fixture.cameraValues[12] = 999;
  fixture.draw(false);
  // Even reusing the exact target object from a live/null boundary does not
  // constitute a new owned capture boundary.
  fixture.renderer.setRenderTarget(fixture.color); fixture.scene.onAfterRender(fixture.renderer, fixture.scene, fixture.camera);
  fixture.input(); const result = await fixture.observer.finish(); assert.equal(result.captures, 1); fixture.observer.dispose();
});
test('two true owned draws before one VideoFrame fail rather than overwriting the first state', () => {
  const fixture = observation(); fixture.draw(); fixture.draw();
  assert.throws(fixture.input, /exactly one owned color draw; got 2/); fixture.observer.dispose();
});
test('experimental float targets and reduced MSAA cannot qualify as production capture', () => {
  for (const mutate of [target => { target.texture.type = 1015; }, target => { target.samples = 0; }]) {
    const fixture = observation(); mutate(fixture.color); fixture.draw();
    assert.throws(fixture.input, /exactly one owned color draw; got 0/); fixture.observer.dispose();
  }
});
test('nominal HalfFloat/MSAA4 cannot hide actual sample clamping, byte color or incomplete framebuffer', () => {
  for (const gl of [{ samples: 2 }, { channelBits: 8 }, { componentType: 0x8C17 }, { status: 0x8CD6 }]) {
    const fixture = observation({ gl }); assert.throws(fixture.draw, /actual framebuffer is not complete float16\/MSAA4/); fixture.observer.dispose();
  }
});
test('actual Three185 shadow-map round-trip preserves the precise owned capture scope', async () => {
  const THREE = await import(new URL('../../director/node_modules/three/build/three.module.js', import.meta.url));
  const { WebGLShadowMap } = await import(new URL('../../director/node_modules/three/src/renderers/webgl/WebGLShadowMap.js', import.meta.url));
  assert.equal(THREE.REVISION, '185');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); mesh.castShadow = true; mesh.frustumCulled = false;
  const bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); scene.add(mesh);
  const light = new THREE.DirectionalLight(); light.castShadow = true; light.position.set(2, 4, 3); scene.add(light, light.target); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
  const byte = { texture: { type: 1009 }, samples: 0, depthBuffer: false, width: 2, height: 2 }, color = { texture: { type: 1016 }, samples: 4, width: 2, height: 2 };
  const transitions = []; let shadowDraws = 0;
  const gl = queryStub(), renderer = { target: null, toneMapping: 0, toneMappingExposure: 1, outputColorSpace: 'srgb', getContext() { return gl; }, getRenderTarget() { return this.target; },
    setRenderTarget(target) { this.target = target; transitions.push(target === byte ? 'delivery' : target === color ? 'owned-color' : target === light.shadow.map ? 'actual-shadow-map' : 'other'); },
    getActiveCubeFace() { return 0; }, getActiveMipmapLevel() { return 0; }, clear() {}, renderBufferDirect() { shadowDraws++; },
    state: { setBlending() {}, setScissorTest() {}, viewport() {}, buffers: { color: { setClear() {} }, depth: { getReversed() { return false; }, setTest() {} } } } };
  const shadow = new WebGLShadowMap(renderer, { update(object) { return object.geometry; } }, { maxTextureSize: 4096 }); renderer.shadowMap = shadow; shadow.enabled = true; shadow.autoUpdate = false; shadow.needsUpdate = true;
  const observer = installCaptureObserver({ scene, renderer, width: 2, height: 2, fps: 30, frameCount: 1, authoredSha256: 'a'.repeat(64) });
  try {
    renderer.setRenderTarget(byte); renderer.setRenderTarget(color); shadow.render([light], scene, camera);
    assert.ok(shadowDraws > 0); assert.deepEqual(transitions, ['delivery', 'owned-color', 'actual-shadow-map', 'owned-color']);
    scene.onAfterRender(renderer, scene, camera); renderer.setRenderTarget(byte); renderer.setRenderTarget(null);
    observer.frame(new Uint8Array(16), { format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0, duration: 33333 });
    const result = await observer.finish(); assert.equal(result.captures, 1); assert.equal(result.frames.length, 1); assert.equal(result.frames[0].renderState.actualFramebuffer.observedIn, 'cpu-stub');
  } finally { observer.dispose(); }
});
test('non-finite bone state cannot become a matching frame observation', async () => {
  const fixture = observation(); fixture.mesh.skeleton.boneMatrices[0] = NaN;
  assert.throws(fixture.draw, /non-finite numeric render state/);
  await assert.rejects(fixture.observer.finish(), /non-finite numeric render state/); fixture.observer.dispose();
});
test('missing inputs, extra unconsumed draws and wrong addressed native timings fail', async () => {
  const missing = observation(); await assert.rejects(missing.observer.finish(), /missing native inputs/); missing.observer.dispose();
  const timing = observation(); timing.draw(); assert.throws(() => timing.input(1), /wrong addressed timestamp/); timing.observer.dispose();
  const extra = observation(); extra.draw(); extra.input(); extra.draw(); await assert.rejects(extra.observer.finish(), /unconsumed/); extra.observer.dispose();
});
test('pack requires exactly two endpoint captures followed by one draw per native frame', async () => {
  const fixture = observation({ kind: 'pack', frameCount: 2 });
  fixture.draw(); fixture.draw(); fixture.draw(); fixture.input(0); fixture.draw(); fixture.input(1);
  const result = await fixture.observer.finish(); assert.equal(result.captures, 4); assert.deepEqual(result.endpoints.map(row => row.frameIndex), [0, 1]); fixture.observer.dispose();
  const missingEndpoint = observation({ kind: 'pack' }); missingEndpoint.draw();
  assert.throws(missingEndpoint.input, /exactly 3 owned states/); missingEndpoint.observer.dispose();
});
