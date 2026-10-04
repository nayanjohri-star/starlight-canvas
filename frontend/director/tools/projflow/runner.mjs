/**
 * runner.mjs — ProjFlow backend for the generation bridge.
 *
 * Mirrors the surface tools/kimodo/runner.mjs exposes ({ mode, describe,
 * probeHealth, ... , <mode>Command }) so bridge.mjs (agent M4, wave 2) can spawn
 * the returned command and grep its `done - <path> (<bytes>)` line exactly as it
 * does for Kimodo. Nothing here talks to the box directly except probeHealth;
 * everything else builds a command for the bridge to spawn.
 *
 * WHAT THIS BACKEND DOES. One thing: line edits. ProjFlow is adopted as an
 * ENGINE-PER-TASK, not an engine-per-session (contract C6) — the bridge routes a
 * `lineEdit` request here regardless of CCLAY_MOTION_BACKEND and keeps sending
 * everything else to Kimodo. So the text-to-motion, sequencing, preserve and
 * base-clip entry points are not implemented and refuse by name rather than
 * quietly producing a take that ignored their inputs.
 *
 * (ProjFlow's checkpoint is a text-conditioned model and CAN generate from a
 * prompt alone, so `singleCommand` is a deliberate refusal, not a missing
 * feature: Kimodo already owns that path, produces rotations rather than
 * positions, and swapping engines under an unchanged request would silently
 * change the take's skeleton fidelity.)
 *
 * WHAT THE COMMAND PRODUCES. The raw hml22 (T,22,3) .npy the box wrote, plus its
 * .meta.json sidecar — NOT a cclay npz. Lifting 22-joint positions to cskel27
 * (contract C8, agent M2) and splicing the edited span back into the source take
 * (agent M5) are separate modules that do not exist yet; wave-2 integration
 * composes them on top of this output. The raw motion is also exactly what a
 * LATER line edit sources from, so keeping it is not scaffolding.
 *
 * ENV. Everything is read at construction so `describe()` can report it:
 *
 *   CCLAY_PROJFLOW_HOST     the GPU box; falls back to CCLAY_KIMODO_HOST,
 *                           because one box serves both engines today and making
 *                           the operator set two variables to the same value is
 *                           how one of them goes stale.
 *   CCLAY_PROJFLOW_REPO     the ProjFlow clone (S1 put it at
 *                           /home/yun/projflow-scout/repo — note `repo`, not
 *                           `ProjFlow`; the clone was named by the setup script).
 *   CCLAY_PROJFLOW_PYTHON   the scout venv's python (S1: python3.10 venv, pinned
 *                           numpy==1.23.5 / timm==1.0.9 — the system python
 *                           cannot run the repo).
 *   CCLAY_PROJFLOW_HOME     HOME override for every box run, so CLIP's 338 MB
 *                           ViT-B/32 download stays inside the scout directory.
 *   CCLAY_PROJFLOW_STEPS / _RIDGE / _PRESERVE_STRIDE / _PRESERVE_MARGIN
 *                           tunables read by generate.mjs itself.
 *   CCLAY_PROJFLOW_RESIDENT=0
 *                           turn the warm service off (contract C11); every
 *                           edit then takes the cold path it always had.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { peekResidentService, residentEnabled } from "./service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** generate.mjs doubles as the box wrapper; see the CLI note at the bottom of
 * that file for why ProjFlow has one script where Kimodo has two. */
const RUN_LINE_EDIT = join(HERE, "generate.mjs");

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export const DEFAULT_REPO = "/home/yun/projflow-scout/repo";
export const DEFAULT_PYTHON = "/home/yun/projflow-scout/venv/bin/python";
export const DEFAULT_BOX_HOME = "/home/yun/projflow-scout/home";

function run(argv, timeoutMs = 60_000) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * Where a run whose bridge output is `outputPath` keeps the RAW hml22 motion.
 *
 * Same role, and the same one-place-decides rule, as Kimodo's
 * nativeMotionPath: generate.mjs writes the file, a later edit finds it again.
 * The suffix says which engine wrote it because the two formats are not
 * interchangeable — Kimodo's is a 77-joint rotation npz, this is a 22-joint
 * position npy.
 */
export function nativeMotionPath(outputPath) {
	return `${String(outputPath).replace(/\.(npz|npy)$/i, "")}.projflow.npy`;
}

/** The metadata sidecar driver.py wrote beside a native motion: row count,
 * sampling seconds, and the exactness numbers gates GP1/GP2 read. */
export function metaPath(nativePath) {
	return `${String(nativePath).replace(/\.npy$/i, "")}.meta.json`;
}

function unsupported(feature) {
	return () => {
		throw new Error(
			`the ProjFlow backend only implements line edits; ${feature} stays on the Kimodo backend`
		);
	};
}

export function createProjflowRunner() {
	const HOST = process.env.CCLAY_PROJFLOW_HOST || process.env.CCLAY_KIMODO_HOST || "";
	const REPO = process.env.CCLAY_PROJFLOW_REPO || DEFAULT_REPO;
	const PYTHON = process.env.CCLAY_PROJFLOW_PYTHON || DEFAULT_PYTHON;
	const BOX_HOME = process.env.CCLAY_PROJFLOW_HOME || DEFAULT_BOX_HOME;

	if (!HOST) {
		throw new Error(
			"CCLAY_PROJFLOW_HOST (or CCLAY_KIMODO_HOST) is required for the ProjFlow backend (for example: user@gpu-box)"
		);
	}

	/**
	 * Can the box actually run a line edit?
	 *
	 * The check is "does the venv python import the REPO", not "is there a
	 * python": S1's install needed pinned numpy 1.23.5 (1.24+ dies on
	 * `np.finfo(np.float)` in utils/quaternion.py) and timm 1.0.9 (newer timm
	 * passes `device=` into the norm layer and blows up at models/ACMDM.py:467).
	 * Both failures happen at IMPORT time, so importing models.ACMDM is exactly
	 * the check that separates "the env is fine" from "the next real run will die
	 * six seconds in". The checkpoint's presence is verified too, because a
	 * missing 625 MB tar is the other way a healthy-looking box fails a run.
	 */
	async function probeHealth() {
		const script = [
			"import sys, os, torch",
			"import models.ACMDM as m",
			"ck = os.path.join('checkpoints', 't2m', 'ACMDM_Raw_Flow_S_PatchSize22', 'model', 'latest.tar')",
			"print('device=' + ('cuda:0' if torch.cuda.is_available() else 'cpu'))",
			"print('models=%d' % len(m.ACMDM_models))",
			"print('checkpoint=%s' % ('yes' if os.path.exists(ck) else 'no'))",
		].join("; ");
		const remote = [
			`cd ${JSON.stringify(REPO)}`,
			`HOME=${BOX_HOME} ${PYTHON} -c ${JSON.stringify(script)}`,
		].join(" && ");
		const { code, stdout, stderr } = await run(["ssh", ...SSH_OPTS, HOST, remote], 120_000);
		if (code !== 0) {
			throw new Error(
				`ssh probe on ${HOST} failed (exit ${code}): ${stderr.trim().split("\n").pop()}`
			);
		}
		const device = /^device=(.*)$/m.exec(stdout)?.[1] ?? "unknown";
		const checkpoint = /^checkpoint=(.*)$/m.exec(stdout)?.[1] === "yes";
		if (!checkpoint) {
			throw new Error(
				`${HOST}:${REPO} has no ACMDM_Raw_Flow_S_PatchSize22 checkpoint; a line edit would fail after the ssh round trip`
			);
		}
		// No encoder sidecar: CLIP loads in the generation process (S1 measured
		// the whole model load at 3.9 s), so health has nothing to report for it
		// and says so rather than faking a port.
		return {
			ok: true,
			host: HOST,
			repo: REPO,
			encoder: "in-process",
			device,
			checkpoint: true,
			resident: await residentUp(),
		};
	}

	/**
	 * Is a WARM child actually there right now (contract C11)?
	 *
	 * Deliberately three things it is not. It does not START a resident: a
	 * health probe that loads 800 MiB of weights onto the GPU as a side effect
	 * would be a surprising answer to "are you well". It does not trust
	 * `state === "ready"`, which only says the child announced itself at some
	 * point; it sends a ping and waits for the answer, because the interesting
	 * failure is a child that died an hour ago. And it never throws — a
	 * resident that cannot be reached is `false`, not a failed health check,
	 * since every edit still works through the cold path.
	 */
	async function residentUp() {
		if (!residentEnabled()) return false;
		const service = peekResidentService({ host: HOST, python: PYTHON, repo: REPO, boxHome: BOX_HOME });
		if (!service || !service.isReady()) return false;
		try {
			const pong = await service.ping();
			return pong?.pong === true;
		} catch {
			return false;
		}
	}

	// ProjFlow takes a source motion, not a base clip; there is nothing to list.
	// An empty listing is a valid answer, not a failure, and the bridge already
	// tolerates it for Kimodo.
	async function listBases() {
		return [];
	}

	/** The environment the box wrapper inherits. Every key is set explicitly and
	 * the run-scoped one is DELETED when unused: process.env is inherited from a
	 * long-lived sidecar, and a leftover output path would have the next request
	 * silently overwrite the previous take. */
	function boxEnv({ output } = {}) {
		const env = {
			...process.env,
			CCLAY_PROJFLOW_HOST: HOST,
			CCLAY_PROJFLOW_REPO: REPO,
			CCLAY_PROJFLOW_PYTHON: PYTHON,
			CCLAY_PROJFLOW_HOME: BOX_HOME,
		};
		delete env.CCLAY_PROJFLOW_NATIVE_OUT;
		if (output) env.CCLAY_PROJFLOW_NATIVE_OUT = nativeMotionPath(output);
		return env;
	}

	/** Which artifact of an earlier run this backend can edit, or null when that
	 * take has none — it came from Kimodo, or predates line editing. The bridge
	 * refuses the edit and says so rather than converting a lossy cskel27 file
	 * back into positions. */
	function sourceMotionFor(motionPath) {
		return nativeMotionPath(motionPath);
	}

	/**
	 * The one command this backend builds.
	 *
	 * `line` is a C6 request; it travels as a FILE rather than on argv because a
	 * 20-point polyline plus a 3x3 rotation is not a command line, and because the
	 * bridge already writes per-run JSON for Kimodo's constraints. The caller
	 * writes it; this function only names it.
	 */
	function lineEditCommand({ source, line, output, steps, preview = false, seed }) {
		if (!source) throw new Error("lineEditCommand: source (an hml22 .npy take) is required");
		if (!line) throw new Error("lineEditCommand: line (a path to the C6 request JSON) is required");
		if (!output) throw new Error("lineEditCommand: output is required");
		const args = [RUN_LINE_EDIT, "--source", source, "--line", line, "--output", nativeMotionPath(output)];
		if (preview) args.push("--preview");
		else if (Number.isInteger(steps)) args.push("--steps", String(steps));
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		return {
			command: process.execPath,
			args,
			env: boxEnv({ output }),
			doneRe: /^run-projflow-line-edit: done - (.+) \((\d+) bytes\)$/,
			label: "run-projflow-line-edit",
		};
	}

	return {
		mode: "projflow",
		describe: () =>
			`box ${HOST} (repo ${REPO}, ACMDM_Raw_Flow_S_PatchSize22, 22-joint positions @ 20 fps)`,
		probeHealth,
		listBases,
		sourceMotionFor,
		lineEditCommand,
		// Named refusals, so a mis-routed request reads as a routing bug rather
		// than a crash inside an unrelated module.
		singleCommand: unsupported("text-to-motion generation"),
		sequenceCommand: unsupported("multi-segment sequencing"),
		editCommand: unsupported("prompt-based span regeneration"),
	};
}
