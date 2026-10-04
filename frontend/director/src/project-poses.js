/**
 * Combine project-owned poses with the operator's local library. Project
 * records replace matching local ids so the opened scene and its library use
 * the same pose definition; unrelated local records retain their order.
 */
export function mergeProjectCustomPoses(localPoses, projectPoses) {
	const projectIds = new Set(projectPoses.map((pose) => pose.id));
	return [...localPoses.filter((pose) => !projectIds.has(pose.id)), ...projectPoses];
}
