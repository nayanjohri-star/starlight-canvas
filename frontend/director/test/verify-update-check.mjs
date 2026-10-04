#!/usr/bin/env node
/**
 * The update notice, without the registry.
 *
 * Two things can go wrong here and both are silent in the wild: telling people
 * about a version that is not newer, and hammering registry.npmjs.org on every
 * launch because the cache never takes. So the version compare is exercised
 * directly and every network path runs against a local mock over
 * COZYCLAY_REGISTRY_URL, with a request counter to prove when a fetch did and
 * did not happen. No fixed sleeps, no real network: this passes offline.
 *
 * Run: `npm run test:update-check`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkForUpdate, compareVersions } from "../bin/update-check.mjs";

function pass(message) {
	console.log(`PASS ${message}`);
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const stateDir = mkdtempSync(join(tmpdir(), "cozyclay-update-check-"));
const cacheFile = join(stateDir, "update-check.json");

/* ------------------------------------------------------ the mock npm ---- */

/** What the next GET answers with, and how many GETs there have been. */
const registry = { body: JSON.stringify({ version: "9.9.9" }), status: 200, requests: 0 };

const server = createServer((req, res) => {
	registry.requests += 1;
	res.writeHead(registry.status, { "content-type": "application/json" });
	res.end(registry.body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const registryUrl = `http://127.0.0.1:${server.address().port}/cozyclay/latest`;

/** A port nobody is listening on, so the fetch is refused rather than slow. */
const deadServer = createServer(() => {});
await new Promise((resolve) => deadServer.listen(0, "127.0.0.1", resolve));
const deadUrl = `http://127.0.0.1:${deadServer.address().port}/cozyclay/latest`;
await new Promise((resolve) => deadServer.close(resolve));

function clearCache() {
	rmSync(cacheFile, { force: true });
}

/** Runs one case with a known registry URL and a fresh request count. */
async function check(currentVersion, { url = registryUrl } = {}) {
	process.env.COZYCLAY_REGISTRY_URL = url;
	registry.requests = 0;
	return await checkForUpdate(currentVersion, stateDir);
}

try {
	/* --------------------------------------------------- compareVersions ---- */

	assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
	assert.equal(compareVersions("1.2.4", "1.2.3"), 1);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
	assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "10 beats 9 numerically, not alphabetically");
	assert.equal(compareVersions("1.3", "1.3.0"), 0, "a missing patch reads as zero");
	assert.equal(compareVersions("1.3.1", "1.3"), 1);
	pass("compareVersions orders older, newer, and equal releases");

	assert.equal(compareVersions("1.4.0-beta.1", "1.4.0"), -1, "a prerelease loses to its own release");
	assert.equal(compareVersions("1.4.0", "1.4.0-beta.1"), 1);
	assert.equal(compareVersions("1.4.0-beta.1", "1.4.0-beta.1"), 0);
	assert.equal(compareVersions("1.4.0-alpha.1", "1.4.0-beta.1"), -1);
	assert.equal(compareVersions("1.4.0-beta.1", "1.3.9"), 1, "a prerelease still beats an older release");
	pass("compareVersions ranks prereleases below their release and against each other");

	assert.equal(compareVersions("", ""), 0);
	assert.equal(compareVersions("not-a-version", "0.0.0"), -1, "unparseable cores read as 0 and keep their prerelease tag");
	assert.equal(compareVersions("1.x.3", "1.0.3"), 0, "a garbage segment reads as zero rather than NaN");
	assert.equal(compareVersions(" 1.2.3 ", "1.2.3"), 0, "surrounding whitespace is trimmed");
	assert.equal(compareVersions(undefined, "0.0.0"), 0);
	assert.equal(compareVersions(null, "1.0.0"), -1);
	assert.ok(Number.isFinite(compareVersions({}, [])), "non-strings never produce NaN");
	pass("compareVersions survives malformed input without throwing or returning NaN");

	/* ---------------------------------------------------- checkForUpdate ---- */

	clearCache();
	registry.body = JSON.stringify({ version: "9.9.9" });
	assert.equal(await check("1.3.0"), "9.9.9", "a newer registry version is reported");
	assert.equal(registry.requests, 1);
	const written = JSON.parse(readFileSync(cacheFile, "utf8"));
	assert.equal(written.latest, "9.9.9");
	assert.ok(Number.isFinite(written.checkedAt));
	pass("checkForUpdate reports a newer published version and caches it");

	clearCache();
	registry.body = JSON.stringify({ version: "1.3.0" });
	assert.equal(await check("1.3.0"), null, "the same version is not news");
	assert.equal(registry.requests, 1);
	clearCache();
	registry.body = JSON.stringify({ version: "1.2.0" });
	assert.equal(await check("1.3.0"), null, "an older registry version is not news");
	pass("checkForUpdate stays quiet when the registry is level with or behind us");

	clearCache();
	registry.body = JSON.stringify({ version: "9.9.9" });
	await check("1.3.0");
	registry.body = JSON.stringify({ version: "1.0.0" });
	assert.equal(await check("1.3.0"), "9.9.9", "a fresh cache answers without asking the registry");
	assert.equal(registry.requests, 0, "no request within the TTL");
	pass("checkForUpdate serves a cache hit inside the 24h TTL without refetching");

	writeFileSync(cacheFile, JSON.stringify({ latest: "1.0.0", checkedAt: Date.now() - CACHE_TTL_MS - 1000 }));
	registry.body = JSON.stringify({ version: "9.9.9" });
	assert.equal(await check("1.3.0"), "9.9.9", "a stale cache is replaced by a live answer");
	assert.equal(registry.requests, 1);
	assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).latest, "9.9.9");
	pass("checkForUpdate refetches once the cached entry is older than the TTL");

	writeFileSync(cacheFile, "{ this is not json");
	registry.body = JSON.stringify({ version: "9.9.9" });
	assert.equal(await check("1.3.0"), "9.9.9");
	assert.equal(registry.requests, 1);
	writeFileSync(cacheFile, JSON.stringify({ latest: "9.9.9", checkedAt: "yesterday" }));
	registry.requests = 0;
	assert.equal(await check("1.3.0"), "9.9.9");
	assert.equal(registry.requests, 1, "a cache without a usable timestamp is refetched, not trusted");
	pass("checkForUpdate refetches through a corrupt or timestamp-less cache file");

	clearCache();
	assert.equal(await check("1.3.0", { url: deadUrl }), null, "an unreachable registry says nothing");
	pass("checkForUpdate returns null on an unreachable registry instead of throwing");

	clearCache();
	registry.status = 503;
	registry.body = "upstream is having a day";
	assert.equal(await check("1.3.0"), null);
	assert.equal(existsSync(cacheFile), false, "a failed check must not poison the cache");
	registry.status = 200;
	pass("checkForUpdate returns null on a registry error response and caches nothing");

	clearCache();
	registry.body = "<html>proxy login</html>";
	assert.equal(await check("1.3.0"), null, "an unparseable body is not a version");
	clearCache();
	registry.body = JSON.stringify({ name: "cozyclay" });
	assert.equal(await check("1.3.0"), null, "a payload with no version string is not a version");
	clearCache();
	registry.body = JSON.stringify({ version: 999 });
	assert.equal(await check("1.3.0"), null, "a non-string version is ignored");
	pass("checkForUpdate ignores junk, versionless, and non-string registry payloads");

	clearCache();
	registry.body = JSON.stringify({ version: "9.9.9" });
	assert.equal(await check("1.3.0", { url: "not a url" }), null);
	pass("checkForUpdate returns null when the registry URL itself is unusable");

	console.log("all Cozy Clay update-check checks PASS");
} finally {
	delete process.env.COZYCLAY_REGISTRY_URL;
	await new Promise((resolve) => server.close(resolve));
	rmSync(stateDir, { recursive: true, force: true });
}
