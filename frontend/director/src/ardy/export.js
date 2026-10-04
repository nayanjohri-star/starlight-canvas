/**
 * Live-rig -> CozyClayPoseV1 export for the ARDY pose bridge.
 *
 * The exported bones are DELTAS, not absolute rotations: per bone
 * `basis = rest^-1 * current`, the same "basis" concept Blender stores in
 * pose_bone.matrix_basis (current = rest * basis). x-bot and y-bot bake
 * different non-zero bind rotations, so absolute values would not transfer
 * between rigs; a delta is rig-independent.
 *
 * Quaternions are emitted w-first [w, x, y, z]: three.js stores x, y, z, w
 * and CozyClay's motion_constraints (authoritative for the ARDY side) is
 * w-first, so values are reordered at this boundary. The camera block is
 * ARDY Y-up, which is also three.js Y-up, so no axis conversion is needed.
 *
 * Every quaternion is normalized; non-finite or missing data throws instead
 * of producing a corrupt JSON blob. The rest quaternions come from the rig's
 * `userData.poseBind` snapshot (primed by PoseHandles, see posestudio.jsx),
 * falling back to a lazy capture — the same resolution chain poses.js uses.
 */

import { POSE_BONES, normalizeBoneName } from "../poses.js";

// yaw/pitch -> unit forward vector for a YXZ-ordered camera. Re-stated as
// pure math (mirrors forwardFrom() in controls.jsx) so this module stays
// importable from plain Node for the math test suite — a JSX import here
// was the reason the exporter could not be tested (issue #61).
function forwardFrom(yaw, pitch) {
	const cp = Math.cos(pitch);
	return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Wire key for a POSE_BONES entry: the Mixamo name without the `mixamorig`
 * prefix, which is exactly the cskel27 joint name ("mixamorigLeftArm" ->
 * "LeftArm"). */
function wireBoneName(entry) {
	return entry.bone.replace(/^mixamorig/i, "");
}

/** Same normalised-name match rule as poses.js/posestudio.jsx: equal, or one
 * is a suffix of the other, so `mixamorig:LeftArm`, `mixamorigLeftArm` and
 * `LeftArm` all hit. */
function boneMatches(boneName, entry) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(entry.bone);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

/** Per-root fallback rest snapshot, used only when PoseHandles never primed
 * `root.userData.poseBind`; mirrors the bindOf() fallback in poses.js. */
const restFallback = new WeakMap();

function restOf(root) {
	const primed = root.userData && root.userData.poseBind;
	if (primed) return primed;
	let map = restFallback.get(root);
	if (!map) {
		map = new Map();
		root.traverse((object) => {
			if (object.isBone) {
				const q = object.quaternion;
				map.set(object, { x: q.x, y: q.y, z: q.z, w: q.w });
			}
		});
		restFallback.set(root, map);
	}
	return map;
}

/** Normalize and reject non-finite or zero-length quaternions loudly. */
function normalizeChecked(q, label) {
	const parts = [q.x, q.y, q.z, q.w];
	if (!parts.every(Number.isFinite)) {
		throw new Error(`buildArdyPose: non-finite quaternion for ${label}`);
	}
	const len = Math.hypot(parts[0], parts[1], parts[2], parts[3]);
	if (len < 1e-12) {
		throw new Error(`buildArdyPose: zero-length quaternion for ${label}`);
	}
	return { x: parts[0] / len, y: parts[1] / len, z: parts[2] / len, w: parts[3] / len };
}

/** Conjugate; valid as the inverse because inputs are normalized unit quats. */
function qInverse(q) {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Hamilton product a * b, same convention as poses.js qMultiply. */
function qMultiply(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

/**
 * Build a CozyClayPoseV1 JSON object for the posed character in `rig`.
 * `rig` is the live three.js Object3D tree (the rigA/rigB model handed to
 * App via onRig), `camRef` the shot camera ref, `look` the `{ yaw, pitch }`
 * ref, `fovDeg` the vertical FOV in degrees, `slate` the slate string, and
 * `rigName` the wire `source.rig` value ("x-bot-tpose").
 */
export function buildArdyPose({ rig, camRef, look, fovDeg, slate, rigName, root }) {
	if (!rig) throw new Error("buildArdyPose: rig is required");
	const cam = camRef && camRef.current;
	if (!cam) throw new Error("buildArdyPose: camRef.current is required");
	if (!look || !look.current) throw new Error("buildArdyPose: look is required");
	if (typeof slate !== "string" || !slate) throw new Error("buildArdyPose: slate must be a non-empty string");
	if (!Number.isFinite(fovDeg)) throw new Error("buildArdyPose: fovDeg must be a finite number");
	if (root !== undefined && (!Array.isArray(root) || root.length !== 3 || !root.every(Number.isFinite))) {
		throw new Error("buildArdyPose: root must be [x, y, z] finite metres when present");
	}

	const rest = restOf(rig);
	const bones = {};
	const found = new Set();

	rig.traverse((object) => {
		if (!object.isBone) return;
		for (const entry of POSE_BONES) {
			if (found.has(entry.id) || !boneMatches(object.name, entry)) continue;
			// First depth-first match is the control bone; Mixamo FBX exports
			// nest an identity "skinned" copy of each bone beneath it (see
			// poses.js), which would read back as an identity delta if it won.
			found.add(entry.id);
			const bind = rest.get(object);
			if (!bind) {
				throw new Error(`buildArdyPose: no rest quaternion for ${entry.id}`);
			}
			const current = normalizeChecked(object.quaternion, `${entry.id} (current)`);
			const restQ = normalizeChecked(bind, `${entry.id} (rest)`);
			// Blender basis: current = rest * basis  =>  basis = rest^-1 * current.
			const basis = normalizeChecked(qMultiply(qInverse(restQ), current), `${entry.id} (basis)`);
			bones[wireBoneName(entry)] = [basis.w, basis.x, basis.y, basis.z];
		}
	});

	if (found.size !== POSE_BONES.length) {
		const missing = POSE_BONES.filter((entry) => !found.has(entry.id)).map((entry) => entry.id);
		throw new Error(`buildArdyPose: rig is missing joints: ${missing.join(", ")}`);
	}

	const position = cam.position;
	const forward = forwardFrom(look.current.yaw, look.current.pitch);
	const camera = {
		position: [position.x, position.y, position.z],
		look_at: [position.x + forward.x, position.y + forward.y, position.z + forward.z],
		up: [0, 1, 0],
		vertical_fov_radians: (fovDeg * Math.PI) / 180,
	};
	for (const value of [...camera.position, ...camera.look_at, camera.vertical_fov_radians]) {
		if (!Number.isFinite(value)) throw new Error("buildArdyPose: non-finite camera value");
	}

	return {
		schema: "cozyclay.pose.v1",
		created_ms: Date.now(),
		source: { app: "cozyclay", rig: typeof rigName === "string" && rigName ? rigName : "unknown" },
		...(root ? { root: root.slice() } : {}),
		bones,
		camera,
		slate,
	};
}
