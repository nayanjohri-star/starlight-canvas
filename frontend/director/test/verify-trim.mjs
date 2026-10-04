import assert from "node:assert/strict";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { sliceMotion } from "../src/ardy/trim.js";

function pass(label) { console.log(`PASS ${label}`); }

const JOINTS = CSKEL27_JOINTS.length;

function stampedMotion(frames) {
	// every value encodes (frame, slot) so any mis-slice is detectable
	const rotMats = new Float32Array(frames * JOINTS * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let f = 0; f < frames; f += 1) {
		for (let k = 0; k < JOINTS * 9; k += 1) rotMats[f * JOINTS * 9 + k] = f + k / 1e4;
		for (let k = 0; k < 3; k += 1) rootPos[f * 3 + k] = f + k / 10;
		for (let k = 0; k < JOINTS * 3; k += 1) posedJoints[f * JOINTS * 3 + k] = f + k / 1e3;
	}
	return { frames, fps: 24, rotMats, rootPos, posedJoints, url: "/ardy/motions/x", anchorFrame: 7, prompt: "take", personScale: 0.9 };
}

{
	const sliced = sliceMotion(stampedMotion(100), 20, 59);
	assert.equal(sliced.frames, 40);
	assert.equal(sliced.rotMats.length, 40 * JOINTS * 9);
	assert.equal(sliced.rootPos.length, 40 * 3);
	assert.equal(sliced.posedJoints.length, 40 * JOINTS * 3);
	assert.equal(sliced.rotMats[0], 20); // slice frame 0 IS source frame 20
	assert.equal(sliced.rootPos[3], 21);
	assert.equal(Math.floor(sliced.posedJoints[39 * JOINTS * 3]), 59); // last slice frame is source frame 59
	assert.equal(sliced.anchorFrame, 0); // the cut re-anchors at its own head
	assert.equal(sliced.fps, 24);
	assert.equal(sliced.prompt, "take"); // metadata rides through
	// The cut is the same performer, and the remaining frames still travel
	// against their stature — a slice that dropped it would replay the tail of
	// a filmed stride at canonical size.
	assert.equal(sliced.personScale, 0.9);
	pass("a mid-clip cut keeps exactly its frames and re-anchors at frame 0");
}

{
	// Re-trimming a cut take and restoring the full take both go through the
	// same slice, so the stature can never be lost by editing.
	const full = stampedMotion(60);
	const once = sliceMotion(full, 10, 49);
	const twice = sliceMotion(once, 5, 20);
	assert.equal(once.personScale, 0.9);
	assert.equal(twice.personScale, 0.9);
	// A take with no stored stature stays that way: canonical, never invented.
	const { personScale, ...canonical } = full;
	assert.equal(personScale, 0.9);
	assert.equal("personScale" in sliceMotion(canonical, 0, 9), false);
	pass("the take's person scale survives repeated cuts and is never invented");
}

{
	const source = stampedMotion(50);
	const sliced = sliceMotion(source, 0, 49);
	assert.equal(sliced.frames, 50);
	assert.notEqual(sliced.rotMats, source.rotMats); // a copy, never a view of the original
	source.rotMats[0] = 999;
	assert.notEqual(sliced.rotMats[0], 999);
	pass("a full-range cut is still an independent copy");
}

{
	const source = stampedMotion(30);
	for (const [a, b] of [[-1, 10], [5, 30], [20, 10], [0.5, 10]]) {
		let named = null;
		try {
			sliceMotion(source, a, b);
		} catch (error) { named = error.message; }
		assert.ok(named && named.startsWith("sliceMotion:"), `${a}..${b}`);
	}
	pass("out-of-range and non-integer cuts are refused by name");
}

console.log("verify-trim: all checks passed");
