#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildH3LockedPrompt } from "../../bin/agent/video-adapters.mjs";

export const FAL_MODEL = "minimax/h3-max-turbo/image-to-video";
export function falRequest({ prompt, firstImage, lastImage }) {
	if (!String(prompt ?? "").trim() || !firstImage || !lastImage) throw new Error("prompt and both endpoint images are required");
	// H3's documented contract has no seed field: independent requests, not
	// a claimed deterministic seed sweep. Do not silently send ignored seeds.
	return { prompt: buildH3LockedPrompt(prompt), image_url: firstImage, end_image_url: lastImage, resolution: "480P", duration: 5, prompt_expansion_mode: "disabled" };
}
export function costFields(value) {
	if (!value || typeof value !== "object") return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (/cost|price|billing|usage/i.test(key)) out[key] = entry;
		else if (entry && typeof entry === "object") { const nested = costFields(entry); if (Object.keys(nested).length) out[key] = nested; }
	}
	return out;
}
/** Unbounded queue wait, finite individual HTTP requests. Every response is
 * logged by the caller. Test injects fetch + wait, never wall-clock polling. */
export async function runFal(body, { key, fetchImpl = fetch, wait = () => delay(5000), onEvent = () => {} }) {
	if (!key) throw new Error("fal key is required");
	const request = async (url, options = {}) => {
		const response = await fetchImpl(url, { ...options, headers: { authorization: `Key ${key}`, ...options.headers }, signal: AbortSignal.timeout(120000) });
		if (!response.ok) throw new Error(`fal HTTP ${response.status} at ${new URL(url).pathname}`);
		const value = await response.json(); onEvent({ at: new Date().toISOString(), url, response: value, cost: costFields(value) }); return value;
	};
	const queued = await request(`https://queue.fal.run/${FAL_MODEL}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	let status = queued;
	for (;;) {
		const video = status.video?.url ?? status.output?.video?.url ?? status.video_url;
		if (video) return { queued, result: status, video };
		if (["FAILED", "CANCELLED"].includes(status.status)) throw new Error(`fal ${status.status}: ${status.error ?? "no error detail"}`);
		if (status.status === "COMPLETED") {
			const url = status.response_url ?? queued.response_url;
			if (!url) throw new Error("fal completed without response_url");
			status = await request(url);
			if (!(status.video?.url ?? status.output?.video?.url ?? status.video_url)) throw new Error("fal completed without video URL");
			continue;
		}
		const url = status.status_url ?? queued.status_url;
		if (!url) throw new Error("fal queue response lacks status_url");
		await wait(); status = await request(url);
	}
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export async function main(argv = process.argv.slice(2)) {
	const { values: v } = parseArgs({ args: argv, options: { scenario: { type: "string" }, variant: { type: "string", default: "shaded" }, out: { type: "string" }, prompt: { type: "string" }, key: { type: "string" }, runs: { type: "string", default: "3" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } } });
	if (v.help) { console.log("usage: node tools/bench/fal-generate.mjs --scenario <GT motion dir> --out <clips root> [--prompt <action>] [--key <file>] [--runs 3] [--variant shaded|skin] [--dry-run]\nReads scenario.json prompt or --prompt; writes <out>/<scenario>-<variant>-01/{video.mp4,request.json,A.png,B.png}. No seed is sent (independent H3 requests)."); return; }
	if (!v.scenario || !v.out) throw new Error("--scenario and --out required");
	const runs = Number(v.runs); if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
	if (!["shaded", "skin"].includes(v.variant)) throw new Error("--variant must be shaded or skin");
	const scenario = resolve(v.scenario), name = basename(scenario), source = join(scenario, v.variant);
	const meta = JSON.parse(readFileSync(join(source, "meta.json"))), info = existsSync(join(scenario, "scenario.json")) ? JSON.parse(readFileSync(join(scenario, "scenario.json"))) : {};
	const prompt = v.prompt ?? info.prompt;
	const still = frame => execFileSync("ffmpeg", ["-v", "error", "-i", join(source, "video.mp4"), "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { maxBuffer: 10 * 1024 * 1024 });
	const a = still(0), b = still(meta.frames - 1);
	if (!a.length || !b.length) throw new Error("missing endpoint frame");
	const body = falRequest({ prompt, firstImage: `data:image/png;base64,${a.toString("base64")}`, lastImage: `data:image/png;base64,${b.toString("base64")}` });
	const keyPath = v.key ?? resolve(process.env.HOME, "ccFalToMocap/.fal-key");
	const dry = v["dry-run"] || !existsSync(keyPath);
	const key = dry ? null : readFileSync(keyPath, "utf8").trim();
	for (let i = 1; i <= runs; i++) {
		const dir = join(resolve(v.out), `${name}-${v.variant}-${String(i).padStart(2, "0")}`); mkdirSync(dir, { recursive: true });
		const recordPath = join(dir, "request.json");
		if (existsSync(recordPath) && JSON.parse(readFileSync(recordPath)).ok && existsSync(join(dir, "video.mp4"))) { console.log(`skip completed ${basename(dir)}`); continue; }
		writeFileSync(join(dir, "A.png"), a); writeFileSync(join(dir, "B.png"), b);
		const record = { model: FAL_MODEL, scenario, variant: v.variant, run: i, independentRun: true, seed: null, dryRun: dry, ok: false, body: { ...body, image_url: "A.png", end_image_url: "B.png" }, endpoints: { A: sha(a), B: sha(b), sourceFrames: [0, meta.frames - 1] }, events: [], cost: null };
		const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n"); save();
		if (dry) { console.log(`dry-run ${basename(dir)}: ${v["dry-run"] ? "requested" : "key missing"}`); continue; }
		try {
			const result = await runFal(body, { key, onEvent: event => { record.events.push(event); save(); console.log(`[${basename(dir)}] ${event.response.status ?? "result"} ${event.response.request_id ?? ""}`); } });
			const response = await fetch(result.video, { signal: AbortSignal.timeout(300000) }); if (!response.ok) throw new Error(`video HTTP ${response.status}`);
			writeFileSync(join(dir, "video.mp4"), Buffer.from(await response.arrayBuffer()));
			record.ok = true; record.requestId = result.queued.request_id; record.result = result.result;
			record.cost = record.events.map(e => e.cost).filter(c => Object.keys(c).length); record.costNote = record.cost.length ? "Provider-reported fields, not estimated." : "Provider supplied no cost fields; unknown, not zero.";
		} catch (error) { record.error = error.message; throw error; } finally { save(); }
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
