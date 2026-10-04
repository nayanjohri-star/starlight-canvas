import { TIMELINE_FRAME_FPS } from "../scenes.js";

const PROMPT_BLOCK_FRAMES = 2 * TIMELINE_FRAME_FPS;
const PROMPT_RESIZE_BLOCK_PX = 120; // one deliberate drag step = one prompt block

/** Resize from the immutable pointer-down frame. Keeping both the frame and
 * pixel origin fixed prevents a growing timeline from feeding its new frame
 * count back into the next pointermove and exploding exponentially. */
export function promptResizeFrame(startFrame, startClientX, clientX) {
	const blocks = (clientX - startClientX) / PROMPT_RESIZE_BLOCK_PX;
	const blockDelta = Math.sign(blocks) * Math.round(Math.abs(blocks));
	return startFrame + blockDelta * PROMPT_BLOCK_FRAMES;
}
