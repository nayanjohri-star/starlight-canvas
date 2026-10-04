#!/usr/bin/env node
/**
 * run-local.mjs - generate an ARDY clip on THIS machine.
 *
 *   run-local.mjs single   [--pose-from NPZ SRC DST]... --prompt P --duration S
 *                          [--seed N] [--root-2d F X Z H]... --output OUT.npz
 *   run-local.mjs sequence --segment PROMPT SECONDS [--segment ...]...
 *                          [--root-2d F X Z H]... [--seed N] --output OUT.npz
 *   run-local.mjs edit     --source SRC.npz --manifest M.json --prompt P
 *                          --context-before N --context-after N [--seed N]
 *                          [--pose POSE.npz]... --output OUT.npz
 *
 * The local twin of run-on-box.sh / run-sequence-on-box.sh /
 * run-edit-on-box.sh: same modes, same success marker
 *
 *   run-local: done - <output> (<bytes> bytes)
 *
 * minus every ssh/scp/temp-dir round trip — the generator scripts run in
 * place from this repo against the ARDY checkout's venv. Device selection
 * lives in the python side (cclay_pick_device: CCLAY_ARDY_DEVICE override,
 * else cuda > mps > cpu). The text encoder is the bridge's lazy sidecar; a
 * dead encoder degrades to ARDY's in-process fallback rather than failing.
 *
 * env (set by runners/local.mjs; usable standalone too):
 *   CCLAY_ARDY_LOCAL_DIR    ARDY checkout       (default ~/.cozyclay/ardy)
 *   CCLAY_ARDY_LOCAL_VENV   venv python         (default <dir>/.venv/bin/python)
 *   TEXT_ENCODER_URL        encoder service     (default http://127.0.0.1:9550/)
 *   TEXT_ENCODERS_DIR       encoder weights dir (default ~/.cozyclay/text-encoders)
 *   CCLAY_ARDY_DEVICE       force a torch device (cpu|mps|cuda[:N])
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = process.env.CCLAY_ARDY_LOCAL_DIR || join(homedir(), ".cozyclay", "ardy");
const VENV_PY =
	process.env.CCLAY_ARDY_LOCAL_VENV ||
	join(LOCAL_DIR, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const WORKER_PORT = Number(process.env.CCLAY_ARDY_WORKER_PORT) || 9552;
// A sequence job can legitimately run a long time; the watchdog only guards
// against a worker that stopped talking entirely.
const WORKER_SILENCE_TIMEOUT_MS = 60 * 60_000;

const GENERATORS = {
	single: join(HERE, "cclay_constrained_generate.py"),
	sequence: join(HERE, "cclay_sequence_generate.py"),
	edit: join(HERE, "cclay_motion_edit.py"),
};

function die(message) {
	console.error(`run-local: ${message}`);
	process.exit(2);
}

function usage() {
	console.error("usage: run-local.mjs <single|sequence|edit> [flags] --output OUT.npz");
	console.error("see the header of tools/ardy/run-local.mjs for the full grammar");
	process.exit(2);
}

// The bridge builds these argv arrays itself, so parsing here is deliberately
// shallow: pull out the handful of values run-local needs (--output always;
// --cpu, --pose/--manifest for staging) and pass everything else through to
// the python generator untouched.
function parseArgs(argv) {
	const passthrough = [];
	let output = "";
	let cpu = false;
	const poses = [];
	let manifest = "";
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--output") {
			output = argv[++i] ?? "";
			continue;
		}
		if (arg === "--cpu") {
			cpu = true;
			continue;
		}
		if (arg === "--pose") {
			poses.push(argv[++i] ?? "");
			continue;
		}
		if (arg === "--manifest") {
			manifest = argv[++i] ?? "";
			continue;
		}
		passthrough.push(arg);
	}
	if (!output) die("--output is required");
	return { passthrough, output, cpu, poses, manifest };
}

/**
 * Try to run the job on the persistent worker (tools/ardy/cclay_worker.py).
 *
 * Resolves {code} when the worker accepted and finished the job (its stdout
 * lines have already been relayed), or null when the worker is unavailable
 * or died mid-job — the caller falls back to a direct spawn, which is always
 * correct because the job is idempotent (same --output, overwritten).
 */
function runViaWorker(mode, flagArgs) {
	return new Promise((resolvePromise) => {
		const sock = createConnection({ host: "127.0.0.1", port: WORKER_PORT });
		let buffer = "";
		let settled = false;
		const finish = (value) => {
			if (!settled) {
				settled = true;
				sock.destroy();
				resolvePromise(value);
			}
		};
		sock.setTimeout(WORKER_SILENCE_TIMEOUT_MS, () => finish(null));
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ mode, argv: flagArgs })}\n`);
		});
		sock.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const marker = /^worker: exit (\d+)$/.exec(line);
				if (marker) {
					finish({ code: Number(marker[1]) });
					return;
				}
				if (line) console.log(line);
			}
		});
	});
}

async function main() {
	const [mode, ...rest] = process.argv.slice(2);
	if (!mode || mode === "-h" || mode === "--help") usage();
	const generator = GENERATORS[mode];
	if (!generator) die(`unknown mode '${mode}' (expected single, sequence, or edit)`);
	if (!existsSync(VENV_PY)) {
		die(`venv python not found at ${VENV_PY}; run \`node tools/ardy/setup-local.mjs\` once`);
	}
	if (!existsSync(LOCAL_DIR)) {
		die(`ARDY checkout not found at ${LOCAL_DIR}; run \`node tools/ardy/setup-local.mjs\` once`);
	}

	const { passthrough, output, cpu, poses, manifest } = parseArgs(rest);

	const flagArgs = [...passthrough];
	let stagingDir = null;
	if (mode === "edit") {
		if (!manifest) die("--manifest is required in edit mode");
		if (poses.length === 0) die("edit mode needs at least one --pose");
		// cclay_motion_edit.py resolves the manifest's relative pose_path
		// entries against the manifest's own directory, expecting pose-<i>.npz
		// siblings (the layout run-edit-on-box.sh created with scp). Stage the
		// same layout in a fresh temp dir.
		stagingDir = mkdtempSync(join(tmpdir(), "cozyclay-edit-"));
		cpSync(manifest, join(stagingDir, "manifest.json"));
		poses.forEach((posePath, index) => {
			cpSync(posePath, join(stagingDir, `pose-${index}.npz`));
		});
		flagArgs.push("--manifest", join(stagingDir, "manifest.json"));
	} else if (manifest) {
		flagArgs.push("--manifest", manifest);
	}
	flagArgs.push("--output", output);

	const env = { ...process.env };
	if (cpu) env.CCLAY_ARDY_DEVICE = "cpu";

	// Prefer the warm worker; a forced device (--cpu / CCLAY_ARDY_DEVICE)
	// bypasses it because the worker's model already lives on the auto-picked
	// device. null = worker unavailable, fall through to a direct spawn.
	let code = null;
	const forcedDevice = cpu || Boolean(process.env.CCLAY_ARDY_DEVICE);
	if (!forcedDevice) {
		const workerResult = await runViaWorker(mode, flagArgs);
		if (workerResult) {
			console.log("run-local: served by warm worker");
			code = workerResult.code;
		}
	}
	if (code === null) {
		console.log(`run-local: ${mode} generation with ${basename(VENV_PY)} (${LOCAL_DIR})`);
		const child = spawn(VENV_PY, [generator, ...flagArgs], {
			cwd: LOCAL_DIR, // keeps any generator-relative paths (outputs/, HF cache) out of this repo
			stdio: ["ignore", "inherit", "inherit"],
			env,
		});
		code = await new Promise((resolvePromise, reject) => {
			child.on("error", reject);
			child.on("close", resolvePromise);
		});
	}
	if (stagingDir) {
		// Cleanup failure must never mask the real result.
		try {
			rmSync(stagingDir, { recursive: true, force: true });
		} catch (err) {
			console.error(`run-local: could not remove ${stagingDir}: ${err.message}`);
		}
	}
	if (code !== 0) {
		console.error(`run-local: generator exited with code ${code}`);
		process.exit(code || 1);
	}
	let size;
	try {
		size = statSync(output).size;
	} catch {
		console.error(`run-local: generator exited 0 but ${output} does not exist`);
		process.exit(1);
	}
	if (size === 0) {
		console.error(`run-local: generator produced an empty file at ${output}`);
		process.exit(1);
	}
	console.log(`run-local: done - ${output} (${size} bytes)`);
}

main().catch((err) => {
	console.error(`run-local: ${err.stack || err}`);
	process.exit(1);
});
