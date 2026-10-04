/**
 * Headless Chrome + Vite plumbing for the ground-truth renderer (#428).
 * Same launch/seed pattern as tools/qa-browser.mjs, but owned by one CLI run:
 * every child it starts is terminated on exit or signal.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOwned, terminateOwned } from "../process-supervisor.mjs";

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);

/** Poll `probe` until it resolves truthy; bounded, fails loudly. */
export async function waitFor(label, probe, { timeoutMs = 60000, intervalMs = 100, child = null } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`${label}: process exited early`);
		try {
			const value = await probe();
			if (value) return value;
		} catch {
			// not ready yet; retried until the deadline
		}
		if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

async function portAnswers(url) {
	try {
		await fetch(url);
		return true;
	} catch {
		return false;
	}
}

/** Start Vite on `port` in `root` unless `url` is given. */
export async function startVite({ root, port, children }) {
	const url = `http://127.0.0.1:${port}`;
	if (await portAnswers(url)) throw new Error(`port ${port} is already in use; stop it or pass --url to reuse a running server`);
	const vite = spawnOwned(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: root,
		// Point the Studio's live-control socket at an unused port so it can
		// never attach to another session's hub (the default is 5184).
		env: { ...process.env, COZYCLAY_LIVE_PORT: process.env.COZYCLAY_LIVE_PORT || "5728" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	children.push(vite);
	await waitFor("vite startup", async () => (await fetch(`${url}/app/`)).ok, { child: vite });
	return url;
}

export async function startChrome({ port, children, cleanups }) {
	const chromePath = CHROME_CANDIDATES.find(existsSync);
	if (!chromePath) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");
	const versionUrl = `http://127.0.0.1:${port}/json/version`;
	if (await portAnswers(versionUrl)) throw new Error(`CDP port ${port} is already in use`);
	const profileDir = mkdtempSync(join(tmpdir(), "cozyclay-gt-render-"));
	cleanups.push(() => rmSync(profileDir, { recursive: true, force: true }));
	const chrome = spawnOwned(chromePath, [
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		"--window-size=1600,1000",
		"--no-first-run",
		"--no-default-browser-check",
		"about:blank",
	], { stdio: ["ignore", "ignore", "ignore"] });
	children.push(chrome);
	await waitFor("chrome CDP startup", async () => (await fetch(versionUrl)).ok, { child: chrome, timeoutMs: 30000 });
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("headless Chrome exposed no page target");
	return connect(page.webSocketDebuggerUrl);
}

/** Minimal CDP client over Node's global WebSocket. */
export async function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`CDP connect failed: ${wsUrl}`));
	});
	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
			else resolve(message.result);
			return;
		}
		for (const listener of listeners) listener(message);
	};
	ws.onclose = () => {
		for (const { reject } of pending.values()) reject(new Error("CDP connection closed"));
		pending.clear();
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "page evaluation failed");
		}
		return result.result?.value;
	};
	/** Resolve on the next event `method`; subscribe BEFORE triggering it. */
	const once = (method, timeoutMs = 60000) => {
		let listener;
		let timer;
		const promise = new Promise((resolve, reject) => {
			listener = (message) => {
				if (message.method === method) resolve(message.params);
			};
			listeners.add(listener);
			timer = setTimeout(() => reject(new Error(`${method}: no event within ${timeoutMs} ms`)), timeoutMs);
		});
		return promise.finally(() => {
			listeners.delete(listener);
			clearTimeout(timer);
		});
	};
	return { send, evaluate, once, close: () => ws.close() };
}

/**
 * Open the Studio on `studioUrl` with a clean origin: storage wiped (so a
 * previous motion's autosaved session cannot come back and mask ?motion=),
 * then the project session seeded so the first-run chooser does not open.
 */
export async function openStudioClean(cdp, studioUrl) {
	const origin = new URL(studioUrl).origin;
	await cdp.send("Page.enable");
	await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
	let loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url: `${origin}/favicon.ico` });
	await loaded;
	await cdp.evaluate("localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'gt-render', updatedAt: Date.now() }))");
	loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url: studioUrl });
	await loaded;
}

export async function terminateAll(children) {
	await Promise.allSettled(children.splice(0).reverse().map((child) => terminateOwned(child)));
}
