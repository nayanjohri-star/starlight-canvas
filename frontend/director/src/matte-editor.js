/**
 * The background editor: the photograph as it arrived, and a purple brush.
 *
 * The rule is that what is purple is what goes. Not a suggestion the machine
 * then reinterprets — the purple IS the mask, and applying takes exactly those
 * pixels, whether a third of the picture is marked or all of it.
 *
 * Neither brush is a pixel brush. A stroke is a set of SEEDS: on release, the
 * same region growth the automatic pass uses runs from every place the brush
 * touched, and the region it reaches is taken in one go. Dragging across a
 * background is "cut this out", not "colour this in" — the brush says WHERE,
 * the algorithm decides HOW FAR.
 *
 * The eraser is that same growth, fenced to what is already selected: drag
 * over a piece of the subject that was cut by mistake and the whole wrongly
 * taken region comes back, stopping exactly where the selection stopped. One
 * tool, pointed either way.
 *
 * That is why the page opens on the untouched picture. An automatic cut shown
 * before anyone asked for it hides the thing that matters: a hole in the
 * subject and a piece of wall that survived both look like nothing once the
 * background is gone. Purple inverts that — nothing photographed for a set is
 * this violet, so every purple pixel is a decision you can see and argue with.
 *
 * The paint layer is kept at the picture's FULL resolution while interaction
 * runs on a preview at most 512 px wide. Painting a preview and scaling the
 * result up would turn a machine-cut edge into a staircase; painting into full
 * resolution and only DISPLAYING the preview costs nothing extra and keeps the
 * edge exactly as sharp as the picture is.
 *
 * No framework: a canvas, a pointer and two typed arrays, mounted the same way
 * from the studio's React sidebar and from the plain-DOM bench.
 */

import { backgroundMask, paintMask } from "./matte.js";

/** The overlay colour. Chosen to be impossible: nothing photographed for a set
 * is this violet, so every purple pixel is a decision, not the picture. */
export const MATTE_PURPLE = [139, 92, 246];
const OVERLAY_ALPHA = 0.62;
/** The ground the picture sits on — the studio's own dark, so the stage reads
 * as part of the panel rather than as a hole in it. */
const STAGE_GROUND = "#141819";
/** Interaction runs on a preview this wide at most — the paint underneath it
 * stays at the picture's own resolution. */
export const EDIT_PREVIEW_MAX = 512;
/** Zoom range. 1 is the whole picture — there is no reason to look at less of
 * it than that — and 16 puts a preview pixel under a fingertip. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
/** How many edits back you can walk. Each step is a full-resolution copy of
 * the selection, so this is a memory budget as much as a usability one: seven
 * is comfortably more than the "that stroke went too far" case a region brush
 * actually produces, and eight masks of a 2048 px picture is a few megabytes. */
export const MATTE_HISTORY = 7;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createMatteEditor(canvas, {
	onChange = () => {},
	createBitmap = globalThis.createImageBitmap,
	makeCanvas = (width, height) => new OffscreenCanvas(width, height),
} = {}) {
	const view = canvas.getContext("2d", { willReadFrequently: true });
	const state = {
		/** the picture at full size — what Auto-detect reads and what the paint
		 * layer is sized to */
		full: null,
		/** the same picture small enough to repaint on every pointer move */
		preview: null,
		/** 1 = purple = this goes. Full resolution, and the only mask there is. */
		paint: null,
		tolerance: 0.18,
		brush: 18,
		mode: "paint",
		painting: false,
		panning: null,
		last: null,
		/** where this stroke has touched, in full-resolution pixels — the seeds
		 * the growth runs from when the pointer comes up */
		seeds: [],
		/** the selection as it was when the stroke began. The eraser grows
		 * through THIS rather than through the live layer, which the stroke's
		 * own dabs are busy clearing. */
		before: null,
		/** What part of the picture the canvas is showing: a zoom factor and the
		 * top-left of the visible rect, in preview pixels. Zoom never goes below
		 * 1 and the rect is kept inside the picture, so there is no empty space
		 * to get lost in — at a hair's width the only thing worth looking at is
		 * the hair. */
		view: { zoom: 1, x: 0, y: 0 },
		/** offscreen copy of the whole preview, the source drawImage crops from */
		buffer: null,
		/** undo buffer: whole selections, newest last, current at `at` */
		history: [],
		at: -1,
	};

	/** Remember the selection as it stands. Called after a change has landed —
	 * a stroke that has finished growing, an auto-detect, a clear — never
	 * mid-drag, so one undo takes back one decision rather than one dab. */
	function commit() {
		if (!state.paint) return;
		// Anything ahead of the cursor is a future that has just been replaced.
		state.history.length = state.at + 1;
		state.history.push(Uint8Array.from(state.paint));
		while (state.history.length > MATTE_HISTORY + 1) state.history.shift();
		state.at = state.history.length - 1;
	}

	function step(delta) {
		const next = state.at + delta;
		if (!state.paint || next < 0 || next >= state.history.length) return false;
		state.at = next;
		state.paint.set(state.history[next]);
		repaint();
		return true;
	}

	/** full-resolution pixels per preview pixel */
	const ratio = () => (state.full && state.preview ? state.full.width / state.preview.width : 1);

	function report() {
		if (!state.paint) return onChange({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false });
		let painted = 0;
		for (let pixel = 0; pixel < state.paint.length; pixel++) painted += state.paint[pixel];
		onChange({
			painted,
			coverage: painted / state.paint.length,
			zoom: state.view.zoom,
			canUndo: state.at > 0,
			canRedo: state.at >= 0 && state.at < state.history.length - 1,
		});
	}

	/** Repaint the preview: the picture, plus purple wherever the paint layer
	 * says a pixel goes. The mask is sampled from full resolution rather than
	 * kept in two places, so what is displayed can never drift from what will
	 * be applied. */
	/**
	 * The canvas is a STAGE, and the picture sits on it.
	 *
	 * The obvious way to fit a picture into a panel is to let the element
	 * letterbox it — but then the bars live outside the canvas and stay there
	 * when you zoom, cropping the very edge you zoomed in to see. So the canvas
	 * fills its box, the ground is painted inside it, and the picture is drawn
	 * on top: at fit it sits in the middle with ground either side, and past fit
	 * it simply covers the stage. Nothing occludes it at any zoom.
	 */
	function stageSize() {
		const rect = canvas.getBoundingClientRect();
		// The stage is measured in DEVICE pixels: on a retina panel a canvas
		// backed at CSS size is visibly soft, and softness in a matte editor is
		// a lie about where the edge is.
		const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
		const width = Math.max(1, Math.round((rect.width || canvas.width || 1) * dpr));
		const height = Math.max(1, Math.round((rect.height || canvas.height || 1) * dpr));
		return { width, height, left: rect.left, top: rect.top, dpr };
	}

	/** Stage pixels per preview pixel: the fit scale, times the zoom. */
	function scaleOf(stage) {
		if (!state.preview) return 1;
		const fit = Math.min(stage.width / state.preview.width, stage.height / state.preview.height);
		return fit * clamp(state.view.zoom, MIN_ZOOM, MAX_ZOOM);
	}

	/**
	 * Where the picture lands on the stage, and what it is centred on.
	 *
	 * The centre is clamped per axis: while the picture covers the stage on that
	 * axis it cannot be dragged far enough to open a gap, and while it does not
	 * (the letterboxed axis at fit) it stays centred, because sliding a picture
	 * around inside its own empty margin is not panning, it is drift.
	 */
	function placement() {
		const stage = stageSize();
		const scale = scaleOf(stage);
		const width = state.preview ? state.preview.width * scale : 0;
		const height = state.preview ? state.preview.height * scale : 0;
		const halfW = stage.width / 2 / scale;
		const halfH = stage.height / 2 / scale;
		const center = { x: state.view.x, y: state.view.y };
		center.x = width >= stage.width
			? clamp(center.x, halfW, state.preview.width - halfW)
			: state.preview.width / 2;
		center.y = height >= stage.height
			? clamp(center.y, halfH, state.preview.height - halfH)
			: state.preview.height / 2;
		return {
			stage,
			scale,
			center,
			width,
			height,
			left: stage.width / 2 - center.x * scale,
			top: stage.height / 2 - center.y * scale,
		};
	}

	function repaint() {
		if (!state.preview) return;
		const { width, height, data } = state.preview;
		const scale = ratio();
		const fullWidth = state.full.width;
		const out = new Uint8ClampedArray(data.length);
		const [pr, pg, pb] = MATTE_PURPLE;
		for (let y = 0; y < height; y++) {
			const fy = Math.min(state.full.height - 1, Math.floor(y * scale));
			for (let x = 0; x < width; x++) {
				const index = (y * width + x) << 2;
				const alpha = data[index + 3] / 255;
				// Transparent parts of the source read as the page behind them, so
				// they get the studio's own dark ground rather than black.
				let r = data[index] * alpha + 26 * (1 - alpha);
				let g = data[index + 1] * alpha + 30 * (1 - alpha);
				let b = data[index + 2] * alpha + 32 * (1 - alpha);
				if (state.paint[fy * fullWidth + Math.min(fullWidth - 1, Math.floor(x * scale))]) {
					r = r * (1 - OVERLAY_ALPHA) + pr * OVERLAY_ALPHA;
					g = g * (1 - OVERLAY_ALPHA) + pg * OVERLAY_ALPHA;
					b = b * (1 - OVERLAY_ALPHA) + pb * OVERLAY_ALPHA;
				}
				out[index] = r;
				out[index + 1] = g;
				out[index + 2] = b;
				out[index + 3] = 255;
			}
		}
		if (!state.buffer || state.buffer.width !== width || state.buffer.height !== height) {
			state.buffer = makeCanvas(width, height);
			state.buffer.width = width;
			state.buffer.height = height;
		}
		// The whole picture is composited once, then placed on the stage.
		// Compositing only the visible part would be cheaper and wrong: the mask
		// is sampled per preview pixel, and cropping first would resample twice.
		state.buffer.getContext("2d").putImageData(new ImageData(out, width, height), 0, 0);

		const stage = stageSize();
		canvas.width = stage.width;
		canvas.height = stage.height;
		const place = placement();
		state.view.x = place.center.x;
		state.view.y = place.center.y;
		view.fillStyle = STAGE_GROUND;
		view.fillRect(0, 0, stage.width, stage.height);
		// Nearest-neighbour past 2x: a matte edge is a decision about which
		// pixels go, and smoothing it into a gradient is a lie about where it is.
		view.imageSmoothingEnabled = state.view.zoom < 2;
		view.drawImage(state.buffer, 0, 0, width, height, place.left, place.top, place.width, place.height);
		report();
	}

	/* --------------------------------------------------------- pointer --- */

	/** Where a pointer is, in FULL-resolution picture pixels: stage → picture,
	 * through the same placement the paint is drawn with. */
	function at(event) {
		const place = placement();
		const dpr = place.stage.dpr;
		const x = ((event.clientX - place.stage.left) * dpr - place.left) / place.scale;
		const y = ((event.clientY - place.stage.top) * dpr - place.top) / place.scale;
		return { x: x * ratio(), y: y * ratio() };
	}

	/** Is the pointer on the PICTURE, rather than on the ground beside it? A
	 * stroke that starts on the ground is not a stroke about the photograph. */
	function inside(event) {
		const place = placement();
		const dpr = place.stage.dpr;
		const x = (event.clientX - place.stage.left) * dpr - place.left;
		const y = (event.clientY - place.stage.top) * dpr - place.top;
		return x >= 0 && y >= 0 && x <= place.width && y <= place.height;
	}

	/** The brush is set in SCREEN pixels, so it shrinks in picture pixels as the
	 * picture is magnified — which is what makes zooming in the way to work an
	 * edge: the same wrist movement covers less photograph. */
	function radius() {
		const place = placement();
		return Math.max(1, (((state.brush * place.stage.dpr) / 2) / place.scale) * ratio());
	}

	function stroke(from, to) {
		const value = state.mode === "erase" ? 0 : 1;
		const r = radius();
		const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, r * 0.4)));
		let touched = 0;
		for (let step = 1; step <= steps; step++) {
			const x = from.x + ((to.x - from.x) * step) / steps;
			const y = from.y + ((to.y - from.y) * step) / steps;
			touched += paintMask(state.paint, state.full, { x, y, radius: r, value });
			// Every dab leaves a seed behind. The growth waits for the pointer to
			// come up: one flood per stroke is fast, one per pointermove would be
			// a full-resolution flood 60 times a second.
			state.seeds.push({ x, y });
		}
		if (touched) repaint();
	}

	/** The stroke is over: run the growth from everywhere the brush touched. */
	function growFromStroke() {
		const seeds = state.seeds;
		const before = state.before;
		state.seeds = [];
		state.before = null;
		if (!seeds.length || !state.full) return;
		const erasing = state.mode === "erase";
		const reached = backgroundMask(state.full, {
			points: seeds,
			tolerance: state.tolerance,
			// Erasing grows only through what was already purple, so it gives a
			// wrongly-cut region back whole and cannot spill into the picture.
			within: erasing ? before : null,
		});
		const value = erasing ? 0 : 1;
		let changed = 0;
		for (let pixel = 0; pixel < reached.length; pixel++) {
			if (!reached[pixel] || state.paint[pixel] === value) continue;
			state.paint[pixel] = value;
			changed += 1;
		}
		if (changed) {
			commit();
			repaint();
		}
	}

	const onDown = (event) => {
		if (!state.preview || !inside(event)) return;
		event.preventDefault();
		canvas.setPointerCapture?.(event.pointerId);
		// Middle button, or space held: this drag moves the view, not the mask.
		if (event.button === 1 || spaceHeld) {
			state.panning = { x: event.clientX, y: event.clientY };
			return;
		}
		state.painting = true;
		// The snapshot the eraser grows through, taken before this stroke's own
		// dabs start clearing the layer it would otherwise read.
		state.before = Uint8Array.from(state.paint);
		state.last = at(event);
		stroke(state.last, state.last);
	};
	const onMove = (event) => {
		if (state.panning) {
			const place = placement();
			// Stage pixels to preview pixels, so the picture tracks the cursor
			// exactly rather than sliding faster or slower than the hand.
			const dpr = place.stage.dpr;
			state.view.x = place.center.x - ((event.clientX - state.panning.x) * dpr) / place.scale;
			state.view.y = place.center.y - ((event.clientY - state.panning.y) * dpr) / place.scale;
			state.panning = { x: event.clientX, y: event.clientY };
			repaint();
			return;
		}
		if (!state.painting) return;
		const point = at(event);
		stroke(state.last, point);
		state.last = point;
	};
	const onUp = (event) => {
		if (state.panning) {
			state.panning = null;
			if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
			return;
		}
		if (!state.painting) return;
		state.painting = false;
		growFromStroke();
		if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	/* ------------------------------------------------------------ view --- */

	/** Zoom about a point on screen, so what is under the cursor stays under
	 * the cursor — the only zoom that lets you keep working on the thing you
	 * were looking at. */
	function zoomAt(clientX, clientY, factor) {
		if (!state.preview) return;
		const place = placement();
		// The picture point under the cursor, before and after — it has to stay
		// under the cursor, or zooming loses the thing you were looking at.
		const dpr = place.stage.dpr;
		const anchorX = ((clientX - place.stage.left) * dpr - place.left) / place.scale;
		const anchorY = ((clientY - place.stage.top) * dpr - place.top) / place.scale;
		state.view.zoom = clamp(state.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
		const next = placement();
		const offsetX = (clientX - next.stage.left) * next.stage.dpr - next.stage.width / 2;
		const offsetY = (clientY - next.stage.top) * next.stage.dpr - next.stage.height / 2;
		state.view.x = anchorX - offsetX / next.scale;
		state.view.y = anchorY - offsetY / next.scale;
		repaint();
	}

	const onWheel = (event) => {
		if (!state.preview) return;
		event.preventDefault();
		zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
	};

	// Middle button pans, and so does the left button while space is held —
	// the two conventions people arrive with from every other paint tool.
	let spaceHeld = false;
	const onKeyDown = (event) => {
		if (event.key === " ") spaceHeld = true;
	};
	const onKeyUp = (event) => {
		if (event.key === " ") spaceHeld = false;
	};
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onUp);
	canvas.addEventListener("pointerleave", onUp);
	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("keydown", onKeyDown);
	canvas.addEventListener("keyup", onKeyUp);

	/* ------------------------------------------------------------- api --- */

	return {
		/**
		 * Decode an asset and show it AS IT IS. Nothing is marked until someone
		 * asks — either with the brush or with Auto-detect.
		 */
		async load(asset) {
			const bitmap = await createBitmap(new Blob([asset.bytes], { type: asset.type }));
			try {
				const read = (width, height) => {
					const work = makeCanvas(width, height);
					const context = work.getContext("2d", { willReadFrequently: true });
					context.drawImage(bitmap, 0, 0, width, height);
					const image = context.getImageData(0, 0, width, height);
					return { data: image.data, width, height };
				};
				state.full = read(bitmap.width, bitmap.height);
				const scale = Math.min(1, EDIT_PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
				state.preview = scale === 1
					? { data: Uint8ClampedArray.from(state.full.data), width: state.full.width, height: state.full.height }
					: read(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
				state.paint = new Uint8Array(state.full.width * state.full.height);
				state.view = { zoom: 1, x: state.preview.width / 2, y: state.preview.height / 2 };
				state.buffer = null;
				state.history = [];
				state.at = -1;
				commit();
				repaint();
			} finally {
				bitmap?.close?.();
			}
		},

		/** Put a saved selection back on the picture — the second half of a
		 * card's state, alongside the photograph itself. */
		setMask(mask, width, height) {
			if (!state.paint || !mask) return false;
			if (width !== state.full.width || height !== state.full.height) return false;
			state.paint.set(mask);
			commit();
			repaint();
			return true;
		},

		/**
		 * The first pass, on request: grow the background from the frame's edges
		 * and paint what it reaches. It ADDS to the purple rather than replacing
		 * it, so running it again at a higher tolerance extends the selection
		 * instead of discarding the corrections already made by hand.
		 */
		autoDetect(tolerance = state.tolerance) {
			if (!state.full) return 0;
			state.tolerance = clamp(Number(tolerance) || 0, 0.01, 0.9);
			const found = backgroundMask(state.full, { tolerance: state.tolerance });
			let added = 0;
			for (let pixel = 0; pixel < found.length; pixel++) {
				if (!found[pixel] || state.paint[pixel]) continue;
				state.paint[pixel] = 1;
				added += 1;
			}
			if (added) commit();
			repaint();
			return added;
		},

		/** Zoom about the middle of the canvas — what the +/− buttons do. */
		zoomBy(factor) {
			const stage = stageSize();
			// The centre of the stage, back in client coordinates.
			zoomAt(stage.left + stage.width / 2 / stage.dpr, stage.top + stage.height / 2 / stage.dpr, factor);
		},
		/** The whole picture again. */
		fit() {
			state.view = { zoom: 1, x: (state.preview?.width ?? 0) / 2, y: (state.preview?.height ?? 0) / 2 };
			repaint();
		},
		zoom: () => state.view.zoom,
		setTolerance(value) {
			state.tolerance = clamp(Number(value) || 0, 0.01, 0.9);
		},
		setBrush(value) {
			state.brush = clamp(Number(value) || 1, 2, 200);
		},
		/** "paint" lays purple down; "erase" takes it off. */
		setMode(mode) {
			state.mode = mode === "erase" ? "erase" : "paint";
		},
		mode: () => state.mode,
		tolerance: () => state.tolerance,
		/** Back to the untouched photograph. */
		clear() {
			if (!state.paint) return;
			state.paint.fill(0);
			commit();
			repaint();
		},
		/** One decision back, and forward again. */
		undo: () => step(-1),
		redo: () => step(1),
		canUndo: () => state.at > 0,
		canRedo: () => state.at >= 0 && state.at < state.history.length - 1,
		hasPaint: () => !!state.paint?.some((value) => value === 1),
		/**
		 * What the cutter needs: the purple, at the picture's own resolution.
		 * No tolerance travels with it — the growth already happened, on screen,
		 * where it could be corrected.
		 */
		options() {
			return state.paint && this.hasPaint()
				? { mask: state.paint, maskWidth: state.full.width, maskHeight: state.full.height }
				: null;
		},
		dispose() {
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointercancel", onUp);
			canvas.removeEventListener("pointerleave", onUp);
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("keydown", onKeyDown);
			canvas.removeEventListener("keyup", onKeyUp);
		},
	};
}
