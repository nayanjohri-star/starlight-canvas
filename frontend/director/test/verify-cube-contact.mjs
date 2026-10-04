#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as THREE from "three";
import { boxCorners, BOX_EDGES, parseSceneBox, projectBox, sceneBoxRecord } from "../tools/gt-render/scene-box.mjs";
import { backgroundDifferenceMask, deriveBox, drawProjectedBox, lowestWindow, paletteMask, supportTop } from "../tools/bench/cube-contact.mjs";
import { falRequest, FAL_MODEL, main as generateFal, runFal } from "../tools/bench/fal-generate.mjs";
import { buildH3LockedPrompt } from "../bin/agent/video-adapters.mjs";
import { boxContactValues } from "../tools/bench/metrics.mjs";
import { makeQaVideo } from "../tools/bench/exp3.mjs";

const b = parseSceneBox({ x: 1, z: 3, rot: 0, scaleX: 2, scaleY: 0.5, scaleZ: 4 });
assert.deepEqual(sceneBoxRecord(b).min, [0, 0, 1]); assert.deepEqual(sceneBoxRecord(b).max, [2, 0.5, 5]);
assert.equal(boxCorners(b).length, 8); assert.equal(BOX_EDGES.length, 12);
assert.equal(parseSceneBox({ ...b, rot: 360 }).rot, 0);
for (const value of [{}, { x: 0, z: 0, sx: 1, sy: -1, sz: 1 }, { ...b, rot: NaN }, { ...b, sy: 0.02 }, { ...b, sx: 101 }, { ...b, x: 241 }]) assert.throws(() => parseSceneBox(value));
const turned = { ...b, rot: 90 }, corners = boxCorners(turned);
assert.ok(Math.abs(corners[0][0] + 1) < 1e-12); assert.ok(Math.abs(corners[0][2] - 4) < 1e-12);
assert.equal(sceneBoxRecord(turned).min, undefined); assert.equal(sceneBoxRecord(turned).yawDeg, 90);
const camera = { width: 832, height: 480, fx: 500, fy: 500, cx: 416, cy: 240, worldToCamera: [[1, 0, 0, 0], [0, -1, 0, 1], [0, 0, -1, 8], [0, 0, 0, 1]] };
const three = new THREE.PerspectiveCamera(2 * Math.atan(240 / 500) * 180 / Math.PI, 832 / 480, 0.01, 100);
three.position.set(0, 1, 8); three.updateMatrixWorld(true);
for (const [i, p] of projectBox(turned, camera).entries()) {
	const q = new THREE.Vector3(...corners[i]).project(three);
	assert.ok(Math.abs(p[0] - (q.x + 1) * 416) < 1e-9); assert.ok(Math.abs(p[1] - (1 - q.y) * 240) < 1e-9);
}
assert.ok(drawProjectedBox(Buffer.alloc(832 * 480 * 3), camera, b).some(v => v === 255));
assert.deepEqual(lowestWindow([9, 1, 1, 0, 8], 2), [2, 3]);
assert.throws(() => lowestWindow([1], 2));
const cloud = [new Float32Array([0, 0.5, 0, 2, 0, 0]), new Float32Array([0, 0.6, 0, 0.2, 0.55, 0])];
const top = supportTop([0, 1], f => cloud[f], { x: 0, z: 0, sx: 0.5, sz: 0.5 });
assert.equal(top.height, 0.5); assert.equal(top.witness.frame, 0);
assert.equal(boxContactValues(cloud[0], { min: [-0.25, 0, -0.25], max: [0.25, top.height, 0.25] }).minSignedDistance, 0);
// Every scenario consumes skin and returns an independently verifiable witness.
const names = ["Hips", "LeftHand", "RightHand", "LeftFoot", "RightFoot"];
for (const scenario of ["sit", "stepup", "handon", "bump"]) {
	const n = 24, joints = { frames: n, fps: 24, joints: names.map(name => ({ name })), world: Array.from({ length: n }, (_, f) => [[0, 0.65, f / 100], [-0.2, 0.9, 0.7], [0.2, 0.9, 0.7], [0, 0.4, 0.8], [0.3, 0.1, 0]]) };
	const blockedSkin = () => new Float32Array([0, 0.5, 0.2, -0.2, 0.87, 0.7, 0.2, 0.87, 0.7, 0, 0.35, 0.8]);
	if (scenario === "handon") {
		assert.throws(() => deriveBox(scenario, joints, blockedSkin), /no skin-safe palm-height table/);
		for (const pose of joints.world) { pose[1][2] = 1.2; pose[2][2] = 1.2; }
	}
	const skin = scenario === "handon" ? () => new Float32Array([0, 0.5, 0.2, -0.2, 0.87, 1.2, 0.2, 0.87, 1.2, 0, 0.35, 0.8]) : blockedSkin;
	const saved = structuredClone(joints), derived = deriveBox(scenario, joints, skin);
	assert.deepEqual(joints, saved); assert.equal(derived.contactFrames.length, 12);
	const signed = derived.contactFrames.map(f => boxContactValues(skin(f), derived.scene).minSignedDistance);
	assert.ok(Math.abs(Math.min(...signed)) < 1e-7, `${scenario}: witness must touch without penetration`);
}
// Exact threshold boundaries, neutral and shadow exclusions.
assert.deepEqual([...paletteMask(Buffer.from([0, 0, 0, 180, 180, 180, 255, 0, 0, 0, 255, 0, 0, 0, 255, 140, 105, 105, 140, 106, 106, 45, 0, 0, 46, 0, 0]))], [0, 0, 255, 255, 255, 255, 0, 0, 255]);
assert.throws(() => paletteMask(Buffer.alloc(2)));
const plate = Buffer.from([100, 100, 100, 200, 200, 200]);
assert.deepEqual([...backgroundDifferenceMask(Buffer.from([129, 100, 100, 230, 200, 200, 100, 70, 100, 200, 200, 171]), plate)], [0, 255, 255, 0]);
assert.throws(() => backgroundDifferenceMask(Buffer.alloc(3), plate));
assert.throws(() => backgroundDifferenceMask(Buffer.alloc(6), plate, 0));
const body = falRequest({ prompt: "walk", firstImage: "data:image/png;base64,AA==", lastImage: "https://example.test/B.png" });
assert.deepEqual(body, { prompt: buildH3LockedPrompt("walk"), image_url: "data:image/png;base64,AA==", end_image_url: "https://example.test/B.png", resolution: "480P", duration: 5, prompt_expansion_mode: "disabled" });
assert.equal(Object.hasOwn(body, "seed"), false); assert.throws(() => falRequest({ prompt: "" }));
const responses = [{ request_id: "r", status: "IN_QUEUE", status_url: "https://queue.fal.run/status", response_url: "https://queue.fal.run/result" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }, { video: { url: "https://example.test/video.mp4" }, cost: 0.25 }];
const calls = [], events = []; let waits = 0;
const result = await runFal(body, { key: "test-only", wait: async () => { waits++; }, onEvent: e => events.push(e), fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => responses.shift() }; } });
assert.equal(result.video, "https://example.test/video.mp4"); assert.equal(waits, 2); assert.equal(calls[0].url, `https://queue.fal.run/${FAL_MODEL}`);
assert.deepEqual(JSON.parse(calls[0].options.body), body); assert.equal(calls[0].options.headers.authorization, "Key test-only"); assert.deepEqual(events.at(-1).cost, { cost: 0.25 });
await assert.rejects(runFal(body, { key: "test", fetchImpl: async () => ({ ok: false, status: 422 }) }), /422/);
await assert.rejects(runFal(body, { key: "test", fetchImpl: async () => ({ ok: true, json: async () => ({ status: "FAILED", error: "bad input" }) }) }), /bad input/);
await assert.rejects(runFal(body, { key: "test", fetchImpl: async () => ({ ok: true, json: async () => ({ status: "IN_QUEUE" }) }) }), /status_url/);
// Exercise the runnable generator, real A/B decoding and disk artifacts;
// only the external provider is mocked. No timers or live requests.
const scratch = mkdtempSync(join(tmpdir(), "cclay-fal-test-")), priorFetch = globalThis.fetch;
try {
	const scenario = join(scratch, "sit"), shaded = join(scenario, "shaded"), out = join(scratch, "clips"), key = join(scratch, "key");
	mkdirSync(shaded, { recursive: true });
	execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24", "-frames:v", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(shaded, "video.mp4")]);
	writeFileSync(join(shaded, "meta.json"), JSON.stringify({ frames: 4 })); writeFileSync(join(scenario, "scenario.json"), JSON.stringify({ prompt: "sit" }));
	writeFileSync(key, "mock-private-key");
	const qaVideo = join(scratch, "qa.mp4");
	makeQaVideo(join(shaded, "video.mp4"), join(shaded, "video.mp4"), qaVideo);
	const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "json", qaVideo])).streams[0];
	assert.equal(probe.width, 192); assert.equal(probe.height, 64); assert.equal(Number(probe.nb_frames), 4);
	const bytes = readFileSync(join(shaded, "video.mp4")); let requests = 0;
	globalThis.fetch = async (url, options) => {
		if (url === `https://queue.fal.run/${FAL_MODEL}`) {
			const request = JSON.parse(options.body); assert.ok(request.image_url.startsWith("data:image/png;base64,")); assert.notEqual(request.image_url, request.end_image_url);
			requests++; return { ok: true, json: async () => ({ request_id: `mock-${requests}`, status: "COMPLETED", video: { url: "https://example.test/mock.mp4" }, cost: 0.25 }) };
		}
		assert.equal(url, "https://example.test/mock.mp4"); return { ok: true, arrayBuffer: async () => bytes };
	};
	await generateFal(["--scenario", scenario, "--out", out, "--key", key]);
	assert.equal(requests, 3);
	for (let i = 1; i <= 3; i++) {
		const dir = join(out, `sit-shaded-0${i}`), text = readFileSync(join(dir, "request.json"), "utf8"), saved = JSON.parse(text);
		assert.equal(saved.ok, true); assert.equal(saved.independentRun, true); assert.deepEqual(saved.cost, [{ cost: 0.25 }]); assert.ok(!text.includes("mock-private-key"));
		assert.deepEqual(readFileSync(join(dir, "video.mp4")), bytes); assert.ok(existsSync(join(dir, "A.png")) && existsSync(join(dir, "B.png")));
	}
	await generateFal(["--scenario", scenario, "--out", out, "--key", key]); assert.equal(requests, 3);
	await generateFal(["--scenario", scenario, "--out", join(scratch, "dry"), "--key", join(scratch, "absent"), "--runs", "1"]);
	assert.equal(JSON.parse(readFileSync(join(scratch, "dry/sit-shaded-01/request.json"))).dryRun, true); assert.equal(requests, 3);
	const skin = join(scenario, "skin"); mkdirSync(skin);
	execFileSync("ffmpeg", ["-v", "error", "-i", join(shaded, "video.mp4"), "-vf", "format=gray", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(skin, "video.mp4")]);
	writeFileSync(join(skin, "meta.json"), JSON.stringify({ frames: 4 }));
	await generateFal(["--scenario", scenario, "--variant", "skin", "--out", out, "--key", key]); assert.equal(requests, 6);
	const greyRecord = JSON.parse(readFileSync(join(out, "sit-skin-01/request.json")));
	assert.equal(greyRecord.variant, "skin"); assert.equal(greyRecord.ok, true);
	assert.notEqual(greyRecord.endpoints.A, JSON.parse(readFileSync(join(out, "sit-shaded-01/request.json"))).endpoints.A);
	await assert.rejects(generateFal(["--scenario", scenario, "--variant", "invalid", "--out", out]), /variant/);
} finally { globalThis.fetch = priorFetch; rmSync(scratch, { recursive: true, force: true }); }
console.log("cube-contact: box derivation, projection, segmentation, mocked fal queue and generator artifacts passed");
