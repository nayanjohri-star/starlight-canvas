import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gvhmrRunnerArgs } from "../tools/ardy/runners/gvhmr-worker.mjs";
import { parseArgs, parseCondition, parseRunnerLog, productionExtractEnv, resolveCondition } from "../tools/bench/extract-bench-lib.mjs";

// --- conditions -------------------------------------------------------------
assert.deepEqual(parseCondition("prod"), { name: "prod", base: "prod", fmm: false });
assert.deepEqual(parseCondition("prod+fmm"), { name: "prod+fmm", base: "prod", fmm: true });
assert.deepEqual(parseCondition("yolo-vitpose+fmm"), { name: "yolo-vitpose+fmm", base: "yolo-vitpose", fmm: true });
for (const bad of ["", "+fmm", "yolo", "prod+FMM", "palette-hybrid+fmm+fmm"]) assert.throws(() => parseCondition(bad), /unknown condition/);

// --- argument parsing -------------------------------------------------------
{
	const options = parseArgs(["--input", "t1", "--out", "t2"], { CCLAY_ARDY_HOST: "box" });
	assert.equal(options.host, "box");
	assert.deepEqual(options.variants, ["shaded"]);
	assert.equal(options.motions, null);
	assert.deepEqual(options.conditions.map((c) => c.name), ["prod", "palette-hybrid", "palette-vitpose", "yolo-vitpose"]);
	assert.equal(parseArgs(["--input", "t1", "--out", "t2"], { CCLAY_ARDY_HOST: "a", CCLAY_EXTRACT_HOST: " b " }).host, "b");
	const explicit = parseArgs(["--input", "t1", "--out", "t2", "--host", "h", "--motions", "a, b", "--variants", "skin",
		"--conditions", "yolo-vitpose,prod+fmm,prod+fmm", "--force"], {});
	assert.deepEqual(explicit.motions, ["a", "b"]);
	assert.deepEqual(explicit.variants, ["skin"]);
	assert.deepEqual(explicit.conditions.map((c) => c.name), ["yolo-vitpose", "prod+fmm"], "duplicates collapse, order kept");
	assert.equal(explicit.force, true);
	assert.equal(parseArgs(["--input", "t1", "--out", "t2", "--dry-run"], {}).host, null, "a dry run needs no host");
	assert.equal(parseArgs(["--help"], {}).help, true);
	assert.throws(() => parseArgs(["--out", "t2", "--host", "h"], {}), /--input is required/);
	assert.throws(() => parseArgs(["--input", "t1", "--host", "h"], {}), /--out is required/);
	assert.throws(() => parseArgs(["--input", "t1", "--out", "t2"], {}), /no GPU host/);
	assert.throws(() => parseArgs(["--input", "--out", "t2"], {}), /--input needs a value/);
	assert.throws(() => parseArgs(["--input", "t1", "--out", "t2", "--conditions", " , "], {}), /at least one/);
	assert.throws(() => parseArgs(["--input", "t1", "--out", "t2", "--conditions", "prod,sam"], {}), /unknown condition "sam"/);
	assert.throws(() => parseArgs(["--jobs", "2"], {}), /unknown argument/);
}

// --- production defaults (the variables handleExtract reads) ---------------
assert.deepEqual(productionExtractEnv({}), {
	staticCam: true, detector: "palette", keypoints: "auto", worker: true, trajectory: true, smoothSigma: 3,
	stabilize: { enabled: true, smoothRotations: true, anchorFeet: true },
});
assert.deepEqual(productionExtractEnv({
	CCLAY_EXTRACT_STATIC_CAM: "0", CCLAY_EXTRACT_DETECTOR: "yolo", CCLAY_EXTRACT_KEYPOINTS: " Hybrid ", CCLAY_GVHMR_WORKER: "0",
	CCLAY_GVHMR_TRAJECTORY: "0", CCLAY_GVHMR_SMOOTHING: "0", CCLAY_GVHMR_ROTATION_SMOOTHING: "0", CCLAY_GVHMR_ANCHOR_FEET: "0",
}), {
	staticCam: false, detector: "palette", keypoints: "hybrid", worker: false, trajectory: false, smoothSigma: 3,
	stabilize: { enabled: false, smoothRotations: false, anchorFeet: false },
});

// --- condition -> flags -----------------------------------------------------
{
	// prod is the bridge's worker request, field for field and in its order.
	const prod = resolveCondition("prod", { cameraFMm: 35 });
	assert.equal(prod.path, "worker");
	assert.deepEqual(Object.entries(prod.workerFields),
		[["staticCam", true], ["detector", "palette"], ["keypoints", "auto"], ["trajectory", true], ["smoothSigma", 3]]);
	assert.deepEqual(prod.runnerArgs, gvhmrRunnerArgs({ staticCam: true, detector: "palette", keypoints: "auto" }));
	assert.equal(prod.fMm, null, "camera focal length is only passed for +fmm");

	const prodFmm = resolveCondition("prod+fmm", { cameraFMm: 35.8 });
	assert.equal(prodFmm.workerFields.fMm, 35);
	assert.deepEqual(prodFmm.runnerArgs, ["--static-cam", "--f-mm", "35", "--detector", "palette", "--keypoints", "auto", "--smooth-sigma", "3"]);
	for (const cameraFMm of [null, undefined, 0, -3, Number.NaN]) {
		assert.throws(() => resolveCondition("prod+fmm", { cameraFMm }), /no usable gvhmrFMm/);
	}

	assert.deepEqual(resolveCondition("palette-hybrid").runnerArgs,
		["--static-cam", "--detector", "palette", "--keypoints", "hybrid", "--smooth-sigma", "3"]);
	assert.deepEqual(resolveCondition("palette-vitpose").runnerArgs,
		["--static-cam", "--detector", "palette", "--keypoints", "vitpose", "--smooth-sigma", "3"]);
	const yolo = resolveCondition("yolo-vitpose+fmm", { cameraFMm: 35 });
	assert.equal(yolo.path, "direct");
	assert.equal(yolo.workerFields, null);
	assert.deepEqual(yolo.runnerArgs, ["--static-cam", "--f-mm", "35", "--detector", "yolo", "--keypoints", "vitpose", "--smooth-sigma", "3"]);

	// Production env switches follow into prod; the bench variables stay fixed.
	const env = { CCLAY_EXTRACT_KEYPOINTS: "palette", CCLAY_EXTRACT_STATIC_CAM: "0", CCLAY_GVHMR_WORKER: "0" };
	const prodDirect = resolveCondition("prod", { env });
	assert.equal(prodDirect.path, "direct", "CCLAY_GVHMR_WORKER=0 is production's one-shot command");
	assert.equal(prodDirect.workerFields, null);
	assert.deepEqual(prodDirect.runnerArgs, ["--detector", "palette", "--keypoints", "palette", "--smooth-sigma", "3"]);
	assert.deepEqual(resolveCondition("palette-vitpose", { env }).runnerArgs, ["--detector", "palette", "--keypoints", "vitpose", "--smooth-sigma", "3"]);
	assert.equal(resolveCondition("yolo-vitpose", { env: { CCLAY_EXTRACT_DETECTOR: "palette" } }).detector, "yolo");
}

// --- runner log parsing -----------------------------------------------------
{
	const palette = parseRunnerLog([
		"[+0.00s] [bench] worker request {}",
		"[+1.50s] [09/27 12:00:00] [cclay] /tmp/cclay-bench-1/x/video.mp4 L=96 832x480 @ 24.0 fps static_cam=True",
		"[+1.60s] [cclay] stage track",
		"[+4.10s] [cclay] detector palette: 95/96 frames",
		"[+4.20s] [cclay] detector: palette selected",
		"[+4.30s] [cclay] keypoints: hybrid selected",
		"[+4.30s] [cclay] stage vitpose",
		"[+9.30s] [cclay] stage keypoints hybrid",
		"[+10.00s] [cclay] keypoints hybrid: palette body + ViTPose face; 12 joint observations re-derived from a neighbouring part (0.12 per frame)",
		"[+10.10s] [cclay] left/right flip corrected at frames [4, 17]",
		"[+10.20s] [cclay] stage features\r[pass1]   48 / 96 frames  (eta ~3 s)\r[pass1]   96 / 96 frames",
		"[+14.20s] [cclay] stage camera",
		"[+14.30s] [cclay] stage gvhmr",
		"[+20.30s] [cclay] stage joints",
		"[+21.00s] [cclay] wrote /tmp/x/gvhmr.npz: 96 frames @ 24 fps, root XZ travel 1.25 m",
	].join("\n"));
	assert.equal(palette.detector, "palette");
	assert.equal(palette.detectedFrames, 95);
	assert.equal(palette.totalFrames, 96);
	assert.equal(palette.detectionRate, 95 / 96);
	assert.equal(palette.detectionSource, "palette-log");
	assert.equal(palette.keypoints, "hybrid");
	assert.equal(palette.videoFrames, 96);
	assert.equal(palette.videoFps, 24);
	assert.equal(palette.staticCam, true);
	assert.equal(palette.wroteFrames, 96);
	assert.equal(palette.rootTravelM, 1.25);
	assert.equal(palette.hybridOverrides, 12);
	assert.deepEqual(palette.lrFlipFrames, [4, 17]);
	assert.deepEqual(palette.stages.map((s) => s.stage), ["track", "vitpose", "keypoints", "features", "camera", "gvhmr", "joints"]);
	assert.equal(palette.stages[0].at, 1.6);
	assert.equal(palette.stages[0].seconds, 2.7);
	assert.equal(palette.stages[1].seconds, 5.0);
	assert.equal(palette.stages.at(-1).seconds, null, "the last stage has no end mark");

	// YOLO: the count belongs to the attempt that produced the track.
	const yolo = parseRunnerLog([
		"[cclay] stage track",
		"[cclay] no person track at yolo conf 0.5",
		"[bench] yolo track: 12/96 frames",
		"[cclay] person track found at yolo conf 0.25",
		"[cclay] detector: yolo selected",
		"[cclay] keypoints: vitpose selected",
	].join("\n"));
	assert.deepEqual([yolo.detector, yolo.detectedFrames, yolo.totalFrames, yolo.detectionSource, yolo.yoloConf, yolo.stages[0].seconds],
		["yolo", 12, 96, "yolo-track", 0.25, null]);
	const raw = parseRunnerLog("[cclay] tracker failed; using raw detections on 40/96 frames, interpolated\n[cclay] detector: yolo selected");
	assert.deepEqual([raw.detectedFrames, raw.detectionSource], [40, "yolo-raw-detections"]);
	// auto: palette saw too little, YOLO took over — the palette count must not be reported as the detection.
	const fellBack = parseRunnerLog("[cclay] detector palette: 3/96 frames\n[cclay] detector: yolo selected");
	assert.deepEqual([fellBack.detector, fellBack.detectedFrames], ["yolo", null]);
	const empty = parseRunnerLog("");
	assert.deepEqual([empty.detector, empty.detectedFrames, empty.stages], [null, null, []]);
}

// --- box launcher: argv passthrough and the YOLO count line ------------------
{
	const launcher = fileURLToPath(new URL("../tools/bench/cclay_bench_runner.py", import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), "cozyclay-bench-launcher-"));
	try {
		mkdirSync(join(dir, "hmr4d", "utils", "preproc"), { recursive: true });
		for (const pkg of ["hmr4d", "hmr4d/utils", "hmr4d/utils/preproc"]) writeFileSync(join(dir, pkg, "__init__.py"), "");
		writeFileSync(join(dir, "hmr4d", "utils", "preproc", "tracker.py"), [
			"class Tracker:",
			"    @staticmethod",
			"    def sort_track_length(track_history, video_path):",
			"        ids = {}",
			"        for f, frame in enumerate(track_history):",
			"            for det in frame: ids.setdefault(det, []).append(f)",
			"        return ids, {}, sorted(ids, key=lambda k: -len(ids[k]))",
			"",
		].join("\n"));
		writeFileSync(join(dir, "runner.py"), [
			"import json, sys",
			"from hmr4d.utils.preproc.tracker import Tracker",
			"def main():",
			"    t = Tracker()",
			"    empty = t.sort_track_length([[], []], 'v.mp4')",
			"    ids, _, order = t.sort_track_length([[7], [], [7, 8], [8]], 'v.mp4')",
			"    print(json.dumps({'argv': sys.argv[1:], 'order': order, 'ids': {str(k): v for k, v in ids.items()}, 'empty': empty[2]}))",
			"if __name__ == '__main__':",
			"    raise SystemExit('the launcher must call main() itself')",
			"",
		].join("\n"));
		const run = spawnSync("python3", [launcher, join(dir, "runner.py"), "in.mp4", "out.npz", "--detector", "yolo"], { cwd: tmpdir(), encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout), { argv: ["in.mp4", "out.npz", "--detector", "yolo"], order: [7, 8], ids: { 7: [0, 2], 8: [2, 3] }, empty: [] });
		assert.equal(run.stderr.trim(), "[bench] yolo track: 2/4 frames", "one line, only for a non-empty track");
		assert.equal(parseRunnerLog(`${run.stderr}[cclay] detector: yolo selected`).detectedFrames, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("PASS extract bench: conditions, arguments, production defaults, runner log, box launcher");
