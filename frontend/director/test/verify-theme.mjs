#!/usr/bin/env node
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");

expect("header brand is Cozy Clay", app.includes("Cozy <span>Clay</span>"));
expect("browser title names the studio", /<title>[^<]*Cozy\s?Clay[^<]*<\/title>/.test(html));
expect("Inter is the only bundled active UI family", css.includes("@font-face{font-family:Inter") && !css.includes("Instrument Serif"));
expect("display and UI roles both use Inter", css.includes('--display: "Inter"') && css.includes('--sans: "Inter"'));
expect("numeric editing data has a monospace role", css.includes("--mono: ui-monospace") && css.includes("font-family: var(--mono)"));
expect("wordmark uses a modern heavy display treatment", css.includes("font-weight: 750") && css.includes("letter-spacing: -.045em"));
expect("chrome backdrop token matches Unity dark", css.includes("--bg: #1e1e1e"));
expect("chrome foreground token is light on dark", css.includes("--fg: #d2d2d2"));
expect("chrome panel token matches Unity dark chrome", css.includes("--panel: #2c2c2c"));
expect("chrome accent token matches Unity selection blue family", css.includes("--accent: #3a7cbf"));
expect("timeline lanes sit on a dark surface", css.includes("background-color: #282828"));
expect("IK uses pencil red", css.includes(".tl-marker.ik") && css.includes("background: #d65f55"));
expect("current frame uses lightbox amber", css.includes(".tl-frame-box") && css.includes("background: #e7b557"));
// The bright stage stays the default; grid view may swap in the dark void.
expect("Canvas uses a bright neutral toon background", app.includes('args={[gridView ? GRID_BACKGROUND : "#eef4f3"]}'));
expect("Character uses bright ivory clay", app.includes('const CLAY = "#f2eee6"'));
expect("Room uses a high-key floor", room.includes('const FLOOR = "#fffdf7"'));
// The walls are gone on purpose: the set is an open deck, so a shot can stage a
// run or a chase without meeting a corner. These assert their ABSENCE, which is
// what would regress if a wall were ever reintroduced by accident.
expect("the stage has no walls", !room.includes("BACK_WALL") && !room.includes("SIDE_WALL") && !room.includes("Skirting"));
expect("the deck is large enough to read as open", room.includes("export const STAGE_SIZE = 500"));
expect("Room has no ceiling plane", !room.includes("function Ceiling") && !room.includes("SHOT_LAYER"));
expect(
	"Studio uses directional high-key toon lighting",
	// The key is user-movable now: the tuned rig survives as the keyLight
	// DEFAULTS, so an untouched stage still renders the same high-key look.
	// grid view may swap in the neutral studio rig; the clay values stay the default arm
	room.includes('["#fffdf6", "#d8d0c3", 0.9]') &&
		room.includes("neutral ? 0.34 : 0.18") &&
		// the key colour is now the user's warmth dial, defaulting to the
		// tuned warm value — the default keyLight shape carries it
		room.includes("{ x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 }"),
);

if (failures) process.exit(1);
console.log("all Cozy Clay theme checks PASS");
