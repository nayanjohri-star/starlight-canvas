#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOwned, terminateOwned } from "../../tools/process-supervisor.mjs";
import {
	hasContinuousRenderActivity,
	RENDER_ACTIVITY_KEYS,
} from "../../src/use-render-activity.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}
// terminateOwned awaits only the owned parent's exit. A SIGTERM'd group member
// can still be exiting, or be an unreaped zombie, for a few ms after that, and
// kill(pid, 0) reports it alive (#479). Nothing emits an event when a process
// that is not our child disappears, so poll its state, bounded.
async function disappears(pid, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return true;
}

	const dir = mkdtempSync(join(tmpdir(), "cozyclay-process-test-"));
const readyPath = join(dir, "ready.json");
const ready = new Promise((resolve, reject) => {
	let timeout;
	const watcher = watch(dir, (_event, filename) => {
		if (filename !== "ready.json" || !existsSync(readyPath)) return;
		watcher.close();
		clearTimeout(timeout);
		resolve();
	});
	timeout = setTimeout(() => {
		watcher.close();
		reject(new Error("fixture process tree did not become ready"));
	}, 3000);
});
const child = spawnOwned(process.execPath, ["test/process/fixture-tree.mjs", readyPath], {
	cwd: new URL("../..", import.meta.url),
	stdio: "ignore",
});
await ready;
const pids = JSON.parse(readFileSync(readyPath, "utf8"));
expect("owned parent process starts", isAlive(pids.parent), String(pids.parent));
expect("owned grandchild process starts", isAlive(pids.grandchild), String(pids.grandchild));
await terminateOwned(child);
expect("terminating owner removes parent", !isAlive(pids.parent), String(pids.parent));
expect("terminating owner removes grandchild", await disappears(pids.grandchild), String(pids.grandchild));
rmSync(dir, { recursive: true, force: true });

expect("idle has no continuous render activity", !hasContinuousRenderActivity(new Set(), new Set(), false));
expect("pointer drag activates continuous rendering", hasContinuousRenderActivity(new Set([1]), new Set(), false));
expect("camera key activates continuous rendering", hasContinuousRenderActivity(new Set(), new Set(["KeyW"]), false));
expect("wheel pulse activates continuous rendering", hasContinuousRenderActivity(new Set(), new Set(), true));
expect(
	"render activity keys cover WASD and crane controls",
	["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"].every((code) => RENDER_ACTIVITY_KEYS.has(code)),
);

if (failures) process.exit(1);
console.log("all lifecycle checks PASS");
