#!/usr/bin/env node
// Contracts for the Rail Follow time clip schedule: the resolved kinds, the
// inclusive active window, the min-10-frame boundary, shrink-safe clamping,
// move/resize, and the single camera-owner decision.
import {
	RAIL_FOLLOW_MIN_FRAMES,
	RAIL_OWNER_KEYS,
	RAIL_OWNER_NONE,
	RAIL_OWNER_RAIL,
	RAIL_SCHEDULE_LEGACY,
	RAIL_SCHEDULE_NONE,
	RAIL_SCHEDULE_OFF,
	RAIL_SCHEDULE_RANGE,
	RAIL_SCHEDULE_TOO_SHORT,
	activeAt,
	clampRailRange,
	defaultRailRange,
	isRailUsable,
	moveRailRange,
	railFollowForNewGeometry,
	railCameraOwner,
	resizeRailRange,
	resolveRailSchedule,
} from "../src/camera-rail-schedule.js";

let failures = 0;
const expect = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

const RAIL = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 1 }];

/* ------------------------------------------------- constants ---- */

expect("the minimum inclusive clip length is 10 frames", RAIL_FOLLOW_MIN_FRAMES === 10, String(RAIL_FOLLOW_MIN_FRAMES));

/* ------------------------------------------------- default range ---- */

expect("default range is the whole timeline", JSON.stringify(defaultRailRange(300)) === '{"startFrame":0,"endFrame":299}');
expect("default range on a 10-frame timeline is exactly 0..9", JSON.stringify(defaultRailRange(10)) === '{"startFrame":0,"endFrame":9}');
expect("no default range below 10 frames", defaultRailRange(9) === null);
expect("no default range for a non-finite length", defaultRailRange(Number.NaN) === null);
expect(
	"a redrawn rail keeps an authored range",
	JSON.stringify(railFollowForNewGeometry({ mode: "range", startFrame: 10, endFrame: 80 }, 300)) === '{"mode":"range","startFrame":10,"endFrame":80}',
);
expect(
	"a redrawn rail drops stale OFF for the default range",
	JSON.stringify(railFollowForNewGeometry({ mode: "off" }, 300)) === '{"startFrame":0,"endFrame":299}',
);
expect(
	"a first rail draw gets the default range",
	JSON.stringify(railFollowForNewGeometry(null, 300)) === '{"startFrame":0,"endFrame":299}',
);

/* ------------------------------------------------- rail usability ---- */

expect("two finite points make a rail usable", isRailUsable(RAIL) === true);
expect("null, empty and one-point rails are unusable", isRailUsable(null) === false && isRailUsable([]) === false && isRailUsable([{ x: 1, z: 1 }]) === false);
expect("garbage points make a rail unusable", isRailUsable([{ x: 0, z: 0 }, { x: Number.NaN, z: 1 }]) === false);

/* ------------------------------------------------- resolve ---- */

const legacy = resolveRailSchedule({ railFollow: null, cameraRail: RAIL, frameCount: 300 });
expect("legacy-derived resolves to the whole timeline", legacy.kind === RAIL_SCHEDULE_LEGACY && legacy.startFrame === 0 && legacy.endFrame === 299, JSON.stringify(legacy));

const ranged = resolveRailSchedule({ railFollow: { mode: "range", startFrame: 50, endFrame: 120 }, cameraRail: RAIL, frameCount: 300 });
expect("an authored range resolves as range", ranged.kind === RAIL_SCHEDULE_RANGE && ranged.startFrame === 50 && ranged.endFrame === 120, JSON.stringify(ranged));

expect(
	"explicit off resolves as off, never legacy",
	resolveRailSchedule({ railFollow: { mode: "off" }, cameraRail: RAIL, frameCount: 300 }).kind === RAIL_SCHEDULE_OFF,
);

expect(
	"no rail geometry resolves as none",
	resolveRailSchedule({ railFollow: { mode: "range", startFrame: 0, endFrame: 9 }, cameraRail: null, frameCount: 300 }).kind === RAIL_SCHEDULE_NONE &&
		resolveRailSchedule({ railFollow: null, cameraRail: [{ x: 1, z: 1 }], frameCount: 300 }).kind === RAIL_SCHEDULE_NONE,
);

expect(
	"a timeline below 10 frames resolves as too-short even with an authored range",
	resolveRailSchedule({ railFollow: { mode: "range", startFrame: 0, endFrame: 5 }, cameraRail: RAIL, frameCount: 9 }).kind === RAIL_SCHEDULE_TOO_SHORT,
);
expect(
	"a too-short timeline beats off",
	resolveRailSchedule({ railFollow: { mode: "off" }, cameraRail: RAIL, frameCount: 9 }).kind === RAIL_SCHEDULE_TOO_SHORT,
);

const boundary = resolveRailSchedule({ railFollow: { mode: "range", startFrame: 0, endFrame: 9 }, cameraRail: RAIL, frameCount: 300 });
expect("the 10-inclusive-frame boundary resolves as a range", boundary.kind === RAIL_SCHEDULE_RANGE && boundary.startFrame === 0 && boundary.endFrame === 9, JSON.stringify(boundary));

const shortRange = resolveRailSchedule({ railFollow: { mode: "range", startFrame: 0, endFrame: 5 }, cameraRail: RAIL, frameCount: 300 });
expect("a stored sub-10 range is extended to the minimum", shortRange.kind === RAIL_SCHEDULE_RANGE && shortRange.startFrame === 0 && shortRange.endFrame === 9, JSON.stringify(shortRange));

const outOfBounds = resolveRailSchedule({ railFollow: { mode: "range", startFrame: 290, endFrame: 400 }, cameraRail: RAIL, frameCount: 300 });
expect("a range past the end is clamped into the timeline", outOfBounds.kind === RAIL_SCHEDULE_RANGE && outOfBounds.startFrame === 290 && outOfBounds.endFrame === 299, JSON.stringify(outOfBounds));

const corrupt = resolveRailSchedule({ railFollow: { mode: "range", startFrame: 50, endFrame: 10 }, cameraRail: RAIL, frameCount: 300 });
expect("a corrupt inverted range folds to off", corrupt.kind === RAIL_SCHEDULE_OFF, JSON.stringify(corrupt));

/* ------------------------------------------------- activeAt ---- */

const window = { kind: RAIL_SCHEDULE_RANGE, startFrame: 10, endFrame: 20 };
expect("activeAt is inclusive on both ends", activeAt(window, 10) === true && activeAt(window, 20) === true);
expect("activeAt excludes the frames just outside", activeAt(window, 9) === false && activeAt(window, 21) === false);
expect("activeAt covers every frame of a legacy clip", activeAt(legacy, 0) === true && activeAt(legacy, 299) === true && activeAt(legacy, 150) === true);
expect("activeAt is false for off/too-short/none schedules", activeAt({ kind: RAIL_SCHEDULE_OFF }, 10) === false && activeAt({ kind: RAIL_SCHEDULE_TOO_SHORT }, 10) === false && activeAt({ kind: RAIL_SCHEDULE_NONE }, 10) === false);
expect("activeAt is false for a non-finite frame", activeAt(window, Number.NaN) === false && activeAt(null, 10) === false);

/* ------------------------------------------------- clamp (shrink-safe) ---- */

expect("shrink clamp pulls the end in", JSON.stringify(clampRailRange({ startFrame: 100, endFrame: 250 }, 200)) === '{"startFrame":100,"endFrame":199}');
expect("shrink clamp keeps the 10-frame minimum by pulling the start", JSON.stringify(clampRailRange({ startFrame: 195, endFrame: 250 }, 200)) === '{"startFrame":190,"endFrame":199}');
expect("re-clamping after growth never resurrects the old range", JSON.stringify(clampRailRange({ startFrame: 100, endFrame: 199 }, 300)) === '{"startFrame":100,"endFrame":199}');
expect("a 10-frame range is preserved, not grown", JSON.stringify(clampRailRange({ startFrame: 0, endFrame: 9 }, 300)) === '{"startFrame":0,"endFrame":9}');
expect("a degenerate 1-frame range is extended to the minimum", JSON.stringify(clampRailRange({ startFrame: 5, endFrame: 5 }, 300)) === '{"startFrame":5,"endFrame":14}');
expect("a 10-frame timeline clamps any range to the full timeline", JSON.stringify(clampRailRange({ startFrame: 0, endFrame: 4 }, 10)) === '{"startFrame":0,"endFrame":9}');
expect("no clamp possible below 10 frames", clampRailRange({ startFrame: 0, endFrame: 9 }, 9) === null);
expect("hostile ranges clamp to null", clampRailRange(null, 300) === null && clampRailRange({ startFrame: 30, endFrame: 10 }, 300) === null);

/* ------------------------------------------------- move ---- */

expect("move shifts the clip by delta", JSON.stringify(moveRailRange({ startFrame: 10, endFrame: 20 }, 5, 300)) === '{"startFrame":15,"endFrame":25}');
expect("move preserves length at the start edge", JSON.stringify(moveRailRange({ startFrame: 10, endFrame: 20 }, -50, 300)) === '{"startFrame":0,"endFrame":10}');
expect("move preserves length at the end edge", JSON.stringify(moveRailRange({ startFrame: 10, endFrame: 20 }, 500, 300)) === '{"startFrame":289,"endFrame":299}');
expect("a clip that cannot fit cannot move", moveRailRange({ startFrame: 0, endFrame: 9 }, 0, 9) === null && moveRailRange({ startFrame: 0, endFrame: 10 }, 0, 10) === null);
expect("hostile ranges cannot move", moveRailRange({ startFrame: 20, endFrame: 10 }, 5, 300) === null && moveRailRange({ startFrame: 5, endFrame: 5 }, 5, 300) === null);

/* ------------------------------------------------- resize ---- */

expect("end resize clamps to the 10-frame minimum", JSON.stringify(resizeRailRange({ startFrame: 10, endFrame: 20 }, "end", 5, 300)) === '{"startFrame":10,"endFrame":19}');
expect("end resize clamps to the timeline end", JSON.stringify(resizeRailRange({ startFrame: 10, endFrame: 20 }, "end", 999, 300)) === '{"startFrame":10,"endFrame":299}');
expect("start resize clamps to the 10-frame minimum", JSON.stringify(resizeRailRange({ startFrame: 10, endFrame: 20 }, "start", 25, 300)) === '{"startFrame":11,"endFrame":20}');
expect("start resize clamps to the timeline start", JSON.stringify(resizeRailRange({ startFrame: 10, endFrame: 20 }, "start", -5, 300)) === '{"startFrame":0,"endFrame":20}');
expect("end resize cannot keep the minimum near the end", resizeRailRange({ startFrame: 95, endFrame: 99 }, "end", 99, 100) === null);
expect("start resize cannot keep the minimum near the start", resizeRailRange({ startFrame: 0, endFrame: 5 }, "start", 0, 10) === null);
expect("an unknown edge is rejected", resizeRailRange({ startFrame: 0, endFrame: 9 }, "middle", 5, 300) === null);

/* ------------------------------------------------- owner ---- */

const owner = (followEnabled, railUsable, schedule, frame) => railCameraOwner({ followEnabled, railUsable, schedule, frame });

expect("follow off: the rail never owns", owner(false, true, ranged, 60) === RAIL_OWNER_NONE);
expect("no usable geometry: the rail never owns", owner(true, false, ranged, 60) === RAIL_OWNER_NONE);
expect("off schedule: no rail owner", owner(true, true, { kind: RAIL_SCHEDULE_OFF }, 60) === RAIL_OWNER_NONE);
expect("too-short schedule: no rail owner", owner(true, true, { kind: RAIL_SCHEDULE_TOO_SHORT }, 60) === RAIL_OWNER_NONE);
expect("none schedule: no rail owner", owner(true, true, { kind: RAIL_SCHEDULE_NONE }, 60) === RAIL_OWNER_NONE);
expect("inside the range the rail owns", owner(true, true, ranged, 50) === RAIL_OWNER_RAIL && owner(true, true, ranged, 120) === RAIL_OWNER_RAIL);
expect("just outside the range the keys own", owner(true, true, ranged, 49) === RAIL_OWNER_KEYS && owner(true, true, ranged, 121) === RAIL_OWNER_KEYS);
expect("legacy: the rail owns the whole timeline", owner(true, true, legacy, 0) === RAIL_OWNER_RAIL && owner(true, true, legacy, 299) === RAIL_OWNER_RAIL);

console.log(failures === 0 ? "all camera-rail-schedule checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
