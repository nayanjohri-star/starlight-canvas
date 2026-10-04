#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COZYCLAY_BONES } from "../../src/ardy/cskel27.js";
import { canonicalCskel27Reference, poseToCskel27 } from "../../src/ardy/to-cskel27.js";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { motionArraysToNpzMembers, stitchMotionSegments, writeNpz } from "../../tools/ardy/npz.mjs";

const rest = JSON.parse(readFileSync(new URL("../../public/ardy/cskel27-rest.json", import.meta.url), "utf8"));
const bones = Object.fromEntries(COZYCLAY_BONES.map((name) => [name, [1, 0, 0, 0]]));
const pose = { schema: "cozyclay.pose.v1", bones };
const canonical = canonicalCskel27Reference();
const minY = Math.min(...canonical.posed_joints.map((joint) => joint[1]));
if (Math.abs(minY) > 1e-7) throw new Error(`canonical skeleton is not floor aligned: ${minY}`);

const explicitRoot = [1.25, 0.88, -2.5];
const rooted = poseToCskel27({ pose: { ...pose, root: explicitRoot }, rest });
for (let axis = 0; axis < 3; axis += 1) {
	if (Math.abs(rooted.posed_joints[0][axis] - explicitRoot[axis]) > 1e-7) {
		throw new Error(`explicit root axis ${axis} was not preserved`);
	}
}

const shiftedReference = {
	local_rot_mats: canonical.local_rot_mats,
	posed_joints: canonical.posed_joints.map(([x, y, z]) => [x + 4, y - 0.102, z - 3]),
};
const fromCanonical = poseToCskel27({ pose, rest });
const fromShiftedClip = poseToCskel27({ pose, rest, reference: shiftedReference });
let maxReferenceLeak = 0;
for (let joint = 0; joint < 27; joint += 1) {
	for (let axis = 0; axis < 3; axis += 1) {
		maxReferenceLeak = Math.max(maxReferenceLeak, Math.abs(fromCanonical.posed_joints[joint][axis] - fromShiftedClip.posed_joints[joint][axis]));
	}
}
if (maxReferenceLeak > 1e-6) throw new Error(`reference root leaked into pose by ${maxReferenceLeak} m`);

const identity = (frames) => {
	const values = new Float32Array(frames * 27 * 9);
	for (let frame = 0; frame < frames; frame += 1) for (let joint = 0; joint < 27; joint += 1) {
		const offset = (frame * 27 + joint) * 9;
		values[offset] = values[offset + 4] = values[offset + 8] = 1;
	}
	return values;
};
const segment = (x) => ({
	frames: 2,
	fps: 20,
	rotMats: identity(2),
	rootPos: Float32Array.of(x, 1, 0, x + 1, 1, 0),
	posedJoints: new Float32Array(2 * 27 * 3),
});
const stitched = stitchMotionSegments([segment(0), segment(2)]);
	const dir = mkdtempSync(join(tmpdir(), "cozyclay-base-free-"));
try {
	const path = join(dir, "motion.npz");
	writeNpz(path, motionArraysToNpzMembers(stitched));
	const decoded = await decodeMotionNpz(new Uint8Array(readFileSync(path)));
	if (decoded.frames !== 4 || decoded.fps !== 20 || decoded.rootPos[9] !== 3) {
		throw new Error("stitched archive did not round-trip");
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(`PASS base-free root + stitch (reference leak ${maxReferenceLeak.toExponential(1)} m)`);
