#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	addShotAtFrame,
	cameraAtFrame,
	createShot,
	cutAtFrame,
	duplicateShot,
	initialShots,
	removeShot,
	reorderShot,
	resizeShot,
	shotAtFrame,
	shotIndexAtFrame,
} from "../src/cuts.js";

const framing = (x) => ({ pos: { x, y: 1.6, z: 3 }, yaw: 0, pitch: 0, fovDeg: 45 });
const key = (frame, x = frame) => ({ frame, framing: framing(x) });

assert.deepEqual(initialShots(300), [], "new timelines start with zero Shots");
assert.equal(shotIndexAtFrame([], 0), -1);
assert.equal(shotAtFrame([], 0), null);
assert.equal(cameraAtFrame([], { x: 0, z: 0 }, 0), null, "uncovered time belongs to the free camera");

let shots = addShotAtFrame([], 20, 200, framing(20));
assert.deepEqual(shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59]], "add creates a free 40-frame card");
assert.equal(shotAtFrame(shots, 19), null);
assert.equal(shotAtFrame(shots, 20), shots[0]);
assert.equal(shotAtFrame(shots, 59), shots[0]);
assert.equal(shotAtFrame(shots, 60), null);
assert.equal(cameraAtFrame(shots, { x: 0, z: 0 }, 19), null);
assert.equal(cameraAtFrame(shots, { x: 0, z: 0 }, 20).pos.x, 20);

const fourSecond = [createShot("Long", 0, 79)];
const addOverLong = addShotAtFrame(fourSecond, 20, 200, framing(20));
assert.deepEqual(addOverLong.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[0, 79], [80, 119]], "add after an occupied 4-second Shot preserves it and creates a separate 2-second Shot");
assert.equal(addOverLong[0], fourSecond[0], "add never rewrites the occupied Shot");

shots = addShotAtFrame(shots, 100, 200, framing(100));
assert.deepEqual(shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59], [100, 139]], "gaps remain valid");

const overlapMove = reorderShot(shots, shots[1].id, 40, 200);
assert.equal(overlapMove, shots, "body moves that overlap are rejected");
const moved = reorderShot(shots, shots[1].id, 145, 200);
assert.deepEqual(moved.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59], [145, 184]]);
assert.equal(moved[1].cameraKeys[0].frame, 145, "keys travel with their card");

const overlapResize = resizeShot(shots, shots[0].id, "end", 110, 200);
assert.equal(overlapResize, shots, "edge resize that overlaps is rejected");
const resized = resizeShot(shots, shots[0].id, "end", 80, 200);
assert.deepEqual([resized[0].startFrame, resized[0].endFrame], [20, 80]);
const startResized = resizeShot(resized, resized[1].id, "start", 90, 200);
assert.deepEqual([startResized[1].startFrame, startResized[1].endFrame], [90, 139]);

const split = cutAtFrame(shots, shots[0].id, 40, framing(40));
assert.deepEqual(split.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 39], [40, 59], [100, 139]]);
assert.throws(() => cutAtFrame(shots, "missing", 80, framing(80)), /Unknown shots ID: missing/, "unknown shot IDs fail explicitly");
assert.equal(split[1].cameraKeys.some((entry) => entry.frame === 40), true);

const removedMiddle = removeShot(split, split[1].id);
assert.deepEqual(removedMiddle.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 39], [100, 139]], "delete leaves an empty gap");
const removedAll = removeShot(removeShot(removedMiddle, removedMiddle[1].id), removedMiddle[0].id);
assert.deepEqual(removedAll, [], "the final Shot is deletable");

const duplicated = duplicateShot(shots, shots[0].id, 200);
assert.deepEqual(duplicated.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[20, 59], [60, 99], [100, 139]]);
assert.notEqual(duplicated[0].camera, duplicated[1].camera);
const fullShot = createShot("Full", 0, 99);
assert.equal(duplicateShot([fullShot], fullShot.id, 100).length, 1, "duplicate rejects a timeline with no free range");

const railCamera = { mode: "rail", cameraRail: [{ x: 0, z: 0 }, { x: 2, z: 2 }], railFollow: { mode: "range", startFrame: 5, endFrame: 20 } };
const railShot = createShot("Rail", 10, 49, [key(10)], railCamera);
const railMoved = reorderShot([railShot], railShot.id, 80, 200)[0];
assert.equal(railMoved.camera.mode, "rail");
assert.deepEqual(railMoved.camera.railFollow, railCamera.railFollow, "local Rail schedule travels unchanged");

console.log("optional Shot overlay model verified");
