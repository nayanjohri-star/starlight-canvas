#!/usr/bin/env node
// Run serially on a dedicated local QA Chrome tab with a one-shot synthetic
// project. Requires M's __cozyclayProject.run seam, CDP, ffmpeg and ffprobe.
// QA_URL=http://127.0.0.1:5180/director/ CDP_PORT=9522 QA_OUT=<absolute-dir>
// Formal evidence also requires QA_BUILD_JSON_URL=<same-origin clean build.json>
// (defaults to /canvas/build.json) and optional CANVAS_DIRECTOR_CANDIDATE_SHA.
// node test/verify-starlight-export-browser.mjs
// It edits the QA clock and writes real media; it does not start Chrome,
// servers, a model service, or another encoder. No fake codec is installed.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { inflateSync } from 'node:zlib';
import { COMPOSITION_LIMITS, assertAddressedFrameState, compareAddressedFrames, isModelRequestPath, assertHostedMediaTarget } from './fixtures/starlight-media-comparison.mjs';
import { installCaptureObserver } from './fixtures/starlight-capture-observer.mjs';
import { synchronizeMediaClock, activateActualForeground } from './fixtures/starlight-media-controls.mjs';
import { pngDimensions } from '../../canvas/tests/fixtures/director-native-screenshot.mjs';

const url = new URL(process.env.QA_URL || 'http://127.0.0.1:5180/director/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated local QA tab');
const out = resolve(process.env.QA_OUT || 'artifacts/starlight-export');
const ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe', run = promisify(execFile);
const targets = await (await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9522)}/json`)).json();
const page = targets.find(target => target.type === 'page' && target.url.startsWith(url.origin + url.pathname));
assert.ok(page?.webSocketDebuggerUrl, `Open the dedicated QA page ${url} first`);
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0, contextId; const pending = new Map(), errors = [], checks = [], contexts = new Map(), external = [], modelRequests = [];
let shotId;
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === 'Runtime.executionContextCreated') {
		const context = message.params.context;
		if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
	}
	if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === 'Network.requestWillBeSent') {
		const requested=new URL(message.params.request.url);
		if (['http:','https:'].includes(requested.protocol) && requested.origin!==url.origin) external.push(requested.origin+requested.pathname);
		if (isModelRequestPath(requested.pathname)) modelRequests.push({ method: message.params.request.method, path: requested.pathname });
	}
	if (message.method === 'Runtime.consoleAPICalled') {
		const first = message.params.args?.[0]?.value;
		if (typeof first === 'string' && first.startsWith('MEDIA_PROGRESS ')) console.log(first);
	}
	const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer);
	message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
};
function send(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 240_000); pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params })); }); }
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, ...(contextId ? { contextId } : {}), awaitPromise: true, returnByValue: true, timeout: 230_000 }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function waitFor(expression) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`QA not ready: ${expression}`); }
async function clock(fps, seconds) {
	console.log(`MEDIA_CLOCK ${fps}fps ${seconds}s begin`);
	const count = await synchronizeMediaClock({ fps, seconds, shotId,
		read: () => evaluate(`(async()=>{const p=JSON.parse(await window.__cozyclayProject.export('Media QA'));const s=p.scenes.scenes.find(s=>s.id===p.scenes.activeSceneId);const a=s.shotDocument??s.shotAuthoring;const shot=a.shots.find(s=>s.id===${JSON.stringify(shotId)});if(!shot)throw Error('QA shot disappeared');const m=window.__cozyclay.captureMeta(shot.startFrame);return {authorFps:a.fps,authorFrameCount:a.frameCount,shotStart:shot.startFrame,shotEnd:shot.endFrame,liveFps:m.fps,liveFrameCount:window.__cozyclay.frameCount,liveRangeStart:m.frameRange.start,liveRangeEnd:m.frameRange.end};})()`),
		run: (command, args) => evaluate(`window.__cozyclayProject.run(${JSON.stringify(command)},${JSON.stringify(args)})`),
		onCommand: (command, args) => console.log(`MEDIA_CLOCK ${command} ${JSON.stringify(args)}`),
	});
	console.log(`MEDIA_CLOCK ready ${count}`);
	return count;
}
async function foreground() {
	const proof = await activateActualForeground({ send, targetId: page.id, readVisibility: () => evaluate('document.visibilityState') });
	console.log(`MEDIA_FOREGROUND ${JSON.stringify(proof)}`); return proof;
}
function canonical(value) { return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
async function authoredProject() {
	const document = JSON.parse(await evaluate('window.__cozyclayProject.export("Media QA")'));
	delete document.savedAt; // Serialization time is not an authored scene/resource version.
	return { document, sha256: createHash('sha256').update(canonical(document)).digest('hex') };
}
async function byteChunks(expression, length) {
	const parts = [];
	for (let at = 0; at < length; at += 196608) {
		const text = await evaluate(`(()=>{const bytes=${expression}.subarray(${at},${at + 196608});let text='';for(let at=0;at<bytes.length;at+=32768)text+=String.fromCharCode(...bytes.subarray(at,at+32768));return btoa(text)})()`);
		parts.push(Buffer.from(text, 'base64'));
	}
	return Buffer.concat(parts);
}
async function video(count, slow = false, { label, retainPixels = false, pack = false, expectedVisibility = 'visible' } = {}) {
	assert.ok(label, 'Unique evidence label is required');
	assert.ok(['visible', 'hidden'].includes(expectedVisibility));
	if (expectedVisibility === 'visible') await foreground();
	assert.equal(await evaluate('document.visibilityState'), expectedVisibility, `Actual ${label} starting visibility`);
	const before = await authoredProject(), meta = await evaluate('window.__cozyclay.captureMeta()');
	const observations = join(out, 'frames', label); await mkdir(observations, { recursive: true });
	console.log(`MEDIA_VIDEO ${count} slow=${slow} begin`);
	const result = await evaluate(`(async()=>{
		const create=URL.createObjectURL, NativeEncoder=VideoEncoder, NativeBlob=Blob, NativeFrame=VideoFrame; let encoded;
		let scene=window.__cozyclay.rigA;while(scene.parent)scene=scene.parent;if(!scene.isScene)throw Error('No actual capture Scene');
		const observer=window.__mediaQaObserverFactory({scene,renderer:window.__mediaQaRenderer,width:${meta.size.width},height:${meta.size.height},fps:${meta.fps},frameCount:${count},authoredSha256:${JSON.stringify(before.sha256)},retainPixels:${retainPixels},kind:${JSON.stringify(pack ? 'pack' : 'video')},expectedVisibility:${JSON.stringify(expectedVisibility)}});
		window.VideoFrame=class extends NativeFrame { constructor(data,options){observer.frame(data,options);super(data,options)} };
		window.Blob=class extends NativeBlob { constructor(parts,options){super(parts,options);if(this.type==='video/mp4')encoded=this} };
		const stats={inputs:0,outputs:0,flushes:0,pendingFlush:0};
		window.VideoEncoder=class extends NativeEncoder {
			constructor(init){super({output:(chunk,meta)=>{stats.outputs++;init.output(chunk,meta)},error:err=>{stats.error=err.message;init.error(err)}})}
			encode(frame,options){stats.inputs++;return super.encode(frame,options)}
			async flush(){stats.flushes++;stats.pendingFlush++;try{const result=await super.flush();if(${slow})await new Promise(resolve=>setTimeout(resolve,20));return result}finally{stats.pendingFlush--}}
		};
		const progress=setInterval(()=>console.log('MEDIA_PROGRESS '+JSON.stringify({...stats,frames:${count},visibility:document.visibilityState,phase:document.querySelector('.export-trigger-state')?.dataset.phase})),10000);
		URL.createObjectURL=function(blob){ if(blob.type==='video/mp4')encoded=blob; return create.call(this,blob); };
		try {
			// Container metadata is checked by full FFmpeg decoding outside the
			// browser; hidden HTMLVideoElement loading can be deferred by Chrome.
			const result=${pack ? `await window.__cozyclay.exportKeyframePack()` : `await window.__exportOffscreen({startFrame:0,endFrame:${count - 1}})`};
			if(!encoded)throw new Error('Production exporter returned no MP4 Blob');
			window.__mediaQaBlob=encoded;
			window.__mediaQaObservation=await observer.finish();
			${pack ? 'window.__mediaQaPack=result; const {bytes,...packMeta}=result;' : ''}
			return {...${pack ? 'packMeta' : 'result'},byteLength:encoded.size,visibility:document.visibilityState,observed:{frameCount:window.__mediaQaObservation.frameCount,captures:window.__mediaQaObservation.captures,endpoints:window.__mediaQaObservation.endpoints}};
		} finally { clearInterval(progress);observer.dispose();URL.createObjectURL=create;window.VideoEncoder=NativeEncoder;window.Blob=NativeBlob;window.VideoFrame=NativeFrame; }
	})()`);
	try {
		assert.equal(result.observed.frameCount, count); assert.equal(result.observed.captures, count + (pack ? 2 : 0));
		assert.equal(result.visibility, expectedVisibility, `Actual ${label} completed visibility`);
		for (let index = 0; index < count; index++) {
			const frame = await evaluate(`(()=>{const {compressedRgba,...meta}=window.__mediaQaObservation.frames[${index}];return {...meta,compressedByteLength:compressedRgba?.byteLength??0}})()`);
			assertAddressedFrameState(frame, frame);
			assert.equal(frame.renderState.actualFramebuffer.observedIn, 'webgl2', 'Formal evidence reads the actual GPU framebuffer');
			assert.equal(frame.visibility, expectedVisibility, `Actual ${label} visibility changed at native frame ${index}`);
			await writeFile(join(observations, `${index}.json`), JSON.stringify(frame));
			if (retainPixels) {
				assert.ok(frame.compressedByteLength > 0, `Missing actual RGBA at frame ${index}`);
				await writeFile(join(observations, `${index}.rgba.deflate`), await byteChunks(`window.__mediaQaObservation.frames[${index}].compressedRgba`, frame.compressedByteLength));
			}
		}
		await writeFile(join(observations, 'observation.json'), JSON.stringify(result.observed, null, 2));
		const after = await authoredProject(); assert.equal(after.sha256, before.sha256, 'Export changed the complete authored scene/motion/asset version');
		const parts=[];
		for(let at=0;at<result.byteLength;at+=196608) {
			const text=await evaluate(`(async()=>{const bytes=new Uint8Array(await window.__mediaQaBlob.slice(${at},${at+196608}).arrayBuffer());let text='';for(let at=0;at<bytes.length;at+=32768)text+=String.fromCharCode(...bytes.subarray(at,at+32768));return btoa(text)})()`);
			parts.push(Buffer.from(text,'base64'));
		}
		let packBytes;
		if (pack) {
			const length = await evaluate('window.__mediaQaPack.bytes.length'), parts = [];
			for (let at = 0; at < length; at += 262144) parts.push(await evaluate(`window.__mediaQaPack.bytes.slice(${at},${at + 262144})`));
			packBytes = parts.join('');
		}
		return {...result,observations,authoredSha256:before.sha256,bytes:Buffer.concat(parts).toString('base64'),...(pack ? {packBytes,fps:meta.fps,frameCount:count,width:meta.size.width,height:meta.size.height} : {})};
	} finally { await evaluate('delete window.__mediaQaBlob;delete window.__mediaQaObservation;delete window.__mediaQaPack'); }
}

async function observedFrame(attempt, index) {
	const meta = JSON.parse(await readFile(join(attempt.observations, `${index}.json`), 'utf8'));
	const rgba = inflateSync(await readFile(join(attempt.observations, `${index}.rgba.deflate`)));
	return { ...meta, rgba };
}
async function compareAttempts(expected, actual, label) {
	assert.equal(actual.frameCount, expected.frameCount); assert.equal(actual.authoredSha256, expected.authoredSha256);
	const comparisons = [], legacyShaMismatches = []; let legacyShaComparedFrames = 0;
	for (let index = 0; index < expected.frameCount; index++) {
		const a = await observedFrame(expected, index), b = await observedFrame(actual, index);
		const row = compareAddressedFrames(a, b); comparisons.push({ frameIndex: index, ...row });
		// Preserve byte hashes as diagnostics. A mismatch is never relabelled as
		// a successful old zero-tolerance assertion.
		if (typeof expected.hashes?.[index] === 'string' && typeof actual.hashes?.[index] === 'string') {
			legacyShaComparedFrames++; if (expected.hashes[index] !== actual.hashes[index]) legacyShaMismatches.push(index);
		}
	}
	const proof = { label, frameCount: expected.frameCount, exactAddressedState: true, compositionPolicy: COMPOSITION_LIMITS, legacyShaComparedFrames, legacyShaStatus: legacyShaComparedFrames === expected.frameCount ? 'compared' : 'unavailable-or-incomplete', legacyShaMismatches, comparisons };
	await writeFile(join(out, `${label}-composition.json`), JSON.stringify(proof, null, 2));
	return proof;
}
async function mediaCheck(path, fps, count, width, height) {
	await run(ffmpeg, ['-v', 'error', '-i', path, '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 });
	const { stdout } = await run(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_packets', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration:packet=pts_time,duration_time', '-of', 'json', path], { maxBuffer: 8 * 1024 * 1024 });
	const probe = JSON.parse(stdout), track = probe.streams.find(track => track.codec_name === 'h264');
	assert.ok(track, 'Real output must decode as H.264'); assert.equal(+track.nb_read_frames, count); assert.equal(track.width, width); assert.equal(track.height, height);
	assert.ok(Math.abs(+probe.format.duration - count / fps) < .001, 'Container duration follows integer frames');
	const packets = probe.packets.sort((a, b) => +a.pts_time - +b.pts_time); assert.equal(packets.length, count);
	for (let index = 0; index < count; index++) assert.ok(Math.abs(+packets[index].pts_time - index / fps) < .0001, `Incorrect timestamp at frame ${index}`);
	return { frames: +track.nb_read_frames, codec: track.codec_name, duration: +probe.format.duration, width, height };
}
const pngRgba = async path => (await run(ffmpeg, ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
const decodedFrame = async (path, frame) => (await run(ffmpeg, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
function bottomUpHash(rgba, width, height) { assert.equal(rgba.length, width * height * 4); const rows = Buffer.alloc(rgba.length), stride = width * 4; for (let row = 0; row < height; row++) rgba.copy(rows, row * stride, (height - 1 - row) * stride, (height - row) * stride); return createHash('sha256').update(rows).digest('hex'); }
function psnr(a, b) { assert.equal(a.length, b.length); let square = 0; for (let index = 0; index < a.length; index++) if (index % 4 !== 3) square += (a[index] - b[index]) ** 2; return square === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (square / (a.length / 4 * 3))); }
// Full streaming decode avoids a giant CDP return or whole-video RGBA buffer.
// The original decoded endpoint quality floor is now also checked at every
// frame of each normal/slow/hidden/pack comparison sample, after exact source
// state and bounded pre-encode pixels have been checked separately.
async function decodedComposition(path, attempt) {
	const child = spawn(ffmpeg, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '', index = 0, used = 0, minimumPsnr = Infinity;
	const frame = Buffer.alloc(attempt.width * attempt.height * 4);
	child.stderr.on('data', chunk => { stderr += chunk.toString(); });
	const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg decode failed ${code}: ${stderr}`))); });
	// Attach rejection immediately, while the async stdout iterator is running.
	exited.catch(() => {});
	try {
		for await (const chunk of child.stdout) {
			for (let at = 0; at < chunk.length;) {
				const bytes = Math.min(frame.length - used, chunk.length - at); chunk.copy(frame, used, at, at + bytes); used += bytes; at += bytes;
				if (used === frame.length) {
					assert.ok(index < attempt.frameCount, 'Decoded video contains an extra frame');
					const source = await observedFrame(attempt, index), quality = psnr(source.rgba, frame);
					assert.ok(quality >= 28, `Decoded frame ${index} diverged from its exact addressed source: ${quality} dB`);
					minimumPsnr = Math.min(minimumPsnr, quality); index++; used = 0;
				}
			}
		}
		await exited; assert.equal(used, 0, 'Decoded RGBA tail is incomplete'); assert.equal(index, attempt.frameCount);
		return { decodedFrames: index, minimumPsnr };
	} finally { if (child.exitCode === null) child.kill(); }
}
let background;
try {
	await mkdir(out, { recursive: true }); await send('Runtime.enable');await send('Network.enable');
	await foreground();
	const tree = (await send('Page.getFrameTree')).frameTree;
	const locate = row => /\/director\/index\.html(?:\?|$)/.test(row.frame.url) ? row.frame : (row.childFrames ?? []).map(locate).find(Boolean);
	const directorFrame = locate(tree);
	assert.ok(directorFrame && directorFrame.id !== tree.frame.id, 'Formal evidence uses the actual hosted director iframe');
	if (directorFrame && directorFrame.id !== tree.frame.id) {
		contextId = contexts.get(directorFrame.id);
		assert.ok(contextId, 'Actual hosted director default execution context is available');
	}
	await waitFor(`!!window.__cozyclay?.rigA && typeof window.__cozyclayProject?.run==='function' && typeof window.__exportOffscreen==='function'`);
	assert.equal(await evaluate(`typeof VideoEncoder`), 'function');
	assert.equal(await evaluate('window.__cozyclay.playing'), false, 'Dedicated authored scene must be paused');
	await evaluate('window.__mediaQaObserverFactory=' + installCaptureObserver.toString());
	await evaluate(`(()=>{let scene=window.__cozyclay.rigA;while(scene.parent)scene=scene.parent;if(!scene.isScene)throw Error('No real Scene');const before=scene.onBeforeRender;scene.onBeforeRender=function(renderer,...args){window.__mediaQaRenderer=renderer;return before?.call(this,renderer,...args)};try{window.__cozyclay.capturePlate()}finally{scene.onBeforeRender=before}if(!window.__mediaQaRenderer)throw Error('No actual capture renderer')})()`);
	const buildUrl = new URL(process.env.QA_BUILD_JSON_URL || '/canvas/build.json', url);
	assert.equal(buildUrl.origin, url.origin, 'Build identity must come from the tested host');
	const artifact = await (await fetch(buildUrl)).json(); assert.equal(artifact.sourceDirty, false, 'Formal media evidence requires a clean artifact');
	assert.match(artifact.sourceCommit, /^[a-f0-9]{40}$/); assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
	if (process.env.CANVAS_DIRECTOR_CANDIDATE_SHA) assert.equal(artifact.sourceCommit, process.env.CANVAS_DIRECTOR_CANDIDATE_SHA);
	const actualRealm = await evaluate('({realmUrl:location.href,baseURI:document.baseURI})');
	const targetIdentity = assertHostedMediaTarget({ artifact, hostUrl: url.href, parentUrl: tree.frame.url, frameUrl: directorFrame.url, ...actualRealm });
	const harness = { gitCommit: process.env.QA_TEST_SHA ?? null, files: {} };
	for (const file of ['./verify-starlight-export-browser.mjs', './fixtures/starlight-capture-observer.mjs', './fixtures/starlight-media-comparison.mjs', './fixtures/starlight-media-controls.mjs', '../../canvas/tests/fixtures/director-native-screenshot.mjs']) {
		harness.files[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
	}
	const document = JSON.parse(await evaluate('window.__cozyclayProject.export("Media QA")'));
	const active = document.scenes.scenes.find(scene => scene.id === document.scenes.activeSceneId), authoring = active.shotAuthoring ?? active.shotDocument;
	assert.equal(authoring.shots.length, 1, 'Load a dedicated one-shot synthetic QA project'); shotId = authoring.shots[0].id;
	for (const fps of [24, 30]) for (const seconds of [1, 6.25, 15, 30]) {
		const count = await clock(fps, seconds), before = await evaluate('window.__cozyclay.tlFrame');
		const result = await video(count, false, { label: `${fps}fps-${seconds}s-normal`, retainPixels: seconds === 6.25 }), path = join(out, `${fps}fps-${seconds}s.mp4`);
		assert.equal(result.fps, fps); assert.equal(result.frameCount, count); assert.equal(result.encodedFrameCount, count); assert.equal(result.hashes.length, count);
		assert.equal(await evaluate('window.__cozyclay.tlFrame'), before, 'Offline export preserves the playhead');
		await writeFile(path, Buffer.from(result.bytes, 'base64')); const proof = await mediaCheck(path, fps, count, result.width, result.height);
		checks.push({ kind: 'video', fps, requestedSeconds: seconds, ...proof }); console.log(`PASS real H264 ${fps}fps ${seconds}s -> ${count} frames / ${proof.duration}s`);
		if (seconds === 6.25) {
			const repeat = await video(count, true, { label: `${fps}fps-${seconds}s-slow`, retainPixels: true });
			const comparison = await compareAttempts(result, repeat, `${fps}fps-slow`);
			const slowPath = join(out, `${fps}fps-${seconds}s-slow.mp4`); await writeFile(slowPath, Buffer.from(repeat.bytes, 'base64'));
			const repeatMedia = await mediaCheck(slowPath, fps, count, repeat.width, repeat.height);
			checks.push({ kind: 'slow-repeat', fps, frames: count, ...repeatMedia, legacyShaMismatches: comparison.legacyShaMismatches,
				decoded: await decodedComposition(slowPath, repeat), normalDecoded: await decodedComposition(path, result) });
		}
	}
	for (const fps of [24, 30]) {
		const count = await clock(fps, 6.25), before = await evaluate('window.__cozyclay.tlFrame');
		const normal = await video(count, false, { label: `${fps}fps-background-baseline`, retainPixels: true });
		background = (await send('Target.createTarget', { url: 'about:blank', background: false })).targetId;
		await send('Target.activateTarget', { targetId: background }); await waitFor(`document.visibilityState==='hidden'`);
		const hidden = await video(count, true, { label: `${fps}fps-hidden`, retainPixels: true, expectedVisibility: 'hidden' }); assert.equal(hidden.visibility, 'hidden');
		assert.equal(await evaluate('window.__cozyclay.tlFrame'), before, 'Background export preserves the playhead');
		const comparison = await compareAttempts(normal, hidden, `${fps}fps-background`);
		const hiddenPath=join(out,`background-${fps}fps-6.25s.mp4`);await writeFile(hiddenPath,Buffer.from(hidden.bytes,'base64'));
		checks.push({ kind: 'background', fps, visibility: hidden.visibility, legacyShaMismatches: comparison.legacyShaMismatches,
			...await mediaCheck(hiddenPath,fps,count,hidden.width,hidden.height), decoded: await decodedComposition(hiddenPath, hidden) });
		await send('Target.closeTarget', { targetId: background }); background = null;
		await foreground();
		const pack = await video(count, false, { label: `${fps}fps-pack`, retainPixels: true, pack: true });
		await compareAttempts(normal, pack, `${fps}fps-pack`);
		const files=unzipSync(Buffer.from(pack.packBytes, 'base64'));
		await writeFile(join(out, `${fps}fps-6.25s-pack.zip`), Buffer.from(pack.packBytes, 'base64'));
		const find = suffix => { const entry = Object.entries(files).find(([name]) => name.endsWith(suffix)); assert.ok(entry, `Pack is missing ${suffix}`); return entry[1]; };
		const meta = JSON.parse(new TextDecoder().decode(find('/camera.json'))); assert.equal(meta.fps, fps); assert.equal(meta.frameCount, count); assert.equal(meta.durationSeconds, count / fps);
		const clipPath = join(out, `${fps}fps-pack-clip.mp4`); await writeFile(clipPath, find('/clip.mp4')); await mediaCheck(clipPath, fps, count, normal.width, normal.height);
		checks.push({ kind: 'pack', fps, decoded: await decodedComposition(clipPath, pack) });
		for (const [label, frame] of [['first', 0], ['last', count - 1]]) {
			const pngPath = join(out, `${fps}fps-${label}.png`), png = Buffer.from(find(`/${label}.png`)); await writeFile(pngPath, png);
			const size = pngDimensions(png); assert.equal(size.width, normal.width); assert.equal(size.height, normal.height);
			const expected = await observedFrame(normal, frame), endpoint = pack.observed.endpoints.find(row => row.frameIndex === frame);
			assert.ok(endpoint, 'Actual PNG endpoint capture state is present');
			const rgba = await pngRgba(pngPath);
			const pixelProof = compareAddressedFrames(expected, { ...expected, renderState: endpoint.renderState, rgba });
			const similarity = psnr(rgba, await decodedFrame(clipPath, frame)); assert.ok(similarity >= 28, `${label} decoded framing diverged: ${similarity} dB`);
			checks.push({ kind: 'endpoint', fps, frame, psnr: similarity, ...pixelProof, diagnosticPngSha256: bottomUpHash(rgba, normal.width, normal.height), diagnosticSourceSha256: normal.hashes[frame] });
		}
	}
	await clock(24, 6.25);
	const tooLong = await evaluate(`window.__exportOffscreen({startFrame:0,endFrame:720}).then(()=>({ok:true}),error=>({code:error.exportFailureCode,message:error.message}))`);
	assert.equal(tooLong.code, 'range_too_long'); assert.equal(errors.length, 0, errors.join('\n'));
	assert.deepEqual(external, [], 'exporting makes no external network request');
	assert.deepEqual(modelRequests, [], 'exporting makes no model request');
	const afterArtifact = await (await fetch(buildUrl)).json(); assert.deepEqual(afterArtifact, artifact, 'Frozen tested artifact changed');
	await writeFile(join(out, 'media-evidence.json'), JSON.stringify({ completed: true, realWebCodecs: true, fullFfmpegDecode: true, actualHalfFloatMsaa4: true, compositionPolicy: COMPOSITION_LIMITS, artifact, targetIdentity, harness, networkScope: 'page CDP; bootstrap context route and synthetic provider counts independently checked by driver', checks }, null, 2));
	console.log('PASS real H264 matrix, slow encoding, actual background tab, endpoint PNG parity, decodable pack and 30-second gate');
} finally { if (background) await send('Target.closeTarget', { targetId: background }).catch(() => {}); await evaluate('delete window.__mediaQaObserverFactory;delete window.__mediaQaRenderer').catch(() => {}); ws.close(); for (const item of pending.values()) clearTimeout(item.timer); }
