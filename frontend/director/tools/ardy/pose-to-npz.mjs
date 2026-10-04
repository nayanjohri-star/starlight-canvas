#!/usr/bin/env node
/**
 * CozyClayPoseV1 -> a one-frame ARDY pose npz.
 *
 * `cclay_constrained_generate.load_poses` reads exactly two arrays out of a pose
 * source, `local_rot_mats` and `posed_joints`, and its docstring is blunt about
 * why the file has to exist at all: "A FullBodyConstraintSet needs all 27
 * joints, so the pose has to come from an existing npz -- 27 rotations are not
 * authorable by hand." CozyClay authors 19 of them. This fills the remaining 8
 * with identity (ARDY rest) and says so out loud rather than pretending the
 * whole skeleton was blocked.
 *
 * Proportions and root come from the base clip's own reference frame, never from
 * a hardcoded rest skeleton -- same reasoning as
 * `motion_constraints.derive_bone_offsets`, which derives offsets from the clip
 * so it stays correct if ARDY ever reproportions cskel27.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { poseToCskel27 } from "../../src/ardy/to-cskel27.js";
import { poseArraysToNpzMembers, writeNpz } from "./npz.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = resolve(HERE, "../..");

function usage(message) {
	if (message) process.stderr.write(`pose-to-npz: ${message}\n\n`);
	process.stderr.write(
		`usage: pose-to-npz.mjs <pose.json> [--reference <frame.json>] [--rest <rest.json>] [--out <npz>]\n\n` +
		`  <pose.json>   a CozyClayPoseV1 export from the app\n` +
			`  --reference   optional ardy.frame.v1 skeleton-proportion reference; placement always\n` +
			`                comes from pose.root or the floor-aligned canonical neutral skeleton.\n` +
			`  --rest        cskel27 rest rotations (default public/ardy/cskel27-rest.json)\n` +
			`  --out         destination npz (default tools/ardy/out/<pose-basename>.npz)\n`,
	);
	process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) usage();

let posePath = "";
let referencePath = "";
let restPath = resolve(REPO, "public/ardy/cskel27-rest.json");
let outPath = "";
for (let i = 0; i < argv.length; i += 1) {
	const a = argv[i];
	const next = () => {
		if (i + 1 >= argv.length) usage(`${a} needs a value`);
		i += 1;
		return argv[i];
	};
	if (a === "--reference") referencePath = next();
	else if (a === "--rest") restPath = next();
	else if (a === "--out") outPath = next();
	else if (a.startsWith("-")) usage(`unknown option ${a}`);
	else if (!posePath) posePath = a;
	else usage(`unexpected argument ${a}`);
}
if (!posePath) usage("missing <pose.json>");

const readJson = (p, label) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (error) {
		process.stderr.write(`pose-to-npz: cannot read ${label} at ${p}: ${error.message}\n`);
		process.exit(1);
	}
};

const pose = readJson(posePath, "pose");
const rest = readJson(restPath, "rest table");
const reference = referencePath ? readJson(referencePath, "reference frame") : undefined;

if (reference && reference.schema !== "ardy.frame.v1") {
	process.stderr.write(`pose-to-npz: --reference must be schema ardy.frame.v1, got ${reference.schema}\n`);
	process.exit(1);
}

if (!outPath) {
	outPath = resolve(REPO, "tools/ardy/out", `${basename(posePath).replace(/\.json$/i, "")}.npz`);
}

let result;
try {
	result = poseToCskel27({ pose, rest, reference });
} catch (error) {
	process.stderr.write(`pose-to-npz: ${error.message}\n`);
	process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeNpz(outPath, poseArraysToNpzMembers(result));

const root = result.posed_joints[0];
process.stdout.write(
	`pose-to-npz: wrote ${outPath}\n` +
		`pose-to-npz: rig ${pose.source?.rig ?? "unknown"}, slate ${JSON.stringify(pose.slate ?? "")}\n` +
		(reference
			? `pose-to-npz: skeleton proportions from ${reference.source_npz} frame ${reference.frame}\n`
			: `pose-to-npz: skeleton proportions from floor-aligned canonical neutral\n`) +
		`pose-to-npz: root [${root.map((v) => v.toFixed(4)).join(", ")}]\n` +
		`pose-to-npz: ${result.filled_identity.length} joint(s) left at ARDY rest: ` +
		`${result.filled_identity.map((f) => f.joint).join(", ")}\n` +
		`pose-to-npz: --pose-from pins full-body shape, root XYZ, and heading at its destination frame\n`,
);
