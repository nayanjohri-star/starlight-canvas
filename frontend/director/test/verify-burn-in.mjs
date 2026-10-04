#!/usr/bin/env node
// Burn-in stamp: text assembly and RGBA compositing (pure paths only; the
// Canvas 2D rasterizer is exercised by the browser QA).
import assert from "node:assert/strict";
import { buildStampText, compositeStamp } from "../src/burn-in.js";

// --- text -----------------------------------------------------------------
assert.equal(buildStampText({ slate: "Medium Shot 35mm", frame: 7, frameCount: 360 }), "MEDIUM SHOT 35MM · F 0007");
assert.equal(buildStampText({ slate: "", frame: 0, frameCount: 100 }), "F 0000", "empty slate leaves a bare counter");
assert.equal(buildStampText({ slate: null, frame: 12, frameCount: 24000 }), "F 00012", "padding follows the last frame's width");
assert.equal(buildStampText({ slate: "  x  ", frame: 3, frameCount: 10 }), "X · F 0003", "slates are trimmed and uppercased");

// --- compositing: placement + alpha ---------------------------------------
// Frame: 4x4 bottom-up RGBA, all opaque black. Stamp: 2x1 top-down — one
// opaque red pixel, one 50%-alpha green pixel.
const width = 4;
const height = 4;
const frame = new Uint8Array(width * height * 4);
for (let index = 3; index < frame.length; index += 4) frame[index] = 255;
const stamp = {
	width: 2,
	height: 1,
	data: new Uint8ClampedArray([255, 0, 0, 255, 0, 200, 0, 128]),
};
compositeStamp(frame, width, height, stamp, { marginX: 1, marginY: 1 });
const px = (row, col) => [...frame.subarray((row * width + col) * 4, (row * width + col) * 4 + 4)];
// marginY=1 in a bottom-up buffer = buffer row 1 (one visual row above the bottom edge)
assert.deepEqual(px(1, 1), [255, 0, 0, 255], "opaque stamp pixel lands at margin offset");
assert.deepEqual(px(1, 2), [0, 100, 0, 255], "half-alpha pixel blends over the frame");
assert.deepEqual(px(1, 3), [0, 0, 0, 255], "pixels right of the stamp stay untouched");
assert.deepEqual(px(0, 1), [0, 0, 0, 255], "the row below the margin stays untouched");
assert.deepEqual(px(2, 1), [0, 0, 0, 255], "the row above the stamp stays untouched");

// --- compositing: vertical flip -------------------------------------------
// Stamp 1x2 top-down: row 0 white, row 1 blue. In the bottom-up frame the
// white row must sit ABOVE the blue row (higher buffer row index).
const flipFrame = new Uint8Array(width * height * 4);
for (let index = 3; index < flipFrame.length; index += 4) flipFrame[index] = 255;
const tallStamp = {
	width: 1,
	height: 2,
	data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 255, 255]),
};
compositeStamp(flipFrame, width, height, tallStamp, { marginX: 0, marginY: 0 });
const fpx = (row) => [...flipFrame.subarray(row * width * 4, row * width * 4 + 4)];
assert.deepEqual(fpx(0), [0, 0, 255, 255], "stamp bottom row sits at the frame bottom");
assert.deepEqual(fpx(1), [255, 255, 255, 255], "stamp top row sits one row above");

// --- compositing: clipping + contract errors ------------------------------
const tiny = new Uint8Array(2 * 2 * 4);
compositeStamp(tiny, 2, 2, { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) });
assert.ok([...tiny].every((byte) => byte === 255), "an oversized stamp clips to the frame instead of overflowing");

assert.throws(() => compositeStamp([], 4, 4, stamp), TypeError, "plain arrays are rejected");
assert.throws(() => compositeStamp(new Uint8Array(7), 4, 4, stamp), RangeError, "frame byte length must match dimensions");
assert.throws(
	() => compositeStamp(new Uint8Array(width * height * 4), width, height, { width: 3, height: 1, data: new Uint8ClampedArray(4) }),
	RangeError,
	"stamp byte length must match its dimensions",
);

// the composite returns the same buffer it mutated (exporter reuses it)
const same = new Uint8Array(width * height * 4);
assert.equal(compositeStamp(same, width, height, stamp), same);

console.log("verify-burn-in: all checks passed");
