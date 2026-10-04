// Speed envelopes: area-conserving drags, time-distance pins, and the
// frame → position answer the prop path draws from them.
import {
	createTiming,
	flatTiming,
	timingProgress,
	envelopeDrag,
	insertCut,
	removeCut,
	ENVELOPE_POINTS,
} from "../src/speed-envelope.js";
import { createObjectPath, objectTransformAt } from "../src/object-path.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** Trapezoid mean of an envelope over its normalized span — must stay 1. */
const mean = (envelope) => {
	let area = 0;
	for (let i = 0; i < envelope.length - 1; i += 1) area += (envelope[i] + envelope[i + 1]) / 2;
	return area / (envelope.length - 1);
};

/* --- schema ---------------------------------------------------------------- */

ok("nothing is not a timing", createTiming(null) === null && createTiming(undefined) === null && createTiming(42) === null);
ok("a flat timing is one segment of ones", (() => {
	const timing = flatTiming();
	return timing.cuts.length === 0 && timing.envelopes.length === 1 &&
		timing.envelopes[0].length === ENVELOPE_POINTS && timing.envelopes[0].every((v) => v === 1);
})());
ok("createTiming repairs and renormalizes", (() => {
	const timing = createTiming({ cuts: [], envelopes: [[2, 2, 2, 2]] });
	return !!timing && timing.envelopes[0].length === ENVELOPE_POINTS && near(mean(timing.envelopes[0]), 1);
})());
ok("cuts must strictly increase in both t and d", (() => {
	const timing = createTiming({ cuts: [{ t: 0.5, d: 0.6 }, { t: 0.4, d: 0.7 }, { t: 0.7, d: 0.5 }], envelopes: [] });
	return !!timing && timing.cuts.length === 1 && timing.cuts[0].t === 0.5 && timing.cuts[0].d === 0.6 &&
		timing.envelopes.length === 2;
})());
ok("negative speeds are repaired to zero", (() => {
	const timing = createTiming({ cuts: [], envelopes: [[-3, 1, 1, 1, 1, 1]] });
	return !!timing && timing.envelopes[0].every((v) => v >= 0);
})());

/* --- the area is the distance: drags conserve it --------------------------- */

const flat = flatTiming().envelopes[0];

ok("a drag conserves the integral", (() => {
	const raised = envelopeDrag(flat, 0.25, 3.0);
	return near(mean(raised), 1, 1e-6);
})());
ok("the raised stretch rises and the rest sinks", (() => {
	const raised = envelopeDrag(flat, 0.25, 3.0);
	const atQuarter = raised[Math.round(0.25 * (ENVELOPE_POINTS - 1))];
	const atEnd = raised[ENVELOPE_POINTS - 1];
	return atQuarter > 2 && atEnd < 1;
})());
ok("speed zero is legal: the object may stand still", (() => {
	const stopped = envelopeDrag(flat, 0.5, 0);
	const atMid = stopped[Math.round(0.5 * (ENVELOPE_POINTS - 1))];
	return near(atMid, 0, 1e-9) && near(mean(stopped), 1, 1e-6) && stopped.every((v) => v >= 0);
})());
ok("an extreme pull floors the rest at zero and still conserves", (() => {
	const extreme = envelopeDrag(flat, 0.5, 1000);
	return near(mean(extreme), 1, 1e-6) && extreme.every((v) => v >= 0);
})());
ok("a pull past the whole budget shrinks itself to fit", (() => {
	// 4x average over a third of the span asks for more distance than exists;
	// the rest floors at zero and the bump scales down so the area holds.
	const over = envelopeDrag(flat, 0.2, 4);
	return near(mean(over), 1, 1e-6) && over[ENVELOPE_POINTS - 1] === 0;
})());

/* --- progress: time → distance --------------------------------------------- */

ok("no timing is the identity", timingProgress(null, 0.3) === 0.3);
ok("progress is pinned at both ends", (() => {
	const timing = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.2, 4)] });
	return near(timingProgress(timing, 0), 0) && near(timingProgress(timing, 1), 1, 1e-9);
})());
ok("a front-loaded envelope runs ahead of the clock", (() => {
	const timing = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.15, 4)] });
	return timingProgress(timing, 0.4) > 0.5;
})());
ok("progress is monotonic even under a wild envelope", (() => {
	let envelope = envelopeDrag(flat, 0.2, 6);
	envelope = envelopeDrag(envelope, 0.8, 5);
	envelope = envelopeDrag(envelope, 0.5, 0);
	const timing = createTiming({ cuts: [], envelopes: [envelope] });
	let previous = 0;
	for (let u = 0; u <= 1.0001; u += 0.01) {
		const d = timingProgress(timing, Math.min(1, u));
		if (d < previous - 1e-9) return false;
		previous = d;
	}
	return true;
})());

/* --- cuts are pins: segments are sealed rooms ------------------------------ */

ok("a cut pins (t, d) exactly", (() => {
	const timing = createTiming({ cuts: [{ t: 0.5, d: 0.6 }], envelopes: [] });
	return near(timingProgress(timing, 0.5), 0.6, 1e-9);
})());
ok("editing one segment never moves another", (() => {
	const before = createTiming({ cuts: [{ t: 0.5, d: 0.6 }], envelopes: [] });
	const after = {
		...before,
		envelopes: [envelopeDrag(before.envelopes[0], 0.3, 5), before.envelopes[1]],
	};
	// The pin holds…
	if (!near(timingProgress(after, 0.5), 0.6, 1e-9)) return false;
	// …and every instant PAST the pin is byte-identical to before the edit.
	for (let u = 0.5; u <= 1.0001; u += 0.01) {
		const clamped = Math.min(1, u);
		if (timingProgress(after, clamped) !== timingProgress(before, clamped)) return false;
	}
	return true;
})());

/* --- inserting and removing cuts ------------------------------------------- */

ok("inserting a cut changes nothing about the motion", (() => {
	const before = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.3, 2)] });
	const after = insertCut(before, 0.5);
	if (after.cuts.length !== 1) return false;
	for (let u = 0; u <= 1.0001; u += 0.02) {
		const clamped = Math.min(1, u);
		if (!near(timingProgress(after, clamped), timingProgress(before, clamped), 5e-3)) return false;
	}
	return true;
})());
ok("a cut lands at the motion's own position", (() => {
	const timing = insertCut(createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.2, 2)] }), 0.4);
	const cut = timing.cuts[0];
	return cut.t === 0.4 && cut.d > 0.4; // front-loaded: already past 40 %
})());
ok("a cut too near an existing one is refused", (() => {
	const timing = createTiming({ cuts: [{ t: 0.5, d: 0.5 }], envelopes: [] });
	return insertCut(timing, 0.51) === timing && insertCut(timing, 0.005) === timing;
})());
ok("removing a cut merges without moving the motion much", (() => {
	const before = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.3, 2)] });
	const withCut = insertCut(before, 0.5);
	const merged = removeCut(withCut, 0);
	if (merged.cuts.length !== 0) return false;
	for (let u = 0; u <= 1.0001; u += 0.02) {
		const clamped = Math.min(1, u);
		if (!near(timingProgress(merged, clamped), timingProgress(before, clamped), 1e-2)) return false;
	}
	return true;
})());

/* --- the path reads the timing (C2) ---------------------------------------- */

const take = { frameCount: 101, fps: 24 };
const straight = { path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] } };

ok("no timing: constant speed, midpoint at mid-take", (() => {
	const at = objectTransformAt(straight, 50, take);
	return near(at.x, 5, 1e-6);
})());
ok("a front-loaded timing runs ahead, then lands exactly at the end", (() => {
	const timing = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.15, 4)] });
	const object = { path: { ...straight.path, timing } };
	const mid = objectTransformAt(object, 50, take);
	const end = objectTransformAt(object, 100, take);
	return mid.x > 6 && near(end.x, 10, 1e-6);
})());
ok("the cut frame is pinned regardless of edits elsewhere", (() => {
	const pinned = createTiming({ cuts: [{ t: 0.5, d: 0.3 }], envelopes: [] });
	const edited = { ...pinned, envelopes: [envelopeDrag(pinned.envelopes[0], 0.2, 6), pinned.envelopes[1]] };
	const a = objectTransformAt({ path: { ...straight.path, timing: pinned } }, 50, take);
	const b = objectTransformAt({ path: { ...straight.path, timing: edited } }, 50, take);
	return near(a.x, 3, 1e-6) && near(b.x, 3, 1e-6);
})());
ok("timing rides inside a speed window", (() => {
	// 10 m at 5 m/s = 2 s = 48 frames of a 101-frame take.
	const timing = createTiming({ cuts: [], envelopes: [envelopeDrag(flat, 0.9, 4)] });
	const object = { path: { ...straight.path, speed: 5, timing } };
	const insideEarly = objectTransformAt(object, 12, take); // back-loaded: behind the clock
	const after = objectTransformAt(object, 60, take); // past the window: arrived
	return insideEarly.x < 2.5 && near(after.x, 10, 1e-6);
})());
ok("createObjectPath carries timing and survives a round-trip", (() => {
	const timing = createTiming({ cuts: [{ t: 0.5, d: 0.6 }], envelopes: [] });
	const path = createObjectPath({ points: straight.path.points, timing });
	if (!path?.timing) return false;
	const again = createObjectPath(path);
	return !!again?.timing && again.timing.cuts.length === 1 && near(again.timing.cuts[0].d, 0.6);
})());
ok("garbage timing is dropped, not crashed on", (() => {
	const path = createObjectPath({ points: straight.path.points, timing: { cuts: "no", envelopes: 3 } });
	return path !== null && (path.timing === null || path.timing === undefined ||
		(path.timing.cuts.length === 0 && path.timing.envelopes.length === 1));
})());

/* --- the camera dolly reads the same timing (C4) ---------------------------- */

const { buildRail, buildRailFollowTrack } = await import("../src/camera-follow.js");
const { createCameraBlock, updateCameraBlock } = await import("../src/camera-block.js");

const rail = buildRail([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
const still = Array.from({ length: 97 }, () => ({ x: 5, z: 6 }));

ok("without timing the dolly walks the whole rail", (() => {
	const track = buildRailFollowTrack(still, 24, rail, { railStartMode: "head" });
	return track.length === still.length && track[track.length - 1].s > rail.length * 0.9;
})());
ok("a zero first half holds the dolly, then it still arrives", (() => {
	const timing = createTiming({ cuts: [], envelopes: [envelopeDrag(flatTiming().envelopes[0], 0.2, 0, 0.4)] });
	const track = buildRailFollowTrack(still, 24, rail, { railStartMode: "head", dollyTiming: timing });
	const early = track[Math.round(track.length * 0.3)].s;
	const end = track[track.length - 1].s;
	return early < rail.length * 0.12 && end > rail.length * 0.9;
})());
ok("the dolly's cut frame is pinned like the prop's", (() => {
	const pinned = createTiming({ cuts: [{ t: 0.5, d: 0.3 }], envelopes: [] });
	const track = buildRailFollowTrack(still, 24, rail, { railStartMode: "head", dollyTiming: pinned });
	const mid = track[Math.round((track.length - 1) * 0.5)].s;
	// the spring trails its target a little; the pin is the target, not the lag
	return Math.abs(mid - rail.length * 0.3) < rail.length * 0.12;
})());
ok("the camera block carries dollyTiming and heals garbage", (() => {
	const timing = createTiming({ cuts: [{ t: 0.5, d: 0.6 }], envelopes: [] });
	const block = createCameraBlock({ mode: "rail", cameraRail: { points: [{ x: 0, z: 0 }, { x: 5, z: 0 }] }, dollyTiming: timing });
	if (!block.dollyTiming || block.dollyTiming.cuts.length !== 1) return false;
	const patched = updateCameraBlock(block, { dollyTiming: null });
	if (patched.dollyTiming !== null) return false;
	const garbage = createCameraBlock({ mode: "rail", dollyTiming: { cuts: "x", envelopes: 1 } });
	return garbage.dollyTiming === null; // flat garbage heals to null
})());

console.log(failures === 0 ? "all speed-envelope checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
