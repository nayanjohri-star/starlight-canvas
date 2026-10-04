/**
 * CoreSkeleton27 neutral-pose joint positions (metres, Y-up), exported
 * verbatim from the box (`CoreSkeleton27().neutral_joints`, ~/ardy) — the
 * same reference the viser demo's Mixamo avatar uses as ardy_bind_positions
 * in compute_bone_transforms. Index order == CSKEL27_JOINTS. The hips sit
 * at the origin and the lowest joint (toes) at y = -0.9544128.
 *
 * Positional skinning needs this: a bone's bind offset is measured
 * against the ARDY neutral joint, not against the rig's own rest pose.
 */
export const CSKEL27_NEUTRAL = [
	[0.0, 0.0, 0.0], // Hips
	[0.0, 0.0709891, -0.0473261], // Spine
	[0.0, 0.1642033, -0.0637623], // Spine1
	[0.0, 0.2584953, -0.0720118], // Spine2
	[0.0, 0.3531475, -0.0720119], // Spine3
	[0.0, 0.6016096, -0.0365176], // Neck
	[0.0, 0.7297793, -0.0139179], // Head
	[-0.0319949, 0.5259196, -0.0186873], // RightShoulder
	[-0.1909029, 0.5259195, -0.0186873], // RightArm
	[-0.4863389, 0.5259194, -0.0186873], // RightForeArm
	[-0.7189909, 0.5259193, -0.0186873], // RightHand
	[-0.7886024, 0.5259193, -0.0186873], // RightHandEnd
	[-0.7468355, 0.5073563, 0.0277204], // RightHandThumb1
	[0.0319949, 0.5259196, -0.0186873], // LeftShoulder
	[0.1909029, 0.5259196, -0.0186873], // LeftArm
	[0.4863389, 0.5259196, -0.0186873], // LeftForeArm
	[0.7189909, 0.5259196, -0.0186873], // LeftHand
	[0.7886024, 0.5259196, -0.0186873], // LeftHandEnd
	[0.7468355, 0.5073565, 0.0277204], // LeftHandThumb1
	[-0.0949182, -0.0277289, 0.0], // RightUpLeg
	[-0.0949182, -0.4398469, 0.0], // RightLeg
	[-0.0949182, -0.8959379, 0.0], // RightFoot
	[-0.0949182, -0.9544128, 0.1606583], // RightToeBase
	[0.0949182, -0.0277289, 0.0], // LeftUpLeg
	[0.0949182, -0.4398469, 0.0], // LeftLeg
	[0.0949182, -0.8959379, 0.0], // LeftFoot
	[0.0949182, -0.9544128, 0.1606583], // LeftToeBase
];
