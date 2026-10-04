import { createProceduralRig, disposeProceduralRig } from './procedural-rig.js';
import { applyPose, DEFAULT_POSE, POSE_BONES } from './poses.js';
import { skeletonAnimationTake, AnimationImportError } from './animation-import.js';
import { toArdyWaypoints } from './ardy/waypoints.js';
import { CSKEL27_JOINTS } from './ardy/cskel27.js';
import { canonicalCskel27Reference } from './ardy/to-cskel27.js';
import { deriveBoneOffsets, forwardKinematics, matMul } from './ardy/convert.js';

export const BASIC_ACTIONS = Object.freeze([
	Object.freeze({ id: 'idle', label: '自然站立' }),
	Object.freeze({ id: 'walk', label: '行走' }),
	Object.freeze({ id: 'wave', label: '挥手' }),
]);
const neutral = canonicalCskel27Reference(), offsets = deriveBoneOffsets(neutral.posed_joints, neutral.local_rot_mats);
const failure = message => new AnimationImportError('invalid-animation', message);
const zeroPose = Object.fromEntries(POSE_BONES.map(entry => [entry.id, [0, 0, 0]]));

/** Original analytic motions, generated directly from the original maquette.
 * Their arrays use the same native NPZ schema as imported/edited takes. */
export function createProceduralAction({ preset, frames, fps, model = 'y-bot-tpose', inPlace = false, rootWorldScale = 1, waypoints = [], rotationDeg = 0, anchorX = 0, anchorZ = 0 }) {
	if (!BASIC_ACTIONS.some(action => action.id === preset)) throw failure(`Unknown basic action ${preset}`);
	if (!Number.isSafeInteger(frames) || frames < 1 || ![24, 30].includes(fps) || frames > fps * 30) throw failure('Basic actions require integer frames at 24/30 fps, at most 30 seconds');
	if (!(rootWorldScale > 0) || !Number.isFinite(rootWorldScale) || ![rotationDeg, anchorX, anchorZ].every(Number.isFinite)) throw failure('Invalid action scale or placement');
	const rig = createProceduralRig(model), bones = []; rig.traverse(node => { if (node.isBone) bones.push(node); });
	try {
		const { take } = skeletonAnimationTake({ bones, frames, fps, unitScale: .01, sample(frame) {
			const t = frame / fps, phase = 2 * Math.PI * 1.1 * t;
			const pose = { ...zeroPose, ...DEFAULT_POSE.bones, spine: [.015 * Math.sin(t * Math.PI), 0, 0] };
			if (preset === 'walk') {
				for (const [side, sign] of [['l', 1], ['r', -1]]) {
					const swing = Math.sin(phase) * sign;
					pose[`${side}UpLeg`] = [-.43 * swing, 0, 0]; pose[`${side}Leg`] = [.62 * Math.max(0, swing), 0, 0]; pose[`${side}Foot`] = [-pose[`${side}UpLeg`][0] - pose[`${side}Leg`][0], 0, 0];
					pose[`${side}Arm`] = [DEFAULT_POSE.bones[`${side}Arm`][0] + .3 * swing, 0, sign * -.18];
				}
			} else if (preset === 'wave') {
				pose.rArm = [.6, -.15, -1.05]; pose.rForeArm = [-.65, .4 * Math.sin(t * Math.PI * 4), .3 * Math.sin(t * Math.PI * 4)];
			}
			applyPose(rig, pose);
			const hips = rig.getObjectByName('mixamorigHips'); hips.position.set(0, 98 + .3 * Math.sin(phase * 2), preset === 'walk' && !inPlace ? .8 * t / rootWorldScale * 100 : 0);
			rig.updateMatrixWorld(true);
		} });
		Object.assign(take, { rootWorldScale, anchorX, anchorZ, anchorFrame: 0, rotationDeg, prompt: BASIC_ACTIONS.find(action => action.id === preset).label, actionPreset: preset });
		return waypoints.length ? actionAlongPath(take, waypoints) : take;
	} finally { disposeProceduralRig(rig); }
}

/** Bake the floor path into the take, retaining the original limb animation.
 * A later path edit is applied by re-running this deterministic operation. */
export function actionAlongPath(take, waypoints) {
	if (!Array.isArray(waypoints) || waypoints.length < 2) throw failure('Action path needs at least two waypoints');
	for (const [index, point] of waypoints.entries()) if (!Number.isSafeInteger(point.frame) || point.frame < 0 || point.frame >= take.frames || ![point.x, point.z].every(Number.isFinite) || (index && point.frame <= waypoints[index - 1].frame)) throw failure('Action waypoints require ascending unique in-range integer frames and finite x/z');
	const scale = take.rootWorldScale ?? 1, local = toArdyWaypoints(waypoints, take.rotationDeg ?? 0), result = { ...take, rotMats: take.rotMats.slice(), rootPos: take.rootPos.slice(), posedJoints: take.posedJoints.slice(), anchorX: waypoints[0].x, anchorZ: waypoints[0].z };
	for (let frame = 0; frame < take.frames; frame++) {
		const hi = local.findIndex(point => point.frame >= frame), upper = hi < 0 ? local.at(-1) : local[hi], lower = hi <= 0 ? upper : local[hi - 1];
		const weight = upper.frame === lower.frame ? 0 : (frame - lower.frame) / (upper.frame - lower.frame);
		const x = lower.x + (upper.x - lower.x) * weight, z = lower.z + (upper.z - lower.z) * weight;
		const tangentLower = lower === upper ? (hi === 0 ? local[0] : local.at(-2)) : lower, tangentUpper = lower === upper ? (hi === 0 ? local[1] : local.at(-1)) : upper;
		const dx = tangentUpper.x - tangentLower.x, dz = tangentUpper.z - tangentLower.z, heading = Math.hypot(dx, dz) > 1e-8 ? Math.atan2(dx, dz) : 0;
		const cosine = Math.cos(heading), sine = Math.sin(heading), yaw = [[cosine, 0, sine], [0, 1, 0], [-sine, 0, cosine]];
		const locals = CSKEL27_JOINTS.map((_, joint) => { const at = (frame * 27 + joint) * 9; return [Array.from(result.rotMats.slice(at, at + 3)), Array.from(result.rotMats.slice(at + 3, at + 6)), Array.from(result.rotMats.slice(at + 6, at + 9))]; });
		locals[0] = matMul(yaw, locals[0]);
		const root = [x / scale, result.rootPos[frame * 3 + 1], z / scale], positions = forwardKinematics(locals, offsets, root);
		result.rootPos.set(root, frame * 3);
		for (let joint = 0; joint < 27; joint++) { result.rotMats.set(locals[joint].flat(), (frame * 27 + joint) * 9); result.posedJoints.set(positions[joint], (frame * 27 + joint) * 3); }
	}
	return result;
}

/** Native playback multiplies canonical metres by the rig's leg-height ratio. */
export function actionRootWorldScale(character) {
	return (.93 / .9544128) * (character.scale ?? 1);
}
