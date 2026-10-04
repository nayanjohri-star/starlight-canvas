const CONTAINER_BOXES = new Set(["moov", "trak", "mdia"]);

function boxType(view, offset) {
	return String.fromCharCode(
		view.getUint8(offset + 4),
		view.getUint8(offset + 5),
		view.getUint8(offset + 6),
		view.getUint8(offset + 7),
	);
}

function walkBoxes(view, start, end, visit) {
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		let headerSize = 8;
		if (size === 1) {
			if (offset + 16 > end) throw new Error("Invalid MP4 extended-size box");
			const extendedSize = view.getBigUint64(offset + 8);
			if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box is too large to inspect safely");
			size = Number(extendedSize);
			headerSize = 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < headerSize || offset + size > end) throw new Error("Invalid MP4 box size");

		const box = { type: boxType(view, offset), start: offset, end: offset + size, payload: offset + headerSize };
		visit(box);
		if (CONTAINER_BOXES.has(box.type)) walkBoxes(view, box.payload, box.end, visit);
		offset = box.end;
	}
	if (offset !== end) throw new Error("Invalid trailing MP4 box data");
}

function timingFields(view, box) {
	const version = view.getUint8(box.payload);
	const timescaleOffset = box.payload + (version === 1 ? 20 : 12);
	const durationOffset = timescaleOffset + 4;
	const durationBytes = version === 1 ? 8 : 4;
	if ((version !== 0 && version !== 1) || durationOffset + durationBytes > box.end) {
		throw new Error(`Invalid ${box.type} box`);
	}
	return {
		version,
		timescale: view.getUint32(timescaleOffset),
		duration: version === 1 ? view.getBigUint64(durationOffset) : BigInt(view.getUint32(durationOffset)),
		durationOffset,
	};
}

function writeDuration(view, fields, duration) {
	if (fields.version === 1) {
		view.setBigUint64(fields.durationOffset, duration);
		return;
	}
	if (duration > 0xffffffffn) throw new Error("Corrected mdhd duration does not fit a version 0 box");
	view.setUint32(fields.durationOffset, Number(duration));
}

/**
 * Repair MediaRecorder MP4 files whose mdhd duration was written in mvhd units.
 *
 * mvhd is the movie header and uses the movie timescale (commonly 1000), while
 * mdhd is a media-track header and must use that track's media timescale
 * (commonly 30000). They describe the same elapsed time with different clocks;
 * copying the mvhd duration number into mdhd makes a 30000 Hz track read 30x
 * too short.
 */
export function repairMp4MediaDurations(input) {
	const source = input instanceof ArrayBuffer
		? new Uint8Array(input)
		: ArrayBuffer.isView(input)
			? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
			: null;
	if (!source) throw new TypeError("repairMp4MediaDurations expects an ArrayBuffer or typed array");

	const output = Uint8Array.from(source);
	const view = new DataView(output.buffer);
	let movie = null;
	const mediaHeaders = [];
	walkBoxes(view, 0, output.byteLength, (box) => {
		if (box.type === "mvhd") movie = timingFields(view, box);
		if (box.type === "mdhd") mediaHeaders.push(timingFields(view, box));
	});
	if (!movie || movie.timescale === 0) throw new Error("MP4 is missing a valid mvhd box");
	if (mediaHeaders.length === 0) throw new Error("MP4 is missing an mdhd box");

	for (const media of mediaHeaders) {
		if (media.timescale === 0) throw new Error("MP4 contains an mdhd box with timescale 0");
		const numerator = movie.duration * BigInt(media.timescale);
		const correctedDuration = (numerator + BigInt(movie.timescale) / 2n) / BigInt(movie.timescale);
		writeDuration(view, media, correctedDuration);
	}
	return output;
}

/** Preserve the recorded Blob's MIME type while repairing its MP4 headers. */
export async function repairRecordedMp4(blob) {
	if (!(blob instanceof Blob)) throw new TypeError("repairRecordedMp4 expects a Blob");
	return new Blob([repairMp4MediaDurations(await blob.arrayBuffer())], { type: blob.type });
}
