/**
 * Observation ladder (#462): pure composition of the phase-1 observation
 * modules into cumulative world-motion estimates, each converted to cskel27
 * through production's own converters. No I/O; tools/bench/obs-bench.mjs
 * does the extraction, caching and scoring.
 *
 * Inputs per ladder: the obs NPZ members (readNpz shape {data, shape};
 * tools/bench/cclay_bench_extract_obs.py documents them), the SMPL rest joints
 * of obs.betas_used (tools/bench/obs/rest_joints.py), camera.json, the
 * character's rest skeleton, A/B endpoint poses and scene boxes. Nothing
 * else: no ground-truth intermediate frame enters any step.
 *
 *   G0  global_pp_default, GVHMR "ayfz" normalisation, production conversion
 *   G1  global_pp_default placed in CozyClay world through the known camera:
 *       frame-0 pelvis and heading from the camera-frame (incam) estimate,
 *       GVHMR's global trajectory carried by ONE rigid yaw + translation
 *   G4  G1 on global_pp_relaxed
 *   G2  per-frame pelvis from 2D keypoints + known K + incam root-relative
 *       joints (depth.mjs), mapped to world; rotations from G4
 *   G3  G2 with stance-foot XZ corrections from 2D ankles (ground.mjs) rayed
 *       onto the plane of the character's standing ankle bone
 *   G5  G1 -> G4 -> G2 -> G3 on the obs extracted with the mannequin betas
 *   Gbest  G5 + A/B endpoint pinning (locomotion only) + scene contacts
 *
 * "Production conversion" is what the box runner and extract-bench do after
 * GVHMR: temporal quaternion gaussian (GVHMR_SMOOTH_SIGMA) on the SMPL params,
 * smplToCskel27Motion, stabilizeMotion with production defaults and
 * guardTrajectoryFloor (a no-op without runner trajectory events, exactly as
 * on the direct extraction path).
 */
import { guardTrajectoryFloor } from "../../ardy/gvhmr-floor.mjs";
import { stabilizeMotion } from "../../ardy/motion-stabilize.mjs";
import { GVHMR_SMOOTH_SIGMA } from "../../ardy/runners/gvhmr-worker.mjs";
import { smplToCskel27Motion } from "../../ardy/smpl-cskel27.mjs";
import { productionExtractEnv } from "../extract-bench-lib.mjs";
import { fitContacts, penetrates } from "../fit/contact.mjs";
import { lockFeet } from "../fit/footlock.mjs";
import { cloneMotion, jointsAt, shiftFrame, smoothstep } from "../fit/motion.mjs";
import { unwrapHeadingFlips } from "./heading.mjs";
import { pinEndpoints } from "../fit/pin.mjs";
import { correctTrajectory } from "./ground.mjs";
import { solveTranslations } from "./depth.mjs";
import { axisAngleToMatrix, cameraFromJson, camToWorldPoint, matrixToAxisAngle, pixelRay } from "./extrinsics.mjs";

export const STEPS = Object.freeze(["G0", "G1", "G4", "G2", "G3", "G5", "Gbest"]);
export const SMPL_PARENTS = Object.freeze([-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21]);
const FOOT_JOINTS = [7, 8, 10, 11]; // L_ankle, R_ankle, L_foot, R_foot (ground.mjs FOOT_NAMES order)
export const DEFAULTS = Object.freeze({
	headingUnwrap: true,
	// Body-pose smoothing. With heading flips unwrapped first, sigma 2 beats
	// GVHMR's 3 on the 11 gt+cube truths (G0 mean PA 65.0 -> 64.1 mm, accel
	// error 1.67 -> 1.62; gt/run 66.6 -> 59.5 mm); 1.5 re-adds accel error.
	smoothSigma: 2,
	// Root orient + translation keep GVHMR's 3: at 2 the occluded fal/bump
	// roots jitter (Gbest root-accel spikes >20 m/s^2: 16 -> 91 over 24 clips).
	rootSmoothSigma: GVHMR_SMOOTH_SIGMA,
	sceneSolver: "ray",
	footLock: true,
	depthSigma: 2,
	maxSpeedMps: 6,
	minKeypointConfidence: 0.3,
	floorPercentile: 0.1,
	pinMinDisplacementM: 0.5,
	// "heading": A/B fix the root position and facing only; the limbs keep the
	// video's pose. "full" also slerps every joint to A/B, which morphs the body
	// for a visible half second wherever GVHMR's first/last pose differs from A/B
	// (walk: 32 cm at a hand, 8 deg heading).
	pinMode: "heading",
	pinWindowSeconds: 1,
	registration: "full",
	// GVHMR's static probabilities are under-confident on rendered clips
	// (walk: median 0.35-0.46 in true stance, p90 <= 0.10 in swing); at 0.8
	// only 6 of 106 stance frames qualify, at 0.2 precision 0.89 / recall 0.75.
	contactProbability: 0.2,
	// Stance selection for G3 (see ground.mjs). Measured on the walk clip: kinematic
	// 28.6 cm raw root RMSE vs hybrid 43.1 cm vs logits-only 30.1 cm (no contacts).
	stanceMode: "kinematic",
	// Predicted SMPL ankles stand 0.09-0.22 m high in true stance (pose noise); the lower-foot gate still applies.
	maxFootHeight: 0.25,
	// "character": the supplied ankleHeight (rendered rig ankle bone standing in A/B); "self": calibrateAnklePlane.
	anklePlane: "character",
	outlierResidualFactor: 3,
	outlierResidualMinPx: 8,
	// A frame whose solved depth leaves GVHMR's incam depth by more than this
	// factor is an outlier. GT renders stay within 0.97-1.22 (p1-p99); partly
	// occluded fal frames (character behind the cube) fit the few visible
	// joints in 2D yet solve to -0.8x .. 11x.
	maxDepthRatio: 1.33,
	// fitContacts keeps cskel27 joint/bone segments out of the scene boxes but has
	// no skin: the rendered body still sinks in by a limb's radius. Gbest inflates
	// every box by this skin clearance before fitting contacts. Trial (cube/sit +
	// 3 fal): 0 cm -> max pen 9.7-16.3 cm; 8 cm -> 0-8.2 cm with B ends kept;
	// 15 cm -> ~0 cm but B ends jump to 50 cm (contacts override the A/B pins).
	sceneClearanceM: 0.15,
	// fitContacts' time-smooth scene solver: pushes ramp in and out over this
	// half width. The per-frame solver teleported the body up to 0.76 m in one
	// frame (fal stepup: 18 m/s) whenever the nearest box face changed.
	sceneSmoothSeconds: 0.375,
});

// ---------------------------------------------------------------- math
/** Yaw of a row-major rotation about +Y (0 = facing +Z). */
const yawOf = (r) => Math.atan2(r[2], r[8]);
/** Pin target that keeps the take's own pose at frame f and turns only its root
 * to the endpoint's heading; root position comes from the endpoint. */
function headingEndpoint(endpoint, take, f) {
	const rotMats = Float32Array.from(take.rotMats.slice(f * 243, (f + 1) * 243));
	const root = Array.from(rotMats.slice(0, 9));
	const d = yawOf(endpoint.rotMats) - yawOf(root), c = Math.cos(d), s = Math.sin(d);
	rotMats.set(mul3([c, 0, s, 0, 1, 0, -s, 0, c], root), 0);
	return { rotMats, rootPos: endpoint.rootPos };
}

const mul3 = (a, b) => [
	a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
	a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
	a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const tr3 = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const flatRows = (m) => (Array.isArray(m[0]) ? m.flat() : Array.from(m));
export const yawMatrix = (theta) => [Math.cos(theta), 0, Math.sin(theta), 0, 1, 0, -Math.sin(theta), 0, Math.cos(theta)];
const rotationAngle = (m) => Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2)));

function percentile(values, p) {
	const a = [...values].sort((x, y) => x - y);
	const x = (a.length - 1) * p, i = Math.floor(x), t = x - i;
	return a[i] * (1 - t) + (a[i + 1] ?? a[i]) * t;
}

// ---------------------------------------------------------------- obs access
/** readNpz member (or nested array) -> frames of `width` rows of `components`. */
export function framesOf(member, width, components = 3) {
	const data = member?.data ?? member;
	if (Array.isArray(data) && Array.isArray(data[0])) return data.map((row) => row.map((p) => Array.from(p, Number)));
	const stride = width * components;
	if (!data || data.length % stride) throw new Error(`obs member: ${data?.length} values are not frames of [${width}, ${components}]`);
	return Array.from({ length: data.length / stride }, (_, f) => Array.from({ length: width }, (_, j) => Array.from(data.slice(f * stride + j * components, f * stride + (j + 1) * components), Number)));
}
/** readNpz member (or nested array) -> [T][3]. */
export function vectorsOf(member) {
	const data = member?.data ?? member;
	if (Array.isArray(data) && Array.isArray(data[0])) return data.map((row) => Array.from(row, Number));
	return framesOf(member, 1, 3).map((row) => row[0]);
}

/** One GVHMR world variant of the obs as plain SMPL arrays. */
export function obsGlobal(obs, variant) {
	const key = (name) => {
		const value = obs[`global_${variant}_${name}`];
		if (!value) throw new Error(`obs has no global_${variant}_${name}`);
		return value;
	};
	return {
		orient: vectorsOf(key("global_orient")),
		bodyPose: framesOf(key("body_pose"), 21),
		pelvis: framesOf(key("joints"), 22).map((joints) => joints[0]),
		joints: framesOf(key("joints"), 22),
	};
}

export function obsFps(obs) {
	const fps = Number(obs.fps?.data?.[0] ?? obs.fps);
	if (!(fps > 0)) throw new Error("obs has no fps");
	return fps;
}

/** Rest info from rest_joints.py JSON: 24 joints, pelvis at the origin. */
export function restInfo(rest) {
	const joints = rest.restJoints ?? rest;
	if (!Array.isArray(joints) || joints.length !== 24 || !joints.every((p) => p.length === 3 && p.every(Number.isFinite))) throw new Error("rest joints: expected [24, 3]");
	return { joints: joints.map((p) => p.map(Number)), minVertexY: Number.isFinite(rest.restMinVertexY) ? rest.restMinVertexY : null };
}

// ---------------------------------------------------------------- SMPL
/** SMPL FK (tools/ardy/GVHMR-NPZ.md): P_j = P_parent + G_parent (rest_j - rest_parent). */
export function smplFk({ orient, bodyPose, pelvis }, restJoints) {
	return orient.map((go, f) => {
		const G = [axisAngleToMatrix(go)], P = [pelvis[f].slice()];
		for (let j = 1; j < 24; j++) {
			const p = SMPL_PARENTS[j];
			const local = j <= bodyPose[f].length ? bodyPose[f][j - 1] : [0, 0, 0];
			G[j] = mul3(G[p], axisAngleToMatrix(local));
			P[j] = add(P[p], apply3(G[p], sub(restJoints[j], restJoints[p])));
		}
		return P;
	});
}

function aaToQuat(aa) {
	const angle = Math.max(Math.hypot(...aa), 1e-9), s = Math.sin(angle / 2) / angle;
	return [aa[0] * s, aa[1] * s, aa[2] * s, Math.cos(angle / 2)];
}
function quatToAa(q) {
	const n = Math.hypot(...q), [x, y, z] = q.map((v) => v / n), w = Math.max(-1, Math.min(1, q[3] / n));
	let angle = 2 * Math.acos(w);
	const s = Math.sqrt(Math.max(1 - w * w, 1e-9));
	if (angle > Math.PI) angle -= 2 * Math.PI;
	return [x / s * angle, y / s * angle, z / s * angle];
}
function gaussian1d(series, sigma) {
	const radius = Math.floor(4 * sigma + 0.5), kernel = [];
	for (let t = -radius; t <= radius; t++) kernel.push(Math.exp(-0.5 * (t / sigma) ** 2));
	const total = kernel.reduce((a, b) => a + b, 0);
	return series.map((_, f) => {
		const out = new Array(series[0].length).fill(0);
		for (let t = -radius; t <= radius; t++) {
			const row = series[Math.min(series.length - 1, Math.max(0, f + t))], w = kernel[t + radius] / total;
			for (let k = 0; k < out.length; k++) out[k] += w * row[k];
		}
		return out;
	});
}
function smoothAa(series, sigma) {
	const qs = series.map(aaToQuat);
	for (let t = 1; t < qs.length; t++) if (qs[t].reduce((s, v, k) => s + v * qs[t - 1][k], 0) < 0) qs[t] = qs[t].map((v) => -v);
	return gaussian1d(qs, sigma).map(quatToAa);
}

/** Port of cclay_gvhmr_extract.py smooth_motion_params (replicate-padded gaussian, hemisphere-continuous quaternions). */
export function smoothSmplParams({ orient, bodyPose, pelvis }, sigma = GVHMR_SMOOTH_SIGMA) {
	if (!(sigma > 0) || orient.length < 2) return { orient: orient.map((v) => v.slice()), bodyPose: bodyPose.map((f) => f.map((v) => v.slice())), pelvis: pelvis.map((v) => v.slice()) };
	const joints = bodyPose[0].length;
	const perJoint = Array.from({ length: joints }, (_, j) => smoothAa(bodyPose.map((f) => f[j]), sigma));
	return { orient: smoothAa(orient, sigma), bodyPose: bodyPose.map((_, f) => perJoint.map((track) => track[f])), pelvis: gaussian1d(pelvis, sigma) };
}

/** GVHMR's ayfz normalisation as the box runner applies it (compute_T_ayfz2ay on frame 0).
 * The runner's floor datum is the clip's lowest mesh vertex; joints stand in
 * here because smplToCskel27Motion re-grounds by percentile, cancelling any
 * constant height offset exactly. */
export function ayfzNormalize({ orient, bodyPose, pelvis, joints }) {
	const offset = [pelvis[0][0], Math.min(...joints.flat().map((p) => p[1])), pelvis[0][2]];
	const j0 = joints[0].map((p) => sub(p, offset));
	const rl = [j0[1][0] - j0[2][0] + j0[16][0] - j0[17][0], j0[1][2] - j0[2][2] + j0[16][2] - j0[17][2]];
	let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	if (rl[0] ** 2 + rl[1] ** 2 >= 1e-4) {
		const n = Math.hypot(...rl), x = [rl[0] / n, 0, rl[1] / n], y = [0, 1, 0];
		const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
		const ayfz2ay = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]; // columns x, y, z
		R = tr3(ayfz2ay);
	}
	return {
		orient: orient.map((go) => matrixToAxisAngle(mul3(R, axisAngleToMatrix(go)))),
		bodyPose,
		pelvis: pelvis.map((p) => apply3(R, sub(p, offset))),
		registration: { kind: "ayfz", rotation: R, offset },
	};
}

/** G1/G4: one rigid ay -> world transform solved at frame 0. The pelvis lands
 * on the camera-frame estimate mapped through the known extrinsics and the
 * frame-0 orientation on the camera-frame orientation mapped the same way;
 * GVHMR's global trajectory and heading are carried by that one transform.
 * `rotation: "full"` (default) is the exact rigid registration: GVHMR's
 * gravity-view frame is only as level as its gravity estimate, and on a
 * static rendered camera that estimate tilts (walk: ~10 deg, the take climbs
 * ~1 m over 7 m), which the known camera removes. `rotation: "yaw"` keeps
 * GVHMR's gravity and registers heading only. Both components are reported. */
export function placeInWorld({ orient, bodyPose, pelvis }, { incamOrient0, incamPelvis0 }, cam, { rotation = "full" } = {}) {
	if (!["full", "yaw"].includes(rotation)) throw new Error(`placeInWorld: rotation must be full or yaw, got ${rotation}`);
	const Rc2w = flatRows(cam.R_c2w);
	const worldOrient0 = mul3(Rc2w, axisAngleToMatrix(incamOrient0));
	const full = mul3(worldOrient0, tr3(axisAngleToMatrix(orient[0])));
	const yaw = Math.atan2(full[2] - full[6], full[0] + full[8]);
	const R = rotation === "full" ? full : yawMatrix(yaw);
	const pelvisW0 = camToWorldPoint(incamPelvis0, cam);
	return {
		orient: orient.map((go) => matrixToAxisAngle(mul3(R, axisAngleToMatrix(go)))),
		bodyPose,
		pelvis: pelvis.map((p) => add(apply3(R, sub(p, pelvis[0])), pelvisW0)),
		registration: {
			kind: `incam-frame0-${rotation}`,
			yawDeg: yaw * 180 / Math.PI,
			tiltDeg: rotationAngle(mul3(tr3(yawMatrix(yaw)), full)) * 180 / Math.PI,
			appliedTiltDeg: rotation === "full" ? rotationAngle(mul3(tr3(yawMatrix(yaw)), full)) * 180 / Math.PI : 0,
			pelvisWorld0: pelvisW0,
			rotation: R,
		},
	};
}

/** G2 trajectory: per-frame camera-space pelvis from 2D keypoints and the
 * incam body (depth.mjs), mapped to world. Jumps are guarded twice: a frame
 * whose own reprojection residual is an outlier (a keypoint failure, e.g. a
 * left/right swap: one walk frame solved 4 m deeper at 24 px against a 4 px
 * median) is replaced by interpolating its inlier neighbours BEFORE the
 * gaussian can spread it, then the smoothed track is speed-limited. */
export function depthTrajectory(obs, cam, { sigma = DEFAULTS.depthSigma, maxSpeedMps = DEFAULTS.maxSpeedMps, minConf = DEFAULTS.minKeypointConfidence, outlierFactor = DEFAULTS.outlierResidualFactor, outlierMinPx = DEFAULTS.outlierResidualMinPx, maxDepthRatio = DEFAULTS.maxDepthRatio } = {}) {
	const joints = framesOf(obs.incam_joints, 22), pelvis = vectorsOf(obs.incam_pelvis);
	const jointsRel = joints.map((frame, f) => frame.map((p) => sub(p, pelvis[f])));
	const raw = solveTranslations({ jointsRel, kp2d: obs.kp2d, K: cam.K, minConf, sigma: 0, incamTransl: pelvis });
	const finite = raw.residualPx.filter(Number.isFinite);
	const limit = Math.max(outlierMinPx, outlierFactor * (finite.length ? percentile(finite, 0.5) : 0));
	const depthRatio = raw.transl.map((t, f) => t[2] / pelvis[f][2]);
	const depthOutlier = depthRatio.map((ratio) => !(ratio <= maxDepthRatio && ratio >= 1 / maxDepthRatio));
	const outlier = raw.residualPx.map((r, f) => raw.flags[f] || !(r <= limit) || depthOutlier[f]);
	const inliers = outlier.flatMap((bad, f) => (bad ? [] : [f]));
	const filled = raw.transl.map((t, f) => {
		if (!outlier[f] || !inliers.length) return t;
		const next = inliers.find((i) => i > f), prev = inliers.findLast((i) => i < f);
		if (prev === undefined) return raw.transl[next];
		if (next === undefined) return raw.transl[prev];
		const w = (f - prev) / (next - prev);
		return raw.transl[prev].map((v, k) => v + (raw.transl[next][k] - v) * w);
	});
	// Outlier frames take depth.mjs's fallback path (the interpolated value): zero their keypoint confidence.
	const kp = Float32Array.from(obs.kp2d.data ?? obs.kp2d.flat(2));
	outlier.forEach((bad, f) => { if (bad) for (let c = 0; c < 17; c++) kp[(f * 17 + c) * 3 + 2] = 0; });
	const solved = solveTranslations({ jointsRel, kp2d: { data: kp, shape: [joints.length, 17, 3] }, K: cam.K, minConf, sigma, incamTransl: filled, maxJump: maxSpeedMps / obsFps(obs) });
	const residual = solved.residualPx.filter(Number.isFinite);
	return {
		pelvisWorld: solved.transl.map((t) => camToWorldPoint(t, cam)),
		pelvisCamera: solved.transl,
		diagnostics: {
			fallbackFrames: raw.flags.filter(Boolean).length,
			outlierFrames: outlier.flatMap((bad, f) => (bad && !raw.flags[f] ? [f] : [])),
			outlierLimitPx: limit,
			depthRatioOutlierFrames: depthOutlier.filter((bad, f) => bad && !raw.flags[f]).length,
			maxDepthRatio,
			residualPxMedian: residual.length ? percentile(residual, 0.5) : null,
			residualPxP90: residual.length ? percentile(residual, 0.9) : null,
			depthScaleVsIncamMedian: percentile(solved.transl.map((t, f) => t[2] / pelvis[f][2]), 0.5),
			sigma, maxJumpM: maxSpeedMps / obsFps(obs), minConf,
		},
	};
}

/** Known floor (y = 0): shift so the body's estimated soles sit on it. The
 * sole under each foot joint is the rest mesh's clearance of that joint. */
export function floorOffset(joints24, rest, p = DEFAULTS.floorPercentile) {
	const clearance = FOOT_JOINTS.map((j) => rest.minVertexY === null ? 0 : rest.joints[j][1] - rest.minVertexY);
	return percentile(joints24.map((frame) => Math.min(...FOOT_JOINTS.map((j, i) => frame[j][1] - clearance[i]))), p);
}

// ---------------------------------------------------------------- world SMPL steps
function incamFrame0(obs) {
	return { incamOrient0: vectorsOf(obs.incam_global_orient)[0], incamPelvis0: vectorsOf(obs.incam_pelvis)[0] };
}

/** SMPL world estimate for G0/G1/G4/G2/G3 on one obs. */
export function worldSmpl(step, { obs, rest, camera, ankleHeight, options = {} }) {
	const cam = camera.R_c2w ? camera : cameraFromJson(camera);
	const opts = { ...DEFAULTS, ...options };
	if (step === "G0") {
		const g = obsGlobal(obs, "pp_default");
		const out = ayfzNormalize(g);
		return { ...out, diagnostics: { source: "global_pp_default", registration: out.registration } };
	}
	if (step === "G1" || step === "G4") {
		const variant = step === "G1" ? "pp_default" : "pp_relaxed";
		const out = placeInWorld(obsGlobal(obs, variant), incamFrame0(obs), cam, { rotation: opts.registration });
		return { ...out, diagnostics: { source: `global_${variant}`, registration: out.registration, floorOffsetNotAppliedM: floorOffset(smplFk(out, rest.joints), rest, opts.floorPercentile) } };
	}
	if (step === "G2" || step === "G3") {
		const g4 = placeInWorld(obsGlobal(obs, "pp_relaxed"), incamFrame0(obs), cam, { rotation: opts.registration });
		const depth = depthTrajectory(obs, cam, { sigma: opts.depthSigma, maxSpeedMps: opts.maxSpeedMps, minConf: opts.minKeypointConfidence, outlierFactor: opts.outlierResidualFactor, outlierMinPx: opts.outlierResidualMinPx, maxDepthRatio: opts.maxDepthRatio });
		const raw = { orient: g4.orient, bodyPose: g4.bodyPose, pelvis: depth.pelvisWorld };
		const floor = floorOffset(smplFk(raw, rest.joints), rest, opts.floorPercentile);
		const g2 = { ...raw, pelvis: raw.pelvis.map((p) => [p[0], p[1] - floor, p[2]]) };
		const diagnostics = { source: "depth.mjs pelvis + G4 rotations", rotations: g4.registration, depth: depth.diagnostics, floorShiftM: -floor };
		if (step === "G2") return { ...g2, diagnostics };
		const joints = smplFk(g2, rest.joints);
		const plane = opts.anklePlane === "self"
			? calibrateAnklePlane({ joints, obs, cam, contactProbability: opts.contactProbability, maxFootHeight: opts.maxFootHeight, minConf: opts.minKeypointConfidence })
			: { height: ankleHeight, source: "character" };
		if (opts.anklePlane !== "self" && !Number.isFinite(ankleHeight)) throw new Error("G3 needs the character's standing ankle height (ankleHeight)");
		if (!Number.isFinite(plane.height)) return { ...g2, diagnostics: { ...diagnostics, ground: { contactCount: 0, anklePlane: plane, note: "no qualifying stance frame to calibrate the ankle plane; G3 = G2" } } };
		const corrected = correctTrajectory({
			rootW: g2.pelvis,
			footW: joints.map((frame) => FOOT_JOINTS.map((j) => frame[j])),
			kp2d: obs.kp2d,
			static_conf_logits: obs.static_conf_logits,
			camera: cam,
			ankleHeight: plane.height,
			contactProbability: opts.contactProbability,
			maxFootHeight: opts.maxFootHeight,
			minKeypointConfidence: opts.minKeypointConfidence,
			fps: obsFps(obs),
			stanceMode: opts.stanceMode,
		});
		const { stanceRuns, contactByFoot, ...ground } = corrected.diagnostics;
		// Why a foot did or did not qualify: GVHMR's static probability and the estimated ankle height, per foot.
		const logits = framesOf(obs.static_conf_logits, 1, 6).map((row) => row[0]);
		const sigmoid = (x) => 1 / (1 + Math.exp(-x));
		const gates = Object.fromEntries([["L_ankle", 0, 7], ["R_ankle", 2, 8]].map(([name, logit, joint]) => [name, {
			staticFrames: logits.filter((row) => Math.max(sigmoid(row[logit]), sigmoid(row[logit + 1])) > opts.contactProbability).length,
			lowAnkleFrames: joints.filter((frame) => frame[joint][1] < opts.maxFootHeight).length,
			contactFrames: contactByFoot[name].length,
		}]));
		return { ...g2, pelvis: corrected.rootW, diagnostics: { ...diagnostics, ground: { ...ground, anklePlane: plane, characterAnkleHeight: ankleHeight, stanceRuns: stanceRuns.length, gates } } };
	}
	throw new Error(`worldSmpl: unknown step ${step}`);
}

/** The height above the floor of the point the 2D ankle keypoint marks,
 * measured against the body-scale (G2) depth: for every stance sample that
 * ground.mjs would accept, the height at which the ankle's camera ray passes
 * the predicted ankle's horizontal distance; the median over the clip. The
 * rig's ankle bone is NOT that point (walk: ViTPose's ankle on the rendered
 * mannequin behaves like a point ~3-7 cm above the bone), and at a grazing
 * camera each cm of plane height moves the floor intersection ~10 cm along
 * the ray, so the plane is calibrated rather than assumed. G3 then corrects
 * the per-stance drift of G2, not its overall depth scale. */
export function calibrateAnklePlane({ joints, obs, cam, contactProbability, maxFootHeight, minConf }) {
	const logits = framesOf(obs.static_conf_logits, 1, 6).map((row) => row[0]), kp = framesOf(obs.kp2d, 17);
	const sigmoid = (x) => 1 / (1 + Math.exp(-x));
	const origin = cam.t_c2w, heights = [];
	for (let f = 0; f < joints.length; f++) {
		for (const [logit, joint, other, coco] of [[0, 7, 8, 15], [2, 8, 7, 16]]) {
			const p = joints[f][joint], k = kp[f][coco];
			if (!(Math.max(sigmoid(logits[f][logit]), sigmoid(logits[f][logit + 1])) > contactProbability) || !(p[1] < maxFootHeight) || p[1] > joints[f][other][1] || !(k[2] >= minConf)) continue;
			const d = pixelRay(k[0], k[1], cam).direction, horizontal = Math.hypot(d[0], d[2]);
			if (!(horizontal > 1e-9)) continue;
			heights.push(origin[1] + d[1] * Math.hypot(p[0] - origin[0], p[2] - origin[2]) / horizontal);
		}
	}
	return { height: heights.length ? percentile(heights, 0.5) : NaN, source: "self-calibrated from G2 depth", samples: heights.length, p10: heights.length ? percentile(heights, 0.1) : null, p90: heights.length ? percentile(heights, 0.9) : null };
}

// ---------------------------------------------------------------- conversion
/** Production conversion: runner smoothing -> smplToCskel27Motion -> stabilizeMotion -> guardTrajectoryFloor. */
export function toCskel27({ orient, bodyPose, pelvis }, rest, fps, { smoothSigma = GVHMR_SMOOTH_SIGMA, rootSmoothSigma = smoothSigma, headingUnwrap = false, betas } = {}) {
	const frames = orient.length;
	const padded = bodyPose.map((f) => (f.length === 23 ? f : [...f, [0, 0, 0], [0, 0, 0]]));
	const heading = headingUnwrap ? unwrapHeadingFlips(orient) : { orient: orient.map((v) => v.slice()), runs: [] };
	const root = smoothSmplParams({ orient: heading.orient, bodyPose: padded.slice(0, 1).map(() => [[0, 0, 0]]), pelvis }, rootSmoothSigma);
	const smooth = { ...root, bodyPose: smoothSmplParams({ orient: heading.orient, bodyPose: padded, pelvis }, smoothSigma).bodyPose };
	const members = {
		fps: { data: Int32Array.of(fps), shape: [] },
		smpl_global_orient: { data: Float32Array.from(smooth.orient.flat()), shape: [frames, 3] },
		smpl_body_pose: { data: Float32Array.from(smooth.bodyPose.flat(2)), shape: [frames, 23, 3] },
		smpl_transl: { data: Float32Array.from(smooth.pelvis.flat()), shape: [frames, 3] },
		smpl_rest_joints: { data: Float32Array.from(rest.joints.flat()), shape: [24, 3] },
		...(betas ? { smpl_betas: { data: Float32Array.from(betas), shape: [10] } } : {}),
	};
	const converted = stabilizeMotion(smplToCskel27Motion(members), productionExtractEnv({}).stabilize);
	const guarded = guardTrajectoryFloor(converted, []);
	return { motion: guarded.motion, diagnostics: { smoothSigma, rootSmoothSigma, headingUnwrap, headingRuns: heading.runs, stabilization: guarded.motion.stabilization ?? null, floor: guarded.diagnostics } };
}

// ---------------------------------------------------------------- ladder
function horizontalDistance(a, b) {
	return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/**
 * One ladder step -> { motion (cskel27), smpl, diagnostics }.
 *   base       { obs, rest }   obs extracted with GVHMR's betas (G0..G3)
 *   mannequin  { obs, rest }   obs extracted with the mannequin betas (G5, Gbest)
 *   camera     camera.json object
 *   endpoints  [A, B] cskel27 { rotMats, rootPos } (fit/motion.mjs readEndpoints) for Gbest
 *   boxes      scene boxes [{min, max}] for Gbest
 */
export function ladderStep(step, { base, mannequin, camera, endpoints, boxes = [], ankleHeight, options = {} }) {
	if (!STEPS.includes(step)) throw new Error(`unknown step ${step}; known: ${STEPS.join(", ")}`);
	const opts = { ...DEFAULTS, ...options };
	if (step === "G5" || step === "Gbest") {
		if (!mannequin?.obs || !mannequin?.rest) throw new Error(`${step} needs the mannequin-betas obs`);
		const g5 = ladderStep("G3", { base: mannequin, camera, ankleHeight, options });
		const diagnostics = { ...g5.diagnostics, step: "G5", composition: "G3 on the mannequin-betas obs" };
		if (step === "G5") return { ...g5, diagnostics };
		if (!Array.isArray(endpoints) || endpoints.length !== 2) throw new Error("Gbest needs the A/B endpoint poses");
		// Studio playback anchors a take's frame-0 root XZ on the subject (the
		// world origin), for the A/B source and for this take alike. Both are
		// put in that anchored frame before pinning: otherwise pinEndpoints'
		// short end ramps would carry the take's frame-0 world placement error
		// (walk: ~0.6 m of camera depth) as a jump into the clip.
		const a0 = Array.from(endpoints[0].rootPos), g0 = Array.from(g5.motion.rootPos.slice(0, 3));
		const anchored = endpoints.map((e) => ({ rotMats: e.rotMats, rootPos: Float32Array.of(e.rootPos[0] - a0[0], e.rootPos[1], e.rootPos[2] - a0[2]) }));
		const take = cloneMotion(g5.motion);
		for (let f = 0; f < take.frames; f++) shiftFrame(take, f, [-g0[0], 0, -g0[2]]);
		const displacement = horizontalDistance(anchored[0].rootPos, anchored[1].rootPos);
		const pin = displacement > opts.pinMinDisplacementM;
		const targets = opts.pinMode === "full" ? anchored : anchored.map((e, i) => headingEndpoint(e, take, i ? take.frames - 1 : 0));
		const pinnedTake = pin ? pinEndpoints(take, targets, { windowSeconds: opts.pinWindowSeconds }) : take;
		// Feet are locked BEFORE the scene solve so the solver has the final say:
		// locking afterwards re-bent legs into the clearance zone (sit clips).
		const foot = opts.footLock ? lockFeet(pinnedTake, { floorY: 0, boxes }) : { motion: pinnedTake, diagnostics: { disabled: true } };
		const pinned = foot.motion;
		const clearance = opts.sceneClearanceM;
		const inflated = boxes.map((b) => ({ ...b, min: b.min.map((v) => v - clearance), max: b.max.map((v) => v + clearance) }));
		const cameraJson = camera.R_c2w ? camera : cameraFromJson(camera);
		const cameraOrigin = camera.position
			? [camera.position.x, camera.position.y, camera.position.z]
			: cameraJson.t_c2w;
		let contacts, contactFallback = null;
		try {
			contacts = fitContacts(pinned, {
				boxes: inflated,
				sceneSmoothSeconds: opts.sceneSmoothSeconds,
				...(opts.sceneSolver === "ray" ? { cameraOrigin } : {}),
			});
		} catch (error) {
			if (opts.sceneSolver !== "ray") throw error;
			contactFallback = { message: error instanceof Error ? error.message : String(error), from: "ray", to: "continuous" };
			contacts = fitContacts(pinned, { boxes: inflated, sceneSmoothSeconds: opts.sceneSmoothSeconds });
		}
		// A and B are known truth: within the pin window the scene/lock shifts
		// ease back towards the pinned take, so a push carried in from the
		// contact phase cannot drag the known end poses away. The ease stops
		// where the skeleton would enter the real (uninflated) box.
		if (pin) {
			const n = take.frames, last = n - 1, radius = Math.min(opts.pinWindowSeconds * take.fps, last / 2);
			const back = Array.from({ length: n }, (_, f) => [0, 1, 2].map((k) => pinned.rootPos[f * 3 + k] - contacts.motion.rootPos[f * 3 + k]));
			const clear = (f, t) => !penetrates(jointsAt(contacts.motion, f).map((p) => p.map((v, k) => v + t * back[f][k])), boxes);
			const fraction = (f, w) => {
				if (!(w > 0) || clear(f, w)) return w;
				let lo = 0, hi = w; for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (clear(f, mid)) lo = mid; else hi = mid; }
				return lo;
			};
			const limit = Array.from({ length: n }, (_, f) => fraction(f, Math.max(1 - smoothstep(f / radius), 1 - smoothstep((last - f) / radius))));
			// The collision limit changes frame to frame; erode then blur over 3
			// frames so the ease stays at or under it and never jumps.
			const r = 3, at = (x, f) => x[Math.min(n - 1, Math.max(0, f))];
			const eroded = limit.map((_, f) => { let m = Infinity; for (let k = -r; k <= r; k++) m = Math.min(m, at(limit, f + k)); return m; });
			const ease = eroded.map((_, f) => { let s = 0; for (let k = -r; k <= r; k++) s += at(eroded, f + k); return s / (2 * r + 1); });
			if (contacts.diagnostics.sceneSolver === "camera-ray") {
				// Never switch the ease on/off: per frame take the largest clear
				// fraction up to ease[f], then lower it (lower envelope) so the
				// applied shift changes by <= easeMaxStepM of root motion per frame.
				// A lowered fraction can collide again: re-limit that frame (after
				// a few rounds, to 0 = the collision-free contact output) and redo.
				const easeMaxStepM = 0.02, size = back.map((b) => Math.hypot(...b));
				const room = size.map((s, f) => easeMaxStepM / Math.max(1e-9, s, f ? size[f - 1] : 0));
				const cap = ease.map((w, f) => fraction(f, w));
				let t;
				for (let round = 0; ; round++) {
					t = cap.map((w) => Math.max(0, w));
					for (let f = 1; f < n; f++) t[f] = Math.min(t[f], t[f - 1] + room[f]);
					for (let f = n - 2; f >= 0; f--) t[f] = Math.min(t[f], t[f + 1] + room[f + 1]);
					const blocked = t.map((w, f) => (w > 0 && !clear(f, w) ? f : -1)).filter((f) => f >= 0);
					if (!blocked.length) break;
					for (const f of blocked) cap[f] = round < 4 ? fraction(f, t[f]) : 0;
				}
				for (let f = 0; f < n; f++) if (t[f] > 0) shiftFrame(contacts.motion, f, back[f].map((v) => v * t[f]));
			} else {
				for (let f = 0; f < n; f++) if (ease[f] > 0) shiftFrame(contacts.motion, f, back[f].map((v) => v * (clear(f, ease[f]) ? ease[f] : 0)));
			}
		}
		const { support, ...contactDiagnostics } = contacts.diagnostics;
		return {
			motion: contacts.motion,
			smpl: g5.smpl,
			diagnostics: { ...diagnostics, step: "Gbest", composition: "G5 + pinEndpoints (if A->B > threshold) + lockFeet + fitContacts", pin: { applied: pin, abDisplacementM: displacement, thresholdM: opts.pinMinDisplacementM, windowSeconds: opts.pinWindowSeconds, mode: opts.pinMode, endpointFrames: "first and last only", anchoring: "A/B root XZ relative to A; take frame-0 root XZ moved to the origin", takeFrame0ShiftM: [-g0[0], 0, -g0[2]] }, contacts: { ...contactDiagnostics, supportFrames: support.filter((s) => s >= 0).length, boxes: boxes.length, sceneClearanceM: clearance, sceneSolver: contactFallback ? "continuous" : opts.sceneSolver, fallback: contactFallback }, footLock: foot.diagnostics },
		};
	}
	if (!base?.obs || !base?.rest) throw new Error(`${step} needs the base obs and its rest joints`);
	const fps = obsFps(base.obs);
	const smpl = worldSmpl(step, { obs: base.obs, rest: base.rest, camera, ankleHeight, options: opts });
	const converted = toCskel27(smpl, base.rest, fps, { smoothSigma: opts.smoothSigma, rootSmoothSigma: opts.rootSmoothSigma, headingUnwrap: opts.headingUnwrap, betas: base.obs.betas_used?.data });
	return { motion: converted.motion, smpl, diagnostics: { step, ...smpl.diagnostics, conversion: converted.diagnostics } };
}
