/**
 * cskel27 joint order and parent hierarchy, transcribed verbatim from the
 * ARDY reference implementation:
 *   - CSKEL27_JOINTS mirrors `motion_retarget.CSKEL27_JOINTS`
 *     (/Users/yun/CozyClay/blender-addon/cclay/motion_retarget.py)
 *   - CSKEL27_PARENTS mirrors `motion_constraints._PARENT_BY_NAME` /
 *     `CSKEL27_PARENTS` (/Users/yun/CozyClay/blender-addon/cclay/motion_constraints.py)
 *
 * Index in CSKEL27_JOINTS == joint index in the npz arrays
 * (local_rot_mats[:, i], posed_joints[:, i]). motion_retarget deliberately
 * carries no hierarchy (it is rotation-only); the parent table was verified
 * numerically in the Python repo (deriving offsets from one frame and running
 * FK across every other frame reproduces the npz's own posed_joints to
 * ~2.8e-07, float32 serialization noise) — a wrong parent moves that error to
 * whole npz units immediately, so this table must stay exact.
 */

/** The 27 ARDY core-skeleton joints in index order. */
export const CSKEL27_JOINTS = [
	"Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
	"RightShoulder", "RightArm", "RightForeArm", "RightHand",
	"RightHandEnd", "RightHandThumb1",
	"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
	"LeftHandEnd", "LeftHandThumb1",
	"RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
	"LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
];

const JOINT_INDEX = Object.fromEntries(
	CSKEL27_JOINTS.map((name, index) => [name, index])
);

// Parent per joint by name, transcribed verbatim from
// motion_constraints._PARENT_BY_NAME. The root (Hips) has no parent.
const PARENT_BY_NAME = {
	"Hips": null,
	"Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Spine3": "Spine2",
	"Neck": "Spine3", "Head": "Neck",
	"RightShoulder": "Spine3", "RightArm": "RightShoulder",
	"RightForeArm": "RightArm", "RightHand": "RightForeArm",
	"RightHandEnd": "RightHand", "RightHandThumb1": "RightHand",
	"LeftShoulder": "Spine3", "LeftArm": "LeftShoulder",
	"LeftForeArm": "LeftArm", "LeftHand": "LeftForeArm",
	"LeftHandEnd": "LeftHand", "LeftHandThumb1": "LeftHand",
	"RightUpLeg": "Hips", "RightLeg": "RightUpLeg",
	"RightFoot": "RightLeg", "RightToeBase": "RightFoot",
	"LeftUpLeg": "Hips", "LeftLeg": "LeftUpLeg",
	"LeftFoot": "LeftLeg", "LeftToeBase": "LeftFoot",
};

/** Parent joint index per cskel27 index; the root (Hips) is null. */
export const CSKEL27_PARENTS = CSKEL27_JOINTS.map(
	(name) => (PARENT_BY_NAME[name] === null ? null : JOINT_INDEX[PARENT_BY_NAME[name]])
);

/** The joints CozyClay edits (src/poses.js POSE_BONES), as cskel27 names.
 * POSE_BONES' Mixamo Spine2 has no entry here: cskel27's "Spine2" is already
 * fed by Mixamo Spine1 (COZYCLAY_TO_CSKEL27), so wiring it would need a
 * Spine3 mapping — until then its rotation stays editor-side and does not
 * reach the ARDY wire pose. */
export const COZYCLAY_BONES = [
	"Hips", "Spine", "Spine1", "Neck", "Head",
	"LeftShoulder", "RightShoulder", "LeftArm", "RightArm",
	"LeftForeArm", "RightForeArm", "LeftHand", "RightHand",
	"LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg",
	"LeftFoot", "RightFoot",
];

/** CozyClay/Mixamo bone name -> playback-equivalent cskel27 joint index.
 * Core has one more torso segment, so its first animated spine joint is
 * Spine1 and the Mixamo chest lands on Spine2. */
export const COZYCLAY_TO_CSKEL27 = Object.fromEntries(
	COZYCLAY_BONES.map((name) => [
		name,
		JOINT_INDEX[name === "Spine" ? "Spine1" : name === "Spine1" ? "Spine2" : name],
	])
);
