#!/usr/bin/env node
import assert from "node:assert/strict";
import { solveTranslations } from "../tools/bench/obs/depth.mjs";

const K = [
	[777.01, 0, 416],
	[0, 777.01, 240],
	[0, 0, 1],
];
const mappedSmpl = [16, 17, 18, 19, 20, 21, 1, 2, 4, 5, 7, 8];
const mappedCoco = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

let seed = 0x462;
function random() {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
}

function gaussian() {
	return Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random());
}

function makeSkeleton(scale = 1) {
	const joints = Array.from({ length: 22 }, () => [0, 0, 0]);
	for (const joint of mappedSmpl) {
		joints[joint] = [
			scale * (-0.55 + 1.1 * random()),
			scale * (-0.9 + 1.8 * random()),
			scale * (-0.3 + 0.6 * random()),
		];
	}
	return joints;
}

function project(joints, translation, noisePx = 0, confidence = 1) {
	const keypoints = Array.from({ length: 17 }, () => [0, 0, 0]);
	for (let i = 0; i < mappedSmpl.length; i += 1) {
		const [x, y, z] = joints[mappedSmpl[i]];
		const depth = z + translation[2];
		assert.ok(depth > 0, `synthetic joint must be in front of camera: ${depth}`);
		keypoints[mappedCoco[i]] = [
			K[0][0] * (x + translation[0]) / depth + K[0][2] + noisePx * gaussian(),
			K[1][1] * (y + translation[1]) / depth + K[1][2] + noisePx * gaussian(),
			confidence,
		];
	}
	return keypoints;
}

function solveOne(joints, kp2d, options = {}) {
	return solveTranslations({
		jointsRel: [joints],
		kp2d: [kp2d],
		K,
		sigma: 0,
		...options,
	}).transl[0];
}

function near(actual, expected, tolerance, label) {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

const trueTranslation = [0.18, -0.11, 4.2];
const skeleton = makeSkeleton();
const noisy = project(skeleton, trueTranslation, 1);
const recovered = solveOne(skeleton, noisy);
near(recovered[0], trueTranslation[0], 0.01, "1 px noise x");
near(recovered[1], trueTranslation[1], 0.01, "1 px noise y");
assert.ok(Math.abs(recovered[2] - trueTranslation[2]) / trueTranslation[2] <= 0.01, `1 px noise depth: ${recovered[2]} vs ${trueTranslation[2]}`);

const partial = project(skeleton, trueTranslation, 1);
for (const coco of [5, 7, 9, 11]) partial[coco][2] = 0.1;
const partialRecovered = solveOne(skeleton, partial);
near(partialRecovered[0], trueTranslation[0], 0.02, "30% low confidence x");
near(partialRecovered[1], trueTranslation[1], 0.02, "30% low confidence y");
assert.ok(Math.abs(partialRecovered[2] - trueTranslation[2]) / trueTranslation[2] <= 0.02, `30% low confidence depth: ${partialRecovered[2]} vs ${trueTranslation[2]}`);

const fallbackTranslation = [0.4, -0.2, 3.7];
const degenerate = Array.from({ length: 17 }, () => [0, 0, 0.1]);
const fallback = solveTranslations({
	jointsRel: [skeleton],
	kp2d: [degenerate],
	K,
	sigma: 0,
	incamTransl: [fallbackTranslation],
});
assert.deepEqual(fallback.transl[0], fallbackTranslation, "degenerate frame falls back to incam translation");
assert.equal(fallback.flags[0], true, "degenerate frame is flagged");

const scaleBaseTranslation = [0, 0, 4];
const scaleBaseKp = project(skeleton, scaleBaseTranslation);
const shrunk = makeSkeleton(0.9);
// Use the same pose coordinates, shrunk about the pelvis, to isolate body-size depth.
for (let i = 0; i < 22; i += 1) shrunk[i] = skeleton[i].map(value => value * 0.9);
const baseDepth = solveOne(skeleton, scaleBaseKp)[2];
const shrunkDepth = solveOne(shrunk, scaleBaseKp)[2];
near(shrunkDepth / baseDepth, 0.9, 0.005, "10% body shrink depth ratio");

console.log("PASS verify-obs-depth");
console.log(`noise recovery: ${recovered.map(value => value.toFixed(5)).join(", ")}`);
console.log(`partial-confidence recovery: ${partialRecovered.map(value => value.toFixed(5)).join(", ")}`);
console.log(`scale depth ratio: ${(shrunkDepth / baseDepth).toFixed(6)}`);
