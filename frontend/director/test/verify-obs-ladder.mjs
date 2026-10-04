#!/usr/bin/env node
/** Observation ladder math on synthetic inputs (#462): a known camera and a
 * known world motion are turned into an obs NPZ exactly as GVHMR's outputs
 * are laid out, then
 *   - G1 must place the motion in world EXACTLY (rigidly tilted/rotated/shifted
 *     GVHMR global frame, frame-0 registration through the camera);
 *   - G2 must recover a trajectory GVHMR under-scaled, from 2D keypoints;
 *   - G3 must reduce the error of a trajectory scaled by a wrong body size;
 *   - every step, through production conversion, must produce a finite take.
 * Pure: no files, no box, no browser. */
import assert from "node:assert/strict";
import { COCO_TO_SMPL } from "../tools/bench/obs/depth.mjs";
import { axisAngleToMatrix, cameraFromJson, matrixToAxisAngle, worldToCameraPoint, worldToCamOrient, worldToPixel } from "../tools/bench/obs/extrinsics.mjs";
import { depthTrajectory, ladderStep, placeInWorld, smplFk, STEPS, worldSmpl, yawMatrix } from "../tools/bench/obs/ladder.mjs";

// Camera: CozyClay's walk render camera (OpenCV worldToCamera, 832x480, f=777 px).
const cameraJson = {
	K: [[777.0115884251717, 0, 416], [0, 777.0115884251717, 240], [0, 0, 1]],
	worldToCamera: [
		[0.8660254037844387, 0, -0.49999999999999994, 3.4649134198493696],
		[0.043577871373829076, -0.9961946980917455, 0.07547908730517333, 0.2904075971091227],
		[-0.4980973490458727, -0.08715574274765817, -0.862729915662821, 10.562174119816405],
		[0, 0, 0, 1],
	],
};
const cam = cameraFromJson(cameraJson);

// SMPL-like rest skeleton, pelvis at the origin; lowest rest vertex 1.0 m below it.
const REST = [
	[0, 0, 0], [0.09, -0.09, 0], [-0.09, -0.09, 0], [0, 0.11, 0], [0.1, -0.47, 0], [-0.1, -0.47, 0],
	[0, 0.25, 0], [0.1, -0.925, -0.03], [-0.1, -0.925, -0.03], [0, 0.3, 0], [0.11, -0.985, 0.1], [-0.11, -0.985, 0.1],
	[0, 0.51, 0], [0.08, 0.42, 0], [-0.08, 0.42, 0], [0, 0.58, 0.02], [0.17, 0.44, 0], [-0.17, 0.44, 0],
	[0.43, 0.4, 0], [-0.43, 0.4, 0], [0.68, 0.4, 0], [-0.68, 0.4, 0], [0.77, 0.39, 0], [-0.77, 0.39, 0],
];
const rest = { joints: REST, minVertexY: -1.0 };
const ankleHeight = REST[7][1] - rest.minVertexY; // 0.075: true stance ankle height
const FPS = 24, T = 48, STEP = 12;

// World motion: walk towards the camera side at 1.2 m/s, alternating 12-frame
// stances; the stance leg is straight (its ankle exactly at ankleHeight), the
// swing leg flexes hip and knee. A small heading sway exercises rotations.
const leftStance = (f) => Math.floor(f / STEP) % 2 === 0;
const truth = { orient: [], bodyPose: [], pelvis: [] };
for (let f = 0; f < T; f++) {
	const phase = (f % STEP) / STEP, lift = Math.sin(Math.PI * phase);
	const pose = Array.from({ length: 21 }, () => [0, 0, 0]);
	const [hip, knee] = leftStance(f) ? [2, 5] : [1, 4]; // SMPL joints R_hip/R_knee or L_hip/L_knee
	pose[hip - 1] = [-0.5 * lift, 0, 0];
	pose[knee - 1] = [1.0 * lift, 0, 0];
	pose[15] = [0, 0, 0.3]; // left shoulder: arms off the torso
	truth.bodyPose.push(pose);
	truth.orient.push(matrixToAxisAngle(yawMatrix(0.6 + 0.08 * Math.sin(f / 6))));
	truth.pelvis.push([0.3 + 1.2 * Math.sin(0.6) * f / FPS, 1.0, -0.2 + 1.2 * Math.cos(0.6) * f / FPS]);
}
const trueJoints = smplFk(truth, REST);

const member = (rows, shape) => ({ data: Float32Array.from(rows.flat(3)), shape });
const mul = (a, b) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]); return r; };
const apply = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);

/** GVHMR-like global frame: an arbitrary rigid (tilted!) transform of world,
 * with the trajectory optionally under-scaled about frame 0. */
function globalVariant(rotation, shift, scale = 1) {
	const p0 = truth.pelvis[0];
	const pelvisScaled = truth.pelvis.map((p) => p.map((v, k) => p0[k] + scale * (v - p0[k])));
	const orient = truth.orient.map((go) => matrixToAxisAngle(mul(rotation, axisAngleToMatrix(go))));
	const joints = smplFk({ orient: truth.orient, bodyPose: truth.bodyPose, pelvis: pelvisScaled }, REST)
		.map((frame) => frame.slice(0, 22).map((p) => apply(rotation, p).map((v, k) => v + shift[k])));
	return { orient, joints };
}

/** Obs NPZ members. `bodyScale` scales the camera-frame body about the camera
 * centre (a wrong body size): 2D projections are unchanged by construction. */
const BAD_FRAME = 20; // one keypoint failure: the leg keypoints jump 60 px (a detector swap)
function makeObs({ bodyScale = 1 } = {}) {
	const tilt = mul(axisAngleToMatrix([0.12, 0, 0.05]), yawMatrix(-1.1));
	const exact = globalVariant(tilt, [0.4, 0.9, -0.3]);
	const relaxed = globalVariant(tilt, [0.4, 0.9, -0.3], 0.8);
	const incamJoints = trueJoints.map((frame) => frame.slice(0, 22).map((p) => worldToCameraPoint(p, cam).map((v) => v * bodyScale)));
	const kp2d = trueJoints.map((frame) => {
		const points = Array.from({ length: 17 }, () => [0, 0, 0]);
		for (const [coco, smpl] of COCO_TO_SMPL) { const [u, v] = worldToPixel(frame[smpl], cam); points[coco] = [u, v, 0.9]; }
		return points;
	});
	for (const coco of [13, 14, 15, 16]) kp2d[BAD_FRAME][coco][1] += 60;
	const logits = Array.from({ length: T }, (_, f) => (leftStance(f) ? [3, 3, -3, -3, -3, -3] : [-3, -3, 3, 3, -3, -3]));
	const obs = {
		fps: { data: Int32Array.of(FPS), shape: [] },
		kp2d: member(kp2d, [T, 17, 3]),
		static_conf_logits: member(logits, [T, 6]),
		betas_used: { data: new Float32Array(10), shape: [10] },
		incam_global_orient: member(truth.orient.map((go) => worldToCamOrient(go, cam)), [T, 3]),
		incam_pelvis: member(incamJoints.map((frame) => frame[0]), [T, 3]),
		incam_joints: member(incamJoints, [T, 22, 3]),
	};
	for (const [name, variant] of [["pp_default", exact], ["pp_relaxed", relaxed]]) {
		obs[`global_${name}_global_orient`] = member(variant.orient, [T, 3]);
		obs[`global_${name}_body_pose`] = member(truth.bodyPose, [T, 21, 3]);
		obs[`global_${name}_joints`] = member(variant.joints, [T, 22, 3]);
	}
	// Float32 storage, as in the real NPZ: every comparison below allows float32 noise.
	return obs;
}

const rmsXZ = (a, b) => Math.sqrt(a.reduce((s, p, f) => s + (p[0] - b[f][0]) ** 2 + (p[2] - b[f][2]) ** 2, 0) / a.length);
const maxDiff = (a, b) => Math.max(...a.flat(2).map((v, i) => Math.abs(v - b.flat(2)[i])));

const obs = makeObs();

// 1. G1: exact world placement through the camera.
const g1 = worldSmpl("G1", { obs, rest, camera: cameraJson, ankleHeight });
assert.ok(maxDiff(g1.pelvis, truth.pelvis) < 2e-5, `G1 pelvis off by ${maxDiff(g1.pelvis, truth.pelvis)} m`);
const orientErr = Math.max(...g1.orient.map((go, f) => Math.max(...axisAngleToMatrix(go).map((v, k) => Math.abs(v - axisAngleToMatrix(truth.orient[f])[k])))));
assert.ok(orientErr < 2e-5, `G1 orientation off by ${orientErr}`);
assert.ok(maxDiff(smplFk(g1, REST), trueJoints) < 5e-5, "G1 joints must reproduce the world joints");
assert.ok(Math.abs(g1.registration.tiltDeg - g1.registration.appliedTiltDeg) < 1e-9 && g1.registration.tiltDeg > 5, "G1 must fold the GVHMR frame tilt in");
// The yaw-only option registers heading alone: on an already-level world motion seen by an identity camera it is the identity.
const yawOnly = placeInWorld({ orient: g1.orient, bodyPose: g1.bodyPose, pelvis: g1.pelvis }, { incamOrient0: truth.orient[0], incamPelvis0: truth.pelvis[0] }, { R_c2w: [1, 0, 0, 0, 1, 0, 0, 0, 1], t_c2w: [0, 0, 0] }, { rotation: "yaw" });
assert.ok(maxDiff(yawOnly.pelvis, truth.pelvis) < 2e-5, "yaw registration of an already-level motion must be the identity");

// 2. G4 carries GVHMR's under-scaled trajectory; G2 recovers it from 2D.
const g4 = worldSmpl("G4", { obs, rest, camera: cameraJson, ankleHeight });
const g2 = worldSmpl("G2", { obs, rest, camera: cameraJson, ankleHeight });
const e4 = rmsXZ(g4.pelvis, truth.pelvis), e2 = rmsXZ(g2.pelvis, truth.pelvis);
assert.ok(e4 > 0.1, `G4 should inherit the 0.8x trajectory (rms ${e4})`);
assert.ok(e2 < 0.25 * e4 && e2 < 0.04, `G2 must recover the trajectory: rms ${e2} vs G4 ${e4}`);
assert.equal(g2.diagnostics.depth.fallbackFrames, 0);
assert.deepEqual(g2.diagnostics.depth.outlierFrames, [BAD_FRAME], "the corrupted keypoint frame must be rejected before smoothing");
assert.ok(Math.hypot(...g2.pelvis[BAD_FRAME].map((v, k) => v - truth.pelvis[BAD_FRAME][k])) < 0.03, "the rejected frame is interpolated from its neighbours");
assert.ok(Math.abs(g2.diagnostics.floorShiftM) < 0.01, `G2 floor datum of an exact body is ~0, got ${g2.diagnostics.floorShiftM}`);

// 2b. Partial occlusion (fal: the character behind the cube): the few visible
// keypoints still fit in 2D but collapse towards each other, which the solve
// reads as a far-away body. The depth-ratio gate must reject those frames and
// interpolate them from their neighbours.
{
	const occluded = makeObs();
	const OCC = [30, 31, 32, 33];
	const kp = occluded.kp2d.data;
	for (const f of OCC) {
		let cx = 0, cy = 0, n = 0;
		for (let c = 0; c < 17; c++) if (kp[(f * 17 + c) * 3 + 2] > 0) { cx += kp[(f * 17 + c) * 3]; cy += kp[(f * 17 + c) * 3 + 1]; n++; }
		cx /= n; cy /= n;
		for (let c = 0; c < 17; c++) { kp[(f * 17 + c) * 3] = cx + 0.4 * (kp[(f * 17 + c) * 3] - cx); kp[(f * 17 + c) * 3 + 1] = cy + 0.4 * (kp[(f * 17 + c) * 3 + 1] - cy); }
	}
	const gated = depthTrajectory(occluded, cam);
	assert.ok(gated.diagnostics.depthRatioOutlierFrames >= OCC.length, `occluded frames must fail the depth-ratio gate (${gated.diagnostics.depthRatioOutlierFrames})`);
	for (const f of OCC) assert.ok(Math.hypot(...gated.pelvisWorld[f].map((v, k) => v - truth.pelvis[f][k])) < 0.05, `occluded frame ${f} is interpolated from its neighbours`);
	const ungated = depthTrajectory(occluded, cam, { maxDepthRatio: Infinity });
	assert.ok(Math.max(...OCC.map((f) => Math.hypot(...ungated.pelvisWorld[f].map((v, k) => v - truth.pelvis[f][k])))) > 0.5, "without the gate the occluded frames fly off (the test can fail)");
}

// 3. A wrong body size (0.85x) pulls the depth trajectory towards the camera;
// G3's stance-ankle rays onto the known floor pull it back.
const small = makeObs({ bodyScale: 0.85 });
const smallRest = { joints: REST.map((p) => p.map((v) => v * 0.85)), minVertexY: -0.85 };
const s2 = worldSmpl("G2", { obs: small, rest: smallRest, camera: cameraJson, ankleHeight });
// The synthetic walk glides (the straight stance leg moves with the pelvis), so
// it has no kinematically planted foot; exercise G3 through its logits mode.
const s3 = worldSmpl("G3", { obs: small, rest: smallRest, camera: cameraJson, ankleHeight, options: { stanceMode: "logits" } });
const es2 = rmsXZ(s2.pelvis, truth.pelvis), es3 = rmsXZ(s3.pelvis, truth.pelvis);
assert.ok(es2 > 0.5, `scaled body must displace the G2 trajectory (rms ${es2})`);
assert.ok(s3.diagnostics.ground.contactCount >= T / 2, `G3 must find the stance contacts (${s3.diagnostics.ground.contactCount})`);
assert.ok(es3 < 0.2 * es2, `G3 must improve the scaled trajectory: rms ${es3} vs G2 ${es2}`);

// 4. Every step through production conversion yields a finite take of T frames.
const g5 = ladderStep("G5", { mannequin: { obs: small, rest: smallRest }, camera: cameraJson, ankleHeight, options: { stanceMode: "logits" } });
const endpoints = [0, T - 1].map((f) => ({ rotMats: g5.motion.rotMats.slice(f * 243, (f + 1) * 243), rootPos: g5.motion.rootPos.slice(f * 3, f * 3 + 3) }));
for (const step of STEPS) {
	const out = ladderStep(step, { base: { obs, rest }, mannequin: { obs: small, rest: smallRest }, camera: cameraJson, endpoints, boxes: [], ankleHeight, options: { stanceMode: "logits" } });
	const m = out.motion;
	assert.equal(m.frames, T, `${step} frames`);
	assert.equal(m.fps, FPS, `${step} fps`);
	for (const key of ["rotMats", "rootPos", "posedJoints"]) assert.ok(m[key] instanceof Float32Array && m[key].every(Number.isFinite), `${step} ${key} finite Float32Array`);
	if (step === "Gbest") {
		assert.equal(out.diagnostics.pin.applied, true, "Gbest pins a >0.5 m A->B take");
		assert.equal(out.diagnostics.contacts.sceneSolver, "ray", "Gbest defaults to the camera-ray scene solver");
		assert.ok(Array.isArray(out.diagnostics.conversion.headingRuns), "Gbest records heading-unwrapper runs");
		assert.equal(out.diagnostics.footLock.disabled, undefined, "Gbest enables foot locking by default");
		// A/B and the take share the Studio's anchored frame: ends land on A/B,
		// the middle keeps G5's trajectory relative to its own frame 0.
		const root = (motion, f) => Array.from(motion.rootPos.slice(f * 3, f * 3 + 3));
		const a = endpoints[0].rootPos, b = endpoints[1].rootPos;
		assert.ok(Math.hypot(root(m, 0)[0], root(m, 0)[2]) < 1e-4, "Gbest frame 0 at A (anchored)");
		assert.ok(Math.hypot(root(m, T - 1)[0] - (b[0] - a[0]), root(m, T - 1)[2] - (b[2] - a[2])) < 1e-4, "Gbest last frame at B (anchored)");
		const mid = T / 2, g5mid = root(g5.motion, mid), g50 = root(g5.motion, 0);
		assert.ok(Math.hypot(root(m, mid)[0] - (g5mid[0] - g50[0]), root(m, mid)[2] - (g5mid[2] - g50[2])) < 1e-4, "Gbest mid-clip keeps G5's anchored trajectory");
	}
}
// G0: GVHMR's ayfz frame puts the frame-0 pelvis on the XZ origin.
const g0 = worldSmpl("G0", { obs, rest, camera: cameraJson, ankleHeight });
assert.ok(Math.hypot(g0.pelvis[0][0], g0.pelvis[0][2]) < 1e-6, "G0 ayfz frame-0 pelvis at the XZ origin");

// 5. Pin modes: A differs from the take's first pose in a limb (60 deg) and in
// heading (20 deg). "heading" keeps the take's limbs and turns only the root;
// "full" copies A's limbs too (the half-second morph users saw as a jump).
{
	const rotAbout = (axis, a) => { const c = Math.cos(a), s = Math.sin(a); return axis === "y" ? [c, 0, s, 0, 1, 0, -s, 0, c] : [1, 0, 0, 0, c, -s, 0, s, c]; };
	const mm = (a, b) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
	const A = { rotMats: Float32Array.from(endpoints[0].rotMats), rootPos: endpoints[0].rootPos };
	A.rotMats.set(mm(rotAbout("y", 0.35), Array.from(A.rotMats.slice(0, 9))), 0);
	const LIMB = 5;
	A.rotMats.set(mm(rotAbout("x", 1.05), Array.from(A.rotMats.slice(LIMB * 9, LIMB * 9 + 9))), LIMB * 9);
	const run = (pinMode) => ladderStep("Gbest", { mannequin: { obs: small, rest: smallRest }, camera: cameraJson, endpoints: [A, endpoints[1]], boxes: [], ankleHeight, options: { stanceMode: "logits", pinMode } }).motion;
	const limb0 = (m) => Array.from(m.rotMats.slice(LIMB * 9, LIMB * 9 + 9));
	const yaw0 = (m) => Math.atan2(m.rotMats[2], m.rotMats[8]);
	const close = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) < tol);
	const heading = run("heading"), full = run("full");
	assert.ok(close(limb0(heading), limb0(g5.motion), 1e-4), "heading pin keeps the take's own limb pose at frame 0");
	assert.ok(close(limb0(full), Array.from(A.rotMats.slice(LIMB * 9, LIMB * 9 + 9)), 1e-4), "full pin copies A's limb pose (the test can fail)");
	assert.ok(Math.abs(yaw0(heading) - Math.atan2(A.rotMats[2], A.rotMats[8])) < 1e-3, "heading pin turns the root to A's heading at frame 0");
}

console.log(`PASS: G1 exact (pelvis ${maxDiff(g1.pelvis, truth.pelvis).toExponential(1)} m, tilt ${g1.registration.tiltDeg.toFixed(1)} deg folded); G2 rms ${(e2 * 100).toFixed(1)} cm vs G4 ${(e4 * 100).toFixed(1)} cm; G3 rms ${(es3 * 100).toFixed(1)} cm vs scaled G2 ${(es2 * 100).toFixed(1)} cm (${s3.diagnostics.ground.contactCount} contacts); ${STEPS.length} steps convert`);
