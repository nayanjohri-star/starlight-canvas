/**
 * Speed envelopes — how fast something moves along its route, over time.
 *
 * The editor draws speed against time; the area under the curve is the total
 * distance, and the distance is a fact of the route, so the area is invariant:
 * pulling one stretch up pushes the rest of the SAME segment down. Cuts are
 * time-distance pins — "at this moment, be exactly here" — and everything
 * between two pins is its own sealed room: editing one can never move
 * another, because each pin's (t, d) is held constant.
 *
 * Pure module: no three.js, no react. The prop path and the camera dolly both
 * read it, so playback, export and the editor share one truth.
 *
 * Representation: normalized. A segment's envelope is ENVELOPE_POINTS values
 * sampled evenly across the segment's own time span, in units of "multiple of
 * this segment's average speed" — a flat envelope is all 1s, and a valid
 * envelope always integrates to exactly 1 over its normalized span.
 */

export const ENVELOPE_POINTS = 24;

/** A cut may not land nearer than this (normalized time) to another pin. */
export const CUT_MIN_GAP = 0.02;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Trapezoid area in units where the full span is (n - 1). */
function trapezoidArea(values) {
	let area = 0;
	for (let i = 0; i < values.length - 1; i += 1) area += (values[i] + values[i + 1]) / 2;
	return area;
}

/** Piecewise-linear read of an envelope at normalized position x. */
function envelopeValueAt(envelope, x) {
	const position = clamp(x, 0, 1) * (envelope.length - 1);
	const index = Math.min(envelope.length - 2, Math.floor(position));
	const fraction = position - index;
	return envelope[index] * (1 - fraction) + envelope[index + 1] * fraction;
}

/** Resample any-length samples to n points, piecewise-linear. */
function resample(values, n = ENVELOPE_POINTS) {
	if (!values.length) return new Array(n).fill(1);
	if (values.length === 1) return new Array(n).fill(values[0]);
	const out = new Array(n);
	for (let i = 0; i < n; i += 1) out[i] = envelopeValueAt(values, i / (n - 1));
	return out;
}

/** Clamp at zero and rescale so the mean is exactly 1; all-zero heals flat. */
function normalize(values) {
	const cleaned = values.map((value) => Math.max(0, finite(value, 0)));
	const mean = trapezoidArea(cleaned) / (cleaned.length - 1);
	if (mean <= 1e-9) return cleaned.map(() => 1);
	return cleaned.map((value) => value / mean);
}

function isFlat(envelope) {
	return envelope.every((value) => Math.abs(value - 1) < 1e-6);
}

/** One segment, constant speed — the do-nothing timing. */
export function flatTiming() {
	return { cuts: [], envelopes: [new Array(ENVELOPE_POINTS).fill(1)] };
}

/** True when this timing changes nothing and may be stored as null. */
export function timingIsFlat(timing) {
	return !timing || (timing.cuts.length === 0 && timing.envelopes.every(isFlat));
}

/**
 * Parse-don't-validate: whatever arrives becomes a legal timing or null.
 * Cuts must strictly increase in both t and d inside (0, 1); each of the
 * cuts+1 segments gets a normalized envelope, healing whatever is missing.
 */
export function createTiming(value) {
	if (!value || typeof value !== "object") return null;
	const rawCuts = Array.isArray(value.cuts) ? value.cuts : [];
	const cuts = [];
	for (const raw of rawCuts) {
		const t = finite(raw?.t, NaN);
		const d = finite(raw?.d, NaN);
		if (!(t > 0 && t < 1 && d > 0 && d < 1)) continue;
		const previous = cuts[cuts.length - 1];
		if (previous && (t <= previous.t + 1e-6 || d <= previous.d + 1e-6)) continue;
		cuts.push({ t, d });
	}
	const rawEnvelopes = Array.isArray(value.envelopes) ? value.envelopes : [];
	const envelopes = [];
	for (let i = 0; i <= cuts.length; i += 1) {
		const raw = Array.isArray(rawEnvelopes[i]) ? rawEnvelopes[i].map((v) => finite(v, 1)) : [];
		envelopes.push(normalize(resample(raw.length >= 2 ? raw : [1, 1])));
	}
	return { cuts, envelopes };
}

/**
 * The area IS the distance, so a drag conserves it exactly. A cosine bump
 * around `at` moves the touched points toward `targetValue`; the untouched
 * remainder is then rescaled by the one factor that restores the integral.
 * The algebra is exact because the trapezoid area is linear in each value:
 * area = 0.5·v₀ + v₁ + … + v₍ₙ₋₂₎ + 0.5·v₍ₙ₋₁₎.
 */
export function envelopeDrag(envelope, at, targetValue, radius = 0.18) {
	const n = envelope.length;
	const target = Math.max(0, finite(targetValue, 0));
	const center = clamp(finite(at, 0), 0, 1);
	// A plateau at the grab point, cosine falloff outside it: the value under
	// the pointer becomes EXACTLY the dragged value (a stop dragged to zero is
	// a real stop, not 0.03× of one), and the shoulders blend smoothly.
	const plateau = radius / 3;
	const weights = new Array(n);
	for (let i = 0; i < n; i += 1) {
		const distance = Math.abs(i / (n - 1) - center);
		weights[i] = distance <= plateau
			? 1
			: distance >= radius
				? 0
				: 0.5 * (1 + Math.cos(((distance - plateau) / (radius - plateau)) * Math.PI));
	}
	const next = envelope.map((value, i) => Math.max(0, value * (1 - weights[i]) + target * weights[i]));
	const weightOf = (i) => (i === 0 || i === n - 1 ? 0.5 : 1);
	const targetArea = n - 1;
	let bumpArea = 0;
	let restArea = 0;
	for (let i = 0; i < n; i += 1) {
		if (weights[i] > 1e-9) bumpArea += weightOf(i) * next[i];
		else restArea += weightOf(i) * next[i];
	}
	if (restArea > 1e-9) {
		const scale = Math.max(0, (targetArea - bumpArea) / restArea);
		for (let i = 0; i < n; i += 1) if (weights[i] <= 1e-9) next[i] *= scale;
		// The pull was larger than the whole budget: the rest is already at
		// zero, so the bump itself must shrink to fit the invariant.
		if (targetArea - bumpArea < 0) {
			const fit = targetArea / bumpArea;
			for (let i = 0; i < n; i += 1) if (weights[i] > 1e-9) next[i] *= fit;
		}
	} else if (bumpArea > 1e-9) {
		const fit = targetArea / bumpArea;
		for (let i = 0; i < n; i += 1) next[i] *= fit;
	} else {
		return new Array(n).fill(1);
	}
	return next;
}

/** Integral of the envelope from 0 to x, as a fraction of its whole area. */
function envelopePrefix(envelope, x) {
	const n = envelope.length;
	const total = trapezoidArea(envelope);
	if (total <= 1e-9) return clamp(x, 0, 1);
	const position = clamp(x, 0, 1) * (n - 1);
	const index = Math.min(n - 2, Math.floor(position));
	const fraction = position - index;
	let area = 0;
	for (let i = 0; i < index; i += 1) area += (envelope[i] + envelope[i + 1]) / 2;
	const edge = envelope[index] * (1 - fraction) + envelope[index + 1] * fraction;
	area += ((envelope[index] + edge) / 2) * fraction;
	return area / total;
}

/**
 * Normalized time → normalized distance. Monotone, pinned to (0,0), (1,1)
 * and to every cut's (t, d). Null timing is the identity — constant speed.
 */
export function timingProgress(timing, u) {
	const clamped = clamp(finite(u, 0), 0, 1);
	if (!timing) return clamped;
	const bounds = [{ t: 0, d: 0 }, ...timing.cuts, { t: 1, d: 1 }];
	let segment = 0;
	while (segment < bounds.length - 2 && clamped > bounds[segment + 1].t) segment += 1;
	const a = bounds[segment];
	const b = bounds[segment + 1];
	const span = b.t - a.t;
	const local = span > 1e-9 ? (clamped - a.t) / span : 1;
	return a.d + (b.d - a.d) * envelopePrefix(timing.envelopes[segment], local);
}

/** Slice [x0, x1] of an envelope, resampled to full resolution. */
function sampleSlice(envelope, x0, x1) {
	const out = new Array(ENVELOPE_POINTS);
	for (let i = 0; i < ENVELOPE_POINTS; i += 1) {
		out[i] = envelopeValueAt(envelope, x0 + (x1 - x0) * (i / (ENVELOPE_POINTS - 1)));
	}
	return out;
}

/**
 * Pin the motion where it already is: a cut at time u takes d from the
 * motion itself, so inserting one never moves anything — it only seals the
 * rooms on either side. Refused within CUT_MIN_GAP of an existing pin, and
 * refused where a stalled envelope leaves no distance to pin (d at 0 or 1).
 */
export function insertCut(timing, u) {
	const base = timing ?? flatTiming();
	const t = finite(u, NaN);
	if (!(t > CUT_MIN_GAP && t < 1 - CUT_MIN_GAP)) return timing;
	for (const cut of base.cuts) if (Math.abs(cut.t - t) < CUT_MIN_GAP) return timing;
	const d = timingProgress(base, t);
	if (!(d > 1e-6 && d < 1 - 1e-6)) return timing;
	let segment = 0;
	while (segment < base.cuts.length && t > base.cuts[segment].t) segment += 1;
	const a = segment === 0 ? { t: 0 } : base.cuts[segment - 1];
	const b = segment === base.cuts.length ? { t: 1 } : base.cuts[segment];
	const local = (t - a.t) / (b.t - a.t);
	const envelope = base.envelopes[segment];
	return {
		cuts: [...base.cuts.slice(0, segment), { t, d }, ...base.cuts.slice(segment)],
		envelopes: [
			...base.envelopes.slice(0, segment),
			normalize(sampleSlice(envelope, 0, local)),
			normalize(sampleSlice(envelope, local, 1)),
			...base.envelopes.slice(segment + 1),
		],
	};
}

/**
 * Unpin: the two rooms around the cut merge into one. The merged envelope is
 * rebuilt in ABSOLUTE speed (each side's shape × its own average) so the
 * motion barely moves — only the pin's hard guarantee is given up.
 */
export function removeCut(timing, index) {
	if (!timing || !timing.cuts[index]) return timing;
	const bounds = [{ t: 0, d: 0 }, ...timing.cuts, { t: 1, d: 1 }];
	const a = bounds[index];
	const cut = bounds[index + 1];
	const b = bounds[index + 2];
	const leftDuration = (cut.t - a.t) / (b.t - a.t);
	const leftShare = (cut.d - a.d) / (b.d - a.d);
	const rightDuration = 1 - leftDuration;
	const rightShare = 1 - leftShare;
	const leftEnvelope = timing.envelopes[index];
	const rightEnvelope = timing.envelopes[index + 1];
	const merged = new Array(ENVELOPE_POINTS);
	for (let i = 0; i < ENVELOPE_POINTS; i += 1) {
		const x = i / (ENVELOPE_POINTS - 1);
		if (x <= leftDuration) {
			const value = envelopeValueAt(leftEnvelope, leftDuration > 1e-9 ? x / leftDuration : 0);
			merged[i] = value * (leftShare / Math.max(1e-9, leftDuration));
		} else {
			const value = envelopeValueAt(rightEnvelope, rightDuration > 1e-9 ? (x - leftDuration) / rightDuration : 0);
			merged[i] = value * (rightShare / Math.max(1e-9, rightDuration));
		}
	}
	return {
		cuts: [...timing.cuts.slice(0, index), ...timing.cuts.slice(index + 1)],
		envelopes: [...timing.envelopes.slice(0, index), normalize(merged), ...timing.envelopes.slice(index + 2)],
	};
}
