import { retimeMotion } from "./retime.js";
import { sliceMotion } from "./trim.js";

const SPEED_MIN = 0.1;
const SPEED_MAX = 4;
const SPEED_STEP = 0.1;
const normalizeSpeed = (speed) => Math.round(Number(speed) / SPEED_STEP) * SPEED_STEP;

const segmentSourceFrames = (segment) => segment.sourceEnd - segment.sourceStart + 1;
const segmentTimelineFrames = (segment) => Math.max(1, Math.round(segmentSourceFrames(segment) / segment.speed));

export function createMotionEdit(frames) {
	if (!Number.isInteger(frames) || frames < 1) {
		throw new Error("createMotionEdit: frames must be a positive integer");
	}
	return [{ id: "motion-0", sourceStart: 0, sourceEnd: frames - 1, speed: 1 }];
}

export function motionEditDuration(edit) {
	if (!Array.isArray(edit) || edit.length < 1) return 0;
	return edit.reduce((total, segment) => total + segmentTimelineFrames(segment), 0);
}

export function motionEditLayout(edit) {
	let cursor = 0;
	return edit.map((segment) => {
		const frames = segmentTimelineFrames(segment);
		const item = {
			...segment,
			timelineStart: cursor,
			timelineEnd: cursor + frames - 1,
			timelineFrames: frames,
		};
		cursor += frames;
		return item;
	});
}

export function timelineFrameToMotionFrame(edit, frame) {
	const layout = motionEditLayout(edit);
	if (layout.length < 1) return Math.max(0, Math.round(frame) || 0);
	const timelineFrame = Math.max(0, Math.min(Number.isFinite(frame) ? frame : 0, layout.at(-1).timelineEnd));
	const segment = layout.find((item) => timelineFrame <= item.timelineEnd) ?? layout.at(-1);
	if (segment.timelineFrames <= 1) return segment.sourceStart;
	const local = timelineFrame - segment.timelineStart;
	const progress = local / (segment.timelineFrames - 1);
	return segment.sourceStart + progress * (segment.sourceEnd - segment.sourceStart);
}

/** The inverse of timelineFrameToMotionFrame: which timeline frame shows a
 * SOURCE frame under this edit. Returns null when no segment covers it (the
 * source range was deleted or trimmed away). When two segments cover the same
 * source frame (a cut boundary), the first segment answers. */
export function motionFrameToTimelineFrame(edit, sourceFrame) {
	if (!Array.isArray(edit) || edit.length < 1 || !Number.isFinite(sourceFrame)) return null;
	const layout = motionEditLayout(edit);
	const segment = layout.find((item) => sourceFrame >= item.sourceStart && sourceFrame <= item.sourceEnd);
	if (!segment) return null;
	if (segment.sourceEnd === segment.sourceStart) return segment.timelineStart;
	const progress = (sourceFrame - segment.sourceStart) / (segment.sourceEnd - segment.sourceStart);
	return Math.round(segment.timelineStart + progress * (segment.timelineFrames - 1));
}

/**
 * Where an OLD timeline frame lands after a segment edit (#79): old timeline
 * → source → new timeline, each leg piecewise-linear per segment. Returns
 * null when the frame's source content no longer exists in the new edit.
 * Anything pinned to timeline frames (IK correction keys, prompt clips) must
 * ride this mapping when segments change, or it stays glued to frame NUMBERS
 * while the POSES those numbers address move away.
 */
export function remapTimelineFrame(previousEdit, nextEdit, frame) {
	const source = timelineFrameToMotionFrame(previousEdit, frame);
	return motionFrameToTimelineFrame(nextEdit, source);
}

/** Migrate a frame-keyed Map through a segment edit. Values move untouched;
 * a speed-up can land two old frames on one new frame — the earlier old
 * frame wins so an authored key is never silently replaced by a later one —
 * and keys whose source frames were deleted drop out. */
export function remapFrameKeyMap(keys, previousEdit, nextEdit) {
	const out = new Map();
	for (const frame of [...keys.keys()].sort((a, b) => a - b)) {
		const mapped = remapTimelineFrame(previousEdit, nextEdit, frame);
		if (mapped === null || out.has(mapped)) continue;
		out.set(mapped, keys.get(frame));
	}
	return out;
}

export function splitMotionEdit(edit, timelineFrame) {
	if (!Array.isArray(edit) || edit.length < 1) return edit;
	const layout = motionEditLayout(edit);
	const cut = Math.round(timelineFrame);
	if (cut <= 0 || cut >= motionEditDuration(edit)) return edit;
	const index = layout.findIndex((segment) => cut > segment.timelineStart && cut <= segment.timelineEnd);
	if (index < 0) return edit;
	const segment = layout[index];
	const sourceCut = Math.max(
		segment.sourceStart + 1,
		Math.min(segment.sourceEnd, Math.round(timelineFrameToMotionFrame(edit, cut))),
	);
	if (sourceCut <= segment.sourceStart || sourceCut > segment.sourceEnd) return edit;
	const next = [...edit];
	next.splice(index, 1,
		{ id: `${segment.id}-a`, sourceStart: segment.sourceStart, sourceEnd: sourceCut - 1, speed: segment.speed },
		{ id: `${segment.id}-b`, sourceStart: sourceCut, sourceEnd: segment.sourceEnd, speed: segment.speed },
	);
	return next;
}

export function setMotionSegmentSpeed(edit, id, speed) {
	const normalized = normalizeSpeed(speed);
	if (!Number.isFinite(normalized) || normalized < SPEED_MIN || normalized > SPEED_MAX) {
		throw new Error("setMotionSegmentSpeed: speed must be between 0.1 and 4.0 in 0.1 steps");
	}
	return edit.map((segment) => segment.id === id ? { ...segment, speed: Number(normalized.toFixed(1)) } : segment);
}

/** Delete one segment from the edit. The last remaining segment stays: an
 * empty edit has no duration, and "no motion" is clearMotion's job, not a
 * segment operation's. Unknown ids return the edit unchanged. */
export function removeMotionSegment(edit, id) {
	if (!Array.isArray(edit) || edit.length < 2) return edit;
	const next = edit.filter((segment) => segment.id !== id);
	return next.length === edit.length ? edit : next;
}

/** The speed that renders a segment across `timelineFrames` production
 * frames — the drag-resize inverse of segmentTimelineFrames. Clamped to the
 * same 0.1x..4x range and 0.1 grid setMotionSegmentSpeed enforces, so a drag
 * can never commit a speed the numeric input would reject. */
export function motionSegmentSpeedForFrames(segment, timelineFrames) {
	const frames = Math.max(1, Math.round(Number(timelineFrames) || 1));
	const raw = segmentSourceFrames(segment) / frames;
	const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw));
	return Number(normalizeSpeed(clamped).toFixed(1));
}

export function trimMotionEdit(edit, startFrame, endFrame) {
	if (!Array.isArray(edit) || edit.length < 1) return edit;
	const duration = motionEditDuration(edit);
	if (
		!Number.isInteger(startFrame) ||
		!Number.isInteger(endFrame) ||
		startFrame < 0 ||
		endFrame >= duration ||
		startFrame > endFrame
	) {
		throw new Error(`trimMotionEdit: range ${startFrame}..${endFrame} is outside 0..${duration - 1}`);
	}
	const layout = motionEditLayout(edit);
	return layout.flatMap((segment) => {
		const overlapStart = Math.max(startFrame, segment.timelineStart);
		const overlapEnd = Math.min(endFrame, segment.timelineEnd);
		if (overlapStart > overlapEnd) return [];
		const sourceStart = Math.ceil(timelineFrameToMotionFrame(edit, overlapStart));
		const sourceEnd = Math.floor(timelineFrameToMotionFrame(edit, overlapEnd));
		return [{
			id: `${segment.id}-trim-${sourceStart}`,
			sourceStart: Math.max(segment.sourceStart, sourceStart),
			sourceEnd: Math.min(segment.sourceEnd, sourceEnd),
			speed: segment.speed,
		}];
	}).filter((segment) => segment.sourceStart <= segment.sourceEnd);
}

function copyFrame(source, sourceFrame, target, targetFrame, stride) {
	const from = sourceFrame * stride;
	target.set(source.subarray(from, from + stride), targetFrame * stride);
}

export function renderMotionEdit(full, edit) {
	if (!full || !Number.isInteger(full.frames) || full.frames < 1 || !Number.isFinite(full.fps) || full.fps <= 0) {
		throw new Error("renderMotionEdit: motion must have positive frames and fps");
	}
	const segments = Array.isArray(edit) && edit.length ? edit : createMotionEdit(full.frames);
	const rendered = segments.map((segment) => {
		const sliced = sliceMotion(full, segment.sourceStart, segment.sourceEnd);
		return segment.speed === 1 ? sliced : retimeMotion(sliced, full.fps / segment.speed);
	});
	const frames = rendered.reduce((total, motion) => total + motion.frames, 0);
	const rotStride = full.rotMats.length / full.frames;
	const rootStride = full.rootPos.length / full.frames;
	const posedStride = full.posedJoints.length / full.frames;
	const rotMats = new Float32Array(frames * rotStride);
	const rootPos = new Float32Array(frames * rootStride);
	const posedJoints = new Float32Array(frames * posedStride);
	let cursor = 0;
	for (let index = 0; index < rendered.length; index += 1) {
		const motion = rendered[index];
		const segment = segments[index];
		for (let frame = 0; frame < motion.frames; frame += 1) {
			const finalFrame = frame === motion.frames - 1 && segment.speed > 1;
			const sourceMotion = finalFrame ? full : motion;
			const sourceFrame = finalFrame ? segment.sourceEnd : frame;
			copyFrame(sourceMotion.rotMats, sourceFrame, rotMats, cursor + frame, rotStride);
			copyFrame(sourceMotion.rootPos, sourceFrame, rootPos, cursor + frame, rootStride);
			copyFrame(sourceMotion.posedJoints, sourceFrame, posedJoints, cursor + frame, posedStride);
		}
		cursor += motion.frames;
	}
	return {
		...full,
		frames,
		fps: full.fps,
		rotMats,
		rootPos,
		posedJoints,
		anchorFrame: 0,
		editSegments: segments.map((segment) => ({ ...segment })),
	};
}
