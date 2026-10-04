/**
 * Pure scoring math for the mocap bench (#431): rigid/similarity alignment,
 * pose and trajectory errors, mask IoU, box contact and timeline resampling.
 * No DOM, no Three, no I/O; unit-tested by test/verify-bench-metrics.mjs.
 *
 * Conventions: points are [x, y, z] in the Studio scene (metres, +Y up).
 * A yaw is a rotation about +Y with the same sign as src/ardy/motion-
 * calibration.js: x' = cos*x + sin*z, z' = -sin*x + cos*z.
 */

export const DEG = Math.PI / 180;

export function rotateYaw([x, y, z], yawRad) {
	const c = Math.cos(yawRad);
	const s = Math.sin(yawRad);
	return [c * x + s * z, y, -s * x + c * z];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function centroid(points) {
	const c = [0, 0, 0];
	for (const p of points) {
		c[0] += p[0];
		c[1] += p[1];
		c[2] += p[2];
	}
	return c.map((value) => value / points.length);
}

/**
 * Least-squares yaw (about +Y) and ground-plane translation mapping `src`
 * onto `dst` (paired points): dst ~ rotateYaw(src, yaw) + [tx, 0, tz].
 * Height is neither rotated nor translated: both takes stand on the same
 * floor, so a height error stays an error.
 */
export function fitYawTranslation(src, dst) {
	if (src.length !== dst.length || !src.length) throw new Error("fitYawTranslation needs paired, non-empty point sets");
	const cs = centroid(src);
	const cd = centroid(dst);
	// Maximise sum b . R(a) over theta: C = sum(ax bx + az bz), S = sum(az bx - ax bz).
	let C = 0;
	let S = 0;
	for (let i = 0; i < src.length; i += 1) {
		const ax = src[i][0] - cs[0];
		const az = src[i][2] - cs[2];
		const bx = dst[i][0] - cd[0];
		const bz = dst[i][2] - cd[2];
		C += ax * bx + az * bz;
		S += az * bx - ax * bz;
	}
	const yawRad = C === 0 && S === 0 ? 0 : Math.atan2(S, C);
	const rc = rotateYaw(cs, yawRad);
	return { yawRad, yawDeg: yawRad / DEG, tx: cd[0] - rc[0], tz: cd[2] - rc[2] };
}

export function applyYawTranslation(point, { yawRad, tx, tz }) {
	const r = rotateYaw(point, yawRad);
	return [r[0] + tx, r[1], r[2] + tz];
}

/** Eigenvector of the largest eigenvalue of a symmetric 4x4 (cyclic Jacobi). */
function dominantEigenvector4(input) {
	const a = input.map((row) => row.slice());
	const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
	for (let sweep = 0; sweep < 64; sweep += 1) {
		let off = 0;
		for (let p = 0; p < 4; p += 1) for (let q = p + 1; q < 4; q += 1) off += a[p][q] * a[p][q];
		if (off < 1e-30) break;
		for (let p = 0; p < 4; p += 1) {
			for (let q = p + 1; q < 4; q += 1) {
				if (Math.abs(a[p][q]) < 1e-300) continue;
				const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
				const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < 4; k += 1) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = c * akp - s * akq;
					a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < 4; k += 1) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = c * apk - s * aqk;
					a[q][k] = s * apk + c * aqk;
				}
				for (let k = 0; k < 4; k += 1) {
					const vkp = v[k][p];
					const vkq = v[k][q];
					v[k][p] = c * vkp - s * vkq;
					v[k][q] = s * vkp + c * vkq;
				}
			}
		}
	}
	let best = 0;
	for (let i = 1; i < 4; i += 1) if (a[i][i] > a[best][best]) best = i;
	return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Similarity Procrustes (Horn's quaternion method, proper rotation only):
 * scale, R, t minimising sum |s R src_i + t - dst_i|^2.
 * Returns { scale, R (row-major 3x3), t, aligned }.
 */
export function similarityAlign(src, dst, { allowScale = true } = {}) {
	if (src.length !== dst.length || !src.length) throw new Error("similarityAlign needs paired, non-empty point sets");
	const cs = centroid(src);
	const cd = centroid(dst);
	const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	let srcNorm = 0;
	for (let i = 0; i < src.length; i += 1) {
		const a = sub(src[i], cs);
		const b = sub(dst[i], cd);
		srcNorm += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
		for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) S[r][c] += a[r] * b[c];
	}
	const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
	const N = [
		[xx + yy + zz, yz - zy, zx - xz, xy - yx],
		[yz - zy, xx - yy - zz, xy + yx, zx + xz],
		[zx - xz, xy + yx, -xx + yy - zz, yz + zy],
		[xy - yx, zx + xz, yz + zy, -xx - yy + zz],
	];
	const [w, x, y, z] = dominantEigenvector4(N);
	const n = Math.hypot(w, x, y, z) || 1;
	const q = [w / n, x / n, y / n, z / n];
	const R = [
		1 - 2 * (q[2] * q[2] + q[3] * q[3]), 2 * (q[1] * q[2] - q[0] * q[3]), 2 * (q[1] * q[3] + q[0] * q[2]),
		2 * (q[1] * q[2] + q[0] * q[3]), 1 - 2 * (q[1] * q[1] + q[3] * q[3]), 2 * (q[2] * q[3] - q[0] * q[1]),
		2 * (q[1] * q[3] - q[0] * q[2]), 2 * (q[2] * q[3] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]),
	];
	const rot = (p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
	let dot = 0;
	for (let i = 0; i < src.length; i += 1) {
		const ra = rot(sub(src[i], cs));
		const b = sub(dst[i], cd);
		dot += ra[0] * b[0] + ra[1] * b[1] + ra[2] * b[2];
	}
	const scale = allowScale && srcNorm > 0 ? dot / srcNorm : 1;
	const rcs = rot(cs);
	const t = [cd[0] - scale * rcs[0], cd[1] - scale * rcs[1], cd[2] - scale * rcs[2]];
	const aligned = src.map((p) => {
		const r = rot(p);
		return [scale * r[0] + t[0], scale * r[1] + t[1], scale * r[2] + t[2]];
	});
	return { scale, R, t, aligned };
}

/** Mean per-joint Euclidean error of two paired joint sets. */
export function meanJointError(pred, gt) {
	if (pred.length !== gt.length || !pred.length) throw new Error("meanJointError needs paired, non-empty joint sets");
	let total = 0;
	for (let i = 0; i < pred.length; i += 1) total += dist(pred[i], gt[i]);
	return total / pred.length;
}

/** MPJPE after subtracting each set's own root joint. */
export function rootRelativeError(pred, gt, rootIndex = 0) {
	const pr = pred[rootIndex];
	const gr = gt[rootIndex];
	return meanJointError(pred.map((p) => sub(p, pr)), gt.map((g) => sub(g, gr)));
}

/** MPJPE after per-frame similarity Procrustes of pred onto gt. */
export function procrustesError(pred, gt) {
	return meanJointError(similarityAlign(pred, gt).aligned, gt);
}

/** Per-frame position errors of two paired trajectories, summarised. */
export function trajectoryError(pred, gt) {
	if (pred.length !== gt.length || !pred.length) throw new Error("trajectoryError needs paired, non-empty trajectories");
	const errors = pred.map((p, i) => dist(p, gt[i]));
	const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
	const rmse = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
	return { errors, mean, rmse, max: Math.max(...errors), final: errors[errors.length - 1] };
}

/** Summed ground-plane (XZ) step length of a trajectory. */
export function pathLengthXZ(points) {
	let total = 0;
	for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
	return total;
}

/** Ground-plane (XZ) distance from the first to the last point. */
export function displacementXZ(points) {
	const a = points[0];
	const b = points[points.length - 1];
	return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/** pred / gt, or null when gt is 0 (a ratio of nothing is not a number). */
export function ratio(pred, gt) {
	return gt > 0 ? pred / gt : null;
}

/**
 * Intersection over union of two 8-bit masks (pixel set where value >=
 * threshold). Two empty masks agree perfectly: IoU 1.
 */
export function maskIoU(a, b, threshold = 128) {
	if (a.length !== b.length) throw new Error(`maskIoU: mask sizes differ (${a.length} vs ${b.length})`);
	let intersection = 0;
	let union = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i] >= threshold;
		const y = b[i] >= threshold;
		if (x && y) intersection += 1;
		if (x || y) union += 1;
	}
	return { iou: union ? intersection / union : 1, intersection, union };
}

/**
 * Signed distance of every point of a flat [x0, y0, z0, ...] array to an
 * axis-aligned box { min: [x, y, z], max: [x, y, z] }: positive outside
 * (Euclidean distance to the box), negative inside (minus the distance to
 * the nearest face). Reduced to the minimum and the count inside.
 *
 * Self-contained on purpose (no outer references): render.mjs injects its
 * source into the Studio page with Function.prototype.toString.
 */
export function boxContactValues(points, box) {
	const [x0, y0, z0] = box.min;
	const [x1, y1, z1] = box.max;
	let minSigned = Infinity;
	let closest = -1;
	let inside = 0;
	const count = Math.floor(points.length / 3);
	for (let i = 0; i < count; i += 1) {
		const x = points[i * 3];
		const y = points[i * 3 + 1];
		const z = points[i * 3 + 2];
		const dx = Math.max(x0 - x, x - x1);
		const dy = Math.max(y0 - y, y - y1);
		const dz = Math.max(z0 - z, z - z1);
		let signed;
		if (dx <= 0 && dy <= 0 && dz <= 0) {
			signed = Math.max(dx, dy, dz);
			inside += 1;
		} else {
			signed = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
		}
		if (signed < minSigned) {
			minSigned = signed;
			closest = i;
		}
	}
	return { minSignedDistance: minSigned, closestIndex: closest, insideCount: inside, count };
}

/** Contact summary of one frame: closest approach (0 when touching or
 * inside) and deepest penetration (0 when nothing is inside). */
export function contactFromSigned(minSignedDistance) {
	return { minDistanceM: Math.max(0, minSignedDistance), maxPenetrationM: Math.max(0, -minSignedDistance) };
}

/** Validate a box given as { min: [x,y,z], max: [x,y,z] }. */
export function parseBox(value) {
	const box = typeof value === "string" ? JSON.parse(value) : value;
	const ok = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
	if (!box || !ok(box.min) || !ok(box.max)) throw new Error("box must be {\"min\":[x,y,z],\"max\":[x,y,z]} in scene metres");
	if (box.min.some((v, i) => v > box.max[i])) throw new Error("box min must not exceed max on any axis");
	return { min: box.min.slice(), max: box.max.slice() };
}

/**
 * Map every GT timeline frame to the nearest-in-time pred frame. A GT frame
 * whose time lies past the pred's last frame (by more than half a pred frame)
 * is not scored. Returns { predIndex: (number|null)[], scored, dropped }.
 */
export function resampleToTimeline({ gtFrames, gtFps, predFrames, predFps }) {
	if (!(gtFps > 0) || !(predFps > 0)) throw new Error("resampleToTimeline needs positive frame rates");
	const predIndex = [];
	let scored = 0;
	for (let i = 0; i < gtFrames; i += 1) {
		const k = Math.round((i / gtFps) * predFps);
		if (k <= predFrames - 1) {
			predIndex.push(k);
			scored += 1;
		} else {
			predIndex.push(null);
		}
	}
	return { predIndex, scored, dropped: gtFrames - scored, exact: gtFps === predFps && gtFrames === predFrames };
}

/**
 * The scene calibration (Studio sceneCalibration semantics: yaw about the
 * take's anchor A, then offset) that equals applying G(p) = rotateYaw(p, g.yaw)
 * + [g.tx, 0, g.tz] after an existing calibration { yawDeg, offsetX, offsetZ }:
 *   G(A + o + Ry(psi)(U - A)) = A + o' + Ry(psi + theta)(U - A),
 *   o' = Ry(theta)(A + o) + t - A.
 */
export function composeCalibration(calibration, anchor, g) {
	const base = [anchor.x + (calibration.offsetX ?? 0), 0, anchor.z + (calibration.offsetZ ?? 0)];
	const moved = applyYawTranslation(base, g);
	return {
		...calibration,
		yawDeg: (calibration.yawDeg ?? 0) + g.yawDeg,
		offsetX: moved[0] - anchor.x,
		offsetZ: moved[2] - anchor.z,
	};
}

export function mean(values) {
	const finite = values.filter((v) => v !== null && Number.isFinite(v));
	return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}
