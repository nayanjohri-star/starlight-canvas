#!/usr/bin/env node
/** Pure math checks for the IK-mode motion trail editor (src/motion-trail.js). */
import assert from "node:assert/strict";
import {
	TRAIL_EFFECTOR_JOINTS,
	TRAIL_TRACKS,
	applyTrailFalloffDelta,
	falloffWeight,
	jointTrailPoints,
	nearestFrameToRay,
	nearestTrailFrame,
	trailEditRange,
	worldDeltaToClip,
} from "../src/motion-trail.js";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";

const JOINTS = CSKEL27_JOINTS.length;

function syntheticMotion({ frames = 10, rotationDeg = 0, anchorX = 0, anchorZ = 0 } = {}) {
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let f = 0; f < frames; f += 1) {
		// The root walks +x in clip space, hips at y = 0.9.
		rootPos[f * 3] = f * 0.1;
		rootPos[f * 3 + 1] = 0.9;
		rootPos[f * 3 + 2] = 0;
		for (let j = 0; j < JOINTS; j += 1) {
			const po = (f * JOINTS + j) * 3;
			posedJoints[po] = f * 0.1 + j * 0.01;
			posedJoints[po + 1] = 0.9 + j * 0.02;
			posedJoints[po + 2] = j * 0.03;
		}
	}
	return { frames, fps: 24, anchorFrame: 0, rotationDeg, anchorX, anchorZ, rootPos, posedJoints };
}

// --- trail points: identity yaw pins frame 0 at the anchor ------------------
{
	const motion = syntheticMotion({ anchorX: 2, anchorZ: 1 });
	const points = jointTrailPoints(motion, "Hips", { baseY: 3 });
	assert.equal(points.length, motion.frames * 3);
	assert.ok(Math.abs(points[0] - 2) < 1e-6, "frame 0 x sits at anchorX");
	assert.ok(Math.abs(points[2] - 1) < 1e-6, "frame 0 z sits at anchorZ");
	assert.ok(Math.abs(points[1] - (3 + 0.9)) < 1e-6, "y = baseY + clip height");
	// Clip +x under 0 yaw stays world +x (rootAt convention).
	assert.ok(points[3] > points[0], "the trail advances along +x");
}

// --- yaw: 90deg rotates clip +x onto world -z (matches sample-at rootAt) ----
{
	const motion = syntheticMotion({ rotationDeg: 90, anchorX: 0, anchorZ: 0 });
	const points = jointTrailPoints(motion, "Hips");
	// rootAt: x' = dx*cos + dz*sin, z' = -dx*sin + dz*cos with dx=0.1, dz=0.
	assert.ok(Math.abs(points[3] - 0) < 1e-6, "90deg yaw sends clip +x to world x=0");
	assert.ok(Math.abs(points[5] - -0.1) < 1e-6, "90deg yaw sends clip +x to world -z");
}

// --- worldDeltaToClip inverts the trail yaw --------------------------------
{
	const motion = syntheticMotion({ rotationDeg: 37 });
	const clip = { x: 0.4, y: 0.2, z: -0.3 };
	const radians = (37 * Math.PI) / 180;
	const world = {
		x: clip.x * Math.cos(radians) + clip.z * Math.sin(radians),
		y: clip.y,
		z: -clip.x * Math.sin(radians) + clip.z * Math.cos(radians),
	};
	const roundTrip = worldDeltaToClip(motion, world);
	assert.ok(Math.abs(roundTrip.x - clip.x) < 1e-6, "x round-trips through the yaw");
	assert.ok(Math.abs(roundTrip.y - clip.y) < 1e-6, "y is yaw-invariant");
	assert.ok(Math.abs(roundTrip.z - clip.z) < 1e-6, "z round-trips through the yaw");
}

// --- falloff: 1 at the grab, 0 at the radius, monotone in between ----------
{
	assert.equal(falloffWeight(0, 12), 1);
	assert.equal(falloffWeight(12, 12), 0);
	assert.equal(falloffWeight(-12, 12), 0);
	let previous = 1;
	for (let d = 1; d <= 12; d += 1) {
		const w = falloffWeight(d, 12);
		assert.ok(w <= previous, "falloff never increases with distance");
		previous = w;
	}
	assert.equal(falloffWeight(0, 0), 1, "zero radius still moves the grab frame");
	assert.equal(falloffWeight(1, 0), 0, "zero radius moves nothing else");
}

// --- edit range: clamped, exclusive end ------------------------------------
{
	assert.deepEqual(trailEditRange(240, 100, 12), { startFrame: 88, endFrame: 113 });
	assert.deepEqual(trailEditRange(240, 3, 12), { startFrame: 0, endFrame: 16 });
	assert.deepEqual(trailEditRange(240, 235, 12), { startFrame: 223, endFrame: 240 });
	assert.deepEqual(trailEditRange(240, 999, 12), { startFrame: 227, endFrame: 240 });
}

// --- deformation: full delta at the grab, zero outside, pure ----------------
{
	const motion = syntheticMotion({ frames: 40 });
	const beforeRoot = motion.rootPos.slice();
	const beforePosed = motion.posedJoints.slice();
	const clipDelta = { x: 0.5, y: 0.25, z: -0.4 };
	const edited = applyTrailFalloffDelta(motion, { grabFrame: 20, radiusFrames: 6, clipDelta });
	assert.notEqual(edited, motion, "a new motion object is returned");
	assert.deepEqual([...motion.rootPos], [...beforeRoot], "the source rootPos is untouched");
	assert.deepEqual([...motion.posedJoints], [...beforePosed], "the source posedJoints is untouched");
	// Grab frame: the full delta lands on root and on every joint.
	assert.ok(Math.abs(edited.rootPos[20 * 3] - (beforeRoot[20 * 3] + 0.5)) < 1e-6);
	assert.ok(Math.abs(edited.rootPos[20 * 3 + 1] - (beforeRoot[20 * 3 + 1] + 0.25)) < 1e-6);
	for (let j = 0; j < JOINTS; j += 1) {
		const po = (20 * JOINTS + j) * 3;
		assert.ok(Math.abs(edited.posedJoints[po + 2] - (beforePosed[po + 2] - 0.4)) < 1e-6);
	}
	// Outside the falloff window: bit-identical.
	for (const f of [0, 13, 27, 39]) {
		assert.equal(edited.rootPos[f * 3], beforeRoot[f * 3], `frame ${f} root x unchanged`);
		assert.equal(edited.posedJoints[(f * JOINTS + 5) * 3], beforePosed[(f * JOINTS + 5) * 3], `frame ${f} joint unchanged`);
	}
	// Halfway into the window the weight is strictly between 0 and 1.
	const mid = edited.rootPos[17 * 3] - beforeRoot[17 * 3];
	assert.ok(mid > 0 && mid < 0.5, "falloff blends between the grab and the edge");
}

// --- grab picking ----------------------------------------------------------
{
	const motion = syntheticMotion({ frames: 30 });
	const points = jointTrailPoints(motion, "Hips");
	const target = { x: points[12 * 3], y: points[12 * 3 + 1], z: points[12 * 3 + 2] };
	assert.equal(nearestTrailFrame(points, target), 12);
	assert.equal(nearestTrailFrame(points, { x: -999, y: 0, z: 0 }), 0);
}

// --- ray picking: the drag entry point raycasts nothing in the scene -------
{
	const motion = syntheticMotion({ frames: 30 });
	const points = jointTrailPoints(motion, "Hips");
	const target = { x: points[12 * 3], y: points[12 * 3 + 1], z: points[12 * 3 + 2] };
	// A ray from above, straight down through frame 12.
	const fromAbove = nearestFrameToRay(points, { x: target.x, y: target.y + 5, z: target.z }, { x: 0, y: -1, z: 0 }, 0.05);
	assert.ok(fromAbove, "the descending ray hits the trail");
	assert.equal(fromAbove.frame, 12);
	assert.ok(fromAbove.distance < 1e-6, "the exact hit has ~zero distance");
	// A ray missing every point by more than the threshold returns null.
	assert.equal(nearestFrameToRay(points, { x: 50, y: 50, z: 50 }, { x: 0, y: -1, z: 0 }, 0.2), null);
	// Points BEHIND the ray origin never grab (t < 0 is rejected).
	assert.equal(nearestFrameToRay(points, { x: target.x, y: target.y + 5, z: target.z }, { x: 0, y: 1, z: 0 }, 0.5), null);
}

// --- effector map only names real cskel27 joints ---------------------------
{
	for (const joint of Object.values(TRAIL_EFFECTOR_JOINTS)) {
		assert.ok(CSKEL27_JOINTS.includes(joint), `${joint} is a cskel27 joint`);
	}
	const motion = syntheticMotion();
	const hand = jointTrailPoints(motion, TRAIL_EFFECTOR_JOINTS.leftHand);
	assert.equal(hand.length, motion.frames * 3);
}

// --- trail tracks: valid joints, IK-handle colours, limbs before hips ------
{
	const HANDLE_COLORS = { arm: "#ff8a3d", leg: "#4dd2ff", torso: "#ffd23d", head: "#b98cff" };
	const expected = {
		leftHand: HANDLE_COLORS.arm,
		rightHand: HANDLE_COLORS.arm,
		leftFoot: HANDLE_COLORS.leg,
		rightFoot: HANDLE_COLORS.leg,
		head: HANDLE_COLORS.head,
		hips: HANDLE_COLORS.torso,
	};
	assert.deepEqual(
		Object.fromEntries(TRAIL_TRACKS.map((track) => [track.id, track.color])),
		expected,
		"every trail rides its viewport IK-handle colour",
	);
	for (const track of TRAIL_TRACKS) {
		assert.ok(CSKEL27_JOINTS.includes(track.joint), `${track.joint} is a cskel27 joint`);
	}
	assert.equal(TRAIL_TRACKS[TRAIL_TRACKS.length - 1].id, "hips", "hips picks last so limb grabs win overlaps");
	const motion = syntheticMotion();
	for (const track of TRAIL_TRACKS) {
		assert.equal(jointTrailPoints(motion, track.joint).length, motion.frames * 3);
	}
}

console.log("all motion trail checks passed");
