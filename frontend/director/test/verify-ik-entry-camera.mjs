#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "rolldown/experimental";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import * as THREE from "three";

const sourceRoot = process.env.COZYCLAY_ROOT
	? resolve(process.env.COZYCLAY_ROOT)
	: fileURLToPath(new URL("../", import.meta.url));
const { chooseIkEntryPose } = await import(pathToFileURL(resolve(sourceRoot, "src/ik-camera.js")).href);

const editorPose = { source: "editor" };
const shotPose = { source: "shot" };
const rememberedPose = { source: "remembered" };

assert.equal(
	chooseIkEntryPose({ rememberedPose: null, editorPose, shotPose, lookThroughShot: false }),
	editorPose,
	"a first IK entry seeds from the editor view",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose, editorPose, shotPose, lookThroughShot: false }),
	rememberedPose,
	"a remembered poser view wins for the same character",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose: null, editorPose, shotPose, lookThroughShot: true }),
	shotPose,
	"look-through-shot IK entry seeds from the shot view",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose, editorPose, shotPose, lookThroughShot: true }),
	rememberedPose,
	"a remembered poser view still wins over look-through-shot",
);

console.log("PASS IK entry camera seeding decisions");

// Mount the shipped motion hook, retaining its local state/ref cells across
// CPU-only SSR renders. Document owners and camera operations remain real;
// browser effects and renderer components are not needed for IK entry.
const { motionFixture } = await import(pathToFileURL(resolve(sourceRoot, "test/bus/motion-fixture.mjs")).href);
const { freeReferences } = await import(pathToFileURL(resolve(sourceRoot, "test/bus/verify-domain-modules.mjs")).href);
const appSource = readFileSync(resolve(sourceRoot, "src/App.jsx"), "utf8");
const motionSource = readFileSync(resolve(sourceRoot, "src/domains/motion.js"), "utf8");
const stageSource = readFileSync(resolve(sourceRoot, "src/app-stage.jsx"), "utf8");
function findNode(node, predicate) {
	if (!node || typeof node !== "object") return null;
	if (predicate(node)) return node;
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) { for (const child of value) { const found = findNode(child, predicate); if (found) return found; } }
		else if (value && typeof value === "object") { const found = findNode(value, predicate); if (found) return found; }
	}
	return null;
}
const call = findNode(parseSync("App.jsx", appSource).program,
	node => node.type === "CallExpression" && node.callee?.name === "useMotion");
assert.equal(call?.arguments[0]?.callee?.property?.name, "forRender");
const sharedNode = call.arguments[0].arguments[0];
const sharedCode = appSource.slice(sharedNode.start, sharedNode.end);
const sharedNames = [...new Set([...sharedNode.properties.map(property => property.key.name), "liveQueries"])]
	.filter(name => !["editorCamRef", "editorLook"].includes(name));
// App declares these refs later in the component. Evaluate its real shared
// object before initialising them, so replacing the lazy getters with eager
// properties would reproduce the startup temporal-dead-zone failure.
const createShared = new Function(...sharedNames, "lateCameraRefs", `
const shared = (${sharedCode});
const { editorCamRef, editorLook } = lateCameraRefs;
return shared;
`);
const stageAst = parseSync("stage.jsx", stageSource).program;
const definitions = new Map(), selected = new Set();
for (const node of stageAst.body) {
	const declaration = node.declaration ?? node;
	if (node.type === "ImportDeclaration") for (const spec of node.specifiers) definitions.set(spec.local.name, node);
	if (declaration.type === "FunctionDeclaration") definitions.set(declaration.id.name, node);
	if (declaration.type === "VariableDeclaration") for (const item of declaration.declarations) if (item.id.type === "Identifier") definitions.set(item.id.name, node);
}
function include(name) {
	const node = definitions.get(name);
	if (!node || selected.has(node)) return;
	selected.add(node);
	if (node.type !== "ImportDeclaration") for (const reference of freeReferences({ type: "Program", body: [node] })) include(reference.node.name);
}
const motionAst = parseSync("motion.js", motionSource).program;
for (const node of motionAst.body) if (node.type === "ImportDeclaration" && node.source.value.endsWith("/app-stage.jsx")) for (const spec of node.specifiers) include(spec.imported.name);
const reactImport = motionAst.body.find(node => node.type === "ImportDeclaration" && node.source.value === "react");
const nativeHooks = reactImport.specifiers.map(spec => spec.local.name).filter(name => !["useState", "useRef"].includes(name));
const hooksId = "virtual:ik-entry-cells";
const server = await createServer({ root: sourceRoot, configFile: false, appType: "custom",
	server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
	plugins: [{ name: "ik-entry-cpu", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${hooksId}`; }, load(id) {
		if (id === `\0${hooksId}`) return `
let cells = [], cursor = 0;
export function begin(reset = false) { cursor = 0; if (reset) cells = []; }
export function useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; }
export function useRef(initial) { return useState(() => ({ current: initial }))[0]; }
`;
		if (id.endsWith("/src/app-stage.jsx")) return stageAst.body.filter(node => selected.has(node)).map(node => stageSource.slice(node.start, node.end)).join("\n");
		if (id.endsWith("/src/domains/motion.js")) return motionSource.slice(0, reactImport.start)
			+ `import { ${nativeHooks.join(", ")} } from "react"; import { useState, useRef } from "${hooksId}";`
			+ motionSource.slice(reactImport.end);
		if (id.endsWith("/src/motion-store.js")) return `export * from '../test/bus/motion-cache-fixture.mjs';`;
	} }],
});
let useMotion, hooks;
try {
	({ useMotion } = await server.ssrLoadModule("/src/domains/motion.js"));
	hooks = await server.ssrLoadModule(hooksId);
} finally { await server.close(); }

const cameraAt = (position, yaw, pitch) => {
	const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100);
	camera.position.set(...position); camera.rotation.set(pitch, yaw, 0, "YXZ");
	return camera;
};
const cameraPose = camera => ({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray() });
function assertCameraPose(camera, expected, message) {
	assert.deepEqual(camera.position.toArray(), expected.position, message);
	// Changing Euler order after copying a quaternion can round a component.
	assert.ok(camera.quaternion.toArray().every((value, index) => Math.abs(value - expected.quaternion[index]) < 1e-12), message);
}
function assertRigVisible(camera, rig) {
	camera.updateMatrixWorld(true); rig.updateMatrixWorld(true);
	for (const name of ["Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot"]) {
		const bone = rig.getObjectByName(`mixamorig${name}`);
		assert.ok(bone, `the production rig has ${name}`);
		const point = bone.getWorldPosition(new THREE.Vector3()).project(camera);
		assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) < 1,
			`${name} remains inside the actual IK camera frustum: ${point.toArray()}`);
	}
}
for (const lookThroughShot of [false, true]) {
	const fixture = motionFixture(), scope = fixture.scope;
	const editor = cameraAt([4, 2.2, 7], 0.3, -0.12);
	const shot = cameraAt([-3, 2, 5], -0.4, -0.08);
	const poser = cameraAt([0.97, 1.62, 2.39], 0, 0);
	Object.assign(scope, {
		editorCamRef: { current: editor }, editorLook: { current: { yaw: 0.3, pitch: -0.12 } },
		shotCamRef: { current: shot }, poserCamRef: { current: poser }, poserLook: { current: { yaw: 0, pitch: 0 } },
		lookThroughShot, cameraPreviewEndRef: { current: null }, tlFrame: 12, tlPlaying: true,
		setTlPlaying(value) { scope.tlPlaying = value; },
		setTlFrame(value) { scope.tlFrame = typeof value === "function" ? value(scope.tlFrame) : value; scope.tlFrameRef.current = scope.tlFrame; },
	});
	scope.tlFrameRef.current = 12;
	const editorBefore = cameraPose(editor), shotBefore = cameraPose(shot), intentBefore = fixture.snapshot();
	hooks.begin(true);
	function render() {
		hooks.begin(); let motion;
		const shared = createShared(...sharedNames.map(name => scope[name]), {
			editorCamRef: scope.editorCamRef, editorLook: scope.editorLook,
		});
		function Mount() { motion = useMotion(scope.appContext.forRender(shared)); return null; }
		renderToStaticMarkup(createElement(Mount));
		return motion;
	}
	try {
		let motion = render();
		motion.toggleIkMode(); motion = render();
		assert.equal(motion.ikMode, true);
		assertCameraPose(poser, lookThroughShot ? shotBefore : editorBefore,
			`first real IK entry copies the ${lookThroughShot ? "shot" : "editor"} camera supplied by App`);
		assertRigVisible(poser, scope.activeRig);
		assert.deepEqual(scope.poserLook.current, lookThroughShot
			? { yaw: shot.rotation.y, pitch: shot.rotation.x } : scope.editorLook.current);
		assert.equal(scope.tlPlaying, false, "IK entry pauses playback without moving the playhead");
		assert.equal(scope.tlFrame, 12);
		// The navigation target is the poser only. These edits must survive an
		// exit/re-entry even when the editor and shot are moved afterwards.
		poser.position.set(6, 3, 8); poser.rotation.set(-0.2, 0.6, 0, "YXZ");
		scope.poserLook.current = { yaw: 0.6, pitch: -0.2 };
		const navigated = cameraPose(poser);
		assert.deepEqual(cameraPose(editor), editorBefore); assert.deepEqual(cameraPose(shot), shotBefore);
		motion.stepFrame(3); assert.equal(scope.tlFrame, 15);
		motion = render(); motion.toggleIkMode(); motion = render();
		assert.equal(motion.ikMode, false);
		editor.position.x += 2; shot.position.z += 2;
		motion.toggleIkMode(); motion = render();
		assertCameraPose(poser, navigated, "re-entry restores the user's remembered poser navigation");
		assertRigVisible(poser, scope.activeRig);
		assert.deepEqual(scope.poserLook.current, { yaw: 0.6, pitch: -0.2 });
		assert.equal(scope.tlFrame, 15);
		motion.advanceFrame(2); assert.equal(scope.tlFrame, 17, "frame stepping still follows the real motion-domain path");
		assert.deepEqual(fixture.snapshot(), intentBefore, "camera entry/navigation does not rewrite motion or IK keys");
	} finally { fixture.dispose(); }
}
console.log("PASS real motion-domain IK entry: App editor/shot references, remembered poser navigation and frame continuity (CPU)");

// Import may legitimately contain no motion rows, or preserve motion belonging
// to a former cast id. Neither case may detach the new cast's active IK state
// from the per-character map used when the actual handle drag is baked.
const { resolveIkRig } = await import(pathToFileURL(resolve(sourceRoot, "src/ardy/ik.js")).href);
for (const orphanRows of [[{ id: "char-a", ikKeys: [{ frame: 3, tracks: {
	head: { q: [{ x: 0, y: Math.sin(0.1), z: 0, w: Math.cos(0.1) }] },
} }] }], []]) {
	const fixture = motionFixture(), scope = fixture.scope;
	const owner = scope.appContext.storeDomain("motion");
	const importedCast = fixture.cast.read().map((character, index) => ({ ...character, id: `imported-${index}` }));
	const importedRigs = Object.values(fixture.rigs);
	for (const id of Object.keys(fixture.rigs)) delete fixture.rigs[id];
	importedCast.forEach((character, index) => { fixture.rigs[character.id] = importedRigs[index]; });
	fixture.cast.load(importedCast);
	Object.assign(scope, { characters: fixture.cast.read(), activeChar: importedCast[0], activeRig: importedRigs[0], tlFrame: 11 });
	scope.tlFrameRef.current = 11;
	fixture.live.current.timeline.currentFrame = 11;
	owner.load(orphanRows); owner.switchLayer(importedCast[0].id);
	const before = owner.document(), originalRigs = importedRigs.map(rig => fixture.actual.snapshotExportRig(rig));
	const initialStates = importedCast.map(character => scope.ikStatesRef.current.get(character.id));
	const previousWindow = globalThis.window;
	globalThis.window = new EventTarget();
	hooks.begin(true);
	function renderMotion() {
		hooks.begin(); let motion;
		function Mount() { motion = useMotion(scope.appContext); return null; }
		renderToStaticMarkup(createElement(Mount));
		return motion;
	}
	try {
		let motion = renderMotion();
		for (let index = 0; index < importedCast.length; index++) {
			const character = importedCast[index], rig = importedRigs[index];
			scope.activeChar = character; scope.activeRig = rig; scope.activeCharIndex = index;
			owner.switchLayer(character.id);
			const resolved = resolveIkRig(rig);
			// App's rig-ready initialisation populates this same active ref.
			Object.assign(scope.ikStateRef.current, resolved, { rig });
			motion = renderMotion();
			const previousDocument = owner.document(), previousRig = fixture.actual.snapshotExportRig(rig);
			const otherRig = fixture.actual.snapshotExportRig(importedRigs[1 - index]);
			const previousDepth = owner.documentStore.depths().past;
			const hand = resolved.chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
			owner.beginGesture(); // the real pointerdown owner captures the pre-drag pose
			// The owner registers pointerup during window capture pointerdown;
			// IkHandles registers its drag end later, from canvas pointerdown.
			// Dispatch this actual listener order instead of calling end first.
			window.addEventListener("pointerup", () => motion.ikDragEnd(), { once: true });
			for (const offset of [0.12, 0.2]) motion.ikSolve("chain", "leftHand", hand.clone().add(new THREE.Vector3(offset, 0.1, 0)));
			assert.ok(scope.ikStateRef.current.tracked.has("leftHand"));
			assert.notDeepEqual(fixture.actual.snapshotExportRig(rig), previousRig, "the real handle solve moves the live bones");
			assert.deepEqual(owner.document(), previousDocument, "pointer moves do not author a key before drag end");
			window.dispatchEvent(new Event("pointerup"));
			assert.equal(owner.layer(character.id).ikKeys.length, 1,
				"the actual drag end must persist a new cast member's key even without a take or matching imported motion row");
			assert.equal(owner.layer(character.id).ikKeys[0].frame, 11);
			assert.ok(owner.layer(character.id).ikKeys[0].tracks.leftHand);
			assert.equal(scope.ikStateRef.current, scope.ikStatesRef.current.get(character.id), "active ref and character map share the touched state");
			assert.equal(scope.ikStateRef.current, initialStates[index], "project and character switches reuse the registered state identity");
			assert.notEqual(initialStates[0], initialStates[1], "the two cast members own separate IK states");
			assert.equal(owner.documentStore.depths().past, previousDepth + 1, "one complete drag creates one undo entry");
			assert.deepEqual(fixture.actual.snapshotExportRig(importedRigs[1 - index]), otherRig, "dragging one actor leaves the other rig unchanged");
			assert.deepEqual(owner.layer(importedCast[1 - index].id).ikKeys,
				previousDocument.motion.find(row => row.id === importedCast[1 - index].id)?.ikKeys ?? []);
			const authored = owner.document(), authoredRig = fixture.actual.snapshotExportRig(rig);
			assert.equal(fixture.run("edit.undo").ok, true);
			assert.deepEqual(owner.document(), previousDocument, "one undo restores the previous saved motion/IK intent");
			assert.deepEqual(fixture.actual.snapshotExportRig(rig), previousRig, "undo restores the pre-pointerdown rig pose");
			assert.equal(fixture.run("edit.redo").ok, true);
			assert.deepEqual(owner.document(), authored); assert.deepEqual(fixture.actual.snapshotExportRig(rig), authoredRig);
		}
		const saved = await owner.portableDocument();
		assert.deepEqual(saved.motion.filter(row => row.id === "char-a"), before.motion.filter(row => row.id === "char-a"),
			"an imported orphan's user-authored keys are retained unchanged");
		const posedRigs = importedRigs.map(rig => fixture.actual.snapshotExportRig(rig));
		owner.load(saved.motion); owner.switchLayer(importedCast[0].id);
		assert.deepEqual(owner.document().motion, saved.motion, "portable save/reload retains both new actors' dragged keys");
		importedCast.forEach((character, index) => {
			assert.equal(scope.ikStatesRef.current.get(character.id), initialStates[index]);
			assert.deepEqual(fixture.actual.snapshotExportRig(importedRigs[index]), posedRigs[index], "reload evaluates the saved pose on the correct rig");
		});
		for (const cancellation of ["pointercancel", "Escape"]) {
			scope.activeChar = importedCast[0]; scope.activeRig = importedRigs[0]; scope.tlFrame = 12;
			scope.tlFrameRef.current = 12; fixture.live.current.timeline.currentFrame = 12;
			owner.switchLayer(scope.activeChar.id); motion = renderMotion();
			const cancelledDocument = owner.document(), cancelledRig = fixture.actual.snapshotExportRig(scope.activeRig);
			const cancelledDepths = owner.documentStore.depths();
			const hand = scope.ikStateRef.current.chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
			owner.beginGesture();
			const onIkUp = () => {
				window.removeEventListener("pointerup", onIkUp); window.removeEventListener("pointercancel", onIkUp);
				motion.ikDragEnd();
			};
			window.addEventListener("pointerup", onIkUp); window.addEventListener("pointercancel", onIkUp);
			motion.ikSolve("chain", "leftHand", hand.clone().add(new THREE.Vector3(0.2, 0.1, 0)));
			if (cancellation === "Escape") {
				const escape = new Event("keydown"); escape.key = "Escape"; window.dispatchEvent(escape);
				motion.ikSolve("chain", "leftHand", hand.clone().add(new THREE.Vector3(0.35, 0.1, 0)));
				window.dispatchEvent(new Event("pointerup"));
			} else window.dispatchEvent(new Event("pointercancel"));
			assert.deepEqual(owner.document(), cancelledDocument, `${cancellation} cannot let the later IK end author a cancelled key`);
			assert.deepEqual(fixture.actual.snapshotExportRig(scope.activeRig), cancelledRig, `${cancellation} restores the pre-drag bones`);
			assert.deepEqual(owner.documentStore.depths(), cancelledDepths, `${cancellation} creates no undo entry`);
		}
		assert.notDeepEqual(posedRigs, originalRigs);
	} finally {
		fixture.dispose();
		if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
	}
}
console.log("PASS real motion-domain drag persistence: native listener order, empty/orphan imports, two actors, one undo/redo, portable reload and cancellation (CPU)");
