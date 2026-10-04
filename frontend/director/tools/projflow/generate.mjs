/**
 * generate.mjs — drive the ProjFlow line-edit driver on the configured box and
 * bring the result back as raw hml22 joint positions.
 *
 * Shaped after tools/kimodo/generate.mjs (ssh/scp helpers, error style, one
 * mkdtemp per run that the `finally` always removes), with one structural
 * difference stated up front: Kimodo ships a CLI and we only pass it flags, so
 * that module has no python of its own. ProjFlow ships two samplers and NEITHER
 * CLI can express a CozyClay line edit — the projflow inpainting sampler
 * preserves source frames but has no camera, the linear-constraint sampler takes
 * a general operator but its demo builds no preserve rows. Contract C7 therefore
 * puts a driver of ours on the box, and this module SHIPS it per run
 * (tools/projflow/driver.py), the same way the Kimodo wrapper ships constraint
 * JSONs. Nothing is installed on the box; the run directory is the whole
 * footprint.
 *
 * THE NUMBERS THIS MODULE DOES NOT COMPUTE. Every constraint row — the affine
 * perspective rows for the drawn line, the identity rows that freeze the rest of
 * the take — is built inside driver.py, because that is where the model's
 * normalisation stats and column layout live. This side does exactly three
 * things: validate the request hard enough that a malformed line never costs a
 * GPU round trip, move files, and read the result back.
 *
 * SEAM: THIS MODULE RETURNS 22-JOINT POSITIONS, NOT cskel27. ACMDM's "Raw"
 * family generates absolute coordinates with no rotation channel at all, so the
 * conversion to cskel27 has to LIFT rotations (aim-based bone frames + inherited
 * twist) rather than re-express them. That is contract C8 and agent M2's module,
 * tools/projflow/hml22-to-cskel27.mjs, which is in flight in parallel with this
 * one. It is deliberately NOT imported here: wave-2 integration composes
 * `lineEditOnBox(...).positions` with `hml22ToCskel27Motion(...)`, so the two
 * modules can land independently and this one stays testable without a
 * converter. Do not add the import until that module exists.
 *
 * FRAME CLOCKS. `line.frameRange` is in GENERATION frames at 20 fps, which is
 * what the model samples and what driver.py indexes. The app's clip frames (24
 * fps) are converted upstream, in the bridge — the same split Kimodo uses, where
 * generate.mjs owns the generation clock and the bridge owns the app clock.
 * There is no conversion in this file, on purpose: two places computing the same
 * frame index is exactly how they drift.
 *
 * TWO ROUTES, ONE FUNCTION (contract C11). `lineEditOnBox` first offers the
 * request to the RESIDENT service (service.mjs): a warm `driver.py --serve`
 * child that already holds the checkpoint, which removes the 3.9 s model load
 * that gate GP3 measured as half of an 8 s round trip. If anything at all goes
 * wrong with that child — it is not up, it dies, it answers late, it answers
 * with the wrong id, it refuses the request — the request runs down the COLD
 * path below, unchanged, which is the contract of record. The cold path does
 * not know the resident exists and never will; that is what makes the fallback
 * trustworthy rather than a second implementation to keep in sync.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// `resolve` is aliased: the promise executor in `run` below binds its own
// `resolve`, and a path helper shadowed by a promise callback is a trap.
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getResidentService, residentEnabled, residentLineEdit } from "./service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "driver.py");

const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=240",
];

/** S1 measured the model at 20 fps, (T,22,3) world metres. Not configurable:
 * it is a property of the checkpoint, not a preference. */
export const GEN_FPS = 20;
export const NUM_JOINTS = 22;

/** S1: 100 ODE steps for a final, 20 for a preview (0.95 s / 0.28 s measured on
 * a 196-frame take with ~3800 constraint rows). */
export const DEFAULT_STEPS = 100;
export const PREVIEW_STEPS = 20;

/** S1: ridge_lambda is the EXACTNESS knob, not steps. The repo ships 1e-3 and
 * lands at 2.6e-5; 1e-6 gives 2.4e-7 at half the steps. */
export const DEFAULT_RIDGE = 1e-6;

/**
 * CozyClay IK track id -> hml22 joint index. THE authoring source; driver.py
 * carries the same table purely as a guard and errors if the two disagree, so a
 * wrapper that drifts fails loudly on the box instead of editing the wrong limb.
 *
 * Composed from two documented hops: track -> cskel27 target (src/ardy/ik.js's
 * own IK_TRACKS/MID_TRACKS/FK_TRACKS) -> hml22 source (S2's mapping table).
 * Three entries look like typos and are not:
 *   - `leftFoot` is cskel27 LeftFoot, whose hml22 source is left_ANKLE (7).
 *     hml22's `left_foot` (10) is the TOE BASE — S2's naming trap.
 *   - `leftShoulder` is the CLAVICLE, so left_collar (13), not left_shoulder
 *     (16, which is the upper-arm root and is cskel27's LeftArm).
 *   - a MID-JOINT track constrains its OWN joint (leftElbow -> 18), not its
 *     chain's effector. The artist dragged the elbow handle and drew the
 *     elbow's path; pinning the wrist instead would follow the line with the
 *     wrong joint and leave the elbow wherever the model liked.
 */
export const TRACK_TO_HML22_JOINT = Object.freeze({
	leftHand: 20,
	rightHand: 21,
	leftFoot: 7,
	rightFoot: 8,
	leftElbow: 18,
	rightElbow: 19,
	leftKnee: 4,
	rightKnee: 5,
	hips: 0,
	spine: 6,
	neck: 12,
	head: 15,
	leftShoulder: 13,
	rightShoulder: 14,
});

/**
 * The line-edit tracks with no hml22 joint behind them, with the reason.
 *
 * `chest` is cskel27 Spine2 and Spine2 is one of S2's five FILLED joints:
 * cskel27 has three spine links between Hips and Spine3 where hml22 has two, so
 * there is literally no source joint to constrain. Refused by name rather than
 * retargeted onto a neighbouring spine joint, which would put the drawn line on
 * a curve the artist did not draw.
 *
 * TRACK_TO_HML22_JOINT + UNMAPPABLE_TRACKS covers all 15 pose-studio tracks;
 * test/verify-projflow-runner.mjs asserts that totality against ik.js itself.
 */
export const UNMAPPABLE_TRACKS = Object.freeze({
	chest: "cskel27 Spine2 has no hml22 source joint (S2: a FILLED joint)",
});

function run(argv, { timeoutMs = 3_600_000, onLine } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (onLine) for (const line of String(chunk).split("\n")) if (line.trim()) onLine(line);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (onLine) for (const line of String(chunk).split("\n")) if (line.trim()) onLine(line);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** hml22 joint for an IK track id, or a named refusal. */
export function trackToJoint(track) {
	if (typeof track !== "string" || !track) {
		throw new Error("lineEdit: track must be a non-empty IK track id");
	}
	if (Object.hasOwn(UNMAPPABLE_TRACKS, track)) {
		throw new Error(`lineEdit: track "${track}" cannot be line-edited: ${UNMAPPABLE_TRACKS[track]}`);
	}
	const joint = TRACK_TO_HML22_JOINT[track];
	if (joint === undefined) {
		throw new Error(
			`lineEdit: unknown track "${track}"; known line-edit tracks: ${Object.keys(TRACK_TO_HML22_JOINT).sort().join(", ")}`
		);
	}
	return joint;
}

/**
 * Validate a C6 line-edit request and return the exact document driver.py reads.
 *
 * Every check here exists because the alternative is discovering it after a
 * 6-second ssh round trip and a model load. The geometry is NOT checked (whether
 * the drawn line is reachable is the model's problem — that is the whole point
 * of a zero-shot projection sampler), only the things that would make the
 * operator malformed or the request meaningless.
 */
export function buildLineRequest(line) {
	if (!line || typeof line !== "object" || Array.isArray(line)) {
		throw new Error("lineEdit: line must be an object");
	}
	const jointId = trackToJoint(line.track);
	if (line.jointId !== undefined && Number(line.jointId) !== jointId) {
		throw new Error(
			`lineEdit: jointId ${line.jointId} disagrees with track "${line.track}" -> joint ${jointId}`
		);
	}

	const range = line.frameRange;
	if (!range || typeof range !== "object") {
		throw new Error("lineEdit: frameRange {start, end} is required");
	}
	const start = Number(range.start);
	const end = Number(range.end);
	for (const [label, value] of [["start", start], ["end", end]]) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`lineEdit: frameRange.${label} must be a non-negative integer, got ${JSON.stringify(range[label])}`);
		}
	}
	// A one-frame range is two rows against one pose, which the sampler happily
	// solves and no artist ever means; a line needs somewhere to go.
	if (end <= start) {
		throw new Error(`lineEdit: frameRange must span at least two frames, got ${start}..${end}`);
	}

	// PINS take the whole rest of this function's job away. A pins edit carries
	// three identity rows per pin and no camera at all, so every check below —
	// the normalised-uv range, the pixel-focal-length trap, the R/t shape — is
	// about a field it does not have. Branching here rather than threading
	// `if (pins)` through each check keeps both readings of the request
	// self-contained, which is what makes the serialised request diffable.
	if (line.pins3d !== undefined) {
		if (line.points2d !== undefined || line.camera !== undefined) {
			throw new Error("lineEdit: a pins edit carries pins3d alone — no points2d, no camera");
		}
		const pins = line.pins3d;
		if (!Array.isArray(pins) || pins.length < 1) {
			throw new Error(`lineEdit: pins3d needs at least 1 pin, got ${Array.isArray(pins) ? pins.length : typeof pins}`);
		}
		let previous = -1;
		const pins3d = pins.map((pin, index) => {
			if (!pin || typeof pin !== "object" || !Number.isInteger(pin.frame)) {
				throw new Error(`lineEdit: pins3d[${index}] must be { frame: integer, position: [x, y, z] }`);
			}
			// GENERATION-clock frames by the time they reach here (line-edit-job
			// scales them), so the range they must sit inside is this request's.
			if (pin.frame < start || pin.frame > end) {
				throw new Error(`lineEdit: pins3d[${index}].frame ${pin.frame} is outside frameRange ${start}..${end}`);
			}
			if (pin.frame <= previous) {
				throw new Error(`lineEdit: pins3d frames must be strictly ascending, got ${pin.frame} after ${previous}`);
			}
			previous = pin.frame;
			if (!Array.isArray(pin.position) || pin.position.length !== 3) {
				throw new Error(`lineEdit: pins3d[${index}].position must be [x, y, z] world metres`);
			}
			const position = pin.position.map((value, axis) => {
				const number = Number(value);
				if (!Number.isFinite(number)) throw new Error(`lineEdit: pins3d[${index}].position[${axis}] must be finite`);
				return number;
			});
			return { frame: pin.frame, position };
		});
		return {
			track: line.track,
			jointId,
			frameRange: { start, end },
			pins3d,
			prompt: line.prompt === undefined || line.prompt === null ? "" : String(line.prompt),
		};
	}

	const points = line.points2d;
	if (!Array.isArray(points) || points.length < 2) {
		throw new Error(`lineEdit: points2d needs at least 2 points, got ${Array.isArray(points) ? points.length : typeof points}`);
	}
	const points2d = points.map((point, index) => {
		if (!Array.isArray(point) || point.length !== 2) {
			throw new Error(`lineEdit: points2d[${index}] must be [u, v]`);
		}
		const [u, v] = point.map(Number);
		if (!Number.isFinite(u) || !Number.isFinite(v)) {
			throw new Error(`lineEdit: points2d[${index}] must be two finite numbers, got ${JSON.stringify(point)}`);
		}
		// Viewport-normalised, per C6. Enforced rather than clamped: a point
		// outside the viewport is either a unit mix-up (pixels sent as
		// normalised) or a stroke the artist could not have seen, and both are
		// worth a message. The tolerance covers a stroke that grazed the edge.
		if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) {
			throw new Error(
				`lineEdit: points2d[${index}] = [${u}, ${v}] is outside the 0..1 normalised viewport; ` +
					"points2d and the camera intrinsics must both be in normalised units"
			);
		}
		return [u, v];
	});

	const camera = line.camera;
	if (!camera || typeof camera !== "object") {
		throw new Error("lineEdit: camera {fx, fy, cx, cy, R, t} is required");
	}
	const intrinsics = {};
	for (const key of ["fx", "fy", "cx", "cy"]) {
		const value = Number(camera[key]);
		if (!Number.isFinite(value)) {
			throw new Error(`lineEdit: camera.${key} must be a finite number, got ${JSON.stringify(camera[key])}`);
		}
		intrinsics[key] = value;
	}
	// A zero focal length collapses both rows of that axis to the depth row and
	// the normal matrix goes singular; the Cholesky failure on the box would name
	// LAPACK, not the camera.
	for (const key of ["fx", "fy"]) {
		if (intrinsics[key] === 0) throw new Error(`lineEdit: camera.${key} must be non-zero`);
	}
	// Intrinsics live in the SAME units as points2d (normalised 0..1). A pixel
	// focal length beside normalised points is the single most likely wire
	// mistake and it produces a plausible-looking but wrong line, so it is caught
	// by magnitude here rather than debugged from a bad take later.
	if (Math.abs(intrinsics.fx) > 50 || Math.abs(intrinsics.fy) > 50) {
		throw new Error(
			`lineEdit: camera.fx/fy look like PIXEL focal lengths (${intrinsics.fx}, ${intrinsics.fy}); ` +
				"they must be normalised by the viewport size, like points2d"
		);
	}
	if (!Array.isArray(camera.R) || camera.R.length !== 3 || camera.R.some((row) => !Array.isArray(row) || row.length !== 3)) {
		throw new Error("lineEdit: camera.R must be a 3x3 world-to-camera rotation");
	}
	const R = camera.R.map((row, i) => row.map((value, j) => {
		const number = Number(value);
		if (!Number.isFinite(number)) throw new Error(`lineEdit: camera.R[${i}][${j}] must be finite`);
		return number;
	}));
	if (!Array.isArray(camera.t) || camera.t.length !== 3) {
		throw new Error("lineEdit: camera.t must be a 3-vector (camera-space translation)");
	}
	const t = camera.t.map((value, i) => {
		const number = Number(value);
		if (!Number.isFinite(number)) throw new Error(`lineEdit: camera.t[${i}] must be finite`);
		return number;
	});

	const prompt = line.prompt === undefined || line.prompt === null ? "" : String(line.prompt);

	// Field order is fixed so two identical requests serialise byte-identically
	// and a run directory can be diffed.
	return {
		track: line.track,
		jointId,
		frameRange: { start, end },
		points2d,
		camera: { ...intrinsics, R, t },
		prompt,
	};
}

/**
 * Minimal reader for a numpy .npy v1/v2 array of little-endian float32 in C
 * order — which is what `np.save` writes for the driver's (T,22,3) output.
 *
 * tools/kimodo/read-npz.mjs has a reader for the same payload format, but it is
 * bound to the ZIP container `np.savez` produces and returns members by name.
 * ProjFlow writes a bare .npy, so the container layer does not apply; the header
 * grammar below is the same one, restated for the one dtype this path can
 * produce. Widening or Fortran order are refused rather than guessed: a silently
 * transposed motion is indistinguishable from a bad take.
 */
export function readNpyFloat32(path) {
	const buffer = readFileSync(path);
	if (buffer.toString("latin1", 0, 6) !== "\x93NUMPY") {
		throw new Error(`readNpyFloat32: ${path} is not a .npy file`);
	}
	const major = buffer.readUInt8(6);
	const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
	const headerStart = major === 1 ? 10 : 12;
	const header = buffer.toString("latin1", headerStart, headerStart + headerLength);

	const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
	const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
	const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
	if (!descr || !fortran || shapeText === undefined) {
		throw new Error(`readNpyFloat32: ${path} has an unreadable .npy header`);
	}
	if (descr !== "<f4") {
		throw new Error(`readNpyFloat32: ${path} has dtype ${descr}; the driver writes float32`);
	}
	if (fortran === "True") {
		throw new Error(`readNpyFloat32: ${path} is Fortran-ordered; only C order is supported`);
	}
	const shape = shapeText
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => {
			const value = Number(part);
			if (!Number.isInteger(value) || value < 0) {
				throw new Error(`readNpyFloat32: ${path} has a bad shape entry ${part}`);
			}
			return value;
		});

	const count = shape.reduce((total, dim) => total * dim, 1);
	const body = buffer.subarray(headerStart + headerLength);
	if (body.length < count * 4) {
		throw new Error(`readNpyFloat32: ${path} is truncated (need ${count * 4} bytes, have ${body.length})`);
	}
	// A copy, not a view: `buffer` is a pooled Node allocation whose byteOffset
	// need not be 4-aligned, which a Float32Array view over it would reject.
	const data = new Float32Array(count);
	for (let index = 0; index < count; index += 1) data[index] = body.readFloatLE(index * 4);
	return { shape, data };
}

/**
 * Write an hml22 (T,22,3) float32 .npy — the inverse of readNpyFloat32, and the
 * ONLY way to produce this module's own `sourceMotionNpy` input.
 *
 * It lives here rather than in the wave-2 composition layer because the header
 * grammar above is the contract with driver.py: a writer that padded or spelled
 * the dict differently would be a second, drifting definition of the same file
 * format, and the round trip readNpyFloat32(writeNpyFloat32(x)) is the cheapest
 * possible test of both. (tools/ardy/npz.mjs has the same 10-byte prefix inside
 * its ZIP builder, but it only ever emits ARCHIVES; a bare .npy is not one of
 * its outputs.)
 *
 * @param {string} path
 * @param {Float32Array} data C-order payload, shape.reduce(*) long
 * @param {number[]} shape
 */
export function writeNpyFloat32(path, data, shape) {
	if (!(data instanceof Float32Array)) {
		throw new Error("writeNpyFloat32: data must be a Float32Array");
	}
	if (!Array.isArray(shape) || shape.length === 0 || shape.some((dim) => !Number.isInteger(dim) || dim < 0)) {
		throw new Error(`writeNpyFloat32: shape must be non-negative integers, got ${JSON.stringify(shape)}`);
	}
	const count = shape.reduce((total, dim) => total * dim, 1);
	if (count !== data.length) {
		throw new Error(`writeNpyFloat32: shape (${shape.join(",")}) needs ${count} values, got ${data.length}`);
	}
	// A NaN reaching the box surfaces as a LAPACK failure inside the Cholesky,
	// which names neither the frame nor the joint; refuse it here instead.
	for (let index = 0; index < data.length; index += 1) {
		if (!Number.isFinite(data[index])) {
			throw new Error(`writeNpyFloat32: data[${index}] is ${data[index]}`);
		}
	}
	const tuple = `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
	const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${tuple}, }`;
	// numpy pads so that magic(6) + version(2) + length(2) + header is a multiple
	// of 64; the same convention tools/ardy/npz.mjs uses.
	const header = `${dict}${" ".repeat((53 - (dict.length % 64) + 64) % 64)}\n`;
	const prefix = Buffer.alloc(10);
	prefix.writeUInt8(0x93, 0);
	prefix.write("NUMPY", 1, "ascii");
	prefix.writeUInt8(1, 6);
	prefix.writeUInt8(0, 7);
	prefix.writeUInt16LE(header.length, 8);
	writeFileSync(
		path,
		Buffer.concat([prefix, Buffer.from(header, "ascii"), Buffer.from(data.buffer, data.byteOffset, data.byteLength)])
	);
}

/**
 * The warm route: hand the request to the resident child and shape its answer
 * like a cold run's.
 *
 * WHY IT MIRRORS THE COLD ARGV RATHER THAN IMPROVING ON IT. The cold path
 * resolves `preview` into a step count and passes `--steps 20`, never
 * `--preview`, so a cold preview's metadata says `preview: false`. This sends
 * exactly the same thing, because two routes that produce different metadata
 * for the same request would make every warm-vs-cold comparison (and gate GS1's
 * fallback proof) an argument about which one is right.
 *
 * `nativeOut` is written HERE rather than scp'd back, since the motion arrived
 * in memory. Same two files, same names, same contract: the raw hml22 .npy and
 * its .meta.json sidecar, which is what a LATER edit sources from.
 */
async function warmLineEdit({
	sourceMotionNpy,
	request,
	steps,
	ridge,
	preserveStride,
	preserveMargin,
	seamPin,
	seed,
	cfg,
	host,
	python,
	repo,
	boxHome,
	nativeOut,
	onLine,
	service,
}) {
	const { shape, data } = readNpyFloat32(sourceMotionNpy);
	if (shape.length !== 3 || shape[1] !== NUM_JOINTS || shape[2] !== 3) {
		throw new Error(`lineEditOnBox: sourceMotionNpy must be (T,22,3), got (${shape.join(",")})`);
	}
	const resident = service || getResidentService({ host, python, repo, boxHome });
	const warm = await residentLineEdit({
		service: resident,
		source: data,
		sourceShape: shape,
		line: request,
		steps,
		preview: false,
		ridge,
		preserveStride,
		preserveMargin,
		seamPin,
		seed,
		cfg,
		onLine,
	});
	if (warm.shape.length !== 3 || warm.shape[1] !== NUM_JOINTS || warm.shape[2] !== 3) {
		throw new Error(`lineEditOnBox: the resident returned a (${warm.shape.join(",")}) result, expected (T,22,3)`);
	}
	// The ONE key that is not in a cold run's metadata. It is worth the
	// asymmetry: without it a report cannot say whether an edit was warm, and
	// "how many edits fell back" is the number this contract is judged on.
	const meta = { ...warm.meta, resident: true };
	if (nativeOut) {
		writeNpyFloat32(nativeOut, warm.positions, warm.shape);
		writeFileSync(`${String(nativeOut).replace(/\.npy$/i, "")}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
	}
	return {
		positions: warm.positions,
		frames: warm.shape[0],
		joints: warm.shape[1],
		fps: GEN_FPS,
		meta,
		line: request,
		nativeNpy: nativeOut || null,
	};
}

/**
 * Run one line edit on the box.
 *
 * @param {object} options
 * @param {string} options.sourceMotionNpy local path to the source take as an
 *   hml22 (T,22,3) float32 .npy — the SAME format the driver writes, so the
 *   output of one edit is the input of the next.
 * @param {object} options.line a C6 line-edit request (see buildLineRequest).
 * @returns {Promise<{positions: Float32Array, frames: number, joints: number,
 *   fps: number, meta: object, line: object}>} `positions` is (frames*22*3) in
 *   C order, world metres, hml22 joint order. Converting to cskel27 is M2's
 *   module — see the seam note in the file header.
 */
export async function lineEditOnBox({
	sourceMotionNpy,
	line,
	// 100 final / 20 preview (contract C7). `preview` wins over `steps` because
	// it is the interactive path's whole point.
	steps = Number(process.env.CCLAY_PROJFLOW_STEPS || DEFAULT_STEPS),
	preview = false,
	ridge = Number(process.env.CCLAY_PROJFLOW_RIDGE || DEFAULT_RIDGE),
	// Preserve-row subsampling. The policy and its reasoning live in driver.py's
	// build_preserve_rows; these are the knobs, not the decision.
	preserveStride = Number(process.env.CCLAY_PROJFLOW_PRESERVE_STRIDE || 2),
	preserveMargin = Number(process.env.CCLAY_PROJFLOW_PRESERVE_MARGIN || 20),
	// How many of the edit range's OWN outermost frames are pinned whole-body to
	// the source. Licensed by the app's guarantee that the curve's first and last
	// points already sit on the source trail; see build_preserve_rows rule 4 for
	// the measurement. 0 restores the pre-seam-pin behaviour.
	seamPin = Number(process.env.CCLAY_PROJFLOW_SEAM_PIN ?? 2),
	seed,
	cfg,
	// CCLAY_PROJFLOW_HOST falls back to the Kimodo host: one GPU box serves both
	// engines today, and making the operator set two variables to the same value
	// is how one of them ends up stale.
	host = process.env.CCLAY_PROJFLOW_HOST || process.env.CCLAY_KIMODO_HOST || "",
	repo = process.env.CCLAY_PROJFLOW_REPO || "/home/yun/projflow-scout/repo",
	python = process.env.CCLAY_PROJFLOW_PYTHON || "/home/yun/projflow-scout/venv/bin/python",
	// S1 pinned HOME inside the scout directory so CLIP's 338 MB ViT-B/32
	// download never lands in the box user's real cache. The model loads CLIP on
	// every run, so this is not optional — with the default HOME the first run
	// re-downloads it somewhere we do not clean up.
	boxHome = process.env.CCLAY_PROJFLOW_HOME || "/home/yun/projflow-scout/home",
	// Where to keep the RAW hml22 result (and its .meta.json) after the run
	// directory is removed. Same role as Kimodo's CCLAY_KIMODO_NATIVE_OUT: the
	// take a LATER edit sources from must be in the engine's own format, and the
	// cskel27 file downstream serves is a lossy conversion of it.
	nativeOut = process.env.CCLAY_PROJFLOW_NATIVE_OUT || "",
	onLine,
} = {}) {
	if (!host) {
		throw new Error("lineEditOnBox: CCLAY_PROJFLOW_HOST (or CCLAY_KIMODO_HOST) is required");
	}
	if (typeof sourceMotionNpy !== "string" || !sourceMotionNpy) {
		throw new Error("lineEditOnBox: sourceMotionNpy is required (an hml22 (T,22,3) .npy)");
	}
	// Validated BEFORE anything touches the network: a malformed request must
	// cost milliseconds, not an ssh round trip plus a 3.9 s model load.
	const request = buildLineRequest(line);
	const effectiveSteps = preview ? PREVIEW_STEPS : Number(steps);
	if (!Number.isInteger(effectiveSteps) || effectiveSteps < 1) {
		throw new Error(`lineEditOnBox: steps must be a positive integer, got ${JSON.stringify(steps)}`);
	}
	if (!Number.isFinite(ridge) || ridge < 0) {
		throw new Error(`lineEditOnBox: ridge must be a non-negative number, got ${JSON.stringify(ridge)}`);
	}

	// --- the warm route (contract C11) --------------------------------------
	// Tried first, never retried, never allowed to fail an edit. Everything the
	// cold argv below carries travels in the request, so the two routes ask the
	// same driver for the same thing and the meta comes back identical.
	if (residentEnabled()) {
		try {
			return await warmLineEdit({
				sourceMotionNpy,
				request,
				steps: effectiveSteps,
				ridge,
				preserveStride: Number(preserveStride),
				preserveMargin: Number(preserveMargin),
				seamPin: Number(seamPin),
				seed,
				cfg,
				host,
				python,
				repo,
				boxHome,
				nativeOut,
				onLine,
			});
		} catch (error) {
			// Loud on the status stream, because a session that silently pays the
			// cold price every edit is the failure mode this contract exists to
			// prevent — the kill criterion is stated in edits-per-fallback.
			onLine?.(`run-projflow-line-edit: resident unavailable (${error.message}); running the cold path`);
		}
	}

	const remoteDir = `/tmp/cclay-projflow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const localDir = await mkdtemp(join(tmpdir(), "cclay-projflow-"));
	try {
		const made = await run(["ssh", ...SSH_OPTS, host, `mkdir -p ${remoteDir}`]);
		if (made.code !== 0) {
			throw new Error(`could not create ${remoteDir} on ${host}: ${made.stderr.trim()}`);
		}
		// Local paths travel as scp ARGV entries, never inside a shell string;
		// every remote path is built from remoteDir, which this process generated.
		const push = async (localPath, remotePath, label) => {
			const pushed = await run(["scp", ...SSH_OPTS, localPath, `${host}:${remotePath}`]);
			if (pushed.code !== 0) {
				throw new Error(`could not copy ${label} to ${host} (exit ${pushed.code}): ${pushed.stderr.trim()}`);
			}
		};

		const localLine = join(localDir, "line.json");
		await writeFile(localLine, `${JSON.stringify(request, null, 2)}\n`);
		// The driver ships per run rather than being installed: the box keeps no
		// CozyClay state, so a driver change takes effect on the next request with
		// no deploy step and no chance of a stale copy on the box.
		await push(DRIVER, `${remoteDir}/driver.py`, "the line-edit driver");
		await push(localLine, `${remoteDir}/line.json`, "the line request");
		await push(sourceMotionNpy, `${remoteDir}/source.npy`, "the source motion");

		// One invocation. HOME is an env assignment on the same command word
		// list; `cd` would be a separate command and is not needed because the
		// driver chdirs to the repo itself (its checkpoint paths are repo-relative).
		const words = [
			`HOME=${boxHome}`,
			python,
			`${remoteDir}/driver.py`,
			`--source ${remoteDir}/source.npy`,
			`--line ${remoteDir}/line.json`,
			`--out ${remoteDir}/edited.npy`,
			`--repo ${JSON.stringify(repo)}`,
			`--steps ${effectiveSteps}`,
			`--ridge ${ridge}`,
			`--preserve-stride ${Number(preserveStride)}`,
			`--preserve-margin ${Number(preserveMargin)}`,
			`--seam-pin ${Number(seamPin)}`,
			seed === undefined ? "" : `--seed ${Number(seed)}`,
			cfg === undefined ? "" : `--cfg ${Number(cfg)}`,
		].filter(Boolean).join(" ");

		const edited = await run(["ssh", ...SSH_OPTS, host, words], { onLine });
		if (edited.code !== 0) {
			throw new Error(
				`the ProjFlow line-edit driver on ${host} failed (exit ${edited.code}):\n` +
					edited.stderr.split("\n").slice(-25).join("\n")
			);
		}

		const localNpy = join(localDir, "edited.npy");
		const localMeta = join(localDir, "edited.meta.json");
		for (const [remoteName, localPath, label] of [
			["edited.npy", localNpy, "the edited motion"],
			["edited.meta.json", localMeta, "the run metadata"],
		]) {
			const copied = await run(["scp", ...SSH_OPTS, `${host}:${remoteDir}/${remoteName}`, localPath]);
			if (copied.code !== 0) {
				throw new Error(`scp of ${label} failed (exit ${copied.code}): ${copied.stderr.trim()}`);
			}
		}

		const { shape, data } = readNpyFloat32(localNpy);
		if (shape.length !== 3 || shape[1] !== NUM_JOINTS || shape[2] !== 3) {
			throw new Error(`lineEditOnBox: expected a (T,22,3) result, got (${shape.join(",")})`);
		}
		// `resident: false` is the counterpart of the warm route's `true`: every
		// result says which route produced it, so a session that quietly stopped
		// being warm is visible in the report instead of only in the clock.
		const meta = { ...JSON.parse(await readFile(localMeta, "utf8")), resident: false };
		if (nativeOut) {
			// NOT best-effort, unlike Kimodo's equivalent: there the native npz is
			// a bonus beside a take the caller already holds in memory, here it is
			// the wrapper's ONLY deliverable to the bridge, and a silently missing
			// file would be reported as a successful run.
			await copyFile(localNpy, nativeOut);
			await copyFile(localMeta, `${String(nativeOut).replace(/\.npy$/i, "")}.meta.json`);
		}
		// The driver measures its own exactness (it is the only side that has both
		// the source and the result in one place) and the caller is entitled to
		// the numbers rather than a boolean: contract GP1 gates on the
		// reprojection error and GP2 on the preserved frames.
		return {
			positions: data,
			frames: shape[0],
			joints: shape[1],
			fps: GEN_FPS,
			meta,
			line: request,
			nativeNpy: nativeOut || null,
		};
	} finally {
		await rm(localDir, { recursive: true, force: true });
		await run(["ssh", ...SSH_OPTS, host, `rm -rf ${remoteDir}`]);
	}
}

/**
 * CLI entry point, so tools/projflow/runner.mjs has something spawnable.
 *
 * WHY THE WRAPPER LIVES IN THIS FILE. Kimodo puts its box wrappers in separate
 * scripts (run-sequence-on-box.mjs, run-edit-on-box.mjs) because two run modes
 * share one argv contract with the ARDY wrappers. ProjFlow v1 has exactly one
 * run mode and no legacy argv to match, so a second file would only be a place
 * for the two to drift.
 *
 * WHAT IT WRITES, AND WHAT IT DOES NOT. The output is the RAW hml22 (T,22,3)
 * .npy plus its .meta.json — NOT a cclay npz. Turning 22-joint positions into a
 * cskel27 take requires lifting rotations (contract C8, agent M2's
 * hml22-to-cskel27.mjs) and splicing the result back into the source take
 * (agent M5), and neither exists yet. Wave-2 integration composes those on top
 * of this file; until then the done line names the raw motion, which is exactly
 * what a later line edit sources from anyway.
 */
async function main(argv) {
	const args = { steps: undefined, preview: false, seed: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return value;
		};
		if (flag === "--source") args.source = next();
		else if (flag === "--line") args.line = next();
		else if (flag === "--output") args.output = next();
		else if (flag === "--steps") args.steps = Number(next());
		else if (flag === "--preview") args.preview = true;
		else if (flag === "--ridge") args.ridge = Number(next());
		else if (flag === "--preserve-stride") args.preserveStride = Number(next());
		else if (flag === "--preserve-margin") args.preserveMargin = Number(next());
		else if (flag === "--seam-pin") args.seamPin = Number(next());
		else if (flag === "--seed") args.seed = Number(next());
		else throw new Error(`unknown flag ${flag}`);
	}
	for (const required of ["source", "line", "output"]) {
		if (!args[required]) throw new Error(`--${required} is required`);
	}
	// THE CLI IS A ONE-SHOT PROCESS, so a resident it would have to start, use
	// once and kill is pure overhead — the point of contract C11 is amortising a
	// model load across a SESSION, and this process is not one. The bridge does
	// not come through here (it imports line-edit-job.mjs in-process, where the
	// child survives between edits). An operator who wants to exercise the warm
	// route from the shell sets the variable explicitly.
	if (process.env.CCLAY_PROJFLOW_RESIDENT === undefined) process.env.CCLAY_PROJFLOW_RESIDENT = "0";
	const line = JSON.parse(await readFile(resolvePath(args.line), "utf8"));
	const result = await lineEditOnBox({
		sourceMotionNpy: resolvePath(args.source),
		line,
		nativeOut: resolvePath(args.output),
		...(args.steps === undefined ? {} : { steps: args.steps }),
		...(args.ridge === undefined ? {} : { ridge: args.ridge }),
		...(args.preserveStride === undefined ? {} : { preserveStride: args.preserveStride }),
		...(args.preserveMargin === undefined ? {} : { preserveMargin: args.preserveMargin }),
		...(args.seamPin === undefined ? {} : { seamPin: args.seamPin }),
		...(args.seed === undefined ? {} : { seed: args.seed }),
		preview: args.preview,
		onLine: (text) => console.error(text),
	});
	const { m, steps, sampling_seconds: samplingSeconds, checks } = result.meta;
	// The exactness numbers on the status stream, not buried in the sidecar:
	// gates GP1/GP2 read exactly these and an operator watching a run should see
	// a regression without opening a file.
	console.log(
		`run-projflow-line-edit: rows=${m} steps=${steps} sample=${samplingSeconds}s ` +
			`preserved=${checks.preservedMaxAbsDiffM} reproj=${checks.lineMaxReprojErr} ` +
			`resident=${result.meta.resident === true}`
	);
	const { size } = await stat(resolvePath(args.output));
	console.log(`run-projflow-line-edit: done - ${resolvePath(args.output)} (${size} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`run-projflow-line-edit: ${error.message}`);
		process.exit(1);
	});
}
