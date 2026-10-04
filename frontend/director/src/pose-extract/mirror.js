// mirror.js — test-time augmentation for the single-photograph path.
//
// One detection of one still is the least evidence this pipeline ever works
// from: there is no neighbouring frame to average against and no filter to run,
// so every landmark error lands whole in the saved pose. Two things are cheap
// to fix here. Detection noise is roughly independent between two views of the
// same photograph, so averaging two views halves it. And the model carries a
// lateral bias — it was trained on natural photographs, which are not
// left/right symmetric — so a mirrored second pass biases the other way and the
// average cancels it.
//
// The second view is the photograph flipped horizontally. Its detection comes
// back in flipped coordinates with left and right limbs traded, and
// mirrorLandmarks puts it back. Everything downstream sees one ordinary
// 33-landmark array and cannot tell it was measured twice.

import { selectMostConfidentPerson } from "./browser.js";

// MediaPipe Pose topology, left index ↔ right index. Every landmark the model
// emits in a pair is here; NOSE (0) is the only unpaired one, so it mirrors
// onto itself. Indices follow the published landmark order:
//   1,2,3 left eye inner/centre/outer   4,5,6 right eye inner/centre/outer
//   7 left ear        8 right ear
//   9 mouth left     10 mouth right
//  11 shoulder  13 elbow  15 wrist  17 pinky  19 index  21 thumb   (left)
//  12 shoulder  14 elbow  16 wrist  18 pinky  20 index  22 thumb   (right)
//  23 hip  25 knee  27 ankle  29 heel  31 foot index                (left)
//  24 hip  26 knee  28 ankle  30 heel  32 foot index                (right)
export const LEFT_RIGHT_PAIRS = Object.freeze([
	[1, 4], [2, 5], [3, 6], // eyes
	[7, 8], // ears
	[9, 10], // mouth corners
	[11, 12], [13, 14], [15, 16], // shoulder, elbow, wrist
	[17, 18], [19, 20], [21, 22], // pinky, index, thumb
	[23, 24], [25, 26], [27, 28], // hip, knee, ankle
	[29, 30], [31, 32], // heel, foot index
].map((pair) => Object.freeze(pair)));

const POSE_LANDMARK_COUNT = 33;

// index -> the index whose measurement belongs to it after a mirror.
const MIRROR_INDEX = Object.freeze((() => {
	const table = new Array(POSE_LANDMARK_COUNT).fill(0).map((_, index) => index);
	for (const [left, right] of LEFT_RIGHT_PAIRS) {
		table[left] = right;
		table[right] = left;
	}
	return table;
})());

function visibilityOf(point) {
	return Number.isFinite(point?.visibility) ? point.visibility : 1;
}

/**
 * Un-mirror a detection that ran on a horizontally flipped image: negate X and
 * trade every left/right pair. World landmarks are hip-centred metric
 * coordinates about the body's own origin, so negating X *is* the spatial
 * mirror — no image width enters. Visibility (and any other field) rides along
 * with the landmark it was measured on, because it describes that body part.
 *
 * The transform is its own inverse: mirroring twice returns the input.
 */
export function mirrorLandmarks(landmarks) {
	if (!Array.isArray(landmarks) || landmarks.length < POSE_LANDMARK_COUNT) {
		throw new Error("mirrorLandmarks: landmarks must contain the 33 MediaPipe Pose landmarks");
	}
	return landmarks.map((_, index) => {
		const source = landmarks[MIRROR_INDEX[index]];
		if (!source) return source ?? null;
		return { ...source, x: -source.x };
	});
}

/**
 * Per-landmark visibility-weighted mean of two detections of the same body.
 * Weighting by visibility lets the view that could actually see a limb carry
 * it; the averaged visibility is the plain mean of the two, not the max,
 * because a part one view could not see is genuinely less certain.
 * A missing landmark on one side yields the other side untouched.
 */
export function averageLandmarkSets(a, b) {
	if (!Array.isArray(a)) return Array.isArray(b) ? b : null;
	if (!Array.isArray(b)) return a;
	const length = Math.max(a.length, b.length);
	const averaged = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const pa = a[index];
		const pb = b[index];
		if (!pa || !pb) {
			averaged[index] = pa ?? pb ?? null;
			continue;
		}
		const wa = visibilityOf(pa);
		const wb = visibilityOf(pb);
		// Two invisible landmarks still have a position worth keeping; fall back
		// to an unweighted mean rather than dividing by zero.
		const total = wa + wb > 1e-9 ? wa + wb : 0;
		const mix = (key) => (total > 0
			? (pa[key] * wa + pb[key] * wb) / total
			: (pa[key] + pb[key]) / 2);
		averaged[index] = {
			...pa,
			x: mix("x"),
			y: mix("y"),
			z: mix("z"),
			visibility: (wa + wb) / 2,
		};
	}
	return averaged;
}

function sizeOf(image) {
	const width = image?.naturalWidth || image?.videoWidth || image?.width || 0;
	const height = image?.naturalHeight || image?.videoHeight || image?.height || 0;
	return { width, height };
}

/**
 * Detect the photograph and its horizontal mirror, and return the average of
 * the two as one ordinary landmark array (or null if neither view found a
 * person). `detect` is the IMAGE-mode detector's `detect(image)`; `createCanvas`
 * is injectable so this is testable without a DOM.
 *
 * Named failures, in the style of detector.js:
 *   pose-mirror-image-unsized  — the element has no decoded size to flip
 *   pose-mirror-canvas-failed  — no 2d context to draw the flip on
 */
export async function detectMirrorAveraged(image, detect, { createCanvas } = {}) {
	if (typeof detect !== "function") throw new Error("detectMirrorAveraged: detect must be a function");
	const { width, height } = sizeOf(image);
	if (!(width > 0) || !(height > 0)) throw new Error("pose-mirror-image-unsized");
	const makeCanvas = createCanvas ?? (() => document.createElement("canvas"));
	const canvas = makeCanvas();
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext?.("2d");
	if (!context) throw new Error("pose-mirror-canvas-failed");
	// translate to the right edge, then scale X by -1: the draw walks back
	// across the canvas and lands the image reversed.
	context.translate(width, 0);
	context.scale(-1, 1);
	context.drawImage(image, 0, 0, width, height);

	// Both passes are the same still at t=0; IMAGE mode ignores the timestamp.
	const direct = selectMostConfidentPerson(await detect(image, 0));
	const flipped = selectMostConfidentPerson(await detect(canvas, 0));
	if (!direct && !flipped) return null;
	if (!flipped) return direct;
	const unmirrored = mirrorLandmarks(flipped);
	if (!direct) return unmirrored;
	return averageLandmarkSets(direct, unmirrored);
}
