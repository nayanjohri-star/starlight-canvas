#!/usr/bin/env node
/**
 * verify-take-recipe.mjs — the client-side take recipe (plan contracts C9/C12).
 *
 * WHAT THIS FILE IS DEFENDING. The recipe is the app's ONLY claim that a take
 * can be rebuilt. Four things can quietly break that claim and none of them
 * shows up on screen:
 *
 *   1. A TAKE WITH NO RECORDED SEED. The bridge accepts a request without one
 *      and picks its own; the result plays back perfectly and is gone forever.
 *      Section [1] pins the rule that makes that impossible — resolveSeed
 *      always returns an integer, and it never overwrites a typed one.
 *   2. BLOCKS DERIVED WRONG. A segments body counts frames on the WIRE clock;
 *      a plain body carries seconds. Mixing them silently rewrites how long
 *      every replayed take is. Section [2].
 *   3. A RECIPE MUTATED IN PLACE. Versions store recipes by reference, so one
 *      shared array is all it takes for "load v1" to hand back v4's edits.
 *      Section [3] pins immutability by both construction (deep freeze) and
 *      observation (the input is untouched).
 *   4. A REPLAY ARRAY OVER C10's CAP, or truncated from the wrong end. Entry i
 *      was authored on top of 0..i-1, so only a PREFIX is self-consistent —
 *      keeping the newest 16 would replay edits onto a base that never existed.
 *      Section [4].
 *
 * Pure node, no DOM, no framework: src/take-recipe.js is React-free on purpose
 * so this file can pin the whole contract without booting the app.
 */

import assert from "node:assert/strict";
import {
	RECIPE_MAX_LINE_EDITS,
	TAKE_VERSIONS_MAX,
	blocksFromRequest,
	freshRecipe,
	pushTakeVersion,
	replayPayload,
	replayTruncated,
	resolveSeed,
	rollSeed,
	stripSourceMotion,
	withLineEdit,
} from "../src/take-recipe.js";

function pass(label) { console.log(`PASS ${label}`); }

const SEED_MAX = 2 ** 31 - 1; // ARDY_SEED_MAX, the bridge's own bound

/** A C6 line-edit payload as the app actually sends one. */
function payload(overrides = {}) {
	return {
		sourceMotion: "/ardy/motions/1787982494307-bdce57",
		track: "leftHand",
		frameRange: { startFrame: 12, endFrame: 48 },
		points2d: [[0.2, 0.3], [0.4, 0.5], [0.6, 0.4]],
		camera: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1 },
		prompt: "A person waves.",
		...overrides,
	};
}

/* [1] THE SEED RULE — a take whose seed was not recorded cannot be rebuilt. */
{
	// Rolled seeds stay inside the bridge's range at both ends of Math.random.
	assert.equal(rollSeed(SEED_MAX, () => 0), 0);
	assert.equal(rollSeed(SEED_MAX, () => 0.9999999999), SEED_MAX - 1);
	for (let i = 0; i < 200; i += 1) {
		const seed = rollSeed(SEED_MAX);
		assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX, `rolled seed out of range: ${seed}`);
	}
	// An empty field is rolled, NOT omitted: this is the whole rule.
	assert.equal(resolveSeed("", SEED_MAX, () => 0.5), Math.floor(0.5 * SEED_MAX));
	assert.equal(resolveSeed(null, SEED_MAX, () => 0.25), Math.floor(0.25 * SEED_MAX));
	assert.equal(resolveSeed(undefined, SEED_MAX, () => 0.75), Math.floor(0.75 * SEED_MAX));
	assert.equal(resolveSeed("   ", SEED_MAX, () => 0), 0);
	// A typed seed is never overwritten, and whitespace around it is not a
	// different seed.
	assert.equal(resolveSeed("7", SEED_MAX, () => 0.5), 7);
	assert.equal(resolveSeed(" 4242 ", SEED_MAX, () => 0.5), 4242);
	assert.equal(resolveSeed("0", SEED_MAX, () => 0.5), 0);
	assert.equal(resolveSeed(String(SEED_MAX), SEED_MAX), SEED_MAX);
	// Out-of-contract seeds are refused loudly rather than silently clamped —
	// the app turns the throw into a toast and abandons the request.
	for (const bad of ["-1", "1.5", "abc", String(SEED_MAX + 1)]) {
		assert.throws(() => resolveSeed(bad, SEED_MAX), /seed must be an integer/, `accepted a bad seed: ${bad}`);
	}
	// And a recipe cannot be built without one.
	assert.throws(() => freshRecipe({ seed: null, blocks: [{ prompt: "x", duration: 4 }] }), /concrete integer seed/);
	assert.throws(() => freshRecipe({ seed: 1.5, blocks: [{ prompt: "x", duration: 4 }] }), /concrete integer seed/);
	pass("the seed rule: empty is rolled, typed is kept, both are always concrete");
}

/* [2] BLOCKS FROM THE REQUEST THAT WAS ACTUALLY SENT. */
{
	const single = blocksFromRequest({ prompt: "A person walks.", duration: 4 }, 24);
	assert.deepEqual(single, [{ prompt: "A person walks.", duration: 4 }]);

	// A chained body: one block per segment, durations back on the seconds clock.
	const chained = blocksFromRequest({
		prompt: "A person walks.",
		duration: 8,
		segments: [
			{ startFrame: 0, endFrame: 96, prompt: "A person walks." },
			{ startFrame: 96, endFrame: 192, prompt: "then stops." },
		],
	}, 24);
	assert.deepEqual(chained, [
		{ prompt: "A person walks.", duration: 4 },
		{ prompt: "then stops.", duration: 4 },
	]);

	// A gap segment carries no prompt of its own: it inherits the base prompt,
	// exactly as buildPromptSchedule fills it on the wire.
	const gapped = blocksFromRequest({
		prompt: "base",
		duration: 4,
		segments: [{ startFrame: 0, endFrame: 48 }, { startFrame: 48, endFrame: 96, prompt: "wave" }],
	}, 24);
	assert.deepEqual(gapped.map((block) => block.prompt), ["base", "wave"]);

	// An empty segments array is not a schedule; it falls back to the pair.
	assert.deepEqual(blocksFromRequest({ prompt: "p", duration: 3, segments: [] }, 24), [{ prompt: "p", duration: 3 }]);
	assert.throws(() => blocksFromRequest({ prompt: "p", duration: 3 }, 0), /positive fps/);
	assert.throws(() => blocksFromRequest(null, 24), /request body/);
	pass("blocks derive from single-prompt and segments bodies on the right clock");
}

/* [3] LINE EDITS PUSH WITHOUT MUTATING — the invariant the version strip rests on. */
{
	const base = freshRecipe({ seed: 11, blocks: [{ prompt: "walk", duration: 4 }] });
	assert.deepEqual(base.lineEdits, []);
	assert.ok(Object.isFrozen(base) && Object.isFrozen(base.blocks) && Object.isFrozen(base.lineEdits));

	const once = withLineEdit(base, payload());
	assert.equal(base.lineEdits.length, 0, "withLineEdit mutated its input recipe");
	assert.equal(once.lineEdits.length, 1);
	assert.notEqual(once, base);
	assert.notEqual(once.blocks, base.blocks);
	assert.deepEqual(once.blocks, base.blocks);
	assert.equal(once.seed, 11, "a refinement must not change the take's seed");

	// sourceMotion is dropped — replay rebinds it to the take it lands on — and
	// so is anything else that is not a C10 field.
	assert.equal(once.lineEdits[0].sourceMotion, undefined);
	assert.deepEqual(Object.keys(once.lineEdits[0]).sort(), ["camera", "frameRange", "points2d", "prompt", "track"]);
	// The rest is stored EXACTLY as sent: app frames, viewport-normalized points.
	assert.deepEqual(once.lineEdits[0].frameRange, { startFrame: 12, endFrame: 48 });
	assert.deepEqual(once.lineEdits[0].points2d, payload().points2d);

	// C10's optional per-entry seed rides along when the app records one.
	const seeded = withLineEdit(base, payload({ seed: 99 }));
	assert.equal(seeded.lineEdits[0].seed, 99);

	// Application ORDER is the recipe's order, and pushes compose.
	const twice = withLineEdit(once, payload({ track: "rightFoot" }));
	assert.deepEqual(twice.lineEdits.map((entry) => entry.track), ["leftHand", "rightFoot"]);
	assert.equal(once.lineEdits.length, 1, "the second push mutated the first recipe");

	// Nothing downstream can write into a stored payload.
	assert.ok(Object.isFrozen(twice.lineEdits[0]));
	assert.throws(() => { twice.lineEdits[0].track = "hips"; }, TypeError);

	// A generate that carried replay keeps those edits: the resulting take
	// CONTAINS them, so resetting to [] would make the next regeneration lose
	// exactly what replay preserved.
	const carried = freshRecipe({ seed: 12, blocks: [{ prompt: "walk", duration: 4 }], lineEdits: twice.lineEdits });
	assert.deepEqual(carried.lineEdits.map((entry) => entry.track), ["leftHand", "rightFoot"]);

	assert.throws(() => withLineEdit(null, payload()), /needs a recipe/);
	assert.throws(() => stripSourceMotion({ sourceMotion: "/x" }), /must name a track/);
	assert.throws(() => freshRecipe({ seed: 1, blocks: [] }), /at least one block/);
	pass("line edits push immutably, sourceMotion-free, in application order");
}

/* [4] THE REPLAY ARRAY — C10's shape and its cap. */
{
	assert.deepEqual(replayPayload(null), []);
	assert.deepEqual(replayPayload(freshRecipe({ seed: 1, blocks: [{ prompt: "p", duration: 2 }] })), []);

	let recipe = freshRecipe({ seed: 1, blocks: [{ prompt: "p", duration: 2 }] });
	for (let i = 0; i < RECIPE_MAX_LINE_EDITS + 4; i += 1) {
		recipe = withLineEdit(recipe, payload({ prompt: `edit ${i}` }));
	}
	assert.equal(recipe.lineEdits.length, RECIPE_MAX_LINE_EDITS + 4, "the recipe itself must keep the full record");
	const replay = replayPayload(recipe);
	assert.equal(replay.length, RECIPE_MAX_LINE_EDITS);
	assert.equal(replayTruncated(recipe), true);
	// PREFIX, not tail: entry i was authored on top of 0..i-1.
	assert.equal(replay[0].prompt, "edit 0");
	assert.equal(replay[RECIPE_MAX_LINE_EDITS - 1].prompt, `edit ${RECIPE_MAX_LINE_EDITS - 1}`);
	// Every entry is a C6 payload minus sourceMotion — the C10 wire shape.
	for (const entry of replay) {
		assert.equal(entry.sourceMotion, undefined);
		assert.ok(typeof entry.track === "string" && entry.track);
		assert.ok(Number.isInteger(entry.frameRange.startFrame) && Number.isInteger(entry.frameRange.endFrame));
		assert.ok(Array.isArray(entry.points2d) && entry.points2d.length >= 2);
		assert.ok(entry.camera && typeof entry.camera === "object");
	}
	// JSON-serialisable, because that is what actually leaves the browser.
	assert.deepEqual(JSON.parse(JSON.stringify(replay)), replay);

	const short = withLineEdit(freshRecipe({ seed: 1, blocks: [{ prompt: "p", duration: 2 }] }), payload());
	assert.equal(replayTruncated(short), false);
	assert.equal(replayPayload(short).length, 1);
	pass(`replay is a sourceMotion-free prefix capped at ${RECIPE_MAX_LINE_EDITS}`);
}

/* [5] THE VERSION STRIP — capped, ordered, and never destroyed by a load. */
{
	const recipe = freshRecipe({ seed: 5, blocks: [{ prompt: "p", duration: 2 }] });
	let versions = [];
	versions = pushTakeVersion(versions, { motionUrl: "/ardy/motions/a", recipe, savedAt: 1000, label: "generate" });
	versions = pushTakeVersion(versions, { motionUrl: "/ardy/motions/b", recipe, savedAt: 2000, label: "refine" });
	assert.deepEqual(versions.map((entry) => entry.motionUrl), ["/ardy/motions/a", "/ardy/motions/b"]);
	assert.equal(versions[0].savedAt, 1000);
	assert.ok(Object.isFrozen(versions[0]));

	// Re-pushing a url already on the strip is a no-op — loading v1 must not
	// clone v1 onto the top of the list.
	const again = pushTakeVersion(versions, { motionUrl: "/ardy/motions/a", recipe, savedAt: 3000, label: "load" });
	assert.equal(again, versions, "re-pushing an existing motionUrl changed the strip");

	// The cap drops the OLDEST, keeping the newest TAKE_VERSIONS_MAX.
	let capped = [];
	for (let i = 0; i < TAKE_VERSIONS_MAX + 5; i += 1) {
		capped = pushTakeVersion(capped, { motionUrl: `/ardy/motions/${i}`, recipe, savedAt: i, label: `v${i}` });
	}
	assert.equal(capped.length, TAKE_VERSIONS_MAX);
	assert.equal(capped[0].motionUrl, "/ardy/motions/5");
	assert.equal(capped[capped.length - 1].motionUrl, `/ardy/motions/${TAKE_VERSIONS_MAX + 4}`);

	// Each version keeps the recipe it was SAVED with, not the latest one.
	const edited = withLineEdit(recipe, payload());
	let lineage = pushTakeVersion([], { motionUrl: "/ardy/motions/v1", recipe, savedAt: 1, label: "generate" });
	lineage = pushTakeVersion(lineage, { motionUrl: "/ardy/motions/v2", recipe: edited, savedAt: 2, label: "refine" });
	assert.equal(lineage[0].recipe.lineEdits.length, 0);
	assert.equal(lineage[1].recipe.lineEdits.length, 1);

	assert.throws(() => pushTakeVersion([], { recipe }), /needs a motionUrl/);
	pass(`the version strip holds ${TAKE_VERSIONS_MAX} checkpoints, each with its own recipe`);
}

console.log("all take-recipe checks PASS");
