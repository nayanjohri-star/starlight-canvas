#!/usr/bin/env node
// Foot lock (#492): a root-translated walk slides the planted foot because the
// leg's local rotations ride along with the pelvis. lockFeet must pin the
// planted ankle in the world by re-solving only the leg (two-bone IK), leave
// root/spine/arms and swing frames untouched, not pop at the stance edges, and
// keep posed_joints equal to FK of the rotations it writes.
import assert from "node:assert/strict";
import { forwardKinematics, globalRotations } from "../src/ardy/convert.js";
import { lockFeet } from "../tools/bench/fit/footlock.mjs";
import { bodyOffsets, jointsAt, localsAt, regenerateJoints, vec } from "../tools/bench/fit/motion.mjs";

const FPS = 24, T = 40, STANCE = [14, 21], STEP = 0.1 / 7; // 10 cm over the 8 stance frames
const LEFT = { hip: 23, knee: 24, ankle: 25, toe: 26 }, RIGHT = { hip: 19, knee: 20, ankle: 21 };
const LEG_JOINTS = new Set([19, 20, 21, 23, 24, 25]);
const rx = (t) => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];

// Hip flexion h and knee bend k with the ankle counter-rotated so the foot
// stays flat in the world. Swing lifts the left foot smoothly away from the
// stance; the right leg is held high throughout (never a stance).
function legPose(rotMats, f, leg, h, k) {
	rotMats.set(rx(h).flat(), (f * 27 + leg.hip) * 9);
	rotMats.set(rx(k).flat(), (f * 27 + leg.knee) * 9);
	rotMats.set(rx(-(h + k)).flat(), (f * 27 + leg.ankle) * 9);
}

function walk() {
	const rotMats = new Float32Array(T * 243), rootPos = new Float32Array(T * 3);
	for (let f = 0; f < T; f++) {
		for (let j = 0; j < 27; j++) rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (f * 27 + j) * 9);
		const away = f < STANCE[0] ? STANCE[0] - f : f > STANCE[1] ? f - STANCE[1] : 0;
		const lift = away === 0 ? 0 : Math.min(1, away / 3) ** 2 * (3 - 2 * Math.min(1, away / 3));
		legPose(rotMats, f, LEFT, 0.25 + 0.4 * lift, -0.45 - 0.8 * lift);
		legPose(rotMats, f, RIGHT, 0.8, -1.4);
	}
	// Ground the stance pose: the left toe sits 5 mm above the floor.
	const offsets = bodyOffsets(), stanceToe = forwardKinematics(localsAt({ rotMats }, STANCE[0]), offsets)[LEFT.toe][1];
	for (let f = 0; f < T; f++) rootPos.set([0, 0.005 - stanceToe, f * STEP], f * 3);
	return regenerateJoints({ frames: T, fps: FPS, rotMats, rootPos, posedJoints: new Float32Array(T * 81) }, offsets);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const horizontalSpan = (m, joint, [a, b]) => {
	let span = 0;
	for (let f = a; f <= b; f++) for (let g = a; g <= b; g++) {
		const p = jointsAt(m, f)[joint], q = jointsAt(m, g)[joint];
		span = Math.max(span, Math.hypot(p[0] - q[0], p[2] - q[2]));
	}
	return span;
};
const sameFrame = (x, y, f) => [x.rotMats, x.posedJoints].every((arr, i) => {
	const other = [y.rotMats, y.posedJoints][i], n = i === 0 ? 243 : 81;
	return arr.slice(f * n, (f + 1) * n).every((v, k) => v === other[f * n + k]);
});

const input = walk();
const inputSlide = horizontalSpan(input, LEFT.ankle, STANCE);
assert.ok(inputSlide > 0.095, `the input's planted ankle slides ~10 cm (the test can fail): ${inputSlide.toFixed(3)} m`);

const { motion: out, diagnostics } = lockFeet(input);
const left = diagnostics.stances.filter((s) => s.foot === "left"), right = diagnostics.stances.filter((s) => s.foot === "right");
assert.equal(left.length, 1, `one left stance: ${JSON.stringify(diagnostics.stances)}`);
assert.ok(left[0].start <= STANCE[0] && left[0].end >= STANCE[1] && left[0].start >= STANCE[0] - 2 && left[0].end <= STANCE[1] + 2, `left stance ~[${STANCE}]: [${left[0].start}, ${left[0].end}]`);
assert.equal(right.length, 0, "the lifted right foot is never a stance");

// 1. The planted foot stays put.
const slide = horizontalSpan(out, LEFT.ankle, STANCE);
assert.ok(slide < 0.01, `planted ankle slide ${slide.toFixed(4)} m < 1 cm (input ${inputSlide.toFixed(3)} m)`);
assert.ok(diagnostics.maxResidualM < 0.005, `reachable anchors are reached: residual ${diagnostics.maxResidualM.toFixed(4)} m`);

// 2. Swing frames beyond the edge ramps (~6 cm corrections fade over <= 8
// frames at 1 cm/frame), the root, spine, arms and the right leg are untouched.
for (const f of [0, 1, 2, 3, 31, 32, 33, 34, 35, 36, 37, 38, 39]) assert.ok(sameFrame(out, input, f), `swing frame ${f} unchanged`);
assert.deepEqual(out.rootPos, input.rootPos, "root never moves");
for (let f = 0; f < T; f++) for (let j = 0; j < 27; j++) {
	if (LEG_JOINTS.has(j) && j >= LEFT.hip) continue;
	const a = input.rotMats.slice((f * 27 + j) * 9, (f * 27 + j + 1) * 9), b = out.rotMats.slice((f * 27 + j) * 9, (f * 27 + j + 1) * 9);
	assert.deepEqual(b, a, `joint ${j} frame ${f} rotation untouched`);
}

// 3. The foot keeps its world orientation.
let footTurn = 0;
for (let f = 0; f < T; f++) {
	const g0 = globalRotations(localsAt(input, f))[LEFT.ankle], g1 = globalRotations(localsAt(out, f))[LEFT.ankle];
	footTurn = Math.max(footTurn, ...g0.flatMap((row, r) => row.map((v, c) => Math.abs(v - g1[r][c]))));
}
assert.ok(footTurn < 1e-4, `foot world orientation kept (max element change ${footTurn.toExponential(1)})`);

// 4. No pop: no joint moves more than 3 cm per frame beyond what the input did.
let extraJump = 0;
for (let f = 1; f < T; f++) {
	const [a0, a1, b0, b1] = [jointsAt(input, f - 1), jointsAt(input, f), jointsAt(out, f - 1), jointsAt(out, f)];
	for (let j = 0; j < 27; j++) extraJump = Math.max(extraJump, dist(b1[j], b0[j]) - dist(a1[j], a0[j]));
}
assert.ok(extraJump < 0.03, `max extra per-frame joint jump ${extraJump.toFixed(4)} m < 3 cm`);

// 5. posed_joints is FK of the written rotations.
const offsets = bodyOffsets();
let fkError = 0;
for (let f = 0; f < T; f++) {
	const fk = forwardKinematics(localsAt(out, f), offsets, vec(out.rootPos, f * 3)), joints = jointsAt(out, f);
	for (let j = 0; j < 27; j++) fkError = Math.max(fkError, dist(fk[j], joints[j]));
}
assert.ok(fkError < 0.005, `FK consistent: ${fkError.toExponential(1)} m < 0.5 cm`);

// 6. Out of reach: a support 30 cm below the foot clamps to full extension and reports the residual.
const deep = lockFeet(input, { floorY: -0.3, maxHeight: 0.5 });
assert.ok(deep.diagnostics.stances.some((s) => s.foot === "left"), "deep support still yields a stance");
assert.ok(deep.diagnostics.maxResidualM > 0.1, `unreachable anchor reports its residual: ${deep.diagnostics.maxResidualM.toFixed(3)} m`);
assert.ok(deep.motion.posedJoints.every(Number.isFinite) && deep.motion.rotMats.every(Number.isFinite), "clamped solve stays finite");

console.log(`PASS verify-footlock: planted slide ${(inputSlide * 100).toFixed(1)} cm -> ${(slide * 100).toFixed(2)} cm, max extra jump ${(extraJump * 100).toFixed(2)} cm, FK error ${fkError.toExponential(1)} m, unreachable residual ${deep.diagnostics.maxResidualM.toFixed(3)} m`);
