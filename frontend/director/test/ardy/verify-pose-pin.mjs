#!/usr/bin/env node

// The pin decision decides which bridge mode a generation runs in, and the two
// modes are mutually exclusive: pose pinning sends full-body poses, a prompt
// schedule uses autoregressive history and refuses them. These checks pin the
// rules so "continue from this pose" cannot silently become an unpinned run,
// and so a schedule can never smuggle poses into a request the bridge rejects.

import assert from "node:assert/strict";
import { PIN_BLOCKED, planPosePin } from "../../src/ardy/pose-pin.js";

function pass(label) { console.log(`PASS ${label}`); }

/* --- continuing out of a blocking pose ------------------------------------- */

const fromPose = planPosePin({ startFromPose: true, clipFrames: 96 });
assert.equal(fromPose.pin, true, "an opted-in pose start pins");
assert.deepEqual(fromPose.frames, [0], "the blocking pose defaults to the first frame");
assert.equal(fromPose.blockedBy, null);
pass("a pose start pins exactly one frame");

/* --- the pose can be placed anywhere in the clip --------------------------- */
// First frame to leave from, last frame to arrive at, or a frame in between to
// pass through: the whole point is that the operator chooses.
const atEnd = planPosePin({ startFromPose: true, poseFrame: 95, clipFrames: 96 });
assert.deepEqual(atEnd.frames, [95], "a pose can be pinned at the last frame");

const atMiddle = planPosePin({ startFromPose: true, poseFrame: 48, clipFrames: 96 });
assert.deepEqual(atMiddle.frames, [48], "a pose can be pinned mid-clip");
pass("a pose pins at the frame it was placed on");

const pastEnd = planPosePin({ startFromPose: true, poseFrame: 500, clipFrames: 96 });
assert.deepEqual(pastEnd.frames, [95], "a pin past the end clamps to the last frame");
const negative = planPosePin({ startFromPose: true, poseFrame: -20, clipFrames: 96 });
assert.deepEqual(negative.frames, [0], "a negative pin clamps to the first frame");
const fractional = planPosePin({ startFromPose: true, poseFrame: 47.6, clipFrames: 96 });
assert.deepEqual(fractional.frames, [48], "a fractional frame lands on a whole one");
pass("an out-of-range placement is clamped into the clip");

const idle = planPosePin({ clipFrames: 96 });
assert.equal(idle.pin, false, "nothing to pin without an opt-in or an edit");
assert.deepEqual(idle.frames, []);
assert.equal(idle.blockedBy, PIN_BLOCKED.NOTHING_TO_PIN);
pass("a plain prompt run stays unpinned");

/* --- the schedule conflict is reported, never silently dropped ------------- */

const scheduled = planPosePin({
	startFromPose: true,
	hasPromptSchedule: true,
	segments: [{ startFrame: 0, endFrame: 48 }, { startFrame: 48, endFrame: 96 }],
	clipFrames: 96,
});
assert.equal(scheduled.pin, false, "a schedule cannot be pinned");
assert.deepEqual(scheduled.frames, []);
assert.equal(scheduled.blockedBy, PIN_BLOCKED.SCHEDULE, "the caller can say why the pose was not used");
pass("a prompt schedule blocks the pose start by name");

const scheduledNoOptIn = planPosePin({ hasPromptSchedule: true, clipFrames: 96 });
assert.equal(scheduledNoOptIn.blockedBy, PIN_BLOCKED.NOTHING_TO_PIN, "no opt-in means nothing was blocked");
pass("an unrequested pin reports nothing-to-pin, not a conflict");

/* --- a root path is constrained at its start ------------------------------- */

const path = planPosePin({ startFromPose: true, waypointMode: true, ikFrames: [30], clipFrames: 96 });
assert.equal(path.pin, true);
assert.deepEqual(path.frames, [0], "a generated root path takes one pin at frame 0");
pass("a root path pins only its first frame");

/* --- authored IK edits still pin the way they did -------------------------- */

const ikOnly = planPosePin({ ikFrames: [12, 40], clipFrames: 96, segments: [{ startFrame: 0, endFrame: 96 }] });
assert.equal(ikOnly.pin, true, "authored IK keys pin without any opt-in");
assert.ok(ikOnly.frames.includes(12) && ikOnly.frames.includes(40), "the authored keys are pinned");
assert.deepEqual(ikOnly.frames, [...ikOnly.frames].sort((a, b) => a - b), "frames leave in ascending order");
assert.equal(new Set(ikOnly.frames).size, ikOnly.frames.length, "no frame is pinned twice");
pass("authored IK keys keep pinning themselves");

const ikPlusPose = planPosePin({ startFromPose: true, poseFrame: 12, ikFrames: [40], clipFrames: 96, segments: [{ startFrame: 0, endFrame: 96 }] });
assert.ok(ikPlusPose.frames.includes(12), "the placed pose is added to the authored keys");
assert.ok(ikPlusPose.frames.includes(40));
pass("a placed pose joins authored IK keys");

const outOfRange = planPosePin({ ikFrames: [-5, 400], clipFrames: 96, segments: [{ startFrame: 0, endFrame: 96 }] });
assert.ok(!outOfRange.frames.includes(-5) && !outOfRange.frames.includes(400), "keys outside the clip are dropped");
pass("IK keys outside the clip never reach the bridge");

/* --- block edits address their own blocks ---------------------------------- */

const blockEdits = planPosePin({
	hasPromptSchedule: true,
	hasBlockEdits: true,
	ikFrames: [10, 70],
	editedSegments: [{ startFrame: 0, endFrame: 48 }],
	clipFrames: 96,
});
assert.equal(blockEdits.pin, true, "block edits pin even under a schedule");
assert.deepEqual(blockEdits.frames, [10], "only keys inside an edited block are pinned");
pass("block edits pin only their own frames");

console.log("pose-pin: OK");
