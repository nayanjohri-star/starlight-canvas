#!/usr/bin/env node
import assert from "node:assert/strict";
import { signPayload as workerSignPayload, canonicalBytes as workerCanonicalBytes, verifyWorkerRequest } from "../../workers/api/src/worker-auth.js";
import { canonicalBytes, signPayload, signedHeaders } from "../../tools/demo-worker/sign.mjs";
import { canonicalBytes as coreCanonicalBytes, signPayload as coreSignPayload } from "../../tools/demo-worker/sign-core.mjs";

const SECRET = "signing-test-secret";
const WORKER_ID = "verify-box";
const JOB_ID = "job-sign-1";
const LEASE = "lease-sign-1";
const TS = Date.now();
const NONCE = "11".repeat(32);
const BODY = Buffer.from("fixture-body\0bytes");
const PATH = "/worker/complete?attempt=1";

class NonceDb {
	constructor() {
		this.seen = new Set();
	}

	prepare(sql) {
		return {
			bind: (...args) => ({
				run: async () => {
					if (!/INSERT INTO worker_nonce/u.test(sql)) return { meta: { changes: 0 } };
					const nonce = String(args[0]);
					if (this.seen.has(nonce)) throw new Error("UNIQUE constraint failed: worker_nonce.nonce");
					this.seen.add(nonce);
					return { meta: { changes: 1 } };
				},
			}),
		};
	}
}

function env(db) {
	return {
		CC_WORKER_SECRET: SECRET,
		DB: db,
	};
}

function requestFor(headers, body = BODY, path = PATH) {
	return new Request(`https://api.example.test${path}`, {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/octet-stream",
		},
		body,
	});
}

const payload = {
	secret: SECRET,
	workerId: WORKER_ID,
	method: "POST",
	path: PATH,
	jobId: JOB_ID,
	leaseToken: LEASE,
	ts: TS,
	nonce: NONCE,
	body: BODY,
};
const ours = signPayload(SECRET, payload);
assert.equal(ours, coreSignPayload(SECRET, payload), "CLI wrapper and pure core share one signer");
const worker = await workerSignPayload(SECRET, payload);
assert.equal(ours, worker, "worker and box signatures match for the fixed vector");
assert.deepEqual([...canonicalBytes(payload)], [...await workerCanonicalBytes(payload)], "canonical bytes match");
assert.deepEqual([...coreCanonicalBytes(payload)], [...canonicalBytes(payload)], "core and CLI canonical bytes match");

const headers = signedHeaders(payload);
assert.equal(headers["X-CC-Kid"], "current", "the v1 signer emits only the current key id");
const valid = await verifyWorkerRequest(requestFor(headers), env(new NonceDb()));
assert.equal(valid.ok, true, "a valid signed request is accepted");
assert.equal(valid.jobId, JOB_ID);
assert.equal(valid.leaseToken, LEASE);

// Retired key ids are rejected before nonce consumption; there is no fallback
// key rotation path in the hosted v1 worker.
const retiredDb = new NonceDb();
const retired = await verifyWorkerRequest(
	requestFor({ ...headers, "X-CC-Kid": "prev" }),
	env(retiredDb),
);
assert.equal(retired.ok, false);
assert.equal(retired.status, 401);
assert.equal(retired.error, "unknown_key");
assert.equal(retiredDb.seen.size, 0, "a retired-key rejection does not consume a nonce");

const skewHeaders = signedHeaders({
	...payload,
	ts: Date.now() - 10 * 60_000,
	nonce: "22".repeat(32),
});
const skewDb = new NonceDb();
const skew = await verifyWorkerRequest(requestFor(skewHeaders), env(skewDb));
assert.equal(skew.ok, false);
assert.equal(skew.error, "skew", "timestamps outside the policy window are rejected");
assert.equal(skewDb.seen.size, 0, "skew rejection does not consume a nonce");

const replayDb = new NonceDb();
const replayHeaders = signedHeaders({ ...payload, nonce: "33".repeat(32) });
assert.equal((await verifyWorkerRequest(requestFor(replayHeaders), env(replayDb))).ok, true);
const replay = await verifyWorkerRequest(requestFor(replayHeaders), env(replayDb));
assert.equal(replay.ok, false);
assert.equal(replay.error, "replay", "a nonce is consumed exactly once");

for (const [name, value] of [
	["X-CC-Nonce", "44".repeat(32)],
	["X-CC-Job-Id", "job-other"],
	["X-CC-Lease", "lease-other"],
	["X-CC-Worker-Id", "worker-other"],
]) {
	const changed = { ...headers, [name]: value };
	const result = await verifyWorkerRequest(requestFor(changed), env(new NonceDb()));
	assert.equal(result.ok, false, `${name} replacement cannot reuse a captured signature`);
	assert.equal(result.error, "bad_signature");
}

console.log("demo worker signing checks PASS");

