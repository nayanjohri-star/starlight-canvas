/**
 * CozyClayPoseV1 -> the two npz arrays cclay_constrained_generate.load_poses
 * reads (local_rot_mats 27x3x3, posed_joints 27x3; the generator then runs its
 * own FK, consulting only posed_joints[0] as the root).
 *
 * The 19 joints CozyClay authors map through each Mixamo bone's armature-space
 * rest rotation Rb (cskel27-rest.json): L = Rb @ basis @ Rb^T. ARDY has four
 * torso segments where Mixamo has three, so Mixamo Spine/Spine1 target ARDY
 * Spine1/Spine2, matching playback's map. The remaining joints get identity;
 * `filled_identity` records them and `rotation_constraint_indices` identifies
 * the rotations that are genuinely authored.
 *
 * Proportions are never hardcoded: bone offsets come from the reference frame
 * of the same base clip the pose will constrain (mirroring
 * motion_constraints.derive_bone_offsets), and the root rides on that frame's
 * own root. If ARDY ever reproportions cskel27, the clip proportions stay
 * correct by construction.
 */

import {
	COZYCLAY_BONES,
	COZYCLAY_TO_CSKEL27,
	CSKEL27_JOINTS,
} from "./cskel27.js";
import { CSKEL27_NEUTRAL } from "./cskel27-neutral.js";
import {
	basisQuaternionToLocalRotation,
	deriveBoneOffsets,
	forwardKinematics,
} from "./convert.js";

// Tolerance on |norm - 1| for pose quaternions, and on orthonormality /
// determinant for emitted matrices. Float32-serialized source data is off by
// ~1e-7 at worst, so 1e-6 is comfortably above input noise while still
// catching real corruption.
const UNIT_TOLERANCE = 1e-6;

const IDENTITY = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];

const SOURCE_BY_TARGET = new Map(
	COZYCLAY_BONES.map((source) => [
		CSKEL27_JOINTS[COZYCLAY_TO_CSKEL27[source]],
		source,
	])
);

const CANONICAL_ROOT_Y = -Math.min(...CSKEL27_NEUTRAL.map((joint) => joint[1]));

/** Floor-aligned CoreSkeleton27 reference used when no clip reference is
 * supplied. A generated motion is not a skeleton definition: borrowing its
 * frame-zero root made a rolling clip lower every authored pose by 10 cm.
 * The neutral skeleton is stable, deterministic, and keeps both toes at Y=0. */
export function canonicalCskel27Reference() {
	return {
		local_rot_mats: CSKEL27_JOINTS.map(() => IDENTITY.map((row) => row.slice())),
		posed_joints: CSKEL27_NEUTRAL.map(([x, y, z]) => [x, y + CANONICAL_ROOT_Y, z]),
	};
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function determinant3(m) {
	return (
		m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
		m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
		m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
	);
}

function requireUnitQuaternion(q, bone) {
	if (!Array.isArray(q) || q.length !== 4 || !q.every(isFiniteNumber)) {
		throw new Error(
			`poseToCskel27: bone "${bone}" is not a [w, x, y, z] quaternion of four finite numbers`
		);
	}
	const norm = Math.hypot(q[0], q[1], q[2], q[3]);
	if (Math.abs(norm - 1) > UNIT_TOLERANCE) {
		throw new Error(
			`poseToCskel27: bone "${bone}" is not a unit quaternion (norm ${norm})`
		);
	}
}

// A matrix must stay inside the rotation group: rows orthonormal (unit
// length, pairwise orthogonal) and right-handed.
function requireRotationMatrix(m, label) {
	for (let i = 0; i < 3; i += 1) {
		const row = m[i];
		const normSq = row[0] * row[0] + row[1] * row[1] + row[2] * row[2];
		if (Math.abs(normSq - 1) > UNIT_TOLERANCE) {
			throw new Error(
				`poseToCskel27: ${label} is not orthonormal (row ${i} has squared length ${normSq})`
			);
		}
		for (let j = i + 1; j < 3; j += 1) {
			const other = m[j];
			const dot = row[0] * other[0] + row[1] * other[1] + row[2] * other[2];
			if (Math.abs(dot) > UNIT_TOLERANCE) {
				throw new Error(
					`poseToCskel27: ${label} is not orthonormal (rows ${i} and ${j} dot to ${dot})`
				);
			}
		}
	}
	const det = determinant3(m);
	if (Math.abs(det - 1) > UNIT_TOLERANCE) {
		throw new Error(`poseToCskel27: ${label} has determinant ${det}, not +1`);
	}
}

/**
 * Convert a CozyClayPoseV1 into the frame arrays the ARDY generator expects.
 * `rest` is the parsed public/ardy/cskel27-rest.json, `reference` a parsed
 * ardy.frame.v1 fixture from the base motion the pose will constrain.
 * Returns { local_rot_mats, posed_joints, filled_identity }.
 */
export function poseToCskel27({ pose, rest, reference }) {
	if (!pose || typeof pose !== "object") {
		throw new Error(
			`poseToCskel27: pose is ${pose === null ? "null" : typeof pose}, expected an object`
		);
	}
	if (pose.schema !== "cozyclay.pose.v1") {
		throw new Error(
			`poseToCskel27: unsupported pose schema ${JSON.stringify(pose.schema)} — expected "cozyclay.pose.v1"`
		);
	}
	if (!pose.bones || typeof pose.bones !== "object" || Array.isArray(pose.bones)) {
		throw new Error("poseToCskel27: pose.bones must be an object keyed by mixamo bone name");
	}
	if (pose.root !== undefined) {
		if (!Array.isArray(pose.root) || pose.root.length !== 3 || !pose.root.every(isFiniteNumber)) {
			throw new Error("poseToCskel27: pose.root must be [x, y, z] finite metres when present");
		}
	}

	// Every joint CozyClay authors must be present and a unit quaternion.
	for (const bone of COZYCLAY_BONES) {
		if (!(bone in pose.bones)) {
			throw new Error(`poseToCskel27: pose.bones is missing "${bone}"`);
		}
		requireUnitQuaternion(pose.bones[bone], bone);
	}

	if (!rest || !Array.isArray(rest.joints)) {
		throw new Error("poseToCskel27: rest must be parsed cskel27-rest.json with a joints array");
	}
	const restByJoint = new Map();
	for (const entry of rest.joints) {
		if (!entry || typeof entry.name !== "string") {
			throw new Error("poseToCskel27: rest.joints entries must carry a string name");
		}
		if (entry.rest !== null) {
			if (
				!Array.isArray(entry.rest) ||
				entry.rest.length !== 3 ||
				!entry.rest.every(
					(row) => Array.isArray(row) && row.length === 3 && row.every(isFiniteNumber)
				)
			) {
				throw new Error(
					`poseToCskel27: rest for "${entry.name}" is neither null nor a 3x3 finite matrix`
				);
			}
		}
		restByJoint.set(entry.name, entry.rest);
	}

	const local_rot_mats = new Array(CSKEL27_JOINTS.length);
	const filled_identity = [];
	const rotation_constraint_indices = [];
	for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
		const name = CSKEL27_JOINTS[index];
		const sourceName = SOURCE_BY_TARGET.get(name);
		const rb = sourceName ? restByJoint.get(sourceName) : null;
		if (sourceName && rb !== null && rb !== undefined) {
			// L = Rb @ basis @ Rb^T; basisQuaternionToLocalRotation is the
			// quatToMat + basisToLocal composition from convert.js.
			local_rot_mats[index] = basisQuaternionToLocalRotation(
				pose.bones[sourceName],
				rb
			);
			rotation_constraint_indices.push(index);
		} else {
			// Fresh identity per joint so callers can never alias a shared
			// constant by mutating one row.
			local_rot_mats[index] = IDENTITY.map((row) => row.slice());
			filled_identity.push({
				joint: name,
				reason: sourceName ? "no rest rotation" : "not authored",
			});
		}
	}

	// Every emitted matrix must be a real rotation.
	for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
		requireRotationMatrix(
			local_rot_mats[index],
			`${CSKEL27_JOINTS[index]} (local_rot_mats[${index}])`
		);
	}

	// A reference may still supply different skeleton proportions, but its
	// frame-zero root is never copied. Placement is authored explicitly in
	// pose.root; otherwise the canonical floor-aligned neutral root is used.
	// This decouples body shape from whichever motion happened to be selected.
	const skeleton = reference ?? canonicalCskel27Reference();
	if (!Array.isArray(skeleton.posed_joints) || !Array.isArray(skeleton.local_rot_mats)) {
		throw new Error("poseToCskel27: reference must carry posed_joints and local_rot_mats");
	}
	const offsets = deriveBoneOffsets(skeleton.posed_joints, skeleton.local_rot_mats);
	const canonicalRoot = canonicalCskel27Reference().posed_joints[0];
	const posed_joints = forwardKinematics(local_rot_mats, offsets, pose.root ?? canonicalRoot);

	return {
		local_rot_mats,
		posed_joints,
		filled_identity,
		rotation_constraint_indices,
	};
}
