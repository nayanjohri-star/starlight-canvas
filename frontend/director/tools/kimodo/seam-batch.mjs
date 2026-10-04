/**
 * seam-batch.mjs — aggregate seam behaviour over several seeds so the ARDY vs
 * Kimodo comparison rests on a distribution rather than one lucky sample.
 *
 * Everything is per SECOND because the two backends run at different frame
 * rates (ARDY-Core 20 fps, Kimodo-SOMA 30 fps).
 *
 * usage: seam-batch.mjs <label> <fps> <glob-dir> <prefix> [...]
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readNpz } from "./read-npz.mjs";
import { seamReport } from "./compare-seam.mjs";

function stats(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return {
		n: values.length,
		mean,
		median: sorted[Math.floor(sorted.length / 2)],
		min: sorted[0],
		max: sorted[sorted.length - 1],
	};
}

function collect(dir, prefix, fps, boundaryFraction) {
	const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".npz"));
	const rows = [];
	for (const file of files.sort()) {
		const members = readNpz(join(dir, file));
		const root = members.root_positions ?? members.smooth_root_pos;
		if (!root) continue;
		const frames = root.shape[0];
		const report = seamReport(root.data, frames, fps, Math.round(frames * boundaryFraction));
		rows.push({ file, ...report });
	}
	return rows;
}

const [, , ...args] = process.argv;
// label fps dir prefix boundaryFraction
const groups = [];
for (let i = 0; i < args.length; i += 5) {
	groups.push({
		label: args[i],
		fps: Number(args[i + 1]),
		dir: args[i + 2],
		prefix: args[i + 3],
		boundaryFraction: Number(args[i + 4]),
	});
}

for (const group of groups) {
	const rows = collect(group.dir, group.prefix, group.fps, group.boundaryFraction);
	if (rows.length === 0) {
		console.log(`\n=== ${group.label} === (no files matched ${group.prefix} in ${group.dir})`);
		continue;
	}
	const stall = stats(rows.map((r) => r.stall_ratio));
	const cruise = stats(rows.map((r) => r.cruise_speed_mps));
	const seamMin = stats(rows.map((r) => r.seam_min_speed_mps));
	console.log(`\n=== ${group.label} ===  (${rows.length} takes @ ${group.fps} fps)`);
	console.log(
		`  STALL RATIO   mean ${stall.mean.toFixed(3)}  median ${stall.median.toFixed(3)}  min ${stall.min.toFixed(3)}  max ${stall.max.toFixed(3)}`
	);
	console.log(`  cruise m/s    mean ${cruise.mean.toFixed(3)}`);
	console.log(`  seam min m/s  mean ${seamMin.mean.toFixed(3)}`);
	for (const row of rows) {
		console.log(
			`    ${row.file.padEnd(24)} stall ${row.stall_ratio.toFixed(3)}  cruise ${row.cruise_speed_mps.toFixed(2)}  seammin ${row.seam_min_speed_mps.toFixed(2)}`
		);
	}
}
console.log("");
