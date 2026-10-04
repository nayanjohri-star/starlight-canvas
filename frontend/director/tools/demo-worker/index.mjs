#!/usr/bin/env node
/**
 * Outbound-only GPU demo worker.
 *
 * There is deliberately no http/net server in this process. The only network
 * operation is an authenticated fetch made by api-client.mjs.
 */

import { POLICY } from "../../workers/api/src/policy.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "./api-client.mjs";
import { createGenerator } from "./generate.mjs";

export const EMPTY_QUEUE_BACKOFF_MIN_MS = 2000;
export const EMPTY_QUEUE_BACKOFF_MAX_MS = 30_000;
export const BACKOFF_MIN_MS = EMPTY_QUEUE_BACKOFF_MIN_MS;
export const BACKOFF_MAX_MS = EMPTY_QUEUE_BACKOFF_MAX_MS;
export const HEARTBEAT_INTERVAL_MS = POLICY.HEARTBEAT_INTERVAL_MS;
export const JOB_HARD_TIMEOUT_MS = POLICY.JOB_HARD_TIMEOUT_MS;

function defaultLogger() {
	return {
		info: (...args) => console.log(...args),
		warn: (...args) => console.warn(...args),
		error: (...args) => console.error(...args),
	};
}

function wait(ms, signal) {
	if (!(ms > 0)) return Promise.resolve();
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolvePromise) => {
		let timer = setTimeout(done, ms);
		const onAbort = () => done();
		function done() {
			if (!timer) return;
			clearTimeout(timer);
			timer = null;
			signal?.removeEventListener?.("abort", onAbort);
			resolvePromise();
		}
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

function jobIdOf(job) {
	return job?.jobId ?? job?.job_id ?? "";
}

function leaseOf(job) {
	return job?.leaseToken ?? job?.lease_token ?? "";
}

function promptOf(job) {
	return job?.prompt ?? job?.prompt_text ?? "";
}

function durationOf(job) {
	return job?.durationS ?? job?.duration_s ?? job?.duration ?? POLICY.DEMO_DURATION_S;
}

function maskSecrets(value) {
	let text = String(value);
	for (const secret of [process.env.CC_WORKER_SECRET].filter(Boolean)) {
		text = text.replaceAll(String(secret), "[REDACTED]");
	}
	return text;
}

function leaseLost(error) {
	const code = String(error?.code ?? error?.error ?? error?.body?.error ?? "").toLowerCase();
	return code === "lease_lost" || code === "lease-lost" || code === "lease_lost_error";
}

function failDeliveryError(jobId, reason, error) {
	const wrapped = new Error(
		`could not report failed job ${jobId} (${reason}): ${reasonOf(error, "fail_delivery_error")}`,
		{ cause: error },
	);
	wrapped.name = "FailDeliveryError";
	wrapped.code = "FAIL_DELIVERY_FAILED";
	wrapped.jobId = jobId;
	wrapped.reason = reason;
	return wrapped;
}

function reasonOf(error, fallback = "worker_failed") {
	const raw = error?.code || error?.message || fallback;
	// Reasons are operator-visible and can come from a child process. Keep them
	// bounded and strip control characters; never include request headers.
	return maskSecrets(raw).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 500) || fallback;
}

function asBuffer(value) {
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (Buffer.isBuffer(value)) return value;
	throw new TypeError("generator must return an npz byte buffer");
}

function invokeGenerator(generator, job, signal, timeoutMs = JOB_HARD_TIMEOUT_MS) {
	const prompt = promptOf(job);
	const duration = durationOf(job);
	if (typeof generator === "function") {
		return generator(prompt, duration, { signal, job, timeoutMs });
	}
	if (generator && typeof generator.generate === "function") {
		return generator.generate(prompt, duration, { signal, job, timeoutMs });
	}
	throw new TypeError("generate dependency must be a function or { generate() }");
}

function awaitAbortable(value, signal) {
	const promise = Promise.resolve(value);
	if (!signal) return promise;
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("generation aborted"));
	}
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		const finish = (fn, result) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			fn(result);
		};
		const onAbort = () => {
			promise.catch(() => {});
			finish(reject, signal.reason instanceof Error ? signal.reason : new Error("generation aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(result) => finish(resolvePromise, result),
			(error) => finish(reject, error),
		);
	});
}

/**
 * Process one claimed job. The returned state is useful to tests and to the
 * outer loop, while all lease/failure behavior remains in one place.
 */
export async function processJob(job, {
	api,
	generator,
	heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
	logger = defaultLogger(),
	state = {},
	timeoutMs = JOB_HARD_TIMEOUT_MS,
} = {}) {
	const jobId = jobIdOf(job);
	const leaseToken = leaseOf(job);
	if (!jobId || !leaseToken) throw new TypeError("claimed job is missing job_id or lease_token");
	const controller = new AbortController();
	state.job = job;
	state.controller = controller;
	state.leaseLost = null;
	state.failPromise = null;
	state.failSent = false;
	let heartbeatInFlight = null;
	let heartbeatTimer = null;

	const failOnce = (reason) => {
		if (state.failPromise) return state.failPromise;
		state.failSent = true;
		state.failPromise = Promise.resolve()
			.then(() => api.fail(jobId, leaseToken, reason))
			.catch((error) => {
				logger.error(`[demo-worker] fail ${jobId} was not accepted (${reasonOf(error, "fail_error")})`);
				throw error;
			});
		return state.failPromise;
	};
	state.failOnce = failOnce;
	const reportFailure = async (reason) => {
		try {
			await failOnce(reason);
			return { reported: true };
		} catch (error) {
			if (leaseLost(error)) return { leaseLost: true, error };
			throw failDeliveryError(jobId, reason, error);
		}
	};

	const heartbeat = async () => {
		if (state.done || state.leaseLost || state.stopping || heartbeatInFlight) return;
		heartbeatInFlight = Promise.resolve()
			.then(() => api.heartbeat(jobId, leaseToken))
			.catch((error) => {
				if (leaseLost(error)) {
					state.leaseLost = error;
					controller.abort(error);
					logger.warn(`[demo-worker] lease lost for ${jobId}; stopping generation`);
					return;
				}
				logger.warn(`[demo-worker] heartbeat ${jobId} failed (${reasonOf(error, "heartbeat_error")})`);
			})
			.finally(() => {
				heartbeatInFlight = null;
			});
		await heartbeatInFlight;
	};
	if (heartbeatIntervalMs > 0) {
		heartbeatTimer = setIntervalFn(heartbeat, heartbeatIntervalMs);
		heartbeatTimer?.unref?.();
	}

	try {
		const generated = await awaitAbortable(invokeGenerator(generator, job, controller.signal, timeoutMs), controller.signal);
		if (state.leaseLost) throw state.leaseLost;
		if (state.stopping) {
			const reported = await reportFailure("worker_shutdown");
			if (reported.leaseLost) return { status: "lease_lost", jobId, leaseToken, error: reported.error };
			return { status: "stopped", jobId, leaseToken };
		}
		const body = asBuffer(await generated);
		await api.complete(jobId, leaseToken, body);
		state.done = true;
		return { status: "done", jobId, leaseToken, bytes: body.byteLength };
	} catch (error) {
		if (state.leaseLost || leaseLost(error)) {
			return { status: "lease_lost", jobId, leaseToken, error: state.leaseLost || error };
		}
		if (state.stopping) {
			const reported = await reportFailure("worker_shutdown");
			if (reported.leaseLost) return { status: "lease_lost", jobId, leaseToken, error: reported.error };
			return { status: "stopped", jobId, leaseToken, error };
		}
		const reported = await reportFailure(reasonOf(error));
		if (reported.leaseLost) return { status: "lease_lost", jobId, leaseToken, error: reported.error };
		return { status: "failed", jobId, leaseToken, error };
	} finally {
		state.done = true;
		if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
		if (heartbeatInFlight) await heartbeatInFlight.catch(() => {});
		state.controller = null;
	}
}

function resolveGenerator(options) {
	if (options.generate !== undefined) {
		const runnerService = options.runner ? createGenerator({ runner: options.runner, timeoutMs: options.timeoutMs }) : null;
		const functionPrepare = typeof options.generate?.prepare === "function"
			? () => options.generate.prepare()
			: undefined;
		return {
			value: options.generate,
			prepare: options.prepareGenerator || functionPrepare || (runnerService ? () => runnerService.prepare() : undefined),
			invalidate: options.invalidateGenerator || (runnerService ? () => runnerService.invalidateWarm() : undefined),
		};
	}
	if (options.generator !== undefined) {
		return {
			value: options.generator,
			prepare: typeof options.generator?.prepare === "function" ? () => options.generator.prepare() : options.prepareGenerator,
			invalidate: typeof options.generator?.invalidateWarm === "function"
				? () => options.generator.invalidateWarm()
				: options.invalidateGenerator,
		};
	}
	const service = createGenerator({ runner: options.runner, timeoutMs: options.timeoutMs });
	return { value: service, prepare: () => service.prepare(), invalidate: () => service.invalidateWarm() };
}

/**
 * Poll until stopped (or `maxJobs` have completed). Tests can inject sleep,
 * timers, and a shutdown AbortSignal; production uses the policy values above.
 */
export async function runLoop({
	api = null,
	apiClient = null,
	generate,
	generator,
	runner,
	prepareGenerator,
	prewarm = true,
	heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
	pollMinMs = EMPTY_QUEUE_BACKOFF_MIN_MS,
	pollMaxMs = EMPTY_QUEUE_BACKOFF_MAX_MS,
	sleep = wait,
	shutdownSignal = null,
	installSignalHandlers = false,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
	logger = defaultLogger(),
	maxJobs = Infinity,
	timeoutMs = JOB_HARD_TIMEOUT_MS,
	warmupMinMs = pollMinMs,
	warmupMaxMs = pollMaxMs,
} = {}) {
	const client = apiClient || api || createApiClient();
	const resolved = resolveGenerator({ generate, generator, runner, prepareGenerator, timeoutMs });
	const generation = resolved.value;
	const prepare = resolved.prepare;
	const invalidateWarm = resolved.invalidate;
	const shutdown = new AbortController();
	let stopping = false;
	let stopSignal = null;
	let current = null;
	let stopPromise = null;
	let stopError = null;
	let completedJobs = 0;
	let failedJobs = 0;
	let polls = 0;

	const failCurrent = (reason) => {
		if (!current?.job || current.done) return Promise.resolve();
		current.stopping = true;
		current.controller?.abort(new Error(reason));
		if (typeof current.failOnce === "function") {
			return current.failOnce(reason).catch((error) => {
				if (leaseLost(error)) return;
				throw failDeliveryError(jobIdOf(current.job), reason, error);
			});
		}
		return Promise.resolve();
	};

	const requestStop = (signalName = "shutdown") => {
		if (stopPromise) return stopPromise;
		stopping = true;
		stopSignal = signalName;
		shutdown.abort(new Error(signalName));
		stopPromise = failCurrent("worker_shutdown");
		return stopPromise;
	};

	const processSignal = (signalName) => {
		requestStop(signalName).catch((error) => {
			stopError = error;
			logger.error(`[demo-worker] shutdown fail report failed (${reasonOf(error, "fail_delivery_error")})`);
		});
	};
	const onAbort = () => processSignal("shutdown");
	const registered = [];
	let warmupBackoff = Math.max(0, warmupMinMs);
	const prepareBeforeClaim = async () => {
		if (!prewarm || typeof prepare !== "function") return true;
		// This check intentionally sits immediately before next(). The
		// generator service caches a successful local warm-up until its idle
		// window expires, so polling does not reset the runner's idle timer;
		// once it has cooled, prepare() blocks here and no lease is claimed
		// until the worker is accepting generation work again.
		for (;;) {
			if (stopping || shutdown.signal.aborted) return false;
			try {
				const readiness = await prepare();
				if (readiness === false || readiness?.ready === false || readiness?.ok === false) {
					throw new Error(readiness?.reason || "runner warm-up did not report ready");
				}
				warmupBackoff = Math.max(0, warmupMinMs);
				return true;
			} catch (error) {
				if (stopping || shutdown.signal.aborted) return false;
				logger.warn(`[demo-worker] runner is not warm (${reasonOf(error, "runner_unavailable")}); waiting before polling`);
				await sleep(warmupBackoff, shutdown.signal);
				warmupBackoff = Math.min(
					Math.max(warmupBackoff * 2, warmupMinMs),
					Math.max(warmupMaxMs, warmupMinMs),
				);
			}
		}
	};
	if (shutdownSignal) {
		if (shutdownSignal.aborted) processSignal("shutdown");
		else {
			shutdownSignal.addEventListener("abort", onAbort, { once: true });
			registered.push(() => shutdownSignal.removeEventListener("abort", onAbort));
		}
	}
	if (installSignalHandlers) {
		for (const signalName of ["SIGINT", "SIGTERM"]) {
			const handler = () => processSignal(signalName);
			process.on(signalName, handler);
			registered.push(() => process.off(signalName, handler));
		}
	}

	try {
		let backoff = Math.max(0, pollMinMs);
		while (!stopping && completedJobs < maxJobs) {
			if (!(await prepareBeforeClaim())) break;
			polls += 1;
			let job;
			try {
				job = await client.next();
			} catch (error) {
				if (stopping || shutdown.signal.aborted) break;
				logger.warn(`[demo-worker] next failed (${reasonOf(error, "poll_error")}); retrying`);
				await sleep(backoff, shutdown.signal);
				backoff = Math.min(Math.max(backoff * 2, pollMinMs), pollMaxMs);
				continue;
			}
			if (stopping) break;
			if (!job) {
				await sleep(backoff, shutdown.signal);
				backoff = Math.min(Math.max(backoff * 2, pollMinMs), pollMaxMs);
				continue;
			}
			backoff = Math.max(0, pollMinMs);
			const state = { job };
			current = state;
			let result;
			try {
				result = await processJob(job, {
					api: client,
					generator: generation,
					heartbeatIntervalMs,
					setIntervalFn,
					clearIntervalFn,
					logger,
					state,
					timeoutMs,
				});
			} catch (error) {
				// A non-lease fail-report error means the API transition is
				// unknown. Do not claim another job; the top-level supervisor
				// restarts this non-zero process and retries with the same queue
				// state instead.
				throw error;
			}
			current = null;
			if (result.status !== "done") invalidateWarm?.();
			if (result.status === "done") completedJobs += 1;
			if (result.status === "failed") failedJobs += 1;
			if (stopping) break;
		}
	} finally {
		if (stopping && current) await failCurrent("worker_shutdown");
		for (const remove of registered) remove();
	}
	if (stopError) throw stopError;
	return {
		completedJobs,
		failedJobs,
		polls,
		stopped: stopping,
		signal: stopSignal,
	};
}

export async function main(options = {}) {
	return runLoop({ ...options, installSignalHandlers: options.installSignalHandlers ?? true });
}

export const run = runLoop;
export default main;

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile && invokedFile === thisFile) {
	main()
		.then((result) => {
			if (result.signal === "SIGINT") process.exitCode = 130;
			if (result.signal === "SIGTERM") process.exitCode = 143;
		})
		.catch((error) => {
			console.error(`[demo-worker] ${reasonOf(error, "worker_start_failed")}`);
			process.exitCode = 1;
		});
}

