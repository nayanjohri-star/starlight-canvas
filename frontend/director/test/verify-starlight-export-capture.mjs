import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createOffscreenCapture } from '../src/offscreen-capture.js';
import { renderPass } from '../src/render-passes.js';

const targets = [];
class Target extends THREE.WebGLRenderTarget {
	constructor(...args) { super(...args); this.disposals = 0; this.addEventListener('dispose', () => this.disposals++); targets.push(this); }
}
const camera = new THREE.PerspectiveCamera(45, 16 / 9, .1, 100); camera.position.set(1, 2, 3); camera.layers.enable(5);
const scene = new THREE.Scene(); scene.fog = new THREE.Fog('white', 20, 50); scene.background = new THREE.Color('white');
const viewport = {}, masks = []; let current = viewport, rendered, lost = false, failure = null, loseOnRender = false;
const renderer = {
	shadowMap: { autoUpdate: false, needsUpdate: false },
	getContext: () => ({ isContextLost: () => lost }), getRenderTarget: () => current,
	setRenderTarget: target => current = target,
	render(_, value) {
		rendered = value; assert.deepEqual([scene.fog.near, scene.fog.far], [55, 95]);
		assert.equal(renderer.shadowMap.autoUpdate, false);
		assert.equal(renderer.shadowMap.needsUpdate, true, 'a frozen editor shadow is refreshed for each addressed capture');
		renderer.shadowMap.needsUpdate = false;
		if (loseOnRender) lost = true;
	},
	readRenderTargetPixels(target, _x, _y, width, height, bytes) { if (failure) throw failure; assert.equal(target.disposals, 0); assert.equal(bytes.length, width * height * 4); bytes.fill(177); },
};
const create = (width, height) => createOffscreenCapture({ renderer, scene, getCamera: () => camera, width, height, gizmoLayer: 5, onCameraMask: mask => masks.push(mask), RenderTargetClass: Target });
const live = create(16, 9), output = create(12, 7);
assert.equal(targets[1].samples, 4, 'direct geometry captures retain their own antialiasing');
assert.equal(output.render().length, 12 * 7 * 4); assert.equal(rendered.aspect, 12 / 7); assert.equal(camera.aspect, 16 / 9);
assert.equal(masks.at(-1) & (1 << 5), 0, 'selection/grid/handles share the excluded editor layer'); assert.equal(camera.layers.mask & (1 << 5), 1 << 5);
assert.equal(current, viewport); assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50]);
assert.deepEqual(renderer.shadowMap, { autoUpdate: false, needsUpdate: true }, 'the restored live pose invalidates the exported shadow');
live.dispose(); const resized = create(9, 16); assert.equal(resized.render().length, 9 * 16 * 4); assert.equal(output.render().length, 12 * 7 * 4);
failure = new Error('readback failed'); assert.throws(() => output.render(), error => error === failure); failure = null;
assert.equal(current, viewport); assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50]);
lost = true; assert.throws(() => output.render(), { exportFailureCode: 'render_failed' }); lost = false;
loseOnRender = true; assert.throws(() => output.render(), { exportFailureCode: 'render_failed' }); loseOnRender = false; lost = false;
assert.equal(current, viewport); assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50]);
const previousBackground = scene.background, previousMaterial = scene.overrideMaterial;
failure = new Error('depth failed'); assert.throws(() => renderPass(output, scene, camera, 'depth'), /depth failed/); failure = null;
assert.equal(scene.background, previousBackground); assert.equal(scene.overrideMaterial, previousMaterial); assert.equal(current, viewport);
output.dispose(); output.dispose(); assert.equal(targets[1].disposals, 1); assert.throws(() => output.render(), /disposed/);
resized.dispose(); assert.ok(targets.every(target => target.disposals === 1));
let draws = 0, extraDisposals = 0;
const focused = createOffscreenCapture({ renderer, scene, getCamera: () => camera, width: 7, height: 5, gizmoLayer: 5, RenderTargetClass: Target,
	renderScene(args) { assert.equal(args.renderer, renderer); assert.equal(args.scene, scene); assert.equal(args.target, current); assert.equal(args.camera.aspect, 7 / 5); assert.equal(args.camera.layers.mask & (1 << 5), 0); draws++; },
	disposeRenderScene() { extraDisposals++; },
});
assert.equal(targets.at(-1).samples, 0, 'the already antialiased color pass is copied without a second resolve');
assert.equal(targets.at(-1).depthBuffer, false);
assert.equal(targets.at(-1).texture.colorSpace, THREE.NoColorSpace, 'display bytes must not receive another hardware sRGB conversion');
assert.equal(focused.render().length, 7 * 5 * 4); focused.dispose(); focused.dispose(); assert.equal(draws, 1); assert.equal(extraDisposals, 1); assert.equal(targets.at(-1).disposals, 1);
assert.throws(() => create(1.1, 2), /dimensions/);
console.log('PASS owned real render targets: clean cloned camera, PNG/video size parity, independent resize, context loss, failure restoration and idempotent cleanup');
