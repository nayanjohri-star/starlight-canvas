/**
 * hml22-to-cskel27.mjs — ProjFlow's HumanML3D 22-joint POSITION stream → the
 * exact motion arrays the cclay npz encoder consumes ({ frames, fps, rotMats,
 * rootPos, posedJoints }), i.e. the same shape tools/kimodo/soma77-to-cskel27.mjs
 * and tools/ardy/bvh-cskel27.mjs produce. Everything downstream — the npz
 * writer, measure-preserve, playback, the splice — is written against that
 * shape, so this file's whole job is to end at it.
 *
 * WHY POSITIONS AND NOT ROTATIONS (the one structural difference from Kimodo).
 * The checkpoint we target is `ACMDM_Raw_Flow_S_PatchSize22`. ACMDM's "Raw"
 * family generates ABSOLUTE JOINT COORDINATES — the model's output tensor is
 * [T, 22, 3] metres at 20 fps with no rotation channel at all (that is the
 * backbone paper's thesis: "Absolute Coordinates Make Motion Generation Easy").
 * soma77ToCskel27Motion is handed `global_rot_mats` and only has to re-express
 * them; here the rotations DO NOT EXIST YET and must be lifted from positions.
 * Plan C8 amendment (2026-08-29) froze that: input is positions, the converter
 * lifts.
 *
 * THREE MOVES, deliberately the same three as soma77-to-cskel27.mjs:
 *   1. NAME MAPPING with an explicit null for every cskel27 joint the source
 *      cannot author (CSKEL27_FROM_HML22).
 *   2. NEAREST-MAPPED-ANCESTOR rule for those nulls: an unauthored joint borrows
 *      its nearest mapped ancestor's GLOBAL rotation, so its LOCAL comes out
 *      identity — the same "not authored" convention poseToCskel27 and
 *      bvhToCskel27Motion use.
 *   3. EVERYTHING THROUGH GLOBAL SPACE. cskel27 and hml22 do not share a spine
 *      segmentation (cskel27 runs Hips→Spine→Spine1→Spine2→Spine3, four links
 *      before the shoulder carrier; hml22 runs pelvis→spine1→spine2→spine3,
 *      three), so a cskel27 local is only well defined as
 *      parentGlobalᵀ · global. Anything between two mapped joints is absorbed
 *      into the child's local and no rotation is lost.
 *
 * THE NEW MOVE: POSITIONS → GLOBALS ("aim + inherited twist").
 * For every mapped cskel27 joint we know a rest bone vector (from the canonical
 * cskel27 skeleton) and the observed direction to the same descendant in the
 * hml22 frame. The global rotation is then
 *
 *     G_j = swing( G_parent · restDir_j  →  obsDir_j ) · G_parent
 *
 * i.e. start from the parent's orientation, then apply the MINIMAL rotation that
 * puts the bone on the observed direction. Twist is INHERITED from the parent
 * rather than invented, which is the physically right default (the forearm's
 * roll follows the upper arm unless something says otherwise) and — the reason
 * it is the right ENGINEERING default too — it is a continuous function of the
 * parent, so a smooth input clip produces a smooth output clip. Two joints get
 * better than that: Hips and Spine3 each see TWO independent directions (the hip
 * axis, the shoulder axis), so their full orientation including twist is
 * recovered exactly by orthonormalising a two-vector frame. Those two carry the
 * whole body's heading, which is why they are the ones worth pinning.
 *
 * TEMPORAL CONTINUITY IS PART OF THE CONTRACT, not a nicety. A twist flip
 * between two frames reads as a limb snapping through 180° and would survive
 * every positional gate, because positions are invariant to it. The lift is
 * continuous everywhere except at two measure-zero branch points — an
 * antiparallel swing (bone reversed exactly through its parent's rest aim) and a
 * two-vector frame whose secondary collapses onto its primary. At both, this
 * converter resolves the branch by continuing the PREVIOUS FRAME (`carry`),
 * never by an arbitrary seed. See liftHml22PoseGlobals.
 *
 * WHAT THIS CANNOT RECOVER, by construction, from positions alone:
 *   - axial TWIST of any single-child bone (forearm pronation, humerus roll,
 *     shin roll, the head's roll about the neck axis). A joint chain's positions
 *     are invariant to twist of the parent bone about its own axis. Measured on
 *     real takes this is 26–55° on the arms. Positions are sub-millimetre;
 *     rotations are approximate. Plan GP4 carve-out: measure and report, do not
 *     gate on it in v1.
 *   - the 5 cskel27 joints hml22 has no source for (Spine2, L/R HandEnd,
 *     L/R HandThumb1) — filled with identity locals, 4.7–6.1 cm positional
 *     error, accepted losses per GP4. None of them is a line-edit target that
 *     hml22 can author.
 * Neither loss moves a MAPPED joint's position, which is what a line edit is
 * scored on.
 *
 * PITFALL THIS FILE EXISTS TO DOCUMENT (the hml22 analogue of the soma77 leg
 * shift): hml22 uses SMPL naming, where `left_collar` is the CLAVICLE and
 * `left_shoulder` is the UPPER-ARM root. cskel27 calls those `LeftShoulder` and
 * `LeftArm`. Mapping by matching name text would put the shoulder's rotation on
 * the clavicle and shear the whole arm. Likewise hml22's `left_foot` (joint 10)
 * is the TOE BASE — the ankle is `left_ankle` (7).
 *
 * FPS: the output keeps the source rate (20 fps, ACMDM's own). Retiming onto the
 * 24 fps app timeline happens DOWNSTREAM, exactly as it does for Kimodo takes —
 * this file must not retime, or the retimer would run twice.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, matMul, matTranspose } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";

/**
 * The HumanML3D / t2m 22-joint skeleton, in npz index order.
 *
 * SOURCE OF TRUTH, two independent confirmations (S2, 2026-08-29):
 *  1. github.com/EricGuo5513/HumanML3D `paramUtil.py` → `t2m_kinematic_chain`
 *     = [[0,2,5,8,11], [0,1,4,7,10], [0,3,6,9,12,15], [9,14,17,19,21],
 *        [9,13,16,18,20]]. That fixes the TOPOLOGY and the left/right ordering
 *     exactly: index 1 is the LEFT hip (it heads the chain that also contains
 *     4,7,10) and index 2 the right.
 *  2. The names are SMPL's, because HumanML3D's 22 joints are SMPL body joints
 *     0..21 verbatim: github.com/vchoutas/smplx `smplx/joint_names.py`.
 * The two agree on every entry: joint 9 (`spine3`) is the parent of 12/13/14,
 * which is precisely the "carries the neck and both clavicles" role.
 */
export const HML22_JOINTS = [
	"pelvis",         //  0
	"left_hip",       //  1
	"right_hip",      //  2
	"spine1",         //  3
	"left_knee",      //  4
	"right_knee",     //  5
	"spine2",         //  6
	"left_ankle",     //  7
	"right_ankle",    //  8
	"spine3",         //  9
	"left_foot",      // 10  ← TOE BASE, not the ankle
	"right_foot",     // 11  ← TOE BASE, not the ankle
	"neck",           // 12
	"left_collar",    // 13  ← CLAVICLE   (cskel27 "LeftShoulder")
	"right_collar",   // 14
	"head",           // 15
	"left_shoulder",  // 16  ← UPPER ARM  (cskel27 "LeftArm")
	"right_shoulder", // 17
	"left_elbow",     // 18
	"right_elbow",    // 19
	"left_wrist",     // 20
	"right_wrist",    // 21
];

/** Parent index per hml22 joint, expanded from t2m_kinematic_chain. */
export const HML22_PARENTS = [
	null, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19,
];

/**
 * cskel27 joint name → the hml22 joint that drives it, or null for "this joint
 * is not authored by the source".
 *
 * TORSO ANCHORING is structural, not cosmetic, exactly as in the soma77 case.
 * Hips↔pelvis is the root in both. cskel27's Spine3 carries the neck AND both
 * clavicles; hml22's `spine3` (9) carries `neck` (12) and both collars (13,14).
 * So Spine3↔spine3 is FORCED. That leaves three cskel27 links (Spine, Spine1,
 * Spine2) spanning the two hml22 links (spine1, spine2) between the anchors, so
 * exactly one cskel27 spine joint must go unauthored. Spine2 is the one chosen,
 * for the same reason soma77-to-cskel27 chose it: mapping bottom-up keeps the
 * lower spine — where the large trunk rotation lives — driven by real data and
 * pushes the identity link to the top of the chain, where the residual
 * Spine2→Spine3 rotation is absorbed into Spine3's local anyway.
 *
 * The hand ends and thumbs stay unauthored: hml22 stops at the wrist. Borrowing
 * anything would invent finger articulation the model never generated.
 */
export const CSKEL27_FROM_HML22 = {
	Hips: "pelvis",
	Spine: "spine1",
	Spine1: "spine2",
	Spine2: null,
	Spine3: "spine3",
	Neck: "neck",
	Head: "head",

	RightShoulder: "right_collar",
	RightArm: "right_shoulder",
	RightForeArm: "right_elbow",
	RightHand: "right_wrist",
	RightHandEnd: null,
	RightHandThumb1: null,

	LeftShoulder: "left_collar",
	LeftArm: "left_shoulder",
	LeftForeArm: "left_elbow",
	LeftHand: "left_wrist",
	LeftHandEnd: null,
	LeftHandThumb1: null,

	RightUpLeg: "right_hip",
	RightLeg: "right_knee",
	RightFoot: "right_ankle",
	RightToeBase: "right_foot",

	LeftUpLeg: "left_hip",
	LeftLeg: "left_knee",
	LeftFoot: "left_ankle",
	LeftToeBase: "left_foot",
};

/**
 * Per mapped cskel27 joint, the DESCENDANT whose bone direction determines this
 * joint's global rotation, plus (where a second independent direction exists)
 * the pair whose difference pins the twist.
 *
 * `aim` names a cskel27 joint, but the direction is measured between the two
 * joints' HML22 SOURCES — which is why Spine1 aims at Spine3 and not Spine2:
 * Spine2 is unauthored, so in the reconstructed skeleton G_Spine2 === G_Spine1
 * and the EFFECTIVE bone leaving Spine1 is Spine1→Spine3.
 *
 * A null entry is a joint whose own orientation positions cannot observe (no
 * mapped child below it): Head, both Hands, both ToeBases. They inherit their
 * parent's global, so their local is identity — and their POSITION is still
 * exact, because it is produced by the parent's aim.
 */
const AIM = {
	Hips: { aim: "Spine", twistRef: ["LeftUpLeg", "RightUpLeg"] },
	Spine: { aim: "Spine1" },
	Spine1: { aim: "Spine3" },
	Spine2: null,
	Spine3: { aim: "Neck", twistRef: ["LeftShoulder", "RightShoulder"] },
	Neck: { aim: "Head" },
	Head: null,

	LeftShoulder: { aim: "LeftArm" },
	LeftArm: { aim: "LeftForeArm" },
	LeftForeArm: { aim: "LeftHand" },
	LeftHand: null,
	LeftHandEnd: null,
	LeftHandThumb1: null,

	RightShoulder: { aim: "RightArm" },
	RightArm: { aim: "RightForeArm" },
	RightForeArm: { aim: "RightHand" },
	RightHand: null,
	RightHandEnd: null,
	RightHandThumb1: null,

	LeftUpLeg: { aim: "LeftLeg" },
	LeftLeg: { aim: "LeftFoot" },
	LeftFoot: { aim: "LeftToeBase" },
	LeftToeBase: null,

	RightUpLeg: { aim: "RightLeg" },
	RightLeg: { aim: "RightFoot" },
	RightFoot: { aim: "RightToeBase" },
	RightToeBase: null,
};

const IDENTITY = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];

/** cskel27 joints whose Y decides where the floor is (same set as soma77). */
const GROUND_JOINTS = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"];

const CSKEL_INDEX = new Map(CSKEL27_JOINTS.map((name, index) => [name, index]));
const HML_INDEX = new Map(HML22_JOINTS.map((name, index) => [name, index]));

/** cskel27 index → hml22 index, or -1 when unauthored. */
export const CSKEL27_TO_HML22_INDEX = CSKEL27_JOINTS.map((name) => {
	const source = CSKEL27_FROM_HML22[name];
	return source === null || source === undefined ? -1 : HML_INDEX.get(source);
});

/** hml22 index → cskel27 index. Total: every hml22 joint has exactly one target. */
export const HML22_TO_CSKEL27_INDEX = HML22_JOINTS.map((name) => {
	const target = CSKEL27_JOINTS.findIndex((joint) => CSKEL27_FROM_HML22[joint] === name);
	if (target < 0) {
		throw new Error(`hml22-to-cskel27: hml22 joint ${name} has no cskel27 target`);
	}
	return target;
});

/**
 * Per cskel27 joint, the hml22 index whose orientation it takes. An unmapped
 * joint walks up the cskel27 parent chain to the nearest mapped ancestor, which
 * is what makes its local come out identity. Verbatim the soma77 rule.
 */
export function resolveSourceIndices() {
	const resolved = new Array(CSKEL27_JOINTS.length);
	for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
		let cursor = index;
		let source = CSKEL27_FROM_HML22[CSKEL27_JOINTS[cursor]];
		while (source == null) {
			cursor = CSKEL27_PARENTS[cursor];
			if (cursor === null) {
				throw new Error(
					`hml22ToCskel27Motion: ${CSKEL27_JOINTS[index]} has no mapped ancestor`
				);
			}
			source = CSKEL27_FROM_HML22[CSKEL27_JOINTS[cursor]];
		}
		resolved[index] = HML_INDEX.get(source);
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// small vector helpers (convert.js exports matrix maths but no matVec)
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function unit(a, label) {
	const length = norm(a);
	if (!(length > 1e-9)) {
		throw new Error(`hml22ToCskel27Motion: degenerate direction for ${label}`);
	}
	return [a[0] / length, a[1] / length, a[2] / length];
}

function matVec(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

/** Component of `v` perpendicular to unit vector `axis`, or null if it vanishes. */
function rejectFrom(v, axis) {
	if (!v) return null;
	const k = dot(v, axis);
	const out = [v[0] - axis[0] * k, v[1] - axis[1] * k, v[2] - axis[2] * k];
	return norm(out) > 1e-6 ? out : null;
}

/**
 * Minimal ("swing") rotation taking unit vector `from` onto unit vector `to`,
 * returned together with the axis it turned about.
 *
 * THE BRANCH POINT. When `from` and `to` are antiparallel every axis
 * perpendicular to `from` is a valid 180° rotation, and picking a fixed seed
 * (say +X) makes the choice jump the moment the bone crosses that
 * configuration — a visible 180° limb flip between two adjacent frames. `hint`
 * is the axis this same joint turned about on the PREVIOUS frame; continuing it
 * is the branch nearest the previous frame, which is exactly the continuity
 * rule this converter promises. The fixed seed survives only as the
 * first-frame fallback, where there is no previous frame to be near.
 */
function swingWithAxis(from, to, hint, label) {
	const cosine = Math.max(-1, Math.min(1, dot(from, to)));
	if (cosine > 1 - 1e-12) {
		// Already aligned: identity, and the previous axis stays the live hint so
		// a momentary alignment does not erase the branch we have been following.
		return { matrix: IDENTITY.map((row) => row.slice()), axis: hint ?? null };
	}
	let axis;
	if (cosine < -1 + 1e-9) {
		const continued = rejectFrom(hint, from);
		const seed = continued ?? (Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
		axis = continued
			? unit(continued, `${label} antiparallel continuation`)
			: unit(cross(from, seed), `${label} antiparallel swing`);
	} else {
		axis = unit(cross(from, to), `${label} swing`);
	}
	const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
	const t = 1 - cosine;
	const [x, y, z] = axis;
	return {
		matrix: [
			[t * x * x + cosine, t * x * y - sine * z, t * x * z + sine * y],
			[t * x * y + sine * z, t * y * y + cosine, t * y * z - sine * x],
			[t * x * z - sine * y, t * y * z + sine * x, t * z * z + cosine],
		],
		axis,
	};
}

/**
 * Orthonormal frame (as a rotation matrix, columns e1/e2/e3) from two vectors.
 * `hint` is the previous frame's e2 for this joint: it only comes into play when
 * the secondary collapses onto the primary (a body folded so the hip axis lies
 * along the spine), which is the other branch point, resolved the same way.
 */
function frameOf(primary, secondary, label, hint) {
	const e1 = unit(primary, `${label} primary`);
	let projected = rejectFrom(secondary, e1);
	if (!projected) projected = rejectFrom(hint, e1);
	if (!projected) {
		throw new Error(`hml22ToCskel27Motion: ${label} secondary is parallel to its primary`);
	}
	const e2 = unit(projected, `${label} secondary`);
	const e3 = cross(e1, e2);
	return [
		[e1[0], e2[0], e3[0]],
		[e1[1], e2[1], e3[1]],
		[e1[2], e2[2], e3[2]],
	];
}

// ---------------------------------------------------------------------------
// 27 → 22 (downsample). Positions only.
//
// This is the direction the BOX is fed: ProjFlow's preservation rows are the
// source take's own frames expressed in hml22 space, so the driver needs the
// inverse of this file. It is also what the verify harness uses to manufacture
// an hml22 fixture out of a real cclay take without a HumanML3D download.
// Pure index gather — lossless by construction, since every hml22 joint has a
// cskel27 counterpart.
// ---------------------------------------------------------------------------

/**
 * @param {{frames?:number, posedJoints:ArrayLike<number>}} input  cskel27 [T,27,3]
 * @returns {Float32Array} hml22 positions, [T,22,3]
 */
export function cskel27ToHml22Positions({ frames, posedJoints }) {
	if (!(ArrayBuffer.isView(posedJoints) || Array.isArray(posedJoints))) {
		throw new Error("cskel27ToHml22Positions: posedJoints must be an array of numbers");
	}
	const count = frames ?? posedJoints.length / (27 * 3);
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(
			`cskel27ToHml22Positions: posedJoints length ${posedJoints.length} is not a whole number of 27-joint frames`
		);
	}
	if (posedJoints.length !== count * 27 * 3) {
		throw new Error(
			`cskel27ToHml22Positions: posedJoints must be ${count * 27 * 3} long, got ${posedJoints.length}`
		);
	}
	const out = new Float32Array(count * 22 * 3);
	for (let frame = 0; frame < count; frame += 1) {
		const src = frame * 27 * 3;
		const dst = frame * 22 * 3;
		for (let joint = 0; joint < 22; joint += 1) {
			const source = HML22_TO_CSKEL27_INDEX[joint];
			out[dst + joint * 3] = posedJoints[src + source * 3];
			out[dst + joint * 3 + 1] = posedJoints[src + source * 3 + 1];
			out[dst + joint * 3 + 2] = posedJoints[src + source * 3 + 2];
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 22 → 27, pose level. These are the building blocks the motion loop composes;
// they are exported so a test can pin one frame's behaviour (and one frame's
// continuity carry) without going through the whole clip.
// ---------------------------------------------------------------------------

/**
 * The canonical cskel27 rest body re-expressed at hml22 indices — the rest
 * directions every aim is measured against.
 * @param {{posed_joints:number[][]}} reference
 * @returns {number[][]} 22 rest positions
 */
export function restPositionsHml22(reference) {
	const rest = new Array(22);
	for (let joint = 0; joint < 22; joint += 1) {
		rest[joint] = reference.posed_joints[HML22_TO_CSKEL27_INDEX[joint]].slice();
	}
	return rest;
}

/**
 * One frame of hml22 positions → 27 GLOBAL rotation matrices.
 *
 * @param {number[][]} observed  22 world positions for this frame
 * @param {object} options
 * @param {number[][]} options.rest              22 rest positions (restPositionsHml22)
 * @param {{swingAxis:Array, frameSecondary:Array}} [options.carry]
 *        the previous frame's branch state; pass the returned `carry` straight
 *        back in on the next frame to keep the clip continuous.
 * @param {number} [options.frame]  frame index, for error messages only
 * @returns {{globals:number[][][], carry:{swingAxis:Array, frameSecondary:Array}}}
 */
export function liftHml22PoseGlobals(observed, { rest, carry = null, frame = 0 } = {}) {
	if (!Array.isArray(observed) || observed.length !== 22) {
		throw new Error("liftHml22PoseGlobals: observed must be 22 [x,y,z] positions");
	}
	if (!Array.isArray(rest) || rest.length !== 22) {
		throw new Error("liftHml22PoseGlobals: rest must be 22 [x,y,z] positions");
	}
	const globals = new Array(27);
	const swingAxis = new Array(27).fill(null);
	const frameSecondary = new Array(27).fill(null);

	// cskel27 indices are topologically ordered (parent < child) — asserted in
	// the verify file — so one ascending pass suffices.
	for (let joint = 0; joint < 27; joint += 1) {
		const name = CSKEL27_JOINTS[joint];
		const parent = CSKEL27_PARENTS[joint];
		const spec = AIM[name];
		const parentGlobal = parent === null ? IDENTITY : globals[parent];

		if (!spec) {
			// Unauthored joint, or a mapped joint with no mapped child: borrow the
			// nearest mapped ancestor's global ⇒ identity local.
			globals[joint] = parentGlobal.map((row) => row.slice());
			continue;
		}

		const label = `${name} (frame ${frame})`;
		const self = CSKEL27_TO_HML22_INDEX[joint];
		const aim = CSKEL27_TO_HML22_INDEX[CSKEL_INDEX.get(spec.aim)];
		const restDir = unit(sub(rest[aim], rest[self]), `${label} rest bone`);
		const observedDir = unit(sub(observed[aim], observed[self]), `${label} observed bone`);

		if (spec.twistRef) {
			// Two independent directions ⇒ the full orientation, twist and all.
			const [first, second] = spec.twistRef;
			const a = CSKEL27_TO_HML22_INDEX[CSKEL_INDEX.get(first)];
			const b = CSKEL27_TO_HML22_INDEX[CSKEL_INDEX.get(second)];
			const restFrame = frameOf(restDir, sub(rest[a], rest[b]), `${label} rest frame`);
			const observedFrame = frameOf(
				observedDir,
				sub(observed[a], observed[b]),
				`${label} observed frame`,
				carry?.frameSecondary?.[joint]
			);
			frameSecondary[joint] = [observedFrame[0][1], observedFrame[1][1], observedFrame[2][1]];
			globals[joint] = matMul(observedFrame, matTranspose(restFrame));
		} else {
			// Aim + inherited twist.
			const aimed = unit(matVec(parentGlobal, restDir), `${label} aimed rest bone`);
			const swung = swingWithAxis(aimed, observedDir, carry?.swingAxis?.[joint], label);
			swingAxis[joint] = swung.axis;
			globals[joint] = matMul(swung.matrix, parentGlobal);
		}
	}
	return { globals, carry: { swingAxis, frameSecondary } };
}

/**
 * 27 global rotations → 27 LOCAL rotations. The soma77 rule, unchanged: whatever
 * sits between two mapped joints composes into the child's local, and an
 * unauthored joint (which borrowed its parent's global) comes out identity.
 * @param {number[][][]} globals
 * @returns {number[][][]}
 */
export function globalsToCskel27Locals(globals) {
	const locals = new Array(27);
	for (let joint = 0; joint < 27; joint += 1) {
		const parent = CSKEL27_PARENTS[joint];
		locals[joint] =
			parent === null
				? globals[joint].map((row) => row.slice())
				: matMul(matTranspose(globals[parent]), globals[joint]);
	}
	return locals;
}

/**
 * Full single-frame convert: hml22 positions → cskel27 rotations + posed joints.
 * The motion path calls exactly this per frame; a test can call it on one pose.
 *
 * @param {number[][]} observed  22 world positions
 * @param {object} options
 * @param {number[][]} options.rest
 * @param {number[][]} options.boneOffsets  canonical cskel27 bone offsets
 * @param {number} [options.rootScale=1]
 * @param {object} [options.carry]
 * @param {number} [options.frame]
 * @returns {{globals, locals, root:number[], posed:number[][], carry:object}}
 */
export function hml22PoseToCskel27(observed, { rest, boneOffsets, rootScale = 1, carry = null, frame = 0 }) {
	const lifted = liftHml22PoseGlobals(observed, { rest, carry, frame });
	const locals = globalsToCskel27Locals(lifted.globals);
	const pelvis = observed[HML_INDEX.get("pelvis")];
	const root = [pelvis[0] * rootScale, pelvis[1] * rootScale, pelvis[2] * rootScale];
	// FK on OUR body, never the source's bone lengths: the take has to move
	// CozyClay's figure, not drag HumanML3D's average proportions into the scene.
	const posed = forwardKinematics(locals, boneOffsets, root);
	return { globals: lifted.globals, locals, root, posed, carry: lifted.carry };
}

// ---------------------------------------------------------------------------
// 22 → 27, motion level. THE C8 ENTRY POINT.
// ---------------------------------------------------------------------------

function chainLengthHml(positions, names) {
	let total = 0;
	for (let step = 1; step < names.length; step += 1) {
		total += norm(sub(positions[HML_INDEX.get(names[step])], positions[HML_INDEX.get(names[step - 1])]));
	}
	return total;
}

function chainLengthCskel(positions, names) {
	let total = 0;
	for (let step = 1; step < names.length; step += 1) {
		total += norm(sub(positions[CSKEL_INDEX.get(names[step])], positions[CSKEL_INDEX.get(names[step - 1])]));
	}
	return total;
}

/**
 * ProjFlow motion → the cclay motion arrays.
 *
 * @param {object} raw
 * @param {Float32Array|number[]} raw.positions  hml22 joint positions, [T,22,3]
 *        flattened, world metres, Y-up. ACMDM's own output tensor.
 * @param {number} [raw.fps=20]      source rate. NOT retimed here (see header).
 * @param {number} [raw.frames]      optional; derived from `positions` when absent,
 *                                   cross-checked against it when present.
 * @param {object} [raw.reference]   {local_rot_mats, posed_joints} cskel27 rest
 *                                   (default: canonicalCskel27Reference())
 * @param {boolean} [raw.scaleRoot=true]  scale the root trajectory by the
 *        leg-length ratio so stride survives reproportioning (soma77's rule)
 * @param {boolean} [raw.ground=true]     one rigid floor shift for the clip
 *        (soma77's rule; see the note at the bottom of this function)
 * @returns {{frames:number, fps:number, rotMats:Float32Array, rootPos:Float32Array, posedJoints:Float32Array}}
 *        rotMats are LOCAL rotations, [T,27,3,3] flattened row-major — the exact
 *        five fields soma77ToCskel27Motion returns, nothing more.
 */
export function hml22ToCskel27Motion(raw) {
	if (!raw || typeof raw !== "object") {
		throw new Error("hml22ToCskel27Motion: expected an object { positions, fps }");
	}
	const {
		positions,
		fps = 20,
		frames: declaredFrames,
		reference = canonicalCskel27Reference(),
		scaleRoot = true,
		ground = true,
	} = raw;

	// `ArrayBuffer.isView || Array.isArray` and not a duck-typed `.length` check:
	// a string has a length too, and would sail past the shape check to die
	// later as a NaN with a misleading joint name.
	if (!(ArrayBuffer.isView(positions) || Array.isArray(positions))) {
		throw new Error(
			"hml22ToCskel27Motion: positions must be a Float32Array or number[] of [T,22,3] world metres"
		);
	}
	if (positions.length === 0 || positions.length % (22 * 3) !== 0) {
		throw new Error(
			`hml22ToCskel27Motion: positions length ${positions.length} is not a whole number of 22-joint frames (multiple of 66)`
		);
	}
	const frames = positions.length / (22 * 3);
	if (declaredFrames !== undefined && declaredFrames !== frames) {
		throw new Error(
			`hml22ToCskel27Motion: frames says ${declaredFrames} but positions holds ${frames} frames`
		);
	}
	if (!Number.isInteger(fps) || fps < 1) {
		throw new Error(`hml22ToCskel27Motion: fps must be a positive integer, got ${fps}`);
	}
	// Scan once up front rather than letting a NaN propagate into a rotation
	// matrix, where it would surface a thousand lines downstream as an empty
	// viewport instead of as "frame 61 left_wrist z is NaN".
	for (let index = 0; index < positions.length; index += 1) {
		if (!Number.isFinite(positions[index])) {
			const frame = Math.floor(index / (22 * 3));
			const joint = Math.floor((index % (22 * 3)) / 3);
			throw new Error(
				`hml22ToCskel27Motion: positions[${index}] is ${positions[index]} ` +
					`(frame ${frame}, joint ${joint} ${HML22_JOINTS[joint]}, axis ${"xyz"[index % 3]})`
			);
		}
	}

	const boneOffsets = deriveBoneOffsets(reference.posed_joints, reference.local_rot_mats);
	const rest = restPositionsHml22(reference);

	// Leg-length ratio, measured on the source's own first frame against the
	// reference body, so a stride generated for HumanML3D's average body covers
	// the same fraction of a step on ours. Same rule as soma77ToCskel27Motion.
	const firstFrame = [];
	for (let joint = 0; joint < 22; joint += 1) {
		firstFrame.push([positions[joint * 3], positions[joint * 3 + 1], positions[joint * 3 + 2]]);
	}
	const sourceLeg = chainLengthHml(firstFrame, ["left_hip", "left_knee", "left_ankle"]);
	const referenceLeg = chainLengthCskel(reference.posed_joints, ["LeftUpLeg", "LeftLeg", "LeftFoot"]);
	if (!(sourceLeg > 0)) {
		throw new Error("hml22ToCskel27Motion: source leg length measured as zero");
	}
	const rootScale = scaleRoot ? referenceLeg / sourceLeg : 1;

	const rotMats = new Float32Array(frames * 27 * 9);
	const rootPos = new Float32Array(frames * 3);
	const outPosed = new Float32Array(frames * 27 * 3);
	let floorY = Infinity;
	let carry = null;

	for (let frame = 0; frame < frames; frame += 1) {
		const base = frame * 22 * 3;
		const observed = new Array(22);
		for (let joint = 0; joint < 22; joint += 1) {
			observed[joint] = [
				positions[base + joint * 3],
				positions[base + joint * 3 + 1],
				positions[base + joint * 3 + 2],
			];
		}

		// `carry` threads the previous frame's branch choices in and this frame's
		// out — the whole of the temporal-continuity guarantee lives on this line.
		const pose = hml22PoseToCskel27(observed, { rest, boneOffsets, rootScale, carry, frame });
		carry = pose.carry;

		for (const name of GROUND_JOINTS) {
			const y = pose.posed[CSKEL_INDEX.get(name)][1];
			if (y < floorY) floorY = y;
		}

		const rotBase = frame * 27 * 9;
		for (let joint = 0; joint < 27; joint += 1) {
			const m = pose.locals[joint];
			for (let row = 0; row < 3; row += 1) {
				for (let col = 0; col < 3; col += 1) {
					rotMats[rotBase + joint * 9 + row * 3 + col] = m[row][col];
				}
			}
		}
		rootPos[frame * 3] = pose.root[0];
		rootPos[frame * 3 + 1] = pose.root[1];
		rootPos[frame * 3 + 2] = pose.root[2];
		const posBase = frame * 27 * 3;
		for (let joint = 0; joint < 27; joint += 1) {
			outPosed[posBase + joint * 3] = pose.posed[joint][0];
			outPosed[posBase + joint * 3 + 1] = pose.posed[joint][1];
			outPosed[posBase + joint * 3 + 2] = pose.posed[joint][2];
		}
	}

	// ONE RIGID FLOOR SHIFT for the whole clip, so the lowest foot sample of the
	// clip touches Y=0. This is soma77ToCskel27Motion's convention copied
	// deliberately and it is a SPLICING requirement, not a cosmetic one: a
	// ProjFlow line edit gets spliced back into a Kimodo/ARDY take, and if the two
	// converters grounded differently the figure would step up or down at the
	// seam. Per-frame grounding is the wrong answer for the same reason it is
	// there: it would flatten the arc of a jump, which is exactly the motion this
	// pipeline exists to stage.
	if (ground && Number.isFinite(floorY) && floorY !== 0) {
		for (let frame = 0; frame < frames; frame += 1) {
			rootPos[frame * 3 + 1] -= floorY;
			const posBase = frame * 27 * 3;
			for (let joint = 0; joint < 27; joint += 1) outPosed[posBase + joint * 3 + 1] -= floorY;
		}
	}

	return { frames, fps, rotMats, rootPos, posedJoints: outPosed };
}

export { IDENTITY as CSKEL27_IDENTITY };
