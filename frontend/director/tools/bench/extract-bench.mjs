#!/usr/bin/env node
/**
 * extract-bench.mjs — GVHMR extraction bench (#430, validation step T2).
 *
 * Feeds T1 ground-truth renders (<input>/<motion>/<variant>/video.mp4 +
 * camera.json) to the GPU box under named conditions and converts every
 * result with production's post-processing, so T3 can score conditions
 * against the ground truth without re-running anything:
 *
 *   <out>/<motion>/<variant>/<condition>/
 *     gvhmr.npz    the runner's SMPL output, untouched
 *     motion.npz   cskel27, smplToCskel27Motion -> stabilizeMotion ->
 *                  guardTrajectoryFloor, written like /ardy/extract writes it
 *     log.txt      the runner's log, lines prefixed with elapsed seconds
 *     result.json  flags, detection counts, timings, quality report,
 *                  stabilisation and trajectory diagnostics
 *
 * `prod` is handleExtract's path step for step (fps conform, upload, the
 * bridge's persistent worker with its request, conversion with the env
 * defaults); the other conditions call cclay_gvhmr_extract.py directly with
 * one variable changed. Runs are serial, on the box they use only
 * /tmp/cclay-bench-<stamp>/ (removed at exit) — the one exception is the
 * persistent worker's own content-addressed code dir, which gvhmrWorker owns.
 * Pure logic: extract-bench-lib.mjs.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conformToExtractFps } from "../ardy/footage.mjs";
import { qualityReportForMotion } from "../ardy/extract.mjs";
import { guardTrajectoryFloor } from "../ardy/gvhmr-floor.mjs";
import { stabilizeMotion } from "../ardy/motion-stabilize.mjs";
import { motionArraysToNpzMembers, writeNpz } from "../ardy/npz.mjs";
import { gvhmrWorker } from "../ardy/runners/gvhmr-worker.mjs";
import { globalChildren, killGroup, streamLines, track } from "../ardy/runners/proc.mjs";
import { smplToCskel27Motion } from "../ardy/smpl-cskel27.mjs";
import { readNpz } from "../kimodo/read-npz.mjs";
import { USAGE, parseArgs, parseRunnerLog, resolveCondition } from "./extract-bench-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const GVHMR_DIR = "~/cclay-ingest/GVHMR";
const LAUNCHER = join(HERE, "cclay_bench_runner.py");
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
// Same ssh options handleExtract uses (CCLAY_EXTRACT_SSH_PORT included) — the
// worker client is keyed on them, as the bridge's is.
const SSH_BASE_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const SSH_PORT = process.env.CCLAY_EXTRACT_SSH_PORT?.trim() || "";
const SSH_OPTS = SSH_PORT ? [...SSH_BASE_OPTS, "-p", SSH_PORT] : SSH_BASE_OPTS;
const SCP_OPTS = SSH_PORT ? [...SSH_BASE_OPTS, "-P", SSH_PORT] : SSH_BASE_OPTS;

/** Spawn a child in its own group; resolve on exit 0, reject with its last
 *  output line otherwise. Every line (split on \r too, for tqdm) -> onLine. */
function exec(command, args, { onLine, timeoutMs = 0 } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		track(child);
		let last = "";
		const feed = (line) => {
			for (const part of line.split("\r")) {
				if (!part.trim()) continue;
				last = part;
				onLine?.(part);
			}
		};
		streamLines(child.stdout, feed);
		streamLines(child.stderr, feed);
		const timer = timeoutMs ? setTimeout(() => { killGroup(child); reject(new Error(`${command} timed out`)); }, timeoutMs) : null;
		child.once("error", (err) => { clearTimeout(timer); reject(new Error(`spawn ${command}: ${err.message}`)); });
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise();
			else reject(new Error(last.trim() || `${command} exited ${code}`));
		});
	});
}

const ssh = (host, command, options) => exec("ssh", [...SSH_OPTS, host, command], options);
const scp = (from, to, options) => exec("scp", [...SCP_OPTS, from, to], options);
const seconds = (since) => Number(((performance.now() - since) / 1000).toFixed(3));
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

function commitId() {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
	const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
	return head ? `${head}${dirty ? "-dirty" : ""}` : null;
}

function discoverMotions(input) {
	return readdirSync(input, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.filter((entry) => readdirSync(join(input, entry.name), { withFileTypes: true })
			.some((sub) => sub.isDirectory() && existsSync(join(input, entry.name, sub.name, "video.mp4"))))
		.map((entry) => entry.name)
		.sort();
}

function buildPlan(options) {
	const motions = options.motions ?? discoverMotions(options.input);
	const runs = [];
	for (const motion of motions) {
		for (const variant of options.variants) {
			const source = join(options.input, motion, variant);
			for (const condition of options.conditions) {
				const camera = readJson(join(source, "camera.json"));
				runs.push({
					motion, variant, source,
					out: join(options.out, motion, variant, condition.name),
					plan: resolveCondition(condition, { cameraFMm: camera?.gvhmrFMm ?? null, env: process.env }),
				});
			}
		}
	}
	return runs;
}

async function runOne(run, { host, benchDir, worker, commit }) {
	const started = performance.now();
	const { motion, variant, source, out, plan } = run;
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const logPath = join(out, "log.txt");
	writeFileSync(logPath, "");
	const log = (line) => appendFileSync(logPath, `[+${((performance.now() - started) / 1000).toFixed(2)}s] ${line}\n`);
	const video = join(source, "video.mp4");
	const videoBytes = readFileSync(video);
	const camera = readJson(join(source, "camera.json"));
	const meta = readJson(join(source, "meta.json"));
	const timings = {};
	const result = {
		ok: false,
		tool: "tools/bench/extract-bench.mjs",
		commit,
		createdAt: new Date().toISOString(),
		motion, variant, condition: plan.name, base: plan.base, fmm: plan.fmm, host,
		input: {
			video, sha256: createHash("sha256").update(videoBytes).digest("hex"), bytes: videoBytes.length,
			camera: camera && { width: camera.width, height: camera.height, fx: camera.fx, gvhmrFMm: camera.gvhmrFMm ?? null },
			meta: meta && { frames: meta.frames, fps: meta.fps, variant: meta.variant, source: meta.source?.path ?? null },
		},
		flags: {
			path: plan.path, detector: plan.detector, keypoints: plan.keypoints, fMm: plan.fMm,
			...(plan.path === "direct" ? { runnerArgs: plan.runnerArgs, launcher: plan.detector === "palette" ? "runner" : "bench-launcher" } : { workerRequest: plan.workerFields }),
			stabilize: plan.stabilize,
		},
		timings,
	};
	const localTmp = mkdtempSync(join(tmpdir(), "cclay-bench-"));
	const runKey = `${motion}-${variant}-${plan.name}`.replace(/[^A-Za-z0-9_.-]/g, "_");
	const remoteDir = `${benchDir}/${runKey}`;
	const remoteVideo = `${remoteDir}/video.mp4`;
	const remoteNpz = `${remoteDir}/gvhmr.npz`;
	const outRoot = `${remoteDir}/gvhmr-out`;
	let step = "conform";
	try {
		// handleExtract's rate ceiling: a ≤30 fps render passes through as is.
		let at = performance.now();
		const conformed = await conformToExtractFps(video, join(localTmp, "capped.mp4"));
		result.conform = { fps: conformed.fps, capped: conformed.capped };
		timings.conformS = seconds(at);

		step = "upload";
		at = performance.now();
		await ssh(host, `umask 077 && mkdir -p '${remoteDir}'`, { timeoutMs: 60000 });
		await scp(conformed.path, `${host}:${remoteVideo}`, { timeoutMs: 300000 });
		timings.uploadS = seconds(at);

		step = "extract";
		at = performance.now();
		let performanceReport = null;
		if (plan.path === "worker") {
			const request = { video: remoteVideo, output: remoteNpz, outRoot, ...plan.workerFields };
			log(`[bench] worker request ${JSON.stringify(request)}`);
			performanceReport = await worker().run(request, { timeoutMs: RUN_TIMEOUT_MS, onLine: log });
		} else {
			const program = plan.detector === "palette"
				? "cclay_gvhmr_extract.py"
				: `${benchDir}/cclay_bench_runner.py cclay_gvhmr_extract.py`;
			const command = `cd ${GVHMR_DIR} && .venv/bin/python ${program} ${remoteVideo} ${remoteNpz} ${plan.runnerArgs.join(" ")} --out-root ${outRoot}`;
			log(`[bench] ssh ${command}`);
			await ssh(host, command, { timeoutMs: RUN_TIMEOUT_MS, onLine: log });
		}
		timings.extractS = seconds(at);
		result.performance = performanceReport;

		step = "fetch";
		at = performance.now();
		const gvhmrNpz = join(out, "gvhmr.npz");
		await scp(`${host}:${remoteNpz}`, gvhmrNpz, { timeoutMs: 120000 });
		timings.fetchS = seconds(at);

		step = "convert";
		at = performance.now();
		const events = performanceReport?.trajectory?.events ?? [];
		const converted = stabilizeMotion(smplToCskel27Motion(readNpz(gvhmrNpz)), plan.stabilize);
		const guarded = guardTrajectoryFloor(converted, events);
		result.quality = qualityReportForMotion(guarded.motion);
		if (events.length) performanceReport.trajectory.floor = guarded.diagnostics;
		writeNpz(join(out, "motion.npz"), motionArraysToNpzMembers(guarded.motion));
		timings.convertS = seconds(at);
		result.motionInfo = { frames: guarded.motion.frames, fps: guarded.motion.fps, personScale: guarded.motion.personScale };
		result.stabilization = guarded.motion.stabilization ?? null;
		result.trajectory = { events, floor: guarded.diagnostics };
		result.ok = true;
	} catch (err) {
		result.error = { step, message: err.message };
		log(`[bench] FAILED at ${step}: ${err.message}`);
	} finally {
		rmSync(localTmp, { recursive: true, force: true });
		await ssh(host, `rm -rf '${remoteDir}'`, { timeoutMs: 60000 }).catch((err) => log(`[bench] remote cleanup failed: ${err.message}`));
	}
	const summary = parseRunnerLog(readFileSync(logPath, "utf8"));
	const segmentation = result.performance?.segmentation;
	result.detection = summary.detectedFrames != null
		? { detector: summary.detector, detectedFrames: summary.detectedFrames, totalFrames: summary.totalFrames, detectionRate: summary.detectionRate, source: summary.detectionSource }
		: segmentation?.detectedFrames != null
			? { detector: segmentation.detector, detectedFrames: segmentation.detectedFrames, totalFrames: segmentation.frames, detectionRate: segmentation.detectionRate, source: "worker-segmentation" }
			: { detector: summary.detector, detectedFrames: null, totalFrames: null, detectionRate: null, source: null };
	result.runnerLog = summary;
	timings.totalS = seconds(started);
	writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, "\t")}\n`);
	return result;
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2), process.env);
	} catch (err) {
		console.error(`extract-bench: ${err.message}\n\n${USAGE}`);
		process.exit(2);
	}
	if (options.help) {
		console.log(USAGE);
		return;
	}
	options.input = resolve(options.input);
	options.out = resolve(options.out);
	const runs = buildPlan(options);
	for (const run of runs) {
		if (!existsSync(join(run.source, "video.mp4"))) throw new Error(`missing input ${join(run.source, "video.mp4")}`);
	}
	if (options.dryRun) {
		for (const { motion, variant, plan } of runs) {
			const flags = plan.path === "worker" ? JSON.stringify(plan.workerFields) : plan.runnerArgs.join(" ");
			console.log(`${motion}/${variant}/${plan.name}\t${plan.path}\t${flags}`);
		}
		return;
	}

	const host = options.host;
	const commit = commitId();
	const benchDir = `/tmp/cclay-bench-${Date.now()}-${randomBytes(3).toString("hex")}`;
	let client = null;
	const worker = () => (client ??= gvhmrWorker({ host, sshOptions: SSH_OPTS, scpOptions: SCP_OPTS }));
	const cleanupRemote = () => spawnSync("ssh", [...SSH_OPTS, host, `rm -rf '${benchDir}'`], { stdio: "ignore", timeout: 60000 });
	process.once("SIGINT", () => {
		console.error("extract-bench: interrupted; stopping children and removing the box temp dir");
		client?.stop("extract-cancelled");
		for (const child of globalChildren) killGroup(child);
		cleanupRemote();
		process.exit(130);
	});

	await ssh(host, `umask 077 && mkdir -p '${benchDir}'`, { timeoutMs: 60000 });
	if (runs.some((run) => run.plan.path === "direct" && run.plan.detector !== "palette")) {
		await scp(LAUNCHER, `${host}:${benchDir}/cclay_bench_runner.py`, { timeoutMs: 60000 });
	}
	let failures = 0;
	try {
		for (const run of runs) {
			const label = `${run.motion}/${run.variant}/${run.plan.name}`;
			const previous = readJson(join(run.out, "result.json"));
			if (previous?.ok && !options.force) {
				console.log(`skip ${label} (result.json ok; --force re-runs)`);
				continue;
			}
			console.log(`run  ${label} [${run.plan.path}]`);
			const result = await runOne(run, { host, benchDir, worker, commit });
			if (!result.ok) failures += 1;
			const d = result.detection;
			console.log(`${result.ok ? "ok  " : "FAIL"} ${label} detected ${d.detectedFrames ?? "?"}/${d.totalFrames ?? "?"} (${d.detector ?? "?"})` +
				` extract ${result.timings.extractS ?? "-"} s total ${result.timings.totalS} s` +
				(result.ok ? ` quality ${result.quality.pass ? "pass" : "fail"}` : ` — ${result.error.step}: ${result.error.message}`));
		}
	} finally {
		client?.stop("extract-bench-finished");
		cleanupRemote();
	}
	if (failures) {
		console.error(`extract-bench: ${failures} run(s) failed`);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(`extract-bench: ${err.stack ?? err.message}`);
	process.exit(1);
});
