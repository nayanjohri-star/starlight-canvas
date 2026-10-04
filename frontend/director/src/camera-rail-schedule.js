/**
 * Rail Follow time clip — pure schedule math.
 *
 * The spatial rail (cameraRail) says WHERE the dolly may go; the Rail Follow
 * clip says WHEN. A shot has at most one clip, drawn as a thin ribbon on the
 * Camera lane, and its schedule lives in the persisted `railFollow` field:
 *
 *   null                        legacy-derived — the clip is the whole timeline
 *                               until the first edit; the serializer omits the
 *                               field entirely so old payloads stay untouched
 *   {mode:"range",startFrame,endFrame}  authored range, both ends inclusive
 *   {mode:"off"}                explicit removal — never resurrects on reload
 *
 * Every function here is pure: storage values in, plain answers out, no
 * state, no React. The camera-owner decision is a separate pure step so the
 * timeline can render the clip (ribbon, progress, handles) even while the
 * follow cam is off.
 */

/** minimum inclusive clip length: 10 frames @ 20 fps = 0.5 s */
export const RAIL_FOLLOW_MIN_FRAMES = 10;

/** resolved schedule kinds — what the clip looks like right now */
export const RAIL_SCHEDULE_NONE = "none"; // no usable rail geometry at all
export const RAIL_SCHEDULE_TOO_SHORT = "too-short"; // timeline can't hold a 10-frame clip
export const RAIL_SCHEDULE_OFF = "off"; // explicitly removed, must not resurrect
export const RAIL_SCHEDULE_RANGE = "range"; // authored range, inclusive both ends
export const RAIL_SCHEDULE_LEGACY = "legacy"; // pre-railFollow payload: whole timeline

/** camera owners at a frame — MoveRig and FollowCamRig must never both win */
export const RAIL_OWNER_NONE = "none";
export const RAIL_OWNER_RAIL = "rail";
export const RAIL_OWNER_KEYS = "keys";

const finite = Number.isFinite;

/** the persisted rail is usable when it holds at least two finite points */
export function isRailUsable(cameraRail) {
	return (
		Array.isArray(cameraRail) &&
		cameraRail.length >= 2 &&
		cameraRail.every((point) => !!point && finite(point.x) && finite(point.z))
	);
}

/**
 * Fit a range into a timeline: clamp both ends into [0, frameCount-1] and
 * enforce the 10-inclusive-frame minimum by extending (never by shrinking a
 * longer clip). Returns null when the range is structurally invalid or the
 * timeline is too short to hold the minimum clip. Never grows a range beyond
 * what was stored, so re-clamping after a timeline grows back is a no-op.
 */
function fitRange(startFrame, endFrame, frameCount) {
	if (!finite(startFrame) || !finite(endFrame) || !finite(frameCount)) return null;
	const last = Math.floor(frameCount) - 1;
	if (last < 0) return null;
	let start = Math.max(0, Math.min(Math.round(startFrame), last));
	let end = Math.max(0, Math.min(Math.round(endFrame), last));
	if (start > end) return null;
	const minSpan = RAIL_FOLLOW_MIN_FRAMES - 1;
	if (end - start < minSpan) {
		if (frameCount < RAIL_FOLLOW_MIN_FRAMES) return null;
		end = Math.min(last, start + minSpan);
		start = Math.max(0, end - minSpan);
	}
	return { startFrame: start, endFrame: end };
}

/** the default clip range for a freshly drawn rail: the whole timeline */
export function defaultRailRange(frameCount) {
	if (!finite(frameCount) || frameCount < RAIL_FOLLOW_MIN_FRAMES) return null;
	return { startFrame: 0, endFrame: Math.floor(frameCount) - 1 };
}

/** A redrawn geometry keeps an authored time range, but never stale OFF. */
export function railFollowForNewGeometry(existing, frameCount) {
	if (existing?.mode === "range") return existing;
	return defaultRailRange(frameCount);
}

/**
 * Shrink-safe clamp for persisting an authored range when the timeline
 * changes: clamp once, store the result, and later growth cannot resurrect
 * the old (now out-of-bounds) range because this never expands it.
 */
export function clampRailRange(range, frameCount) {
	if (!range || typeof range !== "object") return null;
	return fitRange(range.startFrame, range.endFrame, frameCount);
}

/**
 * Move a clip by `delta` frames, preserving its length. The whole span stays
 * inside [0, frameCount-1]. Returns null when the range is not a valid
 * min-10 clip or cannot fit in the timeline.
 */
export function moveRailRange(range, delta, frameCount) {
	if (!range || typeof range !== "object" || !finite(delta) || !finite(frameCount)) return null;
	const start = Math.round(range.startFrame);
	const end = Math.round(range.endFrame);
	const length = end - start + 1;
	if (start > end || length < RAIL_FOLLOW_MIN_FRAMES || length > frameCount) return null;
	const last = Math.floor(frameCount) - 1;
	if (last < 0) return null;
	const maxStart = last - (length - 1);
	const shifted = start + Math.round(delta);
	const newStart = Math.max(0, Math.min(shifted, maxStart));
	return { startFrame: newStart, endFrame: newStart + length - 1 };
}

/**
 * Resize a clip by moving one edge to `frame`. The result keeps the other
 * edge fixed, stays inside the timeline, and is never shorter than the
 * 10-inclusive-frame minimum. Returns null when no valid range can keep the
 * fixed edge (the timeline is too short at that side) or the inputs are
 * structurally invalid.
 */
export function resizeRailRange(range, edge, frame, frameCount) {
	if (!range || typeof range !== "object" || (edge !== "start" && edge !== "end")) return null;
	if (!finite(frame) || !finite(frameCount)) return null;
	const last = Math.floor(frameCount) - 1;
	if (last < 0) return null;
	const start = Math.max(0, Math.min(Math.round(range.startFrame), last));
	const end = Math.max(0, Math.min(Math.round(range.endFrame), last));
	if (start > end) return null;
	const target = Math.max(0, Math.min(Math.round(frame), last));
	const minSpan = RAIL_FOLLOW_MIN_FRAMES - 1;
	if (edge === "end") {
		const minEnd = start + minSpan;
		if (minEnd > last) return null;
		return { startFrame: start, endFrame: Math.max(minEnd, Math.min(target, last)) };
	}
	const maxStart = end - minSpan;
	if (maxStart < 0) return null;
	return { startFrame: Math.min(maxStart, Math.max(target, 0)), endFrame: end };
}

/**
 * Resolve the persisted schedule into what the clip looks like right now.
 * Order matters: no rail beats everything (there is nothing to schedule),
 * then a timeline too short to hold a clip hides it, then the stored modes
 * apply. Corrupt ranges fold to "off" — never invent a clip the data does
 * not support.
 */
export function resolveRailSchedule({ railFollow, cameraRail, frameCount }) {
	if (!isRailUsable(cameraRail)) return { kind: RAIL_SCHEDULE_NONE };
	if (!finite(frameCount) || frameCount < RAIL_FOLLOW_MIN_FRAMES) return { kind: RAIL_SCHEDULE_TOO_SHORT };
	const last = Math.floor(frameCount) - 1;
	if (!railFollow) return { kind: RAIL_SCHEDULE_LEGACY, startFrame: 0, endFrame: last };
	if (railFollow.mode === RAIL_SCHEDULE_OFF) return { kind: RAIL_SCHEDULE_OFF };
	if (railFollow.mode === RAIL_SCHEDULE_RANGE) {
		const fitted = fitRange(railFollow.startFrame, railFollow.endFrame, frameCount);
		if (fitted) return { kind: RAIL_SCHEDULE_RANGE, ...fitted };
		return { kind: RAIL_SCHEDULE_OFF };
	}
	return { kind: RAIL_SCHEDULE_OFF };
}

/** is `frame` inside the clip? Both ends are inclusive. */
export function activeAt(schedule, frame) {
	if (!schedule || !finite(frame)) return false;
	if (schedule.kind !== RAIL_SCHEDULE_RANGE && schedule.kind !== RAIL_SCHEDULE_LEGACY) return false;
	return frame >= schedule.startFrame && frame <= schedule.endFrame;
}

/**
 * Which camera owns `frame`? Kept deliberately separate from
 * resolveRailSchedule so the caller passes explicit rail usability (the
 * built geometry, not just the stored points) and the resolved schedule.
 *
 *   follow off            -> none (keys/free hold as before)
 *   no usable geometry    -> none (free follow owns the whole clip)
 *   off / too-short / none-> none
 *   inside the clip       -> rail
 *   outside the clip      -> keys (the caller's existing no-keys fallback
 *                             to free/hold applies as before)
 */
export function railCameraOwner({ followEnabled, railUsable, schedule, frame }) {
	if (followEnabled !== true || !railUsable) return RAIL_OWNER_NONE;
	if (activeAt(schedule, frame)) return RAIL_OWNER_RAIL;
	if (schedule && (schedule.kind === RAIL_SCHEDULE_RANGE || schedule.kind === RAIL_SCHEDULE_LEGACY)) return RAIL_OWNER_KEYS;
	return RAIL_OWNER_NONE;
}
