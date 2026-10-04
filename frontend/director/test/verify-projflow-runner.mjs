/**
 * verify-projflow-runner.mjs — GPU-free checks for the ProjFlow line-editing
 * backend (contract C7: tools/projflow/{generate,runner}.mjs + driver.py).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The exactness numbers the plan gates on
 * (GP1's reprojection error, GP2's preserved frames) are properties of a GPU
 * sample and are measured by driver.py itself, on the box, into
 * `<out>.meta.json`. Nothing here can reproduce them without a 3070. So this
 * file tests the three things that CAN be wrong without a GPU and would each
 * cost a full round trip to discover:
 *
 *   1. THE SKELETON MAP. Every one of the pose studio's 15 IK track ids resolves
 *      to an hml22 joint or is refused by name. A wrong entry here silently
 *      edits the wrong limb and the run still "succeeds".
 *   2. REQUEST ASSEMBLY. A malformed line must fail in milliseconds on this
 *      side, not after an ssh round trip and a 3.9 s model load on the box.
 *   3. COMMAND/ENV CONSTRUCTION. The bridge spawns what the runner returns and
 *      greps its done line; both are contracts and both are pure functions.
 *
 * Plus two structural guards: the .npy reader (the only parser between the box's
 * output and the app) and driver.py's syntax, so a python typo is caught by the
 * node suite rather than by the GPU.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IK_TRACKS, MID_TRACKS, FK_TRACKS } from "../src/ardy/ik.js";
import {
	DEFAULT_RIDGE,
	DEFAULT_STEPS,
	GEN_FPS,
	NUM_JOINTS,
	PREVIEW_STEPS,
	TRACK_TO_HML22_JOINT,
	UNMAPPABLE_TRACKS,
	buildLineRequest,
	readNpyFloat32,
	trackToJoint,
} from "../tools/projflow/generate.mjs";
import { createProjflowRunner, metaPath, nativeMotionPath } from "../tools/projflow/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function pass(label) { console.log(`PASS ${label}`); }
function skip(label) { console.log(`SKIP ${label}`); }

const SAVED = { ...process.env };
const BOX_KEYS = [
	"CCLAY_PROJFLOW_HOST", "CCLAY_KIMODO_HOST", "CCLAY_PROJFLOW_REPO",
	"CCLAY_PROJFLOW_PYTHON", "CCLAY_PROJFLOW_HOME", "CCLAY_PROJFLOW_NATIVE_OUT",
];
function withEnv(env, body) {
	for (const key of BOX_KEYS) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of BOX_KEYS) delete process.env[key];
		Object.assign(process.env, SAVED);
	}
}

/** A request that passes every check, so each negative case below differs from
 * a valid one in exactly one field. */
function validLine(overrides = {}) {
	return {
		track: "leftHand",
		frameRange: { start: 60, end: 140 },
		points2d: [[0.35, 0.65], [0.65, 0.35]],
		camera: {
			fx: 1.3738, fy: 2.4423, cx: 0.5, cy: 0.5,
			R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
			t: [0, 1, 4],
		},
		prompt: "",
		...overrides,
	};
}

// =====================================================================
// 1. The track -> hml22 joint map is TOTAL over the pose studio's tracks
// =====================================================================
// The 15 ids come from src/ardy/ik.js itself rather than a copy, so a track
// added to the studio fails this test instead of failing on the box.
const STUDIO_TRACKS = [...IK_TRACKS, ...MID_TRACKS, ...FK_TRACKS].map((track) => track.id);
assert.equal(STUDIO_TRACKS.length, 15, "the pose studio should expose 15 line-editable tracks");
assert.equal(new Set(STUDIO_TRACKS).size, 15, "track ids must be unique");

for (const track of STUDIO_TRACKS) {
	const mapped = Object.hasOwn(TRACK_TO_HML22_JOINT, track);
	const refused = Object.hasOwn(UNMAPPABLE_TRACKS, track);
	assert.ok(mapped || refused, `track "${track}" has neither an hml22 joint nor a documented refusal`);
	assert.ok(!(mapped && refused), `track "${track}" is both mapped and refused`);
}
pass("every one of the 15 pose-studio tracks is either mapped to an hml22 joint or refused by name");

// No entry that the studio does not have: an id here that no handle produces is
// dead weight the bridge would accept and the app could never send.
for (const track of [...Object.keys(TRACK_TO_HML22_JOINT), ...Object.keys(UNMAPPABLE_TRACKS)]) {
	assert.ok(STUDIO_TRACKS.includes(track), `"${track}" is mapped but is not a pose-studio track id`);
}
pass("the map contains no track the pose studio cannot produce");

// Joints must be real hml22 indices, and no two tracks may share one: two
// handles pointing at one joint means the second silently overrides the first.
const joints = Object.values(TRACK_TO_HML22_JOINT);
for (const [track, joint] of Object.entries(TRACK_TO_HML22_JOINT)) {
	assert.ok(Number.isInteger(joint) && joint >= 0 && joint < NUM_JOINTS, `${track} -> ${joint} is not an hml22 index`);
}
assert.equal(new Set(joints).size, joints.length, "the track -> joint map must be injective");
pass("every mapped joint is a valid hml22 index and the map is injective");

// The entries S2's mapping table flags as naming traps, pinned explicitly:
// getting any of these "obviously right" is how the wrong bone gets edited.
assert.equal(trackToJoint("leftHand"), 20);
assert.equal(trackToJoint("rightHand"), 21);
// LeftFoot is the ANKLE (7); hml22's `left_foot` (10) is the toe base.
assert.equal(trackToJoint("leftFoot"), 7);
assert.equal(trackToJoint("rightFoot"), 8);
// leftShoulder is the CLAVICLE, so left_collar (13), not left_shoulder (16).
assert.equal(trackToJoint("leftShoulder"), 13);
assert.equal(trackToJoint("rightShoulder"), 14);
// A mid-joint handle constrains its OWN joint, not its chain's effector.
assert.equal(trackToJoint("leftElbow"), 18);
assert.equal(trackToJoint("leftKnee"), 4);
assert.notEqual(trackToJoint("leftElbow"), trackToJoint("leftHand"));
// `spine` is cskel27 Spine1, whose hml22 source is spine2 (6).
assert.equal(trackToJoint("spine"), 6);
assert.equal(trackToJoint("hips"), 0);
assert.equal(trackToJoint("head"), 15);
assert.equal(trackToJoint("neck"), 12);
pass("S2's naming traps resolve to the joints the mapping table documents");

// `chest` is cskel27 Spine2, a FILLED joint with no hml22 source. It must be
// refused by NAME rather than retargeted onto a neighbouring spine joint.
assert.throws(() => trackToJoint("chest"), /cannot be line-edited.*Spine2/);
assert.throws(() => trackToJoint("leftThumb"), /unknown track "leftThumb"/);
assert.throws(() => trackToJoint(""), /must be a non-empty IK track id/);
assert.throws(() => trackToJoint(undefined), /must be a non-empty IK track id/);
pass("unmappable and unknown tracks are refused with a named reason");

// =====================================================================
// 2. Request assembly: a malformed line costs milliseconds, not a round trip
// =====================================================================
{
	const request = buildLineRequest(validLine());
	assert.equal(request.jointId, 20, "the wrapper resolves the joint so driver.py can cross-check it");
	assert.deepEqual(request.frameRange, { start: 60, end: 140 });
	assert.equal(request.points2d.length, 2);
	assert.equal(request.prompt, "");
	// The serialised document is what travels to the box; two identical requests
	// must produce identical bytes so a run directory can be diffed.
	assert.equal(JSON.stringify(buildLineRequest(validLine())), JSON.stringify(request));
	pass("a valid request resolves its joint and serialises deterministically");
}

// frameRange
assert.throws(() => buildLineRequest(validLine({ frameRange: undefined })), /frameRange \{start, end\} is required/);
assert.throws(() => buildLineRequest(validLine({ frameRange: { start: -1, end: 10 } })), /frameRange\.start must be a non-negative integer/);
assert.throws(() => buildLineRequest(validLine({ frameRange: { start: 0, end: 4.5 } })), /frameRange\.end must be a non-negative integer/);
// A one-frame range is two rows against a single pose: the sampler solves it and
// no artist ever meant it.
assert.throws(() => buildLineRequest(validLine({ frameRange: { start: 60, end: 60 } })), /must span at least two frames/);
assert.throws(() => buildLineRequest(validLine({ frameRange: { start: 90, end: 60 } })), /must span at least two frames/);
pass("frameRange must be two ascending non-negative integers");

// points2d
assert.throws(() => buildLineRequest(validLine({ points2d: [[0.5, 0.5]] })), /needs at least 2 points/);
assert.throws(() => buildLineRequest(validLine({ points2d: "0.5,0.5" })), /needs at least 2 points/);
assert.throws(() => buildLineRequest(validLine({ points2d: [[0.5, 0.5], [0.5]] })), /points2d\[1\] must be \[u, v\]/);
assert.throws(() => buildLineRequest(validLine({ points2d: [[0.5, 0.5], [NaN, 0.5]] })), /two finite numbers/);
// Viewport-normalised, per C6. Pixels sent as normalised units is the single
// most likely wire mistake and it produces a plausible-looking wrong line.
assert.throws(() => buildLineRequest(validLine({ points2d: [[0.5, 0.5], [960, 540]] })), /outside the 0\.\.1 normalised viewport/);
assert.throws(() => buildLineRequest(validLine({ points2d: [[0.5, 0.5], [-0.4, 0.5]] })), /outside the 0\.\.1 normalised viewport/);
// A stroke that grazed the viewport edge is a real stroke, not an error.
assert.doesNotThrow(() => buildLineRequest(validLine({ points2d: [[0, 0], [1, 1]] })));
assert.doesNotThrow(() => buildLineRequest(validLine({ points2d: [[-0.005, 0.5], [1.005, 0.5]] })));
pass("points2d must be >= 2 finite, viewport-normalised points");

// camera
assert.throws(() => buildLineRequest(validLine({ camera: undefined })), /camera \{fx, fy, cx, cy, R, t\} is required/);
for (const key of ["fx", "fy", "cx", "cy"]) {
	const camera = { ...validLine().camera, [key]: "wide" };
	assert.throws(() => buildLineRequest(validLine({ camera })), new RegExp(`camera\\.${key} must be a finite number`));
}
// A zero focal length collapses that axis's row onto the depth row and the
// normal matrix goes singular; LAPACK's message on the box would not say camera.
assert.throws(() => buildLineRequest(validLine({ camera: { ...validLine().camera, fx: 0 } })), /camera\.fx must be non-zero/);
// Pixel intrinsics beside normalised points: caught by magnitude here rather
// than debugged from a bad take later.
assert.throws(() => buildLineRequest(validLine({ camera: { ...validLine().camera, fx: 1200, fy: 1200 } })), /look like PIXEL focal lengths/);
assert.throws(() => buildLineRequest(validLine({ camera: { ...validLine().camera, R: [[1, 0, 0], [0, 1, 0]] } })), /camera\.R must be a 3x3/);
assert.throws(() => buildLineRequest(validLine({ camera: { ...validLine().camera, t: [0, 1] } })), /camera\.t must be a 3-vector/);
pass("the camera must carry finite normalised intrinsics, a 3x3 R and a 3-vector t");

// jointId, when the caller supplies one, is a cross-check and not an override —
// the same guard driver.py applies on the box.
assert.throws(() => buildLineRequest(validLine({ jointId: 21 })), /jointId 21 disagrees with track "leftHand" -> joint 20/);
assert.doesNotThrow(() => buildLineRequest(validLine({ jointId: 20 })));
assert.throws(() => buildLineRequest(validLine({ track: "chest" })), /cannot be line-edited/);
assert.throws(() => buildLineRequest(null), /line must be an object/);
assert.throws(() => buildLineRequest([1, 2]), /line must be an object/);
pass("a declared jointId must agree with the track, and a bad envelope is refused");

// =====================================================================
// 3. Runner: command and environment construction
// =====================================================================
const BOX = { CCLAY_PROJFLOW_HOST: "user@projflow-box" };

assert.throws(() => withEnv({}, () => createProjflowRunner()), /CCLAY_PROJFLOW_HOST \(or CCLAY_KIMODO_HOST\) is required/);
pass("the runner refuses to exist without a host");

// One box serves both engines today; the fallback is what stops an operator from
// having to set two variables to the same value.
assert.match(withEnv({ CCLAY_KIMODO_HOST: "user@shared-box" }, () => createProjflowRunner().describe()), /user@shared-box/);
assert.match(
	withEnv({ CCLAY_KIMODO_HOST: "user@shared-box", ...BOX }, () => createProjflowRunner().describe()),
	/user@projflow-box/
);
pass("CCLAY_PROJFLOW_HOST falls back to CCLAY_KIMODO_HOST and wins when both are set");

// S1's clone is at .../projflow-scout/repo — the setup script named it `repo`,
// not `ProjFlow`, and the default has to match the box that exists.
assert.match(withEnv(BOX, () => createProjflowRunner().describe()), /\/home\/yun\/projflow-scout\/repo/);
assert.match(
	withEnv({ ...BOX, CCLAY_PROJFLOW_REPO: "/opt/projflow" }, () => createProjflowRunner().describe()),
	/\/opt\/projflow/
);
pass("the repo default matches S1's clone path and is overridable");

const runner = withEnv(BOX, () => createProjflowRunner());
assert.equal(runner.mode, "projflow");
for (const method of ["probeHealth", "listBases", "sourceMotionFor", "lineEditCommand", "describe"]) {
	assert.equal(typeof runner[method], "function", `runner must expose ${method}`);
}
pass("the ProjFlow runner exposes the surface the bridge calls");

// Engine-per-task: everything that is not a line edit stays on Kimodo, and says
// so rather than crashing somewhere unrelated.
for (const [method, feature] of [
	["singleCommand", /text-to-motion generation/],
	["sequenceCommand", /multi-segment sequencing/],
	["editCommand", /prompt-based span regeneration/],
]) {
	assert.throws(() => runner[method]({}), feature);
	assert.throws(() => runner[method]({}), /stays on the Kimodo backend/);
}
pass("non-line-edit run modes refuse by name instead of half-running");

{
	const command = withEnv(BOX, () => createProjflowRunner().lineEditCommand({
		source: "/motions/take.projflow.npy",
		line: "/runs/42/line.json",
		output: "/motions/edit-42.npz",
		steps: 100,
		seed: 7,
	}));
	assert.equal(command.command, process.execPath);
	assert.ok(command.args[0].endsWith("tools/projflow/generate.mjs"), "the wrapper is generate.mjs's CLI");
	assert.ok(command.args.includes("--source") && command.args.includes("/motions/take.projflow.npy"));
	assert.ok(command.args.includes("--line") && command.args.includes("/runs/42/line.json"));
	assert.ok(command.args.includes("--seed") && command.args.includes("7"));
	assert.ok(command.args.includes("--steps") && command.args.includes("100"));
	assert.ok(!command.args.includes("--preview"));
	// The output is the RAW hml22 motion, not the npz the bridge was asked for:
	// converting to cskel27 is M2's module and splicing is M5's, and both land in
	// wave 2. The name says which engine wrote it, because a Kimodo native npz
	// (77-joint rotations) and this (22-joint positions) are not interchangeable.
	assert.ok(command.args.includes("/motions/edit-42.projflow.npy"));
	assert.equal(nativeMotionPath("/motions/edit-42.npz"), "/motions/edit-42.projflow.npy");
	assert.equal(nativeMotionPath("/motions/edit-42.npy"), "/motions/edit-42.projflow.npy");
	assert.equal(metaPath("/motions/edit-42.projflow.npy"), "/motions/edit-42.projflow.meta.json");
	pass("lineEditCommand builds a spawnable command naming the raw hml22 output");

	// The bridge parses the path and byte count out of this exact line.
	const line = "run-projflow-line-edit: done - /motions/edit-42.projflow.npy (51872 bytes)";
	assert.match(line, command.doneRe);
	const parsed = command.doneRe.exec(line);
	assert.equal(parsed[1], "/motions/edit-42.projflow.npy");
	assert.equal(parsed[2], "51872");
	// The status line the operator watches must NOT be mistaken for the done line.
	assert.doesNotMatch("run-projflow-line-edit: rows=3792 steps=100 sample=0.95s", command.doneRe);
	pass("the done line matches doneRe and the status line does not");

	// The box env every wrapper inherits, and the run-scoped key that must not
	// survive into the next request.
	assert.equal(command.env.CCLAY_PROJFLOW_HOST, "user@projflow-box");
	assert.equal(command.env.CCLAY_PROJFLOW_REPO, "/home/yun/projflow-scout/repo");
	assert.equal(command.env.CCLAY_PROJFLOW_PYTHON, "/home/yun/projflow-scout/venv/bin/python");
	// S1 pinned HOME inside the scout dir so CLIP's 338 MB download never lands
	// in the box user's real cache.
	assert.equal(command.env.CCLAY_PROJFLOW_HOME, "/home/yun/projflow-scout/home");
	assert.equal(command.env.CCLAY_PROJFLOW_NATIVE_OUT, "/motions/edit-42.projflow.npy");
	pass("lineEditCommand's environment carries the box, the venv and the HOME override");
}

{
	// A preview run replaces the step count rather than adding to it: 20 steps is
	// the interactive path (S1: 0.28 s vs 0.95 s) and a caller passing both meant
	// the preview.
	const command = withEnv(BOX, () => createProjflowRunner().lineEditCommand({
		source: "/a.npy", line: "/l.json", output: "/o.npz", steps: 100, preview: true,
	}));
	assert.ok(command.args.includes("--preview"));
	assert.ok(!command.args.includes("--steps"));
	pass("--preview replaces --steps rather than competing with it");
}

for (const missing of ["source", "line", "output"]) {
	const request = { source: "/a.npy", line: "/l.json", output: "/o.npz" };
	delete request[missing];
	assert.throws(
		() => withEnv(BOX, () => createProjflowRunner().lineEditCommand(request)),
		new RegExp(`lineEditCommand: ${missing}`)
	);
}
pass("lineEditCommand names the input it is missing");

// A leftover run-scoped path in a long-lived sidecar's environment would have
// the next request silently overwrite the previous take.
{
	const env = withEnv({ ...BOX, CCLAY_PROJFLOW_NATIVE_OUT: "/motions/stale.projflow.npy" }, () =>
		createProjflowRunner().lineEditCommand({ source: "/a.npy", line: "/l.json", output: "/fresh.npz" }).env);
	assert.equal(env.CCLAY_PROJFLOW_NATIVE_OUT, "/fresh.projflow.npy");
}
pass("a stale CCLAY_PROJFLOW_NATIVE_OUT cannot leak into the next run");

// =====================================================================
// 4. The .npy reader — the only parser between the box and the app
// =====================================================================
{
	const scratch = mkdtempSync(join(tmpdir(), "cclay-projflow-test-"));
	try {
		/** Write a numpy v1 .npy the way np.save does: magic, version, uint16
		 * header length, a python dict literal padded so the DATA starts on a
		 * 64-byte boundary, then the raw C-order body. */
		const writeNpy = (path, { descr = "<f4", fortran = "False", shape, values }) => {
			const dict = `{'descr': '${descr}', 'fortran_order': ${fortran}, 'shape': (${shape.map((d) => `${d},`).join(" ")}), }`;
			const prefix = 10;
			const padded = dict.padEnd(Math.ceil((prefix + dict.length + 1) / 64) * 64 - prefix - 1, " ") + "\n";
			const header = Buffer.alloc(prefix);
			header.write("\x93NUMPY", 0, "latin1");
			header.writeUInt8(1, 6);
			header.writeUInt8(0, 7);
			header.writeUInt16LE(padded.length, 8);
			const body = Buffer.alloc(values.length * 4);
			values.forEach((value, index) => body.writeFloatLE(value, index * 4));
			writeFileSync(path, Buffer.concat([header, Buffer.from(padded, "latin1"), body]));
		};

		const good = join(scratch, "good.npy");
		// A (2,2,3) motion: T=2 frames of 2 joints, C order, so the flat array
		// reads frame-major then joint-major then xyz — the layout every caller
		// downstream indexes.
		writeNpy(good, { shape: [2, 2, 3], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
		const read = readNpyFloat32(good);
		assert.deepEqual(read.shape, [2, 2, 3]);
		assert.ok(read.data instanceof Float32Array);
		assert.equal(read.data.length, 12);
		assert.equal(read.data[0], 0);
		assert.equal(read.data[7], 7);
		assert.equal(read.data[11], 11);
		pass("readNpyFloat32 reads a C-order float32 .npy and its shape");

		// Fortran order and a widened dtype are REFUSED, not guessed: a silently
		// transposed motion is indistinguishable from a bad take.
		const fortran = join(scratch, "fortran.npy");
		writeNpy(fortran, { shape: [2, 2, 3], fortran: "True", values: new Array(12).fill(0) });
		assert.throws(() => readNpyFloat32(fortran), /Fortran-ordered/);

		const doubles = join(scratch, "f8.npy");
		writeNpy(doubles, { shape: [2], descr: "<f8", values: [0, 0, 0, 0] });
		assert.throws(() => readNpyFloat32(doubles), /dtype <f8; the driver writes float32/);

		const truncated = join(scratch, "short.npy");
		writeNpy(truncated, { shape: [2, 2, 3], values: [1, 2, 3] });
		assert.throws(() => readNpyFloat32(truncated), /is truncated/);

		const garbage = join(scratch, "garbage.npy");
		writeFileSync(garbage, Buffer.from("this is not a numpy array at all"));
		assert.throws(() => readNpyFloat32(garbage), /is not a \.npy file/);
		pass("readNpyFloat32 refuses Fortran order, foreign dtypes, truncation and non-npy files");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// =====================================================================
// 5. Constants the box side agrees with
// =====================================================================
assert.equal(GEN_FPS, 20, "S1 measured the checkpoint at 20 fps");
assert.equal(NUM_JOINTS, 22, "ACMDM_Raw_Flow_S_PatchSize22 emits 22 joints");
assert.equal(DEFAULT_STEPS, 100);
assert.equal(PREVIEW_STEPS, 20);
// S1: ridge_lambda is the exactness knob, not steps. The repo ships 1e-3 and
// lands at 2.6e-5; C7 pins 1e-6, which measured 2.4e-7 at half the steps.
assert.equal(DEFAULT_RIDGE, 1e-6);
pass("the generation constants match S1's measurements and contract C7");

// =====================================================================
// 6. driver.py compiles
// =====================================================================
// The python only ever runs on the box, so a syntax error would otherwise be
// found by a GPU round trip. Compiled to a temp cache file so the check leaves
// no __pycache__ in the tree.
{
	const driver = join(REPO_ROOT, "tools", "projflow", "driver.py");
	const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		skip("driver.py syntax (no local python3 — the box venv is the only one that matters)");
	} else {
		const scratch = mkdtempSync(join(tmpdir(), "cclay-projflow-pyc-"));
		try {
			const compiled = spawnSync(
				"python3",
				[
					"-c",
					"import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)",
					driver,
					join(scratch, "driver.pyc"),
				],
				{ encoding: "utf8" }
			);
			assert.equal(compiled.status, 0, `driver.py does not compile:\n${compiled.stderr}`);
			pass("driver.py compiles under the local python3");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

console.log("projflow runner checks complete");
