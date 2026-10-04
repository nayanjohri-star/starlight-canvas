#!/usr/bin/env node
/**
 * Real-surface IK camera-drag frame-time probe. The browser is supplied by
 * tools/qa-browser.mjs; this script only drives the page over CDP.
 */
import { writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9284);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5284/app/";
const perfDpr = Number(process.env.PERF_DPR || 1);
if (!(perfDpr > 0)) throw new Error(`PERF_DPR must be positive, got ${process.env.PERF_DPR}`);
const perfWidth = 1920;
const perfHeight = 1200;
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error(`no page target on CDP port ${port}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const request = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${expression}`);
};

await send("Runtime.enable");
await send("Page.enable");
// Match the reporter's high-resolution surface before the page creates its
// renderer; setting this after navigation leaves canvas allocation at DPR 1.
await send("Emulation.setDeviceMetricsOverride", {
	width: perfWidth,
	height: perfHeight,
	deviceScaleFactor: perfDpr,
	mobile: false,
});
await send("Profiler.enable");
await send("Page.navigate", { url: `${baseUrl}?motion=/demo/walk-then-stop.npz` });
await waitFor("!!window.__cozyclay?.rigA && !!window.__cozyclay?.motion");
await evaluate(`(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK off"); if (!button) throw new Error("IK toggle missing"); button.click(); return true; })()`);
await waitFor("window.__cozyclay?.ikMode === true && !!window.__ikVisibilityPerformance");
await sleep(500);
const renderer = await evaluate(`(() => {
	const canvas = document.querySelector("canvas");
	const context = canvas?.getContext("webgl2") || canvas?.getContext("webgl");
	const debug = context?.getExtension("WEBGL_debug_renderer_info");
	return {
		userAgent: navigator.userAgent,
		requestedDevicePixelRatio: ${perfDpr},
		effectiveDevicePixelRatio: devicePixelRatio,
		viewportWidth: innerWidth,
		viewportHeight: innerHeight,
		canvasWidth: canvas?.width,
		canvasHeight: canvas?.height,
		webgl: context?.constructor?.name || null,
		renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable",
		vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "unavailable",
	};
})()`);
const stage = await evaluate(`(() => { const rect = document.querySelector(".stage")?.getBoundingClientRect(); if (!rect) throw new Error("stage missing"); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }; })()`);
const mouse = (type, x, y, button = "right", buttons = button === "right" ? 2 : 0) => send("Input.dispatchMouseEvent", {
	type, x: Math.round(x), y: Math.round(y), button, buttons, clickCount: 1,
});
const profileStartedAt = new Date().toISOString();
await send("Profiler.start");
const sample = evaluate(`new Promise((resolve) => {
	const frames = [];
	let previous = performance.now();
	const started = previous;
	const tick = (now) => {
		frames.push(now - previous);
		previous = now;
		if (now - started >= 2100) resolve(frames.slice(1));
		else requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})`);
await mouse("mousePressed", stage.x, stage.y);
for (let index = 1; index <= 120; index += 1) {
	const angle = (index / 120) * Math.PI * 2;
	await mouse("mouseMoved", stage.x + Math.cos(angle) * stage.width * 0.12, stage.y + Math.sin(angle) * stage.height * 0.08);
	await sleep(2000 / 120);
}
await mouse("mouseReleased", stage.x + stage.width * 0.12, stage.y, "right", 0);
const frameTimes = await sample;
const profileResult = await send("Profiler.stop");
const sorted = [...frameTimes].sort((a, b) => a - b);
const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null;
const duration = frameTimes.reduce((sum, value) => sum + value, 0);
const samples = profileResult.profile?.samples ?? [];
const deltas = profileResult.profile?.timeDeltas ?? [];
const nodes = new Map((profileResult.profile?.nodes ?? []).map((node) => [node.id, node]));
const selfTime = new Map();
for (let index = 0; index < samples.length; index += 1) selfTime.set(samples[index], (selfTime.get(samples[index]) || 0) + (deltas[index] || 0));
const topSelfTime = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, microseconds]) => {
	const node = nodes.get(id);
	return { function: node?.callFrame?.functionName || "(anonymous)", url: node?.callFrame?.url || "", microseconds };
});
const result = {
	capturedAt: profileStartedAt,
	baseUrl,
	renderer,
	ikVisibility: await evaluate("window.__ikVisibilityPerformance()"),
	run: {
		frameCount: frameTimes.length,
		medianFrameMs: percentile(sorted, 0.5),
		p95FrameMs: percentile(sorted, 0.95),
		fps: duration > 0 ? frameTimes.length / (duration / 1000) : 0,
		minFrameMs: sorted[0] ?? null,
		maxFrameMs: sorted.at(-1) ?? null,
	},
	topSelfTime,
};
const outputPath = process.env.PERF_OUTPUT;
if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
ws.close();
