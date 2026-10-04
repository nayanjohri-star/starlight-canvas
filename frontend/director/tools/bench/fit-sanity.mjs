#!/usr/bin/env node
/** Read-only evaluation, deliberately separate from all fitting code.
 * This is NOT #431's official rendered-rig scorer. Compare native cskel27
 * posed_joints at matching seconds (linear GT position interpolation),
 * without scale/heading/translation/Procrustes alignment. Source playback
 * applies a rig-dependent scale and bind offsets, absent from these numbers.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMotion } from "./fit/motion.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args.includes("--help")) {
	console.log("usage: node tools/bench/fit-sanity.mjs <fit-root> <gt-source-npz-dir>\nWrites sanity.json and sanity.md under fit-root. Evaluation only; not an input to fitting.");
	if (!args.includes("--help")) process.exitCode = 2;
} else {
	const [root, source] = args;
	const rows = [];
	for (const name of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
		const gt = readMotion(join(source, `${name}.npz`));
		for (let step = 0; step <= 5; step++) {
			const motion = readMotion(join(root, name, `F${step}`, "motion.npz"));
			let relative = 0, rootError = 0;
			for (let f = 0; f < motion.frames; f++) {
				const t = f / motion.fps * gt.fps;
				if (t > gt.frames - 1 + 1e-5) throw new Error(`${name}: fitted timeline exceeds GT source`);
				const a = Math.floor(t), b = Math.min(gt.frames - 1, a + 1), w = t - a;
				const at = (j, k) => gt.posedJoints[(a * 27 + j) * 3 + k] * (1 - w) + gt.posedJoints[(b * 27 + j) * 3 + k] * w;
				const delta = j => [0, 1, 2].map(k => motion.posedJoints[(f * 27 + j) * 3 + k] - at(j, k));
				const r = delta(0); rootError += Math.hypot(...r);
				for (let j = 1; j < 27; j++) relative += Math.hypot(...delta(j).map((v, k) => v - r[k]));
			}
			rows.push({ motion: name, step: `F${step}`, frames: motion.frames, rootRelativeMm: 1000 * relative / (motion.frames * 26), rootPositionMm: 1000 * rootError / motion.frames });
		}
	}
	const means = Array.from({ length: 6 }, (_, i) => {
		const step = `F${i}`, selected = rows.filter(r => r.step === step);
		return { step, rootRelativeMm: selected.reduce((s, r) => s + r.rootRelativeMm, 0) / selected.length, rootPositionMm: selected.reduce((s, r) => s + r.rootPositionMm, 0) / selected.length };
	});
	const note = "Native cskel27 posed_joints versus GT source NPZ, matched at f/fps seconds with linear GT position interpolation. Root-relative mean excludes Hips (26 joints); root position is Hips error. No alignment. These are NOT rendered-rig errors: Studio playback changes scale and bind offsets. F2 is camera-registered scene metres; F4 A/B endpoints are native source poses. Official #431 scoring is separate.";
	const text = `${note}\n\n| Motion | Step | Root-relative mm | Root position mm |\n|---|---|---:|---:|\n${rows.map(r => `| ${r.motion} | ${r.step} | ${r.rootRelativeMm.toFixed(1)} | ${r.rootPositionMm.toFixed(1)} |`).join("\n")}\n\n| Mean over motions | Root-relative mm | Root position mm |\n|---|---:|---:|\n${means.map(r => `| ${r.step} | ${r.rootRelativeMm.toFixed(1)} | ${r.rootPositionMm.toFixed(1)} |`).join("\n")}\n`;
	writeFileSync(join(root, "sanity.json"), JSON.stringify({ note, rows, means }, null, 2) + "\n");
	writeFileSync(join(root, "sanity.md"), text);
	console.log(text);
}
