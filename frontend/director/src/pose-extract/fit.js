/** Landmark directions -> ordinary cozyclay.pose.v1 keys, with no runtime UI dependency. */

import { COZYCLAY_BONES, CSKEL27_JOINTS } from "../ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../ardy/cskel27-neutral.js";
import { localToBasis, matMul, matToQuat, matTranspose } from "../ardy/convert.js";
import { POSE_LANDMARK as L } from "./landmarks.js";

function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(v, amount) { return [v[0] * amount, v[1] * amount, v[2] * amount]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) { return Math.hypot(v[0], v[1], v[2]); }
function unit(v) { const n = norm(v); return n > 1e-8 ? scale(v, 1 / n) : null; }
function lerp(a, b, t) { return add(a, scale(sub(b, a), t)); }
function rotateY(v, cos, sin) { return [v[0] * cos + v[2] * sin, v[1], v[2] * cos - v[0] * sin]; }

function averageLandmarks(landmarks, indices) {
	const available = indices.map((index) => landmarks[index]).filter(Boolean);
	if (available.length === 0) return null;
	const weight = available.reduce((sum, entry) => sum + entry.visibility, 0);
	if (!(weight > 0)) return null;
	return available.reduce(
		(sum, entry) => add(sum, scale(entry.position, entry.visibility / weight)),
		[0, 0, 0]
	);
}

function landmarkPoint(landmarks, index) {
	return landmarks[index]?.position?.slice() ?? null;
}

function buildTargetPoints(landmarks) {
	const leftHip = landmarkPoint(landmarks, L.LEFT_HIP);
	const rightHip = landmarkPoint(landmarks, L.RIGHT_HIP);
	const leftShoulder = landmarkPoint(landmarks, L.LEFT_SHOULDER);
	const rightShoulder = landmarkPoint(landmarks, L.RIGHT_SHOULDER);
	if (!leftHip || !rightHip || !leftShoulder || !rightShoulder) return null;
	const hips = scale(add(leftHip, rightHip), 0.5);
	const shoulders = scale(add(leftShoulder, rightShoulder), 0.5);
	const head = averageLandmarks(landmarks, [L.NOSE, L.LEFT_EYE, L.RIGHT_EYE, L.LEFT_EAR, L.RIGHT_EAR]);
	return {
		Hips: hips,
		Spine: lerp(hips, shoulders, 0.25),
		Spine1: lerp(hips, shoulders, 0.5),
		Spine2: lerp(hips, shoulders, 0.75),
		Spine3: shoulders,
		Neck: shoulders,
		Head: head,
		LeftShoulder: shoulders,
		LeftArm: leftShoulder,
		LeftForeArm: landmarkPoint(landmarks, L.LEFT_ELBOW),
		LeftHand: landmarkPoint(landmarks, L.LEFT_WRIST),
		LeftHandEnd: averageLandmarks(landmarks, [L.LEFT_PINKY, L.LEFT_INDEX]),
		RightShoulder: shoulders,
		RightArm: rightShoulder,
		RightForeArm: landmarkPoint(landmarks, L.RIGHT_ELBOW),
		RightHand: landmarkPoint(landmarks, L.RIGHT_WRIST),
		RightHandEnd: averageLandmarks(landmarks, [L.RIGHT_PINKY, L.RIGHT_INDEX]),
		LeftUpLeg: leftHip,
		LeftLeg: landmarkPoint(landmarks, L.LEFT_KNEE),
		LeftFoot: landmarkPoint(landmarks, L.LEFT_ANKLE),
		LeftToeBase: landmarkPoint(landmarks, L.LEFT_FOOT_INDEX),
		RightUpLeg: rightHip,
		RightLeg: landmarkPoint(landmarks, L.RIGHT_KNEE),
		RightFoot: landmarkPoint(landmarks, L.RIGHT_ANKLE),
		RightToeBase: landmarkPoint(landmarks, L.RIGHT_FOOT_INDEX),
		_faceForward: head && averageLandmarks(landmarks, [L.LEFT_EAR, L.RIGHT_EAR])
			? sub(landmarkPoint(landmarks, L.NOSE) ?? head, averageLandmarks(landmarks, [L.LEFT_EAR, L.RIGHT_EAR]))
			: null,
	};
}

function buildNeutralPoints() {
	return Object.fromEntries(CSKEL27_JOINTS.map((name, index) => [name, CSKEL27_NEUTRAL[index].slice()]));
}

const CHILD = {
	Hips: "Spine", Spine: "Spine1", Spine1: "Spine2", Neck: "Head",
	LeftShoulder: "LeftArm", LeftArm: "LeftForeArm", LeftForeArm: "LeftHand", LeftHand: "LeftHandEnd",
	RightShoulder: "RightArm", RightArm: "RightForeArm", RightForeArm: "RightHand", RightHand: "RightHandEnd",
	LeftUpLeg: "LeftLeg", LeftLeg: "LeftFoot", LeftFoot: "LeftToeBase",
	RightUpLeg: "RightLeg", RightLeg: "RightFoot", RightFoot: "RightToeBase",
};

const EFFECTIVE_PARENT = {
	Hips: null, Spine: "Hips", Spine1: "Spine", Neck: "Spine1", Head: "Neck",
	LeftShoulder: "Spine1", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
	RightShoulder: "Spine1", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm",
	LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg", LeftFoot: "LeftLeg",
	RightUpLeg: "Hips", RightLeg: "RightUpLeg", RightFoot: "RightLeg",
};

function bodyAxes(points) {
	const lateral = points.LeftUpLeg && points.RightUpLeg ? unit(sub(points.LeftUpLeg, points.RightUpLeg)) : null;
	const up = points.Spine3 && points.Hips ? unit(sub(points.Spine3, points.Hips)) : null;
	const forward = lateral && up ? unit(cross(lateral, up)) : null;
	return { lateral, up, forward };
}

/**
 * Below this the forward axis is too close to vertical to carry a yaw: the
 * subject is lying down or shot straight from above. Yaw comes out of
 * atan2 over the leftover horizontal components, so its error scales as
 * 1/horizontal — at 0.12 (about 7 deg off vertical) landmark jitter of 0.01
 * already swings the angle ~5 deg, and it diverges below that.
 */
const YAW_HORIZONTAL_MIN = 0.12;

/**
 * Drop the photograph's horizontal facing: yaw belongs to the Character
 * group's `rot`, not to the saved pose, so every target point is spun about Y
 * until the subject's forward matches the neutral skeleton's forward. Returns
 * the points unchanged when either forward is too vertical to yield a yaw.
 */
function yawAlignPoints(points, targetForward, neutralForward) {
	if (!targetForward || !neutralForward) return points;
	const targetHorizontal = Math.hypot(targetForward[0], targetForward[2]);
	const neutralHorizontal = Math.hypot(neutralForward[0], neutralForward[2]);
	if (targetHorizontal < YAW_HORIZONTAL_MIN || neutralHorizontal < YAW_HORIZONTAL_MIN) return points;
	const angle = Math.atan2(neutralForward[0], neutralForward[2])
		- Math.atan2(targetForward[0], targetForward[2]);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	// _faceForward is a difference, not a position; rotation is linear, so the same spin applies.
	return Object.fromEntries(
		Object.entries(points).map(([name, value]) => [name, value ? rotateY(value, cos, sin) : value])
	);
}

function frameFrom(primary, secondary) {
	const x = unit(primary);
	if (!x || !secondary) return null;
	let y = sub(secondary, scale(x, dot(secondary, x)));
	y = unit(y);
	if (!y) {
		const fallback = Math.abs(x[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
		y = unit(sub(fallback, scale(x, dot(fallback, x))));
	}
	if (!y) return null;
	const z = unit(cross(x, y));
	if (!z) return null;
	y = unit(cross(z, x));
	return [
		[x[0], y[0], z[0]],
		[x[1], y[1], z[1]],
		[x[2], y[2], z[2]],
	];
}

function jointFrame(name, points, axes) {
	let primary;
	if (name === "Head") primary = points.Head && points.Neck ? sub(points.Head, points.Neck) : null;
	else {
		const child = CHILD[name];
		primary = child && points[name] && points[child] ? sub(points[child], points[name]) : null;
	}
	if (!primary) return null;
	let secondary = axes.forward;
	if (["Hips", "Spine", "Spine1", "Neck"].includes(name)) secondary = axes.lateral;
	else if (name === "Head") secondary = points._faceForward ?? axes.forward;
	else if (name.endsWith("Shoulder") || name.endsWith("Foot")) secondary = axes.up;
	return frameFrom(primary, secondary);
}

function restByName(rest) {
	if (!rest || !Array.isArray(rest.joints)) {
		throw new Error("fitLandmarksToPose: rest must be parsed cskel27-rest.json");
	}
	return new Map(rest.joints.map((entry) => [entry.name, entry.rest]));
}

function meanConfidence(landmarks) {
	const visible = landmarks.filter(Boolean);
	return visible.length ? visible.reduce((sum, entry) => sum + entry.visibility, 0) / visible.length : 0;
}

/** Fit one normalised landmark sample into the exact pose schema consumed by poseToCskel27. */
export function fitLandmarksToPose({ sample, rest, createdMs = 0 }) {
	if (!sample?.valid || !Array.isArray(sample.landmarks)) {
		throw new Error("fitLandmarksToPose: sample must be a valid normalized landmark sample");
	}
	const measuredPoints = buildTargetPoints(sample.landmarks);
	if (!measuredPoints) throw new Error("fitLandmarksToPose: shoulders and hips must be visible");
	const neutralPoints = buildNeutralPoints();
	const neutralAxes = bodyAxes(neutralPoints);
	// Neutral owns the forward direction; reading it off CSKEL27_NEUTRAL keeps the axis unhardcoded.
	const targetPoints = yawAlignPoints(measuredPoints, bodyAxes(measuredPoints).forward, neutralAxes.forward);
	const targetAxes = bodyAxes(targetPoints);
	const rests = restByName(rest);
	const desiredGlobal = new Map();
	const bones = {};
	const releasedBones = [];
	const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

	for (const name of COZYCLAY_BONES) {
		const targetFrame = jointFrame(name, targetPoints, targetAxes);
		const neutralFrame = jointFrame(name, neutralPoints, neutralAxes);
		const parentName = EFFECTIVE_PARENT[name];
		const parentGlobal = parentName ? desiredGlobal.get(parentName) : identity;
		let global = parentGlobal;
		let local = identity;
		if (targetFrame && neutralFrame) {
			global = matMul(targetFrame, matTranspose(neutralFrame));
			local = matMul(matTranspose(parentGlobal), global);
		} else {
			releasedBones.push(name);
		}
		desiredGlobal.set(name, global);
		const restRotation = rests.get(name);
		if (!restRotation) throw new Error(`fitLandmarksToPose: rest rotation missing for ${name}`);
		bones[name] = matToQuat(localToBasis(local, restRotation));
	}

	return {
		pose: {
			schema: "cozyclay.pose.v1",
			created_ms: createdMs,
			source: { app: "cozyclay", rig: "cskel27-video-fit", time_s: sample.timeS },
			bones,
		},
		releasedBones,
		confidence: meanConfidence(sample.landmarks),
	};
}
