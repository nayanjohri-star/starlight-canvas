import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { globalRotations, matMul } from "../src/ardy/convert.js";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { readKimodoMotion, readNpz } from "../tools/kimodo/read-npz.mjs";
import { continuityMetrics, joinPrompts } from "../tools/kimodo/generate.mjs";
import {
	CSKEL27_FROM_SOMA77,
	SOMA77_JOINTS,
	resolveSourceIndices,
	soma77ToCskel27Motion,
} from "../tools/kimodo/soma77-to-cskel27.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const JOINTS = SOMA77_JOINTS.length;
const INDEX = new Map(SOMA77_JOINTS.map((name, index) => [name, index]));

function rotX(a) {
	const c = Math.cos(a), s = Math.sin(a);
	return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function rotY(a) {
	const c = Math.cos(a), s = Math.sin(a);
	return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

/**
 * A synthetic somaskel77 clip. Every joint carries a DISTINCT global rotation
 * derived from its index, so a mapping that reads the wrong source joint
 * cannot coincidentally produce the right answer.
 */
function syntheticSource(frames) {
	const globalRotMats = new Float32Array(frames * JOINTS * 9);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let frame = 0; frame < frames; frame += 1) {
		for (let joint = 0; joint < JOINTS; joint += 1) {
			const m = matMul(rotY(0.11 * joint + 0.03 * frame), rotX(0.07 * joint - 0.02 * frame));
			const base = frame * JOINTS * 9 + joint * 9;
			for (let row = 0; row < 3; row += 1) {
				for (let col = 0; col < 3; col += 1) globalRotMats[base + row * 3 + col] = m[row][col];
			}
		}
		// Only the Hips trajectory and the left leg chain are read for
		// positions (root + leg-length ratio), so give those real geometry.
		const put = (name, x, y, z) => {
			const base = frame * JOINTS * 3 + INDEX.get(name) * 3;
			posedJoints[base] = x;
			posedJoints[base + 1] = y;
			posedJoints[base + 2] = z;
		};
		put("Hips", 0.25 * frame, 0.95, 0.1 * frame);
		put("LeftLeg", 0.25 * frame, 0.90, 0.1 * frame);
		put("LeftShin", 0.25 * frame, 0.45, 0.1 * frame);
		put("LeftFoot", 0.25 * frame, 0.05, 0.1 * frame);
	}
	return { globalRotMats, posedJoints };
}

const FRAMES = 6;
const FPS = 30;
const source = syntheticSource(FRAMES);
const motion = soma77ToCskel27Motion({ frames: FRAMES, fps: FPS, ...source });

// ---- shapes ---------------------------------------------------------------
assert.equal(motion.frames, FRAMES);
assert.equal(motion.fps, FPS);
assert.equal(motion.rotMats.length, FRAMES * 27 * 9);
assert.equal(motion.rootPos.length, FRAMES * 3);
assert.equal(motion.posedJoints.length, FRAMES * 27 * 3);
assert.ok(motion.rotMats.every(Number.isFinite), "rotMats must be finite");
assert.ok(motion.posedJoints.every(Number.isFinite), "posedJoints must be finite");
pass("output arrays have the cskel27 npz shapes and are finite");

// ---- the mapping covers cskel27 exactly -----------------------------------
assert.deepEqual(
	Object.keys(CSKEL27_FROM_SOMA77).sort(),
	[...CSKEL27_JOINTS].sort(),
	"the map must name every cskel27 joint and nothing else"
);
assert.equal(SOMA77_JOINTS.length, 77, "somaskel77 must have 77 joints");
assert.equal(new Set(SOMA77_JOINTS).size, 77, "somaskel77 joint names must be unique");
pass("mapping covers cskel27 and somaskel77 is 77 unique joints");

// ---- the leg names shift by one -------------------------------------------
// somaskel77 LeftLeg is the THIGH and LeftShin is the shank. Mapping by equal
// name would put the knee rotation on the hip; assert the shift explicitly.
assert.equal(CSKEL27_FROM_SOMA77.LeftUpLeg, "LeftLeg");
assert.equal(CSKEL27_FROM_SOMA77.LeftLeg, "LeftShin");
assert.equal(CSKEL27_FROM_SOMA77.RightUpLeg, "RightLeg");
assert.equal(CSKEL27_FROM_SOMA77.RightLeg, "RightShin");
pass("leg chain is mapped across the somaskel77 name shift");

// ---- THE contract: globals survive the segmentation mismatch --------------
// For every cskel27 joint, the global rotation rebuilt by FK from the emitted
// locals must equal the source global of the joint it maps to (an unmapped
// joint maps to its nearest mapped ancestor). This is what makes the 4-vs-3
// spine and the split neck a non-issue, and it fails loudly on any wrong
// parent, wrong source index, or transpose slip.
const sources = resolveSourceIndices();
const readSource = (frame, joint) => {
	const base = frame * JOINTS * 9 + joint * 9;
	return [
		[source.globalRotMats[base], source.globalRotMats[base + 1], source.globalRotMats[base + 2]],
		[source.globalRotMats[base + 3], source.globalRotMats[base + 4], source.globalRotMats[base + 5]],
		[source.globalRotMats[base + 6], source.globalRotMats[base + 7], source.globalRotMats[base + 8]],
	];
};
let worst = 0;
for (let frame = 0; frame < FRAMES; frame += 1) {
	const locals = [];
	for (let joint = 0; joint < 27; joint += 1) {
		const base = frame * 27 * 9 + joint * 9;
		locals.push([
			[motion.rotMats[base], motion.rotMats[base + 1], motion.rotMats[base + 2]],
			[motion.rotMats[base + 3], motion.rotMats[base + 4], motion.rotMats[base + 5]],
			[motion.rotMats[base + 6], motion.rotMats[base + 7], motion.rotMats[base + 8]],
		]);
	}
	const rebuilt = globalRotations(locals);
	for (let joint = 0; joint < 27; joint += 1) {
		const expected = readSource(frame, sources[joint]);
		for (let row = 0; row < 3; row += 1) {
			for (let col = 0; col < 3; col += 1) {
				worst = Math.max(worst, Math.abs(rebuilt[joint][row][col] - expected[row][col]));
			}
		}
	}
}
assert.ok(worst < 1e-5, `rebuilt globals must match the source globals (worst ${worst})`);
pass(`FK over the emitted locals reproduces every source global (worst ${worst.toExponential(2)})`);

// ---- unmapped joints are "not authored" -----------------------------------
// Spine2 and the hand ends have no somaskel77 counterpart, so they borrow an
// ancestor's global and their LOCAL must come out identity.
for (const name of ["Spine2", "LeftHandEnd", "RightHandEnd"]) {
	assert.equal(CSKEL27_FROM_SOMA77[name], null, `${name} is expected to be unauthored`);
	const joint = CSKEL27_JOINTS.indexOf(name);
	for (let frame = 0; frame < FRAMES; frame += 1) {
		const base = frame * 27 * 9 + joint * 9;
		const m = Array.from(motion.rotMats.slice(base, base + 9));
		const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
		for (let cell = 0; cell < 9; cell += 1) {
			assert.ok(
				Math.abs(m[cell] - identity[cell]) < 1e-6,
				`${name} local must be identity at frame ${frame}`
			);
		}
	}
}
pass("unmapped cskel27 joints emit identity locals");

// ---- emitted locals are rotations -----------------------------------------
for (let joint = 0; joint < 27; joint += 1) {
	const base = 2 * 27 * 9 + joint * 9;
	const m = [
		[motion.rotMats[base], motion.rotMats[base + 1], motion.rotMats[base + 2]],
		[motion.rotMats[base + 3], motion.rotMats[base + 4], motion.rotMats[base + 5]],
		[motion.rotMats[base + 6], motion.rotMats[base + 7], motion.rotMats[base + 8]],
	];
	const det =
		m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
		m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
		m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	assert.ok(Math.abs(det - 1) < 1e-5, `${CSKEL27_JOINTS[joint]} local must have determinant 1, got ${det}`);
}
pass("emitted locals are proper rotations");

// ---- the clip stands on the floor -----------------------------------------
const FEET = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"].map((n) => CSKEL27_JOINTS.indexOf(n));
let lowest = Infinity;
for (let frame = 0; frame < FRAMES; frame += 1) {
	for (const joint of FEET) lowest = Math.min(lowest, motion.posedJoints[(frame * 27 + joint) * 3 + 1]);
}
assert.ok(Math.abs(lowest) < 1e-6, `lowest foot sample must touch Y=0, got ${lowest}`);
pass("clip is floor-aligned on its lowest foot sample");

// ---- the floor shift is rigid, not per-frame ------------------------------
// A per-frame grounding would flatten a jump. The root must keep its shape.
const sourceRootY = [];
const outRootY = [];
for (let frame = 0; frame < FRAMES; frame += 1) {
	sourceRootY.push(source.posedJoints[(frame * JOINTS + INDEX.get("Hips")) * 3 + 1]);
	outRootY.push(motion.rootPos[frame * 3 + 1]);
}
const deltas = outRootY.map((y, i) => y - sourceRootY[i] * (outRootY[0] / sourceRootY[0]));
const spread = Math.max(...deltas) - Math.min(...deltas);
assert.ok(spread < 1e-6, `root Y must be a rigid scale+shift of the source (spread ${spread})`);
pass("floor correction is one rigid shift, so vertical motion survives");

// ---- inputs are validated -------------------------------------------------
assert.throws(
	() => soma77ToCskel27Motion({ frames: 0, fps: 30, ...source }),
	/frames must be a positive integer/
);
assert.throws(
	() => soma77ToCskel27Motion({ frames: FRAMES, fps: FPS, globalRotMats: new Float32Array(4), posedJoints: source.posedJoints }),
	/globalRotMats must be/
);
assert.throws(
	() => resolveSourceIndices(["Hips"]),
	/missing/
);
pass("bad shapes and incomplete source skeletons are rejected");

// ---- end to end: a real npz on disk, read back and converted -------------
// Exercises the actual byte path (zip container + .npy headers) rather than
// trusting in-memory arrays, so a header or offset slip in the reader is
// caught here instead of on the first real Kimodo run.
const workDir = mkdtempSync(join(tmpdir(), "cclay-kimodo-"));
try {
	const npzPath = join(workDir, "kimodo-take.npz");
	writeNpz(npzPath, {
		posed_joints: { data: source.posedJoints, shape: [FRAMES, JOINTS, 3] },
		global_rot_mats: { data: source.globalRotMats, shape: [FRAMES, JOINTS, 3, 3] },
		fps: { data: Float32Array.of(FPS), shape: [] },
	});

	const members = readNpz(npzPath);
	assert.deepEqual(members.posed_joints.shape, [FRAMES, JOINTS, 3]);
	assert.deepEqual(members.global_rot_mats.shape, [FRAMES, JOINTS, 3, 3]);

	const loaded = readKimodoMotion(npzPath);
	assert.equal(loaded.frames, FRAMES);
	assert.equal(loaded.joints, 77);
	assert.equal(loaded.fps, FPS);
	pass("a Kimodo npz round-trips through the reader with its shapes intact");

	const roundTripped = soma77ToCskel27Motion({
		frames: loaded.frames,
		fps: loaded.fps,
		globalRotMats: loaded.globalRotMats,
		posedJoints: loaded.posedJoints,
	});
	assert.deepEqual(
		Array.from(roundTripped.rotMats),
		Array.from(motion.rotMats),
		"converting from disk must match converting in memory"
	);
	assert.deepEqual(Array.from(roundTripped.posedJoints), Array.from(motion.posedJoints));
	pass("disk path and in-memory path agree exactly");

	// The converted take must satisfy the cclay motion npz contract.
	const encoded = motionArraysToNpzMembers({
		frames: roundTripped.frames,
		fps: roundTripped.fps,
		rotMats: roundTripped.rotMats,
		rootPos: roundTripped.rootPos,
		posedJoints: roundTripped.posedJoints,
	});
	assert.deepEqual(encoded.local_rot_mats.shape, [FRAMES, 27, 3, 3]);
	assert.deepEqual(encoded.posed_joints.shape, [FRAMES, 27, 3]);
	assert.deepEqual(encoded.root_positions.shape, [FRAMES, 3]);
	const outPath = join(workDir, "converted.npz");
	writeNpz(outPath, encoded);
	assert.deepEqual(readNpz(outPath).local_rot_mats.shape, [FRAMES, 27, 3, 3]);
	pass("the converted take encodes and writes as a cclay motion npz");

	// A non-SOMA Kimodo model must fail by name, not silently misread.
	const g1Path = join(workDir, "g1.npz");
	writeNpz(g1Path, {
		posed_joints: { data: new Float32Array(FRAMES * 34 * 3), shape: [FRAMES, 34, 3] },
		global_rot_mats: { data: new Float32Array(FRAMES * 34 * 9), shape: [FRAMES, 34, 3, 3] },
	});
	assert.throws(() => readKimodoMotion(g1Path), /expected a 77-joint skeleton, got 34/);
	pass("a non-SOMA skeleton is rejected with an actionable message");
} finally {
	rmSync(workDir, { recursive: true, force: true });
}

// ---- prompt segmentation ---------------------------------------------------
// kimodo_gen splits the prompt on periods and zips the pieces against
// --duration in order, so an unnoticed period inside one segment would shift
// every later segment onto the wrong duration. That must fail loudly.
assert.deepEqual(
	joinPrompts([
		{ prompt: "a person runs forward", duration: 3 },
		{ prompt: "a person walks", duration: 2 },
	]),
	{ prompt: "a person runs forward. a person walks.", duration: "3 2" }
);
assert.deepEqual(
	joinPrompts([{ prompt: "  a person jumps.  ", duration: 1.5 }]),
	{ prompt: "a person jumps.", duration: "1.5" },
	"an author's own trailing period must not create an empty segment"
);
assert.throws(
	() => joinPrompts([{ prompt: "he stops. then runs", duration: 2 }]),
	/reads as a segment break/
);
assert.throws(() => joinPrompts([{ prompt: "ok", duration: 0 }]), /positive duration/);
assert.throws(() => joinPrompts([]), /at least one segment/);
pass("prompt joining matches kimodo_gen's period segmentation, or refuses");

// ---- continuity metric -----------------------------------------------------
// The metric that decides whether Kimodo actually beats ARDY at the seam, so
// it must measure the seam and not the average.
const seam = {
	frames: 4,
	rootPos: Float32Array.of(0, 0, 0, 0.1, 0, 0, 0.9, 0, 0, 1.0, 0, 0),
};
const measured = continuityMetrics(seam);
assert.ok(Math.abs(measured.max_jump_m - 0.8) < 1e-6, `max jump should be 0.8, got ${measured.max_jump_m}`);
assert.equal(measured.max_jump_frame, 1, "the reported frame must localise the seam");
assert.ok(Math.abs(measured.mean_jump_m - 1.0 / 3) < 1e-6);
pass("continuity metric localises the worst seam");

console.log("OK verify-kimodo-cskel27");
