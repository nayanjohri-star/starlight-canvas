// video-frames.js — seek-stepped frame supply for landmark extraction. The
// video element is injected (same pattern as probeFootage) so the node suite
// drives exactly the stepping the app runs. Frames come out in ascending time
// order, which is also the contract detectForVideo enforces on timestamps.

/**
 * The times extraction samples: t=0 plus every whole step inside the
 * duration — the same counting rule as frameCountFor, so a clip's sample
 * count and its timeline frame count agree at equal rates. The final sample
 * is backed off the stream end by 1 ms: a seek to the exact duration lands
 * past the last presentable frame on some decoders.
 */
export function sampleTimes(durationS, sampleFps) {
	if (!(durationS > 0) || !(sampleFps > 0)) return [];
	const count = Math.floor(durationS * sampleFps + 1e-6) + 1;
	const tail = Math.max(0, durationS - 1e-3);
	const times = [];
	for (let i = 0; i < count; i += 1) times.push(Math.min(i / sampleFps, tail));
	if (times.length > 1 && times[times.length - 1] <= times[times.length - 2]) times.pop();
	return times;
}

function waitForData(video, timeoutMs) {
	if ((video.readyState ?? 0) >= 2) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => finish(new Error("footage-load-timeout")), timeoutMs);
		const onLoaded = () => finish(null);
		const onError = () => finish(new Error("decode-failed"));
		function finish(error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			video.removeEventListener?.("loadeddata", onLoaded);
			video.removeEventListener?.("error", onError);
			if (error) reject(error);
			else resolve();
		}
		video.addEventListener("loadeddata", onLoaded);
		video.addEventListener("error", onError);
		video.load?.();
	});
}

function seekTo(video, timeS, timeoutMs) {
	// The first sample is usually t=0 with the decoder already sitting there;
	// assigning currentTime=0 again fires no seeked event, so that case must
	// resolve without waiting for one.
	if (Math.abs((video.currentTime ?? 0) - timeS) < 1e-4 && (video.readyState ?? 0) >= 2) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => finish(new Error("seek-timeout")), timeoutMs);
		const onSeeked = () => finish(null);
		const onError = () => finish(new Error("decode-failed"));
		function finish(error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			video.removeEventListener?.("seeked", onSeeked);
			video.removeEventListener?.("error", onError);
			if (error) reject(error);
			else resolve();
		}
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onError);
		video.currentTime = timeS;
	});
}

/**
 * Async-iterate `{ image, timeS }` frames from already-ingested footage.
 * `image` is the video element itself — exactly what detectForVideo accepts —
 * so no canvas copy sits between the decoder and the detector.
 */
export async function* videoFrames(objectUrl, { createVideo, sampleFps = 20, timeoutMs = 8000 } = {}) {
	if (typeof createVideo !== "function") throw new Error("videoFrames: createVideo is required");
	const video = createVideo();
	video.src = objectUrl;
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	await waitForData(video, timeoutMs);
	const times = sampleTimes(Number(video.duration), sampleFps);
	if (times.length === 0) throw new Error("duration-unreadable");
	for (const timeS of times) {
		await seekTo(video, timeS, timeoutMs);
		yield { image: video, timeS };
	}
}
