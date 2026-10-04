#!/usr/bin/env node

// Recipe replay (contract C10) and the preview flag that rides with it.
//
// A take is a RECIPE — seed + prompt blocks + the line edits drawn on top — so
// regenerating or extending one has to re-apply those edits or every "add a
// block" throws the refinement work away. THIS file pins the contract's three
// moving parts: what `body.replay` is allowed to be, which edits are warned
// about because they sit on a block boundary, and how the entries chain.
//
// Nothing here talks to a GPU or to a box. The pure logic lives in
// tools/projflow/replay.mjs precisely so it can be checked with a stub job
// runner, and the bridge's validator is exercised the way a client sees it: a
// real sidecar on a loopback port, one POST per rule.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	BOUNDARY_MARGIN,
	REPLAY_MAX,
	blockBoundaries,
	boundaryWarningFor,
	runReplay,
	validateLineEditFields,
	validateReplay,
} from "../tools/projflow/replay.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const REPO = new URL("..", import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 15_000;

let failures = 0;
const work = mkdtempSync(join(tmpdir(), "cclay-projflow-replay-"));

/* ------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* ------------------------------------------------------------------------- */

const CLIP_FRAMES = 120; // duration 5 s on the bridge's 24 fps clock
const MOTION = "/ardy/motions/1700000000000-abcdef";
const CAMERA = {
	fx: 1.2, fy: 1.6, cx: 0.5, cy: 0.5,
	R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
	t: [0, 0, 4],
};
const POINTS = [[0.3, 0.5], [0.5, 0.35], [0.7, 0.5]];
// A C6 payload MINUS sourceMotion — exactly what C9 stores in a recipe.
const ENTRY = {
	track: "leftHand",
	frameRange: { startFrame: 48, endFrame: 72 },
	points2d: POINTS,
	camera: CAMERA,
	prompt: "A person reaches",
};
const entryAt = (startFrame, endFrame, track = "leftHand") => ({ ...ENTRY, track, frameRange: { startFrame, endFrame } });

/* ------------------------------------------------------------------------- */
/* the block boundaries a replayed edit is warned about                        */
/* ------------------------------------------------------------------------- */
// Block N+1 is conditioned on block N's PRE-edit tail: an edit that leaves the
// tail alone replays exactly, an edit that touches it changes what the next
// block saw. Only INTERNAL boundaries count — the clip end has no block after
// it, and a take with no prompt schedule is one block with no seam at all.
{
	assert.deepEqual(blockBoundaries(undefined, CLIP_FRAMES), [], "no segments field means no internal boundaries");
	assert.deepEqual(blockBoundaries([], CLIP_FRAMES), []);
	assert.deepEqual(
		blockBoundaries([{ startFrame: 0, endFrame: 120, prompt: "a" }], CLIP_FRAMES),
		[],
		"a single block has nothing to hand over to",
	);
	assert.deepEqual(
		blockBoundaries([{ startFrame: 0, endFrame: 60, prompt: "a" }, { startFrame: 60, endFrame: 120, prompt: "b" }], CLIP_FRAMES),
		[60],
		"two blocks have exactly one internal boundary; the clip end is not one",
	);
	assert.deepEqual(
		blockBoundaries(
			[
				{ startFrame: 0, endFrame: 48, prompt: "a" },
				{ startFrame: 48, endFrame: 96, prompt: "b" },
				{ startFrame: 96, endFrame: 120, prompt: "c" },
			],
			CLIP_FRAMES,
		),
		[48, 96],
		"the boundaries are the cumulative endFrames, the last one excluded",
	);
	// Defensive, not decorative: the field is validated before this runs, but a
	// boundary at frame 0 or past the clip would warn about a seam that is not
	// there.
	assert.deepEqual(
		blockBoundaries([{ endFrame: 0 }, { endFrame: 60 }, { endFrame: 60 }, { endFrame: 200 }], CLIP_FRAMES),
		[60],
		"frame 0, duplicates and out-of-clip ends are not boundaries",
	);
	pass("blockBoundaries returns the internal block seams and nothing else");
}

/* ------------------------------------------------------------------------- */
/* the warning window                                                          */
/* ------------------------------------------------------------------------- */
// [boundary - 5, boundary + 5] inclusive, against a HALF-OPEN range whose last
// constrained frame is endFrame - 1. Non-blocking by contract; the arithmetic
// still has to be exact or the notice fires on the wrong takes.
{
	assert.equal(BOUNDARY_MARGIN, 5, "contract C10 fixes the margin at 5 frames");
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 120 }, []), false, "a single-block take never warns");
	assert.equal(boundaryWarningFor({ startFrame: 40, endFrame: 60 }, [48]), true, "an edit straddling the seam warns");

	// The four edges of the window around boundary 48: [43, 53].
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 44 }, [48]), true, "last frame 43 touches the window");
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 43 }, [48]), false, "last frame 42 is one frame clear");
	assert.equal(boundaryWarningFor({ startFrame: 53, endFrame: 70 }, [48]), true, "starting on 53 touches the window");
	assert.equal(boundaryWarningFor({ startFrame: 54, endFrame: 70 }, [48]), false, "starting on 54 is one frame clear");

	// Far away, either side, with several boundaries in play.
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 20 }, [48, 96]), false, "an edit far from every seam is quiet");
	assert.equal(boundaryWarningFor({ startFrame: 60, endFrame: 80 }, [48, 96]), false);
	assert.equal(boundaryWarningFor({ startFrame: 60, endFrame: 92 }, [48, 96]), true, "any one boundary is enough");

	// The margin is a parameter, and 0 means "only frames the seam itself owns".
	assert.equal(boundaryWarningFor({ startFrame: 48, endFrame: 60 }, [48], 0), true);
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 48 }, [48], 0), false, "half-open: frame 48 is not in [0,48)");
	assert.equal(boundaryWarningFor({ startFrame: 0, endFrame: 49 }, [48], 0), true);
	assert.equal(boundaryWarningFor(null, [48]), false, "a missing range cannot intersect anything");
	pass("boundaryWarningFor intersects the half-open range with [boundary-5, boundary+5]");
}

/* ------------------------------------------------------------------------- */
/* validateReplay, as a pure function                                          */
/* ------------------------------------------------------------------------- */
{
	const BODY = { prompt: "A person walks", duration: 5, posePin: false };
	const ok = (body) => validateReplay(body, CLIP_FRAMES);

	assert.equal(ok({ ...BODY, replay: [] }), null, "an empty replay is a no-op, not an error");
	assert.equal(ok({ ...BODY, replay: [ENTRY, entryAt(0, 24, "rightFoot")] }), null);
	assert.equal(
		ok({ ...BODY, replay: Array.from({ length: REPLAY_MAX }, () => ENTRY) }),
		null,
		"exactly the cap is accepted",
	);

	assert.match(ok({ ...BODY, replay: { 0: ENTRY } }), /field 'replay' must be an array of line-edit payloads \(contract C10\)/);
	assert.match(
		ok({ ...BODY, replay: Array.from({ length: REPLAY_MAX + 1 }, () => ENTRY) }),
		/field 'replay' is capped at 16 entries, got 17 \(contract C10\)/,
	);
	assert.match(ok({ ...BODY, replay: [null] }), /field 'replay\[0\]' must be an object/);
	assert.match(ok({ ...BODY, replay: [ENTRY, [ENTRY]] }), /field 'replay\[1\]' must be an object/);

	// A stored source id would name the take that is being superseded, so it is
	// refused rather than ignored: dropping it silently would let a client
	// believe it chose the base.
	assert.match(
		ok({ ...BODY, replay: [{ ...ENTRY, sourceMotion: MOTION }] }),
		/field 'replay\[0\]\.sourceMotion' must be omitted: contract C10 rebinds every replay entry/,
	);
	assert.match(
		ok({ ...BODY, replay: [ENTRY, { ...ENTRY, preview: true }] }),
		/field 'replay\[1\]\.preview' must be omitted: contract C10 replays always run at full quality/,
	);
	assert.equal(ok({ ...BODY, replay: [{ ...ENTRY, seed: 7 }] }), null, "a per-entry integer seed is part of the contract");
	assert.match(ok({ ...BODY, replay: [{ ...ENTRY, seed: 1.5 }] }), /field 'replay\[0\]\.seed' must be an integer in 0\.\.2147483647/);
	assert.match(ok({ ...BODY, replay: [{ ...ENTRY, seed: -1 }] }), /field 'replay\[0\]\.seed' must be an integer/);
	assert.match(
		validateReplay({ ...BODY, replay: [{ ...ENTRY, seed: 99 }] }, CLIP_FRAMES, { seedMax: 10 }),
		/must be an integer in 0\.\.10/,
		"the bridge passes its own seed cap in so the two can never disagree",
	);

	// Exclusivity: the three modes that splice or rewrite an existing take.
	for (const field of ["lineEdit", "motionEdit", "regenerateSegments"]) {
		assert.match(
			ok({ ...BODY, replay: [ENTRY], [field]: {} }),
			new RegExp(`field 'replay' cannot be combined with ${field}: contract C10 replays onto the take this request generates`),
			`${field} must be refused by name`,
		);
	}
	assert.equal(ok({ ...BODY, replay: [ENTRY], segments: [] }), null, "a prompt schedule is explicitly allowed");
	assert.equal(ok({ ...BODY, replay: [ENTRY], preserve: {} }), null, "so is preserve");

	// Per-field rules, reached through the entry's own label.
	assert.match(
		ok({ ...BODY, replay: [ENTRY, entryAt(48, 200)] }),
		/field 'replay\[1\]\.frameRange' must be a non-empty half-open range inside 0\.\.120/,
	);
	assert.match(ok({ ...BODY, replay: [entryAt(48, 49)] }), /field 'replay\[0\]\.frameRange' must span at least 2 frames/);
	assert.match(
		ok({ ...BODY, replay: [{ ...ENTRY, track: "LeftArm" }] }),
		/field 'replay\[0\]\.track' "LeftArm" is not a line-editable IK track id; valid ids are .*leftHand/,
	);
	assert.match(
		ok({ ...BODY, replay: [{ ...ENTRY, track: "chest" }] }),
		/field 'replay\[0\]\.track' "chest" cannot be line-edited: .*draw on spine or neck instead/,
	);
	assert.match(ok({ ...BODY, replay: [{ ...ENTRY, points2d: [[0.5, 0.5]] }] }), /field 'replay\[0\]\.points2d' needs at least 2 points/);
	assert.match(
		ok({ ...BODY, replay: [{ ...ENTRY, camera: { ...CAMERA, fx: 1200, fy: 1200 } }] }),
		/field 'replay\[0\]\.camera' has PIXEL focal lengths/,
	);
	pass("validateReplay pins the array, the 16-entry cap, exclusivity and every per-entry field");

	// The whole point of the shared helper: ONE rule set, two labels. The C6
	// message must stay byte-identical (its own verify file pins it) while the
	// replay entry says which entry it is.
	const broken = { ...ENTRY, camera: { ...CAMERA, t: [0, 0] } };
	assert.equal(
		validateLineEditFields(broken, CLIP_FRAMES),
		"field 'lineEdit.camera.t' must be 3 finite numbers",
		"the default label is the C6 one, unchanged",
	);
	assert.equal(
		validateLineEditFields(broken, CLIP_FRAMES, "replay[2]"),
		"field 'replay[2].camera.t' must be 3 finite numbers",
		"the same rule, the entry's own wire path",
	);
	assert.equal(validateLineEditFields(ENTRY, CLIP_FRAMES), null);
	pass("the per-field rules are shared between C6 and C10 and differ only in the label");
}

/* ------------------------------------------------------------------------- */
/* runReplay: the chain, and what a failure costs                              */
/* ------------------------------------------------------------------------- */
// The stub stands in for runLineEditJob and nothing else: it records what it was
// handed and reports the output path the loop asked for. No npz is written, so
// what is measured here is exactly the sequencing.
{
	const artifactDir = join(work, "chain");
	const calls = [];
	const status = [];
	const stub = async (options) => {
		calls.push(options);
		return { output: options.outputPath, seamStartDelta: 0.01 * (calls.length), seamEndDelta: 0.02 };
	};

	const entries = [entryAt(0, 24), entryAt(48, 72, "rightHand"), { ...entryAt(96, 120, "head"), seed: 11 }];
	const result = await runReplay({
		entries,
		takePath: join(artifactDir, "generated.npz"),
		artifactDir,
		boundaries: [48],
		appFps: 24,
		runJob: stub,
		onStatus: (line) => status.push(line),
	});

	// (a) the chain: entry 0 reads the fresh take, entry i reads entry i-1.
	assert.equal(calls.length, 3);
	assert.equal(calls[0].takePath, join(artifactDir, "generated.npz"), "entry 0 edits the freshly generated take");
	assert.equal(calls[0].outputPath, join(artifactDir, "replay-0.npz"));
	assert.equal(calls[1].takePath, join(artifactDir, "replay-0.npz"), "entry 1 reads entry 0's output");
	assert.equal(calls[1].outputPath, join(artifactDir, "replay-1.npz"));
	assert.equal(calls[2].takePath, join(artifactDir, "replay-1.npz"));
	assert.equal(result.takePath, join(artifactDir, "replay-2.npz"), "the LAST output is what gets registered");

	// (b) what each entry was run with.
	assert.deepEqual(calls[0].lineEdit, entries[0], "the stored payload is forwarded verbatim");
	assert.equal(calls[0].appFps, 24);
	assert.equal("seed" in calls[0], false, "an entry without a seed must not pin one");
	assert.equal(calls[2].seed, 11, "a per-entry seed rides along");
	assert.equal(typeof calls[0].onStatus, "function", "box output reaches the same stream");

	// (c) the report shape contract C10 names, in order.
	assert.deepEqual(result.entries.map((entry) => entry.index), [0, 1, 2]);
	assert.deepEqual(
		result.entries.map((entry) => ({ ...entry })),
		[
			// Only the middle entry (frames 48..71) touches the seam at 48; the
			// other two are far enough away to stay quiet.
			{ index: 0, track: "leftHand", ok: true, boundaryWarning: false, seamStartDelta: 0.01, seamEndDelta: 0.02 },
			{ index: 1, track: "rightHand", ok: true, boundaryWarning: true, seamStartDelta: 0.02, seamEndDelta: 0.02 },
			{ index: 2, track: "head", ok: true, boundaryWarning: false, seamStartDelta: 0.03, seamEndDelta: 0.02 },
		],
		"index/track/ok/boundaryWarning/seam deltas, and no error key on a success",
	);
	assert.equal(Object.hasOwn(result.entries[0], "error"), false);

	// (d) one status line per entry, at least, and the boundary notice is loud.
	assert.ok(status.filter((line) => /replay 1\/3|replay 2\/3|replay 3\/3/.test(line)).length >= 3);
	assert.ok(status.some((line) => /WARNING/.test(line) && /block boundary \(48\)/.test(line)));
	pass("runReplay chains take -> replay-0 -> replay-1 -> replay-2 and reports every entry");
}

{
	// A failing entry is skipped and the chain CONTINUES from the last good take:
	// a missing refinement beats a dead run.
	const artifactDir = join(work, "partial");
	const seen = [];
	const stub = async (options) => {
		seen.push(options.takePath);
		if (options.outputPath.endsWith("replay-1.npz")) throw new Error("the box went away");
		return { output: options.outputPath, seamStartDelta: 0.5, seamEndDelta: 0.5 };
	};
	const result = await runReplay({
		entries: [entryAt(0, 24), entryAt(24, 48), entryAt(48, 72)],
		takePath: join(artifactDir, "generated.npz"),
		artifactDir,
		runJob: stub,
		onStatus: () => {},
	});
	assert.deepEqual(
		seen,
		[join(artifactDir, "generated.npz"), join(artifactDir, "replay-0.npz"), join(artifactDir, "replay-0.npz")],
		"entry 2 continues from entry 0's output, the last file that exists",
	);
	assert.deepEqual(result.entries.map((entry) => entry.ok), [true, false, true]);
	assert.equal(result.entries[1].error, "the box went away", "the reason travels in the report");
	assert.equal(result.entries[1].seamStartDelta, null, "a failed entry has no seams to report");
	assert.equal(result.takePath, join(artifactDir, "replay-2.npz"));

	// Every entry failing is not a failed run: the generated take still ships.
	const takePath = join(artifactDir, "generated.npz");
	const allFailed = await runReplay({
		entries: [entryAt(0, 24), entryAt(24, 48)],
		takePath,
		artifactDir,
		runJob: async () => { throw new Error("no backend"); },
	});
	assert.equal(allFailed.takePath, takePath, "with nothing applied, the fresh take is what gets registered");
	assert.deepEqual(allFailed.entries.map((entry) => entry.ok), [false, false]);
	assert.equal(allFailed.entries[0].boundaryWarning, false, "no segments, no boundaries, no warning");

	assert.deepEqual(
		(await runReplay({ entries: [], takePath, artifactDir, runJob: stub })),
		{ entries: [], takePath },
		"an empty replay leaves the take exactly where it was",
	);
	await assert.rejects(() => runReplay({ entries: [ENTRY], takePath, artifactDir }), /runJob is required/);
	await assert.rejects(() => runReplay({ entries: [ENTRY], artifactDir, runJob: stub }), /takePath is required/);
	await assert.rejects(() => runReplay({ entries: [ENTRY], takePath, runJob: stub }), /artifactDir is required/);
	pass("a failed entry is reported and skipped; the chain continues from the last good take");
}

/* ------------------------------------------------------------------------- */
/* the bridge, over the wire                                                   */
/* ------------------------------------------------------------------------- */
// Same harness as verify-projflow-bridge.mjs: bridge.mjs binds a socket on load,
// so its validator is exercised the way a client sees it, with a fake `ssh` on
// PATH answering both backends' health probes.

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

const fakeBin = join(work, "bin");
{
	mkdirSync(fakeBin, { recursive: true });
	const path = join(fakeBin, "ssh");
	writeFileSync(path, ['#!/bin/sh', 'echo "device=cuda:0"', 'echo "models=3"', 'echo "checkpoint=yes"', "exit 0", ""].join("\n"));
	chmodSync(path, 0o755);
}

async function startBridge(env) {
	const port = await freePort();
	const bridge = fork(join(HERE, "..", "tools", "ardy", "bridge.mjs"), [], {
		cwd: REPO,
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			CCLAY_MOTION_BACKEND: "kimodo",
			CCLAY_KIMODO_HOST: "test@kimodo",
			CCLAY_PROJFLOW_HOST: "test@projflow",
			COZYCLAY_BRIDGE_PORT: String(port),
			...env,
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const ready = await Promise.race([
		once(bridge, "message"),
		new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not report readiness")), READY_TIMEOUT_MS).unref()),
	]);
	assert.deepEqual(ready[0], { type: "cozyclay-bridge-ready", port });
	return { bridge, port };
}

{
	const { bridge, port } = await startBridge({});
	try {
		const BODY = { prompt: "A person walks", duration: 5, posePin: false };
		const POSE = { schema: "cozyclay.pose.v1", root: [0, 0.9, 0] };
		const SEGMENTS = [
			{ startFrame: 0, endFrame: 60, prompt: "walks" },
			{ startFrame: 60, endFrame: 120, prompt: "waves" },
		];
		const OK_LINE = {
			sourceMotion: MOTION,
			track: "leftHand",
			frameRange: { startFrame: 48, endFrame: 72 },
			points2d: POINTS,
			camera: CAMERA,
			prompt: "A person reaches",
		};

		async function post(body) {
			const response = await fetch(`http://127.0.0.1:${port}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
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

		// ACCEPTED. A valid replay cannot be proved by a 200 — that would run a
		// generation — so it is proved by the NEXT rule failing instead: `seed` is
		// validated immediately after `replay`, so a seed complaint means every
		// replay entry got through.
		async function accepts(label, body) {
			const { status, reason } = await post({ ...body, seed: -1 });
			try {
				assert.equal(status, 400);
				assert.match(reason, /field 'seed' must be an integer in 0\.\.2147483647/,
					`${label}: replay must be accepted, but the bridge said "${reason}"`);
				pass(label);
			} catch (error) {
				failures += 1;
				console.error(`FAIL ${error.message}`);
			}
		}

		await accepts("replay rides on plain prompt generation", { ...BODY, replay: [ENTRY] });
		await accepts("replay rides on a pose-pinned request", {
			prompt: "A person walks", duration: 5, poses: [{ frame: 0, pose: POSE }], replay: [ENTRY],
		});
		await accepts("replay rides on a prompt schedule (chained blocks)", { ...BODY, segments: SEGMENTS, replay: [ENTRY, entryAt(0, 24)] });
		await accepts("replay rides on a preserved regeneration", {
			...BODY,
			preserve: { sourceMotion: MOTION, strength: 0.5, editRanges: [] },
			replay: [ENTRY],
		});
		await accepts("a full 16-entry recipe is accepted", { ...BODY, replay: Array.from({ length: 16 }, () => ENTRY) });

		// REJECTED, by name and with the contract cited.
		await refuses(
			"replay + lineEdit is refused",
			{ ...BODY, lineEdit: OK_LINE, replay: [ENTRY] },
			/field 'replay' cannot be combined with lineEdit: contract C10/,
		);
		await refuses(
			"replay + motionEdit is refused",
			{
				prompt: "A person walks",
				duration: 5,
				poses: [{ frame: 20, pose: POSE }],
				motionEdit: { sourceMotion: MOTION, startFrame: 10, endFrame: 40, contextBefore: 8, contextAfter: 8, edits: [{ frame: 20, tracks: ["hips"], pose: POSE }] },
				replay: [ENTRY],
			},
			/field 'replay' cannot be combined with motionEdit: contract C10/,
		);
		await refuses(
			"replay + regenerateSegments is refused",
			{
				prompt: "A person walks",
				duration: 5,
				sourceMotion: MOTION,
				poses: [{ frame: 0, pose: POSE }],
				regenerateSegments: [{ startFrame: 0, endFrame: 60, prompt: "again" }],
				replay: [ENTRY],
			},
			/field 'replay' cannot be combined with regenerateSegments: contract C10/,
		);

		// PER-ENTRY VALIDATION, over the wire.
		await refuses("replay must be an array", { ...BODY, replay: ENTRY }, /field 'replay' must be an array of line-edit payloads \(contract C10\)/);
		await refuses(
			"the 16-entry cap is enforced",
			{ ...BODY, replay: Array.from({ length: 17 }, () => ENTRY) },
			/field 'replay' is capped at 16 entries, got 17 \(contract C10\)/,
		);
		await refuses(
			"an unknown track names the entry it came from",
			{ ...BODY, replay: [ENTRY, { ...ENTRY, track: "LeftArm" }] },
			/field 'replay\[1\]\.track' "LeftArm" is not a line-editable IK track id/,
		);
		await refuses(
			"a frameRange past the clip is refused",
			{ ...BODY, replay: [entryAt(48, 121)] },
			/field 'replay\[0\]\.frameRange' must be a non-empty half-open range inside 0\.\.120/,
		);
		await refuses(
			"pixels are not normalised coordinates here either",
			{ ...BODY, replay: [{ ...ENTRY, points2d: [[0.5, 0.5], [640, 360]] }] },
			/field 'replay\[0\]\.points2d\[1\]' must be viewport-normalized into 0\.\.1/,
		);
		await refuses(
			"a replay entry may not name a source take",
			{ ...BODY, replay: [{ ...ENTRY, sourceMotion: MOTION }] },
			/field 'replay\[0\]\.sourceMotion' must be omitted: contract C10/,
		);
		await refuses(
			"a replay entry may not ask for a preview",
			{ ...BODY, replay: [{ ...ENTRY, preview: true }] },
			/field 'replay\[0\]\.preview' must be omitted: contract C10 replays always run at full quality/,
		);
		await refuses(
			"a per-entry seed must be an integer",
			{ ...BODY, replay: [{ ...ENTRY, seed: 2 ** 31 }] },
			/field 'replay\[0\]\.seed' must be an integer in 0\.\.2147483647/,
		);

		// THE PREVIEW FLAG (C10, riding with the replay contract).
		{
			const { status, reason } = await post({ ...BODY, lineEdit: { ...OK_LINE, preview: true } });
			assert.equal(status, 400);
			assert.match(reason, /field 'lineEdit\.sourceMotion': unknown or expired motion/,
				"preview:true must get past the validator and die on the allowlist like any line edit");
			pass("lineEdit.preview:true is accepted");
		}
		await refuses(
			"lineEdit.preview must be a boolean",
			{ ...BODY, lineEdit: { ...OK_LINE, preview: "yes" } },
			/field 'lineEdit\.preview' must be a boolean when present/,
		);
		{
			// Nothing above may have disturbed a request that carries neither field.
			const { reason } = await post({ ...BODY, duration: 0.05 });
			assert.match(reason, /field 'duration' must be in /, "unrelated validation is unchanged");
			pass("requests without replay or preview validate exactly as before");
		}
	} finally {
		bridge.kill("SIGTERM");
	}
}

/* ------------------------------------------------------------------------- */
/* the source says what the wiring is, where a live run cannot reach           */
/* ------------------------------------------------------------------------- */
// Running a replay end to end needs a GPU, so the ORDER of the four steps that
// make the contract true — generate, replay, report, register — is pinned
// against the source, the way verify-projflow-bridge.mjs pins routing.
{
	const bridgeSource = readFileSync(new URL("tools/ardy/bridge.mjs", REPO), "utf8");
	// The replay runs BEFORE registration, and the file it leaves behind is the
	// one the client is handed. Both take-producing branches, spelled out.
	const registered = [...bridgeSource.matchAll(/const deliveredPath = await applyReplay\(outNpzPath\);/g)];
	assert.equal(registered.length, 2, "both the prompt-schedule and the single-run branch replay before they register");
	assert.match(bridgeSource, /registerMotion\(stamp, deliveredPath\);/);
	assert.equal(
		bridgeSource.includes("registerMotion(stamp, outNpzPath);\n\t\t\tsend({ event: \"done\", output: deliveredPath"),
		false,
		"a registered take and the take named in the done event are never different files",
	);
	// The report event carries the table even when the generator produced none.
	assert.match(bridgeSource, /\.\.\.\(replayReport \? \{ replay: replayReport \} : \{\}\)/);
	// The boundaries come from the REQUEST's prompt schedule, not from the take.
	assert.match(bridgeSource, /blockBoundaries\(body\.segments, Math\.floor\(body\.duration \* FPS\)\)/);
	// The preview flag is forwarded to the job, which owns what it costs.
	assert.match(bridgeSource, /preview: body\.lineEdit\.preview === true,/);
	// A replay with no ProjFlow backend is refused before the stream opens.
	assert.match(bridgeSource, /recipe replay needs the ProjFlow backend/);
	pass("the bridge replays after the take is verified, before it is registered");
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
	console.error(`${failures} projflow replay check(s) failed`);
	process.exit(1);
}
console.log("OK verify-projflow-replay");
