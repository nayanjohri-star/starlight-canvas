/**
 * replay.mjs — recipe replay (contract C10) and the per-field line-edit rules
 * both the C6 and the C10 paths validate with.
 *
 * A take is a RECIPE, not a result: seed + prompt blocks + the line edits the
 * artist drew on top. Determinism makes the result reconstructible, so
 * regenerating or extending a take no longer has to destroy its refinements —
 * the app sends the stored line edits back as `replay` and the bridge re-applies
 * them to the freshly generated take.
 *
 * WHY THIS IS ITS OWN MODULE and not more bridge code: everything here is pure
 * arithmetic plus one injectable job runner, so the whole contract — the
 * per-entry rules, the boundary warning, the sequential chaining — is testable
 * on a laptop with no GPU and no sidecar. bridge.mjs keeps only the wiring:
 * which take the chain starts from, where the artifacts go, and what it streams.
 *
 * THE CHAIN, stated once. Entry i reads entry i-1's OUTPUT; entry 0 reads the
 * freshly generated take. Every output lands in the request's artifact dir as
 * replay-<i>.npz and only the LAST one is registered — the intermediates are
 * evidence, not takes. A failing entry is skipped and the chain continues from
 * the last good file: a missing refinement beats a dead run.
 */

import { join } from "node:path";

import { TRACK_TO_HML22_JOINT, UNMAPPABLE_TRACKS } from "./generate.mjs";

/** The tracks a line edit (C6) or a replay entry (C10) may name — the wrapper's
 * own track -> hml22 joint table, never a copy of it. */
export const LINE_EDIT_TRACK_IDS = Object.keys(TRACK_TO_HML22_JOINT);
export const LINE_EDIT_POINTS_MIN = 2;
export const LINE_EDIT_POINTS_MAX = 64; // matches src/line-edit.js MAX_LINE_POINTS
/** C6's OTHER gesture: 3D pins (`pins3d`), one per scrubbed moment.
 *
 * A pin is a keyframe — "the hand is HERE at frame 100" — and it is the shape
 * ProjFlow is actually evaluated on: its whole spatial-control table is sparse
 * keyframes (1, 2, 5, 49, 196 of them) with exact satisfaction and the flow
 * prior filling the gaps. A drawn line is the dense end of the same mechanism.
 *
 * ONE is a legal edit, unlike points2d's two: a line needs two points to have a
 * direction, a pin needs none. EIGHT is the cap, and it is a UX number rather
 * than a solver one — 3 rows per pin is nothing next to 128 line rows — past
 * eight pins in one edit the artist is keyframing by hand and wants the pose
 * studio, not a reroute. */
export const LINE_EDIT_PINS_MIN = 1;
export const LINE_EDIT_PINS_MAX = 8;
/** C10's cap. A recipe is an authoring history, not a render queue: 16 chained
 * box round trips is already a minute of wall time on top of the generation. */
export const REPLAY_MAX = 16;
/** Mirrors the bridge's own optional-seed cap; the bridge passes its constant in
 * so the two can never disagree, and this default only serves direct callers. */
const DEFAULT_SEED_MAX = 2 ** 31 - 1;
/** Frames either side of a block boundary that a replayed edit is warned about.
 * See boundaryWarningFor for why the number is small. */
export const BOUNDARY_MARGIN = 5;
/** Fields a replay entry may NOT carry: `replay` cannot be combined with the
 * modes that splice or rewrite an existing take, because then "the take the
 * replay applies to" has two candidate answers. */
export const REPLAY_EXCLUSIVE = ["lineEdit", "motionEdit", "regenerateSegments"];

/* ------------------------------------------------------------------------- */
/* the per-field rules, shared by C6 and C10                                   */
/* ------------------------------------------------------------------------- */

/**
 * The field checks a line-edit payload must pass, wherever it arrives from.
 *
 * `label` is the wire path the message names — "lineEdit" for a C6 request,
 * "replay[3]" for the fourth entry of a C10 replay — and it is the ONLY
 * difference between the two paths. The strings are otherwise byte-identical to
 * the ones the C6 validator has always returned.
 *
 * What is NOT here, deliberately: `sourceMotion` (C6 requires it, C10 forbids
 * it), the exclusivity rules, and `preview` (C6 only). Those belong to whoever
 * calls this.
 *
 * Frame numbers are all on the app's 24 fps clip clock, exactly as sent; the
 * 24 -> 20 conversion is line-edit-job.mjs's business and is not duplicated
 * here or in the bridge.
 *
 * Returns an error message naming the offending field, or null when valid.
 */
export function validateLineEditFields(lineEdit, clipFrames, label = "lineEdit") {
	if (!lineEdit || typeof lineEdit !== "object" || Array.isArray(lineEdit)) {
		return `field '${label}' must be an object`;
	}
	// `chest` is a REAL pose-studio track and a real refusal: cskel27 Spine2 is
	// one of the five joints the hml22 skeleton has no source for (S2), so there
	// is nothing to constrain. Refused by name, with the alternative, rather than
	// silently retargeted onto a neighbouring spine joint — which would put the
	// drawn line on a curve the artist did not draw.
	if (typeof lineEdit.track === "string" && Object.hasOwn(UNMAPPABLE_TRACKS, lineEdit.track)) {
		return (
			`field '${label}.track' "${lineEdit.track}" cannot be line-edited: ${UNMAPPABLE_TRACKS[lineEdit.track]}; ` +
			"draw on spine or neck instead"
		);
	}
	if (typeof lineEdit.track !== "string" || !Object.hasOwn(TRACK_TO_HML22_JOINT, lineEdit.track)) {
		return (
			`field '${label}.track' ${JSON.stringify(lineEdit.track)} is not a line-editable IK track id; ` +
			`valid ids are ${LINE_EDIT_TRACK_IDS.join(", ")}`
		);
	}
	const range = lineEdit.frameRange;
	if (!range || typeof range !== "object" || Array.isArray(range)) {
		return `field '${label}.frameRange' must be an object { startFrame, endFrame }`;
	}
	if (!Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)) {
		return `field '${label}.frameRange' startFrame and endFrame must be integers`;
	}
	// Half-open and inside the clip, like every other range that crosses this
	// boundary. The clip length comes from `duration`, which the app derives from
	// the take's own frame count; the job re-checks against the npz itself, since
	// only that file knows how long the take really is.
	if (range.startFrame < 0 || range.endFrame <= range.startFrame || range.endFrame > clipFrames) {
		return `field '${label}.frameRange' must be a non-empty half-open range inside 0..${clipFrames}`;
	}
	// Two points need two frames: one constrained frame is a pin, not a line.
	if (range.endFrame - range.startFrame < 2) {
		return `field '${label}.frameRange' must span at least 2 frames`;
	}
	/* ---------------------------- pins3d (C6 v2) ---------------------------
	 * ONE EDIT IS ONE GESTURE. A stroke says "go along this shape" and pins say
	 * "be exactly here at these moments"; combining them would ask the box to
	 * satisfy a 2D path and a set of 3D points that were authored through
	 * different mental models and are only accidentally compatible. So pins3d
	 * REPLACES points2d and the camera — a pin is already in world metres and
	 * needs no lens to be read through, which is also why a pinned edit survives
	 * a camera move that would discard a drawn one.
	 *
	 * Checked BEFORE points2d so a pins payload never trips the "needs at least
	 * 2 points" message about a field it deliberately omitted. */
	if (lineEdit.pins3d !== undefined) {
		const pins = lineEdit.pins3d;
		if (lineEdit.points2d !== undefined) {
			return `field '${label}' must carry either points2d (a drawn line) or pins3d (3D pins), not both`;
		}
		if (!Array.isArray(pins) || pins.length < LINE_EDIT_PINS_MIN) {
			return `field '${label}.pins3d' needs at least ${LINE_EDIT_PINS_MIN} pin`;
		}
		if (pins.length > LINE_EDIT_PINS_MAX) {
			return `field '${label}.pins3d' is capped at ${LINE_EDIT_PINS_MAX} pins, got ${pins.length}`;
		}
		let previousFrame = -1;
		for (let index = 0; index < pins.length; index += 1) {
			const pin = pins[index];
			if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
				return `field '${label}.pins3d[${index}]' must be an object { frame, position }`;
			}
			if (!Number.isInteger(pin.frame)) {
				return `field '${label}.pins3d[${index}].frame' must be an integer app-clip frame`;
			}
			// Inside the range and half-open with it: a pin on endFrame names a
			// frame the edit does not own, and the splice would throw it away.
			if (pin.frame < range.startFrame || pin.frame >= range.endFrame) {
				return `field '${label}.pins3d[${index}].frame' ${pin.frame} is outside frameRange ${range.startFrame}..${range.endFrame}`;
			}
			// STRICTLY ascending: two pins on one frame are two answers to the
			// same question, and out-of-order pins mean the caller lost track of
			// which pin it was editing.
			if (pin.frame <= previousFrame) {
				return `field '${label}.pins3d' frames must be strictly ascending, got ${pin.frame} after ${previousFrame}`;
			}
			previousFrame = pin.frame;
			const position = pin.position;
			if (!Array.isArray(position) || position.length !== 3 || !position.every((value) => typeof value === "number" && Number.isFinite(value))) {
				return `field '${label}.pins3d[${index}].position' must be [x, y, z] finite numbers in world metres`;
			}
		}
		// The camera is a stroke's business. Refused rather than ignored, for the
		// same reason a replay entry's sourceMotion is: silently dropping a field
		// lets the caller believe it meant something.
		if (lineEdit.camera !== undefined) {
			return `field '${label}.camera' must be omitted for a pins3d edit — pins are world-space and need no lens`;
		}
		if (lineEdit.prompt !== undefined && typeof lineEdit.prompt !== "string") {
			return `field '${label}.prompt' must be a string when present`;
		}
		return null;
	}

	const points = lineEdit.points2d;
	if (!Array.isArray(points) || points.length < LINE_EDIT_POINTS_MIN) {
		return `field '${label}.points2d' needs at least ${LINE_EDIT_POINTS_MIN} points`;
	}
	// The cap is the app's own, and it is a solver budget: the box builds two
	// affine rows per point and factorises an m x m system every ODE step.
	if (points.length > LINE_EDIT_POINTS_MAX) {
		return `field '${label}.points2d' is capped at ${LINE_EDIT_POINTS_MAX} points, got ${points.length}`;
	}
	for (let index = 0; index < points.length; index += 1) {
		const point = points[index];
		if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === "number" && Number.isFinite(value))) {
			return `field '${label}.points2d[${index}]' must be [u, v] finite numbers`;
		}
		// Viewport-NORMALISED, and enforced rather than clamped: a pixel
		// coordinate here is the single most likely wire mistake and it produces a
		// plausible-looking line through the wrong ray.
		if (point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) {
			return `field '${label}.points2d[${index}]' must be viewport-normalized into 0..1, got ${JSON.stringify(point)}`;
		}
	}
	const camera = lineEdit.camera;
	if (!camera || typeof camera !== "object" || Array.isArray(camera)) {
		return `field '${label}.camera' must be an object { fx, fy, cx, cy, R, t }`;
	}
	for (const key of ["fx", "fy", "cx", "cy"]) {
		if (typeof camera[key] !== "number" || !Number.isFinite(camera[key])) {
			return `field '${label}.camera.${key}' must be a finite number`;
		}
	}
	// A non-positive focal length means the uv/NDC flip was applied twice or not
	// at all, and every solved position would be mirrored.
	if (camera.fx <= 0 || camera.fy <= 0) {
		return `field '${label}.camera' has a non-positive focal length — the uv convention is inverted`;
	}
	// The intrinsics live in the SAME units as points2d. A pixel focal length
	// beside normalised points solves cleanly and lands nowhere near the stroke.
	if (camera.fx > 50 || camera.fy > 50) {
		return `field '${label}.camera' has PIXEL focal lengths (${camera.fx}, ${camera.fy}); normalize them by the viewport size, like points2d`;
	}
	if (!Array.isArray(camera.R) || camera.R.length !== 9 || !camera.R.every((value) => typeof value === "number" && Number.isFinite(value))) {
		return `field '${label}.camera.R' must be 9 finite numbers (3x3 row-major, world-to-camera)`;
	}
	if (!Array.isArray(camera.t) || camera.t.length !== 3 || !camera.t.every((value) => typeof value === "number" && Number.isFinite(value))) {
		return `field '${label}.camera.t' must be 3 finite numbers`;
	}
	if (lineEdit.prompt !== undefined && typeof lineEdit.prompt !== "string") {
		return `field '${label}.prompt' must be a string when present`;
	}
	return null;
}

/* ------------------------------------------------------------------------- */
/* the request field (contract C10)                                            */
/* ------------------------------------------------------------------------- */

/**
 * `body.replay`: the line edits to re-apply to the take this request generates.
 *
 * Each entry is a C6 payload MINUS sourceMotion — the base is the take being
 * generated right now, so a stored source id would name a take that is about to
 * be superseded. Sending one anyway is refused rather than ignored: silently
 * dropping it would let a client believe it chose the base.
 *
 * Returns an error message naming the offending field, or null when valid.
 */
export function validateReplay(body, clipFrames, { seedMax = DEFAULT_SEED_MAX } = {}) {
	const replay = body?.replay;
	if (!Array.isArray(replay)) {
		return "field 'replay' must be an array of line-edit payloads (contract C10)";
	}
	// Exclusivity first, for the same reason C6 checks it first: a body carrying
	// both is two run modes, and guessing which take the replay applies to is not
	// the bridge's call. Plain generation, a prompt schedule and preserve all
	// produce ONE fresh take, which is exactly what a replay needs.
	for (const field of REPLAY_EXCLUSIVE) {
		if (body[field] !== undefined) {
			return (
				`field 'replay' cannot be combined with ${field}: contract C10 replays onto the take this request ` +
				"generates, and a spliced or rewritten take leaves the replay base ambiguous"
			);
		}
	}
	if (replay.length > REPLAY_MAX) {
		return `field 'replay' is capped at ${REPLAY_MAX} entries, got ${replay.length} (contract C10)`;
	}
	for (let index = 0; index < replay.length; index += 1) {
		const entry = replay[index];
		const label = `replay[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return `field '${label}' must be an object`;
		}
		if (entry.sourceMotion !== undefined) {
			return (
				`field '${label}.sourceMotion' must be omitted: contract C10 rebinds every replay entry to the take ` +
				"this request generates"
			);
		}
		// Preview is a 20-step draft for the interactive loop. A replay is the
		// take's history being rebuilt, so it always runs at full quality — an
		// entry asking otherwise is a client bug, not a preference.
		if (entry.preview !== undefined) {
			return `field '${label}.preview' must be omitted: contract C10 replays always run at full quality`;
		}
		if (entry.seed !== undefined && (!Number.isInteger(entry.seed) || entry.seed < 0 || entry.seed > seedMax)) {
			return `field '${label}.seed' must be an integer in 0..${seedMax}`;
		}
		const error = validateLineEditFields(entry, clipFrames, label);
		if (error) return error;
	}
	return null;
}

/* ------------------------------------------------------------------------- */
/* the boundary rule                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The INTERNAL block boundaries of a generated take: the frame where one
 * prompt block's rollout hands over to the next.
 *
 * Why they matter (the user's catch, verified in pf-chain): block N+1 is
 * conditioned on block N's PRE-edit tail. An edit that does not touch a block
 * tail leaves that tail byte-identical, so replaying it reproduces the same
 * chain exactly; an edit that DOES touch a tail changes what block N+1 was
 * conditioned on, and the replayed take can drift after the seam.
 *
 * The clip end is excluded — there is no block after it to condition — and a
 * request with no `segments` field (or with fewer than two blocks in it) is a
 * single rollout, so it has no internal boundaries at all.
 *
 * `segments` entries are contiguous by the time they get here (the bridge
 * refuses anything else), so their endFrames ARE the cumulative ones.
 */
export function blockBoundaries(segments, clipFrames) {
	if (!Array.isArray(segments) || segments.length < 2) return [];
	const boundaries = [];
	for (const segment of segments) {
		const end = segment?.endFrame;
		if (!Number.isInteger(end) || end <= 0 || end >= clipFrames) continue;
		if (!boundaries.includes(end)) boundaries.push(end);
	}
	return boundaries;
}

/**
 * Does this half-open app-frame range come close enough to a block boundary to
 * be warned about?
 *
 * The window is [boundary - margin, boundary + margin] INCLUSIVE and the range
 * is [startFrame, endFrame) — so the last constrained frame is endFrame - 1 and
 * the two intersect iff `startFrame <= boundary + margin` and
 * `endFrame - 1 >= boundary - margin`.
 *
 * The margin is small (5 frames, ~0.2 s) on purpose: the conditioning window the
 * next block reads is the tail of the previous one, and a warning that fires on
 * half the clip would be ignored. NON-BLOCKING by contract — it is a note on the
 * report, never a refusal.
 */
export function boundaryWarningFor(frameRange, boundaries, margin = BOUNDARY_MARGIN) {
	if (!frameRange || !Array.isArray(boundaries) || boundaries.length === 0) return false;
	const { startFrame, endFrame } = frameRange;
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) return false;
	return boundaries.some(
		(boundary) => startFrame <= boundary + margin && endFrame - 1 >= boundary - margin
	);
}

/* ------------------------------------------------------------------------- */
/* the sequential run                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Re-apply a recipe's line edits to a freshly generated take, in order.
 *
 * @param {object} options
 * @param {object[]} options.entries  validated C10 entries, application order.
 * @param {string} options.takePath  the fresh take entry 0 edits.
 * @param {string} options.artifactDir  where replay-<i>.npz files are written.
 * @param {number[]} [options.boundaries]  internal block boundaries (app frames).
 * @param {number} [options.boundaryMargin=5]
 * @param {number} [options.appFps=24]
 * @param {Function} options.runJob  runLineEditJob, injected so the sequencing
 *   can be tested without a GPU — the chaining and the failure policy are the
 *   only logic here, and they are where the bugs would be.
 * @param {(line: string) => void} [options.onStatus]
 * @returns {Promise<{entries: object[], takePath: string}>} the per-entry report
 *   (C10 shape) and the path of the LAST GOOD take — what the caller registers.
 */
export async function runReplay({
	entries,
	takePath,
	artifactDir,
	boundaries = [],
	boundaryMargin = BOUNDARY_MARGIN,
	appFps = 24,
	runJob,
	onStatus,
} = {}) {
	if (!Array.isArray(entries)) throw new Error("runReplay: entries must be an array");
	if (!takePath) throw new Error("runReplay: takePath is required");
	if (!artifactDir) throw new Error("runReplay: artifactDir is required");
	if (typeof runJob !== "function") throw new Error("runReplay: runJob is required");
	const status = typeof onStatus === "function" ? onStatus : () => {};
	const report = [];
	// The chain cursor. It only ever moves onto a file a job actually wrote, so a
	// failed entry leaves it pointing at the last take that exists on disk.
	let current = takePath;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const outputPath = join(artifactDir, `replay-${index}.npz`);
		const boundaryWarning = boundaryWarningFor(entry.frameRange, boundaries, boundaryMargin);
		status(
			`[bridge] replay ${index + 1}/${entries.length}: ${entry.track} over frames ` +
			`${entry.frameRange.startFrame}..${entry.frameRange.endFrame - 1}`
		);
		if (boundaryWarning) {
			status(
				`[bridge] replay ${index + 1}/${entries.length} WARNING: frames ` +
				`${entry.frameRange.startFrame}..${entry.frameRange.endFrame - 1} sit within ${boundaryMargin} frames of a ` +
				`block boundary (${boundaries.join(", ")}); the next block was conditioned on the UNEDITED tail, ` +
				"so this edit may not replay exactly"
			);
		}
		let ok = true;
		let error;
		let seamStartDelta = null;
		let seamEndDelta = null;
		try {
			const meta = await runJob({
				lineEdit: entry,
				takePath: current,
				outputPath,
				appFps,
				...(entry.seed === undefined ? {} : { seed: entry.seed }),
				onStatus: status,
			});
			// The job's own output path, not the one we asked for: they are the same
			// file, and reading it back from the meta keeps this loop honest about
			// what actually got written.
			current = meta?.output || outputPath;
			seamStartDelta = Number.isFinite(meta?.seamStartDelta) ? meta.seamStartDelta : null;
			seamEndDelta = Number.isFinite(meta?.seamEndDelta) ? meta.seamEndDelta : null;
			status(
				`[bridge] replay ${index + 1}/${entries.length} applied: seams ` +
				`${seamStartDelta === null ? "n/a" : seamStartDelta.toFixed(4)} / ` +
				`${seamEndDelta === null ? "n/a" : seamEndDelta.toFixed(4)} m`
			);
		} catch (err) {
			// LOUD, and then on with the run: the take the artist asked for exists,
			// and losing one refinement is recoverable by drawing it again. Losing
			// the whole generation is not.
			ok = false;
			error = err?.message || String(err);
			status(
				`[bridge] replay ${index + 1}/${entries.length} FAILED (${entry.track}): ${error} — ` +
				"continuing from the last good take"
			);
		}
		report.push({
			index,
			track: entry.track,
			ok,
			boundaryWarning,
			seamStartDelta,
			seamEndDelta,
			...(ok ? {} : { error }),
		});
	}
	return { entries: report, takePath: current };
}
