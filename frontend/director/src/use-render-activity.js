import { useEffect, useState } from "react";

export const RENDER_ACTIVITY_KEYS = new Set([
	"KeyW",
	"KeyA",
	"KeyS",
	"KeyD",
	"KeyQ",
	"KeyE",
]);
export const RENDER_ACTIVITY_EVENT = "cozyclay-render-activity";

export function hasContinuousRenderActivity(pointerIds, keyCodes, transient) {
	return pointerIds.size > 0 || keyCodes.size > 0 || transient;
}

/**
 * Camera navigation cannot change the rig silhouette, so its exposure result
 * can stay cached until the gesture settles. Pose changes remain immediate.
 */
export function shouldRefreshIkExposure({ cameraGesture, cameraGestureEnded, exposureDirty, poseDirty, elapsedMs, throttleMs = 100 }) {
	if (!exposureDirty) return false;
	if (cameraGesture) return false;
	if (cameraGestureEnded || poseDirty) return true;
	return elapsedMs >= throttleMs;
}

/**
 * Keep the WebGL loop hot only while the user is actively manipulating the
 * scene. React/R3F still invalidates demand frames for ordinary state changes;
 * this hook covers direct ref mutations such as IK drags, camera look/dolly,
 * plan puck drags, scrubbing, and held WASD/QE movement.
 */
export function useRenderActivity(alwaysActive) {
	const [interactive, setInteractive] = useState(false);

	useEffect(() => {
		const pointerIds = new Set();
		const keyCodes = new Set();
		let transient = false;
		let transientTimer = null;
		const sync = () => setInteractive(hasContinuousRenderActivity(pointerIds, keyCodes, transient));
		const endTransient = () => {
			transient = false;
			transientTimer = null;
			sync();
		};
		const pulse = () => {
			transient = true;
			if (transientTimer !== null) clearTimeout(transientTimer);
			transientTimer = setTimeout(endTransient, 180);
			sync();
		};
		const onPointerDown = (event) => {
			// Right-button fly navigation invalidates explicitly from
			// FlyControls. It must not switch the whole canvas to an
			// always-running loop, because the split renderer would repaint
			// frozen panes on every RAF.
			if (event.button === 2) return;
			pointerIds.add(event.pointerId);
			sync();
		};
		const onPointerEnd = (event) => {
			if (event.button === 2) return;
			pointerIds.delete(event.pointerId);
			sync();
		};
		const onKeyDown = (event) => {
			if (!RENDER_ACTIVITY_KEYS.has(event.code)) return;
			const element = document.activeElement;
			if (element && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return;
			keyCodes.add(event.code);
			sync();
		};
		const onKeyUp = (event) => {
			if (!RENDER_ACTIVITY_KEYS.has(event.code)) return;
			keyCodes.delete(event.code);
			sync();
		};
		const reset = () => {
			pointerIds.clear();
			keyCodes.clear();
			transient = false;
			if (transientTimer !== null) clearTimeout(transientTimer);
			transientTimer = null;
			sync();
		};

		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("pointerup", onPointerEnd, true);
		window.addEventListener("pointercancel", onPointerEnd, true);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("wheel", pulse, { capture: true, passive: true });
		window.addEventListener("blur", reset);
		return () => {
			if (transientTimer !== null) clearTimeout(transientTimer);
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("pointerup", onPointerEnd, true);
			window.removeEventListener("pointercancel", onPointerEnd, true);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("wheel", pulse, true);
			window.removeEventListener("blur", reset);
		};
	}, []);

	const active = alwaysActive || interactive;
	useEffect(() => {
		window.dispatchEvent(new CustomEvent(RENDER_ACTIVITY_EVENT, { detail: active }));
	}, [active]);
	return active;
}
