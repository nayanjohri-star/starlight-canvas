#!/usr/bin/env node
// unwrapHeadingFlips (#492): GVHMR's global_orient flips front/back about world
// vertical for a few frames when ViTPose swaps left/right on the faceless
// mannequin. The unwrap must remove those short runs (including one at the
// clip start and one whose exit is spread over a mid-flip frame), leave every
// other frame byte-identical, and leave a genuine slow turn alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { axisAngleToMatrix, matrixToAxisAngle } from "../tools/bench/obs/extrinsics.mjs";
import { unwrapHeadingFlips } from "../tools/bench/obs/heading.mjs";

const DEG = 180 / Math.PI;

const mul = (a, b) => Array.from({ length: 9 }, (_, k) => { const i = Math.floor(k / 3), j = k % 3; return a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; });
const rot = (axis, deg) => axisAngleToMatrix(axis.map((v) => (v * deg) / DEG));
const Ry = (deg) => rot([0, 1, 0], deg);
const geodesic = (a, b) => { const A = axisAngleToMatrix(a), B = axisAngleToMatrix(b); let tr = 0; for (let i = 0; i < 9; i++) tr += A[i] * B[i]; return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * DEG; };
const maxStep = (s) => Math.max(...s.slice(1).map((aa, t) => geodesic(aa, s[t])));
const inRun = (runs, t) => runs.some((r) => t >= r.start && t <= r.end);
const wrap = (a) => a - 360 * Math.floor((a + 180) / 360);

function assertUntouched(input, out, runs, label) {
	let n = 0;
	for (let t = 0; t < input.length; t++) {
		if (inRun(runs, t)) continue;
		n++;
		for (let k = 0; k < 3; k++) assert.ok(Object.is(out[t][k], input[t][k]), `${label}: frame ${t} outside every run is byte-identical`);
	}
	return n;
}

// --- Synthetic: slow drift + wobbling tilt, three injected flip runs. ---
const T = 80;
const base = Array.from({ length: T }, (_, t) => mul(Ry(20 + 0.5 * t), mul(rot([1, 0, 0], 8 * Math.sin(t / 7)), rot([0, 0, 1], 4 * Math.cos(t / 5)))));
const flipped = base.map((R, t) => {
	if (t <= 2) return mul(Ry(-170), R); // run at frame 0
	if (t >= 20 && t <= 26) return mul(Ry(150), R); // 7-frame 150 deg run
	if (t === 27) return mul(Ry(75), mul(rot([1, 0, 0], 25), R)); // mid-flip exit frame, tilt corrupted too
	if (t >= 50 && t <= 54) return mul(Ry(115 - 2 * (t - 50)), R); // 115 deg run, not exactly opposite at exit (107)
	return R;
});
const synth = flipped.map(matrixToAxisAngle);
const { orient: synthOut, runs: synthRuns } = unwrapHeadingFlips(synth);

assert.ok(maxStep(synth) > 100, "the synthetic input flips (the test can fail)");
assert.deepEqual(synthRuns.map(({ start, end }) => [start, end]), [[0, 2], [20, 27], [50, 54]], `runs detected: ${JSON.stringify(synthRuns)}`);
for (const [run, want] of [[synthRuns[0], -170], [synthRuns[1], 150], [synthRuns[2], 115]]) assert.ok(Math.abs(wrap(run.yawDeg - want)) < 3, `run ${run.start}-${run.end} measured ${run.yawDeg} deg, injected ${want}`);
const synthMax = maxStep(synthOut);
assert.ok(synthMax < 5, `max per-frame rotation after unwrap ${synthMax.toFixed(2)} deg < 5`);
const synthErr = Math.max(...synthOut.map((aa, t) => geodesic(aa, matrixToAxisAngle(base[t]))));
assert.ok(synthErr < 5, `unwrapped series within ${synthErr.toFixed(2)} deg of the unflipped truth`);
const synthKept = assertUntouched(synth, synthOut, synthRuns, "synthetic");
for (const t of [0, 1, 2, 20, 21, 22, 23, 24, 25, 26, 50, 51, 52, 53, 54]) {
	const a = axisAngleToMatrix(synth[t]), b = axisAngleToMatrix(synthOut[t]);
	assert.ok(Math.abs(a[4] - b[4]) < 1e-9, `frame ${t}: yaw-only correction leaves the tilt from vertical unchanged`);
}

// --- A genuine slow turn: 180 deg over 40 frames is not a flip. ---
const turn = Array.from({ length: 60 }, (_, t) => matrixToAxisAngle(mul(Ry(10 + 180 * Math.min(1, Math.max(0, (t - 10) / 40))), rot([1, 0, 0], 6))));
const turnResult = unwrapHeadingFlips(turn);
assert.deepEqual(turnResult.runs, [], "slow 180 deg turn has no runs");
assertUntouched(turn, turnResult.orient, [], "slow turn");

// --- Real GVHMR output (raw global orient series committed as a fixture). ---
const REAL = JSON.parse(readFileSync(new URL("./fixtures/heading-orient.json", import.meta.url), "utf8")).items;
function realOrient(id) {
	assert.ok(REAL[id], `fixture has ${id}`);
	return REAL[id].map((v) => v.slice());
}
const real = [];
for (const id of ["gt/walk", "fal/stepup-shaded-01"]) {
	const input = realOrient(id);
	const { orient, runs } = unwrapHeadingFlips(input);
	const before = maxStep(input), after = maxStep(orient);
	assert.ok(before > 90, `${id}: raw orient flips (${before.toFixed(1)} deg/frame; the test can fail)`);
	assert.ok(runs.length > 0, `${id}: flip runs detected`);
	assert.ok(after < 30, `${id}: after unwrap no frame-to-frame rotation > 30 deg (max ${after.toFixed(1)})`);
	assertUntouched(input, orient, runs, id);
	real.push(`${id} ${before.toFixed(1)}->${after.toFixed(1)} deg/frame runs ${runs.map((r) => `${r.start}-${r.end}`).join(",")}`);
}
{
	const input = realOrient("gt/turn");
	const { orient, runs } = unwrapHeadingFlips(input);
	assert.deepEqual(runs, [], "gt/turn (real 180 deg turn) has no runs");
	assertUntouched(input, orient, runs, "gt/turn");
	real.push(`gt/turn ${maxStep(input).toFixed(1)} deg/frame unchanged`);
}

console.log(`PASS verify-heading-unwrap: synthetic runs ${synthRuns.map((r) => `${r.start}-${r.end}@${r.yawDeg}`).join(" ")} -> max ${synthMax.toFixed(2)} deg/frame, ${synthKept} frames untouched; slow turn untouched; ${real.join("; ")}`);
