/**
 * effector-constraints.mjs — an authored pose → Kimodo END-EFFECTOR constraints.
 *
 * Round 1 pinned every edit with `fullbody`, which freezes all 77 joints at the
 * keyed frames. That is right for an anchor (a context frame we want held) and
 * wrong for an edit: dragging one hand should move the arm, not weld the legs,
 * the spine and the head to the base take. C5 in the round-2 contract is that
 * split — a hand/foot edit constrains ONLY that effector chain (+ hips).
 *
 * WHY THE SHORTHAND TYPES, NOT "end-effector"
 * -------------------------------------------
 * kimodo/constraints.py TYPE_TO_CLASS maps five EE-flavoured names:
 *
 *     "left-hand" -> LeftHandConstraintSet   (joint_names = ["LeftHand"])
 *     "right-hand"-> RightHandConstraintSet
 *     "left-foot" -> LeftFootConstraintSet
 *     "right-foot"-> RightFootConstraintSet
 *     "end-effector" -> EndEffectorConstraintSet  (generic, joint_names from JSON)
 *
 * The four named ones are thin subclasses of EndEffectorConstraintSet that hard-code
 * `joint_names`; functionally the generic type can express exactly the same thing.
 * We still MUST use the named shorthands, because kimodo/postprocess.py builds its
 * per-frame constraint masks by comparing `constraint.name` against a closed list:
 *
 *     if   constraint.name == "fullbody":   out["FullBody"][frames] = 1.0
 *     elif constraint.name == "left-foot":  out["LeftFoot"][frames]  = 1.0
 *     ...  "right-foot" / "left-hand" / "right-hand" / "root2d"
 *
 * There is no branch for "end-effector". A generic EE constraint would still be
 * applied during sampling but would be INVISIBLE to the postprocessor, so the
 * foot-contact / IK cleanup pass would happily slide the very joint we pinned.
 * Emitting the shorthand is therefore not cosmetic — it is what keeps the edit
 * surviving postprocess.
 *
 * WHY THE PAYLOAD IS SHARED ACROSS ENTRIES
 * ----------------------------------------
 * EndEffectorConstraintSet.from_dict reads THE SAME FIELDS as FullBodyConstraintSet:
 *
 *     local_rot = torch.tensor(dico["local_joints_rot"])       # [T, J, 3] axis-angle
 *     ... _convert_constraint_local_rots_to_skeleton(...)
 *     global_rots, global_pos, _ = skeleton.fk(local_rot_mats,
 *                                              torch.tensor(dico["root_positions"]))
 *
 * i.e. it runs FK over the WHOLE body from the same pose payload and then, in
 * __init__, indexes out only its own chain via skeleton.expand_joint_names. The
 * difference between "left-hand" and "right-foot" is purely which columns of that
 * shared FK result get constrained — the input JSON is byte-identical.
 *
 * So this module does not re-derive anything. It calls buildFullBodyConstraints
 * (pose-constraints.mjs), takes its single entry's frame_indices /
 * local_joints_rot / root_positions, and re-emits that payload once per distinct
 * effector type with the shorthand `type`. Consequences, all deliberate:
 *   - the cskel27 → somaskel77 mapping, the rotation validation and the
 *     lowest-joint grounding are IDENTICAL to round 1's pipeline, which measured
 *     0.00° constraint error on the box. No second implementation to drift.
 *   - all validation lives in buildFullBodyConstraints; we let it throw.
 *   - the arrays are shared BY REFERENCE between entries (not copied). They are
 *     write-once and go straight to JSON.stringify, so sharing is safe and keeps
 *     a two-effector edit the same size in memory. Do not mutate an entry in place.
 *
 * WARNING FOR CALLERS — AN EE CONSTRAINT STILL PINS THE ROOT
 * ----------------------------------------------------------
 * "Effector-scoped" scopes the JOINTS, not the root. EndEffectorConstraintSet
 * .update_constraints appends, unconditionally and for every constrained frame:
 *
 *     data_dict["smooth_root_2d"]      <- root XZ  (from smooth_root_2d if the JSON
 *                                        carries it, else the FK'd pelvis XZ)
 *     data_dict["root_y_pos"]          <- root height
 *     data_dict["global_root_heading"] <- root facing
 *
 * — exactly what FullBodyConstraintSet does. There is no flag to switch it off.
 * So at every keyed frame the character's position, height and facing are frozen
 * to the authored pose regardless of which limb was edited.
 *
 * On a PRESERVED take that is harmless by construction: the pose was read back
 * out of the base take, so the pinned root IS the base's root and the constraint
 * agrees with what scheduled inpainting is already holding there.
 *
 * On a FRESH take (no base motion) it is a real constraint the caller did not
 * ask for: keying one hand at frame 40 also nails the pelvis at frame 40. If that
 * is unwanted the fix is upstream — key fewer frames, or accept it. This module
 * does not strip the root, because the fields Kimodo reads (`root_positions`) are
 * the same ones the FK needs; there is nothing to omit.
 *
 * We deliberately do NOT emit `smooth_root_2d`. Kimodo's from_dict treats it as
 * optional and falls back to the FK'd pelvis XZ, which for a single authored pose
 * is the same number — emitting a hand-rolled "smoothed" root from isolated
 * keyframes would be inventing data.
 *
 * SCOPE, AND WHY THIS MODULE NEVER WIDENS IT
 * ------------------------------------------
 * Only the four limb chains have an EE constraint class. A head, spine, chest,
 * neck, shoulder or hips edit has no effector to scope to. Rather than silently
 * falling back to fullbody — which would re-freeze the whole body, the exact bug
 * C5 exists to remove, and would do it invisibly — we throw. The caller
 * (planEditConstraints) owns the fullbody-vs-EE decision and must make it
 * explicitly: EE entries only when EVERY edited track maps to a limb.
 */

import { buildFullBodyConstraints } from "./pose-constraints.mjs";

export const LEFT_HAND_TYPE = "left-hand";
export const RIGHT_HAND_TYPE = "right-hand";
export const LEFT_FOOT_TYPE = "left-foot";
export const RIGHT_FOOT_TYPE = "right-foot";

/**
 * IK/mid-joint track id -> Kimodo effector constraint type.
 *
 * Track ids are the ones in src/ardy/ik.js (IK_TRACKS + MID_TRACKS). A mid-joint
 * handle edits bones INSIDE a chain (leftElbow moves the upper arm and forearm
 * with the shoulder and wrist pinned), so it is constrained through that chain's
 * effector: the wrist is what carries the elbow's result into Kimodo. FK tracks
 * (head/neck/spine/chest/shoulders/hips) are absent on purpose — see above.
 *
 * Exported as data so the wiring agent can ask "do these tracks map cleanly?"
 * without duplicating the table.
 */
export const EFFECTOR_TRACKS = Object.freeze({
	leftHand: LEFT_HAND_TYPE,
	leftElbow: LEFT_HAND_TYPE,
	rightHand: RIGHT_HAND_TYPE,
	rightElbow: RIGHT_HAND_TYPE,
	leftFoot: LEFT_FOOT_TYPE,
	leftKnee: LEFT_FOOT_TYPE,
	rightFoot: RIGHT_FOOT_TYPE,
	rightKnee: RIGHT_FOOT_TYPE,
});

/** All four effector types, for callers that want to validate a `type` string. */
export const EFFECTOR_TYPES = Object.freeze([
	LEFT_HAND_TYPE,
	RIGHT_HAND_TYPE,
	LEFT_FOOT_TYPE,
	RIGHT_FOOT_TYPE,
]);

/**
 * The Kimodo effector constraint type an IK track maps to, or null if the track
 * has none (head, neck, spine, chest, shoulders, hips, root...).
 *
 * Total and side-effect free: this is the predicate planEditConstraints uses to
 * decide fullbody-vs-EE, so it must never throw.
 *
 * @param {string} track IK track id, e.g. "leftHand"
 * @returns {string|null}
 */
export function effectorTypeForTrack(track) {
	if (typeof track !== "string") return null;
	return Object.hasOwn(EFFECTOR_TRACKS, track) ? EFFECTOR_TRACKS[track] : null;
}

/**
 * Authored poses + the tracks that were edited → Kimodo end-effector constraints.
 *
 * One entry per DISTINCT effector type, in the order each type is first reached
 * while walking `tracks` (so [leftHand, rightFoot] emits left-hand then
 * right-foot, and [leftHand, leftElbow] emits ONE left-hand entry — two entries
 * for the same chain would be redundant work for Kimodo, not a stronger pin).
 *
 * Every entry carries the same payload object references; see the header.
 *
 * @param {Array<{frame:number, pose:{local_rot_mats:number[][][], posed_joints:number[][]}}>} poses
 *   Same shape buildFullBodyConstraints takes: cskel27 locals + posed joints.
 * @param {{genFrames:number, tracks:string[]}} options
 * @returns {Array<{type:string, frame_indices:number[], local_joints_rot:number[][][], root_positions:number[][]}>}
 * @throws if a track has no effector, or on anything buildFullBodyConstraints refuses.
 */
export function buildEffectorConstraints(poses, { genFrames, tracks } = {}) {
	if (!Array.isArray(tracks) || tracks.length === 0) {
		throw new Error(
			`buildEffectorConstraints: tracks must be a non-empty array of IK track ids, got ${JSON.stringify(tracks)}`
		);
	}

	// Scope is resolved BEFORE any pose work: a caller that asked for something
	// this module cannot express should hear about it even if it passed no poses.
	const types = [];
	for (const track of tracks) {
		const type = effectorTypeForTrack(track);
		if (type === null) {
			throw new Error(
				`buildEffectorConstraints: track ${track} has no effector constraint — use fullbody`
			);
		}
		if (!types.includes(type)) types.push(type);
	}

	// The whole payload — and the whole of the validation — comes from round 1.
	const fullbody = buildFullBodyConstraints(poses, { genFrames });
	if (fullbody.length === 0) return [];
	const { frame_indices, local_joints_rot, root_positions } = fullbody[0];

	return types.map((type) => ({
		type,
		frame_indices,
		local_joints_rot,
		root_positions,
	}));
}
