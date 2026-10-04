#!/usr/bin/env node
/**
 * setup-local.mjs - provision local ARDY motion generation for CozyClay.
 *
 *   node tools/ardy/setup-local.mjs [--skip-checkpoint] [--skip-encoder]
 *
 * Everything lands OUTSIDE this repo, in a per-user directory; the repo
 * never contains model weights. All downloads come from their official
 * sources, pinned or content-verified:
 *
 *   ~/.cozyclay/ardy            git clone of github.com/nv-tlabs/ardy
 *                               (Apache-2.0) + a python venv with torch,
 *                               ardy, gradio
 *   HF hub cache                nvidia/ARDY-Core-RP-20FPS-Horizon40 motion
 *                               checkpoint via huggingface_hub (NVIDIA Open
 *                               Model License)
 *   ~/.cozyclay/text-encoders   Llama-3-8B + LLM2Vec encoder stack from
 *                               public, ungated mirrors, every shard
 *                               SHA-256-verified (setup-text-encoder.py),
 *                               then LoRA-merged in place
 *                               (merge-text-encoder.py); ~16.4 GB, resumable
 *
 * Every step is idempotent: re-running verifies and fills gaps only.
 * Overrides: CCLAY_ARDY_LOCAL_DIR, CCLAY_ARDY_ENCODERS_DIR, CCLAY_ARDY_PYTHON.
 *
 * torch note: `pip install torch` gives CUDA wheels on Linux and MPS wheels
 * on Apple Silicon out of the box. On Windows, install a CUDA build first if
 * you want GPU generation:
 *   <venv>\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu126
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARDY_GIT_URL = "https://github.com/nv-tlabs/ardy.git";
const ARDY_CHECKPOINT = "nvidia/ARDY-Core-RP-20FPS-Horizon40";
const LOCAL_DIR = process.env.CCLAY_ARDY_LOCAL_DIR || join(homedir(), ".cozyclay", "ardy");
const ENCODERS_DIR = process.env.CCLAY_ARDY_ENCODERS_DIR || join(homedir(), ".cozyclay", "text-encoders");
const IS_WIN = process.platform === "win32";
const VENV_DIR = join(LOCAL_DIR, ".venv");
const VENV_PY = join(VENV_DIR, IS_WIN ? "Scripts\\python.exe" : "bin/python");

const skipCheckpoint = process.argv.includes("--skip-checkpoint");
const skipEncoder = process.argv.includes("--skip-encoder");

function log(message) {
	console.log(`setup-local: ${message}`);
}

function die(message) {
	console.error(`setup-local: ${message}`);
	process.exit(1);
}

// Run a step to completion with output visible; die with context on failure.
function run(label, argv, options = {}) {
	log(label);
	const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", ...options });
	if (result.error) die(`${label} failed: ${result.error.message}`);
	if (result.status !== 0) die(`${label} failed (exit ${result.status})`);
}

function probe(argv) {
	const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
	return result.status === 0 ? (result.stdout || "").trim() : null;
}

// --- prerequisites ----------------------------------------------------------

if (!probe(["git", "--version"])) die("git is required (https://git-scm.com)");
if (!probe(["cmake", "--version"])) {
	die(
		"cmake is required to build ARDY's motion-correction extension.\n" +
			"  macOS:  brew install cmake\n" +
			"  Linux:  apt/dnf install cmake\n" +
			"  Windows: winget install Kitware.CMake"
	);
}

// Python 3.10+ — ARDY's floor. Prefer an explicit override, then the newest
// commonly-installed minor, then the bare python3.
function findPython() {
	const candidates = process.env.CCLAY_ARDY_PYTHON
		? [process.env.CCLAY_ARDY_PYTHON]
		: ["python3.12", "python3.11", "python3.10", "python3", "python"];
	for (const candidate of candidates) {
		const version = probe([candidate, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
		if (!version) continue;
		const [major, minor] = version.split(".").map(Number);
		if (major === 3 && minor >= 10) return { python: candidate, version };
	}
	return null;
}

const found = findPython();
if (!found) {
	die(
		"python 3.10+ not found (ARDY requires >=3.10).\n" +
			"  install one (e.g. `brew install python@3.12` / `uv python install 3.12`)\n" +
			"  or point CCLAY_ARDY_PYTHON at an interpreter"
	);
}
log(`using ${found.python} (${found.version})`);

// --- ARDY checkout + venv ----------------------------------------------------

if (existsSync(join(LOCAL_DIR, "pyproject.toml"))) {
	log(`ARDY checkout already present at ${LOCAL_DIR}`);
} else if (existsSync(LOCAL_DIR)) {
	die(`${LOCAL_DIR} exists but is not an ARDY checkout; move it aside or set CCLAY_ARDY_LOCAL_DIR`);
} else {
	run(`cloning ${ARDY_GIT_URL} -> ${LOCAL_DIR}`, ["git", "clone", "--depth", "1", ARDY_GIT_URL, LOCAL_DIR]);
}

if (existsSync(VENV_PY)) {
	log(`venv already present at ${VENV_DIR}`);
} else {
	run(`creating venv at ${VENV_DIR}`, [found.python, "-m", "venv", VENV_DIR]);
}

function pipHas(module) {
	return probe([VENV_PY, "-c", `import ${module}`]) !== null;
}

run("upgrading pip", [VENV_PY, "-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
if (pipHas("torch")) {
	log("torch already installed");
} else {
	// Default wheels: CUDA on Linux, MPS on Apple Silicon, CPU on Windows
	// (see the header for the Windows CUDA index-url).
	run("installing torch (this downloads a large wheel)", [VENV_PY, "-m", "pip", "install", "torch"]);
}
if (pipHas("ardy")) {
	log("ardy package already installed");
} else {
	// Core only — never [all]: the trt extra is Linux/CUDA-only and the demo
	// extra is not needed for generation. The C++ extension builds here
	// (cmake); it may fetch pybind11/Eigen/sse2neon from their upstreams.
	run("installing ARDY into the venv (builds a small C++ extension)", [
		VENV_PY, "-m", "pip", "install", "-e", LOCAL_DIR,
	]);
}
if (pipHas("gradio")) {
	log("gradio already installed");
} else {
	// Only the text-encoder *server* needs gradio; the generator's client side
	// (gradio_client) is an ARDY core dependency already.
	run("installing gradio (text-encoder service)", [VENV_PY, "-m", "pip", "install", "gradio"]);
}

// --- ARDY motion checkpoint (HF hub, auto-cached) ----------------------------

if (skipCheckpoint) {
	log("skipping motion checkpoint download (--skip-checkpoint)");
} else {
	run(`fetching motion checkpoint ${ARDY_CHECKPOINT} into the HF cache`, [
		VENV_PY,
		"-c",
		[
			"from huggingface_hub import snapshot_download",
			`path = snapshot_download(repo_id=${JSON.stringify(ARDY_CHECKPOINT)})`,
			"print('checkpoint at', path)",
		].join("\n"),
	]);
}

// --- text-encoder weights (public mirrors, SHA-256 pinned) -------------------

if (skipEncoder) {
	log("skipping text-encoder weights (--skip-encoder)");
} else {
	run(`downloading/verifying encoder stack under ${ENCODERS_DIR} (~16.4 GB, resumable)`, [
		VENV_PY, join(HERE, "setup-text-encoder.py"), "--dest", ENCODERS_DIR,
	]);
	// Bake the MNTP LoRA into a full model (idempotent via MERGE_MANIFEST):
	// transformers v5 cannot chase adapter dirs the way ARDY's loader expects.
	run("merging MNTP LoRA into the base weights (one-time, needs RAM)", [
		VENV_PY, join(HERE, "merge-text-encoder.py"), "--dest", ENCODERS_DIR,
	], { cwd: LOCAL_DIR });
}

log("done. start CozyClay with `npm run dev` — the bridge auto-selects local mode");
log(`  ARDY:     ${LOCAL_DIR}`);
log(`  encoder:  ${ENCODERS_DIR} (lazy service on first generation)`);
log("  remote box users: CCLAY_ARDY_HOST keeps selecting the ssh backend");
