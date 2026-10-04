const COCO_TO_SMPL = [
	[5, 16], [6, 17], [7, 18], [8, 19], [9, 20], [10, 21],
	[11, 1], [12, 2], [13, 4], [14, 5], [15, 7], [16, 8],
];

const DEFAULT_MIN_CONF = 0.3;
const DEFAULT_SIGMA = 2;
const EPSILON = 1e-10;

function valuesOf(value) {
	return value?.data ?? value;
}

function shapeOf(value) {
	return value?.shape ? Array.from(value.shape) : null;
}

function flatValues(value, name) {
	const data = valuesOf(value);
	if (ArrayBuffer.isView(data) || Array.isArray(data)) return data;
	throw new TypeError(`${name}: expected an array or a shaped array`);
}

function frameRows(value, frames, width, components, name) {
	const shape = shapeOf(value);
	const data = flatValues(value, name);
	if (shape) {
		const expected = [frames, width, components];
		if (shape.length !== 3 || shape.some((n, i) => n !== expected[i])) {
			throw new Error(`${name}: expected shape [${expected.join(", ")}]`);
		}
	}
	if (Array.isArray(data) && data.length === frames && data.every(row => Array.isArray(row))) {
		return data.map((row, frame) => {
			if (row.length !== width || row.some(point => !Array.isArray(point) && !ArrayBuffer.isView(point))) {
				throw new Error(`${name}[${frame}]: expected [${width}, ${components}]`);
			}
			return row.map((point, index) => {
				if (point.length !== components) throw new Error(`${name}[${frame}][${index}]: expected ${components} values`);
				return Array.from(point, Number);
			});
		});
	}
	if (data.length !== frames * width * components) {
		throw new Error(`${name}: expected ${frames * width * components} values`);
	}
	return Array.from({ length: frames }, (_, frame) => Array.from({ length: width }, (_, index) => {
			const offset = (frame * width + index) * components;
			return Array.from(data.slice(offset, offset + components), Number);
		}));
}

function vectorFrames(value, frames, width, name) {
	const shape = shapeOf(value);
	const data = flatValues(value, name);
	if (shape) {
		const expected = [frames, width];
		if (shape.length !== 2 || shape.some((n, i) => n !== expected[i])) {
			throw new Error(`${name}: expected shape [${expected.join(", ")}]`);
		}
	}
	if (Array.isArray(data) && data.length === frames && data.every(row => Array.isArray(row) || ArrayBuffer.isView(row))) {
		return data.map((row, frame) => {
			if (row.length !== width) throw new Error(`${name}[${frame}]: expected ${width} values`);
			return Array.from(row, Number);
		});
	}
	if (data.length !== frames * width) throw new Error(`${name}: expected ${frames * width} values`);
	return Array.from({ length: frames }, (_, frame) => Array.from(data.slice(frame * width, (frame + 1) * width), Number));
}

function matrix3(K) {
	const data = valuesOf(K);
	const shape = shapeOf(K);
	if (shape && (shape.length !== 2 || shape[0] !== 3 || shape[1] !== 3)) throw new Error("K: expected shape [3, 3]");
	const matrix = Array.isArray(data) && data.length === 3 && data.every(row => Array.isArray(row) || ArrayBuffer.isView(row))
		? data.map(row => Array.from(row, Number))
		: data?.length === 9 ? Array.from({ length: 3 }, (_, row) => Array.from(data.slice(row * 3, row * 3 + 3), Number)) : null;
	if (!matrix || matrix.some(row => row.length !== 3 || row.some(value => !Number.isFinite(value)))) throw new Error("K: expected a finite 3x3 matrix");
	if (!(Math.abs(matrix[0][0]) > EPSILON) || !(Math.abs(matrix[1][1]) > EPSILON)) throw new Error("K: fx and fy must be nonzero");
	return matrix;
}

function finiteVector(value, fallback = [0, 0, 0]) {
	return (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length === 3 && Array.from(value).every(Number.isFinite)
		? Array.from(value, Number) : fallback.slice();
}

function addNormal(normal, rhs, row, target, weight) {
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) normal[i][j] += weight * row[i] * row[j];
		rhs[i] += weight * row[i] * target;
	}
}

function solve3(normal, rhs) {
	const a = normal.map((row, i) => [...row, rhs[i]]);
	for (let column = 0; column < 3; column++) {
		let pivot = column;
		for (let row = column + 1; row < 3; row++) {
			if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
		}
		if (Math.abs(a[pivot][column]) <= EPSILON) return null;
		[a[column], a[pivot]] = [a[pivot], a[column]];
		for (let row = column + 1; row < 3; row++) {
			const scale = a[row][column] / a[column][column];
			for (let col = column; col < 4; col++) a[row][col] -= scale * a[column][col];
		}
	}
	const answer = [0, 0, 0];
	for (let row = 2; row >= 0; row--) {
		let value = a[row][3];
		for (let col = row + 1; col < 3; col++) value -= a[row][col] * answer[col];
		answer[row] = value / a[row][row];
	}
	return answer.every(Number.isFinite) ? answer : null;
}

function observations(joints, keypoints, K, minConf) {
	const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
	return COCO_TO_SMPL.flatMap(([coco, smpl]) => {
		const point = keypoints[coco], joint = joints[smpl];
		if (!point || !joint || point.length < 3 || joint.length < 3) return [];
		const confidence = Number(point[2]);
		if (!(confidence >= minConf) || !joint.every(Number.isFinite) || !point.slice(0, 2).every(Number.isFinite)) return [];
		return [{ X: joint[0], Y: joint[1], Z: joint[2], u: point[0], v: point[1], confidence }];
	});
}

function linearTranslation(items, K) {
	const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
	const normal = Array.from({ length: 3 }, () => [0, 0, 0]);
	const rhs = [0, 0, 0];
	for (const item of items) {
		const weight = item.confidence;
		// fx*(X+tx) + (cx-u)*(Z+tz) = 0, and the equivalent y equation.
		addNormal(normal, rhs, [fx, 0, cx - item.u], item.u * item.Z - fx * item.X, weight);
		addNormal(normal, rhs, [0, fy, cy - item.v], item.v * item.Z - fy * item.Y, weight);
	}
	return solve3(normal, rhs);
}

function refineTranslation(start, items, K, iterations = 5) {
	const fx = K[0][0], fy = K[1][1];
	const translation = start.slice();
	for (let iteration = 0; iteration < iterations; iteration++) {
		const normal = Array.from({ length: 3 }, () => [0, 0, 0]);
		const rhs = [0, 0, 0];
		let rows = 0;
		for (const item of items) {
			const x = item.X + translation[0], y = item.Y + translation[1], z = item.Z + translation[2];
			if (!(z > EPSILON)) continue;
			const u = fx * x / z + K[0][2], v = fy * y / z + K[1][2];
			const du = u - item.u, dv = v - item.v;
			const ju = [fx / z, 0, -fx * x / (z * z)];
			const jv = [0, fy / z, -fy * y / (z * z)];
			addNormal(normal, rhs, ju, -du, item.confidence);
			addNormal(normal, rhs, jv, -dv, item.confidence);
			rows += 2;
		}
		if (rows < 3) break;
		const delta = solve3(normal, rhs);
		if (!delta) break;
		translation[0] += delta[0];
		translation[1] += delta[1];
		translation[2] += delta[2];
		if (Math.hypot(...delta) < 1e-8) break;
	}
	return translation;
}

function residual(translation, items, K) {
	let error = 0;
	let weight = 0;
	for (const item of items) {
		const z = item.Z + translation[2];
		if (!(z > EPSILON)) continue;
		const u = K[0][0] * (item.X + translation[0]) / z + K[0][2];
		const v = K[1][1] * (item.Y + translation[1]) / z + K[1][2];
		error += item.confidence * ((u - item.u) ** 2 + (v - item.v) ** 2);
		weight += item.confidence;
	}
	return weight > 0 ? Math.sqrt(error / weight) : Infinity;
}

function gaussianSmooth(translations, sigma) {
	if (!(sigma > 0) || translations.length < 2) return translations.map(translation => translation.slice());
	const radius = Math.ceil(3 * sigma);
	return translations.map((_, frame) => {
		const out = [0, 0, 0];
		let total = 0;
		for (let other = Math.max(0, frame - radius); other <= Math.min(translations.length - 1, frame + radius); other++) {
			const distance = other - frame;
			const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma));
			total += weight;
			for (let axis = 0; axis < 3; axis++) out[axis] += weight * translations[other][axis];
		}
		return out.map(value => value / total);
	});
}

function guardJumps(translations, maxJump) {
	if (!(maxJump > 0) || !Number.isFinite(maxJump)) return translations;
	const guarded = [];
	for (const translation of translations) {
		if (!guarded.length) {
			guarded.push(translation.slice());
			continue;
		}
		const previous = guarded.at(-1);
		const delta = translation.map((value, axis) => value - previous[axis]);
		const distance = Math.hypot(...delta);
		if (distance <= maxJump) guarded.push(translation.slice());
		else {
			const scale = maxJump / distance;
			guarded.push(previous.map((value, axis) => value + delta[axis] * scale));
		}
	}
	return guarded;
}

/**
 * Recover per-frame camera translation from known-size, root-relative SMPL-X
 * joints and COCO-17 observations. `incamTransl` is accepted as the fallback
 * translation because the root-relative joints alone do not contain one.
 */
export function solveTranslations({ jointsRel, kp2d, K, minConf = DEFAULT_MIN_CONF, sigma = DEFAULT_SIGMA, incamTransl, maxJump = Infinity } = {}) {
	const keypointData = flatValues(kp2d, "kp2d");
	const keypointShape = shapeOf(kp2d);
	const frames = keypointShape?.[0] ?? (Array.isArray(keypointData) && keypointData.every(row => Array.isArray(row) || ArrayBuffer.isView(row)) ? keypointData.length : Math.floor(keypointData.length / (17 * 3)));
	if (!Number.isInteger(frames) || frames < 1) throw new Error("kp2d: expected at least one frame");
	const joints = frameRows(jointsRel, frames, 22, 3, "jointsRel");
	const keypoints = frameRows(kp2d, frames, 17, 3, "kp2d");
	const intrinsics = matrix3(K);
	if (!(Number.isFinite(minConf) && minConf >= 0)) throw new Error("minConf: expected a nonnegative number");
	if (!(Number.isFinite(sigma) && sigma >= 0)) throw new Error("sigma: expected a nonnegative number");
	const fallback = incamTransl === undefined
		? Array.from({ length: frames }, () => [0, 0, 0])
		: vectorFrames(incamTransl, frames, 3, "incamTransl");
	const rawTranslations = [];
	const flags = [];
	const frameItems = [];
	for (let frame = 0; frame < frames; frame++) {
		const items = observations(joints[frame], keypoints[frame], intrinsics, minConf);
		let translation = items.length >= 4 ? linearTranslation(items, intrinsics) : null;
		const usedFallback = items.length < 4 || !translation;
		if (usedFallback) translation = finiteVector(fallback[frame]);
		else translation = refineTranslation(translation, items, intrinsics);
		rawTranslations.push(translation);
		flags.push(usedFallback);
		frameItems.push(items);
	}
	const translations = guardJumps(gaussianSmooth(rawTranslations, sigma), maxJump);
	const residualPx = translations.map((translation, frame) => residual(translation, frameItems[frame], intrinsics));
	return { transl: translations, flags, residualPx };
}

export { COCO_TO_SMPL };
