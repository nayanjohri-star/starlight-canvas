// take.js — bake a raw landmark track into the exact motion shape the npz
// decoder returns ({ frames, fps, rotMats, rootPos, posedJoints }), so the
// existing timeline playback consumes an extracted take with zero new
// playback code. This is deliberately NOT an ARDY surface: the take is a
// measurement of the footage, and the generator is never in the loop.

import { CSKEL27_JOINTS } from "../ardy/cskel27.js";
import { poseToCskel27 } from "../ardy/to-cskel27.js";
import { fitLandmarksToPose } from "./fit.js";
import { filterLandmarkTrack, normalizeLandmarkTrack } from "./landmarks.js";

/**
 * `samples` are raw `{ timeS, landmarks }` from collectLandmarkTrack on the
 * uniform `fps` grid, holes allowed — detection loses the person for a frame
 * without warning. Holes hold the previous baked frame and the leading hole
 * backfills from the first fitted one: a previs take must never cut to
 * T-pose because one frame missed. `fitted`/`held` in the result say exactly
 * how much of the take was measured versus held.
 *
 * `releasedBones`/`confidence` carry the fit diagnostics out to the UI, which
 * is the only place that can tell the user why part of a pose did not move.
 * A bone is reported released only when EVERY fitted frame released it: a bone
 * the footage found even once was measured, and warning about it would be a
 * lie. `confidence` is the mean over fitted frames so one bad frame in a long
 * take cannot alone push the take under a warning threshold.
 */
export function bakeExtractedTake({ samples, rest, fps, durationS, ...options }) {
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error("bakeExtractedTake: fps must be a positive finite number");
	}
	if (!Number.isFinite(durationS) || durationS <= 0) {
		throw new Error("bakeExtractedTake: durationS must be a positive finite number");
	}
	const normalized = normalizeLandmarkTrack(samples, options);
	const filtered = filterLandmarkTrack(normalized, options.filter);
	const joints = CSKEL27_JOINTS.length;
	// Same counting rule as frameCountFor: the frame at t=0 plus every whole
	// frame inside the duration, so take length and timeline length agree.
	const frames = Math.max(1, Math.floor(durationS * fps + 1e-6) + 1);
	const rotMats = new Float32Array(frames * joints * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * joints * 3);

	const fitByFrame = new Map();
	let fitted = 0;
	// Held in fit order, then narrowed frame by frame, so the reported names keep
	// the skeleton's own ordering instead of Set insertion order.
	let releasedBones = null;
	let confidenceSum = 0;
	for (const sample of filtered) {
		if (!sample.valid) continue;
		const frame = Math.round(sample.timeS * fps);
		if (frame < 0 || frame >= frames) continue;
		const fit = fitLandmarksToPose({ sample, rest, createdMs: options.createdMs ?? 0 });
		fitByFrame.set(frame, poseToCskel27({ pose: fit.pose, rest }));
		const released = new Set(fit.releasedBones);
		releasedBones = releasedBones === null
			? [...fit.releasedBones]
			: releasedBones.filter((name) => released.has(name));
		confidenceSum += fit.confidence;
		fitted += 1;
	}
	if (fitted === 0) throw new Error("no-usable-pose");
	const confidence = confidenceSum / fitted;

	const writeFrame = (frame, converted) => {
		const rotBase = frame * joints * 9;
		const jointBase = frame * joints * 3;
		for (let j = 0; j < joints; j += 1) {
			const m = converted.local_rot_mats[j];
			const o = rotBase + j * 9;
			rotMats[o] = m[0][0]; rotMats[o + 1] = m[0][1]; rotMats[o + 2] = m[0][2];
			rotMats[o + 3] = m[1][0]; rotMats[o + 4] = m[1][1]; rotMats[o + 5] = m[1][2];
			rotMats[o + 6] = m[2][0]; rotMats[o + 7] = m[2][1]; rotMats[o + 8] = m[2][2];
			const p = converted.posed_joints[j];
			posedJoints[jointBase + j * 3] = p[0];
			posedJoints[jointBase + j * 3 + 1] = p[1];
			posedJoints[jointBase + j * 3 + 2] = p[2];
		}
		rootPos[frame * 3] = converted.posed_joints[0][0];
		rootPos[frame * 3 + 1] = converted.posed_joints[0][1];
		rootPos[frame * 3 + 2] = converted.posed_joints[0][2];
	};

	let last = null;
	let held = 0;
	const leading = [];
	for (let frame = 0; frame < frames; frame += 1) {
		const converted = fitByFrame.get(frame) ?? null;
		if (converted) last = converted;
		if (!last) {
			leading.push(frame);
			continue;
		}
		if (!converted) held += 1;
		writeFrame(frame, last);
	}
	if (leading.length > 0) {
		const first = fitByFrame.get(Math.min(...fitByFrame.keys()));
		for (const frame of leading) writeFrame(frame, first);
		held += leading.length;
	}
	return { frames, fps, rotMats, rootPos, posedJoints, fitted, held, releasedBones, confidence };
}

// A still has no duration to sample, so the take is one frame wide. Any
// duration under one second at 1 fps produces exactly that single frame under
// bakeExtractedTake's own counting rule; naming it here keeps the constant
// from reading as an arbitrary number at the call site.
const STILL_FPS = 1;
const STILL_DURATION_S = 0.5;

/**
 * Bake the one landmark sample a photograph yields into the same motion shape
 * playback consumes, so a still is posed through the take path that footage
 * already proves. The sample is pinned to t=0: a still has no timeline, and a
 * stray timestamp would otherwise bake a held frame instead of a measured one.
 */
export function bakePoseFrame({ samples, rest, ...options }) {
	const list = Array.isArray(samples) ? samples : [];
	// A still that detected nobody is the same outcome as a clip that never
	// fitted a frame, so it fails by that name rather than as a shape error.
	if (list.length === 0) throw new Error("no-usable-pose");
	return bakeExtractedTake({
		samples: list.slice(0, 1).map((sample) => ({ ...sample, timeS: 0 })),
		rest,
		fps: STILL_FPS,
		durationS: STILL_DURATION_S,
		...options,
	});
}
