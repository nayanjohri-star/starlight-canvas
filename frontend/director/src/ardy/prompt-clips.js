/** Move one prompt clip on the fixed prompt-block grid without changing its
 * duration. Segment generation needs at most one prompt per frame range, so a
 * snapped position that lands inside a neighbor clamps to abut that neighbor
 * instead of overlapping; gaps remain valid and inherit the main prompt.
 *
 * Clock-agnostic: `blockFrames` is the caller's grid, and App.jsx always
 * passes ARDY_PROMPT_HORIZON_FRAMES (2 s on the 24 fps timeline clock = 48).
 * The 40 default is only the bare-call fallback and means nothing on the
 * wire — nothing here ever reaches the bridge unconverted. */
export function movePromptClipFrames(clips, id, rawStartFrame, blockFrames = 40) {
	const target = clips.find((clip) => clip.id === id);
	if (!target) return clips;
	const duration = target.endFrame - target.startFrame;
	let startFrame = Math.max(0, Math.round(rawStartFrame / blockFrames) * blockFrames);
	// Generated takes lay clips off the block grid (phase seconds are free-form),
	// so every grid position near an off-grid neighbor can overlap it — the clip
	// would refuse to move at all. Slide to touch the neighbor's nearest edge.
	const others = clips.filter((clip) => clip.id !== id);
	for (const clip of others) {
		if (startFrame < clip.endFrame && startFrame + duration > clip.startFrame) {
			const mid = (clip.startFrame + clip.endFrame) / 2;
			startFrame = rawStartFrame + duration / 2 <= mid ? clip.startFrame - duration : clip.endFrame;
		}
	}
	const endFrame = startFrame + duration;
	if (startFrame < 0 || startFrame === target.startFrame) return clips;
	const overlaps = others.some((clip) => startFrame < clip.endFrame && endFrame > clip.startFrame);
	if (overlaps) return clips;
	return clips.map((clip) => clip.id === id ? { ...clip, startFrame, endFrame } : clip);
}
