// Metadata burn-in for exported movies, after Blender's render Stamp: a
// review cut is only reviewable when every frame names itself. The stamp bar
// carries slate · frame counter and is composited straight into the RGBA
// bytes the offscreen exporter already produces, so the mp4 pipeline and its
// determinism guarantees stay untouched.
//
// Split on purpose:
//   buildStampText / compositeStamp — pure byte math, unit-testable in node.
//   renderStampBitmap / burnInCapture — need Canvas 2D, exercised in browser QA.

/** the slate line for one frame, zero-padded so columns never jitter */
export function buildStampText({ slate, frame, frameCount }) {
	const digits = Math.max(4, String(Math.max(0, (frameCount ?? 0) - 1)).length);
	const counter = `F ${String(frame).padStart(digits, "0")}`;
	const head = (slate ?? "").trim().toUpperCase();
	return head ? `${head} · ${counter}` : counter;
}

/**
 * Alpha-composite a top-down stamp bitmap into a bottom-up RGBA frame at the
 * bottom-left corner. `pixels` is the raw WebGL readback (row 0 = visual
 * bottom); the stamp is ordinary canvas output (row 0 = visual top). Margins
 * are in pixels of the target frame.
 */
export function compositeStamp(pixels, width, height, stamp, { marginX = 0, marginY = 0 } = {}) {
	const { data, width: stampW, height: stampH } = stamp;
	if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) {
		throw new TypeError("compositeStamp needs raw RGBA bytes");
	}
	if (pixels.byteLength !== width * height * 4) throw new RangeError("frame byte length does not match dimensions");
	if (data.byteLength !== stampW * stampH * 4) throw new RangeError("stamp byte length does not match dimensions");
	const copyW = Math.min(stampW, Math.max(0, width - marginX));
	const copyH = Math.min(stampH, Math.max(0, height - marginY));
	for (let row = 0; row < copyH; row += 1) {
		// stamp row (top-down) → visual y from frame bottom → frame buffer row
		const visualFromBottom = marginY + (copyH - 1 - row);
		const frameRowStart = (visualFromBottom * width + marginX) * 4;
		const stampRowStart = row * stampW * 4;
		for (let col = 0; col < copyW; col += 1) {
			const s = stampRowStart + col * 4;
			const alpha = data[s + 3] / 255;
			if (alpha <= 0) continue;
			const d = frameRowStart + col * 4;
			pixels[d] = Math.round(data[s] * alpha + pixels[d] * (1 - alpha));
			pixels[d + 1] = Math.round(data[s + 1] * alpha + pixels[d + 1] * (1 - alpha));
			pixels[d + 2] = Math.round(data[s + 2] * alpha + pixels[d + 2] * (1 - alpha));
			pixels[d + 3] = 255;
		}
	}
	return pixels;
}

/** Rasterize one stamp line into RGBA bytes (browser-only: Canvas 2D). */
export function renderStampBitmap(text, { fontPx = 18, padX = 10, padY = 6, maxWidth = Infinity } = {}) {
	const probe = new OffscreenCanvas(1, 1).getContext("2d");
	probe.font = `600 ${fontPx}px ui-monospace, Menlo, monospace`;
	const textW = Math.ceil(probe.measureText(text).width);
	const width = Math.max(1, Math.min(textW + padX * 2, Math.floor(maxWidth)));
	const height = fontPx + padY * 2;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.fillStyle = "rgba(14, 13, 16, 0.72)";
	ctx.fillRect(0, 0, width, height);
	ctx.font = probe.font;
	ctx.textBaseline = "middle";
	ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
	ctx.fillText(text, padX, height / 2 + 1, width - padX * 2);
	const image = ctx.getImageData(0, 0, width, height);
	return { data: image.data, width, height };
}

/**
 * Wrap an exporter `capture(frame)` so every returned frame carries the burn-in
 * bar. Bitmaps are cached per rendered text, so the per-frame cost is one
 * composite pass; only the frame counter changes between frames.
 */
export function burnInCapture(capture, { width, height, slate, frameCount }) {
	const cache = new Map();
	const margin = Math.max(8, Math.round(height * 0.02));
	return (frame) => {
		const pixels = capture(frame);
		if (!pixels) return pixels;
		const text = buildStampText({ slate, frame, frameCount });
		let bitmap = cache.get(text);
		if (!bitmap) {
			bitmap = renderStampBitmap(text, { fontPx: Math.max(12, Math.round(height / 40)), maxWidth: width - margin * 2 });
			cache.set(text, bitmap);
		}
		return compositeStamp(pixels, width, height, bitmap, { marginX: margin, marginY: margin });
	};
}
