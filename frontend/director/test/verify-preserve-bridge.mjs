#!/usr/bin/env node

// Scheduled inpainting, wired end to end (contract C3).
//
// tools/kimodo/preserve-mask.mjs owns the mask itself and is pinned by
// verify-kimodo-preserve.mjs. THIS file pins the wiring around it: what the
// bridge accepts and refuses, how a preserve request reaches the Kimodo box,
// and the one arithmetic rule that decides whether the box accepts the mask at
// all.
//
// The bridge's validator cannot be imported — bridge.mjs binds a socket on
// load — so it is exercised the way a client sees it: a real sidecar on a
// loopback port, one POST per rule, asserting the reason string names the
// field it refused.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { motionArraysToNpzMembers, poseArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { createKimodoRunner, nativeMotionPath, preserveMaskPath } from "../tools/kimodo/runner.mjs";
import { cliGenFrames, generateOnBox, scaleMaskAmplitude } from "../tools/kimodo/generate.mjs";
import { buildPreserveMask, rootFreeMask } from "../tools/kimodo/preserve-mask.mjs";
import { planEditConstraints } from "../tools/kimodo/edit.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const REPO = new URL("..", import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------- */
/* the generated frame count the mask is sized against                        */
/* ------------------------------------------------------------------------- */
// kimodo/scripts/generate.py does `int(duration_sec * fps)` and then REFUSES a
// mask whose genFrames differs by one. Rounding instead of truncating is the
// single silent way to fail every preserve run on a clip whose length lands on
// a half frame, so the rule is pinned against the CLI's arithmetic, not ours.
{
	assert.equal(cliGenFrames(5, 30), 150, "a whole number of seconds is exact either way");
	assert.equal(cliGenFrames(119 / 24, 30), 148, "148.75 generation frames truncate to 148, not 149");
	assert.notEqual(cliGenFrames(119 / 24, 30), Math.round((119 / 24) * 30), "rounding would disagree with the box");
	// 196 app frames is 8.166666666666666 s, and that times 30 is
	// 244.99999999999997 in IEEE-754 — on BOTH sides. Python's int() takes 244
	// and Math.trunc reproduces it; rounding would ask the box for 245 frames of
	// mask against a 244-frame clip and the run would die there.
	assert.equal(cliGenFrames(196 / 24, 30), 244, "a product a hair below an integer truncates down on both sides");
	assert.equal(Math.round((196 / 24) * 30), 245, "...where rounding lands one frame too high");
	assert.equal(cliGenFrames(2, 30), 60);
	pass("the mask is sized with the CLI's truncation, not with rounding");
}

/* ------------------------------------------------------------------------- */
/* the runner: how preserve reaches the box, and what it keeps for next time   */
/* ------------------------------------------------------------------------- */
const SAVED_ENV = { ...process.env };
const RUNNER_KEYS = ["CCLAY_KIMODO_HOST", "CCLAY_KIMODO_PRESERVE", "CCLAY_KIMODO_NATIVE_OUT"];
function withEnv(env, body) {
	for (const key of RUNNER_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of RUNNER_KEYS) delete process.env[key];
		Object.assign(process.env, SAVED_ENV);
	}
}

const PRESERVE = {
	basePath: "/runs/generate-abc/generated.kimodo.npz",
	sigmaS: 500,
	sigmaE: 50,
	editRanges: [{ startFrame: 40, endFrame: 80 }],
};
const OUTPUT = "/runs/generate-xyz/generated.npz";

{
	const runner = withEnv({ CCLAY_KIMODO_HOST: "user@kimodo-box" }, () => createKimodoRunner());

	// The wrapper scripts' argv is a frozen contract shared with the ARDY
	// wrappers, so preserve travels in the environment. An unknown flag would be
	// a usage() exit, which is why this is asserted rather than assumed.
	const preserved = runner.singleCommand({ prompt: "A person walks", durationS: 5, preserve: PRESERVE, output: OUTPUT });
	assert.ok(!preserved.args.some((arg) => String(arg).startsWith("--preserve")), "preserve must not be smuggled onto argv");
	const shipped = JSON.parse(preserved.env.CCLAY_KIMODO_PRESERVE);
	assert.equal(shipped.basePath, PRESERVE.basePath);
	assert.equal(shipped.sigmaS, 500);
	assert.equal(shipped.sigmaE, 50);
	assert.deepEqual(shipped.editRanges, PRESERVE.editRanges, "edit ranges reach the mask builder unchanged");
	assert.equal(shipped.maskPath, preserveMaskPath(OUTPUT), "the mask is kept in the run directory");
	assert.equal(shipped.maskPath, "/runs/generate-xyz/preserve-mask.json");
	pass("a preserve request reaches the box through CCLAY_KIMODO_PRESERVE");

	// preserve + waypoints (C3v2) uses BOTH channels of the same invocation: the
	// path is argv (--root-2d, the frozen wrapper contract), the preserve object
	// is the environment. Neither displaces the other, and the rootFree flag the
	// bridge set travels verbatim — the runner interprets nothing.
	const withPath = runner.singleCommand({
		prompt: "A person walks",
		durationS: 5,
		waypoints: [
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 60, x: 3, z: 0, heading: null },
		],
		preserve: { ...PRESERVE, rootFree: true },
		output: OUTPUT,
	});
	assert.equal(withPath.args.filter((arg) => arg === "--root-2d").length, 2, "both waypoints reach argv");
	const shippedWithPath = JSON.parse(withPath.env.CCLAY_KIMODO_PRESERVE);
	assert.equal(shippedWithPath.rootFree, true, "rootFree reaches the box in the preserve JSON");
	assert.equal(shippedWithPath.basePath, PRESERVE.basePath, "and the base motion still rides with it");
	assert.equal(JSON.parse(preserved.env.CCLAY_KIMODO_PRESERVE).rootFree, undefined, "absent unless the bridge set it");
	pass("preserve + waypoints compose: path on argv, rootFree in the preserve JSON");

	// Kimodo's --base_motion reads the npz its own generator wrote; the cskel27
	// file the bridge serves is a conversion of it. Every whole-clip run keeps
	// the native one beside its output so a LATER run can preserve from it.
	const kept = runner.singleCommand({ prompt: "A person walks", durationS: 5, keepNative: true, output: OUTPUT });
	assert.equal(kept.env.CCLAY_KIMODO_NATIVE_OUT, nativeMotionPath(OUTPUT));
	assert.equal(kept.env.CCLAY_KIMODO_NATIVE_OUT, "/runs/generate-xyz/generated.kimodo.npz");
	assert.equal(kept.env.CCLAY_KIMODO_PRESERVE, undefined, "keeping a base does not turn preservation on");
	pass("a whole-clip run keeps Kimodo's own npz beside its take");

	// An edit SPLICES its regenerated span into the source take, so the npz
	// Kimodo wrote is not the take that comes out and must never become a base.
	const edit = runner.editCommand({
		source: "/runs/generate-abc/generated.npz",
		manifest: "/runs/generate-xyz/edit-manifest.json",
		prompt: "A person waves",
		contextBefore: 8,
		contextAfter: 8,
		preserve: PRESERVE,
		output: "/runs/generate-xyz/constrained.npz",
	});
	assert.equal(edit.env.CCLAY_KIMODO_NATIVE_OUT, undefined, "a spliced take must not be kept as a base motion");
	assert.equal(JSON.parse(edit.env.CCLAY_KIMODO_PRESERVE).basePath, PRESERVE.basePath, "an edit can still preserve");
	pass("an edit run preserves but never keeps a base of its own");

	// The bridge is a long-lived sidecar: a value left over from the previous
	// request would preserve the wrong take on this one, silently.
	const stale = withEnv(
		{
			CCLAY_KIMODO_HOST: "user@kimodo-box",
			CCLAY_KIMODO_PRESERVE: JSON.stringify(PRESERVE),
			CCLAY_KIMODO_NATIVE_OUT: "/runs/stale/generated.kimodo.npz",
		},
		() => createKimodoRunner().singleCommand({ prompt: "A person walks", durationS: 5, output: OUTPUT }),
	);
	assert.equal(stale.env.CCLAY_KIMODO_PRESERVE, undefined, "an inherited preserve must not leak into a plain run");
	assert.equal(stale.env.CCLAY_KIMODO_NATIVE_OUT, undefined, "an inherited native-out must not leak into a plain run");
	pass("a plain generation clears both inherited preserve variables");

	// The base clip refusal is unrelated machinery (autoregressive history) and
	// must survive preserve landing next to it.
	assert.throws(
		() => runner.singleCommand({ prompt: "x", durationS: 1, basePath: "/base.npz", output: OUTPUT }),
		/does not implement base clips/,
		"the base-clip refusal must survive",
	);
	pass("preserve is supported while base clips still refuse by name");

	// Resolving a take back to this backend's base motion.
	const runDir = mkdtempSync(join(tmpdir(), "cclay-preserve-"));
	try {
		const take = join(runDir, "generated.npz");
		writeFileSync(take, "cskel27");
		assert.equal(runner.baseMotionFor(take), null, "a take with no native npz has no base motion");
		writeFileSync(nativeMotionPath(take), "kimodo-native");
		assert.equal(runner.baseMotionFor(take), join(runDir, "generated.kimodo.npz"));
		pass("baseMotionFor finds the native npz beside a take, or reports none");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------------- */
/* generate.mjs refuses a preserve plan it cannot ship                         */
/* ------------------------------------------------------------------------- */
// Every one of these is caught before any ssh, so a bad plan costs nothing.
{
	const segments = [{ prompt: "A person walks", duration: 4 }];
	const call = (preserve, extra = {}) =>
		generateOnBox({ segments, host: "nobody@nowhere.invalid", preserve, ...extra });

	await assert.rejects(
		() => call({ ...PRESERVE }, { segments: [{ prompt: "A person walks", duration: 2 }, { prompt: "A person waves", duration: 2 }] }),
		/single segment/,
		"the box would refuse a prompt schedule; refuse it before the GPU is booked",
	);
	await assert.rejects(() => call({ ...PRESERVE, basePath: "" }), /basePath/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 1500 }), /sigmaS must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 12.5 }), /sigmaS must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaE: -1 }), /sigmaE must be an integer in 0\.\.1000/);
	await assert.rejects(() => call({ ...PRESERVE, sigmaS: 400, sigmaE: 600 }), /must be <= preserve\.sigmaS/);
	// A range outside the generated clip reaches the mask builder's own refusal.
	await assert.rejects(() => call({ ...PRESERVE, editRanges: [{ startFrame: 9000, endFrame: 9100 }] }), /buildPreserveMask/);
	pass("generate.mjs refuses an unshippable preserve plan before touching the box");
}

/* ------------------------------------------------------------------------- */
/* the strength dial scales EVERY level of a v2 mask                           */
/* ------------------------------------------------------------------------- */
// Round 1's scaling touched `weights` only. A v2 mask carries up to four kinds of
// array, and Python reads a GROUP's array instead of the top level for that
// group's features — so scaling only the top level would leave every grouped
// feature pinned at full amplitude however the slider is set, and would let the
// high-noise pass disagree with the low-noise one about the same frame.
{
	const grouped = buildPreserveMask(
		[{ startFrame: 40, endFrame: 80, tracks: ["leftHand"] }, { startFrame: 10, endFrame: 20 }],
		{ appFps: 24, genFps: 30, genFrames: 150 },
	);
	assert.equal(grouped.version, 2);
	assert.ok(Array.isArray(grouped.wideWeights), "a tracked range opts into the noise-scheduled kernel");
	assert.ok(grouped.groups.leftArm, "leftHand frees the leftArm group");
	assert.ok(Array.isArray(grouped.groups.leftArm.wideWeights));

	const half = scaleMaskAmplitude(grouped, 0.5);
	const levels = [
		["weights", grouped.weights, half.weights],
		["wideWeights", grouped.wideWeights, half.wideWeights],
		["groups.leftArm.weights", grouped.groups.leftArm.weights, half.groups.leftArm.weights],
		["groups.leftArm.wideWeights", grouped.groups.leftArm.wideWeights, half.groups.leftArm.wideWeights],
	];
	for (const [label, before, after] of levels) {
		assert.ok(Array.isArray(after), `${label} must survive scaling`);
		assert.equal(after.length, before.length, `${label} keeps its length`);
		assert.ok(after.some((w) => w > 0), `${label} is not all zero to begin with`);
		for (let f = 0; f < before.length; f += 1) {
			assert.ok(Math.abs(after[f] - before[f] * 0.5) < 1e-12, `${label}[${f}] must be scaled`);
			// The Python loader RAISES beyond 1 + 1e-6; multiplying by <= 1 can
			// never get there, and an edit's 0 must stay exactly 0 or the slider
			// would quietly re-preserve the frames the user freed.
			assert.ok(after[f] >= 0 && after[f] <= 1, `${label}[${f}] must stay inside 0..1`);
			if (before[f] === 0) assert.equal(after[f], 0, `${label}[${f}] was free and must stay free`);
		}
	}
	assert.deepEqual(Object.keys(half.groups), Object.keys(grouped.groups), "group order is stable");
	assert.notEqual(half, grouped, "scaling returns a new object");
	assert.deepEqual(grouped.weights, buildPreserveMask(
		[{ startFrame: 40, endFrame: 80, tracks: ["leftHand"] }, { startFrame: 10, endFrame: 20 }],
		{ appFps: 24, genFps: 30, genFrames: 150 },
	).weights, "scaling must not mutate its input");

	assert.equal(scaleMaskAmplitude(grouped, 1), grouped, "full strength is the identity, by reference");
	for (const bad of [0, -0.5, 1.5, Number.NaN, "0.5", null]) {
		assert.throws(() => scaleMaskAmplitude(grouped, bad), /strength must be a number in \(0,1\]/);
	}
	// A v1 mask has nothing but the top level, and must not grow keys.
	const v1 = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], { appFps: 24, genFps: 30, genFrames: 150 });
	const v1Half = scaleMaskAmplitude(v1, 0.5);
	assert.deepEqual(Object.keys(v1Half), Object.keys(v1), "a v1 mask stays v1 shaped after scaling");
	pass("the strength dial scales weights, wideWeights and every group array");
}

/* ------------------------------------------------------------------------- */
/* the mask that actually ships: tracks, and the freed root of preserve+path   */
/* ------------------------------------------------------------------------- */
// generate.mjs writes the mask to `maskPath` BEFORE it touches the box, so the
// exact bytes the box would have received can be read back from a run that dies
// on the first ssh. That is the only way to see the composed mask: it is built in
// one place, on purpose, and never returned before the run completes.
async function shippedMask(preserve, extra = {}) {
	const dir = mkdtempSync(join(tmpdir(), "cclay-mask-"));
	const maskPath = join(dir, "preserve-mask.json");
	try {
		await assert.rejects(
			() =>
				generateOnBox({
					segments: [{ prompt: "A person walks", duration: 5 }],
					host: "nobody@nowhere.invalid",
					preserve: { ...preserve, maskPath },
					...extra,
				}),
			/nowhere\.invalid|could not create|could not copy/,
			"the run must die at the box, not before the mask is written",
		);
		return JSON.parse(readFileSync(maskPath, "utf8"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

{
	// 5 s at 30 fps: 150 generation frames, the CLI's own arithmetic.
	const GEN_FRAMES = 150;

	// (a) tracks reach the mask builder and scope the edit to its groups.
	const scoped = await shippedMask({
		...PRESERVE,
		strength: 1,
		editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["leftHand", "leftElbow"] }],
	});
	assert.equal(scoped.version, 2, "a tracked range emits a v2 document");
	assert.equal(scoped.genFrames, GEN_FRAMES);
	assert.deepEqual(Object.keys(scoped.groups), ["leftArm"], "leftHand + leftElbow free exactly one group");
	assert.ok(scoped.weights.every((w) => w === 1), "a tracked range must not free the top level");
	assert.ok(scoped.groups.leftArm.weights.some((w) => w === 0), "the arm is free inside the range");
	pass("editRanges[].tracks reach the mask builder and free only their groups");

	// (b) preserve + waypoints: the root group is freed for the WHOLE clip.
	const rootFree = await shippedMask({ ...PRESERVE, strength: 1, editRanges: [], rootFree: true });
	assert.deepEqual(
		rootFree,
		rootFreeMask({ genFps: 30, genFrames: GEN_FRAMES }),
		"with no edits, the composed mask IS the mask builder's own rootFreeMask",
	);
	assert.ok(rootFree.weights.every((w) => w === 1), "the body still rides the preserved take");
	assert.ok(rootFree.groups.root.weights.every((w) => w === 0), "the drawn path owns the root, end to end");
	pass("preserve + waypoints frees the root group for the whole clip");

	// (c) editRanges + waypoints + preserve TOGETHER: the editRanges mask with the
	// root forced free. The body keeps the base except where it was edited.
	const both = await shippedMask({
		...PRESERVE,
		strength: 1,
		rootFree: true,
		editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["rightHand"] }],
	});
	assert.deepEqual(Object.keys(both.groups).sort(), ["rightArm", "root"], "the edit's group AND the freed root");
	assert.ok(both.groups.rightArm.weights.some((w) => w === 0), "the edited arm is still free where it was edited");
	assert.ok(both.groups.root.weights.every((w) => w === 0), "and the root is free everywhere");
	assert.ok(both.weights.every((w) => w === 1), "everything else is preserved");
	pass("editRanges + waypoints + preserve compose: the edit's mask with the root freed");

	// (d) the same composition, through the strength dial: the freed root cannot
	// be re-preserved by it, and every other level scales.
	const dialled = await shippedMask({ ...PRESERVE, strength: 0.5, rootFree: true, editRanges: [] });
	assert.ok(dialled.weights.every((w) => w === 0.5), "the dial caps the blend amplitude");
	assert.ok(dialled.groups.root.weights.every((w) => w === 0), "0 * strength is still 0: the root stays free");
	pass("the strength dial scales the composed mask without re-preserving the root");
}

/* ------------------------------------------------------------------------- */
/* the strength -> diffusion-time mapping                                      */
/* ------------------------------------------------------------------------- */
// Server-side by contract, and numeric: a client never speaks in diffusion-time
// units, and the paper's recommended pair is 500/50. Reachable only through a
// real generated take, so the formula is pinned against the source.
{
	const bridgeSource = readFileSync(new URL("tools/ardy/bridge.mjs", REPO), "utf8");
	assert.match(bridgeSource, /const PRESERVE_SIGMA_MAX = 1000;/);
	assert.match(bridgeSource, /const PRESERVE_SIGMA_END_CAP = 50;/);
	// INVERTED mapping: a smaller sigma_s preserves MORE (alpha_time is 1 above
	// sigma_s), measured on the box in gate G3. Full strength floors at the end
	// cap instead of rounding sigma_s to 0, which would read as preserve-off.
	assert.match(
		bridgeSource,
		/const sigmaS = Math\.max\(PRESERVE_SIGMA_END_CAP, Math\.round\(PRESERVE_SIGMA_MAX \* \(1 - strength\)\)\);/,
	);
	assert.match(bridgeSource, /sigmaE: Math\.min\(PRESERVE_SIGMA_END_CAP, sigmaS\)/);
	// The contract's default is unchanged by the inversion: strength 0.5 -> 500/50.
	assert.equal(Math.max(50, Math.round(1000 * (1 - 0.5))), 500);
	assert.equal(Math.min(50, 500), 50);
	// Full preserve is a step schedule, not preserve-off.
	assert.equal(Math.max(50, Math.round(1000 * (1 - 1))), 50);
	pass("strength maps to sigma_s = max(50, round(1000*(1-s))) with sigma_e capped at 50");

	// Where rootFree is DECIDED. Like the sigma mapping it is unreachable without
	// a real take on disk, so it is pinned against the source: the presence of
	// waypoints, and nothing else, frees the root group.
	assert.match(bridgeSource, /rootFree: body\.waypoints !== undefined,/);
	// And the refusal it replaced must be gone, not merely unreachable.
	assert.doesNotMatch(bridgeSource, /cannot be combined with waypoints/);
	assert.match(bridgeSource, /cannot be combined with regenerateSegments/);
	assert.match(bridgeSource, /scheduled inpainting v1 supports a single segment/);
	pass("rootFree is set by the presence of waypoints, and only there");
}

/* ------------------------------------------------------------------------- */
/* C5: an edit's author keys switch to effector constraints, anchors do not     */
/* ------------------------------------------------------------------------- */
// planEditConstraints owns the fullbody-vs-EE decision (effector-constraints.mjs
// throws rather than choose for it), so the decision is pinned here — this file
// owns the wiring. Fixtures follow verify-kimodo-edit.mjs: a synthetic take whose
// every frame is identifiable by its root Z, plus one identity pose npz.
{
	const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	const work = mkdtempSync(join(tmpdir(), "cclay-edit-mode-"));
	try {
		const sourcePath = join(work, "source.npz");
		{
			const frames = 120;
			const rotMats = new Float32Array(frames * 27 * 9);
			const posedJoints = new Float32Array(frames * 27 * 3);
			const rootPos = new Float32Array(frames * 3);
			for (let f = 0; f < frames; f += 1) {
				for (let j = 0; j < 27; j += 1) {
					const b = (f * 27 + j) * 9;
					rotMats[b] = 1; rotMats[b + 4] = 1; rotMats[b + 8] = 1;
					posedJoints[(f * 27 + j) * 3 + 1] = 1 - j * 0.01;
					posedJoints[(f * 27 + j) * 3 + 2] = f * 0.1;
				}
				rootPos[f * 3 + 1] = 0.95;
				rootPos[f * 3 + 2] = f * 0.1;
			}
			writeNpz(sourcePath, motionArraysToNpzMembers({ frames, fps: 20, rotMats, rootPos, posedJoints }));
		}
		writeNpz(
			join(work, "pose-0.npz"),
			poseArraysToNpzMembers({
				local_rot_mats: CSKEL27_JOINTS.map(() => IDENTITY.map((r) => r.slice())),
				posed_joints: CSKEL27_JOINTS.map((_, i) => [0, 1 - i * 0.01, 0]),
			}),
		);

		let manifestCount = 0;
		const planFor = (edits, context = 4) => {
			const manifestPath = join(work, `manifest-${(manifestCount += 1)}.json`);
			writeFileSync(manifestPath, JSON.stringify({ start_frame: 40, end_frame: 80, edits }));
			return planEditConstraints({
				sourcePath,
				manifestPath,
				contextBefore: context,
				contextAfter: context,
				genFps: 20,
				appFps: 20,
			});
		};
		const key = (frame, tracks) => ({ frame, tracks, pose_path: "pose-0.npz" });

		// ---- every edited track maps to a limb -> effector -------------------
		{
			const plan = planFor([key(60, ["leftHand"])]);
			assert.equal(plan.constraintMode, "effector");
			assert.deepEqual(plan.editedTracks, ["leftHand"]);
			const types = plan.constraints.map((entry) => entry.type);
			assert.deepEqual(types, ["fullbody", "left-hand"], "anchors stay fullbody; the author's key does not");
			const anchorFrames = plan.constraints[0].frame_indices;
			const handFrames = plan.constraints[1].frame_indices;
			assert.deepEqual(handFrames, [60], "only the author's own frame is effector-pinned");
			assert.ok(!anchorFrames.includes(60), "the edited frame must not ALSO be pinned fullbody");
			// The invariant planEditConstraints' byFrame map exists to guarantee: a
			// frame never carries both a fullbody anchor and an EE edit. If it did,
			// Kimodo would apply two constraints to one frame from two poses.
			assert.equal(
				anchorFrames.filter((f) => handFrames.includes(f)).length,
				0,
				"anchor frames and author frames must be disjoint",
			);
			assert.ok(anchorFrames.some((f) => f < 40) && anchorFrames.some((f) => f >= 80), "context on both sides");
			assert.equal(plan.constraints[1].local_joints_rot[0].length, 77, "EE entries still ride on somaskel77");
			pass("a hand edit pins the hand chain and leaves the anchors fullbody");
		}

		// ---- two limbs -> one entry per distinct chain, shared payload -------
		{
			const plan = planFor([key(50, ["leftHand", "leftElbow"]), key(60, ["rightFoot"])]);
			assert.equal(plan.constraintMode, "effector");
			assert.deepEqual(
				plan.constraints.map((entry) => entry.type),
				["fullbody", "left-hand", "right-foot"],
				"leftHand + leftElbow are one chain; rightFoot is a second",
			);
			assert.deepEqual(plan.constraints[1].frame_indices, [50, 60]);
			assert.equal(
				plan.constraints[1].frame_indices,
				plan.constraints[2].frame_indices,
				"the effector entries share one payload by reference",
			);
			pass("two edited limbs emit one entry per chain over the same author frames");
		}

		// ---- anything that is not a limb -> fullbody for everything ----------
		{
			const hips = planFor([key(60, ["hips"])]);
			assert.equal(hips.constraintMode, "fullbody", "hips has no effector: the whole body is pinned");
			assert.deepEqual(hips.constraints.map((entry) => entry.type), ["fullbody"]);
			assert.ok(hips.constraints[0].frame_indices.includes(60), "one entry carries anchors and the key alike");

			const mixed = planFor([key(50, ["leftHand"]), key(60, ["head"])]);
			assert.equal(mixed.constraintMode, "fullbody", "EVERY edited track must map, not merely one");
			assert.deepEqual(mixed.constraints.map((entry) => entry.type), ["fullbody"]);

			const untracked = planFor([{ frame: 60, pose_path: "pose-0.npz" }]);
			assert.equal(untracked.constraintMode, "fullbody", "an edit that names no track cannot claim a chain");
			pass("a non-limb, mixed or untracked edit keeps round 1's fullbody pin");
		}

		// ---- no context at all: the EE entry is the whole constraint set -----
		{
			const plan = planFor([key(60, ["rightHand"])], 0);
			assert.deepEqual(plan.constraints.map((entry) => entry.type), ["right-hand"], "no anchors, no fullbody entry");
			assert.deepEqual(plan.constraints[0].frame_indices, [60]);
			pass("with no context frames an effector edit ships only its own chain");
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------------- */
/* the bridge validator, over the wire                                         */
/* ------------------------------------------------------------------------- */

function freePort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close((error) => (error ? reject(error) : resolvePromise(port)));
		});
	});
}

const port = await freePort();
const bridge = fork(join(HERE, "..", "tools", "ardy", "bridge.mjs"), [], {
	cwd: REPO,
	env: {
		...process.env,
		CCLAY_MOTION_BACKEND: "kimodo",
		CCLAY_KIMODO_HOST: "test@kimodo",
		COZYCLAY_BRIDGE_PORT: String(port),
	},
	stdio: ["ignore", "ignore", "ignore", "ipc"],
});

let failures = 0;
try {
	const ready = await Promise.race([
		once(bridge, "message"),
		new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not report readiness")), READY_TIMEOUT_MS).unref()),
	]);
	assert.deepEqual(ready[0], { type: "cozyclay-bridge-ready", port });

	// duration 5 s on the bridge's 24 fps clock = a 120-frame clip.
	const CLIP_FRAMES = 120;
	const MOTION = "/ardy/motions/1700000000000-abcdef";
	const POSE = { schema: "cozyclay.pose.v1", root: [0, 0.9, 0] };
	const FREE = { prompt: "A person walks", duration: 5, posePin: false };
	const PINNED = { prompt: "A person walks", duration: 5, poses: [{ frame: 0, pose: POSE }] };
	const OK_PRESERVE = { sourceMotion: MOTION, strength: 0.5, editRanges: [{ startFrame: 40, endFrame: 80 }] };

	async function post(body) {
		const response = await fetch(`http://127.0.0.1:${port}/ardy/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// A refused request answers JSON; an accepted one opens an NDJSON stream.
		const text = await response.text();
		const first = text.split("\n").find(Boolean) ?? "";
		return { status: response.status, ...JSON.parse(first) };
	}

	async function refuses(label, body, pattern) {
		const { status, reason, message } = await post(body);
		const said = reason ?? message ?? "";
		try {
			assert.equal(status, 400, `${label} must be refused with 400, got ${status} (${said})`);
			assert.match(said, pattern, label);
			pass(label);
		} catch (error) {
			failures += 1;
			console.error(`FAIL ${error.message}`);
		}
	}

	// ---- shape ------------------------------------------------------------
	await refuses("preserve must be an object", { ...FREE, preserve: [] }, /field 'preserve' must be an object/);
	await refuses("preserve must not be a string", { ...FREE, preserve: "yes" }, /field 'preserve' must be an object/);
	await refuses("preserve must not be null", { ...FREE, preserve: null }, /field 'preserve' must be an object/);

	// ---- sourceMotion: the same URL shape every other take reference uses ---
	await refuses("sourceMotion is required", { ...FREE, preserve: { strength: 0.5, editRanges: [] } }, /'preserve\.sourceMotion'/);
	await refuses(
		"sourceMotion must be a motion URL",
		{ ...FREE, preserve: { ...OK_PRESERVE, sourceMotion: "/etc/passwd" } },
		/'preserve\.sourceMotion' must be a generated \/ardy\/motions\/<run-id> URL/,
	);
	await refuses(
		"sourceMotion must carry a well-formed run id",
		{ ...FREE, preserve: { ...OK_PRESERVE, sourceMotion: "/ardy/motions/../../etc" } },
		/'preserve\.sourceMotion'/,
	);

	// ---- strength ---------------------------------------------------------
	await refuses("strength is required", { ...FREE, preserve: { sourceMotion: MOTION, editRanges: [] } }, /'preserve\.strength'/);
	await refuses("strength 0 means omit the field", { ...FREE, preserve: { ...OK_PRESERVE, strength: 0 } }, /'preserve\.strength'/);
	await refuses("strength above 1", { ...FREE, preserve: { ...OK_PRESERVE, strength: 1.5 } }, /'preserve\.strength'/);
	await refuses("strength must be a number", { ...FREE, preserve: { ...OK_PRESERVE, strength: "0.5" } }, /'preserve\.strength'/);
	await refuses("strength must be finite", { ...FREE, preserve: { ...OK_PRESERVE, strength: Number.NaN } }, /'preserve\.strength'/);

	// ---- editRanges -------------------------------------------------------
	await refuses("editRanges is required", { ...FREE, preserve: { sourceMotion: MOTION, strength: 0.5 } }, /'preserve\.editRanges' must be an array/);
	await refuses("editRanges must be an array", { ...FREE, preserve: { ...OK_PRESERVE, editRanges: {} } }, /'preserve\.editRanges' must be an array/);
	await refuses(
		"a range must be an object",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [40] } },
		/'preserve\.editRanges\[0\]' must be an object/,
	);
	await refuses(
		"range frames must be integers",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40.5, endFrame: 80 }] } },
		/'preserve\.editRanges\[0\]' startFrame and endFrame must be integers/,
	);
	await refuses(
		"a range must be non-empty",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]' must be a non-empty half-open range inside 0\.\.120/,
	);
	await refuses(
		"a range must not be inverted",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 80, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]'/,
	);
	await refuses(
		"a range must not start before the clip",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: -1, endFrame: 40 }] } },
		/'preserve\.editRanges\[0\]'/,
	);
	await refuses(
		"a range must not run past the clip",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 100, endFrame: 121 }] } },
		/'preserve\.editRanges\[0\]' must be a non-empty half-open range inside 0\.\.120/,
	);
	await refuses(
		"the offending range is named by index",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 0, endFrame: 10 }, { startFrame: 10, endFrame: 10 }] } },
		/'preserve\.editRanges\[1\]'/,
	);

	// ---- editRanges[].tracks (C3v2) ---------------------------------------
	// The valid ids are the mask builder's own table, imported by the bridge so
	// there is one list; these three rules exist so a scoped request never gets
	// past the bridge only to die inside buildPreserveMask on the box.
	await refuses(
		"tracks must be an array",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: "leftHand" }] } },
		/'preserve\.editRanges\[0\]\.tracks' must be an array of IK track ids/,
	);
	await refuses(
		"an empty tracks list is refused rather than guessed",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: [] }] } },
		/'preserve\.editRanges\[0\]\.tracks' is empty — omit the key entirely for a whole-body edit/,
	);
	await refuses(
		"an unknown track id is named, with the valid ones",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["leftHand", "LeftArm"] }] } },
		/'preserve\.editRanges\[0\]\.tracks\[1\]' "LeftArm" is not a known IK track id; valid ids are .*leftHand/,
	);
	await refuses(
		"a non-string track id is refused",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: [7] }] } },
		/'preserve\.editRanges\[0\]\.tracks\[0\]'/,
	);
	// Object.hasOwn, not `in`: an inherited property must not pass for a track.
	await refuses(
		"a prototype property is not a track id",
		{ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["constructor"] }] } },
		/is not a known IK track id/,
	);

	// ---- exclusivity ------------------------------------------------------
	await refuses(
		"preserve cannot ride with a prompt schedule",
		{
			...FREE,
			segments: [
				{ startFrame: 0, endFrame: 60, prompt: "A person walks" },
				{ startFrame: 60, endFrame: CLIP_FRAMES, prompt: "A person waves" },
			],
			preserve: OK_PRESERVE,
		},
		/scheduled inpainting v1 supports a single segment/,
	);
	await refuses(
		"preserve cannot ride with regenerateSegments",
		{
			...PINNED,
			sourceMotion: MOTION,
			regenerateSegments: [{ startFrame: 0, endFrame: 60, prompt: "A person walks" }],
			preserve: OK_PRESERVE,
		},
		/'preserve' cannot be combined with regenerateSegments/,
	);

	// ---- accepted ---------------------------------------------------------
	// Validation passing is proved by WHICH refusal comes next: the request gets
	// past validateGenerate and dies resolving the take it names, which no
	// synthetic run id can satisfy.
	{
		const { status, reason } = await post({ ...FREE, preserve: OK_PRESERVE });
		assert.equal(status, 400);
		assert.match(reason, /field 'preserve\.sourceMotion': unknown or expired motion "1700000000000-abcdef"/);
		pass("a well-formed preserve passes validation and is resolved against the motion allowlist");
	}
	{
		// An empty edit list is the whole-take reconstruction case (gate G1) and
		// must not be mistaken for a missing field.
		const { status, reason } = await post({ ...FREE, preserve: { ...OK_PRESERVE, editRanges: [] } });
		assert.equal(status, 400);
		assert.match(reason, /unknown or expired motion/);
		pass("an empty edit list is valid: preserve the whole take");
	}
	{
		// C3v2: a range scoped to IK tracks is accepted and reaches the resolver.
		const { status, reason } = await post({
			...FREE,
			preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["leftHand", "hips"] }] },
		});
		assert.equal(status, 400);
		assert.match(reason, /unknown or expired motion/, "a valid tracks list must not be refused");
		pass("an edit range scoped to known IK tracks is accepted");
	}
	{
		// ROUND 2, contract C3v2: preserve + waypoints is ALLOWED. The drawn path
		// owns the root (the mask's `root` group is freed end to end) and the body
		// rides the preserved take. Still single-segment: `segments` is refused
		// above, so this is one prompt over one rollout.
		const { status, reason } = await post({
			...FREE,
			waypoints: [
				{ frame: 0, x: 0, z: 0, heading: null },
				{ frame: 60, x: 3, z: 0, heading: null },
			],
			preserve: OK_PRESERVE,
		});
		assert.equal(status, 400);
		assert.doesNotMatch(reason, /cannot be combined with waypoints/, "round 2 lifts the waypoints refusal");
		assert.match(reason, /unknown or expired motion/, "it fails only on the synthetic take id");
		pass("preserve rides with waypoints (the drawn path owns the root)");
	}
	{
		// ...and all three together: an edit range, a path, and a preserved take.
		const { reason } = await post({
			...FREE,
			waypoints: [
				{ frame: 0, x: 0, z: 0, heading: null },
				{ frame: 60, x: 3, z: 0, heading: null },
			],
			preserve: { ...OK_PRESERVE, editRanges: [{ startFrame: 40, endFrame: 80, tracks: ["leftHand"] }] },
		});
		assert.doesNotMatch(reason, /cannot be combined/, "editRanges + waypoints + preserve is allowed");
		assert.match(reason, /unknown or expired motion/);
		pass("editRanges + waypoints + preserve are accepted together");
	}
	{
		// Overlapping ranges are legal; the mask combines them by minimum.
		const overlapping = [{ startFrame: 20, endFrame: 60 }, { startFrame: 40, endFrame: 80 }];
		const { reason } = await post({ ...FREE, preserve: { ...OK_PRESERVE, editRanges: overlapping } });
		assert.match(reason, /unknown or expired motion/);
		pass("overlapping edit ranges are accepted");
	}
	{
		// The one combination the contract explicitly allows: an IK edit
		// regenerates a span of the very take preserve is reconstructing.
		const { status, reason } = await post({
			...PINNED,
			poses: undefined,
			motionEdit: {
				sourceMotion: MOTION,
				startFrame: 10,
				endFrame: 40,
				contextBefore: 8,
				contextAfter: 8,
				edits: [{ frame: 20, tracks: ["hips"], pose: POSE }],
			},
			preserve: OK_PRESERVE,
		});
		assert.equal(status, 400);
		assert.doesNotMatch(reason, /cannot be combined/, "motionEdit + preserve is the combination the feature exists for");
		assert.match(reason, /unknown or expired motion/);
		pass("preserve rides with motionEdit");
	}
	{
		// Nothing above may have disturbed a request that carries no preserve.
		const { status, reason } = await post({ ...FREE, duration: 0.05 });
		assert.equal(status, 400);
		assert.match(reason, /field 'duration' must be in /, "unrelated validation is unchanged");
		pass("requests without preserve validate exactly as before");
	}
} finally {
	bridge.kill("SIGTERM");
}

if (failures > 0) {
	console.error(`${failures} preserve bridge check(s) failed`);
	process.exit(1);
}
console.log("OK verify-preserve-bridge");
