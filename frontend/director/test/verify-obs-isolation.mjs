#!/usr/bin/env node
// C6 (#462): the observation ladder may use only what production knows at run
// time: the video (through GVHMR's obs), the camera, the character body, the
// floor/scene boxes, and the A/B endpoint poses. Ground-truth motion (the
// source npz's middle frames, GT joints/masks, score outputs) must never reach
// a ladder step. Checked statically (imports, argument lists) and at run time
// (endpoint reader ignores middle frames; the bench's ladder context has
// exactly the allowed keys).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNpz } from "../tools/ardy/npz.mjs";
import { readEndpoints } from "../tools/bench/fit/motion.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// 1. The ladder modules compute from their arguments only: no file, process or
// network access, and no scorer or ground-truth loader imported.
for (const path of ["tools/bench/obs/ladder.mjs", "tools/bench/obs/ground.mjs", "tools/bench/obs/depth.mjs", "tools/bench/obs/extrinsics.mjs"]) {
	const imports = [...read(path).matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
	for (const spec of imports) {
		assert.ok(!/^node:(fs|child_process|net|http|https)/.test(spec), `${path} must not import ${spec}`);
		assert.ok(!/score|metrics|cube-contact|obs-bench/.test(spec), `${path} must not import the scorer (${spec})`);
	}
	assert.ok(!/gt-motions|joints\.json|score\.json|trueJoints/.test(read(path)), `${path} must not name a ground-truth artifact`);
}

// 2. The bench hands a ladder step exactly: camera, character ankle height,
// A/B endpoints, scene boxes, and the GVHMR obs (+ rest joints from betas).
const bench = read("tools/bench/obs-bench.mjs");
const ctxLiteral = bench.match(/const ctx = \{([^}]*)\};/);
assert.ok(ctxLiteral, "obs-bench builds one ladder context literal");
const keys = ctxLiteral[1].split(",").map((part) => part.split(":")[0].trim()).filter(Boolean);
assert.deepEqual(keys.sort(), ["ankleHeight", "boxes", "camera", "endpoints"], `ladder context keys: ${keys}`);
const assigned = [...bench.matchAll(/ctx\.(\w+)\s*=/g)].map((m) => m[1]).sort();
assert.deepEqual(assigned, ["base", "mannequin"], `ladder context late keys: ${assigned}`);
assert.equal([...bench.matchAll(/ladderStep\(/g)].length, 1, "one ladderStep call site");
assert.match(bench, /ladderStep\(step, ctx\)/, "ladderStep receives only the context");
assert.match(bench, /const endpoints = readEndpoints\(inputs\.source\)/, "the source npz is read only through readEndpoints");
// Outside readEndpoints the source npz may appear only in the provenance record
// and in scoreAgainstGt (the scorer, which runs after the step is built).
const sourceUses = bench.split("\n").map((line, index) => ({ line, index })).filter(({ line }) => /inputs\.source/.test(line));
assert.equal(sourceUses.length, 3, `inputs.source uses: ${sourceUses.map((u) => u.index + 1)}`);
const scorerStart = bench.indexOf("function scoreAgainstGt("), scorerEnd = bench.indexOf("\n}\n", scorerStart);
for (const { line } of sourceUses) {
	const at = bench.indexOf(line);
	const allowed = line.includes("readEndpoints(inputs.source)") || line.includes("endpoints: { path: inputs.source") || (at > scorerStart && at < scorerEnd);
	assert.ok(allowed, `inputs.source leaks outside readEndpoints/provenance/scorer: ${line.trim()}`);
}

// 3. The box-side extractor sees the video, K, detector choice, betas and
// post-processing knobs only.
const args = [...read("tools/bench/cclay_bench_extract_obs.py").matchAll(/add_argument\("([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(args, ["--K-json", "--betas-json", "--check-pp", "--detector", "--keypoints", "--out-root", "--pp-clamp", "--pp-thr", "output", "runner", "video"].sort(), `extractor arguments: ${args}`);

// 4. readEndpoints returns the first and last pose only: rewriting every middle
// frame of the source motion leaves what the ladder receives unchanged.
const dir = mkdtempSync(join(tmpdir(), "obs-isolation-"));
try {
	const frames = 9;
	const motion = (middle) => {
		const rot = new Float32Array(frames * 243), pos = new Float32Array(frames * 3);
		for (let f = 0; f < frames; f++) {
			for (let j = 0; j < 27; j++) { rot[f * 243 + j * 9] = 1; rot[f * 243 + j * 9 + 4] = 1; rot[f * 243 + j * 9 + 8] = 1; }
			pos.set([f * 0.1, 1, 0], f * 3);
			if (f > 0 && f < frames - 1) pos.set([middle, middle, middle], f * 3);
		}
		return { local_rot_mats: { data: rot, shape: [frames, 27, 3, 3] }, root_positions: { data: pos, shape: [frames, 3] } };
	};
	const a = join(dir, "a.npz"), b = join(dir, "b.npz");
	writeNpz(a, motion(0));
	writeNpz(b, motion(42));
	const ea = readEndpoints(a), eb = readEndpoints(b);
	assert.equal(ea.length, 2, "two endpoint poses");
	for (let i = 0; i < 2; i++) {
		assert.deepEqual(Array.from(ea[i].rootPos), Array.from(eb[i].rootPos), `endpoint ${i} root independent of middle frames`);
		assert.deepEqual(Array.from(ea[i].rotMats), Array.from(eb[i].rotMats), `endpoint ${i} rotations independent of middle frames`);
	}
	assert.deepEqual(Array.from(ea[1].rootPos).map((v) => Number(v.toFixed(5))), [0.8, 1, 0], "last endpoint is the final frame");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("PASS verify-obs-isolation: ladder modules pure, context keys {camera, ankleHeight, endpoints, boxes, base, mannequin}, extractor args video/K/detector/betas/pp, endpoints first+last only");
