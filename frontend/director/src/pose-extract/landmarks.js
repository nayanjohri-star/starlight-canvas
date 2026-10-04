/**
 * Pure MediaPipe Pose landmark preparation.
 *
 * Input samples use MediaPipe's 33-landmark shape and camera coordinates
 * (X right, Y down, Z away from the camera). Output is hip-centred, Y-up,
 * forward-positive and torso-normalised. Root translation is intentionally
 * discarded: CozyClay authors it with waypoints and ARDY synthesises it.
 */

export const POSE_LANDMARK = Object.freeze({
	NOSE: 0,
	LEFT_EYE: 2,
	RIGHT_EYE: 5,
	LEFT_EAR: 7,
	RIGHT_EAR: 8,
	LEFT_SHOULDER: 11,
	RIGHT_SHOULDER: 12,
	LEFT_ELBOW: 13,
	RIGHT_ELBOW: 14,
	LEFT_WRIST: 15,
	RIGHT_WRIST: 16,
	LEFT_PINKY: 17,
	RIGHT_PINKY: 18,
	LEFT_INDEX: 19,
	RIGHT_INDEX: 20,
	LEFT_HIP: 23,
	RIGHT_HIP: 24,
	LEFT_KNEE: 25,
	RIGHT_KNEE: 26,
	LEFT_ANKLE: 27,
	RIGHT_ANKLE: 28,
	LEFT_HEEL: 29,
	RIGHT_HEEL: 30,
	LEFT_FOOT_INDEX: 31,
	RIGHT_FOOT_INDEX: 32,
});

const REQUIRED_CORE = [
	POSE_LANDMARK.LEFT_SHOULDER,
	POSE_LANDMARK.RIGHT_SHOULDER,
	POSE_LANDMARK.LEFT_HIP,
	POSE_LANDMARK.RIGHT_HIP,
];

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function midpoint(a, b) {
	return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function distance(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function readLandmark(entry, index, minVisibility, mirrored) {
	if (!entry || !finite(entry.x) || !finite(entry.y) || !finite(entry.z)) return null;
	const visibility = finite(entry.visibility) ? entry.visibility : 1;
	if (visibility < minVisibility) return null;
	return {
		position: [(mirrored ? -1 : 1) * entry.x, -entry.y, -entry.z],
		visibility,
		index,
	};
}

/** Normalize one `{ timeS, landmarks }` sample without using DOM or three.js. */
export function normalizeLandmarkSample(sample, options = {}) {
	const minVisibility = options.minVisibility ?? 0.35;
	const mirrored = options.mirrored === true;
	if (!sample || !finite(sample.timeS) || sample.timeS < 0) {
		throw new Error("normalizeLandmarkSample: sample.timeS must be a non-negative finite number");
	}
	if (!Array.isArray(sample.landmarks) || sample.landmarks.length < 33) {
		throw new Error("normalizeLandmarkSample: landmarks must contain the 33 MediaPipe Pose landmarks");
	}
	const landmarks = sample.landmarks.map((entry, index) =>
		readLandmark(entry, index, minVisibility, mirrored)
	);
	if (REQUIRED_CORE.some((index) => landmarks[index] === null)) {
		return { timeS: sample.timeS, landmarks, valid: false, scale: null };
	}

	const leftHip = landmarks[POSE_LANDMARK.LEFT_HIP].position;
	const rightHip = landmarks[POSE_LANDMARK.RIGHT_HIP].position;
	const leftShoulder = landmarks[POSE_LANDMARK.LEFT_SHOULDER].position;
	const rightShoulder = landmarks[POSE_LANDMARK.RIGHT_SHOULDER].position;
	const hipCentre = midpoint(leftHip, rightHip);
	const shoulderCentre = midpoint(leftShoulder, rightShoulder);
	const torso = distance(hipCentre, shoulderCentre);
	const shoulderWidth = distance(leftShoulder, rightShoulder);
	const hipWidth = distance(leftHip, rightHip);
	const scale = torso > 1e-6 ? torso : Math.max(shoulderWidth, hipWidth);
	if (!(scale > 1e-6)) return { timeS: sample.timeS, landmarks, valid: false, scale: null };

	for (const landmark of landmarks) {
		if (!landmark) continue;
		landmark.position = landmark.position.map((value, axis) =>
			(value - hipCentre[axis]) / scale
		);
	}
	return { timeS: sample.timeS, landmarks, valid: true, scale };
}

export function normalizeLandmarkTrack(samples, options = {}) {
	if (!Array.isArray(samples) || samples.length === 0) {
		throw new Error("normalizeLandmarkTrack: samples must be a non-empty array");
	}
	let previous = -Infinity;
	return samples.map((sample) => {
		if (sample?.timeS <= previous) {
			throw new Error("normalizeLandmarkTrack: sample times must be strictly ascending");
		}
		previous = sample.timeS;
		return normalizeLandmarkSample(sample, options);
	});
}

function smoothingAlpha(cutoff, dt) {
	const tau = 1 / (2 * Math.PI * cutoff);
	return 1 / (1 + tau / dt);
}

/** One-Euro filter over a normalised track. Missing/low-confidence points stay released. */
export function filterLandmarkTrack(samples, options = {}) {
	const minCutoff = options.minCutoff ?? 1;
	const beta = options.beta ?? 0.08;
	const derivativeCutoff = options.derivativeCutoff ?? 1;
	const state = new Array(33).fill(null);
	return samples.map((sample) => {
		const landmarks = sample.landmarks.map((landmark, index) => {
			if (!landmark) return null;
			const previous = state[index];
			if (!previous) {
				state[index] = {
				timeS: sample.timeS,
				raw: landmark.position.slice(),
				filtered: landmark.position.slice(),
				derivative: [0, 0, 0],
			};
				return { ...landmark, position: landmark.position.slice() };
			}
			const dt = Math.max(sample.timeS - previous.timeS, 1e-6);
			const derivativeAlpha = smoothingAlpha(derivativeCutoff, dt);
			const rawDerivative = landmark.position.map((value, axis) =>
				(value - previous.raw[axis]) / dt
			);
			const derivative = rawDerivative.map((value, axis) =>
				previous.derivative[axis] + derivativeAlpha * (value - previous.derivative[axis])
			);
			const speed = Math.hypot(...derivative);
			const alpha = smoothingAlpha(minCutoff + beta * speed, dt);
			const filtered = landmark.position.map((value, axis) =>
				previous.filtered[axis] + alpha * (value - previous.filtered[axis])
			);
			state[index] = { timeS: sample.timeS, raw: landmark.position.slice(), filtered, derivative };
			return { ...landmark, position: filtered };
		});
		return { ...sample, landmarks };
	});
}
