import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProceduralRig, disposeProceduralRig } from '../src/procedural-rig.js';
import { createProceduralAction, actionRootWorldScale } from '../src/procedural-actions.js';
import { importAnimation, importBvhAnimation, animationClipTake, convertAnimationSpatialBundle } from '../src/animation-import.js';
import { writeMotionSnapshot } from '../src/motion-snapshot.js';
import { decodeMotionNpz } from '../src/ardy/npz.js';
import { decodeMotionResource } from '../src/motion-resources.js';
import { applyMotionFrame, snapshotPlaybackBones, restorePlaybackBones } from '../src/ardy/playback.js';
import { createServer } from 'vite';
import { createAppContext } from '../src/app-context.js';
import { createDocumentStore } from '../src/document-store.js';
import { createCharacterEntry } from '../src/scenes.js';
import { register as registerCommands } from '../src/commands/motion.js';

const near = (a, b, tolerance = 1e-5) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < tolerance, `index ${i}: ${a[i]} / ${b[i]}`); };
function authoredBvh(up = 'Y') {
	const rig = createProceduralRig(); rig.updateMatrixWorld(true); const bones = []; rig.traverse(bone => { if (bone.isBone) bones.push(bone); });
	const position = bone => { const p = bone.getWorldPosition(new THREE.Vector3()); return up === 'Y' ? p : new THREE.Vector3(p.x, -p.z, p.y); };
	function joint(bone, depth = 0) {
		const p = position(bone); if (bone.parent.isBone) p.sub(position(bone.parent));
		const tabs = '\t'.repeat(depth), children = bone.children.filter(child => child.isBone);
		return `${tabs}${depth ? 'JOINT' : 'ROOT'} ${bone.name}\n${tabs}{\n${tabs}\tOFFSET ${p.x} ${p.y} ${p.z}\n${tabs}\tCHANNELS ${depth ? '3 Xrotation Yrotation Zrotation' : '6 Xposition Yposition Zposition Xrotation Yrotation Zrotation'}\n${children.map(child => joint(child, depth + 1)).join('')}${tabs}}\n`;
	}
	const hierarchy = `HIERARCHY\n${joint(bones[0])}`, values = [];
	for (let frame = 0; frame < 30; frame++) values.push(bones.flatMap((bone, index) => index === 0 ? (up === 'Y' ? [0, 0, frame, 0, 0, 0] : [0, -frame, 0, 0, 0, 0]) : bone.name.endsWith('RightForeArm') ? (up === 'Y' ? [0, 0, frame] : [0, -frame, 0]) : [0, 0, 0]).join(' '));
	disposeProceduralRig(rig); return `${hierarchy}MOTION\nFrames: 30\nFrame Time: ${1 / 30}\n${values.join('\n')}\n`;
}
const yBvh = authoredBvh(), zBvh = authoredBvh('Z');
// Authored ASCII FBX, constructed solely from our original rig and own curves.
function authoredFbx(up = 'Y') {
	const rig = createProceduralRig(), bones = []; rig.updateMatrixWorld(true); rig.traverse(bone => { if (bone.isBone) bones.push(bone); });
	const ids = new Map(bones.map((bone, index) => [bone, 100 + index])), position = bone => { const p = bone.getWorldPosition(new THREE.Vector3()); return up === 'Y' ? p : new THREE.Vector3(p.x, -p.z, p.y); };
	const models = bones.map(bone => { const p = position(bone); if (bone.parent.isBone) p.sub(position(bone.parent)); return `\tModel: ${ids.get(bone)}, "Model::${bone.name}", "LimbNode" {\n\t\tProperties70:  {\n\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${p.toArray().join(',')}\n\t\t}\n\t}\n`; }).join('');
	const objects = `${models}\tAnimationStack: 1000, "AnimStack::Original", "" {\n\t}\n\tAnimationLayer: 1001, "AnimLayer::Base", "" {\n\t}\n\tAnimationCurveNode: 1002, "AnimCurveNode::T", "" {\n\t}\n\tAnimationCurveNode: 1003, "AnimCurveNode::R", "" {\n\t}\n`;
	const curve = (id, end) => `\tAnimationCurve: ${id}, "AnimCurve::Curve", "" {\n\t\tKeyTime: *2 {\n\t\t\ta: 0,46186158000\n\t\t}\n\t\tKeyValueFloat: *2 {\n\t\t\ta: 0,${end}\n\t\t}\n\t}\n`;
	const links = bones.map(bone => `\tC: "OO",${ids.get(bone)},${ids.get(bone.parent) ?? 0}\n`).join('') + `\tC: "OO",1001,1000\n\tC: "OO",1002,1001\n\tC: "OO",1003,1001\n\tC: "OP",1002,100,"Lcl Translation"\n\tC: "OP",1003,${ids.get(rig.getObjectByName('mixamorigRightForeArm'))},"Lcl Rotation"\n\tC: "OP",1004,1002,"d|${up === 'Y' ? 'Z' : 'Y'}"\n\tC: "OP",1005,1003,"d|${up === 'Y' ? 'Z' : 'Y'}"\n`;
	disposeProceduralRig(rig);
	return new TextEncoder().encode(`; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\nGlobalSettings:  {\n\tProperties70:  {\n\t\tP: "UpAxis", "int", "Integer", "",${up === 'Y' ? 1 : 2}\n\t}\n}\nObjects:  {\n${objects}${curve(1004, up === 'Y' ? 100 : -100)}${curve(1005, up === 'Y' ? 30 : -30)}}\nConnections:  {\n${links}}\n`);
}
const y = importBvhAnimation(yBvh, { fps: 30, sourceUp: 'Y', unitScale: .01 }), z = importBvhAnimation(zBvh, { fps: 30, sourceUp: 'Z', unitScale: .01 });
near(y.take.rotMats, z.take.rotMats); near(y.take.rootPos, z.take.rootPos); near(y.take.posedJoints, z.take.posedJoints);
assert.equal(y.take.frames, 30); assert.ok(y.take.rootPos.at(-1) > .28); assert.deepEqual(y.diagnostics.derived, []);
assert.throws(() => importBvhAnimation(yBvh.replaceAll('mixamorigLeftArm', 'UnknownArm').replaceAll('mixamorigRightFoot', 'UnknownFoot')), error => { assert.equal(error.code, 'missing-joints'); assert.deepEqual(error.missing, ['LeftArm', 'RightFoot']); return true; });
const aliased = importBvhAnimation(yBvh.replaceAll('mixamorigHips', 'pelvis'), { fps: 24, jointMap: { Hips: 'pelvis' } }); assert.equal(aliased.take.frames, 24);
for (const invalid of [yBvh + '9', yBvh.replace('Xrotation', 'Qrotation'), yBvh.replace('Frame Time:', 'Broken Time:'), yBvh.replace('CHANNELS 6', 'CHANNELS 6000000000'), yBvh.slice(0, -50)]) assert.throws(() => importBvhAnimation(invalid), /BVH/);

for (const fps of [24, 30]) for (const preset of ['idle', 'walk', 'wave']) {
	const options = { preset, frames: fps * 2, fps, rootWorldScale: actionRootWorldScale({ scale: 1 }) }, take = createProceduralAction(options), again = createProceduralAction(options);
	assert.deepEqual(take.rotMats, again.rotMats); assert.deepEqual(take.posedJoints, again.posedJoints); const decoded = await decodeMotionNpz(writeMotionSnapshot(take)); assert.deepEqual(decoded.rotMats, take.rotMats); assert.deepEqual(decoded.posedJoints, take.posedJoints);
	const rig = createProceduralRig(); rig.scale.setScalar(.01); applyMotionFrame(rig, take, 0); const hand = rig.getObjectByName('mixamorigRightHand').getWorldPosition(new THREE.Vector3()); applyMotionFrame(rig, take, Math.round(fps / 8));
	assert.ok(rig.getObjectByName('mixamorigRightHand').getWorldPosition(new THREE.Vector3()).distanceTo(hand) > (preset === 'idle' ? .0001 : .01));
	if (preset === 'walk') assert.ok(take.rootPos.at(-1) > 1.5); disposeProceduralRig(rig);
}
const route = [{ frame: 0, x: 2, z: 3 }, { frame: 23, x: 4, z: 3 }], scale = actionRootWorldScale({ scale: 1 });
for (const fps of [24, 30]) {
	assert.equal(createProceduralAction({ preset: 'idle', frames: fps * 30, fps }).frames, fps * 30);
	assert.throws(() => createProceduralAction({ preset: 'walk', frames: fps * 30 + 1, fps }), /30 seconds/);
}
const walked = createProceduralAction({ preset: 'walk', frames: 24, fps: 24, rootWorldScale: scale, waypoints: route });
assert.ok(Math.abs(walked.rootPos[69] * scale - 2) < 1e-6); assert.equal(walked.rootPos[71], 0); assert.equal(walked.anchorX, 2);
const routeRig = createProceduralRig(); routeRig.scale.setScalar(.01); applyMotionFrame(routeRig, walked, 0); const firstHip = routeRig.getObjectByName('mixamorigHips').getWorldPosition(new THREE.Vector3()); applyMotionFrame(routeRig, walked, 23); const lastHip = routeRig.getObjectByName('mixamorigHips').getWorldPosition(new THREE.Vector3()); assert.ok(Math.abs(lastHip.x - firstHip.x - 2) < .001); disposeProceduralRig(routeRig);

const clipRig = createProceduralRig(), clip = new THREE.AnimationClip('Original clip', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 98, 0, 0, 98, 100]), new THREE.QuaternionKeyframeTrack('mixamorigRightArm.quaternion', [0, 1], [0, 0, 0, 1, ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .7).toArray()])]);
const clipped = animationClipTake(clipRig, clip, { fps: 30, sourceUp: 'Y', unitScale: .01 }); assert.equal(clipped.take.frames, 30); assert.ok(clipped.take.rootPos.at(-1) > .96); await decodeMotionNpz(writeMotionSnapshot(clipped.take)); disposeProceduralRig(clipRig);
const importedNpz = await importAnimation({ format: 'npz', source: writeMotionSnapshot(createProceduralAction({ preset: 'wave', frames: 60, fps: 30 })), fps: 24, sourceUp: 'Y', unitScale: 1 }); assert.equal(importedNpz.take.frames, 48);
await assert.rejects(importAnimation({ format: 'npz', source: writeMotionSnapshot(importedNpz.take), fps: 24, sourceUp: 'Z', unitScale: 1 }), /canonical/);
await assert.rejects(importAnimation({ format: 'fbx', source: new Uint8Array([1, 2, 3]), fps: 24, sourceUp: 'Y', unitScale: .01 }));
const fbxY = await importAnimation({ format: 'fbx', source: authoredFbx(), fps: 30, sourceUp: 'Y', unitScale: .01 }), fbxZ = await importAnimation({ format: 'fbx', source: authoredFbx('Z'), fps: 30, sourceUp: 'Z', unitScale: .01 });
assert.equal(fbxY.take.frames, 30); assert.ok(fbxY.take.rootPos.at(-1) > .96); assert.equal(fbxZ.diagnostics.loaderAxisCorrection, true); near(fbxY.take.rootPos, fbxZ.take.rootPos); near(fbxY.take.rotMats, fbxZ.take.rotMats); near(fbxY.take.posedJoints, fbxZ.take.posedJoints); await decodeMotionNpz(writeMotionSnapshot(fbxY.take));

const original = { camera: { position: [100, -200, 300], lookAt: [0, 0, 100], up: [0, 0, 1] }, path: [{ frame: 0, position: [100, -200, 300] }], model: { position: [100, -200, 300], quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .4).toArray(), positions: new Float32Array([10, 20, 30]), normals: new Float32Array([0, 0, 1]) } };
const converted = convertAnimationSpatialBundle(original, 'Z', .01); near(converted.camera.position, [1, 3, 2]); near(converted.camera.up, [0, 1, 0]); near(converted.path[0].position, [1, 3, 2]);
const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), expectedWorld = new THREE.Vector3(10, 20, 30).applyQuaternion(new THREE.Quaternion(...original.model.quaternion)).add(new THREE.Vector3(...original.model.position)).multiplyScalar(.01).applyQuaternion(basis), convertedWorld = new THREE.Vector3(...converted.model.positions).applyQuaternion(new THREE.Quaternion(...converted.model.quaternion)).add(new THREE.Vector3(...converted.model.position)); near(expectedWorld.toArray(), convertedWorld.toArray());

const records = new Map(); globalThis.__actionTestRecords = records;
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{ name: 'action-test-db', enforce: 'pre', load(id) { if (id.endsWith('/src/motion-store.js')) return `export const openMotionDb=async()=>({close(){}}); export const putMotion=async(db,row)=>globalThis.__actionTestRecords.set(row.motionId,row); export const getMotion=async(db,id)=>globalThis.__actionTestRecords.get(id);`; } }] });
let createMotionDomain; try { ({ createMotionDomain } = await server.ssrLoadModule('/src/domains/motion.js')); } finally { await server.close(); }
const characters = [createCharacterEntry({ id: 'a', layer: { waypoints: route } }), createCharacterEntry({ id: 'b' })], rigs = Object.fromEntries(characters.map(row => { const rig = createProceduralRig(); rig.scale.setScalar(.01); return [row.id, rig]; }));
rigs.oldUnmounted = null; rigs.oldDisposed = createProceduralRig(); disposeProceduralRig(rigs.oldDisposed);
const scope = { rigs, startupScene: {}, ikStatesRef: { current: new Map() }, ikStateRef: { current: null }, loadedLayerCharRef: { current: 'a' }, bufferRef: { current: {} }, takeRecipeRef: { current: null }, motionFullRef: { current: new Map() }, projectMotionsRef: { current: records }, snapshotExportRig: rig => { assert.ok(rig && !rig.userData.disposed, 'only live rigs may be snapshotted'); return { rig, bones: snapshotPlaybackBones(rig) }; }, restoreExportRig: snapshot => restorePlaybackBones(snapshot.rig, snapshot.bones), readStudioState: () => ({ characters: cast.read(), frameCount: 24 }) };
const app = createAppContext({ notify() {} }).forRender(scope); app.publishLive({ timeline: { currentFrame: 0 }, characters });
const castStore = createDocumentStore({ owned: { cast: characters } }), cast = { documentStore: castStore, read: () => castStore.read('cast'), write: update => castStore.write('cast', update), beginAction: () => castStore.beginAction('cast'), publishMotion() {}, syncTimeline() {} }; app.registerStoreDomain('cast', cast); const owner = createMotionDomain(app, characters), commands = new Map();
registerCommands({ register: command => commands.set(command.id, command), registerToolAlias() {} }, { storeDomain: id => app.storeDomain(id), state: () => ({ characters: cast.read(), frameCount: 24, frame: 0 }) });
try {
	owner.beginGesture(); owner.finishGesture(true); owner.switchLayer('b'); owner.beginGesture(); owner.finishGesture(true); owner.switchLayer('a');
	app.recordAction('motion', () => commands.get('motion.applyPreset').run({ characterId: 'a', preset: 'walk', frames: 24, fps: 24 })); assert.equal(owner.motionFor('a').frames, 24); assert.equal(owner.motionFor('b'), null);
	assert.equal(app.nextStoreHistory(false).stepHistory(false), true); assert.equal(owner.motionFor('a'), null); assert.equal(app.nextStoreHistory(true).stepHistory(true), true);
	await owner.flushDraft(); const portable = await owner.portableDocument(); assert.equal(portable.motion[0].take.rootWorldScale, scale); assert.equal(portable.motion[0].take.motionId, portable.motion[0].fullTake.motionId); assert.ok(portable.records.length);
	app.recordAction('motion', () => owner.editSegments('a', [{ id: 'trimmed', sourceStart: 2, sourceEnd: 21, speed: 1 }])); assert.equal(owner.motionFor('a').frames, 20); assert.equal(owner.fullMotionFor('a').frames, 24);
	const beforeBad = owner.document(); await assert.rejects(commands.get('motion.importAnimation').run({ characterId: 'a', format: 'bvh', source: 'bad', encoding: 'text', fps: 24, sourceUp: 'Y', unitScale: .01 }, { check() {}, commit: apply => app.recordAction('motion', apply) }), /BVH/); assert.deepEqual(owner.document(), beforeBad);
	const result = await commands.get('motion.importAnimation').run({ characterId: 'b', format: 'bvh', source: yBvh, encoding: 'text', fps: 24, sourceUp: 'Y', unitScale: .01 }, { check() {}, commit: apply => app.recordAction('motion', apply) }); assert.equal(result.output.frames, 24); assert.equal(owner.motionFor('b').rootWorldScale, scale); assert.equal(app.nextStoreHistory(false).stepHistory(false), true); assert.equal(owner.motionFor('b'), null);
	await owner.flushDraft();
	const saved = await owner.portableDocument(), expectedCurrent = owner.motionFor('a').rootPos.slice(), expectedFull = owner.fullMotionFor('a').rootPos.slice();
	owner.load(JSON.parse(JSON.stringify(saved.motion))); const row = owner.layer('a'), current = await decodeMotionResource(records.get(row.take.motionId)), full = await decodeMotionResource(records.get(row.fullTake.motionId));
	assert.equal(owner.hydrate('a', current, cast.read().find(character => character.id === 'a').motionRef, full), true);
	assert.deepEqual(owner.motionFor('a').rootPos, expectedCurrent); assert.deepEqual(owner.fullMotionFor('a').rootPos, expectedFull); assert.equal(owner.motionFor('a').rootWorldScale, scale); assert.equal(owner.fullMotionFor('a').rootWorldScale, scale); assert.equal(owner.motionFor('a').actionPreset, 'walk');
	const invalidScale = structuredClone(saved.motion); invalidScale[0].take.rootWorldScale = 0; assert.throws(() => owner.load(invalidScale), /root world scale/);
} finally { owner.dispose(); castStore.dispose(); for (const rig of Object.values(rigs)) disposeProceduralRig(rig); delete globalThis.__actionTestRecords; }
console.log('PASS original idle/walk/wave, exact path root, current/full NPZ restore, strict BVH/actual FBX Y/Z retarget, spatial camera/path/mesh conversion, 30-second boundary, undo/import failures and null/disposed rig gestures');
