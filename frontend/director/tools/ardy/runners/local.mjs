/**
 * Local runner for the ARDY bridge: generation on THIS machine.
 *
 * Same small interface as runners/remote.mjs, no ssh anywhere. The heavy
 * pieces live in a per-user directory (nothing model-shaped is ever inside
 * the CozyClay repo):
 *
 *   ~/.cozyclay/ardy            ARDY checkout + .venv (torch, ardy, gradio)
 *   ~/.cozyclay/text-encoders   LLM2Vec / Llama-3-8B encoder weights
 *   (HF cache)                  ARDY motion checkpoints, auto-downloaded by
 *                               huggingface_hub on first use
 *
 * `node tools/ardy/setup-local.mjs` provisions all of it; this runner only
 * checks and reports. Generation children are spawned through
 * tools/ardy/run-local.mjs, which mirrors the run-*-on-box.sh contract
 * (same modes, same "<label>: done - <path> (<bytes> bytes)" marker) minus
 * the push/pull dance.
 *
 * The text encoder (Llama-3-8B, ~16 GB resident) is the one piece too heavy
 * to keep alive unconditionally, so it is a lazy sidecar: started on the
 * first generation that needs it, reused while warm, and shut down after an
 * idle window to give the RAM back. ARDY's own TEXT_ENCODER_MODE=auto makes
 * a dead encoder a graceful state (in-process fallback), never a crash.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { killGroup, lastLine, run, track } from "./proc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_ARDY = join(HERE, "..");
const RUN_LOCAL = join(TOOLS_ARDY, "run-local.mjs");
const SETUP_HINT = "run `node tools/ardy/setup-local.mjs` once to install ARDY locally";

// cuda > mps > cpu, the same order cclay_pick_device() uses in the python
// generators, so what health reports is what generation will use.
const DEVICE_PROBE = [
	"import os, torch",
	'forced = os.environ.get("CCLAY_ARDY_DEVICE", "").strip().lower()',
	"mps = getattr(torch.backends, 'mps', None)",
	'print(forced or ("cuda:0" if torch.cuda.is_available() else ("mps" if mps is not None and mps.is_available() else "cpu")))',
].join("\n");

const ENCODER_START_TIMEOUT_MS = 10 * 60_000; // first start reads ~16 GB of weights from disk
const ENCODER_POLL_MS = 2000;
const ENCODER_IDLE_DEFAULT_S = 900; // give the RAM back after 15 quiet minutes

const WORKER_START_TIMEOUT_MS = 15 * 60_000; // model load + first-ever kernel compile
const WORKER_POLL_MS = 2000;
const WORKER_IDLE_DEFAULT_S = 3600; // the motion model is small; keep it warm longer

export function createLocalRunner() {
	const LOCAL_DIR = process.env.CCLAY_ARDY_LOCAL_DIR || join(homedir(), ".cozyclay", "ardy");
	const VENV_PY =
		process.env.CCLAY_ARDY_LOCAL_VENV ||
		join(LOCAL_DIR, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
	const ENCODERS_DIR = process.env.CCLAY_ARDY_ENCODERS_DIR || join(homedir(), ".cozyclay", "text-encoders");
	const ENCODER_URL = process.env.CCLAY_ARDY_ENCODER_URL || "http://127.0.0.1:9550/";
	const ENCODER_DEVICE = (process.env.CCLAY_ARDY_ENCODER_DEVICE || "").trim();
	const ENCODER_IDLE_S = Number(process.env.CCLAY_ARDY_ENCODER_IDLE_S) > 0
		? Number(process.env.CCLAY_ARDY_ENCODER_IDLE_S)
		: ENCODER_IDLE_DEFAULT_S;

	// Environment every local child (probe, encoder, generator) runs under.
	// TEXT_ENCODER_URL/TEXT_ENCODERS_DIR are ARDY's own env contract;
	// PYTORCH_ENABLE_MPS_FALLBACK lets the odd unsupported op fall back to CPU
	// instead of aborting an entire generation on Apple GPUs.
	function localEnv(extra = {}) {
		return {
			...process.env,
			CCLAY_ARDY_LOCAL_DIR: LOCAL_DIR,
			CCLAY_ARDY_LOCAL_VENV: VENV_PY,
			CCLAY_ARDY_ENCODER_URL: ENCODER_URL,
			TEXT_ENCODER_URL: ENCODER_URL,
			TEXT_ENCODERS_DIR: ENCODERS_DIR,
			PYTORCH_ENABLE_MPS_FALLBACK: "1",
			...extra,
		};
	}

	function requireSetup() {
		if (!existsSync(LOCAL_DIR)) {
			throw new Error(`local ARDY checkout not found at ${LOCAL_DIR}; ${SETUP_HINT}`);
		}
		if (!existsSync(VENV_PY)) {
			throw new Error(`local ARDY venv python not found at ${VENV_PY}; ${SETUP_HINT}`);
		}
	}

	// The device cannot change mid-session, and the probe costs a full torch
	// import (~seconds), so the first successful answer is kept for the
	// bridge's lifetime instead of re-spawning python on every health poll.
	let deviceCache = null;

	async function probeDevice() {
		if (deviceCache) return deviceCache;
		const { code, stdout, stderr } = await run([VENV_PY, "-c", DEVICE_PROBE], { timeoutMs: 60_000 });
		if (code !== 0) {
			throw new Error(`local device probe failed (exit ${code}): ${lastLine(stderr)}`);
		}
		const device = stdout.trim();
		if (!/^(cpu|mps|cuda:\d+)$/.test(device)) {
			throw new Error(`local device probe returned unexpected ${JSON.stringify(device)}`);
		}
		deviceCache = device;
		return device;
	}

	async function encoderStatus() {
		try {
			const res = await fetch(ENCODER_URL, { signal: AbortSignal.timeout(5000) });
			return res.status;
		} catch {
			return 0;
		}
	}

	async function probeHealth() {
		requireSetup();
		const [device, encoder] = await Promise.all([probeDevice(), encoderStatus()]);
		// A down encoder is a normal state here (it lazy-starts on the first
		// generation), so health stays ok and the field says so instead of
		// blocking the generate affordance the way a dead box would.
		return { ok: true, host: "local", encoder: encoder === 200 ? 200 : "on-demand", device };
	}

	// Frame counts come from a real numpy load of each npz, one python child
	// for the whole listing; entries that fail to load are skipped with a note
	// on stderr, and paths are reported repo-relative (outputs/...) so the
	// bridge-side SAFE_BASE_PATH whitelist applies unchanged.
	const BASES_SCRIPT = [
		"import glob, json, os, sys",
		"import numpy as np",
		"root = sys.argv[1]",
		"entries = []",
		'for pattern in ("outputs/*.npz", "outputs/omb/*.npz"):',
		"    for path in sorted(glob.glob(os.path.join(root, pattern))):",
		"        try:",
		"            data = np.load(path, allow_pickle=False)",
		'            frames = int(data["posed_joints"].shape[0])',
		"            data.close()",
		"        except Exception as exc:",
		'            print("bases: skipping %s: %s" % (path, exc), file=sys.stderr)',
		"            continue",
		"        rel = os.path.relpath(path, root).replace(os.sep, '/')",
		'        entries.append({"id": os.path.basename(path)[:-4], "path": rel, "frames": frames})',
		"print(json.dumps(entries))",
	].join("\n");

	async function listBases() {
		requireSetup();
		const { code, stdout, stderr } = await run([VENV_PY, "-c", BASES_SCRIPT, LOCAL_DIR], { timeoutMs: 120_000 });
		if (code !== 0) {
			throw new Error(`local bases listing failed (exit ${code}): ${lastLine(stderr)}`);
		}
		let entries;
		try {
			entries = JSON.parse(stdout);
		} catch (err) {
			throw new Error(`local bases listing did not parse as JSON: ${lastLine(stderr) || err.message}`);
		}
		if (!Array.isArray(entries)) {
			throw new Error("local bases listing was not an array");
		}
		return entries;
	}

	// --- lazy text-encoder sidecar -----------------------------------------

	let encoderChild = null;
	let encoderStarting = null;
	let encoderIdleTimer = null;

	function armIdleShutdown() {
		if (encoderIdleTimer) clearTimeout(encoderIdleTimer);
		encoderIdleTimer = setTimeout(() => {
			if (encoderChild) {
				console.log(`[bridge] text encoder idle for ${ENCODER_IDLE_S}s; shutting it down to free RAM`);
				killGroup(encoderChild);
				encoderChild = null;
			}
		}, ENCODER_IDLE_S * 1000);
		encoderIdleTimer.unref();
	}

	async function startEncoder() {
		const device = ENCODER_DEVICE || (await probeDevice().catch(() => "cpu"));
		// Strip the cuda ordinal notation the generator uses; the server takes
		// plain "cuda"/"cuda:N"/"mps"/"cpu" so cuda:0 passes through unchanged.
		console.log(`[bridge] starting local text encoder on ${device} (first answer may take minutes while ~16 GB of weights load)`);
		const child = spawn(
			VENV_PY,
			[
				"-u", join(LOCAL_DIR, "scripts", "run_text_encoder_server.py"),
				"--host", "127.0.0.1",
				"--port", String(new URL(ENCODER_URL).port || 9550),
				"--device", device,
				// The server's default /tmp/text_encoder/ is NOT the system temp
				// dir on macOS (/var/folders/...), and gradio refuses to serve
				// files from outside cwd/tempdir — so put the scratch npy files
				// where gradio provably allows them.
				"--tmp-folder", join(tmpdir(), "cozyclay-text-encoder"),
			],
			{
				cwd: LOCAL_DIR, // the server imports its sibling get_gradio_theme.py
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: localEnv({ GRADIO_ANALYTICS_ENABLED: "False" }),
			}
		);
		track(child);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => process.stdout.write(`[encoder] ${chunk}`));
		child.stderr.on("data", (chunk) => process.stderr.write(`[encoder] ${chunk}`));
		child.once("close", (code) => {
			if (encoderChild === child) encoderChild = null;
			if (code !== 0 && code !== null) console.error(`[bridge] text encoder exited with code ${code}`);
		});
		encoderChild = child;

		const deadline = Date.now() + ENCODER_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (encoderChild !== child) throw new Error("text encoder process exited while starting");
			if ((await encoderStatus()) === 200) return;
			await new Promise((resolveSleep) => setTimeout(resolveSleep, ENCODER_POLL_MS));
		}
		killGroup(child);
		throw new Error(`text encoder did not answer on ${ENCODER_URL} within ${ENCODER_START_TIMEOUT_MS / 60000} minutes`);
	}

	// Resolves when the encoder answers 200. Reuses a warm encoder (its idle
	// timer is re-armed), joins an in-flight start, or starts a fresh one.
	async function ensureEncoder() {
		if ((await encoderStatus()) === 200) {
			armIdleShutdown();
			return;
		}
		if (!encoderStarting) {
			encoderStarting = startEncoder().finally(() => {
				encoderStarting = null;
			});
		}
		await encoderStarting;
		armIdleShutdown();
	}

	// --- persistent generation worker ---------------------------------------
	// Loading the motion model + compiling GPU kernels costs minutes on MPS;
	// sampling costs seconds. The worker (tools/ardy/cclay_worker.py) pays the
	// load once and serves jobs warm. run-local.mjs falls back to a direct
	// spawn whenever the worker is missing, so this is purely an accelerator.

	const WORKER_PORT = Number(process.env.CCLAY_ARDY_WORKER_PORT) || 9552;
	const WORKER_IDLE_S = Number(process.env.CCLAY_ARDY_WORKER_IDLE_S) > 0
		? Number(process.env.CCLAY_ARDY_WORKER_IDLE_S)
		: WORKER_IDLE_DEFAULT_S;

	let workerChild = null;
	let workerStarting = null;
	let workerIdleTimer = null;

	function workerStatus() {
		return new Promise((resolvePromise) => {
			const sock = createConnection({ host: "127.0.0.1", port: WORKER_PORT });
			let settled = false;
			const finish = (ok) => {
				if (!settled) {
					settled = true;
					sock.destroy();
					resolvePromise(ok);
				}
			};
			sock.setTimeout(3000, () => finish(false));
			sock.on("error", () => finish(false));
			sock.on("close", () => finish(false));
			sock.on("connect", () => sock.write('{"mode":"ping"}\n'));
			sock.on("data", (chunk) => finish(String(chunk).includes("worker: pong")));
		});
	}

	function armWorkerIdleShutdown() {
		if (workerIdleTimer) clearTimeout(workerIdleTimer);
		workerIdleTimer = setTimeout(() => {
			if (workerChild) {
				console.log(`[bridge] generation worker idle for ${WORKER_IDLE_S}s; shutting it down`);
				killGroup(workerChild);
				workerChild = null;
			}
		}, WORKER_IDLE_S * 1000);
		workerIdleTimer.unref();
	}

	async function startWorker() {
		console.log("[bridge] starting generation worker (loads the motion model once; later requests reuse it warm)");
		const device = ENCODER_DEVICE || (await probeDevice().catch(() => "cpu"));
		const child = spawn(
			VENV_PY,
			["-u", join(TOOLS_ARDY, "cclay_worker.py")],
			{
				cwd: LOCAL_DIR,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				// With no encoder service running, ARDY's auto mode loads the
				// text encoder IN-PROCESS inside the worker — one warm process
				// serving both models, no HTTP hop. TEXT_ENCODER_DEVICE keeps
				// that in-process Llama off the CPU default.
				env: localEnv({
					CCLAY_ARDY_WORKER_PORT: String(WORKER_PORT),
					TEXT_ENCODER_DEVICE: device,
				}),
			}
		);
		track(child);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => process.stdout.write(`[worker] ${chunk}`));
		child.stderr.on("data", (chunk) => process.stderr.write(`[worker] ${chunk}`));
		child.once("close", (code) => {
			if (workerChild === child) workerChild = null;
			if (code !== 0 && code !== null) console.error(`[bridge] generation worker exited with code ${code}`);
		});
		workerChild = child;

		const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (workerChild !== child) throw new Error("generation worker exited while starting");
			if (await workerStatus()) return;
			await new Promise((resolveSleep) => setTimeout(resolveSleep, WORKER_POLL_MS));
		}
		killGroup(child);
		throw new Error(`generation worker did not answer on port ${WORKER_PORT} within ${WORKER_START_TIMEOUT_MS / 60000} minutes`);
	}

	// Best-effort: a broken worker must never block generation, because
	// run-local.mjs degrades to a direct spawn on its own.
	async function ensureWorker() {
		if (await workerStatus()) {
			armWorkerIdleShutdown();
			return;
		}
		if (!workerStarting) {
			workerStarting = startWorker().finally(() => {
				workerStarting = null;
			});
		}
		try {
			await workerStarting;
			armWorkerIdleShutdown();
		} catch (err) {
			console.error(`[bridge] generation worker unavailable, jobs will cold-spawn: ${err.message}`);
		}
	}

	// Prewarm in the background at startup so even the FIRST generation of a
	// session usually hits a warm model. Opt out with CCLAY_ARDY_PREWARM=0.
	if (process.env.CCLAY_ARDY_PREWARM !== "0" && existsSync(VENV_PY)) {
		ensureWorker();
	}

	// --- generation argv builders ------------------------------------------
	// All three spawn run-local.mjs, whose stdout ends in
	// "run-local: done - <path> (<bytes> bytes)" on success. The encoder is
	// made ready first so the generator's TEXT_ENCODER_MODE=auto probe finds
	// the warm service instead of cold-loading Llama in-process per request;
	// the worker is made ready so the job skips the per-process model load.

	function generatorEnv(cpu) {
		return localEnv(cpu === true ? { CCLAY_ARDY_DEVICE: "cpu" } : {});
	}

	const DONE_RE = /^run-local: done - (.+) \((\d+) bytes\)$/;

	// The worker carries its own in-process text encoder, so the separate
	// gradio encoder service is only needed for jobs that bypass the worker
	// (forced-CPU debugging, or the worker failing to start). Starting both
	// would put two 16 GB Llama copies in memory on a 24 GB machine.
	async function ensureBackends(cpu) {
		if (cpu === true) {
			await ensureEncoder();
			return;
		}
		await ensureWorker();
		if (await workerStatus()) return;
		await ensureEncoder();
	}

	async function singleCommand({ poseFroms, prompt, durationS, seed, cpu, waypoints, output }) {
		requireSetup();
		await ensureBackends(cpu);
		const args = [RUN_LOCAL, "single"];
		for (const entry of poseFroms) {
			args.push("--pose-from", entry.npz, String(entry.srcFrame), String(entry.dstFrame));
		}
		args.push("--prompt", prompt, "--duration", String(durationS));
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		for (const wp of waypoints || []) {
			args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
		}
		args.push("--output", output);
		return { command: process.execPath, args, env: generatorEnv(cpu), doneRe: DONE_RE, label: "run-local" };
	}

	async function sequenceCommand({ segments, waypoints, seed, cpu, rootMargin, contactThreshold, historyFrames, output }) {
		requireSetup();
		await ensureBackends(cpu);
		const args = [RUN_LOCAL, "sequence"];
		for (const segment of segments) {
			args.push("--segment", segment.prompt, String(segment.durationS));
		}
		for (const wp of waypoints || []) {
			args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
		}
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		if (Number.isFinite(rootMargin)) args.push("--root-margin", String(rootMargin));
		if (Number.isFinite(contactThreshold)) args.push("--contact-threshold", String(contactThreshold));
		if (Number.isInteger(historyFrames)) args.push("--history_frames", String(historyFrames));
		args.push("--output", output);
		return { command: process.execPath, args, env: generatorEnv(cpu), doneRe: DONE_RE, label: "run-local" };
	}

	async function editCommand({ source, manifest, prompt, contextBefore, contextAfter, seed, poseNpzPaths, output }) {
		requireSetup();
		await ensureBackends(false);
		const args = [
			RUN_LOCAL, "edit",
			"--source", source,
			"--manifest", manifest,
			"--prompt", prompt,
			"--context-before", String(contextBefore),
			"--context-after", String(contextAfter),
			"--output", output,
		];
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		// The manifest references its poses as sibling pose-<i>.npz files, so
		// run-local.mjs stages manifest + poses together in one temp dir (the
		// local twin of run-edit-on-box.sh's scp layout).
		for (const posePath of poseNpzPaths) args.push("--pose", posePath);
		return { command: process.execPath, args, env: generatorEnv(false), doneRe: DONE_RE, label: "run-local" };
	}

	return {
		mode: "local",
		describe: () => `local ARDY at ${LOCAL_DIR} (venv ${VENV_PY}, encoder ${ENCODER_URL} lazy, weights ${ENCODERS_DIR})`,
		probeHealth,
		listBases,
		singleCommand,
		sequenceCommand,
		editCommand,
	};
}
