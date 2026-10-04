/**
 * Remote (ssh) runner for the ARDY bridge.
 *
 * This is the original box-driven backend extracted verbatim from bridge.mjs:
 * health and bases probes go over one ssh round trip each, reference dumps
 * scp a python script to the box's /tmp, and generation shells out to the
 * run-*-on-box.sh wrappers, which push inputs, run the generator remotely and
 * pull the npz back.
 *
 * The runner interface (shared with runners/local.mjs) is deliberately small:
 *
 *   describe()                     one-line startup log
 *   probeHealth()                  -> { ok:true, host, encoder, device } | throws
 *   listBases()                    -> raw entries [{id, path, frames}] | throws
 *   singleCommand(request)         -> { command, args, env, doneRe }
 *   sequenceCommand(request)       -> { command, args, env, doneRe }
 *   editCommand(request)           -> { command, args, env, doneRe }
 *
 * The bridge owns validation, caching, streaming and the motion allowlist;
 * a runner only knows how to probe its backend and how to build the argv for
 * one generation child whose stdout carries a `doneRe`-matching marker line
 * (`<marker>: done - <path> (<bytes> bytes)`) on success.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastLine, run } from "./proc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_ARDY = join(HERE, "..");
const RUN_ON_BOX = join(TOOLS_ARDY, "run-on-box.sh");
const RUN_SEQUENCE_ON_BOX = join(TOOLS_ARDY, "run-sequence-on-box.sh");
const RUN_EDIT_ON_BOX = join(TOOLS_ARDY, "run-edit-on-box.sh");

// BatchMode: never hang on a password prompt. ConnectTimeout fails fast on a
// dead host; ServerAlive* drops a wedged connection (same set run-on-box.sh
// uses).
const SSH_OPTS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "ServerAliveInterval=30",
	"-o", "ServerAliveCountMax=240",
];

export function createRemoteRunner() {
	// Same env var names as run-on-box.sh, so health, the bases listing and
	// generation all talk to one operator-configured host/venv/encoder.
	const HOST = process.env.CCLAY_ARDY_HOST?.trim() || "";
	const REMOTE = process.env.CCLAY_ARDY_REPO || "$HOME/ardy"; // literal $HOME: the REMOTE shell expands it
	const VENV_PY = process.env.CCLAY_ARDY_VENV || "~/ardy/.venv-cuda/bin/python"; // generator venv (tilde expands on the box)
	const ENCODER_URL = process.env.CCLAY_ARDY_ENCODER_URL || "http://127.0.0.1:9550/";
	// Numpy-only read paths (bases listing, reference dumps) use the CPU venv
	// on purpose: the box's two venvs are NOT interchangeable, and this is the
	// one the dump tooling is verified under.
	const DUMP_PY = "~/ardy/.venv/bin/python";

	if (!HOST) {
		throw new Error("CCLAY_ARDY_HOST is required for the remote runner (for example: user@ardy-host)");
	}

	// Force the same box config onto the run-*-on-box.sh wrappers even when
	// the bridge was started with different env values; they must not disagree.
	function boxEnv() {
		return {
			...process.env,
			CCLAY_ARDY_HOST: HOST,
			CCLAY_ARDY_REPO: REMOTE,
			CCLAY_ARDY_VENV: VENV_PY,
			CCLAY_ARDY_ENCODER_URL: ENCODER_URL,
		};
	}

	// One ssh round trip covers everything health needs: the host answering is
	// the ssh call itself, then the encoder HTTP code and the device the
	// generator venv would pick are read on the box with the same env the
	// generator runs under. The device line mirrors run-on-box.sh's probe
	// exactly, so what health reports is what the generation will use.
	function healthRemoteCmd() {
		return [
			`ENC="$(curl -s -o /dev/null -w '%{http_code}' -m 10 ${ENCODER_URL})"`,
			'[ -n "$ENC" ] || ENC="000"',
			`DEV="$(cd ${REMOTE} && ${VENV_PY} -c 'import torch; print("cuda:0" if torch.cuda.is_available() else "cpu")')"`,
			`printf 'encoder=%s\\ndevice=%s\\n' "$ENC" "$DEV"`,
		].join(" && ");
	}

	async function probeHealth() {
		const { code, stdout, stderr } = await run(
			["ssh", ...SSH_OPTS, HOST, healthRemoteCmd()],
			{ timeoutMs: 60_000 }
		);
		if (code !== 0) {
			throw new Error(`ssh probe on ${HOST} failed (exit ${code}): ${lastLine(stderr)}`);
		}
		const fields = {};
		for (const line of stdout.split("\n")) {
			const match = /^(encoder|device)=(.*)$/.exec(line.trim());
			if (match) fields[match[1]] = match[2];
		}
		if (!("encoder" in fields)) {
			throw new Error(`encoder probe on ${HOST} produced no answer`);
		}
		if (fields.encoder !== "200") {
			throw new Error(`text encoder at ${ENCODER_URL} answered ${fields.encoder}, not 200`);
		}
		if (!("device" in fields) || fields.device === "") {
			const tail = lastLine(stderr);
			throw new Error(
				`device probe on ${HOST} produced no answer${tail ? `: ${tail}` : ""}`
			);
		}
		if (!/^(cpu|cuda:\d+)$/.test(fields.device)) {
			throw new Error(
				`device probe on ${HOST} returned unexpected ${JSON.stringify(fields.device)}`
			);
		}
		return { ok: true, host: HOST, encoder: Number(fields.encoder), device: fields.device };
	}

	// Frame counts come from a real load of each npz, in ONE ssh call: the
	// script is fed to the box's python over a quoted heredoc (no local shell
	// step), and entries that fail to load are skipped with a note on the box
	// stderr instead of failing the whole listing.
	function basesRemoteCmd() {
		const script = [
			"import glob, json, sys",
			"import numpy as np",
			"entries = []",
			'for pattern in ("outputs/*.npz", "outputs/omb/*.npz"):',
			"    for path in sorted(glob.glob(pattern)):",
			"        try:",
			'            data = np.load(path, allow_pickle=False)',
			'            frames = int(data["posed_joints"].shape[0])',
			"            data.close()",
			"        except Exception as exc:",
			'            print("bases: skipping %s: %s" % (path, exc), file=sys.stderr)',
			"            continue",
			'        entries.append({"id": path.rsplit("/", 1)[-1][:-4], "path": path, "frames": frames})',
			"print(json.dumps(entries))",
		].join("\n");
		return `cd ${REMOTE} && ${DUMP_PY} - <<'COZYCLAY_PY_EOF'\n${script}\nCOZYCLAY_PY_EOF`;
	}

	async function listBases() {
		const { code, stdout, stderr } = await run(
			["ssh", ...SSH_OPTS, HOST, basesRemoteCmd()],
			{ timeoutMs: 120_000 }
		);
		if (code !== 0) {
			throw new Error(`bases listing on ${HOST} failed (exit ${code}): ${lastLine(stderr)}`);
		}
		let entries;
		try {
			entries = JSON.parse(stdout);
		} catch (err) {
			throw new Error(
				`bases listing on ${HOST} did not parse as JSON: ${lastLine(stderr) || err.message}`
			);
		}
		if (!Array.isArray(entries)) {
			throw new Error(`bases listing on ${HOST} was not an array`);
		}
		return entries;
	}

	// --- generation argv builders -----------------------------------------
	// Each returns what the bridge needs to spawn ONE child whose stdout ends
	// in a done marker: pose/waypoint/free single runs, autoregressive
	// sequence runs, and context-aware motion edits.

	function singleCommand({ poseFroms, basePath, prompt, durationS, seed, cpu, waypoints, rootMargin, contactThreshold, historyFrames, output }) {
		const args = [RUN_ON_BOX];
		for (const entry of poseFroms) {
			args.push("--pose-from", entry.npz, String(entry.srcFrame), String(entry.dstFrame));
		}
		if (basePath) args.push("--base", basePath);
		args.push("--prompt", prompt, "--duration", String(durationS));
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		if (cpu === true) args.push("--cpu");
		for (const wp of waypoints || []) {
			args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
		}
		if (Number.isFinite(rootMargin)) args.push("--root-margin", String(rootMargin));
		if (Number.isFinite(contactThreshold)) args.push("--contact-threshold", String(contactThreshold));
		if (Number.isInteger(historyFrames)) args.push("--history-frames", String(historyFrames));
		args.push("--output", output);
		return {
			command: "bash",
			args,
			env: boxEnv(),
			doneRe: /^run-on-box: done - (.+) \((\d+) bytes\)$/,
			label: "run-on-box",
		};
	}

	function sequenceCommand({ segments, waypoints, seed, cpu, rootMargin, contactThreshold, historyFrames, output }) {
		const args = [RUN_SEQUENCE_ON_BOX];
		for (const segment of segments) {
			args.push("--segment", segment.prompt, String(segment.durationS));
		}
		// Root waypoints ride the same chained rollout (rollout-global frames):
		// the sequence generator slices the constraint set per segment call, so
		// a path and a prompt schedule coexist.
		for (const wp of waypoints || []) {
			args.push("--root-2d", String(wp.frame), String(wp.x), String(wp.z), wp.heading === null ? "none" : String(wp.heading));
		}
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		if (cpu === true) args.push("--cpu");
		if (Number.isFinite(rootMargin)) args.push("--root-margin", String(rootMargin));
		if (Number.isFinite(contactThreshold)) args.push("--contact-threshold", String(contactThreshold));
		if (Number.isInteger(historyFrames)) args.push("--history-frames", String(historyFrames));
		args.push("--output", output);
		return {
			command: "bash",
			args,
			env: boxEnv(),
			doneRe: /^run-sequence-on-box: done - (.+) \((\d+) bytes\)$/,
			label: "run-sequence-on-box",
		};
	}

	function editCommand({ source, manifest, prompt, contextBefore, contextAfter, seed, poseNpzPaths, output }) {
		const args = [
			RUN_EDIT_ON_BOX,
			"--source", source,
			"--manifest", manifest,
			"--prompt", prompt,
			"--context-before", String(contextBefore),
			"--context-after", String(contextAfter),
			"--output", output,
		];
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		for (const posePath of poseNpzPaths) args.push("--pose", posePath);
		return {
			command: "bash",
			args,
			env: boxEnv(),
			doneRe: /^run-edit-on-box: done - (.+) \((\d+) bytes\)$/,
			label: "run-edit-on-box",
		};
	}

	return {
		mode: "remote",
		describe: () => `box ${HOST} (repo ${REMOTE}, generator venv ${VENV_PY}, encoder ${ENCODER_URL})`,
		probeHealth,
		listBases,
		singleCommand,
		sequenceCommand,
		editCommand,
	};
}
