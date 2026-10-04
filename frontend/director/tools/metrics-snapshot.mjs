#!/usr/bin/env node
/**
 * Snapshot GitHub traffic + repo stats + npm downloads into JSONL ledgers.
 *
 * GitHub's traffic API only keeps 14 days, so this must run on a schedule
 * (.github/workflows/metrics.yml) to build a permanent time series. Rows are
 * deduped by date so overlapping 14-day windows never double-count.
 *
 * Usage: GITHUB_TOKEN=... node tools/metrics-snapshot.mjs <output-dir>
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.METRICS_REPO || "NomaDamas/CozyClay";
const NPM_PACKAGE = process.env.METRICS_NPM_PACKAGE || "cozyclay";
const outDir = process.argv[2];
if (!outDir) {
	console.error("usage: node tools/metrics-snapshot.mjs <output-dir>");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const token = process.env.GITHUB_TOKEN;
if (!token) {
	console.error("GITHUB_TOKEN is required (traffic API needs push access)");
	process.exit(2);
}

async function github(path) {
	const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
		headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
	});
	if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
	return res.json();
}

function loadRows(file) {
	if (!existsSync(file)) return new Map();
	const rows = new Map();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const row = JSON.parse(line);
		rows.set(row.date, row);
	}
	return rows;
}

function saveRows(file, rows) {
	const sorted = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
	writeFileSync(file, sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
	return sorted.length;
}

const today = new Date().toISOString().slice(0, 10);

// 1) Daily traffic (views + clones), deduped by date. Today's partial day is
// excluded so a later run can record the complete figure.
const [views, clones] = await Promise.all([github("/traffic/views"), github("/traffic/clones")]);
const trafficFile = join(outDir, "traffic-daily.jsonl");
const traffic = loadRows(trafficFile);
const byDate = new Map();
for (const v of views.views ?? []) {
	byDate.set(v.timestamp.slice(0, 10), { views: v.count, view_uniques: v.uniques });
}
for (const c of clones.clones ?? []) {
	const date = c.timestamp.slice(0, 10);
	byDate.set(date, { ...byDate.get(date), clones: c.count, clone_uniques: c.uniques });
}
let added = 0;
for (const [date, row] of byDate) {
	if (date >= today) continue;
	if (!traffic.has(date)) added += 1;
	traffic.set(date, { date, views: 0, view_uniques: 0, clones: 0, clone_uniques: 0, ...traffic.get(date), ...row });
}
const trafficTotal = saveRows(trafficFile, traffic);

// 2) Point-in-time repo stats + weekly npm downloads, one row per run date.
const repo = await github("");
let npm = null;
try {
	const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`);
	if (res.ok) npm = await res.json();
} catch {
	// npm stats are best effort.
}
const statsFile = join(outDir, "repo-stats.jsonl");
const stats = loadRows(statsFile);
stats.set(today, {
	date: today,
	stars: repo.stargazers_count,
	forks: repo.forks_count,
	watchers: repo.subscribers_count,
	open_issues: repo.open_issues_count,
	npm_weekly_downloads: npm?.downloads ?? null,
});
const statsTotal = saveRows(statsFile, stats);

console.log(`traffic-daily: +${added} new day(s), ${trafficTotal} total; repo-stats: ${statsTotal} snapshot(s)`);
