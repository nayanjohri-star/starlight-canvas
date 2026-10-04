// image-frame.js — single-still frame supply for pose extraction. A photo is
// the degenerate footage case: no duration, no seeking, one frame at t=0.
// Shaped as the same async iterable videoFrames yields so collectLandmarkTrack
// consumes a still and a clip through one code path.

function waitForDecode(image, timeoutMs) {
	// A cached image can already be complete before a listener is attached;
	// waiting for a load event that will never fire again would hang.
	if (image.complete && (image.naturalWidth ?? 0) > 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => finish(new Error("image-load-timeout")), timeoutMs);
		const onLoad = () => finish(null);
		const onError = () => finish(new Error("decode-failed"));
		function finish(error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			image.removeEventListener?.("load", onLoad);
			image.removeEventListener?.("error", onError);
			if (error) reject(error);
			else resolve();
		}
		image.addEventListener("load", onLoad);
		image.addEventListener("error", onError);
	});
}

/**
 * Decode one still and hand back the element itself — what the IMAGE-mode
 * landmarker accepts, so no canvas copy sits between the decoder and the
 * detector. Split out of imageFrames because a caller that runs its own
 * detection passes over the still (mirror.js) needs the decode without the
 * frame-supply shape, and the load/timeout rules must not be written twice.
 * Failures are named: `image-load-timeout`, `decode-failed`.
 */
export async function decodeImage(objectUrl, { createImage, timeoutMs = 8000 } = {}) {
	if (typeof createImage !== "function") throw new Error("imageFrames: createImage is required");
	const image = createImage();
	image.src = objectUrl;
	await waitForDecode(image, timeoutMs);
	return image;
}

/**
 * Async-iterate the one `{ image, timeS }` frame a still supplies. Shaped like
 * videoFrames so collectLandmarkTrack consumes a still and a clip alike.
 */
export async function* imageFrames(objectUrl, options = {}) {
	yield { image: await decodeImage(objectUrl, options), timeS: 0 };
}
