import assert from "node:assert/strict";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { buildFullBodyConstraints } from "../tools/kimodo/pose-constraints.mjs";
import {
	EFFECTOR_TRACKS,
	EFFECTOR_TYPES,
	buildEffectorConstraints,
	effectorTypeForTrack,
} from "../tools/kimodo/effector-constraints.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
function rotAxis(axis, angle) {
	const [x, y, z] = axis;
	const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

// Same fixture shape verify-kimodo-pose.mjs uses: 27 identity locals and 27
// descending joint positions, so the pose is valid and the grounding has
// something real to subtract.
function pose(overrides = {}) {
	const local = CSKEL27_JOINTS.map(() => IDENTITY.map((r) => r.slice()));
	const posed = CSKEL27_JOINTS.map((_, i) => [0, 1 - i * 0.01, 0]);
	return { local_rot_mats: local, posed_joints: posed, ...overrides };
}

const OPTS = { genFrames: 120 };
const POSES = [{ frame: 40, pose: pose() }];

// ---- the track -> effector table ----------------------------------------
// This table is the whole contract with the wiring agent: planEditConstraints
// asks effectorTypeForTrack whether an edit can be scoped at all. A mid-joint
// handle (elbow/knee) edits bones INSIDE a chain, so it rides that chain's
// effector — mapping leftElbow to anything but left-hand would scope an arm
// edit onto the wrong limb.
{
	assert.equal(effectorTypeForTrack("leftHand"), "left-hand");
	assert.equal(effectorTypeForTrack("rightHand"), "right-hand");
	assert.equal(effectorTypeForTrack("leftFoot"), "left-foot");
	assert.equal(effectorTypeForTrack("rightFoot"), "right-foot");
	assert.equal(effectorTypeForTrack("leftElbow"), "left-hand");
	assert.equal(effectorTypeForTrack("rightElbow"), "right-hand");
	assert.equal(effectorTypeForTrack("leftKnee"), "left-foot");
	assert.equal(effectorTypeForTrack("rightKnee"), "right-foot");
	// FK tracks have no effector; null, never a fullbody fallback.
	for (const track of ["head", "neck", "hips", "spine", "chest", "leftShoulder", "rightShoulder"]) {
		assert.equal(effectorTypeForTrack(track), null, `${track} must have no effector`);
	}
	// total and non-throwing: it is used as a predicate
	assert.equal(effectorTypeForTrack("nonsense"), null);
	assert.equal(effectorTypeForTrack(undefined), null);
	assert.equal(effectorTypeForTrack("constructor"), null, "prototype keys must not leak through");
	// the exported table agrees with the function and only names real types
	for (const [track, type] of Object.entries(EFFECTOR_TRACKS)) {
		assert.equal(effectorTypeForTrack(track), type);
		assert.ok(EFFECTOR_TYPES.includes(type), `${type} is not a Kimodo effector type`);
	}
	pass("track -> effector map covers both hands, both feet and their mid-joints");
}

// ---- a single hand edit emits ONE shorthand entry -------------------------
// The shorthand type is load-bearing: kimodo/postprocess.py masks by
// constraint.name against a closed list ("fullbody"/"left-hand"/... ) and has NO
// branch for the generic "end-effector", so a generic type would be invisible to
// the IK cleanup pass and the pinned hand could be slid back out.
{
	const out = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand"] });
	assert.equal(out.length, 1, "one edited chain is one entry");
	assert.equal(out[0].type, "left-hand");
	assert.notEqual(out[0].type, "end-effector", "the generic type is ignored by postprocess");
	assert.deepEqual(Object.keys(out[0]).sort(), ["frame_indices", "local_joints_rot", "root_positions", "type"]);
	pass("a single hand track emits exactly one left-hand entry");
}

// ---- the payload IS the fullbody payload ---------------------------------
// EndEffectorConstraintSet.from_dict reads the same JSON fields as fullbody and
// runs the same whole-body FK; only the columns it then constrains differ. So
// the numbers must come from round 1's builder untouched — that is what keeps
// the cskel27 -> somaskel77 mapping and the lowest-joint grounding (measured
// 0.00 deg on the box) identical rather than reimplemented here.
{
	const poses = [{ frame: 10, pose: pose() }, { frame: 50, pose: pose() }];
	const full = buildFullBodyConstraints(poses, OPTS);
	const ee = buildEffectorConstraints(poses, { ...OPTS, tracks: ["rightFoot"] });
	assert.deepEqual(ee[0].frame_indices, full[0].frame_indices);
	assert.deepEqual(ee[0].local_joints_rot, full[0].local_joints_rot);
	assert.deepEqual(ee[0].root_positions, full[0].root_positions);
	// shape sanity, so a silently-empty payload cannot pass the deepEquals above
	assert.deepEqual(ee[0].frame_indices, [10, 50]);
	assert.equal(ee[0].local_joints_rot.length, 2);
	assert.equal(ee[0].local_joints_rot[0].length, 77, "rotations stay on somaskel77");
	assert.equal(ee[0].root_positions[0].length, 3);
	// and the ONLY difference from fullbody is the type
	assert.equal(full[0].type, "fullbody");
	assert.equal(ee[0].type, "right-foot");
	pass("an effector entry carries buildFullBodyConstraints' payload unchanged");
}

// ---- two chains share ONE payload, by reference ---------------------------
// Kimodo derives each effector's targets from the same FK of the same pose, so
// copying would only cost memory. Asserted as identity, not equality, so a
// future refactor that starts deep-copying has to come here and say why.
{
	const out = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand", "rightFoot"] });
	assert.equal(out.length, 2, "two edited chains are two entries");
	assert.deepEqual(out.map((e) => e.type), ["left-hand", "right-foot"], "entries follow track order");
	assert.equal(new Set(out.map((e) => e.type)).size, 2, "types must be distinct");
	assert.ok(out[0].frame_indices === out[1].frame_indices, "frame_indices must be the SAME array");
	assert.ok(out[0].local_joints_rot === out[1].local_joints_rot, "local_joints_rot must be the SAME array");
	assert.ok(out[0].root_positions === out[1].root_positions, "root_positions must be the SAME array");
	pass("two effectors emit two entries over one shared payload");
}

// ---- mid-joint tracks resolve to their chain's effector -------------------
{
	const elbow = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftElbow"] });
	assert.deepEqual(elbow.map((e) => e.type), ["left-hand"]);
	const knee = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["rightKnee"] });
	assert.deepEqual(knee.map((e) => e.type), ["right-foot"]);
	// an elbow edit and a hand edit produce the identical constraint
	assert.deepEqual(elbow, buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand"] }));
	pass("elbow/knee edits are constrained through their chain's effector");
}

// ---- overlapping tracks collapse -----------------------------------------
// Dragging the hand and then its elbow is ONE arm edit. Two left-hand entries
// would not pin it harder, just make Kimodo apply the same target twice.
{
	const out = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand", "leftElbow"] });
	assert.equal(out.length, 1, `leftHand + leftElbow is one arm, got ${out.length} entries`);
	assert.equal(out[0].type, "left-hand");
	// order of first appearance survives dedup
	const mixed = buildEffectorConstraints(POSES, {
		...OPTS,
		tracks: ["rightKnee", "leftHand", "rightFoot", "leftElbow"],
	});
	assert.deepEqual(mixed.map((e) => e.type), ["right-foot", "left-hand"]);
	pass("duplicate and overlapping tracks collapse to one entry per chain");
}

// ---- a non-effector track is refused, never widened -----------------------
// Falling back to fullbody here would silently re-freeze the whole body — the
// exact behaviour C5 exists to remove. The caller owns that decision.
{
	for (const track of ["head", "hips", "spine", "chest", "neck", "leftShoulder"]) {
		assert.throws(
			() => buildEffectorConstraints(POSES, { ...OPTS, tracks: [track] }),
			new RegExp(`track ${track} has no effector constraint — use fullbody`),
			`${track} must be refused by name`
		);
	}
	// one bad track poisons the whole call even alongside good ones: a partial
	// answer would drop the head edit on the floor without telling anyone.
	assert.throws(
		() => buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand", "head"] }),
		/track head has no effector constraint — use fullbody/
	);
	// and scope is checked before pose work, so it reports even with no poses
	assert.throws(() => buildEffectorConstraints([], { ...OPTS, tracks: ["head"] }), /no effector constraint/);
	pass("a track with no effector throws and is never widened to fullbody");
}

// ---- missing tracks ------------------------------------------------------
{
	assert.throws(() => buildEffectorConstraints(POSES, OPTS), /tracks must be a non-empty array/);
	assert.throws(() => buildEffectorConstraints(POSES, { ...OPTS, tracks: [] }), /tracks must be a non-empty array/);
	assert.throws(() => buildEffectorConstraints(POSES, { ...OPTS, tracks: "leftHand" }), /tracks must be a non-empty array/);
	pass("an edit with no tracks is refused rather than guessed at");
}

// ---- empty poses mirror buildFullBodyConstraints --------------------------
{
	assert.deepEqual(buildFullBodyConstraints([], OPTS), []);
	assert.deepEqual(buildEffectorConstraints([], { ...OPTS, tracks: ["leftHand"] }), []);
	assert.deepEqual(buildEffectorConstraints(undefined, { ...OPTS, tracks: ["leftHand"] }), []);
	pass("no poses produces no constraints, same as the fullbody builder");
}

// ---- validation is NOT reimplemented, it propagates -----------------------
// There is exactly one pose validator in the tree. If this module ever grew its
// own, the two would drift and an edit could be accepted on one path and refused
// on the other — so the errors must still arrive under the fullbody builder's
// own name.
{
	const tracks = ["leftHand"];
	const bad = [{ frame: 999, pose: pose() }];
	assert.throws(
		() => buildEffectorConstraints(bad, { ...OPTS, tracks }),
		/^Error: buildFullBodyConstraints: /,
		"an out-of-range frame must surface the fullbody builder's error"
	);
	const skewed = pose();
	skewed.local_rot_mats[3] = [[2, 0, 0], [0, 1, 0], [0, 0, 1]];
	assert.throws(
		() => buildEffectorConstraints([{ frame: 5, pose: skewed }], { ...OPTS, tracks }),
		/^Error: buildFullBodyConstraints: .*(rotation|determinant)/,
		"a non-rotation must surface the fullbody builder's error"
	);
	assert.throws(
		() => buildEffectorConstraints([{ frame: 5, pose: { local_rot_mats: [], posed_joints: [] } }], { ...OPTS, tracks }),
		/^Error: buildFullBodyConstraints: .*27/
	);
	assert.throws(
		() => buildEffectorConstraints(POSES, { genFrames: 0, tracks }),
		/^Error: buildFullBodyConstraints: genFrames/
	);
	pass("malformed poses propagate buildFullBodyConstraints' own errors");
}

// ---- authored rotations survive the hand-off -----------------------------
// The payload is passed through, not rebuilt, so a real authored joint must come
// out the far side non-zero — otherwise every deepEqual above would be comparing
// two equally empty poses.
{
	const p = pose();
	p.local_rot_mats[CSKEL27_JOINTS.indexOf("LeftUpLeg")] = rotAxis([1, 0, 0], Math.PI / 3);
	p.posed_joints[CSKEL27_JOINTS.indexOf("Hips")] = [1.5, 1.2, -2.5];
	const out = buildEffectorConstraints([{ frame: 12, pose: p }], { ...OPTS, tracks: ["leftFoot"] });
	const rots = out[0].local_joints_rot[0];
	assert.ok(rots.some((r) => Math.hypot(...r) > 0.5), "the authored rotation must reach the entry");
	const [x, y, z] = out[0].root_positions[0];
	assert.ok(Math.abs(x - 1.5) < 1e-6 && Math.abs(z + 2.5) < 1e-6, "root XZ carries through");
	// grounded on the pose's own lowest joint (1 - 26*0.01 = 0.74), not raw hips
	assert.ok(Math.abs(y - (1.2 - 0.74)) < 1e-6, `hips must be grounded, got ${y}`);
	pass("authored rotations and the grounded root survive into the effector entry");
}

// ---- JSON round trip in Kimodo's schema ---------------------------------
// The shared arrays must not confuse the serializer, and no key may appear that
// EndEffectorConstraintSet.from_dict does not read. Note `joint_names` is absent
// on purpose: from_dict only demands it for the generic "end-effector" class,
// and the shorthands hard-code their own.
{
	const out = buildEffectorConstraints(POSES, { ...OPTS, tracks: ["leftHand", "rightFoot"] });
	const round = JSON.parse(JSON.stringify(out));
	assert.deepEqual(round, out, "sharing arrays must not change what is serialized");
	assert.deepEqual(round[0].local_joints_rot, round[1].local_joints_rot, "both entries serialize the same payload");
	for (const entry of round) {
		for (const key of Object.keys(entry)) {
			assert.ok(
				["type", "frame_indices", "local_joints_rot", "root_positions", "smooth_root_2d"].includes(key),
				`unexpected key ${key} would be rejected by kimodo_gen`
			);
		}
		assert.ok(!("joint_names" in entry), "the shorthand types hard-code their joint_names");
		assert.ok(!("smooth_root_2d" in entry), "smooth_root_2d is omitted; Kimodo falls back to the FK'd pelvis XZ");
	}
	pass("emitted constraints match Kimodo's end-effector schema and round trip");
}

console.log("OK verify-kimodo-effector");
