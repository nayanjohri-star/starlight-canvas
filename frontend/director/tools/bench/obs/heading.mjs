/**
 * heading.mjs — remove GVHMR's short front/back yaw-flip runs from a SMPL
 * global_orient series before temporal smoothing.
 *
 * On the faceless mannequin ViTPose swaps left/right for 1-8 frames, so the
 * raw global_orient turns 97-178 deg about world vertical in one frame (or two
 * or three) and turns back later. body_pose and pelvis do not flip. Gaussian
 * smoothing then smears each such run into a visible spin, so the runs are
 * removed here first.
 *
 * Mechanism:
 *  1. Heading = twist of global_orient about world +Y (swing-twist
 *     decomposition). Pre-multiplying a world Ry(a) shifts it by exactly a
 *     and leaves the swing (tilt) unchanged.
 *  2. Jump events = maximal clusters of consecutive frames whose yaw step
 *     exceeds minJumpDeg/2, kept when the cluster's net yaw exceeds
 *     minJumpDeg. A flip spread over 2-3 transitional frames is one event.
 *  3. Paired runs: an entry event followed within maxRunFrames by the events
 *     whose summed yaw returns within minJumpDeg of zero. The run is every
 *     frame from the first frame of the entry event up to the frame before
 *     the last frame of the exit event.
 *  4. Each run frame t is corrected by Ry(-offset(t)). offset(t) is the
 *     summed measured jump yaw up to t, not a fixed 180. Any exit mismatch r
 *     (flips that are not exactly opposite) is spread linearly over the
 *     run, so both joins step by only r/(L+1).
 *  5. An unpaired event within maxRunFrames of the clip start or end marks
 *     a run touching frame 0 or the last frame. It is corrected toward the
 *     stable side when that side is longer than the run.
 *  6. A flip spread over several frames leaves mid-flip frames that match
 *     neither heading. Their tilt is corrupted too (walk f24 tilts 33 deg
 *     against 8-12 deg neighbours). These frames only (event frames before
 *     the event's last frame, inside a run) are replaced by a slerp between
 *     their corrected neighbours. Every other run frame gets the yaw-only
 *     correction and keeps its tilt.
 * Frames outside runs are returned as copies of their input values.
 */

import { axisAngleToMatrix, matrixToAxisAngle } from "./extrinsics.mjs";

const DEG = 180 / Math.PI;

/** Wrap degrees into [-180, 180). */
const wrapDeg = (a) => a - 360 * Math.floor((a + 180) / 360);

/** Twist of an axis-angle rotation about world +Y, degrees. */
export function worldYawDeg(aa) {
	const theta = Math.hypot(aa[0], aa[1], aa[2]);
	const qw = Math.cos(theta / 2);
	const qy = theta > 1e-12 ? (aa[1] / theta) * Math.sin(theta / 2) : aa[1] / 2;
	return wrapDeg(2 * Math.atan2(qy, qw) * DEG);
}

function mul3(a, b) {
	const o = new Array(9);
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
	return o;
}

function slerpAA(a, b, f) {
	const A = axisAngleToMatrix(a);
	const At = [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
	const rel = matrixToAxisAngle(mul3(At, axisAngleToMatrix(b)));
	return matrixToAxisAngle(mul3(A, axisAngleToMatrix(rel.map((v) => v * f))));
}

function preRotateY(aa, deg) {
	const a = deg / DEG, c = Math.cos(a), s = Math.sin(a);
	const m = axisAngleToMatrix(Array.from(aa));
	// Ry(a) * m, Ry = [c 0 s; 0 1 0; -s 0 c]
	return matrixToAxisAngle([
		c * m[0] + s * m[6], c * m[1] + s * m[7], c * m[2] + s * m[8],
		m[3], m[4], m[5],
		-s * m[0] + c * m[6], -s * m[1] + c * m[7], -s * m[2] + c * m[8],
	]);
}

/**
 * @param {ArrayLike<number>[]} orientAA  [T] axis-angle global_orient (world, +Y up)
 * @param {{ maxRunFrames?: number, minJumpDeg?: number }} [options]
 * @returns {{ orient: number[][], runs: { start: number, end: number, yawDeg: number }[] }}
 */
export function unwrapHeadingFlips(orientAA, { maxRunFrames = 12, minJumpDeg = 60 } = {}) {
	const T = orientAA.length;
	const yaw = Array.from(orientAA, worldYawDeg);
	const d = yaw.map((y, t) => (t ? wrapDeg(y - yaw[t - 1]) : 0));

	const events = [];
	for (let t = 1; t < T;) {
		if (!(Math.abs(d[t]) > minJumpDeg / 2)) { t++; continue; }
		let e = t, sum = 0;
		while (e < T && Math.abs(d[e]) > minJumpDeg / 2) sum += d[e++];
		if (Math.abs(wrapDeg(sum)) > minJumpDeg) events.push({ first: t, last: e - 1, sum: wrapDeg(sum), used: false });
		t = e;
	}
	// Summed wrapped steps over every event frame in [from, to].
	const eventYaw = (from, to) => {
		let s = 0;
		for (const ev of events) for (let k = Math.max(ev.first, from); k <= Math.min(ev.last, to); k++) s += d[k];
		return s;
	};

	// runs: { start, end, yawDeg, offset(t) }
	let runs = [];
	outer: for (let i = 0; i < events.length; i++) {
		let net = events[i].sum;
		for (let j = i + 1; j < events.length; j++) {
			const start = events[i].first, end = events[j].last - 1;
			if (end - start + 1 > maxRunFrames) break;
			net += events[j].sum;
			if (Math.abs(wrapDeg(net)) < minJumpDeg) {
				const L = end - start + 1, r = wrapDeg(eventYaw(start, events[j].last));
				runs.push({ start, end, yawDeg: events[i].sum, offset: (t) => eventYaw(start, t) - (r * (t - start + 1)) / (L + 1) });
				for (let k = i; k <= j; k++) events[k].used = true;
				i = j;
				continue outer;
			}
		}
	}

	const unpaired = events.filter((ev) => !ev.used);
	const head = unpaired.filter((ev) => ev.last <= maxRunFrames).pop();
	if (head) {
		const next = events.find((ev) => ev.first > head.last);
		if ((next ? next.first : T) - head.last > head.last) {
			const end = head.last - 1;
			runs = runs.filter((run) => run.start > end);
			runs.unshift({ start: 0, end, yawDeg: wrapDeg(-eventYaw(0, head.last)), offset: (t) => -eventYaw(t + 1, head.last) });
			head.used = true;
		}
	}
	const tail = unpaired.find((ev) => !ev.used && T - ev.first <= maxRunFrames);
	if (tail) {
		const prev = events.filter((ev) => ev.last < tail.first).pop();
		const start = tail.first;
		if (start - (prev ? prev.last : 0) > T - start) {
			runs = runs.filter((run) => run.end < start);
			runs.push({ start, end: T - 1, yawDeg: wrapDeg(eventYaw(start, T - 1)), offset: (t) => eventYaw(start, t) });
		}
	}

	const orient = Array.from(orientAA, (aa) => Array.from(aa));
	for (const run of runs) for (let t = run.start; t <= run.end; t++) orient[t] = preRotateY(orientAA[t], -run.offset(t));
	for (const run of runs) {
		for (const ev of events) {
			if (ev.last - ev.first < 1 || ev.first > run.end + 1 || ev.last < run.start) continue;
			const lo = ev.first - 1, hi = ev.last;
			for (let k = Math.max(ev.first, run.start); k <= Math.min(ev.last - 1, run.end); k++) orient[k] = slerpAA(orient[lo], orient[hi], (k - lo) / (hi - lo));
		}
	}
	return { orient, runs: runs.map(({ start, end, yawDeg }) => ({ start, end, yawDeg: Math.round(yawDeg * 10) / 10 })) };
}
