#!/usr/bin/env node
/**
 * measure-pose.mjs — how closely did a generated take hit its pinned pose?
 *
 * Compares the GLOBAL rotation of every authored joint at the pinned frame
 * against the authored pose, in degrees. Globals rather than locals because a
 * local error high in the chain is inherited by everything below it, which would
 * count one mistake many times; the global is what the viewer actually sees.
 *
 * usage: measure-pose.mjs <take.npz> <pose.npz> <frame>
 */
import { readNpz } from "./read-npz.mjs";
import { globalRotations, matMul, matTranspose } from "../../src/ardy/convert.js";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";

const [, , takePath, posePath, frameArg] = process.argv;
if (!takePath || !posePath) {
	console.error("usage: measure-pose.mjs <take.npz> <pose.npz> <frame>");
	process.exit(2);
}
const frame = Number(frameArg);

const readLocals = (members, f) => {
	const rot = members.local_rot_mats;
	const J = rot.shape.at(-3);
	const out = [];
	for (let j = 0; j < J; j += 1) {
		const base = (f * J + j) * 9;
		out.push([
			[rot.data[base], rot.data[base + 1], rot.data[base + 2]],
			[rot.data[base + 3], rot.data[base + 4], rot.data[base + 5]],
			[rot.data[base + 6], rot.data[base + 7], rot.data[base + 8]],
		]);
	}
	return out;
};

const take = readNpz(takePath);
const pose = readNpz(posePath);
const authoredIdx = pose.rotation_constraint_indices
	? Array.from(pose.rotation_constraint_indices.data, (v) => Math.round(v))
	: CSKEL27_JOINTS.map((_, i) => i);

const takeGlobals = globalRotations(readLocals(take, frame));
const poseGlobals = globalRotations(readLocals(pose, 0));

const angleBetween = (a, b) => {
	const d = matMul(matTranspose(a), b);
	const trace = d[0][0] + d[1][1] + d[2][2];
	return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
};

let sum = 0;
const rows = [];
for (const j of authoredIdx) {
	const deg = angleBetween(poseGlobals[j], takeGlobals[j]);
	sum += deg;
	rows.push({ name: CSKEL27_JOINTS[j], deg });
}
rows.sort((a, b) => b.deg - a.deg);
console.log(`pinned frame ${frame}, ${authoredIdx.length} authored joints`);
for (const r of rows) console.log(`  ${r.name.padEnd(16)} ${r.deg.toFixed(1)} deg`);
const mean = sum / authoredIdx.length;
console.log(`MEAN_ERROR_DEG=${mean.toFixed(2)}`);
console.log(`MAX_ERROR_DEG=${rows[0].deg.toFixed(2)}`);
