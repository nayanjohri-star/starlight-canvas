import { muxMP4 } from "./mp4-muxer.js";
import { topDownRgba, validatePixelDimensions } from './export-pixels.js';

export const REFERENCE_VIDEO_MAX_SECONDS = 30;
export const REFERENCE_VIDEO_FPS = Object.freeze([24, 30]);

const CODECS = Object.freeze([
	Object.freeze({ codec: "avc1.640032", avc: Object.freeze({ format: "avc" }) }),
	Object.freeze({ codec: "avc1.4d0032", avc: Object.freeze({ format: "avc" }) }),
	Object.freeze({ codec: "avc1.420032", avc: Object.freeze({ format: "avc" }) }),
]);

export function normalizeFrameRange(startFrame, endFrame) {
	const start = startFrame, end = endFrame;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || !Number.isSafeInteger(end - start + 1)) {
		throw new RangeError("export frame range must be an inclusive non-negative range");
	}
	return { startFrame: start, endFrame: end, frameCount: end - start + 1 };
}

export function referenceVideoPlan(startFrame, endFrame, fps) {
	const range = normalizeFrameRange(startFrame, endFrame);
	if (!REFERENCE_VIDEO_FPS.includes(fps)) throw new RangeError('Reference video fps must be 24 or 30');
	if (range.frameCount > fps * REFERENCE_VIDEO_MAX_SECONDS) throw withExportFailureCode(new RangeError('A reference video cannot exceed 30 seconds. Export each shot separately.'), 'range_too_long');
	return { ...range, fps, durationSeconds: range.frameCount / fps, durationUs: Math.round(range.frameCount * 1_000_000 / fps) };
}

export function exportFrameTiming(index, fps) {
	const timestamp = Math.round(index * 1_000_000 / fps);
	return { timestamp, duration: Math.round((index + 1) * 1_000_000 / fps) - timestamp };
}

export async function pixelHash(pixels, subtle = globalThis.crypto?.subtle) {
	if (!subtle) throw new Error("Web Crypto is unavailable; pixel hashes cannot be computed");
	const digest = new Uint8Array(await subtle.digest("SHA-256", pixels));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withExportFailureCode(error, code) {
	try {
		Object.defineProperty(error, "exportFailureCode", {
			value: error?.name === "AbortError" ? "aborted" : code,
			configurable: true,
		});
	} catch {
		// Preserve the original thrown value even if a foreign/frozen error
		// cannot carry metadata. Classification must not replace the error.
	}
	return error;
}

// Native codec probes/flushes are not guaranteed to settle after cancellation.
// Race them against the signal while observing late rejections and removing
// the listener on every outcome. The encoder itself is closed by its owner.
function abortable(promise, signal) {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const abort = () => { cleanup(); reject(abortError()); };
		const cleanup = () => signal.removeEventListener("abort", abort);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(promise).then(
			(value) => { cleanup(); resolve(value); },
			(error) => { cleanup(); reject(error); },
		);
	});
}

async function supportedEncoderConfig(width, height, fps, VideoEncoderClass, signal) {
	for (const candidate of CODECS) {
		if (signal?.aborted) throw abortError();
		const config = {
			...candidate,
			width,
			height,
			framerate: fps,
			bitrate: Math.max(2_000_000, Math.round(width * height * fps * 0.24)),
			latencyMode: "quality",
		};
		try {
			const support = await abortable(VideoEncoderClass.isConfigSupported(config), signal);
			if (support.supported) return support.config;
		} catch (error) {
			if (error?.name === "AbortError") throw error;
			// Try the next H.264 profile. A browser can expose WebCodecs while a
			// particular hardware/software encoder profile is unavailable.
		}
	}
	if (signal?.aborted) throw abortError();
	throw withExportFailureCode(new Error("This browser has no H.264 WebCodecs encoder for MP4 export"), "unsupported_codec");
}

function abortError() {
	return new DOMException("Offscreen export was cancelled", "AbortError");
}

/**
 * Address and encode every frame in an inclusive range. `capture(frame, passKind)` must
 * synchronously apply that absolute frame and return bottom-up RGBA bytes from
 * the offscreen WebGL render target. No playback or animation clock is used.
 */
export async function exportOffscreenVideo({
	startFrame,
	endFrame,
	fps,
	width,
	height,
	capture,
	signal,
	passKind = null,
	onFrame,
	onPhase,
	VideoEncoderClass = globalThis.VideoEncoder,
	VideoFrameClass = globalThis.VideoFrame,
}) {
	if (signal?.aborted) throw abortError();
	const range = referenceVideoPlan(startFrame, endFrame, fps);
	validatePixelDimensions(width, height);
	if (typeof capture !== "function") throw new TypeError("export capture must be a function");
	if (!VideoEncoderClass || !VideoFrameClass) throw withExportFailureCode(new Error("This browser does not support WebCodecs video export"), "unsupported_codec");

	const config = await supportedEncoderConfig(width, height, fps, VideoEncoderClass, signal);
	if (signal?.aborted) throw abortError();
	const chunks = [];
	let decoderConfig = null;
	const hashes = [];
	let encoderError = null;
	let encoder = null;
	let failureCode = "encode_failed";
	const closeEncoder = () => {
		try {
			if (encoder && encoder.state !== "closed") encoder.close();
		} catch {
			// Cleanup must not replace the original failure or cancellation.
		}
	};
	try {
		encoder = new VideoEncoderClass({
			output(chunk, metadata) {
				try {
					if (signal?.aborted) return;
					const index = Math.round(chunk.timestamp * fps / 1_000_000), timing = exportFrameTiming(index, fps);
					if (index < 0 || index >= range.frameCount || chunk.timestamp !== timing.timestamp) throw new Error(`Unexpected encoded timestamp ${chunk.timestamp}`);
					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);
					chunks.push({
						timestamp: chunk.timestamp,
						duration: timing.duration,
						type: chunk.type,
						data,
					});
					if (!decoderConfig && metadata?.decoderConfig) decoderConfig = metadata.decoderConfig;
				} catch (error) {
					encoderError = error;
				}
			},
			error(error) {
				encoderError = error;
			},
		});
		signal?.addEventListener("abort", closeEncoder, { once: true });
		if (signal?.aborted) throw abortError();
		onPhase?.({ phase: "encoding", cancellable: true });
		if (signal?.aborted) throw abortError();
		const topDown = new Uint8ClampedArray(width * height * 4);
		const keyInterval = Math.max(1, Math.round(fps * 2));
		encoder.configure(config);
		for (let index = 0; index < range.frameCount; index += 1) {
			if (signal?.aborted) throw abortError();
			if (encoderError) throw encoderError;
			const frame = range.startFrame + index;
			failureCode = "render_failed";
			const pixels = capture(frame, passKind);
			if (!(pixels instanceof Uint8Array) || pixels.byteLength !== topDown.byteLength) {
				throw new Error(`frame ${frame} returned ${pixels?.byteLength ?? 0} RGBA bytes; expected ${topDown.byteLength}`);
			}
			const hash = await abortable(pixelHash(pixels), signal);
			hashes.push(hash);
			topDownRgba(pixels, { width, height }, topDown);
			failureCode = "encode_failed";
			if (signal?.aborted) throw abortError();
			const videoFrame = new VideoFrameClass(topDown, {
				format: "RGBA",
				codedWidth: width,
				codedHeight: height,
				...exportFrameTiming(index, fps),
			});
			try {
				encoder.encode(videoFrame, { keyFrame: index % keyInterval === 0 });
			} finally {
				videoFrame.close();
			}
			if (encoderError) throw encoderError;
			// Encoder-paced flush boundaries may change file bytes; determinism covers addressed pixels and their hashes only.
			if (encoder.encodeQueueSize > 4) await abortable(encoder.flush(), signal);
			onFrame?.({ frame, index, frameCount: range.frameCount, hash });
		}
		if (signal?.aborted) throw abortError();
		onPhase?.({ phase: "finalizing", stage: "flush", cancellable: true });
		if (signal?.aborted) throw abortError();
		await abortable(encoder.flush(), signal);
		if (signal?.aborted) throw abortError();
		if (encoderError) throw encoderError;
		encoder.close();

		if (chunks.length !== range.frameCount || new Set(chunks.map(chunk => chunk.timestamp)).size !== range.frameCount) {
			throw new Error(`WebCodecs emitted ${chunks.length} frames for ${range.frameCount} inputs`);
		}
		// Mux finalization cannot be interrupted internally; disclose that stage
		// and wait for it to settle before releasing the shared export lock.
		onPhase?.({ phase: "finalizing", stage: "mux", cancellable: false });
		const blob = await muxMP4({
			chunks,
			codec: config.codec,
			decoderConfig: decoderConfig ?? {
				codec: config.codec,
				codedWidth: width,
				codedHeight: height,
			},
			signal,
		});
		if (signal?.aborted) throw abortError();
		return {
			...range,
			fps,
			width,
			height,
			codec: config.codec,
			mimeType: blob.type,
			encodedFrameCount: chunks.length,
			hashes,
			blob,
		};
	} catch (error) {
		throw withExportFailureCode(error, failureCode);
	} finally {
		signal?.removeEventListener("abort", closeEncoder);
		closeEncoder();
	}
}
