/**
 * compare-seam.mjs — measure what a multi-segment take does AT THE SEAM,
 * comparably across backends that run at different frame rates.
 *
 * ARDY-Core runs at 20 fps and Kimodo-SOMA at 30, so a per-FRAME root
 * displacement means different things in each file and cannot be compared
 * directly — every figure here is per SECOND.
 *
 * Two different failures are reported because they are not the same thing:
 *   - a STALL: root speed collapsing toward zero at the boundary, which is the
 *     "the motion stops between the two prompts" symptom.
 *   - a JUMP: a one-frame teleport, which is a discontinuity rather than a stall.
 */

import { readNpz } from "./read-npz.mjs";

/** Root speed per frame, in m/s. */
export function rootSpeeds(rootPos, frames, fps) {
	const speeds = [];
	for (let frame = 1; frame < frames; frame += 1) {
		const a = frame * 3;
		const b = (frame - 1) * 3;
		speeds.push(
			Math.hypot(rootPos[a] - rootPos[b], rootPos[a + 1] - rootPos[b + 1], rootPos[a + 2] - rootPos[b + 2]) * fps
		);
	}
	return speeds;
}

/**
 * @param {Float32Array} rootPos flat [frames*3]
 * @param {number} boundaryFrame first frame of the second segment
 * @param {number} windowS how far either side of the seam to look
 */
export function seamReport(rootPos, frames, fps, boundaryFrame, windowS = 0.25) {
	const speeds = rootSpeeds(rootPos, frames, fps);
	const half = Math.max(1, Math.round(windowS * fps));
	// speeds[i] is the step from frame i to i+1.
	const seamIndex = boundaryFrame - 1;
	const from = Math.max(0, seamIndex - half);
	const to = Math.min(speeds.length - 1, seamIndex + half);

	const window = speeds.slice(from, to + 1);
	const outsideBefore = speeds.slice(Math.max(0, from - half), from);
	const outsideAfter = speeds.slice(to + 1, Math.min(speeds.length, to + 1 + half));
	const surrounding = [...outsideBefore, ...outsideAfter];

	const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
	const cruise = mean(surrounding);
	const seamMin = window.length ? Math.min(...window) : 0;
	const seamMax = window.length ? Math.max(...window) : 0;

	return {
		fps,
		frames,
		boundaryFrame,
		seam_speed_at_boundary_mps: speeds[seamIndex] ?? null,
		seam_min_speed_mps: seamMin,
		seam_max_speed_mps: seamMax,
		cruise_speed_mps: cruise,
		// 1.0 = the seam keeps the surrounding pace; 0.0 = a dead stop.
		stall_ratio: cruise > 0 ? seamMin / cruise : null,
		overall_max_speed_mps: Math.max(...speeds),
		overall_mean_speed_mps: mean(speeds),
	};
}

function loadRoot(path) {
	const members = readNpz(path);
	const root = members.root_positions ?? members.smooth_root_pos;
	if (!root) throw new Error(`${path}: no root_positions member`);
	const frames = root.shape[0];
	return { rootPos: root.data, frames };
}

// Only act as a CLI when executed directly; seam-batch.mjs imports seamReport.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("compare-seam.mjs");
const [, , ...args] = process.argv;
if (!invokedDirectly) {
	// imported as a library
} else if (args.length % 3 !== 0 || args.length === 0) {
	console.error('usage: compare-seam.mjs <label> <npz> <fps> [<label> <npz> <fps> ...]');
	process.exit(2);
}

if (invokedDirectly) {
	const rows = [];
	for (let index = 0; index < args.length; index += 3) {
		const label = args[index];
		const path = args[index + 1];
		const fps = Number(args[index + 2]);
		const { rootPos, frames } = loadRoot(path);
		// Both takes here are two equal-length segments, so the seam is the middle.
		const report = seamReport(rootPos, frames, fps, Math.round(frames / 2));
		rows.push({ label, ...report });
	}

	for (const row of rows) {
		console.log(`\n=== ${row.label} ===`);
		console.log(`  ${row.frames} frames @ ${row.fps} fps  (seam at frame ${row.boundaryFrame})`);
		console.log(`  cruise speed around seam : ${row.cruise_speed_mps.toFixed(3)} m/s`);
		console.log(`  slowest speed at seam    : ${row.seam_min_speed_mps.toFixed(3)} m/s`);
		console.log(`  STALL RATIO              : ${row.stall_ratio.toFixed(3)}   (1.0 = no stall, 0.0 = dead stop)`);
		console.log(`  fastest speed at seam    : ${row.seam_max_speed_mps.toFixed(3)} m/s`);
		console.log(`  overall max / mean       : ${row.overall_max_speed_mps.toFixed(3)} / ${row.overall_mean_speed_mps.toFixed(3)} m/s`);
	}
	console.log("");
}
