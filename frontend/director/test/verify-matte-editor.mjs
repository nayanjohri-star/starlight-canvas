#!/usr/bin/env node
/**
 * The background editor, driven without a browser.
 *
 * The widget is a canvas, a pointer and two typed arrays, so all three can be
 * faked: the canvas records what was drawn, the pointer handlers are called
 * directly, and the assertions are about pixels — does it open on the
 * untouched photograph, does the brush lay purple down, does the eraser take
 * it off, and is the mask it finally hands over exactly what was on screen.
 */

import { MATTE_HISTORY, MATTE_PURPLE, MAX_ZOOM, createMatteEditor } from "../src/matte-editor.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) {
		this.data = data;
		this.width = width;
		this.height = height ?? data.length / 4 / width;
	}
};
globalThis.Blob ??= class Blob {
	constructor(parts) {
		this.parts = parts;
	}
};

/* -- a picture: a red block on a grey wall, 40 x 60 ---------------------- */

const WIDTH = 40;
const HEIGHT = 60;
const BOX = { x0: 12, y0: 20, x1: 28, y1: 46 };
const source = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
	for (let x = 0; x < WIDTH; x++) {
		const index = (y * WIDTH + x) * 4;
		const subject = x >= BOX.x0 && x < BOX.x1 && y >= BOX.y0 && y < BOX.y1;
		source[index] = subject ? 205 : 188;
		source[index + 1] = subject ? 55 : 190;
		source[index + 2] = subject ? 45 : 186;
		source[index + 3] = 255;
	}
}

/* -- the fakes ------------------------------------------------------------ */

const handlers = new Map();
let painted = null;
/** The element box the canvas is displayed in — changed below to letterbox. */
const box = { left: 0, top: 0, width: WIDTH, height: HEIGHT };
const canvas = {
	width: 0,
	height: 0,
	addEventListener: (type, handler) => handlers.set(type, handler),
	removeEventListener: (type) => handlers.delete(type),
	getBoundingClientRect: () => ({ ...box }),
	setPointerCapture() {},
	releasePointerCapture() {},
	hasPointerCapture: () => false,
	getContext: () => ({
		imageSmoothingEnabled: true,
		fillStyle: "#000000",
		// The stage: a ground the picture is placed on. Emulated so a pixel
		// assertion means the same thing at any zoom, and so a click on the
		// ground can be told from a click on the photograph.
		fillRect: (x, y, w, h) => {
			painted = { data: new Uint8ClampedArray(w * h * 4).fill(0), width: w, height: h };
			for (let i = 0; i < w * h; i++) {
				painted.data[i * 4] = 20;
				painted.data[i * 4 + 1] = 24;
				painted.data[i * 4 + 2] = 25;
				painted.data[i * 4 + 3] = 255;
			}
		},
		// Nearest-neighbour blit of the whole buffer into a destination rect,
		// clipped to the stage — which is what the browser does for us here.
		drawImage: (source, sx, sy, sw, sh, dx, dy, dw, dh) => {
			const from = source.__image;
			if (!from || !painted) return;
			for (let y = 0; y < painted.height; y++) {
				if (y < dy || y >= dy + dh) continue;
				const srcY = Math.min(from.height - 1, Math.floor(sy + ((y - dy) / dh) * sh));
				for (let x = 0; x < painted.width; x++) {
					if (x < dx || x >= dx + dw) continue;
					const srcX = Math.min(from.width - 1, Math.floor(sx + ((x - dx) / dw) * sw));
					const s = (srcY * from.width + srcX) * 4;
					const d = (y * painted.width + x) * 4;
					painted.data[d] = from.data[s];
					painted.data[d + 1] = from.data[s + 1];
					painted.data[d + 2] = from.data[s + 2];
					painted.data[d + 3] = from.data[s + 3];
				}
			}
		},
	}),
};
const makeCanvas = (width, height) => {
	const canvasLike = {
		width,
		height,
		__image: null,
		getContext: () => ({
			drawImage: () => {},
			getImageData: () => ({ data: Uint8ClampedArray.from(source), width, height }),
			// The offscreen buffer the editor composites into, then crops from.
			putImageData: (image) => { canvasLike.__image = image; },
		}),
	};
	return canvasLike;
};
const asset = { id: "img-" + "c".repeat(32), type: "image/png", width: WIDTH, height: HEIGHT, bytes: new ArrayBuffer(4) };

let last = null;
const editor = createMatteEditor(canvas, {
	onChange: (stats) => { last = stats; },
	createBitmap: async () => ({ width: WIDTH, height: HEIGHT, close() {} }),
	makeCanvas,
});
await editor.load(asset);

const pixelAt = (x, y) => {
	const index = (y * painted.width + x) * 4;
	return [painted.data[index], painted.data[index + 1], painted.data[index + 2]];
};
const sourceAt = (x, y) => {
	const index = (y * WIDTH + x) * 4;
	return [source[index], source[index + 1], source[index + 2]];
};
const near = (a, b, slack = 3) => a.every((value, channel) => Math.abs(value - b[channel]) <= slack);
/** Purple over red is magenta, purple over grey is violet — so "is it
 * overlaid" is asked against the exact mix, not against a hue guess. */
const isPurple = (x, y) => near(pixelAt(x, y), sourceAt(x, y).map((value, channel) => value * 0.38 + MATTE_PURPLE[channel] * 0.62));
const isPlain = (x, y) => near(pixelAt(x, y), sourceAt(x, y));

/* -- it opens on the picture, untouched ---------------------------------- */

expect("the editor paints something the size of the picture", painted?.width === WIDTH && painted?.height === HEIGHT);
expect(
	"nothing is marked until someone asks — the photograph is the default",
	isPlain(1, 1) && isPlain(20, 30) && isPlain(38, 58) && last.painted === 0,
	JSON.stringify(last),
);
expect("with nothing painted there is nothing to apply", editor.options() === null && editor.hasPaint() === false);

/* -- a stroke is a seed, and the algorithm does the cutting ---------------- */

const pointer = (type, x, y) => handlers.get(type)?.({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
editor.setBrush(4);
pointer("pointerdown", 4, 4);
pointer("pointermove", 4, 8);
expect("the brush marks where it touched while the pointer is down", isPurple(4, 4) && isPlain(30, 30));
const duringStroke = last.painted;
pointer("pointerup", 4, 8);

expect(
	"letting go grows the cut out from the seeds — one dab takes the whole wall",
	last.painted > duringStroke * 5 && isPurple(36, 2) && isPurple(2, 56),
	JSON.stringify({ duringStroke, after: last.painted }),
);
expect("the growth stops at the subject", isPlain(20, 30) && isPlain(14, 22));
expect("what is marked is counted", last.coverage > 0.5 && last.coverage < 0.95, JSON.stringify(last));

/* -- the eraser is the same tool, pointed the other way -------------------- */

// One dab on the wall gives the WHOLE wall back: the growth runs fenced to
// what is already selected, so it stops exactly where the selection did.
editor.setMode("erase");
editor.setBrush(4);
const beforeErase = last.painted;
pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
expect(
	"erasing gives the whole cut region back, not a disc of it",
	last.painted === 0 && isPlain(4, 4) && isPlain(36, 2) && isPlain(2, 56),
	JSON.stringify({ beforeErase, after: last.painted }),
);

// And it cannot spill: with only part of the wall selected, erasing takes back
// that part and leaves the picture alone.
editor.setMode("paint");
pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
const wall = last.painted;
editor.setMode("erase");
pointer("pointerdown", 20, 30);
pointer("pointerup", 20, 30);
expect(
	"erasing where nothing is selected changes nothing",
	last.painted === wall && isPlain(20, 30),
	JSON.stringify({ wall, after: last.painted }),
);
editor.setMode("paint");

/* -- auto-detect is an offer, not the default ----------------------------- */

editor.clear();
expect("clear puts the photograph back", last.painted === 0 && isPlain(1, 1) && isPlain(20, 30));
const added = editor.autoDetect(0.18);
expect("auto-detect marks the background and leaves the subject", added > 0 && isPurple(1, 1) && isPurple(38, 58) && isPlain(20, 30));

// A stroke on the subject seeds a growth INSIDE it: the subject is one flat
// colour, so this is "cut this out too", and it must survive a second pass.
pointer("pointerdown", 20, 30);
pointer("pointerup", 20, 30);
expect("a stroke on the subject cuts the subject out too", isPurple(20, 30) && isPurple(14, 22));
const afterCorrection = last.painted;
editor.autoDetect(0.3);
expect("running auto-detect again keeps what is already marked", isPurple(20, 30) && last.painted >= afterCorrection);

/* -- what gets handed to the cutter --------------------------------------- */

const options = editor.options();
let purple = 0;
for (const value of options.mask) purple += value;
expect(
	"the mask is the picture's own size, and is exactly what is purple",
	options.mask.length === WIDTH * HEIGHT && options.maskWidth === WIDTH && options.maskHeight === HEIGHT && purple === last.painted,
	JSON.stringify({ length: options.mask.length, purple, painted: last.painted }),
);
expect("no tolerance travels with it — the growth already happened on screen", options.tolerance === undefined);
// Copied HERE, while the selection is still on screen: options.mask is the
// live paint layer, not a snapshot, and everything below edits it.
const saved = Uint8Array.from(options.mask);

/* -- a picture that does not fill its stage -------------------------------- */

// The canvas fills its box and the picture is placed ON it: a 40 x 60 picture
// in a 200 x 60 box sits in the middle, on ground, rather than being cropped
// by bars that live outside the canvas. Stage coordinates from here on, since
// that is what the canvas now holds.
Object.assign(box, { left: 12, top: 4, width: 200, height: 60 });
// The canvas only learns its box when it next paints.
editor.clear();
editor.setBrush(4);
const PICTURE_LEFT = (200 - 40) / 2;
expect(
	"the ground is painted around the picture, not around the canvas",
	// Just outside the picture on the left, and just inside it.
	near(pixelAt(PICTURE_LEFT - 6, 30), [20, 24, 25]) && near(pixelAt(PICTURE_LEFT + 2, 30), sourceAt(2, 30)),
	JSON.stringify({ ground: pixelAt(PICTURE_LEFT - 6, 30), picture: pixelAt(PICTURE_LEFT + 2, 30) }),
);

pointer("pointerdown", 12 + PICTURE_LEFT + 2, 4 + 2);
pointer("pointerup", 12 + PICTURE_LEFT + 2, 4 + 2);
expect(
	"a click lands on the picture where the cursor is, not where the canvas starts",
	near(pixelAt(PICTURE_LEFT + 2, 2), sourceAt(2, 2).map((v, c) => v * 0.38 + MATTE_PURPLE[c] * 0.62)) && last.painted > 0,
	JSON.stringify(last),
);

editor.clear();
pointer("pointerdown", 12 + 10, 4 + 30);
pointer("pointerup", 12 + 10, 4 + 30);
expect("a click on the ground beside the picture is ignored", last.painted === 0);

// Displayed at 4x, the picture fills the stage: a click a quarter of the way
// in is a quarter of the way into the photograph, and the brush keeps its size
// on screen, so it covers fewer picture pixels.
Object.assign(box, { left: 0, top: 0, width: WIDTH * 4, height: HEIGHT * 4 });
editor.clear();
pointer("pointerdown", 4 * 4, 4 * 4);
pointer("pointerup", 4 * 4, 4 * 4);
expect(
	"a scaled-up display still maps to the right pixel",
	near(pixelAt(16, 16), sourceAt(4, 4).map((v, c) => v * 0.38 + MATTE_PURPLE[c] * 0.62)) && near(pixelAt(80, 120), sourceAt(20, 30)),
	JSON.stringify({ at: pixelAt(16, 16), subject: pixelAt(80, 120) }),
);
Object.assign(box, { left: 0, top: 0, width: WIDTH, height: HEIGHT });
editor.clear();
editor.fit();

/* -- a retina panel ------------------------------------------------------- */

// The stage is backed in DEVICE pixels, so on a 2x display the canvas holds
// twice as many pixels as it occupies. Every mapping has to divide that back
// out, or a click lands twice as far from the corner as the cursor was.
globalThis.devicePixelRatio = 2;
editor.clear();
editor.setBrush(4);
pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
expect(
	"a click on a retina panel lands where the cursor is, not at twice the offset",
	// The canvas box is 40 x 60 CSS px; at 2x the stage is 80 x 120 device px
	// and the picture fills it, so CSS (4, 4) is picture (4, 4) — device (8, 8).
	near(pixelAt(8, 8), sourceAt(4, 4).map((v, c) => v * 0.38 + MATTE_PURPLE[c] * 0.62)) && last.painted > 0,
	JSON.stringify({ at: pixelAt(8, 8), painted: last.painted }),
);
expect(
	"and the picture still fills the stage, rather than a quarter of it",
	// The far corner is picture — wall, and by now purple — never the ground.
	!near(pixelAt(78, 118), [20, 24, 25]),
	JSON.stringify(pixelAt(78, 118)),
);
globalThis.devicePixelRatio = 1;
editor.clear();
editor.fit();

/* -- undo and redo -------------------------------------------------------- */

await editor.load(asset);
expect("a freshly loaded picture has nothing to undo", editor.canUndo() === false && editor.canRedo() === false);

pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
const cutWall = last.painted;
expect("a cut is one undoable decision", cutWall > 0 && editor.canUndo() === true && last.canUndo === true);

expect("undo takes the whole cut back, not one dab of it", editor.undo() === true && last.painted === 0 && isPlain(4, 4));
expect("redo puts it back", editor.redo() === true && last.painted === cutWall && isPurple(4, 4));
expect("redo runs out at the present", editor.redo() === false && last.canRedo === false);

// A new edit replaces the future that was undone.
editor.undo();
editor.autoDetect(0.18);
expect("editing after an undo drops the redo", editor.canRedo() === false && last.painted > 0);

// The buffer is bounded: seven steps back, and the eighth is gone. Each pass
// has to actually change something, so it alternates cutting with clearing —
// a second cut on an already-purple wall changes nothing and is not a step.
editor.clear();
for (let step = 0; step < MATTE_HISTORY + 3; step++) {
	if (step % 2 === 0) {
		pointer("pointerdown", 4, 4);
		pointer("pointerup", 4, 4);
	} else {
		editor.clear();
	}
}
let walked = 0;
while (editor.undo()) walked += 1;
expect(`the buffer keeps ${MATTE_HISTORY} steps and no more`, walked === MATTE_HISTORY, String(walked));
expect("the oldest state left is still a real one", last.painted >= 0 && editor.canUndo() === false);

/* -- zoom and pan --------------------------------------------------------- */

await editor.load(asset);
expect("a picture opens at fit", editor.zoom() === 1 && last.zoom === 1);

// The canvas is 40 x 60 on screen. At 2x, the visible slice is 20 x 30 of the
// picture, centred, so the subject's top-left corner (12, 20) lands at the
// canvas's own (4, 20) — magnified, and still the same pixel of the photo.
editor.zoomBy(2);
expect("zooming reports itself", editor.zoom() === 2 && last.zoom === 2);
editor.setBrush(2);
pointer("pointerdown", 4, 4);
pointer("pointerup", 4, 4);
expect(
	"a click at 2x lands on the pixel it is over, not on the one it would be at fit",
	// (4, 4) on a 2x view centred at (10, 15) is picture (12, 17) — wall, just
	// above the subject — and the growth takes the wall.
	isPurple(4, 4) && isPlain(20, 30),
	JSON.stringify({ zoom: editor.zoom(), painted: last.painted }),
);

editor.clear();
// Panning moves the picture under the canvas: after dragging right, what was
// to the LEFT comes into view.
const beforePan = pixelAt(2, 30);
handlers.get("keydown")({ key: " " });
pointer("pointerdown", 30, 30);
handlers.get("pointermove")({ clientX: 10, clientY: 30, pointerId: 1, preventDefault() {} });
pointer("pointerup", 10, 30);
handlers.get("keyup")({ key: " " });
expect("space-drag pans instead of painting", last.painted === 0, JSON.stringify(last));
expect("the view actually moved", JSON.stringify(pixelAt(2, 30)) !== JSON.stringify(beforePan) || editor.zoom() === 1);

editor.fit();
expect("fit puts the whole picture back", editor.zoom() === 1 && isPlain(1, 1) && isPlain(20, 30));

// The zoom is bounded at both ends: there is nothing to see below fit, and 16x
// is a preview pixel under a fingertip.
for (let i = 0; i < 20; i++) editor.zoomBy(2);
expect("zoom stops at the far end", editor.zoom() === MAX_ZOOM, String(editor.zoom()));
for (let i = 0; i < 40; i++) editor.zoomBy(0.5);
expect("and never goes below the whole picture", editor.zoom() === 1, String(editor.zoom()));
editor.fit();

/* -- a saved selection can be put back ------------------------------------ */

editor.clear();
expect("clear puts the photograph back", last.painted === 0 && isPlain(1, 1) && isPlain(20, 30) && editor.options() === null);
expect("a saved selection is restored onto the picture", editor.setMask(saved, WIDTH, HEIGHT) && isPurple(1, 1) && last.painted === saved.reduce((sum, value) => sum + value, 0));
expect("a selection from a different picture is refused", editor.setMask(new Uint8Array(9), 3, 3) === false);

editor.dispose();
expect("disposing lets go of the pointer", handlers.size === 0);

if (failures) process.exit(1);
console.log("all matte editor checks PASS");
