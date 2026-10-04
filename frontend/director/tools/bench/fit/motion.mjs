/** cskel27 bench utilities. Fitting never samples GT intermediate frames. */
import { deriveBoneOffsets, forwardKinematics } from "../../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../../src/ardy/to-cskel27.js";
import { readNpz } from "../../kimodo/read-npz.mjs";

export const readMat = (flat, offset = 0) => Array.from({ length: 3 }, (_, row) => Array.from(flat.slice(offset + row * 3, offset + row * 3 + 3)));
export const localsAt = (motion, frame) => Array.from({ length: 27 }, (_, joint) => readMat(motion.rotMats, (frame * 27 + joint) * 9));
export const jointsAt = (motion, frame) => Array.from({ length: 27 }, (_, joint) => Array.from(motion.posedJoints.slice((frame * 27 + joint) * 3, (frame * 27 + joint + 1) * 3)));
export const vec = (flat, offset = 0) => Array.from(flat.slice(offset, offset + 3));
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const matVec = (m, v) => m.map(row => row.reduce((sum, x, i) => sum + x * v[i], 0));
export const smoothstep = t => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

export function member(members, name, shape) {
	const value = members[name];
	if (!value?.data || JSON.stringify(value.shape) !== JSON.stringify(shape) || !value.data.every(Number.isFinite)) {
		throw new Error(`${name}: expected finite [${shape}]`);
	}
	return value.data;
}

export function readMotion(path) {
	const m = readNpz(path), frames = m.local_rot_mats?.shape[0];
	if (!Number.isInteger(frames) || frames < 1) throw new Error(`${path}: invalid frame count`);
	const fps = member(m, "fps", [])[0];
	if (!(fps > 0)) throw new Error(`${path}: invalid fps`);
	const personScale = m.person_scale ? member(m, "person_scale", [])[0] : 1;
	const boneScale = m.bone_scale ? member(m, "bone_scale", [27]) : new Float32Array(27).fill(1);
	if (!(personScale > 0) || !boneScale.every(v => v > 0)) throw new Error(`${path}: invalid body scale`);
	return { frames, fps, rotMats: member(m, "local_rot_mats", [frames, 27, 3, 3]),
		rootPos: member(m, "root_positions", [frames, 3]), posedJoints: member(m, "posed_joints", [frames, 27, 3]), personScale, boneScale };
}

/** The NPZ decoder reads the archive; only these TWO poses cross into fitting.
 * In the real workflow this input is the user's A/B pose pair. No temporal
 * statistics, body measurements, or intermediate GT frames enter any fit. */
export function readEndpoints(path) {
	const m = readNpz(path), n = m.local_rot_mats?.shape[0];
	if (!(n >= 2) || JSON.stringify(m.local_rot_mats.shape.slice(1)) !== "[27,3,3]" || JSON.stringify(m.root_positions?.shape) !== JSON.stringify([n, 3])) {
		throw new Error(`${path}: expected at least two cskel27 poses`);
	}
	return [0, n - 1].map(f => {
		const rotMats = m.local_rot_mats.data.slice(f * 243, (f + 1) * 243);
		const rootPos = m.root_positions.data.slice(f * 3, (f + 1) * 3);
		if (![...rotMats, ...rootPos].every(Number.isFinite)) throw new Error(`${path}: nonfinite endpoint`);
		return { rotMats, rootPos };
	});
}

export function cloneMotion(m) {
	return { ...m, rotMats: m.rotMats.slice(), rootPos: m.rootPos.slice(), posedJoints: m.posedJoints.slice(), boneScale: m.boneScale?.slice() };
}

export function bodyOffsets(boneScale = new Float32Array(27).fill(1)) {
	const reference = canonicalCskel27Reference();
	return deriveBoneOffsets(reference.posed_joints, reference.local_rot_mats).map((v, j) => v.map(x => x * boneScale[j]));
}

export function regenerateJoints(motion, offsets = bodyOffsets(motion.boneScale)) {
	for (let f = 0; f < motion.frames; f++) {
		const positions = forwardKinematics(localsAt(motion, f), offsets, vec(motion.rootPos, f * 3));
		for (let j = 0; j < 27; j++) motion.posedJoints.set(positions[j], (f * 27 + j) * 3);
	}
	return motion;
}

export function shiftFrame(motion, frame, delta) {
	for (let k = 0; k < 3; k++) {
		motion.rootPos[frame * 3 + k] += delta[k];
		for (let j = 0; j < 27; j++) motion.posedJoints[(frame * 27 + j) * 3 + k] += delta[k];
	}
}

/** F3: retain F2 rotations and metric trajectory, replace estimated proportions
 * with the CHARACTER's known cskel27 bone factors. Canonical (all ones) is
 * equivalent to smplToCskel27Motion(..., {boneScale:1}), without re-grounding
 * or discarding production's temporal smoothing and root corrections. */
export function fitBody(motion, boneScale = new Float32Array(27).fill(1)) {
	if (boneScale.length !== 27 || !boneScale.every(v => Number.isFinite(v) && v > 0)) throw new Error("body: expected 27 positive bone factors");
	const out = cloneMotion(motion);
	out.boneScale = Float32Array.from(boneScale);
	out.personScale = 1; // Root remains in metres; never rescale camera translation.
	return regenerateJoints(out);
}
