// The ARDY pose exporter's quaternion math, tested in plain Node (issue #61).
// A fake minimal Object3D/Bone tree stands in for three.js: the exporter only
// reads `isBone`, `name`, `quaternion {x,y,z,w}`, and `traverse`, so the rig
// contract is small enough to fake without importing three.js.
import { buildArdyPose } from "../../src/ardy/export.js";
import { POSE_BONES } from "../../src/poses.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};

const Q = (x, y, z, w) => ({ x, y, z, w });
const IDENTITY = Q(0, 0, 0, 1);
// 90° about Y: (0, sin45, 0, cos45)
const ROT_Y90 = Q(0, Math.SQRT1_2, 0, Math.SQRT1_2);
// 90° about X
const ROT_X90 = Q(Math.SQRT1_2, 0, 0, Math.SQRT1_2);

class FakeBone {
	constructor(name, quaternion) {
		this.isBone = true;
		this.name = name;
		this.quaternion = quaternion;
		this.children = [];
		this.userData = {};
	}
	traverse(fn) {
		fn(this);
		for (const child of this.children) child.traverse(fn);
	}
}

/** Build a rig where every pose bone starts at identity rest. */
function makeRig(overrides = {}) {
	const root = new FakeBone("Root", IDENTITY);
	for (const entry of POSE_BONES) {
		root.children.push(new FakeBone(entry.bone, overrides[entry.id] ?? IDENTITY));
	}
	return root;
}

/** Prime every bone's rest at identity (restOf's WeakMap fallback would
 * otherwise capture the CURRENT pose, making rest === current). */
function primeIdentityRest(rig) {
	const bind = new Map();
	rig.traverse((b) => { if (b.isBone) bind.set(b, { ...IDENTITY }); });
	rig.userData.poseBind = bind;
}

const cam = { position: { x: 1, y: 1.6, z: 3 } };
const camRef = { current: cam };
const look = { current: { yaw: 0, pitch: 0 } };
const base = { rig: null, camRef, look, fovDeg: 45, slate: "S1 · T1", rigName: "y-bot-tpose" };

// identity rest + identity current -> identity basis [w=1, xyz=0]
{
	const rig = makeRig();
	const pose = buildArdyPose({ ...base, rig });
	ok("identity rest and current yields identity basis", (() => {
		for (const entry of POSE_BONES) {
			const wire = entry.bone.replace(/^mixamorig/i, "");
			const [w, x, y, z] = pose.bones[wire];
			if (Math.abs(w - 1) > 1e-9 || Math.abs(x) > 1e-9 || Math.abs(y) > 1e-9 || Math.abs(z) > 1e-9) return false;
		}
		return true;
	})());
}
// rest=identity, current=ROT_Y90 -> basis == ROT_Y90
{
	const rig = makeRig({ spine: ROT_Y90 });
	primeIdentityRest(rig);
	const pose = buildArdyPose({ ...base, rig });
	const [w, x, y, z] = pose.bones.Spine;
	ok("current rotation passes through as basis when rest is identity",
		Math.abs(w - ROT_Y90.w) < 1e-9 && Math.abs(y - ROT_Y90.y) < 1e-9 && Math.abs(x) < 1e-9 && Math.abs(z) < 1e-9,
		JSON.stringify(pose.bones.Spine));
}
// rest=ROT_Y90, current=ROT_Y90*ROT_X90 (Hamilton) -> basis == ROT_X90
{
	// Hamilton qMultiply(a,b) as in export.js
	const mul = (a, b) => Q(
		a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	);
	const rig = makeRig({ spine: mul(ROT_Y90, ROT_X90) });
	// prime the rest snapshot: every bone at identity, Spine at ROT_Y90 —
	// so rest^-1 * current recovers exactly the applied ROT_X90 delta
	primeIdentityRest(rig);
	const spine = rig.children.find((b) => b.name === POSE_BONES.find((e) => e.id === "spine").bone);
	rig.userData.poseBind.set(spine, { ...ROT_Y90 });
	const pose = buildArdyPose({ ...base, rig });
	const [w, x, y, z] = pose.bones.Spine;
	ok("basis = rest^-1 * current recovers the applied delta",
		Math.abs(w - ROT_X90.w) < 1e-9 && Math.abs(x - ROT_X90.x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9,
		JSON.stringify(pose.bones.Spine));
}
// wire key order is [w,x,y,z]
{
	const rig = makeRig({ hips: ROT_Y90 });
	primeIdentityRest(rig);
	const pose = buildArdyPose({ ...base, rig });
	ok("wire order is w-first", Math.abs(pose.bones.Hips[0] - ROT_Y90.w) < 1e-9, JSON.stringify(pose.bones.Hips));
}
// every basis is unit length
{
	const rig = makeRig({ head: Q(0.1, 0.2, 0.3, 0.9) /* unnormalized on purpose */ });
	primeIdentityRest(rig);
	const pose = buildArdyPose({ ...base, rig });
	const [w, x, y, z] = pose.bones.Head;
	const len = Math.hypot(w, x, y, z);
	ok("non-unit input is normalized to unit length", Math.abs(len - 1) < 1e-9, String(len));
}
// missing joints throw with the names
{
	const rig = makeRig();
	rig.children = rig.children.filter((b) => b.name !== POSE_BONES.find((e) => e.id === "head").bone);
	let threw = null;
	try { buildArdyPose({ ...base, rig }); } catch (error) { threw = error.message; }
	ok("a rig missing joints throws with the joint names", threw?.includes("head") && threw.includes("missing joints"), String(threw));
}
// camera block: position + look_at + fov radians
{
	const rig = makeRig();
	const pose = buildArdyPose({ ...base, rig });
	ok("camera position is the camera's", JSON.stringify(pose.camera.position) === "[1,1.6,3]");
	ok("look_at is position + forward (yaw0/pitch0 => -z)", (() => {
		const [x, y, z] = pose.camera.look_at;
		return x === 1 && y === 1.6 && z < 3;
	})(), JSON.stringify(pose.camera.look_at));
	ok("fov is radians", Math.abs(pose.camera.vertical_fov_radians - (45 * Math.PI) / 180) < 1e-12);
}
// non-finite quats throw
{
	const rig = makeRig({ spine: Q(NaN, 0, 0, 1) });
	let threw = null;
	try { buildArdyPose({ ...base, rig }); } catch (error) { threw = error.message; }
	ok("non-finite quaternion throws loudly", threw?.includes("non-finite"), String(threw));
}
// duplicate nested skinned bone: first depth-first match wins
{
	const rig = makeRig();
	const hipsName = POSE_BONES.find((e) => e.id === "hips").bone;
	const outer = rig.children.find((b) => b.name === hipsName);
	primeIdentityRest(rig); // capture rest BEFORE posing
	outer.quaternion = ROT_Y90;
	outer.children.push(new FakeBone(hipsName, IDENTITY)); // nested identity copy
	const pose = buildArdyPose({ ...base, rig });
	ok("first depth-first match wins over the nested identity copy",
		Math.abs(pose.bones.Hips[0] - ROT_Y90.w) < 1e-9, JSON.stringify(pose.bones.Hips));
}
// schema + root passthrough
{
	const rig = makeRig();
	const pose = buildArdyPose({ ...base, rig, root: [1, 0, -2] });
	ok("schema is cozyclay.pose.v1", pose.schema === "cozyclay.pose.v1");
	ok("root passes through", JSON.stringify(pose.root) === "[1,0,-2]");
}

console.log(failures === 0 ? "all pose-export math checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
