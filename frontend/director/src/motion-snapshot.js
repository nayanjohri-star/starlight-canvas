import { buildZip } from "./zip-store.js";
import { hash } from "fast-sha256";

// Browser-native, deterministic NPZ snapshots of the evaluated take. Keeping
// the actual arrays preserves staging/retiming/trail edits rather than merely
// saving the unedited source download. Existing NPZ validation reads them.
function npy(data, shape, integer = false) {
	const count = shape.reduce((a, b) => a * b, 1);
	if (data.length !== count) throw new TypeError("Motion snapshot array has invalid shape or numbers");
	for (let i = 0; i < count; i++) if (!Number.isFinite(data[i])) throw new TypeError("Motion snapshot array has invalid shape or numbers");
	const tuple = shape.length ? `(${shape.join(", ")}${shape.length === 1 ? "," : ""})` : "()";
	const header = `{'descr': '${integer ? "<i4" : "<f4"}', 'fortran_order': False, 'shape': ${tuple}, }`;
	const padding = (16 - ((10 + header.length + 1) % 16)) % 16;
	const encoded = new TextEncoder().encode(`${header}${" ".repeat(padding)}\n`);
	const bytes = new Uint8Array(10 + encoded.length + count * 4), view = new DataView(bytes.buffer);
	bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]); view.setUint16(8, encoded.length, true); bytes.set(encoded, 10);
	for (let i = 0; i < count; i++) view[integer ? "setInt32" : "setFloat32"](10 + encoded.length + i * 4, data[i], true);
	return bytes;
}

export function writeMotionSnapshot(take) {
	if (!Number.isInteger(take?.frames) || take.frames < 1 || !Number.isInteger(take.fps) || take.fps < 1) throw new TypeError("Motion snapshot requires positive integer frames and fps");
	const frames = take.frames;
	const entries = [
		{ name: "local_rot_mats.npy", data: npy(take.rotMats ?? [], [frames, 27, 3, 3]) },
		{ name: "root_positions.npy", data: npy(take.rootPos ?? [], [frames, 3]) },
		{ name: "posed_joints.npy", data: npy(take.posedJoints ?? [], [frames, 27, 3]) },
		{ name: "fps.npy", data: npy([take.fps], [], true) },
	];
	if (take.personScale != null) entries.push({ name: "person_scale.npy", data: npy([take.personScale], []) });
	if (take.boneScale != null) entries.push({ name: "bone_scale.npy", data: npy(take.boneScale, [27]) });
	return buildZip(entries);
}

export function motionSnapshotRecord(take) {
	const bytes = writeMotionSnapshot(take);
	const motionId = [...hash(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return { motionId, encoding: 'base64', data: btoa(binary), bytes: bytes.length, frames: take.frames, fps: take.fps, meta: { personScale: take.personScale ?? 1 } };
}
