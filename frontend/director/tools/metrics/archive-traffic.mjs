#!/usr/bin/env node
// Archive GitHub repository traffic into .metrics/.
//
// GitHub keeps traffic for 14 days. That is shorter than the time it takes to
// tell whether a launch worked, so this snapshots the numbers and merges them
// into a permanent time series.
//
// The traffic endpoints need repository admin rights, which the Actions
// GITHUB_TOKEN does not have. So this runs wherever a real credential lives:
// pass one in GITHUB_TOKEN / GH_TOKEN, or let it fall back to the token git
// already stores for github.com.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const REPO = process.env.TRAFFIC_REPO ?? "NomaDamas/CozyClay";
const OUT = path.resolve(process.env.TRAFFIC_OUT ?? ".metrics");

async function resolveToken() {
	const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (fromEnv) return fromEnv;

	// git credential fill speaks a key=value protocol on stdin/stdout, and it
	// blocks until stdin is closed — so the request has to be written and the
	// pipe ended explicitly.
	const stdout = await new Promise((resolve) => {
		const child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		const done = (value) => resolve(value);
		const timer = setTimeout(() => {
			child.kill();
			done("");
		}, 10_000);
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("error", () => {
			clearTimeout(timer);
			done("");
		});
		child.on("close", () => {
			clearTimeout(timer);
			done(out);
		});
		child.stdin.end(`protocol=https\nhost=github.com\npath=${REPO}.git\n\n`);
	});

	const line = stdout.split("\n").find((l) => l.startsWith("password="));
	if (!line) throw new Error("no GitHub token: set GITHUB_TOKEN or sign in to git");
	return line.slice("password=".length);
}

async function api(token, endpoint) {
	const res = await fetch(`https://api.github.com/repos/${REPO}/traffic/${endpoint}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`${endpoint} -> ${res.status}: ${body.slice(0, 200)}`);
	}
	return res.json();
}

async function readJson(file, fallback) {
	const p = path.join(OUT, file);
	if (!existsSync(p)) return fallback;
	try {
		return JSON.parse(await readFile(p, "utf8"));
	} catch {
		return fallback;
	}
}

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

async function writeJson(file, data) {
	await writeFile(path.join(OUT, file), JSON.stringify(sortKeys(data), null, 2) + "\n");
}

const token = await resolveToken();
await mkdir(OUT, { recursive: true });

const [views, clones, referrers, paths] = await Promise.all([
	api(token, "views"),
	api(token, "clones"),
	api(token, "popular/referrers"),
	api(token, "popular/paths"),
]);

// Daily counts are keyed by date, so re-running the same day corrects the row
// instead of appending a duplicate.
const daily = await readJson("daily.json", {});
for (const [kind, payload] of [
	["views", views],
	["clones", clones],
]) {
	for (const row of payload[kind] ?? []) {
		const day = row.timestamp.slice(0, 10);
		daily[day] ??= {};
		daily[day][kind] = row.count;
		daily[day][`${kind}_uniques`] = row.uniques;
	}
}
await writeJson("daily.json", daily);

// Referrers and paths are 14-day rollups on GitHub's side, not per-day values,
// so they are kept as dated snapshots rather than merged.
const today = new Date().toISOString().slice(0, 10);
for (const [file, payload] of [
	["referrers.json", referrers],
	["paths.json", paths],
]) {
	const history = await readJson(file, {});
	history[today] = payload;
	await writeJson(file, history);
}

const rows = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b));
await writeFile(
	path.join(OUT, "daily.csv"),
	["date,views,views_uniques,clones,clones_uniques"]
		.concat(
			rows.map(([day, v]) =>
				[day, v.views ?? "", v.views_uniques ?? "", v.clones ?? "", v.clones_uniques ?? ""].join(","),
			),
		)
		.join("\n") + "\n",
);

const totalViews = rows.reduce((sum, [, v]) => sum + (v.views ?? 0), 0);
console.log(
	`archived ${rows.length} days (${totalViews} views total) · top referrer: ` +
		`${referrers[0]?.referrer ?? "none"} (${referrers[0]?.uniques ?? 0} uniques)`,
);
