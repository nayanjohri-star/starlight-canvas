/** The video and PNG paths consume the same bottom-up RGBA render target. */
export function validatePixelDimensions(width, height) {
	if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(width * height * 4)) throw new RangeError('Invalid export dimensions');
	return width * height * 4;
}

export function topDownRgba(pixels, { width, height }, destination = null) {
	const length = validatePixelDimensions(width, height);
	if (!(pixels instanceof Uint8Array) || pixels.byteLength !== length) throw new RangeError(`Export capture returned ${pixels?.byteLength ?? 0} RGBA bytes; expected ${length}`);
	const output = destination ?? new Uint8ClampedArray(length);
	if (!(output instanceof Uint8Array || output instanceof Uint8ClampedArray) || output.byteLength !== length) throw new RangeError('Invalid RGBA destination');
	if (output.buffer === pixels.buffer) throw new TypeError('RGBA row conversion requires an independent destination');
	const stride = width * 4;
	for (let row = 0; row < height; row++) output.set(pixels.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
	return output;
}

/** Encode a complete PNG or throw; never return a partial or empty picture. */
export function rgbaToPngDataUrl(pixels, size, createCanvas = () => document.createElement('canvas')) {
	const rgba = topDownRgba(pixels, size), canvas = createCanvas();
	try {
		canvas.width = size.width; canvas.height = size.height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('PNG canvas is unavailable');
		const image = context.createImageData(size.width, size.height);
		image.data.set(rgba); context.putImageData(image, 0, 0);
		const result = canvas.toDataURL('image/png');
		if (!result.startsWith('data:image/png;base64,')) throw new Error('PNG encoding failed');
		return result;
	} finally { canvas.width = 0; canvas.height = 0; }
}
