#!/usr/bin/env node
/**
 * measure-waypoints.mjs - how closely did a generated take follow its authored path?
 *
 * Reports per-waypoint XZ error in metres. The take's root is translated to the
 * canonical origin the same way the constraints were authored (path anchored on
 * its first waypoint), because Kimodo generates in canonical space and the
 * bridge does not re-anchor the take to world coordinates.
 *
 * usage: measure-waypoints.mjs <npz> <appFps> <frame,x,z> [<frame,x,z> ...]
 */
import { readNpz } from "./read-npz.mjs";

const [, , npzPath, fpsArg, ...pathArgs] = process.argv;
if (!npzPath || pathArgs.length === 0) {
	console.error("usage: measure-waypoints.mjs <npz> <appFps> <frame,x,z> ...");
	process.exit(2);
}
const members = readNpz(npzPath);
const root = members.root_positions;
if (!root) throw new Error(`${npzPath}: no root_positions`);
const frames = root.shape[0];

const waypoints = pathArgs.map((a) => {
	const [frame, x, z] = a.split(",").map(Number);
	return { frame, x, z };
});
const origin = waypoints[0];
const at = (f) => {
	const i = Math.min(frames - 1, Math.max(0, f));
	return [root.data[i * 3], root.data[i * 3 + 2]];
};
const rootStart = at(waypoints[0].frame);

let worst = 0;
const rows = [];
for (const wp of waypoints) {
	const [rx, rz] = at(wp.frame);
	// both sides expressed relative to their own first-waypoint anchor
	const gotX = rx - rootStart[0];
	const gotZ = rz - rootStart[1];
	const wantX = wp.x - origin.x;
	const wantZ = wp.z - origin.z;
	const err = Math.hypot(gotX - wantX, gotZ - wantZ);
	worst = Math.max(worst, err);
	rows.push({ frame: wp.frame, want: [wantX, wantZ], got: [gotX, gotZ], error_m: err });
}
console.log(`frames=${frames}`);
for (const r of rows) {
	console.log(
		`  frame ${String(r.frame).padStart(3)}  want (${r.want[0].toFixed(2)}, ${r.want[1].toFixed(2)})  ` +
			`got (${r.got[0].toFixed(2)}, ${r.got[1].toFixed(2)})  error ${r.error_m.toFixed(3)} m`
	);
}
console.log(`WORST_ERROR_M=${worst.toFixed(4)}`);
