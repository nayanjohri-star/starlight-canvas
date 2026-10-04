#!/usr/bin/env node
/**
 * Background removal, on pictures whose right answer is known exactly.
 *
 * Synthetic images are the point here, not a shortcut: a photograph can only
 * be judged by eye, but a red square on a grey wall has an exact expected
 * mask, and a wall that shades from top to bottom has an exact expected
 * failure mode for the global-threshold approach this one deliberately is not.
 */

import { webcrypto } from "node:crypto";
import {
	applyMask,
	backgroundMask,
	borderSeeds,
	combineMask,
	cropPixels,
	cutOutBackground,
	decodeMask,
	encodeMask,
	opaqueBounds,
	paintMask,
	removeBackground,
} from "../src/matte.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/** A picture built from a per-pixel function: (x, y) => [r, g, b, a]. */
function picture(width, height, paint) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a = 255] = paint(x, y);
			const index = (y * width + x) * 4;
			data[index] = r;
			data[index + 1] = g;
			data[index + 2] = b;
			data[index + 3] = a;
		}
	}
	return { data, width, height };
}
const alphaAt = ({ data, width }, x, y) => data[(y * width + x) * 4 + 3];
const inBox = (x, y, box) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

/* ------------------------------------------------ a subject on a wall ---- */

const BOX = { x0: 20, y0: 30, x1: 60, y1: 90 };
const flat = picture(80, 120, (x, y) => (inBox(x, y, BOX) ? [200, 60, 50] : [190, 192, 188]));
const cut = removeBackground(flat, { shrink: 0, feather: 0 });

expect("the wall is gone", alphaAt(cut, 2, 2) === 0 && alphaAt(cut, 78, 118) === 0 && alphaAt(cut, 40, 10) === 0);
expect("the subject is untouched", alphaAt(cut, 40, 60) === 255 && alphaAt(cut, 21, 31) === 255 && alphaAt(cut, 59, 89) === 255);
expect(
	"every subject pixel survives and every wall pixel does not",
	(() => {
		for (let y = 0; y < 120; y++) {
			for (let x = 0; x < 80; x++) {
				const kept = alphaAt(cut, x, y) > 0;
				if (kept !== inBox(x, y, BOX)) return false;
			}
		}
		return true;
	})(),
);
expect("the removal is reported as a count", cut.removed === 80 * 120 - 40 * 60, String(cut.removed));
expect("the source picture is not mutated", flat.data[3] === 255 && flat.data.at(-1) === 255);

/* ---------------------------------------------------- a shaded wall ------ */

// The wall runs 150 → 230 top to bottom: far wider than any tolerance that
// still leaves the subject alone. Local growth is the only thing that gets it.
const graded = picture(80, 120, (x, y) => (inBox(x, y, BOX) ? [40, 90, 190] : [150 + Math.round((y / 119) * 80), 150 + Math.round((y / 119) * 80), 148 + Math.round((y / 119) * 80)]));
const gradedCut = removeBackground(graded, { tolerance: 0.1, shrink: 0, feather: 0 });
expect(
	"a wall that shades top to bottom still goes in one piece",
	alphaAt(gradedCut, 5, 5) === 0 && alphaAt(gradedCut, 5, 60) === 0 && alphaAt(gradedCut, 5, 118) === 0,
);
expect("the subject survives the gradient", alphaAt(gradedCut, 40, 60) === 255);

/* ------------------------------------------- a subject touching the edge -- */

// A person standing at the bottom of the frame touches the border, so the
// border is not a reliable sample of background on its own. The dominant
// colours are: a minority colour on one edge is the subject, not the wall.
const ROOTED = { x0: 30, y0: 60, x1: 50, y1: 120 };
const rooted = picture(80, 120, (x, y) => (inBox(x, y, ROOTED) ? [30, 140, 60] : [205, 203, 200]));
const rootedCut = removeBackground(rooted, { shrink: 0, feather: 0 });
expect(
	"a subject standing on the frame edge is not eaten from its own feet",
	alphaAt(rootedCut, 40, 119) === 255 && alphaAt(rootedCut, 40, 80) === 255,
);
expect("the wall around it still goes", alphaAt(rootedCut, 5, 119) === 0 && alphaAt(rootedCut, 70, 60) === 0);

/* --------------------------------------------------- pointed at a colour -- */

const twoWalls = picture(60, 60, (x, y) => (y < 30 ? [40, 40, 44] : [220, 220, 216]));
const pointed = removeBackground(twoWalls, { points: [{ x: 5, y: 50 }], tolerance: 0.12, shrink: 0, feather: 0 });
expect(
	"clicking one background keeps the other side",
	alphaAt(pointed, 30, 50) === 0 && alphaAt(pointed, 30, 5) === 255,
);
expect(
	"seeds come from the click, not the frame",
	borderSeeds(twoWalls, [{ x: 5, y: 50 }]).seeds.length === 3,
);

/* ------------------------------------------------------ shrink & feather -- */

const shrunk = removeBackground(flat, { shrink: 1, feather: 0 });
expect("shrink eats the fringe of the kept region", alphaAt(shrunk, 20, 30) === 0 && alphaAt(shrunk, 22, 32) === 255);
const feathered = removeBackground(flat, { shrink: 0, feather: 1 });
const edge = alphaAt(feathered, 20, 60);
expect("feather softens the boundary without hollowing the subject", edge > 0 && edge < 255 && alphaAt(feathered, 40, 60) === 255, String(edge));

/* ----------------------------------------------------------------- trim -- */

const bounds = opaqueBounds(cut);
expect(
	"the trim box is exactly the subject",
	bounds.x === 20 && bounds.y === 30 && bounds.width === 40 && bounds.height === 60,
	JSON.stringify(bounds),
);
const cropped = cropPixels(cut, bounds);
expect("cropping keeps the picture, not the margin", cropped.width === 40 && cropped.height === 60 && alphaAt(cropped, 0, 0) === 255);
expect("a picture with nothing left has no box", opaqueBounds(picture(4, 4, () => [0, 0, 0, 0])) === null);

/* --------------------------------------------------- the browser glue ---- */

// Stubs for decode / canvas: enough of the API surface to drive the real path.
function stubs(source) {
	return {
		subtle: webcrypto.subtle,
		createBitmap: async () => ({ width: source.width, height: source.height, close() {} }),
		makeCanvas: (width, height) => {
			const store = { data: new Uint8ClampedArray(width * height * 4), width, height };
			return {
				getContext: () => ({
					drawImage: () => store.data.set(source.data),
					getImageData: () => ({ data: Uint8ClampedArray.from(source.data), width, height }),
					putImageData: (image) => store.data.set(image.data),
				}),
				convertToBlob: async ({ type }) => ({ type, arrayBuffer: async () => store.data.buffer.slice(0) }),
			};
		},
	};
}
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) {
		this.data = data;
		this.width = width;
		this.height = height ?? data.length / 4 / width;
	}
};

const asset = { id: "img-" + "a".repeat(32), type: "image/png", width: 80, height: 120, bytes: new ArrayBuffer(8), name: "sofa.png" };
const result = await cutOutBackground(asset, { shrink: 0, feather: 0 }, stubs(flat));
expect("the cut comes back as its own asset", result.asset.id !== asset.id && result.asset.type === "image/png");
expect("the cut asset is trimmed to the subject", result.asset.width === 40 && result.asset.height === 60);
expect("the name follows the picture", result.asset.name === "sofa.png");
expect(
	"the height scale keeps the subject the size it was",
	Math.abs(result.heightScale - 60 / 120) < 1e-9,
	String(result.heightScale),
);
expect("how much went is reported", Math.abs(result.removed - (80 * 120 - 40 * 60) / (80 * 120)) < 1e-9, String(result.removed));

const untrimmed = await cutOutBackground(asset, { shrink: 0, feather: 0, trim: false }, stubs(flat));
expect("trimming can be declined", untrimmed.asset.width === 80 && untrimmed.heightScale === 1);

await cutOutBackground(asset, { tolerance: 1.5 }, stubs(flat)).then(
	() => expect("a tolerance that eats everything fails with a readable reason", false, "resolved"),
	(error) => expect("a tolerance that eats everything fails with a readable reason", /lower tolerance/.test(error.message), error.message),
);
await cutOutBackground(null, {}, stubs(flat)).then(
	() => expect("a missing asset is refused", false, "resolved"),
	(error) => expect("a missing asset is refused", /asset record/.test(error.message), error.message),
);

/* ------------------------------------------------- mask, brush, combine -- */

const mask = backgroundMask(flat, {});
expect("the mask marks the wall and nothing else", mask[0] === 1 && mask[60 * 80 + 40] === 0 && mask.length === 80 * 120);

const paint = new Int8Array(80 * 120);
const touched = paintMask(paint, { width: 80, height: 120 }, { x: 40, y: 60, radius: 4, value: 1 });
expect("a stroke is a disc, and reports what it touched", touched > 40 && touched < 60 && paint[60 * 80 + 40] === 1 && paint[60 * 80 + 50] === 0);
expect("painting the same pixels again touches nothing", paintMask(paint, { width: 80, height: 120 }, { x: 40, y: 60, radius: 4, value: 1 }) === 0);
expect(
	"a stroke at the edge is clipped, not wrapped",
	paintMask(paint, { width: 80, height: 120 }, { x: 0, y: 0, radius: 3, value: 1 }) > 0 && paint[79] === 0,
);

const combined = combineMask(mask, paint, { width: 80, height: 120 });
expect("a remove stroke cuts into the subject", combined[60 * 80 + 40] === 1 && mask[60 * 80 + 40] === 0);
const restore = new Int8Array(80 * 120);
paintMask(restore, { width: 80, height: 120 }, { x: 5, y: 5, radius: 3, value: -1 });
expect("a restore stroke puts the wall back", combineMask(mask, restore, { width: 80, height: 120 })[5 * 80 + 5] === 0);
expect("no paint layer leaves the mask alone", combineMask(mask, null, { width: 80, height: 120 })[0] === 1);

// The editor paints on a preview; the mask it lands on was grown at full size.
const halfPaint = new Int8Array(40 * 60);
paintMask(halfPaint, { width: 40, height: 60 }, { x: 20, y: 30, radius: 3, value: 1 });
const upscaled = combineMask(mask, halfPaint, { width: 80, height: 120, paintWidth: 40, paintHeight: 60 });
expect(
	"a stroke painted on a half-size preview lands in the right place",
	// (40, 60) is the middle of the subject and under the stroke; (25, 35) is
	// also subject, but nowhere near it.
	upscaled[60 * 80 + 40] === 1 && upscaled[35 * 80 + 25] === 0,
);

const applied = applyMask(flat, mask, { shrink: 0, feather: 0 });
expect("applying a mask writes the alpha and counts what went", applied.removed === 80 * 120 - 40 * 60 && alphaAt(applied, 2, 2) === 0);
const painterly = removeBackground(flat, { mask: combined, shrink: 0, feather: 0 });
expect(
	"a hand-edited mask can be applied directly, strokes and all",
	painterly.removed === combined.reduce((sum, value) => sum + value, 0) && painterly.removed > applied.removed,
	`${painterly.removed} vs ${applied.removed}`,
);

const painted = await cutOutBackground(asset, { shrink: 0, feather: 0, paint, paintWidth: 80, paintHeight: 120 }, stubs(flat));
expect("the glue takes a paint layer with it", painted.asset.id !== result.asset.id);

const handCut = await cutOutBackground(asset, { shrink: 0, feather: 0, mask: combined }, stubs(flat));
expect(
	"a mask made by hand is applied as-is, not re-grown",
	handCut.asset.width === 40 && handCut.asset.height === 60 - 0 && handCut.removed > result.removed,
	JSON.stringify({ w: handCut.asset.width, h: handCut.asset.height, removed: handCut.removed }),
);
await cutOutBackground(asset, { mask: new Uint8Array(4) }, stubs(flat)).then(
	() => expect("a mask from another picture is refused", false, "resolved"),
	(error) => expect("a mask from another picture is refused", /different picture/.test(error.message), error.message),
);


/* -------------------------------------------------- the mask as a file -- */

// The stub canvas hands its own pixels back, which is exactly what a real PNG
// round trip does for a black-and-white image.
const maskCanvas = (width, height) => {
	const store = { data: new Uint8ClampedArray(width * height * 4) };
	return {
		getContext: () => ({
			drawImage: () => {},
			putImageData: (image) => store.data.set(image.data),
			getImageData: () => ({ data: Uint8ClampedArray.from(store.data), width, height }),
		}),
		convertToBlob: async ({ type }) => ({ type, arrayBuffer: async () => store.data.buffer.slice(0) }),
	};
};
const encoded = await encodeMask(mask, { width: 80, height: 120 }, { makeCanvas: maskCanvas });
expect("a mask encodes to storable bytes", encoded.byteLength === 80 * 120 * 4);
const restored = await decodeMask(
	{ bytes: encoded, type: "image/png" },
	{
		createBitmap: async () => ({ width: 80, height: 120, close() {} }),
		makeCanvas: (width, height) => ({
			getContext: () => ({
				drawImage: () => {},
				getImageData: () => ({ data: new Uint8ClampedArray(encoded), width, height }),
			}),
		}),
	},
);
expect(
	"a stored mask comes back exactly as it went in",
	restored.width === 80 && restored.height === 120 && restored.mask.every((value, pixel) => value === mask[pixel]),
);

/* ------------------------------------------------------------- fenced -- */

// The eraser grows through what is already selected and stops where the
// selection does — the same tool as the brush, pointed the other way.
const fence = new Uint8Array(80 * 120);
for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) fence[y * 80 + x] = 1;
const fenced = backgroundMask(flat, { points: [{ x: 2, y: 2 }], tolerance: 0.18, within: fence });
expect(
	"a fenced growth stays inside the fence",
	fenced[2 * 80 + 2] === 1 && fenced[30 * 80 + 2] === 1 && fenced[80 * 80 + 2] === 0,
);
expect(
	"a seed outside the fence grows nothing",
	backgroundMask(flat, { points: [{ x: 2, y: 100 }], tolerance: 0.18, within: fence }).every((value) => value === 0),
);

/* --------------------------------------------- thin things survive ------ */

/**
 * A comb: teeth 1 to 10 px wide standing on a bar, against a flat wall. This
 * is the shape every fine subject reduces to — hair, branches, chair legs, an
 * antenna — and a blanket one-pixel erosion deletes all of it.
 */
const COMB_TEETH = [[20, 1], [30, 2], [45, 3], [60, 4], [75, 6], [95, 10]];
const comb = picture(140, 80, (x, y) => {
	const onBar = y >= 60 && y < 70 && x >= 10 && x < 130;
	const onTooth = COMB_TEETH.some(([at, wide]) => x >= at && x < at + wide && y >= 20 && y < 60);
	return onBar || onTooth ? [60, 70, 120] : [200, 202, 198];
});
const combed = removeBackground(comb, { tolerance: 0.18, shrink: 1, feather: 0 });
const toothWidth = ([at, wide]) => {
	let solid = 0;
	for (let x = at; x < at + wide; x++) if (combed.data[(40 * 140 + x) * 4 + 3] >= 128) solid += 1;
	return solid;
};
expect(
	"a one, two or three pixel structure survives the trim whole",
	toothWidth(COMB_TEETH[0]) === 1 && toothWidth(COMB_TEETH[1]) === 2 && toothWidth(COMB_TEETH[2]) === 3,
	JSON.stringify(COMB_TEETH.map((tooth) => `${tooth[1]}px→${toothWidth(tooth)}`)),
);
expect(
	"a mass still gets its rim taken, one pixel from each side",
	toothWidth(COMB_TEETH[3]) === 2 && toothWidth(COMB_TEETH[4]) === 4 && toothWidth(COMB_TEETH[5]) === 8,
	JSON.stringify(COMB_TEETH.map((tooth) => `${tooth[1]}px→${toothWidth(tooth)}`)),
);

/**
 * And the rim it exists for: a photographed edge is a pixel of subject mixed
 * with a pixel of wall, too far from the wall's own colour for the growth to
 * take. Left alone it rings the cutout in half-wall, which on a set reads as
 * an outline drawn round the card.
 */
const WALL = [200, 202, 198];
const SUBJECT = [60, 70, 120];
const blend = (t) => WALL.map((value, channel) => Math.round(value * (1 - t) + SUBJECT[channel] * t));
const rimmed = picture(60, 40, (x, y) => {
	if (x >= 20 && x < 40 && y >= 12 && y < 28) return SUBJECT;
	if (x >= 19 && x < 41 && y >= 11 && y < 29) return blend(0.5);
	if (x >= 18 && x < 42 && y >= 10 && y < 30) return blend(0.15);
	return WALL;
});
const rimMask = backgroundMask(rimmed, { tolerance: 0.18 });
const rimAlpha = (result, x, y) => result.data[(y * 60 + x) * 4 + 3];
expect(
	"without the trim the blended rim survives as a ring of half-wall",
	rimAlpha(applyMask(rimmed, rimMask, { shrink: 0, feather: 0 }), 19, 20) > 0,
);
expect(
	"with it the rim goes and the subject stays",
	(() => {
		const trimmed = applyMask(rimmed, rimMask, { shrink: 1, feather: 0 });
		return rimAlpha(trimmed, 19, 20) === 0 && rimAlpha(trimmed, 20, 20) === 255;
	})(),
);

if (failures) process.exit(1);
console.log("all matte checks PASS");
