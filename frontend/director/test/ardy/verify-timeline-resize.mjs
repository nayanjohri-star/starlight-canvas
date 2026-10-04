#!/usr/bin/env node
import { promptResizeFrame } from "../../src/ardy/timeline-resize.js";

let failures = 0;
function expect(name, actual, wanted) {
	const ok = Object.is(actual, wanted);
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, wanted ${wanted}`}`);
	if (!ok) failures += 1;
}

expect("10 px does not resize a 2-second block", promptResizeFrame(40, 1000, 1010), 40);
expect("59 px stays below one-block threshold", promptResizeFrame(40, 1000, 1059), 40);
expect("60 px right adds one 2-second timeline block", promptResizeFrame(48, 1000, 1060), 96);
expect("60 px left removes one 2-second timeline block", promptResizeFrame(96, 1000, 940), 48);
expect("120 px right adds one timeline block", promptResizeFrame(48, 1000, 1120), 96);
expect("360 px right adds three blocks, never an exponential value", promptResizeFrame(48, 1000, 1360), 192);
let repeated = 48;
for (let move = 0; move < 1000; move += 1) repeated = promptResizeFrame(48, 1000, 1070);
expect("1000 repeated pointermoves stay on the same frame", repeated, 96);
if (failures) process.exit(1);
console.log("all prompt resize checks PASS");
