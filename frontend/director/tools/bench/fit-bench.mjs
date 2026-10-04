#!/usr/bin/env node
/** #432 cumulative fits. No GT intermediate frame is used by this program. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { motionArraysToNpzMembers, writeNpz } from "../ardy/npz.mjs";
import { readNpz } from "../kimodo/read-npz.mjs";
import { registerCamera } from "./fit/camera.mjs";
import { fitContacts, validateBoxes } from "./fit/contact.mjs";
import { fitBody, readEndpoints, readMotion } from "./fit/motion.mjs";
import { pinEndpoints } from "./fit/pin.mjs";
import { extractIncam, extractMissingFocal } from "./fit/remote.mjs";
import { parseCondition } from "./extract-bench-lib.mjs";

export const USAGE = `usage: node tools/bench/fit-bench.mjs --input <gt-render-root> --extract <t2-root>
       --poses <user-ab-npz-dir> --out <dir> [options]

  --motions walk,run     default: all motion dirs in --input
  --variant shaded      one variant per output root (default shaded)
  --base-condition prod T2 baseline without +fmm (e.g. yolo-vitpose); missing +fmm
                        is extracted serially with --host and the known camera
  --host user@box        extract missing camera evidence; CCLAY_EXTRACT_HOST fallback
  --incam-root <dir>     use supplied <dir>/<motion>/incam.npz instead of GPU
  --window-seconds 0.5   smooth A/B pin falloff, capped at half the clip
  --body <json>          character's 27 positive bone factors (default all 1)
  --scene <json>         {boxes:[{min:[x,y,z],max:[x,y,z]}]} in world metres
  --force-incam          re-extract camera evidence even if cached
  --help                this text

Writes <out>/<motion>/F0..F5/motion.npz plus result.json and incam.npz.
F0/F1 copy T2 <base-condition>/<base-condition>+fmm motion.npz BYTE FOR BYTE. F2 adds one static
camera registration from predicted camera-space pelvis/orientation and known
OpenCV extrinsics, retaining F1's trajectory. F3 replaces estimated proportions
with the known character body (canonical cskel27 by default; personScale=1).
F4 consumes ONLY FIRST/LAST poses of <poses>/<motion>.npz, never intermediate
GT frames. F5 uses only fitted motion + known floor/boxes; one rigid stance
support, skeletal segment collisions (not skin), geometry wins over A/B pins.
No fitting stage uses GT intermediate frames or GT trajectory alignment.
Only camera, character, A/B poses and scene geometry are user-known inputs.
GT evaluation is a separate, read-only fit-sanity.mjs program.

GPU runs are serial and refuse ANY other GVHMR process (even an idle worker).
Wait for other extraction sweeps to finish; never kill another process. Box
scratch is confined to /tmp/cclay-fit-* and removed on completion/failure.
For another variant use a separate --out root to avoid overwriting a run.`;

export function parseArgs(args) {
	const out = { variant: "shaded", baseCondition: "prod", windowSeconds: 0.5, host: process.env.CCLAY_EXTRACT_HOST || process.env.CCLAY_ARDY_HOST };
	const names = { "--input": "input", "--extract": "extract", "--poses": "poses", "--out": "out", "--motions": "motions", "--variant": "variant", "--base-condition": "baseCondition", "--host": "host", "--incam-root": "incamRoot", "--window-seconds": "windowSeconds", "--body": "body", "--scene": "scene" };
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--help" || flag === "-h") { out.help = true; continue; }
		if (flag === "--force-incam") { out.forceIncam = true; continue; }
		if (!names[flag]) throw new Error(`unknown option ${flag}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		out[names[flag]] = value;
	}
	if (out.help) return out;
	for (const key of ["input", "extract", "poses", "out"]) if (!out[key]) throw new Error(`--${key} is required`);
	out.windowSeconds = Number(out.windowSeconds);
	if (!(Number.isFinite(out.windowSeconds) && out.windowSeconds > 0)) throw new Error("--window-seconds must be positive");
	if (parseCondition(out.baseCondition).fmm) throw new Error("--base-condition must omit +fmm");
	if (out.motions) out.motions = out.motions.split(",");
	for (const name of [...(out.motions ?? []), out.variant]) if (!/^[a-zA-Z0-9][a-zA-Z0-9_+.-]*$/.test(name)) throw new Error(`invalid motion/variant name ${name}`);
	return out;
}

const json = path => JSON.parse(readFileSync(path, "utf8"));
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export async function main(argv = process.argv.slice(2), { missingFocal = extractMissingFocal, cameraEvidence = extractIncam } = {}) {
	const options = parseArgs(argv);
	if (options.help) { console.log(USAGE); return; }
	const motions = options.motions ?? readdirSync(options.input, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(options.input, d.name, options.variant, "video.mp4"))).map(d => d.name).sort();
	if (!motions.length) throw new Error("no motions found");
	const boxes = validateBoxes(options.scene ? json(options.scene).boxes : []);
	const boneScale = options.body ? json(options.body) : new Array(27).fill(1);
	if (!Array.isArray(boneScale) || boneScale.length !== 27 || !boneScale.every(v => Number.isFinite(v) && v > 0)) throw new Error("--body must contain 27 positive bone factors");
	for (const name of motions) {
		const source = join(options.input, name, options.variant), extracted = join(options.extract, name, options.variant);
		const destination = join(options.out, name), prior = join(destination, "result.json");
		if (existsSync(prior) && (json(prior).variant !== options.variant || (json(prior).baseCondition ?? "prod") !== options.baseCondition)) throw new Error(`${destination}: belongs to a different variant/base condition; choose another --out`);
		const conditions = [options.baseCondition, `${options.baseCondition}+fmm`];
		const paths = { F0: join(extracted, conditions[0], "motion.npz"), F1: join(extracted, conditions[1], "motion.npz"), camera: join(source, "camera.json"), poses: join(options.poses, `${name}.npz`) };
		for (const path of [paths.F0, paths.camera, paths.poses]) if (!existsSync(path)) throw new Error(`missing input ${path}; wait for the T2 sweep to finish`);
		if (!existsSync(paths.F1)) {
			console.log(`extract missing ${name}/${options.variant}/${conditions[1]}`);
			await missingFocal({ input: options.input, extract: options.extract, motion: name, variant: options.variant, baseCondition: options.baseCondition, host: options.host });
			if (!existsSync(paths.F1)) throw new Error(`focal extraction did not produce ${paths.F1}`);
		}
		for (const condition of conditions) {
			const result = join(extracted, condition, "result.json");
			if (existsSync(result) && !json(result).ok) throw new Error(`${result}: extraction did not succeed`);
		}
		mkdirSync(destination, { recursive: true });
		const camera = json(paths.camera), incamPath = join(options.incamRoot ?? options.out, name, "incam.npz");
		console.log(`fit ${name}/${options.variant}`);
		const cameraRun = options.incamRoot ? { supplied: resolve(incamPath) } : await cameraEvidence({ host: options.host, video: join(source, "video.mp4"), output: incamPath, camera, log: join(destination, "incam.log"), force: options.forceIncam, baseCondition: options.baseCondition });
		const f0 = readMotion(paths.F0), f1 = readMotion(paths.F1);
		if (f0.frames !== f1.frames || f0.fps !== f1.fps) throw new Error(`${name}: F0/F1 timelines disagree`);
		const incam = readNpz(incamPath);
		const k = incam.K_fullimg;
		if (!k?.data || k.shape.join() !== [f1.frames, 3, 3].join() || !k.data.every(Number.isFinite) || Math.abs(k.data[0] - camera.fx) > 0.01 || Math.abs(k.data[4] - camera.fy) > 0.01) throw new Error("incam intrinsics do not match camera.json known focal");
		const f2 = registerCamera(f1, incam, camera);
		const f3 = fitBody(f2.motion, boneScale);
		const f4 = pinEndpoints(f3, readEndpoints(paths.poses), { windowSeconds: options.windowSeconds });
		const f5 = fitContacts(f4, { boxes });
		for (const [index, motion] of [f0, f1, f2.motion, f3, f4, f5.motion].entries()) {
			const directory = join(destination, `F${index}`); mkdirSync(directory, { recursive: true });
			if (index < 2) copyFileSync(paths[`F${index}`], join(directory, "motion.npz"));
			else writeNpz(join(directory, "motion.npz"), motionArraysToNpzMembers(motion));
		}
		writeFileSync(prior, JSON.stringify({ ok: true, tool: "fit-bench", motion: name, variant: options.variant, baseCondition: options.baseCondition, createdAt: new Date().toISOString(), frames: f1.frames, fps: f1.fps,
			inputs: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, { path: resolve(path), sha256: sha(path) }])),
			cameraRun, cameraRegistration: f2.diagnostics, body: { boneScale, personScale: 1 }, pinning: { windowSeconds: options.windowSeconds, sourceFrames: "first and last ONLY" }, contacts: f5.diagnostics, boxes,
			deviations: ["F2 one rigid first-pelvis registration; per-frame incam transforms are diagnostic only", "F2 replaces the arbitrary initial floor datum with the camera-predicted pelvis height", "F3 FK regenerates production-smoothed rotations with known character bones; no automatic regrounding", "F4 source NPZ endpoints are in native cskel27 space, not rendered-rig playback space", "F5 one support point at a time; skeletal segment boxes, no skin thickness; scene safety may release locks and move A/B endpoints"],
		}, null, 2) + "\n");
		console.log(`ok ${name}: ${f1.frames} frames @ ${f1.fps} fps, F0..F5; contacts ${f5.diagnostics.lockedFrames} frames`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(`fit-bench: ${error.stack ?? error}`); process.exitCode = 1; });
}
