import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { matMul, matToQuat, matTranspose } from "../src/ardy/convert.js";
import { slerpQuat } from "../src/ardy/retime.js";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { main as fitMain, parseArgs } from "../tools/bench/fit-bench.mjs";
import { incamPlan } from "../tools/bench/fit/remote.mjs";
import { axisAngleMatrix, cameraToWorld, registerCamera } from "../tools/bench/fit/camera.mjs";
import { boxPenetration, fitContacts, resolveScene, segmentPenetratesBox, validateBoxes } from "../tools/bench/fit/contact.mjs";
import { fitBody, jointsAt, matVec, readEndpoints, readMat, readMotion, regenerateJoints, sub, vec } from "../tools/bench/fit/motion.mjs";
import { pinEndpoints } from "../tools/bench/fit/pin.mjs";

let checks = 0;
function close(actual, expected, tolerance = 2e-5) {
	assert.equal(actual.length, expected.length);
	actual.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) <= tolerance, `${i}: ${x} != ${expected[i]}`)); checks++;
}
function fixture(n = 25) {
	const motion = { frames: n, fps: 24, rotMats: new Float32Array(n * 243), rootPos: new Float32Array(n * 3), posedJoints: new Float32Array(n * 81), boneScale: new Float32Array(27).fill(1), personScale: 1 };
	for (let f = 0; f < n; f++) {
		for (let j = 0; j < 27; j++) motion.rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (f * 27 + j) * 9);
		motion.rootPos.set([f * .002, .9544128, 0], f * 3);
	}
	return regenerateJoints(motion);
}
function archive(data, shape) { return { data: Float32Array.from(data), shape }; }

// Known OpenCV extrinsics invert y-down/z-forward correctly with a nontrivial
// camera rotation and translation; also catches row/column major confusion.
const rotation = axisAngleMatrix([0.2, -0.5, .1]), position = [2, 3, 8];
const translation = matVec(rotation, position.map(x => -x));
const camera = { static: true, fx: 777, fy: 777, worldToCamera: [...rotation.map((r, i) => [...r, translation[i]]), [0, 0, 0, 1]] };
const inverse = cameraToWorld(camera);
close(inverse.rotation.flat(), matTranspose(rotation).flat()); close(inverse.translation, position);
assert.throws(() => cameraToWorld({ ...camera, static: false }));
assert.throws(() => cameraToWorld({ static: true, worldToCamera: [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }));
const motion = fixture(), before = motion.posedJoints.slice();
const desiredRoot = [4, 1, -2], cameraRoot = matVec(rotation, desiredRoot).map((x, i) => x + translation[i]);
const incam = { fps: archive([24], []), incam_pelvis: archive(Array.from({ length: motion.frames }, () => cameraRoot).flat(), [motion.frames, 3]), incam_global_orient: archive(Array.from({ length: motion.frames }, () => [.2, -.5, .1]).flat(), [motion.frames, 3]) };
const registered = registerCamera(motion, incam, camera).motion;
close(vec(registered.rootPos), desiredRoot);
close(sub(vec(registered.rootPos, 24 * 3), vec(registered.rootPos)), [.048, 0, 0]);
close(registered.rotMats.slice(0, 9), motion.rotMats.slice(0, 9));
assert.deepEqual(motion.posedJoints, before);
assert.throws(() => registerCamera(motion, { ...incam, fps: archive([30], []) }, camera));

// F3 replaces proportions only, preserves all F2 root/rotation channels.
const longBody = fitBody(registered, new Float32Array(27).fill(1.4));
const knownBody = fitBody(longBody);
assert.deepEqual(knownBody.rootPos, registered.rootPos); assert.deepEqual(knownBody.rotMats, registered.rotMats);
close(knownBody.posedJoints, registered.posedJoints);

const a = { rootPos: Float32Array.of(1, 1, 2), rotMats: motion.rotMats.slice(0, 243) };
const b = { rootPos: Float32Array.of(-2, 2, 1), rotMats: motion.rotMats.slice(0, 243) };
a.rotMats.set(axisAngleMatrix([0, Math.PI / 2, 0]).flat());
b.rotMats.set(axisAngleMatrix([0, -Math.PI / 2, 0]).flat());
const pinned = pinEndpoints(motion, [a, b], { windowSeconds: .25 });
close(pinned.rootPos.slice(0, 3), a.rootPos); close(pinned.rootPos.slice(-3), b.rootPos);
close(pinned.rotMats.slice(0, 243), a.rotMats); close(pinned.rotMats.slice(-243), b.rotMats);
// Halfway through six-frame falloff => half the angular/root correction.
close(pinned.rotMats.slice(3 * 243, 3 * 243 + 9), axisAngleMatrix([0, Math.PI / 4, 0]).flat());
close(pinned.rootPos.slice(3 * 3, 3 * 3 + 3), vec(motion.rootPos, 9).map((v, k) => v + .5 * (a.rootPos[k] - motion.rootPos[k])));
assert.deepEqual(pinned.rotMats.slice(6 * 243, 19 * 243), motion.rotMats.slice(6 * 243, 19 * 243));
assert.deepEqual(pinned.rootPos.slice(6 * 3, 19 * 3), motion.rootPos.slice(6 * 3, 19 * 3));
const short = pinEndpoints(fixture(2), [a, b], { windowSeconds: 5 });
close(short.rootPos.slice(0, 3), a.rootPos); close(short.rootPos.slice(-3), b.rootPos);
const q = matToQuat(axisAngleMatrix([0, Math.PI - .001, 0]));
close(slerpQuat(q, q.map(x => -x), .5), q);
assert.throws(() => pinEndpoints(motion, [a, b], { windowSeconds: 0 }));

const box = { min: [-.5, .5, -.5], max: [.5, 1.5, .5] };
close(boxPenetration([.4, 1, 0], box), [.1, 0, 0]);
close(boxPenetration([.5, 1, 0], box), [0, 0, 0]);
close(boxPenetration([2, 1, 0], box), [0, 0, 0]);
assert.ok(segmentPenetratesBox([-2, 1, 0], [2, 1, 0], box));
assert.ok(!segmentPenetratesBox([-2, .5, 0], [2, .5, 0], box));
assert.throws(() => validateBoxes([{ min: [0, 0, 0], max: [0, 1, 1] }]));
const crossing = Array.from({ length: 27 }, () => [2, 1, 0]); crossing[0] = [-2, 1, 0];
const solved = resolveScene(crossing, [box]);
assert.ok(Math.hypot(...solved.delta) > 0);
for (let j = 1; j < 27; j++) assert.ok(!segmentPenetratesBox(solved.positions[CSKEL27_PARENTS[j]], solved.positions[j], box));

const contact = fitContacts(motion);
assert.ok(contact.diagnostics.lockedFrames > 10);
assert.ok(contact.diagnostics.maxLockResidualM < 1e-4);
for (let f = 0; f < motion.frames; f++) {
	const points = jointsAt(contact.motion, f), old = jointsAt(motion, f);
	for (const j of [21, 22, 25, 26]) assert.ok(points[j][1] >= 0);
	for (let j = 1; j < 27; j++) close(sub(points[j], points[CSKEL27_PARENTS[j]]), sub(old[j], old[CSKEL27_PARENTS[j]]));
}
// Scene wins over endpoint/root locks and still keeps rigid bone vectors.
const boxed = fitContacts(motion, { boxes: [box] });
for (let f = 0; f < motion.frames; f++) {
	const points = jointsAt(boxed.motion, f);
	for (let j = 1; j < 27; j++) assert.ok(!segmentPenetratesBox(points[CSKEL27_PARENTS[j]], points[j], box));
}
assert.throws(() => parseArgs(["--input", "x", "--extract", "x", "--poses", "x", "--out", "x", "--motions", "../escape"]));
assert.throws(() => parseArgs(["--input", "x", "--extract", "x", "--poses", "x", "--out", "x", "--window-seconds", "NaN"]));

const cliArgs = ["--input", "x", "--extract", "x", "--poses", "x", "--out", "x"];
assert.equal(parseArgs(cliArgs).baseCondition, "prod");
assert.equal(parseArgs([...cliArgs, "--base-condition", "yolo-vitpose"]).baseCondition, "yolo-vitpose");
assert.throws(() => parseArgs([...cliArgs, "--base-condition", "yolo-vitpose+fmm"]), /omit/);
assert.throws(() => parseArgs([...cliArgs, "--base-condition", "unknown"]), /unknown condition/);
const native = incamPlan("yolo-vitpose", { cameraFMm: 35, env: {} });
assert.deepEqual(native.launcherArgs, ["--bench-direct"]);
assert.deepEqual(native.plan.runnerArgs, ["--static-cam", "--f-mm", "35", "--detector", "yolo", "--keypoints", "vitpose", "--smooth-sigma", "3"]);
const production = incamPlan("prod", { cameraFMm: 35, env: {} });
assert.deepEqual(production.launcherArgs, []); assert.equal(production.plan.workerFields.trajectory, true);
assert.throws(() => incamPlan("yolo-vitpose", { cameraFMm: 35, env: { CCLAY_EXTRACT_STATIC_CAM: "0" } }), /static camera/);

// Exercise the real CLI surface with real archives, not mocked fitting. The
// only substitute is a supplied incam archive, which is a supported CLI path.
const scratch = mkdtempSync(join(tmpdir(), "cclay-fit-test-"));
try {
	const input = join(scratch, "input", "test", "shaded"), t2 = join(scratch, "t2", "test", "shaded"), poses = join(scratch, "poses"), cam = join(scratch, "cam", "test");
	for (const p of [input, poses, cam, join(t2, "prod"), join(t2, "prod+fmm")]) mkdirSync(p, { recursive: true });
	writeFileSync(join(input, "camera.json"), JSON.stringify(camera));
	for (const condition of ["prod", "prod+fmm"]) writeNpz(join(t2, condition, "motion.npz"), motionArraysToNpzMembers(motion));
	writeNpz(join(poses, "test.npz"), motionArraysToNpzMembers(pinned));
	const endpoints = readEndpoints(join(poses, "test.npz"));
	// Poison only intermediate GT frames: endpoints and fits cannot change.
	const poison = { ...pinned, rotMats: pinned.rotMats.slice(), rootPos: pinned.rootPos.slice(), posedJoints: pinned.posedJoints.slice() };
	// The archive writer correctly rejects NaN; finite, absurd sentinel values
	// still expose accidental use of intermediate frames without bypassing it.
	poison.rotMats.fill(1e6, 243, poison.rotMats.length - 243); poison.rootPos.fill(1e6, 3, poison.rootPos.length - 3); poison.posedJoints.fill(1e6);
	writeNpz(join(poses, "test.npz"), motionArraysToNpzMembers(poison));
	assert.deepEqual(readEndpoints(join(poses, "test.npz")), endpoints);
	writeNpz(join(cam, "incam.npz"), { ...incam, K_fullimg: archive(Array.from({ length: motion.frames }, () => [777, 0, 416, 0, 777, 240, 0, 0, 1]).flat(), [motion.frames, 3, 3]) });
	const run = spawnSync(process.execPath, ["tools/bench/fit-bench.mjs", "--input", join(scratch, "input"), "--extract", join(scratch, "t2"), "--poses", poses, "--out", join(scratch, "out"), "--incam-root", join(scratch, "cam"), "--motions", "test"], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	for (let i = 0; i <= 5; i++) {
		const output = join(scratch, "out", "test", `F${i}`, "motion.npz"), result = readMotion(output);
		assert.equal(result.frames, motion.frames); assert.equal(result.fps, motion.fps);
		assert.ok(result.posedJoints.every(Number.isFinite));
		if (i < 2) assert.deepEqual(readFileSync(output), readFileSync(join(t2, i ? "prod+fmm" : "prod", "motion.npz")));
	}
	const f4 = readMotion(join(scratch, "out", "test", "F4", "motion.npz"));
	close(f4.rootPos.slice(0, 3), a.rootPos); close(f4.rootPos.slice(-3), b.rootPos);
	close(matMul(readMat(f4.rotMats), matTranspose(readMat(a.rotMats))).flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
	// Skin/YOLO with missing +fmm: only remote inference is substituted. The
	// runner selects paths, requests the matching condition and runs all fits.
	const skin = join(scratch, "input/test/skin"), yolo = join(scratch, "t2/test/skin");
	mkdirSync(skin, { recursive: true }); mkdirSync(join(yolo, "yolo-vitpose"), { recursive: true });
	writeFileSync(join(skin, "camera.json"), JSON.stringify(camera));
	writeNpz(join(yolo, "yolo-vitpose/motion.npz"), motionArraysToNpzMembers(motion));
	let focalCalls = 0, cameraCalls = 0;
	await fitMain(["--input", join(scratch, "input"), "--extract", join(scratch, "t2"), "--poses", poses, "--out", join(scratch, "skin-out"), "--motions", "test", "--variant", "skin", "--base-condition", "yolo-vitpose", "--host", "fixture-host"], {
		missingFocal: async request => {
			focalCalls++; assert.equal(request.variant, "skin"); assert.equal(request.baseCondition, "yolo-vitpose"); assert.equal(request.motion, "test");
			mkdirSync(join(yolo, "yolo-vitpose+fmm")); writeNpz(join(yolo, "yolo-vitpose+fmm/motion.npz"), motionArraysToNpzMembers(motion));
		},
		cameraEvidence: async request => {
			cameraCalls++; assert.equal(request.baseCondition, "yolo-vitpose"); assert.equal(request.video, join(skin, "video.mp4"));
			writeFileSync(request.output, readFileSync(join(cam, "incam.npz"))); return { supplied: true };
		},
	});
	assert.equal(focalCalls, 1); assert.equal(cameraCalls, 1);
	for (const [i, condition] of ["yolo-vitpose", "yolo-vitpose+fmm"].entries()) assert.deepEqual(readFileSync(join(scratch, "skin-out/test", `F${i}`, "motion.npz")), readFileSync(join(yolo, condition, "motion.npz")));
	assert.equal(JSON.parse(readFileSync(join(scratch, "skin-out/test/result.json"))).baseCondition, "yolo-vitpose");
	// The Python launcher's real control flow must strip the bench-only flag
	// and avoid worker wrappers for direct YOLO. Stop at runner.main: numeric
	// camera extraction is exercised separately on the actual GPU installation.
	const runner = join(scratch, "runner.py"), probe = join(scratch, "probe.json");
	writeFileSync(runner, `import json, sys\ndetach_to_cpu = lambda x: x\ncompute_T_ayfz2ay = lambda x: x\ndef main():\n    json.dump({'argv':sys.argv,'wrappers':sys.wrapper_calls},open(${JSON.stringify(probe)},'w'))\n    raise RuntimeError('MAIN_REACHED')\n`);
	for (const direct of [false, true]) {
		const script = `import sys, types, runpy\nfrom contextlib import contextmanager\nsys.wrapper_calls=[]\nsys.modules['numpy']=types.ModuleType('numpy')\nsys.modules['torch']=types.ModuleType('torch')\n@contextmanager\ndef job(*args):\n    sys.wrapper_calls.append('job')\n    yield\nclass Runtime:\n    def __init__(self,*args,**kwargs): pass\n    def job(self): return job()\na=types.ModuleType('gvhmr_fastpath'); a.FastRuntime=Runtime; sys.modules[a.__name__]=a\nb=types.ModuleType('gvhmr_trajectory'); b.trajectory_job=job; sys.modules[b.__name__]=b\nsys.argv=${JSON.stringify(["tools/bench/cclay_bench_extract_incam.py", runner, "video.mp4", "output.npz", ...(direct ? ["--bench-direct"] : []), "--static-cam", "--f-mm", "35", "--out-root", scratch, "--detector", direct ? "yolo" : "palette", "--keypoints", direct ? "vitpose" : "auto"])}\ntry: runpy.run_path(sys.argv[0],run_name='__main__')\nexcept RuntimeError as e:\n    if str(e) != 'MAIN_REACHED': raise\n`;
		const result = spawnSync("python3", ["-c", script], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
		const observed = JSON.parse(readFileSync(probe)); assert.equal(observed.argv.includes("--bench-direct"), false); assert.equal(observed.wrappers.length, direct ? 0 : 2);
		assert.equal(observed.argv[observed.argv.indexOf("--detector") + 1], direct ? "yolo" : "palette");
	}
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`PASS fit bench: ${checks} numeric checks plus camera/body/pin/contact/box/CLI/endpoint-isolation assertions`);
