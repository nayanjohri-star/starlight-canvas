#!/usr/bin/env node
// verify_result visual "contact_sheet": one image of 6 frames sampled across
// the range, each shot frame box-downscaled and tiled 3x2 row-major. The pure
// pieces live in src/studio-contact-sheet.js; the agent binding
// (src/studio-app-binding.js) only wires the export render and the PNG
// encoder, so its branch is pinned against the source.
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function check(name, run) {
	try { run(); } catch (error) { expect(name, false, error?.message ?? String(error)); }
}

const sheet = await import("../src/studio-contact-sheet.js").catch(error => ({ loadError: error }));
expect("src/studio-contact-sheet.js loads", !sheet.loadError, sheet.loadError?.message);

check("sampling", () => {
	const whole = sheet.sampleContactSheetFrames("whole_clip", 240);
	const gaps = whole.slice(1).map((frame, i) => frame - whole[i]);
	expect("whole clip of 240 frames samples 6 frames from 0 to 239", whole.length === 6 && whole[0] === 0 && whole[5] === 239, JSON.stringify(whole));
	expect("whole clip samples are evenly spaced", gaps.every(gap => Math.abs(gap - 239 / 5) < 1), JSON.stringify(gaps));
	expect("no range is the whole clip", JSON.stringify(sheet.sampleContactSheetFrames(undefined, 240)) === JSON.stringify(whole));
	const explicit = sheet.sampleContactSheetFrames({ startFrame: 24, endFrameExclusive: 72 }, 240);
	expect("an explicit range samples its first and last frame", explicit.length === 6 && explicit[0] === 24 && explicit[5] === 71, JSON.stringify(explicit));
	const short = sheet.sampleContactSheetFrames({ startFrame: 10, endFrameExclusive: 14 }, 240);
	expect("a 4-frame range uses each frame once", JSON.stringify(short) === "[10,11,12,13]", JSON.stringify(short));
});

check("box downscale", () => {
	// 4x2 RGBA: each 2x2 block averages to one output pixel.
	const source = new Uint8Array([
		0, 0, 0, 255, 100, 40, 8, 255, 10, 20, 30, 255, 30, 40, 50, 255,
		200, 80, 16, 255, 100, 40, 8, 255, 50, 60, 70, 255, 70, 80, 90, 255,
	]);
	const out = sheet.boxDownscaleRgba(source, 4, 2, 2, 1);
	expect("each output pixel is the mean of its source box", JSON.stringify([...out]) === JSON.stringify([100, 40, 8, 255, 40, 50, 60, 255]), JSON.stringify([...out]));
	const same = sheet.boxDownscaleRgba(source, 4, 2, 4, 2);
	expect("an unscaled pass keeps every pixel", JSON.stringify([...same]) === JSON.stringify([...source]));
});

check("3x2 tiling", () => {
	const tile = value => new Uint8Array([value, value, value, 255]);
	const pixels = ({ data, width, height }) => Array.from({ length: width * height }, (_, i) => data[i * 4]);
	const topDown = sheet.tileRgba([1, 2, 3, 4, 5, 6].map(tile), 1, 1, { columns: 3, rows: 2 });
	expect("tiles land row-major, 3 columns by 2 rows", topDown.width === 3 && topDown.height === 2 && JSON.stringify(pixels(topDown)) === "[1,2,3,4,5,6]", JSON.stringify(pixels(topDown)));
	// WebGL read-back rows run bottom-up: the first row of tiles is the last block.
	const bottomUp = sheet.tileRgba([1, 2, 3, 4, 5, 6].map(tile), 1, 1, { columns: 3, rows: 2, bottomUp: true });
	expect("bottom-up tiling puts the first row of tiles last in the buffer", JSON.stringify(pixels(bottomUp)) === "[4,5,6,1,2,3]", JSON.stringify(pixels(bottomUp)));
	const partial = sheet.tileRgba([1, 2, 3, 4].map(tile), 1, 1, { columns: 3, rows: 2 });
	expect("empty cells are opaque black", JSON.stringify([...partial.data.subarray(16)]) === "[0,0,0,255,0,0,0,255]", JSON.stringify([...partial.data]));
});

check("contact sheet", () => {
	// The renderer reuses one read-back buffer, as the WebGL capture does.
	const width = 2400, height = 100, buffer = new Uint8Array(width * height * 4), rendered = [];
	const render = frame => { rendered.push(frame); buffer.fill(frame); return { data: buffer, width, height }; };
	const frames = [0, 48, 96, 143, 191, 239];
	const result = sheet.buildContactSheet(frames, render);
	expect("every sampled frame renders once, in order", JSON.stringify(rendered) === JSON.stringify(frames), JSON.stringify(rendered));
	expect("the sheet's longest side is at most 1600 px", Math.max(result.width, result.height) <= 1600 && result.width >= 1590, `${result.width}x${result.height}`);
	const tileWidth = result.width / 3, tileHeight = result.height / 2;
	expect("the sheet is 3 tiles wide and 2 high at the frame's aspect", Number.isInteger(tileWidth) && Number.isInteger(tileHeight) && Math.abs(tileWidth / tileHeight - width / height) < 1, `${result.width}x${result.height}`);
	const at = (column, row) => result.data[(((1 - row) * tileHeight) * result.width + column * tileWidth) * 4];
	const placed = [at(0, 0), at(1, 0), at(2, 0), at(0, 1), at(1, 1), at(2, 1)];
	expect("each tile shows its own frame, row-major from the top", JSON.stringify(placed) === JSON.stringify(frames), JSON.stringify(placed));
});

check("binding verify_result branch", () => {
	const app = readFileSync(new URL("../src/studio-app-binding.js", import.meta.url), "utf8");
	const start = app.indexOf('if (request.name === "verify_result") {');
	const branch = app.slice(start, app.indexOf("return result;", start));
	expect("verify_result branch is found", start > 0 && branch.length > 0);
	expect("verify_result no longer reports contact_sheet as unsupported", !branch.includes('unsupportedChecks.push("contact_sheet")'));
	expect("verify_result builds the contact sheet through the module", branch.includes("buildContactSheet(") && branch.includes("sampleContactSheetFrames("));
});

if (failures) process.exit(1);
console.log("all studio contact sheet checks PASS");
