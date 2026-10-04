#!/usr/bin/env node
import { frameFromClientX, motionTrimRange, TRIM_MIN_FRAMES } from "../../src/ardy/timeline-coordinates.js";

let failures = 0;
function expect(name, actual, wanted) {
	const ok = actual === wanted;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, wanted ${wanted}`}`);
	if (!ok) failures += 1;
}
function clientXForFrame(frame, left, width, displayFrameCount) {
	return left + (frame / (displayFrameCount - 1)) * width;
}
const frameCount = 181; // frames 0..180, matching the screenshot's ruler
const left = 148;
const width = 1452;
for (const zoom of [0.25, 0.5, 1]) {
	const displayFrameCount = zoom < 1 ? Math.ceil(frameCount / zoom) : frameCount;
	const x = clientXForFrame(140, left, width, displayFrameCount);
	expect(`${zoom}x click on tick 140 resolves frame 140`, frameFromClientX(x, left, width, displayFrameCount, frameCount), 140);
}
const zoomedWidth = width * 2;
const scrolledLeft = left - 600;
const scrolledX = clientXForFrame(100, scrolledLeft, zoomedWidth, frameCount);
expect("2x scrolled click resolves frame 100", frameFromClientX(scrolledX, scrolledLeft, zoomedWidth, frameCount, frameCount), 100);
expect("zoom-out virtual frames beyond clip clamp to final frame", frameFromClientX(left + width, left, width, 724, frameCount), 180);
expect("left of lane clamps to frame 0", frameFromClientX(left - 500, left, width, frameCount, frameCount), 0);

// Motion-strip trim: the drag runs on the same pixel→frame transform, always
// restarts from the FULL take, and never cuts below TRIM_MIN_FRAMES.
function dragTrim(edge, targetFrame, { takeFrames = frameCount, displayFrameCount = frameCount } = {}) {
	const max = Math.min(takeFrames, displayFrameCount) - 1;
	let preview = { start: 0, end: max }; // pointer-down ALWAYS reopens the full take
	const x = clientXForFrame(targetFrame, left, width, displayFrameCount);
	const frame = Math.min(max, frameFromClientX(x, left, width, displayFrameCount, frameCount));
	preview = motionTrimRange(edge, frame, preview, max);
	return preview;
}
expect("TRIM_MIN_FRAMES is half a second at 24 fps", TRIM_MIN_FRAMES, 12);
const endDrag = dragTrim("end", 120);
expect("end handle lands on the dragged frame", endDrag.end, 120);
expect("end-only drag still reports start 0 (full-range restart)", endDrag.start, 0);
const startDrag = dragTrim("start", 40);
expect("start handle lands on the dragged frame", startDrag.start, 40);
expect("start-only drag leaves the take's last frame", startDrag.end, frameCount - 1);
expect("start cannot cross within TRIM_MIN_FRAMES of the end", dragTrim("start", 179).start, frameCount - 1 - TRIM_MIN_FRAMES);
expect("end cannot cross within TRIM_MIN_FRAMES of the start", dragTrim("end", 3).end, TRIM_MIN_FRAMES);
expect("end clamps to the take's last frame", dragTrim("end", 170, { takeFrames: 90 }).end, 89);
// Zoomed out, the visible range widens but the take keeps its own frames.
const zoomedOut = dragTrim("end", 100, { takeFrames: frameCount, displayFrameCount: 724 });
expect("zoom-out drag resolves the same take frame", zoomedOut.end, 100);
expect("zoom-out drag keeps the full-range start", zoomedOut.start, 0);

if (failures) process.exit(1);
console.log("all timeline coordinate checks PASS");
