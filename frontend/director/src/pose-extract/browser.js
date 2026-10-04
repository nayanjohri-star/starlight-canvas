/**
 * Browser extraction boundary shared by uploaded video and webcam frames.
 * The UI supplies an async iterable of `{ image, timeS }` and an already
 * configured detector (for MediaPipe: `detectForVideo(image, timeS * 1000)`).
 * Keeping model creation outside this module makes model URL/revision,
 * telemetry gating and first-use caching explicit at the App integration site.
 */

function confidenceOf(landmarks) {
	if (!Array.isArray(landmarks) || landmarks.length === 0) return -Infinity;
	return landmarks.reduce((sum, point) =>
		sum + (Number.isFinite(point?.visibility) ? point.visibility : 1), 0
	) / landmarks.length;
}

export function selectMostConfidentPerson(result) {
	const candidates = result?.worldLandmarks ?? result?.landmarks ?? [];
	if (!Array.isArray(candidates) || candidates.length === 0) return null;
	return candidates.reduce((best, candidate) =>
		confidenceOf(candidate) > confidenceOf(best) ? candidate : best
	, null);
}

export async function collectLandmarkTrack({ frames, detect, onProgress = () => {} }) {
	if (!frames || typeof frames[Symbol.asyncIterator] !== "function") {
		throw new Error("collectLandmarkTrack: frames must be an async iterable");
	}
	if (typeof detect !== "function") throw new Error("collectLandmarkTrack: detect must be a function");
	const samples = [];
	let processed = 0;
	for await (const frame of frames) {
		if (!frame || !Number.isFinite(frame.timeS) || frame.timeS < 0 || !("image" in frame)) {
			throw new Error("collectLandmarkTrack: each frame needs image and non-negative timeS");
		}
		const result = await detect(frame.image, frame.timeS * 1000);
		const landmarks = selectMostConfidentPerson(result);
		if (landmarks) samples.push({ timeS: frame.timeS, landmarks });
		processed += 1;
		onProgress({ processed, accepted: samples.length, timeS: frame.timeS });
	}
	return samples;
}
