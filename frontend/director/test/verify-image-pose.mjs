// verify-image-pose.mjs — the still-image pose path. A single photograph is
// the degenerate case of the footage path: one frame, no keyframe selection,
// no held frames. These checks pin the three pieces that differ from video —
// the single-frame supply, the IMAGE-mode detector call, and the one-frame
// bake — so "set the pose from a photo" cannot silently regress into the
// video contract.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import {
	bakePoseFrame,
	collectLandmarkTrack,
	createPoseDetector,
	imageFrames,
} from "../src/pose-extract/index.js";

const rest = JSON.parse(readFileSync(new URL("../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));

function pass(label) { console.log(`PASS ${label}`); }

function standingLandmarks() {
	const points = new Array(33).fill(null).map(() => [0, 1, 0]);
	const set = (index, x, y, z = 0) => { points[index] = [x, y, z]; };
	set(0, 0, 1.72, 0.08);
	set(2, 0.04, 1.75, 0.04); set(5, -0.04, 1.75, 0.04);
	set(7, 0.09, 1.7, 0); set(8, -0.09, 1.7, 0);
	set(11, 0.26, 1.42); set(12, -0.26, 1.42);
	set(13, 0.56, 1.42, 0.02); set(15, 0.82, 1.42, 0.04);
	set(17, 0.9, 1.42, 0.08); set(19, 0.91, 1.42, 0.04);
	set(14, -0.56, 1.42, 0.02); set(16, -0.82, 1.42, 0.04);
	set(18, -0.9, 1.42, 0.08); set(20, -0.91, 1.42, 0.04);
	set(23, 0.15, 0.92); set(24, -0.15, 0.92);
	set(25, 0.15, 0.5); set(26, -0.15, 0.5);
	set(27, 0.15, 0.08); set(28, -0.15, 0.08);
	set(29, 0.15, 0.03, -0.05); set(30, -0.15, 0.03, -0.05);
	set(31, 0.15, 0, 0.2); set(32, -0.15, 0, 0.2);
	return points.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility: 0.99 }));
}

/* --- imageFrames: exactly one frame, at t=0 --------------------------------- */

function fakeImage() {
	const listeners = new Map();
	return {
		naturalWidth: 0,
		complete: false,
		addEventListener(type, fn) { listeners.set(type, fn); },
		removeEventListener(type) { listeners.delete(type); },
		set src(value) {
			this._src = value;
			// Decode resolves on the next turn, exactly like a real element.
			queueMicrotask(() => {
				this.naturalWidth = 640;
				this.complete = true;
				listeners.get("load")?.();
			});
		},
		get src() { return this._src; },
	};
}

const frames = [];
for await (const frame of imageFrames("blob:still", { createImage: fakeImage })) frames.push(frame);
assert.equal(frames.length, 1, "a still supplies exactly one frame");
assert.equal(frames[0].timeS, 0, "the single frame sits at t=0");
assert.ok(frames[0].image, "the frame carries the decoded image");
pass("imageFrames yields one frame at t=0");

const failing = {
	addEventListener(type, fn) { if (type === "error") queueMicrotask(fn); },
	removeEventListener() {},
	set src(value) { this._src = value; },
	get src() { return this._src; },
};
await assert.rejects(
	async () => { for await (const _ of imageFrames("blob:broken", { createImage: () => failing })) void _; },
	/decode-failed/,
	"an undecodable still fails by name",
);
pass("imageFrames names a decode failure");

/* --- detector: IMAGE mode uses detect(), VIDEO keeps detectForVideo --------- */

function stubRuntime(record) {
	return {
		FilesetResolver: { forVisionTasks: async () => ({}) },
		PoseLandmarker: {
			createFromOptions: async (_fileset, options) => {
				record.runningMode = options.runningMode;
				return {
					detect: (image) => { record.calls.push(["detect", image]); return { worldLandmarks: [] }; },
					detectForVideo: (image, ts) => { record.calls.push(["detectForVideo", image, ts]); return { worldLandmarks: [] }; },
					close: () => { record.closed = true; },
				};
			},
		},
	};
}

const imageRecord = { calls: [] };
const imageDetector = await createPoseDetector({
	runningMode: "IMAGE",
	loadRuntime: async () => stubRuntime(imageRecord),
	fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
});
assert.equal(imageRecord.runningMode, "IMAGE", "the landmarker is built in IMAGE mode");
imageDetector.detect("frame", 0);
assert.deepEqual(imageRecord.calls[0], ["detect", "frame"], "IMAGE mode calls detect without a timestamp");
pass("createPoseDetector honours IMAGE mode");

const videoRecord = { calls: [] };
const videoDetector = await createPoseDetector({
	loadRuntime: async () => stubRuntime(videoRecord),
	fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
});
assert.equal(videoRecord.runningMode, "VIDEO", "the default stays VIDEO for footage");
videoDetector.detect("frame", 40.4);
assert.deepEqual(videoRecord.calls[0], ["detectForVideo", "frame", 40], "VIDEO mode still rounds the timestamp");
pass("createPoseDetector keeps the VIDEO contract");

/* --- collectLandmarkTrack drives the still supply unchanged ----------------- */

const samples = await collectLandmarkTrack({
	frames: imageFrames("blob:still", { createImage: fakeImage }),
	detect: () => ({ worldLandmarks: [standingLandmarks()] }),
});
assert.equal(samples.length, 1, "a still produces one landmark sample");
pass("collectLandmarkTrack accepts a still supply");

/* --- bakePoseFrame: one frame, nothing held -------------------------------- */

const joints = CSKEL27_JOINTS.length;
const take = bakePoseFrame({ samples, rest, createdMs: 7 });
assert.equal(take.frames, 1, "a still bakes to exactly one frame");
assert.equal(take.fitted, 1, "the single frame is measured, not held");
assert.equal(take.held, 0, "a still holds nothing");
assert.equal(take.rotMats.length, joints * 9, "rotations cover every cskel27 joint once");
assert.equal(take.posedJoints.length, joints * 3, "posed joints cover every cskel27 joint once");
assert.ok(Array.from(take.rotMats).every(Number.isFinite), "every baked rotation is finite");
assert.ok(Array.from(take.posedJoints).every(Number.isFinite), "every baked joint is finite");
pass("bakePoseFrame bakes a single measured frame");

assert.throws(
	() => bakePoseFrame({ samples: [], rest }),
	/no-usable-pose/,
	"a still with no person is a named failure",
);
pass("bakePoseFrame names an empty still");

console.log("image-pose: OK");
