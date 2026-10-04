#!/usr/bin/env node
// Pure math of the mocap bench (#431): alignment, Procrustes, ATE, IoU, box
// distance, timeline pairing, calibration composition, and the renderer's
// take transform / given-camera helpers.
import assert from "node:assert/strict";
import { applyMotionCalibration } from "../src/ardy/motion-calibration.js";
import {
	applyYawTranslation,
	boxContactValues,
	composeCalibration,
	contactFromSigned,
	displacementXZ,
	fitYawTranslation,
	maskIoU,
	meanJointError,
	parseBox,
	pathLengthXZ,
	procrustesError,
	resampleToTimeline,
	rootRelativeError,
	rotateYaw,
	similarityAlign,
	trajectoryError,
} from "../tools/bench/metrics.mjs";
import { buildCamera, cameraFromRecord, projectPoint, supportArgs, supportValues, translateCamera } from "../tools/gt-render/camera-math.mjs";
import { parseTransform, transformTake } from "../tools/gt-render/take-transform.mjs";

let checks = 0;
const close = (actual, expected, tolerance, label) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (tol ${tolerance})`);
	checks += 1;
};
// Deterministic pseudo-random points (no Math.random: reproducible failures).
let seed = 12345;
const rand = () => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648 - 0.5;
};
const cloud = (n) => Array.from({ length: n }, () => [rand() * 2, rand() * 2 + 1, rand() * 2]);

// --- yaw + ground translation ------------------------------------------------
{
	const src = cloud(22);
	const g = { yawRad: (30 * Math.PI) / 180, tx: 1.25, tz: -0.5 };
	const dst = src.map((p) => applyYawTranslation(p, g));
	const fit = fitYawTranslation(src, dst);
	close(fit.yawDeg, 30, 1e-9, "yaw recovered");
	close(fit.tx, 1.25, 1e-9, "tx recovered");
	close(fit.tz, -0.5, 1e-9, "tz recovered");
	// Same sign as the Studio calibration (applyMotionCalibration).
	const flat = Float32Array.from(src.flat());
	const { motion } = applyMotionCalibration({ frames: 1, posedJoints: flat, rootPos: flat.slice(0, 3) }, { yawDeg: 30 });
	const rotated = Array.from({ length: src.length }, (_, i) => Array.from(motion.posedJoints.slice(i * 3, i * 3 + 3)));
	close(fitYawTranslation(src, rotated).yawDeg, 30, 1e-4, "yaw sign matches applyMotionCalibration");
	// Height is not aligned away.
	const lifted = dst.map(([x, y, z]) => [x, y + 0.2, z]);
	const aligned = src.map((p) => applyYawTranslation(p, fitYawTranslation(src, lifted)));
	close(meanJointError(aligned, lifted), 0.2, 1e-9, "a height error survives the ground alignment");
}

// --- similarity Procrustes -----------------------------------------------------
{
	const src = cloud(22);
	const q = [0.3, -0.5, 0.7, 0.4];
	const n = Math.hypot(...q);
	const [w, x, y, z] = q.map((v) => v / n);
	const R = [
		1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
		2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
		2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
	];
	const dst = src.map((p) => [0, 1, 2].map((r) => 1.3 * (R[r * 3] * p[0] + R[r * 3 + 1] * p[1] + R[r * 3 + 2] * p[2]) + [0.4, -2, 3][r]));
	const fit = similarityAlign(src, dst);
	close(fit.scale, 1.3, 1e-9, "Procrustes scale");
	for (let i = 0; i < 9; i += 1) close(fit.R[i], R[i], 1e-9, `Procrustes R[${i}]`);
	close(procrustesError(src, dst), 0, 1e-9, "PA-MPJPE of an exact similarity is 0");
	// Mirrored target: the best PROPER rotation leaves a residual.
	const mirrored = src.map(([a, b, c]) => [-a, b, c]);
	const m = similarityAlign(src, mirrored);
	const det = m.R[0] * (m.R[4] * m.R[8] - m.R[5] * m.R[7]) - m.R[1] * (m.R[3] * m.R[8] - m.R[5] * m.R[6]) + m.R[2] * (m.R[3] * m.R[7] - m.R[4] * m.R[6]);
	close(det, 1, 1e-9, "Procrustes never returns a reflection");
	assert.ok(procrustesError(src, mirrored) > 1e-3, "a mirror image is not a zero PA error");
	checks += 1;
}

// --- MPJPE, ATE, path ------------------------------------------------------------
{
	const gt = cloud(5);
	const shifted = gt.map(([x, y, z]) => [x + 1, y, z - 2]);
	close(rootRelativeError(shifted, gt), 0, 1e-12, "root-relative MPJPE ignores a translation");
	close(meanJointError(shifted, gt), Math.hypot(1, 2), 1e-12, "absolute joint error sees it");
	const ate = trajectoryError([[0, 0, 0], [3, 0, 0], [0, 4, 0]], [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
	close(ate.mean, 7 / 3, 1e-12, "ATE mean");
	close(ate.rmse, Math.sqrt(25 / 3), 1e-12, "ATE rmse");
	close(ate.max, 4, 0, "ATE max");
	close(ate.final, 4, 0, "ATE final");
	const square = [[0, 5, 0], [1, 0, 0], [1, 9, 1], [0, 1, 1]];
	close(pathLengthXZ(square), 3, 1e-12, "path length is ground-plane only");
	close(displacementXZ(square), 1, 1e-12, "displacement is ground-plane only");
}

// --- mask IoU ------------------------------------------------------------------------
{
	const a = Uint8Array.from([255, 255, 0, 0, 200, 0]);
	const b = Uint8Array.from([255, 0, 255, 0, 127, 0]);
	const r = maskIoU(a, b);
	assert.equal(r.intersection, 1);
	assert.equal(r.union, 4);
	close(r.iou, 0.25, 0, "IoU");
	close(maskIoU(new Uint8Array(4), new Uint8Array(4)).iou, 1, 0, "two empty masks agree");
	assert.throws(() => maskIoU(new Uint8Array(3), new Uint8Array(4)), /sizes differ/);
	checks += 3;
}

// --- box distance ------------------------------------------------------------------------
{
	const box = parseBox('{"min":[0,0,0],"max":[1,2,3]}');
	const outside = boxContactValues([4, 6, 3], box); // corner (1,2,3) -> (3,4,0)
	close(outside.minSignedDistance, 5, 1e-12, "outside distance to a corner");
	assert.equal(outside.insideCount, 0);
	const inside = boxContactValues([0.5, 1, 0.1, 0.5, 1, 1.5], box);
	close(inside.minSignedDistance, -0.5, 1e-12, "deepest vertex: 0.5 from its nearest face");
	assert.equal(inside.insideCount, 2);
	assert.equal(inside.closestIndex, 1);
	const mixed = boxContactValues([2, 1, 1, 0.9, 1, 1], box);
	close(mixed.minSignedDistance, -0.1, 1e-12, "min over vertices, inside wins");
	close(boxContactValues([1, 1, 1], box).minSignedDistance, 0, 0, "on a face is distance 0");
	close(contactFromSigned(0.3).minDistanceM, 0.3, 0, "clearance");
	close(contactFromSigned(0.3).maxPenetrationM, 0, 0, "no penetration outside");
	close(contactFromSigned(-0.2).maxPenetrationM, 0.2, 0, "penetration depth");
	close(contactFromSigned(-0.2).minDistanceM, 0, 0, "touching distance");
	assert.throws(() => parseBox('{"min":[0,0,0],"max":[1,-1,1]}'), /min must not exceed/);
	// Self-contained: survives the toString round trip render.mjs uses.
	const revived = new Function(`return (${boxContactValues.toString()})`)();
	close(revived([4, 6, 3], box).minSignedDistance, 5, 1e-12, "boxContactValues is injectable");
	checks += 5;
}

// --- timeline pairing ------------------------------------------------------------------------
{
	const same = resampleToTimeline({ gtFrames: 10, gtFps: 24, predFrames: 10, predFps: 24 });
	assert.deepEqual(same.predIndex, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	assert.equal(same.exact, true);
	const short = resampleToTimeline({ gtFrames: 10, gtFps: 24, predFrames: 8, predFps: 24 });
	assert.equal(short.scored, 8);
	assert.equal(short.dropped, 2);
	assert.equal(short.predIndex[9], null);
	const fast = resampleToTimeline({ gtFrames: 5, gtFps: 24, predFrames: 100, predFps: 30 });
	assert.deepEqual(fast.predIndex, [0, 1, 3, 4, 5]); // round(i * 30 / 24)
	assert.equal(fast.exact, false);
	checks += 7;
}

// --- calibration composition ------------------------------------------------------------------------
{
	const anchor = { x: 0.7, z: -1.1 };
	const place = (u, c) => {
		const r = rotateYaw([u[0] - anchor.x, u[1], u[2] - anchor.z], (c.yawDeg * Math.PI) / 180);
		return [anchor.x + c.offsetX + r[0], r[1], anchor.z + c.offsetZ + r[2]];
	};
	const calibration = { scale: 1, yawDeg: 12, offsetX: 0.4, offsetY: 0, offsetZ: -0.3 };
	const g = { yawRad: (-40 * Math.PI) / 180, yawDeg: -40, tx: 2, tz: 0.5 };
	const composed = composeCalibration(calibration, anchor, g);
	close(composed.yawDeg, -28, 1e-12, "yaws add");
	for (const u of cloud(6)) {
		const direct = applyYawTranslation(place(u, calibration), g);
		const once = place(u, composed);
		close(Math.hypot(direct[0] - once[0], direct[1] - once[1], direct[2] - once[2]), 0, 1e-12, "composed calibration == calibration then G");
	}
}

// --- take transform (render.mjs --transform) ------------------------------------------------------------------------
{
	assert.throws(() => parseTransform('{"yaw":3}'), /unknown key/);
	assert.throws(() => parseTransform('{"scale":50}'), /outside the Studio calibration range/);
	const t = parseTransform('{"yawDeg":90,"offsetX":1.5,"offsetZ":-2}');
	const frames = 2;
	const rotMats = new Float32Array(frames * 27 * 9);
	for (let i = 0; i < frames * 27; i += 1) rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], i * 9);
	const posedJoints = Float32Array.from({ length: frames * 27 * 3 }, (_, i) => (i % 3 === 1 ? 1 : i * 0.01));
	const rootPos = Float32Array.from({ length: frames * 3 }, (_, i) => i * 0.1);
	const { motion, sceneOffset } = transformTake({ frames, fps: 24, rotMats, posedJoints, rootPos }, t);
	assert.deepEqual(sceneOffset, { x: 1.5, y: 0, z: -2 });
	// Root local rotation becomes Ry(90) (x -> -z, z -> x); other joints untouched.
	const expected = [0, 0, 1, 0, 1, 0, -1, 0, 0];
	for (let i = 0; i < 9; i += 1) close(motion.rotMats[i], expected[i], 1e-7, `root rot[${i}]`);
	for (let i = 0; i < 9; i += 1) close(motion.rotMats[9 + i], [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 0, `joint 1 rot[${i}]`);
	// Joints rotated the same way, offsets NOT baked in (the renderer moves the camera).
	const p = [posedJoints[3], posedJoints[4], posedJoints[5]];
	const r = rotateYaw(p, Math.PI / 2);
	for (let k = 0; k < 3; k += 1) close(motion.posedJoints[3 + k], r[k], 1e-6, `rotated joint[${k}]`);
}

// --- given camera (render.mjs --camera) ------------------------------------------------------------------------
{
	const geometry = { width: 832, height: 480, fMm: 35, azimuthDeg: 20, elevationDeg: 5, margin: 0.08 };
	const { R, kx, ky } = supportArgs(geometry);
	const pts = cloud(30).flat();
	const camera = buildCamera({ ...geometry, support: supportValues(pts, R, kx, ky) });
	const record = JSON.parse(JSON.stringify({ ...camera, worldToCamera: camera.worldToCameraCv }));
	const again = cameraFromRecord(record);
	for (const p of cloud(5)) {
		const a = projectPoint(p, camera);
		const b = projectPoint(p, again);
		close(Math.hypot(a[0] - b[0], a[1] - b[1]), 0, 1e-9, "camera.json round trip projects identically");
	}
	assert.throws(() => cameraFromRecord({ ...record, yaw: record.yaw + 0.01 }), /worldToCamera differs/);
	checks += 1;
	const o = { x: 1, y: 0, z: -0.5 };
	const moved = translateCamera(camera, { x: -o.x, y: -o.y, z: -o.z });
	for (const p of cloud(5)) {
		const a = projectPoint([p[0] + o.x, p[1] + o.y, p[2] + o.z], camera);
		const b = projectPoint(p, moved);
		close(Math.hypot(a[0] - b[0], a[1] - b[1]), 0, 1e-9, "offset take in camera == take in the opposite-moved camera");
	}
}

console.log(`verify-bench-metrics: ${checks} checks passed`);
