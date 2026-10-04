const IDENTITY_3 = [
	1, 0, 0,
	0, 1, 0,
	0, 0, 1,
];

function flat3(m) {
	return Array.isArray(m[0]) ? m.flat() : m;
}

function rows3(m) {
	return [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
}

function mat3Vec(m, v) {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}

function mat3Mul(a, b) {
	return [
		a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
		a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
		a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
		a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
		a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
		a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
		a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
		a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
		a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
	];
}

function transpose3(m) {
	return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function add3(a, b) {
	return a.map((x, i) => x + b[i]);
}

function scale3(m, s) {
	return m.map((x) => x * s);
}

function skew(v) {
	return [
		0, -v[2], v[1],
		v[2], 0, -v[0],
		-v[1], v[0], 0,
	];
}

function axisAngleToMatrix(axisAngle) {
	const theta = Math.hypot(...axisAngle);
	const W = skew(axisAngle);
	const W2 = mat3Mul(W, W);
	let a;
	let b;
	if (theta < 1e-8) {
		const theta2 = theta * theta;
		a = 1 - theta2 / 6 + theta2 * theta2 / 120;
		b = 0.5 - theta2 / 24 + theta2 * theta2 / 720;
	} else {
		a = Math.sin(theta) / theta;
		b = (1 - Math.cos(theta)) / (theta * theta);
	}
	return add3(add3(IDENTITY_3, scale3(W, a)), scale3(W2, b));
}

function matrixToAxisAngle(m) {
	const trace = m[0] + m[4] + m[8];
	const qw = Math.sqrt(Math.max(0, 1 + trace)) / 2;
	let qx;
	let qy;
	let qz;
	if (qw > 1e-6) {
		const scale = 1 / (4 * qw);
		qx = (m[7] - m[5]) * scale;
		qy = (m[2] - m[6]) * scale;
		qz = (m[3] - m[1]) * scale;
	} else if (m[0] >= m[4] && m[0] >= m[8]) {
		qx = Math.sqrt(Math.max(0, 1 + m[0] - m[4] - m[8])) / 2;
		const scale = qx > 1e-8 ? 1 / (4 * qx) : 0;
		qy = (m[1] + m[3]) * scale;
		qz = (m[2] + m[6]) * scale;
	} else if (m[4] >= m[8]) {
		qy = Math.sqrt(Math.max(0, 1 - m[0] + m[4] - m[8])) / 2;
		const scale = qy > 1e-8 ? 1 / (4 * qy) : 0;
		qx = (m[1] + m[3]) * scale;
		qz = (m[5] + m[7]) * scale;
	} else {
		qz = Math.sqrt(Math.max(0, 1 - m[0] - m[4] + m[8])) / 2;
		const scale = qz > 1e-8 ? 1 / (4 * qz) : 0;
		qx = (m[2] + m[6]) * scale;
		qy = (m[5] + m[7]) * scale;
	}
	const qNorm = Math.hypot(qw, qx, qy, qz);
	if (!(qNorm > 0)) return [0, 0, 0];
	const q = [qw / qNorm, qx / qNorm, qy / qNorm, qz / qNorm];
	if (q[0] < 0) q.forEach((_, i) => { q[i] = -q[i]; });
	const angle = 2 * Math.atan2(Math.hypot(q[1], q[2], q[3]), q[0]);
	if (angle < 1e-12) return [0, 0, 0];
	const scale = angle / Math.hypot(q[1], q[2], q[3]);
	return [q[1] * scale, q[2] * scale, q[3] * scale];
}

function rigidWorldToCamera(camera) {
	const matrix = camera?.worldToCamera;
	if (!Array.isArray(matrix) || matrix.length !== 4 || !matrix.every((row) => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite))) {
		throw new Error("camera.json needs a finite 4x4 worldToCamera matrix");
	}
	if (matrix[3][0] !== 0 || matrix[3][1] !== 0 || matrix[3][2] !== 0 || matrix[3][3] !== 1) {
		throw new Error("camera.json worldToCamera must be an affine 4x4 matrix");
	}
	return matrix;
}

export function cameraFromJson(camera) {
	const matrix = rigidWorldToCamera(camera);
	const R_w2c = [
		matrix[0][0], matrix[0][1], matrix[0][2],
		matrix[1][0], matrix[1][1], matrix[1][2],
		matrix[2][0], matrix[2][1], matrix[2][2],
	];
	const t_w2c = [matrix[0][3], matrix[1][3], matrix[2][3]];
	const R_c2w = transpose3(R_w2c);
	const t_c2w = scale3(mat3Vec(R_c2w, t_w2c), -1);
	const K = camera.K?.map((row) => row.slice()) ?? [
		[camera.fx, 0, camera.cx],
		[0, camera.fy, camera.cy],
		[0, 0, 1],
	];
	if (!Array.isArray(K) || K.length !== 3 || !K.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))) {
		throw new Error("camera.json needs a finite 3x3 K matrix");
	}
	return { K, R_c2w: rows3(R_c2w), t_c2w, R_w2c: rows3(R_w2c), t_w2c };
}

export function camToWorldPoint(p, cam) {
	return add3(mat3Vec(flat3(cam.R_c2w), p), cam.t_c2w);
}

export function worldToCameraPoint(p, cam) {
	return add3(mat3Vec(flat3(cam.R_w2c), p), cam.t_w2c);
}

export function camToWorldOrient(axisAngleCam, cam) {
	return matrixToAxisAngle(mat3Mul(flat3(cam.R_c2w), axisAngleToMatrix(axisAngleCam)));
}

export function worldToCamOrient(axisAngleWorld, cam) {
	return matrixToAxisAngle(mat3Mul(flat3(cam.R_w2c), axisAngleToMatrix(axisAngleWorld)));
}

export function worldToPixel(p, cam) {
	const [x, y, depth] = worldToCameraPoint(p, cam);
	return [cam.K[0][0] * x / depth + cam.K[0][2], cam.K[1][1] * y / depth + cam.K[1][2], depth];
}

export function pixelRay(u, v, cam) {
	const rayCamera = [
		(u - cam.K[0][2]) / cam.K[0][0],
		(v - cam.K[1][2]) / cam.K[1][1],
		1,
	];
	const direction = mat3Vec(flat3(cam.R_c2w), rayCamera);
	const length = Math.hypot(...direction);
	return { origin: cam.t_c2w.slice(), direction: direction.map((x) => x / length) };
}

export { axisAngleToMatrix, matrixToAxisAngle };
