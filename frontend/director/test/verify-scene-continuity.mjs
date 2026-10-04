#!/usr/bin/env node
// fitContacts' time-smooth scene solver (#462 follow-up): a body sliding
// through a box whose nearest face changes along the way. The per-frame solver
// flips the separating axis between frames (a one-frame teleport); the smooth
// solver must keep every bone out of the box AND move the body continuously.
import assert from "node:assert/strict";
import { CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { fitContacts, segmentPenetratesBox } from "../tools/bench/fit/contact.mjs";

const FPS = 24, T = 60, FEET = new Set([21, 22, 25, 26]);
const box = { min: [0, 0, 0], max: [0.6, 2, 0.6] };

// A vertical stick figure walking along +x at z = 0.1: it enters the box
// through the -x face, where the cheapest exit is -x, then -z, then +x.
function motion() {
	const rotMats = new Float32Array(T * 243), rootPos = new Float32Array(T * 3), posedJoints = new Float32Array(T * 81);
	for (let f = 0; f < T; f++) {
		const x = -0.3 + (1.2 * f) / (T - 1), z = 0.1;
		for (let j = 0; j < 27; j++) {
			rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (f * 27 + j) * 9);
			posedJoints.set([x, FEET.has(j) ? 0.02 : 0.1 + 0.05 * j, z], (f * 27 + j) * 3);
		}
		rootPos.set(posedJoints.slice(f * 81, f * 81 + 3), f * 3);
	}
	return { frames: T, fps: FPS, rotMats, rootPos, posedJoints };
}

const joints = (m, f) => Array.from({ length: 27 }, (_, j) => Array.from(m.posedJoints.slice((f * 27 + j) * 3, (f * 27 + j) * 3 + 3)));
const penetrating = (m) => Array.from({ length: m.frames }, (_, f) => f).filter((f) => { const J = joints(m, f); return CSKEL27_PARENTS.some((p, j) => p !== null && segmentPenetratesBox(J[p], J[j], box)); });
const maxStep = (m) => Math.max(...Array.from({ length: m.frames - 1 }, (_, f) => Math.hypot(...[0, 1, 2].map((k) => m.rootPos[(f + 1) * 3 + k] - m.rootPos[f * 3 + k]))));
// The input itself moves 1.2 m / 59 frames = 0.020 m per frame.
const inputStep = maxStep(motion());

const perFrame = fitContacts(motion(), { boxes: [box] });
const smooth = fitContacts(motion(), { boxes: [box], sceneSmoothSeconds: 0.375 });

assert.equal(penetrating(motion()).length > 10, true, "the input walks through the box (the test can fail)");
assert.deepEqual(penetrating(perFrame.motion), [], "per-frame solver clears the box");
assert.ok(maxStep(perFrame.motion) > 0.1, `per-frame solver teleports when the nearest face changes (max step ${maxStep(perFrame.motion).toFixed(3)} m)`);
assert.deepEqual(penetrating(smooth.motion), [], "smooth solver keeps every bone out of the box");
assert.ok(maxStep(smooth.motion) < 3 * inputStep, `smooth solver moves continuously: max step ${maxStep(smooth.motion).toFixed(3)} m vs input ${inputStep.toFixed(3)} m`);
assert.equal(smooth.diagnostics.sceneSolver, "continuous");
assert.equal(perFrame.diagnostics.sceneSolver, "per-frame");
assert.throws(() => fitContacts(motion(), { boxes: [box], sceneSmoothSeconds: 0 }), /positive duration/);

console.log(`PASS verify-scene-continuity: per-frame max step ${maxStep(perFrame.motion).toFixed(3)} m, smooth ${maxStep(smooth.motion).toFixed(3)} m (input ${inputStep.toFixed(3)} m), no bone inside the box`);
