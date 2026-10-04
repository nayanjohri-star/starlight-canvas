import assert from 'node:assert/strict';
import { Input, BlobSource, MP4, EncodedPacketSink } from 'mediabunny';
import { unzipSync } from 'fflate';
import { exportOffscreenVideo, referenceVideoPlan, normalizeFrameRange, exportFrameTiming } from '../src/offscreen-export.js';
import { keyframePackEntries, buildKeyframePack } from '../src/keyframe-pack.js';
import { topDownRgba, rgbaToPngDataUrl } from '../src/export-pixels.js';

// Fake codec packets exercise the real container writer/reader. This test
// proves scheduling and cleanup, not that its synthetic packets decode H.264.
const encoders = [], frames = [];
class Frame {
	constructor(data, init) { this.data = data.slice(); Object.assign(this, init); this.closed = 0; frames.push(this); }
	close() { this.closed++; }
}
class Encoder {
	static async isConfigSupported(config) { return { supported: true, config }; }
	constructor({ output, error }) { Object.assign(this, { output, error, state: 'unconfigured', encodeQueueSize: 0, closed: 0 }); encoders.push(this); }
	configure(config) { this.config = config; this.state = 'configured'; }
	encode(frame, options) {
		this.encodeQueueSize++;
		this.output({ timestamp: frame.timestamp, duration: frame.duration, type: options.keyFrame ? 'key' : 'delta', byteLength: 2, copyTo: bytes => bytes.set([frame.data[0], frame.data[4]]) }, { decoderConfig: { codec: this.config.codec, codedWidth: 2, codedHeight: 2, description: new Uint8Array([1, 100, 0, 50, 255, 225, 0, 4, 103, 100, 0, 50, 1, 0, 4, 104, 238, 60, 128]) } });
	}
	async flush() { this.encodeQueueSize = 0; }
	close() { this.closed++; this.state = 'closed'; }
}
const pixels = frame => Uint8Array.from({ length: 16 }, (_, at) => (frame * 13 + at) % 256);
const options = { startFrame: 0, endFrame: 23, fps: 24, width: 2, height: 2, capture: pixels, VideoEncoderClass: Encoder, VideoFrameClass: Frame };
async function exportAndRead(frameCount, fps, EncoderClass = Encoder) {
	const addressed = [], offset = frames.length;
	const result = await exportOffscreenVideo({ ...options, startFrame: 17, endFrame: 17 + frameCount - 1, fps, capture(frame) { addressed.push(frame); return pixels(frame); }, VideoEncoderClass: EncoderClass });
	assert.equal(addressed.length, frameCount); assert.equal(addressed[0], 17); assert.equal(addressed.at(-1), 16 + frameCount);
	const submitted = frames.slice(offset);
	for (let index = 0; index < frameCount; index++) { assert.deepEqual({ timestamp: submitted[index].timestamp, duration: submitted[index].duration }, exportFrameTiming(index, fps)); assert.equal(submitted[index].closed, 1); }
	assert.equal(submitted.at(-1).timestamp + submitted.at(-1).duration, Math.round(frameCount * 1e6 / fps));
	const input = new Input({ source: new BlobSource(result.blob), formats: [MP4] });
	try {
		const track = await input.getPrimaryVideoTrack(), sink = new EncodedPacketSink(track), packets = [];
		for await (const packet of sink.packets()) packets.push(packet);
		assert.equal(packets.length, frameCount); assert.ok(Math.abs(await input.computeDuration() - frameCount / fps) < 1e-4);
	} finally { input.dispose(); }
	assert.equal(encoders.at(-1).closed, 1); return result;
}
for (const fps of [24, 30]) for (const seconds of [1, 6.25, 15, 30]) {
	const count = Math.round(seconds * fps), result = await exportAndRead(count, fps);
	assert.equal(result.encodedFrameCount, count); assert.equal(result.durationUs, Math.round(count * 1e6 / fps));
	console.log(`PASS ${fps}fps / requested ${seconds}s: ${count} frames, actual ${count / fps}s, real MP4 container timing`);
}
class SlowEncoder extends Encoder { async flush() { await new Promise(resolve => setTimeout(resolve, 2)); super.flush(); } }
const beforeRaf = globalThis.requestAnimationFrame; let rafCalls = 0;
globalThis.requestAnimationFrame = () => { rafCalls++; };
try { const normal = await exportAndRead(150, 24), slow = await exportAndRead(150, 24, SlowEncoder); assert.deepEqual(normal.hashes, slow.hashes); assert.equal(rafCalls, 0); } finally { globalThis.requestAnimationFrame = beforeRaf; }
assert.equal(referenceVideoPlan(0, 149, 24).durationSeconds, 6.25);
assert.equal(referenceVideoPlan(0, 187, 30).durationSeconds, 188 / 30);
for (const range of [[.2, 10], [0, 1.7], [-1, 5], [5, 4], [0, Infinity]]) assert.throws(() => normalizeFrameRange(...range), RangeError);
for (const fps of [0, 20, 25, 29.97, 60]) assert.throws(() => referenceVideoPlan(0, 1, fps), /fps/);
for (const fps of [24, 30]) {
	const before = encoders.length;
	await assert.rejects(exportOffscreenVideo({ ...options, fps, endFrame: 30 * fps }), { exportFailureCode: 'range_too_long' });
	assert.equal(encoders.length, before, 'overlong range is rejected before codec allocation');
}
const bottom = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]);
assert.deepEqual([...topDownRgba(bottom, { width: 2, height: 2 })], [...bottom.slice(8), ...bottom.slice(0, 8)]);
assert.throws(() => topDownRgba(bottom, { width: 3, height: 2 }), /expected/);
const canvases = [], painted = [];
function canvas(fail = false) { const value = { width: 1, height: 1, getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(16) }), putImageData: image => painted.push([...image.data]) }), toDataURL() { if (fail) throw new Error('PNG allocation'); return 'data:image/png;base64,test'; } }; canvases.push(value); return value; }
assert.match(rgbaToPngDataUrl(bottom, { width: 2, height: 2 }, canvas), /^data:image\/png/);
assert.deepEqual(painted[0], [...topDownRgba(bottom, { width: 2, height: 2 })]);
assert.throws(() => rgbaToPngDataUrl(bottom, { width: 2, height: 2 }, () => canvas(true)), /PNG allocation/);
assert.ok(canvases.every(value => !value.width && !value.height), 'success and failure release their PNG backing stores');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pack = { shot: { index: 1, title: 'Frame contract', startFrame: 7, endFrame: 156 }, fps: 24, firstFramePng: png, lastFramePng: png, clip: { data: new Uint8Array([1]), ext: 'mp4', fps: 24, frameCount: 150 }, camera: {}, prompt: '' };
const entries = keyframePackEntries(pack), meta = JSON.parse(entries.find(entry => entry.name.endsWith('camera.json')).data);
assert.equal(meta.frameCount, 150); assert.equal(meta.durationSeconds, 6.25); assert.deepEqual(buildKeyframePack(pack), buildKeyframePack(pack));
const unpacked = unzipSync(buildKeyframePack(pack)); assert.deepEqual(Object.keys(unpacked), entries.map(entry => entry.name)); assert.deepEqual(unpacked[entries[0].name], png);
assert.throws(() => keyframePackEntries({ ...pack, clip: { ...pack.clip, fps: 30 } }), /disagrees/);
assert.throws(() => keyframePackEntries({ ...pack, firstFramePng: new Uint8Array(8) }), /PNG/);
assert.doesNotMatch(entries.at(-1).data, /blocking-depth\.mp4/, 'pack does not advertise files it does not contain');

for (const failure of ['capture', 'encode', 'flush']) {
	class FailureEncoder extends Encoder { encode(...args) { if (failure === 'encode') throw new Error('encode failure'); super.encode(...args); } async flush() { if (failure === 'flush') throw new Error('flush failure'); return super.flush(); } }
	const start = frames.length;
	await assert.rejects(exportOffscreenVideo({ ...options, capture: failure === 'capture' ? () => { throw new Error('capture failure'); } : pixels, VideoEncoderClass: FailureEncoder }), /failure/);
	assert.equal(encoders.at(-1).closed, 1); assert.ok(frames.slice(start).every(frame => frame.closed === 1));
}
class RepeatedTimestampEncoder extends Encoder { encode(frame, options) { super.encode({ ...frame, timestamp: 0 }, options); } }
await assert.rejects(exportOffscreenVideo({ ...options, VideoEncoderClass: RepeatedTimestampEncoder }), /WebCodecs emitted/); assert.equal(encoders.at(-1).closed, 1);
class BadTimestampEncoder extends Encoder { encode(frame, options) { super.encode({ ...frame, timestamp: 19 }, options); } }
await assert.rejects(exportOffscreenVideo({ ...options, VideoEncoderClass: BadTimestampEncoder }), /Unexpected encoded timestamp/); assert.equal(encoders.at(-1).closed, 1);
const controller = new AbortController(); let entered;
const entry = new Promise(resolve => entered = resolve);
class StalledEncoder extends Encoder { flush() { entered(); return new Promise(() => {}); } }
const aborting = exportOffscreenVideo({ ...options, signal: controller.signal, VideoEncoderClass: StalledEncoder });
await entry; controller.abort(); await assert.rejects(aborting, { name: 'AbortError' }); assert.equal(encoders.at(-1).closed, 1);
await exportAndRead(24, 24);
console.log('PASS deterministic slow/no-RAF export, frame gate, PNG row parity, pack metadata, errors, abort cleanup and retry');
