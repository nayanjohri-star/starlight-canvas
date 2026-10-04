// trim.js — cut a loaded take to a frame range. The slice is a NEW motion
// object in the exact npz-decoded shape; the caller keeps the original, so
// trimming is non-destructive and re-trimming always cuts from the full
// take. Frame 0 of the slice becomes the playback anchor: applyMotionFrame
// re-anchors X/Z on the anchor frame, so a mid-clip cut plays at the
// character's placement instead of teleporting to the original frame 0.
// The spread carries every non-array field with the slice — `personScale`
// included: a cut is the same performer, and a take that lost its stature
// mid-edit would replay the remaining frames at the wrong stride length.

import { CSKEL27_JOINTS } from "./cskel27.js";

export function sliceMotion(motion, startFrame, endFrame) {
	if (!motion || !Number.isInteger(motion.frames) || motion.frames < 1) {
		throw new Error("sliceMotion: motion.frames must be a positive integer");
	}
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) {
		throw new Error("sliceMotion: startFrame and endFrame must be integers");
	}
	if (startFrame < 0 || endFrame >= motion.frames || startFrame > endFrame) {
		throw new Error(`sliceMotion: range ${startFrame}..${endFrame} is outside 0..${motion.frames - 1}`);
	}
	const joints = CSKEL27_JOINTS.length;
	const frames = endFrame - startFrame + 1;
	return {
		...motion,
		frames,
		rotMats: motion.rotMats.slice(startFrame * joints * 9, (endFrame + 1) * joints * 9),
		rootPos: motion.rootPos.slice(startFrame * 3, (endFrame + 1) * 3),
		posedJoints: motion.posedJoints.slice(startFrame * joints * 3, (endFrame + 1) * joints * 3),
		anchorFrame: 0,
	};
}
