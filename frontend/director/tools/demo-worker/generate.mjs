/**
 * Generate one demo result with the existing local ARDY runner.
 *
 * This module owns the child process boundary. The poller never shells out
 * directly: createLocalRunner() builds the same argv/env contract used by the
 * bridge, and this file only supervises that command, reads its npz, and
 * enforces the absolute hard timeout.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createLocalRunner } from "../ardy/runners/local.mjs";
import { killGroup, track } from "../ardy/runners/proc.mjs";
import { POLICY } from "../../workers/api/src/policy.js";

export const JOB_HARD_TIMEOUT_MS = POLICY.JOB_HARD_TIMEOUT_MS;
const DEFAULT_TIMEOUT_ENV = ["CC_JOB_HARD_TIMEOUT_MS", "JOB_HARD_TIMEOUT_MS"];
let sharedRunner = null;

function defaultRunner() {
	if (!sharedRunner) sharedRunner = createLocalRunner();
	return sharedRunner;
}

function localWorkerReady(timeoutMs = 3000) {
	const port = Number(process.env.CCLAY_ARDY_WORKER_PORT) || 9552;
	return new Promise((resolvePromise) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const finish = (ready) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolvePromise(ready);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
		socket.once("connect", () => socket.write('{"mode":"ping"}\n'));
		socket.on("data", (chunk) => {
			if (String(chunk).includes("worker: pong")) finish(true);
		});
	});
}

function configuredTimeout(value) {
	if (value != null) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
	}
	for (const name of DEFAULT_TIMEOUT_ENV) {
		const numeric = Number(process.env[name]);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
	}
	return JOB_HARD_TIMEOUT_MS;
}

function abortError(signal) {
	const error = signal?.reason instanceof Error ? signal.reason : new Error("generation aborted");
	if (!signal?.reason || error.name === "Error") error.name = "AbortError";
	return error;
}

function commandError(command, code, stderr, stdout) {
	const detail = String(stderr || stdout || "no output").trim().split("\n").slice(-1)[0];
	const error = new Error(`${command?.label || "ARDY"} failed (exit ${code}): ${detail}`);
	error.code = "GENERATION_FAILED";
	return error;
}

function outputMarker(command, stdout) {
	if (!command?.doneRe) return null;
	const lines = String(stdout || "").split(/\r?\n/u);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = command.doneRe.exec(lines[index]);
		if (match) return { path: match[1], bytes: Number(match[2]) };
	}
	return null;
}

function spawnCommand(command, spawnImpl = spawn) {
	const child = spawnImpl(command.command, command.args || [], {
		cwd: command.cwd || process.cwd(),
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: command.env,
	});
	track(child);
	return child;
}

function waitForChild(child) {
	return new Promise((resolvePromise, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		child.stdout?.setEncoding?.("utf8");
		child.stderr?.setEncoding?.("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => finish(reject, error));
		child.once("close", (code, signal) => finish(resolvePromise, { code, signal, stdout, stderr }));
	});
}

/**
 * Supervise a runner command and return its output as a Buffer.
 *
 * `runner` is injectable so loop tests can use a tiny fixture command without
 * installing ARDY. Production callers leave it unset and get
 * createLocalRunner().
 */
export async function generate(prompt, durationS, options = {}) {
	// Accept both generate(prompt, duration, options) and generate({prompt,
	// duration}, options). The latter is convenient for queue adapters and does
	// not change the public positional contract.
	if (prompt && typeof prompt === "object") {
		const job = prompt;
		const suppliedOptions = durationS && typeof durationS === "object" ? durationS : {};
		prompt = job.prompt ?? job.prompt_text;
		durationS = job.durationS ?? job.duration_s ?? job.duration;
		options = { ...suppliedOptions, ...(options && typeof options === "object" ? options : {}) };
	}
	const {
		runner = null,
		timeoutMs,
		signal,
		outputPath = null,
		tempRoot = tmpdir(),
		spawnImpl = spawn,
		keepOutput = false,
	} = options || {};
	if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("prompt is required");
	if (!Number.isFinite(Number(durationS)) || Number(durationS) <= 0) throw new TypeError("duration must be positive");
	if (signal?.aborted) throw abortError(signal);

	const backend = runner || defaultRunner();
	let tempDir = null;
	let output = outputPath;
	if (!output) {
		tempDir = mkdtempSync(join(tempRoot, "cozyclay-demo-worker-"));
		output = join(tempDir, "result.npz");
	}

	let child = null;
	let timer = null;
	let timedOut = false;
	let aborted = false;
	const timeout = configuredTimeout(timeoutMs);
	const abortHandler = () => {
		aborted = true;
		if (child) killGroup(child);
	};
	signal?.addEventListener?.("abort", abortHandler, { once: true });
	try {
		if (typeof backend.singleCommand !== "function") {
			throw new TypeError("local runner does not provide singleCommand()");
		}
		const command = await backend.singleCommand({
			poseFroms: [],
			prompt,
			durationS: Number(durationS),
			output,
		});
		if (!command || typeof command.command !== "string") throw new TypeError("runner returned an invalid command");
		if (aborted || signal?.aborted) throw abortError(signal);
		child = spawnCommand(command, spawnImpl);
		const childDone = waitForChild(child);
		timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeout);
		timer.unref?.();
		const result = await childDone;
		if (timedOut) {
			const error = new Error(`generation exceeded JOB_HARD_TIMEOUT_MS (${timeout} ms)`);
			error.name = "TimeoutError";
			error.code = "JOB_HARD_TIMEOUT";
			throw error;
		}
		if (aborted || signal?.aborted) throw abortError(signal);
		if (result.code !== 0) throw commandError(command, result.code, result.stderr, result.stdout);
		let size;
		try {
			size = statSync(output).size;
		} catch {
			throw new Error("generator exited successfully but produced no npz output");
		}
		if (!Number.isSafeInteger(size) || size <= 0) throw new Error("generator produced an empty npz output");
		const marker = outputMarker(command, result.stdout);
		if (marker && (marker.path !== output || marker.bytes !== size)) {
			throw new Error(`generator output marker mismatch for ${output}`);
		}
		return readFileSync(output);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener?.("abort", abortHandler);
		if (tempDir && !keepOutput) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// A failed cleanup must not mask generation/lease errors.
			}
		}
	}
}

/**
 * Return a service object for index.mjs. `prepare()` is intentionally
 * idempotent for injected runners and, for createLocalRunner(), waits for the
 * actual generation worker rather than merely probing device/encoder health.
 */
export function createGenerator({ runner = null, workerReady = localWorkerReady, ...defaults } = {}) {
	const backend = runner || defaultRunner();
	const workerIdleMs = Number(process.env.CCLAY_ARDY_WORKER_IDLE_S) > 0
		? Number(process.env.CCLAY_ARDY_WORKER_IDLE_S) * 1000
		: 3600 * 1000;
	let warmedAt = 0;
	let warming = null;
	const warmWithCommand = async () => {
		const warmDir = mkdtempSync(join(tmpdir(), "cozyclay-demo-prewarm-"));
		try {
			const command = await backend.singleCommand({
				poseFroms: [],
				prompt: "cozyclay demo worker prewarm",
				durationS: 0.2,
				output: join(warmDir, "discarded.npz"),
			});
			if (!command) throw new Error("local runner did not return a warm command");
			if (backend.mode === "local" && typeof backend.probeHealth === "function" && !(await workerReady())) {
				throw new Error("local generation worker did not become warm");
			}
			warmedAt = Date.now();
			return { ok: true, warm: true };
		} finally {
			try {
				rmSync(warmDir, { recursive: true, force: true });
			} catch {
				// A failed cleanup must not turn a warm worker into a false
				// negative.
			}
		}
	};
	return {
		runner: backend,
		async prepare({ force = false } = {}) {
			if (typeof backend.prepare === "function") return backend.prepare();
			if (typeof backend.prewarm === "function") return backend.prewarm();
			if (typeof backend.ensureWorker === "function") return backend.ensureWorker();
			// createLocalRunner() intentionally keeps its warm-worker helper
			// private. Calling singleCommand() with a throwaway output path
			// exercises that same ensureBackends(false) path and, crucially,
			// does not spawn a generation child. Its promise resolves only after
			// workerStatus() confirms the loopback worker is accepting work.
			if (typeof backend.singleCommand === "function") {
				if (!force && warmedAt && Date.now() - warmedAt < workerIdleMs) {
					if (backend.mode !== "local" || await workerReady()) {
						return { ok: true, warm: true, cached: true };
					}
					warmedAt = 0;
				}
				if (!warming) {
					warming = warmWithCommand()
						.catch((error) => {
							warmedAt = 0;
							throw error;
						})
						.finally(() => {
							warming = null;
						});
				}
				return warming;
			}
			return {
				ok: false,
				ready: false,
				reason: "warm_worker_unconfirmed: runner exposes no awaitable warm-worker hook",
			};
		},
		invalidateWarm() {
			warmedAt = 0;
		},
		generate(prompt, durationS, options = {}) {
			return generate(prompt, durationS, { ...defaults, ...options, runner: backend });
		},
	};
}

export const generateJob = generate;
export default generate;

