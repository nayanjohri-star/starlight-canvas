#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	insertStableItemBefore,
	removeStableItem,
	updateStableItem,
} from "../src/stable-items.js";
import {
	moveCameraKey,
	removeCameraKey,
	renameShot,
} from "../src/cuts.js";
import { readSceneDocument, serializeSceneDocument } from "../src/scenes.js";
import { readShotAuthoring, serializeShotAuthoring } from "../src/shot-authoring.js";
import { toArdyWaypoints } from "../src/ardy/waypoints.js";

const framing = (fovDeg) => ({ pos: { x: 1, y: 1.6, z: 2.4 }, yaw: 0.2, pitch: -0.1, fovDeg });

function assertInsertBeforeTargetsStableId({ name, items, inserted, targetId, update }) {
	const afterInsert = insertStableItemBefore(items, targetId, inserted, name);
	const afterUpdate = update(afterInsert, targetId);
	assert.equal(afterUpdate.find((item) => item.id === targetId).changed, true, `${name}: target B changes by ID after insertion`);
	assert.equal(afterUpdate[1].id, inserted.id, `${name}: the item now at B's former index stays untouched`);
}

// Given: each persisted collection contains A and B with stable identities.
// When: a new item is inserted before B and B is edited through its retained ID.
// Then: B changes while the item at B's old index does not.
assertInsertBeforeTargetsStableId({
	name: "waypoints",
	items: [{ id: "waypoint-a", frame: 24, x: 1, z: 2 }, { id: "waypoint-b", frame: 48, x: 3, z: 4 }],
	inserted: { id: "waypoint-new", frame: 36, x: 2, z: 3 },
	targetId: "waypoint-b",
	update: (items, id) => updateStableItem(items, id, (item) => ({ ...item, changed: true }), "waypoints"),
});
assertInsertBeforeTargetsStableId({
	name: "promptClips",
	items: [{ id: "prompt-a", startFrame: 0, endFrame: 24, text: "A" }, { id: "prompt-b", startFrame: 24, endFrame: 48, text: "B" }],
	inserted: { id: "prompt-new", startFrame: 12, endFrame: 24, text: "new" },
	targetId: "prompt-b",
	update: (items, id) => updateStableItem(items, id, (item) => ({ ...item, changed: true }), "promptClips"),
});

const shots = [
	{ id: "shot-a", name: "A", startFrame: 0, endFrame: 19, cameraKeys: [], camera: { mode: "keys" } },
	{ id: "shot-b", name: "B", startFrame: 40, endFrame: 59, cameraKeys: [], camera: { mode: "keys" } },
];
const insertedShot = { id: "shot-new", name: "New", startFrame: 20, endFrame: 39, cameraKeys: [], camera: { mode: "keys" } };
const shotsAfterInsert = insertStableItemBefore(shots, "shot-b", insertedShot, "shots");
const shotsAfterRename = renameShot(shotsAfterInsert, "shot-b", "B changed");
assert.equal(shotsAfterRename.find((shot) => shot.id === "shot-b").name, "B changed", "shots: target B changes by ID after insertion");
assert.equal(shotsAfterRename[1].id, "shot-new", "shots: the item now at B's former index stays untouched");

const cameraKeys = [
	{ id: "camera-key-a", frame: 0, framing: framing(40) },
	{ id: "camera-key-b", frame: 20, framing: framing(50) },
];
const keysAfterInsert = insertStableItemBefore(cameraKeys, "camera-key-b", { id: "camera-key-new", frame: 10, framing: framing(45) }, "cameraKeys");
const keysAfterMove = moveCameraKey(keysAfterInsert, "camera-key-b", 30);
assert.equal(keysAfterMove.find((key) => key.id === "camera-key-b").frame, 30, "cameraKeys: target B changes by ID after insertion");
assert.equal(keysAfterMove[1].id, "camera-key-new", "cameraKeys: the item now at B's former index stays untouched");

// Given: unknown IDs are supplied to every editor mutation seam.
// When: the mutation is attempted.
// Then: it fails explicitly instead of selecting an index or silently doing nothing.
for (const [name, mutate] of [
	["waypoints", () => updateStableItem([], "missing", (item) => item, "waypoints")],
	["promptClips", () => removeStableItem([], "missing", "promptClips")],
	["cameraKeys", () => removeCameraKey(cameraKeys, "missing")],
	["shots", () => renameShot(shots, "missing", "Nope")],
]) {
	assert.throws(mutate, /Unknown .* ID: missing/, `${name}: unknown ID fails explicitly`);
}

// Given: legacy persisted documents without stable IDs, including duplicate IDs.
// When: their parsing boundaries normalize them.
// Then: IDs are deterministic and unique while all semantic fields survive.
const legacyStage = {
	characters: [{ id: "char-a", layer: {
		waypoints: [{ id: "duplicate-waypoint", frame: 24, x: 1, z: 2, heading: null }, { id: "duplicate-waypoint", frame: 48, x: 3, z: 4, heading: 0.5 }, { frame: 72, x: 5, z: 6, heading: null }],
		promptClips: [{ id: "duplicate-prompt", startFrame: 0, endFrame: 24, text: "walk" }, { id: "duplicate-prompt", startFrame: 24, endFrame: 48, text: "stop" }, { startFrame: 48, endFrame: 72, text: "turn" }],
	} }],
};
const legacySceneRaw = JSON.stringify({ version: 4, activeSceneId: "scene", scenes: [{ id: "scene", name: "Set", objects: [], shotDocument: null, stage: legacyStage }] });
const legacyScene = readSceneDocument(legacySceneRaw).document;
const legacyLayer = legacyScene.scenes[0].stage.characters[0].layer;
assert.deepEqual(legacyLayer.waypoints.map(({ id, ...waypoint }) => waypoint), legacyStage.characters[0].layer.waypoints.map(({ id, ...waypoint }) => waypoint), "legacy waypoints retain semantic fields");
assert.deepEqual(legacyLayer.promptClips.map(({ id, ...clip }) => clip), legacyStage.characters[0].layer.promptClips.map(({ id, ...clip }) => clip), "legacy prompt clips retain semantic fields");
assert.deepEqual(readSceneDocument(legacySceneRaw).document.scenes[0].stage.characters[0].layer, legacyLayer, "legacy stage IDs are deterministic");
assert.equal(new Set(legacyLayer.waypoints.map((item) => item.id)).size, legacyLayer.waypoints.length, "legacy waypoint IDs are unique");
assert.equal(new Set(legacyLayer.promptClips.map((item) => item.id)).size, legacyLayer.promptClips.length, "legacy prompt IDs are unique");

const legacyShotRaw = JSON.stringify({
	version: 4,
	frameCount: 80,
	waypoints: [{ id: "duplicate-waypoint", frame: 24, x: 1, z: 2, heading: null }, { id: "duplicate-waypoint", frame: 48, x: 3, z: 4, heading: null }, { frame: 72, x: 5, z: 6, heading: null }],
	shots: [{ id: "duplicate", startFrame: 0, endFrame: 39, cameraKeys: [{ id: "duplicate-camera-key", frame: 0, framing: framing(40) }, { id: "duplicate-camera-key", frame: 20, framing: framing(50) }, { frame: 30, framing: framing(55) }] }, { id: "duplicate", startFrame: 40, endFrame: 79, cameraKeys: [{ id: "duplicate-camera-key", frame: 40, framing: framing(60) }] }],
});
const legacyShot = readShotAuthoring(legacyShotRaw).state;
assert.equal(new Set(legacyShot.waypoints.map((item) => item.id)).size, legacyShot.waypoints.length, "parsed shot-document waypoint IDs are unique");
assert.equal(new Set(legacyShot.shots.map((item) => item.id)).size, legacyShot.shots.length, "parsed shot IDs are unique");
assert.ok(legacyShot.shots.every((shot) => new Set(shot.cameraKeys.map((item) => item.id)).size === shot.cameraKeys.length), "parsed camera-key IDs are unique");
assert.deepEqual(readShotAuthoring(legacyShotRaw).state, legacyShot, "legacy shot IDs are deterministic");

// Given: normalized documents are saved and reopened.
// When: both project envelopes make a round trip.
// Then: all stable IDs survive unchanged.
const sceneRoundTrip = readSceneDocument(serializeSceneDocument(legacyScene)).document;
assert.deepEqual(sceneRoundTrip.scenes[0].stage.characters[0].layer, legacyLayer, "scene save/open preserves layer IDs");
const shotRoundTrip = readShotAuthoring(serializeShotAuthoring(legacyShot)).state;
assert.deepEqual(shotRoundTrip, legacyShot, "shot-document save/open preserves IDs");

// Given: authored IDs are present internally.
// When: the ARDY waypoint payload is built.
// Then: external semantic payload fields remain unchanged and IDs do not leave the app.
const ardyPayload = toArdyWaypoints(legacyLayer.waypoints, 0);
assert.deepEqual(ardyPayload, [
	{ frame: 24, x: 0, z: 0, heading: null },
	{ frame: 48, x: 2, z: 2, heading: 0.5 },
	{ frame: 72, x: 4, z: 4, heading: null },
], "ARDY waypoint semantics are unchanged and IDs stay internal");

console.log("stable ID checks PASS");
