import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCondition, resolveCondition } from "../extract-bench-lib.mjs";

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const port = process.env.CCLAY_EXTRACT_SSH_PORT;
const sshFlags = port ? [...sshOptions, "-p", port] : sshOptions;
const scpFlags = port ? [...sshOptions, "-P", port] : sshOptions;
const here = fileURLToPath(new URL("../", import.meta.url));

function exec(program, args, log) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const onData = chunk => { output += chunk; if (log) appendFileSync(log, chunk); };
		child.stdout.on("data", onData); child.stderr.on("data", onData);
		child.once("error", reject);
		child.once("close", code => code === 0 ? resolve(output) : reject(new Error(`${program} exited ${code}: ${output.slice(-3000)}`)));
	});
}

// Refuse even idle GVHMR workers: a separate sweep can submit to them at any
// moment. No process is killed. Check again in the SAME remote shell before
// starting; the caller must still coordinate independent noncooperating jobs.
const idleCheck = `python3 - <<'PY'
from pathlib import Path
import subprocess
busy = []
for p in Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        argv = (p/'cmdline').read_bytes().split(b'\\0')
        executable = Path(argv[0].decode(errors='replace')).name
        cmd = b' '.join(argv).decode(errors='replace')
    except (FileNotFoundError, ProcessLookupError, PermissionError): continue
    # PyTorch renames /proc/<pid>/comm to pt_main_thread. Inspect argv[0],
    # not that mutable thread label, including workers idling at only 284 MiB.
    if 'python' in executable and ('cclay_gvhmr' in cmd or 'cclay_bench' in cmd): busy.append(cmd)
usage = subprocess.check_output(['nvidia-smi','--query-compute-apps=used_memory','--format=csv,noheader,nounits'], text=True)
# Leave room for production's 8GB peak with the existing ~1GB ARDY worker.
used = sum(int(v.strip()) for v in usage.splitlines() if v.strip())
if busy or used > 1600:
    raise SystemExit('GPU busy: ' + repr(busy) + '; compute memory=' + str(used) + ' MiB')
print('GPU idle for GVHMR; compute memory=' + str(used) + ' MiB')
PY`;

export async function assertGpuIdle(host) {
	return exec("ssh", [...sshFlags, host, idleCheck]);
}

/** A cache is bound to the video, focal and source code, never silently reused
 * for a different camera/condition. Results and logs live locally; ALL box
 * uploads, caches and model outputs are removed from /tmp/cclay-fit-*.
 */
export function incamPlan(baseCondition = "prod", { cameraFMm, env = process.env } = {}) {
	const base = parseCondition(baseCondition);
	if (base.fmm) throw new Error("base condition must omit +fmm");
	const plan = resolveCondition(`${base.name}+fmm`, { cameraFMm, env });
	if (!plan.runnerArgs.includes("--static-cam")) throw new Error("incam bench requires a static camera");
	if (plan.path === "worker" && !plan.workerFields.trajectory) throw new Error("incam worker path requires production trajectory correction");
	return { plan, launcherArgs: plan.path === "direct" ? ["--bench-direct"] : [] };
}

export async function extractMissingFocal({ input, extract, motion, variant, baseCondition, host }) {
	if (!host) throw new Error(`missing ${baseCondition}+fmm extraction; pass --host to extract it serially`);
	await assertGpuIdle(host);
	return exec(process.execPath, [fileURLToPath(new URL("../extract-bench.mjs", import.meta.url)), "--input", input, "--out", extract, "--motions", motion, "--variants", variant, "--conditions", `${baseCondition}+fmm`, "--host", host]);
}

export async function extractIncam({ host, video, output, camera, log, force = false, baseCondition = "prod" }) {
	const files = [
		[`${here}/cclay_bench_extract_incam.py`, "cclay_bench_extract_incam.py"],
		[fileURLToPath(new URL("../../ardy/gvhmr_fastpath.py", import.meta.url)), "gvhmr_fastpath.py"],
		[fileURLToPath(new URL("../../ardy/gvhmr_trajectory.py", import.meta.url)), "gvhmr_trajectory.py"],
	];
	const { plan, launcherArgs } = incamPlan(baseCondition, { cameraFMm: camera.gvhmrFMm });
	const sha = createHash("sha256").update(readFileSync(video));
	for (const [path] of files) sha.update(readFileSync(path));
	sha.update(JSON.stringify(plan));
	const signature = sha.digest("hex"), manifest = `${output}.json`;
	if (!force && existsSync(output) && existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).signature === signature) return { cached: true, signature };
	if (!host) throw new Error(`missing camera cache ${output}; pass --host to extract`);
	await assertGpuIdle(host);
	const remote = `/tmp/cclay-fit-${Date.now()}-${randomBytes(5).toString("hex")}`;
	const ssh = command => exec("ssh", [...sshFlags, host, command], log);
	const scp = (a, b) => exec("scp", [...scpFlags, a, b], log);
	writeFileSync(log, "");
	let failure;
	try {
		await ssh(`umask 077 && mkdir ${quote(remote)}`);
		for (const [path, name] of files) await scp(path, `${host}:${remote}/${name}`);
		await scp(video, `${host}:${remote}/video.mp4`);
		const args = [`${remote}/cclay_bench_extract_incam.py`, "cclay_gvhmr_extract.py", `${remote}/video.mp4`, `${remote}/incam.npz`, ...launcherArgs, ...plan.runnerArgs, "--out-root", `${remote}/cache`];
		await ssh(`set -e\n${idleCheck}\ncd ~/cclay-ingest/GVHMR\n.venv/bin/python ${args.map(quote).join(" ")}`);
		await scp(`${host}:${remote}/incam.npz`, output);
		const runnerSha = (await ssh("shasum -a 256 ~/cclay-ingest/GVHMR/cclay_gvhmr_extract.py")).trim().split(/\s+/)[0];
		writeFileSync(manifest, JSON.stringify({ signature, runnerSha, plan, video, createdAt: new Date().toISOString() }, null, 2) + "\n");
	} catch (error) { failure = error; }
	try { await ssh(`rm -rf ${quote(remote)}`); } catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], `box cleanup failed: ${remote}`); }
	if (failure) throw failure;
	return { cached: false, signature };
}
