/**
 * preserve-mask.mjs — user edit ranges → Kimodo's `--preserve_mask` JSON (C1 v2).
 *
 * Scheduled inpainting (Disney, "Interactive Generative Motion Editing via
 * Scheduled Inpainting", 2026) blends a preserved base take back into the
 * evolving sample inside the denoising loop:
 *
 *   x_blended = alpha_t * noise(base, t) + (1 - alpha_t) * x_gen
 *   alpha_t   = alpha_time(t) * alpha_mask(frame)
 *
 * This file builds ONLY alpha_mask: one float per GENERATION frame, 1 = keep the
 * base take exactly, 0 = let the model generate freely. Everything about
 * diffusion time (sigma_s / sigma_e) lives on the Python side; the mask is a
 * pure function of "which frames did the user edit".
 *
 * Three things are silent-bug shaped here, so each is pinned by
 * test/verify-kimodo-preserve.mjs:
 *
 * 1. FRAME SPACE. Edit ranges arrive in the app's clip space, which runs at
 *    ARDY's 20 fps (src/App.jsx ARDY_FPS). Kimodo generates at 30. An unscaled
 *    range would free the wrong 2/3 of the clip — the user edits seconds 2..4
 *    and the model regenerates seconds 1.33..2.67. The scaling rule is copied
 *    verbatim from buildRoot2dConstraints in ./constraints.mjs (frame * genFps /
 *    appFps, Math.round, clamped into the generated clip) so a waypoint and an
 *    edit range authored on the same app frame always land on the same
 *    generation frame. If that rule ever changes, it must change in both files.
 *
 * 2. THE FALLOFF MUST NOT BE A STEP. The paper's own ablation is explicit: a
 *    square (hard-edged) kernel breaks motion at the seam — the preserved side
 *    is frozen on the base pose and the free side is generated with no knowledge
 *    of it, so the character snaps. The edit's influence therefore decays as a
 *    Gaussian shoulder over `influenceRadius` generation frames:
 *
 *      weight(f) = 1 - exp( -(d^2) / (2 * sigma^2) ),  sigma = influenceRadius/2
 *
 *    where d is the distance in generation frames from f to the NEAREST frame of
 *    the edit range (so d = 0 anywhere inside it, giving weight 0 = fully free).
 *    sigma = radius/2 is chosen so the named radius is 2 sigma: weight is ~0.86
 *    at exactly `influenceRadius` frames out and reaches float-exact 1.0 around
 *    4.3 radii, i.e. "the radius is where the edit has mostly stopped mattering",
 *    not where it is cut off. The first step away from a boundary is only
 *    1 - exp(-1/(2*sigma^2)) (0.0198 for the default radius 10), which is the
 *    smoothness the tests assert.
 *
 * 3. OVERLAPS TAKE THE MINIMUM. Two edits whose shoulders meet must not add up
 *    to MORE preservation in the gap between them than either edit asked for on
 *    its own. Combining by min means "any edit that wants this frame free wins",
 *    which is the only rule that keeps the mask monotone in the number of edits:
 *    adding an edit can never preserve a frame harder than before.
 *
 * ---------------------------------------------------------------------------
 * ROUND 2 (C1v2) adds two orthogonal axes to that same per-frame mask. Both are
 * strictly additive: a call that uses neither emits a byte-identical v1 file.
 *
 * 4. PER-JOINT-GROUP MASKS. "Recompose only the arm" needs a mask that is free
 *    for the arm and preserved for everything else on the SAME frames. The unit
 *    is a GROUP, never a single joint: the seven groups of C1v2 (root, torso,
 *    head, leftArm, rightArm, leftLeg, rightLeg) are the coarsest partition that
 *    still lets a limb move without dragging the body, and they are coarse on
 *    purpose — freeing a forearm while pinning its own hand asks the model for a
 *    pose that does not exist, and it answers with a broken elbow.
 *
 *    Callers name IK TRACK ids (the things the user actually drags in the pose
 *    studio: `leftHand`, `leftElbow`, `hips`, ...), not group names, and
 *    TRACK_GROUPS below is the single source of truth for that mapping —
 *    src/ardy/ik.js owns the track ids, this file owns what they preserve.
 *    `hips` deliberately maps to BOTH torso and root: dragging the hips moves
 *    the pelvis bone AND translates the character, and the two live in different
 *    halves of the motion representation, so freeing only one of them would let
 *    the model fight the half that stayed pinned.
 *
 *    A range WITHOUT tracks is a whole-body edit and lowers the TOP-LEVEL
 *    weights, exactly as in v1. A range WITH tracks lowers only its groups'
 *    arrays and leaves the top level at 1 there. Python reads a group's array
 *    when one exists and falls back to the top level otherwise, so every emitted
 *    group array must ALSO carry the whole-body edits — otherwise a mixed call
 *    (one tracked range + one whole-body range) would quietly EXEMPT the tracked
 *    groups from the whole-body edit, which is the opposite of what was asked.
 *    That is why a group's array is built from the union of its own ranges and
 *    every untracked range, not from its own ranges alone.
 *
 * 5. THE NOISE-SCHEDULED KERNEL WIDTH (paper, Appendix A). One mask width cannot
 *    serve the whole denoising trajectory. At high noise the sample only carries
 *    global structure, so the edit's influence has to reach FAR to move the
 *    trajectory at all; at low noise it carries detail, and a wide mask there
 *    would smear the preserved take. The paper's answer is two masks and a lerp:
 *
 *      alpha_mask(f, t) = lerp(weights[f], wideWeights[f], w(t))
 *
 *    with w(t) rising with noise (Python picks the exact schedule and documents
 *    it). This file emits both arrays; `wideWeights` is the same Gaussian built
 *    with `influenceRadius * wideRadiusScale`. Wider means the shoulder decays
 *    more slowly, so wideWeights[f] <= weights[f] everywhere — the wide mask is
 *    always the more permissive one, never the other way round.
 *
 *    wideWeights is OPT-IN, not automatic: it is emitted when the call carries
 *    tracks (grouped masks are a round-2 feature and always want the schedule)
 *    or when the caller names `wideRadiusScale` explicitly. A plain v1-shaped
 *    call therefore still produces a v1 file, which is what keeps round-1
 *    callers and their fixtures valid.
 *
 * VERSION. `version` is 2 as soon as either axis is used (groups or
 * wideWeights) and 1 otherwise. It is a property of the emitted SHAPE, not of
 * the caller's intent: a reader that only understands v1 can trust that a
 * version-1 file has nothing it would silently ignore.
 */

export const PRESERVE_MASK_VERSION = 1;

/** The version stamped on a mask that uses groups and/or wideWeights. */
export const PRESERVE_MASK_VERSION_V2 = 2;

/** Default shoulder width in GENERATION frames (~0.33 s at 30 fps). */
export const DEFAULT_INFLUENCE_RADIUS = 10;

/**
 * Default multiplier for the high-noise (wide) kernel. 3 comes from the paper's
 * Appendix A ablation: narrower than ~2x and the wide pass barely differs from
 * the narrow one (no schedule at all); much wider than ~4x and the high-noise
 * pass frees most of the clip, which is just "generate from scratch" with extra
 * steps. 3 is the middle of that band.
 */
export const DEFAULT_WIDE_RADIUS_SCALE = 3;

/**
 * The seven mask groups of C1v2, in canonical order. Python maps these to
 * somaskel30 joints and then to motion-rep feature indices; a group missing from
 * a mask means "use the top-level weights for those features".
 */
export const PRESERVE_GROUPS = Object.freeze([
	"root",
	"torso",
	"head",
	"leftArm",
	"rightArm",
	"leftLeg",
	"rightLeg",
]);

/**
 * IK track id -> the mask groups that track's edits free. SINGLE SOURCE OF
 * TRUTH for the JS side (contract: "Track -> group map"); the bridge, the
 * effector-constraint builder and this mask builder must all read it from here.
 *
 * The ids are exactly the ones the pose studio drags, spread across three
 * tables in src/ardy/ik.js: IK_TRACKS (hands/feet), MID_TRACKS (elbows/knees)
 * and FK_TRACKS (hips/spine/chest/neck/head/shoulders). They are NOT cskel27
 * joint names — `leftElbow` is the joint cskel27 calls LeftForeArm, and `chest`
 * spans Spine1/Spine2.
 *
 * Two mappings are worth stating out loud because they look like typos:
 *   - the SHOULDERS belong to `torso`, not to their arm. A clavicle rotation
 *     swings the whole shoulder mass and reads as a torso motion; freeing it
 *     with the arm would let the chest twist inside a preserved spine.
 *   - `hips` frees `torso` AND `root` — the pelvis bone and the character's
 *     global position/heading are different features of the representation and
 *     a hips drag moves both.
 */
export const TRACK_GROUPS = Object.freeze({
	// arms
	leftHand: Object.freeze(["leftArm"]),
	leftElbow: Object.freeze(["leftArm"]),
	rightHand: Object.freeze(["rightArm"]),
	rightElbow: Object.freeze(["rightArm"]),
	// legs
	leftFoot: Object.freeze(["leftLeg"]),
	leftKnee: Object.freeze(["leftLeg"]),
	rightFoot: Object.freeze(["rightLeg"]),
	rightKnee: Object.freeze(["rightLeg"]),
	// head
	head: Object.freeze(["head"]),
	neck: Object.freeze(["head"]),
	// torso
	spine: Object.freeze(["torso"]),
	chest: Object.freeze(["torso"]),
	leftShoulder: Object.freeze(["torso"]),
	rightShoulder: Object.freeze(["torso"]),
	// the pelvis is both a bone and the character's global transform
	hips: Object.freeze(["torso", "root"]),
});

const KNOWN_TRACK_IDS = Object.freeze(Object.keys(TRACK_GROUPS));

function requireFinite(value, label, fn = "buildPreserveMask") {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${fn}: ${label} must be a finite number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requirePositive(value, label, fn = "buildPreserveMask") {
	requireFinite(value, label, fn);
	if (value <= 0) {
		throw new Error(`${fn}: ${label} must be greater than 0, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Resolve one range's `tracks` list to the canonical group names it frees.
 * Returns null when the range has no tracks (a whole-body edit).
 */
function resolveGroups(tracks, index) {
	if (tracks === undefined || tracks === null) return null;
	if (!Array.isArray(tracks)) {
		throw new Error(
			`buildPreserveMask: editRanges[${index}].tracks must be an array of IK track ids, got ${JSON.stringify(tracks)}`
		);
	}
	// An EMPTY list is refused rather than read as either "whole body" or
	// "nothing": both readings are plausible, they differ by the entire clip, and
	// the caller that produced it meant one of them. Omitting the key is the
	// unambiguous way to say "whole body".
	if (tracks.length === 0) {
		throw new Error(
			`buildPreserveMask: editRanges[${index}].tracks is empty — omit the key entirely for a whole-body edit`
		);
	}
	const groups = new Set();
	for (let slot = 0; slot < tracks.length; slot += 1) {
		const track = tracks[slot];
		const mapped = typeof track === "string" ? TRACK_GROUPS[track] : undefined;
		if (!mapped) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}].tracks[${slot}] ${JSON.stringify(track)} is not a known IK track id; ` +
					`valid ids are ${KNOWN_TRACK_IDS.join(", ")}`
			);
		}
		for (const group of mapped) groups.add(group);
	}
	// Canonical order so two callers naming the same tracks in a different order
	// emit byte-identical JSON.
	return PRESERVE_GROUPS.filter((group) => groups.has(group));
}

/**
 * The v1 Gaussian, factored out so the narrow mask, the wide mask and every
 * group array are provably the same function of a range list and a radius.
 *
 * `radius` is a plain number here rather than the validated integer option: the
 * wide kernel is `influenceRadius * wideRadiusScale` and has no reason to land
 * on an integer.
 */
function gaussianWeights(ranges, frameCount, radius) {
	// 1.0 everywhere = preserve the whole base take. Edits only ever subtract.
	const weights = new Array(frameCount).fill(1);
	// sigma = radius/2; see the header for why the named radius is 2 sigma.
	const sigma = radius / 2;
	const twoSigmaSquared = 2 * sigma * sigma;

	for (const { start, end } of ranges) {
		for (let frame = 0; frame < frameCount; frame += 1) {
			// Distance to the NEAREST frame of the range. `end` is exclusive, so the
			// last free frame is end - 1 and the first frame past the range is one
			// step away from it, not zero — getting this wrong would shift the whole
			// trailing shoulder by a frame.
			let distance = 0;
			if (frame < start) distance = start - frame;
			else if (frame > end - 1) distance = frame - (end - 1);

			let weight;
			if (distance === 0) {
				weight = 0; // inside the edit: fully free generation
			} else if (radius === 0) {
				weight = 1; // opt-in hard edge: no shoulder at all
			} else {
				weight = 1 - Math.exp(-(distance * distance) / twoSigmaSquared);
			}

			// MIN, not sum or product: any edit that wants this frame free wins, so
			// adding an edit can never preserve a frame harder than before.
			if (weight < weights[frame]) weights[frame] = weight;
		}
	}

	// Clamp defensively. The Gaussian is analytically inside [0, 1), but the mask
	// is fed straight into a blend coefficient and a value outside [0, 1] there
	// would amplify rather than mix, so the invariant is enforced, not assumed.
	for (let frame = 0; frame < frameCount; frame += 1) {
		weights[frame] = Math.min(1, Math.max(0, weights[frame]));
	}
	return weights;
}

/**
 * Turn APP-space edit ranges into the dense per-frame preserve mask (C1 v1/v2).
 *
 * @param {Array<{startFrame:number,endFrame:number,tracks?:string[]}>} editRanges
 *   Half-open [startFrame, endFrame) ranges in APP frame space (20 fps clip).
 *   An EMPTY array is valid and means "nothing was edited": the result is all
 *   ones, i.e. pure reconstruction of the base take. That case is the project's
 *   G1 acceptance gate, so it must be expressible, not an error.
 *   `tracks` (optional, v2) names IK track ids from TRACK_GROUPS; with it the
 *   range frees only the mapped groups, without it the whole body.
 * @param {{appFps:number, genFps:number, genFrames:number, influenceRadius?:number,
 *          wideRadiusScale?:number|null}} options
 *   `wideRadiusScale` (default 3) is the multiplier for the paper's high-noise
 *   wide kernel. Naming it — at any value — opts into `wideWeights`; passing
 *   null suppresses `wideWeights` even for a grouped mask, which is the escape
 *   hatch for a caller whose Python side predates the schedule.
 * @returns {{version:1|2, genFps:number, genFrames:number, weights:number[],
 *            wideWeights?:number[], groups?:Object<string,{weights:number[],wideWeights?:number[]}>}}
 */
export function buildPreserveMask(editRanges, options = {}) {
	const {
		appFps,
		genFps,
		genFrames,
		influenceRadius = DEFAULT_INFLUENCE_RADIUS,
		wideRadiusScale = DEFAULT_WIDE_RADIUS_SCALE,
	} = options ?? {};
	// Presence, not value: the default width has to exist for grouped masks, but
	// defaulting the EMISSION on would rewrite every round-1 caller's file.
	const wideRequested =
		options !== null && typeof options === "object" &&
		Object.prototype.hasOwnProperty.call(options, "wideRadiusScale");

	if (!Array.isArray(editRanges)) {
		throw new Error(`buildPreserveMask: editRanges must be an array, got ${JSON.stringify(editRanges)}`);
	}
	requirePositive(appFps, "appFps");
	requirePositive(genFps, "genFps");
	requirePositive(genFrames, "genFrames");
	if (genFrames < 1) throw new Error(`buildPreserveMask: genFrames must be >= 1, got ${genFrames}`);
	// influenceRadius 0 is EXPLICITLY ALLOWED and means a hard-edged square
	// kernel. The paper measured that as the broken case, so it is never the
	// default — but a caller that has already smoothed its own seam (or is
	// measuring the ablation, tools/kimodo/measure-preserve.mjs) needs the opt
	// out, and silently substituting a ramp would falsify their measurement.
	if (!Number.isInteger(influenceRadius) || influenceRadius < 0) {
		throw new Error(
			`buildPreserveMask: influenceRadius must be a non-negative integer, got ${JSON.stringify(influenceRadius)}`
		);
	}
	// A scale below 1 would make the "wide" kernel NARROWER than the narrow one,
	// inverting the paper's schedule (high noise would preserve harder than low
	// noise). That is not a tuning choice, it is a sign error, so it is refused.
	if (wideRadiusScale !== null && (!Number.isFinite(wideRadiusScale) || wideRadiusScale < 1)) {
		throw new Error(
			`buildPreserveMask: wideRadiusScale must be a finite number >= 1 (or null to suppress wideWeights), got ${JSON.stringify(wideRadiusScale)}`
		);
	}

	const scale = genFps / appFps;
	const frameCount = Math.round(genFrames);
	const lastFrame = frameCount - 1;

	// Validate and scale every range in author order first, so a bad edit list is
	// refused before any of it shapes the mask.
	const scaled = editRanges.map((range, index) => {
		if (!range || typeof range !== "object") {
			throw new Error(`buildPreserveMask: editRanges[${index}] must be an object`);
		}
		const { startFrame, endFrame, tracks } = range;
		const groups = resolveGroups(tracks, index);
		if (!Number.isInteger(startFrame) || startFrame < 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}].startFrame must be a non-negative integer, got ${JSON.stringify(startFrame)}`
			);
		}
		if (!Number.isInteger(endFrame) || endFrame < 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}].endFrame must be a non-negative integer, got ${JSON.stringify(endFrame)}`
			);
		}
		// Ranges are half-open, so an empty or inverted one edits nothing. It is
		// almost always an off-by-one in the caller rather than intent, and
		// accepting it would produce an all-ones mask that looks like a working
		// reconstruction while silently ignoring the user's edit.
		if (endFrame <= startFrame) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}] must be a non-empty half-open range, got [${startFrame}, ${endFrame})`
			);
		}

		const rawStart = Math.round(startFrame * scale);
		const rawEnd = Math.round(endFrame * scale);
		// A range that misses the generated clip entirely cannot be clamped into
		// anything meaningful — clamping it would free a frame at one end that the
		// user never touched. Refuse it by name, quoting the clip length, because
		// the usual cause is a mask built against a different take's duration.
		if (rawStart >= frameCount || rawEnd <= 0) {
			throw new Error(
				`buildPreserveMask: editRanges[${index}] [${startFrame}, ${endFrame}) scales to generation frames [${rawStart}, ${rawEnd}) which lies outside the ${frameCount}-frame clip`
			);
		}

		// Partial overlap CLAMPS rather than throwing: an edit that runs off the
		// end of the clip still asks for the frames it shares with it.
		const start = Math.min(lastFrame, Math.max(0, rawStart));
		// The exclusive end clamps to frameCount, not frameCount - 1: the last
		// index this frees is end - 1, which is still inside [0, frameCount - 1].
		// Clamping the END index itself would silently preserve the clip's final
		// frame even when the user edited right up to it.
		// A downscale (e.g. 60 fps app -> 30 fps generation) can also round both
		// ends onto one frame; forcing at least one free frame keeps the edit
		// visible instead of collapsing it to nothing.
		const end = Math.min(frameCount, Math.max(start + 1, rawEnd));
		return { start, end, groups };
	});

	// Whole-body ranges shape the top level; tracked ranges shape their groups.
	const wholeBody = scaled.filter((range) => range.groups === null);
	const rangesByGroup = new Map();
	for (const range of scaled) {
		if (range.groups === null) continue;
		for (const group of range.groups) {
			if (!rangesByGroup.has(group)) rangesByGroup.set(group, []);
			rangesByGroup.get(group).push(range);
		}
	}

	const weights = gaussianWeights(wholeBody, frameCount, influenceRadius);

	// No edits at all is pure reconstruction (gate G1): a v1 all-ones mask, and
	// deliberately NO wideWeights — there is no shoulder whose width could be
	// scheduled, and an all-ones wide array would only invite a reader to lerp
	// between two identical masks and call it a feature.
	const hasEdits = scaled.length > 0;
	const hasGroups = rangesByGroup.size > 0;
	const emitWide = hasEdits && wideRadiusScale !== null && (hasGroups || wideRequested);
	const wideRadius = influenceRadius * (wideRadiusScale ?? 1);

	const mask = {
		version: hasGroups || emitWide ? PRESERVE_MASK_VERSION_V2 : PRESERVE_MASK_VERSION,
		genFps,
		genFrames: frameCount,
		weights,
	};
	if (emitWide) mask.wideWeights = gaussianWeights(wholeBody, frameCount, wideRadius);

	if (hasGroups) {
		const groups = {};
		// Canonical order, so the JSON is stable regardless of edit order.
		for (const name of PRESERVE_GROUPS) {
			const own = rangesByGroup.get(name);
			if (!own) continue;
			// The union with `wholeBody` is the load-bearing part: Python reads this
			// array INSTEAD of the top level for the group's features, so a group
			// that dropped the whole-body ranges would be exempted from them.
			const union = wholeBody.concat(own);
			const entry = { weights: gaussianWeights(union, frameCount, influenceRadius) };
			if (emitWide) entry.wideWeights = gaussianWeights(union, frameCount, wideRadius);
			groups[name] = entry;
		}
		mask.groups = groups;
	}

	return mask;
}

/**
 * The preserve + waypoints mask (paper 4.4, round-2 feature B).
 *
 * The user keeps a take's style but redraws its path. The root — global
 * translation and heading — must therefore come entirely from the waypoints,
 * while every other feature rides the preserved take. That is exactly a mask
 * whose `root` group is 0 for the whole clip and whose top level is 1.
 *
 * It lives here rather than in the bridge because it is a MASK SHAPE, and the
 * one thing worse than a one-line helper is two callers each inventing their own
 * spelling of the same shape. No wideWeights: a constant mask has no shoulder,
 * so there is no width to schedule at any noise level.
 *
 * @param {{genFps:number, genFrames:number}} options
 * @returns {{version:2, genFps:number, genFrames:number, weights:number[],
 *            groups:{root:{weights:number[]}}}}
 */
export function rootFreeMask({ genFps, genFrames } = {}) {
	requirePositive(genFps, "genFps", "rootFreeMask");
	requirePositive(genFrames, "genFrames", "rootFreeMask");
	const frameCount = Math.round(genFrames);
	return {
		version: PRESERVE_MASK_VERSION_V2,
		genFps,
		genFrames: frameCount,
		weights: new Array(frameCount).fill(1),
		groups: { root: { weights: new Array(frameCount).fill(0) } },
	};
}

/** Free / ramp / preserved counts for one weights array, validating as it goes. */
function countWeights(weights, label) {
	if (!Array.isArray(weights)) {
		throw new Error(`preserveMaskStats: ${label} must be an array of finite weights`);
	}
	let freeFrames = 0;
	let preservedFrames = 0;
	let rampFrames = 0;
	for (let index = 0; index < weights.length; index += 1) {
		const weight = weights[index];
		if (typeof weight !== "number" || !Number.isFinite(weight)) {
			throw new Error(`preserveMaskStats: ${label}[${index}] must be a finite number, got ${JSON.stringify(weight)}`);
		}
		if (weight === 0) freeFrames += 1;
		else if (weight === 1) preservedFrames += 1;
		else rampFrames += 1;
	}
	return { freeFrames, preservedFrames, rampFrames };
}

/**
 * Summarise a mask for the UI and for run reporting: how much of the take is
 * being regenerated, how much is held, and how much is the blend in between.
 * A run whose rampFrames dwarf its freeFrames is a warning sign — the shoulders
 * are wider than the edit, so the "preserved" take will drift almost everywhere.
 *
 * Accepts either the mask object from buildPreserveMask or a bare weights array.
 *
 * When the mask carries groups the same three counts are reported per group
 * under `groups`, because the top-level numbers of a purely grouped mask are
 * "0 free, everything preserved" — technically true and completely misleading
 * as a summary of a run that is about to regenerate an arm. The key is ABSENT
 * for a groupless mask so a v1 summary stays deep-equal to what it always was.
 *
 * @param {{weights:number[], groups?:object}|number[]} mask
 * @returns {{freeFrames:number, preservedFrames:number, rampFrames:number,
 *            groups?:Object<string,{freeFrames:number,preservedFrames:number,rampFrames:number}>}}
 */
export function preserveMaskStats(mask) {
	const weights = Array.isArray(mask) ? mask : mask && mask.weights;
	if (!Array.isArray(weights)) {
		throw new Error("preserveMaskStats: mask must be a preserve mask object or a weights array");
	}
	const stats = countWeights(weights, "weights");

	const maskGroups = Array.isArray(mask) ? null : mask.groups;
	if (maskGroups !== undefined && maskGroups !== null) {
		if (typeof maskGroups !== "object" || Array.isArray(maskGroups)) {
			throw new Error(`preserveMaskStats: groups must be an object, got ${JSON.stringify(maskGroups)}`);
		}
		const names = Object.keys(maskGroups);
		if (names.length > 0) {
			const groups = {};
			for (const name of names) {
				const group = maskGroups[name];
				groups[name] = countWeights(group && group.weights, `groups.${name}.weights`);
			}
			stats.groups = groups;
		}
	}
	return stats;
}
