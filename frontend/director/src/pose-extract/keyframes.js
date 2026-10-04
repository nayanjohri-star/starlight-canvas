/** Pure pose-change scoring and keyframe selection. */

function landmarkDistance(a, b) {
	let sum = 0;
	let weight = 0;
	const count = Math.min(a.landmarks.length, b.landmarks.length);
	for (let index = 0; index < count; index += 1) {
		const pa = a.landmarks[index];
		const pb = b.landmarks[index];
		if (!pa || !pb) continue;
		const confidence = Math.min(pa.visibility, pb.visibility);
		const delta = Math.hypot(
			pa.position[0] - pb.position[0],
			pa.position[1] - pb.position[1],
			pa.position[2] - pb.position[2]
		);
		sum += delta * confidence;
		weight += confidence;
	}
	return weight > 0 ? sum / weight : 0;
}

export function poseChangeScores(samples) {
	if (!Array.isArray(samples)) throw new Error("poseChangeScores: samples must be an array");
	return samples.map((sample, index) => {
		if (!sample.valid || index === 0 || index === samples.length - 1) return 0;
		const before = samples[index - 1];
		const after = samples[index + 1];
		if (!before.valid || !after.valid) return 0;
		const dtBefore = Math.max(sample.timeS - before.timeS, 1e-6);
		const dtAfter = Math.max(after.timeS - sample.timeS, 1e-6);
		return (
			landmarkDistance(before, sample) / dtBefore +
			landmarkDistance(sample, after) / dtAfter
		);
	});
}

/**
 * Keep valid endpoints plus the strongest local pose-change peaks. Returned
 * indices are source ordered and respect `minSpacingS` wherever possible.
 */
export function selectPoseKeyframes(samples, options = {}) {
	if (!Array.isArray(samples) || samples.length === 0) {
		throw new Error("selectPoseKeyframes: samples must be a non-empty array");
	}
	const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? 12));
	const minSpacingS = Math.max(0, options.minSpacingS ?? 0.25);
	const valid = samples.map((sample, index) => sample.valid ? index : -1).filter((index) => index >= 0);
	if (valid.length === 0) return { indices: [], scores: poseChangeScores(samples) };
	if (maxKeys === 1) return { indices: [valid[0]], scores: poseChangeScores(samples) };

	const scores = poseChangeScores(samples);
	const selected = new Set([valid[0], valid[valid.length - 1]]);
	const peaks = valid
		.filter((index) => index > 0 && index < samples.length - 1)
		.filter((index) => scores[index] >= scores[index - 1] && scores[index] >= scores[index + 1])
		.sort((a, b) => scores[b] - scores[a] || a - b);
	const candidates = [
		...peaks,
		...valid
			.filter((index) => index > 0 && index < samples.length - 1 && !peaks.includes(index))
			.sort((a, b) => scores[b] - scores[a] || a - b),
	];

	for (const index of candidates) {
		if (selected.size >= maxKeys) break;
		const time = samples[index].timeS;
		if ([...selected].every((other) => Math.abs(samples[other].timeS - time) >= minSpacingS)) {
			selected.add(index);
		}
	}
	return { indices: [...selected].sort((a, b) => a - b), scores };
}
