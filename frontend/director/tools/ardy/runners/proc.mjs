/**
 * Shared child-process helpers for the ARDY bridge and its runners.
 *
 * Everything here is backend-agnostic: the same helpers drive an ssh session
 * to a remote box and a local python process. All children spawned for
 * generation are detached so they lead their own process group; killing the
 * group takes down the whole tree (bash + ssh, or python + its workers), so
 * nothing is orphaned.
 */

import { spawn } from "node:child_process";

// Tracked globally so Ctrl-C can clean up in-flight children too.
export const globalChildren = new Set();

export function track(child) {
	globalChildren.add(child);
	child.once("close", () => globalChildren.delete(child));
}

export function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		/* process group already gone */
	}
	// SIGKILL backup for anything that ignores SIGTERM; unref'd so it never
	// keeps the bridge alive on its own.
	const backup = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}, 3000);
	backup.unref();
}

// Run a short, non-streaming child (probes, listings) to completion.
export function run(argv, { timeoutMs = 0 } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer = null;
		const finish = (err, code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (err) reject(err);
			else resolvePromise({ code, stdout, stderr });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => finish(err));
		child.on("close", (code) => finish(null, code));
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* gone */
				}
				finish(new Error(`timed out after ${timeoutMs} ms`));
			}, timeoutMs);
		}
	});
}

// Split a child's stdout/stderr into lines as they arrive; empty lines are
// dropped. The trailing partial line is flushed on end so the generator's
// last line is never lost.
export function streamLines(stream, onLine) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const rest = buffer.replace(/\r$/, "");
		if (rest) onLine(rest);
	});
}

// Resolves with the exit code; rejects when the child could not be started.
export function runStreaming(child, onLine) {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		const finish = (fn, value) => {
			if (!settled) {
				settled = true;
				fn(value);
			}
		};
		child.on("error", (err) => finish(reject, err));
		child.on("close", (code) => finish(resolvePromise, code));
		for (const [streamName, stream] of [
			["stdout", child.stdout],
			["stderr", child.stderr],
		]) {
			streamLines(stream, (line) => onLine(line, streamName));
		}
	});
}

export function lastLine(text) {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.length ? lines[lines.length - 1] : "";
}
