#!/usr/bin/env node
/**
 * Focused regression proof for the two load-bearing browser motion paths.
 * Pure Node, no numpy and no network needed:
 *
 *   node test/ardy/verify-browser-motion.mjs
 *
 * 1. decodeMotionNpz (src/ardy/npz.js) must decode a valid STORED motion npz
 *    whose float32 payloads start at a byteOffset that is NOT a multiple of
 *    4. A real box-generated npz puts npy payloads behind zip local headers
 *    and npy dict headers of arbitrary byte length, so the payload is
 *    routinely unaligned relative to the archive ArrayBuffer; the pre-fix
 *    code built `new Float32Array(buffer, payloadOffset, n)` directly and
 *    threw "start offset of Float32Array should be a multiple of 4". This
 *    test builds a minimal archive with a tiny spec-derived NPY/ZIP STORED
 *    writer (no product internals), shifts the whole archive one byte into
 *    a fresh buffer, PROVES the local_rot_mats payload byteOffset is not a
 *    multiple of 4 (and that a direct Float32Array view at that offset
 *    throws exactly the old RangeError), then requires the decoder to
 *    succeed with exact frames/fps/lengths/values. A second archive with
 *    one required shape mutated must be rejected with the exact message --
 *    no tolerance weakening anywhere.
 *
 * 2. applyMotionFrame (src/ardy/playback.js) must invert the pose export
 *    exactly: current = bind * basis with basis = qRb^-1 * qL * qRb
 *    (convert.js localToBasis), NOT the old `bind * L` which rotates limbs
 *    around the wrong axes. A minimal THREE.Bone rig compatible with
 *    motionBones carries non-identity local bind quaternions, stamped on
 *    rig.userData.poseBind. The LeftArm parent chain is three rotZ(30)
 *    binds, so its armature-space rest rotation Rb is provably rotZ(90);
 *    the known basis rotation of 60 deg about Y conjugates into the ARDY
 *    local rotation L = Rb * basis * Rb^-1 = rotX(-60), which is placed
 *    into an otherwise-identity 1-frame 27-joint motion. The target bone
 *    must come back out as bind * basis = rotY(60) (up to quaternion sign);
 *    the old bind * L result is rotX(-60) -- 2*acos(0.75) = 82.8 deg away,
 *    asserted > 0.01. Snapshot -> playback perturb -> restore must
 *    reproduce the pre-playback quaternions exactly (bitwise).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { characterScaleFor, decodeMotionNpz, NpzError } from "../../src/ardy/npz.js";
import { motionArraysToNpzMembers, writeNpz } from "../../tools/ardy/npz.mjs";
import {
	applyMotionFrame,
	motionBones,
	snapshotPlaybackBones,
	restorePlaybackBones,
} from "../../src/ardy/playback.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { alignArdyPath, defaultWaypointPosition, densifyArdyWaypoints, judgeAuthoredPath, judgeNextWaypoint, poseConstraintFrame, toArdyWaypoints, toSceneRootOffset, PATH_LIMITS } from "../../src/ardy/waypoints.js";
import { primeBindPose } from "../../src/poses.js";

let failures = 0;
const ok = (label, cond, detail) => {
	if (cond) {
		console.log(`PASS  ${label}${detail ? ` -- ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
	}
};

const throws = (fn) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

const bindRig = new THREE.Object3D();
const bindBone = new THREE.Bone();
bindBone.position.set(3, 4, 5);
bindRig.add(bindBone);
primeBindPose(bindRig);
bindBone.position.set(30, 40, 50);
primeBindPose(bindRig);
const savedBindPosition = bindRig.userData.poseBind.get(bindBone).position;
ok(
	"bind snapshot preserves the original local translation for IK FK reconstruction",
	savedBindPosition.x === 3 && savedBindPosition.y === 4 && savedBindPosition.z === 5
);

async function rejectsWith(promise) {
	try {
		await promise;
		return { threw: false, err: null };
	} catch (err) {
		return { threw: true, err };
	}
}

/* --- test-only NPY / ZIP STORED writer (spec-derived, no product internals) */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** One .npy v1.0 member. The header is padded so the whole 10-byte prefix +
 * header is a multiple of 16 bytes; with the 30-byte zip local header and
 * 18-byte member name below, the first float32 payload lands at byteOffset
 * 30 + 18 + 10 + header = 58 + header, i.e. 2 (mod 4) inside the archive --
 * so a 1-byte shift makes it 3 (mod 4), genuinely unaligned. */
function npyBytes(descr, shape, payload) {
	const tuple =
		shape.length === 0 ? "()" : `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
	const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${tuple}, }`;
	const header = dict + " ".repeat((16 - ((dict.length + 1) % 16)) % 16) + "\n";
	const prefix = new Uint8Array(10);
	prefix[0] = 0x93;
	prefix.set([0x4e, 0x55, 0x4d, 0x50, 0x59], 1); // "NUMPY"
	prefix[6] = 1; // version 1.0
	prefix[8] = header.length & 0xff;
	prefix[9] = (header.length >> 8) & 0xff;
	const out = new Uint8Array(10 + header.length + payload.length);
	out.set(prefix, 0);
	out.set(new TextEncoder().encode(header), 10);
	out.set(payload, 10 + header.length);
	return out;
}

/** Minimal STORED zip: local headers + payloads, central directory, EOCD. */
function zipStored(members) {
	const localParts = [];
	const centralEntries = [];
	let offset = 0;
	for (const { name, bytes } of members) {
		const nameBytes = new TextEncoder().encode(name);
		const crc = crc32(bytes);
		const local = new Uint8Array(30);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true); // version needed to extract
		lv.setUint16(6, 0, true); // general purpose flags
		lv.setUint16(8, 0, true); // method: STORED
		lv.setUint32(14, crc, true);
		lv.setUint32(18, bytes.length, true); // compressed size
		lv.setUint32(22, bytes.length, true); // uncompressed size
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true); // extra field length
		localParts.push(local, nameBytes, bytes);
		centralEntries.push({ nameBytes, crc, size: bytes.length, offset });
		offset += 30 + nameBytes.length + bytes.length;
	}
	const cdStart = offset;
	const cdParts = [];
	let cdSize = 0;
	for (const entry of centralEntries) {
		const c = new Uint8Array(46);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true); // version made by
		cv.setUint16(6, 20, true); // version needed to extract
		cv.setUint16(8, 0, true); // flags
		cv.setUint16(10, 0, true); // method: STORED
		cv.setUint32(16, entry.crc, true);
		cv.setUint32(20, entry.size, true);
		cv.setUint32(24, entry.size, true);
		cv.setUint16(28, entry.nameBytes.length, true);
		cv.setUint16(30, 0, true); // extra
		cv.setUint16(32, 0, true); // comment
		cv.setUint16(34, 0, true); // disk number start
		cv.setUint16(36, 0, true); // internal attributes
		cv.setUint32(38, 0, true); // external attributes
		cv.setUint32(42, entry.offset, true); // local header offset
		cdParts.push(c, entry.nameBytes);
		cdSize += 46 + entry.nameBytes.length;
	}
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, members.length, true); // entries on this disk
	ev.setUint16(10, members.length, true); // total entries
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, cdStart, true);
	ev.setUint16(20, 0, true); // comment length
	return concatBytes([...localParts, ...cdParts, eocd]);
}

function f32Bytes(values) {
	const floats = Float32Array.from(values);
	return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

function int32Bytes(value) {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setInt32(0, value, true);
	return bytes;
}

/** Byte offset of one member's npy float payload inside the archive (zip
 * spec navigation only: EOCD -> central directory -> local header -> npy
 * header length field). */
function memberPayloadOffset(archive, name) {
	const eocd = archive.length - 22;
	const eocdView = new DataView(archive.buffer, archive.byteOffset + eocd);
	const count = eocdView.getUint16(10, true);
	let off = eocdView.getUint32(16, true);
	for (let n = 0; n < count; n += 1) {
		const view = new DataView(archive.buffer, archive.byteOffset + off);
		const nameLen = view.getUint16(28, true);
		const extraLen = view.getUint16(30, true);
		const commentLen = view.getUint16(32, true);
		const localOff = view.getUint32(42, true);
		const entryName = new TextDecoder("latin1").decode(
			archive.subarray(off + 46, off + 46 + nameLen)
		);
		if (entryName === name) {
			const localView = new DataView(archive.buffer, archive.byteOffset + localOff);
			const dataStart =
				localOff + 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
			const headerLen = archive[dataStart + 8] | (archive[dataStart + 9] << 8);
			return dataStart + 10 + headerLen;
		}
		off += 46 + nameLen + extraLen + commentLen;
	}
	throw new Error(`zip member ${name} not found`);
}

function arraysEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

function identityPattern(mat) {
	for (let i = 0; i < mat.length; i += 1) {
		const k = i % 9;
		if (mat[i] !== (k === 0 || k === 4 || k === 8 ? 1 : 0)) return false;
	}
	return true;
}

/** Max component distance between two quaternions, up to quaternion sign
 * (q and -q are the same rotation). */
function quatMaxError(a, b) {
	let best = Infinity;
	for (const sign of [1, -1]) {
		const error = Math.max(
			Math.abs(a.x - sign * b.x),
			Math.abs(a.y - sign * b.y),
			Math.abs(a.z - sign * b.z),
			Math.abs(a.w - sign * b.w)
		);
		if (error < best) best = error;
	}
	return best;
}

const DEG = Math.PI / 180;
const IDENTITY_Q = new THREE.Quaternion();

/* --- 1. npz decoder: unaligned-archive regression --------------------------- */

const F = 2;
const rotValues = new Float32Array(F * 27 * 9);
for (let i = 0; i < rotValues.length; i += 1) {
	const k = i % 9;
	rotValues[i] = k === 0 || k === 4 || k === 8 ? 1 : 0;
}
const posedValues = new Float32Array(F * 27 * 3);
for (let i = 0; i < posedValues.length; i += 1) posedValues[i] = (i % 17) - 8;
const archive = zipStored([
	{ name: "local_rot_mats.npy", bytes: npyBytes("<f4", [F, 27, 3, 3], f32Bytes(rotValues)) },
	{ name: "root_positions.npy", bytes: npyBytes("<f4", [F, 3], f32Bytes([0, 0, 0, 1, 2, 3])) },
	{ name: "fps.npy", bytes: npyBytes("<i4", [], int32Bytes(30)) },
	{ name: "posed_joints.npy", bytes: npyBytes("<f4", [F, 27, 3], f32Bytes(posedValues)) },
]);

// Shift the whole archive one byte into a fresh buffer: every payload
// byteOffset flips parity, so the local_rot_mats float32 payload (2 mod 4
// in the original archive) becomes 3 mod 4 -- the exact condition under
// which the pre-fix direct `new Float32Array(buffer, offset, n)` threw.
const holder = new Uint8Array(archive.length + 2);
holder.set(archive, 1);
const shifted = holder.subarray(1, 1 + archive.length);

const lrotOffset = memberPayloadOffset(shifted, "local_rot_mats.npy");
const absLrot = shifted.byteOffset + lrotOffset;
ok(
	"npz setup: local_rot_mats payload byteOffset is not a multiple of 4",
	absLrot % 4 !== 0,
	`absolute byteOffset=${absLrot} (${absLrot % 4} mod 4)`
);
ok(
	"npz setup: direct Float32Array view at that offset throws (old failure)",
	throws(() => new Float32Array(shifted.buffer, absLrot, F * 27 * 9)),
	"RangeError: start offset of Float32Array should be a multiple of 4"
);

const decoded = await decodeMotionNpz(shifted);
ok(
	"npz decode: unaligned archive decodes",
	decoded.frames === F && decoded.fps === 30,
	`frames=${decoded.frames} fps=${decoded.fps}`
);
ok(
	"npz decode: exact member lengths",
	decoded.rotMats instanceof Float32Array &&
		decoded.rotMats.length === F * 27 * 9 &&
		decoded.rootPos.length === F * 3 &&
		decoded.posedJoints instanceof Float32Array &&
		decoded.posedJoints.length === F * 27 * 3,
	`rotMats=${decoded.rotMats.length} rootPos=${decoded.rootPos.length} posedJoints=${decoded.posedJoints?.length}`
);
ok(
	"npz decode: posed_joints exact selected values",
	decoded.posedJoints[0] === -8 &&
		decoded.posedJoints[17] === -8 &&
		decoded.posedJoints[F * 27 * 3 - 1] === ((F * 27 * 3 - 1) % 17) - 8,
	`posedJoints[0]=${decoded.posedJoints[0]} [17]=${decoded.posedJoints[17]}`
);
ok("npz decode: local_rot_mats exactly identity", identityPattern(decoded.rotMats));
ok(
	"npz decode: root_positions exact selected values",
	decoded.rootPos[0] === 0 &&
		decoded.rootPos[1] === 0 &&
		decoded.rootPos[2] === 0 &&
		decoded.rootPos[3] === 1 &&
		decoded.rootPos[4] === 2 &&
		decoded.rootPos[5] === 3,
	`rootPos=[${decoded.rootPos.join(",")}]`
);
const alignedDecoded = await decodeMotionNpz(archive);
ok(
	"npz decode: shifted and original archives decode identically",
	alignedDecoded.frames === decoded.frames &&
		alignedDecoded.fps === decoded.fps &&
		arraysEqual(alignedDecoded.rotMats, decoded.rotMats) &&
		arraysEqual(alignedDecoded.rootPos, decoded.rootPos) &&
		arraysEqual(alignedDecoded.posedJoints, decoded.posedJoints)
);

// One required shape mutated (26 joints instead of 27): must be rejected
// with the exact message.
const badArchive = zipStored([
	{
		name: "local_rot_mats.npy",
		bytes: npyBytes("<f4", [F, 26, 3, 3], f32Bytes(new Float32Array(F * 26 * 9))),
	},
	{ name: "root_positions.npy", bytes: npyBytes("<f4", [F, 3], f32Bytes([0, 0, 0, 1, 2, 3])) },
	{ name: "fps.npy", bytes: npyBytes("<i4", [], int32Bytes(30)) },
	{ name: "posed_joints.npy", bytes: npyBytes("<f4", [F, 27, 3], f32Bytes(posedValues)) },
]);
const rejection = await rejectsWith(decodeMotionNpz(badArchive));
ok(
	"npz rejection: joint-count mutation rejected with exact message",
	rejection.threw &&
		rejection.err instanceof NpzError &&
		rejection.err.message ===
			"local_rot_mats must have shape (F, 27, 3, 3), got (2, 26, 3, 3)",
	rejection.threw ? `msg="${rejection.err.message}"` : "no throw"
);

/* --- 1b. person scale: the filmed body travels WITH the take --------------- */

// WHY: the extraction divided the take's root translation by the performer's
// stature, so the frames are only metrically right when the character is
// scaled by the same number. A take that carried its frames but not its scale
// replayed a filmed stride ~10 % too long and skated the feet.

ok(
	"npz decode: an archive without person_scale reports the canonical 1",
	decoded.personScale === 1,
	`personScale=${decoded.personScale}`
);

const scaledArchive = zipStored([
	{ name: "local_rot_mats.npy", bytes: npyBytes("<f4", [F, 27, 3, 3], f32Bytes(rotValues)) },
	{ name: "root_positions.npy", bytes: npyBytes("<f4", [F, 3], f32Bytes([0, 0, 0, 1, 2, 3])) },
	{ name: "fps.npy", bytes: npyBytes("<i4", [], int32Bytes(30)) },
	{ name: "posed_joints.npy", bytes: npyBytes("<f4", [F, 27, 3], f32Bytes(posedValues)) },
	{ name: "person_scale.npy", bytes: npyBytes("<f4", [], f32Bytes([0.9])) },
]);
const scaledDecoded = await decodeMotionNpz(scaledArchive);
ok(
	"npz decode: a stored person_scale comes back on the motion",
	scaledDecoded.personScale === Math.fround(0.9) &&
		scaledDecoded.frames === F &&
		arraysEqual(scaledDecoded.rootPos, decoded.rootPos),
	`personScale=${scaledDecoded.personScale}`
);

const zeroScaleArchive = zipStored([
	{ name: "local_rot_mats.npy", bytes: npyBytes("<f4", [F, 27, 3, 3], f32Bytes(rotValues)) },
	{ name: "root_positions.npy", bytes: npyBytes("<f4", [F, 3], f32Bytes([0, 0, 0, 1, 2, 3])) },
	{ name: "fps.npy", bytes: npyBytes("<i4", [], int32Bytes(30)) },
	{ name: "posed_joints.npy", bytes: npyBytes("<f4", [F, 27, 3], f32Bytes(posedValues)) },
	{ name: "person_scale.npy", bytes: npyBytes("<f4", [], f32Bytes([0])) },
]);
const zeroScaleRejection = await rejectsWith(decodeMotionNpz(zeroScaleArchive));
ok(
	"npz rejection: a zero person_scale is corrupt data, not a scale to clamp",
	zeroScaleRejection.threw &&
		zeroScaleRejection.err instanceof NpzError &&
		zeroScaleRejection.err.message === "motion person_scale 0 must be positive",
	zeroScaleRejection.threw ? `msg="${zeroScaleRejection.err.message}"` : "no throw"
);

// Writer -> npz -> browser decoder, the real production pair: tools/ardy/npz.mjs
// is what the extract bridge writes with, src/ardy/npz.js is what the app reads
// with. The value has to survive that boundary, and an archive written without
// one has to stay decodable.
const scaleDir = mkdtempSync(join(tmpdir(), "cozyclay-person-scale-"));
try {
	const arrays = {
		frames: F,
		fps: 30,
		rotMats: rotValues,
		rootPos: Float32Array.from([0, 0, 0, 1, 2, 3]),
		posedJoints: posedValues,
	};
	const withScalePath = join(scaleDir, "with-scale.npz");
	writeNpz(withScalePath, motionArraysToNpzMembers({ ...arrays, personScale: 0.9037 }));
	const roundTripped = await decodeMotionNpz(new Uint8Array(readFileSync(withScalePath)));
	ok(
		"npz round-trip: writer person_scale survives into the browser decoder",
		roundTripped.personScale === Math.fround(0.9037) &&
			roundTripped.frames === F &&
			roundTripped.fps === 30 &&
			arraysEqual(roundTripped.rotMats, rotValues),
		`personScale=${roundTripped.personScale}`
	);

	const plainPath = join(scaleDir, "no-scale.npz");
	const plainMembers = motionArraysToNpzMembers(arrays);
	writeNpz(plainPath, plainMembers);
	const plainDecoded = await decodeMotionNpz(new Uint8Array(readFileSync(plainPath)));
	ok(
		"npz round-trip: a take written without a stature omits the member and reads back as 1",
		plainMembers.person_scale === undefined &&
			Object.keys(plainMembers).join() === "local_rot_mats,root_positions,posed_joints,fps" &&
			plainDecoded.personScale === 1,
		`members=${Object.keys(plainMembers).join()} personScale=${plainDecoded.personScale}`
	);
	ok(
		"npz writer: person_scale is appended last, so the four original members keep their order",
		Object.keys(motionArraysToNpzMembers({ ...arrays, personScale: 0.9 })).join() ===
			"local_rot_mats,root_positions,posed_joints,fps,person_scale"
	);
	ok(
		"npz writer: a canonical 1 adds no member, so a decode/edit/rewrite round trip does not grow the archive",
		motionArraysToNpzMembers({ ...arrays, personScale: 1 }).person_scale === undefined
	);
	ok(
		"npz writer: a non-positive stature is refused, never written",
		throws(() => motionArraysToNpzMembers({ ...arrays, personScale: 0 })) &&
			throws(() => motionArraysToNpzMembers({ ...arrays, personScale: Number.NaN }))
	);
} finally {
	rmSync(scaleDir, { recursive: true, force: true });
}

ok(
	"character scale: a stored stature is used as-is inside the sane band",
	characterScaleFor({ personScale: 0.9 }) === 0.9 &&
		characterScaleFor({ personScale: 1.42 }) === 1.42
);
ok(
	"character scale: a bad estimate is clamped, never a giant or a gnome",
	characterScaleFor({ personScale: 4 }) === 1.5 && characterScaleFor({ personScale: 0.05 }) === 0.6
);
ok(
	"character scale: no stature anywhere means canonical 1",
	characterScaleFor({}) === 1 && characterScaleFor(null) === 1 && characterScaleFor(undefined, NaN) === 1
);
ok(
	"character scale: the response fallback only applies when the take stores nothing",
	characterScaleFor(null, 0.8) === 0.8 &&
		characterScaleFor({ personScale: 0.9 }, 0.8) === 0.9 &&
		characterScaleFor(null, 9) === 1.5
);

/* --- 2. playback: positional skinning (viser compute_bone_transforms twin) --- */

// Mini rig: 8 bones with non-identity bind rotations and positions. The
// skinning map must resolve the RT-style spine shift (core Spine1/2/3 drive
// the Mixamo Spine/Spine1/Spine2 bones) and every bone's world transform
// must come out as
//     pos  = s * (posed - anchorRootXZ) + R @ (bindPos - s * neutralShifted)
//     quat = R @ bindQuat
// computed INDEPENDENTLY here from the bind pose, the neutral skeleton, and
// the frame's global rotations — the local-conversion path (world -> bone
// local down the parent chain) is where positional skinning breaks if the
// chain tracking is wrong.
const rig = new THREE.Object3D();
rig.name = "Rig";
const addBone = (name, parent, pos, quat) => {
	const bone = new THREE.Bone();
	bone.name = name;
	bone.position.set(pos[0], pos[1], pos[2]);
	if (quat) bone.quaternion.copy(quat);
	parent.add(bone);
	return bone;
};
const rotAxis = (x, y, z, angle) =>
	new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle);

const Hips = addBone("mixamorig:Hips", rig, [0, 100, 0], rotAxis(0, 0, 1, 30 * DEG));
const Spine = addBone("mixamorig:Spine", Hips, [0, 10, 2], null);
const Spine1 = addBone("mixamorig:Spine1", Spine, [0, 9, -1], rotAxis(1, 0, 0, 10 * DEG));
const Spine2 = addBone("mixamorig:Spine2", Spine1, [0, 9, -1], null);
const RightUpLeg = addBone("mixamorig:RightUpLeg", Hips, [-8, -5, 0], rotAxis(1, 0, 0, -5 * DEG));
const RightLeg = addBone("mixamorig:RightLeg", RightUpLeg, [0, -45, 0], null);
const RightFoot = addBone("mixamorig:RightFoot", RightLeg, [0, -45, 0], rotAxis(1, 0, 0, 15 * DEG));
const RightToeBase = addBone("mixamorig:RightToeBase", RightFoot, [0, -4, 12], rotAxis(1, 0, 0, 20 * DEG));

// poseBind snapshot primed by Character: local bind quaternions.
rig.userData.poseBind = new Map();
rig.traverse((object) => {
	if (object.isBone) {
		const q = object.quaternion;
		rig.userData.poseBind.set(object, { x: q.x, y: q.y, z: q.z, w: q.w });
	}
});
rig.updateMatrixWorld(true);

const mappedBones = [Hips, Spine, Spine1, Spine2, RightUpLeg, RightLeg, RightFoot, RightToeBase];
const bindWorldPos = new Map();
const bindWorldQuat = new Map();
const bindLocalPos = new Map();
const bindLocalQuat = new Map();
for (const bone of mappedBones) {
	bindWorldPos.set(bone, bone.getWorldPosition(new THREE.Vector3()));
	bindWorldQuat.set(bone, bone.getWorldQuaternion(new THREE.Quaternion()));
	bindLocalPos.set(bone, bone.position.clone());
	bindLocalQuat.set(bone, bone.quaternion.clone());
}

// Independent replication of the prep scale: rig leg height over ARDY's
// neutral leg height (0.9544128 m toe depth under the hips-origin neutral).
const ARDY_NEUTRAL_TOE = 0.9544128;
const hipsBindY = bindWorldPos.get(Hips).y;
let lowestBindY = hipsBindY;
for (const bone of mappedBones) lowestBindY = Math.min(lowestBindY, bindWorldPos.get(bone).y);
const S = (hipsBindY - lowestBindY) / ARDY_NEUTRAL_TOE;

// cskel27 indices of the mapped bones, per the skinning map.
const boneJoint = new Map([
	[Hips, "Hips"], [Spine, "Spine1"], [Spine1, "Spine2"], [Spine2, "Spine3"],
	[RightUpLeg, "RightUpLeg"], [RightLeg, "RightLeg"], [RightFoot, "RightFoot"], [RightToeBase, "RightToeBase"],
]);

const resolved = motionBones(rig);
ok(
	"playback setup: skinning map resolves the RT spine shift and the hips",
	resolved[CSKEL27_JOINTS.indexOf("Hips")] === Hips &&
		resolved[CSKEL27_JOINTS.indexOf("Spine1")] === Spine &&
		resolved[CSKEL27_JOINTS.indexOf("Spine2")] === Spine1 &&
		resolved[CSKEL27_JOINTS.indexOf("Spine3")] === Spine2 &&
		resolved[CSKEL27_JOINTS.indexOf("Spine")] === null &&
		resolved[CSKEL27_JOINTS.indexOf("RightToeBase")] === RightToeBase,
	`Spine->${resolved[CSKEL27_JOINTS.indexOf("Spine1")]?.name} Spine1->${resolved[CSKEL27_JOINTS.indexOf("Spine2")]?.name}`
);

// Two-frame motion. Frame 0: identity locals + the floor-shifted neutral
// pose (the rig must come out at its exact bind — zero pop into playback).
// Frame 1: hips rotY(90) with the same joint positions (offsets must be
// rotated by the joint's global rotation).
const JOINTS = CSKEL27_JOINTS.length;
const rotMats = new Float32Array(2 * JOINTS * 9);
for (let i = 0; i < rotMats.length; i += 9) {
	rotMats[i] = 1;
	rotMats[i + 4] = 1;
	rotMats[i + 8] = 1;
}
// frame 1 hips: rotY(90), row-major [[0,0,1],[0,1,0],[-1,0,0]].
const hipsRotBase = (JOINTS + 0) * 9;
rotMats[hipsRotBase + 2] = 1;
rotMats[hipsRotBase + 4] = 1;
rotMats[hipsRotBase + 6] = -1;
rotMats[hipsRotBase + 0] = 0;
rotMats[hipsRotBase + 8] = 0;

const posedJoints = new Float32Array(2 * JOINTS * 3);
for (let f = 0; f < 2; f += 1) {
	for (let j = 0; j < JOINTS; j += 1) {
		const n = CSKEL27_NEUTRAL[j];
		posedJoints[(f * JOINTS + j) * 3] = Math.fround(n[0]);
		posedJoints[(f * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE);
		posedJoints[(f * JOINTS + j) * 3 + 2] = Math.fround(n[2]);
	}
}
const rootPos = new Float32Array([0, Math.fround(ARDY_NEUTRAL_TOE), 0, 0, Math.fround(ARDY_NEUTRAL_TOE), 0]);
const motion = { frames: 2, fps: 30, rotMats, rootPos, posedJoints, anchorFrame: 0 };

// Snapshot at bind, then play frame 0: the rig must not move (zero pop).
const snapshot = snapshotPlaybackBones(rig);
applyMotionFrame(rig, motion, 0);
rig.updateMatrixWorld(true);
let popErr = 0;
let popQuatErr = 0;
for (const bone of mappedBones) {
	popErr = Math.max(popErr, bone.getWorldPosition(new THREE.Vector3()).distanceTo(bindWorldPos.get(bone)));
	popQuatErr = Math.max(popQuatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), bindWorldQuat.get(bone)));
}
ok(
	"playback: neutral frame reproduces the bind pose exactly (zero pop)",
	popErr < 1e-3 && popQuatErr < 1e-4,
	`max pos err ${popErr.toExponential(2)}, max quat err ${popQuatErr.toExponential(2)}`
);

// Frame 1: every mapped bone's world transform must equal the independently
// computed skinning target with global rotation rotY(90).
applyMotionFrame(rig, motion, 1);
rig.updateMatrixWorld(true);
const qGlobal = rotAxis(0, 1, 0, Math.PI / 2);
let posErr = 0;
let quatErr = 0;
let worstBone = "";
for (const bone of mappedBones) {
	const j = CSKEL27_JOINTS.indexOf(boneJoint.get(bone));
	const n = CSKEL27_NEUTRAL[j];
	const offset = bindWorldPos.get(bone).clone().sub(new THREE.Vector3(
		S * n[0],
		S * (n[1] + ARDY_NEUTRAL_TOE),
		S * n[2],
	));
	const expected = new THREE.Vector3(
		S * Math.fround(n[0]),
		S * Math.fround(n[1] + ARDY_NEUTRAL_TOE),
		S * Math.fround(n[2]),
	).add(offset.applyQuaternion(qGlobal));
	const got = bone.getWorldPosition(new THREE.Vector3());
	const err = got.distanceTo(expected);
	if (err > posErr) { posErr = err; worstBone = bone.name; }
	const expectedQuat = qGlobal.clone().multiply(bindWorldQuat.get(bone));
	quatErr = Math.max(quatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), expectedQuat));
}
ok(
	"playback: skinned world positions match s*posed + R@offset (all 8 bones)",
	posErr < 2e-3,
	`max pos err ${posErr.toExponential(2)} at ${worstBone} (scale ${S.toFixed(3)})`
);
ok(
	"playback: skinned world quaternions match R @ bindQuat (all 8 bones)",
	quatErr < 1e-4,
	`max quat err ${quatErr.toExponential(2)}`
);

// Restore must reproduce the pre-playback transforms bitwise (positions
// included: positional skinning drives bone translations).
restorePlaybackBones(rig, snapshot);
ok(
	"playback: restore reproduces pre-playback transforms exactly",
	mappedBones.every((bone) =>
		bone.quaternion.equals(bindLocalQuat.get(bone)) && bone.position.equals(bindLocalPos.get(bone))
	),
	`bones=${mappedBones.length} bitwise`
);

/* --- 3. root path authoring and ARDY coordinate contract -------------------- */

const sceneWaypoints = [
	{ frame: 0, x: 3.5, z: -2, heading: null },
	{ frame: 40, x: 4, z: -3.25, heading: null },
	{ frame: 79, x: 5.5, z: -3, heading: null },
];
const ardyWaypoints = toArdyWaypoints(sceneWaypoints);
ok(
	"waypoints: scene path is rebased to ARDY clip-local coordinates",
	JSON.stringify(ardyWaypoints) ===
		JSON.stringify([
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 40, x: 0.5, z: -1.25, heading: null },
			{ frame: 79, x: 2, z: -1, heading: null },
		]),
	JSON.stringify(ardyWaypoints),
);
const rotatedArdyWaypoints = toArdyWaypoints(sceneWaypoints, 90);
ok(
	"waypoints: player rotation is removed before ARDY generation",
	Math.abs(rotatedArdyWaypoints[1].x - 1.25) < 1e-9 &&
		Math.abs(rotatedArdyWaypoints[1].z - 0.5) < 1e-9 &&
		Math.abs(rotatedArdyWaypoints[2].x - 1) < 1e-9 &&
		Math.abs(rotatedArdyWaypoints[2].z - 2) < 1e-9,
	JSON.stringify(rotatedArdyWaypoints),
);
const restoredSceneOffset = toSceneRootOffset(rotatedArdyWaypoints[1].x, rotatedArdyWaypoints[1].z, 90);
ok(
	"waypoints: playback rotation restores the exact authored scene offset",
	Math.abs(restoredSceneOffset.x - 0.5) < 1e-9 &&
		Math.abs(restoredSceneOffset.z + 1.25) < 1e-9,
	JSON.stringify(restoredSceneOffset),
);
ok(
	"waypoints: local conversion does not mutate the authored scene path",
	sceneWaypoints[0].x === 3.5 && sceneWaypoints[2].z === -3,
);
const densePath = densifyArdyWaypoints(sceneWaypoints);
const denseFrames = densePath.map((point) => point.frame);
const denseFrame40 = densePath.find((point) => point.frame === 40);
ok(
	"waypoints: densified path starts at frame 0, ascending, ≤32 points, keeps authored frames",
	densePath.length >= 3 &&
		densePath.length <= 32 &&
		densePath[0].frame === 0 &&
		densePath.every((point, i) => i === 0 || point.frame > densePath[i - 1].frame) &&
		[0, 40, 79].every((frame) => denseFrames.includes(frame)) &&
		denseFrame40 !== undefined &&
		Math.abs(denseFrame40.x - 0.5) < 1e-9 &&
		Math.abs(denseFrame40.z + 1.25) < 1e-9,
	`count=${densePath.length} frames=[${denseFrames.join(",")}]`,
);
ok(
	"waypoints: densified headings are finite numbers in [-2π, 2π], never null",
	densePath.every(
		(point) =>
			point.heading !== null && Number.isFinite(point.heading) && Math.abs(point.heading) <= 2 * Math.PI,
	),
	`first=${densePath[0].heading} last=${densePath[densePath.length - 1].heading}`,
);
ok(
	"waypoints: densify does not mutate the authored scene path",
	sceneWaypoints[0].x === 3.5 &&
		sceneWaypoints[0].z === -2 &&
		sceneWaypoints[2].x === 5.5 &&
		sceneWaypoints[2].z === -3,
);
/** Absolute angular distance, both angles wrapped onto the same circle. */
const angleDiff = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
const straightPath = densifyArdyWaypoints([
	{ frame: 0, x: 0, z: 0 },
	{ frame: 30, x: 0, z: 5 },
	{ frame: 60, x: 0, z: 10 },
]);
ok(
	"waypoints: default density preserves the authored 0.4-second cadence at 24 fps",
	straightPath.map((point) => point.frame).join(",") === "0,10,20,30,40,50,60",
	`frames=[${straightPath.map((point) => point.frame).join(",")}]`,
);
ok(
	"waypoints: straight +Z path faces its travel direction (heading ≈ 0)",
	straightPath.length >= 3 &&
		straightPath.every((point) => angleDiff(point.heading, 0) < 1e-9 && point.x === 0),
	`count=${straightPath.length} headings=[${straightPath.map((point) => point.heading).join(",")}]`,
);
const lPath = densifyArdyWaypoints(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 20, x: 0, z: 5 },
		{ frame: 40, x: 5, z: 5 },
	],
	0,
	64,
);
const lCorner = lPath.find((point) => point.frame === 20);
const lHeadings = lPath.map((point) => point.heading);
// The C1 resampler turns a corner into one continuous arc: a symmetric L
// still crosses its corner at exactly the bisector, the headings sweep
// monotonically from one segment direction to the other, and the ends stay
// near their segments (a small anticipatory bend is the arc starting early
// — pinning every heading to its segment is what caused the corner hitch).
ok(
	"waypoints: L-corner turns as one continuous monotonic arc",
	lCorner !== undefined &&
		angleDiff(lCorner.heading, Math.PI / 4) < 1e-9 &&
		lHeadings.every((heading, i) => i === 0 || heading >= lHeadings[i - 1] - 1e-9) &&
		angleDiff(lHeadings[0], 0) < 0.35 &&
		angleDiff(lHeadings[lHeadings.length - 1], Math.PI / 2) < 0.35,
	`corner=${lCorner?.heading} headings=[${lHeadings.map((h) => h.toFixed(3)).join(",")}]`,
);
const rotatedDensePath = densifyArdyWaypoints(sceneWaypoints, 90, 96);
const rotatedDense40 = rotatedDensePath.find((point) => point.frame === 40);
const rotatedDense79 = rotatedDensePath.find((point) => point.frame === 79);
const rotatedSeg1 = Math.atan2(
	rotatedArdyWaypoints[1].x - rotatedArdyWaypoints[0].x,
	rotatedArdyWaypoints[1].z - rotatedArdyWaypoints[0].z,
);
const rotatedSeg2 = Math.atan2(
	rotatedArdyWaypoints[2].x - rotatedArdyWaypoints[1].x,
	rotatedArdyWaypoints[2].z - rotatedArdyWaypoints[1].z,
);
// Actor rotation is rigid: the rotated resample must be the unrotated one
// turned by exactly -90° — same frames, positions, and headings.
const unrotatedDensePath = densifyArdyWaypoints(sceneWaypoints, 0, 96);
ok(
	"waypoints: actor rotation 90 is removed rigidly from coordinates and headings",
	rotatedDense40 !== undefined &&
		rotatedDense79 !== undefined &&
		rotatedDensePath[0].frame === 0 &&
		Math.abs(rotatedDensePath[0].x) < 1e-9 &&
		Math.abs(rotatedDensePath[0].z) < 1e-9 &&
		Math.abs(rotatedDense40.x - rotatedArdyWaypoints[1].x) < 1e-9 &&
		Math.abs(rotatedDense40.z - rotatedArdyWaypoints[1].z) < 1e-9 &&
		Math.abs(rotatedDense79.x - rotatedArdyWaypoints[2].x) < 1e-9 &&
		Math.abs(rotatedDense79.z - rotatedArdyWaypoints[2].z) < 1e-9 &&
		rotatedDensePath.length === unrotatedDensePath.length &&
		rotatedDensePath.every((point, i) => {
			const base = unrotatedDensePath[i];
			return point.frame === base.frame && angleDiff(point.heading, base.heading - Math.PI / 2) < 1e-9;
		}),
	`seg1=${rotatedSeg1.toFixed(4)} seg2=${rotatedSeg2.toFixed(4)} count=${rotatedDensePath.length}`,
);
// With C1 corners the heading at an authored pin is no longer the raw
// velocity average — it is sampled from the arc — but it must still lie
// strictly inside the turn, between the two segment directions.
const rotatedTurn = angleDiff(rotatedSeg1, rotatedSeg2);
ok(
	"waypoints: densified corner heading lies inside the turn",
	rotatedDense40 !== undefined &&
		angleDiff(rotatedDense40.heading, rotatedSeg1) < rotatedTurn &&
		angleDiff(rotatedDense40.heading, rotatedSeg2) < rotatedTurn,
	`corner=${rotatedDense40?.heading} seg1=${rotatedSeg1.toFixed(4)} seg2=${rotatedSeg2.toFixed(4)}`,
);
const stallPath = densifyArdyWaypoints(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 10, x: 0, z: 0 },
		{ frame: 20, x: 5, z: 0 },
	],
	0,
	64,
);
ok(
	"waypoints: stalled segment keeps the previous heading until motion resumes",
	stallPath.filter((point) => point.frame < 10).every((point) => point.heading === 0) &&
		stallPath.filter((point) => point.frame > 10).every((point) => angleDiff(point.heading, Math.PI / 2) < 1e-9),
	`count=${stallPath.length}`,
);
const stationaryPath = densifyArdyWaypoints([
	{ frame: 0, x: 2, z: 3 },
	{ frame: 10, x: 2, z: 3 },
]);
ok(
	"waypoints: fully stationary path has heading 0 everywhere",
	stationaryPath.length >= 2 && stationaryPath.every((point) => point.heading === 0),
	`count=${stationaryPath.length}`,
);
const alignedPath = alignArdyPath(sceneWaypoints);
const alignedSecond = alignedPath.waypoints[1];
const alignedFrame40 = alignedPath.waypoints.find((point) => point.frame === 40);
const restoredAligned40 = toSceneRootOffset(alignedFrame40.x, alignedFrame40.z, alignedPath.rotationDeg);
ok(
	"waypoints: alignArdyPath starts with heading 0 and +Z progress",
	alignedPath.waypoints[0].frame === 0 &&
		alignedPath.waypoints[0].heading !== null &&
		angleDiff(alignedPath.waypoints[0].heading, 0) < 1e-9 &&
		alignedSecond !== undefined &&
		Math.abs(alignedSecond.x) < 1e-9 &&
		alignedSecond.z > 0,
	`rotation=${alignedPath.rotationDeg} firstHeading=${alignedPath.waypoints[0].heading} second=(${alignedSecond.x}, ${alignedSecond.z})`,
);
ok(
	"waypoints: alignArdyPath rotation round-trips frame 40 to the scene offset",
	alignedFrame40 !== undefined &&
		Math.abs(restoredAligned40.x - 0.5) < 1e-9 &&
		Math.abs(restoredAligned40.z + 1.25) < 1e-9,
	`rotation=${alignedPath.rotationDeg} restored=(${restoredAligned40.x}, ${restoredAligned40.z})`,
);
const aligned90Path = alignArdyPath(sceneWaypoints, 90);
const aligned90Second = aligned90Path.waypoints[1];
const aligned90Frame40 = aligned90Path.waypoints.find((point) => point.frame === 40);
const restoredAligned90 = toSceneRootOffset(aligned90Frame40.x, aligned90Frame40.z, aligned90Path.rotationDeg);
ok(
	"waypoints: alignArdyPath with actor rotation 90 still starts at heading 0 and round-trips",
	aligned90Path.waypoints[0].heading !== null &&
		angleDiff(aligned90Path.waypoints[0].heading, 0) < 1e-9 &&
		aligned90Second !== undefined &&
		Math.abs(aligned90Second.x) < 1e-9 &&
		aligned90Second.z > 0 &&
		aligned90Frame40 !== undefined &&
		Math.abs(restoredAligned90.x - 0.5) < 1e-9 &&
		Math.abs(restoredAligned90.z + 1.25) < 1e-9,
	`rotation=${aligned90Path.rotationDeg} firstHeading=${aligned90Path.waypoints[0].heading} restored=(${restoredAligned90.x}, ${restoredAligned90.z})`,
);
/* -------------------------------------------------- path limit judges --- */
// The 16 s / frame-219 incident, exactly as authored: leg 2 crawls at
// 0.26 m/s and the clip overruns ARDY's 10 s trained window. Both must be
// reported as errors, with the long unconstrained tail warned about.
const incident = judgeAuthoredPath(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 180, x: 0, z: 4.9 },
		{ frame: 219, x: 0.2, z: 5.4 },
	],
	20,
	320,
);
ok(
	"limits: the frame-219 incident is rejected for crawl speed and window overrun",
	incident.errors.length === 2 &&
		incident.errors.some((error) => error.includes("below a sustainable walk")) &&
		incident.errors.some((error) => error.includes(`${PATH_LIMITS.clipMaxS} s`)),
	JSON.stringify(incident.errors),
);
// A prompt schedule chains the rollout block by block, so the same 16 s clip
// keeps the crawl-speed error but LOSES the whole-clip window error — the
// trained window binds each chained call, not the total (the bridge and the
// sequence generator cap the blocks).
const incidentChained = judgeAuthoredPath(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 180, x: 0, z: 4.9 },
		{ frame: 219, x: 0.2, z: 5.4 },
	],
	20,
	320,
	{ chained: true },
);
ok(
	"limits: a chained rollout drops the whole-clip window error but keeps speed errors",
	incidentChained.errors.length === 1 &&
		incidentChained.errors.some((error) => error.includes("below a sustainable walk")) &&
		!incidentChained.errors.some((error) => error.includes(`${PATH_LIMITS.clipMaxS} s`)),
	JSON.stringify(incidentChained.errors),
);
const longCleanChained = judgeAuthoredPath(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 140, x: 0, z: 7 },
		{ frame: 300, x: 5, z: 10 },
	],
	20,
	320,
	{ chained: true },
);
ok(
	"limits: a natural 16 s path is legal when the rollout is chained",
	longCleanChained.errors.length === 0,
	JSON.stringify(longCleanChained.errors),
);
const slowVerdict = judgeNextWaypoint({ frame: 0, x: 0, z: 0 }, { frame: 39, x: 0, z: 0.5 }, 20);
ok(
	"limits: a sub-gait pin is blocked and the fix names a workable frame",
	!slowVerdict.ok && /below a sustainable walk/.test(slowVerdict.error) && /frame ~8/.test(slowVerdict.error),
	slowVerdict.error,
);
const fastVerdict = judgeNextWaypoint({ frame: 0, x: 0, z: 0 }, { frame: 8, x: 0, z: 5 }, 20);
ok(
	"limits: a superhuman pin is blocked with the earliest legal frame",
	!fastVerdict.ok && /faster than anyone moves/.test(fastVerdict.error) && /frame 34/.test(fastVerdict.error),
	fastVerdict.error,
);
const gapVerdict = judgeNextWaypoint({ frame: 40, x: 0, z: 0 }, { frame: 44, x: 0, z: 0.3 }, 20);
ok(
	"limits: pins closer than the rail gap are blocked",
	!gapVerdict.ok && /8 frames/.test(gapVerdict.error),
	gapVerdict.error,
);
ok(
	"limits: a hold (same spot, any duration) is legal",
	judgeNextWaypoint({ frame: 0, x: 1, z: 1 }, { frame: 120, x: 1.01, z: 1 }, 20).ok,
);
ok(
	"limits: a natural walking leg passes clean",
	(() => {
		const verdict = judgeNextWaypoint({ frame: 0, x: 0, z: 0 }, { frame: 20, x: 0, z: 1.4 }, 20);
		return verdict.ok && verdict.warnings.length === 0;
	})(),
);
const ratioVerdict = judgeNextWaypoint(
	{ frame: 40, x: 0, z: 2 },
	{ frame: 60, x: 0, z: 4.8 },
	20,
	{ frame: 0, x: 0, z: 0 },
);
ok(
	"limits: a >2x pace change places with a gait-shift warning",
	ratioVerdict.ok && ratioVerdict.warnings.some((warning) => warning.includes("speed change")),
	JSON.stringify(ratioVerdict.warnings),
);
const turnVerdict = judgeNextWaypoint(
	{ frame: 40, x: 0, z: 2.8 },
	{ frame: 50, x: 0.7, z: 2.8 },
	20,
	{ frame: 0, x: 0, z: 0 },
);
ok(
	"limits: a sharp turn places with a turn-rate warning",
	turnVerdict.ok && turnVerdict.warnings.some((warning) => warning.includes("turn")),
	JSON.stringify(turnVerdict.warnings),
);
const cleanPath = judgeAuthoredPath(
	[
		{ frame: 0, x: 0, z: 0 },
		{ frame: 70, x: 0, z: 4.9 },
		{ frame: 180, x: 3, z: 7 },
	],
	20,
	200,
);
ok(
	"limits: a natural 10 s path passes with no errors",
	cleanPath.errors.length === 0,
	JSON.stringify(cleanPath.errors),
);

const stationaryAlignInput = [
	{ frame: 0, x: 2, z: 3 },
	{ frame: 10, x: 2, z: 3 },
];
const alignedStationary = alignArdyPath(stationaryAlignInput);
const alignedStationary90 = alignArdyPath(stationaryAlignInput, 90);
const alignedSingleton = alignArdyPath([{ frame: 0, x: 2, z: 3 }], 45);
ok(
	"waypoints: alignArdyPath keeps the actor rotation on stationary or short paths",
	alignedStationary.rotationDeg === 0 &&
		alignedStationary90.rotationDeg === 90 &&
		alignedSingleton.rotationDeg === 45 &&
		alignedSingleton.waypoints.length === 0,
	`rot0=${alignedStationary.rotationDeg} rot90=${alignedStationary90.rotationDeg} singleton=${alignedSingleton.rotationDeg} singletonPoints=${alignedSingleton.waypoints.length}`,
);
ok(
	"waypoints: path generation aligns the full-body pose with frame-zero root",
	poseConstraintFrame(40, 80, true) === 0 &&
		poseConstraintFrame(40, 80, false) === 40 &&
		poseConstraintFrame(200, 80, false) === 79,
);
const firstPosition = defaultWaypointPosition([], { x: 2, z: 3, rot: 0 });
const secondPosition = defaultWaypointPosition([{ frame: 0, x: 2, z: 3 }], { x: 2, z: 3, rot: 0 });
const thirdPosition = defaultWaypointPosition(
	[
		{ frame: 0, x: 2, z: 3 },
		{ frame: 40, x: 2, z: 2 },
	],
	{ x: 2, z: 3, rot: 0 },
);
ok(
	"waypoints: new numbered markers are immediately separated and draggable",
	firstPosition.x === 2 &&
		firstPosition.z === 3 &&
		secondPosition.x === 2 &&
		secondPosition.z === 4 &&
		thirdPosition.x === 2 &&
		thirdPosition.z === 1,
);
console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
