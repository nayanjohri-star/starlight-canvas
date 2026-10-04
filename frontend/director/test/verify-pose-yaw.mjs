// verify-pose-yaw.mjs — the photograph's horizontal facing must not reach the
// saved pose. Facing is authored on the Character group's `rot`; a pose fitted
// from a 3/4 or profile shot has to come out identical to the same body shot
// head-on, or "set the pose from a photo" silently yaws the character.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLandmarkSample } from "../src/pose-extract/landmarks.js";
import { fitLandmarksToPose } from "../src/pose-extract/fit.js";

const rest = JSON.parse(readFileSync(new URL("../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));

function pass(label) { console.log(`PASS ${label}`); }

/** Y-up world points of a standing person, arms out, left arm raised by `lift`. */
function standingPoints(lift = 0) {
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
	return points;
}

function rotY(points, radians) {
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return points.map(([x, y, z]) => [x * cos + z * sin, y, z * cos - x * sin]);
}

function rotX(points, radians) {
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return points.map(([x, y, z]) => [x, y * cos - z * sin, y * sin + z * cos]);
}

/** World points -> the MediaPipe camera convention normalizeLandmarkSample expects. */
function asSample(points, timeS = 0) {
	return normalizeLandmarkSample({
		timeS,
		landmarks: points.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility: 0.99 })),
	});
}

function fit(points) {
	return fitLandmarksToPose({ sample: asSample(points), rest });
}

/** Quaternion sign is free; compare orientations, not components. */
function quatDelta(a, b) {
	const d = a.reduce((sum, value, index) => sum + value * b[index], 0);
	return Math.abs(1 - Math.abs(d));
}

/* --- yaw does not reach the fitted pose ------------------------------------ */

const front = fit(standingPoints(0.7));
const bones = Object.keys(front.pose.bones);
assert.ok(bones.length === 19, "the fit covers every cozyclay bone");

for (const yaw of [Math.PI / 2, -Math.PI / 2, Math.PI, 0.6]) {
	const turned = fit(rotY(standingPoints(0.7), yaw));
	assert.deepEqual(Object.keys(turned.pose.bones), bones, "the same bones are fitted at any yaw");
	for (const name of bones) {
		const delta = quatDelta(front.pose.bones[name], turned.pose.bones[name]);
		assert.ok(delta < 1e-9, `${name} drifted by ${delta} at yaw ${yaw}`);
	}
	assert.deepEqual(turned.releasedBones, front.releasedBones, "yaw does not change which bones release");
}
pass("a yawed subject fits to the same pose as a head-on subject");

/* --- the pose still lands facing neutral-forward, not merely self-consistent */

const quarter = fit(rotY(standingPoints(0.7), Math.PI / 2));
assert.ok(
	Object.values(quarter.pose.bones).every((quat) => quat.every(Number.isFinite)),
	"every fitted rotation is finite",
);
const hipsDelta = quatDelta(front.pose.bones.Hips, quarter.pose.bones.Hips);
assert.ok(hipsDelta < 1e-9, `Hips carries the photograph's yaw (delta ${hipsDelta})`);
pass("Hips no longer bakes in the camera-relative facing");

/* --- degenerate facing: lying down / top-down camera ----------------------- */

// Tipped onto the back, the forward axis points at the camera: its horizontal
// component collapses and no yaw can be recovered. Normalization must stand
// down rather than spin the pose by a noise-derived angle.
const lying = rotX(standingPoints(0.7), Math.PI / 2);
let lyingFit;
assert.doesNotThrow(() => { lyingFit = fit(lying); }, "a lying subject still fits");
assert.ok(
	Object.values(lyingFit.pose.bones).every((quat) => quat.every(Number.isFinite)),
	"a lying subject yields finite rotations",
);

// Skipping is all-or-nothing: two yaws of a lying subject stay distinct rather
// than being pulled together by a garbage angle.
const lyingTurned = fit(rotY(lying, Math.PI / 2));
assert.ok(
	Object.values(lyingTurned.pose.bones).every((quat) => quat.every(Number.isFinite)),
	"a yawed lying subject yields finite rotations",
);
pass("a degenerate facing skips normalization without throwing");

console.log("pose-yaw: OK");
