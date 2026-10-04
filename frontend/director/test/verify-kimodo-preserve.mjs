import assert from "node:assert/strict";
import {
	buildPreserveMask,
	preserveMaskStats,
	rootFreeMask,
	PRESERVE_MASK_VERSION,
	PRESERVE_MASK_VERSION_V2,
	PRESERVE_GROUPS,
	TRACK_GROUPS,
	DEFAULT_INFLUENCE_RADIUS,
	DEFAULT_WIDE_RADIUS_SCALE,
} from "../tools/kimodo/preserve-mask.mjs";

function pass(label) { console.log(`PASS ${label}`); }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// Scheduled inpainting preserves an existing take and regenerates only what the
// user edited. The mask is the ONLY thing standing between "the edit is smoothly
// blended into the old take" and "the character snaps at the seam", so every
// assertion below pins one property the blend depends on: frame space, the shape
// of the shoulder, how overlaps combine, and the clip's own edges.
const APP_FPS = 20;
const GEN_FPS = 30;

// The Gaussian the module builds, restated independently so the tests compare
// against the CONTRACT rather than against whatever the implementation did.
const shoulder = (distance, radius) => 1 - Math.exp(-(distance * distance) / (2 * (radius / 2) ** 2));

// ---- no edits at all: pure reconstruction ---------------------------------
// This is acceptance gate G1 (no edits + strength 0.5 must reproduce the base
// take). An empty edit list is therefore VALID input, not an error, and must
// mean "preserve everything".
{
	const mask = buildPreserveMask([], { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 });
	assert.equal(mask.version, PRESERVE_MASK_VERSION, "the emitted mask must declare the v1 schema");
	assert.equal(mask.version, 1);
	assert.equal(mask.genFps, GEN_FPS);
	assert.equal(mask.genFrames, 180);
	assert.equal(mask.weights.length, 180, "weights must be dense, one per generation frame");
	assert.ok(mask.weights.every((weight) => weight === 1), "with no edits every frame is fully preserved");
	assert.deepEqual(preserveMaskStats(mask), { freeFrames: 0, preservedFrames: 180, rampFrames: 0 });
	pass("an empty edit list preserves the whole take");
}

// ---- one edit zeroes its span and grows symmetric shoulders ----------------
// Inside the edit the model must be completely free (weight 0) or the user's
// change cannot happen; outside it the influence has to decay smoothly and
// identically in both directions, or the seam is asymmetric and the character
// leans into one side of the edit.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	// The edit is free end to end.
	for (let frame = 60; frame < 120; frame += 1) {
		assert.equal(mask.weights[frame], 0, `frame ${frame} is inside the edit and must be free`);
	}
	// The shoulders match the documented Gaussian exactly, one step out and ten.
	assert.ok(near(mask.weights[59], shoulder(1, 10)), `leading shoulder at d=1, got ${mask.weights[59]}`);
	assert.ok(near(mask.weights[120], shoulder(1, 10)), `trailing shoulder at d=1, got ${mask.weights[120]}`);
	assert.ok(near(mask.weights[50], shoulder(10, 10)), `leading shoulder at d=10, got ${mask.weights[50]}`);
	assert.ok(near(mask.weights[129], shoulder(10, 10)), `trailing shoulder at d=10, got ${mask.weights[129]}`);
	// SYMMETRY: frame `start - k` must equal frame `(end - 1) + k`. The exclusive
	// end is the classic off-by-one here; asymmetry means the trailing shoulder
	// is shifted a frame relative to the leading one.
	for (let step = 1; step <= 40; step += 1) {
		assert.ok(
			near(mask.weights[60 - step], mask.weights[119 + step]),
			`shoulders must be symmetric at step ${step}: ${mask.weights[60 - step]} vs ${mask.weights[119 + step]}`
		);
	}
	// The shoulder is monotone: influence only ever fades as you move away.
	for (let frame = 120; frame < 179; frame += 1) {
		assert.ok(
			mask.weights[frame + 1] >= mask.weights[frame],
			`the shoulder must not rise and fall; frame ${frame} -> ${frame + 1}`
		);
	}
	// Far from the edit the base take is preserved untouched.
	assert.equal(mask.weights[0], 1, "a frame far from the edit must be fully preserved");
	assert.equal(mask.weights[179], 1, "a frame far from the edit must be fully preserved");
	pass("a single edit zeroes its span and tapers symmetrically on both sides");
}

// ---- app frames scale onto the generation clock ---------------------------
// CozyClay authors edits against the app's 20 fps clip; Kimodo generates at 30.
// Skipping the scale would free the wrong two thirds of the take, and the rule
// must be the SAME one buildRoot2dConstraints uses or a waypoint and an edit
// authored on the same app frame land on different generation frames.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	// app [40, 80) @ 20 fps -> gen [60, 120) @ 30 fps, half-open at both ends.
	assert.notEqual(mask.weights[59], 0, "gen frame 59 is before the edit and must not be free");
	assert.equal(mask.weights[60], 0, "app frame 40 @20fps must free gen frame 60 @30fps");
	assert.equal(mask.weights[119], 0, "the last frame of the edit is end-1 = 119");
	assert.notEqual(mask.weights[120], 0, "the range is half-open: gen frame 120 is outside the edit");
	// A 1:1 clock must not move anything at all.
	const unscaled = buildPreserveMask([{ startFrame: 10, endFrame: 20 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(unscaled.weights[9] === 0, false);
	assert.equal(unscaled.weights[10], 0, "with appFps == genFps the frames pass through unchanged");
	assert.equal(unscaled.weights[19], 0);
	assert.equal(unscaled.weights[20] === 0, false);
	pass("20 fps app ranges scale onto 30 fps generation frames");
}

// ---- overlapping edits take the MINIMUM weight -----------------------------
// Two shoulders meeting in a gap must not add up to more preservation than
// either edit asked for on its own. Min is the only rule that keeps the mask
// monotone in the number of edits: adding an edit can never preserve a frame
// harder than it was before.
{
	const options = { appFps: 30, genFps: 30, genFrames: 120 };
	const first = buildPreserveMask([{ startFrame: 30, endFrame: 40 }], options);
	const second = buildPreserveMask([{ startFrame: 50, endFrame: 60 }], options);
	const both = buildPreserveMask(
		[{ startFrame: 30, endFrame: 40 }, { startFrame: 50, endFrame: 60 }],
		options
	);
	for (let frame = 0; frame < 120; frame += 1) {
		assert.ok(
			near(both.weights[frame], Math.min(first.weights[frame], second.weights[frame])),
			`frame ${frame} must take the minimum of the two edits, got ${both.weights[frame]}`
		);
		assert.ok(both.weights[frame] <= first.weights[frame], `adding an edit must never raise frame ${frame}`);
	}
	// Both spans are still fully free, and the gap between them is a blend, not a
	// preserved island.
	for (const frame of [30, 39, 50, 59]) assert.equal(both.weights[frame], 0, `frame ${frame} is inside an edit`);
	assert.ok(both.weights[45] > 0 && both.weights[45] < 1, "the gap between two edits stays a partial blend");
	// Literally overlapping ranges collapse into one continuous free span.
	const merged = buildPreserveMask(
		[{ startFrame: 30, endFrame: 45 }, { startFrame: 40, endFrame: 60 }],
		options
	);
	for (let frame = 30; frame < 60; frame += 1) {
		assert.equal(merged.weights[frame], 0, `overlapping edits must free the whole union, frame ${frame}`);
	}
	pass("overlapping edits combine by minimum weight");
}

// ---- an edit on the clip's first frame ------------------------------------
// The shoulder would like to extend before frame 0. There is nothing there to
// preserve, so it must simply be absent rather than shifted inward (which would
// preserve frames the user actually edited).
{
	const mask = buildPreserveMask([{ startFrame: 0, endFrame: 10 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights.length, 60, "a clipped shoulder must not change the mask length");
	for (let frame = 0; frame < 10; frame += 1) assert.equal(mask.weights[frame], 0, `frame ${frame} is edited`);
	assert.ok(near(mask.weights[10], shoulder(1, 10)), "only the trailing shoulder exists");
	assert.ok(mask.weights.every((weight) => Number.isFinite(weight)), "clipping must not produce NaN");
	pass("an edit touching frame 0 has no leading shoulder and no out-of-range frames");
}

// ---- an edit on the clip's last frame -------------------------------------
// The exclusive end is the trap: clamping it to genFrames - 1 would silently
// preserve the final frame even though the user edited right up to it.
{
	const mask = buildPreserveMask([{ startFrame: 50, endFrame: 60 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights.length, 60);
	assert.equal(mask.weights[59], 0, "an edit running to the clip end must free the LAST frame");
	assert.equal(mask.weights[50], 0);
	assert.ok(near(mask.weights[49], shoulder(1, 10)), "only the leading shoulder exists");
	// An edit that runs PAST the end still owns the frames it shares with the
	// clip; clamping is the honest reading, dropping it would ignore the edit.
	const overrun = buildPreserveMask([{ startFrame: 55, endFrame: 999 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(overrun.weights.length, 60);
	for (let frame = 55; frame < 60; frame += 1) assert.equal(overrun.weights[frame], 0, `frame ${frame} is edited`);
	pass("an edit touching the last frame frees it and never ramps past the clip");
}

// ---- a range that rounds down to nothing still frees a frame --------------
// A 60 fps app clock halves onto a 30 fps generation clock, so a one-frame edit
// can round to an empty span. Collapsing it would drop the user's edit while
// reporting success.
{
	const mask = buildPreserveMask([{ startFrame: 10, endFrame: 11 }], {
		appFps: 60,
		genFps: 30,
		genFrames: 60,
	});
	assert.equal(mask.weights[5], 0, "a collapsed range must still free at least one generation frame");
	assert.equal(preserveMaskStats(mask).freeFrames, 1);
	pass("a range that rounds onto a single generation frame is not dropped");
}

// ---- the boundary must never be a hard step -------------------------------
// The paper's ablation is explicit: a square kernel breaks motion at the seam.
// The per-frame delta at a range boundary is the direct measure of that, so it
// is asserted rather than assumed.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	let maxDelta = 0;
	for (let frame = 0; frame < mask.weights.length - 1; frame += 1) {
		maxDelta = Math.max(maxDelta, Math.abs(mask.weights[frame + 1] - mask.weights[frame]));
	}
	assert.ok(maxDelta < 0.5, `the default radius must never step; max per-frame delta was ${maxDelta}`);
	// The step ACROSS the boundary itself is the smallest one in the whole ramp:
	// the Gaussian is flattest at d = 0 and steepest around d = sigma, which is
	// exactly the property that stops the character snapping where the edit ends.
	const boundaryDelta = Math.abs(mask.weights[120] - mask.weights[119]);
	assert.ok(near(boundaryDelta, shoulder(1, 10)), `the boundary step must be the Gaussian at d=1, got ${boundaryDelta}`);
	assert.ok(boundaryDelta < 0.05, `the boundary step must be gentle, got ${boundaryDelta}`);
	assert.ok(boundaryDelta < maxDelta, "the ramp must be steepest away from the seam, not at it");
	// A narrow radius is steeper but still not a step.
	const narrow = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
		influenceRadius: 2,
	});
	let narrowMax = 0;
	for (let frame = 0; frame < narrow.weights.length - 1; frame += 1) {
		narrowMax = Math.max(narrowMax, Math.abs(narrow.weights[frame + 1] - narrow.weights[frame]));
	}
	assert.ok(narrowMax < 0.5, `even a 2-frame radius must taper, max delta ${narrowMax}`);
	pass("the boundary tapers: max per-frame delta stays well under a step");
}

// ---- influenceRadius 0 is the opt-in hard edge ----------------------------
// The broken case from the paper is kept REACHABLE so it can be measured
// (tools/kimodo/measure-preserve.mjs) and so a caller that smooths its own seam
// can opt out. It is never the default, and this test documents what it costs.
{
	const mask = buildPreserveMask([{ startFrame: 30, endFrame: 40 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 90,
		influenceRadius: 0,
	});
	assert.ok(
		mask.weights.every((weight) => weight === 0 || weight === 1),
		"radius 0 must produce a binary mask with no ramp at all"
	);
	assert.deepEqual(preserveMaskStats(mask), { freeFrames: 10, preservedFrames: 80, rampFrames: 0 });
	// ...and this is exactly the full step the default radius avoids.
	assert.equal(Math.abs(mask.weights[30] - mask.weights[29]), 1, "radius 0 steps a full 1.0 at the boundary");
	pass("influenceRadius 0 gives the documented hard edge (caller opt-out)");
}

// ---- structural invariants the Python side relies on -----------------------
// generate.py reads this file straight off disk; a short array or a value
// outside [0,1] would become a blend coefficient that amplifies instead of
// mixing, which is a silent corruption rather than a crash.
{
	for (const genFrames of [1, 7, 60, 181]) {
		const mask = buildPreserveMask([{ startFrame: 0, endFrame: 1 }], { appFps: 30, genFps: 30, genFrames });
		assert.equal(mask.weights.length, genFrames, `weights must be exactly genFrames long for ${genFrames}`);
		assert.equal(mask.genFrames, genFrames, "the declared genFrames must match the array length");
		assert.ok(
			mask.weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1),
			`every weight must be finite in [0,1] for genFrames ${genFrames}`
		);
	}
	const mask = buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { appFps: 20, genFps: 30, genFrames: 120 });
	const roundTrip = JSON.parse(JSON.stringify(mask));
	assert.deepEqual(roundTrip, mask, "the mask must survive a JSON round trip unchanged");
	assert.deepEqual(
		Object.keys(roundTrip).sort(),
		["genFps", "genFrames", "version", "weights"],
		"v1 emits exactly the C1 keys; jointWeights is reserved for v2 and must not appear"
	);
	pass("the emitted mask matches the C1 v1 schema and round trips through JSON");
}

// ---- preserveMaskStats reports what the run will actually do --------------
// The UI needs to tell the user how much of their take is being regenerated. A
// run whose ramp dwarfs its free span means the shoulders are wider than the
// edit and the "preserved" take will drift almost everywhere.
{
	const mask = buildPreserveMask([{ startFrame: 100, endFrame: 110 }], {
		appFps: 30,
		genFps: 30,
		genFrames: 300,
	});
	const stats = preserveMaskStats(mask);
	assert.equal(stats.freeFrames, 10, "exactly the edited frames are free");
	assert.ok(stats.rampFrames > 0, "a default-radius edit must produce a blend region");
	assert.ok(stats.preservedFrames > 0, "frames far from the edit must stay fully preserved");
	assert.equal(
		stats.freeFrames + stats.rampFrames + stats.preservedFrames,
		300,
		"every frame must be counted exactly once"
	);
	// The bare array form is accepted too, so callers holding only the weights
	// (the Python-side reader, the measurement tool) need not rebuild the object.
	assert.deepEqual(preserveMaskStats(mask.weights), stats);
	assert.throws(() => preserveMaskStats(null), /weights array/);
	assert.throws(() => preserveMaskStats({ weights: [0, Number.NaN] }), /finite/);
	pass("preserveMaskStats counts free, ramp and preserved frames");
}

// ---- every validation path fails loudly and by name ------------------------
// A malformed mask does not crash Kimodo — it produces a plausible-looking take
// that quietly ignores the user's edit, so bad input must never reach the file.
{
	const opts = { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 };
	const range = [{ startFrame: 10, endFrame: 20 }];

	// editRanges itself
	assert.throws(() => buildPreserveMask(undefined, opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask(null, opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask("40:80", opts), /editRanges must be an array/);
	assert.throws(() => buildPreserveMask({ startFrame: 0, endFrame: 5 }, opts), /editRanges must be an array/);

	// individual entries
	assert.throws(() => buildPreserveMask([null], opts), /editRanges\[0\] must be an object/);
	assert.throws(() => buildPreserveMask([{ startFrame: -1, endFrame: 5 }], opts), /startFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 1.5, endFrame: 5 }], opts), /startFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: null }], opts), /endFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: 2.5 }], opts), /endFrame/);
	assert.throws(() => buildPreserveMask([{ startFrame: 0, endFrame: -3 }], opts), /endFrame/);
	// inverted and empty half-open ranges edit nothing; accepting them would look
	// like a working reconstruction while dropping the user's edit.
	assert.throws(() => buildPreserveMask([{ startFrame: 80, endFrame: 40 }], opts), /non-empty half-open range/);
	assert.throws(() => buildPreserveMask([{ startFrame: 40, endFrame: 40 }], opts), /non-empty half-open range/);

	// a range with no overlap at all names the clip length so the caller can see
	// it built the mask against the wrong take's duration.
	assert.throws(
		() => buildPreserveMask([{ startFrame: 500, endFrame: 600 }], opts),
		/outside the 180-frame clip/
	);
	assert.throws(
		() => buildPreserveMask([{ startFrame: 0, endFrame: 4 }], { appFps: 1000, genFps: 1, genFrames: 180 }),
		/outside the 180-frame clip/
	);

	// clocks and clip length
	assert.throws(() => buildPreserveMask(range, { ...opts, appFps: 0 }), /appFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, appFps: -20 }), /appFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFps: Number.NaN }), /genFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFps: "30" }), /genFps/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: 0 }), /genFrames/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: Number.POSITIVE_INFINITY }), /genFrames/);
	assert.throws(() => buildPreserveMask(range, { ...opts, genFrames: undefined }), /genFrames/);

	// influence radius
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: -1 }), /influenceRadius/);
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: 2.5 }), /influenceRadius/);
	assert.throws(() => buildPreserveMask(range, { ...opts, influenceRadius: null }), /influenceRadius/);
	pass("every malformed edit list, clock and radius is refused by name");
}

// ===========================================================================
// ROUND 2 (C1v2): per-joint-GROUP masks and the noise-scheduled kernel width.
// Everything above this line is v1 and must keep passing byte-for-byte — the
// whole point of the v2 shape is that a caller who does not ask for it never
// sees it.
// ===========================================================================

// ---- the track -> group map is the contract, restated ----------------------
// This map is the single source of truth shared by the bridge, the effector
// constraint builder and the Python feature mapping. A silent change to it does
// not crash anything: it just frees the wrong limb, which looks like a bad
// generation rather than a bug. So the contract's table is transcribed here
// independently and compared.
{
	assert.deepEqual(
		[...PRESERVE_GROUPS],
		["root", "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"],
		"C1v2 names exactly these 7 groups, in this canonical order"
	);
	const expected = {
		leftHand: ["leftArm"], leftElbow: ["leftArm"],
		rightHand: ["rightArm"], rightElbow: ["rightArm"],
		leftFoot: ["leftLeg"], leftKnee: ["leftLeg"],
		rightFoot: ["rightLeg"], rightKnee: ["rightLeg"],
		head: ["head"], neck: ["head"],
		spine: ["torso"], chest: ["torso"],
		leftShoulder: ["torso"], rightShoulder: ["torso"],
		// the pelvis is a bone AND the character's global transform
		hips: ["torso", "root"],
	};
	assert.deepEqual(
		Object.keys(TRACK_GROUPS).sort(),
		Object.keys(expected).sort(),
		"every IK/MID/FK track id in src/ardy/ik.js must map to a group"
	);
	for (const [track, groups] of Object.entries(expected)) {
		assert.deepEqual([...TRACK_GROUPS[track]], groups, `track ${track} maps to ${groups.join("+")}`);
	}
	// Nothing may map to a group the schema does not have — Python would look up
	// a feature range that does not exist.
	for (const [track, groups] of Object.entries(TRACK_GROUPS)) {
		for (const group of groups) {
			assert.ok(PRESERVE_GROUPS.includes(group), `track ${track} maps to unknown group ${group}`);
		}
	}
	pass("TRACK_GROUPS matches the frozen track -> group map");
}

// ---- a tracked range frees ONLY its groups ---------------------------------
// The whole point of feature A: "recompose only the arm". The top level must
// stay at 1 across the edited frames, because Python falls back to the top level
// for every feature no group claims — a top level that dipped here would free
// the legs too and we would be back to a whole-body edit with extra JSON.
{
	const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80, tracks: ["leftHand"] }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 180,
	});
	assert.equal(mask.version, PRESERVE_MASK_VERSION_V2, "groups make this a v2 mask");
	assert.equal(mask.version, 2);
	assert.ok(mask.weights.every((weight) => weight === 1), "a tracked edit must not touch the top-level weights");
	// The top level gets a wideWeights too, and for a tracked-only edit it is the
	// same all-ones array: lerping a preserved feature against itself is a no-op,
	// which is the correct answer for features no group claims. Emitting it keeps
	// "v2 with a schedule => every level has both arrays" true without exceptions.
	assert.ok(mask.wideWeights.every((weight) => weight === 1), "the unedited top level is preserved at every noise level");
	assert.deepEqual(Object.keys(mask.groups), ["leftArm"], "leftHand maps to leftArm and nothing else");

	const arm = mask.groups.leftArm.weights;
	assert.equal(arm.length, 180, "a group array is dense, one weight per generation frame");
	// app [40,80) @20 -> gen [60,120) @30, the same scaling rule as the top level.
	for (let frame = 60; frame < 120; frame += 1) {
		assert.equal(arm[frame], 0, `frame ${frame} is inside the arm edit and must be free FOR THE ARM`);
	}
	// ...and it is the identical Gaussian, not a second implementation.
	assert.ok(near(arm[59], shoulder(1, 10)), `the group shoulder is the v1 Gaussian, got ${arm[59]}`);
	assert.ok(near(arm[50], shoulder(10, 10)), `the group shoulder is the v1 Gaussian, got ${arm[50]}`);
	assert.equal(arm[0], 1, "far from the edit even the freed group is preserved");
	assert.ok(arm.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1), "group weights stay in [0,1]");

	// The unnamed groups are ABSENT rather than emitted as all-ones: absence is
	// what tells Python "fall back to the top level", and it keeps the file from
	// growing 7 identical arrays for a one-limb edit.
	for (const group of ["torso", "root", "head", "rightArm", "leftLeg", "rightLeg"]) {
		assert.equal(mask.groups[group], undefined, `${group} was not edited and must not appear`);
	}
	pass("a tracked edit frees only the mapped group and leaves the top level preserved");
}

// ---- hips frees torso AND root ---------------------------------------------
// The pelvis drag is the one track that spans two groups. Freeing only the bone
// would leave the model rotating a pelvis inside a pinned global heading; the
// two halves of the representation have to move together or they fight.
{
	const mask = buildPreserveMask([{ startFrame: 30, endFrame: 40, tracks: ["hips"] }], {
		appFps: 30,
		genFps: 30,
		genFrames: 120,
	});
	assert.deepEqual(
		Object.keys(mask.groups),
		["root", "torso"],
		"hips frees both groups, emitted in canonical PRESERVE_GROUPS order"
	);
	for (let frame = 30; frame < 40; frame += 1) {
		assert.equal(mask.groups.root.weights[frame], 0, `root must be free on frame ${frame}`);
		assert.equal(mask.groups.torso.weights[frame], 0, `torso must be free on frame ${frame}`);
	}
	assert.deepEqual(mask.groups.root.weights, mask.groups.torso.weights, "one range, one shape, two groups");
	assert.ok(mask.weights.every((weight) => weight === 1), "the arms and legs still ride the base take");

	// Naming the same group twice (elbow + hand) must not deepen the mask: the
	// combine rule is min, and min of a value with itself is itself.
	const once = buildPreserveMask([{ startFrame: 30, endFrame: 40, tracks: ["leftHand"] }], {
		appFps: 30, genFps: 30, genFrames: 120,
	});
	const twice = buildPreserveMask([{ startFrame: 30, endFrame: 40, tracks: ["leftHand", "leftElbow"] }], {
		appFps: 30, genFps: 30, genFrames: 120,
	});
	assert.deepEqual(twice, once, "two tracks in the same group produce the same mask as one");
	// Track order is not information; the JSON must be byte-identical either way.
	const reordered = buildPreserveMask([{ startFrame: 30, endFrame: 40, tracks: ["leftElbow", "leftHand"] }], {
		appFps: 30, genFps: 30, genFrames: 120,
	});
	assert.equal(JSON.stringify(reordered), JSON.stringify(twice), "track order must not change the emitted file");
	pass("hips frees torso AND root; repeated tracks collapse by minimum");
}

// ---- mixed ranges: one whole-body, one tracked -----------------------------
// The trap. Python reads a GROUP's array instead of the top level for that
// group's features, so a group array that carried only its own range would
// EXEMPT the freed limb from the whole-body edit — the user asks to regenerate
// seconds 0.3-0.6 of everything plus the arm later on, and the arm alone stays
// frozen in the first edit. Every group array must therefore be the union.
{
	const options = { appFps: 30, genFps: 30, genFrames: 200 };
	const mask = buildPreserveMask(
		[{ startFrame: 10, endFrame: 20 }, { startFrame: 120, endFrame: 140, tracks: ["leftHand"] }],
		options
	);
	assert.equal(mask.version, 2);
	// Top level: only the whole-body range, exactly as v1 would have built it.
	const wholeBodyOnly = buildPreserveMask([{ startFrame: 10, endFrame: 20 }], options);
	assert.deepEqual(mask.weights, wholeBodyOnly.weights, "the top level sees only the untracked range");
	for (let frame = 120; frame < 140; frame += 1) {
		assert.equal(mask.weights[frame], 1, `frame ${frame} is an ARM edit; the body must stay fully preserved`);
	}
	// The group array carries BOTH.
	const arm = mask.groups.leftArm.weights;
	for (let frame = 10; frame < 20; frame += 1) {
		assert.equal(arm[frame], 0, `the arm must also be freed by the whole-body edit on frame ${frame}`);
	}
	for (let frame = 120; frame < 140; frame += 1) {
		assert.equal(arm[frame], 0, `the arm's own edit frees frame ${frame}`);
	}
	// ...and is nowhere MORE preserved than the top level, which is the same
	// monotonicity the v1 min rule guarantees, restated across the two levels.
	for (let frame = 0; frame < 200; frame += 1) {
		assert.ok(
			arm[frame] <= mask.weights[frame] + 1e-12,
			`a group can only ever be freer than the fallback; frame ${frame}: ${arm[frame]} vs ${mask.weights[frame]}`
		);
	}
	// A group equals the mask you would have got by authoring both ranges as
	// whole-body edits — same function, different scope.
	const asWholeBody = buildPreserveMask(
		[{ startFrame: 10, endFrame: 20 }, { startFrame: 120, endFrame: 140 }],
		options
	);
	assert.deepEqual(arm, asWholeBody.weights, "a group array is the v1 mask of its own union of ranges");
	pass("a group array is the union of its own ranges and every whole-body range");
}

// ---- version stays 1 for a plain call --------------------------------------
// Round 1's files, fixtures and Python reader are still in service. A v1-shaped
// call must therefore emit a v1-shaped file with no new keys at all, whatever
// else the module has learned to do.
{
	for (const options of [
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 },
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180, influenceRadius: 4 },
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180, influenceRadius: 0 },
	]) {
		const mask = buildPreserveMask([{ startFrame: 40, endFrame: 80 }], options);
		assert.equal(mask.version, PRESERVE_MASK_VERSION, "an untracked call stays v1");
		assert.equal(mask.version, 1);
		assert.deepEqual(Object.keys(mask).sort(), ["genFps", "genFrames", "version", "weights"]);
	}
	// Even an explicit "no wide kernel" on a GROUPED mask stays v2 — groups alone
	// are a v2 feature — but emits no wideWeights anywhere.
	const suppressed = buildPreserveMask([{ startFrame: 40, endFrame: 80, tracks: ["head"] }], {
		appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180, wideRadiusScale: null,
	});
	assert.equal(suppressed.version, 2);
	assert.equal(suppressed.wideWeights, undefined, "wideRadiusScale null suppresses the schedule");
	assert.equal(suppressed.groups.head.wideWeights, undefined, "...for the groups too");
	pass("a plain untracked call still emits the exact v1 shape");
}

// ---- the wide kernel is wider, everywhere ----------------------------------
// The paper's Appendix A schedule lerps narrow -> wide as noise rises. If the
// wide array were not uniformly the more permissive one the lerp would preserve
// HARDER at high noise on some frames and softer on others, which is not a
// schedule, it is a lumpy mask that changes shape mid-trajectory.
{
	const options = { appFps: 30, genFps: 30, genFrames: 180 };
	const mask = buildPreserveMask([{ startFrame: 60, endFrame: 120, tracks: ["leftShoulder"] }], options);
	assert.equal(Object.keys(mask.groups)[0], "torso", "the shoulder is a torso track, not an arm one");
	const narrow = mask.groups.torso.weights;
	const wide = mask.groups.torso.wideWeights;
	assert.equal(wide.length, 180, "the wide array is dense too");
	const wideRadius = DEFAULT_INFLUENCE_RADIUS * DEFAULT_WIDE_RADIUS_SCALE;
	assert.equal(wideRadius, 30, "the documented default schedule is radius 10 -> 30");

	// Spot-check one shoulder frame against the contract's Gaussian at BOTH radii.
	// Frame 130 sits 11 frames past the last edited frame (119).
	assert.ok(near(narrow[130], shoulder(11, 10)), `narrow shoulder at d=11, got ${narrow[130]}`);
	assert.ok(near(wide[130], shoulder(11, wideRadius)), `wide shoulder at d=11, got ${wide[130]}`);
	assert.ok(wide[130] < narrow[130] - 0.5, `the wide kernel must be much freer here: ${wide[130]} vs ${narrow[130]}`);

	for (let frame = 0; frame < 180; frame += 1) {
		assert.ok(
			wide[frame] <= narrow[frame] + 1e-12,
			`the wide kernel must never preserve harder than the narrow one; frame ${frame}`
		);
		assert.ok(Number.isFinite(wide[frame]) && wide[frame] >= 0 && wide[frame] <= 1, `wide[${frame}] in [0,1]`);
	}
	// Inside the edit both are 0: width changes the shoulder, never the edit.
	for (let frame = 60; frame < 120; frame += 1) assert.equal(wide[frame], 0, `frame ${frame} is edited`);
	// The wide mask is the SAME builder at a scaled radius, so it must equal the
	// mask you would get by asking for that radius directly.
	const direct = buildPreserveMask([{ startFrame: 60, endFrame: 120, tracks: ["leftShoulder"] }], {
		...options, influenceRadius: wideRadius,
	});
	assert.deepEqual(wide, direct.groups.torso.weights, "wideWeights is the narrow builder at radius * scale");

	// An untracked caller can opt into the schedule by naming the scale.
	const topLevel = buildPreserveMask([{ startFrame: 60, endFrame: 120 }], { ...options, wideRadiusScale: 2 });
	assert.equal(topLevel.version, 2, "asking for a wide kernel is a v2 file");
	assert.equal(topLevel.groups, undefined, "...without inventing groups nobody asked for");
	assert.ok(near(topLevel.wideWeights[130], shoulder(11, 20)), "the named scale is the one used");
	// scale 1 is legal and degenerate: the schedule exists but does nothing.
	const flat = buildPreserveMask([{ startFrame: 60, endFrame: 120 }], { ...options, wideRadiusScale: 1 });
	assert.deepEqual(flat.wideWeights, flat.weights, "scale 1 makes the two masks identical, which is allowed");
	pass("wideWeights is the same Gaussian at a wider radius and is never narrower");
}

// ---- no edits means no width schedule --------------------------------------
// Pure reconstruction (gate G1) has no shoulder, so there is nothing whose width
// could depend on noise. Emitting an all-ones wideWeights would invite a reader
// to lerp between two identical masks and report a feature that did nothing.
{
	for (const options of [
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 150 },
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 150, wideRadiusScale: 3 },
	]) {
		const mask = buildPreserveMask([], options);
		assert.equal(mask.version, 1, "an empty edit list is a v1 reconstruction mask whatever else was asked for");
		assert.deepEqual(Object.keys(mask).sort(), ["genFps", "genFrames", "version", "weights"]);
		assert.ok(mask.weights.every((weight) => weight === 1));
	}
	pass("an empty edit list emits the v1 all-ones mask with no width schedule");
}

// ---- rootFreeMask: preserve + waypoints (paper 4.4) ------------------------
// The drawn path owns the root for the WHOLE clip; the body rides the preserved
// take. Constant arrays, so there is deliberately no wideWeights: a mask with no
// shoulder has no width to schedule.
{
	const mask = rootFreeMask({ genFps: 30, genFrames: 150 });
	assert.deepEqual(Object.keys(mask).sort(), ["genFps", "genFrames", "groups", "version", "weights"]);
	assert.equal(mask.version, 2);
	assert.equal(mask.genFps, 30);
	assert.equal(mask.genFrames, 150);
	assert.equal(mask.weights.length, 150);
	assert.ok(mask.weights.every((weight) => weight === 1), "every non-root feature is fully preserved");
	assert.deepEqual(Object.keys(mask.groups), ["root"]);
	assert.equal(mask.groups.root.weights.length, 150);
	assert.ok(mask.groups.root.weights.every((weight) => weight === 0), "the root is free for the entire clip");
	assert.equal(mask.groups.root.wideWeights, undefined, "a constant mask has no width to schedule");
	assert.deepEqual(JSON.parse(JSON.stringify(mask)), mask, "it must survive a JSON round trip");
	assert.deepEqual(preserveMaskStats(mask), {
		freeFrames: 0,
		preservedFrames: 150,
		rampFrames: 0,
		groups: { root: { freeFrames: 150, preservedFrames: 0, rampFrames: 0 } },
	});
	assert.throws(() => rootFreeMask({ genFps: 30, genFrames: 0 }), /rootFreeMask: genFrames/);
	assert.throws(() => rootFreeMask({ genFrames: 150 }), /rootFreeMask: genFps/);
	pass("rootFreeMask hands the whole clip's root to the drawn path");
}

// ---- per-group stats -------------------------------------------------------
// The top-level summary of a purely grouped mask is "0 free, everything
// preserved" — true, and a completely misleading thing to show a user who is
// about to regenerate an arm. So the per-group counts ride alongside, and are
// ABSENT for a groupless mask so v1 summaries stay deep-equal to what they were.
{
	const options = { appFps: 30, genFps: 30, genFrames: 300 };
	const mask = buildPreserveMask(
		[{ startFrame: 100, endFrame: 110 }, { startFrame: 200, endFrame: 220, tracks: ["rightFoot"] }],
		options
	);
	const stats = preserveMaskStats(mask);
	assert.equal(stats.freeFrames, 10, "the top level counts only the whole-body edit");
	assert.equal(stats.freeFrames + stats.rampFrames + stats.preservedFrames, 300);
	assert.deepEqual(Object.keys(stats.groups), ["rightLeg"], "only emitted groups are counted");
	const leg = stats.groups.rightLeg;
	assert.equal(leg.freeFrames, 30, "the leg is free for its own 20 frames plus the whole-body 10");
	assert.equal(leg.freeFrames + leg.rampFrames + leg.preservedFrames, 300, "every frame counted exactly once");
	assert.ok(leg.rampFrames > stats.rampFrames, "two edits' shoulders ramp more of the clip than one's");

	// A groupless mask must be byte-identical to the v1 summary — no empty
	// `groups: {}` key that a deepEqual in another suite would trip over.
	const plain = preserveMaskStats(buildPreserveMask([{ startFrame: 100, endFrame: 110 }], options));
	assert.deepEqual(Object.keys(plain).sort(), ["freeFrames", "preservedFrames", "rampFrames"]);
	// The bare-array form still works and, having no groups, reports none.
	assert.deepEqual(preserveMaskStats(mask.weights), {
		freeFrames: stats.freeFrames, preservedFrames: stats.preservedFrames, rampFrames: stats.rampFrames,
	});
	assert.throws(() => preserveMaskStats({ weights: [1], groups: { leftArm: {} } }), /groups\.leftArm\.weights/);
	assert.throws(() => preserveMaskStats({ weights: [1], groups: [] }), /groups must be an object/);
	pass("preserveMaskStats reports per-group free/ramp/preserved counts");
}

// ---- malformed tracks are refused by name ----------------------------------
// A typo'd track id must never be dropped: silently ignoring it produces a mask
// that preserves the limb the user just edited, which reads as "the model
// ignored me" rather than as a bug in the request.
{
	const opts = { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 180 };
	const with_ = (tracks) => buildPreserveMask([{ startFrame: 10, endFrame: 20, tracks }], opts);

	assert.throws(() => with_(["leftWing"]), /is not a known IK track id/);
	// The error has to carry the valid ids, because the caller's spelling is
	// usually close and the list is the fix.
	assert.throws(() => with_(["leftWing"]), /leftHand/);
	assert.throws(() => with_(["leftWing"]), /rightShoulder/);
	assert.throws(() => with_(["leftWing"]), /editRanges\[0\]\.tracks\[0\]/);
	// cskel27 JOINT names are the classic mix-up: the mask speaks track ids.
	assert.throws(() => with_(["LeftHand"]), /is not a known IK track id/);
	assert.throws(() => with_(["LeftForeArm"]), /is not a known IK track id/);
	// GROUP names are not track ids either, even though they look like them.
	assert.throws(() => with_(["leftArm"]), /is not a known IK track id/);
	// a good id after a bad one must still be caught, and named by index
	assert.throws(() => with_(["leftHand", "nope"]), /editRanges\[0\]\.tracks\[1\]/);
	assert.throws(() => with_([null]), /is not a known IK track id/);
	assert.throws(() => with_([{ id: "leftHand" }]), /is not a known IK track id/);

	// Shape errors on the key itself.
	assert.throws(() => with_("leftHand"), /tracks must be an array/);
	assert.throws(() => with_({ 0: "leftHand" }), /tracks must be an array/);
	// An empty list is ambiguous between "whole body" and "nothing" and the two
	// differ by the entire clip, so it is refused with the unambiguous spelling.
	assert.throws(() => with_([]), /tracks is empty — omit the key entirely/);
	// Omitting the key is v1 behaviour, and an explicit undefined/null is the
	// same statement a spread-built request makes.
	assert.equal(with_(undefined).version, 1);
	assert.equal(with_(null).version, 1);

	// The wide scale is a multiplier, and a multiplier below 1 inverts the
	// paper's schedule rather than tuning it.
	assert.throws(() => buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { ...opts, wideRadiusScale: 0.5 }), /wideRadiusScale/);
	assert.throws(() => buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { ...opts, wideRadiusScale: 0 }), /wideRadiusScale/);
	assert.throws(() => buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { ...opts, wideRadiusScale: "3" }), /wideRadiusScale/);
	assert.throws(() => buildPreserveMask([{ startFrame: 10, endFrame: 20 }], { ...opts, wideRadiusScale: Number.NaN }), /wideRadiusScale/);
	pass("unknown track ids, malformed tracks lists and bad wide scales are refused by name");
}

// ---- the v2 file the Python side will actually read ------------------------
// generate.py reads this straight off disk. Every array must be dense and in
// [0,1] at every level, and the whole thing must survive JSON — a group array
// that came out short would blend a limb against undefined.
{
	const mask = buildPreserveMask(
		[{ startFrame: 5, endFrame: 15 }, { startFrame: 40, endFrame: 60, tracks: ["hips", "rightHand"] }],
		{ appFps: 20, genFps: 30, genFrames: 150 }
	);
	assert.deepEqual(
		Object.keys(mask),
		["version", "genFps", "genFrames", "weights", "wideWeights", "groups"],
		"the v2 key order is stable so the file diffs cleanly between runs"
	);
	assert.deepEqual(Object.keys(mask.groups), ["root", "torso", "rightArm"], "canonical group order");
	const arrays = [mask.weights, mask.wideWeights];
	for (const group of Object.values(mask.groups)) {
		assert.deepEqual(Object.keys(group), ["weights", "wideWeights"]);
		arrays.push(group.weights, group.wideWeights);
	}
	for (const array of arrays) {
		assert.equal(array.length, 150, "every array is exactly genFrames long");
		assert.ok(array.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1), "every weight in [0,1]");
	}
	assert.deepEqual(JSON.parse(JSON.stringify(mask)), mask, "the v2 mask must survive a JSON round trip");
	pass("the emitted mask matches the C1 v2 schema and round trips through JSON");
}

console.log("OK verify-kimodo-preserve");
