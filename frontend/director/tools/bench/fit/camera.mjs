import { matMul, matTranspose, quatToMat } from "../../../src/ardy/convert.js";
import { add, cloneMotion, matVec, member, readMat, sub, vec } from "./motion.mjs";

export function axisAngleMatrix(v) {
	const angle = Math.hypot(...v), scale = angle < 1e-12 ? 0.5 : Math.sin(angle / 2) / angle;
	return quatToMat([Math.cos(angle / 2), ...v.map(x => x * scale)]);
}

/** OpenCV x-right/y-down/z-forward, NOT the OpenGL camera rotation. */
export function cameraToWorld(camera) {
	const t = camera.worldToCamera;
	if (!camera.static || !Array.isArray(t) || t.length !== 4 || !t.every(row => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite))) {
		throw new Error("camera: expected static OpenCV worldToCamera [4,4]");
	}
	const r = t.slice(0, 3).map(row => row.slice(0, 3)), rt = matTranspose(r);
	const identity = matMul(r, rt);
	const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
	if (identity.some((row, i) => row.some((x, j) => Math.abs(x - Number(i === j)) > 1e-5)) || Math.abs(det - 1) > 1e-5 || t[3].some((x, i) => Math.abs(x - Number(i === 3)) > 1e-6)) {
		throw new Error("camera: worldToCamera must be a rigid proper transform");
	}
	return { rotation: rt, translation: matVec(rt, t.slice(0, 3).map(row => -row[3])) };
}

export function transformMotion(motion, { rotation, translation }) {
	const out = cloneMotion(motion);
	for (let f = 0; f < motion.frames; f++) {
		out.rootPos.set(add(matVec(rotation, vec(motion.rootPos, f * 3)), translation), f * 3);
		out.rotMats.set(matMul(rotation, readMat(motion.rotMats, f * 243)).flat(), f * 243);
		for (let j = 0; j < 27; j++) {
			const o = (f * 27 + j) * 3;
			out.posedJoints.set(add(matVec(rotation, vec(motion.posedJoints, o)), translation), o);
		}
	}
	return out;
}

/** F2: static registration, never a trajectory fit to GT. The new box run
 * supplies the camera-space pelvis and orientation. F1 supplies the SAME
 * production-smoothed ayfz root orientation. Register their first frames,
 * then apply ONE rigid transform to all of F1. This removes the arbitrary
 * initial heading/origin/floor datum while preserving production trajectory,
 * body, stabilisation and trajectory-floor safety relative to that datum.
 * Per-frame world->camera transforms are saved as diagnostics, not used as
 * a moving camera: their drift includes monocular depth/velocity disagreement.
 */
export function registerCamera(motion, incam, camera) {
	const n = incam.incam_pelvis?.shape[0];
	if (n !== motion.frames) throw new Error("incam and F1 frame counts disagree");
	const pelvis = member(incam, "incam_pelvis", [n, 3]);
	const orient = member(incam, "incam_global_orient", [n, 3]);
	if (Math.abs(member(incam, "fps", [])[0] - motion.fps) > 1e-6) throw new Error("incam and F1 fps disagree");
	const c2w = cameraToWorld(camera);
	const f1ToCamera = matMul(axisAngleMatrix(vec(orient)), matTranspose(readMat(motion.rotMats)));
	const rotation = matMul(c2w.rotation, f1ToCamera);
	const worldPelvis = add(matVec(c2w.rotation, vec(pelvis)), c2w.translation);
	const translation = sub(worldPelvis, matVec(rotation, vec(motion.rootPos)));
	return { motion: transformMotion(motion, { rotation, translation }),
		diagnostics: { rotation, translation, worldPelvis, anchorFrame: 0, registration: "static-predicted-pelvis", preservesF1RelativeTrajectory: true } };
}
