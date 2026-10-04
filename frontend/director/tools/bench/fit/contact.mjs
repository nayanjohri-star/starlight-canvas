import { CSKEL27_PARENTS } from "../../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, globalRotations, matMul, matTranspose, quatToMat } from "../../../src/ardy/convert.js";
import { add, bodyOffsets, cloneMotion, jointsAt, localsAt, matVec, shiftFrame, smoothstep, sub, vec } from "./motion.mjs";

const FEET = [21, 22, 25, 26], HANDS = [10, 16];
const EPS = 1e-5;

export function validateBoxes(boxes) {
	if (!Array.isArray(boxes) || boxes.some(b => ![b?.min, b?.max].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) || b.min.some((v, k) => v >= b.max[k]))) {
		throw new Error("scene: boxes must be {min:[x,y,z],max:[x,y,z]} with min < max");
	}
	return boxes;
}

/** Smallest translation of an interior POINT to a box face. Boundary is not
 * penetration. Used for hand contact proximity; no skin radius is implied. */
export function boxPenetration(point, box) {
	if (point.some((v, k) => v <= box.min[k] || v >= box.max[k])) return [0, 0, 0];
	const candidates = box.min.flatMap((lo, k) => [[k, lo - point[k]], [k, box.max[k] - point[k]]]);
	candidates.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
	const delta = [0, 0, 0]; delta[candidates[0][0]] = candidates[0][1];
	return delta;
}

/** Open-interior segment/AABB slab intersection catches a bone crossing a
 * box even when both of its joints lie outside (point-only tests miss it). */
export function segmentPenetratesBox(a, b, box) {
	let near = 0, far = 1;
	for (let k = 0; k < 3; k++) {
		const d = b[k] - a[k];
		if (Math.abs(d) < 1e-12) {
			if (a[k] <= box.min[k] || a[k] >= box.max[k]) return false;
		} else {
			const t0 = (box.min[k] - a[k]) / d, t1 = (box.max[k] - a[k]) / d;
			near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
			if (near >= far) return false;
		}
	}
	return near < far;
}

function intersects(points, box) {
	return CSKEL27_PARENTS.some((p, j) => p !== null && segmentPenetratesBox(points[p], points[j], box));
}

/** Conservative rigid skeleton projection. On collision, clear the whole
 * skeleton along its nearest feasible separating axis, not independent
 * joint pushes (which would stretch bones). Floor wins over downward pushes.
 * This tests joint/bone segments, NOT mesh/capsule thickness or self-collision.
 * Multiple mutually obstructing boxes fail explicitly instead of silently
 * emitting penetration. Cube/mesh refinement is a separate experiment. */
export function resolveScene(points, boxes, { floorY = 0 } = {}) {
	let placed = points.map(p => p.slice()), total = [0, 0, 0];
	for (let pass = 0; pass < 32; pass++) {
		const floorLift = Math.max(0, floorY + EPS - Math.min(...FEET.map(j => placed[j][1])));
		if (floorLift) { const d = [0, floorLift, 0]; placed = placed.map(p => add(p, d)); total = add(total, d); }
		const box = boxes.find(b => intersects(placed, b));
		if (!box) return { delta: total, positions: placed };
		const candidates = [];
		for (let k = 0; k < 3; k++) {
			const lo = Math.min(...placed.map(p => p[k])), hi = Math.max(...placed.map(p => p[k]));
			for (const amount of [box.min[k] - hi - EPS, box.max[k] - lo + EPS]) {
				if (k === 1 && Math.min(...FEET.map(j => placed[j][1])) + amount < floorY) continue;
				const delta = [0, 0, 0]; delta[k] = amount; candidates.push(delta);
			}
		}
		candidates.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
		placed = placed.map(p => add(p, candidates[0])); total = add(total, candidates[0]);
	}
	throw new Error("scene: no collision-free rigid placement after 32 projections; constraints conflict");
}

export function penetrates(points, boxes, floorY = 0) {
	return Math.min(...FEET.map(j => points[j][1])) < floorY - EPS || boxes.some(b => intersects(points, b));
}

/** Scene corrections that are smooth in time. Per frame: the smallest push
 * that clears the skeleton (its nearest face may change between frames). Then
 * each signed axis component
 * is dilated by `radius` frames and Gaussian-smoothed (sigma = radius / 3):
 * the result is at least the needed push at every frame, so it stays
 * collision-free, and it ramps in and out instead of snapping. The per-frame
 * solver picks each frame's nearest face from scratch and teleported the body
 * whenever that face changed (fal stepup: 0.76 m in one frame). */
export function continuousSceneDeltas(motion, boxes, radius) {
	const n = motion.frames, shifted = (f, delta) => jointsAt(motion, f).map(p => add(p, delta));
	const blocked = (f, delta) => penetrates(shifted(f, delta), boxes);
	const raw = Array.from({ length: n }, (_, f) => (blocked(f, [0, 0, 0]) ? resolveScene(shifted(f, [0, 0, 0]), boxes).delta : [0, 0, 0]));
	const sigma = Math.max(1, radius / 3), kernel = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-0.5 * ((k - radius) / sigma) ** 2));
	const at = (x, f) => x[Math.min(n - 1, Math.max(0, f))];
	const ramp = (x) => {
		const dilated = x.map((_, f) => { let m = 0; for (let k = -radius; k <= radius; k++) m = Math.max(m, at(x, f + k)); return m; });
		return dilated.map((_, f) => { let s = 0, t = 0; for (let k = -radius; k <= radius; k++) { s += kernel[k + radius] * at(dilated, f + k); t += kernel[k + radius]; } return s / t; });
	};
	const axes = [0, 1, 2].map(k => {
		const up = ramp(raw.map(d => Math.max(0, d[k]))), down = ramp(raw.map(d => Math.max(0, -d[k])));
		return up.map((v, f) => v - down[f]);
	});
	// Where opposite pushes on one axis overlap, the ramp can fall short: top it
	// up by the smallest extra push (small, since the ramp already carries most).
	return raw.map((_, f) => { const smooth = [axes[0][f], axes[1][f], axes[2][f]]; return blocked(f, smooth) ? add(smooth, resolveScene(shifted(f, smooth), boxes).delta) : smooth; });
}

// Only these descendants can be moved without moving the torso/attachment.
// [hip/shoulder, knee/elbow, ankle/wrist, ...toe/finger joints]
const LIMBS = [[19, 20, 21, 22], [23, 24, 25, 26], [8, 9, 10, 11, 12], [14, 15, 16, 17, 18]];
const LIMB_BONES = new Set(LIMBS.flatMap(chain => chain.slice(1)));
const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);
const scale = (v, s) => v.map(x => x * s);
const unit = v => scale(v, 1 / Math.hypot(...v));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Forbidden ray offsets for a whole BONE, not just its endpoints. Clip the
 * convex polygon (t,s) with a + t*(b-a) + s*ray inside the six box planes,
 * then project onto s. A small margin survives Float32 FK/writeback. */
function boneRayInterval(a, b, ray, box) {
	const corners = Array.from({ length: 8 }, (_, i) => box.min.map((v, k) => i & (1 << k) ? box.max[k] : v));
	const extent = 1 + Math.max(...corners.flatMap(p => [Math.hypot(...sub(p, a)), Math.hypot(...sub(p, b))]));
	let polygon = [[0, -extent], [1, -extent], [1, extent], [0, extent]];
	for (let k = 0; k < 3; k++) for (const sign of [-1, 1]) {
		const face = sign > 0 ? box.max[k] + EPS : box.min[k] - EPS;
		const distance = p => sign * (a[k] + p[0] * (b[k] - a[k]) + p[1] * ray[k] - face);
		const clipped = [];
		for (let i = 0; i < polygon.length; i++) {
			const p = polygon[i], q = polygon[(i + 1) % polygon.length], dp = distance(p), dq = distance(q);
			if (dp <= 0) clipped.push(p);
			if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) clipped.push(p.map((v, j) => v + (q[j] - v) * dp / (dp - dq)));
		}
		polygon = clipped;
		if (!polygon.length) return null;
	}
	return [Math.min(...polygon.map(p => p[1])), Math.max(...polygon.map(p => p[1]))];
}

/** Ray offsets s at which one frame's TORSO (non-limb bones) crosses a box.
 * The torso MUST be clear: limb IK cannot repair its penetration. Swept
 * interval endpoints avoid a depth grid missing a narrow feasible corridor. */
function torsoRayIntervals(points, ray, boxes) {
	const intervals = [];
	for (let j = 1; j < 27; j++) if (!LIMB_BONES.has(j)) for (const box of boxes) {
		const interval = boneRayInterval(points[CSKEL27_PARENTS[j]], points[j], ray, box);
		if (interval) intervals.push(interval);
	}
	return intervals;
}

/** Smallest t >= t0 (t = sign * s) outside every forbidden torso interval. */
function clearFrom(intervals, sign, t0) {
	let t = t0;
	for (let moved = true; moved;) {
		moved = false;
		for (const [lo, hi] of intervals) {
			const a = sign > 0 ? lo : -hi, b = sign > 0 ? hi : -lo;
			if (t >= a - EPS && t <= b + EPS) { t = b + 2 * EPS; moved = true; }
		}
	}
	return t;
}

/** Exact upper envelope max_g (required[g] - path budget g..f): the smallest
 * curve at or above `required` whose change on edge f-1..f is <= budget[f]. */
function slopeEnvelope(required, budget) {
	const t = required.slice();
	for (let f = 1; f < t.length; f++) t[f] = Math.max(t[f], t[f - 1] - budget[f]);
	for (let f = t.length - 2; f >= 0; f--) t[f] = Math.max(t[f], t[f + 1] - budget[f + 1]);
	return t;
}

/** Time-varying offset for one sign: per frame the minimal torso-clear
 * t_req(f) >= 0 (0 when the frame needs none), then its slope-limited upper
 * envelope, so t is 0 far from any collision and ramps in/out. The vector
 * correction step |s_f r_f - s_{f-1} r_{f-1}| <= |ds| + |s| |dr|, so each
 * edge's slope budget is rayMaxStepM minus what the turning ray already uses
 * at the peak offset. An envelope value may land inside another torso
 * interval; raise that frame's requirement past it and rebuild. Requirements
 * only increase through a finite set of interval ends, so this terminates.
 * Returns null when the sign cannot stay within the caps/budget. */
function signedRayOffsets(intervals, sign, caps, turns, rayMaxStepM) {
	const required = intervals.map(i => clearFrom(i, sign, 0));
	for (;;) {
		const peak = Math.max(...required), budget = turns.map(d => rayMaxStepM - peak * d - 1e-9);
		if (budget.some((b, f) => f && !(b > 0))) return null;
		const t = slopeEnvelope(required, budget);
		if (t.some((v, f) => v > caps[f])) return null;
		let raised = false;
		for (let f = 0; f < t.length; f++) {
			const clear = clearFrom(intervals[f], sign, t[f]);
			if (clear > t[f]) { required[f] = clear; raised = true; }
		}
		if (!raised) return t.map(v => sign * v);
	}
}

function perpendicular(v) {
	const axis = Math.abs(v[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
	return unit(sub(axis, scale(v, dot(axis, v))));
}

function swingRotation(from, to) {
	const a = unit(from), b = unit(to), cosine = clamp(dot(a, b), -1, 1);
	return cosine < -1 + 1e-10 ? quatToMat([0, ...perpendicular(a)]) : quatToMat([1 + cosine, ...cross(a, b)]);
}

/** Analytic two-bone IK; only the chain changes. Preserve the effector's
 * world orientation so a corrected ankle does not tip its toe into the floor
 * (and a wrist does not swing its fingers back through the box). */
function limbPose(locals, points, globals, offsets, chain, target, poleAngle) {
	const [a, b, c] = chain, origin = points[a], toward = sub(target, origin);
	const l0 = Math.hypot(...offsets[b]), l1 = Math.hypot(...offsets[c]);
	const distance = Math.hypot(...toward), direction = distance > EPS ? scale(toward, 1 / distance) : unit(sub(points[c], origin));
	const reach = clamp(distance, Math.abs(l0 - l1) + EPS, l0 + l1 - EPS);
	const along = (l0 * l0 + reach * reach - l1 * l1) / (2 * reach);
	const height = Math.sqrt(Math.max(0, l0 * l0 - along * along));
	const oldBend = sub(points[b], origin), projected = sub(oldBend, scale(direction, dot(oldBend, direction)));
	const bend = Math.hypot(...projected) > EPS ? unit(projected) : perpendicular(direction);
	const pole = add(scale(bend, Math.cos(poleAngle)), scale(cross(direction, bend), Math.sin(poleAngle)));
	const elbow = add(origin, add(scale(direction, along), scale(pole, height)));
	const end = add(origin, scale(direction, reach));
	const upper = matMul(swingRotation(sub(points[b], origin), sub(elbow, origin)), globals[a]);
	const movedLower = matMul(upper, locals[b]);
	const lower = matMul(swingRotation(matVec(movedLower, offsets[c]), sub(end, elbow)), movedLower);
	const solved = locals.slice();
	solved[a] = matMul(matTranspose(globals[CSKEL27_PARENTS[a]]), upper);
	solved[b] = matMul(matTranspose(upper), lower);
	solved[c] = matMul(matTranspose(lower), globals[c]);
	return solved;
}

function limbBlocked(points, chain, boxes) {
	return chain.slice(1).some(j => (FEET.includes(j) && points[j][1] < -EPS) || boxes.some(box => segmentPenetratesBox(points[CSKEL27_PARENTS[j]], points[j], box)));
}

function clearLimb(locals, points, offsets, chain, boxes) {
	const end = points[chain[2]], tips = chain.slice(2), globals = globalRotations(locals);
	// Each face contributes an effector coordinate which clears ALL distal
	// joints. Cartesian combinations include edges/corners and multiple boxes.
	const coordinates = end.map((v, k) => {
		const relative = tips.map(j => points[j][k] - end[k]);
		return [v, ...boxes.flatMap(box => [box.min[k] - Math.max(...relative) - 4 * EPS, box.max[k] - Math.min(...relative) + 4 * EPS])];
	});
	const floor = FEET.includes(chain[2]) ? EPS - Math.min(...tips.map(j => points[j][1] - end[1])) : -Infinity;
	coordinates[1] = [...new Set(coordinates[1].map(y => Math.max(y, floor)))];
	const targets = coordinates[0].flatMap(x => coordinates[1].flatMap(y => coordinates[2].map(z => [x, y, z])));
	targets.sort((a, b) => Math.hypot(...sub(a, end)) - Math.hypot(...sub(b, end)));
	let best = null;
	for (const target of targets) for (let i = 0; i < 16; i++) {
		const solved = limbPose(locals, points, globals, offsets, chain, target, i * Math.PI / 8);
		const positions = forwardKinematics(solved, offsets, points[0]);
		if (limbBlocked(positions, chain, boxes)) continue;
		const cost = chain.slice(1).reduce((s, j) => s + dot(sub(positions[j], points[j]), sub(positions[j], points[j])), 0);
		if (!best || cost < best.cost) best = { locals: solved, positions, cost };
	}
	return best;
}

/** cameraOrigin opts into ray + limb correction instead of rigid stance
 * locks. Those locks (including floor lifts) would violate the root's camera
 * ray and reintroduce the glide this path is meant to remove. s(f) is the
 * slope-limited envelope of each frame's minimal torso-clear offset: 0 where
 * no correction is needed (so known A/B ends stay put when collisions are
 * elsewhere), one sign for the clip (either may be chosen; the smaller peak
 * wins). A single clip-level s contradicted those ends. Bound BOTH scalar
 * motion and vector correction as rays turn. Residual limb penetration is
 * fixed by two-bone IK; an impossible torso placement or limb solve fails
 * explicitly. */
function fitRayContacts(motion, boxes, cameraOrigin, rayMaxOffsetM, rayMaxStepM) {
	if (!Array.isArray(cameraOrigin) || cameraOrigin.length !== 3 || !cameraOrigin.every(Number.isFinite)) throw new Error("cameraOrigin must be a finite world [x,y,z]");
	if (!(Number.isFinite(rayMaxOffsetM) && rayMaxOffsetM >= 0 && Number.isFinite(rayMaxStepM) && rayMaxStepM > 0)) throw new Error("rayMaxOffsetM must be nonnegative and rayMaxStepM positive");
	const out = cloneMotion(motion), n = motion.frames;
	// G5 independently filters joints and rotations; its posed joints may
	// already disagree with FK. Solve against the actual playback skeleton.
	const offsets = motion.boneScale ? bodyOffsets(motion.boneScale) : deriveBoneOffsets(jointsAt(motion, 0), localsAt(motion, 0));
	const locals = Array.from({ length: n }, (_, f) => localsAt(motion, f));
	const points = locals.map((r, f) => forwardKinematics(r, offsets, vec(motion.rootPos, f * 3)));
	const rays = points.map(p => {
		const v = sub(p[0], cameraOrigin);
		if (Math.hypot(...v) < EPS) throw new Error("scene ray: root coincides with cameraOrigin");
		return unit(v);
	});
	let inputFkResidualM = 0;
	for (let f = 0; f < n; f++) {
		const input = jointsAt(motion, f);
		for (let j = 0; j < 27; j++) inputFkResidualM = Math.max(inputFkResidualM, Math.hypot(...sub(points[f][j], input[j])));
	}
	// Do not translate through the camera, even if a large limit is supplied.
	const caps = points.map(p => Math.min(rayMaxOffsetM, Math.hypot(...sub(p[0], cameraOrigin)) - EPS));
	const turns = rays.map((r, f) => (f ? Math.hypot(...sub(r, rays[f - 1])) : 0));
	const intervals = points.map((p, f) => torsoRayIntervals(p, rays[f], boxes));
	const peak = x => Math.max(...x.map(Math.abs)), total = x => x.reduce((a, v) => a + Math.abs(v), 0);
	const options = [1, -1].map(sign => signedRayOffsets(intervals, sign, caps, turns, rayMaxStepM)).filter(Boolean);
	options.sort((a, b) => peak(a) - peak(b) || total(a) - total(b));
	if (!options.length) throw new Error(`scene ray: no torso-clear ray offset within ${rayMaxOffsetM.toFixed(3)} m and ${rayMaxStepM.toFixed(3)} m/frame; ray limits/scene conflict`);
	const s = options[0], limbFixFrames = [];
	let sceneOverrides = 0, limbFixes = 0, sceneMaxStepM = 0, maxRootStepM = 0, rayMaxStep = 0;
	for (let f = 0; f < n; f++) {
		const delta = scale(rays[f], s[f]);
		out.rootPos.set(add(points[f][0], delta), f * 3);
		let positions = points[f].map(p => add(p, delta)), rotations = locals[f], fixed = false;
		for (const chain of LIMBS) {
			if (!limbBlocked(positions, chain, boxes)) continue;
			const solved = clearLimb(rotations, positions, offsets, chain, boxes);
			if (!solved) throw new Error(`scene ray: no collision-free limb IK at frame ${f}, joint ${chain[0]}; root was not lifted`);
			rotations = solved.locals; positions = solved.positions; fixed = true; limbFixes++;
		}
		if (fixed) limbFixFrames.push(f);
		if (fixed || Math.abs(s[f]) > EPS) sceneOverrides++;
		for (let j = 0; j < 27; j++) out.rotMats.set(rotations[j].flat(), (f * 27 + j) * 9);
		// Recompute from the stored Float32 channels, not unquantized IK points.
		positions = forwardKinematics(localsAt(out, f), offsets, vec(out.rootPos, f * 3));
		if (penetrates(positions, boxes)) throw new Error(`scene ray: residual penetration after FK at frame ${f}`);
		for (let j = 0; j < 27; j++) out.posedJoints.set(positions[j], (f * 27 + j) * 3);
		if (f) {
			sceneMaxStepM = Math.max(sceneMaxStepM, Math.hypot(...sub(delta, scale(rays[f - 1], s[f - 1]))));
			rayMaxStep = Math.max(rayMaxStep, Math.abs(s[f] - s[f - 1]));
			maxRootStepM = Math.max(maxRootStepM, Math.hypot(...sub(vec(out.rootPos, f * 3), vec(out.rootPos, (f - 1) * 3))));
		}
	}
	return { motion: out, diagnostics: {
		runs: 0, lockedFrames: 0, support: Array(n).fill(-1), maxLockResidualM: 0,
		sceneOverrides, maxCorrectionM: peak(s), sceneMaxStepM, maxRootStepM,
		rayOffset: { minM: Math.min(...s), maxM: Math.max(...s), meanM: s.reduce((a, v) => a + v, 0) / n, maxAbsM: peak(s), maxStepM: rayMaxStep, framesNonZero: s.filter(v => Math.abs(v) > EPS).length },
		rayMaxOffsetM, rayMaxStepM, limbFixFrames, limbFixes, inputFkResidualM,
		geometry: "cskel27 joint/bone segments; no skin radius", sceneSolver: "camera-ray",
		solver: "slope-limited per-frame torso-clear camera-ray offset + two-bone limb IK; no rigid contact locks",
	} };
}

function contactTarget(point, joint, boxes, height) {
	if (FEET.includes(joint)) {
		let y = 0;
		for (const box of boxes) if (point[0] >= box.min[0] && point[0] <= box.max[0] && point[2] >= box.min[2] && point[2] <= box.max[2] && Math.abs(point[1] - box.max[1]) <= height) y = Math.max(y, box.max[1]);
		return Math.abs(point[1] - y) <= height ? [point[0], y + EPS, point[2]] : null;
	}
	// A hand may support on any known box face; never invent a hand contact
	// from a low percentile of its own trajectory when there is no surface.
	for (const box of boxes) {
		const clamped = point.map((x, k) => Math.max(box.min[k], Math.min(box.max[k], x)));
		const target = add(clamped, boxPenetration(clamped, box));
		if (Math.hypot(...sub(point, target)) <= height) return target;
	}
	return null;
}

/** F5 uses F4 motion + known floor/boxes ONLY. Low, slow runs nominate one
 * support point (feet first, then a box-contact hand); rigid root offsets
 * lock it without changing pose or bone lengths. Other simultaneous contacts
 * are not an IK solve. Scene feasibility overrides pinning/locks; diagnostics
 * expose every such override instead of claiming incompatible constraints.
 */
export function fitContacts(motion, { boxes = [], contactHeight = 0.04, maxSpeed = 0.18, minStanceSeconds = 0.08, sceneSmoothSeconds = null, cameraOrigin = null, rayMaxOffsetM = 0.75, rayMaxStepM = 0.02 } = {}) {
	validateBoxes(boxes);
	if (![contactHeight, maxSpeed, minStanceSeconds].every(x => Number.isFinite(x) && x > 0)) throw new Error("contact thresholds must be positive");
	if (cameraOrigin !== null) return fitRayContacts(motion, boxes, cameraOrigin, rayMaxOffsetM, rayMaxStepM);
	const out = cloneMotion(motion), n = motion.frames, sites = [...FEET, ...HANDS];
	const minimum = Math.max(2, Math.ceil(minStanceSeconds * motion.fps));
	const targets = new Map(), candidates = new Map();
	for (const j of sites) {
		const track = Array.from({ length: n }, (_, f) => vec(motion.posedJoints, (f * 27 + j) * 3));
		const target = track.map(p => contactTarget(p, j, boxes, contactHeight));
		const eligible = target.map((p, f) => {
			const lo = Math.max(0, f - 1), hi = Math.min(n - 1, f + 1);
			const speed = Math.max(...[lo, hi].map(t => Math.hypot(...sub(track[f], track[t])) * motion.fps));
			return !!p && speed <= maxSpeed;
		});
		const good = new Uint8Array(n);
		for (let f = 0; f < n;) {
			if (!eligible[f]) { f++; continue; }
			const start = f; while (f < n && eligible[f]) f++;
			if (f - start >= minimum) good.fill(1, start, f);
		}
		targets.set(j, target); candidates.set(j, good);
	}
	const support = new Int8Array(n).fill(-1);
	for (let f = 0; f < n; f++) {
		const previous = f ? support[f - 1] : -1;
		support[f] = previous >= 0 && candidates.get(previous)[f] ? previous : (sites.find(j => candidates.get(j)[f]) ?? -1);
	}
	const offsets = new Array(n).fill(null), anchors = new Array(n).fill(null);
	let carry = [0, 0, 0], runs = 0, lockedFrames = 0;
	for (let f = 0; f < n;) {
		const j = support[f];
		if (j < 0) { f++; continue; }
		const first = f, target = targets.get(j)[f];
		// Keep accumulated horizontal travel across stance changes, but the
		// surface owns contact height. A hand's authored face owns all axes.
		const anchor = FEET.includes(j) ? [target[0] + carry[0], target[1], target[2] + carry[2]] : target;
		while (f < n && support[f] === j) {
			offsets[f] = sub(anchor, vec(motion.posedJoints, (f * 27 + j) * 3)); anchors[f] = anchor; f++;
		}
		carry = offsets[f - 1]; runs++; lockedFrames += f - first;
	}
	// Smooth offset bridges through flight/swing; no reset snap on release.
	for (let f = 0; f < n;) {
		if (offsets[f]) { f++; continue; }
		const start = f; while (f < n && !offsets[f]) f++;
		const a = start ? offsets[start - 1] : [0, 0, 0], b = f < n ? offsets[f] : a;
		for (let t = start; t < f; t++) { const w = smoothstep((t - start + 1) / (f - start + 1)); offsets[t] = a.map((v, k) => v + (b[k] - v) * w); }
	}
	let sceneOverrides = 0, maxLockResidualM = 0, maxCorrectionM = 0, sceneMaxStepM = 0;
	// sceneSmoothSeconds selects the time-smooth scene solver (its ramp half
	// width); null keeps the original per-frame projection (F5 and earlier).
	let sceneDeltas = null;
	if (sceneSmoothSeconds !== null) {
		if (!(Number.isFinite(sceneSmoothSeconds) && sceneSmoothSeconds > 0)) throw new Error("sceneSmoothSeconds must be a positive duration");
		for (let f = 0; f < n; f++) shiftFrame(out, f, offsets[f]);
		sceneDeltas = continuousSceneDeltas(out, boxes, Math.max(1, Math.round(sceneSmoothSeconds * motion.fps)));
	}
	for (let f = 0; f < n; f++) {
		if (!sceneDeltas) shiftFrame(out, f, offsets[f]);
		const { delta } = sceneDeltas ? { delta: sceneDeltas[f] } : resolveScene(jointsAt(out, f), boxes);
		if (f && sceneDeltas) sceneMaxStepM = Math.max(sceneMaxStepM, Math.hypot(...sub(sceneDeltas[f], sceneDeltas[f - 1])));
		if (Math.hypot(...delta) > 1e-6) sceneOverrides++;
		shiftFrame(out, f, delta);
		maxCorrectionM = Math.max(maxCorrectionM, Math.hypot(...add(offsets[f], delta)));
		if (support[f] >= 0) maxLockResidualM = Math.max(maxLockResidualM, Math.hypot(...sub(vec(out.posedJoints, (f * 27 + support[f]) * 3), anchors[f])));
	}
	return { motion: out, diagnostics: { runs, lockedFrames, sceneOverrides, maxLockResidualM, maxCorrectionM, support: Array.from(support), geometry: "cskel27 joint/bone segments; no skin radius", solver: "one rigid support; scene constraints override locks and A/B pins", sceneSolver: sceneDeltas ? "continuous" : "per-frame", ...(sceneDeltas ? { sceneSmoothSeconds, sceneMaxStepM } : {}) } };
}
