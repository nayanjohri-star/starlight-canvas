/**
 * read-npz.mjs — minimal numpy .npz reader for Kimodo generation output.
 *
 * tools/ardy/npz.mjs writes npz files and src/ardy/npz.js decodes the cclay
 * MOTION npz, but that decoder is bound to the 27-joint cclay contract (member
 * set, joint count, browser DecompressionStream). Kimodo writes a somaskel77
 * file with a different member set, so reading it needs a plain reader that
 * returns members verbatim and leaves interpretation to the caller.
 *
 * `np.savez` writes STORED entries and `np.savez_compressed` writes DEFLATE;
 * both are accepted so the reader does not depend on which one Kimodo uses.
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_LOCAL_SIG = 0x04034b50;
const NPY_MAGIC = "\x93NUMPY";

/** Element readers by numpy dtype string. Little-endian only, which is what
 * numpy writes on every platform CozyClay runs generation on. */
const DTYPES = {
	"<f4": { bytes: 4, read: (buf, off) => buf.readFloatLE(off) },
	"<f8": { bytes: 8, read: (buf, off) => buf.readDoubleLE(off) },
	"<i4": { bytes: 4, read: (buf, off) => buf.readInt32LE(off) },
	"<i8": { bytes: 8, read: (buf, off) => Number(buf.readBigInt64LE(off)) },
	"<u4": { bytes: 4, read: (buf, off) => buf.readUInt32LE(off) },
	"|b1": { bytes: 1, read: (buf, off) => buf.readUInt8(off) },
	"|i1": { bytes: 1, read: (buf, off) => buf.readInt8(off) },
};

function findEocd(buf) {
	// The comment field is variable-length, so the EOCD is found by scanning
	// back from the end for its signature.
	for (let offset = buf.length - 22; offset >= 0; offset -= 1) {
		if (buf.readUInt32LE(offset) === ZIP_EOCD_SIG) return offset;
	}
	throw new Error("readNpz: not a zip archive (no end-of-central-directory record)");
}

function unzip(buf) {
	const eocd = findEocd(buf);
	const entryCount = buf.readUInt16LE(eocd + 10);
	let cursor = buf.readUInt32LE(eocd + 16);
	const files = new Map();
	for (let index = 0; index < entryCount; index += 1) {
		const method = buf.readUInt16LE(cursor + 10);
		const compressedSize = buf.readUInt32LE(cursor + 20);
		const nameLength = buf.readUInt16LE(cursor + 28);
		const extraLength = buf.readUInt16LE(cursor + 30);
		const commentLength = buf.readUInt16LE(cursor + 32);
		const localOffset = buf.readUInt32LE(cursor + 42);
		const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLength);

		if (buf.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
			throw new Error(`readNpz: bad local header for ${name}`);
		}
		// The local header repeats the name/extra lengths and they may differ
		// from the central directory's, so the payload offset is taken here.
		const localNameLength = buf.readUInt16LE(localOffset + 26);
		const localExtraLength = buf.readUInt16LE(localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		const payload = buf.subarray(start, start + compressedSize);

		if (method === 0) files.set(name, payload);
		else if (method === 8) files.set(name, inflateRawSync(payload));
		else throw new Error(`readNpz: unsupported zip compression method ${method} for ${name}`);

		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}

function parseNpy(buf, label) {
	if (buf.toString("latin1", 0, 6) !== NPY_MAGIC) {
		throw new Error(`readNpz: ${label} is not a .npy payload`);
	}
	const major = buf.readUInt8(6);
	const headerLength = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
	const headerStart = major === 1 ? 10 : 12;
	const header = buf.toString("latin1", headerStart, headerStart + headerLength);

	const descr = /'descr'\s*:\s*'([^']+)'/.exec(header);
	const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header);
	const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
	if (!descr || !fortran || !shapeText) {
		throw new Error(`readNpz: ${label} has an unreadable .npy header`);
	}
	if (fortran[1] === "True") {
		throw new Error(`readNpz: ${label} is Fortran-ordered; only C order is supported`);
	}
	const shape = shapeText[1]
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => {
			const value = Number(part);
			if (!Number.isInteger(value) || value < 0) {
				throw new Error(`readNpz: ${label} has a bad shape entry ${part}`);
			}
			return value;
		});

	const dtype = DTYPES[descr[1]];
	// A member this reader cannot type is reported, not thrown: real motion npz
	// files carry non-numeric members alongside the arrays (ARDY writes the
	// prompt as a `text` member with a unicode dtype), and refusing the whole
	// archive over one of them would make a readable file unreadable. Callers
	// that NEED a member still fail, in readKimodoMotion, by name.
	if (!dtype) return { dtype: descr[1], shape, data: null, unsupported: true };

	const count = shape.reduce((total, dim) => total * dim, 1);
	const body = buf.subarray(headerStart + headerLength);
	if (body.length < count * dtype.bytes) {
		throw new Error(
			`readNpz: ${label} is truncated (need ${count * dtype.bytes} bytes, have ${body.length})`
		);
	}
	const data = new Float32Array(count);
	for (let index = 0; index < count; index += 1) {
		data[index] = dtype.read(body, index * dtype.bytes);
	}
	return { dtype: descr[1], shape, data };
}

/**
 * Read an .npz into `{ [name]: { dtype, shape, data: Float32Array } }`.
 * Values are widened to Float32Array so every member reads the same way;
 * int64 members (numpy's default for a python int, e.g. `fps`) are exact for
 * every magnitude this pipeline uses.
 */
export function readNpz(path) {
	const files = unzip(readFileSync(path));
	const members = {};
	for (const [name, payload] of files) {
		if (!name.endsWith(".npy")) continue;
		members[name.slice(0, -4)] = parseNpy(payload, name);
	}
	if (Object.keys(members).length === 0) {
		throw new Error(`readNpz: ${path} contains no .npy members`);
	}
	return members;
}

/**
 * Pull the arrays soma77ToCskel27Motion needs out of a Kimodo motion npz.
 * Kimodo writes `posed_joints [T,J,3]`, `global_rot_mats [T,J,3,3]` and `fps`;
 * the joint count is read from the data rather than assumed so a G1 or SMPL-X
 * file fails with a clear message instead of silently misreading.
 */
export function readKimodoMotion(path, { expectedJoints = 77 } = {}) {
	const members = readNpz(path);
	for (const required of ["posed_joints", "global_rot_mats"]) {
		if (!members[required]) {
			throw new Error(`readKimodoMotion: ${path} is missing ${required}`);
		}
		if (members[required].unsupported) {
			throw new Error(
				`readKimodoMotion: ${path} stores ${required} as unsupported dtype ${members[required].dtype}`
			);
		}
	}
	const posed = members.posed_joints;
	const rots = members.global_rot_mats;
	if (posed.shape.length !== 3 || posed.shape[2] !== 3) {
		throw new Error(`readKimodoMotion: posed_joints must be [T,J,3], got [${posed.shape}]`);
	}
	if (rots.shape.length !== 4 || rots.shape[2] !== 3 || rots.shape[3] !== 3) {
		throw new Error(`readKimodoMotion: global_rot_mats must be [T,J,3,3], got [${rots.shape}]`);
	}
	const [frames, joints] = posed.shape;
	if (rots.shape[0] !== frames || rots.shape[1] !== joints) {
		throw new Error(
			`readKimodoMotion: posed_joints [${posed.shape}] and global_rot_mats [${rots.shape}] disagree`
		);
	}
	if (joints !== expectedJoints) {
		throw new Error(
			`readKimodoMotion: expected a ${expectedJoints}-joint skeleton, got ${joints}. ` +
				"Generate with a Kimodo-SOMA model — the G1 (34) and SMPL-X (22) skeletons are not supported."
		);
	}
	const fps = members.fps ? Math.round(members.fps.data[0]) : null;
	if (fps !== null && (!Number.isInteger(fps) || fps < 1)) {
		throw new Error(`readKimodoMotion: fps member is not a positive integer (${fps})`);
	}
	return { frames, joints, fps, posedJoints: posed.data, globalRotMats: rots.data };
}
