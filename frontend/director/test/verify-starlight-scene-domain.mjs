import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppContext } from '../src/app-context.js';
import { createDocumentStore } from '../src/document-store.js';
import { createProceduralRig, disposeProceduralRig } from '../src/procedural-rig.js';
import { createCharacterEntry, createSceneStage, createSceneDocument, serializeSceneDocument, readSceneDocument } from '../src/scenes.js';
import { readProjectDocument, PROJECT_SESSION_KEY } from '../src/project.js';
import { snapshotPlaybackBones, restorePlaybackBones } from '../src/ardy/playback.js';
import { capturePose, DEFAULT_POSE } from '../src/poses.js';
import { decodeMotionResource, encodeMotionResource } from '../src/motion-resources.js';
import { writeMotionSnapshot } from '../src/motion-snapshot.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';
import { register as registerCastCommands } from '../src/commands/cast.js';

const records = new Map();
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{ name: 'local-motion-db', enforce: 'pre', load(id) {
	if (id.endsWith('/src/motion-store.js')) return `const records=globalThis.__starlightMotionTestRecords; export const openMotionDb=async()=>({close(){}});export const putMotion=async(db,r)=>{await globalThis.__starlightMotionTestCache?.(r);records.set(r.motionId,r);return r};export const getMotion=async(db,id)=>records.get(id);`;
	if (id.endsWith('/src/scene-assets.js')) return `export * from './scene-assets.js?real'; export const openAssetDb=async()=>({close(){}});`;
} }] });
globalThis.__starlightMotionTestRecords = records;
let createMotionDomain, useScenes;
try { ({ createMotionDomain } = await server.ssrLoadModule('/src/domains/motion.js')); ({ useScenes } = await server.ssrLoadModule('/src/domains/scenes.js')); } finally { await server.close(); }
function fixture(motion = undefined, motionRecords = new Map()) {
	const characters = ['char-a', 'char-b'].map((id, index) => createCharacterEntry({ id, model: index ? 'x-bot-tpose' : 'y-bot-tpose', pose: DEFAULT_POSE, motionRef: { motionId: 'a'.repeat(64), prompt: 'synthetic', anchorX: index, anchorZ: 0, rotationDeg: 0 } }, index));
	const rigs = Object.fromEntries(characters.map(row => { const rig = createProceduralRig(row.model); rig.scale.setScalar(.01); return [row.id, rig]; }));
	const scope = { startupScene: { motion }, rigs, ikStatesRef: { current: new Map() }, ikStateRef: { current: null }, loadedLayerCharRef: { current: 'char-a' }, bufferRef: { current: {} }, takeRecipeRef: { current: null }, motionFullRef: { current: new Map() }, projectMotionsRef: { current: motionRecords }, snapshotExportRig: rig => ({ rig, bones: snapshotPlaybackBones(rig) }), restoreExportRig: value => restorePlaybackBones(value.rig, value.bones) };
	const app = createAppContext({ notify: () => {} }).forRender(scope); app.publishLive({ timeline: { currentFrame: 12 }, characters });
	const castStore = createDocumentStore({ owned: { cast: characters } });
	const cast = { documentStore: castStore, beginAction: () => castStore.beginAction('cast'), read: () => castStore.read('cast'), write: update => castStore.write('cast', update), publishMotion() {}, syncTimeline() {}, poses: () => [], applyPose(id, pose) { cast.write(rows => rows.map(row => row.id === id ? { ...row, pose } : row)); } };
	app.registerStoreDomain('cast', cast); const owner = createMotionDomain(app, characters);
	scope.readStudioState = () => ({ characters: cast.read(), frameCount: 48 });
	return { owner, app, scope, cast, rigs, dispose() { owner.dispose(); castStore.dispose(); Object.values(rigs).forEach(disposeProceduralRig); } };
}
function take(frames = 48) {
	const value = { frames, fps: 24, personScale: 1, rotMats: new Float32Array(frames * 243), rootPos: new Float32Array(frames * 3), posedJoints: new Float32Array(frames * 81), anchorX: 0, anchorZ: 0, anchorFrame: 0, rotationDeg: 0, editSegments: [{ id: 'source', sourceStart: 0, sourceEnd: frames - 1, speed: 1 }] };
	for (let frame = 0; frame < frames; frame++) { for (let joint = 0; joint < 27; joint++) { value.rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (frame * 27 + joint) * 9); const p = CSKEL27_NEUTRAL[joint]; value.posedJoints.set([p[0] + frame * .01, p[1] + 1, p[2]], (frame * 27 + joint) * 3); } value.rootPos.set([frame * .01, 1, 0], frame * 3); }
	return value;
}
const first = fixture(); let reopened;
try {
	for (const id of ['char-a', 'char-b']) first.app.recordAction('motion', () => { first.owner.replace(id, take()); first.owner.keyPose(id, 12, { bones: { lArm: [.9, .1, .2], rArm: [.3, -.1, -.2] } }); });
	first.app.recordAction('motion', () => first.owner.editSegments('char-a', [{ id: 'trimmed', sourceStart: 4, sourceEnd: 43, speed: 2 }]));
	const commands = new Map(); registerCastCommands({ register: row => commands.set(row.id, row), registerToolAlias() {} }, { storeDomain: id => first.app.storeDomain(id), state: () => ({ frame: 12 }) });
	const untouched = capturePose(first.rigs['char-b']), beforeMirror = structuredClone(first.owner.layer('char-a').ikKeys);
	first.app.recordAction('cast', () => commands.get('character.mirrorPose').run({ characterId: 'char-a' })); assert.deepEqual(capturePose(first.rigs['char-b']), untouched);
	const afterMirror = structuredClone(first.owner.layer('char-a').ikKeys); assert.notDeepEqual(afterMirror, beforeMirror);
	assert.equal(first.app.nextStoreHistory(false).stepHistory(false), true); assert.deepEqual(first.owner.layer('char-a').ikKeys, beforeMirror);
	assert.equal(first.app.nextStoreHistory(true).stepHistory(true), true); assert.deepEqual(first.owner.layer('char-a').ikKeys, afterMirror);
	assert.ok(first.owner.layer('char-a').ikKeys.length); await first.owner.flushDraft();
	const portable = await first.owner.portableDocument(); assert.ok(portable.records.length >= 2);
	const scenes = createSceneDocument(); scenes.scenes[0].motion = first.owner.document().motion;
	const loaded = readSceneDocument(serializeSceneDocument(scenes)); assert.deepEqual(loaded.document.scenes[0].motion, scenes.scenes[0].motion);
	reopened = fixture(loaded.document.scenes[0].motion, new Map(portable.records.map(row => [row.motionId, row])));
	for (const row of reopened.owner.read()) {
		const current = await decodeMotionResource(records.get(row.take.motionId)), full = await decodeMotionResource(records.get(row.fullTake.motionId));
		assert.equal(reopened.owner.hydrate(row.id, current, reopened.cast.read().find(character => character.id === row.id).motionRef, full), true);
	}
	for (const id of ['char-a', 'char-b']) {
		assert.deepEqual(reopened.owner.layer(id).ikKeys, first.owner.layer(id).ikKeys);
		assert.deepEqual(reopened.owner.motionFor(id).rootPos, first.owner.motionFor(id).rootPos);
		assert.deepEqual(reopened.owner.fullMotionFor(id).posedJoints, first.owner.fullMotionFor(id).posedJoints);
		assert.deepEqual(capturePose(reopened.rigs[id]), capturePose(first.rigs[id]));
	}
	assert.equal(reopened.owner.motionFor('char-a').frames, 20); assert.equal(reopened.owner.fullMotionFor('char-a').frames, 48);
	const rows = reopened.owner.document().motion; reopened.owner.load(rows); assert.deepEqual(reopened.owner.layer('char-a').ikKeys, rows[0].ikKeys);
	const beforeInvalid = reopened.owner.document(); const invalid = structuredClone(rows); invalid[0].ikKeys = [{ frame: 12, tracks: null }];
	assert.throws(() => reopened.owner.load(invalid), /Invalid IK key/); assert.deepEqual(reopened.owner.document(), beforeInvalid, 'bad input cannot replace the live motion document');
	const previousStorage = globalThis.localStorage, previousWindow = globalThis.window; const storage = new Map([[PROJECT_SESSION_KEY, JSON.stringify({ name: 'Snapshot test' })]]), writes = [];
	globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
	globalThis.window = { showSaveFilePicker() {}, showOpenFilePicker() {} };
	try {
		const doc = createSceneDocument(), stage = createSceneStage({ characters: first.cast.read() }); first.scope.shots = [];
		doc.scenes[0].stage = stage;
		Object.assign(first.scope, { startup: { document: doc, error: null }, activeSceneIdRef: { current: doc.activeSceneId }, actorStageRef: { current: stage }, shotDocumentRef: { current: null }, storeRef: { current: { objects: [] } }, projectStateRef: { current: { customPoses: [], workspaceLayout: null } }, dirtyRef: { current: false }, saveBlockedRef: { current: false }, saveFailureToastRef: { current: false }, projectSnapshotRef: { current: null }, projectHandleRef: { current: { name: 'snapshot.cclayproject', createWritable: async () => ({ write: async text => writes.push(text), close: async () => {} }) } }, projectMotionsRef: { current: new Map(portable.records.map(record => [record.motionId, record])) } });
		// Match App's document identity when mounting the real project owner.
		first.scope.studioDocumentEpochRef = { current: crypto.randomUUID() };
		let project; function Mount() { project = useScenes(first.app); return null; } renderToStaticMarkup(createElement(Mount));
		const result = await project.saveProject(false, 'Snapshot test', { check() {} }); assert.equal(result.saved, true, JSON.stringify({ result, writes: writes.length })); assert.equal(writes.length, 1);
		const imported = readProjectDocument(writes[0]); assert.equal(imported.ok, true); assert.deepEqual(imported.project.scenesDocument.scenes[0].motion, portable.motion);
		const broken = { ...structuredClone(doc.scenes[0]), id: 'missing-scene', motion: [{ id: 'lost-character', take: { snapshot: true, motionId: 'f'.repeat(64) }, fullTake: null }] };
		first.app.recordAction('scenes', () => first.app.storeDomain('scenes').write(rows => [...rows, broken]));
		const failed = await project.saveProject(false, 'Snapshot test', { check() {} }); assert.equal(failed.saved, false); assert.equal(failed.failure, 'missing-resources'); assert.equal(writes.length, 1, 'missing snapshot preserves the prior complete file');
		const otherTake = take(6); otherTake.rootPos[0] = 19;
		const otherRecord = await encodeMotionResource(writeMotionSnapshot(otherTake));
		first.scope.projectMotionsRef.current.set(otherRecord.motionId, { ...otherRecord, data: otherRecord.data.slice(4) });
		first.app.recordAction('scenes', () => first.app.storeDomain('scenes').write(rows => rows.map(scene => scene.id === broken.id ? { ...scene, motion: [{ id: 'lost-character', take: { snapshot: true, motionId: otherRecord.motionId }, fullTake: null }] } : scene)));
		const corrupted = await project.saveProject(false, 'Snapshot test', { check() {} }); assert.equal(corrupted.saved, false); assert.equal(corrupted.failure, 'missing-resources'); assert.equal(writes.length, 1, 'invalid bytes in an inactive scene cannot overwrite the complete file');
		first.app.storeDomain('scenes').dispose();
	} finally { globalThis.localStorage = previousStorage; globalThis.window = previousWindow; }
	const failing = fixture(), requested = new Map(); let failedId;
	try {
		globalThis.__starlightMotionTestCache = async record => { requested.set(record.motionId, (requested.get(record.motionId) ?? 0) + 1); failedId ??= record.motionId; if (record.motionId === failedId) throw new Error('cache quota'); };
		const a = take(9), b = take(9); b.rootPos[0] = 3;
		failing.app.recordAction('motion', () => { failing.owner.replace('char-a', a); failing.owner.replace('char-b', b); });
		await assert.rejects(failing.owner.flushDraft(), /cache quota/); await new Promise(resolve => setImmediate(resolve));
		assert.equal(failing.owner.pendingDraft(), false); assert.match(failing.owner.draftError().message, /cache quota/, 'another successful snapshot must not clear this failure');
		assert.equal(requested.get(failedId), 1, 'the same current/full snapshot is written once');
		globalThis.__starlightMotionTestCache = async record => requested.set(record.motionId, (requested.get(record.motionId) ?? 0) + 1);
		failing.app.recordAction('motion', () => failing.owner.replace('char-a', a)); await failing.owner.flushDraft();
		assert.equal(failing.owner.draftError(), null); assert.equal(requested.get(failedId), 2, 'a later successful retry resolves its own failure');
	} finally { failing.dispose(); delete globalThis.__starlightMotionTestCache; }
	console.log('PASS real motion owner: dual-character mirror, full/trimmed snapshots, SHA restore, IK keys, exact frame pose, scene reload and safe cache/file failures');
} finally { reopened?.dispose(); first.dispose(); delete globalThis.__starlightMotionTestRecords; delete globalThis.__starlightMotionTestCache; }
