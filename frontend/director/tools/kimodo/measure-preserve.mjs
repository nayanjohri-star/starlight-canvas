#!/usr/bin/env node
/**
 * measure-preserve.mjs — how much of a base take survived a regeneration?
 *
 * This is the measuring stick for the scheduled-inpainting acceptance gates
 * (.omo/plans/scheduled-inpainting.md, G1–G4): it compares two cclay motion
 * npz files — the take the user already had, and the take that came back out
 * of a preserve-enabled generation — and reports how far apart they are.
 *
 * GPU-free and dependency-free on purpose: the gates are run over artefacts
 * pulled back from the box, so this has to work from a laptop with nothing but
 * node and the two files.
 *
 * WHY ROOT-RELATIVE POSITIONS ARE THE HEADLINE NUMBER. Kimodo generates in a
 * canonicalised space and the take is re-anchored afterwards, so two takes that
 * hold the SAME pose can sit metres apart in world coordinates. A raw
 * posed_joints difference is then dominated by root drift and says nothing about
 * whether the body was preserved, which is the thing the gates are about. So the
 * headline L2P subtracts each frame's Hips position from every joint of that
 * frame before differencing, and the undrifted figure is still reported
 * separately as globalL2P because a take that preserves the pose but walks off
 * in a different direction is its own kind of failure and must stay visible.
 *
 * WHY ROTATION IS MEASURED GEODESICALLY. Per-element matrix differences are not
 * a metric on SO(3) — the same 10° error scores differently depending on where
 * on the sphere it sits. The geodesic angle acos((tr(Rᵀ_a R_b) - 1)/2) is the
 * actual rotation you would have to apply to get from one to the other, in
 * radians, and is directly comparable between joints and between clips.
 *
 * WHY FOOT SLIDING IS MEASURED PER CLIP, NOT AS A DIFFERENCE. G4 asks whether
 * preservation introduced skating, and skating is a property of ONE clip (a
 * planted foot that translates), not of the pair. So each clip is measured on
 * its own timeline with its own floor, and only then are the two numbers
 * subtracted.
 *
 * WHY THERE IS A PER-JOINT SPLIT (round 2). The grouped-mask gates are claims
 * about WHICH PART of the body moved: "free the left arm over this range and the
 * arm moves while the legs do not" (GA), "the edited hand lands on target and the
 * other limbs stay put" (GC). A single whole-body mean cannot distinguish "the
 * arm moved 10 cm" from "every joint drifted 1 cm", and those are a pass and a
 * failure of the same gate. So the same root-relative L2P is also accumulated
 * per cskel27 joint and aggregated into the seven C1v2 mask groups.
 *
 * usage:
 *   measure-preserve.mjs <base.npz> <candidate.npz> [--ranges 40:80,120:150]
 *                        [--json] [--per-joint] [--groups]
 *                        [--max-l2p M] [--max-l2r RAD] [--max-foot-delta M]
 *
 * `--ranges` are APP frames, half-open [start,end), in the BASE clip's frame
 * space — the same space C3's `editRanges` are authored in. Frames inside any
 * range are the ones the edit was allowed to change; everything else is what
 * G2 says must stay pinned to the base.
 *
 * Any --max-* flag turns this into a gate: exceeding it exits 1. With no
 * threshold flag the tool only reports and exits 0.
 */

import { readNpz } from "./read-npz.mjs";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";

const JOINTS = 27;

/** Joint 0 is the root in cskel27; asserted rather than assumed because every
 * root-relative number below silently changes meaning if the order ever moves. */
const HIPS = 0;
if (CSKEL27_JOINTS[HIPS] !== "Hips") {
	throw new Error(`measure-preserve: cskel27 joint 0 is ${CSKEL27_JOINTS[HIPS]}, expected Hips`);
}

/** The joints whose contact with the floor defines sliding. Toes are included
 * because a heel-planted foot pivoting on the toe is not skating, but a toe
 * that translates while down is. */
const FOOT_JOINTS = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"];
const FOOT_INDICES = FOOT_JOINTS.map((name) => {
	const index = CSKEL27_JOINTS.indexOf(name);
	if (index < 0) throw new Error(`measure-preserve: cskel27 has no joint ${name}`);
	return index;
});

/**
 * Contact heuristic, deliberately crude and deliberately per-joint-per-clip.
 *
 * A joint counts as planted on a frame when its height is within 5 cm of THAT
 * JOINT's own minimum height across THAT clip. Per-joint because the toe sits
 * lower than the ankle and a shared threshold would call the ankle airborne for
 * the whole clip; per-clip because soma77ToCskel27Motion floor-shifts each take
 * by its own lowest sample, so "y == 0" is not a shared floor between two files.
 *
 * The honest caveat: for a clip with no ground contact at all (a jump loop, a
 * lying-down take) the minimum is not the floor and this will report the slide
 * of whatever was lowest. That is acceptable here because G4 compares the SAME
 * motion before and after preservation, so the bias is identical on both sides
 * and cancels in the delta. Do not lift this number into an absolute
 * "does this clip skate" claim without checking the clip has real contacts.
 */
const CONTACT_BAND_M = 0.05;

/* ------------------------------------------------------- cskel27 -> C1v2 groups */

/**
 * The seven C1v2 mask groups expressed in cskel27 JOINT names.
 *
 * THIS IS A DIFFERENT NAMESPACE FROM THE MASK'S TRACK IDS and the two must not
 * be confused. tools/kimodo/preserve-mask.mjs maps IK TRACK ids — the handles
 * the user drags: `leftHand`, `leftElbow`, `chest`, `hips` — to these same seven
 * group names. This table maps the 27 MEASURED joints to them. The names differ
 * on both sides of the arrow: the `leftElbow` track is the joint cskel27 calls
 * LeftForeArm, the `chest` track spans Spine1/Spine2, and joints the user has no
 * handle for at all (LeftHandEnd, RightToeBase, Spine3) still have to land in a
 * group here because they are measured. So this is a mirror of TRACK_GROUPS'
 * SEMANTICS, deliberately re-derived rather than imported — importing would
 * suggest a name correspondence that does not exist.
 *
 * Two consequences worth stating before someone reads a number wrong:
 *
 *  - `root` is Hips alone, and the root-relative L2P of Hips is IDENTICALLY
 *    ZERO by construction (every joint is expressed against its own frame's
 *    hips, so the hips are always the origin). The root group's meaningful
 *    number is therefore its GLOBAL L2P, which is reported alongside. A root
 *    l2p_m of 0.000000 is arithmetic, not a passing gate.
 *  - Hips appears in BOTH `root` and `torso`, mirroring the mask's `hips` track
 *    which frees both. The groups therefore overlap and their joint counts sum
 *    to 28, not 27.
 */
export const CSKEL27_GROUPS = Object.freeze({
	root: Object.freeze(["Hips"]),
	// the shoulders are torso, not arm: a clavicle swings the whole shoulder
	// mass, exactly as TRACK_GROUPS puts leftShoulder/rightShoulder in torso.
	torso: Object.freeze(["Hips", "Spine", "Spine1", "Spine2", "Spine3", "LeftShoulder", "RightShoulder"]),
	head: Object.freeze(["Neck", "Head"]),
	leftArm: Object.freeze(["LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1"]),
	rightArm: Object.freeze(["RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1"]),
	leftLeg: Object.freeze(["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"]),
	rightLeg: Object.freeze(["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]),
});

/** Group name -> joint indices, resolved once and checked for total coverage. */
const GROUP_INDICES = Object.fromEntries(
	Object.entries(CSKEL27_GROUPS).map(([group, joints]) => [
		group,
		joints.map((name) => {
			const index = CSKEL27_JOINTS.indexOf(name);
			if (index < 0) throw new Error(`measure-preserve: group ${group} names unknown cskel27 joint ${name}`);
			return index;
		}),
	])
);

/** Joint index -> the groups it belongs to. A joint in NO group would be
 * silently missing from every grouped number, so the partition is checked at
 * load rather than trusted. */
const JOINT_GROUPS = CSKEL27_JOINTS.map((_, index) =>
	Object.keys(GROUP_INDICES).filter((group) => GROUP_INDICES[group].includes(index))
);
for (let joint = 0; joint < JOINTS; joint += 1) {
	if (JOINT_GROUPS[joint].length === 0) {
		throw new Error(`measure-preserve: cskel27 joint ${CSKEL27_JOINTS[joint]} belongs to no C1v2 group`);
	}
}

/* ------------------------------------------------------------------ loading */

function requireMember(members, name, path) {
	const member = members[name];
	if (!member) {
		throw new Error(
			`measure-preserve: ${path} is missing the '${name}' member — is this a cclay motion npz? ` +
				`(found: ${Object.keys(members).join(", ") || "nothing"})`
		);
	}
	if (member.unsupported || !member.data) {
		throw new Error(
			`measure-preserve: ${path} stores '${name}' as unsupported dtype ${member.dtype}`
		);
	}
	return member;
}

/** Count non-finite entries so a NaN in the source is reported by name instead
 * of quietly turning every aggregate into NaN. */
function countNonFinite(data) {
	let count = 0;
	for (let index = 0; index < data.length; index += 1) {
		if (!Number.isFinite(data[index])) count += 1;
	}
	return count;
}

/**
 * Load a cclay motion npz down to the arrays this tool compares.
 * @returns {{path:string, frames:number, fps:number, fpsAssumed:boolean,
 *            rot:Float32Array, posed:Float32Array, nonFinite:object}}
 */
export function loadMotion(path, { defaultFps = 20 } = {}) {
	const members = readNpz(path);
	const rot = requireMember(members, "local_rot_mats", path);
	const posed = requireMember(members, "posed_joints", path);

	if (rot.shape.length !== 4 || rot.shape[1] !== JOINTS || rot.shape[2] !== 3 || rot.shape[3] !== 3) {
		throw new Error(
			`measure-preserve: ${path} local_rot_mats must be [T,${JOINTS},3,3], got [${rot.shape}]`
		);
	}
	if (posed.shape.length !== 3 || posed.shape[1] !== JOINTS || posed.shape[2] !== 3) {
		throw new Error(
			`measure-preserve: ${path} posed_joints must be [T,${JOINTS},3], got [${posed.shape}]`
		);
	}
	const frames = rot.shape[0];
	if (posed.shape[0] !== frames) {
		throw new Error(
			`measure-preserve: ${path} local_rot_mats has ${frames} frames but posed_joints has ${posed.shape[0]}`
		);
	}
	if (frames < 1) throw new Error(`measure-preserve: ${path} has no frames`);

	// fps is optional in the wild: ARDY-generated takes write it as <i4 and
	// ARDY-Core demos as <i8, but a hand-built or trimmed file may omit it. A
	// missing fps is assumed, never guessed silently — it changes the resampling.
	let fps = null;
	let fpsAssumed = false;
	if (members.fps && members.fps.data && !members.fps.unsupported) {
		fps = Math.round(members.fps.data[0]);
		if (!Number.isInteger(fps) || fps < 1) {
			throw new Error(`measure-preserve: ${path} has a non-positive fps member (${fps})`);
		}
	} else {
		fps = defaultFps;
		fpsAssumed = true;
	}

	return {
		path,
		frames,
		fps,
		fpsAssumed,
		rot: rot.data,
		posed: posed.data,
		nonFinite: {
			local_rot_mats: countNonFinite(rot.data),
			posed_joints: countNonFinite(posed.data),
		},
	};
}

/* -------------------------------------------------------------- comparison */

/**
 * Map every base frame onto a candidate frame by NEAREST sample in time.
 *
 * Nearest, not interpolated, because interpolating rotation matrices
 * element-wise leaves SO(3) and would make L2R measure the interpolation error
 * instead of the generation's. Nearest is exact when the clocks match (the
 * normal case) and is an honest, reportable approximation when they do not.
 *
 * Base frames whose time falls past the end of the candidate are dropped rather
 * than clamped: clamping would compare the whole tail of the base against one
 * repeated candidate frame and invent an error that is really just a length
 * mismatch. The count of dropped frames is reported as a truncation warning.
 */
export function buildFrameMap(base, candidate) {
	const map = new Int32Array(base.frames);
	let compared = 0;
	for (let frame = 0; frame < base.frames; frame += 1) {
		const index = Math.round((frame * candidate.fps) / base.fps);
		if (index > candidate.frames - 1) break;
		map[frame] = index;
		compared += 1;
	}
	if (compared === 0) {
		throw new Error(
			`measure-preserve: no overlapping frames between ${base.path} ` +
				`(${base.frames}@${base.fps}) and ${candidate.path} (${candidate.frames}@${candidate.fps})`
		);
	}
	return { map, compared };
}

/** Accumulator for a mean over per-sample values, NaN-skipping and counting. */
function accumulator() {
	return { sum: 0, count: 0, skipped: 0, max: 0 };
}

function add(acc, value) {
	if (!Number.isFinite(value)) {
		acc.skipped += 1;
		return;
	}
	acc.sum += value;
	acc.count += 1;
	if (value > acc.max) acc.max = value;
}

function mean(acc) {
	return acc.count > 0 ? acc.sum / acc.count : null;
}

function summarize(acc) {
	return { mean: mean(acc), max: acc.count > 0 ? acc.max : null, samples: acc.count, skipped: acc.skipped };
}

/**
 * Merge accumulators into one, so a group's mean is the mean over ALL its
 * joints' samples rather than the mean of their per-joint means. The two differ
 * whenever a joint skipped a NaN sample, and the sample-weighted one is the
 * honest reading of "how far apart are these joints".
 */
function combine(accs) {
	const merged = accumulator();
	for (const acc of accs) {
		merged.sum += acc.sum;
		merged.count += acc.count;
		merged.skipped += acc.skipped;
		if (acc.count > 0 && acc.max > merged.max) merged.max = acc.max;
	}
	return merged;
}

/**
 * Geodesic angle between two rotation matrices, in radians.
 *
 * The textbook form is acos((tr(Rᵀ_a R_b) - 1) / 2), and it is a TRAP at the
 * small angles this tool exists to measure. acos has infinite slope at 1, so it
 * amplifies error like sqrt: the npz stores float32, whose matrices are only
 * orthonormal to ~1e-7, and acos turns that 1e-7 into ~3e-4 rad of phantom
 * rotation error. Measured, not theorised — the first cut of this file scored a
 * fixture against ITSELF at 1.04e-4 rad mean / 7.6e-4 max, which is the same
 * order as a real preservation difference and would have made G1 unreadable.
 *
 * So the angle comes from atan2(sin, cos) instead, where sin is read off the
 * skew-symmetric part of Rᵀ_a R_b. Near zero, sin IS the angle to first order
 * and is built from DIFFERENCES that vanish when the matrices agree, so the
 * float32 noise stays 1e-7 instead of being square-rooted up.
 *
 * The bitwise fast path on top is not an optimisation dodge: two identical
 * float32 blocks are the same rotation, and the geodesic distance from a
 * rotation to itself is exactly 0. Any nonzero result there is arithmetic
 * noise, and reporting it would be wrong, not precise.
 *
 * Neither the transpose nor the product is materialised — the six entries and
 * the trace are read straight out of the two flat blocks.
 */
function geodesicAngle(rot, aBase, bBase) {
	const a = rot.a;
	const b = rot.b;
	let identical = true;
	for (let element = 0; element < 9; element += 1) {
		if (a[aBase + element] !== b[bBase + element]) {
			identical = false;
			break;
		}
	}
	if (identical) return 0;

	// R = Aᵀ B, so R[i][j] = sum_k A[k][i] * B[k][j]; A[r][c] is flat[base+r*3+c].
	let trace = 0;
	for (let element = 0; element < 9; element += 1) trace += a[aBase + element] * b[bBase + element];

	let r21 = 0, r12 = 0, r02 = 0, r20 = 0, r10 = 0, r01 = 0;
	for (let k = 0; k < 3; k += 1) {
		const ak = aBase + k * 3;
		const bk = bBase + k * 3;
		r21 += a[ak + 2] * b[bk + 1];
		r12 += a[ak + 1] * b[bk + 2];
		r02 += a[ak + 0] * b[bk + 2];
		r20 += a[ak + 2] * b[bk + 0];
		r10 += a[ak + 1] * b[bk + 0];
		r01 += a[ak + 0] * b[bk + 1];
	}
	const sin = 0.5 * Math.hypot(r21 - r12, r02 - r20, r10 - r01);
	const cos = (trace - 1) / 2;
	// atan2 needs no clamping: it is defined for any (sin, cos) pair, including
	// the slightly-off-unit-circle pairs a non-exactly-orthonormal input gives.
	return Math.atan2(sin, cos);
}

/**
 * Parse `--ranges 40:80,120:150` into half-open [start,end) app-frame ranges.
 */
export function parseRanges(text) {
	const ranges = [];
	for (const part of text.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const bits = trimmed.split(":");
		if (bits.length !== 2) {
			throw new Error(`measure-preserve: bad range '${trimmed}', expected start:end`);
		}
		const start = Number(bits[0]);
		const end = Number(bits[1]);
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
			throw new Error(
				`measure-preserve: bad range '${trimmed}' — start and end must be integers with 0 <= start < end`
			);
		}
		ranges.push({ startFrame: start, endFrame: end });
	}
	return ranges;
}

/** Per-frame membership of the union of the edited ranges, in base frame space. */
function rangeMembership(ranges, frames) {
	const inside = new Uint8Array(frames);
	for (const range of ranges) {
		const from = Math.max(0, range.startFrame);
		const to = Math.min(frames, range.endFrame);
		for (let frame = from; frame < to; frame += 1) inside[frame] = 1;
	}
	return inside;
}

/**
 * Foot sliding for ONE clip, in metres of XZ travel per frame.
 *
 * Headline number is the TOTAL slide accumulated across all four foot joints
 * divided by the clip's frame transitions, so a clip where both feet skate
 * scores twice a clip where one does. Per-joint figures are reported alongside
 * because a single skating toe is a different bug from a whole body gliding.
 */
export function footSliding(motion) {
	const { frames, posed } = motion;
	const transitions = Math.max(1, frames - 1);
	const perJoint = [];
	let total = 0;
	let contactFrames = 0;

	for (let slot = 0; slot < FOOT_INDICES.length; slot += 1) {
		const joint = FOOT_INDICES[slot];
		let minY = Infinity;
		for (let frame = 0; frame < frames; frame += 1) {
			const y = posed[(frame * JOINTS + joint) * 3 + 1];
			if (Number.isFinite(y) && y < minY) minY = y;
		}
		let slide = 0;
		let contacts = 0;
		if (Number.isFinite(minY)) {
			const ceiling = minY + CONTACT_BAND_M;
			for (let frame = 0; frame < frames - 1; frame += 1) {
				const here = (frame * JOINTS + joint) * 3;
				const next = ((frame + 1) * JOINTS + joint) * 3;
				if (!(posed[here + 1] <= ceiling)) continue; // airborne, or NaN
				const dx = posed[next] - posed[here];
				const dz = posed[next + 2] - posed[here + 2];
				const step = Math.hypot(dx, dz);
				if (!Number.isFinite(step)) continue;
				slide += step;
				contacts += 1;
			}
		}
		total += slide;
		contactFrames += contacts;
		perJoint.push({
			joint: CSKEL27_JOINTS[joint],
			minHeight_m: Number.isFinite(minY) ? minY : null,
			contactFrames: contacts,
			slide_m: slide,
			slide_m_per_frame: slide / transitions,
		});
	}

	return {
		contactBand_m: CONTACT_BAND_M,
		frames,
		contactFrames,
		total_slide_m: total,
		slide_m_per_frame: total / transitions,
		perJoint,
	};
}

/**
 * Compare a base take against a candidate.
 * @param {object} base      from loadMotion
 * @param {object} candidate from loadMotion
 * @param {Array<{startFrame:number,endFrame:number}>} ranges edited app-frame ranges
 */
export function measurePreserve(base, candidate, ranges = []) {
	const warnings = [];
	for (const motion of [base, candidate]) {
		for (const [member, count] of Object.entries(motion.nonFinite)) {
			if (count > 0) warnings.push(`${motion.path}: ${count} non-finite values in ${member}`);
		}
		if (motion.fpsAssumed) warnings.push(`${motion.path}: no fps member, assumed ${motion.fps}`);
	}

	// Resampling and truncation are reported separately because they are
	// different accusations: a clock mismatch means the numbers below carry a
	// nearest-frame approximation, whereas an equal-clock length mismatch means
	// the candidate is simply shorter and nothing was approximated.
	const resampled = base.fps !== candidate.fps;
	const { map, compared } = buildFrameMap(base, candidate);
	if (resampled) {
		warnings.push(
			`candidate resampled onto the base timeline by nearest frame ` +
				`(base ${base.frames}f@${base.fps} vs candidate ${candidate.frames}f@${candidate.fps})`
		);
	}
	const truncated = compared < base.frames;
	if (truncated) {
		warnings.push(
			`candidate is short: only ${compared} of ${base.frames} base frames have a candidate sample; ` +
				`the remaining ${base.frames - compared} were dropped, not clamped`
		);
	}
	for (const range of ranges) {
		// The classic mix-up is handing this tool GENERATION-space frames (30 fps)
		// for an app-space (20 fps) clip, which silently lands the range past the
		// end and reports a flawless out-of-range score over the whole take.
		if (range.startFrame >= compared) {
			warnings.push(
				`range [${range.startFrame},${range.endFrame}) starts past the last compared frame ` +
					`(${compared}) — are these app frames in the BASE clip's fps space?`
			);
		} else if (range.endFrame > compared) {
			warnings.push(
				`range [${range.startFrame},${range.endFrame}) is clipped to the compared span (${compared} frames)`
			);
		}
	}

	const inside = rangeMembership(ranges, base.frames);
	const rot = { a: base.rot, b: candidate.rot };

	// Three buckets per metric: everything, inside the edited ranges, outside.
	const buckets = {
		l2p: { all: accumulator(), inRange: accumulator(), outOfRange: accumulator() },
		globalL2p: { all: accumulator(), inRange: accumulator(), outOfRange: accumulator() },
		l2r: { all: accumulator(), inRange: accumulator(), outOfRange: accumulator() },
	};
	const perFrame = { l2p: new Float64Array(compared), l2r: new Float64Array(compared) };

	// Per-joint buckets, the round-2 addition. Three per joint for the same
	// reason the whole-body metric has three: GA and GC are claims about a joint
	// INSIDE the edited range versus the same joint outside it.
	const perJointBuckets = [];
	for (let joint = 0; joint < JOINTS; joint += 1) {
		perJointBuckets.push({
			l2p: { all: accumulator(), inRange: accumulator(), outOfRange: accumulator() },
			globalL2p: accumulator(),
			l2r: accumulator(),
		});
	}

	for (let frame = 0; frame < compared; frame += 1) {
		const other = map[frame];
		const baseFrameBase = frame * JOINTS * 3;
		const candFrameBase = other * JOINTS * 3;
		const baseHips = baseFrameBase + HIPS * 3;
		const candHips = candFrameBase + HIPS * 3;
		const bucket = inside[frame] ? "inRange" : "outOfRange";

		let frameL2p = 0;
		let frameL2r = 0;
		for (let joint = 0; joint < JOINTS; joint += 1) {
			const p = baseFrameBase + joint * 3;
			const q = candFrameBase + joint * 3;
			const jointBucket = perJointBuckets[joint];

			// Root-relative: each side is expressed against its OWN hips, so a
			// clip that is the same pose translated scores zero here.
			const rdx = base.posed[p] - base.posed[baseHips] - (candidate.posed[q] - candidate.posed[candHips]);
			const rdy = base.posed[p + 1] - base.posed[baseHips + 1] - (candidate.posed[q + 1] - candidate.posed[candHips + 1]);
			const rdz = base.posed[p + 2] - base.posed[baseHips + 2] - (candidate.posed[q + 2] - candidate.posed[candHips + 2]);
			const local = Math.hypot(rdx, rdy, rdz);
			add(buckets.l2p.all, local);
			add(buckets.l2p[bucket], local);
			add(jointBucket.l2p.all, local);
			add(jointBucket.l2p[bucket], local);
			frameL2p += Number.isFinite(local) ? local : 0;

			const global = Math.hypot(
				base.posed[p] - candidate.posed[q],
				base.posed[p + 1] - candidate.posed[q + 1],
				base.posed[p + 2] - candidate.posed[q + 2]
			);
			add(buckets.globalL2p.all, global);
			add(buckets.globalL2p[bucket], global);
			add(jointBucket.globalL2p, global);

			const angle = geodesicAngle(rot, (frame * JOINTS + joint) * 9, (other * JOINTS + joint) * 9);
			add(buckets.l2r.all, angle);
			add(buckets.l2r[bucket], angle);
			add(jointBucket.l2r, angle);
			frameL2r += Number.isFinite(angle) ? angle : 0;
		}
		perFrame.l2p[frame] = frameL2p / JOINTS;
		perFrame.l2r[frame] = frameL2r / JOINTS;
	}

	// Per-range breakdown: a union aggregate hides an edit that only moved one
	// of two ranges, which is exactly the G2 failure mode.
	const perRange = ranges.map((range) => {
		const l2p = accumulator();
		const l2r = accumulator();
		const from = Math.max(0, range.startFrame);
		const to = Math.min(compared, range.endFrame);
		for (let frame = from; frame < to; frame += 1) {
			add(l2p, perFrame.l2p[frame]);
			add(l2r, perFrame.l2r[frame]);
		}
		return {
			startFrame: range.startFrame,
			endFrame: range.endFrame,
			comparedFrames: Math.max(0, to - from),
			l2p_m: mean(l2p),
			l2r_rad: mean(l2r),
		};
	});

	// Per-joint table, in cskel27 index order so it lines up with the npz arrays
	// and with any other tool that indexes joints. Sorting it by error would read
	// better and would make two runs impossible to diff, so it stays in order.
	const perJoint = perJointBuckets.map((jointBucket, joint) => ({
		index: joint,
		joint: CSKEL27_JOINTS[joint],
		groups: JOINT_GROUPS[joint],
		l2p_m: mean(jointBucket.l2p.all),
		l2pMax_m: jointBucket.l2p.all.count > 0 ? jointBucket.l2p.all.max : null,
		globalL2p_m: mean(jointBucket.globalL2p),
		l2r_rad: mean(jointBucket.l2r),
		l2p_inRange_m: ranges.length ? mean(jointBucket.l2p.inRange) : null,
		l2p_outOfRange_m: ranges.length ? mean(jointBucket.l2p.outOfRange) : null,
	}));

	// Group aggregation. Sample-weighted across the group's joints, and reported
	// with globalL2p alongside because the `root` group's root-relative number is
	// identically zero by construction (see CSKEL27_GROUPS).
	const perGroup = Object.keys(CSKEL27_GROUPS).map((group) => {
		const indices = GROUP_INDICES[group];
		const l2pAll = combine(indices.map((joint) => perJointBuckets[joint].l2p.all));
		return {
			group,
			joints: indices.map((joint) => CSKEL27_JOINTS[joint]),
			jointCount: indices.length,
			l2p_m: mean(l2pAll),
			l2pMax_m: l2pAll.count > 0 ? l2pAll.max : null,
			globalL2p_m: mean(combine(indices.map((joint) => perJointBuckets[joint].globalL2p))),
			l2r_rad: mean(combine(indices.map((joint) => perJointBuckets[joint].l2r))),
			l2p_inRange_m: ranges.length
				? mean(combine(indices.map((joint) => perJointBuckets[joint].l2p.inRange)))
				: null,
			l2p_outOfRange_m: ranges.length
				? mean(combine(indices.map((joint) => perJointBuckets[joint].l2p.outOfRange)))
				: null,
		};
	});

	const baseFeet = footSliding(base);
	const candidateFeet = footSliding(candidate);

	return {
		base: { path: base.path, frames: base.frames, fps: base.fps },
		candidate: { path: candidate.path, frames: candidate.frames, fps: candidate.fps },
		resampled,
		truncated,
		comparedFrames: compared,
		ranges,
		jointCount: JOINTS,
		l2p_m: summarize(buckets.l2p.all),
		l2p_inRange_m: ranges.length ? summarize(buckets.l2p.inRange) : null,
		l2p_outOfRange_m: ranges.length ? summarize(buckets.l2p.outOfRange) : null,
		globalL2p_m: summarize(buckets.globalL2p.all),
		globalL2p_inRange_m: ranges.length ? summarize(buckets.globalL2p.inRange) : null,
		globalL2p_outOfRange_m: ranges.length ? summarize(buckets.globalL2p.outOfRange) : null,
		l2r_rad: summarize(buckets.l2r.all),
		l2r_inRange_rad: ranges.length ? summarize(buckets.l2r.inRange) : null,
		l2r_outOfRange_rad: ranges.length ? summarize(buckets.l2r.outOfRange) : null,
		perRange,
		perJoint,
		perGroup,
		footSliding: {
			base: baseFeet,
			candidate: candidateFeet,
			// Positive = the candidate skates more than the base. G4's budget.
			delta_m_per_frame: candidateFeet.slide_m_per_frame - baseFeet.slide_m_per_frame,
		},
		warnings,
	};
}

/* -------------------------------------------------------------------- CLI */

function formatMetres(value) {
	return value === null ? "  n/a    " : value.toFixed(6);
}

function formatRadians(value) {
	return value === null ? "  n/a   " : `${value.toFixed(6)} (${((value * 180) / Math.PI).toFixed(3)}°)`;
}

/**
 * The per-joint table. Printed only on request because 27 rows would bury the
 * headline numbers in the common case, and the JSON carries it unconditionally
 * for the gate harness.
 */
function printPerJoint(report) {
	const showRanges = report.ranges.length > 0;
	console.log("  per joint (root-relative L2P, metres — mean over the compared frames)");
	console.log(
		`    ${"joint".padEnd(16)}${"group".padEnd(10)}${"mean".padStart(10)}${"max".padStart(11)}` +
			`${"global".padStart(11)}` +
			(showRanges ? `${"inRange".padStart(11)}${"outRange".padStart(11)}` : "")
	);
	for (const row of report.perJoint) {
		console.log(
			`    ${row.joint.padEnd(16)}${row.groups.join("+").padEnd(10)}` +
				`${formatMetres(row.l2p_m).padStart(10)}${formatMetres(row.l2pMax_m).padStart(11)}` +
				`${formatMetres(row.globalL2p_m).padStart(11)}` +
				(showRanges
					? `${formatMetres(row.l2p_inRange_m).padStart(11)}${formatMetres(row.l2p_outOfRange_m).padStart(11)}`
					: "")
		);
	}
	// The one row that is always 0.000000 and always means nothing.
	console.log("    (Hips root-relative L2P is 0 by construction; read its global column instead)");
}

/**
 * The seven-group aggregation — the shape the round-2 gates are phrased in
 * ("the arm moved, the legs did not").
 */
function printGroups(report) {
	const showRanges = report.ranges.length > 0;
	console.log("  per C1v2 mask group (root-relative L2P, metres; groups overlap — Hips is in root AND torso)");
	console.log(
		`    ${"group".padEnd(10)}${"joints".padStart(7)}${"mean".padStart(11)}${"max".padStart(11)}` +
			`${"global".padStart(11)}` +
			(showRanges ? `${"inRange".padStart(11)}${"outRange".padStart(11)}` : "")
	);
	for (const row of report.perGroup) {
		console.log(
			`    ${row.group.padEnd(10)}${String(row.jointCount).padStart(7)}` +
				`${formatMetres(row.l2p_m).padStart(11)}${formatMetres(row.l2pMax_m).padStart(11)}` +
				`${formatMetres(row.globalL2p_m).padStart(11)}` +
				(showRanges
					? `${formatMetres(row.l2p_inRange_m).padStart(11)}${formatMetres(row.l2p_outOfRange_m).padStart(11)}`
					: "")
		);
	}
}

function printReport(report, { perJoint = false, groups = false } = {}) {
	console.log(`base      : ${report.base.path}  ${report.base.frames} frames @ ${report.base.fps} fps`);
	console.log(`candidate : ${report.candidate.path}  ${report.candidate.frames} frames @ ${report.candidate.fps} fps`);
	console.log(
		`compared  : ${report.comparedFrames} frames x ${report.jointCount} joints` +
			(report.resampled ? "  (candidate RESAMPLED to base timeline, nearest frame)" : "") +
			(report.truncated ? "  (TRUNCATED to the candidate's length)" : "")
	);
	for (const warning of report.warnings) console.log(`WARN: ${warning}`);

	console.log("");
	console.log("  position error (root-relative, metres)");
	console.log(`    all         : mean ${formatMetres(report.l2p_m.mean)}   max ${formatMetres(report.l2p_m.max)}`);
	if (report.l2p_inRange_m) {
		console.log(`    inRange     : mean ${formatMetres(report.l2p_inRange_m.mean)}   max ${formatMetres(report.l2p_inRange_m.max)}   (${report.l2p_inRange_m.samples} samples)`);
		console.log(`    outOfRange  : mean ${formatMetres(report.l2p_outOfRange_m.mean)}   max ${formatMetres(report.l2p_outOfRange_m.max)}   (${report.l2p_outOfRange_m.samples} samples)`);
	}
	console.log("  position error (global / world, metres)");
	console.log(`    all         : mean ${formatMetres(report.globalL2p_m.mean)}   max ${formatMetres(report.globalL2p_m.max)}`);
	if (report.globalL2p_inRange_m) {
		console.log(`    inRange     : mean ${formatMetres(report.globalL2p_inRange_m.mean)}`);
		console.log(`    outOfRange  : mean ${formatMetres(report.globalL2p_outOfRange_m.mean)}`);
	}
	console.log("  rotation error (geodesic, radians)");
	console.log(`    all         : mean ${formatRadians(report.l2r_rad.mean)}   max ${formatRadians(report.l2r_rad.max)}`);
	if (report.l2r_inRange_rad) {
		console.log(`    inRange     : mean ${formatRadians(report.l2r_inRange_rad.mean)}`);
		console.log(`    outOfRange  : mean ${formatRadians(report.l2r_outOfRange_rad.mean)}`);
	}

	if (report.perRange.length) {
		console.log("  per edited range");
		for (const range of report.perRange) {
			console.log(
				`    [${range.startFrame},${range.endFrame})  ${String(range.comparedFrames).padStart(4)} frames  ` +
					`L2P ${formatMetres(range.l2p_m)}  L2R ${formatRadians(range.l2r_rad)}`
			);
		}
	}

	if (perJoint) printPerJoint(report);
	if (groups) printGroups(report);

	const feet = report.footSliding;
	console.log("  foot sliding (m per frame, contact = within 5 cm of that joint's own minimum)");
	console.log(`    base        : ${feet.base.slide_m_per_frame.toFixed(6)}   (${feet.base.contactFrames} contact frames)`);
	console.log(`    candidate   : ${feet.candidate.slide_m_per_frame.toFixed(6)}   (${feet.candidate.contactFrames} contact frames)`);
	console.log(`    delta       : ${feet.delta_m_per_frame >= 0 ? "+" : ""}${feet.delta_m_per_frame.toFixed(6)}`);

	console.log("");
	// Flat, greppable keys, same shape as measure-waypoints.mjs's WORST_ERROR_M,
	// so a gate script can pull one number without parsing the whole report.
	console.log(`L2P_M=${report.l2p_m.mean === null ? "nan" : report.l2p_m.mean.toFixed(6)}`);
	console.log(`GLOBAL_L2P_M=${report.globalL2p_m.mean === null ? "nan" : report.globalL2p_m.mean.toFixed(6)}`);
	console.log(`L2R_RAD=${report.l2r_rad.mean === null ? "nan" : report.l2r_rad.mean.toFixed(6)}`);
	if (report.l2p_outOfRange_m) {
		console.log(`L2P_OUT_M=${report.l2p_outOfRange_m.mean === null ? "nan" : report.l2p_outOfRange_m.mean.toFixed(6)}`);
		console.log(`L2P_IN_M=${report.l2p_inRange_m.mean === null ? "nan" : report.l2p_inRange_m.mean.toFixed(6)}`);
	}
	if (groups) {
		// One flat key per group so a gate script can assert "arm moved, legs did
		// not" without parsing the table. The all-frames key is always emitted and
		// the range-scoped ones only when ranges were given, so a key never
		// silently changes meaning between two invocations.
		const number = (value) => (value === null ? "nan" : value.toFixed(6));
		for (const row of report.perGroup) {
			const name = row.group.toUpperCase();
			console.log(`L2P_GROUP_${name}=${number(row.l2p_m)}`);
			if (report.ranges.length) {
				console.log(`L2P_GROUP_${name}_IN=${number(row.l2p_inRange_m)}`);
				console.log(`L2P_GROUP_${name}_OUT=${number(row.l2p_outOfRange_m)}`);
			}
		}
	}
	console.log(`FOOT_SLIDE_DELTA_M=${feet.delta_m_per_frame.toFixed(6)}`);
}

function parseArgs(argv) {
	const positional = [];
	const options = {
		ranges: [], json: false, perJoint: false, groups: false,
		maxL2p: null, maxL2r: null, maxFootDelta: null,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--per-joint") options.perJoint = true;
		else if (arg === "--groups") options.groups = true;
		else if (arg === "--ranges") options.ranges = parseRanges(argv[++index] ?? "");
		else if (arg.startsWith("--ranges=")) options.ranges = parseRanges(arg.slice("--ranges=".length));
		else if (arg === "--max-l2p") options.maxL2p = Number(argv[++index]);
		else if (arg === "--max-l2r") options.maxL2r = Number(argv[++index]);
		else if (arg === "--max-foot-delta") options.maxFootDelta = Number(argv[++index]);
		else if (arg.startsWith("--")) throw new Error(`measure-preserve: unknown flag ${arg}`);
		else positional.push(arg);
	}
	for (const [flag, value] of [["--max-l2p", options.maxL2p], ["--max-l2r", options.maxL2r], ["--max-foot-delta", options.maxFootDelta]]) {
		if (value !== null && !Number.isFinite(value)) {
			throw new Error(`measure-preserve: ${flag} needs a finite number`);
		}
	}
	return { positional, options };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("measure-preserve.mjs");
if (invokedDirectly) {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	const [basePath, candidatePath] = parsed.positional;
	if (!basePath || !candidatePath) {
		console.error(
			"usage: measure-preserve.mjs <base.npz> <candidate.npz> [--ranges 40:80,120:150] [--json]\n" +
				"                            [--per-joint] [--groups]\n" +
				"                            [--max-l2p M] [--max-l2r RAD] [--max-foot-delta M]"
		);
		process.exit(2);
	}

	let report;
	try {
		const base = loadMotion(basePath);
		// The candidate inherits the base's fps when it carries none: the two are
		// the same take before and after regeneration, so silently assuming a
		// different default would fake a resample.
		const candidate = loadMotion(candidatePath, { defaultFps: base.fps });
		report = measurePreserve(base, candidate, parsed.options.ranges);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}

	// Gates are evaluated before printing so the failures can ride along in the
	// JSON, which is the form the acceptance harness consumes.
	const failures = [];
	const { maxL2p, maxL2r, maxFootDelta } = parsed.options;
	if (maxL2p !== null && !(report.l2p_m.mean <= maxL2p)) {
		failures.push(`L2P ${report.l2p_m.mean} > --max-l2p ${maxL2p}`);
	}
	if (maxL2r !== null && !(report.l2r_rad.mean <= maxL2r)) {
		failures.push(`L2R ${report.l2r_rad.mean} > --max-l2r ${maxL2r}`);
	}
	if (maxFootDelta !== null && !(report.footSliding.delta_m_per_frame <= maxFootDelta)) {
		failures.push(`foot slide delta ${report.footSliding.delta_m_per_frame} > --max-foot-delta ${maxFootDelta}`);
	}

	if (parsed.options.json) {
		console.log(JSON.stringify({ ...report, failures }, null, 2));
	} else {
		printReport(report, { perJoint: parsed.options.perJoint, groups: parsed.options.groups });
		for (const failure of failures) console.error(`FAIL: ${failure}`);
	}
	process.exit(failures.length ? 1 : 0);
}
