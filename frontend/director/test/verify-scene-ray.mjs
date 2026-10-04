#!/usr/bin/env node
import assert from "node:assert/strict";
import { CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { forwardKinematics } from "../src/ardy/convert.js";
import { fitContacts, segmentPenetratesBox } from "../tools/bench/fit/contact.mjs";
import { bodyOffsets, cloneMotion, jointsAt, localsAt, regenerateJoints, sub, vec } from "../tools/bench/fit/motion.mjs";

const cameraOrigin = [2, 1.6, 5], T = 32;
function fixture(frames = T, x = f => 0.001 * f) {
	const m = { frames, fps: 24, rootPos: new Float32Array(frames * 3), rotMats: new Float32Array(frames * 243), posedJoints: new Float32Array(frames * 81), boneScale: new Float32Array(27).fill(1), personScale: 1 };
	for (let f = 0; f < frames; f++) {
		m.rootPos.set([x(f), 1.05, 0], f * 3);
		for (let j = 0; j < 27; j++) m.rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (f * 27 + j) * 9);
	}
	return regenerateJoints(m);
}
const legBox = { min: [-0.16, 0.25, -0.06], max: [-0.04, 0.5, 0.06] };
// Crosses the spine (a torso bone) between two joints, below the arms.
const torsoBox = { min: [-0.04, 1.23, -0.1], max: [0.04, 1.29, -0.03] };
const armBox = { min: [-0.65, 1.52, -0.06], max: [-0.54, 1.63, 0.02] };
const mirror = box => ({ min: [-box.max[0] + 0.031, box.min[1], box.min[2]], max: [-box.min[0] + 0.031, box.max[1], box.max[2]] });
const hit = (m, f, boxes) => {
	const p = jointsAt(m, f);
	return boxes.some(box => CSKEL27_PARENTS.some((parent, j) => parent !== null && segmentPenetratesBox(p[parent], p[j], box)));
};
const step = (m, f) => Math.hypot(...sub(vec(m.rootPos, f * 3), vec(m.rootPos, (f - 1) * 3)));
let maxFkError = 0, maxRayResidual = 0, maxStep = 0;
function verify(input, result, boxes, camera = cameraOrigin, stepLimit = 0.02) {
	const m = result.motion, offsets = bodyOffsets(input.boneScale);
	let previousDelta = null;
	for (let f = 0; f < m.frames; f++) {
		assert.equal(hit(m, f, boxes), false, `no bone may cross a box at frame ${f}`);
		const root = vec(input.rootPos, f * 3), ray = sub(root, camera), delta = sub(vec(m.rootPos, f * 3), root);
		const distance = Math.hypot(...ray), direction = ray.map(x => x / distance), amount = delta.reduce((s, v, k) => s + v * direction[k], 0);
		const perpendicular = Math.hypot(...delta.map((v, k) => v - amount * direction[k]));
		maxRayResidual = Math.max(maxRayResidual, perpendicular);
		assert.ok(perpendicular < 0.001, `root stays on the ORIGINAL camera ray: ${perpendicular}`);
		if (f) {
			maxStep = Math.max(maxStep, step(m, f));
			assert.ok(step(m, f) <= step(input, f) + stepLimit + 1e-6, "output step is bounded by input step plus the correction budget");
			assert.ok(Math.hypot(...sub(delta, previousDelta)) <= stepLimit + 1e-6, "bound the vector correction, not merely the scalar offset");
		}
		previousDelta = delta;
		const posed = jointsAt(m, f), fk = forwardKinematics(localsAt(m, f), offsets, vec(m.rootPos, f * 3));
		for (let j = 0; j < 27; j++) {
			const error = Math.hypot(...sub(posed[j], fk[j]));
			maxFkError = Math.max(maxFkError, error);
			assert.ok(error < 0.005, `FK mismatch at frame ${f}, joint ${j}: ${error}`);
		}
		for (const j of [21, 22, 25, 26]) assert.ok(posed[j][1] >= -1e-5, "limb IK, not a root lift, clears the floor");
	}
	assert.equal(result.diagnostics.sceneSolver, "camera-ray");
	assert.ok(result.diagnostics.rayOffset.maxStepM <= stepLimit);
	assert.ok(result.diagnostics.sceneMaxStepM <= stepLimit + 1e-6);
	assert.ok(Math.abs(result.diagnostics.maxRootStepM - Math.max(...Array.from({ length: m.frames - 1 }, (_, f) => step(m, f + 1)))) < 1e-9);
}

const input = fixture(), saved = cloneMotion(input);
assert.ok(Array.from({ length: T }, (_, f) => hit(input, f, [torsoBox])).every(Boolean), "the uncorrected spine really crosses the box");
const p = jointsAt(input, 0);
assert.ok(p[2][1] < torsoBox.min[1] && p[3][1] > torsoBox.max[1], "both spine endpoints are outside: point-only collision checks cannot pass this fixture");
const ray = fitContacts(input, { boxes: [torsoBox], cameraOrigin });
verify(input, ray, [torsoBox]);
assert.ok(ray.diagnostics.rayOffset.maxAbsM > 0.01, "a meaningful depth correction is exercised");
assert.equal(ray.diagnostics.rayOffset.framesNonZero, T, "every colliding frame is corrected");
assert.equal(ray.diagnostics.limbFixFrames.length, 0, "a torso-only ray correction does not alter limb rotations");
assert.deepEqual(ray.motion.rotMats, input.rotMats);
assert.deepEqual(input, saved, "never mutate the caller's motion");

// A limb-only collision needs no root offset: limb IK repairs it in place.
assert.ok(Array.from({ length: T }, (_, f) => hit(input, f, [legBox])).every(Boolean), "the uncorrected leg really crosses the box");
assert.ok(p[20][1] > legBox.max[1] && p[21][1] < legBox.min[1], "both shin endpoints are outside the leg box");
const leg = fitContacts(input, { boxes: [legBox], cameraOrigin });
verify(input, leg, [legBox]);
assert.equal(leg.diagnostics.rayOffset.maxAbsM, 0, "the torso is clear, so the root stays on its input position");
assert.equal(leg.diagnostics.limbFixFrames.length, T);
assert.deepEqual(leg.motion.rootPos, input.rootPos);

// Only the middle frames collide: the offset is 0 at both ends (known A/B
// poses stay put) and ramps in/out within the per-frame budget.
const M = 48, walk = fixture(M, f => -0.6 + 0.025 * f), middleBox = { min: [-0.1, 1.23, -0.1], max: [0.1, 1.29, -0.03] };
const colliding = Array.from({ length: M }, (_, f) => hit(walk, f, [middleBox]));
assert.ok(colliding.some(Boolean) && !colliding[0] && !colliding[M - 1], "only middle frames collide");
const middle = fitContacts(walk, { boxes: [middleBox], cameraOrigin });
verify(walk, middle, [middleBox]);
const offsetAt = f => Math.hypot(...sub(vec(middle.motion.rootPos, f * 3), vec(walk.rootPos, f * 3)));
assert.equal(offsetAt(0), 0, "no offset at the start");
assert.equal(offsetAt(M - 1), 0, "no offset at the end");
assert.ok(middle.diagnostics.rayOffset.maxAbsM > 0.03, "the middle is corrected");
assert.ok(middle.diagnostics.rayOffset.maxStepM <= 0.02, "slope-limited offset");
assert.ok(middle.diagnostics.rayOffset.framesNonZero > colliding.filter(Boolean).length, "the offset ramps in/out around the collision");
assert.ok(middle.diagnostics.rayOffset.framesNonZero < M, "and is zero far from it");

// A tight depth budget forces genuine residual box IK, separately for each
// arm and leg. The nonoffending chains and torso must retain their rotations.
for (const [box, chain] of [[legBox, [19, 20, 21]], [mirror(legBox), [23, 24, 25]], [armBox, [8, 9, 10]], [mirror(armBox), [14, 15, 16]]]) {
	assert.ok(hit(input, 0, [box]));
	const ik = fitContacts(input, { boxes: [box], cameraOrigin, rayMaxOffsetM: 0.01 });
	verify(input, ik, [box]);
	assert.ok(ik.diagnostics.limbFixFrames.length > 0, "the limb fallback must actually run");
	assert.notDeepEqual(ik.motion.rotMats, input.rotMats, "IK must update rotations, not just posed joints");
	for (let f = 0; f < T; f++) for (let j = 0; j < 27; j++) if (!chain.includes(j)) {
		assert.deepEqual(ik.motion.rotMats.slice((f * 27 + j) * 9, (f * 27 + j + 1) * 9), input.rotMats.slice((f * 27 + j) * 9, (f * 27 + j + 1) * 9), `nonoffending joint ${j} is untouched`);
	}
}
const both = [legBox, armBox];
verify(input, fitContacts(input, { boxes: both, cameraOrigin, rayMaxOffsetM: 0 }), both);

// Rays turning quickly near the camera also consume the vector step budget:
// the scalar slope must stay below it so the vector correction does not.
const nearCamera = [0, 1.3, 0.8];
const turning = fitContacts(walk, { boxes: [middleBox], cameraOrigin: nearCamera, rayMaxStepM: 0.005 });
verify(walk, turning, [middleBox], nearCamera, 0.005);
assert.ok(turning.diagnostics.rayOffset.maxAbsM > 0.01);
assert.ok(turning.diagnostics.rayOffset.maxStepM < 0.005 - 1e-4, "turning rays shrink the scalar slope budget");
assert.equal(Math.hypot(...sub(vec(turning.motion.rootPos, 0), vec(walk.rootPos, 0))), 0);

// Production's independent joint/rotation filtering can leave stale posed
// joints. The output uses the known bone factors, not new per-frame offsets.
const stale = cloneMotion(input);
stale.posedJoints[(5 * 27 + 10) * 3] += 0.04;
const repaired = fitContacts(stale, { cameraOrigin });
verify(stale, repaired, []);
assert.ok(repaired.diagnostics.inputFkResidualM > 0.039);
assert.deepEqual(repaired.motion.rootPos, stale.rootPos);
assert.deepEqual(repaired.motion.rotMats, stale.rotMats);

// cameraOrigin selects the new behavior even when the old ramp duration is
// present; without cameraOrigin the existing callers retain their solver.
assert.deepEqual(fitContacts(input, { boxes: [torsoBox], cameraOrigin, sceneSmoothSeconds: 0.375 }).motion, ray.motion);
assert.throws(() => fitContacts(input, { cameraOrigin: [0, NaN, 5] }), /cameraOrigin/);
assert.throws(() => fitContacts(input, { cameraOrigin, rayMaxOffsetM: -1 }), /rayMaxOffsetM/);
assert.throws(() => fitContacts(input, { cameraOrigin, rayMaxStepM: 0 }), /rayMaxStepM/);
assert.throws(() => fitContacts(input, { cameraOrigin: vec(input.rootPos) }), /coincides/);
assert.throws(() => fitContacts(input, { cameraOrigin, rayMaxOffsetM: 0, boxes: [{ min: [-1, 0.9, -1], max: [1, 1.8, 1] }] }), /no torso-clear/);
console.log(`PASS: scene ray: torso ray offset (0 at clear ends, slope-limited) and four limb IK chains, no bone penetration, FK error ${maxFkError.toExponential(2)} m, ray residual ${maxRayResidual.toExponential(2)} m, max synthetic root step ${maxStep.toFixed(6)} m`);
