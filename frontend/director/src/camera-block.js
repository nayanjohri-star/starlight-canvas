import { createTiming, timingIsFlat } from "./speed-envelope.js";
import { normalizeFocus } from './camera-focus.js';

// Pure Camera Block model. A shot owns one complete camera instruction, like
// the camera card clipped to a single strip of film.

export const CAMERA_MODES = Object.freeze(["keys", "follow", "rail"]);

export const CAMERA_FOLLOW_DEFAULTS = Object.freeze({
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
});

function cloneRail(points) {
	return Array.isArray(points) ? points.map((point) => ({ x: point.x, z: point.z })) : null;
}

/**
 * The crane axis a rail may carry: height marks along the dolly's arc
 * progress ({ points: [{ t, height }] }, endpoints pinned at t 0 and 1, at
 * most 8 marks). A legacy { start, end } pair reads as its two endpoints.
 * Null = flat rail at the follow height (every pre-crane document). Marks
 * clamp to a 0.1 m floor — a lens below the deck is never authorable.
 */
function cloneCraneHeight(value) {
	if (!value || typeof value !== "object") return null;
	const raw = Array.isArray(value.points)
		? value.points
		: Number.isFinite(value.start) && Number.isFinite(value.end)
			? [{ t: 0, height: value.start }, { t: 1, height: value.end }]
			: null;
	if (!raw) return null;
	const cleaned = raw
		.filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.height))
		.map((point) => ({ t: Math.max(0, Math.min(1, point.t)), height: Math.max(0.1, point.height) }))
		.sort((a, b) => a.t - b.t)
		// duplicate marks: the later-authored one wins
		.filter((point, i, arr) => i === arr.length - 1 || arr[i + 1].t - point.t > 1e-6)
		.slice(0, 8);
	if (cleaned.length < 2) return null;
	cleaned[0] = { ...cleaned[0], t: 0 };
	cleaned[cleaned.length - 1] = { ...cleaned[cleaned.length - 1], t: 1 };
	return { points: cleaned };
}

function cloneRailFollow(value) {
	if (!value || typeof value !== "object") return null;
	if (value.mode === "off") return { mode: "off" };
	if (value.mode === "range") return {
		mode: "range",
		startFrame: value.startFrame,
		endFrame: value.endFrame,
	};
	return null;
}

/** Build a complete block from a partial or stored camera value. */
export function createCameraBlock(input = {}) {
	const value = input && typeof input === "object" ? input : {};
	const mode = CAMERA_MODES.includes(value.mode) ? value.mode : "keys";
	const followCam = { ...CAMERA_FOLLOW_DEFAULTS, ...(value.followCam ?? {}) };
	const cameraRail = cloneRail(value.cameraRail);
	// The crane is always on for a rail: a stored null (older projects, an
	// explicit "off" patch) normalizes to the flat two-mark profile at the
	// follow height, which is exactly what "no crane" rendered as.
	const craneHeight = cloneCraneHeight(value.craneHeight)
		?? (mode === "rail" && cameraRail
			? { points: [{ t: 0, height: followCam.height }, { t: 1, height: followCam.height }] }
			: null);
	// The dolly's speed curve along the rail — same grammar as a prop path's
	// timing. Flat heals to null so untouched shots stay byte-stable.
	const dollyTiming = createTiming(value.dollyTiming);
	return {
		mode,
		followCam,
		cameraRail,
		railFollow: cloneRailFollow(value.railFollow),
		craneHeight,
		dollyTiming: timingIsFlat(dollyTiming) ? null : dollyTiming,
		...(Number.isFinite(value.focusDistance) || value.depthOfField !== undefined || Number.isFinite(value.fStop) ? normalizeFocus(value) : {}),
	};
}

/** Camera Blocks must never share nested settings across shots. */
export function cloneCameraBlock(camera) {
	return createCameraBlock(camera);
}

/** Immutable nested update used by both the sidebar and timeline inspector. */
export function updateCameraBlock(camera, patch = {}) {
	const current = createCameraBlock(camera);
	const change = patch && typeof patch === "object" ? patch : {};
	return createCameraBlock({
		...current,
		...change,
		followCam: change.followCam
			? { ...current.followCam, ...change.followCam }
			: current.followCam,
		cameraRail: Object.hasOwn(change, "cameraRail") ? change.cameraRail : current.cameraRail,
		railFollow: Object.hasOwn(change, "railFollow") ? change.railFollow : current.railFollow,
		craneHeight: Object.hasOwn(change, "craneHeight") ? change.craneHeight : current.craneHeight,
		dollyTiming: Object.hasOwn(change, "dollyTiming") ? change.dollyTiming : current.dollyTiming,
	});
}

/** Delete authored rail geometry and return rail mode to free Follow. */
export function removeCameraRail(camera) {
	const current = createCameraBlock(camera);
	return updateCameraBlock(current, {
		mode: current.mode === "rail" ? "follow" : current.mode,
		cameraRail: null,
		railFollow: null,
		craneHeight: null,
	});
}
