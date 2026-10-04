import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createAppContext } from '../src/app-context.js';
import { createDocumentStore } from '../src/document-store.js';
import { createStudioActionRegistry } from '../src/studio-actions.js';
import { register } from '../src/commands/shot.js';
import { mountShots } from './bus/shots-hook.mjs';
import { quantizeDuration, rescaleFrames, timelineToSourceFrame, referenceFrameRange } from '../src/frame-clock.js';
import { createShotAuthoringDocument, readShotAuthoringDocument } from '../src/shot-authoring.js';
import { createCameraBlock } from '../src/camera-block.js';
import { sampleCameraWithFocus } from '../src/camera-library.js';
import { buildFollowTrack, buildRailFollowTrack, buildRail } from '../src/camera-follow.js';
import { createDepthOfFieldPass, applyFocusToPass } from '../src/camera-focus.js';

const framing = { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 45 };
const shot = { id: 'shot-a', name: '镜头一', startFrame: 0, endFrame: 149,
  cameraKeys: [{ id: 'key-a', frame: 0, framing }, { id: 'key-b', frame: 149, framing: { ...framing, pos: { x: 2, y: 2, z: 4 } } }], camera: createCameraBlock() };
function fixture() {
  const nativeCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000); nativeCamera.position.set(0, 1.6, 5);
  const live = { current: { timeline: { currentFrame: 0, frameCount: 150, fps: 24 }, shots: [], fovDeg: 45,
    filmback: { sensorId: 'fullFrame', aspectRatio: 16 / 9 }, camera: { position: { x: 0, y: 1.6, z: 5 }, lookAt: { x: 0, y: 1.6, z: 0 }, focalMm: 28 } } };
  let bus; const notices = [];
  const context = createAppContext({ state: live, getBus: () => bus, notify: message => notices.push(message) });
  const shared = { startupScene: { shotDocument: createShotAuthoringDocument({ shots: [shot], frameCount: 150 }) },
    look: { current: { yaw: 0, pitch: 0 } }, shotCameraPosRef: { current: {} }, shotCamRef: { current: nativeCamera },
    manualCameraOverrideRef: { current: false }, setCameraPos() {}, markSemanticEdit() {}, charA: { x: 0, z: 0, rot: 0 },
    setTlFrame: frame => { live.current.timeline.currentFrame = frame; },
    captureCurrentFraming: () => ({ pos: { x: nativeCamera.position.x, y: nativeCamera.position.y, z: nativeCamera.position.z },
      yaw: shared.look.current.yaw, pitch: shared.look.current.pitch, fovDeg: nativeCamera.fov }) };
  const read = () => ({ ...live.current, camera: live.current.studioCamera ?? live.current.camera, view: { frame: live.current.timeline.currentFrame }, host: { sceneId: 'scene-a' },
    frame: live.current.timeline.currentFrame, frameCount: live.current.timeline.frameCount, activeSceneId: 'scene-a', characters: [] });
  context.updatePorts({ read });
  const owner = mountShots(context.forRender(shared));
  owner.load({ shots: [shot], frameCount: 150, camera: live.current.camera });
  const others = {};
  for (const [name, rows] of Object.entries({ cast: [{ id: 'actor-a', layer: { waypoints: [{ frame: 60, x: 2, z: 1 }], promptClips: [{ startFrame: 0, endFrame: 150, text: '用户动作' }] } }],
    motion: [{ id: 'actor-a', take: { resourceId: 'clip-source', fps: 20, frames: 125, anchorFrame: 4 }, ikKeys: [{ frame: 96, tracks: {} }], poseEdits: { 48: { pose: 'test' } }, committedIkEdits: [{ frame: 120 }] }],
    objects: [{ id: 'prop-a', path: { durationFrames: 120, keys: [{ frame: 72, x: 1 }] } }] })) {
    const store = createDocumentStore({ owned: { [name]: rows } });
    const handle = { documentStore: store, read: () => store.read(name), write: value => store.write(name, value), beginAction: () => store.beginAction(name) };
    context.registerStoreDomain(name, handle); others[name] = handle;
  }
  const registry = createStudioActionRegistry({ readState: read }); registry.registerToolAlias = () => {};
  register(registry, { state: read, storeDomain: context.storeDomain });
  bus = { run(id, args) {
    try { const prepared = registry.prepare(id, args); const result = context.recordAction('shot', () => registry.invoke(prepared.entry, prepared.args, {})); return { ok: true, ...result.result, historyEntryId: result.historyEntryId }; }
    catch (error) { return { ok: false, code: error.code ?? 'INVALID_ARGUMENT', message: error.message }; }
  } };
  const run = (id, args) => { const result = bus.run(id, args); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const snapshot = () => structuredClone({ shot: owner.state(), ...Object.fromEntries(Object.entries(others).map(([name, handle]) => [name, handle.read()])) });
  return { context, owner, others, nativeCamera, live, notices, run, bus, snapshot,
    dispose() { owner.dispose(); for (const row of Object.values(others)) row.documentStore.dispose(); } };
}

test('24/30 clocks report exact integer frame quantization and enforce the 30 second segment limit', () => {
  assert.deepEqual(quantizeDuration(6.25, 24), { fps: 24, requestedSeconds: 6.25, frameCount: 150, lastFrame: 149,
    actualSeconds: 6.25, rounded: false, deltaSeconds: 0, message: '6.25 秒 = 150 帧（24 fps，末帧 149）' });
  const rounded = quantizeDuration(6.25, 30); assert.equal(rounded.frameCount, 188); assert.equal(rounded.rounded, true); assert.match(rounded.message, /6\.266667/);
  for (const fps of [24, 30]) for (const seconds of [1, 15, 30]) assert.equal(quantizeDuration(seconds, fps).frameCount, fps * seconds);
  assert.throws(() => referenceFrameRange(0, 720, 24), /30 秒/);
  assert.equal(referenceFrameRange(0, 719, 24).durationSeconds, 30);
  assert.equal(timelineToSourceFrame(90, 30, 20), 60);
  const thirty = createShotAuthoringDocument({ fps: 30, frameCount: 180, shots: [{ ...shot, endFrame: 179 }] });
  assert.equal(readShotAuthoringDocument(thirty).state.fps, 30);
  assert.equal(readShotAuthoringDocument(thirty).state.frameCount, 180);
  assert.equal(readShotAuthoringDocument({ ...thirty, fps: 60 }).status, 'future');
});

test('FPS command remaps all authored tracks while native take samples stay on their own clock, and undo is atomic', () => {
  const f = fixture(); try {
    f.live.current.timeline.currentFrame = 72;
    const before = f.snapshot(); const result = f.run('shot.setFps', { fps: 30 });
    assert.ok(result.historyEntryId); assert.equal(f.owner.state().fps, 30); assert.equal(f.live.current.timeline.fps, 30);
    assert.equal(f.live.current.timeline.currentFrame, 90);
    assert.equal(f.owner.state().frameCount, 188); assert.equal(f.owner.read()[0].endFrame, 187); assert.equal(f.owner.read()[0].cameraKeys[1].frame, 186);
    assert.equal(f.others.cast.read()[0].layer.waypoints[0].frame, 75);
    assert.equal(f.others.cast.read()[0].layer.promptClips[0].endFrame, 188);
    assert.equal(f.others.motion.read()[0].ikKeys[0].frame, 120); assert.equal(f.others.motion.read()[0].poseEdits[60].pose, 'test');
    assert.equal(f.others.motion.read()[0].committedIkEdits[0].frame, 150);
    assert.deepEqual(f.others.motion.read()[0].take, before.motion[0].take);
    assert.equal(f.others.objects.read()[0].path.durationFrames, 150);
    const after = f.snapshot(); const history = f.context.nextStoreHistory(false); assert.ok(history.stepHistory(false));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.live.current.timeline.fps, 24);
    assert.equal(f.live.current.timeline.currentFrame, 72);
    assert.ok(f.context.nextStoreHistory(true).stepHistory(true)); assert.deepEqual(f.snapshot(), after);
    assert.match(f.notices.at(-1), /188 帧/);
    f.run('shot.setDuration', { seconds: 1 }); assert.equal(f.owner.state().frameCount, 30);
  } finally { f.dispose(); }
});

test('key collisions refuse frame-rate changes without dropping an authored key', () => {
  const source = { fps: 30, keys: [{ id: 'a', frame: 2 }, { id: 'b', frame: 3 }] };
  assert.throws(() => rescaleFrames(source, 30, 24), error => error.code === 'FRAME_COLLISION' && error.collisions.length === 1);
  assert.deepEqual(source.keys.map(key => key.frame), [2, 3]);
  const f = fixture(); try {
    f.run('shot.setFps', { fps: 30 });
    f.context.recordAction('motion', () => f.others.motion.write([{ id: 'actor-a', ikKeys: [{ frame: 2 }, { frame: 3 }] }]));
    const before = f.snapshot(), historyEntry = f.context.historyEntry();
    const result = f.bus.run('shot.setFps', { fps: 24 });
    assert.equal(result.ok, false); assert.equal(result.code, 'FRAME_COLLISION');
    assert.deepEqual(f.snapshot(), before); assert.equal(f.context.historyEntry(), historyEntry);
  } finally { f.dispose(); }
});

test('named camera library capture/switch/duplicate/delete/bind is saved and reversible', () => {
  const f = fixture(); try {
    assert.equal(f.owner.state().cameraLibrary.cameras.length, 3);
    const before = f.snapshot(); f.run('shot.selectCamera', { cameraId: 'camera-side' });
    assert.equal(f.nativeCamera.position.x, 5);
    f.run('shot.saveCamera', { name: '演员 B 特写' });
    const savedId = f.owner.state().cameraLibrary.activeCameraId;
    f.run('shot.bindCamera', { shotId: 'shot-a', cameraId: savedId });
    assert.equal(f.owner.read()[0].cameraId, savedId);
    f.run('shot.duplicateCamera', { cameraId: savedId });
    const copied = f.owner.state().cameraLibrary.activeCameraId; assert.notEqual(copied, savedId);
    f.run('shot.removeCamera', { cameraId: savedId });
    assert.equal(f.owner.read()[0].cameraId, undefined); assert.equal(f.owner.read()[0].cameraKeys[0].framing.pos.x, 5);
    assert.ok(f.context.nextStoreHistory(false).stepHistory(false)); assert.equal(f.owner.read()[0].cameraId, savedId);
    const document = f.owner.authoringDocument(); const restored = readShotAuthoringDocument(document);
    assert.equal(restored.status, 'valid'); assert.deepEqual(restored.state.cameraLibrary, document.cameraLibrary);
    for (let i = 0; i < 4; i++) assert.ok(f.context.nextStoreHistory(false).stepHistory(false));
    assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});

test('focus survives camera keys/documents and drives a real Bokeh pass; visible DOF still requires composer rendering', async () => {
  const f = fixture(); try {
    f.run('shot.setFocus', { target: { x: 0, y: 1.6, z: 0 }, fStop: 2, depthOfField: true });
    assert.equal(f.owner.state().camera.focusDistance, 5);
    const document = f.owner.authoringDocument(); assert.equal(document.shots[0].cameraKeys[0].framing.focusDistance, 5);
    assert.equal(readShotAuthoringDocument(document).state.shots[0].camera.depthOfField, true);
    const pass = await createDepthOfFieldPass({ scene: new THREE.Scene(), camera: f.nativeCamera, width: 1280, height: 720, focus: f.owner.state().camera });
    assert.equal(pass.enabled, true); assert.equal(pass.uniforms.focus.value, 5);
    assert.ok(pass.materialBokeh.isShaderMaterial);
    applyFocusToPass(pass, { focusDistance: 2, fStop: 4, depthOfField: false }, 35);
    assert.equal(pass.enabled, false); assert.equal(pass.uniforms.focus.value, 2); pass.dispose();
  } finally { f.dispose(); }
});

test('camera key, rail and follow outputs are identical when frames are addressed in random and sequential order at both rates', () => {
  for (const fps of [24, 30]) {
    const count = fps * 6, subject = Array.from({ length: count }, (_, frame) => ({ x: Math.sin(frame / fps), z: frame / fps }));
    const rail = buildRail([{ x: -2, z: 0 }, { x: 2, z: 6 }]);
    for (const mode of ['keys', 'follow', 'rail']) {
      const track = mode === 'rail' ? buildRailFollowTrack(subject, fps, rail, { followCam: { distance: 3 } }) : buildFollowTrack(subject, fps);
      const authored = { ...shot, endFrame: count - 1, camera: createCameraBlock({ mode,
        cameraRail: mode === 'rail' ? [{ x: -2, z: 0 }, { x: 2, z: 6 }] : null, railFollow: { mode: 'range', startFrame: 0, endFrame: count - 1 } }),
        cameraKeys: [{ frame: 0, framing: { ...framing, focusDistance: 2 } }, { frame: count - 1, framing: { ...framing, pos: { x: 2, y: 2, z: 4 }, focusDistance: 8 } }] };
      const scene = { frameCount: count, subjectTrack: subject, cameraTrack: track, cameraAnchor: { x: 0, z: 0 } };
      const sequential = Array.from({ length: count }, (_, frame) => sampleCameraWithFocus(scene, authored, frame));
      for (let i = 0; i < count; i++) { const frame = (i * 73) % count; assert.deepEqual(sampleCameraWithFocus(scene, authored, frame), sequential[frame]); }
      assert.equal(sequential.at(-1).focusDistance, 8);
    }
  }
});
