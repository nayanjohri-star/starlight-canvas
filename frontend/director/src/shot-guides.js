// Composition guides for the shot frame, after Blender's camera display
// options: overlay geometry only, expressed in a normalized 0..100 frame
// space so one description serves every aspect ratio. Pure data — the React
// layer stretches it over whichever DOM rect currently shows the shot frame.

export const GUIDE_STORAGE_KEY = "cozyclay.shot-guides.v1";

/** cycle order; "off" first so the default costs nothing */
export const GUIDE_MODES = Object.freeze(["off", "thirds", "golden", "center", "safe"]);

export const GUIDE_LABELS = Object.freeze({
	off: Object.freeze({ en: "Guides off", ko: "가이드 끔" }),
	thirds: Object.freeze({ en: "Thirds", ko: "삼분할" }),
	golden: Object.freeze({ en: "Golden ratio", ko: "골든 레이쇼" }),
	center: Object.freeze({ en: "Center + diagonals", ko: "센터·대각선" }),
	safe: Object.freeze({ en: "Safe areas", ko: "세이프 에어리어" }),
});

export function nextGuideMode(mode) {
	const index = GUIDE_MODES.indexOf(mode);
	return GUIDE_MODES[(index + 1) % GUIDE_MODES.length] ?? GUIDE_MODES[0];
}

export function normalizeGuideMode(value) {
	return GUIDE_MODES.includes(value) ? value : "off";
}

// The golden split, measured from either edge: 1/phi^2 of the frame.
const GOLDEN = 100 * (1 - 1 / 1.61803398875); // ≈ 38.196…

const line = (x1, y1, x2, y2) => Object.freeze({ x1, y1, x2, y2 });

function splitLines(low, high) {
	return [
		line(low, 0, low, 100),
		line(high, 0, high, 100),
		line(0, low, 100, low),
		line(0, high, 100, high),
	];
}

/**
 * Guide geometry for a mode in the normalized frame.
 * Returns { lines: [{x1,y1,x2,y2}], rects: [{x,y,width,height,kind}] }.
 */
export function guideGeometry(mode) {
	switch (normalizeGuideMode(mode)) {
		case "thirds":
			return Object.freeze({ lines: Object.freeze(splitLines(100 / 3, 200 / 3)), rects: Object.freeze([]) });
		case "golden":
			return Object.freeze({ lines: Object.freeze(splitLines(GOLDEN, 100 - GOLDEN)), rects: Object.freeze([]) });
		case "center":
			return Object.freeze({
				lines: Object.freeze([
					line(50, 0, 50, 100),
					line(0, 50, 100, 50),
					line(0, 0, 100, 100),
					line(100, 0, 0, 100),
				]),
				rects: Object.freeze([]),
			});
		case "safe":
			// Blender's defaults: action safe 90%, title safe 80% of the frame.
			return Object.freeze({
				lines: Object.freeze([]),
				rects: Object.freeze([
					Object.freeze({ x: 5, y: 5, width: 90, height: 90, kind: "action" }),
					Object.freeze({ x: 10, y: 10, width: 80, height: 80, kind: "title" }),
				]),
			});
		default:
			return Object.freeze({ lines: Object.freeze([]), rects: Object.freeze([]) });
	}
}

export function readStoredGuideMode(storage) {
	try {
		return normalizeGuideMode(storage?.getItem(GUIDE_STORAGE_KEY));
	} catch {
		return "off";
	}
}

export function writeStoredGuideMode(storage, mode) {
	try {
		storage?.setItem(GUIDE_STORAGE_KEY, normalizeGuideMode(mode));
	} catch {
		// Storage can be unavailable (private mode); guides simply stop persisting.
	}
}
