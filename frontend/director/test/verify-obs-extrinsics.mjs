#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	axisAngleToMatrix,
	camToWorldOrient,
	camToWorldPoint,
	cameraFromJson,
	matrixToAxisAngle,
	pixelRay,
	worldToCamOrient,
	worldToCameraPoint,
	worldToPixel,
} from "../tools/bench/obs/extrinsics.mjs";

const evidenceDir = process.env.OBS_EXTRINSICS_EVIDENCE_DIR ?? new URL("./fixtures/obs-walk", import.meta.url).pathname;
const [cameraJson, jointsJson] = await Promise.all([
	readFile(`${evidenceDir}/camera.json`, "utf8").then(JSON.parse),
	readFile(`${evidenceDir}/joints.json`, "utf8").then(JSON.parse),
]);
const cam = cameraFromJson(cameraJson);
assert.equal(cam.R_c2w.length, 3);
assert.equal(cam.R_w2c.length, 3);
assert.ok(cam.R_c2w.every((row) => row.length === 3));
assert.ok(cam.R_w2c.every((row) => row.length === 3));
const checks = { projection: 0, pointRoundTrip: 0, ray: 0, orient: 0 };
let maxProjectionError = 0;
let maxPointRoundTripError = 0;
let maxRayDistance = 0;

function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function matrixError(a, b) {
	return Math.max(...a.map((x, i) => Math.abs(x - b[i])));
}

let seed = 0x462;
function random() {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
}

for (let sample = 0; sample < 20; sample += 1) {
	const frame = Math.floor(random() * jointsJson.frames);
	const joint = Math.floor(random() * jointsJson.world[frame].length);
	const world = jointsJson.world[frame][joint];
	const expectedUv = jointsJson.uv[frame][joint];
	const [u, v, depth] = worldToPixel(world, cam);
	const projectionError = Math.hypot(u - expectedUv[0], v - expectedUv[1]);
	maxProjectionError = Math.max(maxProjectionError, projectionError);
	assert.ok(projectionError <= 1e-3, `projection frame ${frame} joint ${joint}: ${projectionError}`);
	assert.ok(depth > 0, `joint is behind camera at frame ${frame} joint ${joint}`);
	checks.projection += 1;

	const cameraPoint = worldToCameraPoint(world, cam);
	const roundTripError = distance(camToWorldPoint(cameraPoint, cam), world);
	maxPointRoundTripError = Math.max(maxPointRoundTripError, roundTripError);
	assert.ok(roundTripError < 1e-9, `point round-trip frame ${frame} joint ${joint}: ${roundTripError}`);
	checks.pointRoundTrip += 1;

	const ray = pixelRay(expectedUv[0], expectedUv[1], cam);
	const offset = world.map((x, i) => x - ray.origin[i]);
	const cross = [
		offset[1] * ray.direction[2] - offset[2] * ray.direction[1],
		offset[2] * ray.direction[0] - offset[0] * ray.direction[2],
		offset[0] * ray.direction[1] - offset[1] * ray.direction[0],
	];
	const rayDistance = Math.hypot(...cross);
	maxRayDistance = Math.max(maxRayDistance, rayDistance);
	assert.ok(rayDistance <= 1e-6, `pixel ray frame ${frame} joint ${joint}: ${rayDistance}`);
	assert.ok(Math.abs(Math.hypot(...ray.direction) - 1) < 1e-15, "pixel ray direction is unit length");
	checks.ray += 1;
}

for (const axisAngle of [
	[0, 0, 0],
	[0.2, -0.4, 0.1],
	[-1.1, 0.7, 0.3],
	[2.2, -0.8, 1.4],
]) {
	const world = camToWorldOrient(axisAngle, cam);
	const recovered = worldToCamOrient(world, cam);
	const error = matrixError(axisAngleToMatrix(recovered), axisAngleToMatrix(axisAngle));
	assert.ok(error < 1e-12, `axis-angle round-trip: ${error}`);
	assert.deepEqual(matrixToAxisAngle(axisAngleToMatrix([0, 0, 0])), [0, 0, 0]);
	checks.orient += 1;
}

const directionLength = Math.hypot(...pixelRay(416, 240, cam).direction);
assert.ok(Math.abs(directionLength - 1) < 1e-15, "centre pixel ray is unit length");

console.log(`PASS verify-obs-extrinsics (${Object.values(checks).reduce((a, b) => a + b, 0)} checks)`);
console.log(`max projection error: ${maxProjectionError}`);
console.log(`max point round-trip error: ${maxPointRoundTripError}`);
console.log(`max pixel-ray distance: ${maxRayDistance}`);
