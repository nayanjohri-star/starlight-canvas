import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { canonicalCskel27Reference, poseToCskel27 } from "../src/ardy/to-cskel27.js";
import {
	bakeExtractedTake,
	collectLandmarkTrack,
	normalizeLandmarkSample,
	selectMostConfidentPerson,
	videoLandmarksToPoseKeys,
} from "../src/pose-extract/index.js";

const rest = JSON.parse(readFileSync(new URL("../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));
const indexOf = Object.fromEntries(CSKEL27_JOINTS.map((name, index) => [name, index]));

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance = 1e-6) { return Math.abs(a - b) <= tolerance; }

function landmarkFrame(timeS, lift = 0, hidden = []) {
	const points = new Array(33).fill(null).map(() => [0, 1, 0]);
	const set = (index, x, y, z = 0) => { points[index] = [x, y, z]; };
	set(0, 0, 1.72, 0.08);
	set(2, 0.04, 1.75, 0.04); set(5, -0.04, 1.75, 0.04);
	set(7, 0.09, 1.7, 0); set(8, -0.09, 1.7, 0);
	set(11, 0.26, 1.42); set(12, -0.26, 1.42);
	set(13, 0.56 - lift * 0.25, 1.42 + lift * 0.3, 0.02);
	set(15, 0.82 - lift * 0.62, 1.42 + lift * 0.63, 0.04);
	set(17, 0.9 - lift * 0.7, 1.42 + lift * 0.72, 0.08);
	set(19, 0.91 - lift * 0.71, 1.42 + lift * 0.75, 0.04);
	set(14, -0.56, 1.42, 0.02); set(16, -0.82, 1.42, 0.04);
	set(18, -0.9, 1.42, 0.08); set(20, -0.91, 1.42, 0.04);
	set(23, 0.15, 0.92); set(24, -0.15, 0.92);
	set(25, 0.15, 0.5); set(26, -0.15, 0.5);
	set(27, 0.15, 0.08); set(28, -0.15, 0.08);
	set(29, 0.15, 0.03, -0.05); set(30, -0.15, 0.03, -0.05);
	set(31, 0.15, 0, 0.2); set(32, -0.15, 0, 0.2);
	return {
		timeS,
		landmarks: points.map(([x, y, z], index) => ({
			x,
			y: -y,
			z: -z,
			visibility: hidden.includes(index) ? 0.05 : 0.99,
		})),
	};
}

const raw = [
	landmarkFrame(0, 0),
	landmarkFrame(0.25, 0.45),
	landmarkFrame(0.5, 1),
	landmarkFrame(0.75, 0.45),
	landmarkFrame(1, 0),
];
const normalized = normalizeLandmarkSample(raw[0]);
assert.equal(normalized.valid, true);
assert.ok(near(normalized.landmarks[23].position[1] + normalized.landmarks[24].position[1], 0));
pass("coordinates are hip-centred, torso-scaled and Y-up");

const result = videoLandmarksToPoseKeys({ samples: raw, rest, fps: 20, maxKeys: 5, minSpacingS: 0.2 });
assert.ok(result.keys.length >= 3);
assert.deepEqual(result.keys.map((key) => key.frame).slice(0, 1), [0]);
assert.equal(result.keys.at(-1).frame, 20);
assert.ok(result.diagnostics.some((entry) => entry.sampleIndex === 2));
assert.ok(result.keys.every((key) => key.pose.schema === "cozyclay.pose.v1"));
assert.ok(result.keys.every((key) => Object.keys(key.pose.bones).length === 19));
pass("pose-change peak selection emits ordinary frame/pose keys on the 20 fps grid");

function determinant(m) {
	return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
		- m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
		+ m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

const raisedEntry = result.keys[result.diagnostics.findIndex((entry) => entry.sampleIndex === 2)];
const fitted = poseToCskel27({ pose: raisedEntry.pose, rest });
for (const matrix of fitted.local_rot_mats) {
	for (let row = 0; row < 3; row += 1) {
		const length = Math.hypot(...matrix[row]);
		assert.ok(near(length, 1, 1e-6));
		for (let other = row + 1; other < 3; other += 1) {
			const dot = matrix[row].reduce((sum, value, column) => sum + value * matrix[other][column], 0);
			assert.ok(near(dot, 0, 1e-6));
		}
	}
	assert.ok(near(determinant(matrix), 1, 1e-6));
}
pass("all fitted cskel27 matrices are right-handed and orthonormal");

const neutral = canonicalCskel27Reference().posed_joints;
for (const [parent, child] of [["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"], ["LeftUpLeg", "LeftLeg"], ["LeftLeg", "LeftFoot"]]) {
	const a = indexOf[parent];
	const b = indexOf[child];
	const expected = Math.hypot(...neutral[b].map((value, axis) => value - neutral[a][axis]));
	const actual = Math.hypot(...fitted.posed_joints[b].map((value, axis) => value - fitted.posed_joints[a][axis]));
	assert.ok(near(actual, expected, 1e-6), `${parent}->${child} length changed`);
}
assert.ok(fitted.posed_joints[indexOf.LeftForeArm][1] > fitted.posed_joints[indexOf.LeftArm][1]);
pass("fitting preserves cskel27 limb lengths and follows the raised-arm direction");

const hidden = landmarkFrame(0, 0, [15, 17, 19]);
const hiddenResult = videoLandmarksToPoseKeys({ samples: [hidden], rest, maxKeys: 1 });
assert.ok(hiddenResult.diagnostics[0].releasedBones.includes("LeftForeArm"));
assert.ok(hiddenResult.diagnostics[0].releasedBones.includes("LeftHand"));
pass("low-visibility landmarks release their affected limb targets");

const personLow = landmarkFrame(0, 0).landmarks.map((point) => ({ ...point, visibility: 0.2 }));
const personHigh = landmarkFrame(0, 0).landmarks;
assert.equal(selectMostConfidentPerson({ worldLandmarks: [personLow, personHigh] }), personHigh);
async function* frames() { yield { image: "frame-a", timeS: 0 }; yield { image: "frame-b", timeS: 0.5 }; }
const progress = [];
const collected = await collectLandmarkTrack({
	frames: frames(),
	detect: async (_image, timeMs) => ({ worldLandmarks: [timeMs === 0 ? personLow : personHigh] }),
	onProgress: (entry) => progress.push(entry),
});
assert.equal(collected.length, 2);
assert.equal(progress.at(-1).processed, 2);
pass("browser detector boundary shares one async frame path for upload and webcam");

const bake = bakeExtractedTake({ samples: raw, rest, fps: 20, durationS: 1 });
assert.equal(bake.frames, 21); // frameCountFor's rule: 1 s at 20 fps
assert.equal(bake.fps, 20);
assert.equal(bake.fitted, 5); // samples at 0, .25, .5, .75, 1 land on frames 0, 5, 10, 15, 20
assert.equal(bake.held, 16); // every other grid frame holds its predecessor
assert.equal(bake.rotMats.length, 21 * 27 * 9);
assert.equal(bake.posedJoints.length, 21 * 27 * 3);
assert.equal(bake.rootPos.length, 21 * 3);
for (const value of bake.rotMats) assert.ok(Number.isFinite(value));
for (const value of bake.posedJoints) assert.ok(Number.isFinite(value));
pass("baking fills the npz motion shape densely from sparse fitted samples");

// A held frame is byte-identical to the fitted frame it holds.
const jointsStride = 27 * 9;
for (let i = 0; i < jointsStride; i += 1) {
	assert.equal(bake.rotMats[3 * jointsStride + i], bake.rotMats[0 * jointsStride + i]);
}
pass("holes hold the previous fitted frame, never a T-pose");

// A leading hole backfills from the first fitted frame.
const lateStart = bakeExtractedTake({ samples: raw.slice(1).map((s) => s), rest, fps: 20, durationS: 1 });
for (let i = 0; i < jointsStride; i += 1) {
	assert.equal(lateStart.rotMats[0 * jointsStride + i], lateStart.rotMats[5 * jointsStride + i]);
}
pass("a leading detection hole backfills from the first fitted frame");

// The root track rides the Hips joint of each baked frame.
assert.equal(bake.rootPos[0], bake.posedJoints[0]);
assert.equal(bake.rootPos[1], bake.posedJoints[1]);
assert.equal(bake.rootPos[2], bake.posedJoints[2]);
pass("rootPos is the baked Hips trajectory");

const noPerson = (() => {
	try {
		bakeExtractedTake({
			samples: [{ timeS: 0, landmarks: new Array(33).fill({ x: 0, y: 0, z: 0, visibility: 0.01 }) }],
			rest,
			fps: 20,
			durationS: 1,
		});
		return null;
	} catch (error) { return error.message; }
})();
assert.equal(noPerson, "no-usable-pose");
pass("a track with no fittable sample is refused by name");

console.log("all video-to-pose-key checks PASS");
