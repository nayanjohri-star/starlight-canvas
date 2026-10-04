#!/usr/bin/env node
import { buildFollowTrack, followFixedTimestep } from "../src/camera-follow.js";
import { sampleAt } from "../src/sample-at.js";
import { fovToFocalMm } from "../src/shot.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const FPS = 24;
const frameCount = 97;
const subjectTrack = Array.from({ length: frameCount }, (_, frame) => ({
	x: frame < 48 ? 0 : (frame - 48) / FPS,
	z: Math.min(frame, 48) / FPS,
}));
const cameraTrack = buildFollowTrack(subjectTrack, FPS);
const shot = {
	startFrame: 0,
	endFrame: frameCount - 1,
	cameraKeys: [],
	camera: { mode: "follow" },
};
const scene = {
	frameCount,
	fps: FPS,
	subject: { x: 0, z: 0 },
	subjectTrack,
	cameraTrack,
	fovDeg: 48,
	sensorId: "super35",
	filmback: { aspectRatio: 2.39 },
};

const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
function sameCamera(a, b) {
	if (a === null || b === null) return a === b;
	return near(a.pos.x, b.pos.x) && near(a.pos.y, b.pos.y) && near(a.pos.z, b.pos.z)
		&& near(a.yaw, b.yaw) && near(a.pitch, b.pitch) && near(a.fovDeg, b.fovDeg)
		&& near(a.focalMm, b.focalMm) && a.sensorId === b.sensorId;
}
function sameState(a, b) {
	return near(a.frame, b.frame) && a.motionFrame === b.motionFrame
		&& (a.subject === null || b.subject === null
			? a.subject === b.subject
			: near(a.subject.x, b.subject.x) && near(a.subject.z, b.subject.z))
		&& sameCamera(a.camera, b.camera);
}

{
	const before = JSON.stringify({ scene, shot });
	const first = sampleAt(scene, shot, 61);
	const second = sampleAt(scene, shot, 61);
	expect("same frame returns frame-accurate state", sameState(first, second));
	expect("samples own their nested values", first !== second && first.subject !== second.subject && first.camera !== second.camera && first.camera.pos !== second.camera.pos);
	expect("sampling does not mutate scene or shot", JSON.stringify({ scene, shot }) === before);
	expect(
		"camera uses the complete shared shape",
		Object.keys(first.camera).join(",") === "pos,yaw,pitch,fovDeg,focalMm,sensorId",
		Object.keys(first.camera).join(","),
	);
	expect("sensorId is available before the filmback producer lands", first.camera.sensorId === "super35", first.camera.sensorId);
	expect(
		"follow camera derives focalMm on the selected sensor",
		near(first.camera.focalMm, fovToFocalMm((48 * Math.PI) / 180, "super35", 2.39)),
		String(first.camera.focalMm),
	);
}

{
	// Render pacing only decides how often the same authored frame is asked
	// for. Both displays must visit the identical sequence of frame states.
	function statesSeenAt(renderFps) {
		const states = [];
		let previousFrame = -1;
		const ticks = Math.ceil(((frameCount - 1) * renderFps) / FPS);
		for (let tick = 0; tick <= ticks; tick += 1) {
			const frame = Math.min(frameCount - 1, Math.floor((tick * FPS) / renderFps + 1e-9));
			if (frame === previousFrame) continue;
			previousFrame = frame;
			states.push(sampleAt(scene, shot, frame));
		}
		return states;
	}
	const at24 = statesSeenAt(24);
	const at60 = statesSeenAt(60);
	expect(
		"24fps and 60fps render pacing produce frame-accurate states",
		at24.length === at60.length && at24.every((state, index) => sameState(state, at60[index])),
		`${at24.length} vs ${at60.length} samples`,
	);
}

{
	const keyedShot = {
		camera: { mode: "keys" },
		cameraKeys: [{
			frame: 12,
			framing: { pos: { x: 1, y: 2, z: 3 }, yaw: 0.2, pitch: -0.1, fovDeg: 35 },
		}],
	};
	const camera = sampleAt(scene, keyedShot, 12).camera;
	expect("key and follow cameras share one shape", Object.keys(camera).join(",") === "pos,yaw,pitch,fovDeg,focalMm,sensorId");
	expect("key camera keeps its authored FOV", camera.fovDeg === 35);
}

{
	// Given: a rail-mode shot whose rail schedule only owns frames 20..40.
	const railShot = {
		startFrame: 0,
		endFrame: 80,
		camera: {
			mode: "rail",
			cameraRail: [{ x: 0, z: 0 }, { x: 1, z: 1 }],
			railFollow: { mode: "range", startFrame: 20, endFrame: 40 },
		},
		cameraKeys: [
			{ frame: 0, framing: { pos: { x: 100, y: 1, z: 200 }, yaw: 0, pitch: 0, fovDeg: 40 } },
			{ frame: 10, framing: { pos: { x: 110, y: 1, z: 210 }, yaw: 0, pitch: 0, fovDeg: 40 } },
			{ frame: 50, framing: { pos: { x: 150, y: 1, z: 250 }, yaw: 0, pitch: 0, fovDeg: 40 } },
			{ frame: 80, framing: { pos: { x: 180, y: 1, z: 280 }, yaw: 0, pitch: 0, fovDeg: 40 } },
		],
	};
	const railScene = {
		...scene,
		frameCount: 81,
		cameraTrack: Array.from({ length: 81 }, (_, frame) => ({
			pos: { x: 1000 + frame, y: 2, z: 2000 + frame },
			yaw: 0.5,
			pitch: -0.2,
			fovDeg: 55,
		})),
	};

	// When: playback addresses frames on both sides of the rail range.
	const keyedFrames = [0, 10, 50, 80];
	const railFrames = [20, 30, 40];

	// Then: keyed frames retain their authored cameras and active rail frames
	// read the precomputed rail samples.
	expect(
		"partial rail range uses keyed cameras outside its authored range",
		keyedFrames.every((frame) => sampleAt(railScene, railShot, frame).camera.pos.x === 100 + frame),
		keyedFrames.map((frame) => `${frame}:${sampleAt(railScene, railShot, frame).camera.pos.x}`).join(", "),
	);
	expect(
		"partial rail range uses rail track samples inside its authored range",
		railFrames.every((frame) => sampleAt(railScene, railShot, frame).camera.pos.x === 1000 + frame),
		railFrames.map((frame) => `${frame}:${sampleAt(railScene, railShot, frame).camera.pos.x}`).join(", "),
	);
}

{
	const motion = {
		frames: 3,
		anchorFrame: 0,
		anchorX: 4,
		anchorZ: -2,
		rotationDeg: 90,
		rootPos: new Float32Array([
			0, 0, 0,
			1, 0, 0,
			2, 0, 0,
		]),
	};
	const sampled = sampleAt({ frameCount: 3, motion }, null, 2);
	expect("motion root is sampled as scene state", Math.abs(sampled.subject.x - 4) < 1e-9 && Math.abs(sampled.subject.z + 4) < 1e-9, JSON.stringify(sampled.subject));
}

expect("follow spring uses one fixed authored-frame timestep", followFixedTimestep(FPS) === 1 / FPS);

if (failures) process.exit(1);
console.log("all sample-at checks PASS");
