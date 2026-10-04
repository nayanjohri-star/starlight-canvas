import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { writeNpz, motionArraysToNpzMembers, poseArraysToNpzMembers } from "../tools/ardy/npz.mjs";
import { parseEditManifest, planEditConstraints } from "../tools/kimodo/edit.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const work = mkdtempSync(join(tmpdir(), "cclay-edit-"));

/** A source take whose every frame is distinguishable by its root Z. */
function writeSourceTake(path, frames, fps = 20) {
	const rotMats = new Float32Array(frames * 27 * 9);
	const posedJoints = new Float32Array(frames * 27 * 3);
	const rootPos = new Float32Array(frames * 3);
	for (let f = 0; f < frames; f += 1) {
		for (let j = 0; j < 27; j += 1) {
			const b = (f * 27 + j) * 9;
			rotMats[b] = 1; rotMats[b + 4] = 1; rotMats[b + 8] = 1;
			posedJoints[(f * 27 + j) * 3 + 1] = 1 - j * 0.01;
			posedJoints[(f * 27 + j) * 3 + 2] = f * 0.1; // frame-identifying
		}
		rootPos[f * 3 + 1] = 0.95;
		rootPos[f * 3 + 2] = f * 0.1;
	}
	writeNpz(path, motionArraysToNpzMembers({ frames, fps, rotMats, rootPos, posedJoints }));
	return { frames, fps };
}

function writePoseNpz(path) {
	writeNpz(
		path,
		poseArraysToNpzMembers({
			local_rot_mats: CSKEL27_JOINTS.map(() => IDENTITY.map((r) => r.slice())),
			posed_joints: CSKEL27_JOINTS.map((_, i) => [0, 1 - i * 0.01, 0]),
		})
	);
}

try {
	const sourcePath = join(work, "source.npz");
	writeSourceTake(sourcePath, 120);
	const posePath = join(work, "pose-0.npz");
	writePoseNpz(posePath);

	const manifestPath = join(work, "edit-manifest.json");
	const manifest = {
		start_frame: 40,
		end_frame: 80,
		edits: [{ frame: 60, tracks: ["LeftArm"], root: [0, 0.95, 6], pose_path: "pose-0.npz" }],
	};
	writeFileSync(manifestPath, JSON.stringify(manifest));

	// ---- manifest parsing -------------------------------------------------
	{
		const parsed = parseEditManifest(manifestPath);
		assert.equal(parsed.startFrame, 40);
		assert.equal(parsed.endFrame, 80);
		assert.equal(parsed.edits.length, 1);
		assert.equal(parsed.edits[0].frame, 60);
		// pose_path is relative to the manifest, and must resolve next to it
		assert.ok(parsed.edits[0].posePath.endsWith("pose-0.npz"));
		assert.ok(parsed.edits[0].posePath.startsWith(work), "pose path must resolve beside the manifest");
		pass("the edit manifest parses into a resolved plan");
	}

	// ---- context anchors come from the SOURCE, on both sides -------------
	// The regenerated span has to rejoin the take it came from, so the frames
	// just before and just after the range are pinned from the source motion.
	{
		const plan = planEditConstraints({
			sourcePath,
			manifestPath,
			contextBefore: 4,
			contextAfter: 4,
			genFps: 20,
			appFps: 20,
		});
		const frames = plan.constraints[0].frame_indices;
		assert.ok(frames.includes(60), "the authored edit frame must be constrained");
		// anchors before the range and after it
		assert.ok(frames.some((f) => f < 40), `expected an anchor before frame 40, got ${frames}`);
		assert.ok(frames.some((f) => f >= 80), `expected an anchor at/after frame 80, got ${frames}`);
		assert.deepEqual([...frames].sort((a, b) => a - b), frames, "frame_indices must be ascending");
		assert.equal(new Set(frames).size, frames.length, "frame_indices must be unique");
		assert.equal(plan.constraints[0].local_joints_rot.length, frames.length);
		assert.equal(plan.constraints[0].local_joints_rot[0].length, 77, "constraints ride on somaskel77");
		assert.equal(plan.constraints[0].root_positions.length, frames.length);
		pass("context anchors are taken from the source on both sides of the range");
	}

	// ---- an anchor must carry the SOURCE pose, not the edit --------------
	{
		const plan = planEditConstraints({
			sourcePath, manifestPath, contextBefore: 2, contextAfter: 2, genFps: 20, appFps: 20,
		});
		const frames = plan.constraints[0].frame_indices;
		const roots = plan.constraints[0].root_positions;
		const anchorBefore = frames.findIndex((f) => f < 40);
		assert.ok(anchorBefore >= 0);
		// the synthetic source puts root Z at frame*0.1
		const expectedZ = frames[anchorBefore] * 0.1;
		assert.ok(
			Math.abs(roots[anchorBefore][2] - expectedZ) < 1e-4,
			`anchor root must come from the source frame (want z=${expectedZ}, got ${roots[anchorBefore][2]})`
		);
		pass("a context anchor carries the source motion's own pose at that frame");
	}

	// ---- range touching the clip edges -----------------------------------
	{
		const edgeManifest = join(work, "edge.json");
		writeFileSync(
			edgeManifest,
			JSON.stringify({ start_frame: 0, end_frame: 30, edits: [{ frame: 10, tracks: ["Hips"], root: [0, 0.9, 1], pose_path: "pose-0.npz" }] })
		);
		const plan = planEditConstraints({
			sourcePath, manifestPath: edgeManifest, contextBefore: 8, contextAfter: 8, genFps: 20, appFps: 20,
		});
		const frames = plan.constraints[0].frame_indices;
		assert.ok(frames.every((f) => f >= 0), "a range at frame 0 must not produce negative anchors");
		assert.ok(frames.includes(10));
		pass("a range touching frame 0 clamps its anchors instead of going negative");
	}

	// ---- malformed manifests refuse by name ------------------------------
	{
		const bad = (obj, re) => {
			const p = join(work, `bad-${Math.random().toString(36).slice(2)}.json`);
			writeFileSync(p, JSON.stringify(obj));
			assert.throws(() => parseEditManifest(p), re);
		};
		bad({ end_frame: 10, edits: [] }, /start_frame/);
		bad({ start_frame: 5, edits: [] }, /end_frame/);
		bad({ start_frame: 10, end_frame: 5, edits: [{ frame: 1, pose_path: "p.npz" }] }, /range/i);
		bad({ start_frame: 0, end_frame: 10, edits: [] }, /edits/);
		bad(
			{ start_frame: 0, end_frame: 40, edits: [{ frame: 20, pose_path: "a.npz" }, { frame: 10, pose_path: "b.npz" }] },
			/ascending/i
		);
		bad({ start_frame: 0, end_frame: 40, edits: [{ frame: 5 }] }, /pose_path/);
		pass("malformed manifests are refused by name");
	}

	// ---- an edit outside its own range is refused ------------------------
	{
		const p = join(work, "outside.json");
		writeFileSync(
			p,
			JSON.stringify({ start_frame: 40, end_frame: 80, edits: [{ frame: 95, tracks: ["Hips"], pose_path: "pose-0.npz" }] })
		);
		assert.throws(() => parseEditManifest(p), /outside|range/i);
		pass("an edit keyframe outside the edited range is refused");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log("OK verify-kimodo-edit");
