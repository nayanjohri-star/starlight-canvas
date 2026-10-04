import assert from "node:assert/strict";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics } from "../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { retimeMotion } from "../src/ardy/retime.js";

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance = 1e-5) { return Math.abs(a - b) <= tolerance; }

const JOINTS = CSKEL27_JOINTS.length;
const SKELETON = canonicalCskel27Reference();
const OFFSETS = deriveBoneOffsets(SKELETON.posed_joints, SKELETON.local_rot_mats);

/** Synthetic clip: joint 0 yaws linearly 0.1 rad/frame, every joint's
 *  position slides linearly in X, root rides joint 0. Its posedJoints are
 *  deliberately NOT the forward kinematics of its rotations — it exercises the
 *  path for a take whose positions are the authority. */
function syntheticMotion(frames, fps) {
	const rotMats = new Float32Array(frames * JOINTS * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let f = 0; f < frames; f += 1) {
		const angle = f * 0.1;
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		for (let j = 0; j < JOINTS; j += 1) {
			const o = (f * JOINTS + j) * 9;
			if (j === 0) {
				rotMats[o] = c; rotMats[o + 2] = s;
				rotMats[o + 4] = 1;
				rotMats[o + 6] = -s; rotMats[o + 8] = c;
			} else {
				rotMats[o] = 1; rotMats[o + 4] = 1; rotMats[o + 8] = 1;
			}
			const p = (f * JOINTS + j) * 3;
			posedJoints[p] = f * 0.05 + j;
			posedJoints[p + 1] = 1;
		}
		rootPos[f * 3] = f * 0.05;
	}
	return { frames, fps, rotMats, rootPos, posedJoints };
}

/** A take shaped like a real one: the hips yaw, both knees swing, the root
 *  walks, and posedJoints are the forward kinematics of exactly that — the
 *  invariant every decoded npz arrives with. */
function posedMotion(frames, fps) {
	const rotMats = new Float32Array(frames * JOINTS * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	const hips = CSKEL27_JOINTS.indexOf("Hips");
	const knees = [CSKEL27_JOINTS.indexOf("LeftLeg"), CSKEL27_JOINTS.indexOf("RightLeg")];
	for (let f = 0; f < frames; f += 1) {
		const locals = CSKEL27_JOINTS.map(() => [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
		const yaw = f * 0.07;
		locals[hips] = [
			[Math.cos(yaw), 0, Math.sin(yaw)],
			[0, 1, 0],
			[-Math.sin(yaw), 0, Math.cos(yaw)],
		];
		knees.forEach((knee, side) => {
			const bend = 0.6 * Math.sin(f * 0.25 + side * Math.PI);
			locals[knee] = [
				[1, 0, 0],
				[0, Math.cos(bend), -Math.sin(bend)],
				[0, Math.sin(bend), Math.cos(bend)],
			];
		});
		const root = [f * 0.02, 0.95 + 0.01 * Math.sin(f * 0.25), f * 0.005];
		const positions = forwardKinematics(locals, OFFSETS, root);
		for (let j = 0; j < JOINTS; j += 1) {
			const o = (f * JOINTS + j) * 9;
			for (let r = 0; r < 3; r += 1) {
				for (let c = 0; c < 3; c += 1) rotMats[o + r * 3 + c] = locals[j][r][c];
			}
			const p = (f * JOINTS + j) * 3;
			posedJoints[p] = positions[j][0];
			posedJoints[p + 1] = positions[j][1];
			posedJoints[p + 2] = positions[j][2];
		}
		for (let axis = 0; axis < 3; axis += 1) rootPos[f * 3 + axis] = root[axis];
	}
	return { frames, fps, rotMats, rootPos, posedJoints };
}

function localsAt(motion, frame) {
	return CSKEL27_JOINTS.map((_, j) => {
		const o = (frame * JOINTS + j) * 9;
		return [
			[motion.rotMats[o], motion.rotMats[o + 1], motion.rotMats[o + 2]],
			[motion.rotMats[o + 3], motion.rotMats[o + 4], motion.rotMats[o + 5]],
			[motion.rotMats[o + 6], motion.rotMats[o + 7], motion.rotMats[o + 8]],
		];
	});
}

/** Worst |FK(rotMats, rootPos) - posedJoints| over the whole take, in metres. */
function fkResidual(motion) {
	let worst = 0;
	for (let f = 0; f < motion.frames; f += 1) {
		const positions = forwardKinematics(localsAt(motion, f), OFFSETS, [
			motion.rootPos[f * 3],
			motion.rootPos[f * 3 + 1],
			motion.rootPos[f * 3 + 2],
		]);
		for (let j = 0; j < JOINTS; j += 1) {
			const p = (f * JOINTS + j) * 3;
			worst = Math.max(worst, Math.hypot(
				positions[j][0] - motion.posedJoints[p],
				positions[j][1] - motion.posedJoints[p + 1],
				positions[j][2] - motion.posedJoints[p + 2]
			));
		}
	}
	return worst;
}

/** Widest swing of any bone's length across the take, in metres. */
function boneLengthSpread(motion) {
	let worst = 0;
	for (let j = 0; j < JOINTS; j += 1) {
		const parent = CSKEL27_PARENTS[j];
		if (parent === null) continue;
		let min = Infinity;
		let max = -Infinity;
		for (let f = 0; f < motion.frames; f += 1) {
			const a = (f * JOINTS + j) * 3;
			const b = (f * JOINTS + parent) * 3;
			const length = Math.hypot(
				motion.posedJoints[a] - motion.posedJoints[b],
				motion.posedJoints[a + 1] - motion.posedJoints[b + 1],
				motion.posedJoints[a + 2] - motion.posedJoints[b + 2]
			);
			min = Math.min(min, length);
			max = Math.max(max, length);
		}
		worst = Math.max(worst, max - min);
	}
	return worst;
}

{
	const src = syntheticMotion(80, 20); // a 4 s ARDY take
	const out = retimeMotion(src, 24);
	assert.equal(out.frames, 96); // 4 s on the 24 fps clock
	assert.equal(out.fps, 24);
	assert.ok(near(src.frames / src.fps, out.frames / out.fps)); // duration in seconds is unchanged
	pass("an 80-frame 20 fps take becomes a 96-frame 24 fps take of the same length");
}

{
	const src = syntheticMotion(80, 20);
	const out = retimeMotion(src, 24);
	for (let k = 0; k < JOINTS * 9; k += 1) assert.equal(out.rotMats[k], src.rotMats[k]);
	// Every 6th output frame lands exactly on a source frame (5:6 ratio).
	for (let k = 0; k < JOINTS * 9; k += 1) assert.ok(near(out.rotMats[6 * JOINTS * 9 + k], src.rotMats[5 * JOINTS * 9 + k]));
	pass("frame 0 and every exact-ratio frame are copies, not re-interpolations");
}

{
	const src = syntheticMotion(80, 20);
	const out = retimeMotion(src, 24);
	// Output frame f sits at source position f*5/6, clamped to the last source
	// frame at the tail; atan2 reads the yaw back wrapped to (-pi, pi].
	for (const f of [1, 7, 25, 95]) {
		const s = Math.min((f * 5) / 6, src.frames - 1);
		const o = f * JOINTS * 9;
		const angle = Math.atan2(out.rotMats[o + 2], out.rotMats[o]);
		const wrapped = Math.atan2(Math.sin(s * 0.1), Math.cos(s * 0.1));
		assert.ok(near(angle, wrapped, 1e-4), `frame ${f}: ${angle} vs ${wrapped}`);
		// This take's positions do not follow its rotations, so they lerp on the
		// same clock rather than being regenerated out from under it.
		assert.ok(near(out.posedJoints[f * JOINTS * 3], s * 0.05, 1e-5));
		assert.ok(near(out.rootPos[f * 3], s * 0.05, 1e-5));
	}
	pass("rotations slerp and the root lerps onto the exact source time");
}

{
	// The bug this guards: slerped rotations walk an arc while lerped positions
	// cut the chord, so blended frames used to hand playback a skeleton whose
	// shin had shrunk by up to 2.6 cm — a visible tremble, since playback writes
	// bone.position straight from posedJoints. Regenerating positions by FK
	// makes rigid bones a property of the output.
	const src = posedMotion(200, 60); // the worst real case: 60 fps in, 24 out
	assert.ok(fkResidual(src) < 1e-6, `source residual ${fkResidual(src)}`);
	const out = retimeMotion(src, 24);
	assert.equal(out.frames, 80);
	assert.ok(fkResidual(out) < 1e-6, `retimed residual ${fkResidual(out)} m`);
	assert.ok(boneLengthSpread(out) < 1e-6, `bone length spread ${boneLengthSpread(out)} m`);
	pass("retimed posedJoints are the FK of the retimed rotations, so every bone keeps its length");
}

{
	// 30 fps is the other clock filmed takes arrive on, and 5:4 puts most output
	// frames between source frames.
	const out = retimeMotion(posedMotion(150, 30), 24);
	assert.equal(out.frames, 120);
	assert.ok(fkResidual(out) < 1e-6);
	assert.ok(boneLengthSpread(out) < 1e-6);
	pass("a 30 fps take retimes onto a rigid 24 fps skeleton too");
}

{
	// Frames that land on a source frame were copies before and are now FK of a
	// copied rotation: the same pose to within float32 noise, because the source
	// satisfies the invariant it is regenerated from.
	const src = posedMotion(150, 30);
	const out = retimeMotion(src, 24);
	for (const [f, s] of [[0, 0], [4, 5], [40, 50], [116, 145]]) {
		for (let j = 0; j < JOINTS; j += 1) {
			for (let axis = 0; axis < 3; axis += 1) {
				assert.ok(
					near(out.posedJoints[(f * JOINTS + j) * 3 + axis], src.posedJoints[(s * JOINTS + j) * 3 + axis], 1e-6),
					`frame ${f} joint ${j} axis ${axis}`
				);
			}
		}
	}
	pass("output frames that land on a source frame still hold that frame's pose");
}

{
	// A take whose posedJoints are not the FK of its rotations (a legacy or
	// hand-built one) has its positions as the authority; regenerating would
	// move it, so those keep lerping and nothing is rewritten.
	const src = syntheticMotion(80, 20);
	const out = retimeMotion(src, 24);
	for (let j = 0; j < JOINTS; j += 1) {
		// Frame 6 sits exactly on source frame 5, whose positions are j + 0.25.
		assert.ok(near(out.posedJoints[(6 * JOINTS + j) * 3], 5 * 0.05 + j, 1e-5));
	}
	pass("a take whose positions do not follow its rotations is not rewritten by FK");
}

{
	const src = syntheticMotion(80, 20);
	const out = retimeMotion(src, 24);
	for (let f = 0; f < out.frames; f += 1) {
		const o = f * JOINTS * 9;
		const row0 = Math.hypot(out.rotMats[o], out.rotMats[o + 1], out.rotMats[o + 2]);
		const row1 = Math.hypot(out.rotMats[o + 3], out.rotMats[o + 4], out.rotMats[o + 5]);
		assert.ok(near(row0, 1, 1e-5) && near(row1, 1, 1e-5));
	}
	pass("every retimed matrix stays a unit rotation");
}

{
	// Changing the sampling clock does not change how big the filmed performer
	// was: the stature has to ride through the retime that every inbound take
	// passes on its way to the 24 fps timeline.
	const out = retimeMotion({ ...syntheticMotion(80, 20), personScale: 0.9 }, 24);
	assert.equal(out.personScale, 0.9);
	assert.equal("personScale" in retimeMotion(syntheticMotion(80, 20), 24), false);
	pass("a take's person scale survives the retime onto the timeline clock");
}

{
	const src = syntheticMotion(10, 24);
	assert.equal(retimeMotion(src, 24), src); // same clock: the same object, no copy
	const scaledAnchor = retimeMotion({ ...syntheticMotion(80, 20), anchorFrame: 40 }, 24);
	assert.equal(scaledAnchor.anchorFrame, 48); // anchors are frame indices and move with the clock
	pass("same-rate input passes through and anchor frames rescale");
}

console.log("verify-retime: all checks passed");
