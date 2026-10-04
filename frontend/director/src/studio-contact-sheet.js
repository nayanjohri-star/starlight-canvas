// verify_result's contact sheet: which frames of the range it shows, how each
// shot render shrinks, and where it lands on the one image the agent sees.
// Pure over RGBA byte buffers; App.jsx supplies the render and the encoder.

export const CONTACT_SHEET_COLUMNS = 3;
export const CONTACT_SHEET_ROWS = 2;
export const CONTACT_SHEET_LAYOUT = "3x2 row-major";
export const CONTACT_SHEET_MAX_SIDE = 1600;

/** Up to 6 frames spread evenly over a half-open range, first and last
 * included; "whole_clip" (or no range) is timeline frames 0..frameCount-1. */
export function sampleContactSheetFrames(range, frameCount, count = CONTACT_SHEET_COLUMNS * CONTACT_SHEET_ROWS) {
	const { startFrame, endFrameExclusive } = range && range !== "whole_clip" ? range : { startFrame: 0, endFrameExclusive: frameCount };
	const length = endFrameExclusive - startFrame;
	if (length <= count) return Array.from({ length }, (_, i) => startFrame + i);
	return Array.from({ length: count }, (_, i) => startFrame + Math.round((i * (length - 1)) / (count - 1)));
}

/** Box filter: each output pixel is the mean of the source pixels it covers. */
export function boxDownscaleRgba(data, width, height, outWidth, outHeight) {
	const out = new Uint8Array(outWidth * outHeight * 4);
	for (let y = 0; y < outHeight; y += 1) {
		const y0 = Math.floor((y * height) / outHeight), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
		for (let x = 0; x < outWidth; x += 1) {
			const x0 = Math.floor((x * width) / outWidth), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = y0; sy < y1; sy += 1) {
				for (let sx = x0; sx < x1; sx += 1) {
					const i = (sy * width + sx) * 4;
					r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
				}
			}
			const n = (y1 - y0) * (x1 - x0), o = (y * outWidth + x) * 4;
			out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
		}
	}
	return out;
}

/** Equal tiles row-major into one buffer; empty cells stay opaque black. With
 * bottomUp the buffer's rows run bottom-up (WebGL read-back order), so the
 * first row of tiles is the last block of rows. */
export function tileRgba(tiles, tileWidth, tileHeight, { columns = CONTACT_SHEET_COLUMNS, rows = CONTACT_SHEET_ROWS, bottomUp = false } = {}) {
	const width = tileWidth * columns, height = tileHeight * rows, data = new Uint8Array(width * height * 4);
	for (let i = 3; i < data.length; i += 4) data[i] = 255;
	tiles.forEach((tile, index) => {
		const column = index % columns, row = Math.floor(index / columns);
		const top = (bottomUp ? rows - 1 - row : row) * tileHeight;
		for (let y = 0; y < tileHeight; y += 1) {
			data.set(tile.subarray(y * tileWidth * 4, (y + 1) * tileWidth * 4), ((top + y) * width + column * tileWidth) * 4);
		}
	});
	return { data, width, height };
}

/** Render each frame (render(frame) -> { data, width, height }, rows bottom-up),
 * shrink it so the whole sheet's longest side is at most maxSide, and tile
 * the frames 3x2 row-major into one bottom-up buffer. */
export function buildContactSheet(frames, render, { maxSide = CONTACT_SHEET_MAX_SIDE } = {}) {
	const tiles = [];
	let tileWidth, tileHeight;
	for (const frame of frames) {
		const shot = render(frame);
		if (tileWidth === undefined) {
			const scale = Math.min(1, maxSide / Math.max(shot.width * CONTACT_SHEET_COLUMNS, shot.height * CONTACT_SHEET_ROWS));
			tileWidth = Math.max(1, Math.floor(shot.width * scale));
			tileHeight = Math.max(1, Math.floor(shot.height * scale));
		}
		// The renderer reuses one read-back buffer: shrink this frame before the next render.
		tiles.push(boxDownscaleRgba(shot.data, shot.width, shot.height, tileWidth, tileHeight));
	}
	return tileRgba(tiles, tileWidth, tileHeight, { bottomUp: true });
}
