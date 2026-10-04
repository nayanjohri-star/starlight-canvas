import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { writeMotionSnapshot, motionSnapshotRecord } from '../src/motion-snapshot.js';
import { decodeMotionResource, encodeMotionResource } from '../src/motion-resources.js';
import { decodeMotionNpz } from '../src/ardy/npz.js';
import { createSceneDocument, serializeSceneDocument, readSceneDocument, duplicateScene } from '../src/scenes.js';
import { createProjectDocument, readProjectDocument } from '../src/project.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const frames = 48;
const take = { frames, fps: 24, rotMats: new Float32Array(frames * 243), rootPos: new Float32Array(frames * 3), posedJoints: new Float32Array(frames * 81), personScale: 1.1, boneScale: new Float32Array(27).fill(1) };
for (let frame = 0; frame < frames; frame++) {
	for (let joint = 0; joint < 27; joint++) {
		take.rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (frame * 27 + joint) * 9);
		const p = CSKEL27_NEUTRAL[joint]; take.posedJoints.set([p[0] + frame * .01, p[1] + 1, p[2]], (frame * 27 + joint) * 3);
	}
	take.rootPos.set([frame * .01, 1, 0], frame * 3);
}
const bytes = writeMotionSnapshot(take); assert.deepEqual(writeMotionSnapshot(take), bytes);
const decoded = await decodeMotionNpz(bytes); assert.deepEqual(decoded.rotMats, take.rotMats); assert.deepEqual(decoded.rootPos, take.rootPos); assert.deepEqual(decoded.posedJoints, take.posedJoints);
const record = motionSnapshotRecord(take), checked = await encodeMotionResource(bytes); assert.equal(record.motionId, checked.motionId);
assert.deepEqual((await decodeMotionResource(record)).boneScale, take.boneScale);
const scene = createSceneDocument();
assert.equal(scene.scenes[0].stage.characters[0].subject, '');
assert.equal(scene.scenes[0].stage.environment, '');
assert.equal(scene.scenes[0].stage.style, '');
scene.scenes[0].stage.characters[0].subject = '用户保存的人物描述';
const layer = id => ({ id, take: { resourceId: `restore:${id}:take:${record.motionId}`, snapshot: true, motionId: record.motionId, frames, fps: 24, editSegments: [{ id: 'edited', sourceStart: 4, sourceEnd: 42, speed: 1.2 }] }, fullTake: { motionId: record.motionId, snapshot: true }, ikKeys: [{ frame: 12, tracks: { hips: { p: { x: 0, y: 91, z: 0 } } } }], committedIkEdits: [{ frame: 12 }] });
scene.scenes[0].motion = [layer('char-a'), layer('char-b')];
const restored = readSceneDocument(serializeSceneDocument(scene)); assert.equal(restored.status, 'valid'); assert.deepEqual(restored.document.scenes[0].motion, scene.scenes[0].motion);
assert.equal(restored.document.scenes[0].stage.characters[0].subject, '用户保存的人物描述');
const duplicated = duplicateScene(scene.scenes, 0); duplicated[1].motion[0].ikKeys[0].tracks.hips.p.y = 55; assert.equal(scene.scenes[0].motion[0].ikKeys[0].tracks.hips.p.y, 91);
const project = createProjectDocument({ scenesDocument: scene, motions: [record] });
const opened = readProjectDocument(JSON.stringify(project)); assert.equal(opened.ok, true); assert.deepEqual(opened.project.scenesDocument.scenes[0].motion, scene.scenes[0].motion);
assert.deepEqual((await decodeMotionResource(opened.project.motions[0])).posedJoints, take.posedJoints);
await assert.rejects(decodeMotionResource({ ...record, motionId: '0'.repeat(64) }), /motionId/);
assert.throws(() => writeMotionSnapshot({ ...take, rootPos: new Float32Array(2) }), /shape/);
console.log('PASS self-contained motion snapshots: deterministic NPZ, SHA check, exact arrays, dual-character IK keys, scene duplication and project round trip');
