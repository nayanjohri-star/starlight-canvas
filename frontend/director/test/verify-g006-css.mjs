#!/usr/bin/env node
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

expect(
	"source offer hover uses the canonical foreground token",
	css.includes(".source-offer:focus-visible {\n\tcolor: var(--fg);") && !css.includes("color: var(--text);"),
);
expect(
	"hierarchy sidebar has no unresolved hierarchy height row",
	!css.includes("var(--hierarchy-height)") && /\.panel\.hierarchy-sidebar\s*\{\s*display: flex;/.test(css),
);

if (failures) process.exit(1);
console.log("all G006 CSS checks PASS");
