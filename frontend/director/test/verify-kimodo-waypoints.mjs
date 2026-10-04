import assert from "node:assert/strict";
import { buildRoot2dConstraints, ROOT2D_TYPE } from "../tools/kimodo/constraints.mjs";

function pass(label) { console.log(`PASS ${label}`); }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// CozyClay authors waypoints in the app's 20 fps clip space with ABSOLUTE world
// XZ. Kimodo wants generation-space frame indices and XZ relative to a canonical
// origin where the root sits at (0,0) on frame 0. Every assertion below pins one
// half of that translation.
const APP_FPS = 20;
const GEN_FPS = 30;

// ---- happy path: three waypoints -----------------------------------------
{
	const waypoints = [
		{ frame: 0, x: 2, z: -1, heading: null },
		{ frame: 20, x: 3, z: 1, heading: 0 },
		{ frame: 40, x: 2, z: 4, heading: Math.PI / 2 },
	];
	const out = buildRoot2dConstraints(waypoints, { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 61 });
	assert.equal(Array.isArray(out), true, "constraints must be an array");
	assert.equal(out.length, 1, "one root2d entry covers the whole path");
	const entry = out[0];
	assert.equal(entry.type, ROOT2D_TYPE);
	assert.equal(entry.type, "root2d");

	// 20 fps app frames scale onto 30 fps generation frames: 0,20,40 -> 0,30,60.
	assert.deepEqual(entry.frame_indices, [0, 30, 60], "app frames must scale to generation frames");

	// Canonical origin: the FIRST waypoint anchors (0,0); the rest are relative.
	assert.deepEqual(
		entry.smooth_root_2d,
		[[0, 0], [1, 2], [0, 5]],
		"XZ must be translated so waypoint 0 sits at the canonical origin"
	);

	// heading is a [cos,sin] PAIR, never a raw radian.
	assert.equal(entry.global_root_heading.length, 3);
	const [h0, h1, h2] = entry.global_root_heading;
	assert.ok(near(h1[0], 1) && near(h1[1], 0), `heading 0 rad -> [1,0], got ${JSON.stringify(h1)}`);
	assert.ok(near(h2[0], 0) && near(h2[1], 1), `heading pi/2 -> [0,1], got ${JSON.stringify(h2)}`);
	// A null heading must still occupy its slot so the arrays stay index-aligned
	// with frame_indices; it carries the next known heading rather than a hole.
	assert.equal(h0.length, 2, "a null heading must still emit a [cos,sin] pair");
	assert.ok(Number.isFinite(h0[0]) && Number.isFinite(h0[1]), "null heading must not emit NaN");
	pass("three waypoints map to one root2d entry in canonical space");
}

// ---- every heading null: heading is omitted entirely ----------------------
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 10, x: 1, z: 0, heading: null },
		],
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 31 }
	);
	assert.equal(out.length, 1);
	assert.equal(
		"global_root_heading" in out[0],
		false,
		"with no authored heading the optional field must be omitted, not filled with zeros"
	);
	assert.deepEqual(out[0].frame_indices, [0, 15]);
	pass("an all-null heading path omits global_root_heading");
}

// ---- empty input produces no constraints ---------------------------------
{
	assert.deepEqual(buildRoot2dConstraints([], { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 30 }), []);
	assert.deepEqual(buildRoot2dConstraints(undefined, { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 30 }), []);
	pass("an empty or missing path produces no constraints");
}

// ---- a single waypoint is still usable -----------------------------------
// One waypoint at frame 0 carries no displacement, so it constrains nothing and
// must not emit a degenerate entry.
{
	const out = buildRoot2dConstraints([{ frame: 0, x: 5, z: 5, heading: null }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 30,
	});
	assert.deepEqual(out, [], "a lone origin waypoint constrains nothing");
	const withHeading = buildRoot2dConstraints([{ frame: 0, x: 5, z: 5, heading: 0 }], {
		appFps: APP_FPS,
		genFps: GEN_FPS,
		genFrames: 30,
	});
	assert.equal(withHeading.length, 1, "a lone waypoint that fixes heading still constrains");
	pass("a single waypoint only constrains when it carries a heading");
}

// ---- frames beyond the clip are clamped, never dropped silently ----------
// The generated clip has genFrames frames; a constraint past the end would be
// rejected by Kimodo, and dropping it would silently ignore authored intent.
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 999, x: 0, z: 10, heading: null },
		],
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 61 }
	);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].frame_indices, [0, 60], "an out-of-range frame clamps to the last generated frame");
	assert.equal(out[0].smooth_root_2d.length, 2, "clamping must not drop the waypoint's position");
	pass("a frame beyond the clip clamps to the last frame instead of vanishing");
}

// ---- collapsing frames must not produce duplicate indices ----------------
// Two app frames can round onto the same generation frame; duplicate
// frame_indices would make Kimodo constrain one frame twice with different
// targets, so the later one must win and the arrays stay the same length.
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 1, x: 0, z: 1, heading: null },
			{ frame: 2, x: 0, z: 2, heading: null },
		],
		{ appFps: 60, genFps: 30, genFrames: 10 }
	);
	const indices = out[0].frame_indices;
	assert.equal(new Set(indices).size, indices.length, `frame_indices must be unique, got ${indices}`);
	assert.equal(
		out[0].smooth_root_2d.length,
		indices.length,
		"smooth_root_2d must stay index-aligned with frame_indices"
	);
	pass("frames colliding after rescale are deduped and stay index-aligned");
}

// ---- non-ascending input is rejected -------------------------------------
// The bridge already enforces ascending frames, so reaching here means a direct
// CLI caller built a bad path; failing loudly beats emitting a scrambled one.
{
	assert.throws(
		() =>
			buildRoot2dConstraints(
				[
					{ frame: 0, x: 0, z: 0, heading: null },
					{ frame: 10, x: 1, z: 0, heading: null },
					{ frame: 5, x: 2, z: 0, heading: null },
				],
				{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 61 }
			),
		/ascending/i
	);
	pass("a non-ascending path is refused by name");
}

// ---- malformed entries are refused ---------------------------------------
{
	const opts = { appFps: APP_FPS, genFps: GEN_FPS, genFrames: 61 };
	assert.throws(() => buildRoot2dConstraints([{ frame: 0, x: Number.NaN, z: 0, heading: null }], opts), /finite/i);
	assert.throws(() => buildRoot2dConstraints([{ frame: -1, x: 0, z: 0, heading: null }], opts), /frame/i);
	assert.throws(
		() => buildRoot2dConstraints([{ frame: 0, x: 0, z: 0, heading: Number.POSITIVE_INFINITY }], opts),
		/heading/i
	);
	pass("NaN positions, negative frames and non-finite headings are refused");
}

// ---- the emitted object is JSON-serialisable in Kimodo's schema ----------
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: 0 },
			{ frame: 30, x: 0, z: 3, heading: null },
		],
		{ appFps: APP_FPS, genFps: GEN_FPS, genFrames: 61 }
	);
	const roundTrip = JSON.parse(JSON.stringify(out));
	assert.deepEqual(roundTrip, out, "constraints must survive JSON round trip unchanged");
	for (const key of Object.keys(roundTrip[0])) {
		assert.ok(
			["type", "frame_indices", "smooth_root_2d", "global_root_heading"].includes(key),
			`unexpected key ${key} would be rejected by kimodo_gen`
		);
	}
	pass("emitted constraints match Kimodo's documented root2d schema");
}

// ---- segmentBoundaries re-expresses constraints per segment ---------------
// This option EXISTS but is deliberately NOT used by generate.mjs: shipping it
// to the box measured strictly worse than whole-clip authoring (waypoint error
// 0.11 m -> 3.55 m, boundary jump 2.35 m -> 4.48 m), twice. It is kept, pinned,
// and documented so the behaviour is understood rather than silently re-tried.
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 30, x: 1, z: 2, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
		{ frame: 90, x: 5, z: 9, heading: null },
	];
	const out = buildRoot2dConstraints(waypoints, {
		appFps: 20,
		genFps: 20,
		genFrames: 120,
		segmentBoundaries: [60],
	});
	assert.deepEqual(out[0].frame_indices, [0, 30, 60, 90]);
	// Segment 1 (frames 0..59) is relative to the path start (0,0).
	// Segment 2 begins at frame 60 where the path sits at (2,3), so frame 60
	// becomes (0,0) and frame 90 becomes (5-2, 9-3) = (3,6).
	assert.deepEqual(
		out[0].smooth_root_2d,
		[[0, 0], [1, 2], [0, 0], [3, 6]],
		"segment-2 constraints must be displacements from segment 2's start"
	);
	pass("segmentBoundaries (unused by default) re-expresses constraints per segment");
}

// ---- a segment boundary that falls BETWEEN two waypoints ------------------
// The segment need not start on an authored pin, so the origin is sampled
// along the path rather than snapped to the nearest waypoint.
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 100, x: 10, z: 0, heading: null },
		],
		{ appFps: 20, genFps: 20, genFrames: 120, segmentBoundaries: [50] }
	);
	// The boundary at frame 50 is halfway along a straight 10 m path, so the
	// segment-2 origin is x=5 and the frame-100 target becomes 10-5 = 5.
	assert.deepEqual(out[0].smooth_root_2d, [[0, 0], [5, 0]]);
	const flat = out[0].smooth_root_2d.flat();
	assert.ok(flat.every(Number.isFinite), "sampled origin must never produce NaN");
	pass("a boundary between waypoints samples the path for its segment origin");
}

// ---- single-segment behaviour is unchanged --------------------------------
{
	const waypoints = [
		{ frame: 0, x: 2, z: -1, heading: null },
		{ frame: 20, x: 3, z: 1, heading: null },
	];
	const withoutBoundaries = buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 20, genFrames: 60 });
	const emptyBoundaries = buildRoot2dConstraints(waypoints, {
		appFps: 20,
		genFps: 20,
		genFrames: 60,
		segmentBoundaries: [],
	});
	assert.deepEqual(withoutBoundaries, emptyBoundaries);
	assert.deepEqual(withoutBoundaries[0].smooth_root_2d, [[0, 0], [1, 2]]);
	pass("a single-segment take keeps whole-clip anchoring");
}

// ---- constraints must clear a segment's transition window ----------------
// For every segment after the first, Kimodo inserts its OWN transition
// constraints over that segment's first `num_transition_frames`
// (kimodo_model.py builds a FullBodyConstraintSet + EndEffectorConstraintSet
// from the previous segment's tail). A root2d constraint landing in that same
// window fights them, and the root teleports at the seam.
//
// MEASURED on the box, identical path and seed:
//   waypoint ON the boundary (gen frame 90)      -> boundary jump 2.353 m
//   same waypoint 10 gen frames later (frame 100) -> boundary jump 0.400 m
// So a constraint inside the window is pushed just past it. The spatial target
// is preserved exactly; only its timing shifts, which is the smallest change
// that stops the two constraint sets from disagreeing.
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
		{ frame: 119, x: -1, z: 6, heading: null },
	];
	// 3 s + 3 s at 20 fps app / 30 fps generation: segment 2 starts at gen 90.
	const out = buildRoot2dConstraints(waypoints, {
		appFps: 20,
		genFps: 30,
		genFrames: 180,
		segmentStarts: [90],
		transitionFrames: 5,
	});
	const indices = out[0].frame_indices;
	assert.equal(indices[0], 0, "frame 0 is the clip start, never nudged");
	assert.ok(
		indices[1] >= 95,
		`a constraint on the segment boundary must clear the 5-frame transition window, got ${indices[1]}`
	);
	assert.ok(indices[1] < 105, `the nudge must stay small, got ${indices[1]}`);
	// The authored POSITION must be untouched - only timing moves.
	assert.deepEqual(out[0].smooth_root_2d[1], [2, 3], "nudging must not move the target position");
	assert.equal(new Set(indices).size, indices.length, "nudging must not create duplicate frames");
	assert.deepEqual([...indices].sort((a, b) => a - b), indices, "frame_indices must stay ascending");
	pass("a constraint on a segment boundary is nudged clear of the transition window");
}

// ---- a constraint already clear of the window is untouched ---------------
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 80, x: 2, z: 3, heading: null },
		],
		{ appFps: 20, genFps: 30, genFrames: 180, segmentStarts: [90], transitionFrames: 5 }
	);
	assert.deepEqual(out[0].frame_indices, [0, 120], "a frame outside the window must not move");
	pass("a constraint outside the transition window keeps its authored frame");
}

// ---- no segment info behaves exactly as before ---------------------------
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
	];
	const plain = buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 30, genFrames: 180 });
	assert.deepEqual(plain[0].frame_indices, [0, 90], "without segmentStarts nothing is nudged");
	pass("a single-segment take is unaffected by the transition-window rule");
}

// ---- densifyStride lays interpolated constraints along the path -----------
// THE seam fix. A waypoint on a prompt boundary belongs entirely to segment 2
// (crop_move is half-open), so segment 1 never learns the path exists, walks
// wherever it likes, and the root teleports 2.353 m at the seam to satisfy the
// constraint one frame later. Densifying the authored polyline gives segment 1
// intermediate targets, so it arrives at the boundary already in place.
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
	];
	// 3 s + 3 s at 20 fps app / 30 fps generation: segment 2 starts at gen 90,
	// which is exactly where the second waypoint lands.
	const out = buildRoot2dConstraints(waypoints, {
		appFps: 20,
		genFps: 30,
		genFrames: 180,
		segmentStarts: [90],
		transitionFrames: 5,
		densifyStride: 10,
	});
	const indices = out[0].frame_indices;
	// Segment 1 must now see the path: intermediate frames every stride.
	for (const expected of [10, 20, 30, 40, 50, 60, 70, 80]) {
		assert.ok(indices.includes(expected), `densified path must constrain gen frame ${expected}, got ${indices}`);
	}
	// Densified samples sit ON the authored straight line (linear interpolation).
	const at30 = out[0].smooth_root_2d[indices.indexOf(30)];
	assert.ok(near(at30[0], 2 / 3, 1e-6) && near(at30[1], 1, 1e-6), `frame 30 must sample the line, got ${at30}`);
	// No constraint may land inside the transition window [90, 95).
	for (const frame of indices) {
		assert.ok(frame < 90 || frame >= 95, `frame ${frame} lands in the transition window [90,95)`);
	}
	// The authored target survives, nudged just past the window, position intact.
	const lastIndex = indices.length - 1;
	assert.equal(indices[lastIndex], 95, `the boundary waypoint must sit right after the window, got ${indices[lastIndex]}`);
	assert.deepEqual(out[0].smooth_root_2d[lastIndex], [2, 3], "densifying must not move the authored target");
	// Structural invariants.
	assert.equal(new Set(indices).size, indices.length, "densifying must not duplicate frames");
	assert.deepEqual([...indices].sort((a, b) => a - b), indices, "frame_indices must stay ascending");
	assert.equal(out[0].smooth_root_2d.length, indices.length, "arrays must stay index-aligned");
	assert.ok(out[0].smooth_root_2d.flat().every(Number.isFinite), "densified samples must be finite");
	assert.equal("global_root_heading" in out[0], false, "an all-null-heading path stays heading-free when densified");
	pass("densifyStride lays interpolated constraints so segment 1 sees the path");
}

// ---- densified samples never outrun the authored path ---------------------
// Sampling past the last waypoint would invent motion the author never asked
// for, so densification stays strictly inside [first, last] authored frames.
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 40, x: 0, z: 4, heading: null },
		],
		{ appFps: 20, genFps: 30, genFrames: 180, densifyStride: 10 }
	);
	const indices = out[0].frame_indices;
	assert.equal(indices[indices.length - 1], 60, `nothing may be constrained past the last authored frame, got ${indices}`);
	pass("densification stops at the last authored waypoint");
}

// ---- densifyStride 0 (the default) changes nothing ------------------------
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
	];
	const plain = buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 30, genFrames: 180 });
	const zero = buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 30, genFrames: 180, densifyStride: 0 });
	assert.deepEqual(plain, zero, "densifyStride 0 must be a no-op");
	pass("densifyStride defaults off and 0 is a no-op");
}

// ---- densified frames keep heading arrays index-aligned -------------------
// Inserted samples author no heading; they borrow the next authored one so the
// character keeps facing along the path it is walking, and the arrays stay the
// same length as frame_indices.
{
	const out = buildRoot2dConstraints(
		[
			{ frame: 0, x: 0, z: 0, heading: null },
			{ frame: 60, x: 2, z: 3, heading: Math.PI / 2 },
		],
		{ appFps: 20, genFps: 30, genFrames: 180, densifyStride: 10 }
	);
	assert.equal(
		out[0].global_root_heading.length,
		out[0].frame_indices.length,
		"heading must stay index-aligned after densification"
	);
	const mid = out[0].global_root_heading[out[0].frame_indices.indexOf(30)];
	assert.ok(near(mid[0], 0) && near(mid[1], 1), `an inserted frame borrows the next authored heading, got ${mid}`);
	pass("densified frames borrow the next authored heading and stay aligned");
}

// ---- a bad stride is refused ----------------------------------------------
{
	const waypoints = [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 60, x: 2, z: 3, heading: null },
	];
	assert.throws(
		() => buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 30, genFrames: 180, densifyStride: -1 }),
		/densifyStride/
	);
	assert.throws(
		() => buildRoot2dConstraints(waypoints, { appFps: 20, genFps: 30, genFrames: 180, densifyStride: 2.5 }),
		/densifyStride/
	);
	pass("a negative or fractional densifyStride is refused by name");
}

console.log("OK verify-kimodo-waypoints");
