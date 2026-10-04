/**
 * Pure HMAC v1 signing primitives.
 *
 * This file intentionally has no network, process, or filesystem behavior.
 * The CLI wrapper is sign.mjs; api-client.mjs imports this module directly so
 * protocol tests and production requests cannot drift.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

const textEncoder = new TextEncoder();

function isArrayBufferView(value) {
	return value != null && ArrayBuffer.isView(value);
}

export function bodyBytes(value) {
	if (value == null) return new Uint8Array();
	if (value instanceof Uint8Array) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (isArrayBufferView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return textEncoder.encode(String(value));
}

export function digestHex(value) {
	return createHash("sha256").update(bodyBytes(value)).digest("hex");
}

function payloadField(payload, camel, snake = camel) {
	return payload?.[camel] ?? payload?.[snake] ?? "";
}

export function canonicalBytes(payload = {}) {
	const body = bodyBytes(payload.body ?? payload.rawBody);
	const canonical = [
		"v1",
		String(payloadField(payload, "workerId", "worker_id")),
		String(payload.ts ?? ""),
		String(payload.nonce ?? ""),
		String(payload.method ?? "GET").toUpperCase(),
		String(payload.path ?? "/"),
		String(payloadField(payload, "jobId", "job_id")),
		String(payloadField(payload, "leaseToken", "lease_token")),
		digestHex(body),
	].join("\n");
	return textEncoder.encode(canonical);
}

export function canonicalString(payload = {}) {
	return new TextDecoder().decode(canonicalBytes(payload));
}

export function toBase64Url(bytes) {
	return Buffer.from(bytes).toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

export function signPayload(secretOrPayload, maybePayload) {
	const payload = typeof secretOrPayload === "string" ? (maybePayload ?? {}) : (secretOrPayload ?? {});
	const secret = typeof secretOrPayload === "string"
		? secretOrPayload
		: typeof maybePayload === "string"
			? maybePayload
			: payload.secret;
	if (!secret) throw new TypeError("worker secret is required");
	return toBase64Url(createHmac("sha256", String(secret)).update(canonicalBytes(payload)).digest());
}

export function randomNonce() {
	return randomBytes(32).toString("hex");
}

export function signedHeaders({
	secret,
	workerId,
	method = "GET",
	path = "/",
	body = new Uint8Array(),
	jobId = "",
	leaseToken = "",
	ts = Date.now(),
	nonce = randomNonce(),
} = {}) {
	if (!secret) throw new TypeError("worker secret is required");
	if (!workerId) throw new TypeError("worker id is required");
	const signature = signPayload(secret, {
		workerId,
		method,
		path,
		body,
		jobId,
		leaseToken,
		ts,
		nonce,
	});
	return {
		"X-CC-Worker-Id": String(workerId),
		"X-CC-Ts": String(ts),
		"X-CC-Nonce": String(nonce),
		"X-CC-Job-Id": String(jobId),
		"X-CC-Lease": String(leaseToken),
		"X-CC-Kid": "current",
		"X-CC-Sig": signature,
	};
}

export const signRequest = signedHeaders;

