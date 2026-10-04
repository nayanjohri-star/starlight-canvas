/**
 * Pure, framework-free math for the CozyClay -> ARDY pose bridge.
 * JS twin of /Users/yun/CozyClay/blender-addon/cclay/motion_constraints.py,
 * with the small matrix/quaternion helpers mirrored from
 * /Users/yun/CozyClay/blender-addon/cclay/motion_retarget.py so the math is
 * not re-derived (keep the two files in lockstep when the Python changes).
 *
 * Matrices are row-major 3x3 nested arrays, quaternions are w-first
 * [w, x, y, z] (Blender/motion_constraints order, NOT three.js [x, y, z, w]).
 * The math contract, from PoseTrackBuilder.step in motion_retarget.py:
 *
 *     basis = Rb^T @ L @ Rb          (ARDY local rotation L -> Blender basis)
 *     L     = Rb @ basis @ Rb^T      (inverse, this module)
 *
 * where Rb is the target bone's armature-space rest rotation (3x3). Every
 * function is total: shape mismatches raise a clear Error instead of leaking
 * NaN. No file IO, no three.js, no UI — pure functions over plain arrays.
 */

import { CSKEL27_PARENTS } from "./cskel27.js";

// Quaternion norm below which a rotation matrix cannot be built. Mirrors
// motion_retarget._QUATERNION_NORM_EPSILON so the inverse path rejects the
// same degenerate inputs the forward path would have produced.
const QUATERNION_NORM_EPSILON = 1e-12;

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function requireQuat(q, label) {
	if (!Array.isArray(q) || q.length !== 4 || !q.every(isFiniteNumber)) {
		throw new Error(`${label} must be a [w, x, y, z] quaternion of four finite numbers`);
	}
	return q;
}

function requireMat3(m, label) {
	if (
		!Array.isArray(m) ||
		m.length !== 3 ||
		!m.every(
			(row) => Array.isArray(row) && row.length === 3 && row.every(isFiniteNumber)
		)
	) {
		throw new Error(`${label} must be a row-major 3x3 matrix of finite numbers`);
	}
	return m;
}

function requireVec3(v, label) {
	if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) {
		throw new Error(`${label} must be an [x, y, z] vector of three finite numbers`);
	}
	return v;
}

function requireJointMatrices(values, label) {
	if (!Array.isArray(values) || values.length !== CSKEL27_PARENTS.length) {
		throw new Error(
			`${label} must hold ${CSKEL27_PARENTS.length} entries (one per cskel27 joint)`
		);
	}
	values.forEach((m, index) => requireMat3(m, `${label}[${index}]`));
	return values;
}

function requireJointVectors(values, label) {
	if (!Array.isArray(values) || values.length !== CSKEL27_PARENTS.length) {
		throw new Error(
			`${label} must hold ${CSKEL27_PARENTS.length} entries (one per cskel27 joint)`
		);
	}
	values.forEach((v, index) => requireVec3(v, `${label}[${index}]`));
	return values;
}

// Joint indices ordered so every parent precedes its children. Mirrors
// motion_constraints._topological_order.
function topologicalOrder() {
	const placed = new Set();
	const order = [];
	CSKEL27_PARENTS.forEach((parent, index) => {
		if (parent === null) {
			placed.add(index);
			order.push(index);
		}
	});
	order.sort((a, b) => a - b);
	while (order.length < CSKEL27_PARENTS.length) {
		let progressed = false;
		for (let index = 0; index < CSKEL27_PARENTS.length; index += 1) {
			if (!placed.has(index) && placed.has(CSKEL27_PARENTS[index])) {
				order.push(index);
				placed.add(index);
				progressed = true;
			}
		}
		if (!progressed) {
			throw new Error("cskel27 parent table is not a tree");
		}
	}
	return order;
}

const CSKEL27_TOPOLOGICAL_ORDER = topologicalOrder();

/** Row-major 3x3 matrix product a @ b (motion_retarget._mat_mul). */
export function matMul(a, b) {
	requireMat3(a, "matMul(a, b): a");
	requireMat3(b, "matMul(a, b): b");
	return [
		[
			a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
			a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
			a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
		],
		[
			a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
			a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
			a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
		],
		[
			a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
			a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
			a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
		],
	];
}

/** Row-major 3x3 transpose (motion_retarget._mat_transpose). */
export function matTranspose(m) {
	requireMat3(m, "matTranspose(m): m");
	return [
		[m[0][0], m[1][0], m[2][0]],
		[m[0][1], m[1][1], m[2][1]],
		[m[0][2], m[1][2], m[2][2]],
	];
}

// Row-major 3x3 matrix times column vector (motion_retarget._mat_vec).
function matVec(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

/**
 * Normalized [w, x, y, z] -> row-major 3x3 rotation matrix.
 * Twin of motion_constraints._quat_to_mat (which is the inverse of
 * motion_retarget._mat_to_quat). A zero-length or non-finite quaternion is
 * rejected explicitly rather than producing a garbage matrix.
 */
export function quatToMat(q) {
	const [wRaw, xRaw, yRaw, zRaw] = requireQuat(q, "quatToMat(q): q");
	const normSq = wRaw * wRaw + xRaw * xRaw + yRaw * yRaw + zRaw * zRaw;
	if (!Number.isFinite(normSq) || normSq <= QUATERNION_NORM_EPSILON) {
		throw new Error("quatToMat(q): quaternion is zero-length and cannot represent a rotation");
	}
	const inverseNorm = 1 / Math.sqrt(normSq);
	const w = wRaw * inverseNorm;
	const x = xRaw * inverseNorm;
	const y = yRaw * inverseNorm;
	const z = zRaw * inverseNorm;
	// Standard quaternion -> rotation matrix (right-handed, row-major).
	return [
		[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
		[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
		[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
	];
}

/**
 * Row-major 3x3 rotation matrix -> normalized [w, x, y, z].
 * Twin of motion_retarget._mat_to_quat (Shepperd's method). A non-finite or
 * degenerate matrix raises instead of returning a garbage quaternion.
 */
export function matToQuat(m) {
	requireMat3(m, "matToQuat(m): m");
	let quat;
	const trace = m[0][0] + m[1][1] + m[2][2];
	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2;
		quat = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s];
	} else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
		const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
		quat = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s];
	} else if (m[1][1] > m[2][2]) {
		const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
		quat = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s];
	} else {
		const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
		quat = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s];
	}
	const squaredNorm = quat.reduce((sum, component) => sum + component * component, 0);
	if (!Number.isFinite(squaredNorm) || squaredNorm <= QUATERNION_NORM_EPSILON) {
		throw new Error("matToQuat(m): matrix is degenerate and cannot represent a rotation");
	}
	const inverseNorm = 1 / Math.sqrt(squaredNorm);
	const normalized = quat.map((component) => component * inverseNorm);
	if (!normalized.every(isFiniteNumber)) {
		throw new Error("matToQuat(m): matrix is degenerate and cannot represent a rotation");
	}
	return normalized;
}

/**
 * ARDY local rotation L -> Blender pose basis: basis = Rb^T @ L @ Rb.
 * (the forward direction of the PoseTrackBuilder.step contract).
 */
export function localToBasis(L, Rb) {
	const local = requireMat3(L, "localToBasis(L, Rb): L");
	const rest = requireMat3(Rb, "localToBasis(L, Rb): Rb");
	const restT = matTranspose(rest);
	return matMul(restT, matMul(local, rest));
}

/**
 * Blender pose basis -> ARDY local rotation L: L = Rb @ basis @ Rb^T.
 * (the inverse of the PoseTrackBuilder.step contract).
 */
export function basisToLocal(basis, Rb) {
	const b = requireMat3(basis, "basisToLocal(basis, Rb): basis");
	const rest = requireMat3(Rb, "basisToLocal(basis, Rb): Rb");
	const restT = matTranspose(rest);
	return matMul(rest, matMul(b, restT));
}

/**
 * Blender pose-bone quaternion (normalized [w, x, y, z]) -> ARDY local
 * rotation L, given the bone's armature-space rest rotation Rb.
 * Twin of motion_constraints.basis_quaternion_to_local_rotation:
 * basis = quatToMat(quat); L = Rb @ basis @ Rb^T.
 */
export function basisQuaternionToLocalRotation(quatWFirst, restRotation) {
	const basis = quatToMat(quatWFirst);
	return basisToLocal(basis, restRotation);
}

/**
 * Accumulate per-joint local rotations into global ones down the tree.
 * Twin of motion_constraints.global_rotations. Returns 27 fresh matrices in
 * cskel27 index order.
 */
export function globalRotations(localRotations) {
	const locals = requireJointMatrices(localRotations, "globalRotations(localRotations)");
	const out = new Array(CSKEL27_PARENTS.length);
	for (const index of CSKEL27_TOPOLOGICAL_ORDER) {
		const parent = CSKEL27_PARENTS[index];
		out[index] =
			parent === null
				? locals[index].map((row) => row.slice())
				: matMul(out[parent], locals[index]);
	}
	return out;
}

/**
 * Constant bone vectors, each expressed in its parent's global frame, derived
 * from one posed frame: offset = R_parent^T @ (child - parent).
 * Twin of motion_constraints.derive_bone_offsets (argument order swapped: JS
 * call sites pass the source positions first). Deriving them from the clip
 * rather than hardcoding a rest skeleton keeps this correct if ARDY ever
 * reproportions cskel27.
 */
export function deriveBoneOffsets(jointPositions, localRotations) {
	const positions = requireJointVectors(jointPositions, "deriveBoneOffsets(jointPositions, ...)");
	const rotations = globalRotations(localRotations);
	const offsets = new Array(CSKEL27_PARENTS.length);
	for (let index = 0; index < offsets.length; index += 1) {
		offsets[index] = [0, 0, 0];
	}
	for (const index of CSKEL27_TOPOLOGICAL_ORDER) {
		const parent = CSKEL27_PARENTS[index];
		if (parent === null) continue;
		const delta = [
			positions[index][0] - positions[parent][0],
			positions[index][1] - positions[parent][1],
			positions[index][2] - positions[parent][2],
		];
		offsets[index] = matVec(matTranspose(rotations[parent]), delta);
	}
	return offsets;
}

/**
 * Joint positions in npz space for one posed frame: the mapping that answers
 * "where does the ARDY skeleton put this joint when posed like these
 * rotations". Twin of motion_constraints.forward_kinematics. `rootPosition`
 * defaults to the npz origin when the caller only needs relative pose.
 */
export function forwardKinematics(localRotations, boneOffsets, rootPosition = [0, 0, 0]) {
	const rotations = globalRotations(localRotations);
	requireJointVectors(boneOffsets, "forwardKinematics(...): boneOffsets");
	const root = requireVec3(rootPosition, "forwardKinematics(...): rootPosition");
	const positions = new Array(CSKEL27_PARENTS.length);
	for (const index of CSKEL27_TOPOLOGICAL_ORDER) {
		const parent = CSKEL27_PARENTS[index];
		if (parent === null) {
			positions[index] = root.slice();
			continue;
		}
		const moved = matVec(rotations[parent], boneOffsets[index]);
		positions[index] = [
			positions[parent][0] + moved[0],
			positions[parent][1] + moved[1],
			positions[parent][2] + moved[2],
		];
	}
	return positions;
}
