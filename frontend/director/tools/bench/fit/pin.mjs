import { matToQuat, quatToMat } from "../../../src/ardy/convert.js";
import { slerpQuat } from "../../../src/ardy/retime.js";
import { cloneMotion, readMat, regenerateJoints, smoothstep, sub, vec } from "./motion.mjs";

/** F4 consumes only two user-known poses, never a GT trajectory. The windows
 * are capped at half the clip to avoid overlapping A/B constraints. Endpoint
 * root OFFSETS ramp to zero; no interpolation toward intermediate GT roots.
 * Regenerating FK keeps the F3 character's bone lengths exactly constant. */
export function pinEndpoints(motion, [a, b], { windowSeconds = 0.5 } = {}) {
	if (!(Number.isFinite(windowSeconds) && windowSeconds > 0) || motion.frames < 2) throw new Error("pinning needs positive windowSeconds and at least two frames");
	const out = cloneMotion(motion), last = motion.frames - 1;
	const radius = Math.min(windowSeconds * motion.fps, last / 2);
	const deltaA = sub(vec(a.rootPos), vec(motion.rootPos));
	const deltaB = sub(vec(b.rootPos), vec(motion.rootPos, last * 3));
	for (let f = 0; f < motion.frames; f++) {
		const wa = 1 - smoothstep(f / radius), wb = 1 - smoothstep((last - f) / radius);
		for (let k = 0; k < 3; k++) out.rootPos[f * 3 + k] += wa * deltaA[k] + wb * deltaB[k];
		const weight = wa || wb;
		if (!weight) continue;
		const target = wa ? a : b;
		for (let j = 0; j < 27; j++) {
			const o = (f * 27 + j) * 9;
			out.rotMats.set(quatToMat(slerpQuat(matToQuat(readMat(motion.rotMats, o)), matToQuat(readMat(target.rotMats, j * 9)), weight)).flat(), o);
		}
	}
	return regenerateJoints(out);
}
