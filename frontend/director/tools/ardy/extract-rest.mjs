#!/usr/bin/env node
/**
 * Extract the cskel27 rest rotations (Rb) from a CozyClay T-pose FBX rig.
 *
 * Rb is the rotation part of each bone's rest (bind) transform in the
 * armature root's space. The ARDY retarget feeds it into
 * `basis = Rb^T @ L @ Rb` (CozyClay motion_retarget.py), where it is the
 * Blender-side `bone.matrix_local.to_3x3()` -- the bone's rest orientation in
 * armature space, NOT its parent-relative rotation and NOT its world
 * orientation including the FBX object transform. Bind data comes from the
 * skeleton's boneInverses (three.js FBXLoader builds those from the FBX
 * TransformLink matrices, the authoritative bind), with the armature
 * container's own world transform divided out.
 *
 * Usage: node tools/ardy/extract-rest.mjs
 * Writes: public/ardy/cskel27-rest.json (x-bot rig), 27 entries in cskel27
 * index order. Also extracts y-bot-tpose.fbx and prints the maximum
 * per-joint angular difference between the two rigs' rest rotations.
 *
 * Exits non-zero if any emitted matrix fails the orthonormality + det checks
 * (same tolerances as motion_retarget._validate_rotation_matrix).
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Project matcher primitive: strip every non-alphanumeric char, lowercase.
// Reused here so the FBX side and the pose studio can never drift apart.
import { normalizeBoneName } from "../../src/poses.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(HERE, "../../public/models");
const OUT_FILE = resolve(HERE, "../../public/ardy/cskel27-rest.json");

/** cskel27 joint order; array index == npz joint index. Verbatim from
 * motion_retarget.CSKEL27_JOINTS. */
const CSKEL27_JOINTS = [
	"Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
	"RightShoulder", "RightArm", "RightForeArm", "RightHand",
	"RightHandEnd", "RightHandThumb1",
	"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
	"LeftHandEnd", "LeftHandThumb1",
	"RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
	"LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
];

/** Mirrors ROTATION_MATRIX_TOLERANCE in CozyClay motion_retarget.py. */
const ROTATION_MATRIX_TOLERANCE = 1e-3;

// FBXLoader touches two browser globals on paths this script never exercises
// (embedded-texture blob URLs, camera aspect fallback). Keep the loader
// loadable under Node without pretending those paths work. No fetch/self shim
// is needed: parse() reads the buffer directly and FBXLoader never references
// `self`.
if (typeof globalThis.window === "undefined") {
	globalThis.window = {
		innerWidth: 1920,
		innerHeight: 1080,
		URL: {
			createObjectURL(blob) {
				if (typeof URL.createObjectURL === "function") {
					return URL.createObjectURL(blob);
				}
				throw new Error(
					"extract-rest: embedded FBX texture loading is not supported under Node"
				);
			},
		},
	};
}

/** The project's bone-matching rule (poses.js boneMatches): normalised names
 * equal, or one is a suffix of the other (`mixamorigleftarm` vs `leftarm`). */
function matchesJoint(boneName, cskelName) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(cskelName);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

/** Find the control skeleton of a parsed FBX root: the one whose root bone
 * hangs off the armature container (a non-bone). Mixamo exports also nest an
 * identity "skinned" copy of every bone under its control bone; those copy
 * skeletons fail this test (their root's parent is a bone), so this rule
 * picks the real hierarchy skeleton regardless of mesh order. */
function findControlSkeleton(root) {
	const candidates = [];
	root.traverse((object) => {
		if (!object.isSkinnedMesh || !object.skeleton) return;
		const skeleton = object.skeleton;
		if (!skeleton.bones.length) return;
		const rootBone = skeleton.bones.find(
			(bone) => !bone.parent || !bone.parent.isBone
		);
		if (rootBone) candidates.push({ skeleton, rootBone });
	});
	if (!candidates.length) {
		throw new Error("no skinned skeleton with a non-bone root found");
	}
	if (candidates.length > 1) {
		console.warn(
			`extract-rest: ${candidates.length} control skeletons; using the first`
		);
	}
	return candidates[0];
}

/** Load a rig and index every bind bone by normalised name.
 * Returns Map<normalised name, { name, bind }> where `bind` is the bone's
 * rest (bind) transform in armature space as a Matrix4. */
function loadRig(rigName) {
	const path = resolve(MODEL_DIR, `${rigName}.fbx`);
	const buffer = readFileSync(path);
	const arrayBuffer = buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength
	);
	const root = new FBXLoader().parse(arrayBuffer, path);
	root.updateMatrixWorld(true);

	const { skeleton, rootBone } = findControlSkeleton(root);
	// Blender's matrix_local divides out the armature object's world
	// transform; the FBX analogue is the skeleton root's non-bone parent.
	const armatureWorld = rootBone.parent
		? rootBone.parent.matrixWorld
		: new THREE.Matrix4();
	const toArmature = armatureWorld.clone().invert();

	const bindByName = new Map();
	skeleton.bones.forEach((bone, index) => {
		const bindGlobal = skeleton.boneInverses[index].clone().invert();
		// Keep the full Matrix4: Quaternion.setFromRotationMatrix reads 4x4
		// element indices, so a Matrix3 would silently produce NaN.
		const bind = toArmature.clone().multiply(bindGlobal);
		bindByName.set(normalizeBoneName(bone.name), { name: bone.name, bind });
	});
	return bindByName;
}

/** Column-major Matrix3 -> row-major 3x3 arrays. The JSON schema is
 * row-major, matching motion_retarget's nested-list matrices. */
function rowMajor(m3) {
	const e = m3.elements;
	return [
		[e[0], e[3], e[6]],
		[e[1], e[4], e[7]],
		[e[2], e[5], e[8]],
	];
}

/** Verify an orthonormal proper rotation exactly like
 * motion_retarget._validate_rotation_matrix: every row and column must have
 * squared norm 1 and pairwise dot 0 within the tolerance, and the determinant
 * must be +1 within the tolerance. Returns null when valid, else a
 * description of the failure. */
function validateRotationMatrix(rows) {
	const tolerance = ROTATION_MATRIX_TOLERANCE;
	const columns = [
		[rows[0][0], rows[1][0], rows[2][0]],
		[rows[0][1], rows[1][1], rows[2][1]],
		[rows[0][2], rows[1][2], rows[2][2]],
	];
	for (const vectors of [rows, columns]) {
		for (const vector of vectors) {
			const squaredNorm =
				vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
			if (
				!Number.isFinite(squaredNorm) ||
				Math.abs(squaredNorm - 1) > tolerance
			) {
				return `squared norm ${squaredNorm}`;
			}
		}
		for (const [first, second] of [[0, 1], [0, 2], [1, 2]]) {
			const dot =
				vectors[first][0] * vectors[second][0] +
				vectors[first][1] * vectors[second][1] +
				vectors[first][2] * vectors[second][2];
			if (!Number.isFinite(dot) || Math.abs(dot) > tolerance) {
				return `pairwise dot ${dot}`;
			}
		}
	}
	const determinant =
		rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1]) -
		rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0]) +
		rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
	if (!Number.isFinite(determinant) || Math.abs(determinant - 1) > tolerance) {
		return `determinant ${determinant}`;
	}
	return null;
}

/** Orthonormalise a near-rotation matrix and emit it. The quaternion
 * round-trip yields the closest proper rotation, so the emitted matrix always
 * satisfies the rotation checks; the RAW bind matrix is validated first,
 * which is the check that can actually fail (scale/shear/reflection would
 * survive the tolerance and must not be shipped as a rest rotation). */
function restRotationRows(bind, jointName) {
	const rawFailure = validateRotationMatrix(rowMajor(new THREE.Matrix3().setFromMatrix4(bind)));
	if (rawFailure !== null) {
		throw new Error(
			`${jointName}: raw bind matrix is not a proper rotation (${rawFailure})`
		);
	}
	const closest = new THREE.Matrix4()
		.makeRotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(bind));
	const rows = rowMajor(new THREE.Matrix3().setFromMatrix4(closest));
	const emittedFailure = validateRotationMatrix(rows);
	if (emittedFailure !== null) {
		throw new Error(
			`${jointName}: orthonormalised rest rotation failed validation (${emittedFailure})`
		);
	}
	return rows;
}

/** Angle in degrees between two rotations (the rotation of q1^-1 @ q2). */
function angleDegrees(q1, q2) {
	const relative = q1.clone().invert().multiply(q2);
	const axisLength = Math.hypot(relative.x, relative.y, relative.z);
	return (2 * Math.atan2(axisLength, relative.w) * 180) / Math.PI;
}

function main() {
	const xRig = loadRig("x-bot-tpose");

	const joints = [];
	const missing = [];
	for (let index = 0; index < CSKEL27_JOINTS.length; index++) {
		const name = CSKEL27_JOINTS[index];
		let matchedBone = null;
		let rest = null;
		for (const entry of xRig.values()) {
			if (matchesJoint(entry.name, name)) {
				matchedBone = entry.name;
				rest = restRotationRows(entry.bind, name);
				break;
			}
		}
		if (matchedBone === null) missing.push(name);
		joints.push({ name, index, matched_bone: matchedBone, rest });
	}

	const json = {
		schema: "cskel27.rest.v1",
		rig: "x-bot-tpose",
		joints,
		missing,
	};
	mkdirSync(dirname(OUT_FILE), { recursive: true });
	writeFileSync(OUT_FILE, `${JSON.stringify(json, null, 2)}\n`);

	const resolved = joints.filter((joint) => joint.rest !== null).length;
	console.log(`wrote ${OUT_FILE}`);
	console.log(`resolved ${resolved}/${CSKEL27_JOINTS.length} cskel27 joints`);
	for (const joint of joints) {
		const match = joint.matched_bone ?? "MISSING";
		console.log(`  ${joint.index.toString().padStart(2)} ${joint.name.padEnd(15)} -> ${match}`);
	}
	console.log(`missing: ${missing.length ? missing.join(", ") : "none"}`);

	// Same extraction against the y-bot rig; the gap between the two rigs'
	// rest rotations is why poses travel as deltas, not absolute rotations.
	const yRig = loadRig("y-bot-tpose");
	let maxAngle = -1;
	let maxJoint = null;
	let compared = 0;
	for (const joint of joints) {
		if (joint.rest === null) continue;
		const yEntry = yRig.get(normalizeBoneName(joint.matched_bone));
		if (!yEntry) continue;
		compared += 1;
		const angle = angleDegrees(
			new THREE.Quaternion().setFromRotationMatrix(
				new THREE.Matrix4().setFromMatrix3(matrixFromRows(joint.rest))
			),
			new THREE.Quaternion().setFromRotationMatrix(yEntry.bind)
		);
		if (angle > maxAngle) {
			maxAngle = angle;
			maxJoint = joint.name;
		}
	}
	console.log(
		`max per-joint rest rotation difference x-bot vs y-bot: ${maxAngle.toFixed(3)} deg (${maxJoint}, ${compared} joints compared)`
	);
}

/** Row-major nested arrays -> Matrix3. Matrix3.set takes row-major arguments. */
function matrixFromRows(rows) {
	return new THREE.Matrix3().set(
		rows[0][0], rows[0][1], rows[0][2],
		rows[1][0], rows[1][1], rows[1][2],
		rows[2][0], rows[2][1], rows[2][2]
	);
}

main();
