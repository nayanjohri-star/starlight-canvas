#!/usr/bin/env node
/**
 * End-to-end parity driver for the CozyClay vs native ARDY equivalence
 * work. One run asks the CozyClay bridge to free-generate a motion with
 * the same prompt / duration / seed as a native ARDY reference run; the
 * resulting npz is then diffed against the reference npz with compareNpz.
 * Identical seeds must produce numerically identical motion (atol 0 is the
 * default and the point of the exercise).
 *
 * The request body is the shared bridge contract { prompt, duration, seed }
 * (seed is optional in the contract; here it is required, because a parity
 * run without a seed proves nothing) plus posePin:false -- the bridge
 * defaults posePin to true and then requires a full-body pose, while a
 * parity run is free generation (scripts/generate.py on the box), which is
 * exactly the posePin:false path. The bridge answers with an NDJSON
 * stream: {"event":"status"...} progress lines, {"event":"report"...}
 * box reports, {"event":"done","output":<path>...} on success and
 * {"event":"error","message"...} on failure -- the output path is parsed
 * out of the done event, not guessed.
 *
 * Usage:
 *   node test/ardy/parity-e2e.mjs --seed <int> --duration <seconds> \
 *     --prompt "<text>" --reference <ref.npz> [--atol <tolerance>]
 *
 *   --seed       integer in 0..2147483647 (the bridge's 2**31-1 contract);
 *                must be the same value the native ARDY reference run used
 *   --duration   clip length in seconds (ARDY convention: seconds * 20
 *                frames, 20 fps)
 *   --prompt     the free-generation text prompt
 *   --reference  path to the native ARDY reference npz
 *   --atol       max acceptable absolute difference per shared array
 *                (default 0: bit-for-bit)
 *
 * Exit 0 on pass, 1 on fail or error, 2 on bad usage.
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { compareNpz, printReport } from "./compare-npz.mjs";

const BRIDGE_URL = "http://127.0.0.1:5181/ardy/generate";
// Generation on the box takes minutes; give a generous hard cap so a hung
// run cannot hang the driver forever (disconnect kills the box children).
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

const USAGE = `usage: node test/ardy/parity-e2e.mjs --seed <int> --duration <seconds> --prompt "<text>" --reference <ref.npz> [--atol <tolerance>]
  POSTs { prompt, duration, seed } to ${BRIDGE_URL}, waits for the NDJSON
  event:done output path, then diffs that npz against the native ARDY
  reference npz (compareNpz, atol default 0). --seed is the bridge-contract
  integer 0..2147483647 (2**31-1). exit 0 on pass, 1 on fail.`;

class UsageError extends Error {}

function parseArgs(argv) {
	const opts = { seed: null, duration: null, prompt: null, reference: null, atol: 0 };
	const need = (name) => {
		if (argv.length === 0) throw new UsageError(`${name} requires a value`);
		return argv.shift();
	};
	while (argv.length > 0) {
		const arg = argv.shift();
		if (arg === "--seed") opts.seed = Number(need("--seed"));
		else if (arg === "--duration") opts.duration = Number(need("--duration"));
		else if (arg === "--prompt") opts.prompt = need("--prompt");
		else if (arg === "--reference") opts.reference = need("--reference");
		else if (arg === "--atol") opts.atol = Number(need("--atol"));
		else if (arg === "-h" || arg === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else throw new UsageError(`unknown argument "${arg}"`);
	}
	if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 2 ** 31 - 1) {
		throw new UsageError("--seed must be an integer in 0..2147483647 (2**31-1)");
	}
	if (!Number.isInteger(opts.duration) || opts.duration <= 0) throw new UsageError("--duration must be a positive integer");
	if (!opts.prompt) throw new UsageError("--prompt is required");
	if (!opts.reference) throw new UsageError("--reference is required");
	if (!Number.isFinite(opts.atol) || opts.atol < 0) throw new UsageError("--atol must be a non-negative finite number");
	return opts;
}

/**
 * POST the generation request and stream the NDJSON response until the
 * done event, returning its output path. Any event:error or a stream that
 * ends without done is an error.
 */
async function generateMotion({ prompt, duration, seed }) {
	const res = await fetch(BRIDGE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt, duration, seed, posePin: false }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`bridge returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
	}
	const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
	let output = null;
	for await (const line of lines) {
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue; // never fail on a non-JSON line from the box
		}
		if (msg.event === "status") {
			console.log(`[bridge] ${msg.message}`);
		} else if (msg.event === "done") {
			output = msg.output;
			break;
		} else if (msg.event === "error") {
			throw new Error(msg.message);
		}
		// report events are box progress; not needed for the comparison.
	}
	if (!output) throw new Error("bridge stream ended without an event:done");
	return output;
}

let opts;
try {
	opts = parseArgs(process.argv.slice(2));
} catch (err) {
	console.error(`parity-e2e: ${err.message}`);
	if (err instanceof UsageError) console.error(USAGE);
	process.exit(2);
}

try {
	console.log(
		`parity-e2e: prompt=${JSON.stringify(opts.prompt)} duration=${opts.duration}s seed=${opts.seed} atol=${opts.atol}`
	);
	console.log(`reference: ${opts.reference}`);
	const output = await generateMotion({ prompt: opts.prompt, duration: opts.duration, seed: opts.seed });
	console.log(`generated: ${output}`);
	const report = compareNpz(output, opts.reference, { atol: opts.atol });
	printReport(output, opts.reference, report, { atol: opts.atol });
	process.exit(report.pass ? 0 : 1);
} catch (err) {
	console.error(`parity-e2e: ${err.message}`);
	process.exit(1);
}
