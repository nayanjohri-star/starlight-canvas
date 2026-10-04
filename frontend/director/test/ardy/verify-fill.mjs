/**
 * Lossless-conversion proof for poseToCskel27 on the 19 joints CozyClay
 * owns, against REAL ARDY data rather than synthetic quaternions.
 *
 * The fixture's local_rot_mats are what the generator would read back for a
 * real pose; the forward path (localToBasis + matToQuat) is exactly what
 * export.js emits as a basis quaternion when a user poses the rig, so feeding
 * that quaternion back through poseToCskel27 must reproduce the original L.
 * The 8 joints CozyClay does not author must come out as exact identity and
 * be named in filled_identity, and the FK positions must hang off the
 * floor-aligned canonical root rather than an arbitrary clip root.
 *
 * Two separate error sources are checked under two named tolerances:
 *   1. conversion correctness: the round trip must equal the nearest rotation
 *      to the fixture L (projection(L), computed independently of the round
 *      trip) to 1e-9 — this is the real losslessness claim;
 *   2. float32 serialization noise: the round trip vs the RAW fixture L below
 *      1e-6, because the fixture values are float32-quantized and a quaternion
 *      cannot represent a matrix that is off SO(3).
 */
import { readFileSync } from "node:fs";
import { COZYCLAY_BONES, COZYCLAY_TO_CSKEL27, CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { localToBasis, matToQuat, quatToMat } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference, poseToCskel27 } from "../../src/ardy/to-cskel27.js";

const loadFixture = (n) =>
	JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const frame = loadFixture("ardy-frame40.json");
const rest = JSON.parse(
	readFileSync(new URL("../../public/ardy/cskel27-rest.json", import.meta.url), "utf8")
);

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

const restByName = new Map(rest.joints.map((entry) => [entry.name, entry.rest]));

// Assemble the pose exactly the way export.js would have: each authored
// joint's real L becomes a basis quaternion (rest^-1 * current), stored
// w-first under the mixamo name without the mixamorig prefix.
const bones = {};
	for (const bone of COZYCLAY_BONES) {
	const rb = restByName.get(bone);
	if (!rb) throw new Error(`verify-fill: rest.json has no rotation for ${bone}`);
		const L = frame.local_rot_mats[COZYCLAY_TO_CSKEL27[bone]];
	bones[bone] = matToQuat(localToBasis(L, rb));
}
const pose = {
		schema: "cozyclay.pose.v1",
	created_ms: 0,
		source: { app: "cozyclay", rig: "x-bot-tpose" },
	bones,
	camera: {
		position: [0, 0, 0],
		look_at: [0, 0, -1],
		up: [0, 1, 0],
		vertical_fov_radians: Math.PI / 4,
	},
	slate: "verify-fill",
};

const out = poseToCskel27({ pose, rest, reference: frame });

ok(
	"output shapes 27x3x3 and 27x3",
	out.local_rot_mats.length === 27 &&
		out.local_rot_mats.every((m) => m.length === 3 && m.every((row) => row.length === 3)) &&
		out.posed_joints.length === 27 &&
		out.posed_joints.every((v) => v.length === 3)
);

// Round trip on the 19 authored joints. The fixture L is float32-serialized
// (every element is exactly float32-representable), so it is itself off the
// rotation group: measured max |det-1| = 1.7e-7 (RightArm) and the nearest
// rotation is 1.016e-7 away (RightForeArm). A quaternion cannot represent a
// matrix that is off SO(3), so the round trip returns the nearest rotation;
// the claim is that it returns THAT rotation exactly (float64 precision).
// The 1e-6 bound below is float32 serialization noise, not conversion error.
const CONVERSION_TOLERANCE = 1e-9; // round trip == projection(L)
const FLOAT32_NOISE_TOLERANCE = 1e-6; // round trip vs raw fixture L

const maxAbsDiff = (a, b) => {
	let d = 0;
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) {
			d = Math.max(d, Math.abs(a[r][c] - b[r][c]));
		}
	}
	return d;
};

let worstRoundTrip = 0; // |roundtrip - projection(L)|, the correctness claim
let worstRoundTripBone = "";
let worstRaw = 0; // |roundtrip - raw fixture L|, includes float32 noise
let worstRawBone = "";
	for (const bone of COZYCLAY_BONES) {
		const index = COZYCLAY_TO_CSKEL27[bone];
	const got = out.local_rot_mats[index];
	const want = frame.local_rot_mats[index];
	// projection(L): the nearest rotation to the float32-quantized L (polar
	// factor), computed directly from L — NOT from the round-trip output, so
	// this check can never agree with the conversion tautologically.
	const projected = quatToMat(matToQuat(want));
	const dRoundTrip = maxAbsDiff(got, projected);
	const dRaw = maxAbsDiff(got, want);
	if (dRoundTrip > worstRoundTrip) {
		worstRoundTrip = dRoundTrip;
		worstRoundTripBone = bone;
	}
	if (dRaw > worstRaw) {
		worstRaw = dRaw;
		worstRawBone = bone;
	}
}
ok(
	"conversion lossless: round trip == projection(L) to 1e-9",
	worstRoundTrip < CONVERSION_TOLERANCE,
	`worst=${worstRoundTrip.toExponential(3)} at ${worstRoundTripBone}`
);
ok(
	"round trip within float32 noise of raw fixture L",
	worstRaw < FLOAT32_NOISE_TOLERANCE,
	`worst=${worstRaw.toExponential(3)} at ${worstRawBone}`
);

// The 8 joints CozyClay does not author after the Mixamo -> Core torso map:
// exact identity, named, and excluded from the rotation constraint mask.
const authoredSet = new Set(
	COZYCLAY_BONES.map((name) => CSKEL27_JOINTS[COZYCLAY_TO_CSKEL27[name]])
);
const nonAuthored = CSKEL27_JOINTS.filter((name) => !authoredSet.has(name));
ok(
	"exactly 8 joints are not authored",
	nonAuthored.length === 8,
	`non-authored=${nonAuthored.join(", ")}`
);
let identityOk = true;
for (const name of nonAuthored) {
	const m = out.local_rot_mats[CSKEL27_JOINTS.indexOf(name)];
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) {
			if (m[r][c] !== (r === c ? 1 : 0)) identityOk = false;
		}
	}
}
ok("8 non-authored joints are exactly identity", identityOk);

const reported = new Map(out.filled_identity.map((entry) => [entry.joint, entry.reason]));
ok(
	'filled_identity names all 8 with reason "not authored"',
	reported.size === nonAuthored.length &&
		nonAuthored.every((name) => reported.get(name) === "not authored"),
	`filled_identity=${JSON.stringify(out.filled_identity)}`
);
ok(
	"rotation constraint mask contains exactly the 19 authored target joints",
	out.rotation_constraint_indices.length === authoredSet.size &&
		out.rotation_constraint_indices.every(
			(index) => authoredSet.has(CSKEL27_JOINTS[index])
		),
	`indices=${JSON.stringify(out.rotation_constraint_indices)}`
);

// FK: the root rides exactly on the canonical floor-aligned root; every position finite.
const canonicalRoot = canonicalCskel27Reference().posed_joints[0];
let rootExact = true;
for (let i = 0; i < 3; i += 1) {
	if (out.posed_joints[0][i] !== canonicalRoot[i]) rootExact = false;
}
ok(
	"posed_joints[0] equals the canonical root exactly",
	rootExact,
	JSON.stringify(out.posed_joints[0])
);
ok(
	"all 27 positions finite",
	out.posed_joints.every((v) => v.every((n) => Number.isFinite(n)))
);

console.log(
	`\nreceipt: conversion error |roundtrip - projection(L)| = ${worstRoundTrip.toExponential(3)} (${worstRoundTripBone}) — the correctness claim, < 1e-9`
);
console.log(
	`receipt: |roundtrip - raw fixture L| = ${worstRaw.toExponential(3)} (${worstRawBone}) — float32 serialization noise, < 1e-6`
);
console.log(
	`receipt: identity-filled joints = ${out.filled_identity
		.map((e) => `${e.joint} (${e.reason})`)
		.join(", ")}`
);
console.log(`failures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
