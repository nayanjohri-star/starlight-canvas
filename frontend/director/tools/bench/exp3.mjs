#!/usr/bin/env node
/** Reproducible issue #454 experiment driver. GPU and CDP work are serial. */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { backgroundDifferenceMask, deriveBox, drawProjectedBox, paletteMask, PALETTE_THRESHOLDS } from "./cube-contact.mjs";
import { assertGpuIdle } from "./fit/remote.mjs";
import { maskIoU, mean, meanJointError } from "./metrics.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCENARIOS = ["bump", "handon", "sit", "stepup"];
const VARIANTS = ["shaded", "skin"];
const baseCondition = variant => variant === "skin" ? "yolo-vitpose" : "prod";
const json = path => JSON.parse(readFileSync(path, "utf8"));
const put = (path, value) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const ff = args => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 512 * 1024 * 1024 });
const run = (tool, args) => execFileSync(process.execPath, [join(ROOT, "tools", tool), ...args], { cwd: ROOT, stdio: "inherit" });
const aabb = info => ({ min: info.scene.min, max: info.scene.max });
function verticesAt(dir) {
	const meta = json(join(dir, "vertices.json")), data = readFileSync(join(dir, "vertices.f32"));
	if (data.length !== meta.frames * meta.vertexCount * 12) throw new Error("incomplete vertices.f32");
	const floats = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
	return frame => floats.subarray(frame * meta.vertexCount * 3, (frame + 1) * meta.vertexCount * 3);
}
function contactSheet(dir, info, variant) {
	const camera = json(join(dir, variant, "camera.json")), meta = json(join(dir, variant, "meta.json"));
	const frames = [...new Set([0, info.contactFrames[0], info.witness.frame, meta.frames - 1])];
	const images = frames.map(frame => {
		const rgb = ff(["-i", join(dir, variant, "video.mp4"), "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
		return drawProjectedBox(rgb, camera, info.box);
	});
	// Two columns, row-major; the corresponding frame numbers are recorded.
	const png = execFileSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${camera.width}x${camera.height}`, "-i", "pipe:0", "-vf", `tile=2x${Math.ceil(images.length / 2)}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { input: Buffer.concat(images), maxBuffer: 20 * 1024 * 1024 });
	writeFileSync(join(dir, variant, "contact-sheet.png"), png);
	put(join(dir, variant, "contact-sheet.json"), { frames, annotation: "Red: camera.json projections of all eight world-space cube corners and twelve edges." });
}
export function summarizeGt(root, names = SCENARIOS) {
	const rows = [], missing = [];
	for (const variant of VARIANTS) for (const name of names) for (let f = 0; f <= 5; f++) {
		const dir = join(root, "gt-path/score", variant, name, `F${f}`), path = join(dir, "score.json");
		if (!existsSync(path)) { missing.push(`${variant}/${name}/F${f}`); continue; }
		const score = json(path), info = json(join(root, "gt", name, "scenario.json"));
		const lines = readFileSync(join(dir, "frames.csv"), "utf8").trim().split("\n"), header = lines.shift().split(",");
		const records = lines.map(line => Object.fromEntries(line.split(",").map((value, i) => [header[i], Number(value)])));
		const contact = records.filter(r => info.contactFrames.includes(r.gt_frame));
		const signed = contact.map(r => r.box_signed_pred_raw_m);
		rows.push({ scenario: name, variant, baseCondition: baseCondition(variant), step: `F${f}`, contactFrames: contact.length, minDistanceM: signed.length ? Math.max(0, Math.min(...signed)) : null, maxPenetrationM: signed.length ? Math.max(0, -Math.min(...signed)) : null, mpjpeM: score.pose.mpjpeRootRelativeAlignedM, endpointM: score.endpoints.lastFrame.jointErrorAlignedM, iou: score.overlap.maskIoUAlignedMean });
	}
	const fmt = (n, scale = 1) => n === null ? "N/A" : (n * scale).toFixed(3);
	const table = ["# Experiment 3: GT path", "", "Contact: RAW world placement, declared contact span only. MPJPE: aligned root-relative; endpoint: aligned last-frame mean joint error; IoU: aligned, cube-occluded character mask. Distances in cm. These metrics do not certify natural action.", "", "| Scenario | Variant | F | Contact frames | Min distance cm | Max penetration cm | MPJPE cm | Endpoint cm | Aligned IoU |", "|---|---|---|---:|---:|---:|---:|---:|---:|", ...rows.map(r => `| ${r.scenario} | ${r.variant} | ${r.step} | ${r.contactFrames} | ${fmt(r.minDistanceM, 100)} | ${fmt(r.maxPenetrationM, 100)} | ${fmt(r.mpjpeM, 100)} | ${fmt(r.endpointM, 100)} | ${fmt(r.iou)} |`), "", ...(missing.length ? [`Incomplete: ${missing.join(", ")}`, ""] : []), "F4 pins only native NPZ A/B endpoints. Studio rig retargeting/anchoring can still move them. F5 is skeletal collision handling, not skin contact optimization."];
	mkdirSync(join(root, "gt-path"), { recursive: true }); writeFileSync(join(root, "gt-path/summary.md"), table.join("\n") + "\n"); put(join(root, "gt-path/summary.json"), { rows, missing });
	return rows;
}
async function renderGt(root, names, ports, variants) {
	const logs = readdirSync(join(root, "gt-motions")).filter(n => /^gen-log.*\.json$/.test(n)).flatMap(n => json(join(root, "gt-motions", n)));
	for (const name of names) {
		const pre = join(root, "prepass", name), gt = join(root, "gt", name), source = join(root, "gt-motions", `${name}.npz`);
		if (!existsSync(join(pre, "joints.json"))) run("gt-render/render.mjs", ["--out", join(root, "prepass"), "--no-video", "--export-vertices", "--azimuth", "30", "--elevation", "5", "--f-mm", "35", ...ports, source]);
		const info = { ...deriveBox(name, json(join(pre, "joints.json")), verticesAt(pre)), prompt: logs.find(l => l.name === name)?.prompt };
		put(join(gt, "scenario.json"), info); put(join(gt, "fit-scene.json"), { boxes: [aabb(info)] });
		console.log(`${name}: ${JSON.stringify(info.box)}; ${info.warnings.join(" ")}`);
		run("gt-render/render.mjs", ["--out", join(root, "gt"), "--variants", variants.join(","), "--keep-frames", "--scene-box", JSON.stringify(info.box), "--box", JSON.stringify(aabb(info)), "--azimuth", "30", "--elevation", "5", "--f-mm", "35", ...ports, source]);
		for (const variant of variants) contactSheet(gt, info, variant);
		const contact = json(join(gt, "contact.json")), selected = info.contactFrames.map(f => contact.frames[f]);
		put(join(gt, "contact-baseline.json"), { contactFrames: info.contactFrames, minDistanceM: Math.min(...selected.map(f => f.minDistanceM)), maxDistanceM: Math.max(...selected.map(f => f.minDistanceM)), maxPenetrationM: Math.max(...selected.map(f => f.maxPenetrationM)), pass: selected.every(f => f.minDistanceM <= 0.03 && f.maxPenetrationM <= 0.02) });
	}
}
async function gtPath(root, names, ports, host, variants) {
	for (const variant of variants) {
		const base = baseCondition(variant);
		await assertGpuIdle(host);
		run("bench/extract-bench.mjs", ["--input", join(root, "gt"), "--out", join(root, "gt-path/extract"), "--motions", names.join(","), "--variants", variant, "--conditions", `${base},${base}+fmm`, "--host", host]);
		for (const name of names) {
			const gt = join(root, "gt", name), info = json(join(gt, "scenario.json"));
			run("bench/fit-bench.mjs", ["--input", join(root, "gt"), "--extract", join(root, "gt-path/extract"), "--poses", join(root, "gt-motions"), "--out", join(root, "gt-path/fit", variant), "--variant", variant, "--base-condition", base, "--motions", name, "--host", host, "--scene", join(gt, "fit-scene.json")]);
			const score = (pred, out) => run("bench/score.mjs", ["--gt", join(gt, variant), "--pred", pred, "--out", out, "--box", JSON.stringify(aabb(info)), "--gt-npz", join(root, "gt-motions", `${name}.npz`), ...ports]);
			const baseline = join(root, "gt-path/gt-self", variant, name);
			if (!existsSync(join(baseline, "score.json"))) score(join(root, "gt-motions", `${name}.npz`), baseline);
			for (let f = 0; f <= 5; f++) {
				const out = join(root, "gt-path/score", variant, name, `F${f}`);
				if (!existsSync(join(out, "score.json"))) score(join(root, "gt-path/fit", variant, name, `F${f}`, "motion.npz"), out);
				summarizeGt(root, names);
			}
		}
	}
}
function videoInfo(path) {
	return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,r_frame_rate,duration", "-of", "json", path], { encoding: "utf8" })).streams[0];
}
export function makeQaVideo(source, prediction, output) {
	ff(["-i", source, "-i", prediction, "-filter_complex", "[0:v]split=2[a][ao];[1:v]split=2[b][bo];[ao][bo]blend=all_mode=average[o];[a][b][o]hstack=inputs=3:shortest=1[v]", "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", output]);
}
async function falPath(root, names, ports, host, key, dryRun, variants) {
	for (const variant of variants) for (const name of names) run("bench/fal-generate.mjs", ["--scenario", join(root, "gt", name), "--variant", variant, "--out", join(root, "fal/clips"), ...(key ? ["--key", key] : []), ...(dryRun ? ["--dry-run"] : [])]);
	const clips = readdirSync(join(root, "fal/clips")).filter(clip => names.some(name => variants.some(variant => clip.startsWith(`${name}-${variant}-`))) && existsSync(join(root, "fal/clips", clip, "video.mp4")));
	const qa = join(root, "qa-pack"); mkdirSync(qa, { recursive: true });
	const csv = join(qa, "ratings.csv");
	// Never overwrite a person's completed ratings on a resumed sweep.
	if (!existsSync(csv)) writeFileSync(csv, "clip,prompt_adherence_0_2,contact_natural_0_2,usable_without_fix_YN,notes\n");
	for (const clip of clips) {
		const record = json(join(root, "fal/clips", clip, "request.json"));
		const variant = record.variant, base = baseCondition(variant);
		const gt = record.scenario, name = basename(gt), info = json(join(gt, "scenario.json")), input = join(root, "fal/input", clip, variant), poses = join(root, "fal/poses");
		mkdirSync(input, { recursive: true }); mkdirSync(poses, { recursive: true });
		const video = join(root, "fal/clips", clip, "video.mp4"), probe = videoInfo(video), camera = json(join(gt, variant, "camera.json"));
		if (Math.abs(probe.width / probe.height / (camera.width / camera.height) - 1) > 0.01) throw new Error(`${clip}: fal changed aspect ratio; cannot claim the GT camera`);
		ff(["-i", video, "-vf", `scale=${camera.width}:${camera.height},fps=24`, "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", join(input, "video.mp4")]);
		copyFileSync(join(gt, variant, "camera.json"), join(input, "camera.json")); copyFileSync(join(gt, variant, "scene.json"), join(input, "scene.json"));
		put(join(input, "meta.json"), { source: { path: video }, normalization: "spatially scaled to A-still dimensions, 24fps; no temporal stretch", cameraAssumption: "H3 obeyed the locked-camera prompt; drift is not corrected" });
		copyFileSync(join(root, "gt-motions", `${name}.npz`), join(poses, `${clip}.npz`));
		await assertGpuIdle(host);
		// F0 needs the unknown-focal production baseline as well as the requested known-focal F1.
		run("bench/extract-bench.mjs", ["--input", join(root, "fal/input"), "--out", join(root, "fal/extract"), "--motions", clip, "--variants", variant, "--conditions", `${base},${base}+fmm`, "--host", host]);
		run("bench/fit-bench.mjs", ["--input", join(root, "fal/input"), "--extract", join(root, "fal/extract"), "--poses", poses, "--out", join(root, "fal/fit"), "--variant", variant, "--base-condition", base, "--motions", clip, "--host", host, "--scene", join(gt, "fit-scene.json")]);
		const normalized = join(input, "video.mp4"), frames = Number(videoInfo(normalized).nb_frames), size = camera.width * camera.height;
		const rgb = ff(["-i", normalized, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
		const plate = variant === "skin" ? ff(["-i", join(gt, "plate.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]) : null;
		const masks = plate ? backgroundDifferenceMask(rgb, plate) : paletteMask(rgb);
		const segmentation = plate ? { method: "background-difference", minChannelDifference: 30, plate: join(gt, "plate.png"), caveat: "Includes changed shadows/lighting/background; not semantic segmentation." } : { method: "palette-colour", ...PALETTE_THRESHOLDS };
		const endpoints = json(join(gt, variant, "joints.json")), scores = [];
		for (let f = 0; f <= 5; f++) {
			const out = join(root, "fal/score", clip, `F${f}`), motion = join(root, "fal/fit", clip, `F${f}`, "motion.npz");
			run("gt-render/render.mjs", ["--out", out, ...(f === 5 ? ["--variants", variant] : ["--no-video"]), "--camera", join(input, "camera.json"), "--scene-box", JSON.stringify(info.box), "--box", JSON.stringify(aabb(info)), ...ports, motion]);
			const rendered = join(out, "motion"), joints = json(join(rendered, ...(f === 5 ? [variant] : []), "joints.json")), contact = json(join(rendered, "contact.json"));
			const predMask = ff(["-i", join(rendered, "mask/%06d.png"), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
			const count = Math.min(frames, joints.frames), ious = Array.from({ length: count }, (_, i) => maskIoU(masks.subarray(i * size, (i + 1) * size), predMask.subarray(i * size, (i + 1) * size)).iou);
			const score = { clip, variant, baseCondition: base, step: `F${f}`, noMotionGroundTruth: true, mpjpe: null, endpointFirstM: meanJointError(joints.world[0], endpoints.world[0]), endpointLastM: meanJointError(joints.world.at(-1), endpoints.world.at(-1)), minDistanceM: Math.min(...contact.frames.map(v => v.minDistanceM)), maxPenetrationM: Math.max(...contact.frames.map(v => v.maxPenetrationM)), contactWindow: "entire clip: fal contact timing is unknown", overlapIoU: mean(ious), segmentation, comparedFrames: count, sourceFrames: frames, predictionFrames: joints.frames, alignment: "none; fixed A-still camera", cameraAssumption: "no H3 camera drift" };
			put(join(out, "score.json"), score); scores.push(score);
			if (f === 5) makeQaVideo(normalized, join(rendered, variant, "video.mp4"), join(qa, `${clip}.mp4`));
		}
		put(join(root, "fal/score", clip, "summary.json"), scores);
		if (!readFileSync(csv, "utf8").split("\n").some(line => line.startsWith(`${clip},`))) writeFileSync(csv, `${clip},,,,\n`, { flag: "a" });
	}
	const scores = clips.flatMap(clip => { const path = join(root, "fal/score", clip, "summary.json"); return existsSync(path) ? json(path) : []; });
	writeFileSync(join(root, "fal/summary.md"), ["# Experiment 3: fal path", "", "No intermediate motion GT. Endpoints are world mean joint error versus A/B; box metrics are whole-clip skin measurements; IoU is unaligned palette-colour (shaded) or empty-plate background-difference (skin) proxy overlap. Distances in cm.", "", "| Clip | Variant | F | A error | B error | Min distance | Max penetration | IoU |", "|---|---|---|---:|---:|---:|---:|---:|", ...scores.map(s => `| ${s.clip} | ${s.variant} | ${s.step} | ${(s.endpointFirstM * 100).toFixed(3)} | ${(s.endpointLastM * 100).toFixed(3)} | ${(s.minDistanceM * 100).toFixed(3)} | ${(s.maxPenetrationM * 100).toFixed(3)} | ${s.overlapIoU.toFixed(3)} |`), "", ...(!clips.length ? ["Pending live generation: no fal video available. Dry-run requests are not measurements."] : [])].join("\n") + "\n");
	put(join(root, "fal/status.json"), { generatedClips: clips, pending: clips.length < names.length * variants.length * 3, plannedClips: names.length * variants.length * 3, variants, qa, note: clips.length ? "Only available metrics; no intermediate motion GT for fal." : "No live fal clips. Request dry-runs and mock-fetch tests do not validate the service or motion quality." });
}
export async function main(argv = process.argv.slice(2)) {
	const { values: v } = parseArgs({ args: argv, options: { root: { type: "string" }, stage: { type: "string", default: "all" }, motions: { type: "string", default: SCENARIOS.join(",") }, variants: { type: "string", default: VARIANTS.join(",") }, host: { type: "string", default: "yun@ubuntu-baremetal" }, port: { type: "string", default: "5194" }, "cdp-port": { type: "string", default: "9234" }, key: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } } });
	if (v.help) { console.log("usage: node tools/bench/exp3.mjs --root <evidence/exp3> --stage gt|gt-path|fal|summary|all [--motions bump,handon,sit,stepup] [--variants shaded,skin] [--host yun@ubuntu-baremetal] [--port 5194 --cdp-port 9234] [--key <file>] [--dry-run]\nGT stage consumes gt-motions/*.npz; saves prepass, derived boxes, shaded renders and projected contact sheets. --dry-run affects fal generation only."); return; }
	if (!v.root || !["gt", "gt-path", "fal", "summary", "all"].includes(v.stage)) throw new Error("--root and a valid --stage required");
	const root = resolve(v.root), names = v.motions.split(","), variants = v.variants.split(","), ports = ["--port", v.port, "--cdp-port", v["cdp-port"]];
	if (!names.every(n => SCENARIOS.includes(n))) throw new Error("unknown scenario");
	if (!variants.every(variant => VARIANTS.includes(variant))) throw new Error("unknown variant");
	if (["gt", "all"].includes(v.stage)) await renderGt(root, names, ports, variants);
	if (["gt-path", "all"].includes(v.stage)) await gtPath(root, names, ports, v.host, variants);
	if (["summary", "gt-path", "all"].includes(v.stage)) summarizeGt(root, names);
	if (["fal", "all"].includes(v.stage)) await falPath(root, names, ports, v.host, v.key, v["dry-run"], variants);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
