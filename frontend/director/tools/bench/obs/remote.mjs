import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertGpuIdle } from "../fit/remote.mjs";

const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const port = process.env.CCLAY_EXTRACT_SSH_PORT;
const sshFlags = port ? [...sshOptions, "-p", port] : sshOptions;
const scpFlags = port ? [...sshOptions, "-P", port] : sshOptions;
const here = fileURLToPath(new URL("../", import.meta.url));
let injectedExec = null;

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function realExec(program, args, log) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const onData = chunk => { output += chunk; if (log) appendFileSync(log, chunk); };
		child.stdout.on("data", onData); child.stderr.on("data", onData);
		child.once("error", reject);
		child.once("close", code => code === 0 ? resolve(output) : reject(new Error(`${program} exited ${code}: ${output.slice(-3000)}`)));
	});
}

/** Test hook: replace ssh/scp execution with (program, args, log) => Promise. */
export function setObsExec(exec) { injectedExec = exec; }

function cameraK(camera) {
	const value = typeof camera === "string" ? JSON.parse(readFileSync(camera, "utf8")) : camera;
	const K = value?.K ?? value?.intrinsics?.K ?? value?.intrinsics;
	if (!Array.isArray(K) || K.length !== 3 || K.some(row => !Array.isArray(row) || row.length !== 3)) {
		throw new Error("camera must contain a 3x3 K array");
	}
	return K;
}

async function run(program, args, log) {
	return (injectedExec ?? realExec)(program, args, log);
}

export async function extractObs({ host, video, camera, output, detector = "palette", keypoints = "vitpose", betas, log, force = false }) {
	if (!host) throw new Error("missing host");
	if (!video || !camera || !output) throw new Error("video, camera, and output are required");
	if (!["palette", "yolo"].includes(detector)) throw new Error(`invalid detector: ${detector}`);
	if (!["vitpose", "hybrid"].includes(keypoints)) throw new Error(`invalid keypoints: ${keypoints}`);
	const exec = (program, args) => run(program, args, log);
	if (!injectedExec) await assertGpuIdle(host);
	else await exec("ssh", [...sshFlags, host, "python3 -c 'import sys; print(\"GPU idle for GVHMR\")'"]);

	const remote = `/tmp/cclay-obs-${Date.now()}-${randomBytes(5).toString("hex")}`;
	const localK = `${output}.K-${process.pid}.json`;
	const K = cameraK(camera);
	writeFileSync(localK, JSON.stringify(K));
	let failure;
	try {
		await exec("ssh", [...sshFlags, host, `umask 077 && mkdir ${quote(remote)}`]);
		await exec("scp", [...scpFlags, `${here}/cclay_bench_extract_obs.py`, `${host}:${remote}/cclay_bench_extract_obs.py`]);
		await exec("scp", [...scpFlags, video, `${host}:${remote}/video.mp4`]);
		await exec("scp", [...scpFlags, localK, `${host}:${remote}/K.json`]);
		const args = [
			`${remote}/cclay_bench_extract_obs.py`,
			"cclay_gvhmr_extract.py",
			`${remote}/video.mp4`, `${remote}/obs.npz`, "--K-json", `${remote}/K.json`,
			"--detector", detector, "--keypoints", keypoints, "--out-root", `${remote}/cache`, "--check-pp",
		];
		if (betas) {
			await exec("scp", [...scpFlags, betas, `${host}:${remote}/betas.json`]);
			args.push("--betas-json", `${remote}/betas.json`);
		}
		await exec("ssh", [...sshFlags, host, `set -e; cd ~/cclay-ingest/GVHMR; .venv/bin/python ${args.map(quote).join(" ")}`]);
		await exec("scp", [...scpFlags, `${host}:${remote}/obs.npz`, output]);
	} catch (error) {
		failure = error;
	} finally {
		try { unlinkSync(localK); } catch {}
		try { await exec("ssh", [...sshFlags, host, `rm -rf ${quote(remote)}`]); }
		catch (error) { failure = failure ? new AggregateError([failure, error], `remote cleanup failed: ${remote}`) : error; }
	}
	if (failure) throw failure;
	return { output, remote };
}
