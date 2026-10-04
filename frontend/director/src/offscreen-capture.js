import * as THREE from 'three';
import { validatePixelDimensions } from './export-pixels.js';

const renderError = message => Object.assign(new Error(message), { exportFailureCode: 'render_failed' });

/** One owned render target per attempt; the live viewport may resize independently. */
export function createOffscreenCapture({ renderer, scene, getCamera, width, height, gizmoLayer, fogNear = 55, fogFar = 95, onCameraMask = null, renderScene = null, disposeRenderScene = null, RenderTargetClass = THREE.WebGLRenderTarget }) {
	const byteLength = validatePixelDimensions(width, height);
	let buffer = new Uint8Array(byteLength), disposed = false;
	// The shared OutputPass already writes display-encoded sRGB bytes. Use an
	// ordinary RGBA8 attachment, or SRGB8_ALPHA8 would encode those bytes again.
	// The color pass already antialiases the geometry. A full-screen output copy
	// needs neither another multisample resolve nor a depth attachment.
	const target = new RenderTargetClass(width, height, { colorSpace: THREE.NoColorSpace,
		samples: renderScene ? 0 : 4, depthBuffer: !renderScene });
	const assertContext = () => {
		if (renderer.getContext?.()?.isContextLost?.()) throw renderError('WebGL context was lost during export. Restore the scene and retry.');
	};
	return {
		scene, width, height,
		dispose() { if (disposed) return; disposed = true; buffer = null; try { disposeRenderScene?.(); } finally { target.dispose(); } },
		render() {
			if (disposed) throw renderError('Export capture has been disposed');
			assertContext();
			const source = getCamera(); if (!source) return null;
			const camera = source.clone();
			if (Number.isInteger(gizmoLayer)) camera.layers.disable(gizmoLayer);
			onCameraMask?.(camera.layers.mask);
			camera.aspect = width / height; camera.updateProjectionMatrix();
			const previous = renderer.getRenderTarget(), fog = scene.fog, near = fog?.near, far = fog?.far;
			const shadow = renderer.shadowMap, shadowAutoUpdate = shadow?.autoUpdate;
			try {
				if (fog) { fog.near = fogNear; fog.far = fogFar; }
				// Camera navigation may freeze the editor shadow map. Addressed export
				// poses still need one shadow update before their color draw.
				if (shadow) { shadow.autoUpdate = false; shadow.needsUpdate = true; }
				renderer.setRenderTarget(target);
				const rendered = renderScene ? renderScene({ renderer, scene, camera, target, width, height }) : renderer.render(scene, camera);
				if (rendered?.then) throw renderError('Export rendering must finish synchronously before readback');
				assertContext();
				renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer);
				assertContext();
				return buffer;
			} finally {
				try { renderer.setRenderTarget(previous); }
				finally {
					if (fog) { fog.near = near; fog.far = far; }
					// The live pose is restored by the caller, so the exported shadow
					// texture is now stale even when navigation keeps auto updates off.
					if (shadow) { shadow.autoUpdate = shadowAutoUpdate; shadow.needsUpdate = true; }
				}
			}
		},
	};
}
