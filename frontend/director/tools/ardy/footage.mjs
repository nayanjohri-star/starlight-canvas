/**
 * footage.mjs — the bridge's footage-fetch side: platform pages (YouTube,
 * Vimeo, …) serve a player, not a file, and block cross-origin reads, so the
 * BROWSER can never ingest them. This process can: yt-dlp downloads the
 * video stream, ffmpeg locks it to a constant rate (platform video is often
 * VFR — frame numbers would drift against seconds) no higher than extraction
 * can use, and the result is served back over loopback where the ordinary
 * ingest takes over.
 *
 * Same safety posture as motion delivery: served paths come only from an
 * allowlist this process populated, a client disconnect kills the child
 * process group, and every failure is a NAMED reason the UI can act on.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup, track } from "./runners/proc.mjs";
import { createPrivateArtifactDir, removePrivateArtifactDir } from "./artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FOOTAGE_DIR = join(HERE, "out", "footage");
// Normalisation locks the clip to a CONSTANT rate and keeps the source's own
// rate up to the extraction ceiling below: platform video is often VFR (frame
// numbers drift against seconds), but resampling 30 → 24 would drop every 5th
// frame and turn smooth motion into a 4-step-1-jump judder that extraction
// reads as real velocity. The take is retimed to the 24 fps timeline AFTER
// extraction, in rotation space.
const FOOTAGE_FPS_FALLBACK = 30;
const FOOTAGE_FPS_MIN = 10;
const FOOTAGE_FPS_MAX = 60;
// The ceiling extraction is allowed to see. SAM-3D-Body solves every frame
// INDEPENDENTLY and errs a little each time, so twice the rate feeds twice the
// estimation noise per second while the smoothing windows behind it are
// counted in FRAMES and therefore span half as much time. Measured on two
// takes of the same session: a 60 fps / 1632-frame extract trembled 3.36 and
// 3.54 cm at the feet, a 30 fps / 270-frame one 0.60 and 0.72 cm — five times
// the wobble, plus double the GPU cost, for frames a 24 fps timeline can
// never show. Both intake paths clamp here; this is the single edit that
// moves the ceiling.
export const EXTRACT_FPS_MAX = 30;
const FOOTAGE_MAX_S = 900; // 15 min: previs reference, not an archive mirror
const FOOTAGE_MAX_HEIGHT = 1080;
const FOOTAGE_ALLOWLIST_MAX = 16; // newest downloads only; evicted ids 404
const FOOTAGE_ID = /^[0-9]+-[0-9a-f]{6}$/;
// Prefer the Homebrew binaries over whatever shadows them on PATH: a stale
// pip-installed yt-dlp is the classic cause of "The page needs to be
// reloaded" refusals from YouTube, and it sorts FIRST in a default PATH.
function firstExisting(override, candidates, fallback) {
	if (override) return override;
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return fallback;
}
const YTDLP = firstExisting(process.env.CCLAY_YTDLP, ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"], "yt-dlp");
const FFMPEG = firstExisting(process.env.CCLAY_FFMPEG, ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"], "ffmpeg");
const FFPROBE = firstExisting(process.env.CCLAY_FFPROBE, ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"], "ffprobe");
// The default (web) client serves full resolution but hits YouTube's
// "confirm you're not a bot" wall on music/mix content; the android client
// always passes but is capped around 360p. So every yt-dlp call goes web
// first and falls back to android ONLY on that specific refusal — quality
// when possible, availability when not.
const YTDLP_BASE = ["--no-playlist", "--no-warnings"];
const YTDLP_BOTFIX = ["--extractor-args", "youtube:player_client=android"];
// Two ways YouTube refuses the web client: the bot wall up front, or a 403
// on the media URLs partway through a download. Both mean "switch client".
const WEB_CLIENT_REFUSED = /confirm you.re not a bot|HTTP Error 403/i;

const footageAllowlist = new Map(); // id -> absolute mp4 path under FOOTAGE_DIR

/** `[download]  42.3% of ...` -> 0.423; null for any other line. */
export function parseDownloadRatio(line) {
	const match = /\[download\]\s+([\d.]+)%/.exec(line);
	if (!match) return null;
	const percent = Number(match[1]);
	if (!Number.isFinite(percent)) return null;
	return Math.min(1, Math.max(0, percent / 100));
}

/** ffmpeg's `... time=00:00:12.34 ...` against the clip length -> 0..1. */
export function parseEncodeRatio(line, durationS) {
	if (!(durationS > 0)) return null;
	const match = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
	if (!match) return null;
	const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
	if (!Number.isFinite(seconds)) return null;
	return Math.min(1, Math.max(0, seconds / durationS));
}

/** yt-dlp's probe line `"123.45\t29.97\tSome title"` -> { durationS, fps,
 *  title }. A missing/absurd rate falls back to 30 and is clamped to a sane
 *  band — the ffmpeg pass hard-locks whatever rate is returned here. */
export function parseProbeLine(line) {
	const parts = line.split("\t");
	if (parts.length < 3) return null;
	const durationS = Number(parts[0]);
	const rawFps = Number(parts[1]);
	const title = parts.slice(2).join("\t").trim();
	if (!Number.isFinite(durationS) || durationS <= 0) return null;
	const fps = Number.isFinite(rawFps) && rawFps > 0
		? Math.min(FOOTAGE_FPS_MAX, Math.max(FOOTAGE_FPS_MIN, Math.round(rawFps)))
		: FOOTAGE_FPS_FALLBACK;
	return { durationS, fps, title };
}

/**
 * The rate a source of `sourceFps` may be fed to extraction at. Never
 * upsamples — 24 stays 24, 25 stays 25 — because inventing frames invents
 * motion. Above the ceiling it prefers an INTEGER divisor of the source
 * (60→30, 50→25, 48→24, 120→30): dropping every n-th frame keeps the
 * surviving frames exactly as they were shot, while landing on a foreign
 * rate has to duplicate frames at uneven intervals and reads as judder. A
 * rate with no divisor that lands in range (35, 45, …) takes the ceiling
 * itself, and an unreadable rate takes it too — the ceiling is the safe
 * answer, never the source's word.
 */
export function capExtractFps(sourceFps) {
	const fps = Math.round(Number(sourceFps));
	if (!Number.isFinite(fps) || fps <= 0) return EXTRACT_FPS_MAX;
	if (fps <= EXTRACT_FPS_MAX) return fps;
	const divisor = Math.ceil(fps / EXTRACT_FPS_MAX);
	return fps % divisor === 0 ? fps / divisor : EXTRACT_FPS_MAX;
}

/**
 * The one ffmpeg pass both intake paths use: a CONSTANT `fps`, no audio, a
 * faststart mp4. Nothing here touches presentation timestamps as a whole —
 * `fps=N` only drops or repeats frames, so the clip comes out the same
 * length and the same speed it went in.
 */
export function normalizeArgs(inputPath, outputPath, fps) {
	return [
		"-y", "-i", inputPath,
		"-vf", `fps=${fps}`,
		"-an",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
		"-movflags", "+faststart",
		outputPath,
	];
}

/** ffprobe's `key=num/den` block -> { fps, durationS }, either field null when
 *  the file would not say. avg_frame_rate is frames ÷ length over the whole
 *  stream, which is what extraction actually meets; r_frame_rate is only the
 *  container's base tick and reads as 90000 on some VFR muxes, so it is the
 *  fallback, not the answer. */
export function parseProbeStreamInfo(text) {
	const source = typeof text === "string" ? text : "";
	const ratio = (key) => {
		const match = new RegExp(`^${key}=([\\d.]+)(?:/([\\d.]+))?$`, "m").exec(source);
		if (!match) return null;
		const value = match[2] === undefined ? Number(match[1]) : Number(match[1]) / Number(match[2]);
		return Number.isFinite(value) && value > 0 ? value : null;
	};
	return { fps: ratio("avg_frame_rate") ?? ratio("r_frame_rate"), durationS: ratio("duration") };
}

function runCollect(command, args, { children, timeoutMs, onLine }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		children.add(child);
		track(child);
		let out = "";
		let err = "";
		let buffered = "";
		const timer = timeoutMs
			? setTimeout(() => {
				killGroup(child);
				reject(new Error("footage-timeout"));
			}, timeoutMs)
			: null;
		const feed = (text) => {
			buffered += text;
			// yt-dlp redraws progress with \r, ffmpeg logs stats to stderr the
			// same way; both count as line breaks for the progress parsers.
			const lines = buffered.split(/[\r\n]/);
			buffered = lines.pop() ?? "";
			for (const line of lines) if (line) onLine?.(line);
		};
		child.stdout.on("data", (chunk) => {
			out += chunk;
			feed(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
			feed(String(chunk));
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			reject(new Error(`spawn ${command}: ${error.message}`));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			if (buffered) onLine?.(buffered);
			if (code === 0) resolvePromise({ out, err });
			else reject(new Error(err.split("\n").filter(Boolean).pop() || `${command} exited ${code}`));
		});
	});
}

/** yt-dlp with the web client, retried via the android client only when
 *  YouTube's bot wall is the stated reason for the failure. */
async function runYtdlp(args, options) {
	try {
		return await runCollect(YTDLP, [...YTDLP_BASE, ...args], options);
	} catch (error) {
		if (!WEB_CLIENT_REFUSED.test(error?.message ?? "")) throw error;
		console.error("[bridge] youtube refused the web client; retrying with the android client (≤360p)");
		return runCollect(YTDLP, [...YTDLP_BASE, ...YTDLP_BOTFIX, ...args], options);
	}
}

function cleanup(paths) {
	for (const path of paths) {
		try {
			rmSync(path, { force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Bring a local video down to EXTRACT_FPS_MAX, if it is over it. Resolves to
 * `{ path, fps, capped }`: `path` is the INPUT untouched whenever the source
 * is already at or under the ceiling, so a bridge download — normalized at
 * this same ceiling on the way in — is never re-encoded a second time for
 * nothing. `fps` is what the file at `path` now runs at, i.e. what extraction
 * will see; it is null only when ffprobe would not name a rate, in which case
 * the clip goes through as it is rather than be refused over a probe hiccup.
 * The ffmpeg failure itself throws, for the caller to name.
 */
export async function conformToExtractFps(inputPath, outputPath, { children = new Set(), timeoutMs = 600000, onCap, onProgress } = {}) {
	let probed = { fps: null, durationS: null };
	try {
		const { out } = await runCollect(
			FFPROBE,
			[
				"-v", "error", "-select_streams", "v:0",
				"-show_entries", "stream=avg_frame_rate,r_frame_rate",
				"-show_entries", "format=duration",
				"-of", "default=noprint_wrappers=1",
				inputPath,
			],
			{ children, timeoutMs: 60000 }
		);
		probed = parseProbeStreamInfo(out);
	} catch (err) {
		console.error(`[bridge] fps probe failed for ${inputPath}: ${err.message}`);
	}
	if (probed.fps === null) return { path: inputPath, fps: null, capped: false };
	const targetFps = capExtractFps(probed.fps);
	if (targetFps >= Math.round(probed.fps)) return { path: inputPath, fps: targetFps, capped: false };
	onCap?.(targetFps);
	await runCollect(FFMPEG, normalizeArgs(inputPath, outputPath, targetFps), {
		children,
		timeoutMs,
		onLine: (line) => {
			const ratio = parseEncodeRatio(line, probed.durationS ?? 0);
			if (ratio !== null) onProgress?.(ratio);
		},
	});
	return { path: outputPath, fps: targetFps, capped: true };
}

/**
 * POST /ardy/footage — body {url}, answer ndjson:
 *   {event:"status", message}         stage announcements
 *   {event:"progress", stage, ratio}  download / normalize movement
 *   {event:"done", url, title, durationS, fps}
 *   {event:"error", message}          message is a NAMED reason
 */
export async function handleFootage(req, res, readBody) {
	let body;
	try {
		body = JSON.parse(await readBody(req));
	} catch (err) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(`${JSON.stringify({ ok: false, reason: err.message })}\n`);
		return;
	}
	const url = typeof body?.url === "string" ? body.url.trim() : "";
	if (!/^https?:\/\/\S{1,2000}$/.test(url)) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(`${JSON.stringify({ ok: false, reason: "footage-url-invalid" })}\n`);
		return;
	}

	res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
	const send = (obj) => {
		if (res.writableEnded) return;
		try {
			res.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone */
		}
	};
	let cleanupArtifacts = () => {};
	const fail = (message) => {
		send({ event: "error", message });
		res.end();
		cleanupArtifacts();
	};

	const children = new Set();
	res.on("close", () => {
		if (!res.writableEnded) {
			console.error(`[bridge] client disconnected mid-footage; killing ${children.size} child group(s)`);
			for (const child of children) killGroup(child);
			children.clear();
			cleanupArtifacts();
		}
	});

	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const artifactDir = createPrivateArtifactDir(FOOTAGE_DIR, "footage");
	const rawPrefix = "raw";
	const outPath = join(artifactDir, "normalized.mp4");
	cleanupArtifacts = () => removePrivateArtifactDir(artifactDir);

	// 1) probe: refuse lives (no duration) and long videos before any bytes.
	send({ event: "status", message: "probing" });
	let probe;
	try {
		const { out } = await runYtdlp(
			["--print", "%(duration)s\t%(fps)s\t%(title)s", url],
			{ children, timeoutMs: 60000 }
		);
		probe = parseProbeLine(out.split("\n").find((line) => line.includes("\t")) ?? "");
	} catch (err) {
		console.error(`[bridge] footage probe failed: ${err.message}`);
		fail("footage-probe-failed");
		return;
	}
	if (!probe) {
		fail("footage-live-unsupported");
		return;
	}
	if (probe.durationS > FOOTAGE_MAX_S) {
		fail("footage-too-long");
		return;
	}

	// 2) download the video stream only (audio never reaches the ingest).
	send({ event: "status", message: "downloading" });
	try {
		await runYtdlp(
			[
				"--newline",
				"-f", `bv*[height<=${FOOTAGE_MAX_HEIGHT}]/b[height<=${FOOTAGE_MAX_HEIGHT}]/b`,
				"-o", join(artifactDir, `${rawPrefix}.%(ext)s`),
				url,
			],
			{
				children,
				timeoutMs: 10 * 60 * 1000,
				onLine: (line) => {
					const ratio = parseDownloadRatio(line);
					if (ratio !== null) send({ event: "progress", stage: "download", ratio });
				},
			}
		);
	} catch (err) {
		console.error(`[bridge] footage download failed: ${err.message}`);
		cleanupArtifacts();
		fail("footage-download-failed");
		return;
	}
	const rawName = readdirSync(artifactDir).find((f) => f.startsWith(rawPrefix));
	if (!rawName) {
		fail("footage-download-failed");
		return;
	}
	const rawPath = join(artifactDir, rawName);

	// 3) lock to a CONSTANT rate at the source's own fps, capped at the rate
	// extraction can use: VFR platform video would otherwise make "frame 385"
	// a different instant than the timeline believes, and resampling to a
	// foreign rate would judder the motion. Everything downstream — the done
	// event below, the browser probe, the retime — is told THIS number, so the
	// clip's declared rate is the rate SAM will actually meet.
	const targetFps = capExtractFps(probe.fps);
	send({ event: "status", message: "normalizing" });
	try {
		await runCollect(
			FFMPEG,
			normalizeArgs(rawPath, outPath, targetFps),
			{
				children,
				timeoutMs: 10 * 60 * 1000,
				onLine: (line) => {
					const ratio = parseEncodeRatio(line, probe.durationS);
					if (ratio !== null) send({ event: "progress", stage: "normalize", ratio });
				},
			}
		);
	} catch (err) {
		console.error(`[bridge] footage normalize failed: ${err.message}`);
		cleanupArtifacts();
		fail("footage-normalize-failed");
		return;
	}
	cleanup([rawPath]);

	footageAllowlist.set(stamp, outPath);
	if (footageAllowlist.size > FOOTAGE_ALLOWLIST_MAX) {
		const oldest = footageAllowlist.keys().next().value;
		removePrivateArtifactDir(dirname(footageAllowlist.get(oldest)));
		footageAllowlist.delete(oldest);
	}
	send({
		event: "done",
		url: `/ardy/footage/${stamp}.mp4`,
		footage: stamp,
		title: probe.title,
		durationS: probe.durationS,
		fps: targetFps,
	});
	res.end();
}

/** Absolute path for an allowlisted footage id, or null — the extract route
 *  reuses a bridge-downloaded clip without a second trip through the browser. */
export function footagePath(id) {
	if (typeof id !== "string" || !FOOTAGE_ID.test(id)) return null;
	return footageAllowlist.get(id) ?? null;
}

/** GET /ardy/footage/<id>.mp4 — allowlist only, exactly like motion delivery. */
export function serveFootage(req, res, pathname) {
	const sendJson = (status, obj) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(`${JSON.stringify(obj)}\n`);
	};
	const match = /^\/ardy\/footage\/([^/]+)\.mp4$/.exec(pathname);
	if (!match || !FOOTAGE_ID.test(match[1]) || !footageAllowlist.has(match[1])) {
		sendJson(404, { ok: false, reason: `unknown or expired footage "${match?.[1] ?? pathname}"` });
		return 404;
	}
	const absPath = footageAllowlist.get(match[1]);
	if (!absPath.startsWith(`${FOOTAGE_DIR}${sep}`)) {
		sendJson(404, { ok: false, reason: "footage path is outside the footage directory" });
		return 404;
	}
	let size;
	try {
		size = statSync(absPath).size;
	} catch {
		sendJson(404, { ok: false, reason: "footage is no longer on disk" });
		return 404;
	}
	res.writeHead(200, {
		"Content-Type": "video/mp4",
		"Content-Length": size,
		"Cache-Control": "no-store",
	});
	createReadStream(absPath)
		.on("error", (err) => {
			console.error(`[bridge] error streaming ${absPath}: ${err.message}`);
			res.destroy();
		})
		.pipe(res);
	return 200;
}
