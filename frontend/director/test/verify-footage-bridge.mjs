import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	EXTRACT_FPS_MAX,
	capExtractFps,
	normalizeArgs,
	parseDownloadRatio,
	parseEncodeRatio,
	parseProbeLine,
	parseProbeStreamInfo,
} from "../tools/ardy/footage.mjs";

const footageSource = readFileSync(new URL("../tools/ardy/footage.mjs", import.meta.url), "utf8");
assert.match(
	footageSource,
	/const fail = \(message\) => \{[\s\S]{0,180}cleanupArtifacts\(\);/,
	"every terminal footage failure removes its private request directory",
);
assert.match(
	footageSource,
	/client disconnected mid-footage[\s\S]{0,240}cleanupArtifacts\(\);/,
	"a disconnected footage request removes partial private artifacts",
);

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance = 1e-9) { return Math.abs(a - b) <= tolerance; }

{
	assert.ok(near(parseDownloadRatio("[download]  42.3% of 12.34MiB at 2.1MiB/s"), 0.423));
	assert.ok(near(parseDownloadRatio("[download] 100% of 12.34MiB"), 1));
	assert.equal(parseDownloadRatio("[info] Downloading format 137"), null);
	assert.equal(parseDownloadRatio(""), null);
	pass("yt-dlp progress lines parse to a 0..1 ratio; other lines are null");
}

{
	assert.ok(near(parseEncodeRatio("frame=  296 fps= 74 time=00:00:12.33 bitrate=...", 24.66), 0.5, 1e-3));
	assert.equal(parseEncodeRatio("frame=  296 fps= 74 time=00:00:30.00", 15), 1); // capped, never over 1
	assert.equal(parseEncodeRatio("Press [q] to stop", 15), null);
	assert.equal(parseEncodeRatio("time=00:00:05.00", 0), null); // no duration, no honest ratio
	pass("ffmpeg time= lines parse against the clip length, capped to 1");
}

{
	assert.deepEqual(parseProbeLine("125.0\t29.97\tBoxing footwork drill"), { durationS: 125, fps: 30, title: "Boxing footwork drill" });
	assert.deepEqual(parseProbeLine("17\tNA\t쉐도우 복싱"), { durationS: 17, fps: 30, title: "쉐도우 복싱" }); // unknown rate falls back, clamped band
	assert.equal(parseProbeLine("125.0\t240\tSlow-mo").fps, 60); // absurd rates clamp to the sane band
	assert.equal(parseProbeLine("NA\t30\tLive stream"), null); // no fixed length: refused upstream by name
	assert.equal(parseProbeLine("no tabs here"), null);
	pass("probe lines split duration, native rate and title; lives and garbage are null");
}

// The measured reason for the ceiling: the same session's 60 fps take trembled
// 3.36/3.54 cm at the feet against 0.60/0.72 cm at 30 fps, because SAM's
// per-frame error arrives per FRAME while the smoothing windows are counted in
// frames. Nothing above the ceiling may reach extraction, by either intake.
{
	assert.equal(EXTRACT_FPS_MAX, 30);
	assert.equal(capExtractFps(60), 30); // the real 60 fps clip in out/footage
	assert.equal(capExtractFps(59.94), 30); // NTSC 60 rounds before it is judged
	assert.equal(capExtractFps(120), 30); // ÷4, still an exact frame drop
	assert.equal(capExtractFps(240), 30);
	pass("a rate over the ceiling comes down to the ceiling or below");
}

{
	assert.equal(capExtractFps(24), 24); // a film-rate source is NEVER pushed up
	assert.equal(capExtractFps(25), 25);
	assert.equal(capExtractFps(30), 30); // exactly at the ceiling: untouched
	assert.equal(capExtractFps(23.976), 24);
	pass("a source at or under the ceiling keeps its own rate — no upsampling");
}

{
	// An integer divisor drops every n-th frame and leaves the survivors as
	// shot; a foreign rate would have to duplicate frames unevenly.
	assert.equal(capExtractFps(50), 25); // ÷2, not 30
	assert.equal(capExtractFps(48), 24); // ÷2, not 30
	assert.equal(capExtractFps(90), 30); // ÷3
	assert.equal(capExtractFps(35), 30); // no divisor lands in range → ceiling
	assert.equal(capExtractFps(45), 30);
	assert.equal(capExtractFps(0), 30); // an unreadable rate takes the ceiling,
	assert.equal(capExtractFps(NaN), 30); // never the source's word
	pass("an exact multiple halves rather than resample to a foreign rate");
}

{
	// The ffmpeg pass a 60 fps download and a 24 fps download each get.
	const sixty = normalizeArgs("/in/raw.mp4", "/out/clip.mp4", capExtractFps(60));
	const twentyFour = normalizeArgs("/in/raw.mp4", "/out/clip.mp4", capExtractFps(24));
	assert.ok(sixty.includes("fps=30"), sixty.join(" "));
	assert.ok(twentyFour.includes("fps=24"), twentyFour.join(" "));
	assert.equal(sixty.filter((arg) => /^fps=/.test(arg)).length, 1); // one rate, no second resample
	assert.ok(sixty.includes("-an")); // audio never reaches the ingest
	// A frame-rate change, not a speed change: nothing here retimes or trims,
	// so the clip comes out the same length it went in.
	for (const arg of [...sixty, ...twentyFour]) {
		assert.ok(!/setpts|atempo/.test(arg), arg);
		assert.ok(arg !== "-t" && arg !== "-r" && arg !== "-ss", arg);
	}
	pass("the normalize pass carries the capped rate and nothing that alters duration");
}

{
	const probed = parseProbeStreamInfo("r_frame_rate=60/1\navg_frame_rate=60/1\nduration=30.050000\n");
	assert.equal(probed.fps, 60);
	assert.ok(near(probed.durationS, 30.05, 1e-9));
	assert.equal(capExtractFps(probed.fps), 30);
	// A VFR mux reports its base tick as r_frame_rate and nothing as the
	// average; extraction still gets a rate it can act on.
	assert.equal(parseProbeStreamInfo("r_frame_rate=90000/1\navg_frame_rate=0/0\n").fps, 90000);
	assert.equal(parseProbeStreamInfo("r_frame_rate=30000/1001\navg_frame_rate=30000/1001\n").fps, 30000 / 1001);
	assert.equal(parseProbeStreamInfo("").fps, null); // no rate is not a rate of 0
	assert.equal(parseProbeStreamInfo("duration=N/A\n").durationS, null);
	pass("ffprobe stream info parses to a real rate and length, or to null");
}

{
	// What the bridge tells the browser must be what SAM will meet: the probe
	// reads the source, the cap decides, and the DONE event reports the cap.
	assert.equal(capExtractFps(parseProbeLine("30.05\t60\t쉐도우 복싱").fps), 30);
	assert.equal(capExtractFps(parseProbeLine("17.13\t24\tFilm take").fps), 24);
	pass("a probed platform rate is reported to the app already capped");
}

console.log("verify-footage-bridge: all checks passed");
