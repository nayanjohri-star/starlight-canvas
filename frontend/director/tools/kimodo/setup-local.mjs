#!/usr/bin/env node
/** Install Kimodo on the configured remote GPU host. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = join(HERE, "setup-on-box.sh");
const host = process.env.CCLAY_KIMODO_HOST || "";
const args = process.argv.slice(2);

function usage() {
	console.log("Usage: CCLAY_KIMODO_HOST=user@gpu-box node tools/kimodo/setup-local.mjs [installer options]");
	console.log("Passes options to setup-on-box.sh; use --dry-run to inspect without changing the host.");
}
if (args.includes("--help") || args.includes("-h")) { usage(); process.exit(0); }
if (!host) {
	console.error("setup-kimodo: CCLAY_KIMODO_HOST is required (for example user@gpu-box)");
	process.exit(2);
}
const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "bash -s --", ...args], {
	input: readFileSync(script),
	stdio: ["pipe", "inherit", "inherit"],
});
if (result.error) {
	console.error(`setup-kimodo: ssh failed: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
