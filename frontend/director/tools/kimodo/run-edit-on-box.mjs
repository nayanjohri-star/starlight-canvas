#!/usr/bin/env node
/**
 * run-edit-on-box.mjs — the Kimodo twin of tools/ardy/run-edit-on-box.sh.
 *
 * Regenerates one span of an existing take and splices it back, writing a cclay
 * motion npz the bridge and app consume exactly like any other generated take.
 *
 * The final stdout line matches the shape bridge.mjs greps for:
 *   run-kimodo-edit: done - <path> (<bytes>)
 */

import { statSync } from "node:fs";
import { motionArraysToNpzMembers, replaceMotionSegment, writeNpz } from "../ardy/npz.mjs";
import { retimeMotion } from "../../src/ardy/retime.js";
import { generateOnBox } from "./generate.mjs";
import { planEditConstraints } from "./edit.mjs";
import { readNpz } from "./read-npz.mjs";

function usage(message) {
	if (message) console.error(`run-kimodo-edit: ${message}`);
	console.error(
		"usage: run-edit-on-box.mjs --source <npz> --manifest <json> --prompt <text> " +
			"[--context-before N] [--context-after N] [--seed N] [--target-fps N] --output <path>"
	);
	process.exit(2);
}

function parseArgs(argv) {
	const out = { contextBefore: 0, contextAfter: 0, targetFps: 24 };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const next = () => argv[(i += 1)];
		if (flag === "--source") out.source = next();
		else if (flag === "--manifest") out.manifest = next();
		else if (flag === "--prompt") out.prompt = next();
		else if (flag === "--context-before") out.contextBefore = Number(next());
		else if (flag === "--context-after") out.contextAfter = Number(next());
		else if (flag === "--seed") out.seed = Number(next());
		else if (flag === "--target-fps") out.targetFps = Number(next());
		else if (flag === "--output") out.output = next();
		else if (flag === "--cpu") { /* accepted for parity with the ARDY wrapper */ }
		else usage(`unknown argument ${flag}`);
	}
	for (const key of ["source", "manifest", "prompt", "output"]) {
		if (!out[key]) usage(`--${key} is required`);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

/** A written cclay motion npz back as the flat arrays replaceMotionSegment wants. */
function loadMotion(path) {
	const members = readNpz(path);
	const frames = members.local_rot_mats.shape[0];
	return {
		frames,
		fps: members.fps ? Math.round(members.fps.data[0]) : 20,
		rotMats: members.local_rot_mats.data,
		rootPos: members.root_positions.data,
		posedJoints: members.posed_joints.data,
	};
}

try {
	const genFps = Number(process.env.CCLAY_KIMODO_GEN_FPS || 30);
	const plan = planEditConstraints({
		sourcePath: args.source,
		manifestPath: args.manifest,
		contextBefore: args.contextBefore,
		contextAfter: args.contextAfter,
		genFps,
		appFps: args.targetFps,
	});

	const source = loadMotion(args.source);
	const durationS = source.frames / source.fps;

	// Which pinning the author's own keys got (contract C5). planEditConstraints
	// owns the decision — every edited track maps to a limb chain, or nothing does
	// — and it is announced BEFORE the GPU is booked, because it is the difference
	// between "this edit moved an arm" and "this edit froze the body", and a take
	// that came out over-pinned should be diagnosable from the run log alone.
	console.log(
		`run-kimodo-edit: constraints=${plan.constraintMode} for ${plan.poses.length} pinned frame(s)` +
			`${plan.editedTracks.length > 0 ? ` (edited tracks: ${plan.editedTracks.join(", ")})` : ""}` +
			`${plan.constraintMode === "effector" ? "; context anchors stay fullbody" : ""}`
	);

	// One prompt over the whole clip, constrained to the source on both sides of
	// the edit. generateOnBox takes poses already in app frame space and rescales
	// them itself, so the plan's poses — anchors and author keys, each tagged with
	// its `kind` — are handed over rather than the plan's already-scaled
	// constraints: the generator resolves the generation clock from the duration it
	// is about to request, and scaling the same frames twice against two clocks is
	// how the pins would drift off the take.
	const { motion, raw } = await generateOnBox({
		segments: [{ prompt: args.prompt, duration: durationS }],
		poses: plan.poses,
		effectorTracks: plan.constraintMode === "effector" ? plan.editedTracks : null,
		appFps: args.targetFps,
		seed: args.seed,
		onLine: (line) => console.log(line),
	});

	const sourceFps = Math.round(raw.frames / durationS);
	const retimed = retimeMotion({ ...motion, fps: sourceFps }, source.fps);

	// Keep ONLY the edited span; everything else stays the author's take.
	const span = plan.endFrame - plan.startFrame;
	if (retimed.frames < plan.endFrame) {
		throw new Error(`regenerated take has ${retimed.frames} frames, need at least ${plan.endFrame}`);
	}
	const replacement = {
		frames: span,
		fps: retimed.fps,
		rotMats: retimed.rotMats.slice(plan.startFrame * 27 * 9, plan.endFrame * 27 * 9),
		rootPos: retimed.rootPos.slice(plan.startFrame * 3, plan.endFrame * 3),
		posedJoints: retimed.posedJoints.slice(plan.startFrame * 27 * 3, plan.endFrame * 27 * 3),
	};
	const edited = replaceMotionSegment(source, replacement, plan.startFrame);

	writeNpz(args.output, motionArraysToNpzMembers(edited));
	console.log(
		JSON.stringify({
			frames: edited.frames,
			fps: edited.fps,
			// Field names match ARDY's cclay_motion_edit.py report: the bridge's
			// tryParseReport recognizes a motion-edit report only by edit_range +
			// history_range + future_range and silently drops anything else — which
			// left the App without commit verification and the new take uninstalled.
			edit_range: [plan.startFrame, plan.endFrame],
			history_range: [Math.max(0, plan.startFrame - (args.contextBefore || 0)), plan.startFrame],
			future_range: [plan.endFrame, Math.min(edited.frames, plan.endFrame + (args.contextAfter || 0))],
			constraints: plan.constraints.length,
			pinned_frames: plan.constraints[0]?.frame_indices?.length ?? 0,
			// "effector" = the author's keys pinned only their limb chains (+ hips
			// and the root, which Kimodo's EE sets pin unconditionally); "fullbody" =
			// round 1's whole-body pin. Context anchors are fullbody either way.
			constraint_mode: plan.constraintMode,
			// The bridge/App commit contract is backend-neutral. Kimodo's
			// constrained splice has completed successfully at this point, so
			// report the authored source-frame keys that were carried through.
			committed_keys: plan.poses
				.filter((entry) => entry.frame >= plan.startFrame && entry.frame < plan.endFrame)
				.map((entry) => entry.frame),
			commit_verified: true,
		})
	);
	const { size } = statSync(args.output);
	console.log(`run-kimodo-edit: done - ${args.output} (${size} bytes)`);
} catch (error) {
	console.error(`run-kimodo-edit: ${error.message}`);
	process.exit(1);
}
