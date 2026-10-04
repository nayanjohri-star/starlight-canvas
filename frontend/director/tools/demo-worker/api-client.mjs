/**
 * Outbound-only client for the Workers demo queue.
 *
 * Every request is signed immediately before fetch. No server, socket, or
 * long-lived connection is created here; the worker only opens connections
 * initiated by fetch().
 */

import { bodyBytes, randomNonce, signedHeaders } from "./sign-core.mjs";

export class DemoApiError extends Error {
	constructor(status, code, body = null) {
		super(`demo API ${status}${code ? ` ${code}` : ""}`);
		this.name = "DemoApiError";
		this.status = status;
		this.code = code || `http_${status}`;
		this.body = body;
	}
}

function pathFor(url) {
	return `${url.pathname}${url.search}`;
}

function normalizeBase(value) {
	if (!value) throw new TypeError("CC_DEMO_API_BASE is required");
	const base = new URL(String(value));
	// URL(base, path) treats a pathless URL as a file. A trailing slash makes
	// both `https://host` and an explicitly configured `/api/` prefix behave
	// predictably.
	if (!base.pathname.endsWith("/")) base.pathname += "/";
	return base;
}

async function responseBody(response) {
	if (response.status === 204) return null;
	if (typeof response.text !== "function") {
		if (typeof response.json === "function") return response.json();
		return null;
	}
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function errorCode(body, status) {
	if (body && typeof body === "object") return body.error ?? body.code ?? body.reason ?? `http_${status}`;
	if (typeof body === "string" && body) return body;
	return `http_${status}`;
}

function asJob(body) {
	if (!body || typeof body !== "object") return body;
	const jobId = body.jobId ?? body.job_id;
	const leaseToken = body.leaseToken ?? body.lease_token;
	const leaseExpiresAt = body.leaseExpiresAt ?? body.lease_expires_at;
	const duration = body.duration ?? body.durationS ?? body.duration_s;
	return {
		...body,
		jobId,
		job_id: body.job_id ?? jobId,
		leaseToken,
		lease_token: body.lease_token ?? leaseToken,
		leaseExpiresAt,
		lease_expires_at: body.lease_expires_at ?? leaseExpiresAt,
		duration,
		durationS: body.durationS ?? duration,
	};
}

/**
 * The API surface is intentionally small and mirrors the four Worker routes.
 * `fetchImpl`, `now`, and `nonceFactory` are injectable to make protocol tests
 * deterministic without changing production behavior.
 */
export class DemoApiClient {
	constructor({
		baseUrl = process.env.CC_DEMO_API_BASE,
		base,
		secret,
		workerId = process.env.CC_WORKER_ID,
		fetchImpl = globalThis.fetch,
		fetch: fetchOverride,
		now = () => Date.now(),
		nonceFactory = randomNonce,
	} = {}) {
		this.baseUrl = normalizeBase(baseUrl ?? base);
		this.secret = secret ?? process.env.CC_WORKER_SECRET;
		this.workerId = workerId;
		this.fetchImpl = fetchOverride || fetchImpl;
		this.now = typeof now === "function" ? now : () => Number(now);
		this.nonceFactory = typeof nonceFactory === "function" ? nonceFactory : () => String(nonceFactory);
		if (typeof this.fetchImpl !== "function") throw new TypeError("global fetch is unavailable");
		if (!this.secret) throw new TypeError("CC_WORKER_SECRET is required");
		if (!this.workerId) throw new TypeError("CC_WORKER_ID is required");
	}

	urlFor(path) {
		const value = String(path || "/");
		return new URL(value.startsWith("/") ? value.slice(1) : value, this.baseUrl);
	}

	signRequest({ method = "GET", path = "/", body = new Uint8Array(), jobId = "", leaseToken = "", ts, nonce } = {}) {
		return signedHeaders({
			secret: this.secret,
			workerId: this.workerId,
			method,
			path,
			jobId,
			leaseToken,
			body,
			ts: ts ?? this.now(),
			nonce: nonce ?? this.nonceFactory(),
		});
	}

	async request(method, path, {
		jobId = "",
		leaseToken = "",
		body = new Uint8Array(),
		contentType = null,
		signal,
	} = {}) {
		const url = this.urlFor(path);
		const bytes = bodyBytes(body);
		const headers = this.signRequest({
			method,
			path: pathFor(url),
			jobId,
			leaseToken,
			body: bytes,
		});
		if (contentType) headers["Content-Type"] = contentType;
		if (bytes.byteLength > 0 || method !== "GET") headers["Content-Length"] = String(bytes.byteLength);
		const init = {
			method: String(method).toUpperCase(),
			headers,
			signal,
		};
		// Undici rejects a GET/HEAD request with a body. An empty POST is valid
		// without an explicit body and still hashes as SHA-256(empty).
		if (bytes.byteLength > 0) init.body = Buffer.from(bytes);
		const response = await this.fetchImpl(url.toString(), init);
		const bodyValue = await responseBody(response);
		const ok = response.ok ?? (response.status >= 200 && response.status < 300);
		if (!ok) throw new DemoApiError(response.status, errorCode(bodyValue, response.status), bodyValue);
		return bodyValue;
	}

	async next({ signal } = {}) {
		const body = await this.request("GET", "/worker/next", { signal });
		return body == null ? null : asJob(body);
	}

	async complete(jobId, leaseToken, npzBuffer, { signal } = {}) {
		if (!jobId || !leaseToken) throw new TypeError("jobId and leaseToken are required");
		const bytes = bodyBytes(npzBuffer);
		return this.request("POST", "/worker/complete", {
			jobId,
			leaseToken,
			body: bytes,
			contentType: "application/octet-stream",
			signal,
		});
	}

	async fail(jobId, leaseToken, reason = "worker_failed", { signal } = {}) {
		if (!jobId || !leaseToken) throw new TypeError("jobId and leaseToken are required");
		const body = Buffer.from(JSON.stringify({ reason: String(reason || "worker_failed") }));
		return this.request("POST", "/worker/fail", {
			jobId,
			leaseToken,
			body,
			contentType: "application/json",
			signal,
		});
	}

	async heartbeat(jobId, leaseToken, { jobsDone10m = 0, signal } = {}) {
		if (!jobId || !leaseToken) throw new TypeError("jobId and leaseToken are required");
		// The route accepts an empty body. Keeping it empty makes the canonical
		// request-target/body hash unambiguous while still allowing an optional
		// throughput counter for operators that use it.
		const body = jobsDone10m
			? Buffer.from(JSON.stringify({ jobs_done_10m: Number(jobsDone10m) }))
			: new Uint8Array();
		return this.request("POST", "/worker/heartbeat", {
			jobId,
			leaseToken,
			body,
			contentType: body.byteLength ? "application/json" : null,
			signal,
		});
	}
}

export const ApiClient = DemoApiClient;

export function createApiClient(options = {}) {
	return new DemoApiClient(options);
}

export const createDemoApiClient = createApiClient;

let defaultClient = null;
function envClient() {
	if (!defaultClient) defaultClient = createApiClient();
	return defaultClient;
}

export function next(options) {
	return envClient().next(options);
}

export function complete(jobId, leaseToken, npzBuffer, options) {
	return envClient().complete(jobId, leaseToken, npzBuffer, options);
}

export function fail(jobId, leaseToken, reason, options) {
	return envClient().fail(jobId, leaseToken, reason, options);
}

export function heartbeat(jobId, leaseToken, options) {
	return envClient().heartbeat(jobId, leaseToken, options);
}

export function signRequest(secretOrOptions, maybeOptions) {
	if (typeof secretOrOptions === "string") {
		return signedHeaders({ ...(maybeOptions || {}), secret: secretOrOptions });
	}
	return signedHeaders(secretOrOptions);
}

export default createApiClient;

