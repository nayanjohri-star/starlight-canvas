#!/usr/bin/env node
// The Camera Block owns one persisted camera instruction per shot; these
// checks pin the craneHeight field's normalization contract: absent stays
// null (legacy shots), patches round-trip, marks clamp to a sane floor, and
// deleting the rail deletes the crane that rode it.
import { createCameraBlock, removeCameraRail, updateCameraBlock } from "../src/camera-block.js";

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures += 1;
};

{
	ok("legacy blocks carry no crane", createCameraBlock({}).craneHeight === null);
	ok("legacy start/end marks migrate to endpoint points", (() => {
		const block = createCameraBlock({ craneHeight: { start: 3, end: 1.2 } });
		const points = block.craneHeight?.points;
		return points?.length === 2 && points[0].t === 0 && points[0].height === 3 && points[1].t === 1 && points[1].height === 1.2;
	})(), JSON.stringify(createCameraBlock({ craneHeight: { start: 3, end: 1.2 } }).craneHeight));
	ok("point cranes normalize sorted with pinned endpoints", (() => {
		const block = createCameraBlock({ craneHeight: { points: [{ t: 0.6, height: 2 }, { t: 0.05, height: 3 }, { t: 0.95, height: 1.2 }] } });
		const points = block.craneHeight?.points;
		return points?.length === 3 && points[0].t === 0 && points.at(-1).t === 1 && points[1].t === 0.6 && points[1].height === 2;
	})());
	ok("malformed crane values normalize to null", createCameraBlock({ craneHeight: { start: "high" } }).craneHeight === null
		&& createCameraBlock({ craneHeight: { points: [{ t: 0, height: 2 }] } }).craneHeight === null);
	ok("crane marks clamp to the 0.1 m floor", (() => {
		const block = createCameraBlock({ craneHeight: { points: [{ t: 0, height: -2 }, { t: 1, height: 0 }] } });
		return block.craneHeight?.points.every((point) => point.height === 0.1);
	})());
	ok("out-of-range and duplicate ts are repaired", (() => {
		const block = createCameraBlock({ craneHeight: { points: [{ t: -3, height: 2 }, { t: 0.5, height: 1 }, { t: 0.5, height: 4 }, { t: 9, height: 2.5 }] } });
		const points = block.craneHeight?.points;
		return !!points && points[0].t === 0 && points.at(-1).t === 1 && points.every((point, i) => i === 0 || point.t > points[i - 1].t);
	})(), JSON.stringify(createCameraBlock({ craneHeight: { points: [{ t: -3, height: 2 }, { t: 0.5, height: 1 }, { t: 0.5, height: 4 }, { t: 9, height: 2.5 }] } }).craneHeight));
	ok("point count caps at 8", (() => {
		const many = Array.from({ length: 20 }, (_, i) => ({ t: i / 19, height: 1 + (i % 3) }));
		const block = createCameraBlock({ craneHeight: { points: many } });
		return block.craneHeight?.points.length === 8;
	})());
}

{
	const base = createCameraBlock({ mode: "rail", cameraRail: [{ x: 0, z: 0 }, { x: 4, z: 0 }] });
	const marks = { points: [{ t: 0, height: 3 }, { t: 1, height: 1.2 }] };
	const craned = updateCameraBlock(base, { craneHeight: marks });
	ok("a rail block is craned by default (flat at the follow height)", base.craneHeight?.points.length === 2 && base.craneHeight.points.every((point) => point.height === base.followCam.height));
	ok("updateCameraBlock round-trips a crane patch", craned.craneHeight?.points[0].height === 3 && craned.craneHeight?.points[1].height === 1.2);
	ok("unrelated patches keep the crane", updateCameraBlock(craned, { mode: "rail" }).craneHeight?.points[1].height === 1.2);
	ok("an explicit null patch levels the crane", (() => {
		// The crane is always on for a rail: null normalizes back to the flat
		// profile at the follow height, which is what "no crane" rendered as.
		const leveled = updateCameraBlock(craned, { craneHeight: null }).craneHeight;
		return leveled?.points.length === 2 && leveled.points.every((point) => point.height === craned.followCam.height);
	})());
	ok("deleting the rail deletes its crane", removeCameraRail(craned).craneHeight === null);
	ok("blocks never share crane objects", (() => {
		const clone = createCameraBlock(craned);
		return clone.craneHeight !== craned.craneHeight && clone.craneHeight.points !== craned.craneHeight.points && clone.craneHeight.points[0].height === 3;
	})());
}

console.log(failures === 0 ? "all camera-block checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
