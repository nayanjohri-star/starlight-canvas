// Keyframe pack export: bundles a shot's reference material into a ZIP that
// can be dropped into Seedance-style multi-reference video tools. Each pack
// is one folder holding first/last frames, an optional motion clip, the
// camera state, the prompt, and a README explaining what each file is for.

import { buildZip } from "./zip-store.js";
import { referenceVideoPlan } from './offscreen-export.js';

function framePng(bytes, label) {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (!(bytes instanceof Uint8Array) || !signature.every((value, index) => bytes[index] === value)) throw new TypeError(`${label} must contain PNG bytes`);
}

export function slugifyTitle(title) {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "shot";
}

/** ZIP file name for a shot pack: `cozyclay-shot-<index>-<slug>.zip`. */
export function keyframePackName(shot) {
	return `cozyclay-shot-${shot.index}-${slugifyTitle(shot.title)}.zip`;
}

function readmeText({ shot, fps, hasLast, hasClip, ext }) {
	const lines = [
		`CozyClay keyframe pack - shot ${shot.index}: ${shot.title}`,
		`Frame range ${shot.startFrame}-${shot.endFrame} at ${fps} fps.`,
		"",
		"This pack is a multi-reference bundle for Seedance-style tools.",
		"Each file plays a distinct reference role:",
		"",
		"- first.png: identity reference. The first frame defines what the",
		"  subject and scene must look like when the shot begins.",
	];
	if (hasLast) {
		lines.push(
			"- last.png: motion endpoint reference. The final frame pins where",
			"  the motion should land, constraining the generated trajectory.",
		);
	} else {
		lines.push(
			"- last.png: not included. Without an endpoint the tool is free to",
			"  choose how the motion resolves.",
		);
	}
	if (hasClip) {
		lines.push(
			`- clip.${ext}: motion reference. The source clip carries the movement`,
			"  the generated video should follow.",
		);
	} else {
		lines.push(
			`- clip.${ext}: not included. Without a motion clip the tool must`,
			"  invent the movement from the frames and prompt alone.",
		);
	}
	lines.push(
		"- camera.json: camera reference. The recorded camera move, fps, and",
		"  frame range to reproduce the framing over time.",
		"- prompt.txt: the text prompt describing the intended action.",
	);
	return lines.join("\n") + "\n";
}

/**
 * Build the ZIP entries for one shot's keyframe pack.
 * @param {object} args
 * @param {{ title: string, index: number, startFrame: number, endFrame: number }} args.shot
 * @param {number} args.fps
 * @param {Uint8Array} args.firstFramePng
 * @param {Uint8Array | null} args.lastFramePng
 * @param {{ data: Uint8Array, ext: "mp4" | "webm" } | null} args.clip
 * @param {object} args.camera
 * @param {string} args.prompt
 * @returns {Array<{ name: string, data: Uint8Array | string }>} entries for buildZip
 */
export function keyframePackEntries({ shot, fps, firstFramePng, lastFramePng, clip, camera, prompt }) {
	const plan = referenceVideoPlan(shot.startFrame, shot.endFrame, fps);
	framePng(firstFramePng, 'first.png');
	if (lastFramePng != null) framePng(lastFramePng, 'last.png');
	if (clip != null) {
		if (!(clip.data instanceof Uint8Array) || !clip.data.length || !['mp4', 'webm'].includes(clip.ext)) throw new TypeError('Reference clip must contain mp4 or webm bytes');
		if ((clip.frameCount != null && clip.frameCount !== plan.frameCount) || (clip.fps != null && clip.fps !== fps)) throw new RangeError('Reference clip frame count or fps disagrees with the shot');
	}
	const folder = `${shot.index}-${slugifyTitle(shot.title)}`;
	const entries = [{ name: `${folder}/first.png`, data: firstFramePng }];
	if (lastFramePng != null) entries.push({ name: `${folder}/last.png`, data: lastFramePng });
	if (clip != null) entries.push({ name: `${folder}/clip.${clip.ext}`, data: clip.data });
	entries.push(
		{ name: `${folder}/camera.json`, data: JSON.stringify({ ...camera, fps, startFrame: plan.startFrame, endFrame: plan.endFrame, frameCount: plan.frameCount, durationSeconds: plan.durationSeconds }, null, 2) + "\n" },
		{ name: `${folder}/prompt.txt`, data: `${prompt}\n` },
		{ name: `${folder}/README.txt`, data: readmeText({ shot, fps, hasLast: lastFramePng != null, hasClip: clip != null, ext: clip ? clip.ext : "mp4" }) },
	);
	return entries;
}

/** Convenience wrapper: entries plus the archive bytes. */
export function buildKeyframePack(args) {
	return buildZip(keyframePackEntries(args));
}
