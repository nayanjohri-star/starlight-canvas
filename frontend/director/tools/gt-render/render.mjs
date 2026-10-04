#!/usr/bin/env node
/**
 * Ground-truth renderer (#428): cskel27 motion npz -> GVHMR-ready videos
 * rendered by the real CozyClay Studio from ONE fixed, known camera, with the
 * exact camera and joint ground truth written next to every video.
 *
 *   node tools/gt-render/render.mjs --out <dir> [options] <motion.npz ...>
 *
 * Per motion it starts (or reuses, --url) a Vite dev server of this checkout
 * and a headless Chrome, loads the take through `?motion=`, and:
 *   1. pre-pass: scrubs every timeline frame, CPU-skins every drawable vertex
 *      of the rig and reduces it (plus the joints) to five support values;
 *   2. solves the closest static camera at the requested azimuth/elevation and
 *      integer GVHMR f-mm that keeps every vertex of every frame inside the
 *      margin box (camera-math.mjs), identical for all variants;
 *   3. renders every timeline frame at 832x480 through the Studio's export
 *      capture (`window.__cozyclay.captureFraming`), encodes H.264 yuv420p
 *      24 fps, and writes camera.json, joints.json and meta.json.
 *
 * Variants: `shaded` (part colours, shaded palette, what GVHMR's palette
 * detector expects), `skin` (part colours off), `hue+N` / `hue-N` (the shaded
 * frames through ffmpeg's `hue=h=N` filter; it rotates the chroma plane of
 * EVERY pixel by the same N degrees, so all hues shift uniformly and neutral
 * greys stay put. It does not reshuffle parts: the palette's relative layout is
 * preserved).
 *
 * Output per motion:
 *   <out>/<motion>/plate.png           the same framing with the character hidden
 *   <out>/<motion>/mask/NNNNNN.png     exact per-frame silhouette (gray, 255 = character),
 *                                      the character re-drawn unlit in one colour
 *   <out>/<motion>/<variant>/{video.mp4,camera.json,joints.json,meta.json}
 *
 * Scoring renders (#431): `--camera <camera.json>` renders through that exact
 * camera instead of solving one; `--no-video` captures only the silhouette
 * masks and writes <out>/<motion>/{camera.json,joints.json,meta.json,mask/};
 * `--transform` places the take in the scene first (take-transform.mjs, the
 * Studio's sceneCalibration semantics); `--box` also writes contact.json, the
 * per-frame signed distance of the closest skinned vertex to a scene box.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installSignalCleanup } from "../process-supervisor.mjs";
import { openStudioClean, startChrome, startVite, terminateAll, waitFor } from "./browser.mjs";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { writeNpz } from "../ardy/npz.mjs";
import { boxContactValues, contactFromSigned, parseBox } from "../bench/metrics.mjs";
import { buildCamera, cameraFromRecord, marginSlopes, mergeSupports, projectPoint, supportArgs, supportValues, translateCamera } from "./camera-math.mjs";
import { installPageHelpers, MASK_RGB, RIG_JOINTS } from "./page.mjs";
import { boxCorners, parseSceneBox, sceneBoxRecord } from "./scene-box.mjs";
import { isIdentityTransform, parseTransform, takeToNpzMembers, transformTake } from "./take-transform.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const WIDTH = 832;
const HEIGHT = 480;
const FPS = 24;
const CACHE_DIR = join(ROOT, "node_modules/.cache/gt-render");

const USAGE = `usage: node tools/gt-render/render.mjs --out <dir> [options] <motion.npz ...>

  --out <dir>          output root; each motion goes to <dir>/<npz basename>/<variant>/
  --variants <list>    comma list of shaded, skin, hue+N, hue-N (default shaded)
  --f-mm <int>         GVHMR --f-mm the camera is built for (default 35)
  --azimuth <deg>      camera azimuth around the subject; 0 = on +Z looking -Z (default 0)
  --elevation <deg>    camera elevation; positive looks down (default 5)
  --margin <frac>      fraction of each image side kept clear of the body (default 0.08)
  --crf <int>          libx264 CRF (default 12)
  --keep-frames        keep the rendered PNG frames in <variant>/frames/
  --url <origin>       reuse a running Vite dev server of THIS checkout (default: start one)
  --port <n>           Vite port when starting one (default 5191)
  --cdp-port <n>       headless Chrome DevTools port (default 9231)
  --camera <file>      render through this camera.json (from an earlier render) instead of
                       solving one; --f-mm/--azimuth/--elevation/--margin are then unused
                       and a joint near or past the edge is reported, not fatal
  --no-video           masks + joints only: <dir>/<motion>/{camera.json,joints.json,meta.json,mask/}
  --transform <json>   place the take first, Studio sceneCalibration semantics:
                       '{"yawDeg":0,"offsetX":0,"offsetY":0,"offsetZ":0,"scale":1}'
                       (yaw about the frame-0 anchor, offsets in scene metres)
  --scene-box <json>   visible Studio cube: {x,z,rot,sx,sy,sz}; base at floor, sizes in metres
  --export-vertices   write vertices.f32 (frame/vertex/xyz, little-endian float32) + vertices.json
  --box <json>         '{"min":[x,y,z],"max":[x,y,z]}' scene box; writes <dir>/<motion>/contact.json
                       (closest skinned vertex per frame: distance / penetration)

writes <dir>/<motion>/{plate.png,mask/NNNNNN.png} and
<dir>/<motion>/<variant>/{video.mp4,camera.json,joints.json,meta.json}`;

function parseOptions(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			out: { type: "string" },
			variants: { type: "string", default: "shaded" },
			"f-mm": { type: "string", default: "35" },
			azimuth: { type: "string", default: "0" },
			elevation: { type: "string", default: "5" },
			margin: { type: "string", default: "0.08" },
			crf: { type: "string", default: "12" },
			"keep-frames": { type: "boolean", default: false },
			url: { type: "string" },
			port: { type: "string", default: "5191" },
			"cdp-port": { type: "string", default: "9231" },
			camera: { type: "string" },
			"no-video": { type: "boolean", default: false },
			transform: { type: "string" },
			box: { type: "string" },
			"scene-box": { type: "string" },
			"export-vertices": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const fail = (message) => {
		console.error(`${message}\n\n${USAGE}`);
		process.exit(2);
	};
	if (!values.out) fail("--out is required");
	if (!positionals.length) fail("at least one motion npz is required");
	const number = (name, integer = false) => {
		const value = Number(values[name]);
		if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) fail(`--${name} must be ${integer ? "an integer" : "a number"}, got ${values[name]}`);
		return value;
	};
	const variants = values.variants.split(",").map((entry) => entry.trim()).filter(Boolean).map((name) => {
		if (name === "shaded" || name === "skin") return { name, kind: name };
		const hue = /^hue([+-]\d+(?:\.\d+)?)$/.exec(name);
		if (hue) return { name, kind: "hue", degrees: Number(hue[1]) };
		return fail(`unknown variant ${name}`);
	});
	if (new Set(variants.map((variant) => variant.name)).size !== variants.length) fail("duplicate variant");
	const motions = positionals.map((file) => resolve(file));
	for (const file of motions) if (!existsSync(file)) fail(`no such motion: ${file}`);
	const names = motions.map((file) => basename(file, ".npz"));
	if (new Set(names).size !== names.length) fail(`two motions share an output name: ${names.join(", ")}`);
	let camera = null;
	if (values.camera) {
		const file = resolve(values.camera);
		if (!existsSync(file)) fail(`no such camera: ${file}`);
		try {
			camera = cameraFromRecord(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			fail(`--camera ${file}: ${error.message}`);
		}
		if (camera.width !== WIDTH || camera.height !== HEIGHT) fail(`--camera is ${camera.width}x${camera.height}; the renderer draws ${WIDTH}x${HEIGHT}`);
		camera.source = file;
	}
	let transform = null;
	if (values.transform) {
		try {
			transform = parseTransform(values.transform);
		} catch (error) {
			fail(`--transform: ${error.message}`);
		}
	}
	let box = null;
	if (values.box) {
		try {
			box = parseBox(values.box);
		} catch (error) {
			fail(`--box: ${error.message}`);
		}
	}
	return {
		camera,
		sceneBox: values["scene-box"] ? parseSceneBox(values["scene-box"]) : null,
		exportVertices: values["export-vertices"],
		noVideo: values["no-video"],
		transform,
		box,
		out: resolve(values.out),
		variants,
		fMm: number("f-mm", true),
		azimuthDeg: number("azimuth"),
		elevationDeg: number("elevation"),
		margin: number("margin"),
		crf: number("crf", true),
		keepFrames: values["keep-frames"],
		url: values.url?.replace(/\/$/, "") ?? null,
		port: number("port", true),
		cdpPort: number("cdp-port", true),
		motions,
	};
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const triples = (flat, digits = 6) => Array.from({ length: flat.length / 3 }, (_, i) => [round(flat[i * 3], digits), round(flat[i * 3 + 1], digits), round(flat[i * 3 + 2], digits)]);

function toolVersion() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	try {
		const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
		return `${pkg.version}+${commit}${dirty ? "-dirty" : ""}`;
	} catch {
		return pkg.version;
	}
}

function encode(framesDir, output, { crf, filter }) {
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-framerate", String(FPS), "-i", join(framesDir, "%06d.png"),
		...(filter ? ["-vf", filter] : []),
		"-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
		"-pix_fmt", "yuv420p", "-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-color_range", "tv",
		"-r", String(FPS), "-movflags", "+faststart", output,
	], { stdio: ["ignore", "inherit", "inherit"] });
}

/** Magenta-on-scene mask captures -> gray PNGs, 255 where the pixel is at
 * least half character (the MSAA edge blends linearly with the scene). */
function writeMasks(rawDir, maskDir) {
	rmSync(maskDir, { recursive: true, force: true });
	mkdirSync(maskDir, { recursive: true });
	const [r, g, b] = MASK_RGB;
	if (!(r === 255 && g === 0 && b === 255)) throw new Error("writeMasks expects the magenta mask colour");
	const test = "255*gt(r(X,Y)-g(X,Y),127)*gt(b(X,Y)-g(X,Y),127)";
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-framerate", String(FPS), "-i", join(rawDir, "%06d.png"),
		"-vf", `format=gbrp,geq=r='${test}':g='${test}':b='${test}',format=gray`,
		"-start_number", "0", join(maskDir, "%06d.png"),
	], { stdio: ["ignore", "inherit", "inherit"] });
}

function cameraRecord(camera, shotCam) {
	return {
		width: camera.width,
		height: camera.height,
		fovDeg: camera.fovDeg,
		fx: camera.fx,
		fy: camera.fy,
		cx: camera.cx,
		cy: camera.cy,
		K: [[camera.fx, 0, camera.cx], [0, camera.fy, camera.cy], [0, 0, 1]],
		gvhmrFMm: camera.gvhmrFMm,
		position: camera.position,
		yaw: camera.yaw,
		pitch: camera.pitch,
		rotationOrder: "YXZ",
		azimuthDeg: camera.azimuthDeg,
		elevationDeg: camera.elevationDeg,
		margin: camera.margin,
		bindingAxis: camera.bindingAxis,
		near: shotCam.near,
		far: shotCam.far,
		static: true,
		worldToCamera: camera.worldToCameraCv,
		worldToCameraGl: camera.worldToCameraGl,
		cameraToWorldRotationThree: [camera.cameraToWorldRotation.slice(0, 3), camera.cameraToWorldRotation.slice(3, 6), camera.cameraToWorldRotation.slice(6, 9)],
		convention: {
			world: "CozyClay Studio / Three.js scene: right-handed, +Y up, metres. The character's front is +Z at azimuth 0.",
			worldToCamera: "OpenCV: [X Y Z 1]^T = worldToCamera * [x y z 1]^T, camera x right, y DOWN, z forward (depth).",
			projection: "u = fx * X / Z + cx, v = fy * Y / Z + cy. Square pixels, no distortion, no skew.",
			image: "Pixels continuous from the top-left corner of the top-left pixel: u right, v DOWN; pixel (col,row) covers [col,col+1)x[row,row+1) and its centre is (col+0.5,row+0.5); cx = width/2, cy = height/2.",
			worldToCameraGl: "Three/OpenGL view matrix (camera.matrixWorldInverse): x right, y up, looking down -z.",
			threeCamera: "PerspectiveCamera(fov = fovDeg vertical, aspect = width/height), position, rotation.set(pitch, yaw, 0) with order YXZ (radians); rendered through the Studio export capture.",
			gvhmr: "Run GVHMR with --f-mm gvhmrFMm: f_px = sqrt(W^2 + H^2) / sqrt(24^2 + 36^2) * f_mm equals fx = fy here.",
		},
	};
}

async function main() {
	const options = parseOptions(process.argv.slice(2));
	const children = [];
	const cleanups = [];
	const runCleanups = () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	};
	const removeSignals = installSignalCleanup(() => children, () => {
		runCleanups();
		process.exit(130);
	});
	const version = toolVersion();
	try {
		const base = options.url ?? await startVite({ root: ROOT, port: options.port, children });
		const cdp = await startChrome({ port: options.cdpPort, children, cleanups });
		mkdirSync(CACHE_DIR, { recursive: true });
		for (const file of options.motions) {
			await renderMotion({ cdp, base, file, options, version });
		}
		cdp.close();
	} finally {
		removeSignals();
		await terminateAll(children);
		runCleanups();
	}
}

/** The npz the Studio loads: the file itself, or the file with --transform's
 * scale/offsetY/yaw baked in (take-transform.mjs). Either way it is put in
 * the (gitignored) node_modules cache, where Vite can serve it to ?motion=. */
async function stageTake(file, bytes, transform) {
	if (isIdentityTransform(transform)) {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const cached = join(CACHE_DIR, `${sha256.slice(0, 16)}.npz`);
		if (!existsSync(cached)) copyFileSync(file, cached);
		return { sha256, cacheName: `${sha256.slice(0, 16)}.npz`, sceneOffset: { x: 0, y: 0, z: 0 } };
	}
	const decoded = await decodeMotionNpz(new Uint8Array(bytes));
	const { motion, sceneOffset } = transformTake(decoded, transform);
	const staging = join(CACHE_DIR, `.staging-${process.pid}.npz`);
	writeNpz(staging, takeToNpzMembers(motion));
	const sha256 = createHash("sha256").update(readFileSync(staging)).digest("hex");
	const cacheName = `${sha256.slice(0, 16)}.npz`;
	copyFileSync(staging, join(CACHE_DIR, cacheName));
	rmSync(staging, { force: true });
	return { sha256, cacheName, sceneOffset };
}

async function renderMotion({ cdp, base, file, options, version }) {
	const started = Date.now();
	const bytes = readFileSync(file);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const motionName = basename(file, ".npz");
	const staged = await stageTake(file, bytes, options.transform);
	// The page renders the take where playback anchors it; a scene offset is
	// the camera moved the opposite way, and every reported point is shifted
	// back into the scene by `offset`.
	const offset = staged.sceneOffset;
	const negOffset = { x: -offset.x, y: -offset.y, z: -offset.z };
	const pageBox = options.box ? { min: options.box.min.map((v, i) => v - [offset.x, offset.y, offset.z][i]), max: options.box.max.map((v, i) => v - [offset.x, offset.y, offset.z][i]) } : null;
	const motionUrl = `/node_modules/.cache/gt-render/${staged.cacheName}`;
	const studioUrl = `${base}/app/?motion=${encodeURIComponent(motionUrl)}`;
	const log = (message) => console.log(`[${motionName}] ${message}`);

	await openStudioClean(cdp, studioUrl);
	await waitFor("studio motion load", () => cdp.evaluate("!!(window.__cozyclay && window.__cozyclay.motion && window.__cozyclay.rigA && typeof window.__cozyclay.captureFraming === 'function')"), { timeoutMs: 180000, intervalMs: 250 });
	await cdp.evaluate(`(${installPageHelpers.toString()})(${supportValues.toString()}, ${JSON.stringify(RIG_JOINTS)}, ${JSON.stringify(MASK_RGB)}, ${boxContactValues.toString()})`);
	const state = await cdp.evaluate("window.__gtRender.state()");
	if (state.motionUrl !== motionUrl) throw new Error(`Studio loaded ${state.motionUrl} instead of ${motionUrl}`);
	if (state.fps !== FPS) throw new Error(`timeline runs at ${state.fps} fps, expected ${FPS}`);
	const frames = state.frameCount;
	log(`loaded ${frames} frames @ ${state.fps} fps, model ${state.characterModel}`);
	const motionDir = join(options.out, motionName);
	mkdirSync(motionDir, { recursive: true });
	if (options.exportVertices) writeFileSync(join(motionDir, "vertices.f32"), "");
	const sceneRecord = options.sceneBox ? { ...sceneBoxRecord(options.sceneBox), studio: await cdp.evaluate(`window.__gtRender.placeBox(${JSON.stringify(options.sceneBox)}, ${JSON.stringify(offset)})`) } : null;

	// Pre-pass: the camera must see every vertex of every frame (solved
	// camera), and --box needs every vertex anyway.
	const geometry = { width: WIDTH, height: HEIGHT, fMm: options.fMm, azimuthDeg: options.azimuthDeg, elevationDeg: options.elevationDeg, margin: options.margin };
	const givenMargin = options.camera ? (options.camera.margin ?? options.margin) : options.margin;
	const { R, kx, ky } = options.camera
		? { R: options.camera.cameraToWorldRotation, ...marginSlopes(options.camera, givenMargin) }
		: supportArgs(geometry);
	await cdp.evaluate(`window.__gtRender.setOrientation(${JSON.stringify(R)}, ${kx}, ${ky})`);
	const sampleOptions = { vertices: !options.camera, box: pageBox, exportVertices: options.exportVertices };
	const supports = [];
	const prepassJoints = [];
	const contacts = [];
	let vertexCount = 0;
	for (let frame = 0; frame < frames; frame += 1) {
		const sample = await cdp.evaluate(`window.__gtRender.sample(${frame}, ${JSON.stringify(sampleOptions)})`);
		if (sample.support) supports.push(sample.support);
		if (sample.vertices) {
			const points = Buffer.allocUnsafe(sample.vertices.length * 4);
			sample.vertices.forEach((v, i) => points.writeFloatLE(v + [offset.x, offset.y, offset.z][i % 3], i * 4));
			appendFileSync(join(motionDir, "vertices.f32"), points);
		}
		prepassJoints.push(sample.joints);
		if (sample.contact) contacts.push(sample.contact);
		vertexCount = sample.vertexCount;
	}
	if (options.exportVertices) writeFileSync(join(motionDir, "vertices.json"), JSON.stringify({ frames, fps: FPS, vertexCount, file: "vertices.f32", layout: "frame,vertex,xyz; float32 LE; world metres" }));
	if (options.sceneBox && !options.camera) supports.push(supportValues(boxCorners(options.sceneBox).flatMap(p => p.map((v, i) => v - [offset.x, offset.y, offset.z][i])), R, kx, ky));
	// pageCamera renders the anchored take; camera (scene) is what is reported.
	const pageCamera = options.camera ? translateCamera(options.camera, negOffset) : buildCamera({ ...geometry, support: mergeSupports(supports) });
	const camera = options.camera ?? translateCamera(pageCamera, offset);
	const framing = { pos: pageCamera.position, yaw: pageCamera.yaw, pitch: pageCamera.pitch, fovDeg: pageCamera.fovDeg };
	const output = { width: WIDTH, height: HEIGHT };
	log(`camera at (${camera.position.x.toFixed(3)}, ${camera.position.y.toFixed(3)}, ${camera.position.z.toFixed(3)}), fov ${camera.fovDeg.toFixed(4)} deg, f ${camera.fy.toFixed(3)} px, ${options.camera ? `given (${options.camera.source})` : `${camera.bindingAxis}-bound`}, ${vertexCount} vertices/frame`);

	// Scene joints (page + offset) projected with camera.json. A solved
	// camera guarantees the margin box; a given one only reports it.
	const sceneJoints = prepassJoints.map((joints) => triples(joints, 12).map(([x, y, z]) => [x + offset.x, y + offset.y, z + offset.z]));
	const uv = sceneJoints.map((joints) => joints.map((point) => projectPoint(point, camera)));
	let minMarginPx = Infinity;
	for (const frameUv of uv) {
		for (const [u, v, depth] of frameUv) minMarginPx = Math.min(minMarginPx, depth > 0 ? Math.min(u, v, WIDTH - u, HEIGHT - v) : -Infinity);
	}
	const marginPx = givenMargin * Math.min(WIDTH, HEIGHT);
	if (!options.camera && minMarginPx < marginPx - 1e-6) throw new Error(`a joint projects ${minMarginPx.toFixed(2)} px from the edge, inside the ${marginPx} px margin`);
	if (options.camera && minMarginPx < marginPx - 1e-6) log(`warning: a joint projects ${minMarginPx.toFixed(2)} px from the edge (margin ${marginPx} px); negative = outside the image or behind the camera`);

	if (!options.noVideo) writeFileSync(join(motionDir, "plate.png"), Buffer.from(await cdp.evaluate(`window.__gtRender.plate(${JSON.stringify(framing)}, ${JSON.stringify(output)})`), "base64"));

	const wanted = new Set(options.noVideo ? [] : options.variants.map((variant) => variant.name));
	const needsShadedFrames = !options.noVideo && options.variants.some((variant) => variant.kind === "hue");
	const browserPasses = options.noVideo ? [{ name: "mask", partColours: null }] : [
		...(wanted.has("shaded") || needsShadedFrames ? [{ name: "shaded", partColours: true }] : []),
		...(wanted.has("skin") ? [{ name: "skin", partColours: false }] : []),
	];
	const checks = { prepassVsRenderJointMaxM: 0, threeVsCameraJsonMaxPx: 0 };
	const framesDirs = {};
	const passState = {};
	const maskRawDir = join(motionDir, ".mask-raw");
	rmSync(maskRawDir, { recursive: true, force: true });
	mkdirSync(maskRawDir, { recursive: true });
	for (const [passIndex, pass] of browserPasses.entries()) {
		const withMask = passIndex === 0;
		const withColour = pass.partColours !== null;
		if (withColour) passState[pass.name] = await cdp.evaluate(`window.__gtRender.setPartColours(${pass.partColours})`);
		const framesDir = wanted.has(pass.name) ? join(motionDir, pass.name, "frames") : join(motionDir, `.${pass.name}-frames`);
		if (withColour) {
			rmSync(framesDir, { recursive: true, force: true });
			mkdirSync(framesDir, { recursive: true });
			framesDirs[pass.name] = framesDir;
		}
		for (let frame = 0; frame < frames; frame += 1) {
			const captured = await cdp.evaluate(`window.__gtRender.capture(${frame}, ${JSON.stringify(framing)}, ${JSON.stringify(output)}, ${withMask}, ${withColour})`);
			if (withColour) writeFileSync(join(framesDir, `${String(frame).padStart(6, "0")}.png`), Buffer.from(captured.png, "base64"));
			if (withMask) writeFileSync(join(maskRawDir, `${String(frame).padStart(6, "0")}.png`), Buffer.from(captured.mask, "base64"));
			for (let i = 0; i < captured.joints.length; i += 1) {
				checks.prepassVsRenderJointMaxM = Math.max(checks.prepassVsRenderJointMaxM, Math.abs(captured.joints[i] - prepassJoints[frame][i]));
			}
			triples(captured.joints, 12).forEach((point, j) => {
				const [u, v] = projectPoint(point, pageCamera);
				checks.threeVsCameraJsonMaxPx = Math.max(checks.threeVsCameraJsonMaxPx, Math.abs(u - captured.threeUv[j * 2]), Math.abs(v - captured.threeUv[j * 2 + 1]));
			});
		}
		log(`rendered ${pass.name}: ${frames} frames`);
	}
	writeMasks(maskRawDir, join(motionDir, "mask"));
	rmSync(maskRawDir, { recursive: true, force: true });
	// The pose must not depend on the pass: joints.json is the pre-pass pose.
	if (checks.prepassVsRenderJointMaxM > 1e-6) throw new Error(`rendered pose differs from the pre-pass by ${checks.prepassVsRenderJointMaxM} m`);
	if (checks.threeVsCameraJsonMaxPx > 1e-3) throw new Error(`camera.json projection differs from the Three capture camera by ${checks.threeVsCameraJsonMaxPx} px`);

	const cameraJson = cameraRecord(camera, passState[browserPasses[0].name]?.shotCam ?? state.shotCam);
	if (options.camera) cameraJson.source = options.camera.source;
	const placement = {
		transform: options.transform ?? null,
		sceneOffset: offset,
		anchor: state.motionAnchor,
		note: "Studio placement: playback anchors the take's frame-0 root XZ on the subject (anchor) with the Character group's yaw. --transform: scale/offsetY/yaw baked into the loaded npz (yaw about the anchor), offsetX/offsetZ applied as the opposite camera move; joints, uv and contact are in the scene frame with the offset included.",
		renderedNpzSha256: staged.sha256,
	};
	const contactJson = options.box ? {
		box: options.box,
		basis: "skinned-vertices",
		vertexCount,
		convention: "signedDistanceM: closest skinned vertex to the box, positive outside, negative inside (depth to the nearest face). minDistanceM = max(0, signed), maxPenetrationM = max(0, -signed). Scene metres, the placement's offset included.",
		frames: contacts.map((contact) => ({ signedDistanceM: round(contact.minSignedDistance, 6), ...Object.fromEntries(Object.entries(contactFromSigned(contact.minSignedDistance)).map(([key, value]) => [key, round(value, 6)])), verticesInside: contact.insideCount })),
	} : null;
	if (contactJson) writeFileSync(join(motionDir, "contact.json"), `${JSON.stringify(contactJson)}\n`);
	const jointsJson = {
		convention: "world: metres in the camera.json world frame; uv: pixels in the camera.json image convention (origin top-left, v down), projected with camera.json; depth: camera-space Z in metres.",
		fps: FPS,
		frames,
		joints: RIG_JOINTS.map(({ bone, cskel27 }) => ({ name: bone.replace(/^mixamorig/, ""), bone, cskel27 })),
		note: "Rig bones of the rendered character (the pose actually drawn). Mixamo Spine/Spine1/Spine2 correspond to cskel27 Spine1/Spine2/Spine3 (src/ardy/playback.js); the Mixamo body is not congruent with cskel27 and playback scales the take's root travel to the rig's leg length, so these are NOT the npz's posed_joints: they differ by centimetres, growing with distance travelled (about 1% of it on walk-then-stop). They are the truth for what the video shows.",
		world: sceneJoints.map((joints) => joints.map((point) => point.map((value) => round(value, 6)))),
		uv: uv.map((frameUv) => frameUv.map(([u, v]) => [round(u, 4), round(v, 4)])),
		depth: uv.map((frameUv) => frameUv.map(([, , z]) => round(z, 6))),
	};
	const shared = {
		tool: "tools/gt-render/render.mjs",
		toolVersion: version,
		createdAt: new Date().toISOString(),
		source: { path: file, sha256, bytes: bytes.length },
		motionName,
		frames,
		fps: FPS,
		placement,
		camera: options.camera ? { source: options.camera.source, given: true } : { given: false },
		video: { file: "video.mp4", width: WIDTH, height: HEIGHT, codec: "h264 (libx264)", pixFmt: "yuv420p", colorspace: "smpte170m, tv range", crf: options.crf },
		characterModel: state.characterModel,
		characterScale: state.characterScale,
		studio: { url: studioUrl, captureHook: "window.__cozyclay.captureFraming" },
		plate: "../plate.png (same camera, character hidden)",
		mask: "../mask/%06d.png (8-bit gray, 255 = character: the frame re-rendered with the character unlit in one colour, >= 50% pixel coverage)",
		checks: {
			...checks,
			minJointEdgeDistancePx: minMarginPx,
			framingVerticesPerFrame: vertexCount,
		},
	};
	if (sceneRecord) writeFileSync(join(motionDir, "scene.json"), `${JSON.stringify(sceneRecord, null, 2)}\n`);
	if (options.noVideo) {
		const { video, plate, ...rest } = shared;
		writeFileSync(join(motionDir, "camera.json"), `${JSON.stringify(cameraJson, null, "\t")}\n`);
		writeFileSync(join(motionDir, "joints.json"), `${JSON.stringify(jointsJson)}\n`);
		writeFileSync(join(motionDir, "meta.json"), `${JSON.stringify({ ...rest, mask: "mask/%06d.png (8-bit gray, 255 = character: the frame re-rendered with the character unlit in one colour, >= 50% pixel coverage)", variant: null, noVideo: true, contact: contactJson ? "contact.json" : null }, null, "\t")}\n`);
		log(`wrote joints + masks (no video)`);
	}
	for (const variant of options.noVideo ? [] : options.variants) {
		const dir = join(motionDir, variant.name);
		mkdirSync(dir, { recursive: true });
		if (sceneRecord) writeFileSync(join(dir, "scene.json"), `${JSON.stringify(sceneRecord, null, 2)}\n`);
		const filter = variant.kind === "hue" ? `hue=h=${variant.degrees}` : null;
		encode(variant.kind === "hue" ? framesDirs.shaded : framesDirs[variant.name], join(dir, "video.mp4"), { crf: options.crf, filter });
		writeFileSync(join(dir, "camera.json"), `${JSON.stringify(cameraJson, null, "\t")}\n`);
		writeFileSync(join(dir, "joints.json"), `${JSON.stringify(jointsJson)}\n`);
		const variantDetail = variant.kind === "hue"
			? { partColours: "shaded", postFilter: filter, note: `ffmpeg hue filter on the shaded frames: rotates every pixel's chroma by ${variant.degrees} degrees, so all hues shift uniformly and greys are unchanged.` }
			: { partColours: variant.kind === "shaded" ? "shaded" : "off", postFilter: null };
		writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ ...shared, variant: variant.name, variantDetail }, null, "\t")}\n`);
		log(`wrote ${variant.name}`);
	}
	if (!options.keepFrames) for (const dir of Object.values(framesDirs)) rmSync(dir, { recursive: true, force: true });
	else if (framesDirs.shaded && !wanted.has("shaded")) rmSync(framesDirs.shaded, { recursive: true, force: true });
	log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((error) => {
	console.error(error?.stack || String(error));
	process.exitCode = 1;
});
