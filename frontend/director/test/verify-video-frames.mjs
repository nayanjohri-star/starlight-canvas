import assert from "node:assert/strict";
import { createPoseDetector } from "../src/pose-extract/detector.js";
import { sampleTimes, videoFrames } from "../src/pose-extract/video-frames.js";

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance = 1e-9) { return Math.abs(a - b) <= tolerance; }

/* --- sampleTimes ----------------------------------------------------------- */

{
	const times = sampleTimes(1, 20);
	assert.equal(times.length, 21); // frame at t=0 plus every whole frame inside — frameCountFor's rule
	assert.ok(near(times[1], 0.05));
	assert.ok(times[20] < 1); // the tail backs off the stream end
	pass("sampleTimes counts like frameCountFor and backs the tail off the end");
}

{
	assert.deepEqual(sampleTimes(0, 20), []);
	assert.deepEqual(sampleTimes(1, 0), []);
	assert.deepEqual(sampleTimes(NaN, 20), []);
	pass("sampleTimes refuses unusable inputs with an empty list");
}

{
	// A clip shorter than one step still yields its t=0 frame.
	const times = sampleTimes(0.02, 20);
	assert.equal(times.length, 1);
	assert.equal(times[0], 0);
	pass("a sub-step clip still yields its first frame");
}

/* --- videoFrames ----------------------------------------------------------- */

function fakeSeekableVideo({ duration = 0.5, failLoad = false, failSeekAt = null, stallSeeks = false } = {}) {
	const listeners = {};
	const fire = (type) => { for (const fn of listeners[type] ?? []) fn(); };
	const video = {
		duration,
		currentTime: 0,
		readyState: 0,
		seeks: [],
		addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
		removeEventListener(type, fn) {
			listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== fn);
		},
		load() {
			queueMicrotask(() => {
				if (failLoad) { fire("error"); return; }
				video.readyState = 2;
				fire("loadeddata");
			});
		},
	};
	Object.defineProperty(video, "currentTime", {
		get() { return video._t ?? 0; },
		set(value) {
			video._t = value;
			video.seeks.push(value);
			if (stallSeeks) return;
			queueMicrotask(() => {
				if (failSeekAt !== null && value >= failSeekAt) fire("error");
				else fire("seeked");
			});
		},
	});
	return video;
}

{
	const video = fakeSeekableVideo({ duration: 0.25 });
	const seen = [];
	for await (const frame of videoFrames("blob:x", { createVideo: () => video, sampleFps: 20 })) {
		assert.equal(frame.image, video); // the element itself, no canvas copy
		seen.push(frame.timeS);
	}
	assert.equal(seen.length, 6); // 0.25 s at 20 fps: frames 0..5
	assert.ok(near(seen[0], 0) && near(seen[5], 0.249));
	assert.equal(video.seeks.filter((t) => t === 0).length, 0); // t=0 never re-seeks: the decoder is already there
	pass("frames step the real element through ascending sample times");
}

{
	const failed = await (async () => {
		try {
			for await (const _ of videoFrames("blob:x", { createVideo: () => fakeSeekableVideo({ failLoad: true }) })) void _;
			return null;
		} catch (error) { return error.message; }
	})();
	assert.equal(failed, "decode-failed");
	pass("an undecodable clip fails closed by name");
}

{
	const failed = await (async () => {
		try {
			for await (const _ of videoFrames("blob:x", { createVideo: () => fakeSeekableVideo({ duration: 0.5, failSeekAt: 0.2 }) })) void _;
			return null;
		} catch (error) { return error.message; }
	})();
	assert.equal(failed, "decode-failed");
	pass("a decode error mid-clip fails closed by name");
}

{
	const failed = await (async () => {
		try {
			for await (const _ of videoFrames("blob:x", { createVideo: () => fakeSeekableVideo({ duration: 0.5, stallSeeks: true }), timeoutMs: 40 })) void _;
			return null;
		} catch (error) { return error.message; }
	})();
	assert.equal(failed, "seek-timeout");
	pass("a stalled seek is named, never an endless hang");
}

/* --- createPoseDetector failure names -------------------------------------- */

const okModelFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });

{
	const failed = await createPoseDetector({
		loadRuntime: async () => { throw new Error("boom"); },
		fetchImpl: okModelFetch,
	}).catch((error) => error.message);
	assert.equal(failed, "pose-runtime-unavailable");
	pass("a missing JS runtime is named");
}

{
	const failed = await createPoseDetector({
		loadRuntime: async () => ({}),
		fetchImpl: async () => ({ ok: false, status: 404 }),
	}).catch((error) => error.message);
	assert.equal(failed, "pose-model-download-failed");
	pass("an unreachable model download is named");
}

{
	const failed = await createPoseDetector({
		loadRuntime: async () => ({
			FilesetResolver: { forVisionTasks: async () => { throw new Error("offline"); } },
		}),
		fetchImpl: okModelFetch,
	}).catch((error) => error.message);
	assert.equal(failed, "pose-engine-download-failed");
	pass("an unreachable wasm engine is named");
}

{
	const delegates = [];
	const failed = await createPoseDetector({
		loadRuntime: async () => ({
			FilesetResolver: { forVisionTasks: async () => ({}) },
			PoseLandmarker: {
				createFromOptions: async (_fileset, options) => {
					delegates.push(options.baseOptions.delegate);
					throw new Error("no delegate");
				},
			},
		}),
		fetchImpl: okModelFetch,
	}).catch((error) => error.message);
	assert.equal(failed, "pose-engine-init-failed");
	assert.deepEqual(delegates, ["GPU", "CPU"]); // GPU first, CPU is the retry, then a named refusal
	pass("engine init tries GPU then CPU before failing by name");
}

{
	const calls = [];
	const detector = await createPoseDetector({
		loadRuntime: async () => ({
			FilesetResolver: { forVisionTasks: async () => ({}) },
			PoseLandmarker: {
				createFromOptions: async () => ({
					detectForVideo: (image, timestampMs) => { calls.push([image, timestampMs]); return { worldLandmarks: [] }; },
					close: () => calls.push("closed"),
				}),
			},
		}),
		fetchImpl: okModelFetch,
	});
	detector.detect("frame", 33.4);
	assert.deepEqual(calls[0], ["frame", 33]); // detectForVideo wants integer ms
	detector.close();
	assert.equal(calls[1], "closed");
	pass("a working detector rounds timestamps and closes cleanly");
}

console.log("verify-video-frames: all checks passed");
