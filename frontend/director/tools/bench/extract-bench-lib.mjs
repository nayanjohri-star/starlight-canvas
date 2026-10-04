/**
 * extract-bench-lib.mjs — the pure half of tools/bench/extract-bench.mjs
 * (#430): argument parsing, condition -> runner flag mapping, the production
 * extraction defaults read from the same environment variables
 * tools/ardy/extract.mjs reads, and runner-log parsing. No I/O here, so every
 * decision the bench makes about WHAT it runs is unit-testable without a box.
 */
import { GVHMR_SMOOTH_SIGMA, gvhmrDetectorFromEnv, gvhmrKeypointsFromEnv, gvhmrRunnerArgs } from "../ardy/runners/gvhmr-worker.mjs";

// `path` is how the box is driven:
//   worker  the bridge's persistent worker (gvhmrWorker), exactly as
//           handleExtract drives it — fast path + trajectory correction on.
//   direct  one `cclay_gvhmr_extract.py` process per run, the runner alone.
// prod follows production's own switch (CCLAY_GVHMR_WORKER=0 -> direct).
// The persistent worker hard-codes the palette detector, so any YOLO
// condition can only run direct.
export const CONDITIONS = Object.freeze({
	prod: Object.freeze({ path: "worker", detector: "palette", keypoints: null }),
	"palette-hybrid": Object.freeze({ path: "direct", detector: "palette", keypoints: "hybrid" }),
	"palette-vitpose": Object.freeze({ path: "direct", detector: "palette", keypoints: "vitpose" }),
	"yolo-vitpose": Object.freeze({ path: "direct", detector: "yolo", keypoints: "vitpose" }),
});
export const FMM_SUFFIX = "+fmm";
export const DEFAULT_CONDITIONS = Object.freeze(Object.keys(CONDITIONS));
export const DEFAULT_VARIANTS = Object.freeze(["shaded"]);

export const USAGE = `usage: node tools/bench/extract-bench.mjs --input <t1-root> --out <dir> [options]

  --input <dir>        T1 output root: <dir>/<motion>/<variant>/{video.mp4,camera.json}
  --out <dir>          results go to <dir>/<motion>/<variant>/<condition>/
  --motions a,b        motions to run (default: every <motion> dir under --input)
  --variants a,b       variants to run (default: ${DEFAULT_VARIANTS.join(",")})
  --conditions a,b     any of ${Object.keys(CONDITIONS).join(", ")},
                       each optionally suffixed ${FMM_SUFFIX} to pass camera.json gvhmrFMm
                       as --f-mm (default: ${DEFAULT_CONDITIONS.join(",")})
  --host <ssh-dest>    GPU box (default: CCLAY_EXTRACT_HOST, then CCLAY_ARDY_HOST)
  --force              re-run conditions whose result.json already says ok
  --dry-run            print the run plan (flags per run) and exit
  --help               this text

Runs are serial. Every motion x variant x condition writes motion.npz
(cskel27, production post-processing), gvhmr.npz (runner output), log.txt
and result.json.`;

function splitList(value, flag) {
	const items = value.split(",").map((item) => item.trim()).filter(Boolean);
	if (!items.length) throw new Error(`${flag} needs at least one entry`);
	return items;
}

/** "prod+fmm" -> { name, base: "prod", fmm: true }; throws on unknown names. */
export function parseCondition(name) {
	const fmm = name.endsWith(FMM_SUFFIX);
	const base = fmm ? name.slice(0, -FMM_SUFFIX.length) : name;
	if (!Object.hasOwn(CONDITIONS, base)) {
		throw new Error(`unknown condition "${name}" (known: ${Object.keys(CONDITIONS).join(", ")}, each optionally ${FMM_SUFFIX})`);
	}
	return { name, base, fmm };
}

export function parseArgs(argv, env = {}) {
	const options = {
		input: null,
		out: null,
		motions: null,
		variants: [...DEFAULT_VARIANTS],
		conditions: DEFAULT_CONDITIONS.map(parseCondition),
		host: env.CCLAY_EXTRACT_HOST?.trim() || env.CCLAY_ARDY_HOST?.trim() || null,
		force: false,
		dryRun: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		switch (flag) {
			case "--input": options.input = value(); break;
			case "--out": options.out = value(); break;
			case "--motions": options.motions = splitList(value(), flag); break;
			case "--variants": options.variants = splitList(value(), flag); break;
			case "--conditions": {
				const names = splitList(value(), flag);
				options.conditions = [...new Set(names)].map(parseCondition);
				break;
			}
			case "--host": options.host = value(); break;
			case "--force": options.force = true; break;
			case "--dry-run": options.dryRun = true; break;
			case "--help": case "-h": options.help = true; break;
			default: throw new Error(`unknown argument: ${flag}`);
		}
	}
	if (options.help) return options;
	if (!options.input) throw new Error("--input is required");
	if (!options.out) throw new Error("--out is required");
	if (!options.dryRun && !options.host) throw new Error("no GPU host: pass --host or set CCLAY_EXTRACT_HOST / CCLAY_ARDY_HOST");
	return options;
}

/**
 * The extraction defaults handleExtract reads at import time, read from the
 * same variables with the same parsing, so the bench's prod condition and a
 * bridge started in the same shell run the same take.
 */
export function productionExtractEnv(env = {}) {
	return {
		staticCam: (env.CCLAY_EXTRACT_STATIC_CAM?.trim() || "1") !== "0",
		detector: gvhmrDetectorFromEnv(env),
		keypoints: gvhmrKeypointsFromEnv(env),
		worker: env.CCLAY_GVHMR_WORKER?.trim() !== "0",
		trajectory: env.CCLAY_GVHMR_TRAJECTORY?.trim() !== "0",
		smoothSigma: GVHMR_SMOOTH_SIGMA,
		stabilize: {
			enabled: env.CCLAY_GVHMR_SMOOTHING?.trim() !== "0",
			smoothRotations: env.CCLAY_GVHMR_ROTATION_SMOOTHING?.trim() !== "0",
			anchorFeet: env.CCLAY_GVHMR_ANCHOR_FEET?.trim() !== "0",
		},
	};
}

/**
 * Everything one run needs to know about its condition:
 *   path          "worker" | "direct"
 *   runnerArgs    flags for cclay_gvhmr_extract.py (direct path; for the
 *                 worker path, the flags its runner_argv derives from the request)
 *   workerFields  the request fields beside video/output/outRoot (worker path)
 *   stabilize     stabilizeMotion options
 * `cameraFMm` is camera.json's gvhmrFMm; required only for a +fmm condition.
 */
export function resolveCondition(condition, { cameraFMm = null, env = {} } = {}) {
	const spec = typeof condition === "string" ? parseCondition(condition) : condition;
	const base = CONDITIONS[spec.base];
	const prod = productionExtractEnv(env);
	let fMm = null;
	if (spec.fmm) {
		if (!Number.isFinite(cameraFMm) || cameraFMm <= 0) throw new Error(`${spec.name}: camera.json has no usable gvhmrFMm`);
		fMm = Math.trunc(cameraFMm);
	}
	const detector = base.detector === "palette" ? prod.detector : base.detector;
	const keypoints = base.keypoints ?? prod.keypoints;
	const path = spec.base === "prod" && !prod.worker ? "direct" : base.path;
	// Start from production's own flag builder so every flag the bench does
	// not vary (static cam, smoothing sigma, f-mm formatting) is byte-for-byte
	// production's; only a non-palette detector is swapped in afterwards,
	// because gvhmrRunnerArgs deliberately refuses to emit one.
	const runnerArgs = gvhmrRunnerArgs({ staticCam: prod.staticCam, fMm, detector, keypoints, smoothSigma: prod.smoothSigma });
	if (detector !== "palette") runnerArgs[runnerArgs.indexOf("--detector") + 1] = detector;
	// Same field order as handleExtract's request; fMm only when asked for,
	// so a plain prod request is exactly the bridge's.
	const workerFields = path === "worker"
		? { staticCam: prod.staticCam, detector, keypoints, trajectory: prod.trajectory, smoothSigma: prod.smoothSigma, ...(fMm != null ? { fMm } : {}) }
		: null;
	return { name: spec.name, base: spec.base, fmm: spec.fmm, fMm, path, detector, keypoints, runnerArgs, workerFields, stabilize: prod.stabilize };
}

const ELAPSED = /^\[\+(\d+(?:\.\d+)?)s\] ?/;

/**
 * Summarise a runner log (log.txt: optionally "[+12.34s] " elapsed prefixes,
 * as the bench writes it). Detection counts come from:
 *   palette   "[cclay] detector palette: N/M frames"
 *   yolo      "[bench] yolo track: N/M frames" (bench launcher, tracker path)
 *             "[cclay] tracker failed; using raw detections on N/M frames"
 * and apply only to the detector the runner finally selected.
 */
export function parseRunnerLog(text) {
	const summary = {
		detector: null, detectedFrames: null, totalFrames: null, detectionRate: null, detectionSource: null,
		yoloConf: null, keypoints: null, videoFrames: null, videoFps: null, staticCam: null,
		wroteFrames: null, rootTravelM: null, lrFlipFrames: [], hybridOverrides: null, stages: [],
	};
	let palette = null;
	let yolo = null;
	for (const raw of String(text).split(/[\r\n]+/)) {
		const elapsed = ELAPSED.exec(raw);
		const at = elapsed ? Number(elapsed[1]) : null;
		const line = elapsed ? raw.slice(elapsed[0].length) : raw;
		let m;
		if ((m = /\[cclay\] stage (\w+)/.exec(line))) summary.stages.push({ stage: m[1], at });
		else if ((m = /\[cclay\] detector palette: (\d+)\/(\d+) frames/.exec(line))) palette = { detected: +m[1], total: +m[2], source: "palette-log" };
		else if ((m = /\[bench\] yolo track: (\d+)\/(\d+) frames/.exec(line))) yolo = { detected: +m[1], total: +m[2], source: "yolo-track" };
		else if ((m = /\[cclay\] tracker failed; using raw detections on (\d+)\/(\d+) frames/.exec(line))) yolo = { detected: +m[1], total: +m[2], source: "yolo-raw-detections" };
		else if ((m = /\[cclay\] person track found at yolo conf ([\d.]+)/.exec(line))) summary.yoloConf = Number(m[1]);
		else if ((m = /\[cclay\] detector: (\w+) selected/.exec(line))) summary.detector = m[1];
		else if ((m = /\[cclay\] keypoints: (\w+) selected/.exec(line))) summary.keypoints = m[1];
		else if ((m = /\[cclay\] \S+ L=(\d+) \d+x\d+ @ ([\d.]+) fps static_cam=(\w+)/.exec(line))) {
			summary.videoFrames = Number(m[1]);
			summary.videoFps = Number(m[2]);
			summary.staticCam = m[3] === "True";
		} else if ((m = /\[cclay\] wrote \S+: (\d+) frames @ [\d.]+ fps, root XZ travel ([\d.]+) m/.exec(line))) {
			summary.wroteFrames = Number(m[1]);
			summary.rootTravelM = Number(m[2]);
		} else if ((m = /\[cclay\] left\/right flip corrected at frames \[([\d, ]*)\]/.exec(line))) {
			summary.lrFlipFrames.push(...m[1].split(",").map((v) => v.trim()).filter(Boolean).map(Number));
		} else if ((m = /\[cclay\] keypoints hybrid: .*?; (\d+) joint observations/.exec(line))) summary.hybridOverrides = Number(m[1]);
	}
	const counted = summary.detector === "palette" ? palette : summary.detector === "yolo" ? yolo : null;
	if (counted) {
		summary.detectedFrames = counted.detected;
		summary.totalFrames = counted.total;
		summary.detectionRate = counted.total ? counted.detected / counted.total : null;
		summary.detectionSource = counted.source;
	}
	// Wall time per stage: from its own line to the next stage line (the last
	// stage has no successor and stays null).
	summary.stages = summary.stages.map((entry, index, all) => ({
		...entry,
		seconds: entry.at != null && all[index + 1]?.at != null ? Number((all[index + 1].at - entry.at).toFixed(3)) : null,
	}));
	return summary;
}
