const FOOT_NAMES = ["L_ankle", "R_ankle", "L_foot", "R_foot"];
const ANKLE_INDEX = { L_ankle: 15, R_ankle: 16 };
const LOGIT_INDEX = { L_ankle: 0, L_foot: 1, R_ankle: 2, R_foot: 3 };
const OPPOSITE = { L_ankle: "R_ankle", R_ankle: "L_ankle" };

function valuesOf(value) {
	return value?.data ?? value;
}

function flattenMatrix(matrix) {
	return Array.isArray(matrix?.[0]) ? matrix.flat() : Array.from(matrix ?? []);
}

function matrix3(matrix, name) {
	const flat = flattenMatrix(matrix);
	if (flat.length !== 9 || flat.some((value) => !Number.isFinite(Number(value)))) throw new Error(`${name}: expected a finite 3x3 matrix`);
	return flat.map(Number);
}

function vector3(value, name) {
	const data = valuesOf(value);
	if (!data || data.length !== 3 || Array.from(data).some((item) => !Number.isFinite(Number(item)))) throw new Error(`${name}: expected a finite 3-vector`);
	return Array.from(data, Number);
}

function frameVectors(value, frames, name) {
	const data = valuesOf(value);
	if (Array.isArray(data) && data.length === frames && data.every((row) => Array.isArray(row))) {
		return data.map((row, frame) => {
			if (row.length !== 3 || row.some((item) => !Number.isFinite(Number(item)))) throw new Error(`${name}[${frame}]: expected a finite 3-vector`);
			return row.map(Number);
		});
	}
	if (!data || data.length !== frames * 3) throw new Error(`${name}: expected [${frames}, 3]`);
	return Array.from({ length: frames }, (_, frame) => Array.from(data.slice(frame * 3, frame * 3 + 3), Number));
}

function frameKeypoints(value, frames) {
	const data = valuesOf(value);
	if (Array.isArray(data) && data.length === frames && data.every((row) => Array.isArray(row))) {
		return data.map((row, frame) => {
			if (row.length < 17 || row.some((point) => !Array.isArray(point) || point.length < 3)) throw new Error(`kp2d[${frame}]: expected at least 17 [x, y, confidence] points`);
			return row.map((point) => point.slice(0, 3).map(Number));
		});
	}
	if (!data || data.length !== frames * 17 * 3) throw new Error(`kp2d: expected [${frames}, 17, 3]`);
	return Array.from({ length: frames }, (_, frame) => Array.from({ length: 17 }, (_, joint) => {
		const offset = (frame * 17 + joint) * 3;
		return Array.from(data.slice(offset, offset + 3), Number);
	}));
}

function frameLogits(value, frames) {
	const data = valuesOf(value);
	if (Array.isArray(data) && data.length === frames && data.every((row) => Array.isArray(row))) {
		return data.map((row, frame) => {
			if (row.length < 6) throw new Error(`static_conf_logits[${frame}]: expected 6 logits`);
			return row.slice(0, 6).map(Number);
		});
	}
	if (!data || data.length !== frames * 6) throw new Error(`static_conf_logits: expected [${frames}, 6]`);
	return Array.from({ length: frames }, (_, frame) => Array.from(data.slice(frame * 6, frame * 6 + 6), Number));
}

function footPoint(footW, frame, name) {
	if (Array.isArray(footW)) {
		const row = footW[frame];
		if (Array.isArray(row)) {
			const index = FOOT_NAMES.indexOf(name);
			return row[index];
		}
		return row?.[name];
	}
	return footW?.[name]?.[frame];
}

function normalizedFootFrames(footW, frames) {
	return Array.from({ length: frames }, (_, frame) => Object.fromEntries(FOOT_NAMES.map((name) => {
		const point = footPoint(footW, frame, name);
		return [name, point && point.length === 3 ? Array.from(point, Number) : null];
	})));
}

function normalizeCamera(camera) {
	if (!camera) throw new Error("camera: expected K, R_c2w, and t_c2w");
	const K = matrix3(camera.K ?? [[camera.fx, 0, camera.cx], [0, camera.fy, camera.cy], [0, 0, 1]], "camera.K");
	let rotation = camera.R_c2w ?? camera.Rc2w;
	let translation = camera.t_c2w ?? camera.tc2w;
	if (!rotation && camera.worldToCamera) {
		const worldToCamera = matrix3(camera.worldToCamera, "camera.worldToCamera");
		rotation = [worldToCamera[0], worldToCamera[3], worldToCamera[6], worldToCamera[1], worldToCamera[4], worldToCamera[7], worldToCamera[2], worldToCamera[5], worldToCamera[8]];
		const tW2C = [worldToCamera[3], worldToCamera[7], worldToCamera[11]];
		translation = [
			-(rotation[0] * tW2C[0] + rotation[1] * tW2C[1] + rotation[2] * tW2C[2]),
			-(rotation[3] * tW2C[0] + rotation[4] * tW2C[1] + rotation[5] * tW2C[2]),
			-(rotation[6] * tW2C[0] + rotation[7] * tW2C[1] + rotation[8] * tW2C[2]),
		];
	}
	return { K, R_c2w: matrix3(rotation, "camera.R_c2w"), t_c2w: vector3(translation, "camera.t_c2w") };
}

function pixelRay(u, v, camera) {
	const { K, R_c2w, t_c2w } = camera;
	const cameraDirection = [(u - K[2]) / K[0], (v - K[5]) / K[4], 1];
	const direction = [
		R_c2w[0] * cameraDirection[0] + R_c2w[1] * cameraDirection[1] + R_c2w[2] * cameraDirection[2],
		R_c2w[3] * cameraDirection[0] + R_c2w[4] * cameraDirection[1] + R_c2w[5] * cameraDirection[2],
		R_c2w[6] * cameraDirection[0] + R_c2w[7] * cameraDirection[1] + R_c2w[8] * cameraDirection[2],
	];
	const length = Math.hypot(...direction);
	return { origin: t_c2w, direction: direction.map((item) => item / length) };
}

function median(values) {
	if (!values.length) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sigmoid(logit) {
	if (!Number.isFinite(logit)) return 0;
	if (logit >= 0) {
		const e = Math.exp(-logit);
		return 1 / (1 + e);
	}
	const e = Math.exp(logit);
	return e / (1 + e);
}

function translatePoint(point, correction) {
	return [point[0] + correction[0], point[1], point[2] + correction[2]];
}

function shiftJoints(jointsW, corrections) {
	if (!Array.isArray(jointsW)) return jointsW;
	return jointsW.map((frame, index) => Array.isArray(frame) ? frame.map((point) => point?.length === 3 ? translatePoint(point, corrections[index]) : point) : frame);
}

function shiftFeet(footW, corrections, frames) {
	if (Array.isArray(footW)) return footW.map((frame, index) => Array.isArray(frame) ? frame.map((point) => point?.length === 3 ? translatePoint(point, corrections[index]) : point) : Object.fromEntries(FOOT_NAMES.map((name) => [name, frame?.[name]?.length === 3 ? translatePoint(frame[name], corrections[index]) : frame?.[name]])));
	if (!footW || typeof footW !== "object") return footW;
	return Object.fromEntries(Object.entries(footW).map(([name, track]) => [name, Array.isArray(track) ? track.map((point, index) => point?.length === 3 ? translatePoint(point, corrections[index]) : point) : track]));
}

function interpolateCorrections(samples, frames) {
	const corrections = Array.from({ length: frames }, () => [0, 0, 0]);
	const contactMask = samples.map((items) => items.length > 0);
	const runs = [];
	for (let frame = 0; frame < frames;) {
		if (!contactMask[frame]) {
			frame += 1;
			continue;
		}
		const start = frame;
		while (frame < frames && contactMask[frame]) frame += 1;
		const end = frame - 1;
		const anchor = [0, 0, 0];
		for (let axis of [0, 2]) anchor[axis] = median(samples.slice(start, end + 1).flatMap((items) => items.map((sample) => sample[axis])));
		runs.push({ start, end, anchor, samples: samples.slice(start, end + 1).flat().length });
		for (let at = start; at <= end; at += 1) corrections[at] = anchor.slice();
	}
	if (!runs.length) return { corrections, runs };
	for (let index = 0; index + 1 < runs.length; index += 1) {
		const left = runs[index], right = runs[index + 1];
		const span = right.start - left.end;
		for (let frame = left.end + 1; frame < right.start; frame += 1) {
			const weight = (frame - left.end) / span;
			corrections[frame] = [
				left.anchor[0] + (right.anchor[0] - left.anchor[0]) * weight,
				0,
				left.anchor[2] + (right.anchor[2] - left.anchor[2]) * weight,
			];
		}
	}
	for (let frame = 0; frame < runs[0].start; frame += 1) corrections[frame] = runs[0].anchor.slice();
	const last = runs[runs.length - 1];
	for (let frame = last.end + 1; frame < frames; frame += 1) corrections[frame] = last.anchor.slice();
	return { corrections, runs };
}

function footSpeed(feet, name, frame, frames, fps) {
	const before = feet[Math.max(0, frame - 1)][name], after = feet[Math.min(frames - 1, frame + 1)][name];
	const span = (Math.min(frames - 1, frame + 1) - Math.max(0, frame - 1)) / fps;
	return before?.every(Number.isFinite) && after?.every(Number.isFinite) && span > 0 ? Math.hypot(after[0] - before[0], after[2] - before[2]) / span : Infinity;
}

/**
 * Correct a world trajectory using 2D ankle observations at static floor
 * contacts. Corrections are XZ translations represented as [dx, 0, dz].
 * Optional `jointsW` and `footW` inputs receive the same rigid translation.
 */
export function correctTrajectory({
	rootW,
	footW,
	jointsW,
	kp2d,
	static_conf_logits: staticConfLogits,
	camera,
	ankleHeight,
	contactProbability = 0.8,
	maxFootHeight = 0.12,
	minKeypointConfidence = 0.3,
	// "kinematic" is the default. "hybrid": stance when EITHER GVHMR's static-contact logit OR the
	// kinematic test says so. "kinematic" (default): lower foot, near its own low height,
	// nearly still (absolutely, or relative to the other foot). GVHMR's logits are
	// weak on the part-coloured mannequin (walk: right foot never exceeds 0.8), so
	// kinematics carry real clips; logits carry clips whose planted foot still
	// slides in the estimate. "logits": logits only.
	stanceMode = "kinematic",
	fps = 24,
	stanceHeightMargin = 0.04,
	maxStanceSpeed = 0.25,
	minStanceFrames = 3,
} = {}) {
	if (!Array.isArray(rootW) || !rootW.length) throw new Error("rootW: expected at least one frame");
	if (!Number.isFinite(ankleHeight)) throw new Error("ankleHeight: expected a finite number");
	if (!(contactProbability > 0 && contactProbability < 1)) throw new Error("contactProbability: expected a value in (0, 1)");
	if (!(maxFootHeight > 0) || !Number.isFinite(maxFootHeight)) throw new Error("maxFootHeight: expected a positive number");
	if (!(minKeypointConfidence >= 0) || !Number.isFinite(minKeypointConfidence)) throw new Error("minKeypointConfidence: expected a nonnegative number");
	const frames = rootW.length;
	const roots = frameVectors(rootW, frames, "rootW");
	const feet = normalizedFootFrames(footW, frames);
	const keypoints = frameKeypoints(kp2d, frames);
	const logits = frameLogits(staticConfLogits, frames);
	const intrinsics = normalizeCamera(camera);
	const samples = Array.from({ length: frames }, () => []);
	const contactByFoot = Object.fromEntries(Object.keys(OPPOSITE).map((name) => [name, []]));
	if (!["hybrid", "kinematic", "logits"].includes(stanceMode)) throw new Error(`stanceMode: expected "hybrid", "kinematic" or "logits", got ${stanceMode}`);
	const stance = Object.fromEntries(Object.keys(OPPOSITE).map((name) => {
		const heights = feet.map((row) => row[name]?.[1]).filter(Number.isFinite).sort((a, b) => a - b);
		const low = heights.length ? heights[Math.floor(heights.length * 0.1)] : NaN;
		const flags = Array.from({ length: frames }, (_, frame) => {
			const point = feet[frame][name];
			const opposite = feet[frame][OPPOSITE[name]];
			const keypoint = keypoints[frame][ANKLE_INDEX[name]];
			const base = point?.every(Number.isFinite) && opposite?.every(Number.isFinite) && keypoint?.every(Number.isFinite) && keypoint[2] >= minKeypointConfidence && point[1] <= opposite[1];
			if (!base) return false;
			const logitOffset = LOGIT_INDEX[name];
			const staticProbability = Math.max(sigmoid(logits[frame][logitOffset]), sigmoid(logits[frame][logitOffset + 1]));
			const byLogits = staticProbability > contactProbability && point[1] < maxFootHeight;
			if (stanceMode === "logits") return byLogits;
			if (stanceMode === "hybrid" && byLogits) return true;
			// The planted foot is the slower of the two, or absolutely still. A
			// relative test survives the very error G3 corrects: a mis-scaled
			// trajectory makes even the stance foot slide in world space.
			const speed = footSpeed(feet, name, frame, frames, fps);
			const otherSpeed = footSpeed(feet, OPPOSITE[name], frame, frames, fps);
			return point[1] <= low + stanceHeightMargin && (speed < maxStanceSpeed || speed < 0.5 * otherSpeed);
		});
		// Short flickers are not a planted foot: keep runs of at least minStanceFrames.
		for (let start = 0; start < frames;) {
			if (!flags[start]) { start += 1; continue; }
			let end = start;
			while (end + 1 < frames && flags[end + 1]) end += 1;
			if (end - start + 1 < minStanceFrames) for (let i = start; i <= end; i += 1) flags[i] = false;
			start = end + 1;
		}
		return [name, flags];
	}));
	for (let frame = 0; frame < frames; frame += 1) {
		for (const name of Object.keys(OPPOSITE)) {
			const point = feet[frame][name];
			const keypoint = keypoints[frame][ANKLE_INDEX[name]];
			if (!stance[name][frame]) continue;
			const ray = pixelRay(keypoint[0], keypoint[1], intrinsics);
			if (Math.abs(ray.direction[1]) < 1e-10) continue;
			const distance = (ankleHeight - ray.origin[1]) / ray.direction[1];
			if (!(distance > 0) || !Number.isFinite(distance)) continue;
			const observed = [ray.origin[0] + distance * ray.direction[0], ankleHeight, ray.origin[2] + distance * ray.direction[2]];
			samples[frame].push([observed[0] - point[0], 0, observed[2] - point[2]]);
			contactByFoot[name].push(frame);
		}
	}
	const { corrections, runs } = interpolateCorrections(samples, frames);
	const correctedRoot = roots.map((point, frame) => translatePoint(point, corrections[frame]));
	const result = {
		rootW: correctedRoot,
		corrections,
		contactFrames: samples.flatMap((items, frame) => items.length ? [frame] : []),
		diagnostics: {
			contactByFoot,
			stanceRuns: runs.map((run) => ({ ...run, anchor: run.anchor.slice() })),
			contactCount: samples.reduce((total, items) => total + items.length, 0),
			interpolatedFrames: corrections.reduce((total, correction, frame) => total + (samples[frame].length ? 0 : (runs.length ? 1 : 0)), 0),
			maxCorrectionM: Math.max(...corrections.map((correction) => Math.hypot(correction[0], correction[2]))),
			planeY: ankleHeight,
			thresholds: { stanceMode, contactProbability, maxFootHeight, minKeypointConfidence, stanceHeightMargin, maxStanceSpeed, minStanceFrames, fps },
		},
	};
	if (jointsW !== undefined) result.jointsW = shiftJoints(jointsW, corrections);
	if (footW !== undefined) result.footW = shiftFeet(footW, corrections, frames);
	return result;
}
