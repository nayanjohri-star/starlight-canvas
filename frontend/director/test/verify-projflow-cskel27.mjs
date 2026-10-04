/**
 * verify-projflow-cskel27.mjs — the hml22 → cskel27 converter (plan C8).
 *
 * WHAT THIS FILE IS DEFENDING. ProjFlow emits POSITIONS ONLY ([T,22,3] @ 20 fps,
 * S1's box report), so tools/projflow/hml22-to-cskel27.mjs is the only place in
 * the pipeline where rotations get INVENTED. Three separate things can go wrong
 * there and only one of them is caught by looking at joint positions:
 *
 *   1. the NAME MAPPING (hml22 is SMPL-named: `left_collar` is the clavicle,
 *      `left_shoulder` is the upper arm, `left_foot` is the TOE). A swap here
 *      shears the arm and shows up as position error.
 *   2. the ROTATION LIFT producing something that is not a rotation at all
 *      (a Gram–Schmidt slip, a transpose, a reflection). Positions can still
 *      come out right while the matrices are unusable by playback.
 *   3. a TWIST FLIP between two frames. Positions are exactly invariant to it,
 *      so no positional gate can ever see it, and on screen it is a limb
 *      snapping through 180°. This is the failure the converter's `carry`
 *      machinery exists to prevent and the reason section [6] is here.
 *
 * THE FIXTURE IS MANUFACTURED, ON PURPOSE. Two real cclay takes
 * (public/demo/walk-then-stop.npz, 360 f of locomotion; test/fixtures/qa-lying.npz,
 * 80 f supine, as a non-upright control) are pushed through our own 27→22
 * downsample and lifted back. That isolates exactly the mapping and the lift
 * without needing the box or a HumanML3D download, and — because both takes are
 * already on the canonical cskel27 body ([3] proves it) — any residual is the
 * ALGORITHM, not retargeting.
 *
 * WHAT IS DELIBERATELY NOT GATED. The 5 filled joints (Spine2, L/R HandEnd,
 * L/R HandThumb1) have no hml22 source and land 4–6 cm off; plan GP4's carve-out
 * accepts that, so [5] asserts they EXIST AND ARE FINITE, never that they are
 * accurate. Axial twist on the arms is unrecoverable from positions (26–55°) —
 * measure and report, do not gate, per the same carve-out.
 */

import assert from "node:assert/strict";
import { CSKEL27_JOINTS, CSKEL27_PARENTS, COZYCLAY_TO_CSKEL27 } from "../src/ardy/cskel27.js";
import { globalRotations, deriveBoneOffsets } from "../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { readNpz } from "../tools/kimodo/read-npz.mjs";
import { soma77ToCskel27Motion, SOMA77_JOINTS } from "../tools/kimodo/soma77-to-cskel27.mjs";
import { IK_TRACKS, MID_TRACKS, FK_TRACKS } from "../src/ardy/ik.js";
import {
	CSKEL27_FROM_HML22,
	CSKEL27_TO_HML22_INDEX,
	HML22_JOINTS,
	HML22_PARENTS,
	HML22_TO_CSKEL27_INDEX,
	cskel27ToHml22Positions,
	globalsToCskel27Locals,
	hml22PoseToCskel27,
	hml22ToCskel27Motion,
	liftHml22PoseGlobals,
	resolveSourceIndices,
	restPositionsHml22,
} from "../tools/projflow/hml22-to-cskel27.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const FILLED = new Set(CSKEL27_JOINTS.filter((name) => CSKEL27_FROM_HML22[name] === null));
const JOINT_INDEX = new Map(CSKEL27_JOINTS.map((name, index) => [name, index]));

const TAKES = [
	{ label: "walk-then-stop", path: "public/demo/walk-then-stop.npz", frames: 360 },
	{ label: "qa-lying", path: "test/fixtures/qa-lying.npz", frames: 80 },
];

// ---- small maths the assertions need --------------------------------------

function readMat(flat, frame, joint, joints = 27) {
	const base = frame * joints * 9 + joint * 9;
	return [
		[flat[base], flat[base + 1], flat[base + 2]],
		[flat[base + 3], flat[base + 4], flat[base + 5]],
		[flat[base + 6], flat[base + 7], flat[base + 8]],
	];
}

function determinant(m) {
	return (
		m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
		m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
		m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
	);
}

/** Largest |MᵀM − I| entry: 0 for a perfectly orthonormal matrix. */
function orthonormalityError(m) {
	let worst = 0;
	for (let a = 0; a < 3; a += 1) {
		for (let b = 0; b < 3; b += 1) {
			let sum = 0;
			for (let k = 0; k < 3; k += 1) sum += m[k][a] * m[k][b];
			worst = Math.max(worst, Math.abs(sum - (a === b ? 1 : 0)));
		}
	}
	return worst;
}

/** Geodesic angle between two rotation matrices, in degrees. */
function geodesicDegrees(a, b) {
	let trace = 0;
	for (let i = 0; i < 3; i += 1) {
		for (let k = 0; k < 3; k += 1) trace += a[k][i] * b[k][i];
	}
	return (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
}

function loadTake(path) {
	const members = readNpz(path);
	const [frames, joints] = members.posed_joints.shape;
	assert.equal(joints, 27, `${path} must be a 27-joint take`);
	return { frames, posedJoints: members.posed_joints.data, localRotMats: members.local_rot_mats.data };
}

/**
 * Per-joint positional error in centimetres. `rootRelative` subtracts each
 * frame's own Hips from both sides first, which separates POSE error from
 * ROOT-TRAJECTORY error: the leg-ratio root rescale deliberately moves the whole
 * figure (that is how stride survives reproportioning), and counting it as
 * mapping error would bury a 1 mm pose difference under a trajectory difference.
 */
function positionError(source, round, frames, rootRelative = false) {
	const stats = CSKEL27_JOINTS.map(() => ({ sum: 0, max: 0 }));
	for (let frame = 0; frame < frames; frame += 1) {
		const base = frame * 27 * 3;
		const ox = rootRelative ? round[base] - source[base] : 0;
		const oy = rootRelative ? round[base + 1] - source[base + 1] : 0;
		const oz = rootRelative ? round[base + 2] - source[base + 2] : 0;
		for (let joint = 0; joint < 27; joint += 1) {
			const distance = Math.hypot(
				round[base + joint * 3] - source[base + joint * 3] - ox,
				round[base + joint * 3 + 1] - source[base + joint * 3 + 1] - oy,
				round[base + joint * 3 + 2] - source[base + joint * 3 + 2] - oz
			) * 100;
			stats[joint].sum += distance;
			if (distance > stats[joint].max) stats[joint].max = distance;
		}
	}
	return stats.map((s) => ({ mean: s.sum / frames, max: s.max }));
}

// ---------------------------------------------------------------------------
// [1] THE MAPPING TABLE
//
// WHY. hml22 is SMPL-named and cskel27 is Mixamo-named, and the two disagree on
// what "shoulder" and "foot" mean. Every one of those traps is asserted by name
// here, because a swap is silent: the skeleton still poses, it just shears. The
// bijection count (22 driven / 5 filled) is asserted too — it is the whole
// accounting, so a joint quietly losing its source shows up as a count.
// ---------------------------------------------------------------------------

assert.deepEqual(
	Object.keys(CSKEL27_FROM_HML22).sort(),
	[...CSKEL27_JOINTS].sort(),
	"the map must name every cskel27 joint and nothing else"
);
assert.equal(HML22_JOINTS.length, 22, "hml22 must have 22 joints");
assert.equal(new Set(HML22_JOINTS).size, 22, "hml22 joint names must be unique");
assert.equal(HML22_PARENTS.length, 22);
assert.equal(HML22_PARENTS[0], null, "pelvis is the hml22 root");
// t2m_kinematic_chain: 9 (spine3) carries the neck and both collars.
assert.deepEqual([HML22_PARENTS[12], HML22_PARENTS[13], HML22_PARENTS[14]], [9, 9, 9]);
// ...which is exactly cskel27 Spine3's role, so Spine3↔spine3 is forced.
assert.equal(CSKEL27_FROM_HML22.Spine3, "spine3");

const driven = CSKEL27_JOINTS.filter((name) => CSKEL27_FROM_HML22[name] !== null);
assert.equal(driven.length, 22, "22 cskel27 joints must be driven by hml22");
assert.equal(FILLED.size, 5, "exactly 5 cskel27 joints are filled");
assert.deepEqual(
	[...FILLED].sort(),
	["LeftHandEnd", "LeftHandThumb1", "RightHandEnd", "RightHandThumb1", "Spine2"],
	"the filled set is the plan's accepted-loss set, nothing more"
);
assert.equal(
	new Set(driven.map((name) => CSKEL27_FROM_HML22[name])).size,
	22,
	"the 22 driven joints must consume all 22 hml22 joints one-to-one"
);
assert.deepEqual(
	HML22_TO_CSKEL27_INDEX.map((index) => CSKEL27_JOINTS[index]).sort(),
	[...driven].sort(),
	"the inverse index must be the same bijection read backwards"
);
pass("mapping is a 22-driven / 5-filled bijection over cskel27");

// The naming traps, spelled out one by one.
assert.equal(CSKEL27_FROM_HML22.LeftShoulder, "left_collar", "cskel27 LeftShoulder is the CLAVICLE");
assert.equal(CSKEL27_FROM_HML22.LeftArm, "left_shoulder", "cskel27 LeftArm is SMPL's upper arm");
assert.equal(CSKEL27_FROM_HML22.RightShoulder, "right_collar");
assert.equal(CSKEL27_FROM_HML22.RightArm, "right_shoulder");
assert.equal(CSKEL27_FROM_HML22.LeftFoot, "left_ankle", "the cskel27 ankle is hml22 `left_ankle` (7)");
assert.equal(CSKEL27_FROM_HML22.LeftToeBase, "left_foot", "hml22 `left_foot` (10) is the TOE BASE");
assert.equal(CSKEL27_FROM_HML22.RightFoot, "right_ankle");
assert.equal(CSKEL27_FROM_HML22.RightToeBase, "right_foot");
assert.equal(HML22_JOINTS[10], "left_foot");
assert.equal(HML22_JOINTS[16], "left_shoulder");
pass("SMPL naming traps are mapped across, not by matching name text");

// Filled joints resolve to a mapped ancestor (that is what makes their local
// identity), and carry no source index of their own.
const sources = resolveSourceIndices();
const expectedAncestor = {
	Spine2: "spine2",
	LeftHandEnd: "left_wrist",
	LeftHandThumb1: "left_wrist",
	RightHandEnd: "right_wrist",
	RightHandThumb1: "right_wrist",
};
for (const name of FILLED) {
	const joint = JOINT_INDEX.get(name);
	assert.equal(CSKEL27_TO_HML22_INDEX[joint], -1, `${name} must have no source of its own`);
	assert.equal(
		HML22_JOINTS[sources[joint]],
		expectedAncestor[name],
		`${name} must inherit its nearest mapped ancestor`
	);
}
pass("filled joints resolve to their nearest mapped ancestor");

// The lift walks cskel27 once in ascending index order and reads globals[parent]
// as it goes; that is only valid if every parent precedes its child.
for (let joint = 0; joint < 27; joint += 1) {
	if (CSKEL27_PARENTS[joint] === null) continue;
	assert.ok(
		CSKEL27_PARENTS[joint] < joint,
		`cskel27 must be topologically ordered: ${CSKEL27_JOINTS[joint]} precedes its parent`
	);
}
pass("cskel27 is parent-before-child, so one ascending pass lifts the whole body");

// ---------------------------------------------------------------------------
// [2] THE OUTPUT SHAPE CONTRACT
//
// WHY. C8 says "same output shape as soma77ToCskel27Motion so everything
// downstream works unchanged". Downstream is the npz writer, measure-preserve
// and playback; none of them are in this file, so the only cheap way to keep
// them honest is to compare the two converters' returns FIELD FOR FIELD against
// each other rather than against a copied literal that can drift.
// ---------------------------------------------------------------------------

const somaFrames = 4;
const somaJoints = SOMA77_JOINTS.length;
const somaIndex = new Map(SOMA77_JOINTS.map((name, index) => [name, index]));
const somaGlobals = new Float32Array(somaFrames * somaJoints * 9);
const somaPosed = new Float32Array(somaFrames * somaJoints * 3);
for (let frame = 0; frame < somaFrames; frame += 1) {
	for (let joint = 0; joint < somaJoints; joint += 1) {
		const base = frame * somaJoints * 9 + joint * 9;
		somaGlobals[base] = 1;
		somaGlobals[base + 4] = 1;
		somaGlobals[base + 8] = 1;
	}
	const put = (name, x, y, z) => {
		const base = frame * somaJoints * 3 + somaIndex.get(name) * 3;
		somaPosed[base] = x;
		somaPosed[base + 1] = y;
		somaPosed[base + 2] = z;
	};
	put("Hips", 0.1 * frame, 0.95, 0);
	put("LeftLeg", 0.1 * frame, 0.9, 0);
	put("LeftShin", 0.1 * frame, 0.48, 0);
	put("LeftFoot", 0.1 * frame, 0.06, 0);
}
const somaMotion = soma77ToCskel27Motion({
	frames: somaFrames,
	fps: 30,
	globalRotMats: somaGlobals,
	posedJoints: somaPosed,
});

const restHml = restPositionsHml22(canonicalCskel27Reference());
const restClip = new Float32Array(somaFrames * 22 * 3);
for (let frame = 0; frame < somaFrames; frame += 1) {
	for (let joint = 0; joint < 22; joint += 1) {
		const base = frame * 22 * 3 + joint * 3;
		restClip[base] = restHml[joint][0] + 0.1 * frame;
		restClip[base + 1] = restHml[joint][1];
		restClip[base + 2] = restHml[joint][2];
	}
}
const restMotion = hml22ToCskel27Motion({ positions: restClip });

assert.deepEqual(
	Object.keys(restMotion).sort(),
	Object.keys(somaMotion).sort(),
	"hml22ToCskel27Motion must return exactly soma77ToCskel27Motion's fields — no more, no fewer"
);
for (const key of Object.keys(somaMotion)) {
	assert.equal(
		restMotion[key]?.constructor?.name,
		somaMotion[key]?.constructor?.name,
		`field ${key} must have the same type as soma77's`
	);
}
assert.equal(restMotion.frames, somaFrames, "frames is derived from the positions length");
assert.equal(restMotion.rotMats.length, somaFrames * 27 * 9);
assert.equal(restMotion.rootPos.length, somaFrames * 3);
assert.equal(restMotion.posedJoints.length, somaFrames * 27 * 3);
assert.ok(restMotion.rotMats.every(Number.isFinite));
assert.ok(restMotion.rootPos.every(Number.isFinite));
assert.ok(restMotion.posedJoints.every(Number.isFinite));
pass("output is the five soma77 fields, same names and same types");

// fps defaults to ACMDM's own 20 and is passed through untouched: retiming onto
// the 24 fps app timeline happens downstream, exactly as for Kimodo takes. If
// this converter retimed, the retimer would run twice.
assert.equal(restMotion.fps, 20, "fps defaults to the ProjFlow/ACMDM rate of 20");
assert.equal(hml22ToCskel27Motion({ positions: restClip, fps: 30 }).fps, 30);
assert.equal(
	hml22ToCskel27Motion({ positions: restClip, fps: 20 }).frames,
	somaFrames,
	"frame count must not change with fps — this converter does not retime"
);
pass("fps is carried through at 20 and no retiming happens here");

// A rest-pose clip must produce identity locals everywhere: the aim directions
// are the rest directions by construction, so anything else is a lift bug.
for (let joint = 0; joint < 27; joint += 1) {
	const m = readMat(restMotion.rotMats, 1, joint);
	assert.ok(
		geodesicDegrees(m, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) < 1e-3,
		`${CSKEL27_JOINTS[joint]} must be identity on a rest-pose clip`
	);
}
pass("a rest-pose clip lifts to identity locals on all 27 joints");

// ---------------------------------------------------------------------------
// [3] REAL FIXTURES: the round trip, and the line-edit gate
//
// WHY THE GATE IS ON THE 15 TRACKS. C6 says a line edit names "one of the 15 ik
// track ids". A line edit is scored on WHERE THE DRAWN JOINT LANDS, so the 5 cm
// gate belongs on those joints — not on a thumb hml22 never saw. The ids and
// their cskel27 targets are taken from src/ardy/ik.js, so renaming a track
// breaks this file instead of silently shrinking the gate's coverage.
// ---------------------------------------------------------------------------

const EFFECTOR_TARGET = {
	leftHand: "LeftHand",
	rightHand: "RightHand",
	leftFoot: "LeftFoot",
	rightFoot: "RightFoot",
	leftElbow: "LeftForeArm",
	rightElbow: "RightForeArm",
	leftKnee: "LeftLeg",
	rightKnee: "RightLeg",
};
assert.deepEqual(
	[...IK_TRACKS, ...MID_TRACKS].map((track) => track.id).sort(),
	Object.keys(EFFECTOR_TARGET).sort(),
	"the IK/mid target table must cover exactly the ik.js track ids"
);
// FK tracks resolve through the app's own bone→cskel27 table, which is where
// `spine`→Spine1 and `chest`→Spine2 come from (cskel27 has one more torso link).
const TRACK_TARGETS = [
	...[...IK_TRACKS, ...MID_TRACKS].map((track) => [track.id, EFFECTOR_TARGET[track.id]]),
	...FK_TRACKS.map((track) => {
		const bone = track.bone.replace(/^mixamorig:?/, "");
		const index = COZYCLAY_TO_CSKEL27[bone];
		assert.ok(Number.isInteger(index), `FK track ${track.id} has no cskel27 target`);
		return [track.id, CSKEL27_JOINTS[index]];
	}),
];
assert.equal(TRACK_TARGETS.length, 15, "C6 promises 15 line-edit tracks");
pass("the 15 line-edit tracks resolve to cskel27 joints via ik.js and COZYCLAY_TO_CSKEL27");

const canonicalOffsets = deriveBoneOffsets(
	canonicalCskel27Reference().posed_joints,
	canonicalCskel27Reference().local_rot_mats
);

for (const take of TAKES) {
	const loaded = loadTake(take.path);
	assert.equal(loaded.frames, take.frames, `${take.label} frame count changed`);

	// 27 → 22 is a pure index gather, so it is lossless by construction; assert
	// that rather than assume it, since it is also what feeds the box.
	const hml = cskel27ToHml22Positions({ frames: loaded.frames, posedJoints: loaded.posedJoints });
	assert.equal(hml.length, loaded.frames * 22 * 3);
	for (let joint = 0; joint < 22; joint += 1) {
		const target = HML22_TO_CSKEL27_INDEX[joint];
		for (const frame of [0, loaded.frames - 1]) {
			for (let axis = 0; axis < 3; axis += 1) {
				assert.equal(
					hml[frame * 22 * 3 + joint * 3 + axis],
					loaded.posedJoints[frame * 27 * 3 + target * 3 + axis],
					`${HML22_JOINTS[joint]} must gather cskel27 ${CSKEL27_JOINTS[target]}`
				);
			}
		}
	}

	// The fixture must already be the canonical body, or [4]'s numbers would be
	// measuring retargeting instead of the algorithm.
	const clipOffsets = deriveBoneOffsets(
		Array.from({ length: 27 }, (_, joint) => [
			loaded.posedJoints[joint * 3],
			loaded.posedJoints[joint * 3 + 1],
			loaded.posedJoints[joint * 3 + 2],
		]),
		Array.from({ length: 27 }, (_, joint) => readMat(loaded.localRotMats, 0, joint))
	);
	let boneDrift = 0;
	for (let joint = 0; joint < 27; joint += 1) {
		if (CSKEL27_PARENTS[joint] === null) continue;
		boneDrift = Math.max(
			boneDrift,
			Math.hypot(
				clipOffsets[joint][0] - canonicalOffsets[joint][0],
				clipOffsets[joint][1] - canonicalOffsets[joint][1],
				clipOffsets[joint][2] - canonicalOffsets[joint][2]
			)
		);
	}
	assert.ok(
		boneDrift < 0.005,
		`${take.label} must be on the canonical body for the round trip to measure the algorithm (drift ${boneDrift})`
	);

	const started = process.hrtime.bigint();
	const motion = hml22ToCskel27Motion({ positions: hml, fps: 20 });
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.equal(motion.frames, loaded.frames);

	// ---- [4] round trip, per line-edit track --------------------------------
	const world = positionError(loaded.posedJoints, motion.posedJoints, loaded.frames);
	const pose = positionError(loaded.posedJoints, motion.posedJoints, loaded.frames, true);
	console.log(`\n  ${take.label} (${loaded.frames}f, ${elapsedMs.toFixed(1)} ms) — line-edit track round trip, cm`);
	let worstTrack = { id: null, max: -1 };
	for (const [id, joint] of TRACK_TARGETS) {
		const index = JOINT_INDEX.get(joint);
		const flag = FILLED.has(joint) ? "   (target is a FILLED joint)" : "";
		console.log(
			`    ${id.padEnd(14)} -> ${joint.padEnd(14)}` +
				` world mean ${world[index].mean.toFixed(3)} max ${world[index].max.toFixed(3)};` +
				` pose-only max ${pose[index].max.toFixed(4)}${flag}`
		);
		assert.ok(
			world[index].max < 5,
			`line-edit track ${id} (${joint}) must round-trip under 5 cm, got ${world[index].max.toFixed(3)}`
		);
		if (world[index].max > worstTrack.max) worstTrack = { id, max: world[index].max };
	}
	console.log(`    -> worst track: ${worstTrack.id} ${worstTrack.max.toFixed(3)} cm (gate 5 cm)`);

	// Every hml22-DRIVEN joint, not just the tracks: GP4's carve-out is
	// "< 5 cm on every hml22-driven joint".
	let worstDriven = { joint: null, max: -1 };
	for (const name of driven) {
		const index = JOINT_INDEX.get(name);
		assert.ok(
			world[index].max < 5,
			`driven joint ${name} must round-trip under 5 cm, got ${world[index].max.toFixed(3)}`
		);
		if (world[index].max > worstDriven.max) worstDriven = { joint: name, max: world[index].max };
	}
	console.log(
		`    -> worst of the 22 DRIVEN joints: ${worstDriven.joint} ${worstDriven.max.toFixed(3)} cm`
	);
	pass(`${take.label}: all 15 line-edit tracks and all 22 driven joints round-trip under 5 cm`);

	// ---- [5] filled joints: present and finite, NOT accurate ----------------
	// GP4 carve-out. Asserting accuracy here would be asserting a fiction; what
	// downstream actually needs is that the arrays are complete and usable.
	for (const name of FILLED) {
		const index = JOINT_INDEX.get(name);
		for (let frame = 0; frame < loaded.frames; frame += 1) {
			const base = frame * 27 * 3 + index * 3;
			for (let axis = 0; axis < 3; axis += 1) {
				assert.ok(
					Number.isFinite(motion.posedJoints[base + axis]),
					`${name} must be finite at frame ${frame}`
				);
			}
		}
		// ...and their LOCAL must be exactly identity — the "not authored" rule.
		for (const frame of [0, Math.floor(loaded.frames / 2), loaded.frames - 1]) {
			const m = readMat(motion.rotMats, frame, index);
			assert.ok(
				geodesicDegrees(m, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) < 1e-3,
				`${name} local must be identity at frame ${frame}`
			);
		}
	}
	console.log(
		`    filled (accepted loss, GP4): ` +
			[...FILLED]
				.map((name) => `${name} ${world[JOINT_INDEX.get(name)].max.toFixed(2)}`)
				.join(", ") + " cm max"
	);
	pass(`${take.label}: the 5 filled joints are finite everywhere and emit identity locals`);

	// ---- [6] every emitted matrix is a rotation -----------------------------
	// Not sampled: EVERY joint of EVERY frame. A reflection or a denormalised row
	// would still render "something", so the only useful check is exhaustive.
	let worstDet = 0;
	let worstOrtho = 0;
	for (let frame = 0; frame < loaded.frames; frame += 1) {
		for (let joint = 0; joint < 27; joint += 1) {
			const m = readMat(motion.rotMats, frame, joint);
			worstDet = Math.max(worstDet, Math.abs(determinant(m) - 1));
			worstOrtho = Math.max(worstOrtho, orthonormalityError(m));
		}
	}
	assert.ok(worstDet < 1e-3, `every local must have det 1 (worst |det-1| ${worstDet})`);
	assert.ok(worstOrtho < 1e-3, `every local must be orthonormal (worst |MᵀM-I| ${worstOrtho})`);
	console.log(
		`    ${loaded.frames * 27} matrices: worst |det-1| ${worstDet.toExponential(2)},` +
			` worst |MᵀM-I| ${worstOrtho.toExponential(2)}`
	);
	pass(`${take.label}: all ${loaded.frames * 27} emitted locals are proper rotations`);

	// ---- [7] temporal continuity -------------------------------------------
	// A twist flip reads as ~180°. The honest bound is the SOURCE CLIP'S OWN
	// worst frame-to-frame local delta: the lift is allowed to be as jumpy as the
	// motion it is reading and no jumpier. Measured first, then pinned with
	// margin (walk-then-stop: lift 22.740° vs source 22.742°; qa-lying: 19.73°
	// vs 17.16°, the extra being forearm twist wander).
	let worstDelta = { joint: null, frame: -1, degrees: 0 };
	let sourceWorst = 0;
	for (let frame = 1; frame < loaded.frames; frame += 1) {
		for (let joint = 0; joint < 27; joint += 1) {
			const delta = geodesicDegrees(
				readMat(motion.rotMats, frame - 1, joint),
				readMat(motion.rotMats, frame, joint)
			);
			if (delta > worstDelta.degrees) {
				worstDelta = { joint: CSKEL27_JOINTS[joint], frame, degrees: delta };
			}
			sourceWorst = Math.max(
				sourceWorst,
				geodesicDegrees(
					readMat(loaded.localRotMats, frame - 1, joint),
					readMat(loaded.localRotMats, frame, joint)
				)
			);
		}
	}
	console.log(
		`    continuity: worst frame-to-frame local delta ${worstDelta.degrees.toFixed(3)}°` +
			` (${worstDelta.joint}, frame ${worstDelta.frame}); source clip's own worst ${sourceWorst.toFixed(3)}°`
	);
	assert.ok(
		worstDelta.degrees < 40,
		`no local may jump 40° between frames — a twist flip is ~180° (worst ${worstDelta.degrees.toFixed(3)}° on ${worstDelta.joint})`
	);
	assert.ok(
		worstDelta.degrees < sourceWorst + 6,
		`the lift may not be jumpier than the motion it reads (${worstDelta.degrees.toFixed(3)}° vs source ${sourceWorst.toFixed(3)}°)`
	);
	pass(`${take.label}: no twist flips — worst local delta ${worstDelta.degrees.toFixed(2)}°`);

	// ---- [8] FK over the emitted locals reproduces the lift's globals -------
	// The structural check: this is what makes the 4-vs-3 spine a non-issue, and
	// it fails loudly on a wrong parent, a wrong source index or a transpose slip.
	const observed = Array.from({ length: 22 }, (_, joint) => [
		hml[joint * 3],
		hml[joint * 3 + 1],
		hml[joint * 3 + 2],
	]);
	const lifted = liftHml22PoseGlobals(observed, { rest: restHml });
	const rebuilt = globalRotations(globalsToCskel27Locals(lifted.globals));
	let globalDrift = 0;
	for (let joint = 0; joint < 27; joint += 1) {
		globalDrift = Math.max(globalDrift, geodesicDegrees(rebuilt[joint], lifted.globals[joint]));
	}
	assert.ok(globalDrift < 1e-4, `FK over the locals must rebuild the lifted globals (${globalDrift})`);
	pass(`${take.label}: FK over the emitted locals reproduces every lifted global`);

	// ---- [9] the floor convention, mirrored from soma77 ---------------------
	// A ProjFlow line edit gets spliced back into a Kimodo/ARDY take. If the two
	// converters grounded differently the figure would step up or down at the
	// seam, so the convention has to be the same one: ONE rigid shift putting the
	// clip's lowest foot sample at Y=0, never a per-frame grounding (that would
	// flatten a jump).
	const feet = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"].map((n) => JOINT_INDEX.get(n));
	let lowest = Infinity;
	for (let frame = 0; frame < loaded.frames; frame += 1) {
		for (const joint of feet) {
			lowest = Math.min(lowest, motion.posedJoints[(frame * 27 + joint) * 3 + 1]);
		}
	}
	assert.ok(Math.abs(lowest) < 1e-6, `lowest foot sample must touch Y=0, got ${lowest}`);

	const ungrounded = hml22ToCskel27Motion({ positions: hml, fps: 20, ground: false });
	const shifts = [];
	for (let frame = 0; frame < loaded.frames; frame += 1) {
		shifts.push(ungrounded.rootPos[frame * 3 + 1] - motion.rootPos[frame * 3 + 1]);
	}
	const spread = Math.max(...shifts) - Math.min(...shifts);
	assert.ok(spread < 1e-6, `the floor correction must be ONE rigid shift, spread was ${spread}`);
	for (let frame = 0; frame < loaded.frames; frame += 1) {
		for (const axis of [0, 2]) {
			assert.equal(
				motion.rootPos[frame * 3 + axis],
				ungrounded.rootPos[frame * 3 + axis],
				"grounding must not touch the horizontal trajectory"
			);
		}
	}
	pass(`${take.label}: floor-aligned by one rigid shift, matching soma77ToCskel27Motion`);
}

// ---------------------------------------------------------------------------
// [10] THE BRANCH POINT, EXERCISED DIRECTLY
//
// WHY A SYNTHETIC CLIP. The two real takes never fold a limb exactly through the
// antiparallel configuration, so they cannot prove the continuity machinery is
// doing anything — they only prove nothing is currently broken. Here the left
// forearm is swept through exactly 180° of elbow flexion in 5° steps, which puts
// one frame precisely on the singular point where every axis perpendicular to
// the bone is a valid 180° swing. The sweep plane is chosen perpendicular to the
// converter's own first-frame fallback seed, so a converter that reached for the
// seed instead of continuing the previous frame lands 180° of TWIST away —
// invisible to every positional gate above, and a limb snapping on screen.
// ---------------------------------------------------------------------------

const elbow = HML22_JOINTS.indexOf("left_elbow");
const wrist = HML22_JOINTS.indexOf("left_wrist");
const forearm = [
	restHml[wrist][0] - restHml[elbow][0],
	restHml[wrist][1] - restHml[elbow][1],
	restHml[wrist][2] - restHml[elbow][2],
];
const forearmLength = Math.hypot(...forearm);
const forearmDir = forearm.map((v) => v / forearmLength);
const unitOf = (v) => {
	const n = Math.hypot(...v);
	return v.map((x) => x / n);
};
const crossOf = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
// The converter's cold fallback axis, reproduced here so the sweep can be made
// perpendicular to it and the test can actually discriminate.
const coldSeed = Math.abs(forearmDir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
const coldAxis = unitOf(crossOf(forearmDir, coldSeed));
const sweepAxis = unitOf(crossOf(forearmDir, coldAxis));
assert.ok(
	Math.abs(sweepAxis.reduce((sum, v, i) => sum + v * coldAxis[i], 0)) < 1e-9,
	"the sweep must be perpendicular to the cold fallback axis or it proves nothing"
);

function rotationAbout(axis, radians) {
	const [x, y, z] = axis;
	const c = Math.cos(radians);
	const s = Math.sin(radians);
	const t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}
function flexedPose(degrees) {
	const m = rotationAbout(sweepAxis, (degrees * Math.PI) / 180);
	const direction = [
		m[0][0] * forearmDir[0] + m[0][1] * forearmDir[1] + m[0][2] * forearmDir[2],
		m[1][0] * forearmDir[0] + m[1][1] * forearmDir[1] + m[1][2] * forearmDir[2],
		m[2][0] * forearmDir[0] + m[2][1] * forearmDir[1] + m[2][2] * forearmDir[2],
	];
	const posed = restHml.map((joint) => joint.slice());
	posed[wrist] = [
		restHml[elbow][0] + direction[0] * forearmLength,
		restHml[elbow][1] + direction[1] * forearmLength,
		restHml[elbow][2] + direction[2] * forearmLength,
	];
	return posed;
}

const SWEEP = [170, 175, 180, 185, 190];
const foreArmIndex = JOINT_INDEX.get("LeftForeArm");
const sweepLocals = [];
let carry = null;
for (const degrees of SWEEP) {
	const lifted = liftHml22PoseGlobals(flexedPose(degrees), { rest: restHml, carry });
	carry = lifted.carry;
	sweepLocals.push(globalsToCskel27Locals(lifted.globals)[foreArmIndex]);
}
let sweepWorst = 0;
for (let step = 1; step < sweepLocals.length; step += 1) {
	sweepWorst = Math.max(sweepWorst, geodesicDegrees(sweepLocals[step - 1], sweepLocals[step]));
}
assert.ok(
	sweepWorst < 6,
	`a 5°/frame sweep through the antiparallel singularity must stay a 5°/frame sweep, got ${sweepWorst.toFixed(3)}°`
);

// ...and prove the carry is what did it: the same singular frame lifted cold
// (no previous frame) lands a full 180° of twist away.
const cold = globalsToCskel27Locals(
	liftHml22PoseGlobals(flexedPose(180), { rest: restHml, carry: null }).globals
)[foreArmIndex];
const coldGap = geodesicDegrees(cold, sweepLocals[SWEEP.indexOf(180)]);
assert.ok(
	coldGap > 170,
	`the cold fallback must differ by ~180° or this test is not exercising the branch (got ${coldGap.toFixed(1)}°)`
);
console.log(
	`\n  antiparallel sweep: continued branch max step ${sweepWorst.toFixed(3)}° (input 5°/frame);` +
		` cold branch is ${coldGap.toFixed(1)}° away`
);
pass("the antiparallel branch is resolved by continuing the previous frame, not by a seed");

// The pose-level helper and the motion loop must agree exactly — the motion loop
// is only allowed to be the pose helper in a for-loop plus the floor shift.
const sweepClip = new Float32Array(SWEEP.length * 22 * 3);
SWEEP.forEach((degrees, frame) => {
	const posed = flexedPose(degrees);
	for (let joint = 0; joint < 22; joint += 1) {
		const base = frame * 22 * 3 + joint * 3;
		sweepClip[base] = posed[joint][0];
		sweepClip[base + 1] = posed[joint][1];
		sweepClip[base + 2] = posed[joint][2];
	}
});
const sweepMotion = hml22ToCskel27Motion({ positions: sweepClip, ground: false, scaleRoot: false });
let poseCarry = null;
const boneOffsets = deriveBoneOffsets(
	canonicalCskel27Reference().posed_joints,
	canonicalCskel27Reference().local_rot_mats
);
for (let frame = 0; frame < SWEEP.length; frame += 1) {
	const step = hml22PoseToCskel27(flexedPose(SWEEP[frame]), {
		rest: restHml,
		boneOffsets,
		carry: poseCarry,
		frame,
	});
	poseCarry = step.carry;
	for (let joint = 0; joint < 27; joint += 1) {
		// Entrywise, not geodesic: the motion path stores its locals as float32
		// and the geodesic angle goes as sqrt(trace error) near zero, so float32
		// storage noise alone reads as ~0.01° there. Entry difference is the
		// metric that actually answers "is this the same matrix".
		const emitted = readMat(sweepMotion.rotMats, frame, joint);
		for (let row = 0; row < 3; row += 1) {
			for (let col = 0; col < 3; col += 1) {
				assert.ok(
					Math.abs(step.locals[joint][row][col] - emitted[row][col]) < 1e-6,
					`pose-level and motion-level must agree on ${CSKEL27_JOINTS[joint]} at frame ${frame}`
				);
			}
		}
	}
}
pass("the exported pose-level convert reproduces the motion loop frame for frame");

// ---------------------------------------------------------------------------
// [11] ERROR PATHS
//
// WHY. The converter sits between a python box and an npz writer, so its inputs
// arrive as raw arrays with no schema. Every one of these failures is one a real
// box run can produce (a truncated file, a diverged sampler, a wrong-rate clip),
// and each message has to name the thing to look at — a NaN that reaches a
// rotation matrix surfaces a thousand lines downstream as an empty viewport.
// ---------------------------------------------------------------------------

assert.throws(() => hml22ToCskel27Motion(), /expected an object/);
assert.throws(() => hml22ToCskel27Motion(null), /expected an object/);
assert.throws(() => hml22ToCskel27Motion({}), /positions must be a Float32Array or number\[\]/);
assert.throws(
	() => hml22ToCskel27Motion({ positions: "nope" }),
	/positions must be a Float32Array or number\[\]/
);
assert.throws(
	() => hml22ToCskel27Motion({ positions: new Float32Array(0) }),
	/not a whole number of 22-joint frames/
);
assert.throws(
	() => hml22ToCskel27Motion({ positions: new Float32Array(70) }),
	/not a whole number of 22-joint frames \(multiple of 66\)/
);
// A 27-joint stream handed in by mistake is the likeliest shape error of all,
// and 27*3 = 81 is not a multiple of 66, so it cannot slip through as "frames".
assert.throws(
	() => hml22ToCskel27Motion({ positions: new Float32Array(27 * 3) }),
	/not a whole number of 22-joint frames/
);
assert.throws(
	() => hml22ToCskel27Motion({ positions: restClip, frames: 99 }),
	/frames says 99 but positions holds 4 frames/
);
assert.throws(() => hml22ToCskel27Motion({ positions: restClip, fps: 0 }), /fps must be a positive integer/);
assert.throws(() => hml22ToCskel27Motion({ positions: restClip, fps: 20.5 }), /fps must be a positive integer/);

const withNaN = Float32Array.from(restClip);
withNaN[1 * 22 * 3 + 20 * 3 + 2] = NaN;
assert.throws(
	() => hml22ToCskel27Motion({ positions: withNaN }),
	/frame 1, joint 20 left_wrist, axis z/,
	"a NaN must be reported by frame, joint name and axis"
);
const withInfinity = Float32Array.from(restClip);
withInfinity[0] = Infinity;
assert.throws(() => hml22ToCskel27Motion({ positions: withInfinity }), /frame 0, joint 0 pelvis, axis x/);

// A collapsed skeleton (every joint at the origin) has no measurable leg, which
// is the signature of a diverged sampler rather than a coding error.
assert.throws(
	() => hml22ToCskel27Motion({ positions: new Float32Array(22 * 3) }),
	/source leg length measured as zero/
);
// A single-frame clip is legal: a pose edit is one frame.
assert.equal(hml22ToCskel27Motion({ positions: restClip.slice(0, 66) }).frames, 1);

assert.throws(() => cskel27ToHml22Positions({ posedJoints: new Float32Array(10) }), /not a whole number/);
assert.throws(() => cskel27ToHml22Positions({}), /posedJoints must be an array of numbers/);
assert.throws(() => liftHml22PoseGlobals([], { rest: restHml }), /observed must be 22/);
assert.throws(
	() => liftHml22PoseGlobals(restHml, { rest: restHml.slice(0, 3) }),
	/rest must be 22/
);
// Two joints on top of each other give a bone with no direction; naming the
// joint and the frame is the difference between a fixable report and a shrug.
const collapsed = restHml.map((joint) => joint.slice());
collapsed[HML22_JOINTS.indexOf("left_knee")] = collapsed[HML22_JOINTS.indexOf("left_hip")].slice();
assert.throws(
	() => liftHml22PoseGlobals(collapsed, { rest: restHml, frame: 7 }),
	/degenerate direction for LeftUpLeg \(frame 7\)/
);
pass("bad shapes, NaNs, collapsed skeletons and bad fps are rejected by name");

// ---------------------------------------------------------------------------
// [12] PERFORMANCE
//
// WHY A GATE AT ALL. This is closed-form maths with no solver in it, so it must
// never become the reason a line edit misses GP3's 10 s round trip; if it ever
// does, something has grown an iteration. Measured ~8–11 ms for 360 frames on
// the dev box; the bound is loose enough to survive a loaded CI machine and
// still catch an order-of-magnitude regression.
// ---------------------------------------------------------------------------

const perfSource = loadTake("public/demo/walk-then-stop.npz");
const perfInput = cskel27ToHml22Positions({ frames: perfSource.frames, posedJoints: perfSource.posedJoints });
const runs = [];
for (let run = 0; run < 5; run += 1) {
	const started = process.hrtime.bigint();
	hml22ToCskel27Motion({ positions: perfInput, fps: 20 });
	runs.push(Number(process.hrtime.bigint() - started) / 1e6);
}
const best = Math.min(...runs);
console.log(`\n  360-frame convert, 5 runs (ms): ${runs.map((r) => r.toFixed(1)).join(", ")}`);
assert.ok(best < 500, `360 frames must convert in well under a second, best run was ${best.toFixed(1)} ms`);
pass(`360 frames convert in ${best.toFixed(1)} ms`);

console.log("OK verify-projflow-cskel27");
