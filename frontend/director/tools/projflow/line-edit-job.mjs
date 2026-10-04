/**
 * line-edit-job.mjs — the composition layer for a ProjFlow line edit.
 *
 * Wave 1 landed four independent pieces: a runner that can drive the box
 * (runner.mjs), a wrapper that runs one edit and returns raw hml22 positions
 * (generate.mjs `lineEditOnBox`), a skeleton converter both ways
 * (hml22-to-cskel27.mjs), and a draw UI. NONE of them touches a cclay take.
 * This file is the only place where a drawn line becomes an edited npz, and it
 * is deliberately a pure async function rather than another CLI: the bridge
 * imports it the way it already imports handleExtract, so there is no second
 * process, no second argv contract, and no second copy of the frame arithmetic.
 *
 * THE PIPELINE, in one place because every step's rounding depends on the one
 * before it:
 *
 *   take.npz (cskel27, 24 fps)
 *     -> cskel27ToHml22Positions          pure index gather, lossless
 *     -> resample 24 -> 20 fps            linear, positions only
 *     -> source.npy (T20,22,3)            what driver.py derives its T from
 *     -> lineEditOnBox                    the GPU round trip
 *     -> hml22ToCskel27Motion             rotation lift, 20 fps
 *     -> retimeMotion(.., 24)             the same call Kimodo's 30 fps output makes
 *     -> replaceMotionSegment             outside the range: the ORIGINAL bytes
 *     -> out.npz
 *
 * THE CLOCK RULE, stated once and used everywhere: every 24 -> 20 conversion is
 * `Math.round(frames24 * 20 / 24)` — the same half-up rounding for the clip
 * length and for BOTH ends of frameRange, so the range can never scale to a
 * span the resampled source does not contain. (Kimodo's cliGenFrames truncates
 * instead, because it must agree with a python `int()` on the box. Nothing
 * truncates here: driver.py derives T from the source npy THIS file writes, so
 * the source length is authoritative and the only requirement is that one rule
 * is used consistently. Rounding is the one that keeps the resampled clip the
 * same DURATION as the take, which is what the artist sees.)
 *
 * WHY LINEAR AND NOT NEAREST for the 24 -> 20 source resample: driver.py turns
 * those frames into hard identity rows (`build_preserve_rows`), so a resampled
 * frame is not a hint, it is an observation the sampler must satisfy exactly.
 * Nearest-neighbour would alias — every 6th frame duplicated — and the sampler
 * would faithfully reproduce a stutter that is not in the take.
 *
 * SPLICING IS A HARD CUT, ON PURPOSE. Outside the edit range the output is the
 * source take byte for byte (replaceMotionSegment copies the original arrays);
 * inside it, the converted result. No crossfade is applied. Gate GP2 asks
 * whether the seams pop, and a crossfade applied up front would make that
 * question unanswerable — so the job MEASURES the seams instead
 * (`seamStartDelta` / `seamEndDelta` against the take's own median frame delta)
 * and hands the numbers to the caller. A blend window is a follow-up knob to be
 * turned on evidence, not a silent default.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { motionArraysToNpzMembers, replaceMotionSegment, writeNpz } from "../ardy/npz.mjs";
import { readNpz } from "../kimodo/read-npz.mjs";
import { retimeMotion } from "../../src/ardy/retime.js";
import { cskel27ToHml22Positions, hml22ToCskel27Motion } from "./hml22-to-cskel27.mjs";
import { GEN_FPS, NUM_JOINTS, lineEditOnBox, writeNpyFloat32 } from "./generate.mjs";
import { nativeMotionPath } from "./runner.mjs";

/** The app/timeline/bridge clock. Kept as a parameter everywhere below so the
 * tests can pin the arithmetic without a 24 fps fixture, but there is exactly
 * one production value and the bridge passes it explicitly. */
export const APP_FPS = 24;

const CSKEL_JOINTS = 27;

/* ------------------------------------------------------------------------- */
/* the clock                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * App frames (24 fps) -> generation frames (20 fps). THE rounding rule.
 *
 * Used for the clip length and for both ends of frameRange. Exported so the
 * verify file can pin it directly instead of inferring it from a spliced take.
 */
export function toGenFrames(appFrames, { appFps = APP_FPS, genFps = GEN_FPS } = {}) {
	if (!Number.isFinite(appFrames)) throw new Error(`toGenFrames: ${JSON.stringify(appFrames)} is not a frame count`);
	return Math.round(appFrames * (genFps / appFps));
}

/**
 * The generation-clock frame range driver.py receives, from the app-clock
 * half-open range the artist selected.
 *
 * Two conversions happen here and both are worth naming:
 *   1. HALF-OPEN -> INCLUSIVE. Every range that crosses the bridge is
 *      [start, end) — preserve.editRanges, the prompt schedule, C6 itself.
 *      driver.py's is INCLUSIVE (`0 <= start <= end < frames`, span =
 *      end - start + 1), so the exclusive end becomes `end - 1` here, once.
 *   2. The clamp. `end` must stay strictly inside the source's T (the driver
 *      indexes it), and the span must stay >= 2 frames or the "line" is one
 *      pose. A range ending exactly at the clip length is the common case —
 *      the artist selected to the end of the take — and it lands on T20, which
 *      is one past the last row.
 */
export function scaleFrameRange({ startFrame, endFrame }, genFrames, { appFps = APP_FPS, genFps = GEN_FPS } = {}) {
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
		throw new Error(`scaleFrameRange: ${startFrame}..${endFrame} is not a non-empty half-open range`);
	}
	if (!Number.isInteger(genFrames) || genFrames < 2) {
		throw new Error(`scaleFrameRange: the generation clip needs at least 2 frames, got ${genFrames}`);
	}
	const scale = (frame) => toGenFrames(frame, { appFps, genFps });
	// start can never sit on the last two rows: the span below needs somewhere
	// to end, and a two-frame edit at the very tail is still a two-frame edit.
	const start = Math.min(Math.max(scale(startFrame), 0), genFrames - 2);
	const endExclusive = Math.min(Math.max(scale(endFrame), start + 2), genFrames);
	return { start, end: endExclusive - 1 };
}

/**
 * `pins3d` on the app clock -> `pins3d` on the generation clock.
 *
 * ONE APP PIN BECOMES THE GENERATION FRAMES THAT APP FRAME IS REBUILT FROM,
 * which is usually two, and that is the whole subtlety of this function.
 *
 * The naive version rounded to a single generation frame and it was MEASURED
 * wrong end to end: the box satisfied the pin exactly (9.5e-7 m at generation
 * frame 83) and the finished take still missed it by 27 cm. Nothing was broken
 * in between — retimeMotion rebuilds app frame f from generation frames
 * `floor(f/ratio)` and `floor(f/ratio)+1`, blended by the fraction, and app
 * frame 100 sits at generation 83.33. So the take at frame 100 is two thirds of
 * an exactly-pinned frame and one third of its UNPINNED neighbour, and that
 * neighbour is 0.2 m away, because a lone hard observation with free
 * neighbours is a spike (the paper's own Plain Masking ablation, which it
 * reports as the worst configuration).
 *
 * Constraining BOTH bracketing frames makes the authored statement survive the
 * clock change: whatever the blend weight is, it is a blend of two frames that
 * both hold the pinned position, so the app frame the artist pinned lands on
 * the value they placed. It is not padding — it is the smallest set of
 * generation frames whose values determine the app frame that was authored.
 * Measured after the change: 27.1 cm -> 0.3 cm at the pinned frame.
 *
 * The exact-frame case (one app frame in six lands on a generation frame with
 * no remainder) emits a single frame, because there is no second frame in the
 * blend to hold.
 *
 * POSITIONS ARE NOT TOUCHED. Resampling the source is a time operation; a pin
 * is a point in space that happens to name a moment, and the only thing the
 * clock change can do to it is move which frames it names.
 *
 * Two app pins can claim one generation frame (they are 1.2 app frames apart at
 * most when that happens), and two rows on one frame would be two contradictory
 * answers for the sampler to average. The LAST pin wins, deliberately: pins
 * arrive in ascending frame order, so "the later one wins" is the same rule the
 * app's own place-a-pin-twice behaviour follows.
 */
export function scalePins(pins, genFrames, { appFps = APP_FPS, genFps = GEN_FPS } = {}) {
	if (!Array.isArray(pins) || pins.length === 0) {
		throw new Error("scalePins: pins3d must be a non-empty array");
	}
	if (!Number.isInteger(genFrames) || genFrames < 1) {
		throw new Error(`scalePins: the generation clip needs at least 1 frame, got ${genFrames}`);
	}
	const byFrame = new Map();
	const clamp = (frame) => Math.min(genFrames - 1, Math.max(0, frame));
	for (const pin of pins) {
		if (!pin || !Number.isInteger(pin.frame) || !Array.isArray(pin.position) || pin.position.length !== 3) {
			throw new Error(`scalePins: ${JSON.stringify(pin)} is not a { frame, position:[x,y,z] } pin`);
		}
		const position = pin.position.map(Number);
		// retimeMotion's own walk, spelled the same way: s = f / (genFps/appFps).
		const exact = (pin.frame * genFps) / appFps;
		const low = clamp(Math.floor(exact));
		const high = clamp(exact === low ? low : low + 1);
		byFrame.set(low, { frame: low, position });
		if (high !== low) byFrame.set(high, { frame: high, position });
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Resample a flat [T, J, 3] position buffer onto `outFrames` rows by linear
 * interpolation.
 *
 * The walk is retimeMotion's own (`s = f / ratio`, floor, clamp, lerp) rather
 * than an arc-length or endpoint-matched resample, so the two directions of the
 * 24 <-> 20 trip agree about where frame f sits in time. The one deliberate
 * difference: `ratio` is the FRAME-COUNT ratio rather than the fps ratio, so a
 * clip whose rounded 20 fps length is a hair off 5/6 of its 24 fps length is
 * still covered end to end instead of stopping short. Positions only: the
 * source npy has no rotations and the driver wants none.
 */
export function resamplePositions(positions, { joints, inFrames, outFrames }) {
	if (positions.length !== inFrames * joints * 3) {
		throw new Error(
			`resamplePositions: expected ${inFrames * joints * 3} values for ${inFrames} frames, got ${positions.length}`
		);
	}
	if (!Number.isInteger(outFrames) || outFrames < 1) {
		throw new Error(`resamplePositions: outFrames must be a positive integer, got ${outFrames}`);
	}
	const out = new Float32Array(outFrames * joints * 3);
	const ratio = outFrames === inFrames ? 1 : outFrames / inFrames;
	for (let frame = 0; frame < outFrames; frame += 1) {
		const s = frame / ratio;
		const i0 = Math.min(Math.floor(s), inFrames - 1);
		const i1 = Math.min(i0 + 1, inFrames - 1);
		const t = Math.min(Math.max(s - i0, 0), 1);
		const dst = frame * joints * 3;
		const src0 = i0 * joints * 3;
		const src1 = i1 * joints * 3;
		for (let index = 0; index < joints * 3; index += 1) {
			out[dst + index] = positions[src0 + index] * (1 - t) + positions[src1 + index] * t;
		}
	}
	return out;
}

/* ------------------------------------------------------------------------- */
/* the take on disk                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Read a cclay take npz into the motion-array shape every tool in this repo
 * passes around.
 *
 * readNpz (tools/kimodo/read-npz.mjs) rather than decodeMotionNpz: the browser
 * decoder is async and byte-cap hardened for untrusted input, which is the
 * wrong trade for a file this process wrote itself, and the bridge already uses
 * both readers for exactly that split.
 */
export function readTakeNpz(path) {
	const members = readNpz(path);
	for (const required of ["local_rot_mats", "root_positions", "posed_joints"]) {
		if (!members[required]) throw new Error(`readTakeNpz: ${path} is missing ${required}`);
	}
	const rot = members.local_rot_mats;
	const root = members.root_positions;
	const posed = members.posed_joints;
	if (rot.shape.length !== 4 || rot.shape[1] !== CSKEL_JOINTS || rot.shape[2] !== 3 || rot.shape[3] !== 3) {
		throw new Error(`readTakeNpz: local_rot_mats must be [T,27,3,3], got [${rot.shape}]`);
	}
	if (posed.shape.length !== 3 || posed.shape[1] !== CSKEL_JOINTS || posed.shape[2] !== 3) {
		throw new Error(`readTakeNpz: posed_joints must be [T,27,3], got [${posed.shape}]`);
	}
	if (root.shape.length !== 2 || root.shape[1] !== 3) {
		throw new Error(`readTakeNpz: root_positions must be [T,3], got [${root.shape}]`);
	}
	const frames = rot.shape[0];
	if (posed.shape[0] !== frames || root.shape[0] !== frames) {
		throw new Error(
			`readTakeNpz: members disagree on frame count (${frames}, ${posed.shape[0]}, ${root.shape[0]})`
		);
	}
	// The bridge writes fps into every take it produces; a take without one is
	// not a cclay take, and guessing 24 would silently retime the edit.
	if (!members.fps) throw new Error(`readTakeNpz: ${path} has no fps member`);
	const fps = Math.round(members.fps.data[0]);
	if (!Number.isInteger(fps) || fps < 1) throw new Error(`readTakeNpz: ${path} has fps ${fps}`);
	const motion = {
		frames,
		fps,
		rotMats: rot.data,
		rootPos: root.data,
		posedJoints: posed.data,
	};
	if (members.person_scale) {
		const personScale = members.person_scale.data[0];
		if (personScale > 0 && personScale !== 1) motion.personScale = personScale;
	}
	return motion;
}

/* ------------------------------------------------------------------------- */
/* the splice and its seams                                                   */
/* ------------------------------------------------------------------------- */

/** Largest per-joint travel between two consecutive frames of a take, in
 * metres. The unit gate GP2 is written in ("no frame-to-frame pop bigger than
 * the take's own median frame delta"). */
export function maxJointStep(posedJoints, frame, { joints = CSKEL_JOINTS } = {}) {
	if (frame <= 0) return 0;
	let worst = 0;
	const current = frame * joints * 3;
	const previous = current - joints * 3;
	for (let joint = 0; joint < joints; joint += 1) {
		const step = Math.hypot(
			posedJoints[current + joint * 3] - posedJoints[previous + joint * 3],
			posedJoints[current + joint * 3 + 1] - posedJoints[previous + joint * 3 + 1],
			posedJoints[current + joint * 3 + 2] - posedJoints[previous + joint * 3 + 2]
		);
		if (step > worst) worst = step;
	}
	return worst;
}

/** The take's own median frame delta — the yardstick a seam is judged against.
 * Median, not mean: one real footfall must not raise the bar for the whole
 * clip. */
export function medianFrameStep(motion, { joints = CSKEL_JOINTS } = {}) {
	if (motion.frames < 2) return 0;
	const steps = [];
	for (let frame = 1; frame < motion.frames; frame += 1) {
		steps.push(maxJointStep(motion.posedJoints, frame, { joints }));
	}
	steps.sort((a, b) => a - b);
	const middle = steps.length >> 1;
	return steps.length % 2 ? steps[middle] : (steps[middle - 1] + steps[middle]) / 2;
}

/**
 * Write `edited` into `take` over the half-open app-frame range, and measure
 * what the two cuts cost.
 *
 * `edited` may be one frame short or long of the take (the 24 -> 20 -> 24 round
 * trip is not a bijection: 117 app frames scale to 98 generation frames, which
 * scale back to 118). The tail index is clamped rather than the range refused —
 * the discrepancy is at most one frame at the very end of the clip and only
 * matters when the edit reaches it, whereas refusing would make whole clip
 * lengths un-editable. `framesClamped` in the returned meta says when it
 * happened, so the case is visible rather than silent.
 */
export function spliceEditedRange(take, edited, { startFrame, endFrame }) {
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
		throw new Error(`spliceEditedRange: ${startFrame}..${endFrame} is not a non-empty half-open range`);
	}
	if (endFrame > take.frames) {
		throw new Error(`spliceEditedRange: range ends at ${endFrame}, past the take's ${take.frames} frames`);
	}
	const span = endFrame - startFrame;
	const slice = {
		frames: span,
		fps: take.fps,
		rotMats: new Float32Array(span * CSKEL_JOINTS * 9),
		rootPos: new Float32Array(span * 3),
		posedJoints: new Float32Array(span * CSKEL_JOINTS * 3),
	};
	let framesClamped = 0;
	for (let index = 0; index < span; index += 1) {
		const wanted = startFrame + index;
		const source = Math.min(wanted, edited.frames - 1);
		if (source !== wanted) framesClamped += 1;
		slice.rotMats.set(
			edited.rotMats.subarray(source * CSKEL_JOINTS * 9, (source + 1) * CSKEL_JOINTS * 9),
			index * CSKEL_JOINTS * 9
		);
		slice.rootPos.set(edited.rootPos.subarray(source * 3, (source + 1) * 3), index * 3);
		slice.posedJoints.set(
			edited.posedJoints.subarray(source * CSKEL_JOINTS * 3, (source + 1) * CSKEL_JOINTS * 3),
			index * CSKEL_JOINTS * 3
		);
	}
	// replaceMotionSegment copies the base arrays and overwrites the span, so
	// every frame outside it is the source take's own bytes, unconditionally.
	const spliced = replaceMotionSegment(take, slice, startFrame);
	const median = medianFrameStep(take);
	const seams = {
		// The frame AT the range start is the first edited pose, so the jump into
		// it is the opening seam; endFrame is the first frame that is source
		// again, so the jump into IT is the closing seam. A range that starts at
		// frame 0 or ends at the clip has only one real seam; the other is 0.
		seamStartDelta: maxJointStep(spliced.posedJoints, startFrame),
		seamEndDelta: endFrame < spliced.frames ? maxJointStep(spliced.posedJoints, endFrame) : 0,
		medianFrameDelta: median,
	};
	seams.seamStartRatio = median > 0 ? seams.seamStartDelta / median : null;
	seams.seamEndRatio = median > 0 ? seams.seamEndDelta / median : null;
	return { motion: spliced, framesClamped, ...seams };
}

/* ------------------------------------------------------------------------- */
/* the job                                                                    */
/* ------------------------------------------------------------------------- */

/** C6's flat 9-element row-major R -> the 3x3 buildLineRequest validates. The
 * app sends flat (it is what a Matrix3 hands over); driver.py reshapes to (3,3)
 * either way, but generate.mjs refuses anything that is not nested, and this is
 * the seam where the two spellings meet. */
function nestR(R) {
	if (Array.isArray(R) && R.length === 3 && R.every((row) => Array.isArray(row) && row.length === 3)) return R;
	if (!Array.isArray(R) || R.length !== 9) {
		throw new Error("lineEdit.camera.R must be 9 numbers (row-major) or a 3x3 array");
	}
	return [R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)];
}

/**
 * Run one line edit end to end and write the edited take.
 *
 * @param {object} options
 * @param {object} options.lineEdit  the C6 block exactly as the app sent it —
 *   app-clock `frameRange {startFrame, endFrame}` (half-open), normalised
 *   points2d, flat-R camera. Nothing in it is on the generation clock.
 * @param {string} options.takePath  the stored cclay npz for `sourceMotion`.
 * @param {string} options.outputPath  where the edited cclay npz goes.
 * @param {boolean} [options.preview]  20 ODE steps instead of 100.
 * @param {number} [options.seed]
 * @param {number} [options.appFps=24]
 * @param {(line: string) => void} [options.onStatus]  box output, line by line.
 * @param {Function} [options.runLineEdit=lineEditOnBox]  the box call. Injected
 *   so the composition can be tested without a GPU: everything around it is
 *   arithmetic on real npz files, and that arithmetic is where the bugs are.
 * @returns {Promise<object>} meta: clocks, frame counts, seam deltas, timings,
 *   and the driver's own exactness numbers under `box`.
 */
export async function runLineEditJob({
	lineEdit,
	takePath,
	outputPath,
	preview = false,
	seed,
	steps,
	appFps = APP_FPS,
	onStatus,
	runLineEdit = lineEditOnBox,
} = {}) {
	if (!lineEdit || typeof lineEdit !== "object") throw new Error("runLineEditJob: lineEdit is required");
	if (!takePath) throw new Error("runLineEditJob: takePath is required");
	if (!outputPath) throw new Error("runLineEditJob: outputPath is required");
	const started = Date.now();
	const timings = {};

	// --- 1. the take ---------------------------------------------------------
	const take = readTakeNpz(takePath);
	if (take.fps !== appFps) {
		throw new Error(`runLineEditJob: the take is ${take.fps} fps; this bridge's clock is ${appFps}`);
	}
	const range = lineEdit.frameRange || {};
	const startFrame = range.startFrame;
	const endFrame = range.endFrame;
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
		throw new Error(`runLineEditJob: frameRange ${startFrame}..${endFrame} is not a non-empty half-open range`);
	}
	// Re-checked against the FILE, not against the duration the request claimed:
	// the bridge validated the range against `duration * 24`, and a take that was
	// spliced or imported can disagree with it.
	if (endFrame > take.frames) {
		throw new Error(
			`runLineEditJob: frameRange ends at ${endFrame} but the source take has ${take.frames} frames`
		);
	}
	timings.readMs = Date.now() - started;

	// --- 2. 24 -> 20, positions only ----------------------------------------
	const genFrames = Math.max(2, toGenFrames(take.frames, { appFps, genFps: GEN_FPS }));
	const sourceHml22 = resamplePositions(
		cskel27ToHml22Positions({ frames: take.frames, posedJoints: take.posedJoints }),
		{ joints: NUM_JOINTS, inFrames: take.frames, outFrames: genFrames }
	);

	// --- 3. the range on the generation clock -------------------------------
	const genRange = scaleFrameRange({ startFrame, endFrame }, genFrames, { appFps, genFps: GEN_FPS });
	const line = lineEdit.pins3d
		? {
			track: lineEdit.track,
			frameRange: genRange,
			// NO CAMERA, and none is invented: a pin is already in the take's own
			// joint space (the app converts from viewport world with
			// worldPointToClip, the exact inverse of the trail projection), so the
			// positions go through UNCHANGED. cskel27ToHml22Positions is a pure
			// index gather with no coordinate transform — that is the whole reason
			// the wire can carry take-space metres and the driver can compare them
			// against source.npy directly.
			pins3d: scalePins(lineEdit.pins3d, genFrames, { appFps, genFps: GEN_FPS }),
			prompt: lineEdit.prompt ?? "",
		}
		: {
			track: lineEdit.track,
			frameRange: genRange,
			points2d: lineEdit.points2d,
			camera: { ...lineEdit.camera, R: nestR(lineEdit.camera?.R) },
			prompt: lineEdit.prompt ?? "",
		};

	// --- 4. the box ----------------------------------------------------------
	const workDir = await mkdtemp(join(tmpdir(), "cclay-line-edit-"));
	let result;
	try {
		const sourceNpy = join(workDir, "source.npy");
		writeNpyFloat32(sourceNpy, sourceHml22, [genFrames, NUM_JOINTS, 3]);
		const boxStarted = Date.now();
		result = await runLineEdit({
			sourceMotionNpy: sourceNpy,
			line,
			preview,
			...(steps === undefined ? {} : { steps }),
			...(seed === undefined ? {} : { seed }),
			// The raw hml22 result is kept beside the take for the same reason
			// Kimodo keeps its native npz: it is what a LATER edit would source
			// from, and the cskel27 file we write below is a lift of it.
			nativeOut: nativeMotionPath(outputPath),
			onLine: onStatus,
		});
		timings.boxMs = Date.now() - boxStarted;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
	if (!result || !result.positions) throw new Error("runLineEditJob: the box returned no positions");
	if (result.frames !== genFrames) {
		// driver.py edits IN PLACE on the source's own T; a different count means
		// the source npy and the result describe different clips and the splice
		// below would be aligned to the wrong frames.
		throw new Error(
			`runLineEditJob: the box returned ${result.frames} frames for a ${genFrames}-frame source`
		);
	}

	// --- 5. 22 -> 27, then 20 -> 24 -----------------------------------------
	const convertStarted = Date.now();
	const converted = hml22ToCskel27Motion({ positions: result.positions, fps: result.fps ?? GEN_FPS });
	// The same call Kimodo's 30 fps output makes on its way to the timeline;
	// rotations slerp, the root lerps, and every other joint is re-derived by FK
	// so bone lengths never enter the blend.
	const retimed = retimeMotion({ ...converted, fps: converted.fps }, appFps);
	timings.convertMs = Date.now() - convertStarted;

	// --- 6. splice and write -------------------------------------------------
	const spliced = spliceEditedRange(take, retimed, { startFrame, endFrame });
	writeNpz(outputPath, motionArraysToNpzMembers({
		frames: spliced.motion.frames,
		fps: spliced.motion.fps,
		rotMats: spliced.motion.rotMats,
		rootPos: spliced.motion.rootPos,
		posedJoints: spliced.motion.posedJoints,
		personScale: spliced.motion.personScale,
	}));
	timings.totalMs = Date.now() - started;

	return {
		output: outputPath,
		nativeMotion: result.nativeNpy ?? null,
		track: lineEdit.track,
		frames: spliced.motion.frames,
		fps: spliced.motion.fps,
		appFrameRange: { startFrame, endFrame },
		genFps: GEN_FPS,
		genFrames,
		// Reported INCLUSIVE, the way driver.py received it, so a box log and this
		// meta can be compared without translating.
		genFrameRange: genRange,
		retimedFrames: retimed.frames,
		framesClamped: spliced.framesClamped,
		seamStartDelta: spliced.seamStartDelta,
		seamEndDelta: spliced.seamEndDelta,
		medianFrameDelta: spliced.medianFrameDelta,
		seamStartRatio: spliced.seamStartRatio,
		seamEndRatio: spliced.seamEndRatio,
		timings,
		box: result.meta ?? null,
	};
}
