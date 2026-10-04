/**
 * Pure camera math for the ground-truth renderer (#428): GVHMR focal
 * conversion, Three.js-compatible intrinsics, static camera placement and
 * pinhole projection. No DOM, no Three, no I/O, so it is unit-tested under
 * Node (test/verify-gt-render-camera.mjs) and `supportValues` is injected
 * verbatim into the Studio page by render.mjs.
 *
 * Conventions (stated once, used everywhere):
 * - World: the Studio's Three.js scene. Right-handed, +Y up, metres.
 * - Studio camera: Three.js PerspectiveCamera, rotation order "YXZ",
 *   rotation = (pitch, yaw, 0), looking down its local -Z, local +Y up.
 *   `R` below is its camera->world rotation Ry(yaw) * Rx(pitch), row-major.
 * - Azimuth/elevation place the camera around the subject: azimuth 0 puts it
 *   on +Z looking toward -Z (the rig's front for a take facing +Z), positive
 *   azimuth swings it toward +X; positive elevation raises it and tilts it
 *   down. yaw = azimuth, pitch = -elevation.
 * - Image: pixel coordinates are continuous, origin at the top-left corner of
 *   the top-left pixel, u to the right, v DOWN. Pixel (col, row) covers
 *   [col, col+1) x [row, row+1); its centre is (col + 0.5, row + 0.5).
 *   cx = W/2, cy = H/2, square pixels (fx = fy). This is exactly where
 *   Three's NDC lands after the viewport transform.
 * - OpenCV extrinsics: X_cv = R_cv * X_world + t_cv with camera x right,
 *   y down, z forward; u = fx * X/Z + cx, v = fy * Y/Z + cy.
 */

/** The 35 mm full-frame diagonal GVHMR's `--f-mm` is measured against. */
export const FULL_FRAME_DIAGONAL_MM = Math.hypot(24, 36);

const DEG = Math.PI / 180;

/** Focal length in pixels GVHMR derives from `--f-mm` for a W x H video. */
export function gvhmrFocalPx(fMm, width, height) {
	return (Math.hypot(width, height) / FULL_FRAME_DIAGONAL_MM) * fMm;
}

/** Inverse of gvhmrFocalPx (not rounded). */
export function gvhmrFMmFromFocalPx(focalPx, width, height) {
	return (focalPx * FULL_FRAME_DIAGONAL_MM) / Math.hypot(width, height);
}

/** Three's vertical field of view (degrees) that renders with gvhmrFocalPx. */
export function fovDegFromFMm(fMm, width, height) {
	return (2 * Math.atan(height / 2 / gvhmrFocalPx(fMm, width, height))) / DEG;
}

/** Pinhole intrinsics of a Three PerspectiveCamera with vertical `fovDeg`
 * rendered at width x height with aspect = width / height. */
export function intrinsicsFromFov({ width, height, fovDeg }) {
	const fy = height / 2 / Math.tan((fovDeg * DEG) / 2);
	return { width, height, fovDeg, fx: fy, fy, cx: width / 2, cy: height / 2 };
}

/** Yaw/pitch (radians) and the camera->world rotation for an orbit angle. */
export function orbitRotation(azimuthDeg, elevationDeg) {
	const yaw = azimuthDeg * DEG;
	const pitch = -elevationDeg * DEG;
	return { yaw, pitch, R: rotationYXZ(yaw, pitch) };
}

/** Ry(yaw) * Rx(pitch), row-major 3x3: the camera->world rotation Three
 * builds from Euler(pitch, yaw, 0, "YXZ"). Columns are the camera's x (right),
 * y (up) and z (backward) axes in world space. */
export function rotationYXZ(yaw, pitch) {
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const cp = Math.cos(pitch);
	const sp = Math.sin(pitch);
	return [
		cy, sy * sp, sy * cp,
		0, cp, -sp,
		-sy, cy * sp, cy * cp,
	];
}

/** Placement slopes: a point at lateral offset x and depth d is inside the
 * margin box iff kx * |x| <= d (and likewise ky for y). `margin` is the
 * fraction of each image dimension kept clear on every side. */
export function marginSlopes({ fx, fy, width, height }, margin) {
	if (!(margin >= 0 && margin < 0.5)) throw new Error(`margin must be in [0, 0.5), got ${margin}`);
	return { kx: fx / ((0.5 - margin) * width), ky: fy / ((0.5 - margin) * height) };
}

/**
 * Support values of a point set for the camera solve, in the camera's
 * rotated frame p' = R^T * P. Exact reduction: the minimal camera distance
 * over any set is a function of these five maxima alone, so the page reduces
 * every skinned vertex of a frame to five numbers.
 *
 * Self-contained on purpose (no outer references): render.mjs injects its
 * source into the browser with Function.prototype.toString.
 *
 * @param {ArrayLike<number>} points flat [x0, y0, z0, x1, ...] in world metres
 * @param {number[]} R row-major camera->world rotation
 * @returns {{ axp: number, axm: number, ayp: number, aym: number, zmax: number, count: number }}
 */
export function supportValues(points, R, kx, ky) {
	let axp = -Infinity;
	let axm = -Infinity;
	let ayp = -Infinity;
	let aym = -Infinity;
	let zmax = -Infinity;
	const count = Math.floor(points.length / 3);
	for (let i = 0; i < count; i += 1) {
		const x = points[i * 3];
		const y = points[i * 3 + 1];
		const z = points[i * 3 + 2];
		const px = R[0] * x + R[3] * y + R[6] * z;
		const py = R[1] * x + R[4] * y + R[7] * z;
		const pz = R[2] * x + R[5] * y + R[8] * z;
		if (pz + kx * px > axp) axp = pz + kx * px;
		if (pz - kx * px > axm) axm = pz - kx * px;
		if (pz + ky * py > ayp) ayp = pz + ky * py;
		if (pz - ky * py > aym) aym = pz - ky * py;
		if (pz > zmax) zmax = pz;
	}
	return { axp, axm, ayp, aym, zmax, count };
}

/** Union of support values (the support of the union of the point sets). */
export function mergeSupports(list) {
	const out = { axp: -Infinity, axm: -Infinity, ayp: -Infinity, aym: -Infinity, zmax: -Infinity, count: 0 };
	for (const s of list) {
		for (const key of ["axp", "axm", "ayp", "aym", "zmax"]) out[key] = Math.max(out[key], s[key]);
		out.count += s.count;
	}
	return out;
}

/**
 * The closest static camera with orientation R that keeps every supported
 * point inside the margin box. In the rotated frame the camera sits at
 * (tx, ty, D); a point p' has depth D - p'z and lateral offset p'x - tx, so
 * the box constraint is D >= p'z + kx * |p'x - tx|. Maximised over the set
 * that is max(axp - kx*tx, axm + kx*tx), minimised at tx = (axp - axm)/(2kx):
 * the extreme points end up symmetric about the image centre.
 *
 * @returns {{ position: {x,y,z}, rotated: [number, number, number], bindingAxis: "x"|"y"|"depth" }}
 */
export function solvePlacement(support, R, { kx, ky }, minDepth = 0.3) {
	if (!(support.count > 0)) throw new Error("camera placement needs at least one point");
	const tx = (support.axp - support.axm) / (2 * kx);
	const ty = (support.ayp - support.aym) / (2 * ky);
	const dx = (support.axp + support.axm) / 2;
	const dy = (support.ayp + support.aym) / 2;
	const dz = support.zmax + minDepth;
	const D = Math.max(dx, dy, dz);
	const bindingAxis = D === dx ? "x" : D === dy ? "y" : "depth";
	const rotated = [tx, ty, D];
	return { position: applyRotation(R, rotated), rotated, bindingAxis };
}

function applyRotation(R, [x, y, z]) {
	return {
		x: R[0] * x + R[1] * y + R[2] * z,
		y: R[3] * x + R[4] * y + R[5] * z,
		z: R[6] * x + R[7] * y + R[8] * z,
	};
}

/** OpenCV world->camera 4x4 (row-major): camera x right, y down, z forward. */
export function worldToCameraCv(R, position) {
	// R_cv = diag(1, -1, -1) * R^T
	const Rcv = [
		R[0], R[3], R[6],
		-R[1], -R[4], -R[7],
		-R[2], -R[5], -R[8],
	];
	const t = [0, 1, 2].map((row) => -(Rcv[row * 3] * position.x + Rcv[row * 3 + 1] * position.y + Rcv[row * 3 + 2] * position.z));
	return [
		[Rcv[0], Rcv[1], Rcv[2], t[0]],
		[Rcv[3], Rcv[4], Rcv[5], t[1]],
		[Rcv[6], Rcv[7], Rcv[8], t[2]],
		[0, 0, 0, 1],
	];
}

/** Three/OpenGL view matrix (camera.matrixWorldInverse) as row-major 4x4:
 * camera x right, y up, looking down -z. */
export function worldToCameraGl(R, position) {
	const t = [0, 1, 2].map((col) => -(R[col] * position.x + R[3 + col] * position.y + R[6 + col] * position.z));
	return [
		[R[0], R[3], R[6], t[0]],
		[R[1], R[4], R[7], t[1]],
		[R[2], R[5], R[8], t[2]],
		[0, 0, 0, 1],
	];
}

/** Project a world point with a camera record ({ fx, fy, cx, cy,
 * worldToCameraCv }). Returns [u, v, depth] in the image convention above;
 * depth <= 0 means behind the camera. */
export function projectPoint([x, y, z], camera) {
	const M = camera.worldToCameraCv;
	const X = M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3];
	const Y = M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3];
	const Z = M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3];
	return [camera.fx * (X / Z) + camera.cx, camera.fy * (Y / Z) + camera.cy, Z];
}

/**
 * Full static camera for a set of support values: intrinsics from an integer
 * GVHMR f-mm, orientation from azimuth/elevation, position from the solve.
 * The returned record is what camera.json stores.
 */
export function buildCamera({ width, height, fMm, azimuthDeg, elevationDeg, margin, support, minDepth = 0.3 }) {
	if (!Number.isInteger(fMm) || fMm <= 0) throw new Error(`f-mm must be a positive integer (GVHMR --f-mm), got ${fMm}`);
	const fovDeg = fovDegFromFMm(fMm, width, height);
	const intrinsics = intrinsicsFromFov({ width, height, fovDeg });
	const { yaw, pitch, R } = orbitRotation(azimuthDeg, elevationDeg);
	const slopes = marginSlopes(intrinsics, margin);
	const placement = solvePlacement(support, R, slopes, minDepth);
	return {
		...intrinsics,
		gvhmrFMm: fMm,
		azimuthDeg,
		elevationDeg,
		margin,
		position: placement.position,
		yaw,
		pitch,
		bindingAxis: placement.bindingAxis,
		cameraToWorldRotation: R,
		worldToCameraCv: worldToCameraCv(R, placement.position),
		worldToCameraGl: worldToCameraGl(R, placement.position),
	};
}

/**
 * Rebuild the camera record from a camera.json written by render.mjs, so a
 * later render uses that exact camera (--camera). The pose is taken from
 * position/yaw/pitch/fovDeg and checked against the stored intrinsics and
 * worldToCamera, so a file in another convention is refused, not reinterpreted.
 */
export function cameraFromRecord(record) {
	const { width, height, fovDeg, position, yaw, pitch } = record ?? {};
	const finite = [width, height, fovDeg, yaw, pitch, position?.x, position?.y, position?.z].every(Number.isFinite);
	if (!finite) throw new Error("camera.json needs width, height, fovDeg, yaw, pitch and position {x, y, z}");
	const intrinsics = intrinsicsFromFov({ width, height, fovDeg });
	for (const key of ["fx", "fy", "cx", "cy"]) {
		if (record[key] !== undefined && Math.abs(record[key] - intrinsics[key]) > 1e-6) throw new Error(`camera.json ${key} ${record[key]} does not match fovDeg (${intrinsics[key]})`);
	}
	const R = rotationYXZ(yaw, pitch);
	const camera = {
		...intrinsics,
		gvhmrFMm: record.gvhmrFMm ?? null,
		azimuthDeg: record.azimuthDeg ?? null,
		elevationDeg: record.elevationDeg ?? null,
		margin: record.margin ?? null,
		position: { x: position.x, y: position.y, z: position.z },
		yaw,
		pitch,
		bindingAxis: record.bindingAxis ?? "given",
		cameraToWorldRotation: R,
		worldToCameraCv: worldToCameraCv(R, position),
		worldToCameraGl: worldToCameraGl(R, position),
	};
	if (record.worldToCamera) {
		const gap = Math.max(...record.worldToCamera.flatMap((row, r) => row.map((value, c) => Math.abs(value - camera.worldToCameraCv[r][c]))));
		if (!(gap <= 1e-9)) throw new Error(`camera.json worldToCamera differs from its position/yaw/pitch by ${gap}`);
	}
	return camera;
}

/** The same camera moved by `offset` (world metres); orientation unchanged. */
export function translateCamera(camera, offset) {
	const position = { x: camera.position.x + offset.x, y: camera.position.y + offset.y, z: camera.position.z + offset.z };
	const R = camera.cameraToWorldRotation;
	return { ...camera, position, worldToCameraCv: worldToCameraCv(R, position), worldToCameraGl: worldToCameraGl(R, position) };
}

/** The minimal support-value arguments a caller needs for a camera orientation. */
export function supportArgs({ width, height, fMm, azimuthDeg, elevationDeg, margin }) {
	const intrinsics = intrinsicsFromFov({ width, height, fovDeg: fovDegFromFMm(fMm, width, height) });
	const { R } = orbitRotation(azimuthDeg, elevationDeg);
	return { R, ...marginSlopes(intrinsics, margin) };
}
