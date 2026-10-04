#!/usr/bin/env node
// Composition guides: pure geometry + persistence contract.
import assert from "node:assert/strict";
import {
	GUIDE_MODES,
	GUIDE_LABELS,
	GUIDE_STORAGE_KEY,
	guideGeometry,
	nextGuideMode,
	normalizeGuideMode,
	readStoredGuideMode,
	writeStoredGuideMode,
} from "../src/shot-guides.js";

// --- mode cycle -----------------------------------------------------------
assert.deepEqual(GUIDE_MODES, ["off", "thirds", "golden", "center", "safe"]);
assert.equal(nextGuideMode("off"), "thirds");
assert.equal(nextGuideMode("safe"), "off", "the cycle wraps");
assert.equal(nextGuideMode("garbage"), "off", "unknown modes restart the cycle");
assert.equal(normalizeGuideMode("golden"), "golden");
assert.equal(normalizeGuideMode(undefined), "off");
for (const mode of GUIDE_MODES) assert.ok(GUIDE_LABELS[mode]?.en && GUIDE_LABELS[mode]?.ko, `${mode} has bilingual labels`);

// --- geometry -------------------------------------------------------------
const thirds = guideGeometry("thirds");
assert.equal(thirds.lines.length, 4);
assert.equal(thirds.rects.length, 0);
const xs = thirds.lines.filter((l) => l.x1 === l.x2).map((l) => l.x1).sort((a, b) => a - b);
assert.ok(Math.abs(xs[0] - 100 / 3) < 1e-9 && Math.abs(xs[1] - 200 / 3) < 1e-9, "vertical thirds sit at 1/3 and 2/3");

const golden = guideGeometry("golden");
const gx = golden.lines.filter((l) => l.x1 === l.x2).map((l) => l.x1).sort((a, b) => a - b);
assert.ok(Math.abs(gx[0] - 38.196601125) < 1e-6, "golden split is 1 - 1/phi of the frame");
assert.ok(Math.abs(gx[0] + gx[1] - 100) < 1e-9, "golden splits mirror around the centre");

const center = guideGeometry("center");
assert.equal(center.lines.length, 4, "centre cross + both diagonals");
assert.ok(center.lines.some((l) => l.x1 === 0 && l.y1 === 0 && l.x2 === 100 && l.y2 === 100), "diagonal reaches corner to corner");

const safe = guideGeometry("safe");
assert.equal(safe.lines.length, 0);
assert.deepEqual(
	safe.rects.map(({ kind, x, width }) => [kind, x, width]),
	[["action", 5, 90], ["title", 10, 80]],
	"Blender defaults: action 90%, title 80%",
);

assert.deepEqual(guideGeometry("off"), { lines: [], rects: [] });
assert.deepEqual(guideGeometry("nonsense"), { lines: [], rects: [] });

// --- persistence ----------------------------------------------------------
assert.equal(GUIDE_STORAGE_KEY, "cozyclay.shot-guides.v1");
const store = new Map();
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
assert.equal(readStoredGuideMode(storage), "off", "empty storage reads as off");
writeStoredGuideMode(storage, "golden");
assert.equal(store.get(GUIDE_STORAGE_KEY), "golden");
assert.equal(readStoredGuideMode(storage), "golden");
writeStoredGuideMode(storage, "not-a-mode");
assert.equal(readStoredGuideMode(storage), "off", "junk normalizes instead of crashing");
assert.equal(readStoredGuideMode(null), "off", "missing storage is safe");
writeStoredGuideMode({ setItem() { throw new Error("quota"); } }, "thirds"); // must not throw
assert.equal(readStoredGuideMode({ getItem() { throw new Error("denied"); } }), "off");

console.log("verify-shot-guides: all checks passed");
