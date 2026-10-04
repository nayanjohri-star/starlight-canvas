#!/usr/bin/env node
import assert from "node:assert/strict";
import { repairMp4MediaDurations, repairRecordedMp4 } from "../src/ardy/mp4-duration.js";

const ascii = (value) => Uint8Array.from(value, (char) => char.charCodeAt(0));

function concat(...parts) {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function box(type, ...payloadParts) {
	const payload = concat(...payloadParts);
	const result = new Uint8Array(8 + payload.byteLength);
	new DataView(result.buffer).setUint32(0, result.byteLength);
	result.set(ascii(type), 4);
	result.set(payload, 8);
	return result;
}

function durationHeader(type, timescale, duration) {
	const payload = new Uint8Array(20);
	const view = new DataView(payload.buffer);
	view.setUint32(12, timescale);
	view.setUint32(16, duration);
	return box(type, payload);
}

function readDuration(bytes, type) {
	const marker = ascii(type);
	const index = bytes.findIndex((_, candidate) => marker.every((value, offset) => bytes[candidate + offset] === value));
	assert.ok(index >= 4, `${type} box exists`);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { timescale: view.getUint32(index + 16), duration: view.getUint32(index + 20) };
}

// Synthetic output from a buggy muxer: 120 frames at 24 fps is five seconds.
// mvhd correctly records 5000 ticks at 1000 Hz, but mdhd incorrectly copies
// 5000 instead of recording 150000 ticks at its 30000 Hz media clock.
const frameCount = 120;
const frameRate = 24;
const movieTimescale = 1000;
const mediaTimescale = 30000;
const movieDuration = (frameCount * movieTimescale) / frameRate;
const expectedMediaDuration = (frameCount * mediaTimescale) / frameRate;
const malformed = box(
	"moov",
	durationHeader("mvhd", movieTimescale, movieDuration),
	box("trak", box("mdia", durationHeader("mdhd", mediaTimescale, movieDuration))),
);

const repaired = repairMp4MediaDurations(malformed);
assert.equal(readDuration(malformed, "mdhd").duration, 5000, "fixture reproduces the movie-timescale bug");
assert.deepEqual(
	readDuration(repaired, "mdhd"),
	{ timescale: mediaTimescale, duration: expectedMediaDuration },
	"mdhd duration uses the media timescale for the known frame count",
);
assert.deepEqual(readDuration(repaired, "mvhd"), { timescale: movieTimescale, duration: movieDuration }, "mvhd stays unchanged");

// The exact issue report example: 8.282 movie seconds becomes 248460 media ticks.
const issueFixture = box(
	"moov",
	durationHeader("mvhd", 1000, 8282),
	box("trak", box("mdia", durationHeader("mdhd", 30000, 8282))),
);
assert.equal(readDuration(repairMp4MediaDurations(issueFixture), "mdhd").duration, 248460);

const repairedBlob = await repairRecordedMp4(new Blob([malformed], { type: "video/mp4" }));
assert.equal(repairedBlob.type, "video/mp4", "Blob repair preserves the MIME type");
assert.equal(readDuration(new Uint8Array(await repairedBlob.arrayBuffer()), "mdhd").duration, expectedMediaDuration);

console.log("MP4 media duration verified");
