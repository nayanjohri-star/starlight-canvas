#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { serializeUsdCamera } from "../src/usd-camera.js";

const cameraTrack = Array.from({ length: 15 }, (_, frame) => ({
	pos: { x: frame, y: 1.5, z: 4 },
	yaw: 0,
	pitch: 0,
	fovDeg: 45,
	focalMm: 35,
	sensorId: "fullFrame",
}));
cameraTrack[12] = {
	pos: { x: 1, y: 2, z: 3 },
	yaw: Math.PI / 6,
	pitch: Math.PI / 9,
	fovDeg: 39.6,
	focalMm: 50,
	sensorId: "fullFrame",
};
cameraTrack[13] = {
	pos: { x: 1.5, y: 2.25, z: 2.5 },
	yaw: Math.PI / 4,
	pitch: Math.PI / 12,
	fovDeg: 31.2,
	focalMm: 65,
	sensorId: "fullFrame",
};
cameraTrack[14] = {
	pos: { x: 2, y: 2.5, z: 2 },
	yaw: Math.PI / 2,
	pitch: Math.PI / 9,
	fovDeg: 24.1,
	focalMm: 85,
	sensorId: "fullFrame",
};

const scene = {
	frameCount: cameraTrack.length,
	cameraTrack,
	filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 },
};
const shot = {
	name: "Arrival",
	startFrame: 12,
	endFrame: 14,
	camera: { mode: "follow" },
};

const before = JSON.stringify({ scene, shot });
const serialized = serializeUsdCamera(scene, shot);
const snapshotUrl = new URL("./snapshots/arrival-camera.usda", import.meta.url);
assert.equal(serialized, await readFile(snapshotUrl, "utf8"), "USDA camera matches the reviewed snapshot");
assert.equal(JSON.stringify({ scene, shot }), before, "USD export is pure");

assert.match(serialized, /timeCodesPerSecond = 24/);
assert.match(serialized, /startTimeCode = 12/);
assert.match(serialized, /endTimeCode = 14/);
assert.match(serialized, /custom float cozyclay:verticalApertureMm = 20\.25/);
assert.match(serialized, /custom float cozyclay:horizontalApertureMm = 36/,
	"16:9 crop restores a 36mm horizontal gate instead of reusing the 20.25mm vertical gate");
assert.match(serialized, /13: \(1\.5, 2\.25, 2\.5\)/,
	"the middle frame comes from sampleAt, not shotMetadata's start-frame camera");
assert.match(serialized, /13: 65,/,
	"animated focal length comes from the same addressed camera sample");
assert.match(serialized,
	/uniform token\[\] xformOpOrder = \["xformOp:translate", "xformOp:orient"\]/,
	"the transform stack uses the quaternion orientation after translation");
assert.doesNotMatch(serialized, /rotateYXZ/, "USD Euler packing is not used");

function parsedOrientSamples(usda) {
	const block = usda.match(/quatf xformOp:orient\.timeSamples = \{([\s\S]*?)\n    \}/)?.[1];
	assert.ok(block, "USDA contains orient time samples");
	return new Map([...block.matchAll(/^\s+(\d+): \(([^)]+)\),$/gm)].map((match) => [
		Number(match[1]),
		// quatf is stored at float precision even though the USDA token may
		// contain more digits. Resolve that quantization like a USD reader does.
		match[2].split(",").map((value) => Math.fround(Number(value))),
	]));
}

// Reimplement USD orient resolution instead of agreeing with emitted text by
// construction. A quatf is (w, x, y, z), and rotates a basis vector by q*v*q^-1.
function rotateByUsdOrient(vector, [w, x, y, z]) {
	const tx = 2 * (y * vector.z - z * vector.y);
	const ty = 2 * (z * vector.x - x * vector.z);
	const tz = 2 * (x * vector.y - y * vector.x);
	return {
		x: vector.x + w * tx + (y * tz - z * ty),
		y: vector.y + w * ty + (z * tx - x * tz),
		z: vector.z + w * tz + (x * ty - y * tx),
	};
}

function threeBasis({ yaw, pitch }) {
	return {
		forward: {
			x: -Math.sin(yaw) * Math.cos(pitch),
			y: Math.sin(pitch),
			z: -Math.cos(yaw) * Math.cos(pitch),
		},
		up: {
			x: Math.sin(yaw) * Math.sin(pitch),
			y: Math.cos(pitch),
			z: Math.cos(yaw) * Math.sin(pitch),
		},
	};
}

function assertVectorNear(actual, expected, label) {
	for (const axis of ["x", "y", "z"]) {
		assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-6,
			`${label} ${axis}: ${actual[axis]} vs ${expected[axis]}`);
	}
}

const orientations = parsedOrientSamples(serialized);
assert.equal(orientations.size, 3, "every inclusive frame has one resolved orientation");
const resolvedForwards = [];
for (const frame of [12, 13, 14]) {
	const quaternion = orientations.get(frame);
	assert.ok(quaternion, `frame ${frame} has an exported quaternion`);
	const expected = threeBasis(cameraTrack[frame]);
	const usdForward = rotateByUsdOrient({ x: 0, y: 0, z: -1 }, quaternion);
	resolvedForwards.push({ frame, vector: usdForward });
	assertVectorNear(
		usdForward,
		expected.forward,
		`frame ${frame} forward`,
	);
	assertVectorNear(
		rotateByUsdOrient({ x: 0, y: 1, z: 0 }, quaternion),
		expected.up,
		`frame ${frame} up`,
	);
}

for (const { frame, vector } of resolvedForwards) {
	console.log(`frame ${frame} USD forward = (${vector.x.toFixed(10)}, ${vector.y.toFixed(10)}, ${vector.z.toFixed(10)})`);
}

assert.throws(
	() => serializeUsdCamera(scene, { ...shot, endFrame: 15 }),
	/outside the scene range/,
	"a clamped sample cannot silently duplicate the last camera frame",
);

console.log("USD camera verified: 3 quaternion-resolved frames, 36x20.25mm cropped gate, 24 fps");
