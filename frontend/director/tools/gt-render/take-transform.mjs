/**
 * Scene transform of a cskel27 take for the renderer's --transform (#431),
 * with the Studio's sceneCalibration semantics (src/App.jsx loadMotion):
 *
 *   scale, offsetY  applied to the take's arrays (applyMotionCalibration),
 *                   exactly as the Studio's playback calibration does;
 *   yawDeg          rotation about +Y through the take's frame-0 anchor. The
 *                   Studio puts it on the Character group; here it is baked
 *                   into the take (joints rotated by applyMotionCalibration,
 *                   plus the root's local rotation, which that pass leaves
 *                   alone), which is the same rigid rotation because playback
 *                   subtracts the frame-0 root XZ before placing the rig;
 *   offsetX/offsetZ scene metres added after the anchor. Playback anchors
 *                   frame 0 on the subject, so an offset baked into the take
 *                   would be cancelled; the renderer instead moves the camera
 *                   by the opposite amount (identical character pixels) and
 *                   adds the offset to every reported joint.
 */
import { applyMotionCalibration, normalizeMotionCalibration } from "../../src/ardy/motion-calibration.js";

const KEYS = new Set(["scale", "yawDeg", "offsetX", "offsetY", "offsetZ"]);

/** Parse and normalise a --transform JSON object; unknown keys are refused. */
export function parseTransform(value) {
	const raw = typeof value === "string" ? JSON.parse(value) : value;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("transform must be a JSON object");
	for (const [key, entry] of Object.entries(raw)) {
		if (!KEYS.has(key)) throw new Error(`transform: unknown key ${key} (allowed: ${[...KEYS].join(", ")})`);
		if (!Number.isFinite(Number(entry))) throw new Error(`transform: ${key} must be a finite number`);
	}
	const normalized = normalizeMotionCalibration(raw);
	for (const key of Object.keys(raw)) {
		const given = Number(raw[key]);
		// normalizeMotionCalibration clamps silently; a scorer must not.
		if (key !== "yawDeg" && Math.abs(normalized[key] - given) > 1e-12) throw new Error(`transform: ${key} ${given} is outside the Studio calibration range`);
	}
	return normalized;
}

export function isIdentityTransform(t) {
	return !t || (t.scale === 1 && t.yawDeg === 0 && t.offsetX === 0 && t.offsetY === 0 && t.offsetZ === 0);
}

/**
 * Bake scale, offsetY and yaw of `transform` into a decoded take
 * ({ frames, rotMats, rootPos, posedJoints, ... }, src/ardy/npz.js). Returns
 * the new take and the scene offset the caller still has to apply.
 */
export function transformTake(motion, transform) {
	const { motion: moved } = applyMotionCalibration(motion, { ...transform, offsetX: 0, offsetZ: 0 });
	const rotMats = Float32Array.from(motion.rotMats);
	if (transform.yawDeg !== 0) {
		const a = (transform.yawDeg * Math.PI) / 180;
		const c = Math.cos(a);
		const s = Math.sin(a);
		// Ry with applyMotionCalibration's sign: x' = c x + s z, z' = -s x + c z.
		const Ry = [c, 0, s, 0, 1, 0, -s, 0, c];
		const stride = rotMats.length / motion.frames;
		for (let f = 0; f < motion.frames; f += 1) {
			const o = f * stride; // joint 0 (Hips) is the root: local == global
			const m = Array.from(rotMats.subarray(o, o + 9));
			for (let r = 0; r < 3; r += 1) {
				for (let col = 0; col < 3; col += 1) {
					rotMats[o + r * 3 + col] = Ry[r * 3] * m[col] + Ry[r * 3 + 1] * m[3 + col] + Ry[r * 3 + 2] * m[6 + col];
				}
			}
		}
	}
	return {
		motion: { ...moved, rotMats, rootPos: Float32Array.from(moved.rootPos), posedJoints: Float32Array.from(moved.posedJoints) },
		sceneOffset: { x: transform.offsetX, y: 0, z: transform.offsetZ },
	};
}

/** The npz members the Studio decoder reads, for tools/ardy/npz.mjs writeNpz. */
export function takeToNpzMembers(motion) {
	const joints = motion.posedJoints.length / (motion.frames * 3);
	const members = {
		local_rot_mats: { data: Float32Array.from(motion.rotMats), shape: [motion.frames, joints, 3, 3] },
		root_positions: { data: Float32Array.from(motion.rootPos), shape: [motion.frames, 3] },
		posed_joints: { data: Float32Array.from(motion.posedJoints), shape: [motion.frames, joints, 3] },
		fps: { data: Int32Array.of(motion.fps), shape: [] },
	};
	if (motion.personScale !== undefined && motion.personScale !== 1) members.person_scale = { data: Float32Array.of(motion.personScale), shape: [] };
	if (motion.boneScale) members.bone_scale = { data: Float32Array.from(motion.boneScale), shape: [motion.boneScale.length] };
	return members;
}
