import { spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

export function spawnOwned(command, args = [], options = {}) {
	return spawn(command, args, {
		stdio: "inherit",
		...options,
		detached: !IS_WINDOWS,
	});
}

export function waitForExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => {
		const finish = (result) => {
			child.off("exit", onExit);
			child.off("error", onError);
			resolve(result);
		};
		const onExit = (code, signal) => finish({ code, signal });
		const onError = () => finish({ code: 1, signal: null });
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function bridgeError(name, port, detail, code) {
	const error = new Error(`${name} on 127.0.0.1:${port} ${detail}`);
	error.code = code;
	return error;
}

export function waitForBridgeReady(child, { name, port, readyType, listenErrorType }, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", onError);
			callback(value);
		};
		const fail = (detail, code) => finish(reject, bridgeError(name, port, detail, code));
		const onMessage = (message) => {
			if (!message || message.port !== port) return;
			if (message.type === readyType) finish(resolve);
			if (message.type === listenErrorType) {
				fail(`could not listen: ${message.code ?? "unknown error"}`, message.code);
			}
		};
		const onExit = (code, signal) => fail(`exited ${signal ? `from ${signal}` : `with code ${code ?? 0}`}`);
		const onError = (error) => fail(`could not start: ${error.message}`);
		const timeout = setTimeout(() => fail(`did not report readiness within ${timeoutMs} ms`), timeoutMs);
		child.on("message", onMessage);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

export async function startBridge({
	command,
	args,
	cwd,
	env,
	mainPort,
	portEnv = "COZYCLAY_BRIDGE_PORT",
	name = "motion bridge",
	readyType = "cozyclay-bridge-ready",
	listenErrorType = "cozyclay-bridge-listen-error",
	onSpawn,
	onFailure,
	onReady,
}) {
	const explicitPort = env[portEnv];
	if (explicitPort !== undefined) {
		const port = Number(explicitPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`${portEnv}=${JSON.stringify(explicitPort)} is not a valid port`);
		}
		return startBridgeAt(port, true);
	}
	for (let port = mainPort + 1; port <= 65535; port += 1) {
		try {
			return await startBridgeAt(port, false);
		} catch (error) {
			if (error?.code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error(`no free bridge port is available at or above ${mainPort + 1}`);

	async function startBridgeAt(port, isExplicit) {
		const child = spawnOwned(command, args, {
			cwd,
			env: { ...env, [portEnv]: String(port) },
			stdio: ["inherit", "inherit", "inherit", "ipc"],
		});
		onSpawn?.(child);
		try {
			await waitForBridgeReady(child, { name, port, readyType, listenErrorType });
			onReady?.(child);
			return { child, port };
		} catch (error) {
			onFailure?.(child);
			await terminateOwned(child);
			if (isExplicit && error?.code === "EADDRINUSE") {
				throw new Error(`${portEnv}=${port} is already in use; choose another ${portEnv}`);
			}
			throw error;
		}
	}
}

function signalOwned(child, signal) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (IS_WINDOWS) child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code === "ESRCH") return;
		if (!IS_WINDOWS && error?.code === "EPERM") {
			try {
				child.kill(signal);
				return;
			} catch (fallbackError) {
				if (fallbackError?.code === "ESRCH") return;
				throw fallbackError;
			}
		}
		throw error;
	}
}

export async function terminateOwned(child, graceMs = 1500) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = waitForExit(child);
	signalOwned(child, "SIGTERM");
	const graceful = await Promise.race([
		exited.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
	]);
	if (!graceful) {
		signalOwned(child, "SIGKILL");
		await exited;
	}
}

export function installSignalCleanup(getChildren, cleanup) {
	let stopping = false;
	const handlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = async () => {
			if (stopping) return;
			stopping = true;
			await Promise.allSettled(getChildren().map((child) => terminateOwned(child)));
			await cleanup?.();
			process.exitCode = signal === "SIGINT" ? 130 : 143;
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}
