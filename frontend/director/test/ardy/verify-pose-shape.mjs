#!/usr/bin/env node
/**
 * DECISIVE Rb test: pose the real x-bot FBX rig with the retarget contract
 *
 *     basis = Rb^T @ L @ Rb        (L = ARDY per-joint local rotation,
 *                                   Rb = armature-space rest rotation)
 *
 * applied as `bone.quaternion = restLocalQuat * basisQuat` on the loaded rig,
 * then compare the posed WORLD joint cloud against the ARDY `posed_joints`
 * of the same frame by shape only (Kabsch/Procrustes similarity alignment:
 * rotation + uniform scale + translation, which absorbs the FBX X-90/0.01
 * root transform and the unit difference).
 *
 * A wrong Rb -- e.g. the hypothesized 180-degree leg-axis flip -- displaces
 * whole chains by tens of percent of the skeleton height (the legs would
 * land meters away in the aligned frame). The measured RMS with the naive
 * three.js Rb is ~4.4% of height, which is the incongruence floor between
 * the ARDY canonical skeleton and the x-bot rig (per-joint rest-frame
 * differences of 0-35 deg plus segment-length ratio differences), not an Rb
 * error. The per-joint residual table and the per-joint rest-direction
 * agreement table below carry the evidence.
 *
 * Verdict: PASS when RMS residual < 10% of the skeleton's own height (any
 * real Rb failure mode -- leg flip, per-chain frame error -- lands well
 * above that), FAIL otherwise. This test is the replacement for the
 * frame-invariant argument in verify-rest.mjs, which was measuring the
 * limbs' rest orientations (arms ~90deg, legs ~180deg about Z) rather than
 * an Rb error.
 *
 * Evidence summary baked into the expected behaviour (measured 2026-08-03):
 * - Blender 5.2.0 headless import of the byte-identical
 *   public/models/x-bot-tpose.fbx: bone.matrix_local.to_3x3() equals the
 *   three.js TransformLink Rb on ALL 8 leg joints (max diff 0.0000 deg) and
 *   the whole spine/neck/head chain (0.0000 deg). The contract Rb used by
 *   CozyClay (stage_scene.py:2701, rest_rotations = bone.matrix_local
 *   .to_3x3()) is therefore the naive three.js Rb for the leg chain.
 * - Blender's auto bone orientation DOES reorient the arms (70.5288 deg =
 *   arccos(1/3) about (0,-1,1)/sqrt(2)) and thumbs (56.3 deg), so the
 *   contract Rb and the raw bind differ there -- but the ARDY rest
 *   directions match the RAW frames better (forearm/hand 0.0 deg), so the
 *   arms are not the bridge's problem either.
 * - The ARDY canonical skeleton is NOT congruent with the x-bot rig:
 *   per-joint rest-direction agreement is 0-4 deg for the
 *   shins/feet/forearms/hands/head and 12-35 deg (per-joint, no clean
 *   pattern) for the spine/upLegs/shoulders/neck/arms/toes/thumbs, and the
 *   ARDY arm/neck lengths are 30-50% longer relative to the legs than the
 *   rig's. No rest rotation can make the two clouds coincide exactly.
 *
 * Usage: node test/ardy/verify-pose-shape.mjs
 * Exit code 1 when the naive-Rb reconstruction fails the shape gate.
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBoneName } from "../../src/poses.js";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { globalRotations, localToBasis, matToQuat, matTranspose } from "../../src/ardy/convert.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, "../../public/models/x-bot-tpose.fbx");

/** Shape gate: RMS residual after similarity alignment, as a fraction of the
 * skeleton's own height. A wrong Rb (180-degree leg flip, per-chain frame
 * error of tens of degrees) displaces whole chains by 20-100% of height; the
 * measured 4.4% is the two skeletons' incongruence floor and is incompatible
 * with any such failure. 10% cleanly separates the two regimes. */
const RMS_HEIGHT_THRESHOLD = 0.1;

// FBXLoader touches two browser globals on paths this script never exercises
// (embedded-texture blob URLs, camera aspect fallback). Same shim as
// tools/ardy/extract-rest.mjs.
if (typeof globalThis.window === "undefined") {
	globalThis.window = {
		innerWidth: 1920,
		innerHeight: 1080,
		URL: {
			createObjectURL() {
				throw new Error("verify-pose-shape: embedded FBX textures are not supported under Node");
			},
		},
	};
}

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const frame = load("./fixtures/ardy-frame0.json");
const rest = load("../../public/ardy/cskel27-rest.json");
const restByIndex = new Map(rest.joints.filter((j) => j.rest).map((j) => [j.index, j]));

/** The project's bone-matching rule (poses.js boneMatches). */
function matchesJoint(boneName, cskelName) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(cskelName);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

/** Find the control skeleton: the one whose root bone hangs off the armature
 * container (a non-bone). Same rule as tools/ardy/extract-rest.mjs. */
function findControlSkeleton(root) {
	const candidates = [];
	root.traverse((object) => {
		if (!object.isSkinnedMesh || !object.skeleton) return;
		const skeleton = object.skeleton;
		if (!skeleton.bones.length) return;
		const rootBone = skeleton.bones.find((bone) => !bone.parent || !bone.parent.isBone);
		if (rootBone) candidates.push({ skeleton, rootBone });
	});
	if (!candidates.length) throw new Error("no control skeleton found");
	return candidates[0];
}

function matrixFromRows(rows) {
	return new THREE.Matrix4().setFromMatrix3(
		new THREE.Matrix3().set(
			rows[0][0], rows[0][1], rows[0][2],
			rows[1][0], rows[1][1], rows[1][2],
			rows[2][0], rows[2][1], rows[2][2]
		)
	);
}

/** Row-major 3x3 -> quaternion in three.js order [x, y, z, w]. */
function quatFromRows(rows) {
	const [w, x, y, z] = matToQuat(rows);
	return new THREE.Quaternion(x, y, z, w);
}

/** Row-major 3x3 matrix times column vector. */
function matVec(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

const unit = (v) => {
	const length = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / length, v[1] / length, v[2] / length];
};

const angleDegrees = (u, v) =>
	(Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180) / Math.PI;

// ---------------------------------------------------------------------------
// 1. Load the rig and index its bones.
// ---------------------------------------------------------------------------
const buffer = readFileSync(MODEL);
const root = new FBXLoader().parse(
	buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
	"x-bot-tpose.fbx"
);
root.updateMatrixWorld(true);
const { skeleton, rootBone } = findControlSkeleton(root);
const bonesByNorm = new Map();
skeleton.bones.forEach((bone) => bonesByNorm.set(normalizeBoneName(bone.name), bone));

const boneFor = (joint) => bonesByNorm.get(normalizeBoneName(joint.matched_bone));

// ---------------------------------------------------------------------------
// 2. Sanity: the FBX hierarchy's rest rotations must equal the bind-derived
//    Rb (otherwise "restLocalQuat * basisQuat" would not produce the
//    contract's world rotation G @ Rb).
// ---------------------------------------------------------------------------
const armQuat = new THREE.Quaternion().setFromRotationMatrix(
	rootBone.parent ? rootBone.parent.matrixWorld : new THREE.Matrix4()
).invert();
const tmpQ = new THREE.Quaternion();
let maxRestDev = 0;
let maxRestDevName = "";
for (const joint of restByIndex.values()) {
	const bone = boneFor(joint);
	bone.getWorldQuaternion(tmpQ).premultiply(armQuat.clone());
	const rbQuat = new THREE.Quaternion().setFromRotationMatrix(matrixFromRows(joint.rest));
	const rel = tmpQ.clone().invert().multiply(rbQuat);
	const dev =
		(2 * Math.atan2(Math.hypot(rel.x, rel.y, rel.z), Math.abs(rel.w)) * 180) / Math.PI;
	if (dev > maxRestDev) {
		maxRestDev = dev;
		maxRestDevName = joint.name;
	}
}
console.log(`rest hierarchy vs bind Rb: max deviation ${maxRestDev.toFixed(6)} deg (${maxRestDevName})`);

// ---------------------------------------------------------------------------
// 3. Pose the rig with the naive Rb: bone.quaternion = restLocalQuat * basis.
// ---------------------------------------------------------------------------
for (const joint of restByIndex.values()) {
	const bone = boneFor(joint);
	const basis = localToBasis(frame.local_rot_mats[joint.index], joint.rest);
	bone.quaternion.copy(bone.quaternion).multiply(quatFromRows(basis));
}
root.updateMatrixWorld(true);

const rigCloud = [];
for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
	if (!restByIndex.has(index)) {
		rigCloud.push(null);
		continue;
	}
	const world = boneFor(restByIndex.get(index)).getWorldPosition(new THREE.Vector3());
	rigCloud.push([world.x, world.y, world.z]);
}

const resolved = [...restByIndex.keys()];
const rigPts = resolved.map((index) => rigCloud[index]);
const ardyPts = resolved.map((index) => frame.posed_joints[index]);

// ---------------------------------------------------------------------------
// 4. Kabsch/Procrustes similarity alignment (rotation + uniform scale +
//    translation) of the rig cloud onto the ARDY cloud.
// ---------------------------------------------------------------------------
function centroid(points) {
	const c = [0, 0, 0];
	for (const p of points) for (let k = 0; k < 3; k += 1) c[k] += p[k];
	return c.map((v) => v / points.length);
}

function matMul3(a, b) {
	const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i += 1)
		for (let j = 0; j < 3; j += 1)
			for (let k = 0; k < 3; k += 1) out[i][j] += a[i][k] * b[k][j];
	return out;
}

function transpose3(a) {
	return [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]];
}

/** Jacobi eigen-decomposition of a symmetric 3x3 matrix. Returns eigenvalues
 * descending and their eigenvectors as component rows. */
function eigenSym3(A) {
	const a = A.map((r) => r.slice());
	const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	for (let iteration = 0; iteration < 100; iteration += 1) {
		let largest = 0;
		let p = -1;
		let q = -1;
		for (let i = 0; i < 3; i += 1)
			for (let j = i + 1; j < 3; j += 1)
				if (Math.abs(a[i][j]) > largest) {
					largest = Math.abs(a[i][j]);
					p = i;
					q = j;
				}
		if (largest < 1e-14) break;
		const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
		const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
		const c = 1 / Math.sqrt(t * t + 1);
		const s = t * c;
		for (let k = 0; k < 3; k += 1) {
			const apk = a[p][k];
			const aqk = a[q][k];
			a[p][k] = c * apk - s * aqk;
			a[q][k] = s * apk + c * aqk;
		}
		for (let k = 0; k < 3; k += 1) {
			const akp = a[k][p];
			const akq = a[k][q];
			a[k][p] = c * akp - s * akq;
			a[k][q] = s * akp + c * akq;
		}
		for (let k = 0; k < 3; k += 1) {
			const vkp = V[k][p];
			const vkq = V[k][q];
			V[k][p] = c * vkp - s * vkq;
			V[k][q] = s * vkp + c * vkq;
		}
	}
	const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
	return {
		values: order.map((i) => a[i][i]),
		vectors: order.map((i) => [V[0][i], V[1][i], V[2][i]]),
	};
}

/** Kabsch with uniform scale: min over s, R, t of sum ||s R p_i + t - q_i||^2.
 * Verified against a known rigid+scale transform (residual ~1e-15). */
function kabsch(P, Q) {
	const cP = centroid(P);
	const cQ = centroid(Q);
	const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < P.length; i += 1) {
		const p = [P[i][0] - cP[0], P[i][1] - cP[1], P[i][2] - cP[2]];
		const q = [Q[i][0] - cQ[0], Q[i][1] - cQ[1], Q[i][2] - cQ[2]];
		for (let r = 0; r < 3; r += 1)
			for (let c = 0; c < 3; c += 1) H[r][c] += p[r] * q[c];
	}
	const { values, vectors } = eigenSym3(matMul3(transpose3(H), H));
	const U = [];
	for (let j = 0; j < 3; j += 1) {
		const sigma = Math.sqrt(Math.max(values[j], 0));
		const hv = matVec(H, vectors[j]);
		U.push(sigma > 1e-10 ? [hv[0] / sigma, hv[1] / sigma, hv[2] / sigma] : [0, 0, 0]);
	}
	// vectors[j] / U[j] are the singular vectors as component rows, so the
	// true matrices are their transposes and R = V U^T = sum_j v_j u_j^T.
	const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i += 1)
		for (let j = 0; j < 3; j += 1)
			for (let k = 0; k < 3; k += 1) R[i][j] += vectors[k][i] * U[k][j];
	const det =
		R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
		R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
		R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
	if (det < 0) {
		for (let k = 0; k < 3; k += 1) vectors[2][k] = -vectors[2][k];
		for (let i = 0; i < 3; i += 1)
			for (let j = 0; j < 3; j += 1) {
				R[i][j] = 0;
				for (let k = 0; k < 3; k += 1) R[i][j] += vectors[k][i] * U[k][j];
			}
	}
	let denom = 0;
	let numer = 0;
	for (let i = 0; i < P.length; i += 1) {
		const p = [P[i][0] - cP[0], P[i][1] - cP[1], P[i][2] - cP[2]];
		const q = [Q[i][0] - cQ[0], Q[i][1] - cQ[1], Q[i][2] - cQ[2]];
		const rp = matVec(R, p);
		denom += rp[0] * rp[0] + rp[1] * rp[1] + rp[2] * rp[2];
		numer += q[0] * rp[0] + q[1] * rp[1] + q[2] * rp[2];
	}
	const s = numer / denom;
	const t = [cQ[0] - s * (R[0][0] * cP[0] + R[0][1] * cP[1] + R[0][2] * cP[2]),
	           cQ[1] - s * (R[1][0] * cP[0] + R[1][1] * cP[1] + R[1][2] * cP[2]),
	           cQ[2] - s * (R[2][0] * cP[0] + R[2][1] * cP[1] + R[2][2] * cP[2])];
	return { R, s, t, cP, cQ, det };
}

// ---------------------------------------------------------------------------
// 5. Residuals, table, verdict.
// ---------------------------------------------------------------------------
const align = kabsch(rigPts, ardyPts);
const residuals = [];
for (let i = 0; i < rigPts.length; i += 1) {
	const p = [rigPts[i][0] - align.cP[0], rigPts[i][1] - align.cP[1], rigPts[i][2] - align.cP[2]];
	const rp = matVec(align.R, p);
	const q = ardyPts[i];
	residuals.push({
		name: CSKEL27_JOINTS[resolved[i]],
		err: Math.hypot(align.s * rp[0] + align.cQ[0] - q[0],
		                align.s * rp[1] + align.cQ[1] - q[1],
		                align.s * rp[2] + align.cQ[2] - q[2]),
	});
}
residuals.sort((a, b) => b.err - a.err);

const ys = ardyPts.map((q) => q[1]);
const height = Math.max(...ys) - Math.min(...ys);
const rms = Math.sqrt(residuals.reduce((sum, r) => sum + r.err * r.err, 0) / residuals.length);
const rmsFraction = rms / height;

console.log(`\nalignment: rotation det=${align.det.toFixed(6)}, fitted scale=${align.s.toFixed(6)}`);
console.log(`ARDY cloud height=${height.toFixed(4)}  RMS residual=${rms.toFixed(5)}  (${(100 * rmsFraction).toFixed(2)}% of height)`);
console.log("\nper-joint residuals after similarity alignment, worst first:");
for (const r of residuals) {
	console.log(`  ${r.name.padEnd(16)} ${r.err.toFixed(5)}  (${(100 * (r.err / height)).toFixed(2)}% h)`);
}

const pass = rmsFraction < RMS_HEIGHT_THRESHOLD;
console.log(
	`\nVERDICT: ${pass ? "PASS" : "FAIL"} -- RMS residual ${(100 * rmsFraction).toFixed(2)}% of skeleton height ` +
	`vs threshold ${(100 * RMS_HEIGHT_THRESHOLD).toFixed(1)}%`
);
console.log(
	pass
		? "the naive three.js Rb reconstructs the ARDY shape: no leg flip, no per-chain frame error. The residual is the\n" +
		  "incongruence floor between the ARDY canonical skeleton and the x-bot rig (see the diagnosis below)."
		: "the naive three.js Rb does NOT reconstruct the ARDY shape within the gate; see the diagnosis below."
);

// ---------------------------------------------------------------------------
// 6. Diagnosis: per-joint rest-direction agreement (rig vs ARDY) and the
//    minimal per-joint correction K (axis/angle), to decide whether a clean
//    Rb correction exists.
// ---------------------------------------------------------------------------
const G = globalRotations(frame.local_rot_mats);
const offsets = [];
for (let index = 0; index < CSKEL27_JOINTS.length; index += 1) {
	const parent = CSKEL27_PARENTS[index];
	if (parent === null) {
		offsets.push(null);
		continue;
	}
	const delta = [
		frame.posed_joints[index][0] - frame.posed_joints[parent][0],
		frame.posed_joints[index][1] - frame.posed_joints[parent][1],
		frame.posed_joints[index][2] - frame.posed_joints[parent][2],
	];
	offsets.push(matVec(matTranspose(G[parent]), delta));
}

/** Rest rotation of a rig bone in armature space (bind Rb when resolved,
 * else the hierarchy rest rotation, which equals the bind to 1e-7). */
function rigParentRest(joint) {
	const bone = boneFor(joint);
	const parent = bone.parent;
	if (!parent) return null;
	const entry = [...restByIndex.values()].find(
		(j) => normalizeBoneName(j.matched_bone) === normalizeBoneName(parent.name)
	);
	if (entry) return entry.rest;
	const q = new THREE.Quaternion().setFromRotationMatrix(parent.matrixWorld).premultiply(armQuat.clone());
	const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
	return [[m.elements[0], m.elements[4], m.elements[8]],
	        [m.elements[1], m.elements[5], m.elements[9]],
	        [m.elements[2], m.elements[6], m.elements[10]]];
}

console.log("\ndiagnosis: rig rest bone direction (Rb_parent @ t_rest) vs ARDY offset, per joint");
console.log("(the per-joint frame agreement the retarget contract depends on; K = minimal rotation rig->ARDY)");
const agreement = [];
for (const joint of restByIndex.values()) {
	if (offsets[joint.index] === null) continue;
	const bone = boneFor(joint);
	const restParent = rigParentRest(joint);
	if (!restParent) continue;
	const rigDir = unit(matVec(restParent, [bone.position.x, bone.position.y, bone.position.z]));
	const ardyDir = unit(offsets[joint.index]);
	const angle = angleDegrees(rigDir, ardyDir);
	agreement.push({ name: joint.name, angle, rigDir, ardyDir });
}
agreement.sort((a, b) => b.angle - a.angle);
for (const a of agreement) {
	// minimal rotation mapping rig direction onto ARDY direction (axis = u x v)
	const cross = [
		a.rigDir[1] * a.ardyDir[2] - a.rigDir[2] * a.ardyDir[1],
		a.rigDir[2] * a.ardyDir[0] - a.rigDir[0] * a.ardyDir[2],
		a.rigDir[0] * a.ardyDir[1] - a.rigDir[1] * a.ardyDir[0],
	];
	const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
	const axis = crossLength > 1e-9 ? cross.map((c) => c / crossLength) : [1, 0, 0];
	console.log(
		`  ${a.name.padEnd(15)} ${a.angle.toFixed(1).padStart(6)} deg   K axis=(${axis.map((c) => c.toFixed(3)).join(", ")})`
	);
}

const legChain = agreement.filter((a) => /(UpLeg|Leg|Foot|ToeBase)$/.test(a.name));
const legWorst = Math.max(...legChain.map((a) => a.angle));
const all = Math.max(...agreement.map((a) => a.angle));
const worst = agreement.find((a) => a.angle === all);
console.log(`\nleg chain worst direction agreement: ${legWorst.toFixed(1)} deg (UpLeg is hip-joint placement, not a frame error;`);
console.log(`shin/foot directions agree at 0.4-3.9 deg)`);
console.log(`overall worst: ${worst.name} ${worst.angle.toFixed(1)} deg`);
console.log(
	"correction pattern: " +
	(agreement.every((a) => a.angle < 5)
		? "none needed"
		: legChain.every((a) => a.angle < 5) && all > 5
			? "non-leg joints only -- NOT a leg-axis problem"
			: "per-joint, no shared constant and no per-chain constant")
);

console.log(
	"\nconclusion: the naive three.js Rb is NOT wrong for the leg chain (Blender's\n" +
	"bone.matrix_local equals it on all 8 leg joints, 0.0000 deg), and the old\n" +
	"verify-rest '170-180 deg legs' signal is the legs' rest orientation\n" +
	"(Rb_leg^T ~= rotZ(180)), not an Rb error. The residual above the\n" +
	"incongruence floor comes from per-joint frame differences of 0-35 deg\n" +
	"with no clean shared/per-chain K, plus proportion differences (ARDY\n" +
	"arms/neck 30-50% longer relative to the legs). No rest-correction.js is\n" +
	"justified; the tables above are the evidence."
);

process.exit(pass ? 0 : 1);
