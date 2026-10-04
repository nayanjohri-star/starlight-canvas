/** Keyboard layout controls must never consume typing or IME composition. */
export function viewportShortcut(event, maximized) {
	if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;
	if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return null;
	if (event.code === "Space" && event.shiftKey) return "maximize";
	if (event.key === "Escape" && maximized) return "restore";
	return null;
}

export function resizeLayoutWithKey(layout, kind, event, bounds) {
	const step = event.shiftKey ? 40 : 10;
	if (kind === "timeline") {
		if (!["ArrowUp", "ArrowDown"].includes(event.key)) return null;
		return { ...layout, timelineHeight: Math.max(110, Math.min(bounds.height * 0.58, layout.timelineHeight + (event.key === "ArrowUp" ? step : -step))) };
	}
	if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return null;
	const delta = event.key === "ArrowRight" ? step : -step;
	return kind === "hierarchy"
		? { ...layout, hierarchyWidth: Math.max(220, Math.min(bounds.width * 0.4, layout.hierarchyWidth + delta)) }
		: { ...layout, sidebarWidth: Math.max(280, Math.min(bounds.width * 0.5, layout.sidebarWidth - delta)) };
}
