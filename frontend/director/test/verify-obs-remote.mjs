import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractObs, setObsExec } from "../tools/bench/obs/remote.mjs";

const root = mkdtempSync(join(tmpdir(), "verify-obs-remote-"));
const video = join(root, "video.mp4");
const camera = join(root, "camera.json");
const output = join(root, "obs.npz");
writeFileSync(video, "video");
writeFileSync(camera, JSON.stringify({ K: [[832, 0, 416], [0, 832, 240], [0, 0, 1]] }));
mkdirSync(join(root, "unused"));

const calls = [];
setObsExec(async (program, args) => {
	calls.push([program, args]);
	if (program === "scp" && args.at(-1) === output) writeFileSync(output, "npz");
	return "ok";
});
await extractObs({ host: "yun@ubuntu-baremetal", video, camera, output });
assert.equal(calls[0][0], "ssh");
assert.match(calls[0][1].at(-1), /GPU idle/);
assert.ok(calls.some(([program, args]) => program === "scp" && args.some(arg => arg.includes("--detector")) === false));
const remote = calls.find(([program, args]) => program === "ssh" && args.at(-1).includes("mkdir"))[1].at(-1).match(/\/tmp\/cclay-obs-[^' ]+/)[0];
assert.ok(calls.some(([program, args]) => program === "ssh" && args.at(-1).includes("cclay_gvhmr_extract.py")));
assert.match(calls.at(-1)[1].at(-1), new RegExp(`rm -rf .*${remote.split("/").at(-1)}`));

const failureCalls = [];
setObsExec(async (program, args) => {
	failureCalls.push([program, args]);
	if (program === "ssh" && args.at(-1).includes("cclay_gvhmr_extract.py")) throw new Error("inference failed");
	return "ok";
});
await assert.rejects(() => extractObs({ host: "yun@ubuntu-baremetal", video, camera, output }), /inference failed/);
assert.match(failureCalls.at(-1)[1].at(-1), /^rm -rf /);

setObsExec(async () => { throw new Error("GPU busy: compute memory=2048 MiB"); });
await assert.rejects(() => extractObs({ host: "yun@ubuntu-baremetal", video, camera, output }), /GPU busy/);
assert.equal(calls.length > 0, true);
setObsExec(null);
console.log("verify-obs-remote: argument building, cleanup-on-failure, and GPU-busy refusal passed");
