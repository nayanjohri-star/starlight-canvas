#!/usr/bin/env node
// Follow-camera contracts: the shot must behave like a crew — hold distance,
// survive corners without snapping, live exactly on a drawn rail, and be
// deterministic so scrubbing and Record replay the identical track.
import {
	FOLLOW_DEFAULTS,
	buildFollowTrack,
	buildRailFollowTrack,
	buildRail,
	craneHeightAt,
	followFramingFromCamera,
	railPoint,
	simplifyStroke,
	travelDirections,
} from "../src/camera-follow.js";

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

const FPS = 20;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** wrap-safe absolute yaw difference */
const yawDelta = (a, b) => {
	let d = a - b;
	while (d > Math.PI) d -= 2 * Math.PI;
	while (d < -Math.PI) d += 2 * Math.PI;
	return Math.abs(d);
};
const EPS = 1e-9;

{
	const position = { x: 3, y: 2, z: 4 };
	const automaticPitch = Math.atan2(1.35 - position.y, 5);
	const measured = followFramingFromCamera(position, automaticPitch + (10 * Math.PI) / 180, { x: 0, z: 0 });
	ok("viewport framing measures planar distance", measured.distance === 5, JSON.stringify(measured));
	ok("viewport framing measures physical lens height", measured.height === 2, JSON.stringify(measured));
	ok("viewport framing converts tilt to automatic-aim offset", measured.pitchOffsetDeg === 10, JSON.stringify(measured));
}

{
	const position = { x: 0, y: 12, z: 3 };
	const authoredPitch = (-30 * Math.PI) / 180;
	const measured = followFramingFromCamera(position, authoredPitch, { x: 0, z: 0 });
	const replayed = buildFollowTrack([{ x: 0, z: 0 }], FPS, measured)[0];
	ok(
		"a high camera preserves its authored pitch through follow measurement and replay",
		Math.abs(replayed.pitch - authoredPitch) < 0.002,
		JSON.stringify({ measured, replayedPitchDeg: (replayed.pitch * 180) / Math.PI }),
	);
}

{
const measured = followFramingFromCamera(
		{ x: 0, y: 1.6, z: 3 },
		0,
		{ x: 0, z: 0 },
		FOLLOW_DEFAULTS.aimHeight,
		{ x: 0, z: 1 },
);
ok(
	"captured camera height has no six-metre ceiling",
	followFramingFromCamera({ x: 0, y: 12, z: -3 }, 0, { x: 0, z: 0 }).height === 12,
);
	ok("viewport framing records a camera placed in front of the subject", Math.abs(measured.orbitOffsetDeg - 180) < 1e-6, JSON.stringify(measured));
}

/** straight walk down +Z at 1.4 m/s for `seconds` */
function straightWalk(seconds, speed = 1.4) {
	const frames = Math.round(seconds * FPS);
	return Array.from({ length: frames }, (_, f) => ({ x: 0, z: (speed * f) / FPS }));
}

/** walk +Z for 4 s, turn the corner, walk +X for 4 s (the corner case) */
function cornerWalk(speed = 1.4) {
	const leg = Math.round(4 * FPS);
	const track = [];
	for (let f = 0; f < leg; f += 1) track.push({ x: 0, z: (speed * f) / FPS });
	const zEnd = (speed * (leg - 1)) / FPS;
	for (let f = 1; f <= leg; f += 1) track.push({ x: (speed * f) / FPS, z: zEnd });
	return track;
}

/* ------------------------------------------------------- free follow --- */

const walk = straightWalk(8);
const free = buildFollowTrack(walk, FPS);
ok("free follow emits one sample per subject frame", free.length === walk.length);
{
	const errs = free.map((sample, frame) => Math.abs(dist(sample.pos, walk[frame]) - FOLLOW_DEFAULTS.distance));
	ok("free follow holds the requested distance exactly", Math.max(...errs) < 1e-6, `max err ${Math.max(...errs)}`);
	ok("free follow keeps the requested height", Math.abs(free[100].pos.y - FOLLOW_DEFAULTS.height) < 0.05, String(free[100].pos.y));
	ok(
		"free follow opens already composed (no slide-in at frame 0)",
		Math.abs(dist(free[0].pos, walk[0]) - FOLLOW_DEFAULTS.distance) < 0.05,
		String(dist(free[0].pos, walk[0])),
	);
	// behind means behind: for a +Z walk the camera sits at smaller z
	ok("free follow trails behind the travel direction", free[100].pos.z < walk[100].z, `cam z ${free[100].pos.z} subj z ${walk[100].z}`);
}

{
	const front = buildFollowTrack(walk, FPS, { orbitOffsetDeg: 180 });
	const errors = front.map((sample, frame) => Math.abs(dist(sample.pos, walk[frame]) - FOLLOW_DEFAULTS.distance));
	ok("front-authored follow holds the requested distance", Math.max(...errors) < 1e-6, `max err ${Math.max(...errors)}`);
	ok("front-authored follow stays in front of a +Z walk", front.every((sample, frame) => sample.pos.z > walk[frame].z), `last cam z ${front.at(-1).pos.z}`);
}

{
	const corner = cornerWalk();
	const track = buildFollowTrack(corner, FPS);
	const maxYawStep = Math.max(...track.slice(1).map((s, i) => yawDelta(s.yaw, track[i].yaw)));
	// the raw look-at (undamped) would exceed this on the corner frames
	ok(
		"corner: damped aim never snaps (max yaw step under 3°/frame)",
		maxYawStep < (3 * Math.PI) / 180,
		`${((maxYawStep * 180) / Math.PI).toFixed(2)} deg/frame`,
	);
	const errs = track.map((sample, frame) => Math.abs(dist(sample.pos, corner[frame]) - FOLLOW_DEFAULTS.distance));
	ok("corner: follow maintains exact planar distance", Math.max(...errs) < 1e-6, `max err ${Math.max(...errs)}`);
}

{
	// Follow is a framing constraint, not merely a spring target. A rapidly
	// accelerating subject must not leave the camera several metres behind.
	const accelerating = Array.from({ length: 160 }, (_, frame) => ({
		x: 0,
		z: (0.02 * frame * frame) / FPS,
	}));
	const track = buildFollowTrack(accelerating, FPS);
	const errors = track.map((sample, frame) => Math.abs(dist(sample.pos, accelerating[frame]) - FOLLOW_DEFAULTS.distance));
	ok("accelerating follow maintains exact planar distance", Math.max(...errors) < 1e-6, `max err ${Math.max(...errors)}`);
}

{
	// a pause mid-walk: the camera coasts to rest instead of orbiting
	const stopAndGo = [...straightWalk(4), ...Array.from({ length: 40 }, () => ({ x: 0, z: straightWalk(4).at(-1).z }))];
	const track = buildFollowTrack(stopAndGo, FPS);
	const tail = track.slice(-5);
	const drift = Math.max(...tail.slice(1).map((s, i) => dist(s.pos, tail[i].pos)));
	ok("a stopped subject brings the camera to rest", drift < 0.01, `tail drift ${drift.toFixed(4)} m/frame`);
}

{
	const a = buildFollowTrack(cornerWalk(), FPS);
	const b = buildFollowTrack(cornerWalk(), FPS);
	ok("the track is deterministic (same input, same output)", JSON.stringify(a) === JSON.stringify(b));
}

{
	const dirs = travelDirections(straightWalk(2), FPS);
	ok("pre-move frames already face the coming walk (probe, not snap)", Math.abs(dirs[0].z - 1) < 1e-6 && Math.abs(dirs[0].x) < 1e-6);
}

/* ------------------------------------------------------ stroke + rail --- */

{
	// a noisy straight stroke collapses to its two endpoints
	const noisy = Array.from({ length: 120 }, (_, i) => ({ x: i * 0.1, z: (i % 2) * 0.04 }));
	const simple = simplifyStroke(noisy, 0.12);
	ok("RDP collapses pointer jitter on a straight stroke", simple.length <= 4, `${simple.length} points`);
	const corner = [
		...Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, z: 0 })),
		...Array.from({ length: 50 }, (_, i) => ({ x: 5, z: (i + 1) * 0.1 })),
	];
	const simpleCorner = simplifyStroke(corner, 0.12);
	ok(
		"RDP keeps the corner point",
		simpleCorner.some((p) => Math.abs(p.x - 4.9) < 0.2 && Math.abs(p.z) < 0.2),
		JSON.stringify(simpleCorner),
	);
}

{
	const rail = buildRail([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }]);
	ok("rail measures a plausible arc length", rail.length > 7.5 && rail.length < 9.2, String(rail.length));
	ok("railPoint clamps at both ends", dist(railPoint(rail, -5), { x: 0, z: 0 }) < 1e-6 && dist(railPoint(rail, 999), { x: 4, z: 4 }) < 1e-6);
	ok("degenerate strokes yield no rail", buildRail([{ x: 1, z: 1 }]) === null && buildRail([]) === null);
}

{
	// rail alongside a straight walk: dolly follows the authored arc
	const walkLong = straightWalk(10);
	const rail = buildRail([{ x: -2.5, z: -2 }, { x: -2.5, z: 16 }]);
	const track = buildRailFollowTrack(walkLong, FPS, rail);
	ok("rail follow emits one sample per subject frame", track.length === walkLong.length);
	const onRail = track.every((s) => Math.abs(s.pos.x - -2.5) < 1e-6);
	ok("the camera never leaves the rail", onRail);
	ok("rail follow advances through the authored rail", track.at(-1).s > rail.length - 0.2, `s ${track.at(-1).s.toFixed(3)} / ${rail.length.toFixed(3)}`);
	const sSteps = track.slice(1).map((s, i) => s.s - track[i].s);
	ok(
		"the dolly respects its speed cap",
		Math.max(...sSteps.map(Math.abs)) <= 4 / FPS + 1e-6,
		`${(Math.max(...sSteps.map(Math.abs)) * FPS).toFixed(2)} m/s`,
	);
}

{
	// A rail that pulls away from a stationary subject must keep traversing.
	// Distance is a framing preference, not permission to stop the authored move.
	const stationary = Array.from({ length: 180 }, () => ({ x: 0, z: 0 }));
	const rail = buildRail([{ x: 1, z: 0 }, { x: 8, z: 0 }]);
	for (const maxDollySpeed of [FOLLOW_DEFAULTS.maxDollySpeed, 1]) {
		const track = buildRailFollowTrack(stationary, FPS, rail, { response: 0.1, maxDollySpeed });
		const sSteps = track.slice(1).map((sample, i) => sample.s - track[i].s);
		ok(
			`response 0.1 pull-out reaches the authored far end at ${maxDollySpeed} m/s`,
			track.at(-1).s > rail.length - 0.2,
			`s ${track.at(-1).s.toFixed(3)} / ${rail.length.toFixed(3)}`,
		);
		ok(
			`response 0.1 pull-out never travels backward at ${maxDollySpeed} m/s`,
			Math.min(...sSteps) >= -EPS,
			`min Δs ${Math.min(...sSteps).toFixed(6)}`,
		);
		ok(
			`response 0.1 pull-out respects the ${maxDollySpeed} m/s cap`,
			Math.max(...sSteps) <= maxDollySpeed / FPS + EPS,
			`max Δs ${(Math.max(...sSteps) * FPS).toFixed(6)} m/s`,
		);
	}
}

{
	// The actor starts beside the middle of the rail, so the two opening modes
	// have visibly different marks.
	const subject = Array.from({ length: 40 }, () => ({ x: 0, z: 5 }));
	const rail = buildRail([{ x: -2, z: 0 }, { x: -2, z: 10 }]);
	const head = buildRailFollowTrack(subject, FPS, rail);
	const nearest = buildRailFollowTrack(subject, FPS, rail, { railStartMode: "nearest" });
	const headPoint = railPoint(rail, 0);
	ok("head mode opens at exactly s=0", head[0].s === 0);
	ok("head mode frame 0 is exactly the rail head", head[0].pos.x === headPoint.x && head[0].pos.z === headPoint.z);
	ok("nearest mode preserves automatic opening placement", nearest[0].s > 1, `s ${nearest[0].s.toFixed(3)}`);
}

{
	// Jumping the subject between opposite rail ends produces the harshest
	// pursuit target changes; no frame may outrun the configured cap.
	const subject = Array.from({ length: 80 }, (_, f) => ({ x: 0, z: f % 2 ? 20 : 0 }));
	const rail = buildRail([{ x: -2, z: 0 }, { x: -2, z: 20 }]);
	for (const cap of [0.5, 2, 6]) {
		const track = buildRailFollowTrack(subject, FPS, rail, { maxDollySpeed: cap });
		const maxStep = Math.max(...track.slice(1).map((sample, i) => Math.abs(sample.s - track[i].s)));
		ok(
			`dolly cap ${cap} m/s binds before every integration`,
			maxStep <= cap / FPS + EPS,
			`${(maxStep * FPS).toFixed(6)} m/s`,
		);
	}
	const steadySubject = Array.from({ length: 40 }, () => ({ x: 0, z: 20 }));
	const slow = buildRailFollowTrack(steadySubject, FPS, rail, { maxDollySpeed: 0.5 });
	const fast = buildRailFollowTrack(steadySubject, FPS, rail, { maxDollySpeed: 6 });
	ok("a slower dolly advances less over the same frames", slow.at(-1).s < fast.at(-1).s, `${slow.at(-1).s.toFixed(2)} < ${fast.at(-1).s.toFixed(2)}`);
	ok("dolly speed does not change sample count", slow.length === fast.length && slow.length === steadySubject.length);
	ok(
		"capped rail tracks remain deterministic",
		JSON.stringify(slow) === JSON.stringify(buildRailFollowTrack(steadySubject, FPS, rail, { maxDollySpeed: 0.5 })),
	);
}

{
	const subject = straightWalk(3);
	const rail = buildRail([{ x: -2, z: 0 }, { x: -2, z: 8 }]);
	const zero = buildRailFollowTrack(subject, FPS, rail, { pitchOffsetDeg: 0 });
	const baseline = buildRailFollowTrack(subject, FPS, rail);
	const plus = buildRailFollowTrack(subject, FPS, rail, { pitchOffsetDeg: 10 });
	const minus = buildRailFollowTrack(subject, FPS, rail, { pitchOffsetDeg: -10 });
	const tenDeg = (10 * Math.PI) / 180;
	ok("zero pitch offset preserves automatic pitch", zero.every((sample, i) => Math.abs(sample.pitch - baseline[i].pitch) < EPS));
	ok("+10° pitch offset is exact", plus.every((sample, i) => Math.abs(sample.pitch - zero[i].pitch - tenDeg) < EPS));
	ok("-10° pitch offset is exact", minus.every((sample, i) => Math.abs(sample.pitch - zero[i].pitch + tenDeg) < EPS));
	ok(
		"pitch offset leaves yaw, position and rail travel unchanged",
		plus.every((sample, i) => sample.yaw === zero[i].yaw && sample.s === zero[i].s && JSON.stringify(sample.pos) === JSON.stringify(zero[i].pos)),
	);

	const highTarget = Array.from({ length: 2 }, () => ({ x: 0, z: 0 }));
	const closeRail = buildRail([{ x: -0.001, z: 0 }, { x: -0.001, z: 1 }]);
	const clamped = buildRailFollowTrack(highTarget, FPS, closeRail, { height: -10, pitchOffsetDeg: 30 });
	const oversizedOffset = buildRailFollowTrack(subject, FPS, rail, { pitchOffsetDeg: 999 });
	const maxOffset = buildRailFollowTrack(subject, FPS, rail, { pitchOffsetDeg: 170 });
	ok("pitch safety clamp stays within ±85°", clamped.every((sample) => Math.abs(sample.pitch) <= (85 * Math.PI) / 180 + EPS));
	ok("pitch input covers the full possible authored offset range", oversizedOffset.every((sample, i) => sample.pitch === maxOffset[i].pitch));

	const raised = buildRailFollowTrack(subject, FPS, rail, { height: 2.4 });
	ok("height changes rig position independently of pitch offset", raised.every((sample, i) => sample.pos.y !== plus[i].pos.y && plus[i].pos.y === zero[i].pos.y));
}

{
	// subject walks past the rail's end: s clamps, no teleport, aim keeps up
	const walkLong = straightWalk(12);
	const rail = buildRail([{ x: -2, z: 0 }, { x: -2, z: 4 }]);
	// nearest recreates the pre-head-mode opening mark; this contract isolates
	// the pinned-dolly pan behaviour from the separately tested start modes.
	const track = buildRailFollowTrack(walkLong, FPS, rail, { railStartMode: "nearest" });
	// the spring converges asymptotically, so "pinned" means within a hand's
	// width of the buffer, not bit-exact
	ok("a too-short rail pins the dolly at its end", track.at(-1).s > rail.length - 0.1, String(track.at(-1).s));
	const maxYawStep = Math.max(...track.slice(1).map((s, i) => yawDelta(s.yaw, track[i].yaw)));
	ok("panning from a pinned dolly still never snaps", maxYawStep < (3 * Math.PI) / 180, `${((maxYawStep * 180) / Math.PI).toFixed(2)} deg/frame`);
}

{
	const a = buildRailFollowTrack(cornerWalk(), FPS, buildRail([{ x: -2, z: -2 }, { x: -2, z: 8 }, { x: 8, z: 8 }]));
	const b = buildRailFollowTrack(cornerWalk(), FPS, buildRail([{ x: -2, z: -2 }, { x: -2, z: 8 }, { x: 8, z: 8 }]));
	ok("rail track is deterministic", JSON.stringify(a) === JSON.stringify(b));
}

/* ------------------------------------------------------ rail crane --- */

{
	// Legacy pin: without craneHeight the dolly holds the follow height the
	// whole way — the flat-rail contract the crane must not disturb.
	const walk = straightWalk(10);
	const rail = buildRail([{ x: -2.5, z: -2 }, { x: -2.5, z: 16 }]);
	const flat = buildRailFollowTrack(walk, FPS, rail, { height: 1.6 });
	ok("flat rail holds the follow height", flat.every((f) => Math.abs(f.pos.y - 1.6) < 1e-6), String(flat.at(-1)?.pos.y));

	// Crane: the lens height rides the dolly's own arc progress start → end.
	const crane = buildRailFollowTrack(walk, FPS, rail, { height: 1.6, craneHeight: { start: 3, end: 1.2 } });
	ok("crane opens at its start height", Math.abs(crane[0].pos.y - 3) < 1e-6, String(crane[0].pos.y));
	ok("crane lands at its end height", Math.abs(crane.at(-1).pos.y - 1.2) < 0.2, String(crane.at(-1).pos.y));
	const mid = crane[Math.floor(crane.length / 2)].pos.y;
	ok("crane passes between its marks mid-move", mid < 3 - 0.1 && mid > 1.2 + 0.05, String(mid));
	ok(
		"a descending crane never climbs back",
		crane.every((f, i) => i === 0 || f.pos.y <= crane[i - 1].pos.y + 0.02),
	);

	// start == end degenerates to the flat contract exactly.
	const level = buildRailFollowTrack(walk, FPS, rail, { height: 1.6, craneHeight: { start: 1.6, end: 1.6 } });
	ok("equal crane marks reproduce the flat rail", level.every((f, i) => Math.abs(f.pos.y - flat[i].pos.y) < 1e-6));

	// The generalized crane: N height points, monotone between marks.
	const points = { points: [{ t: 0, height: 3 }, { t: 0.5, height: 0.8 }, { t: 1, height: 2 }] };
	ok("craneHeightAt hits every mark exactly",
		Math.abs(craneHeightAt(points, 0) - 3) < 1e-9 &&
		Math.abs(craneHeightAt(points, 0.5) - 0.8) < 1e-9 &&
		Math.abs(craneHeightAt(points, 1) - 2) < 1e-9);
	ok("craneHeightAt clamps outside the arc", craneHeightAt(points, -1) === 3 && craneHeightAt(points, 2) === 2);
	ok("the profile never overshoots its marks (monotone)", (() => {
		for (let i = 0; i <= 200; i += 1) {
			const h = craneHeightAt(points, i / 200);
			if (h < 0.8 - 1e-6 || h > 3 + 1e-6) return false;
		}
		return true;
	})());
	ok("legacy two-mark cranes evaluate as the straight lerp", (() => {
		const legacy = { start: 3, end: 1.2 };
		for (let i = 0; i <= 20; i += 1) {
			const progress = i / 20;
			if (Math.abs(craneHeightAt(legacy, progress) - (3 + (1.2 - 3) * progress)) > 1e-9) return false;
		}
		return true;
	})());
	const dip = buildRailFollowTrack(walk, FPS, rail, { height: 1.6, craneHeight: points });
	ok("a point crane opens at its first mark", Math.abs(dip[0].pos.y - 3) < 1e-6, String(dip[0].pos.y));
	const dipMin = Math.min(...dip.map((f) => f.pos.y));
	ok("a point crane dips toward its low mark", dipMin < 1.15, String(dipMin));
	ok("a point crane never undershoots the low mark", dipMin > 0.8 - 0.05, String(dipMin));
	ok("a point crane rises back toward its final mark", Math.abs(dip.at(-1).pos.y - 2) < 0.25, String(dip.at(-1).pos.y));
}

console.log(failures === 0 ? "all camera-follow checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
