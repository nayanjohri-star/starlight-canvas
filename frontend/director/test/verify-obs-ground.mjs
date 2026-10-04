#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { correctTrajectory } from "../tools/bench/obs/ground.mjs";

const cameraPath = process.env.OBS_GROUND_CAMERA ?? new URL("./fixtures/obs-walk/camera.json", import.meta.url).pathname;
const cameraJson = JSON.parse(await readFile(cameraPath, "utf8"));
const worldToCamera = cameraJson.worldToCamera.flat();
const R_w2c = [
	worldToCamera[0], worldToCamera[1], worldToCamera[2],
	worldToCamera[4], worldToCamera[5], worldToCamera[6],
	worldToCamera[8], worldToCamera[9], worldToCamera[10],
];
const R_c2w = [R_w2c[0], R_w2c[3], R_w2c[6], R_w2c[1], R_w2c[4], R_w2c[7], R_w2c[2], R_w2c[5], R_w2c[8]];
const t_w2c = [worldToCamera[3], worldToCamera[7], worldToCamera[11]];
const t_c2w = [
	-(R_c2w[0] * t_w2c[0] + R_c2w[1] * t_w2c[1] + R_c2w[2] * t_w2c[2]),
	-(R_c2w[3] * t_w2c[0] + R_c2w[4] * t_w2c[1] + R_c2w[5] * t_w2c[2]),
	-(R_c2w[6] * t_w2c[0] + R_c2w[7] * t_w2c[1] + R_c2w[8] * t_w2c[2]),
];
const camera = { K: cameraJson.K, R_c2w, t_c2w };
const ankleHeight = 0.08;
const frames = 60;
const leftStance = (frame) => frame < 15 || frame >= 45;
const rightStance = (frame) => frame >= 20 && frame < 40;

function lerp(a, b, weight) {
	return a + (b - a) * weight;
}

function rootAt(frame) {
	if (frame < 15) return [0, 1, 0];
	if (frame < 20) {
		const w = (frame - 15) / 5;
		return [lerp(0, 0.5, w), 1, lerp(0, 0.7, w)];
	}
	if (frame < 40) return [0.5, 1, 0.7];
	if (frame < 45) {
		const w = (frame - 40) / 5;
		return [lerp(0.5, -0.25, w), 1, lerp(0.7, 1.3, w)];
	}
	return [-0.25, 1, 1.3];
}

function project(point) {
	const x = R_w2c[0] * point[0] + R_w2c[1] * point[1] + R_w2c[2] * point[2] + t_w2c[0];
	const y = R_w2c[3] * point[0] + R_w2c[4] * point[1] + R_w2c[5] * point[2] + t_w2c[1];
	const z = R_w2c[6] * point[0] + R_w2c[7] * point[1] + R_w2c[8] * point[2] + t_w2c[2];
	return [cameraJson.fx * x / z + cameraJson.cx, cameraJson.fy * y / z + cameraJson.cy, 1];
}

function makeWalk({ pixelNoise = false } = {}) {
	const trueRoot = [];
	const predictedRoot = [];
	const trueFeet = [];
	const predictedFeet = [];
	const kp2d = [];
	const logits = [];
	for (let frame = 0; frame < frames; frame += 1) {
		const root = rootAt(frame);
		const drift = [0.1 + frame * 0.0003, 0, -0.04 + frame * 0.0002];
		const activeLeft = leftStance(frame);
		const activeRight = rightStance(frame);
		const left = [activeLeft ? root[0] : root[0] + 0.24, activeLeft ? ankleHeight : ankleHeight + 0.025, activeLeft ? root[2] : root[2] + 0.1];
		const right = [activeRight ? root[0] : root[0] - 0.24, activeRight ? ankleHeight : ankleHeight + 0.025, activeRight ? root[2] : root[2] - 0.1];
		const predicted = (point) => [point[0] * 0.7 + drift[0], point[1] * 0.7, point[2] * 0.7 + drift[2]];
		trueRoot.push(root);
		predictedRoot.push(predicted(root));
		trueFeet.push({ L_ankle: left, R_ankle: right, L_foot: left, R_foot: right });
		predictedFeet.push({ L_ankle: predicted(left), R_ankle: predicted(right), L_foot: predicted(left), R_foot: predicted(right) });
		const leftPixel = project(left);
		const rightPixel = project(right);
		if (pixelNoise && (activeLeft || activeRight)) {
			const noise = [-1, 0, 1, 0, -1, 0, 1][frame % 7];
			if (activeLeft) { leftPixel[0] += noise; leftPixel[1] -= noise; }
			if (activeRight) { rightPixel[0] -= noise; rightPixel[1] += noise; }
		}
		const points = Array.from({ length: 17 }, () => [0, 0, 0]);
		points[15] = leftPixel;
		points[16] = rightPixel;
		kp2d.push(points);
		logits.push([
			activeLeft ? 6 : -6, activeLeft ? 6 : -6,
			activeRight ? 6 : -6, activeRight ? 6 : -6,
			-6, -6,
		]);
	}
	return { trueRoot, predictedRoot, predictedFeet, kp2d, logits };
}

function xzError(a, b) {
	return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function run({ pixelNoise = false, stanceMode = "logits", lowLogits = false } = {}) {
	const walk = makeWalk({ pixelNoise });
	if (lowLogits) walk.logits = walk.logits.map((row) => row.map(() => -3));
	const corrected = correctTrajectory({
		rootW: walk.predictedRoot,
		jointsW: walk.predictedRoot.map((root) => [root, [root[0], root[1] + 1, root[2]]]),
		footW: walk.predictedFeet,
		kp2d: walk.kp2d,
		static_conf_logits: walk.logits,
		camera,
		ankleHeight,
		stanceMode,
	});
	return { walk, corrected };
}

const clean = run();
const contactErrors = clean.corrected.contactFrames.map((frame) => xzError(clean.corrected.rootW[frame], clean.walk.trueRoot[frame]));
const allErrors = clean.corrected.rootW.map((root, frame) => xzError(root, clean.walk.trueRoot[frame]));
assert.ok(clean.corrected.contactFrames.length === 50, `expected 50 contact frames, got ${clean.corrected.contactFrames.length}`);
assert.ok(Math.max(...contactErrors) < 0.03, `contact XZ error exceeded 3 cm: ${Math.max(...contactErrors)}`);
assert.ok(Math.max(...allErrors) < 0.06, `overall XZ error exceeded 6 cm: ${Math.max(...allErrors)}`);
assert.equal(clean.corrected.diagnostics.stanceRuns.length, 3);
assert.deepEqual(clean.corrected.jointsW[12][0], clean.corrected.rootW[12], "all joints should receive the root correction");
assert.equal(clean.corrected.jointsW[12][1][1], 1.7, "joint Y should remain unchanged");
assert.ok(clean.corrected.corrections[17][0] > clean.corrected.corrections[15][0] && clean.corrected.corrections[17][0] < clean.corrected.corrections[20][0], "gap correction should interpolate linearly");
assert.ok(clean.corrected.corrections[42][2] > clean.corrected.corrections[40][2] && clean.corrected.corrections[42][2] < clean.corrected.corrections[45][2], "second gap correction should interpolate linearly");

const noisy = run({ pixelNoise: true });
const noisyErrors = noisy.corrected.rootW.map((root, frame) => xzError(root, noisy.walk.trueRoot[frame]));
assert.ok(Math.max(...noisyErrors) < 0.05, `1 px noisy overall XZ error exceeded 5 cm: ${Math.max(...noisyErrors)}`);

// Kinematic stance: GVHMR logits all low (as on the part-coloured mannequin),
// yet planted, near-floor, still feet must still be found and corrected.
const kinematic = run({ stanceMode: "kinematic", lowLogits: true });
assert.ok(kinematic.corrected.contactFrames.length >= 30, `kinematic stance found too few contact frames: ${kinematic.corrected.contactFrames.length}`);
const kinematicErrors = kinematic.corrected.contactFrames.map((frame) => xzError(kinematic.corrected.rootW[frame], kinematic.walk.trueRoot[frame]));
assert.ok(Math.max(...kinematicErrors) < 0.03, `kinematic contact XZ error exceeded 3 cm: ${Math.max(...kinematicErrors)}`);
const logitsOnly = run({ stanceMode: "logits", lowLogits: true });
assert.equal(logitsOnly.corrected.contactFrames.length, 0, "logits mode must find no contact when every logit is low");
console.log("kinematic contact frames:", kinematic.corrected.contactFrames.length, "max XZ error:", Math.max(...kinematicErrors).toFixed(4));
console.log("PASS verify-obs-ground");
console.log(`contact frames: ${clean.corrected.contactFrames.length}`);
console.log(`max contact XZ error: ${Math.max(...contactErrors).toFixed(6)} m`);
console.log(`max overall XZ error: ${Math.max(...allErrors).toFixed(6)} m`);
console.log(`max 1 px noisy XZ error: ${Math.max(...noisyErrors).toFixed(6)} m`);
