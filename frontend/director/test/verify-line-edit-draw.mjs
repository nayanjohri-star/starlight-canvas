/**
 * Freehand DRAWING inside line-edit mode — the pure half (src/line-edit.js).
 *
 * The mode used to react to exactly one gesture: a press within
 * CURVE_GRAB_RADIUS_PX of the joint's projected trail. On a take whose trail
 * bunches into a few screen pixels (a person backing up and falling, where the
 * hand barely moves across the image) there is nothing grabbable and the whole
 * mode reads as dead. `strokeToCurve` is the second gesture — draw a path on
 * empty space — and it has to produce a curve INDISTINGUISHABLE from a dragged
 * one, because preview, undo, curveToPoints2d and the camera-drift watcher are
 * all written against that single type.
 *
 * What is actually asserted here, in the order it matters:
 *   1. ARC LENGTH, not sample index — a stroke drawn slow-then-fast lands the
 *      same curve as one drawn at a constant speed. That is the whole claim
 *      that "drawing speed is irrelevant".
 *   2. The pinned ends come back BY REFERENCE from the base curve, so the seam
 *      guarantee is structural rather than a float comparison away.
 *   3. A click (too few samples, no length, below the caller's threshold) is a
 *      no-op — null — because a stray click must not wipe an existing edit.
 *   4. Null gaps survive as nulls, exactly as dragCurve leaves them.
 *   5. Drawing twice: the second stroke wins, and a drag on a drawn curve
 *      refines it like any other curve.
 *
 * Pure node, no DOM: run with `node test/verify-line-edit-draw.mjs`.
 */
import assert from "node:assert/strict";
import {
	DRAW_BUNCHED_WINDOW_FRAMES,
	DRAW_MIN_STROKE_POINTS,
	DRAW_MIN_STROKE_PX,
	DRAW_MIN_WINDOW_FRAMES,
	MIN_LINE_POINTS,
	PINNED_CURVE_ENDS,
	SEAM_EASE_MAX,
	SEAM_EASE_MIN,
	baseArcFractions,
	changedFrameRange,
	curveToPoints2d,
	sliceCurveToRange,
	curveWindow,
	curvesEqual,
	dragCurve,
	drawStrokeEdit,
	matchStrokeWindow,
	seamEaseFrames,
	seamEaseWeight,
	strokeToCurve,
} from "../src/line-edit.js";

let passed = 0;
const test = (name, fn) => {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(err?.stack || err);
		process.exitCode = 1;
	}
};

/** A base curve is what projectTrailCurve produces: dense, frame-indexed,
 * `{ frame, u, v }` or null. This one is a gentle diagonal so any resampling
 * bug shows up as a visible bend. */
const baseCurve = (count = 24, { nulls = [] } = {}) =>
	Array.from({ length: count }, (_, i) =>
		(nulls.includes(i) ? null : { frame: 100 + i, u: 0.2 + (0.4 * i) / (count - 1), v: 0.7 - (0.2 * i) / (count - 1) }));

/** Sample a polyline at `fraction` of its TOTAL LENGTH — the independent
 * spelling of what strokeToCurve does internally, so the test is not just the
 * implementation read back to itself. */
const alongStroke = (stroke, fraction) => {
	const cum = [0];
	for (let i = 1; i < stroke.length; i += 1) {
		cum.push(cum[i - 1] + Math.hypot(stroke[i][0] - stroke[i - 1][0], stroke[i][1] - stroke[i - 1][1]));
	}
	const target = fraction * cum[cum.length - 1];
	for (let i = 1; i < cum.length; i += 1) {
		if (cum[i] >= target || i === cum.length - 1) {
			const span = cum[i] - cum[i - 1];
			const t = span > 0 ? (target - cum[i - 1]) / span : 0;
			return [
				stroke[i - 1][0] + (stroke[i][0] - stroke[i - 1][0]) * t,
				stroke[i - 1][1] + (stroke[i][1] - stroke[i - 1][1]) * t,
			];
		}
	}
	return stroke[stroke.length - 1];
};

/** Straight strokes make the arc-length claim checkable in closed form; the
 * shape is the same line, only the SAMPLE SPACING differs between these two. */
const uniformStroke = (samples = 40) =>
	Array.from({ length: samples }, (_, i) => {
		const t = i / (samples - 1);
		return [0.15 + 0.7 * t, 0.25 + 0.5 * t];
	});

/** The same line, drawn slowly for its first half and flicked through the
 * second: 30 samples crawl over 20% of the length, 6 cover the other 80%. */
const slowThenFastStroke = () => {
	const points = [];
	for (let i = 0; i < 30; i += 1) {
		const t = (i / 29) * 0.2;
		points.push([0.15 + 0.7 * t, 0.25 + 0.5 * t]);
	}
	for (let i = 1; i <= 6; i += 1) {
		const t = 0.2 + (i / 6) * 0.8;
		points.push([0.15 + 0.7 * t, 0.25 + 0.5 * t]);
	}
	return points;
};

console.log("strokeToCurve — arc-length parameterization");

test("a drawn stroke replaces the interior with points sampled along its LENGTH", () => {
	const base = baseCurve();
	const stroke = uniformStroke();
	const drawn = strokeToCurve(stroke, base);
	assert.ok(drawn, "a real stroke must produce a curve");
	assert.equal(drawn.length, base.length, "the curve stays dense and frame-indexed");
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		const [u, v] = alongStroke(stroke, i / (base.length - 1));
		assert.ok(Math.abs(drawn[i].u - u) < 1e-9, `interior point ${i} u`);
		assert.ok(Math.abs(drawn[i].v - v) < 1e-9, `interior point ${i} v`);
		assert.equal(drawn[i].frame, base[i].frame, "the frame index is carried through untouched");
	}
});

test("drawing speed is irrelevant: slow-then-fast lands the same curve as uniform", () => {
	const base = baseCurve(48);
	const uniform = strokeToCurve(uniformStroke(), base);
	const uneven = strokeToCurve(slowThenFastStroke(), base);
	assert.ok(uniform && uneven);
	// Same geometry, sampled from wildly different sample DENSITIES. Anything
	// index-based here would drag the crowded first fifth across most of the
	// range and re-time the take.
	for (let i = 0; i < base.length; i += 1) {
		if (!uniform[i] || !uneven[i]) continue;
		assert.ok(Math.abs(uniform[i].u - uneven[i].u) < 1e-9, `point ${i} u drifted with drawing speed`);
		assert.ok(Math.abs(uniform[i].v - uneven[i].v) < 1e-9, `point ${i} v drifted with drawing speed`);
	}
});

test("a two-sample stroke is a straight line, evenly spaced in space", () => {
	const base = baseCurve(11);
	const drawn = strokeToCurve([[0.2, 0.2], [0.8, 0.8]], base);
	assert.ok(drawn);
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		const t = i / (base.length - 1);
		assert.ok(Math.abs(drawn[i].u - (0.2 + 0.6 * t)) < 1e-12, `point ${i} is not evenly spaced`);
	}
});

test("a stroke drawn backwards is not the same curve as one drawn forwards", () => {
	// Direction is meaning: a path is walked from its first frame to its last.
	// An ODD length so there is an exact middle index, which is the one place a
	// stroke and its reverse must agree.
	const base = baseCurve(25);
	const forward = strokeToCurve(uniformStroke(), base);
	const backward = strokeToCurve([...uniformStroke()].reverse(), base);
	assert.ok(!curvesEqual(forward, backward));
	const mid = (base.length - 1) / 2;
	assert.ok(Math.abs(forward[mid].u - backward[mid].u) < 1e-9, "the midpoint is the one place they agree");
	assert.ok(forward[PINNED_CURVE_ENDS].u < backward[PINNED_CURVE_ENDS].u);
});

console.log("strokeToCurve — the pinned ends");

test("the first and last PINNED_CURVE_ENDS points come back BY REFERENCE", () => {
	const base = baseCurve();
	const drawn = strokeToCurve(uniformStroke(), base);
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) {
		assert.equal(drawn[i], base[i], `head point ${i} must be the same object, not a copy`);
		const tail = base.length - 1 - i;
		assert.equal(drawn[tail], base[tail], `tail point ${tail} must be the same object, not a copy`);
	}
});

test("the pinned ends stay on the ORIGINAL trail even when the stroke is far away", () => {
	// The seam guarantee, stated the way GP2 measured it: wherever the stroke
	// starts, the range's first and last constrained frames are exactly where
	// the take already put the joint.
	const base = baseCurve();
	const drawn = strokeToCurve([[0.9, 0.05], [0.95, 0.1]], base);
	assert.equal(drawn[0].u, base[0].u);
	assert.equal(drawn[0].v, base[0].v);
	assert.equal(drawn[base.length - 1].u, base[base.length - 1].u);
	assert.equal(drawn[base.length - 1].v, base[base.length - 1].v);
	// ...and the interior really did move, i.e. the pinning is not just "it did
	// nothing at all".
	assert.ok(Math.abs(drawn[10].u - base[10].u) > 0.2, "the interior must be free");
});

test("pinnedEnds is honoured when overridden, and can never eat the whole curve", () => {
	const base = baseCurve(9);
	const wide = strokeToCurve(uniformStroke(), base, { pinnedEnds: 3 });
	for (let i = 0; i < 3; i += 1) assert.equal(wide[i], base[i]);
	assert.notEqual(wide[3], base[3]);
	// A pathological pinnedEnds must not silently return the base curve — half
	// the length is the cap, so there is always something in the middle.
	const capped = strokeToCurve(uniformStroke(), base, { pinnedEnds: 99 });
	assert.ok(capped, "an over-wide pin must still produce a curve");
	assert.ok(!curvesEqual(capped, base), "the middle point still moves");
});

console.log("strokeToCurve — the no-op click");

test("fewer than 2 samples is a click, not a stroke", () => {
	const base = baseCurve();
	assert.equal(strokeToCurve([], base), null);
	assert.equal(strokeToCurve([[0.5, 0.5]], base), null);
	assert.equal(DRAW_MIN_STROKE_POINTS, 2);
});

test("a stroke of zero length is a click", () => {
	const base = baseCurve();
	// A press and release with no movement still reports several samples on a
	// real pointer; every one of them is the same point.
	assert.equal(strokeToCurve([[0.4, 0.4], [0.4, 0.4], [0.4, 0.4]], base), null);
});

test("minLength refuses a stroke below the caller's threshold", () => {
	const base = baseCurve();
	// The app measures DRAW_MIN_STROKE_PX in PIXELS and converts; here the same
	// refusal is exercised directly in uv.
	const tremor = [[0.5, 0.5], [0.5025, 0.5], [0.505, 0.5008]];
	assert.equal(strokeToCurve(tremor, base, { minLength: 0.02 }), null);
	assert.ok(strokeToCurve(tremor, base, { minLength: 0.001 }), "above the threshold it is a real stroke");
	assert.equal(DRAW_MIN_STROKE_PX, 8);
});

test("a no-op refusal is null, never a mutated or emptied base curve", () => {
	// This is the "a stray click must not wipe an existing edit" rule at the
	// geometry level: the caller keeps its curve exactly when this returns null.
	const base = baseCurve();
	const snapshot = base.map((point) => (point ? { ...point } : null));
	assert.equal(strokeToCurve([[0.4, 0.4]], base), null);
	assert.ok(curvesEqual(base, snapshot), "the base curve must not be touched");
});

test("a garbage stroke is refused rather than producing NaN points", () => {
	const base = baseCurve();
	assert.equal(strokeToCurve(null, base), null);
	assert.equal(strokeToCurve("nope", base), null);
	assert.equal(strokeToCurve([[Number.NaN, 0.2], [0.3, Number.NaN]], base), null);
	// One good sample among the rubbish is still only one sample.
	assert.equal(strokeToCurve([[Number.NaN, 0.2], [0.3, 0.4]], base), null);
	// Two good samples among rubbish DO draw — the bad ones are dropped, not
	// allowed to poison the arc length.
	const mixed = strokeToCurve([[0.2, 0.2], [Number.POSITIVE_INFINITY, 0.5], [0.8, 0.8]], base);
	assert.ok(mixed && mixed.every((point) => !point || (Number.isFinite(point.u) && Number.isFinite(point.v))));
});

test("a base curve that is not a curve is refused", () => {
	assert.equal(strokeToCurve(uniformStroke(), null), null);
	assert.equal(strokeToCurve(uniformStroke(), []), null);
	assert.equal(strokeToCurve(uniformStroke(), [{ frame: 0, u: 0.5, v: 0.5 }]), null);
	assert.equal(MIN_LINE_POINTS, 2);
});

console.log("strokeToCurve — null gaps");

test("frames with no image stay null, exactly as dragCurve leaves them", () => {
	const nulls = [5, 6, 7, 20];
	const base = baseCurve(24, { nulls });
	const drawn = strokeToCurve(uniformStroke(), base);
	assert.ok(drawn);
	for (const index of nulls) assert.equal(drawn[index], null, `frame ${index} has no image and cannot gain one`);
	// The same shape as dragCurve's null policy, side by side.
	const dragged = dragCurve(base, 12, 0.05, -0.02, 8);
	for (let i = 0; i < base.length; i += 1) {
		assert.equal(drawn[i] === null, dragged[i] === null, `null layout diverges at ${i}`);
	}
});

test("a null gap does not shift the arc-length mapping of the points around it", () => {
	// The gap is a hole in the IMAGE, not in the timeline: index i is still
	// frame start+i, so the visible points must land where they would have
	// landed with no gap at all.
	const stroke = uniformStroke();
	const dense = strokeToCurve(stroke, baseCurve(24));
	const gapped = strokeToCurve(stroke, baseCurve(24, { nulls: [8, 9, 10] }));
	for (let i = 0; i < 24; i += 1) {
		if (!gapped[i]) continue;
		assert.ok(Math.abs(gapped[i].u - dense[i].u) < 1e-12, `point ${i} moved because of a gap elsewhere`);
	}
});

test("pinned ends that are themselves null stay null", () => {
	const base = baseCurve(24, { nulls: [0, 23] });
	const drawn = strokeToCurve(uniformStroke(), base);
	assert.equal(drawn[0], null);
	assert.equal(drawn[23], null);
	assert.equal(drawn[1], base[1]);
});

console.log("strokeToCurve — the drawn curve is an ordinary curve");

test("drawing twice: the second stroke wins", () => {
	const base = baseCurve();
	const first = strokeToCurve([[0.2, 0.8], [0.8, 0.8]], base);
	const second = strokeToCurve([[0.2, 0.2], [0.8, 0.2]], first);
	assert.ok(second);
	for (let i = PINNED_CURVE_ENDS; i < base.length - PINNED_CURVE_ENDS; i += 1) {
		assert.ok(Math.abs(second[i].v - 0.2) < 1e-12, `point ${i} still carries the first stroke`);
	}
	// ...and the ends are STILL the original trail, not the first stroke's ends:
	// redrawing cannot walk the seam away one stroke at a time.
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) assert.equal(second[i], base[i]);
});

test("a drag after a draw refines the drawn curve like any other", () => {
	const base = baseCurve();
	const drawn = strokeToCurve(uniformStroke(), base);
	const dragged = dragCurve(drawn, 12, 0.1, 0.0, 8);
	assert.ok(!curvesEqual(dragged, drawn), "the pull must move something");
	assert.ok(Math.abs(dragged[12].u - (drawn[12].u + 0.1)) < 1e-12, "the grabbed point follows the pointer exactly");
	for (let i = 0; i < PINNED_CURVE_ENDS; i += 1) assert.equal(dragged[i], base[i], "the pins survive draw-then-drag");
});

test("a drawn curve goes on the wire like a dragged one", () => {
	const base = baseCurve(40);
	const drawn = strokeToCurve(uniformStroke(), base);
	const { points2d, error } = curveToPoints2d(drawn);
	assert.equal(error, undefined);
	assert.equal(points2d.length, 40);
	assert.ok(points2d.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1));
	// First and last sent points are the pinned ends, byte for byte.
	assert.deepEqual(points2d[0], [base[0].u, base[0].v]);
	assert.deepEqual(points2d[39], [base[39].u, base[39].v]);
});

test("a stroke drawn off the image is refused by the wire gate, not silently clamped", () => {
	const base = baseCurve();
	const drawn = strokeToCurve([[0.5, 0.5], [1.4, 0.5]], base);
	assert.ok(drawn, "the curve itself is real — the joint really is out there");
	assert.equal(curveToPoints2d(drawn).error, "offscreen");
});

/* ===================== the redesign: draw = reroute THIS part ===============
 * Everything above tests strokeToCurve's DEFAULTS, which are still exactly what
 * a drag needs (uniform timing, hard pins) and are still what the pinned-end
 * tests assert. Nothing below changes them — the draw path opts in, so no check
 * above needed rewriting when the semantics changed.
 *
 * What the redesign fixes, and what each block below pins down:
 *   A. the stroke's endpoints choose the FRAME RANGE (matchStrokeWindow), so a
 *      short hook is no longer spread over an eight-second clip;
 *   B. frame f sits at the BASE trail's arc-length fraction (baseArcFractions),
 *      so the take's own velocity profile survives the reroute;
 *   C. the ends EASE instead of teleporting from a 2-frame pin (seamEaseWeight).
 * ========================================================================== */

/** A whole-clip trail: 120 frames, a wide arc across the middle of the image.
 * Frame f is at index f, which is what projectTrailCurve produces for a range
 * starting at 0. */
const clipCurve = (count = 120) =>
	Array.from({ length: count }, (_, f) => ({
		frame: f,
		u: 0.1 + (0.8 * f) / (count - 1),
		v: 0.5 - 0.25 * Math.sin((Math.PI * f) / (count - 1)),
	}));

const PANE = { paneW: 1600, paneH: 900 };

console.log("matchStrokeWindow — the stroke picks its own frames");

test("a stroke drawn over a stretch of the trail matches THAT stretch", () => {
	const full = clipCurve();
	// Drawn from just above frame 30 to just above frame 66 — a bulge over the
	// path rather than along it, which is what "reroute this part" looks like.
	const stroke = [];
	for (let i = 0; i <= 20; i += 1) {
		const f = 30 + (36 * i) / 20;
		const point = full[Math.round(f)];
		stroke.push([point.u, point.v - 0.08 * Math.sin((Math.PI * i) / 20)]);
	}
	const match = matchStrokeWindow(stroke, full, { ...PANE, clipFrames: full.length });
	assert.ok(match, "a stroke over the visible path must match");
	assert.equal(match.reversed, false);
	assert.equal(match.startFrame, 30);
	assert.equal(match.endFrame, 67, "endFrame is EXCLUSIVE — 30..66 inclusive is 30..67");
	// The whole point: a sub-window, not the clip.
	assert.ok(match.endFrame - match.startFrame < full.length / 2);
});

test("a stroke drawn end-to-start matches the SAME window, and reports reversed", () => {
	const full = clipCurve();
	const forward = [];
	for (let i = 0; i <= 20; i += 1) {
		const point = full[30 + Math.round((36 * i) / 20)];
		forward.push([point.u, point.v - 0.08]);
	}
	const a = matchStrokeWindow(forward, full, { ...PANE, clipFrames: full.length });
	const b = matchStrokeWindow([...forward].reverse(), full, { ...PANE, clipFrames: full.length });
	assert.ok(a && b);
	assert.equal(b.startFrame, a.startFrame, "drawing it backwards names the same frames");
	assert.equal(b.endFrame, a.endFrame);
	assert.equal(a.reversed, false);
	assert.equal(b.reversed, true, "the DIRECTION is reported, not baked into the range");
});

test("a bunched trail falls back to a window of about a second, centred on the match", () => {
	// The take that made drawing necessary in the first place: 120 frames of
	// trail projecting into ~2 px. The trail is still strictly increasing, so a
	// naive frame-span test would happily match frames 0 and 119 and hand the
	// stroke the WHOLE CLIP again — the original complaint through the back
	// door. The separation test is what catches it.
	const bunched = Array.from({ length: 120 }, (_, f) => ({ frame: f, u: 0.5 + f * 1e-5, v: 0.5 + f * 1e-5 }));
	const stroke = [[0.3, 0.2], [0.4, 0.35], [0.55, 0.6]];
	const match = matchStrokeWindow(stroke, bunched, { ...PANE, clipFrames: 120 });
	assert.ok(match);
	assert.equal(match.endFrame - match.startFrame, DRAW_BUNCHED_WINDOW_FRAMES);
	assert.ok(DRAW_BUNCHED_WINDOW_FRAMES >= DRAW_MIN_WINDOW_FRAMES, "the bunched window also satisfies the minimum");
	assert.ok(match.startFrame >= 0 && match.endFrame <= 120, "and never leaves the clip");
	assert.ok(match.endFrame - match.startFrame < 120 / 2, "and is nowhere near the whole clip");
});

test("the separation test is in PIXELS: the same trail on a huge pane IS matchable", () => {
	// The rule is "could the user have aimed at one end rather than the other?",
	// so it has to move with the pane. Scaled up 400x, that 2 px trail is 800 px
	// of path and the two ends are genuinely different places.
	const bunched = Array.from({ length: 120 }, (_, f) => ({ frame: f, u: 0.5 + f * 1e-5, v: 0.5 + f * 1e-5 }));
	const stroke = [[0.5, 0.5], [0.5008, 0.5008], [0.50119, 0.50119]];
	const tight = matchStrokeWindow(stroke, bunched, { ...PANE, clipFrames: 120 });
	assert.equal(tight.endFrame - tight.startFrame, DRAW_BUNCHED_WINDOW_FRAMES, "28 px apart on this pane: bunched");
	const wide = matchStrokeWindow(stroke, bunched, { paneW: 640000, paneH: 360000, clipFrames: 120 });
	assert.ok(wide.endFrame - wide.startFrame > DRAW_BUNCHED_WINDOW_FRAMES, "far apart on that one: a real match");
	assert.equal(wide.startFrame, 0);
	assert.equal(wide.endFrame, 120);
});

test("a bunched match at the very start of the clip slides in rather than going negative", () => {
	const bunched = Array.from({ length: 40 }, (_, f) => ({ frame: f, u: 0.5, v: 0.5 }));
	const match = matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], bunched, { ...PANE, clipFrames: 40 });
	assert.ok(match);
	assert.ok(match.startFrame >= 0);
	assert.equal(match.endFrame - match.startFrame, DRAW_BUNCHED_WINDOW_FRAMES);
});

test("a clip shorter than the bunched window is clipped, not overflowed", () => {
	const tiny = Array.from({ length: 10 }, (_, f) => ({ frame: f, u: 0.5, v: 0.5 }));
	const match = matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], tiny, { ...PANE, clipFrames: 10 });
	assert.ok(match);
	assert.equal(match.startFrame, 0);
	assert.equal(match.endFrame, 10);
});

test("a trail with nothing on screen matches nothing — the caller keeps its range", () => {
	const offscreen = Array.from({ length: 40 }, (_, f) => ({ frame: f, u: 1.8, v: -0.4 }));
	assert.equal(matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], offscreen, { ...PANE, clipFrames: 40 }), null);
	const allNull = Array.from({ length: 40 }, () => null);
	assert.equal(matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], allNull, { ...PANE, clipFrames: 40 }), null);
	// And the degenerate inputs, which must refuse rather than guess.
	assert.equal(matchStrokeWindow([[0.5, 0.5]], clipCurve(), { ...PANE, clipFrames: 120 }), null);
	assert.equal(matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], null, { ...PANE, clipFrames: 120 }), null);
	assert.equal(matchStrokeWindow([[0.5, 0.5], [0.6, 0.6]], clipCurve(), { paneW: 0, paneH: 0 }), null);
});

test("matching is in PIXELS, so a 16:9 pane does not bias the match vertically", () => {
	// Two candidate frames equidistant in uv but not on screen: the pixel metric
	// must prefer the one that is actually closer to the eye.
	const curve = [
		{ frame: 0, u: 0.50, v: 0.40 }, // 0.1 of v = 90 px on a 900-tall pane
		{ frame: 1, u: 0.50, v: 0.50 },
		{ frame: 2, u: 0.60, v: 0.50 }, // 0.1 of u = 160 px on a 1600-wide pane
	];
	const match = matchStrokeWindow([[0.5, 0.5], [0.5, 0.5]], curve, { ...PANE, clipFrames: 3 });
	assert.ok(match, "an exact hit on frame 1 still produces a window");
	// A stroke starting at frame 0's point: the nearest OTHER point in pixels is
	// frame 1 (90 px), not frame 2 (~187 px) — proven by the window it names.
	const window = matchStrokeWindow([[0.5, 0.40], [0.5, 0.50]], curve, { ...PANE, clipFrames: 3, minWindowFrames: 2 });
	assert.deepEqual({ s: window.startFrame, e: window.endFrame }, { s: 0, e: 2 });
});

console.log("curveWindow — slicing the clip curve by frames");

test("the window is sliced by FRAME NUMBER, not by array index", () => {
	// A curve that starts at frame 100, the way projectTrailCurve labels a range.
	const curve = Array.from({ length: 50 }, (_, i) => ({ frame: 100 + i, u: i / 100, v: 0.5 }));
	const window = curveWindow(curve, { startFrame: 110, endFrame: 120 });
	assert.equal(window.length, 10);
	assert.equal(window[0].frame, 110);
	assert.equal(window[9].frame, 119);
	// Nulls at the head must not shift the offset.
	const gapped = [null, null, ...curve.slice(2)];
	assert.equal(curveWindow(gapped, { startFrame: 110, endFrame: 120 })[0].frame, 110);
});

test("a window the curve does not fully cover is refused, never silently shortened", () => {
	const curve = Array.from({ length: 20 }, (_, i) => ({ frame: i, u: 0.5, v: 0.5 }));
	assert.equal(curveWindow(curve, { startFrame: 10, endFrame: 40 }), null);
	assert.equal(curveWindow(curve, { startFrame: -5, endFrame: 10 }), null);
	assert.equal(curveWindow(curve, { startFrame: 5, endFrame: 6 }), null, "a one-frame window is not a line");
});

console.log("seamEaseWeight / seamEaseFrames — the ease ramp");

test("the ramp is 0 at both edges, 1 in the interior, and monotone in between", () => {
	const n = 40;
	const ease = seamEaseFrames(n);
	assert.equal(seamEaseWeight(0, n, ease), 0, "the first frame is exactly on the original trail");
	assert.equal(seamEaseWeight(n - 1, n, ease), 0, "and so is the last");
	assert.equal(seamEaseWeight(ease, n, ease), 1, "the ramp is done by easeFrames in");
	assert.equal(seamEaseWeight(n / 2, n, ease), 1, "the middle is fully the stroke");
	// Monotone rising over the head, falling over the tail, and symmetric.
	for (let i = 1; i <= ease; i += 1) {
		assert.ok(seamEaseWeight(i, n, ease) > seamEaseWeight(i - 1, n, ease), `ramp not rising at ${i}`);
		assert.ok(Math.abs(seamEaseWeight(i, n, ease) - seamEaseWeight(n - 1 - i, n, ease)) < 1e-12, "the two seams differ");
	}
	// Weights never leave 0..1, so a blend can never overshoot the stroke.
	for (let i = 0; i < n; i += 1) {
		const w = seamEaseWeight(i, n, ease);
		assert.ok(w >= 0 && w <= 1, `weight ${w} out of range at ${i}`);
	}
});

test("the ramp leaves the seam along the ORIGINAL slope — smoothstep, not linear", () => {
	// The property that makes one eased edge stronger than two hard pins: the
	// weight's own slope is zero at the seam, so the curve departs the trail
	// tangentially instead of with a kink. Measured as a second difference.
	const n = 60;
	const ease = seamEaseFrames(n);
	const w = (i) => seamEaseWeight(i, n, ease);
	assert.ok(w(1) < 1 / ease, `smoothstep must start flatter than a linear ramp (${w(1)} vs ${1 / ease})`);
	assert.ok(w(ease - 1) > 1 - 1 / ease, "and finish flatter too");
});

test("easeFrames is 15% of the window, floored at 2 and capped at 12", () => {
	assert.equal(seamEaseFrames(40), 6);
	assert.equal(seamEaseFrames(100), 12, `capped at ${SEAM_EASE_MAX}`);
	assert.equal(seamEaseFrames(10), SEAM_EASE_MIN, "a short window still gets the pin-equivalent floor");
	// Never wide enough for the two ramps to meet and leave no interior.
	for (const n of [3, 4, 5, 8, 9]) {
		const ease = seamEaseFrames(n);
		assert.ok(ease >= 1 && ease <= Math.floor((n - 1) / 2), `ease ${ease} eats the whole window of ${n}`);
		assert.equal(seamEaseWeight(Math.floor(n / 2), n, ease), 1, `no interior left in a window of ${n}`);
	}
	// A window with no interior at all cannot be eased and says so.
	assert.equal(seamEaseFrames(2), 0);
	assert.equal(seamEaseFrames(1), 0);
});

test("an eased stroke glides out of the trail instead of teleporting to it", () => {
	// The GP2 failure mode, reproduced: a stroke drawn FAR from the trail. With
	// the old 2-frame pin the joint crossed the whole gap in one frame; with the
	// ramp it crosses it over easeFrames, and the first step is the smallest.
	const base = baseCurve(40);
	const far = [[0.85, 0.05], [0.95, 0.12]];
	const pinned = strokeToCurve(far, base, { pinnedEnds: PINNED_CURVE_ENDS });
	const ease = seamEaseFrames(base.length);
	const eased = strokeToCurve(far, base, { easeFrames: ease });
	const jump = (curve, i) => Math.hypot(curve[i].u - curve[i - 1].u, curve[i].v - curve[i - 1].v);
	const worstPinned = Math.max(...Array.from({ length: base.length - 1 }, (_, i) => jump(pinned, i + 1)));
	const worstEased = Math.max(...Array.from({ length: base.length - 1 }, (_, i) => jump(eased, i + 1)));
	assert.ok(worstEased < worstPinned / 2, `the ease must halve the worst pop (${worstEased} vs ${worstPinned})`);
	// The edge itself is still byte-identical to the trail — the pin's guarantee,
	// kept BY REFERENCE so curvesEqual needs no epsilon.
	assert.equal(eased[0], base[0]);
	assert.equal(eased[base.length - 1], base[base.length - 1]);
	// ...and the interior really is the stroke, not a watered-down version.
	assert.ok(Math.abs(eased[20].u - 0.9) < 0.06, "the middle must reach the drawn line");
});

console.log("baseArcFractions — the take's own velocity profile");

test("a fast-then-slow base maps the stroke unevenly, matching its arc-length profile", () => {
	// 21 frames: the joint covers 90% of its screen distance in the first 5
	// frames (a fall) and crawls through the rest (the recovery). Uniform timing
	// would put the halfway point of the STROKE at frame 10; velocity timing
	// puts it where the joint had actually gone halfway, which is frame 1-2.
	const base = Array.from({ length: 21 }, (_, i) => ({
		frame: i,
		u: i <= 5 ? (0.9 * i) / 5 : 0.9 + (0.1 * (i - 5)) / 15,
		v: 0.5,
	}));
	const fractions = baseArcFractions(base);
	assert.ok(fractions);
	assert.equal(fractions[0], 0);
	assert.ok(Math.abs(fractions[20] - 1) < 1e-12);
	assert.ok(Math.abs(fractions[5] - 0.9) < 1e-12, "90% of the distance is covered by frame 5");
	// Monotone non-decreasing, which is what lets strokeToCurve keep one walk.
	for (let i = 1; i < fractions.length; i += 1) assert.ok(fractions[i] >= fractions[i - 1], `not monotone at ${i}`);

	// And the mapping the fractions produce: a straight stroke, so position along
	// it IS the fraction, readable directly off u.
	const stroke = [[0, 0.2], [1, 0.2]];
	const drawn = strokeToCurve(stroke, base, { arcFractions: fractions, easeFrames: 1 });
	assert.ok(Math.abs(drawn[5].u - 0.9) < 1e-9, "frame 5 sits 90% along the drawn line, as it did on the trail");
	const uniform = strokeToCurve(stroke, base, { easeFrames: 1 });
	assert.ok(Math.abs(uniform[5].u - 0.25) < 1e-9, "uniform timing would have put it a quarter along");
	// The claim in one line: the fast part stays fast.
	assert.ok(drawn[5].u - drawn[0].u > uniform[5].u - uniform[0].u);
});

test("a stationary joint has no profile to preserve and falls back to uniform", () => {
	const still = Array.from({ length: 20 }, (_, i) => ({ frame: i, u: 0.5, v: 0.5 }));
	assert.equal(baseArcFractions(still), null);
	assert.equal(baseArcFractions([{ frame: 0, u: 0.1, v: 0.1 }]), null, "one point has no length");
	assert.equal(baseArcFractions(null), null);
	// Nulls contribute no length and inherit their neighbour's fraction, so a
	// gap cannot make the sequence jump or go non-monotone.
	const gapped = [{ frame: 0, u: 0, v: 0 }, null, null, { frame: 3, u: 1, v: 0 }];
	const fractions = baseArcFractions(gapped);
	assert.deepEqual(fractions, [0, 0, 0, 1]);
});

console.log("strokeToCurve — reversed strokes");

test("a reversed stroke lands the same curve as the forward one drawn over the same path", () => {
	const base = baseCurve(30);
	const stroke = uniformStroke();
	const forward = strokeToCurve(stroke, base, { easeFrames: 4 });
	const backward = strokeToCurve([...stroke].reverse(), base, { easeFrames: 4, reversed: true });
	assert.ok(curvesEqual(forward, backward), "reversed:true must undo a backwards-drawn stroke exactly");
	// Sanity: without the flag it is a different curve, as the older check above
	// already asserts for the default path.
	assert.ok(!curvesEqual(strokeToCurve([...stroke].reverse(), base, { easeFrames: 4 }), forward));
});

console.log("drawStrokeEdit — the whole gesture");

test("drawing over a stretch of path returns that window, its base and an eased curve", () => {
	const full = clipCurve();
	const stroke = [];
	for (let i = 0; i <= 24; i += 1) {
		const point = full[30 + Math.round((36 * i) / 24)];
		// A bulge ALONG the path: the ends sit on the trail (which is what "draw
		// along the path" means) and the middle lifts off it.
		stroke.push([point.u, point.v - 0.10 * Math.sin((Math.PI * i) / 24)]);
	}
	const edit = drawStrokeEdit(stroke, { fullCurve: full, ...PANE, clipFrames: full.length });
	assert.ok(edit);
	assert.equal(edit.matched, true);
	assert.deepEqual(edit.frameRange, { startFrame: 30, endFrame: 67 });
	assert.equal(edit.base.length, 37, "the base is the window's slice of the ORIGINAL trail");
	assert.equal(edit.base[0].frame, 30);
	assert.equal(edit.curve.length, edit.base.length, "still dense and frame-indexed");
	assert.equal(edit.curve[0], edit.base[0], "the seams are the original trail, by reference");
	assert.equal(edit.curve[36], edit.base[36]);
	assert.equal(edit.easeFrames, seamEaseFrames(37));
	// The interior really moved to the drawn line...
	assert.ok(Math.abs(edit.curve[18].v - (edit.base[18].v - 0.10)) < 0.02);
	// ...and NOT the frames outside the window, which are not in the edit at all.
	assert.ok(edit.frameRange.startFrame > 0 && edit.frameRange.endFrame < full.length);
});

test("the same stroke drawn backwards produces the same window and a forward-running curve", () => {
	const full = clipCurve();
	const stroke = [];
	for (let i = 0; i <= 24; i += 1) {
		const point = full[30 + Math.round((36 * i) / 24)];
		// A bulge ALONG the path: the ends sit on the trail (which is what "draw
		// along the path" means) and the middle lifts off it.
		stroke.push([point.u, point.v - 0.10 * Math.sin((Math.PI * i) / 24)]);
	}
	const forward = drawStrokeEdit(stroke, { fullCurve: full, ...PANE, clipFrames: full.length });
	const backward = drawStrokeEdit([...stroke].reverse(), { fullCurve: full, ...PANE, clipFrames: full.length });
	assert.ok(forward && backward);
	assert.deepEqual(backward.frameRange, forward.frameRange);
	assert.equal(backward.reversed, true);
	// u rises with the frame in both: drawing right-to-left must not run the
	// joint backwards along its own timeline.
	assert.ok(backward.curve[30].u > backward.curve[6].u, "the drawn curve runs forwards in time");
	for (let i = 0; i < forward.curve.length; i += 1) {
		if (!forward.curve[i] || !backward.curve[i]) continue;
		assert.ok(Math.abs(forward.curve[i].u - backward.curve[i].u) < 1e-9, `direction leaked at ${i}`);
	}
});

test("the timing comes from the BASE window, not from the stroke", () => {
	// A trail that sprints through the first third of the window and crawls
	// through the rest. Any two strokes of the same SHAPE must land the same
	// curve (that is the old arc-length claim), but the frames must be spaced by
	// the trail's profile, not evenly.
	const full = Array.from({ length: 60 }, (_, f) => ({
		frame: f,
		u: f <= 20 ? 0.1 + (0.6 * f) / 20 : 0.7 + (0.1 * (f - 20)) / 39,
		v: 0.5,
	}));
	const stroke = [[0.1, 0.3], [0.8, 0.3]];
	const edit = drawStrokeEdit(stroke, { fullCurve: full, ...PANE, clipFrames: 60 });
	assert.ok(edit && edit.matched);
	const span = edit.curve[edit.curve.length - 1].u - edit.curve[0].u;
	const covered = (i) => (edit.curve[i].u - edit.curve[0].u) / span;
	// By the window's frame 20 the original had covered ~86% of its screen
	// distance; the drawn curve must be roughly that far along too, and nowhere
	// near the ~34% uniform spacing would give.
	const at20 = covered(20 - edit.frameRange.startFrame);
	assert.ok(at20 > 0.7, `velocity profile lost (${at20.toFixed(3)} covered by the sprint's end)`);
	assert.ok(at20 > 2 * (20 / edit.curve.length), "this is not just uniform spacing in disguise");
});

test("no trail to match against falls back to the panel's range and still draws", () => {
	const offscreen = Array.from({ length: 60 }, (_, f) => ({ frame: f, u: 1.9, v: 1.9 }));
	const fallbackCurve = baseCurve(24);
	const fallbackRange = { startFrame: 100, endFrame: 124 };
	const edit = drawStrokeEdit(uniformStroke(), {
		fullCurve: offscreen,
		fallbackCurve,
		fallbackRange,
		...PANE,
		clipFrames: 60,
	});
	assert.ok(edit, "the gesture must still do something");
	assert.equal(edit.matched, false);
	assert.deepEqual(edit.frameRange, fallbackRange);
	assert.equal(edit.base, fallbackCurve);
	assert.ok(!curvesEqual(edit.curve, fallbackCurve), "and it must actually have drawn");
});

test("a click through drawStrokeEdit is still a no-op, and refuses without a base", () => {
	const full = clipCurve();
	assert.equal(drawStrokeEdit([[0.5, 0.5]], { fullCurve: full, ...PANE, clipFrames: 120 }), null);
	assert.equal(drawStrokeEdit([[0.5, 0.5], [0.5, 0.5]], { fullCurve: full, ...PANE, clipFrames: 120 }), null);
	// No trail AND no fallback: nothing to draw into, so nothing happens — the
	// existing edit in the caller's hand survives untouched.
	assert.equal(drawStrokeEdit(uniformStroke(), { fullCurve: null, ...PANE, clipFrames: 120 }), null);
});

test("a drawn edit goes on the wire exactly like a dragged one", () => {
	const full = clipCurve();
	const stroke = [];
	for (let i = 0; i <= 24; i += 1) {
		const point = full[30 + Math.round((36 * i) / 24)];
		// A bulge ALONG the path: the ends sit on the trail (which is what "draw
		// along the path" means) and the middle lifts off it.
		stroke.push([point.u, point.v - 0.10 * Math.sin((Math.PI * i) / 24)]);
	}
	const edit = drawStrokeEdit(stroke, { fullCurve: full, ...PANE, clipFrames: full.length });
	const { points2d, error } = curveToPoints2d(edit.curve);
	assert.equal(error, undefined);
	assert.equal(points2d.length, 37);
	// The window's endpoints are on the original trail, which is the whole seam
	// argument stated in the units the box receives.
	assert.deepEqual(points2d[0], [edit.base[0].u, edit.base[0].v]);
	assert.deepEqual(points2d[36], [edit.base[36].u, edit.base[36].v]);
	// A drag on top of a drawn curve still refines it, ends and all.
	const dragged = dragCurve(edit.curve, 18, 0.05, 0.0, 8);
	assert.ok(!curvesEqual(dragged, edit.curve));
	assert.equal(dragged[0], edit.base[0], "the drag's own pins hold the eased seam in place");
});

test("a fresh pull's committed range is the frames the falloff touched, not the clip", () => {
	const base = clipCurve();
	const pulled = dragCurve(base, 60, 0.05, 0.02, 8);
	const range = changedFrameRange(base, pulled, { clipFrames: base.length });
	assert.ok(range, "a real pull must name a window");
	// dragWeight cuts off at the radius, so the touched span is ~2*radius wide
	// plus the pad — nowhere near the 120-frame clip that used to be re-rolled.
	assert.ok(range.endFrame - range.startFrame <= 8 * 2 + 1 + 2 * 2 + 2, `window ${JSON.stringify(range)} should be falloff-sized`);
	assert.ok(range.startFrame <= 60 && range.endFrame > 60, "and it must contain the grab");
	// Identity is the test, so an untouched curve names no window at all.
	assert.equal(changedFrameRange(base, base, { clipFrames: base.length }), null);
});

test("a tiny flick still asks for a workable window, clamped inside the clip", () => {
	const base = clipCurve();
	const flick = dragCurve(base, 3, 0.03, 0, 2);
	const range = changedFrameRange(base, flick, { clipFrames: base.length });
	assert.ok(range.endFrame - range.startFrame >= 8, "minFrames must hold");
	assert.ok(range.startFrame >= 0 && range.endFrame <= base.length, "and stay inside the clip");
});

test("the wire slice pairs the touched window's own frames with the range", () => {
	const base = clipCurve();
	const pulled = dragCurve(base, 60, 0.05, 0.02, 8);
	const range = changedFrameRange(base, pulled, { clipFrames: base.length });
	const sliced = sliceCurveToRange(pulled, range);
	assert.equal(sliced.length, range.endFrame - range.startFrame);
	assert.equal(sliced[0].frame, range.startFrame);
	assert.equal(sliced[sliced.length - 1].frame, range.endFrame - 1);
	// A curve that already spans its range (a drawn window) is returned as-is.
	assert.equal(sliceCurveToRange(sliced, range), sliced);
	// Nulls inherit their frame from position, so a behind-the-lens gap inside
	// the window survives the slice and one outside it is dropped.
	const gappy = pulled.map((point, index) => (index === 61 || index === 5 ? null : point));
	const slicedGaps = sliceCurveToRange(gappy, range);
	assert.equal(slicedGaps.length, range.endFrame - range.startFrame);
	assert.equal(slicedGaps[61 - range.startFrame], null);
});

console.log(`\n${passed} checks passed`);
