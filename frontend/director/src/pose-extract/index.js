/**
 * Public video-to-pose-keys contract.
 *
 * App wiring should pass MediaPipe world-landmark samples here, then merge
 * `result.keys` into the same `{ frame, pose }[]` list currently sent as
 * `body.poses`. The output is intentionally ordinary cozyclay.pose.v1 data:
 * no bridge endpoint, npz path or root-recovery schema is introduced.
 */

import { fitLandmarksToPose } from "./fit.js";
import { selectPoseKeyframes } from "./keyframes.js";
import { filterLandmarkTrack, normalizeLandmarkTrack } from "./landmarks.js";

export { collectLandmarkTrack, selectMostConfidentPerson } from "./browser.js";
export { createPoseDetector, POSE_MODELS, POSE_MODEL_URL, POSE_MODEL_URL_HEAVY, POSE_WASM_BASE, TASKS_VISION_VERSION } from "./detector.js";
export { sampleTimes, videoFrames } from "./video-frames.js";
export { decodeImage, imageFrames } from "./image-frame.js";
export { averageLandmarkSets, detectMirrorAveraged, LEFT_RIGHT_PAIRS, mirrorLandmarks } from "./mirror.js";
export { bakeExtractedTake, bakePoseFrame } from "./take.js";
export { fitLandmarksToPose } from "./fit.js";
export { poseChangeScores, selectPoseKeyframes } from "./keyframes.js";
export { filterLandmarkTrack, normalizeLandmarkSample, normalizeLandmarkTrack, POSE_LANDMARK } from "./landmarks.js";

export function videoLandmarksToPoseKeys({ samples, rest, fps = 20, ...options }) {
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error("videoLandmarksToPoseKeys: fps must be a positive finite number");
	}
	const normalized = normalizeLandmarkTrack(samples, options);
	const filtered = filterLandmarkTrack(normalized, options.filter);
	const { indices, scores } = selectPoseKeyframes(filtered, options);
	const keys = [];
	const diagnostics = [];
	for (const sampleIndex of indices) {
		const sample = filtered[sampleIndex];
		const frame = Math.max(0, Math.round(sample.timeS * fps));
		const fitted = fitLandmarksToPose({ sample, rest, createdMs: options.createdMs ?? 0 });
		const entry = { frame, pose: fitted.pose };
		const diagnostic = {
			frame,
			sampleIndex,
			sourceTimeS: sample.timeS,
			score: scores[sampleIndex],
			confidence: fitted.confidence,
			releasedBones: fitted.releasedBones,
		};
		const prior = keys[keys.length - 1];
		if (prior?.frame === frame) {
			if (diagnostic.score > diagnostics[diagnostics.length - 1].score) {
				keys[keys.length - 1] = entry;
				diagnostics[diagnostics.length - 1] = diagnostic;
			}
		} else {
			keys.push(entry);
			diagnostics.push(diagnostic);
		}
	}
	return { keys, diagnostics };
}
