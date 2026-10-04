#!/usr/bin/env node
/**
 * Mocap scorer (#431): compare a predicted cskel27 motion npz against a T1
 * ground-truth render (tools/gt-render/render.mjs) by rendering the
 * prediction through the SAME Studio rig and the SAME camera.
 *
 *   node tools/bench/score.mjs --gt <T1 motion dir> --pred <motion.npz> --out <dir>
 *        [--box '{"min":[x,y,z],"max":[x,y,z]}'] [--pred-transform '<json>'] [--gt-npz <npz>]
 *
 * Ground truth is the rig as rendered (joints.json, mask/), so the prediction
 * is read the same way: render.mjs --no-video --camera <gt camera.json>.
 *
 * Placements
 *   raw      the prediction as the Studio places any take: frame 0 anchored on
 *            the subject, the take's own heading (plus --pred-transform, a scene
 *            calibration in the Studio's sceneCalibration semantics, if given).
 *            A constant offset baked into the npz is therefore invisible here;
 *            score.json reports it separately (npz.frame0RootOffsetM).
 *   aligned  raw moved by the least-squares yaw + ground-plane translation that
 *            maps its first scored frame's joints onto the GT's, re-rendered so
 *            the mask IoU is of a real render.
 *
 * Timelines: the Studio plays every take at 24 fps (retimed on load). Each GT
 * frame is paired with the nearest-in-time rendered pred frame; GT frames past
 * the prediction's end are not scored. Both are reported in score.json.
 *
 * Writes <out>/score.json, <out>/frames.csv and the renders in <out>/render-*.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { mocapMetricsFromMotion } from "../ardy/mocap-metrics.mjs";
import { installSignalCleanup, spawnOwned, waitForExit } from "../process-supervisor.mjs";
import { startVite, terminateAll } from "../gt-render/browser.mjs";
import { isIdentityTransform, parseTransform, transformTake } from "../gt-render/take-transform.mjs";
import {
	applyYawTranslation,
	composeCalibration,
	displacementXZ,
	fitYawTranslation,
	maskIoU,
	mean,
	meanJointError,
	parseBox,
	pathLengthXZ,
	procrustesError,
	ratio,
	resampleToTimeline,
	rootRelativeError,
	trajectoryError,
} from "./metrics.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const RENDER = join(ROOT, "tools/gt-render/render.mjs");
const ROOT_JOINT = "Hips";

const USAGE = `usage: node tools/bench/score.mjs --gt <T1 motion dir> --pred <motion.npz> --out <dir> [options]

  --gt <dir>              T1 output for one motion (<dir>/mask/ + <dir>/<variant>/{camera,joints}.json),
                          or a --no-video render dir holding camera.json/joints.json/mask/
  --pred <npz>            predicted cskel27 motion npz
  --out <dir>             score.json, frames.csv, render-raw/, render-aligned/ [, render-gt/]
  --box <json>            '{"min":[x,y,z],"max":[x,y,z]}' scene box: skinned-vertex distance/penetration
  --pred-transform <json> scene calibration for the raw placement (render.mjs --transform keys)
  --gt-npz <npz>          GT source npz (default: meta.json source.path); used for physical
                          metrics, the npz offset diagnostic and GT contact with --box
  --url <origin>          reuse a running Vite dev server of THIS checkout
  --port <n>              Vite port when starting one (default 5192)
  --cdp-port <n>          headless Chrome DevTools port for the renders (default 9232)`;

function parseOptions(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			gt: { type: "string" },
			pred: { type: "string" },
			out: { type: "string" },
			box: { type: "string" },
			"pred-transform": { type: "string" },
			"gt-npz": { type: "string" },
			url: { type: "string" },
			port: { type: "string", default: "5192" },
			"cdp-port": { type: "string", default: "9232" },
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
	for (const key of ["gt", "pred", "out"]) if (!values[key]) fail(`--${key} is required`);
	const pred = resolve(values.pred);
	if (!existsSync(pred)) fail(`no such pred: ${pred}`);
	let box = null;
	let predTransform = null;
	try {
		if (values.box) box = parseBox(values.box);
		predTransform = parseTransform(values["pred-transform"] ?? "{}");
	} catch (error) {
		fail(error.message);
	}
	const port = Number(values.port);
	const cdpPort = Number(values["cdp-port"]);
	if (!Number.isInteger(port) || !Number.isInteger(cdpPort)) fail("--port and --cdp-port must be integers");
	return { gt: resolve(values.gt), pred, out: resolve(values.out), box, predTransform, gtNpz: values["gt-npz"] ? resolve(values["gt-npz"]) : null, url: values.url?.replace(/\/$/, "") ?? null, port, cdpPort };
}

/** camera.json, joints.json, meta.json and mask/ of a GT motion dir. */
function loadGt(dir) {
	const hasFiles = (d) => existsSync(join(d, "camera.json")) && existsSync(join(d, "joints.json"));
	let files = hasFiles(dir) ? dir : null;
	if (!files) {
		const variants = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && hasFiles(join(dir, e.name))).map((e) => e.name);
		const pick = variants.includes("shaded") ? "shaded" : variants.sort()[0];
		if (!pick) throw new Error(`${dir}: no camera.json/joints.json here or in a variant subdirectory`);
		files = join(dir, pick);
	}
	const maskDir = [join(dir, "mask"), join(files, "mask"), join(dirname(files), "mask")].find((d) => existsSync(d));
	if (!maskDir) throw new Error(`${dir}: no mask/ directory`);
	const read = (name) => JSON.parse(readFileSync(join(files, name), "utf8"));
	return { dir, files, cameraPath: join(files, "camera.json"), camera: read("camera.json"), joints: read("joints.json"), meta: existsSync(join(files, "meta.json")) ? read("meta.json") : null, sceneBox: existsSync(join(files, "scene.json")) ? read("scene.json").placement : null, maskDir };
}

async function render({ base, cdpPort, out, camera, transform, box, sceneBox, file, children }) {
	const args = [RENDER, "--out", out, "--no-video", "--camera", camera, "--url", base, "--cdp-port", String(cdpPort)];
	if (transform && !isIdentityTransform(transform)) args.push("--transform", JSON.stringify(transform));
	if (box) args.push("--box", JSON.stringify(box));
	if (sceneBox) args.push("--scene-box", JSON.stringify(sceneBox));
	args.push(file);
	const child = spawnOwned(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
	children.push(child);
	const { code, signal } = await waitForExit(child);
	children.splice(children.indexOf(child), 1);
	if (code !== 0) throw new Error(`render.mjs ${basename(file)} failed (code ${code}, signal ${signal})`);
	const dir = join(out, basename(file, ".npz"));
	const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
	return { dir, joints: read("joints.json"), meta: read("meta.json"), contact: box ? read("contact.json") : null, maskDir: join(dir, "mask") };
}

/** All masks of a dir as one gray buffer (frames * width * height). */
function readMasks(dir, frames, width, height) {
	const buffer = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-start_number", "0", "-i", join(dir, "%06d.png"), "-frames:v", String(frames), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: frames * width * height + 1024 });
	if (buffer.length !== frames * width * height) throw new Error(`${dir}: decoded ${buffer.length} mask bytes, expected ${frames} x ${width} x ${height}`);
	return (i) => buffer.subarray(i * width * height, (i + 1) * width * height);
}

const rootOf = (joints) => joints.joints.findIndex((joint) => joint.cskel27 === ROOT_JOINT);

async function decodeFile(path) {
	return decodeMotionNpz(new Uint8Array(readFileSync(path)));
}

function physical(motion, path) {
	const m = mocapMetricsFromMotion(motion, { path });
	return { frames: m.frames, fps: m.fps, footSlideCmPerS: m.footSlideCmPerS, jitterMmPerS2: m.jitterMmPerS2, framesBelowFloor: m.framesBelowFloor, deepestBelowFloorCm: m.deepestBelowFloorCm, rootTravelM: m.rootTravelM };
}

function contactSummary(contact, indices) {
	if (!contact) return null;
	const frames = indices.map((i) => contact.frames[i]);
	const minDistance = Math.min(...frames.map((f) => f.minDistanceM));
	const maxPenetration = Math.max(...frames.map((f) => f.maxPenetrationM));
	return { basis: contact.basis, minDistanceM: minDistance, maxPenetrationM: maxPenetration, framesPenetrating: frames.filter((f) => f.maxPenetrationM > 0).length, framesTouching: frames.filter((f) => f.signedDistanceM <= 0.01).length };
}

const r6 = (value) => (value === null || value === undefined || !Number.isFinite(value) ? value ?? null : Math.round(value * 1e6) / 1e6);

async function main() {
	const options = parseOptions(process.argv.slice(2));
	const children = [];
	const removeSignals = installSignalCleanup(() => children, () => process.exit(130));
	mkdirSync(options.out, { recursive: true });
	const gt = loadGt(options.gt);
	const { width, height } = gt.camera;
	const gtNpz = options.gtNpz ?? (gt.meta?.source?.path && existsSync(gt.meta.source.path) ? gt.meta.source.path : null);
	try {
		const base = options.url ?? await startVite({ root: ROOT, port: options.port, children });
		const common = { base, cdpPort: options.cdpPort, camera: gt.cameraPath, box: options.box, sceneBox: gt.sceneBox, children };
		console.log(`[score] raw render of ${options.pred}`);
		const raw = await render({ ...common, out: join(options.out, "render-raw"), transform: options.predTransform, file: options.pred });

		// Timeline pairing, GT frame -> nearest pred frame.
		const timeline = resampleToTimeline({ gtFrames: gt.joints.frames, gtFps: gt.joints.fps, predFrames: raw.joints.frames, predFps: raw.joints.fps });
		const pairs = timeline.predIndex.map((k, i) => [i, k]).filter(([, k]) => k !== null);
		if (!pairs.length) throw new Error("no GT frame falls inside the prediction's timeline");
		const [gt0, pr0] = pairs[0];

		// First-frame rigid alignment (yaw + ground-plane translation).
		const alignment = fitYawTranslation(raw.joints.world[pr0], gt.joints.world[gt0]);
		const anchor = raw.meta.placement.anchor;
		const alignedTransform = composeCalibration(options.predTransform, anchor, alignment);
		console.log(`[score] first-frame alignment: yaw ${alignment.yawDeg.toFixed(3)} deg, t (${alignment.tx.toFixed(4)}, ${alignment.tz.toFixed(4)}) m; aligned render`);
		const aligned = await render({ ...common, out: join(options.out, "render-aligned"), transform: parseTransform(JSON.stringify(alignedTransform)), file: options.pred });
		let rigidCheck = 0;
		for (let k = 0; k < raw.joints.frames; k += 1) {
			raw.joints.world[k].forEach((p, j) => {
				const q = applyYawTranslation(p, alignment);
				const a = aligned.joints.world[k][j];
				rigidCheck = Math.max(rigidCheck, Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2]));
			});
		}
		const gtRender = options.box && gtNpz ? await render({ ...common, out: join(options.out, "render-gt"), transform: null, file: gtNpz }) : null;

		// Masks.
		const gtMask = readMasks(gt.maskDir, gt.joints.frames, width, height);
		const rawMask = readMasks(raw.maskDir, raw.joints.frames, width, height);
		const alignedMask = readMasks(aligned.maskDir, aligned.joints.frames, width, height);

		const root = rootOf(gt.joints);
		if (root < 0 || rootOf(raw.joints) !== root) throw new Error("GT and pred joints.json disagree on the root joint");
		if (gt.joints.joints.map((j) => j.bone).join() !== raw.joints.joints.map((j) => j.bone).join()) throw new Error("GT and pred joints.json list different joints");

		const rows = pairs.map(([i, k]) => {
			const g = gt.joints.world[i];
			const pr = raw.joints.world[k];
			const pa = aligned.joints.world[k];
			return {
				gtFrame: i,
				predFrame: k,
				timeS: i / gt.joints.fps,
				mpjpeRawM: rootRelativeError(pr, g, root),
				mpjpeAlignedM: rootRelativeError(pa, g, root),
				paMpjpeM: procrustesError(pr, g),
				jointErrRawM: meanJointError(pr, g),
				jointErrAlignedM: meanJointError(pa, g),
				rootErrRawM: Math.hypot(pr[root][0] - g[root][0], pr[root][1] - g[root][1], pr[root][2] - g[root][2]),
				rootErrAlignedM: Math.hypot(pa[root][0] - g[root][0], pa[root][1] - g[root][1], pa[root][2] - g[root][2]),
				iouRaw: maskIoU(rawMask(k), gtMask(i)).iou,
				iouAligned: maskIoU(alignedMask(k), gtMask(i)).iou,
				contactPredRaw: raw.contact?.frames[k] ?? null,
				contactPredAligned: aligned.contact?.frames[k] ?? null,
				contactGt: gtRender?.contact?.frames[i] ?? null,
			};
		});
		const gtRoot = pairs.map(([i]) => gt.joints.world[i][root]);
		const rawRoot = pairs.map(([, k]) => raw.joints.world[k][root]);
		const alignedRoot = pairs.map(([, k]) => aligned.joints.world[k][root]);
		const ateAligned = trajectoryError(alignedRoot, gtRoot);
		const ateRaw = trajectoryError(rawRoot, gtRoot);
		const last = rows[rows.length - 1];

		// npz-level facts: physical metrics (tools/ardy/mocap-metrics.mjs on the
		// take as loaded, i.e. with the scale/offsetY/yaw baked in) and the
		// frame-0 root offset the Studio's anchoring discards.
		const predTake = await decodeFile(options.pred);
		const predLoaded = isIdentityTransform(options.predTransform) ? predTake : transformTake(predTake, options.predTransform).motion;
		const gtTake = gtNpz ? await decodeFile(gtNpz) : null;
		const npzOffset = gtTake ? Math.hypot(predTake.posedJoints[0] - gtTake.posedJoints[0], predTake.posedJoints[2] - gtTake.posedJoints[2]) : null;

		const score = {
			tool: "tools/bench/score.mjs",
			createdAt: new Date().toISOString(),
			gt: { dir: gt.dir, files: gt.files, camera: gt.cameraPath, npz: gtNpz, frames: gt.joints.frames, fps: gt.joints.fps },
			pred: { npz: options.pred, transform: options.predTransform, npzFrames: predTake.frames, npzFps: predTake.fps, timelineFrames: raw.joints.frames, timelineFps: raw.joints.fps },
			timeline: {
				mapping: "each GT frame -> nearest-in-time rendered pred frame (Studio timeline, pred retimed to 24 fps on load); GT frames past the pred's end are not scored",
				scoredFrames: timeline.scored,
				droppedGtFrames: timeline.dropped,
				exact: timeline.exact,
				frameCountMismatch: gt.joints.frames !== raw.joints.frames ? { gt: gt.joints.frames, pred: raw.joints.frames } : null,
				fpsMismatch: gt.joints.fps !== raw.joints.fps || (gtTake && predTake.fps !== gtTake.fps) ? { gtTimeline: gt.joints.fps, predTimeline: raw.joints.fps, gtNpz: gtTake?.fps ?? null, predNpz: predTake.fps } : null,
			},
			joints: { count: gt.joints.joints.length, root: ROOT_JOINT, source: "rendered Studio rig bones (joints.json), scene metres" },
			alignment: {
				method: "least-squares yaw about +Y + XZ translation of the first scored frame's joints (pred raw -> GT); height untouched",
				yawDeg: r6(alignment.yawDeg),
				translationM: [r6(alignment.tx), 0, r6(alignment.tz)],
				renderTransform: alignedTransform,
				anchor,
			},
			pose: {
				mpjpeRootRelativeRawM: r6(mean(rows.map((r) => r.mpjpeRawM))),
				mpjpeRootRelativeAlignedM: r6(mean(rows.map((r) => r.mpjpeAlignedM))),
				paMpjpeM: r6(mean(rows.map((r) => r.paMpjpeM))),
			},
			trajectory: {
				root: ROOT_JOINT,
				ateAlignedM: { rmse: r6(ateAligned.rmse), mean: r6(ateAligned.mean), max: r6(ateAligned.max), final: r6(ateAligned.final) },
				rootErrorRawM: { rmse: r6(ateRaw.rmse), mean: r6(ateRaw.mean), max: r6(ateRaw.max), final: r6(ateRaw.final) },
				pathLengthM: { gt: r6(pathLengthXZ(gtRoot)), pred: r6(pathLengthXZ(alignedRoot)) },
				pathLengthRatio: r6(ratio(pathLengthXZ(alignedRoot), pathLengthXZ(gtRoot))),
				displacementM: { gt: r6(displacementXZ(gtRoot)), pred: r6(displacementXZ(alignedRoot)) },
				displacementRatio: r6(ratio(displacementXZ(alignedRoot), displacementXZ(gtRoot))),
			},
			endpoints: {
				firstFrame: { gtFrame: rows[0].gtFrame, jointErrorRawM: r6(rows[0].jointErrRawM), jointErrorAlignedM: r6(rows[0].jointErrAlignedM) },
				lastFrame: { gtFrame: last.gtFrame, jointErrorRawM: r6(last.jointErrRawM), jointErrorAlignedM: r6(last.jointErrAlignedM) },
			},
			physical: {
				source: "tools/ardy/mocap-metrics.mjs on the npz posed_joints as loaded (native fps, npz units)",
				pred: physical(predLoaded, options.pred),
				gt: gtTake ? physical(gtTake, gtNpz) : null,
			},
			overlap: {
				maskIoURawMean: r6(mean(rows.map((r) => r.iouRaw))),
				maskIoUAlignedMean: r6(mean(rows.map((r) => r.iouAligned))),
				maskIoUAlignedMin: r6(Math.min(...rows.map((r) => r.iouAligned))),
			},
			contact: options.box ? {
				box: options.box,
				basis: "skinned-vertices",
				predRaw: contactSummary(raw.contact, pairs.map(([, k]) => k)),
				predAligned: contactSummary(aligned.contact, pairs.map(([, k]) => k)),
				gt: gtRender ? contactSummary(gtRender.contact, pairs.map(([i]) => i)) : null,
				gtNote: gtRender ? "GT npz re-rendered through the GT camera with --box" : "no GT npz available (pass --gt-npz)",
			} : null,
			npz: {
				frame0RootOffsetM: r6(npzOffset),
				note: "XZ distance between the pred and GT npz frame-0 roots (npz units). The Studio anchors every take's frame 0 on the subject, so this offset does not reach the renders above.",
			},
			checks: {
				alignedRenderVsRigidMaxM: r6(rigidCheck),
			},
			files: { csv: "frames.csv", renders: ["render-raw", "render-aligned", ...(gtRender ? ["render-gt"] : [])] },
		};
		writeFileSync(join(options.out, "score.json"), `${JSON.stringify(score, null, "\t")}\n`);
		const header = ["gt_frame", "pred_frame", "time_s", "mpjpe_rr_raw_m", "mpjpe_rr_aligned_m", "pa_mpjpe_m", "joint_err_raw_m", "joint_err_aligned_m", "root_err_raw_m", "root_err_aligned_m", "iou_raw", "iou_aligned"];
		if (options.box) header.push("box_signed_pred_raw_m", "box_signed_pred_aligned_m", "box_signed_gt_m");
		const csv = [header.join(",")];
		for (const r of rows) {
			const cells = [r.gtFrame, r.predFrame, r.timeS.toFixed(4), r.mpjpeRawM, r.mpjpeAlignedM, r.paMpjpeM, r.jointErrRawM, r.jointErrAlignedM, r.rootErrRawM, r.rootErrAlignedM, r.iouRaw, r.iouAligned].map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(6) : String(v)));
			if (options.box) cells.push(r.contactPredRaw?.signedDistanceM ?? "", r.contactPredAligned?.signedDistanceM ?? "", r.contactGt?.signedDistanceM ?? "");
			csv.push(cells.join(","));
		}
		writeFileSync(join(options.out, "frames.csv"), `${csv.join("\n")}\n`);
		console.log(`[score] MPJPE rr raw ${(score.pose.mpjpeRootRelativeRawM * 1000).toFixed(1)} mm, aligned ${(score.pose.mpjpeRootRelativeAlignedM * 1000).toFixed(1)} mm, PA ${(score.pose.paMpjpeM * 1000).toFixed(1)} mm; ATE ${score.trajectory.ateAlignedM.rmse.toFixed(4)} m; IoU raw ${score.overlap.maskIoURawMean.toFixed(4)} aligned ${score.overlap.maskIoUAlignedMean.toFixed(4)}`);
		console.log(`[score] wrote ${join(options.out, "score.json")}`);
	} finally {
		removeSignals();
		await terminateAll(children);
	}
}

main().catch((error) => {
	console.error(error?.stack || String(error));
	process.exitCode = 1;
});
