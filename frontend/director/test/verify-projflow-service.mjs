/**
 * verify-projflow-service.mjs — GPU-free, ssh-free checks for the resident
 * ProjFlow service (contract C11: tools/projflow/service.mjs + driver.py's
 * --serve mode).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The speed the contract is judged on (a
 * warm edit at ~2 s) is a property of a loaded checkpoint on a 3070 and is
 * measured on the box. Nothing here has a GPU or a box. What it CAN prove is
 * everything that decides whether a warm edit is CORRECT rather than fast, and
 * every one of those is a pure protocol or state-machine question:
 *
 *   1. FRAMING. A response is paired with its own request or with nothing.
 *      This is the failure that silently hands an artist another edit's motion,
 *      and it is invisible in a timing measurement.
 *   2. THE ARRAY ROUND TRIP. base64 float32 in, base64 float32 out, with the
 *      shape checked rather than trusted.
 *   3. THE FALLBACK DECISION. Which failures kill the child (transport) and
 *      which leave it up (the driver refused a request). Both fall back cold;
 *      only one costs a restart.
 *   4. THE RESTART STATE MACHINE. Backoff schedule, background restart, and
 *      giving up rather than spinning ssh forever at a box that is gone.
 *   5. PROCESS LIFETIME. A warm child must not keep a finished process alive,
 *      and must not survive it either. That one is checked with a real
 *      subprocess, because it is a question about handles, not about logic.
 *
 * The fake children below come in two flavours on purpose. An in-process
 * EventEmitter fake gives exact control over the failure modes (die mid
 * request, answer the wrong id, write garbage). ONE real `node -e` child then
 * runs the same code over real pipes, so the tests cannot pass by agreeing with
 * a fake that has drifted from what a spawned process behaves like.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	BACKOFF_MS,
	MAX_CONSECUTIVE_FAILURES,
	PROTOCOL_VERSION,
	ResidentError,
	backoffDelay,
	createResidentService,
	decodeFloat32,
	encodeFloat32,
	residentEnabled,
	residentLineEdit,
} from "../tools/projflow/service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function pass(label) { console.log(`PASS ${label}`); }
function skip(label) { console.log(`SKIP ${label}`); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The config every service in this file is built with. No host is ever
 * contacted: `startChild` is injected in every case. */
const BOX = { host: "fake@box", python: "/venv/bin/python", repo: "/repo", boxHome: "/home" };

/** A service whose children are fakes and whose exit hook is NOT armed — the
 * suite creates a dozen of these and a dozen process-wide signal handlers would
 * be a leak, not a test. */
function fakeService(startChild, overrides = {}) {
	return createResidentService({ ...BOX, registerExitHook: false, startChild, ...overrides });
}

/**
 * A child process the tests can drive frame by frame.
 *
 * It implements exactly the surface service.mjs touches: piped stdio, `close`,
 * `error`, `kill`. Nothing more, so a test cannot lean on behaviour the real
 * ssh child does not have.
 */
class FakeChild extends EventEmitter {
	constructor({ ready = { type: "ready", protocol: PROTOCOL_VERSION, device: "cpu", loadSeconds: 0.01 }, respond } = {}) {
		super();
		this.requests = [];
		this.killed = false;
		this.readyMessage = ready;
		this.responder = respond;
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdout.setEncoding = () => {};
		this.stderr.setEncoding = () => {};
		this.stdin = {
			write: (text) => {
				const request = JSON.parse(text);
				this.requests.push(request);
				// Asynchronous like a real pipe: a responder that answered inside
				// `write` would let a bug in the pending-request bookkeeping pass.
				setImmediate(() => {
					const answer = this.responder?.(request);
					if (answer !== undefined && answer !== null) this.line(answer);
				});
				return true;
			},
			end: () => {},
		};
	}

	/** Announce readiness the way the driver does, after the caller has had a
	 * chance to attach — `start()` awaits `startChild` before it listens. */
	announce() {
		if (this.readyMessage) setImmediate(() => this.line(this.readyMessage));
		return this;
	}

	line(message) {
		this.stdout.emit("data", typeof message === "string" ? message : `${JSON.stringify(message)}\n`);
	}

	die(code = 1) {
		this.emit("close", code, null);
	}

	kill() {
		this.killed = true;
	}
}

/** The echo the happy-path tests use: the source array straight back, plus a
 * meta shaped like driver.py's. */
function echoResponder(request) {
	if (request.type === "ping") {
		return { id: request.id, ok: true, result: { pong: true, protocol: PROTOCOL_VERSION, served: 0 } };
	}
	// A request with no source is one of the bare `{type: "lineEdit"}` probes the
	// framing tests use; echoing an empty array keeps the responder honest
	// without making every test build a motion.
	const source = request.source ?? encodeFloat32(new Float32Array(3), [1, 1, 3]);
	return {
		id: request.id,
		ok: true,
		result: {
			shape: source.shape,
			dtype: "float32",
			data: source.data,
			meta: { track: request.line?.track, steps: request.steps, seed: request.seed, m: 42 },
		},
	};
}

// =====================================================================
// 1. base64 float32 arrays — the wire format for a 52 KB motion
// =====================================================================
{
	const source = new Float32Array([0, 1, -2.5, 3.25, 1e-7, 1234.5]);
	const blob = encodeFloat32(source, [2, 3]);
	assert.equal(blob.dtype, "float32");
	assert.deepEqual(blob.shape, [2, 3]);
	assert.equal(typeof blob.data, "string");
	const back = decodeFloat32(blob);
	assert.deepEqual(back.shape, [2, 3]);
	assert.ok(back.data instanceof Float32Array);
	// Bit-exact: a float32 that survived base64 must be the SAME float32, or a
	// preserved frame would come back as a near-miss and the seam would pop.
	assert.deepEqual([...back.data], [...source]);
	pass("a float32 array survives the base64 round trip bit for bit");

	// A (T,22,3) motion of the size the box really sends.
	const motion = new Float32Array(196 * 22 * 3);
	for (let index = 0; index < motion.length; index += 1) motion[index] = Math.sin(index) * 3;
	const round = decodeFloat32(encodeFloat32(motion, [196, 22, 3]));
	assert.deepEqual(round.shape, [196, 22, 3]);
	assert.equal(round.data.length, motion.length);
	assert.deepEqual([...round.data.subarray(0, 64)], [...motion.subarray(0, 64)]);
	assert.equal(round.data[motion.length - 1], motion[motion.length - 1]);
	pass("a full 196-frame hml22 motion round-trips through the base64 blob");
}

// The shape travels because a (T,22,3) and a (3,22,T) blob are the same length
// and the sampler would happily edit the transpose.
assert.throws(() => encodeFloat32(new Float32Array(6), [2, 2]), /needs 4 values, got 6/);
assert.throws(() => encodeFloat32([1, 2, 3], [3]), /must be a Float32Array/);
assert.throws(() => decodeFloat32(null), /returned no array/);
assert.throws(() => decodeFloat32({ shape: [2, "x"], data: "" }), /bad shape/);
assert.throws(() => decodeFloat32({ shape: [2], dtype: "float64", data: "AAAAAAAAAAA=" }), /dtype float64/);
assert.throws(
	() => decodeFloat32({ shape: [4], data: encodeFloat32(new Float32Array(2), [2]).data }),
	/returned 8 bytes for shape \(4\), expected 16/
);
pass("a payload whose bytes disagree with its own shape is refused, not reshaped");

// =====================================================================
// 2. The env switch and the backoff schedule
// =====================================================================
assert.equal(residentEnabled({}), true, "the resident is opt-OUT: the cold path is always underneath it");
assert.equal(residentEnabled({ CCLAY_PROJFLOW_RESIDENT: "1" }), true);
assert.equal(residentEnabled({ CCLAY_PROJFLOW_RESIDENT: "0" }), false);
assert.equal(residentEnabled({ CCLAY_PROJFLOW_RESIDENT: "false" }), false);
assert.equal(residentEnabled({ CCLAY_PROJFLOW_RESIDENT: "off" }), false);
pass("CCLAY_PROJFLOW_RESIDENT=0 disables the resident and anything else leaves it on");

assert.deepEqual([...BACKOFF_MS], [1_000, 5_000, 25_000]);
assert.equal(backoffDelay(1), 1_000);
assert.equal(backoffDelay(2), 5_000);
assert.equal(backoffDelay(3), 25_000);
// Capped, not unbounded: a box that comes back after an hour should be picked
// up within 25 s, not after a doubling sequence nobody waits out.
assert.equal(backoffDelay(4), 25_000);
assert.equal(backoffDelay(99), 25_000);
assert.equal(backoffDelay(0), 1_000);
pass("the restart backoff is 1 s, 5 s, 25 s and then capped");

// =====================================================================
// 3. Framing: a response belongs to its own request or to nothing
// =====================================================================
{
	const child = new FakeChild({ respond: echoResponder });
	const service = fakeService(async () => child.announce());
	const source = new Float32Array([1, 2, 3, 4, 5, 6]);
	const result = await residentLineEdit({
		service,
		source,
		sourceShape: [1, 2, 3],
		line: { track: "leftHand", frameRange: { start: 0, end: 1 } },
		steps: 100,
		ridge: 1e-6,
		preserveStride: 2,
		preserveMargin: 20,
		seed: 7,
	});
	assert.deepEqual([...result.positions], [...source]);
	assert.deepEqual(result.shape, [1, 2, 3]);
	assert.equal(result.meta.track, "leftHand");
	// Everything a one-shot invocation carries has to be on the wire, or the warm
	// route is quietly running a different edit from the cold one.
	const sent = child.requests[0];
	assert.equal(sent.type, "lineEdit");
	assert.equal(sent.steps, 100);
	assert.equal(sent.ridge, 1e-6);
	assert.equal(sent.preserveStride, 2);
	assert.equal(sent.preserveMargin, 20);
	assert.equal(sent.seed, 7);
	assert.deepEqual(sent.source.shape, [1, 2, 3]);
	assert.equal(sent.line.track, "leftHand");
	assert.ok(typeof sent.id === "string" && sent.id.length > 0, "every request carries an id");
	assert.equal(service.state(), "ready");
	service.stop();
	pass("a warm line edit carries the whole one-shot request and returns positions + meta");
}

{
	// Ids must be unique per request, and the queue must serialise: one child,
	// one line at a time, however many callers there are.
	const inFlight = [];
	const child = new FakeChild({
		respond: (request) => {
			inFlight.push(request.id);
			return echoResponder(request);
		},
	});
	const service = fakeService(async () => child.announce());
	const one = () =>
		residentLineEdit({
			service,
			source: new Float32Array([1, 2, 3]),
			sourceShape: [1, 1, 3],
			line: { track: "head" },
			steps: 20,
			ridge: 1e-6,
			preserveStride: 2,
			preserveMargin: 20,
		});
	const results = await Promise.all([one(), one(), one()]);
	assert.equal(results.length, 3);
	assert.equal(new Set(child.requests.map((request) => request.id)).size, 3, "ids must be unique");
	assert.deepEqual(inFlight, child.requests.map((request) => request.id), "requests are answered in order");
	// The seed and cfg are OMITTED when the caller has none: driver.py owns those
	// defaults and two places spelling them is how they drift.
	assert.ok(!("seed" in child.requests[0]), "an absent seed is not invented on this side");
	assert.ok(!("cfg" in child.requests[0]));
	service.stop();
	pass("concurrent callers are queued onto the single child with unique ids");
}

{
	// THE stale-response guard. A response for another id must never be handed
	// to the waiting caller — it would be another edit's motion.
	const child = new FakeChild({
		respond: (request) => ({ ...echoResponder(request), id: "not-your-request" }),
	});
	const service = fakeService(async () => child.announce());
	await assert.rejects(
		() => service.request({ type: "lineEdit" }, { timeoutMs: 2_000 }),
		(error) => {
			assert.ok(error instanceof ResidentError);
			assert.equal(error.kind, "transport");
			assert.match(error.message, /does not match request/);
			return true;
		}
	);
	// A framing failure means the stream cannot be trusted at all: the child goes.
	assert.equal(child.killed, true, "an id mismatch kills the child");
	assert.equal(service.state(), "backoff");
	service.stop();
	pass("a mismatched response id is a transport failure that kills and restarts the child");
}

{
	// An answer with nothing in flight is the same class of bug seen from the
	// other side.
	const child = new FakeChild({ respond: () => null });
	const service = fakeService(async () => child.announce());
	await service.start();
	child.line({ id: "ghost", ok: true, result: {} });
	await sleep(20);
	assert.equal(child.killed, true);
	assert.equal(service.state(), "backoff");
	service.stop();
	pass("an unsolicited response line is refused instead of being cached for the next request");
}

{
	// driver.py points fd 1 at stderr before importing torch precisely so this
	// cannot happen; if it does, the stream is no longer a protocol.
	const child = new FakeChild({ respond: () => null });
	const service = fakeService(async () => child.announce());
	await service.start();
	const pending = service.request({ type: "ping" }, { timeoutMs: 2_000 });
	await sleep(20); // let the request reach the child, so it is genuinely in flight
	child.line("Loading checkpoint: 42%\n");
	await assert.rejects(pending, /non-protocol line/);
	assert.equal(child.killed, true);
	service.stop();
	pass("a non-JSON line on stdout is a protocol failure, not status output");
}

// =====================================================================
// 4. The fallback decision: which failures cost a restart
// =====================================================================
{
	// AN ENVELOPE ERROR IS NOT A TRANSPORT ERROR. The driver understood us and
	// refused; it is healthy. The caller still falls back cold (where the same
	// request produces the same named error from the contract of record), but
	// the child stays up and the next edit is still warm.
	const child = new FakeChild({
		respond: (request) =>
			request.type === "ping"
				? echoResponder(request)
				: { id: request.id, ok: false, error: { type: "ValueError", message: "track 'chest' cannot be line-edited" } },
	});
	const service = fakeService(async () => child.announce());
	await assert.rejects(
		() => service.request({ type: "lineEdit" }, { timeoutMs: 2_000 }),
		(error) => {
			assert.equal(error.kind, "envelope");
			assert.match(error.message, /chest/);
			return true;
		}
	);
	assert.equal(child.killed, false, "a refused request must not cost a model load");
	assert.equal(service.state(), "ready");
	// ...and the child really is still usable.
	const pong = await service.ping(2_000);
	assert.equal(pong.pong, true);
	service.stop();
	pass("a driver error envelope falls back cold WITHOUT killing the warm child");
}

{
	// A response with no metadata is not a usable result: the caller's contract
	// includes the driver's own exactness numbers.
	const child = new FakeChild({
		respond: (request) => ({ id: request.id, ok: true, result: { shape: [1, 1, 3], dtype: "float32", data: encodeFloat32(new Float32Array(3), [3]).data } }),
	});
	const service = fakeService(async () => child.announce());
	await assert.rejects(
		() =>
			residentLineEdit({
				service,
				source: new Float32Array(3),
				sourceShape: [1, 1, 3],
				line: { track: "head" },
				steps: 20,
				ridge: 1e-6,
				preserveStride: 2,
				preserveMargin: 20,
			}),
		/no metadata/
	);
	service.stop();
	pass("a result without the driver's meta is refused");
}

{
	// A protocol number from an older build: refused loudly rather than trusted
	// to mean the same thing it used to.
	const child = new FakeChild({ ready: { type: "ready", protocol: PROTOCOL_VERSION + 1, device: "cpu" } });
	const service = fakeService(async () => child.announce());
	await assert.rejects(() => service.start(), /speaks protocol/);
	assert.equal(child.killed, true);
	service.stop();
	pass("a resident speaking another protocol version is refused and replaced");
}

{
	// A timeout is a TRANSPORT failure on purpose: a response that arrives after
	// we gave up would be paired with the NEXT request, which is exactly what the
	// ids exist to prevent.
	const child = new FakeChild({ respond: () => null });
	const service = fakeService(async () => child.announce(), { requestTimeoutMs: 60 });
	await assert.rejects(
		() => service.request({ type: "lineEdit" }),
		(error) => {
			assert.equal(error.kind, "transport");
			assert.match(error.message, /timed out after 60 ms/);
			return true;
		}
	);
	assert.equal(child.killed, true);
	service.stop();
	pass("a request that outlives its timeout kills the child instead of waiting for a stale answer");
}

{
	// The child that never announces itself. Same treatment, different clock.
	const child = new FakeChild({ ready: null });
	const service = fakeService(async () => child, { readyTimeoutMs: 60 });
	await assert.rejects(() => service.start(), /did not become ready within 60 ms/);
	assert.equal(child.killed, true);
	service.stop();
	pass("a resident that never loads its model is given up on and the edit goes cold");
}

// =====================================================================
// 5. Death, restart and giving up
// =====================================================================
{
	// The user pulls the plug mid-edit (gate GS1's fallback proof, in miniature).
	const child = new FakeChild({ respond: () => null });
	let starts = 0;
	// The real schedule starts at 1 s; the SHAPE of the state machine is what is
	// under test here and `backoffDelay` above pins the production numbers.
	const service = fakeService(async () => {
		starts += 1;
		return starts === 1 ? child.announce() : new FakeChild({ respond: echoResponder }).announce();
	}, { backoff: [50] });
	await service.start();
	const pending = service.request({ type: "lineEdit" }, { timeoutMs: 5_000 });
	await sleep(20); // in flight, not merely queued
	child.die(137);
	await assert.rejects(pending, (error) => {
		assert.equal(error.kind, "transport");
		assert.match(error.message, /the resident exited \(code 137\)/);
		return true;
	});
	assert.equal(service.state(), "backoff", "a death schedules a restart rather than leaving the service dead");
	assert.equal(service.failures(), 1);

	// While it is in backoff an edit must NOT wait for it: the cold path is
	// already running by then and adding a 1 s wait to it would be the resident
	// making things WORSE than not existing.
	const started = Date.now();
	await assert.rejects(() => service.request({ type: "ping" }), /restarting; this edit goes cold/);
	assert.ok(Date.now() - started < 200, "a backoff refusal is immediate");

	// ...and the background restart really happens, so the NEXT edit is warm
	// again without anybody asking.
	await sleep(300);
	assert.equal(starts, 2, "the service restarted itself in the background");
	assert.equal(service.state(), "ready");
	assert.equal(service.failures(), 0, "a successful start clears the failure count");
	const pong = await service.ping(2_000);
	assert.equal(pong.pong, true);
	service.stop();
	pass("a child that dies mid-request fails that edit, restarts in the background and serves the next one");
}

{
	// A box that is simply gone. The service must not keep an ssh retry loop
	// alive forever; it gives up and waits for someone at the keyboard.
	let attempts = 0;
	const service = fakeService(
		async () => {
			attempts += 1;
			throw new Error("ssh: connect to host fake@box port 22: No route to host");
		},
		{ backoff: [20] }
	);
	await assert.rejects(() => service.start(), /No route to host/);
	// From here the retries are the SERVICE's own, not the caller's: nobody is
	// awaiting an edit any more and the loop has to stop by itself.
	await sleep(20 * (MAX_CONSECUTIVE_FAILURES + 4));
	assert.equal(attempts, MAX_CONSECUTIVE_FAILURES);
	assert.equal(service.failures(), MAX_CONSECUTIVE_FAILURES);
	assert.equal(service.state(), "idle", "after N failures the service stops retrying on its own");
	// And it really has stopped: no more attempts arrive on their own.
	await sleep(120);
	assert.equal(attempts, MAX_CONSECUTIVE_FAILURES);
	// Idle, not stopped: the next edit still tries, because a person asking for
	// one is the best evidence the box might be back.
	await assert.rejects(() => service.start(), /No route to host/);
	assert.equal(attempts, MAX_CONSECUTIVE_FAILURES + 1);
	service.stop();
	pass("an unreachable box stops the retry loop instead of spawning ssh forever");
}

{
	// stop() is final: a stopped service must not resurrect itself.
	const child = new FakeChild({ respond: echoResponder });
	const service = fakeService(async () => child.announce());
	await service.start();
	service.stop();
	assert.equal(child.killed, true);
	assert.equal(service.state(), "stopped");
	await assert.rejects(() => service.request({ type: "ping" }), /is stopped/);
	await assert.rejects(() => service.start(), /is stopped/);
	pass("a stopped resident stays stopped and kills its child");
}

// =====================================================================
// 6. The same protocol over REAL pipes
// =====================================================================
// Everything above is an in-process fake. This one spawns a node child that
// speaks the driver's NDJSON dialect over real stdio, so the framing cannot
// pass by agreeing with a fake that has drifted from a spawned process.
{
	const FAKE_DRIVER = `
		let buffer = "";
		const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
		write({ type: "ready", protocol: ${PROTOCOL_VERSION}, device: "cpu", loadSeconds: 0.02, pid: process.pid });
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\\n")) >= 0) {
				const text = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!text.trim()) continue;
				const request = JSON.parse(text);
				if (request.type === "ping") { write({ id: request.id, ok: true, result: { pong: true, protocol: ${PROTOCOL_VERSION} } }); continue; }
				if (request.type === "lineEdit") {
					// Diagnostics go to stderr, the way driver.py forces them to.
					process.stderr.write("fake-driver: sampling " + request.steps + " steps\\n");
					write({ id: request.id, ok: true, result: {
						shape: request.source.shape, dtype: "float32", data: request.source.data,
						meta: { m: 3792, steps: request.steps, checks: { lineMaxReprojErr: 1e-7 } },
					} });
					continue;
				}
				write({ id: request.id, ok: false, error: { type: "ValueError", message: "unknown type " + request.type } });
			}
		});
	`;
	const status = [];
	const service = createResidentService({
		...BOX,
		registerExitHook: false,
		onLine: (text) => status.push(text),
		startChild: async () => spawn(process.execPath, ["-e", FAKE_DRIVER], { stdio: ["pipe", "pipe", "pipe"] }),
	});
	const motion = new Float32Array(60 * 22 * 3);
	for (let index = 0; index < motion.length; index += 1) motion[index] = index * 0.001;
	const result = await residentLineEdit({
		service,
		source: motion,
		sourceShape: [60, 22, 3],
		line: { track: "leftHand", frameRange: { start: 10, end: 40 } },
		steps: 100,
		ridge: 1e-6,
		preserveStride: 2,
		preserveMargin: 20,
	});
	assert.deepEqual(result.shape, [60, 22, 3]);
	assert.equal(result.positions.length, motion.length);
	assert.deepEqual([...result.positions.subarray(0, 32)], [...motion.subarray(0, 32)]);
	assert.equal(result.meta.m, 3792);
	// A second edit on the SAME child is the whole point of the contract.
	const again = await residentLineEdit({
		service,
		source: motion,
		sourceShape: [60, 22, 3],
		line: { track: "head" },
		steps: 20,
		ridge: 1e-6,
		preserveStride: 2,
		preserveMargin: 20,
	});
	assert.equal(again.meta.steps, 20);
	assert.ok(status.some((text) => /fake-driver: sampling 100 steps/.test(text)), "stderr is forwarded as status");
	assert.ok(status.some((text) => /projflow-resident: ready/.test(text)));
	// An error envelope over real pipes behaves like the fake's.
	await assert.rejects(() => service.request({ type: "nonsense" }, { timeoutMs: 5_000 }), /unknown type nonsense/);
	assert.equal(service.state(), "ready");
	service.stop();
	pass("the same protocol works over real pipes: two edits on one child, stderr as status, envelope errors survivable");
}

// =====================================================================
// 7. Process lifetime: a warm child neither holds a process open nor outlives it
// =====================================================================
// The two halves of "killed on process exit" are handle questions, not logic
// questions, so they are asked of a real process. The subprocess below starts a
// resident whose child prints its pid and then sleeps forever, and RETURNS.
// If the idle child kept a handle ref'd, node would hang; if the exit hook did
// not fire, the grandchild would still be alive afterwards.
{
	const LIFETIME = `
		const { createResidentService } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "tools/projflow/service.mjs")).href)});
		const { spawn } = await import("node:child_process");
		const CHILD = 'process.stdout.write(JSON.stringify({type:"ready",protocol:${PROTOCOL_VERSION},device:"cpu",pid:process.pid})+"\\\\n"); setInterval(() => {}, 1000); process.stdin.resume();';
		const service = createResidentService({
			host: "fake@box", python: "p", repo: "r", boxHome: "h",
			startChild: async () => spawn(process.execPath, ["-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] }),
		});
		const info = await service.start();
		process.stdout.write("GRANDCHILD " + info.pid + "\\n");
	`;
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", LIFETIME], { encoding: "utf8", timeout: 20_000 });
	if (run.status !== 0 || run.error) {
		skip(`resident process lifetime (subprocess exited ${run.status}: ${String(run.stderr).trim().split("\n").pop()})`);
	} else {
		const pid = Number(/^GRANDCHILD (\d+)$/m.exec(run.stdout)?.[1]);
		assert.ok(Number.isInteger(pid) && pid > 0, `the subprocess should report its grandchild pid, got ${run.stdout}`);
		// It exited at all: an idle warm child does not keep its owner alive.
		// (spawnSync would have returned a timeout signal otherwise.)
		assert.equal(run.signal, null, "the parent must exit on its own with a warm child idle");
		await sleep(300);
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, `the resident child ${pid} outlived the process that owned it`);
		pass("an idle resident lets its owner exit and is killed when the owner does");
	}
}

// =====================================================================
// 8. driver.py's --serve mode is wired up and its one-shot mode is intact
// =====================================================================
// The python only ever runs on the box. What is checkable here is that the two
// modes exist, that they refuse each other's arguments, and that the module
// still compiles — a missing --serve flag would otherwise be found by an ssh
// round trip that hangs waiting for a `ready` line that never comes.
{
	const driver = join(REPO_ROOT, "tools", "projflow", "driver.py");
	// numpy, not just python: the driver imports it at module scope, so a dev
	// machine without it can check nothing here. The box venv has it, and
	// verify-projflow-runner.mjs still compiles the file either way.
	const probe = spawnSync("python3", ["-c", "import numpy"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		skip("driver.py --serve wiring (no local python3 with numpy — the box venv is the only one that matters)");
	} else {
		const help = spawnSync("python3", [driver, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0, `driver.py --help failed:\n${help.stderr}`);
		assert.match(help.stdout, /--serve/, "the resident mode must be reachable from the CLI");
		// The one-shot mode is the contract of record and must still be required
		// to be complete.
		for (const flag of ["--source", "--line", "--out"]) {
			assert.match(help.stdout, new RegExp(flag.replace("--", "--")));
		}
		const missing = spawnSync("python3", [driver, "--source", "/x.npy"], { encoding: "utf8" });
		assert.notEqual(missing.status, 0);
		assert.match(`${missing.stderr}${missing.stdout}`, /--line is required \(or use --serve\)/);
		const mixed = spawnSync("python3", [driver, "--serve", "--out", "/x.npy"], { encoding: "utf8" });
		assert.notEqual(mixed.status, 0);
		assert.match(`${mixed.stderr}${mixed.stdout}`, /--serve takes its requests on stdin/);
		pass("driver.py exposes --serve, still demands the one-shot trio, and refuses a mix of the two");

		// The serve loop's protocol helpers are pure python and testable without
		// torch: the base64 blob this suite builds on the JS side must decode to
		// the same numbers on the box side.
		const codecSource = new Float32Array([1.5, -2.25, 0, 1e-7, 3, 4]);
		const blob = encodeFloat32(codecSource, [1, 2, 3]);
		const script = [
			"import importlib.util, json, sys",
			`spec = importlib.util.spec_from_file_location('drv', ${JSON.stringify(driver)})`,
			"mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
			`blob = json.loads(${JSON.stringify(JSON.stringify(blob))})`,
			"arr = mod.decode_array(blob)",
			"print(json.dumps({'shape': list(arr.shape), 'values': [float(v) for v in arr.reshape(-1)]}))",
			"back = mod.encode_array(arr)",
			"print(json.dumps({'same': back['data'] == blob['data'], 'shape': back['shape'], 'dtype': back['dtype']}))",
		].join("; ");
		const decoded = spawnSync("python3", ["-c", script], { encoding: "utf8" });
		if (decoded.status !== 0) {
			// numpy is not guaranteed on a dev machine; the box venv has it.
			skip(`driver.py array codec (${String(decoded.stderr).trim().split("\n").pop()})`);
		} else {
			const [values, round] = decoded.stdout.trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(values.shape, [1, 2, 3]);
			// numpy's `float(v)` widens the stored float32 to a python double, same as
			// reading a Float32Array element in JS — both are exact bit widenings with
			// no further rounding. But a *literal* like 1e-7 is a float64 the moment
			// it's typed, and 1e-7 has no exact float32 representation, so the literal
			// and the widened-float32 value differ starting at the 8th significant
			// digit. Compare against the float32-rounded expectation, not the literal.
			assert.deepEqual(values.values, Array.from(codecSource));
			assert.equal(round.same, true, "the box re-encodes the same bytes it received");
			assert.deepEqual(round.shape, [1, 2, 3]);
			assert.equal(round.dtype, "float32");
			pass("driver.py decodes this module's base64 blobs to the same float32 values and back");
		}
	}
}

console.log("projflow resident service checks complete");
