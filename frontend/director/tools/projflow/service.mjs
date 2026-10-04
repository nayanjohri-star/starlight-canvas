/**
 * service.mjs — the resident (warm) ProjFlow child, contract C11.
 *
 * WHY THIS EXISTS. Gate GP3 measured a line edit at 7.6-8.6 s wall, of which
 * 3.9 s is loading the same 625 MB checkpoint the previous edit already loaded
 * and 1.3 s is the actual sample. The detail loop ("drag, look, drag again") is
 * ProjFlow's job now, so the load has to be paid once per SESSION rather than
 * once per drag. That is the entire idea: one `ssh <host> python driver.py
 * --serve` child, owned by this module, fed one NDJSON request per line.
 *
 * WHAT THIS MODULE IS NOT. It is not a scheduler, not a pool and not a server.
 * There is no port, no tunnel and nothing listening on the box — the transport
 * is the ssh child's own stdin/stdout, which means the resident inherits ssh's
 * authentication and dies with the pipe. One child, one request in flight, a
 * queue for the rest.
 *
 * THE COLD PATH IS THE CONTRACT OF RECORD. Every failure here — a dead child, a
 * response whose id does not match the request, a timeout, a driver error
 * envelope — turns into a `ResidentError`, and generate.mjs answers a
 * ResidentError by running the cold spawn path it always had. So the worst a
 * broken resident can do is make an edit as slow as it is today. That is why
 * the failure paths below are aggressive rather than forgiving: there is no
 * situation in which retrying inside the warm path beats falling back.
 *
 * TWO KINDS OF FAILURE, DELIBERATELY TREATED DIFFERENTLY:
 *
 *   TRANSPORT failures (child died, id mismatch, unsolicited line, timeout)
 *     mean the stream can no longer be trusted to pair responses with
 *     requests. The child is killed and restarted with backoff.
 *   ENVELOPE failures ({"ok": false} — a bad track, a frame range past the end
 *     of the source) mean the driver understood us perfectly and refused. The
 *     child is HEALTHY and stays up; the caller still falls back cold, where
 *     the same request produces the same named error from the path the
 *     contract is written against.
 *
 * RESTART POLICY. 1 s, 5 s, 25 s, capped, and only while a session looks
 * recoverable: after MAX_CONSECUTIVE_FAILURES the background loop gives up and
 * the service goes idle, so a box that is simply gone does not leave a retry
 * loop spawning ssh forever. The next edit starts it again on demand, which is
 * the right trigger — someone is at the keyboard.
 *
 * ENV
 *   CCLAY_PROJFLOW_RESIDENT=0        disable the resident entirely (cold only)
 *   CCLAY_PROJFLOW_RESIDENT_READY_MS how long to wait for the model load
 *   CCLAY_PROJFLOW_RESIDENT_REQ_MS   per-request ceiling on the warm path
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "driver.py");

/** The same ssh options generate.mjs uses for the cold path, plus the keepalive
 * that matters more here: this child is expected to sit idle between edits. */
const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=6",
];

/** Bumped in lockstep with driver.py's PROTOCOL_VERSION. A resident left over
 * from an earlier build answers with the old number and is refused rather than
 * trusted, which is the whole reason the field exists.
 *
 * NOT bumped for `seamPin` (2026-08-29), and the reason is worth stating because
 * it looks like an omission. The version guards FRAMING and field MEANING: an
 * old resident handed the new field ignores it, a new resident handed a request
 * without it applies its own default, and in both directions every existing
 * field still means exactly what it meant. Bumping would have been the safer
 * instinct and was measurably wrong — a long-lived wrapper process holds this
 * constant in memory while it re-ships driver.py from DISK on every resident
 * start, so a bump makes the freshly shipped driver announce a number its own
 * launcher refuses, and the supervisor crash-loops the box until the wrapper
 * itself is restarted. Bump this only when a stale resident would produce a
 * WRONG answer rather than an older one, and expect to restart every wrapper. */
export const PROTOCOL_VERSION = 1;

/** 1 s, 5 s, 25 s, then 25 s forever. Short enough that a transient ssh blip
 * costs one cold edit, long enough that a box being rebooted is not hammered. */
export const BACKOFF_MS = Object.freeze([1_000, 5_000, 25_000]);
export const MAX_CONSECUTIVE_FAILURES = 6;

/** scp + ssh + a 3.9 s model load, with room for a cold page cache. */
const DEFAULT_READY_MS = 45_000;
/** A 100-step edit samples in ~1.3 s; the ceiling exists to bound a hung child,
 * not to be a realistic budget. */
const DEFAULT_REQUEST_MS = 120_000;
const PING_MS = 10_000;

/**
 * A failure that means "use the cold path".
 *
 * `kind` is the only field callers branch on and it exists for one decision:
 * whether the child is still trustworthy. `transport` kills and restarts it;
 * `envelope` and `disabled` leave it alone.
 */
export class ResidentError extends Error {
	constructor(message, { kind = "transport", cause } = {}) {
		super(message);
		this.name = "ResidentError";
		this.kind = kind;
		if (cause !== undefined) this.cause = cause;
	}
}

/** How long to wait before the Nth consecutive restart (N counted from 1).
 * `schedule` exists so a service and this function cannot end up with two
 * spellings of the same clamp; only tests ever pass one. */
export function backoffDelay(failures, schedule = BACKOFF_MS) {
	const index = Math.max(0, Math.floor(failures) - 1);
	return schedule[Math.min(index, schedule.length - 1)];
}

/** The resident is opt-OUT: it is the fast path and the cold path is always
 * underneath it, so the default is on and the env var is an escape hatch for
 * bisecting a bad session. */
export function residentEnabled(env = process.env) {
	const value = env.CCLAY_PROJFLOW_RESIDENT;
	return !(value === "0" || value === "false" || value === "off");
}

function positiveInt(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/* ------------------------------------------------------------------------- */
/* the transport                                                              */
/* ------------------------------------------------------------------------- */

function runOnce(argv, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * Ship the CURRENT driver.py and start it in serve mode.
 *
 * The deploy is the cold path's mechanism, unchanged: scp the file that is in
 * the tree right now, to a path this process generated. Nothing is installed on
 * the box and nothing survives the session — the remote copy is removed when the
 * service stops, and if the local process dies without stopping cleanly, a
 * single file in /tmp is the whole residue.
 *
 * `env HOME=... exec python` rather than a bare assignment: `exec` guarantees
 * the ssh channel owns the python process directly, so when this end of the
 * pipe closes, sshd's SIGHUP lands on the driver rather than on a shell that
 * would leave it orphaned holding 800 MiB of VRAM.
 */
async function defaultStartChild({ host, python, repo, boxHome, driverPath, onLine }) {
	const remoteDriver = `/tmp/cclay-projflow-serve-${Date.now()}-${randomBytes(4).toString("hex")}.py`;
	const pushed = await runOnce(["scp", ...SSH_OPTS, driverPath, `${host}:${remoteDriver}`], 60_000);
	if (pushed.code !== 0) {
		throw new ResidentError(
			`could not copy the serve driver to ${host} (exit ${pushed.code}): ${pushed.stderr.trim()}`
		);
	}
	const remote = `exec env HOME=${boxHome} ${python} ${remoteDriver} --serve --repo ${JSON.stringify(repo)}`;
	onLine?.(`projflow-resident: starting ${host}:${remoteDriver}`);
	const child = spawn("ssh", [...SSH_OPTS, host, remote], { stdio: ["pipe", "pipe", "pipe"] });
	child.cleanupRemote = async () => {
		await runOnce(["ssh", ...SSH_OPTS, host, `rm -f ${remoteDriver}`], 20_000);
	};
	return child;
}

/* ------------------------------------------------------------------------- */
/* the service                                                                */
/* ------------------------------------------------------------------------- */

/**
 * One resident child and everything that can go wrong with it.
 *
 * @param {object} config
 * @param {string} config.host  ssh destination
 * @param {string} config.python  the scout venv's python on the box
 * @param {string} config.repo  the ProjFlow clone on the box
 * @param {string} config.boxHome  HOME override (keeps CLIP's cache in the scout dir)
 * @param {Function} [config.startChild]  injected for tests: returns a child
 *   process-like object with piped stdio. The default scps driver.py and spawns
 *   `ssh <host> python driver.py --serve`.
 */
export function createResidentService({
	host,
	python,
	repo,
	boxHome,
	driverPath = DRIVER,
	startChild = defaultStartChild,
	// The schedule is a parameter for one reason: the restart state machine is
	// worth testing and 1 + 5 + 25 seconds is not a test. Production never passes
	// it.
	backoff = BACKOFF_MS,
	readyTimeoutMs = positiveInt(process.env.CCLAY_PROJFLOW_RESIDENT_READY_MS, DEFAULT_READY_MS),
	requestTimeoutMs = positiveInt(process.env.CCLAY_PROJFLOW_RESIDENT_REQ_MS, DEFAULT_REQUEST_MS),
	onLine,
	registerExitHook = true,
} = {}) {
	if (!host) throw new Error("createResidentService: host is required");

	let child = null;
	let state = "idle"; // idle | starting | ready | backoff | stopped
	let readyPromise = null;
	let readyInfo = null;
	let failures = 0;
	let restartTimer = null;
	let pending = null; // the single in-flight request
	let readyWaiters = [];
	let queue = Promise.resolve();
	let counter = 0;
	let stdoutBuffer = "";

	/**
	 * Does the warm child count as work this process is waiting for?
	 *
	 * It must, while a request is in flight or the model is loading — otherwise
	 * node would exit out from under an awaited edit, because the only pending
	 * handle is a pipe. It must NOT while the child is merely warm, or every
	 * short-lived process that ever ran an edit would hang forever holding an
	 * idle ssh open. So the child is ref'd exactly for the duration of the work
	 * and unref'd the rest of the time; the exit hook does the killing.
	 */
	function keepAlive(on) {
		if (!child) return;
		const handles = [child, child.stdin, child.stdout, child.stderr];
		for (const handle of handles) {
			try {
				if (on) handle?.ref?.();
				else handle?.unref?.();
			} catch {
				// A stream that is already destroyed has nothing to ref.
			}
		}
	}

	const say = (text) => {
		try {
			(pending?.onLine || onLine)?.(text);
		} catch {
			// A status sink that throws must not take the service with it.
		}
	};

	/** Kill the child and forget it. `reason` is null for an orderly stop. */
	function tearDown(reason) {
		const dying = child;
		child = null;
		readyPromise = null;
		readyInfo = null;
		stdoutBuffer = "";
		const error = new ResidentError(reason || "the resident was stopped", { kind: "transport" });
		if (pending) {
			const failed = pending;
			pending = null;
			clearTimeout(failed.timer);
			failed.reject(error);
		}
		const waiting = readyWaiters;
		readyWaiters = [];
		for (const waiter of waiting) waiter.reject(error);
		if (dying) {
			dying.removeAllListeners?.("close");
			dying.removeAllListeners?.("error");
			try {
				dying.stdin?.end?.();
			} catch {
				// The pipe may already be gone; killing is what matters.
			}
			try {
				dying.kill?.("SIGKILL");
			} catch {
				// Same.
			}
			// Best-effort: the remote /tmp copy of the driver. A failure here is
			// one stale file, never a failed edit, so it is never awaited.
			Promise.resolve(dying.cleanupRemote?.()).catch(() => {});
		}
	}

	/** A transport failure: drop the child, count it, and schedule a restart so
	 * the NEXT edit is warm even though this one goes cold. */
	function fail(reason) {
		if (state === "stopped") return;
		tearDown(reason);
		failures += 1;
		if (failures >= MAX_CONSECUTIVE_FAILURES) {
			// The box is not coming back on its own. Go idle rather than keep an
			// ssh retry loop alive; the next request restarts on demand.
			state = "idle";
			say(`projflow-resident: giving up after ${failures} failed starts (${reason}); edits stay cold`);
			return;
		}
		const delay = backoffDelay(failures, backoff);
		state = "backoff";
		say(`projflow-resident: ${reason}; restarting in ${delay / 1000}s`);
		clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			restartTimer = null;
			if (state !== "backoff") return;
			state = "idle";
			// Fire and forget: a background restart that fails just schedules the
			// next one, and nobody is awaiting this.
			start().catch(() => {});
		}, delay);
		// The timer must never hold the process open — a warm model is a
		// convenience, not a reason for `node` to refuse to exit.
		restartTimer.unref?.();
	}

	function handleMessage(message) {
		if (message && message.type === "ready") {
			if (readyInfo) {
				fail("the resident announced itself twice");
				return;
			}
			readyInfo = message;
			const waiting = readyWaiters;
			readyWaiters = [];
			for (const waiter of waiting) waiter.resolve(message);
			return;
		}
		if (!pending) {
			// Nothing is in flight, so this line cannot be an answer to anything.
			// The two sides no longer agree about framing.
			fail(`the resident sent an unsolicited response (id ${JSON.stringify(message?.id)})`);
			return;
		}
		if (message?.id !== pending.id) {
			// THE stale-response guard: pairing this with the in-flight request
			// would hand the caller another edit's motion.
			const wanted = pending.id;
			fail(`response id ${JSON.stringify(message?.id)} does not match request ${JSON.stringify(wanted)}`);
			return;
		}
		const settled = pending;
		pending = null;
		clearTimeout(settled.timer);
		keepAlive(false);
		if (message.ok) {
			settled.resolve(message.result);
			return;
		}
		// The driver refused the request. It is still healthy, so it stays up and
		// only this request falls back.
		const detail = message.error?.message || "the resident refused the request";
		settled.reject(new ResidentError(detail, { kind: "envelope" }));
	}

	function attach(spawned) {
		spawned.stdout?.setEncoding?.("utf8");
		spawned.stdout?.on("data", (chunk) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				const text = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (text) {
					let message;
					try {
						message = JSON.parse(text);
					} catch {
						// driver.py points fd 1 at stderr before it imports anything,
						// so a non-JSON line on stdout means something wrote past that
						// guard and the stream is no longer a protocol.
						fail(`the resident wrote a non-protocol line to stdout: ${text.slice(0, 120)}`);
						return;
					}
					handleMessage(message);
					if (!child) return; // handleMessage tore the child down
				}
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		spawned.stderr?.setEncoding?.("utf8");
		spawned.stderr?.on("data", (chunk) => {
			for (const text of String(chunk).split("\n")) if (text.trim()) say(text);
		});
		spawned.on("error", (error) => fail(`the resident child errored: ${error.message}`));
		spawned.on("close", (code, signal) => {
			if (state === "stopped") return;
			fail(`the resident exited (code ${code}${signal ? `, ${signal}` : ""})`);
		});
	}

	/**
	 * Start the child and resolve once it has announced a compatible protocol.
	 *
	 * Memoised, and the memo is CLEARED by `fail` (through tearDown), so a start
	 * that failed is never handed to the next caller as a cached rejection — the
	 * next edit gets a fresh attempt or a fast "in backoff" refusal, both of
	 * which are honest answers.
	 */
	function start() {
		if (state === "stopped") return Promise.reject(new ResidentError("the resident is stopped"));
		// Backoff means "we already know this is broken, and the clock has not run
		// out". Starting anyway would spend the backoff's whole purpose — and it
		// would add a start attempt to an edit that should already be running
		// cold. Only the restart timer moves the state out of backoff.
		if (state === "backoff") {
			return Promise.reject(new ResidentError("the resident is restarting; this edit goes cold"));
		}
		if (readyPromise) return readyPromise;
		state = "starting";
		const attempt = (async () => {
			const spawned = await startChild({ host, python, repo, boxHome, driverPath, onLine: say });
			child = spawned;
			attach(spawned);
			keepAlive(true); // the model load is work this process is waiting on
			const announced = readyInfo ?? await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => fail(`the resident did not become ready within ${readyTimeoutMs} ms`),
					readyTimeoutMs
				);
				// NOT unref'd, unlike the restart timer below: this one is the
				// promise's own guarantee that it settles, and a process whose only
				// remaining work is an awaited start must not exit out from under it.
				readyWaiters.push({
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
			});
			if (Number(announced.protocol) !== PROTOCOL_VERSION) {
				throw new ResidentError(
					`the resident speaks protocol ${announced.protocol}, this build speaks ${PROTOCOL_VERSION}`
				);
			}
			state = "ready";
			failures = 0;
			if (!pending) keepAlive(false);
			say(
				`projflow-resident: ready on ${announced.device ?? "?"} in ${announced.loadSeconds ?? "?"}s ` +
					`(protocol ${announced.protocol})`
			);
			return announced;
		})().catch((error) => {
			const wrapped = error instanceof ResidentError
				? error
				: new ResidentError(`the resident failed to start: ${error.message}`, { cause: error });
			// `fail` is idempotent enough for this: when the child died on its own
			// it has already run, and a second call only costs another backoff
			// slot on a service that is not going to be used until it restarts.
			if (state === "starting" || state === "ready") fail(wrapped.message);
			throw wrapped;
		});
		readyPromise = attempt;
		return attempt;
	}

	function send(payload, timeoutMs, lineSink) {
		return new Promise((resolve, reject) => {
			if (!child || state !== "ready") {
				reject(new ResidentError("the resident is not ready"));
				return;
			}
			counter += 1;
			const id = `r${counter}`;
			const timer = setTimeout(() => {
				// A timeout is a TRANSPORT failure, not a slow answer we can wait
				// out: if the response arrives later it would be paired with the
				// next request, which is exactly the bug the ids exist to prevent.
				fail(`request ${id} timed out after ${timeoutMs} ms`);
			}, timeoutMs);
			// Ref'd on purpose (see the ready timeout): this timer is what makes an
			// awaited edit always settle, warm child or not.
			pending = { id, resolve, reject, timer, onLine: lineSink };
			keepAlive(true);
			try {
				child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
			} catch (error) {
				fail(`could not write to the resident: ${error.message}`);
			}
		});
	}

	/**
	 * Queue one request against the child, starting it if necessary.
	 *
	 * Serialised on purpose. The bridge sends one line edit at a time today, but
	 * "today" is not a guarantee, and a second writer would interleave lines on
	 * one stdin.
	 */
	function request(payload, { timeoutMs = requestTimeoutMs, onLine: lineSink } = {}) {
		if (state === "stopped") return Promise.reject(new ResidentError("the resident is stopped"));
		// A child that is in backoff is a child we already know is broken. Waiting
		// for it would add its backoff to an edit that could already be running
		// cold.
		if (state === "backoff") {
			return Promise.reject(new ResidentError("the resident is restarting; this edit goes cold", { kind: "transport" }));
		}
		const run = async () => {
			await start();
			return send(payload, timeoutMs, lineSink);
		};
		// `.then(run, run)` rather than `.then(run)`: one failed request must not
		// poison the queue for the next one.
		const result = queue.then(run, run);
		queue = result.then(() => {}, () => {});
		return result;
	}

	function stop() {
		state = "stopped";
		clearTimeout(restartTimer);
		restartTimer = null;
		tearDown(null);
		LIVE.delete(service);
	}

	const service = {
		key: JSON.stringify({ host, python, repo, boxHome }),
		host,
		request,
		start,
		stop,
		state: () => state,
		failures: () => failures,
		isReady: () => state === "ready" && Boolean(child),
		info: () => readyInfo,
		/** A ping is the only way to claim a resident is up: `state === "ready"`
		 * says the child announced itself, an answered ping says it is still
		 * there. probeHealth reports the second, never the first. */
		ping: (timeoutMs = PING_MS) => request({ type: "ping" }, { timeoutMs }),
	};

	if (registerExitHook) armExitCleanup(service);
	return service;
}

/* ------------------------------------------------------------------------- */
/* process lifetime                                                           */
/* ------------------------------------------------------------------------- */

const LIVE = new Set();
let hooksArmed = false;

/**
 * Kill every resident when this process goes away.
 *
 * `exit` covers the normal case. The signal handlers are more careful than they
 * look: adding a SIGTERM listener SUPPRESSES node's default termination, so a
 * handler installed by a library would silently make the bridge unkillable.
 * When nobody else is listening we kill the children, remove ourselves and
 * re-raise the signal so the default behaviour still happens; when the host
 * process has its own handler we only do the cleanup and let it decide.
 */
function armExitCleanup(service) {
	LIVE.add(service);
	if (hooksArmed) return;
	hooksArmed = true;
	const killAll = () => {
		for (const live of LIVE) {
			try {
				live.stop();
			} catch {
				// Nothing useful to do on the way out.
			}
		}
		LIVE.clear();
	};
	process.once("exit", killAll);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		const hostHandles = process.listenerCount(signal) > 0;
		const handler = () => {
			killAll();
			if (!hostHandles) {
				process.removeListener(signal, handler);
				process.kill(process.pid, signal);
			}
		};
		process.on(signal, handler);
	}
}

/* ------------------------------------------------------------------------- */
/* the shared instance                                                        */
/* ------------------------------------------------------------------------- */

let shared = null;

/** The process-wide resident for one box configuration, created on demand.
 * Changing the box (or the venv, or the repo) replaces it: a warm child pointed
 * at the wrong repo is worse than no child at all. */
export function getResidentService(config) {
	const key = JSON.stringify({
		host: config.host,
		python: config.python,
		repo: config.repo,
		boxHome: config.boxHome,
	});
	if (shared && shared.key !== key) {
		shared.stop();
		shared = null;
	}
	if (!shared) shared = createResidentService(config);
	return shared;
}

/** The existing resident, or null. Used by probeHealth, which must never START
 * a model load just to answer a health question. */
export function peekResidentService(config) {
	if (!shared) return null;
	if (!config) return shared;
	const key = JSON.stringify({
		host: config.host,
		python: config.python,
		repo: config.repo,
		boxHome: config.boxHome,
	});
	return shared.key === key ? shared : null;
}

export function stopResidentService() {
	if (shared) shared.stop();
	shared = null;
}

/* ------------------------------------------------------------------------- */
/* base64 float32 arrays                                                      */
/* ------------------------------------------------------------------------- */

/** A Float32Array as the {shape, dtype, data} blob driver.py decodes. Little
 * endian is the wire format and every machine either side of this is; the
 * dtype name travels so the driver can refuse rather than reinterpret. */
export function encodeFloat32(data, shape) {
	if (!(data instanceof Float32Array)) throw new TypeError("encodeFloat32: data must be a Float32Array");
	const count = shape.reduce((total, dim) => total * dim, 1);
	if (count !== data.length) {
		throw new Error(`encodeFloat32: shape (${shape.join(",")}) needs ${count} values, got ${data.length}`);
	}
	return {
		shape: [...shape],
		dtype: "float32",
		data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
	};
}

/** The inverse, with the shape checked rather than trusted: a payload whose
 * byte count disagrees with its own shape is a corrupt response, not a motion. */
export function decodeFloat32(blob) {
	if (!blob || typeof blob !== "object") throw new ResidentError("the resident returned no array");
	const shape = Array.isArray(blob.shape) ? blob.shape.map(Number) : null;
	if (!shape || shape.some((dim) => !Number.isInteger(dim) || dim < 0)) {
		throw new ResidentError(`the resident returned a bad shape ${JSON.stringify(blob.shape)}`);
	}
	if (blob.dtype && blob.dtype !== "float32") {
		throw new ResidentError(`the resident returned dtype ${blob.dtype}; this path is float32 only`);
	}
	const bytes = Buffer.from(String(blob.data || ""), "base64");
	const count = shape.reduce((total, dim) => total * dim, 1);
	if (bytes.length !== count * 4) {
		throw new ResidentError(
			`the resident returned ${bytes.length} bytes for shape (${shape.join(",")}), expected ${count * 4}`
		);
	}
	// A copy, not a view: Buffer.from(base64) has no alignment guarantee and a
	// Float32Array view over an odd byteOffset throws.
	const data = new Float32Array(count);
	for (let index = 0; index < count; index += 1) data[index] = bytes.readFloatLE(index * 4);
	return { data, shape };
}

/* ------------------------------------------------------------------------- */
/* one warm line edit                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Run one line edit on the warm child.
 *
 * Everything a one-shot invocation carries travels in the request, because the
 * resident has no per-run argv: the C6 line document, the source motion as a
 * base64 float32 blob, the step count (or the preview flag), the ridge, the
 * preserve knobs, the seed and the cfg. What comes back is the same
 * `(T,22,3)` motion and the same meta the one-shot writes to
 * `<out>.meta.json`.
 *
 * @throws {ResidentError} on ANY failure. The caller's answer to that is the
 *   cold path — never a retry here.
 */
export async function residentLineEdit({
	service,
	source,
	sourceShape,
	line,
	steps,
	preview = false,
	ridge,
	preserveStride,
	preserveMargin,
	seamPin,
	seed,
	cfg,
	timeoutMs,
	onLine,
} = {}) {
	if (!service) throw new ResidentError("residentLineEdit: no resident service");
	const payload = {
		type: "lineEdit",
		line,
		source: encodeFloat32(source, sourceShape),
		preview: Boolean(preview),
		steps: Number(steps),
		ridge: Number(ridge),
		preserveStride: Number(preserveStride),
		preserveMargin: Number(preserveMargin),
	};
	if (seamPin !== undefined) payload.seamPin = Number(seamPin);
	// Omitted rather than defaulted on this side: driver.py owns the defaults
	// (0 and 3.0) and two places spelling them is how they drift.
	if (seed !== undefined) payload.seed = Number(seed);
	if (cfg !== undefined) payload.cfg = Number(cfg);

	const result = await service.request(payload, { timeoutMs, onLine });
	const { data, shape } = decodeFloat32(result);
	if (!result.meta || typeof result.meta !== "object") {
		throw new ResidentError("the resident returned a motion with no metadata");
	}
	return { positions: data, shape, meta: result.meta };
}
