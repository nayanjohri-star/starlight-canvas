/* ======================== take recipes (contract C9) ========================
 * A take is a RECIPE, not a result: seed + prompt blocks + the line edits that
 * were pulled on top of it. Determinism on the box (re-chain diff = 0 bitwise)
 * is what makes that true — given the recipe the same take can be rebuilt at
 * any time, which is the whole reason regenerate/extend no longer destroys the
 * refinements the artist spent their afternoon on.
 *
 *   recipe = {
 *     seed: 1234,                    // ALWAYS a concrete integer, never null
 *     blocks: [{ prompt, duration }],// ordered; a single-prompt take = length 1
 *     lineEdits: [ <C6 payload WITHOUT sourceMotion> ],  // application order
 *   }
 *
 * THE SEED RULE, and why it lives here. A recipe with no seed cannot replay,
 * so no request that CREATES a take may omit one. When the artist leaves the
 * seed field empty the app rolls one, SENDS it, and records it — rolling it
 * here rather than letting the box pick silently is the difference between a
 * take you can rebuild and a take you can only remember.
 *
 * This file is deliberately React-free and side-effect-free: every function is
 * a pure value transform, so test/verify-take-recipe.mjs can pin the whole
 * contract in plain node without a DOM. Recipes come out DEEP FROZEN — the
 * one invariant that keeps "the recipe travels with the motionUrl" honest is
 * that no later edit can reach back and rewrite a version that is already on
 * the strip. */

/** C10's cap on a replay array. The bridge refuses more, and the app must not
 * discover that by being refused. */
export const RECIPE_MAX_LINE_EDITS = 16;

/** C12's cap on the version strip. The bridge's motion allowlist holds 64, so
 * 20 checkpoints are all still loadable when the oldest is dropped. */
export const TAKE_VERSIONS_MAX = 20;

/** Every key a C6 lineEdit payload may carry into a C10 replay entry, minus
 * sourceMotion (replay rebinds that to the freshly generated take). `seed` is
 * C10's optional per-entry seed and is the only field the app ADDS: it is the
 * seed that was actually sent with the edit, so a replay reproduces the edit
 * bit for bit instead of re-rolling it.
 *
 * `pins3d` is the second gesture's payload and rides the SAME list: a replayed
 * pin needs no camera and no polyline, and because the whitelist is a
 * whitelist, omitting it would have made a pinned edit vanish from its own
 * take's recipe silently — the take would regenerate without the refinement and
 * nothing would say why. */
const REPLAY_KEYS = ["track", "frameRange", "points2d", "pins3d", "camera", "prompt", "seed"];

function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) deepFreeze(entry);
	return value;
}

/** Roll a seed the way the seed rule demands. `random` is injectable so tests
 * can pin the arithmetic instead of sampling it. */
export function rollSeed(max, random = Math.random) {
	if (!Number.isInteger(max) || max <= 0) throw new Error(`rollSeed needs a positive integer max, got ${max}`);
	return Math.floor(random() * max);
}

/** The seed a request will actually carry. `typed` is the artist's raw field
 * value (empty string = "you pick"); a typed seed is NEVER overwritten, and an
 * empty one is rolled here so the same integer can be both sent and recorded.
 * Returns an integer, always — this is the function every take-creating call
 * site goes through. */
export function resolveSeed(typed, max, random = Math.random) {
	const text = typeof typed === "string" ? typed.trim() : typed;
	if (text === "" || text === null || text === undefined) return rollSeed(max, random);
	const value = Number(text);
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new Error(`seed must be an integer in 0..${max}, got ${typed}`);
	}
	return value;
}

/** The prompt blocks a request actually asked for. A segments body (chained
 * blocks) contributes one block per segment on the WIRE clock it was built
 * against; anything else is the single prompt+duration pair the bridge was
 * handed. Durations come out in seconds either way, because that is the one
 * frame-rate-free number in the request. */
export function blocksFromRequest(body, fps) {
	if (!body || typeof body !== "object") throw new Error("blocksFromRequest needs a request body");
	if (!(fps > 0)) throw new Error(`blocksFromRequest needs a positive fps, got ${fps}`);
	const basePrompt = typeof body.prompt === "string" ? body.prompt : "";
	if (Array.isArray(body.segments) && body.segments.length > 0) {
		return body.segments.map((segment) => ({
			prompt: (typeof segment.prompt === "string" && segment.prompt) || basePrompt,
			duration: Math.max(0, (segment.endFrame - segment.startFrame) / fps),
		}));
	}
	return [{ prompt: basePrompt, duration: Number(body.duration) || 0 }];
}

/** A recipe for a take that was just generated. `lineEdits` defaults to empty —
 * a plain generate has none — but a regeneration that CARRIED `replay` starts
 * life with exactly the edits the box re-applied, because those edits are in
 * the resulting npz and dropping them here would make the NEXT regeneration
 * lose them. */
export function freshRecipe({ seed, blocks, lineEdits = [] }) {
	if (!Number.isInteger(seed)) throw new Error(`a recipe needs a concrete integer seed, got ${seed}`);
	if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("a recipe needs at least one block");
	return deepFreeze({
		seed,
		blocks: blocks.map((block) => ({ prompt: String(block.prompt ?? ""), duration: Number(block.duration) || 0 })),
		lineEdits: lineEdits.map(stripSourceMotion),
	});
}

/** A C6 payload reduced to what a C10 replay entry may carry: sourceMotion is
 * dropped (replay rebinds it), unknown keys are dropped with it, and absent
 * optional keys stay absent rather than becoming undefined on the wire. */
export function stripSourceMotion(payload) {
	if (!payload || typeof payload !== "object") throw new Error("a line edit payload is required");
	const entry = {};
	for (const key of REPLAY_KEYS) {
		if (payload[key] !== undefined) entry[key] = payload[key];
	}
	if (!entry.track) throw new Error("a line edit payload must name a track");
	return deepFreeze(entry);
}

/** Push a successful line edit onto the take's recipe. Returns a NEW recipe;
 * the input is never touched, which is what lets an old version keep the
 * recipe it was saved with after the artist edits from it. */
export function withLineEdit(recipe, payload) {
	if (!recipe) throw new Error("withLineEdit needs a recipe to extend");
	return deepFreeze({
		seed: recipe.seed,
		blocks: recipe.blocks.map((block) => ({ ...block })),
		lineEdits: [...recipe.lineEdits, stripSourceMotion(payload)],
	});
}

/** The C10 `replay` array for this recipe, or [] when there is nothing to
 * replay. TRUNCATION KEEPS THE PREFIX, not the tail: entry i was authored on
 * top of entries 0..i-1, so the first N edits are the only slice that is
 * self-consistent. Dropping the newest work is the honest failure here, and
 * the caller surfaces it (replayTruncated) rather than silently shipping 16. */
export function replayPayload(recipe) {
	if (!recipe || !Array.isArray(recipe.lineEdits) || recipe.lineEdits.length === 0) return [];
	return recipe.lineEdits.slice(0, RECIPE_MAX_LINE_EDITS).map(stripSourceMotion);
}

/** True when this recipe carries more edits than one replay request can hold. */
export function replayTruncated(recipe) {
	return (recipe?.lineEdits?.length ?? 0) > RECIPE_MAX_LINE_EDITS;
}

/** Append a checkpoint to the version strip, oldest dropped past the cap.
 * Re-pushing a motionUrl that is already on the strip is a no-op: loading an
 * old version must not clone it onto the top, and a retried delivery must not
 * either. */
export function pushTakeVersion(versions, entry, cap = TAKE_VERSIONS_MAX) {
	const list = Array.isArray(versions) ? versions : [];
	if (!entry?.motionUrl) throw new Error("a take version needs a motionUrl");
	if (list.some((item) => item.motionUrl === entry.motionUrl)) return list;
	const next = [...list, Object.freeze({
		motionUrl: entry.motionUrl,
		recipe: entry.recipe ?? null,
		savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : Date.now(),
		label: typeof entry.label === "string" ? entry.label : "",
	})];
	return next.length > cap ? next.slice(next.length - cap) : next;
}
