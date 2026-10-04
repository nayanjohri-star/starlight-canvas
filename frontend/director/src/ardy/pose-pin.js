/**
 * Which frames a generation request pins, and why.
 *
 * The bridge has two modes and they are mutually exclusive. `posePin: true`
 * sends full-body poses and runs the box's pose mode; `segments` (a prompt
 * schedule) uses autoregressive history and demands `posePin: false`. Getting
 * that wrong is a rejected request, so the decision is made here, once, as
 * data — not spread across the call site where it cannot be tested.
 *
 * Pinning is deliberately NOT automatic for a loaded take. Pose mode builds on
 * a fixed implicit reference base, so pinning a whole clip makes a new prompt
 * dress up the same canned root path ("I changed the prompt but got the same
 * walk"). The cases below are the ones where a pin is what the operator asked
 * for:
 *
 *   - `startFromPose` — the character's blocking pose is pinned at a chosen
 *     frame and the motion is generated around it. The frame is the operator's
 *     choice: the first frame to leave from, the last to arrive at, or any
 *     frame in between to pass through.
 *   - authored IK edits — corrections addressed to specific frames.
 *   - block edits — IK keys inside a scheduled block, addressed to that take.
 */

/** Reasons a request ends up unpinned, so the caller can explain itself. */
export const PIN_BLOCKED = Object.freeze({
	SCHEDULE: "prompt-schedule",
	NOTHING_TO_PIN: "nothing-to-pin",
});

/**
 * @param {object} input
 * @param {boolean} input.startFromPose  operator asked to continue from the pose
 * @param {boolean} input.hasPromptSchedule  more than one prompt block
 * @param {boolean} input.hasBlockEdits  IK keys land inside scheduled blocks
 * @param {boolean} input.waypointMode  a root path is being authored
 * @param {number[]} input.ikFrames  timeline frames carrying authored IK keys
 * @param {number} input.clipFrames  the clip's length in timeline frames
 * @param {{startFrame:number,endFrame:number}[]} input.segments
 * @param {{startFrame:number,endFrame:number}[]} input.editedSegments
 * @returns {{pin: boolean, frames: number[], blockedBy: string|null}}
 */
export function planPosePin({
	startFromPose = false,
	poseFrame = 0,
	hasPromptSchedule = false,
	hasBlockEdits = false,
	waypointMode = false,
	ikFrames = [],
	clipFrames = 0,
	segments = [],
	editedSegments = [],
}) {
	// The pin must land inside the clip the box is about to generate: an
	// out-of-range destination is refused at the far end of the pipeline, so it
	// is clamped here where the clip length is known.
	const pinFrame = Math.max(0, Math.min(Math.max(0, clipFrames - 1), Math.round(poseFrame) || 0));
	// A schedule cannot be pinned at all: the bridge refuses the combination,
	// so an opted-in pose start has to be reported as blocked rather than
	// silently dropped.
	if (hasPromptSchedule && !hasBlockEdits) {
		return {
			pin: false,
			frames: [],
			blockedBy: startFromPose ? PIN_BLOCKED.SCHEDULE : PIN_BLOCKED.NOTHING_TO_PIN,
		};
	}

	const wantsPin = hasBlockEdits || ikFrames.length > 0 || startFromPose;
	if (!wantsPin) return { pin: false, frames: [], blockedBy: PIN_BLOCKED.NOTHING_TO_PIN };

	// A root path is generated from frame 0 outward, so one pin at the start is
	// the whole constraint — pinning later frames would fight the path.
	if (waypointMode) return { pin: true, frames: [0], blockedBy: null };

	if (hasBlockEdits) {
		const frames = ikFrames.filter((frame) =>
			editedSegments.some((segment) => frame >= segment.startFrame && frame < segment.endFrame)
		);
		return { pin: frames.length > 0, frames, blockedBy: frames.length > 0 ? null : PIN_BLOCKED.NOTHING_TO_PIN };
	}

	// A pose placement is exactly one constraint, at the chosen frame. Anything
	// more would pin motion the operator never authored.
	if (ikFrames.length === 0) return { pin: true, frames: [pinFrame], blockedBy: null };

	const frames = [...new Set([
		...(startFromPose ? [pinFrame] : []),
		...segments.flatMap((segment) => [
			segment.startFrame,
			Math.min(segment.endFrame - 1, segment.startFrame + 1),
			Math.max(segment.startFrame, segment.endFrame - 2),
			segment.endFrame - 1,
		]),
		...ikFrames.filter((frame) => frame >= 0 && frame < clipFrames),
	])].sort((a, b) => a - b);
	return { pin: frames.length > 0, frames, blockedBy: null };
}
