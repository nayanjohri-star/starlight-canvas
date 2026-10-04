/**
 * Cross-frame validation of the cskel27 parent table and FK, against real ARDY data.
 *
 * motion_constraints.py warns that a wrong parent "moves that error to whole npz
 * units immediately", and that its own FK reproduces the npz posed_joints to
 * ~2.8e-07. Deriving offsets and re-applying them on the SAME frame is circular,
 * so offsets come from frame 0 and are re-applied with frame 40's rotations, then
 * compared against frame 40's own posed_joints. Bone offsets are constant for a
 * clip, so only a correct parent chain can survive that.
 */
import { readFileSync } from "node:fs";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, globalRotations } from "../../src/ardy/convert.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const f0 = load("ardy-frame0.json");
const f40 = load("ardy-frame40.json");

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
	if (!cond) fail.push(label);
};

// the parent chain must be acyclic, single-rooted, and topologically ordered
let roots = 0;
let ordered = true;
CSKEL27_PARENTS.forEach((p, i) => {
	if (p === null) roots += 1;
	else if (p >= i) ordered = false;
});
ok("single root", roots === 1, `roots=${roots}`);
ok("parents precede children", ordered);
ok("27 joints", CSKEL27_JOINTS.length === 27 && CSKEL27_PARENTS.length === 27);

const offsets = deriveBoneOffsets(f0.posed_joints, f0.local_rot_mats);
const predicted = forwardKinematics(f40.local_rot_mats, offsets, f40.posed_joints[0]);

let worst = 0;
let worstJoint = "";
for (let i = 0; i < 27; i += 1) {
	const d = Math.hypot(
		predicted[i][0] - f40.posed_joints[i][0],
		predicted[i][1] - f40.posed_joints[i][1],
		predicted[i][2] - f40.posed_joints[i][2],
	);
	if (d > worst) {
		worst = d;
		worstJoint = CSKEL27_JOINTS[i];
	}
}
// float32 serialization noise is ~1e-7; a wrong parent lands in whole npz units.
ok("FK reproduces frame 40 from frame 0 offsets", worst < 1e-4, `worst=${worst.toExponential(3)} at ${worstJoint}`);

// global rotations must compose down the same chain
const g = globalRotations(f0.local_rot_mats);
ok("globalRotations shape", g.length === 27 && g[0].length === 3);
const det = (m) =>
	m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
	m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
	m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
ok("globals stay rotations", g.every((m) => Math.abs(det(m) - 1) < 1e-3));

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);
