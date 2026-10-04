// Inspector number fields: dragging the NUMBER scrubs it (issue #87).
//
// Two things are proved here. The arithmetic — a fixed-travel rate instead of
// the old `pixels * step` mapping, plus the click/drag threshold — is pure, so
// it is exercised directly. The wiring that makes the whole field the hotspot
// (pointer handlers on the field, not just the axis badge) is asserted against
// ui.jsx's source: the browser suite drives the real gesture, but this keeps a
// regression that silently moves the handlers back onto the badge visible in
// the Node tier.
import { readFileSync } from "node:fs";
import {
	SCRUB_TRAVEL_PX,
	SCRUB_THRESHOLD_PX,
	FINE_SCRUB_FACTOR,
	createScrubGesture,
	scrubRangeFor,
	scrubValue,
	snapScrubValue,
	shouldStartScrub,
} from "../src/ui-scrub.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* --- the click/drag threshold ---------------------------------------------- */

ok("a press that never travels is a click", !shouldStartScrub(0) && !shouldStartScrub(3) && !shouldStartScrub(-3));
ok("travel past the threshold is a scrub", shouldStartScrub(SCRUB_THRESHOLD_PX) && shouldStartScrub(-SCRUB_THRESHOLD_PX) && shouldStartScrub(40));

/* --- the meaningful span --------------------------------------------------- */

ok("a step-0.05 field sweeps 5 units per full travel", scrubRangeFor({ step: 0.05 }) === 5);
ok("a step-1 field sweeps 100 units per full travel", scrubRangeFor({ step: 1 }) === 100);
ok("an explicit scrubRange wins over the step default", scrubRangeFor({ step: 1, scrubRange: 180 }) === 180);
ok("a nonsense range falls back to the step default", scrubRangeFor({ step: 0.05, scrubRange: 0 }) === 5 && scrubRangeFor({ step: 0.05, scrubRange: NaN }) === 5);
ok("a missing step still has a span", scrubRangeFor({}) === 100);

/* --- the rate: fixed travel, not pixels * step ----------------------------- */

ok("a full travel moves one whole range", near(scrubValue(1, SCRUB_TRAVEL_PX, { step: 0.05, precision: 2 }), 6));
ok("dragging left subtracts symmetrically", near(scrubValue(1, -SCRUB_TRAVEL_PX, { step: 0.05, precision: 2 }), -4));
ok("the old pixels*step feel is gone", (() => {
	// 60 px on a step-0.05 field used to buy 3.0 units of travel… no: 60*0.05 = 3
	// only for step 1. The point is the rate no longer depends on step alone:
	// 60 px is 60/220 of the span whatever the step is.
	const small = scrubValue(0, 60, { step: 0.05, precision: 2 });
	const big = scrubValue(0, 60, { step: 1, precision: 1 });
	return near(small, snapScrubValue((60 / 220) * 5, { step: 0.05, precision: 2 })) &&
		near(big, snapScrubValue((60 / 220) * 100, { step: 1, precision: 1 })) &&
		Math.abs(small) > 1e-9;
})());
ok("60 px on Scale X is a felt change, not a twitch", (() => {
	const moved = scrubValue(1, 60, { step: 0.05, precision: 2 });
	return moved > 1.3 && moved < 2.5;
})());
ok("an explicit range drives the rate", near(scrubValue(0, SCRUB_TRAVEL_PX / 2, { step: 1, precision: 1, scrubRange: 180 }), 90));
// Ratios are checked on an unsnapped field (step 0) so the step grid does not
// round the quarter away; the snapping itself has its own checks below.
ok("Shift is a quarter-speed pass", (() => {
	const coarse = scrubValue(0, 110, { step: 0, precision: 6, scrubRange: 5 });
	const fine = scrubValue(0, 110, { step: 0, precision: 6, scrubRange: 5, shiftKey: true });
	return near(fine, coarse * FINE_SCRUB_FACTOR, 1e-6) && fine > 0;
})());
ok("Alt stays the finest pass", (() => {
	const coarse = scrubValue(0, 110, { step: 0, precision: 6, scrubRange: 5 });
	const fine = scrubValue(0, 110, { step: 0, precision: 6, scrubRange: 5, altKey: true });
	return near(fine, coarse * 0.1, 1e-6);
})());

/* --- snapping: the field's own grid ---------------------------------------- */

ok("values land on the step grid", snapScrubValue(1.7321, { step: 0.05, precision: 2 }) === 1.75);
ok("precision kills float dust", snapScrubValue(0.1 + 0.2, { step: 0, precision: 2 }) === 0.3);
ok("a degree field rounds to whole degrees", snapScrubValue(43.4, { step: 1, precision: 1 }) === 43);
ok("scrubValue snaps its own result", scrubValue(1, 13, { step: 0.05, precision: 2 }) === snapScrubValue(1 + (13 / 220) * 5, { step: 0.05, precision: 2 }));

/* --- the gesture state machine: click vs scrub ------------------------------ */

const field = { step: 0.05, precision: 2 };

ok("a press alone changes nothing", (() => {
	const gesture = createScrubGesture({ x: 100, value: 1, ...field });
	return gesture.scrubbing === false && gesture.move(102) === null && gesture.scrubbing === false;
})());
ok("travel arms the scrub and reports a value from the press point", (() => {
	const gesture = createScrubGesture({ x: 100, value: 1, ...field });
	gesture.move(102);
	const armed = gesture.move(160);
	return gesture.scrubbing === true && armed !== null && near(armed, scrubValue(1, 60, field));
})());
ok("an armed scrub keeps reporting, including back inside the threshold", (() => {
	const gesture = createScrubGesture({ x: 100, value: 1, ...field });
	gesture.move(160);
	const back = gesture.move(101);
	return back !== null && near(back, scrubValue(1, 1, field));
})());
ok("the value does not jump by the threshold when the scrub arms", (() => {
	const gesture = createScrubGesture({ x: 100, value: 1, ...field });
	const armed = gesture.move(100 + SCRUB_THRESHOLD_PX);
	// Measuring from the press point (not from where it armed) means the first
	// reported value is only the threshold's worth of travel away from base.
	return near(armed, scrubValue(1, SCRUB_THRESHOLD_PX, field)) && Math.abs(armed - 1) < 0.2;
})());
ok("modifiers ride along per move", (() => {
	const gesture = createScrubGesture({ x: 100, value: 1, step: 0, precision: 6, scrubRange: 5 });
	const coarse = gesture.move(200);
	const fine = gesture.move(200, { shiftKey: true });
	return near(fine - 1, (coarse - 1) * FINE_SCRUB_FACTOR, 1e-6);
})());
ok("an explicit scrubRange reaches the gesture", (() => {
	const gesture = createScrubGesture({ x: 0, value: 0, step: 1, precision: 1, scrubRange: 180 });
	return near(gesture.move(SCRUB_TRAVEL_PX), 180);
})());

/* --- the wiring: the whole field is the hotspot ----------------------------- */

const ui = readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8");
const numberField = ui.slice(ui.indexOf("export function NumberField"), ui.indexOf("export function Vector3Row"));
ok("NumberField exists to inspect", numberField.length > 0);
ok("the field element owns the pointer gesture", (() => {
	// Everything between the opening <span className="number-field"> tag and the
	// first child: the press handler must live on the field wrapper itself, so
	// badge and number are one hotspot.
	const openTag = numberField.slice(numberField.search(/className=[{"]`?number-field/), numberField.indexOf('className="axis"'));
	return /onPointerDown=/.test(openTag) && /onPointerUp=/.test(openTag);
})());
ok("the drag itself is tracked on the window", /window\.addEventListener\("pointermove"/.test(numberField) && /window\.addEventListener\("pointerup"/.test(numberField));
ok("the pointer handlers no longer live only on the axis badge", (() => {
	const axis = numberField.slice(numberField.indexOf('className="axis"'), numberField.indexOf("<input"));
	return !/onPointerDown=/.test(axis);
})());
ok("the scrub still opens one store transaction", /onScrubStart\?\.\(/.test(numberField) && /scrubEndRef\.current\?\.\(/.test(numberField));
ok("Escape still cancels a live scrub", /event\.key !== "Escape"/.test(numberField) && /closeScrub\(false\)/.test(numberField));
ok("the rate math comes from the shared module", /from "\.\/ui-scrub\.js"/.test(ui) && !/e\.clientX - drag\.x\) \* step/.test(numberField));
ok("Vector3Row passes a per-field scrub range", (() => {
	const row = ui.slice(ui.indexOf("export function Vector3Row"));
	return /scrubRange=\{field\.scrubRange\}/.test(row);
})());

/* --- the Inspector rows hand the transaction token back --------------------- */

// A field callback that drops NumberField's second argument turns every move
// of a scrub into an atomic edit, and the store settles the open transaction
// on the first one — which is why the old drag froze after a single pixel's
// worth of travel and left one stray undo entry behind.
const app = readFileSync(new URL("../src/panels/ObjectTransformPanel.jsx", import.meta.url), "utf8");
const transformRows = app.slice(app.indexOf("selectedSceneObject.scaleX") - 4000, app.indexOf("selectedSceneObject.scaleZ") + 400);
for (const axis of ["x", "y", "z", "rotX", "rot", "rotZ", "scaleX", "scaleY", "scaleZ"]) {
	const pattern = new RegExp(`onChange: \\(${axis}, token\\) => run\\(\\.\\.\\.updateArgs\\(\\{ ${axis} \\}, token\\)\\)`);
	ok(`the ${axis} field applies inside the scrub's transaction`, pattern.test(transformRows));
}
ok("the transform rows name their own scrub spans", (() => {
	const spans = [...transformRows.matchAll(/scrubRange: (\d+)/g)].map((match) => match[1]);
	return spans.length === 9 && spans.slice(0, 3).every((span) => span === "5") &&
		spans.slice(3, 6).every((span) => span === "180") && spans.slice(6).every((span) => span === "4");
})());

/* --- the affordance: the number reads as draggable -------------------------- */

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
ok("the number itself shows the scrub cursor", /\.number-field input\s*\{[^}]*cursor:\s*ew-resize/.test(css));
ok("a focused field goes back to a text caret", /\.number-field input:focus\s*\{[^}]*cursor:\s*text/.test(css));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
