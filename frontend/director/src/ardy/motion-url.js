/**
 * Query-string gate for externally supplied motion URLs (`/app/?motion=`).
 *
 * The hosted demo hands a visitor a result link that opens the app with a
 * `?motion=<url>` query. That value is attacker-controllable, so it is a
 * security boundary, not a convenience: only same-origin paths and the
 * hosted demo API may ever reach `loadMotionFromUrl`'s fetch. Everything
 * else — foreign hosts, downgraded schemes, `javascript:`, protocol-relative
 * tricks, userinfo-embedded lookalikes — resolves to `null` and the app
 * silently falls back to its normal seed behavior.
 *
 * Kept as a plain module (no React, no DOM) so the allowlist is testable
 * under Node: see test/demo/verify-motion-url-allowlist.mjs.
 */

/** Hosts allowed to serve motion npz files cross-origin, over https only. */
export const MOTION_URL_ALLOWED_HOSTS = ["api.cozyclay.org"];

/**
 * Extract and validate the `motion` query parameter.
 *
 * @param {string} search - a query string (`location.search`)
 * @param {string} origin - the page origin (`location.origin`)
 * @returns {string|null} a same-origin path (`/demo/x.npz`) or an absolute
 *   https URL on an allowlisted host; `null` when absent or not allowed.
 */
export function motionUrlFromQuery(search, origin) {
	let value;
	try {
		value = new URLSearchParams(search ?? "").get("motion");
	} catch {
		return null;
	}
	if (!value) return null;
	let base;
	let parsed;
	try {
		base = new URL(origin);
		parsed = new URL(value, base);
	} catch {
		return null;
	}
	// Userinfo is only ever used to disguise the real host
	// (https://api.cozyclay.org@evil.example/x.npz) — reject it outright,
	// even for the page's own origin.
	if (parsed.username || parsed.password) return null;
	// Same-origin: return the path form so dev (http://127.0.0.1:5180) and
	// production resolve identically.
	if (parsed.origin === base.origin) return parsed.pathname + parsed.search;
	// Cross-origin: https only, exact host match (a non-standard port makes
	// `host` differ from the allowlist entry and is therefore rejected).
	if (parsed.protocol !== "https:") return null;
	if (!MOTION_URL_ALLOWED_HOSTS.includes(parsed.host)) return null;
	return parsed.href;
}
