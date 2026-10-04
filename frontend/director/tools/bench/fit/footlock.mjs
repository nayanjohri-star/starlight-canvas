/** Foot lock: keep a planted foot fixed in the world during stance by solving
 * analytic two-bone IK on the leg (UpLeg-Leg-Foot). Root-only corrections
 * (depth, scene shifts) translate the body while local rotations stay put, so
 * the planted ankle slides with the pelvis; this pass moves only the leg's
 * local rotations back under the anchor. Root, spine and arms are untouched;
 * the foot keeps its input world orientation. */
import { forwardKinematics, globalRotations, matMul, matTranspose } from "../../../src/ardy/convert.js";
import { bodyOffsets, cloneMotion, localsAt, smoothstep, vec } from "./motion.mjs";

const LEGS = [
	{ foot: "left", hip: 23, knee: 24, ankle: 25, toe: 26 },
	{ foot: "right", hip: 19, knee: 20, ankle: 21, toe: 22 },
];
const HIPS = 0;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / norm(a));
const perp = (a, axis) => sub(a, scale(axis, dot(a, axis)));
const mulVec = (m, v) => m.map((row) => dot(row, v));
const columns = (x, y, z) => [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
const angleDeg = (a, b) => {
	const r = matMul(matTranspose(a), b);
	return (Math.acos(Math.max(-1, Math.min(1, (r[0][0] + r[1][1] + r[2][2] - 1) / 2))) * 180) / Math.PI;
};
const median = (values) => {
	const s = [...values].sort((a, b) => a - b), m = (s.length - 1) / 2;
	return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

/** Minimal rotation taking unit vector a onto unit vector b (Rodrigues). */
function rotationBetween(a, b) {
	const axis = cross(a, b), s = norm(axis), c = dot(a, b);
	if (s < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	const [x, y, z] = scale(axis, 1 / s), t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

/** Knee pole: the knee's offset from the hip-ankle line; for a straight leg the
 * toe direction (knees bend over the toes); last resort any perpendicular. */
function poleDirection(H, K, A, toe, axis) {
	for (const candidate of [perp(sub(K, H), axis), perp(sub(toe, A), axis), perp([0, 0, 1], axis), perp([1, 0, 0], axis)]) {
		if (norm(candidate) > 1e-3) return unit(candidate);
	}
	throw new Error("footlock: no knee pole direction");
}

/** Soft IK reach: near full extension the knee angle is hypersensitive to the
 * ankle distance (a straightening knee sweeps centimetres per millimetre), so
 * the reach saturates exponentially inside the last `soft` metres instead of
 * snapping straight. Applied relative to the input distance d0 so a zero
 * request reproduces the input pose exactly. */
function softReach(d0, distance, length, soft) {
	if (!(soft > 0)) return Math.min(distance, length);
	const knee = length - soft, cap = length - 1e-9 * length;
	const squash = (x) => (x <= knee ? x : knee + soft * (1 - Math.exp(-(x - knee) / soft)));
	const unsquash = (y) => (y <= knee ? y : knee - soft * Math.log(1 - (Math.min(y, cap) - knee) / soft));
	return squash(unsquash(d0) + distance - d0);
}

/** Two-bone IK on one leg in place: updates locals of hip/knee/ankle so the
 * ankle reaches T (clamped to the reachable shell), the knee stays in the
 * plane through hip, target and the original pole, and the foot keeps its
 * world orientation. */
function solveLeg(locals, G, P, leg, T, softness) {
	const H = P[leg.hip], K = P[leg.knee], A = P[leg.ankle];
	const a = norm(sub(K, H)), b = norm(sub(A, K));
	const axis0 = unit(sub(A, H)), pole = poleDirection(H, K, A, P[leg.toe], axis0);
	const toTarget = sub(T, H), distance = norm(toTarget);
	const axis1 = distance > 1e-9 ? scale(toTarget, 1 / distance) : axis0;
	const reach = Math.max(softReach(norm(sub(A, H)), distance, a + b, softness * (a + b)), Math.abs(a - b) + 1e-6);
	const cosA = Math.max(-1, Math.min(1, (a * a + reach * reach - b * b) / (2 * a * reach)));
	const sinA = Math.sqrt(1 - cosA * cosA);
	const pole1 = norm(perp(pole, axis1)) > 1e-6 ? unit(perp(pole, axis1)) : poleDirection(H, K, A, P[leg.toe], axis1);
	const K1 = [0, 1, 2].map((k) => H[k] + axis1[k] * a * cosA + pole1[k] * a * sinA);
	const A1 = [0, 1, 2].map((k) => H[k] + axis1[k] * reach);
	// Thigh: align the (thigh, bend-normal) frame; knee: hinge about the normal.
	const u0 = unit(sub(K, H)), n0 = unit(perp(cross(axis0, pole), u0));
	const u1 = unit(sub(K1, H)), n1 = unit(perp(cross(axis1, pole1), u1));
	const thigh = matMul(columns(u1, n1, cross(u1, n1)), matTranspose(columns(u0, n0, cross(u0, n0))));
	const knee = rotationBetween(unit(mulVec(thigh, sub(A, K))), unit(sub(A1, K1)));
	const gUp = matMul(thigh, G[leg.hip]), gLeg = matMul(knee, matMul(thigh, G[leg.knee]));
	locals[leg.hip] = matMul(matTranspose(G[HIPS]), gUp);
	locals[leg.knee] = matMul(matTranspose(gUp), gLeg);
	locals[leg.ankle] = matMul(matTranspose(gLeg), G[leg.ankle]);
}

/** Highest support (floor or box top under the foot) the foot may stand on. */
function supportUnder(points, lowY, floorY, boxes, maxHeight) {
	let best = floorY;
	for (const box of boxes) {
		const inside = points.some((p) => p[0] >= box.min[0] && p[0] <= box.max[0] && p[2] >= box.min[2] && p[2] <= box.max[2]);
		if (inside && box.max[1] > best && lowY >= box.max[1] - maxHeight) best = box.max[1];
	}
	return best;
}

/** Per frame: { goal } (absolute ankle target) inside a stance, { offset } in
 * the ramps around it, null where the leg is left alone. The ramps fade the
 * stance-edge correction (not a pull toward the anchor), so the swing keeps its
 * shape; each ramp lasts at least blendFrames and long enough that the added
 * per-frame displacement stays near maxBlendStepM. Two stances whose ramps meet
 * share the gap: the correction interpolates from one edge to the next. */
function planCorrections(motion, leg, stances, blendFrames, maxBlendStepM) {
	const T = motion.frames, plan = new Array(T).fill(null);
	const ankle = (f) => vec(motion.posedJoints, (f * 27 + leg.ankle) * 3);
	const toeY = (f) => motion.posedJoints[(f * 27 + leg.toe) * 3 + 1];
	// A ramp carries a stance-edge correction onto frames whose foot pitch
	// differs; never let it push the foot's lowest point under the support
	// (or deeper than the input already was). The foot keeps its world
	// orientation, so the toe moves with the ankle.
	const fade = (f, offset, level) => {
		const lowest = Math.min(ankle(f)[1], toeY(f));
		return { offset: [offset[0], Math.max(offset[1], -Math.max(0, lowest - level)), offset[2]] };
	};
	const goal = (stance, f) => [stance.anchor[0], stance.height(f), stance.anchor[2]];
	// smoothstep's peak slope is 1.5 / (n + 1) per frame over an n-frame ramp.
	const ramp = (d) => Math.max(blendFrames, Math.ceil((1.5 * norm(d)) / maxBlendStepM) - 1);
	const edges = stances.map((s) => {
		const first = sub(goal(s, s.start), ankle(s.start)), last = sub(goal(s, s.end), ankle(s.end));
		return { first, last, before: ramp(first), after: ramp(last) };
	});
	stances.forEach((s, i) => {
		for (let f = s.start; f <= s.end; f++) plan[f] = { goal: goal(s, f) };
		const next = stances[i + 1], gap = next ? next.start - s.end : Infinity;
		if (next && gap - 1 <= edges[i].after + edges[i + 1].before) {
			for (let f = s.end + 1; f < next.start; f++) {
				const t = smoothstep((f - s.end) / gap);
				plan[f] = fade(f, edges[i].last.map((v, k) => v + (edges[i + 1].first[k] - v) * t), Math.max(s.level, next.level));
			}
		} else {
			const n = edges[i].after;
			for (let f = s.end + 1; f <= Math.min(T - 1, s.end + n); f++) plan[f] = fade(f, scale(edges[i].last, smoothstep(1 - (f - s.end) / (n + 1))), s.level);
			if (next) {
				const m = edges[i + 1].before;
				for (let f = next.start - m; f < next.start; f++) plan[f] = fade(f, scale(edges[i + 1].first, smoothstep(1 - (next.start - f) / (m + 1))), next.level);
			}
		}
		if (i === 0) {
			const m = edges[0].before;
			for (let f = Math.max(0, s.start - m); f < s.start; f++) plan[f] = fade(f, scale(edges[0].first, smoothstep(1 - (s.start - f) / (m + 1))), s.level);
		}
	});
	return plan;
}

function detectStances(motion, leg, { floorY, boxes, maxHeight, maxSpeed, minStanceFrames, minSwingFrames }) {
	const T = motion.frames, at = (f, j) => vec(motion.posedJoints, (f * 27 + j) * 3);
	const ankle = Array.from({ length: T }, (_, f) => at(f, leg.ankle));
	const toe = Array.from({ length: T }, (_, f) => at(f, leg.toe));
	// The slower one-sided step: a stance's first/last frame has one slow side.
	const step = (f, g) => Math.hypot(ankle[g][0] - ankle[f][0], ankle[g][2] - ankle[f][2]) * motion.fps;
	const speed = ankle.map((_, f) => Math.min(f > 0 ? step(f - 1, f) : Infinity, f + 1 < T ? step(f, f + 1) : Infinity, T === 1 ? 0 : Infinity));
	const support = ankle.map((p, f) => {
		const lowY = Math.min(p[1], toe[f][1]), s = supportUnder([p, toe[f]], lowY, floorY, boxes, maxHeight);
		return lowY - s <= maxHeight && speed[f] <= maxSpeed ? s : null;
	});
	const runs = [];
	for (let f = 0; f < T;) {
		if (support[f] === null) { f += 1; continue; }
		let end = f;
		while (end + 1 < T && support[end + 1] !== null && Math.abs(support[end + 1] - support[f]) < 0.01) end += 1;
		const last = runs.at(-1);
		// A foot cannot lift and replant in fewer than minSwingFrames: one fast
		// frame inside a sliding stance is not a step.
		if (last && f - last.end - 1 < minSwingFrames && Math.abs(last.level - support[f]) < 0.01) last.end = end;
		else runs.push({ start: f, end, level: support[f] });
		f = end + 1;
	}
	const stances = [];
	for (const { start, end, level } of runs) {
		if (end - start + 1 >= minStanceFrames) {
			const frames = Array.from({ length: end - start + 1 }, (_, i) => start + i);
			const mean = (k) => frames.reduce((sum, i) => sum + ankle[i][k], 0) / frames.length;
			// Flat-foot ankle height above the toe; heel-off raises the ankle above it.
			const flat = median(frames.map((i) => ankle[i][1] - toe[i][1]));
			const height = (i) => level + Math.max(flat, ankle[i][1] - toe[i][1]);
			stances.push({ foot: leg.foot, start, end, anchor: [mean(0), level + flat, mean(2)], level, height });
		}
	}
	return stances;
}

/**
 * Stance = ankle/toe within maxHeight of the floor or a box top AND ankle
 * horizontal speed <= maxSpeed for >= minStanceFrames. maxSpeed defaults to
 * 0.4 m/s, not 0.25: the fitted takes this pass repairs slide 25-30 cm/s on
 * truly planted frames, so 0.25 misses about half of each stance (measured on
 * the 11 gt+cube items: mean skate 9.7 cm/s at 0.25 vs 8.2 at 0.4).
 * @param {object} motion cskel27 motion ({ frames, fps, rotMats, rootPos, posedJoints, boneScale })
 * @returns {{ motion, diagnostics: { stances, maxResidualM, maxAdjustDeg } }}
 */
export function lockFeet(motion, { floorY = 0, boxes = [], maxHeight = 0.06, maxSpeed = 0.4, minStanceFrames = 3, blendFrames = 3,
	minSwingFrames = 4, maxBlendStepM = 0.01, softness = 0.03, offsets = bodyOffsets(motion.boneScale) } = {}) {
	if (!(blendFrames >= 0) || !(minStanceFrames >= 1) || !(minSwingFrames >= 0) || !(maxBlendStepM > 0) || !(softness >= 0)) {
		throw new Error("lockFeet: blendFrames >= 0, minStanceFrames >= 1, minSwingFrames >= 0, maxBlendStepM > 0, softness >= 0 required");
	}
	const out = cloneMotion(motion), T = motion.frames;
	const detect = { floorY, boxes, maxHeight, maxSpeed, minStanceFrames, minSwingFrames };
	const plans = LEGS.map((leg) => {
		const stances = detectStances(motion, leg, detect);
		return { leg, stances, plan: planCorrections(motion, leg, stances, blendFrames, maxBlendStepM) };
	});
	let maxResidualM = 0, maxAdjustDeg = 0;
	for (let f = 0; f < T; f++) {
		const active = plans.filter(({ plan }) => plan[f] !== null);
		if (!active.length) continue;
		const original = localsAt(motion, f), locals = original.map((m) => m.map((row) => row.slice()));
		const root = vec(motion.rootPos, f * 3), G = globalRotations(locals), P = forwardKinematics(locals, offsets, root);
		const targets = active.map(({ leg, plan }) => {
			const target = plan[f].goal ?? P[leg.ankle].map((v, k) => v + plan[f].offset[k]);
			solveLeg(locals, G, P, leg, target, softness);
			return { leg, target };
		});
		const solved = forwardKinematics(locals, offsets, root);
		for (const { leg, target } of targets) {
			maxResidualM = Math.max(maxResidualM, norm(sub(solved[leg.ankle], target)));
			for (const j of [leg.hip, leg.knee, leg.ankle]) {
				maxAdjustDeg = Math.max(maxAdjustDeg, angleDeg(original[j], locals[j]));
				out.rotMats.set(locals[j].flat(), (f * 27 + j) * 9);
			}
		}
		for (let j = 0; j < 27; j++) out.posedJoints.set(solved[j], (f * 27 + j) * 3);
	}
	const stances = plans.flatMap(({ stances }) => stances.map(({ foot, start, end, anchor }) => ({ foot, start, end, anchor })));
	return { motion: out, diagnostics: { stances, maxResidualM, maxAdjustDeg } };
}
