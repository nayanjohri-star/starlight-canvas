import { sceneBoxRecord, projectBox, BOX_EDGES } from "../gt-render/scene-box.mjs";

/** Lowest sustained window, never a one-frame outlier. Ties choose the later span. */
export function lowestWindow(values, length, start = 0) {
	if (!values.length || !values.every(Number.isFinite) || length < 1 || length > values.length - start) throw new Error("invalid sustained window");
	let best = start, score = Infinity;
	for (let i = start; i <= values.length - length; i++) {
		const mean = values.slice(i, i + length).reduce((a, b) => a + b, 0) / length;
		if (mean <= score) { score = mean; best = i; }
	}
	return Array.from({ length }, (_, i) => best + i);
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const xyz = (v, i) => [v[i], v[i + 1], v[i + 2]];

/** Axis-aligned horizontal support: the highest nonpenetrating top beneath
 * ALL sampled skin in this footprint. No joint radius or guessed skin offset.
 * Returns the witness vertex, making exact contact independently checkable. */
export function supportTop(frames, vertices, { x, z, sx, sz }) {
	let height = Infinity, witness = null;
	for (const frame of frames) {
		const v = vertices(frame);
		for (let i = 0; i < v.length; i += 3) {
			if (Math.abs(v[i] - x) <= sx / 2 && Math.abs(v[i + 2] - z) <= sz / 2 && v[i + 1] < height) {
				height = v[i + 1]; witness = { frame, vertex: i / 3, point: xyz(v, i) };
			}
		}
	}
	return { height, witness };
}

export function deriveBox(scenario, joints, vertices) {
	const index = name => { const i = joints.joints.findIndex(j => j.name === name); if (i < 0) throw new Error(`missing joint ${name}`); return i; };
	const at = (f, name) => joints.world[f][index(name)];
	const n = joints.frames, length = Math.min(n, Math.round(joints.fps / 2));
	const heights = name => joints.world.map((_, f) => at(f, name)[1]);
	const warnings = [];
	let frames, box, witness, targetHeight;
	if (scenario === "bump") {
		const first = at(0, "Hips"), travel = joints.world.map((_, f) => at(f, "Hips").map((v, a) => v - first[a]));
		const extent = a => Math.max(...travel.map(v => Math.abs(v[a])));
		const axis = extent(0) > extent(2) ? 0 : 2;
		const far = travel.reduce((a, b) => Math.abs(b[axis]) > Math.abs(a[axis]) ? b : a), sign = Math.sign(far[axis]) || 1;
		let reach = -Infinity, peak = 0;
		for (let f = 0; f < n; f++) {
			const v = vertices(f);
			for (let i = 0; i < v.length; i += 3) if (v[i + 1] > 0.15 && v[i + 1] < 1.5 && sign * v[i + axis] > reach) {
				reach = sign * v[i + axis]; peak = f; witness = { frame: f, vertex: i / 3, point: xyz(v, i) };
			}
		}
		frames = Array.from({ length: Math.min(length, n) }, (_, i) => Math.max(0, Math.min(n - length, peak - Math.floor(length / 2))) + i);
		const centre = at(peak, "Hips").slice(), side = axis === 0 ? 2 : 0;
		centre[axis] = sign * (reach + 0.2);
		box = { x: centre[0], z: centre[2], rot: 0, sx: axis === 0 ? 0.4 : 1.5, sy: 1.5, sz: axis === 2 ? 0.4 : 1.5 };
		// Centre width on the actual contact witness, not a drifting pelvis.
		box[side === 0 ? "x" : "z"] = witness.point[side];
		warnings.push("Bump frame is maximal skin reach along the dominant travel axis; this may be an extended hand rather than torso impact.");
	} else {
		let centres;
		if (scenario === "sit") {
			frames = lowestWindow(heights("Hips"), length, Math.floor(n / 3));
			centres = frames.map(f => at(f, "Hips"));
			targetHeight = mean(centres.map(p => p[1])) - 0.12;
			if (Math.max(...heights("Hips")) - mean(centres.map(p => p[1])) < 0.15) warnings.push("No clear seated pelvis drop; using the lowest available sustained span.");
		} else if (scenario === "handon") {
			const travel = [at(n - 1, "Hips")[0] - at(0, "Hips")[0], at(n - 1, "Hips")[2] - at(0, "Hips")[2]];
			const norm = Math.hypot(...travel), forward = norm > 1e-6 ? travel.map(v => v / norm) : [0, 1];
			const windows = Array.from({ length: n - length - Math.floor(n / 2) + 1 }, (_, i) => {
				const span = Array.from({ length }, (_, k) => Math.floor(n / 2) + i + k);
				const palms = span.flatMap(f => [at(f, "LeftHand"), at(f, "RightHand")]);
				return { span, palms, height: mean(palms.map(p => p[1])) };
			}).sort((a, b) => a.height - b.height);
			// The lowest hand span can still be beside the thighs. Select the
			// lowest span that permits a palm-height table IN FRONT, not a box
			// shifted sideways to touch a leg. Keep the failed-motion caveat.
			for (const { span, palms } of windows) {
				let best = Infinity;
				const target = Math.min(...palms.map(p => p[1])) - 0.025;
				for (let step = 14; step <= 36; step++) {
					const distance = step * 0.025;
					const candidate = { x: mean(palms.map(p => p[0])) + forward[0] * distance, z: mean(palms.map(p => p[2])) + forward[1] * distance, sx: 0.9, sz: 0.9 };
					const support = supportTop(span, vertices, candidate);
					if (support.height < Math.max(0.1, target - 0.1) || support.height > target + 0.1) continue;
					const loss = Math.abs(support.height - target) + 0.02 * distance;
					if (loss < best) { best = loss; box = { ...candidate, sy: support.height, rot: 0 }; witness = support.witness; frames = span; centres = palms; targetHeight = target; }
				}
				if (box) break;
			}
			if (!box) throw new Error("handon: no skin-safe palm-height table in front of the body in any sustained latter-half span");
			warnings.push("The absolute lowest hands are beside the thighs, not in a table-support pose. Selected the lowest sustained span permitting a skin-safe palm-height table in front. Both-palms natural contact is not established.");
		} else if (scenario === "stepup") {
			frames = Array.from({ length }, (_, i) => n - length + i);
			const foot = mean(frames.map(f => at(f, "LeftFoot")[1])) > mean(frames.map(f => at(f, "RightFoot")[1])) ? "LeftFoot" : "RightFoot";
			centres = frames.map(f => at(f, foot));
			targetHeight = Math.min(...centres.map(p => p[1])) - 0.04;
			if (targetHeight < 0.12) warnings.push("No clearly raised terminal stance foot; best available terminal span used, not a fabricated 0.3 m step.");
		} else throw new Error(`unknown scenario ${scenario}`);
		if (!box) {
			const x = mean(centres.map(p => p[0])), z = mean(centres.map(p => p[2]));
			const size = scenario === "sit" ? 0.5 : 0.4;
			let best = Infinity;
			// A footprint enclosing the feet is rejected by its near-floor
			// support top, not repaired by ignoring those vertices.
			const offsets = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];
			for (const dx of offsets) for (const dz of offsets) {
				const candidate = { x: x + dx, z: z + dz, sx: size, sz: size };
				const support = supportTop(frames, vertices, candidate);
				if (!Number.isFinite(support.height) || support.height < 0.1 || support.height > targetHeight + 0.1) continue;
				const loss = Math.abs(support.height - targetHeight) + 0.3 * Math.hypot(dx, dz);
				if (loss < best) { best = loss; box = { ...candidate, sy: support.height, rot: 0 }; witness = support.witness; }
			}
			if (!box) throw new Error(`${scenario}: no Studio-supported (>=0.1 m) support footprint near the intended contact`);
		}
		if (scenario === "stepup" && box.sy > 0.45) warnings.push(`Kimodo's terminal sole is ${box.sy.toFixed(3)} m high; retained the motion-derived height rather than inventing a 0.3-0.4 m step.`);
		if (Math.abs(box.sy - targetHeight) > 0.1) warnings.push(`Skin-safe top ${box.sy.toFixed(3)} m differs from anatomical target ${targetHeight.toFixed(3)} m: motion/contact is not a clean instance of the requested action.`);
	}
	return { scenario, box, scene: sceneBoxRecord(box), contactFrames: frames, contactSeconds: [frames[0] / joints.fps, frames.at(-1) / joints.fps], witness, targetHeight, warnings, method: "Static box from rendered skin in a declared 0.5 s contact span; no intermediate GT is used in fitting. A support top equals the lowest skin vertex within its footprint across that span." };
}

/** Chroma-only proxy: RGB range >= 35, HSV S >= .25, V >= .18;
 * includes all saturated palette colours, excludes neutral cube/floor/shadows.
 * It is NOT semantic segmentation and includes similarly coloured hallucinations. */
export const PALETTE_THRESHOLDS = Object.freeze({ minRange: 35, minSaturation: 0.25, minValue: 0.18 });
export function paletteMask(rgb, thresholds = PALETTE_THRESHOLDS) {
	if (rgb.length % 3) throw new Error("RGB byte count must be divisible by three");
	const mask = Buffer.alloc(rgb.length / 3);
	for (let p = 0; p < mask.length; p++) {
		const r = rgb[p * 3], g = rgb[p * 3 + 1], b = rgb[p * 3 + 2], hi = Math.max(r, g, b), lo = Math.min(r, g, b);
		mask[p] = hi - lo >= thresholds.minRange && (hi - lo) / hi >= thresholds.minSaturation && hi / 255 >= thresholds.minValue ? 255 : 0;
	}
	return mask;
}

/** Grey-body proxy against the same camera's empty Studio plate (cube stays).
 * Any RGB channel changing by >=30 counts as foreground. Lighting drift,
 * moving shadows and generated background changes are intentionally NOT
 * corrected: they are uncertainties of this proxy, not motion ground truth. */
export function backgroundDifferenceMask(rgb, plate, threshold = 30) {
	if (!plate.length || plate.length % 3 || rgb.length % plate.length || !Number.isFinite(threshold) || threshold <= 0 || threshold > 255) throw new Error("invalid RGB background-difference inputs");
	const mask = Buffer.alloc(rgb.length / 3);
	for (let p = 0; p < mask.length; p++) {
		const i = p * 3, q = i % plate.length;
		mask[p] = Math.max(Math.abs(rgb[i] - plate[q]), Math.abs(rgb[i + 1] - plate[q + 1]), Math.abs(rgb[i + 2] - plate[q + 2])) >= threshold ? 255 : 0;
	}
	return mask;
}

/** Draw all 8 projected corners and 12 edges directly into RGB (no image dependency). */
export function drawProjectedBox(rgb, camera, box) {
	const out = Buffer.from(rgb), points = projectBox(box, camera), { width, height } = camera;
	const dot = (x, y, radius) => { for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
		const u = Math.round(x) + dx, v = Math.round(y) + dy;
		if (u >= 0 && u < width && v >= 0 && v < height) { const p = (v * width + u) * 3; out[p] = 255; out[p + 1] = 25; out[p + 2] = 25; }
	} };
	for (const [a, b] of BOX_EDGES) {
		const p = points[a], q = points[b]; if (p[2] <= 0 || q[2] <= 0) continue;
		const steps = Math.ceil(Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])));
		for (let i = 0; i <= steps; i++) { const t = steps ? i / steps : 0; dot(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, 0); }
	}
	for (const [u, v, d] of points) if (d > 0) dot(u, v, 3);
	return out;
}
