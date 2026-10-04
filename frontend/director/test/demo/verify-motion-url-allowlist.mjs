/**
 * verify-motion-url-allowlist.mjs - the `?motion=` query gate.
 *
 * `motionUrlFromQuery` is the security boundary that keeps a hosted-demo
 * result link (`/app/?motion=<url>`) from turning into an arbitrary-fetch
 * primitive. These cases pin the allowlist semantics: same-origin paths and
 * https on allowlisted hosts pass; everything else is null.
 */
import assert from "node:assert/strict";
import { MOTION_URL_ALLOWED_HOSTS, motionUrlFromQuery } from "../../src/ardy/motion-url.js";

const ORIGIN = "https://cozyclay.org";
const q = (url) => `?motion=${encodeURIComponent(url)}`;

// The allowlist itself is part of the contract: the demo API host only.
assert.deepEqual(MOTION_URL_ALLOWED_HOSTS, ["api.cozyclay.org"]);

// 1. Same-origin relative path passes and stays origin-portable.
assert.equal(motionUrlFromQuery(q("/demo/walk-then-stop.npz"), ORIGIN), "/demo/walk-then-stop.npz");
// ...including under the http dev origin.
assert.equal(motionUrlFromQuery(q("/demo/walk-then-stop.npz"), "http://127.0.0.1:5180"), "/demo/walk-then-stop.npz");

// 2. Allowlisted https host passes verbatim.
assert.equal(
	motionUrlFromQuery(q("https://api.cozyclay.org/r/tok123.npz"), ORIGIN),
	"https://api.cozyclay.org/r/tok123.npz",
);

// 3. Non-allowlisted host is rejected.
assert.equal(motionUrlFromQuery(q("https://evil.example/x.npz"), ORIGIN), null);

// 4. http: downgrade is rejected even for the allowlisted host.
assert.equal(motionUrlFromQuery(q("http://api.cozyclay.org/r/tok123.npz"), ORIGIN), null);

// 5. javascript: never reaches fetch.
assert.equal(motionUrlFromQuery(q("javascript:alert(1)"), ORIGIN), null);

// 6. Protocol-relative //host resolves cross-origin and is rejected.
assert.equal(motionUrlFromQuery(q("//evil.example/x.npz"), ORIGIN), null);

// 7. Userinfo-disguised host is rejected, even when the fake "host" text is
//    the allowlisted one and even on the page's own origin.
assert.equal(motionUrlFromQuery(q("https://api.cozyclay.org@evil.example/x.npz"), ORIGIN), null);
const credentialUrl = new URL('https://cozyclay.org/x.npz'); credentialUrl.username = 'user'; credentialUrl.password = 'pw';
assert.equal(motionUrlFromQuery(q(credentialUrl.href), ORIGIN), null);

// Absent/empty/malformed inputs are a quiet null, never a throw.
assert.equal(motionUrlFromQuery("", ORIGIN), null);
assert.equal(motionUrlFromQuery("?motion=", ORIGIN), null);
assert.equal(motionUrlFromQuery(undefined, ORIGIN), null);
assert.equal(motionUrlFromQuery("?other=1", ORIGIN), null);

// A non-standard port makes `host` differ from the allowlist entry.
assert.equal(motionUrlFromQuery(q("https://api.cozyclay.org:8443/r/x.npz"), ORIGIN), null);

// Same-origin query strings survive (path + search form).
assert.equal(motionUrlFromQuery(q("/demo/a.npz?v=2"), ORIGIN), "/demo/a.npz?v=2");

console.log("PASS verify-motion-url-allowlist");
