/**
 * Auto color: Blender's viewport "Random" color mode, adapted to CozyClay.
 *
 * Every set object gets its own DISPLAY color derived deterministically from
 * its id — the same object is the same color across sessions, machines, and
 * collaborators, so "the teal box" stays a meaningful thing to say. This is a
 * viewport mode, never data: nothing here reads or writes scene state, and
 * the authored `object.color` is untouched wherever the mode is applied.
 *
 * The derivation: FNV-1a over the id, then a golden-angle hue walk — adjacent
 * hash values land far apart on the wheel, so a run of `cube-1..cube-9` reads
 * as nine colors, not nine shades. Saturation/lightness are fixed to sit
 * inside the clay palette instead of shouting over it.
 */

/** FNV-1a 32-bit over the id string. Stable, dependency-free, good spread. */
export function hashObjectId(id) {
	let hash = 2166136261;
	for (let index = 0; index < id.length; index += 1) {
		hash ^= id.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash >>> 0;
}

const GOLDEN_RATIO_CONJUGATE = 0.61803398875;
const AUTO_SATURATION = 0.58;
const AUTO_LIGHTNESS = 0.62;

/** Lowercase `#rrggbb` for one object id; deterministic, well-spaced hues. */
export function autoColorHex(id) {
	const hue = (hashObjectId(id) * GOLDEN_RATIO_CONJUGATE) % 1;
	const channel = (n) => {
		const k = (n + hue * 12) % 12;
		const a = AUTO_SATURATION * Math.min(AUTO_LIGHTNESS, 1 - AUTO_LIGHTNESS);
		const c = AUTO_LIGHTNESS - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(c * 255);
	};
	return `#${[channel(0), channel(8), channel(4)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}

/** Persistence: same contract as the locale choice — a plain flag, own key,
 * and storage failures mean "default", never a crash. Default is OFF, like
 * Blender's shading color defaulting to Material rather than Random. */
export const AUTO_COLOR_KEY = "cozyclay.auto-color.v1";

export function loadAutoColor() {
	try {
		return localStorage.getItem(AUTO_COLOR_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveAutoColor(on) {
	try {
		localStorage.setItem(AUTO_COLOR_KEY, on ? "1" : "0");
	} catch {
		/* a blocked storage is not a reason to lose the toggle */
	}
}
