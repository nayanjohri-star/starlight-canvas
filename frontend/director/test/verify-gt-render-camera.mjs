#!/usr/bin/env node
// Pure camera math of the ground-truth renderer (#428): the GVHMR focal
// conversion, the Three-compatible intrinsics/extrinsics, and the static
// camera placement that keeps every point inside the margin box.
import assert from "node:assert/strict";
import * as THREE from "three";
import {
	buildCamera,
	fovDegFromFMm,
	gvhmrFMmFromFocalPx,
	gvhmrFocalPx,
	intrinsicsFromFov,
	mergeSupports,
	orbitRotation,
	projectPoint,
	supportArgs,
	supportValues,
} from "../tools/gt-render/camera-math.mjs";

const W = 832;
const H = 480;
let checks = 0;
const close = (actual, expected, tolerance, label) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (tol ${tolerance})`);
	checks += 1;
};

// GVHMR: f_px = sqrt(W^2 + H^2) / sqrt(24^2 + 36^2) * f_mm.
const f35 = gvhmrFocalPx(35, W, H);
close(f35, (Math.sqrt(832 * 832 + 480 * 480) / Math.sqrt(24 * 24 + 36 * 36)) * 35, 1e-9, "gvhmr focal px");
close(f35, 777.0, 0.1, "35 mm at 832x480 is ~777 px");
const fov35 = fovDegFromFMm(35, W, H);
const k35 = intrinsicsFromFov({ width: W, height: H, fovDeg: fov35 });
close(k35.fy, f35, 1e-9, "Three vertical fov reproduces the GVHMR focal");
close(k35.fx, k35.fy, 0, "square pixels");
close(gvhmrFMmFromFocalPx(k35.fy, W, H), 35, 1e-9, "f-mm round trip");
assert.equal(k35.cx, 416);
assert.equal(k35.cy, 240);
checks += 2;

// Seeded point clouds so a failure is reproducible.
let seed = 42;
const random = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
function cloud(count, centre, spread) {
	const points = new Float64Array(count * 3);
	for (let i = 0; i < count; i += 1) {
		for (let axis = 0; axis < 3; axis += 1) points[i * 3 + axis] = centre[axis] + (random() - 0.5) * spread[axis];
	}
	return points;
}

// Orientation and extrinsics match what Three builds for the same framing,
// and the projection matches Three's NDC -> viewport mapping (v down).
for (const [azimuthDeg, elevationDeg] of [[0, 5], [37, 12], [-120, -8], [180, 30]]) {
	const { yaw, pitch, R } = orbitRotation(azimuthDeg, elevationDeg);
	const three = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ")).elements; // column-major
	for (let row = 0; row < 3; row += 1) {
		for (let col = 0; col < 3; col += 1) close(R[row * 3 + col], three[col * 4 + row], 1e-12, `R[${row}][${col}] az=${azimuthDeg}`);
	}
	const { kx, ky } = supportArgs({ width: W, height: H, fMm: 35, azimuthDeg, elevationDeg, margin: 0.08 });
	const support = supportValues(cloud(50, [0.3, 0.9, -0.4], [1.2, 1.8, 3]), R, kx, ky);
	const camera = buildCamera({ width: W, height: H, fMm: 35, azimuthDeg, elevationDeg, margin: 0.08, support });
	const cam = new THREE.PerspectiveCamera(camera.fovDeg, W / H, 0.01, 1000);
	cam.position.set(camera.position.x, camera.position.y, camera.position.z);
	cam.rotation.order = "YXZ";
	cam.rotation.set(camera.pitch, camera.yaw, 0);
	cam.updateMatrixWorld(true);
	cam.updateProjectionMatrix();
	const view = cam.matrixWorldInverse.elements;
	for (let row = 0; row < 4; row += 1) {
		for (let col = 0; col < 4; col += 1) close(camera.worldToCameraGl[row][col], view[col * 4 + row], 1e-9, `view[${row}][${col}]`);
	}
	const probe = cloud(20, [0.3, 0.9, -0.4], [1, 1.5, 2]);
	for (let i = 0; i < 20; i += 1) {
		const point = [probe[i * 3], probe[i * 3 + 1], probe[i * 3 + 2]];
		const ndc = new THREE.Vector3(...point).project(cam);
		const [u, v, depth] = projectPoint(point, camera);
		close(u, ((ndc.x + 1) / 2) * W, 1e-6, "u matches Three");
		close(v, ((1 - ndc.y) / 2) * H, 1e-6, "v matches Three (image y down)");
		const local = new THREE.Vector3(...point).applyMatrix4(cam.matrixWorldInverse);
		close(depth, -local.z, 1e-9, "OpenCV depth is Three's -z");
	}
}

// Azimuth 0 / elevation 0 puts the camera on +Z of the subject, looking -Z.
{
	const args = { width: W, height: H, fMm: 35, azimuthDeg: 0, elevationDeg: 0, margin: 0.08 };
	const { R, kx, ky } = supportArgs(args);
	const camera = buildCamera({ ...args, support: supportValues(cloud(10, [0, 1, 0], [0.4, 1.7, 0.4]), R, kx, ky) });
	assert.ok(camera.position.z > 1 && Math.abs(camera.position.x) < 0.2, `camera stands on +Z (${JSON.stringify(camera.position)})`);
	close(camera.yaw, 0, 0, "yaw");
	checks += 1;
}

// Placement: every point inside the margin box, the binding axis touches the
// margin on both sides (the camera is as close as it can be), and supports of
// chunks merge to the support of the whole set.
for (const [azimuthDeg, elevationDeg, margin, fMm, centre, spread] of [
	[0, 5, 0.08, 35, [0, 0.9, 0], [0.6, 1.8, 0.5]], // standing, tall: height binds
	[0, 5, 0.08, 35, [0, 0.3, 0], [1.9, 0.5, 0.6]], // lying down: width binds
	[30, 10, 0.1, 50, [2, 0.9, 3], [0.8, 1.7, 6]], // walks toward the camera
	[-90, 0, 0.02, 24, [-1, 1, 0], [5, 1.7, 0.5]],
]) {
	const args = { width: W, height: H, fMm, azimuthDeg, elevationDeg, margin };
	const { R, kx, ky } = supportArgs(args);
	const points = cloud(400, centre, spread);
	const whole = supportValues(points, R, kx, ky);
	const merged = mergeSupports([0, 1, 2, 3].map((chunk) => supportValues(points.subarray(chunk * 300, (chunk + 1) * 300), R, kx, ky)));
	for (const key of ["axp", "axm", "ayp", "aym", "zmax", "count"]) close(merged[key], whole[key], 0, `merged ${key}`);
	const camera = buildCamera({ ...args, support: whole });
	let minU = Infinity;
	let maxU = -Infinity;
	let minV = Infinity;
	let maxV = -Infinity;
	for (let i = 0; i < 400; i += 1) {
		const [u, v, depth] = projectPoint([points[i * 3], points[i * 3 + 1], points[i * 3 + 2]], camera);
		assert.ok(depth >= 0.3 - 1e-9, `point ${i} in front of the camera (${depth})`);
		minU = Math.min(minU, u);
		maxU = Math.max(maxU, u);
		minV = Math.min(minV, v);
		maxV = Math.max(maxV, v);
	}
	const eps = 1e-6;
	assert.ok(minU >= margin * W - eps && maxU <= (1 - margin) * W + eps, `u in margin box: ${minU}..${maxU}`);
	assert.ok(minV >= margin * H - eps && maxV <= (1 - margin) * H + eps, `v in margin box: ${minV}..${maxV}`);
	checks += 3;
	if (camera.bindingAxis === "x") {
		close(minU, margin * W, 1e-6, "left extreme on the margin");
		close(maxU, (1 - margin) * W, 1e-6, "right extreme on the margin");
	} else if (camera.bindingAxis === "y") {
		close(minV, margin * H, 1e-6, "top extreme on the margin");
		close(maxV, (1 - margin) * H, 1e-6, "bottom extreme on the margin");
	} else {
		assert.fail(`unexpected depth-bound placement for az=${azimuthDeg}`);
	}
}

// Placement is exact for the lying case the width binds, the standing case height.
{
	const args = { width: W, height: H, fMm: 35, azimuthDeg: 0, elevationDeg: 0, margin: 0.08 };
	const { R, kx, ky } = supportArgs(args);
	const standing = buildCamera({ ...args, support: supportValues(new Float64Array([0, 0, 0, 0, 1.8, 0]), R, kx, ky) });
	// Two points on the camera axis plane at z = 0: D * tan(half vfov) * (1 - 2m) = 0.9.
	close(standing.position.z, 0.9 / ((240 / k35.fy) * (1 - 0.16)), 1e-9, "standing distance from the closed form");
	close(standing.position.y, 0.9, 1e-9, "standing camera centred on the body");
	assert.equal(standing.bindingAxis, "y");
	checks += 1;
}

assert.throws(() => buildCamera({ width: W, height: H, fMm: 35.5, azimuthDeg: 0, elevationDeg: 0, margin: 0.08, support: { axp: 0, axm: 0, ayp: 0, aym: 0, zmax: 0, count: 1 } }), /integer/);
assert.throws(() => supportArgs({ width: W, height: H, fMm: 35, azimuthDeg: 0, elevationDeg: 0, margin: 0.5 }), /margin/);
checks += 2;

console.log(`PASS verify-gt-render-camera (${checks} checks)`);
