// detector.js — the App-side loader for MediaPipe's PoseLandmarker. Model
// creation stays out of browser.js on purpose (see that header): this module
// is where the engine version, the download sources and the failure names
// live, so "extraction is broken" always decomposes into which piece failed.
//
// Both the wasm engine and the .task weights are runtime downloads. The wasm
// must match the npm bundle compiled into this build byte-for-byte, so its
// URL is pinned to the same version; the weights are ~9 MB of Google binaries
// that belong in neither this repo nor its npm package. Offline is therefore
// a NAMED failure, never a hang or a silent fallback.

export const TASKS_VISION_VERSION = "0.10.17"; // must equal the @mediapipe/tasks-vision entry in package.json — the JS bundle and the wasm ABI move together
export const POSE_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// "full", not "lite": every caller here is an offline pass over a still photo or
// already-recorded footage, so the ~9 MB download and the slower per-frame cost
// buy landmark accuracy that nothing downstream can recover once it is lost.
// Only switch back if a realtime (camera-preview) caller ever appears.
export const POSE_MODEL_URL =
	"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
// "heavy" is the same landmark contract at the top of the accuracy ladder, paid
// for with a ~25 MB one-time download and several times the per-frame cost. That
// price is per FRAME, so it is only affordable where there is one: a single
// photograph. A clip of a few hundred frames stays on "full".
export const POSE_MODEL_URL_HEAVY =
	"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";
// The choice is a name at the call site, not a URL: callers say what they are
// extracting from, and this table decides what that costs.
export const POSE_MODELS = Object.freeze({
	full: POSE_MODEL_URL,
	heavy: POSE_MODEL_URL_HEAVY,
});

/**
 * Create a `{ detect, close }` pair for collectLandmarkTrack. Every failure
 * mode has its own name:
 *   pose-model-unknown         — `model` is not a key of POSE_MODELS (caller bug)
 *   pose-runtime-unavailable   — the JS bundle did not load (broken build)
 *   pose-model-download-failed — the .task weights were unreachable
 *   pose-engine-download-failed— the wasm engine was unreachable
 *   pose-engine-init-failed    — the engine loaded but refused to start
 * The GPU delegate is tried first and CPU is the retry: WebGPU blocklists
 * are common and a slower extraction beats a refused one.
 */
export async function createPoseDetector({
	wasmBase = POSE_WASM_BASE,
	model = "full", // "heavy" for a single still; see POSE_MODELS
	modelUrl, // an explicit URL wins over `model` — pinning a revision stays possible
	fetchImpl,
	loadRuntime,
	numPoses = 2, // the footage guidance allows two performers in frame; selectMostConfidentPerson picks one
	runningMode = "VIDEO", // "IMAGE" for a still: MediaPipe rejects detectForVideo outside VIDEO mode
} = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	const resolvedModelUrl = modelUrl ?? POSE_MODELS[model];
	if (!resolvedModelUrl) throw new Error("pose-model-unknown");
	let runtime;
	try {
		runtime = await (loadRuntime ?? (() => import("@mediapipe/tasks-vision")))();
	} catch {
		throw new Error("pose-runtime-unavailable");
	}
	let modelAssetBuffer;
	try {
		const response = await doFetch(resolvedModelUrl);
		if (!response.ok) throw new Error(`http-${response.status}`);
		modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
	} catch {
		throw new Error("pose-model-download-failed");
	}
	let fileset;
	try {
		fileset = await runtime.FilesetResolver.forVisionTasks(wasmBase);
	} catch {
		throw new Error("pose-engine-download-failed");
	}
	const optionsFor = (delegate) => ({
		baseOptions: { modelAssetBuffer, delegate },
		runningMode,
		numPoses,
		outputSegmentationMasks: false,
	});
	let landmarker;
	try {
		landmarker = await runtime.PoseLandmarker.createFromOptions(fileset, optionsFor("GPU"));
	} catch {
		try {
			landmarker = await runtime.PoseLandmarker.createFromOptions(fileset, optionsFor("CPU"));
		} catch {
			throw new Error("pose-engine-init-failed");
		}
	}
	return {
		// One `detect(image, timestampMs)` shape for both modes so the frame
		// supply — a clip or a still — is the only thing that differs.
		detect: runningMode === "IMAGE"
			? (image) => landmarker.detect(image)
			: (image, timestampMs) => landmarker.detectForVideo(image, Math.round(timestampMs)),
		close: () => landmarker.close?.(),
	};
}
