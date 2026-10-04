#!/usr/bin/env node
/**
 * HMAC v1 signing primitives used by the demo worker.
 *
 * The Worker verifier in workers/api/src/worker-auth.js signs these exact
 * canonical bytes:
 *
 *   v1
 *   worker id
 *   timestamp (milliseconds)
 *   nonce
 *   HTTP method
 *   request-target path (including query)
 *   job id
 *   lease token
 *   SHA-256(raw body), hexadecimal
 *
 * Keep this module free of network and filesystem side effects when imported.
 * The small CLI at the bottom is deliberately just a convenience for curl.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bodyBytes,
	canonicalBytes,
	canonicalString,
	digestHex,
	randomNonce,
	signPayload,
	signRequest,
	signedHeaders,
	toBase64Url,
} from "./sign-core.mjs";

export {
	bodyBytes,
	canonicalBytes,
	canonicalString,
	digestHex,
	randomNonce,
	signPayload,
	signRequest,
	signedHeaders,
	toBase64Url,
};

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseCli(argv) {
	const result = {
		method: null,
		path: null,
		jobId: "",
		leaseToken: "",
		bodyFile: null,
		ts: undefined,
		nonce: undefined,
	};
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-")) {
			positional.push(arg);
			continue;
		}
		const take = (name) => {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
			return value;
		};
		switch (arg) {
			case "--method":
				result.method = take(arg);
				break;
			case "--path":
				result.path = take(arg);
				break;
			case "--job":
			case "--job-id":
				result.jobId = take(arg);
				break;
			case "--lease":
			case "--lease-token":
				result.leaseToken = take(arg);
				break;
			case "--body-file":
				result.bodyFile = take(arg);
				break;
			case "--ts":
				result.ts = Number(take(arg));
				if (!Number.isFinite(result.ts)) throw new Error("--ts must be a finite number");
				break;
			case "--nonce":
				result.nonce = take(arg);
				break;
			case "--help":
			case "-h":
				throw new Error(
					"usage: node tools/demo-worker/sign.mjs <method> <path> [jobId] [leaseToken] [bodyFile]\n" +
					"   or: node tools/demo-worker/sign.mjs --method GET --path /worker/next [--job id] [--lease token] [--body-file file]",
				);
			default:
				throw new Error(`unknown option ${arg}`);
		}
	}
	if (result.method == null && positional.length > 0) result.method = positional.shift();
	if (result.path == null && positional.length > 0) result.path = positional.shift();
	if (!result.jobId && positional.length > 0) result.jobId = positional.shift();
	if (!result.leaseToken && positional.length > 0) result.leaseToken = positional.shift();
	if (!result.bodyFile && positional.length > 0) result.bodyFile = positional.shift();
	if (positional.length > 0) throw new Error(`unexpected positional argument ${positional[0]}`);
	if (!result.method || !result.path) throw new Error("method and path are required");
	return result;
}

/** Run the CLI and return its exit status; exported for focused tests. */
export function runCli(argv = process.argv.slice(2), env = process.env) {
	try {
		if (argv.includes("--help") || argv.includes("-h")) {
			process.stdout.write(
				"usage: node tools/demo-worker/sign.mjs <method> <path> [jobId] [leaseToken] [bodyFile]\n" +
				"   or: node tools/demo-worker/sign.mjs --method GET --path /worker/next [--job id] [--lease token] [--body-file file]\n",
			);
			return 0;
		}
		const options = parseCli(argv);
		const secret = env.CC_WORKER_SECRET;
		const workerId = env.CC_WORKER_ID;
		if (!secret) throw new Error("CC_WORKER_SECRET is required");
		if (!workerId) throw new Error("CC_WORKER_ID is required");
		const body = options.bodyFile ? readFileSync(resolve(options.bodyFile)) : new Uint8Array();
		const headers = signedHeaders({
			secret,
			workerId,
			method: options.method,
			path: options.path,
			jobId: options.jobId,
			leaseToken: options.leaseToken,
			body,
			ts: options.ts,
			nonce: options.nonce,
		});
		for (const [name, value] of Object.entries(headers)) {
			process.stdout.write(`-H ${shellQuote(`${name}: ${value}`)}\n`);
		}
		return 0;
	} catch (error) {
		console.error(`demo-worker sign: ${error?.message ?? error}`);
		return 2;
	}
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
	process.exitCode = runCli();
}

