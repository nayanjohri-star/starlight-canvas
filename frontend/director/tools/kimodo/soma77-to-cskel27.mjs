/**
 * soma77-to-cskel27.mjs — Kimodo's somaskel77 motion npz → the exact motion
 * arrays the cclay npz encoder consumes ({ frames, fps, rotMats, rootPos,
 * posedJoints }), i.e. the same shape tools/ardy/bvh-cskel27.mjs produces.
 *
 * WHY GLOBAL ROTATIONS. cskel27 and somaskel77 do not share a spine
 * segmentation: cskel27 runs Hips→Spine→Spine1→Spine2→Spine3 (four segments
 * before the shoulder carrier) where somaskel77 runs Hips→Spine1→Spine2→Chest
 * (three), and somaskel77 splits the neck in two (Neck1→Neck2) where cskel27
 * has one. Re-deriving each cskel27 LOCAL from a per-joint global — exactly
 * the rule tools/ardy/bvh-cskel27.mjs states for the Mixamo case — makes that
 * mismatch a non-issue in both directions:
 *
 *   - a source segment cskel27 lacks (Neck2) is absorbed into the child's
 *     local, because local = parentGlobalᵀ · global composes whatever sits
 *     between the two mapped joints. No rotation is lost.
 *   - a cskel27 joint the source lacks (Spine2, the Hand ends) borrows its
 *     nearest mapped ancestor's global, so its local comes out identity —
 *     the same "not authored" rule poseToCskel27 and bvhToCskel27Motion use.
 *
 * Both skeletons rest in the same convention (Y-up, metres, standard T-pose:
 * Kimodo writes its NPZ against the canonical SOMA T-pose, and CSKEL27_NEUTRAL
 * is the cskel27 T-pose), so a somaskel77 global IS the cskel27 global for the
 * matching joint and no basis change is needed.
 *
 * POSITIONS ARE RE-GROWN, never copied: the take has to move CozyClay's body,
 * not drag Kimodo's per-model bone lengths into the scene. FK runs over the
 * canonical cskel27 skeleton and the root trajectory is scaled by the
 * leg-length ratio so stride length survives the reproportioning, then
 * floor-shifted so the clip's lowest foot sample touches Y=0.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, matMul, matTranspose } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";

/**
 * somaskel77 joint order, transcribed from the upstream skeleton definition
 * (`SOMASkeleton77.bone_order_names_with_parents` in ardy/skeleton/definitions.py,
 * identical in the Kimodo tree). Index here == joint index in the Kimodo npz
 * arrays. The standard-T-pose BVH in the Kimodo assets carries an extra `Root`
 * node ABOVE Hips that is a BVH-file artifact only — it is not part of the
 * joint arrays, so this list starts at Hips and is 77 long.
 */
export const SOMA77_JOINTS = [
	"Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "HeadEnd",
	"Jaw", "LeftEye", "RightEye",
	"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
	"LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3", "LeftHandThumbEnd",
	"LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3", "LeftHandIndex4", "LeftHandIndexEnd",
	"LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3", "LeftHandMiddle4", "LeftHandMiddleEnd",
	"LeftHandRing1", "LeftHandRing2", "LeftHandRing3", "LeftHandRing4", "LeftHandRingEnd",
	"LeftHandPinky1", "LeftHandPinky2", "LeftHandPinky3", "LeftHandPinky4", "LeftHandPinkyEnd",
	"RightShoulder", "RightArm", "RightForeArm", "RightHand",
	"RightHandThumb1", "RightHandThumb2", "RightHandThumb3", "RightHandThumbEnd",
	"RightHandIndex1", "RightHandIndex2", "RightHandIndex3", "RightHandIndex4", "RightHandIndexEnd",
	"RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3", "RightHandMiddle4", "RightHandMiddleEnd",
	"RightHandRing1", "RightHandRing2", "RightHandRing3", "RightHandRing4", "RightHandRingEnd",
	"RightHandPinky1", "RightHandPinky2", "RightHandPinky3", "RightHandPinky4", "RightHandPinkyEnd",
	"LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "LeftToeEnd",
	"RightLeg", "RightShin", "RightFoot", "RightToeBase", "RightToeEnd",
];

/**
 * cskel27 joint name → the somaskel77 joint whose GLOBAL rotation drives it,
 * or null for "this joint is not authored by the source".
 *
 * The two anchors that fix the torso alignment are structural, not cosmetic:
 * Hips is the root in both, and cskel27's Spine3 carries the shoulders and the
 * neck exactly as somaskel77's Chest does — so Spine3↔Chest is forced. That
 * leaves three cskel27 links (Spine, Spine1, Spine2) spanning the two
 * somaskel77 links (Spine1, Spine2) between those anchors, so exactly one
 * cskel27 spine joint must go unauthored. Spine2 is the one chosen: mapping
 * from the bottom up keeps the lower spine — where the large trunk rotation
 * lives — driven by real data, and pushes the identity link to the top of the
 * chain where the residual Spine2→Chest rotation is absorbed into Spine3's
 * local anyway.
 *
 * NOTE ON THE LEGS: the names shift by one between the two skeletons.
 * somaskel77's LeftLeg is the THIGH (cskel27's LeftUpLeg) and its LeftShin is
 * the shank (cskel27's LeftLeg). Mapping these by identical name would silently
 * put the knee rotation on the hip.
 *
 * The hand ends stay unauthored, matching bvhToCskel27Motion: somaskel77's
 * nearest equivalents are finger roots, and borrowing one would splay the hand.
 */
export const CSKEL27_FROM_SOMA77 = {
	Hips: "Hips",
	Spine: "Spine1",
	Spine1: "Spine2",
	Spine2: null,
	Spine3: "Chest",
	Neck: "Neck1",
	Head: "Head",

	RightShoulder: "RightShoulder",
	RightArm: "RightArm",
	RightForeArm: "RightForeArm",
	RightHand: "RightHand",
	RightHandEnd: null,
	RightHandThumb1: "RightHandThumb1",

	LeftShoulder: "LeftShoulder",
	LeftArm: "LeftArm",
	LeftForeArm: "LeftForeArm",
	LeftHand: "LeftHand",
	LeftHandEnd: null,
	LeftHandThumb1: "LeftHandThumb1",

	RightUpLeg: "RightLeg",
	RightLeg: "RightShin",
	RightFoot: "RightFoot",
	RightToeBase: "RightToeBase",

	LeftUpLeg: "LeftLeg",
	LeftLeg: "LeftShin",
	LeftFoot: "LeftFoot",
	LeftToeBase: "LeftToeBase",
};

const IDENTITY = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];

/** cskel27 joints whose Y decides where the floor is. */
const GROUND_JOINTS = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"];

/**
 * Per cskel27 joint, the somaskel77 index whose global rotation it takes.
 * An unmapped joint walks up the cskel27 parent chain to the nearest mapped
 * ancestor, which is what makes its local come out identity.
 */
export function resolveSourceIndices(jointNames = SOMA77_JOINTS) {
	const sourceIndex = new Map(jointNames.map((name, index) => [name, index]));
	const missing = Object.values(CSKEL27_FROM_SOMA77).filter(
		(name) => name !== null && !sourceIndex.has(name)
	);
	if (missing.length) {
		throw new Error(`soma77ToCskel27Motion: source skeleton is missing ${missing.join(", ")}`);
	}
	const resolved = new Array(CSKEL27_JOINTS.length);
	for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
		let cursor = index;
		let source = CSKEL27_FROM_SOMA77[CSKEL27_JOINTS[cursor]];
		while (source == null) {
			cursor = CSKEL27_PARENTS[cursor];
			if (cursor === null) {
				throw new Error(
					`soma77ToCskel27Motion: ${CSKEL27_JOINTS[index]} has no mapped ancestor`
				);
			}
			source = CSKEL27_FROM_SOMA77[CSKEL27_JOINTS[cursor]];
		}
		resolved[index] = sourceIndex.get(source);
	}
	return resolved;
}

function readMat(flat, base) {
	return [
		[flat[base], flat[base + 1], flat[base + 2]],
		[flat[base + 3], flat[base + 4], flat[base + 5]],
		[flat[base + 6], flat[base + 7], flat[base + 8]],
	];
}

function chainLength(positions, indexByName, names) {
	let total = 0;
	for (let step = 1; step < names.length; step += 1) {
		const a = positions[indexByName.get(names[step - 1])];
		const b = positions[indexByName.get(names[step])];
		total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
	}
	return total;
}

/**
 * @param {object} input
 * @param {number} input.frames
 * @param {number} input.fps
 * @param {Float32Array} input.globalRotMats  Kimodo `global_rot_mats`, frames*J*9
 * @param {Float32Array} input.posedJoints    Kimodo `posed_joints`, frames*J*3
 * @param {string[]} [input.jointNames]       source joint order (default somaskel77)
 * @returns {{frames:number, fps:number, rotMats:Float32Array, rootPos:Float32Array, posedJoints:Float32Array}}
 */
export function soma77ToCskel27Motion({ frames, fps, globalRotMats, posedJoints, jointNames = SOMA77_JOINTS }) {
	if (!Number.isInteger(frames) || frames < 1) {
		throw new Error("soma77ToCskel27Motion: frames must be a positive integer");
	}
	if (!Number.isInteger(fps) || fps < 1) {
		throw new Error("soma77ToCskel27Motion: fps must be a positive integer");
	}
	const jointCount = jointNames.length;
	if (globalRotMats.length !== frames * jointCount * 9) {
		throw new Error(
			`soma77ToCskel27Motion: globalRotMats must be ${frames * jointCount * 9} long, got ${globalRotMats.length}`
		);
	}
	if (posedJoints.length !== frames * jointCount * 3) {
		throw new Error(
			`soma77ToCskel27Motion: posedJoints must be ${frames * jointCount * 3} long, got ${posedJoints.length}`
		);
	}

	const sources = resolveSourceIndices(jointNames);
	const indexByName = new Map(jointNames.map((name, index) => [name, index]));

	// Canonical cskel27 proportions. The reference rests with identity locals,
	// so these offsets are the neutral skeleton's own bone vectors.
	const reference = canonicalCskel27Reference();
	const boneOffsets = deriveBoneOffsets(reference.posed_joints, reference.local_rot_mats);

	// Leg-length ratio, measured on the source's own first frame against the
	// canonical body, so a stride generated for Kimodo's proportions covers the
	// same fraction of a step on CozyClay's.
	const firstFrame = [];
	for (let joint = 0; joint < jointCount; joint += 1) {
		const base = joint * 3;
		firstFrame.push([posedJoints[base], posedJoints[base + 1], posedJoints[base + 2]]);
	}
	const sourceLeg = chainLength(firstFrame, indexByName, ["LeftLeg", "LeftShin", "LeftFoot"]);
	const canonicalIndex = new Map(CSKEL27_JOINTS.map((name, index) => [name, index]));
	const canonicalLeg = chainLength(reference.posed_joints, canonicalIndex, [
		"LeftUpLeg",
		"LeftLeg",
		"LeftFoot",
	]);
	if (!(sourceLeg > 0)) {
		throw new Error("soma77ToCskel27Motion: source leg length measured as zero");
	}
	const rootScale = canonicalLeg / sourceLeg;

	const rotMats = new Float32Array(frames * 27 * 9);
	const rootPos = new Float32Array(frames * 3);
	const outPosed = new Float32Array(frames * 27 * 3);

	const hipsSource = indexByName.get("Hips");
	let floorY = Infinity;

	for (let frame = 0; frame < frames; frame += 1) {
		const rotBase = frame * jointCount * 9;
		const globals = new Array(27);
		for (let joint = 0; joint < 27; joint += 1) {
			globals[joint] = readMat(globalRotMats, rotBase + sources[joint] * 9);
		}

		const locals = new Array(27);
		for (let joint = 0; joint < 27; joint += 1) {
			const parent = CSKEL27_PARENTS[joint];
			locals[joint] =
				parent === null ? globals[joint].map((row) => row.slice()) : matMul(matTranspose(globals[parent]), globals[joint]);
		}

		const posBase = frame * jointCount * 3 + hipsSource * 3;
		const root = [
			posedJoints[posBase] * rootScale,
			posedJoints[posBase + 1] * rootScale,
			posedJoints[posBase + 2] * rootScale,
		];
		const positions = forwardKinematics(locals, boneOffsets, root);

		for (const name of GROUND_JOINTS) {
			const y = positions[canonicalIndex.get(name)][1];
			if (y < floorY) floorY = y;
		}

		const outRotBase = frame * 27 * 9;
		for (let joint = 0; joint < 27; joint += 1) {
			const m = locals[joint];
			for (let row = 0; row < 3; row += 1) {
				for (let col = 0; col < 3; col += 1) {
					rotMats[outRotBase + joint * 3 * 3 + row * 3 + col] = m[row][col];
				}
			}
		}
		rootPos[frame * 3] = root[0];
		rootPos[frame * 3 + 1] = root[1];
		rootPos[frame * 3 + 2] = root[2];
		const outPosBase = frame * 27 * 3;
		for (let joint = 0; joint < 27; joint += 1) {
			outPosed[outPosBase + joint * 3] = positions[joint][0];
			outPosed[outPosBase + joint * 3 + 1] = positions[joint][1];
			outPosed[outPosBase + joint * 3 + 2] = positions[joint][2];
		}
	}

	// One rigid floor shift for the whole clip: per-frame grounding would
	// flatten the arc of a jump, which is exactly the motion this pipeline
	// exists to stage.
	if (Number.isFinite(floorY) && floorY !== 0) {
		for (let frame = 0; frame < frames; frame += 1) {
			rootPos[frame * 3 + 1] -= floorY;
			const outPosBase = frame * 27 * 3;
			for (let joint = 0; joint < 27; joint += 1) {
				outPosed[outPosBase + joint * 3 + 1] -= floorY;
			}
		}
	}

	return { frames, fps, rotMats, rootPos, posedJoints: outPosed };
}

export { IDENTITY as CSKEL27_IDENTITY };
