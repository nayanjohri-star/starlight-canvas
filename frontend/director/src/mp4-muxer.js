import {
	BufferTarget,
	EncodedPacket,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

const codecFamily = (codec) => {
	if (codec.startsWith("avc1")) return "avc";
	throw new RangeError(`unsupported MP4 video codec: ${codec}`);
};

/** Package ordered WebCodecs video chunks into a fast-start, video-only MP4. */
export async function muxMP4({ chunks, codec, decoderConfig, signal = null }) {
	if (!Array.isArray(chunks) || chunks.length < 1) throw new RangeError("MP4 needs at least one encoded frame");
	if (!decoderConfig || typeof decoderConfig !== "object") throw new TypeError("MP4 needs a decoder config");
	if (codec.startsWith("avc1") && !decoderConfig.description) {
		throw new Error("H.264 MP4 needs the encoder's AVC decoder configuration");
	}

	const target = new BufferTarget();
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: "in-memory" }),
		target,
	});
	const source = new EncodedVideoPacketSource(codecFamily(codec));
	output.addVideoTrack(source);
	try {
		signal?.throwIfAborted();
		await output.start();
		for (let index = 0; index < chunks.length; index += 1) {
			signal?.throwIfAborted();
			const chunk = chunks[index];
			const packet = new EncodedPacket(
				chunk.data,
				chunk.type,
				chunk.timestamp / 1_000_000,
				chunk.duration / 1_000_000,
				index,
			);
			await source.add(packet, index === 0 ? { decoderConfig } : undefined);
		}
		signal?.throwIfAborted();
		await output.finalize();
		if (!target.buffer) throw new Error("MP4 muxer finalized without output");
		return new Blob([target.buffer], { type: "video/mp4" });
	} catch (error) {
		if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
		throw error;
	}
}
