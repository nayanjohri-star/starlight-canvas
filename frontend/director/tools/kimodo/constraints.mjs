/**
 * constraints.mjs — CozyClay's authored root path → Kimodo's `--constraints` JSON.
 *
 * Two coordinate translations happen here, and both are silent-bug shaped, so
 * each is pinned by test/verify-kimodo-waypoints.mjs:
 *
 * 1. FRAME SPACE. CozyClay authors waypoints against the app's clip, which runs
 *    at ARDY's 20 fps (src/App.jsx ARDY_FPS). Kimodo generates at 30 and the
 *    take is retimed back down afterwards, so a constraint frame must be scaled
 *    onto the GENERATION clock or the path lands at 2/3 of the intended time.
 *
 * 2. ORIGIN. Kimodo canonicalises training motion so the smoothed root starts at
 *    XZ (0,0) on frame 0, and the docs require constraints to be authored
 *    against that canonical origin. CozyClay waypoints are absolute world
 *    metres, so the whole path is translated by its own first waypoint. Feeding
 *    absolute coordinates straight in would ask the character to teleport to its
 *    world position on frame 0.
 *
 * 3. SEGMENT SPACE. Kimodo generates each prompt segment separately. For every
 *    segment after the first it shifts that segment's constraints to the origin
 *    (translate_2d(observed_motion, -last_smooth_root_2d)), generates, then adds
 *    last_smooth_root_2d back — where last_smooth_root_2d is the segment's
 *    ACTUAL GENERATED start. `crop_move` only re-indexes frames; it never moves
 *    smooth_root_2d. So a constraint in segment N must be a DISPLACEMENT FROM
 *    THAT SEGMENT'S START, and an absolute whole-clip target lands there as a
 *    doubled offset that yanks the root at the boundary.
 *
 *    This was isolated by measurement on a real 2-segment take, not inferred:
 *      no waypoints                  -> boundary jump 0.105 m
 *      waypoints inside segment 1    -> boundary jump 0.084 m
 *      absolute waypoints in seg 2   -> boundary jump 2.353 m
 *    A first attempt that re-anchored each segment onto its own first waypoint
 *    was measured WORSE still (4.48 m, waypoint error 3.55 m) because it
 *    discarded the displacement the author actually asked for.
 *
 * `global_root_heading` is a [cos, sin] direction PAIR per constrained frame,
 * NOT a radian — passing radians through would be accepted as a number pair and
 * silently steer the character wrong, so heading is converted, never forwarded.
 */

export const ROOT2D_TYPE = "root2d";

function requireFinite(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`buildRoot2dConstraints: ${label} must be a finite number, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * @param {Array<{frame:number,x:number,z:number,heading:number|null}>} waypoints
 * @param {{appFps:number, genFps:number, genFrames:number, segmentBoundaries?:number[],
 *          segmentStarts?:number[], transitionFrames?:number}} options
 *   `segmentBoundaries` are APP-space frames where a new prompt segment begins
 *   (excluding 0). Omit or pass [] for a single-segment take.
 *   `segmentStarts` are the same boundaries already in GENERATION space, used
 *   to keep constraints clear of each segment's transition window.
 * @returns {Array<object>} Kimodo constraint entries (empty when nothing is constrained)
 */
export function buildRoot2dConstraints(
	waypoints,
	{ appFps, genFps, genFrames, segmentBoundaries = [], segmentStarts = [], transitionFrames = 5, densifyStride = 0 } = {}
) {
	if (!Number.isInteger(densifyStride) || densifyStride < 0) {
		throw new Error(`buildRoot2dConstraints: densifyStride must be a non-negative integer, got ${JSON.stringify(densifyStride)}`);
	}
	if (!waypoints || waypoints.length === 0) return [];
	if (!Array.isArray(waypoints)) {
		throw new Error("buildRoot2dConstraints: waypoints must be an array");
	}
	requireFinite(appFps, "appFps");
	requireFinite(genFps, "genFps");
	requireFinite(genFrames, "genFrames");
	if (genFrames < 1) throw new Error(`buildRoot2dConstraints: genFrames must be >= 1, got ${genFrames}`);

	const scale = genFps / appFps;
	const lastFrame = Math.round(genFrames) - 1;

	// Validate and normalise in author order first, so a bad path is refused
	// before any of it is translated.
	let previousFrame = -1;
	const normalised = waypoints.map((waypoint, index) => {
		if (!waypoint || typeof waypoint !== "object") {
			throw new Error(`buildRoot2dConstraints: waypoints[${index}] must be an object`);
		}
		const frame = waypoint.frame;
		if (!Number.isInteger(frame) || frame < 0) {
			throw new Error(
				`buildRoot2dConstraints: waypoints[${index}].frame must be a non-negative integer, got ${JSON.stringify(frame)}`
			);
		}
		if (frame <= previousFrame) {
			throw new Error(
				`buildRoot2dConstraints: waypoint frames must be strictly ascending; waypoints[${index}].frame ${frame} follows ${previousFrame}`
			);
		}
		previousFrame = frame;
		const x = requireFinite(waypoint.x, `waypoints[${index}].x`);
		const z = requireFinite(waypoint.z, `waypoints[${index}].z`);
		const heading = waypoint.heading;
		if (heading !== null && heading !== undefined) {
			requireFinite(heading, `waypoints[${index}].heading`);
		}
		// A frame past the generated clip is CLAMPED rather than dropped: the
		// author asked for the path to end there, and Kimodo rejects an index
		// outside the clip, so the honest reading is "as late as possible".
		const genFrame = Math.min(lastFrame, Math.max(0, Math.round(frame * scale)));
		return { genFrame, x, z, heading: heading ?? null };
	});

	// Two authored frames can round onto one generation frame (a downscale, or
	// waypoints one app-frame apart). Duplicate frame_indices would constrain a
	// single frame to two different targets, so the LAST author wins — matching
	// "the most recent instruction for that moment".
	const byFrame = new Map();
	for (const entry of normalised) byFrame.set(entry.genFrame, entry);
	const points = [...byFrame.values()].sort((a, b) => a.genFrame - b.genFrame);

	// The AUTHORED polyline, frozen before any nudge or densification mutates
	// `points`: every later interpolation samples what the author drew, never a
	// constraint that has already been moved for Kimodo's benefit.
	const authored = points.map((point) => ({ ...point }));

	// Where does the authored path sit when each segment BEGINS? That position is
	// the origin Kimodo will re-zero this segment to, so every constraint inside
	// the segment is emitted as a displacement from it. The path is sampled
	// (linearly, matching a straight walk between pins) rather than snapped to a
	// waypoint, because a segment need not start on one.
	const genBoundaries = [...new Set(segmentBoundaries.map((frame) => Math.round(frame * scale)))].sort(
		(a, b) => a - b
	);
	const sampleAt = (genFrame) => {
		if (genFrame <= authored[0].genFrame) return authored[0];
		const last = authored[authored.length - 1];
		if (genFrame >= last.genFrame) return last;
		for (let index = 1; index < authored.length; index += 1) {
			const a = authored[index - 1];
			const b = authored[index];
			if (genFrame <= b.genFrame) {
				const span = b.genFrame - a.genFrame;
				const t = span === 0 ? 0 : (genFrame - a.genFrame) / span;
				return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
			}
		}
		return last;
	};
	const segmentStartOf = (genFrame) => {
		let start = 0;
		for (const boundary of genBoundaries) if (genFrame >= boundary) start = boundary;
		return start;
	};
	const originCache = new Map();
	const originFor = (genFrame) => {
		const start = segmentStartOf(genFrame);
		if (!originCache.has(start)) originCache.set(start, start === 0 ? points[0] : sampleAt(start));
		return originCache.get(start);
	};

	// Keep constraints out of each segment's TRANSITION WINDOW. For every segment
	// after the first, Kimodo builds its own FullBody + EndEffector constraints
	// over that segment's first `num_transition_frames` from the previous
	// segment's tail. A root2d constraint in the same window disagrees with them
	// and the root teleports at the seam: measured 2.353 m with the constraint on
	// the boundary against 0.400 m ten frames later, same path and seed.
	//
	// Only the TIMING moves; the authored position is preserved exactly, because
	// dropping the constraint would silently discard what the author asked for.
	if (segmentStarts.length > 0 && points.length > 0) {
		const windows = [...new Set(segmentStarts.map((frame) => Math.round(frame)))].sort((a, b) => a - b);
		for (const point of points) {
			for (const start of windows) {
				if (point.genFrame >= start && point.genFrame < start + transitionFrames) {
					point.genFrame = Math.min(lastFrame, start + transitionFrames);
				}
			}
		}
		// A nudge can land on a frame another waypoint already owns, and duplicate
		// indices would constrain one frame twice; the later author wins, matching
		// the dedupe above.
		const deduped = new Map();
		for (const point of points) deduped.set(point.genFrame, point);
		points.length = 0;
		points.push(...[...deduped.values()].sort((a, b) => a.genFrame - b.genFrame));
	}

	// DENSIFICATION — the seam fix. Kimodo generates each prompt segment
	// separately and crops constraints with a half-open [start, end): a waypoint
	// ON a boundary belongs entirely to the segment that starts there, so the
	// segment BEFORE it never learns the path exists, ends wherever it likes, and
	// the root teleports at the seam (measured 2.353 m) to satisfy the constraint
	// one frame later. Laying interpolated samples of the authored polyline every
	// `densifyStride` generation frames tells every segment where the path goes,
	// so each one arrives at its boundary already in place. Samples stay strictly
	// inside [first, last] authored frames (constraining past the path's end
	// would invent motion) and out of every transition window (Kimodo owns those
	// frames with its own constraints; see the nudge above).
	if (densifyStride > 0 && points.length >= 2) {
		const windows = [...new Set(segmentStarts.map((frame) => Math.round(frame)))];
		const inWindow = (frame) => windows.some((start) => frame >= start && frame < start + transitionFrames);
		const taken = new Set(points.map((point) => point.genFrame));
		const first = authored[0].genFrame;
		const last = authored[authored.length - 1].genFrame;
		for (let frame = first + densifyStride; frame < last; frame += densifyStride) {
			if (taken.has(frame) || inWindow(frame)) continue;
			const { x, z } = sampleAt(frame);
			points.push({ genFrame: frame, x, z, heading: null });
			taken.add(frame);
		}
		points.sort((a, b) => a.genFrame - b.genFrame);
	}

	const anyHeading = points.some((point) => point.heading !== null);

	// A lone waypoint at the origin carries no displacement and no heading, so
	// it constrains nothing; emitting it would hand Kimodo a degenerate entry.
	if (points.length === 1 && !anyHeading) return [];

	const entry = {
		type: ROOT2D_TYPE,
		frame_indices: points.map((point) => point.genFrame),
		smooth_root_2d: points.map((point) => {
			const origin = originFor(point.genFrame);
			return [point.x - origin.x, point.z - origin.z];
		}),
	};

	if (anyHeading) {
		// Every constrained frame needs a pair so the array stays index-aligned
		// with frame_indices. An unauthored heading borrows the next authored
		// one (falling back to the previous), which keeps the character facing
		// along the path it is about to follow rather than snapping at the
		// first authored pin.
		const resolved = points.map((point) => point.heading);
		for (let index = resolved.length - 1; index >= 0; index -= 1) {
			if (resolved[index] === null) resolved[index] = resolved[index + 1] ?? null;
		}
		for (let index = 0; index < resolved.length; index += 1) {
			if (resolved[index] === null) resolved[index] = resolved[index - 1] ?? 0;
		}
		entry.global_root_heading = resolved.map((radians) => [Math.cos(radians), Math.sin(radians)]);
	}

	return [entry];
}
