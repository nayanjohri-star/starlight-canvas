import assert from "node:assert/strict";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { matMul, matTranspose } from "../src/ardy/convert.js";
import { SOMA77_JOINTS } from "../tools/kimodo/soma77-to-cskel27.mjs";
import {
	FULLBODY_TYPE,
	axisAngleFromMatrix,
	buildFullBodyConstraints,
} from "../tools/kimodo/pose-constraints.mjs";

function pass(label) { console.log(`PASS ${label}`); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
const norm = ([x, y, z]) => {
	const n = Math.hypot(x, y, z);
	return [x / n, y / n, z / n];
};

// ---- axis-angle round trip ------------------------------------------------
// Kimodo runs axis_angle_to_matrix on whatever we emit, so a wrong convention
// here silently rotates every authored joint. Round-tripping through the same
// matrix is the only check that catches a sign or transpose slip.
{
	const cases = [
		["identity", IDENTITY],
		["x 30deg", rotAxis([1, 0, 0], Math.PI / 6)],
		["y 90deg", rotAxis([0, 1, 0], Math.PI / 2)],
		["z -120deg", rotAxis([0, 0, 1], (-2 * Math.PI) / 3)],
		["oblique 45deg", rotAxis(norm([1, 2, -3]), Math.PI / 4)],
		// 180 degrees is the degenerate case: sin(theta)=0 so the naive
		// (m21-m12)/(2 sin) extraction divides by zero.
		["x 180deg", rotAxis([1, 0, 0], Math.PI)],
		["oblique 180deg", rotAxis(norm([1, 1, 0]), Math.PI)],
	];
	for (const [label, m] of cases) {
		const aa = axisAngleFromMatrix(m);
		assert.equal(aa.length, 3, `${label}: axis-angle must be 3 numbers`);
		assert.ok(aa.every(Number.isFinite), `${label}: axis-angle must be finite, got ${aa}`);
		// rebuild the matrix from the axis-angle and compare
		const angle = Math.hypot(...aa);
		const rebuilt = angle < 1e-12 ? IDENTITY : rotAxis(aa.map((v) => v / angle), angle);
		let worst = 0;
		for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) {
			worst = Math.max(worst, Math.abs(rebuilt[r][c] - m[r][c]));
		}
		assert.ok(worst < 1e-5, `${label}: round trip error ${worst}`);
	}
	assert.deepEqual(axisAngleFromMatrix(IDENTITY), [0, 0, 0], "identity must be exactly zero");
	pass("matrix -> axis-angle round trips, including 180 degrees and identity");
}

// ---- shape and joint order ------------------------------------------------
function pose(overrides = {}) {
	const local = CSKEL27_JOINTS.map(() => IDENTITY.map((r) => r.slice()));
	const posed = CSKEL27_JOINTS.map((_, i) => [0, 1 - i * 0.01, 0]);
	return { local_rot_mats: local, posed_joints: posed, ...overrides };
}

{
	const out = buildFullBodyConstraints([{ frame: 40, pose: pose() }], { genFrames: 120 });
	assert.equal(out.length, 1);
	const entry = out[0];
	assert.equal(entry.type, FULLBODY_TYPE);
	assert.equal(entry.type, "fullbody");
	assert.deepEqual(entry.frame_indices, [40]);
	assert.equal(entry.local_joints_rot.length, 1, "one keyframe");
	assert.equal(entry.local_joints_rot[0].length, 77, "rotations must be emitted on somaskel77");
	assert.equal(entry.local_joints_rot[0][0].length, 3, "each joint is one axis-angle triple");
	assert.equal(entry.root_positions.length, 1);
	assert.equal(entry.root_positions[0].length, 3);
	pass("a pose emits one fullbody entry shaped [T,77,3] with [T,3] roots");
}

// ---- an authored rotation lands on the right somaskel77 joint ------------
// The leg names shift between the two skeletons (cskel27 LeftUpLeg is
// somaskel77 LeftLeg), so a mapping by equal name would put a hip rotation on
// the shin. Author ONE joint and assert it arrives where it belongs.
{
	const p = pose();
	const bent = rotAxis([1, 0, 0], Math.PI / 3);
	p.local_rot_mats[CSKEL27_JOINTS.indexOf("LeftUpLeg")] = bent;
	const out = buildFullBodyConstraints([{ frame: 10, pose: p }], { genFrames: 60 });
	const rots = out[0].local_joints_rot[0];
	const thigh = rots[SOMA77_JOINTS.indexOf("LeftLeg")];   // somaskel77 thigh
	const shin = rots[SOMA77_JOINTS.indexOf("LeftShin")];   // somaskel77 shank
	assert.ok(Math.hypot(...thigh) > 0.5, `the authored thigh rotation must reach somaskel77 LeftLeg, got ${thigh}`);
	assert.ok(Math.hypot(...shin) < 1e-6, `somaskel77 LeftShin must stay unrotated, got ${shin}`);
	pass("an authored rotation lands on the correct somaskel77 joint across the leg name shift");
}

// ---- unauthored joints emit zero ----------------------------------------
{
	const out = buildFullBodyConstraints([{ frame: 5, pose: pose() }], { genFrames: 60 });
	const rots = out[0].local_joints_rot[0];
	const nonZero = rots.filter((r) => Math.hypot(...r) > 1e-9);
	assert.equal(nonZero.length, 0, `an all-identity pose must emit all-zero axis-angles, got ${nonZero.length} non-zero`);
	// fingers have no cskel27 source at all and must never be invented
	for (const name of ["LeftHandIndex1", "RightHandPinky3", "Jaw", "LeftEye"]) {
		assert.deepEqual(rots[SOMA77_JOINTS.indexOf(name)], [0, 0, 0], `${name} must stay at rest`);
	}
	pass("unauthored and unmapped joints emit zero axis-angle");
}

// ---- root position: Y is height ABOVE THE GROUND, XZ carries through -----
// Kimodo reads root_positions Y as the hip height above the floor. A CozyClay
// pose is authored in its take's own space and is NOT floor-aligned: a real
// pose off the app measured hips at 1.781 m with its lowest joint at 0.787 m,
// i.e. the whole character 79 cm in the air. Passing that through told Kimodo to
// generate a floating character, and because each motion edit re-authors a pose
// from the previous take, the drift compounded every round.
{
	const p = pose();
	// a pose standing on the floor: lowest joint at 0, hips at 0.94
	p.posed_joints = CSKEL27_JOINTS.map(() => [0, 0.5, 0]);
	p.posed_joints[CSKEL27_JOINTS.indexOf("Hips")] = [1.5, 0.94, -2.5];
	p.posed_joints[CSKEL27_JOINTS.indexOf("LeftFoot")] = [0, 0, 0];
	const grounded = buildFullBodyConstraints([{ frame: 30, pose: p }], { genFrames: 120 });
	const [x, y, z] = grounded[0].root_positions[0];
	assert.ok(near(y, 0.94, 1e-6), `a grounded pose keeps its hip height, got ${y}`);
	assert.ok(near(x, 1.5, 1e-6) && near(z, -2.5, 1e-6), `root XZ must carry through, got ${x},${z}`);

	// the SAME pose lifted 0.787 m into the air must produce the SAME constraint
	const floating = pose();
	floating.posed_joints = p.posed_joints.map(([px, py, pz]) => [px, py + 0.787, pz]);
	const lifted = buildFullBodyConstraints([{ frame: 30, pose: floating }], { genFrames: 120 });
	assert.ok(
		near(lifted[0].root_positions[0][1], 0.94, 1e-5),
		`a floating pose must be grounded before it is constrained, got ${lifted[0].root_positions[0][1]}`
	);
	assert.ok(near(lifted[0].root_positions[0][0], 1.5, 1e-6), "grounding must not move XZ");
	pass("a pose is grounded before it becomes a constraint, so float cannot compound");
}

// ---- several poses share one entry, ascending ---------------------------
{
	const out = buildFullBodyConstraints(
		[
			{ frame: 10, pose: pose() },
			{ frame: 50, pose: pose() },
		],
		{ genFrames: 120 }
	);
	assert.equal(out.length, 1, "poses collapse into a single fullbody entry");
	assert.deepEqual(out[0].frame_indices, [10, 50]);
	assert.equal(out[0].local_joints_rot.length, 2);
	assert.equal(out[0].root_positions.length, 2);
	pass("multiple pinned poses share one fullbody entry, index-aligned");
}

// ---- empty input ---------------------------------------------------------
{
	assert.deepEqual(buildFullBodyConstraints([], { genFrames: 60 }), []);
	assert.deepEqual(buildFullBodyConstraints(undefined, { genFrames: 60 }), []);
	pass("no poses produces no constraints");
}

// ---- malformed input is refused by name ---------------------------------
{
	const opts = { genFrames: 60 };
	assert.throws(() => buildFullBodyConstraints([{ frame: -1, pose: pose() }], opts), /frame/i);
	assert.throws(() => buildFullBodyConstraints([{ frame: 5, pose: { local_rot_mats: [], posed_joints: [] } }], opts), /27/);
	// a non-orthonormal matrix is corrupt data, not a rotation
	const skewed = pose();
	skewed.local_rot_mats[3] = [[2, 0, 0], [0, 1, 0], [0, 0, 1]];
	assert.throws(() => buildFullBodyConstraints([{ frame: 5, pose: skewed }], opts), /rotation|orthonormal|determinant/i);
	// a frame past the clip cannot be constrained
	assert.throws(() => buildFullBodyConstraints([{ frame: 999, pose: pose() }], opts), /frame/i);
	pass("bad frames, wrong joint counts and non-rotations are refused by name");
}

// ---- JSON round trip in Kimodo's schema ---------------------------------
{
	const out = buildFullBodyConstraints([{ frame: 20, pose: pose() }], { genFrames: 60 });
	const round = JSON.parse(JSON.stringify(out));
	assert.deepEqual(round, out);
	for (const key of Object.keys(round[0])) {
		assert.ok(
			["type", "frame_indices", "local_joints_rot", "root_positions", "smooth_root_2d"].includes(key),
			`unexpected key ${key} would be rejected by kimodo_gen`
		);
	}
	pass("emitted constraints match Kimodo's documented fullbody schema");
}

console.log("OK verify-kimodo-pose");
