#!/usr/bin/env node
import { promptMoveStartFrame } from "../../src/ardy/timeline-coordinates.js";
import { movePromptClipFrames } from "../../src/ardy/prompt-clips.js";

let failures = 0;
function expect(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
	if (!ok) failures += 1;
}
const rawAt = (displayFrameCount, laneWidth, frameDelta) =>
	promptMoveStartFrame(0, 500, 500 + frameDelta * laneWidth / (displayFrameCount - 1), laneWidth, displayFrameCount);
expect("1x pixel delta maps to 40 frames", Math.abs(rawAt(200, 1452, 40) - 40) < 1e-9);
expect("0.5x pixel delta maps to 40 frames", Math.abs(rawAt(400, 1452, 40) - 40) < 1e-9);
expect("2x wide lane pixel delta maps to 40 frames", Math.abs(rawAt(200, 2904, 40) - 40) < 1e-9);
let repeated = 0;
for (let i = 0; i < 1000; i += 1) repeated = rawAt(400, 1452, 40);
expect("1000 repeated events never accumulate movement", Math.abs(repeated - 40) < 1e-9, String(repeated));

const one = [{ id: "a", startFrame: 0, endFrame: 40, text: "walk" }];
const right = movePromptClipFrames(one, "a", 42);
expect("move snaps to the next 40-frame block", right[0].startFrame === 40 && right[0].endFrame === 80, JSON.stringify(right));
expect("move preserves duration", right[0].endFrame - right[0].startFrame === 40);
const clamped = movePromptClipFrames(right, "a", -200);
expect("left move clamps at frame zero", clamped[0].startFrame === 0 && clamped[0].endFrame === 40);
const clips = [
	{ id: "a", startFrame: 0, endFrame: 40, text: "walk" },
	{ id: "b", startFrame: 80, endFrame: 120, text: "stop" },
];
const collision = movePromptClipFrames(clips, "a", 80);
expect("move onto another block clamps to abut it", collision[0].startFrame === 40 && collision[0].endFrame === 80, JSON.stringify(collision));
const gap = movePromptClipFrames(clips, "a", 40);
expect("move into a free adjacent slot succeeds", gap[0].startFrame === 40 && gap[0].endFrame === 80);
// Generated takes place clips off the block grid (phase seconds are free-form).
// Dragging the walk clip left toward an off-grid neighbor must land flush
// against it, not silently refuse because every snap position overlaps.
const offGrid = [
	{ id: "crouch", startFrame: 0, endFrame: 72, text: "crouch" },
	{ id: "walk", startFrame: 96, endFrame: 204, text: "walk" },
];
const flush = movePromptClipFrames(offGrid, "walk", 70, 48);
expect("off-grid drag clamps flush against the neighbor", flush[1].startFrame === 72 && flush[1].endFrame === 180, JSON.stringify(flush));
const noRoom = movePromptClipFrames(
	[
		{ id: "a", startFrame: 0, endFrame: 72, text: "a" },
		{ id: "b", startFrame: 72, endFrame: 132, text: "b" },
		{ id: "c", startFrame: 132, endFrame: 240, text: "c" },
	],
	"c",
	100,
	48
);
expect("drag with no free room keeps the layout", noRoom[2].startFrame === 132, JSON.stringify(noRoom));
if (failures) process.exit(1);
console.log("all prompt move checks PASS");
