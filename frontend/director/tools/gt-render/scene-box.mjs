import { projectPoint } from "./camera-math.mjs";
import { elementByPath } from "../../src/studio-elements.js";

/** Studio cube is 1 m on each axis, origin at the floor/footprint centre. */
export function parseSceneBox(value) {
	const b = typeof value === "string" ? JSON.parse(value) : value;
	const out = { x: b?.x, z: b?.z, rot: b?.rot ?? 0, sx: b?.sx ?? b?.scaleX, sy: b?.sy ?? b?.scaleY, sz: b?.sz ?? b?.scaleZ };
	if (!Object.values(out).every(Number.isFinite) || ![out.sx, out.sy, out.sz].every(v => v > 0)) throw new Error("scene-box needs finite x,z,rot and positive sx,sy,sz (scaleX/Y/Z also accepted)");
	const size = elementByPath("object.scale"), position = elementByPath("object.position");
	for (const axis of ["x", "y", "z"]) if (out[`s${axis}`] < size.min[axis] || out[`s${axis}`] > size.max[axis]) throw new Error(`scene-box s${axis} must be within Studio's ${size.min[axis]}..${size.max[axis]} m range`);
	for (const axis of ["x", "z"]) if (out[axis] < position.min[axis] || out[axis] > position.max[axis]) throw new Error(`scene-box ${axis} exceeds Studio position bounds`);
	out.rot = ((out.rot + 180) % 360 + 360) % 360 - 180;
	return out;
}
export function boxCorners(box) {
	const b = parseSceneBox(box), a = b.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
	return Array.from({ length: 8 }, (_, i) => {
		const x = (i & 1 ? 1 : -1) * b.sx / 2, z = (i & 4 ? 1 : -1) * b.sz / 2;
		return [b.x + c * x + s * z, i & 2 ? b.sy : 0, b.z - s * x + c * z];
	});
}
export const BOX_EDGES = Array.from({ length: 8 }, (_, i) => [1, 2, 4].filter(bit => !(i & bit)).map(bit => [i, i | bit])).flat();
export function sceneBoxRecord(box) {
	const b = parseSceneBox(box);
	return { kind: "cube", placement: b, centre: [b.x, b.sy / 2, b.z], halfExtents: [b.sx / 2, b.sy / 2, b.sz / 2], yawDeg: b.rot,
		...(b.rot === 0 ? { min: [b.x - b.sx / 2, 0, b.z - b.sz / 2], max: [b.x + b.sx / 2, b.sy, b.z + b.sz / 2] } : {}),
		corners: boxCorners(b), convention: "World metres, +Y up; yaw degrees about +Y. Cube base at y=0." };
}
export function projectBox(box, camera) {
	return boxCorners(box).map(p => projectPoint(p, { ...camera, worldToCameraCv: camera.worldToCameraCv ?? camera.worldToCamera }));
}
