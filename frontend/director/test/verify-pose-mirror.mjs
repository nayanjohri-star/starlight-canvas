// verify-pose-mirror.mjs — the still-photo accuracy pass. A photograph gives
// one detection of one frame: no neighbour to average with, no filter to run,
// so every landmark error lands whole in the saved pose. The fix is to measure
// the still twice — as shot and horizontally mirrored — and average. These
// checks pin the three things that can silently ruin that: the left/right index
// table (a wrong pair swaps the character's arms), the weighted average (a
// wrong weight lets an unseen limb outvote a seen one), and the two-pass
// detection wiring (a missed fallback loses a person the model did find).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitLandmarksToPose } from "../src/pose-extract/fit.js";
import { normalizeLandmarkSample } from "../src/pose-extract/landmarks.js";
import { POSE_MODELS, POSE_MODEL_URL, POSE_MODEL_URL_HEAVY } from "../src/pose-extract/detector.js";
import {
	LEFT_RIGHT_PAIRS,
	averageLandmarkSets,
	detectMirrorAveraged,
	mirrorLandmarks,
} from "../src/pose-extract/mirror.js";

const rest = JSON.parse(readFileSync(new URL("../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance = 1e-9) { return Math.abs(a - b) <= tolerance; }

/** Y-up world points of a standing person, arms out, left arm raised by `lift`. */
function standingPoints(lift = 0) {
	const points = new Array(33).fill(null).map(() => [0, 1, 0]);
	const set = (index, x, y, z = 0) => { points[index] = [x, y, z]; };
	set(0, 0, 1.72, 0.08);
	set(1, 0.02, 1.75, 0.05); set(2, 0.04, 1.75, 0.04); set(3, 0.06, 1.75, 0.03);
	set(4, -0.02, 1.75, 0.05); set(5, -0.04, 1.75, 0.04); set(6, -0.06, 1.75, 0.03);
	set(7, 0.09, 1.7, 0); set(8, -0.09, 1.7, 0);
	set(9, 0.03, 1.66, 0.06); set(10, -0.03, 1.66, 0.06);
	set(11, 0.26, 1.42); set(12, -0.26, 1.42);
	set(13, 0.56 - lift * 0.25, 1.42 + lift * 0.3, 0.02);
	set(15, 0.82 - lift * 0.62, 1.42 + lift * 0.63, 0.04);
	set(17, 0.9 - lift * 0.7, 1.42 + lift * 0.72, 0.08);
	set(19, 0.91 - lift * 0.71, 1.42 + lift * 0.75, 0.04);
	set(21, 0.88 - lift * 0.68, 1.42 + lift * 0.7, 0.06);
	set(14, -0.56, 1.42, 0.02); set(16, -0.82, 1.42, 0.04);
	set(18, -0.9, 1.42, 0.08); set(20, -0.91, 1.42, 0.04);
	set(22, -0.88, 1.42, 0.06);
	set(23, 0.15, 0.92); set(24, -0.15, 0.92);
	set(25, 0.15, 0.5); set(26, -0.15, 0.5);
	set(27, 0.15, 0.08); set(28, -0.15, 0.08);
	set(29, 0.15, 0.03, -0.05); set(30, -0.15, 0.03, -0.05);
	set(31, 0.15, 0, 0.2); set(32, -0.15, 0, 0.2);
	return points;
}

/** World points -> raw MediaPipe camera-convention landmarks (X right, Y down, Z away). */
function asLandmarks(points, visibility = 0.99) {
	return points.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility }));
}

function fit(landmarks) {
	return fitLandmarksToPose({ sample: normalizeLandmarkSample({ timeS: 0, landmarks }), rest });
}

/** Quaternion sign is free; compare orientations, not components. */
function quatDelta(a, b) {
	const d = a.reduce((sum, value, index) => sum + value * b[index], 0);
	return Math.abs(1 - Math.abs(d));
}

/* --- the model choice is a name, and "heavy" is a real, distinct URL -------- */

assert.equal(POSE_MODELS.full, POSE_MODEL_URL, "the default model name still resolves to full");
assert.notEqual(POSE_MODEL_URL_HEAVY, POSE_MODEL_URL, "heavy is not full under another name");
assert.ok(
	POSE_MODEL_URL_HEAVY.includes("pose_landmarker_heavy") && POSE_MODEL_URL_HEAVY.endsWith(".task"),
	"the heavy URL points at the heavy .task weights",
);
assert.equal(POSE_MODELS.heavy, POSE_MODEL_URL_HEAVY, "heavy is reachable by name");
pass("the still path can name the heavy model without touching a URL");

/* --- the left/right table covers the topology ------------------------------ */

const paired = new Set(LEFT_RIGHT_PAIRS.flat());
assert.equal(LEFT_RIGHT_PAIRS.length * 2, paired.size, "no landmark appears in two pairs");
// 33 landmarks, only NOSE (0) is unpaired.
assert.equal(paired.size, 32, "every landmark but the nose is paired");
assert.ok(!paired.has(0), "the nose mirrors onto itself");
for (const [left, right] of LEFT_RIGHT_PAIRS) {
	assert.ok(left < right, `pair [${left}, ${right}] is written left-index-first`);
}
pass("the left/right pair table matches the MediaPipe Pose topology");

/* --- mirroring twice is the identity --------------------------------------- */

const raised = asLandmarks(standingPoints(1)).map((point, index) => ({
	...point,
	// Distinct per-landmark visibility, so a mis-swap cannot hide behind a
	// uniform confidence.
	visibility: 0.3 + index / 100,
}));
const twice = mirrorLandmarks(mirrorLandmarks(raised));
assert.equal(twice.length, 33, "mirroring preserves the 33-landmark shape");
for (let index = 0; index < 33; index += 1) {
	for (const key of ["x", "y", "z", "visibility"]) {
		assert.ok(
			near(twice[index][key], raised[index][key]),
			`landmark ${index}.${key} did not survive a double mirror`,
		);
	}
}
pass("mirrorLandmarks is its own inverse");

/* --- one mirror trades the sides ------------------------------------------- */

const mirrored = mirrorLandmarks(raised);
// The fixture raises the LEFT arm (indices 13/15/17/19/21, world +X).
for (const [left, right] of LEFT_RIGHT_PAIRS) {
	assert.ok(near(mirrored[right].x, -raised[left].x), `x was not negated across ${left}->${right}`);
	assert.ok(near(mirrored[right].y, raised[left].y), `y must not move across ${left}->${right}`);
	assert.ok(near(mirrored[right].z, raised[left].z), `z must not move across ${left}->${right}`);
	assert.ok(
		near(mirrored[right].visibility, raised[left].visibility),
		`visibility must ride along with landmark ${left}`,
	);
}
// Y is down in the MediaPipe camera convention: raised means a smaller y.
assert.ok(raised[15].y < raised[11].y, "the fixture really raises the left wrist");
assert.ok(mirrored[16].y < mirrored[12].y, "after mirroring, the RIGHT wrist is the raised one");
assert.ok(near(mirrored[16].y, raised[15].y), "the raised height is carried across, not recomputed");
assert.ok(mirrored[15].y > mirrored[16].y, "after mirroring, the left wrist is the low one");
assert.ok(raised[15].x > 0 && mirrored[16].x < 0, "the raised arm's x is negated");
pass("a left-raised arm mirrors to a right-raised arm with x negated");

assert.throws(
	() => mirrorLandmarks(new Array(12).fill({ x: 0, y: 0, z: 0 })),
	/mirrorLandmarks: landmarks must contain the 33/,
	"a short landmark array is refused by name",
);
pass("mirrorLandmarks names a wrong-shaped input");

/* --- averageLandmarkSets: visibility-weighted, honest confidence ------------ */

const weighted = averageLandmarkSets(
	[{ x: 0, y: 0, z: 0, visibility: 1 }],
	[{ x: 10, y: 20, z: 30, visibility: 3 }],
);
assert.ok(near(weighted[0].x, 7.5), "x is weighted 1:3 toward the confident detection");
assert.ok(near(weighted[0].y, 15), "y is weighted 1:3");
assert.ok(near(weighted[0].z, 22.5), "z is weighted 1:3");
assert.ok(near(weighted[0].visibility, 2), "the averaged visibility is the mean, not the max");
pass("averageLandmarkSets weights position by visibility and means the confidence");

const unweighted = averageLandmarkSets(
	[{ x: -4, y: 2, z: 0, visibility: 0 }],
	[{ x: 8, y: 6, z: 4, visibility: 0 }],
);
assert.ok(near(unweighted[0].x, 2), "two invisible landmarks fall back to an unweighted mean");
assert.ok(near(unweighted[0].visibility, 0), "an unseen landmark stays unseen after averaging");
pass("a zero-visibility pair averages without dividing by zero");

// Missing landmarks: whichever side has one wins outright.
const holes = averageLandmarkSets(
	[null, { x: 1, y: 1, z: 1, visibility: 0.9 }, { x: 5, y: 5, z: 5, visibility: 0.5 }],
	[{ x: 2, y: 2, z: 2, visibility: 0.4 }, undefined, { x: 5, y: 5, z: 5, visibility: 0.5 }],
);
assert.deepEqual(holes[0], { x: 2, y: 2, z: 2, visibility: 0.4 }, "a hole in A takes B untouched");
assert.deepEqual(holes[1], { x: 1, y: 1, z: 1, visibility: 0.9 }, "a hole in B takes A untouched");
assert.ok(near(holes[2].x, 5), "a landmark present on both sides is still averaged");
pass("averageLandmarkSets fills per-landmark holes from the other set");

const onlyA = [{ x: 1, y: 2, z: 3, visibility: 0.7 }];
assert.equal(averageLandmarkSets(onlyA, null), onlyA, "a null B returns A itself");
assert.equal(averageLandmarkSets(null, onlyA), onlyA, "a null A returns B itself");
assert.equal(averageLandmarkSets(null, null), null, "two null sets average to null");
assert.equal(averageLandmarkSets(undefined, undefined), null, "two missing sets average to null");
pass("averageLandmarkSets handles a missing set on either side");

/* --- detectMirrorAveraged: two passes, one landmark array ------------------- */

function fakeImage() {
	return { naturalWidth: 640, naturalHeight: 480, tag: "image" };
}

function fakeCanvas(ops) {
	const canvas = {
		width: 0,
		height: 0,
		tag: "canvas",
		getContext: (kind) => {
			ops.push(["getContext", kind]);
			return {
				translate: (x, y) => ops.push(["translate", x, y]),
				scale: (x, y) => ops.push(["scale", x, y]),
				drawImage: (source, x, y, w, h) => ops.push(["drawImage", source.tag, x, y, w, h]),
			};
		},
	};
	return canvas;
}

// A detector that answers with whatever the caller staged for each element.
function stagedDetect(byTag, seen) {
	return async (element) => {
		seen.push(element.tag);
		return byTag[element.tag];
	};
}

const symmetric = asLandmarks(standingPoints(0));
const symmetricOps = [];
const symmetricSeen = [];
const symmetricResult = await detectMirrorAveraged(
	fakeImage(),
	stagedDetect({
		image: { worldLandmarks: [symmetric] },
		// What a detector really returns on a flipped image of this body.
		canvas: { worldLandmarks: [mirrorLandmarks(symmetric)] },
	}, symmetricSeen),
	{ createCanvas: () => fakeCanvas(symmetricOps) },
);
assert.deepEqual(symmetricSeen, ["image", "canvas"], "both the still and its flip are detected, in that order");
assert.deepEqual(
	symmetricOps,
	[
		["getContext", "2d"],
		["translate", 640, 0],
		["scale", -1, 1],
		["drawImage", "image", 0, 0, 640, 480],
	],
	"the flip is a translate-to-the-right-edge then a negative X scale",
);
for (let index = 0; index < 33; index += 1) {
	for (const key of ["x", "y", "z", "visibility"]) {
		assert.ok(
			near(symmetricResult[index][key], symmetric[index][key], 1e-12),
			`a symmetric detection moved at landmark ${index}.${key}`,
		);
	}
}
pass("a symmetric detection averages to itself");

// An asymmetric noise pair: the two views disagree, the average splits it.
const noisyA = asLandmarks(standingPoints(1)).map((point) => ({ ...point, x: point.x + 0.1 }));
const noisyB = asLandmarks(standingPoints(1)).map((point) => ({ ...point, x: point.x - 0.3 }));
const midpoint = await detectMirrorAveraged(
	fakeImage(),
	stagedDetect({
		image: { worldLandmarks: [noisyA] },
		canvas: { worldLandmarks: [mirrorLandmarks(noisyB)] },
	}, []),
	{ createCanvas: () => fakeCanvas([]) },
);
for (let index = 0; index < 33; index += 1) {
	assert.ok(
		near(midpoint[index].x, (noisyA[index].x + noisyB[index].x) / 2, 1e-12),
		`landmark ${index} did not land between the two detections`,
	);
	assert.ok(near(midpoint[index].y, noisyA[index].y, 1e-12), `landmark ${index} y drifted`);
}
pass("two disagreeing detections average to their midpoint");

/* --- nobody found: fall back rather than lose the person -------------------- */

const onlyDirect = await detectMirrorAveraged(
	fakeImage(),
	stagedDetect({ image: { worldLandmarks: [symmetric] }, canvas: { worldLandmarks: [] } }, []),
	{ createCanvas: () => fakeCanvas([]) },
);
assert.equal(onlyDirect, symmetric, "an empty mirror pass falls back to the direct detection");

const onlyMirror = await detectMirrorAveraged(
	fakeImage(),
	stagedDetect({
		image: { worldLandmarks: [] },
		canvas: { worldLandmarks: [mirrorLandmarks(symmetric)] },
	}, []),
	{ createCanvas: () => fakeCanvas([]) },
);
for (let index = 0; index < 33; index += 1) {
	assert.ok(
		near(onlyMirror[index].x, symmetric[index].x, 1e-12),
		`the mirror-only fallback was not un-mirrored at landmark ${index}`,
	);
}

const nobody = await detectMirrorAveraged(
	fakeImage(),
	stagedDetect({ image: { worldLandmarks: [] }, canvas: { worldLandmarks: [] } }, []),
	{ createCanvas: () => fakeCanvas([]) },
);
assert.equal(nobody, null, "no person in either pass is null, not an empty pose");
pass("a one-sided detection falls back, and no detection at all returns null");

await assert.rejects(
	() => detectMirrorAveraged({ naturalWidth: 0, naturalHeight: 0 }, async () => ({}), {
		createCanvas: () => fakeCanvas([]),
	}),
	/pose-mirror-image-unsized/,
	"an undecoded element fails by name",
);
await assert.rejects(
	() => detectMirrorAveraged(fakeImage(), async () => ({}), {
		createCanvas: () => ({ getContext: () => null }),
	}),
	/pose-mirror-canvas-failed/,
	"a missing 2d context fails by name",
);
pass("detectMirrorAveraged names its own failures");

/* --- end to end: the round trip does not move the fitted pose --------------- */

const original = asLandmarks(standingPoints(0.7));
// What the detector would report on the flipped photograph, put back by
// mirrorLandmarks — the exact path a still now takes.
const roundTripped = mirrorLandmarks(mirrorLandmarks(original));
const baseline = fit(original);
const rebuilt = fit(roundTripped);
const bones = Object.keys(baseline.pose.bones);
assert.equal(bones.length, 19, "the fit covers every cozyclay bone");
assert.deepEqual(Object.keys(rebuilt.pose.bones), bones, "the same bones are fitted after the round trip");
for (const name of bones) {
	const delta = quatDelta(baseline.pose.bones[name], rebuilt.pose.bones[name]);
	assert.ok(delta < 1e-9, `${name} drifted by ${delta} across the mirror round trip`);
}
assert.deepEqual(rebuilt.releasedBones, baseline.releasedBones, "the round trip does not change which bones release");
pass("a mirrored-then-unmirrored still fits to the original pose");

// And the averaged sample of two identical views is that same pose: the new
// still path adds accuracy, never a systematic shift.
const averagedSample = averageLandmarkSets(original, mirrorLandmarks(mirrorLandmarks(original)));
const averagedFit = fit(averagedSample);
for (const name of bones) {
	const delta = quatDelta(baseline.pose.bones[name], averagedFit.pose.bones[name]);
	assert.ok(delta < 1e-9, `${name} drifted by ${delta} when averaging two agreeing views`);
}
pass("averaging two agreeing views leaves the fitted pose where it was");

console.log("pose-mirror: OK");
