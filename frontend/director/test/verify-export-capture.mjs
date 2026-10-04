import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createFocusedRenderer } from "../src/focused-render.js";
import { createOffscreenCapture } from "../src/offscreen-capture.js";

// Exercise the CaptureRig effect through its public ref, with real cameras and
// production capture/focus factories, real targets and real Three Output/Bokeh
// passes. Renderer calls are a CPU boundary spy, not pixel/rasterisation proof.
const source = readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");
const component = source.slice(source.indexOf("export function CaptureRig("), source.indexOf("export async function captureMcpFrame("));
const targets = [];
const resources = new Map(), outputDraws = new Map();
function observe(resource) {
	if (!resources.has(resource)) {
		const record = { disposals: 0 }; resources.set(resource, record);
		resource.addEventListener("dispose", () => record.disposals++);
	}
	return resource;
}
class RenderTarget extends THREE.WebGLRenderTarget {
	constructor(...args) {
		super(...args);
		this.disposals = 0;
		this.addEventListener("dispose", () => { this.disposals += 1; });
		targets.push(this);
		observe(this);
	}
}
const scene = new THREE.Scene();
scene.fog = new THREE.Fog("white", 20, 50);
const initialTarget = { editor: true };
let currentTarget = initialTarget;
let capturedCamera;
let sceneTarget;
let readbackError = null;
const viewport = new THREE.Vector4(3, 4, 100, 60), scissor = new THREE.Vector4(5, 6, 70, 40);
const clearColor = new THREE.Color(0x224466); let clearAlpha = 0.3, scissorTest = true;
const gl = {
	autoClear: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
	getContext: () => ({ isContextLost: () => false }),
	getRenderTarget: () => currentTarget,
	setRenderTarget: (target) => { if (target?.isWebGLRenderTarget) observe(target); currentTarget = target; },
	getViewport: value => value.copy(viewport), setViewport: value => viewport.copy(value),
	getScissor: value => value.copy(scissor), setScissor: value => scissor.copy(value),
	getScissorTest: () => scissorTest, setScissorTest: value => { scissorTest = value; },
	getClearColor: value => value.copy(clearColor), getClearAlpha: () => clearAlpha,
	setClearColor: (value, alpha) => { clearColor.set(value); if (alpha !== undefined) clearAlpha = alpha; },
	setClearAlpha: value => { clearAlpha = value; }, clear() {},
	render(object, camera) {
		if (object === scene) {
			capturedCamera = camera; sceneTarget = currentTarget;
			assert.deepEqual([scene.fog.near, scene.fog.far], [55, 95]);
			if (scene.overrideMaterial) observe(scene.overrideMaterial);
		} else {
			assert.ok(object.isMesh, "real Three full-screen pass reaches the renderer boundary");
			observe(object.material);
			if (object.material.isRawShaderMaterial) {
				assert.match(object.material.fragmentShader, /texelFetch/);
				assert.ok(object.material.uniforms.tDiffuse.value?.isTexture);
				assert.ok(Object.hasOwn(object.material.defines, "ACES_FILMIC_TONE_MAPPING"));
				assert.ok(Object.hasOwn(object.material.defines, "SRGB_TRANSFER"));
				outputDraws.set(currentTarget, object.material);
			} else assert.ok(object.material.uniforms.tDepth.value?.isTexture, "real BokehPass uses its depth texture");
		}
	},
	readRenderTargetPixels(target, _x, _y, width, height, buffer) {
		assert.equal(target.width, width);
		assert.equal(target.height, height);
		assert.equal(target.disposals, 0, "capture target is still owned");
		assert.ok(outputDraws.has(target), "readback follows the production OutputPass draw into this target");
		if (readbackError) throw readbackError;
		buffer.fill(127);
	},
};
const renderState = () => ({ target: currentTarget, viewport: viewport.toArray(), scissor: scissor.toArray(), scissorTest,
	autoClear: gl.autoClear, toneMapping: gl.toneMapping, outputColorSpace: gl.outputColorSpace, clearColor: clearColor.getHex(), clearAlpha,
	override: scene.overrideMaterial });
const initialState = renderState();
let cleanup;
const browser = {};
const CaptureRig = new Function("createFocusedRenderer", "createOffscreenCapture", "useThree", "useEffect", "window", "GIZMO_LAYER",
	"CAPTURE_W", "CAPTURE_H", "MCP_CAPTURE_W", "MCP_CAPTURE_H", "CAPTURE_FOG_NEAR", "CAPTURE_FOG_FAR",
	`${component.replace("export function", "function")}; return CaptureRig;`)(
	createFocusedRenderer, options => createOffscreenCapture({ ...options, RenderTargetClass: RenderTarget }),
	() => ({ gl, scene }), (effect) => { cleanup = effect(); },
	browser, 5, 1920, 1080, 640, 360, 55, 95,
);
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100);
camera.position.set(1, 2, 3);
camera.layers.enable(5);
const apiRef = { current: null };
const camRef = { current: camera };
CaptureRig({ apiRef, camRef, width: 16, height: 9 });
const editorApi = apiRef.current;
assert.equal(editorApi.render().byteLength, 16 * 9 * 4);
const editorColor = sceneTarget, editorOutput = outputDraws.get(targets[0]);
const exportApi = editorApi.createExportCapture({ width: 12, height: 7 });
assert.equal(exportApi.scene, scene);
assert.equal(exportApi.render().byteLength, 12 * 7 * 4);
const exportColor = sceneTarget, exportOutput = outputDraws.get(targets[1]);
assert.notEqual(editorColor, exportColor, "preview and export own independent production color targets");
assert.notEqual(editorOutput, exportOutput, "preview and export own independent real OutputPass materials");
assert.equal(targets[1].samples, 0, "OutputPass writes to the non-multisampled delivery target");
assert.equal(capturedCamera.aspect, 12 / 7);
assert.equal(capturedCamera.layers.isEnabled(5), false);
assert.equal(camera.aspect, 16 / 9, "export never changes the editing camera aspect");
assert.equal(camera.layers.isEnabled(5), true);
assert.equal(currentTarget, initialTarget);
assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50]);
assert.deepEqual(renderState(), initialState, "successful capture restores its original editor render state");

cleanup();
assert.equal(targets[0].disposals, 1, "editor resize releases its own target");
assert.equal(resources.get(editorColor).disposals, 1);
assert.equal(resources.get(editorOutput).disposals, 1);
assert.equal(targets[1].disposals, 0, "in-flight export target survives editor resize");
assert.equal(resources.get(exportColor).disposals, 0);
assert.equal(resources.get(exportOutput).disposals, 0);
assert.equal(apiRef.current, null, "effect cleanup removes only its current preview API");
CaptureRig({ apiRef, camRef, width: 9, height: 16 });
assert.equal(apiRef.current.render().byteLength, 9 * 16 * 4);
assert.equal(exportApi.render().byteLength, 12 * 7 * 4, "retry settings remain independent of live dimensions");
camera.userData.focus = { depthOfField: true, focusDistance: 3, fStop: 4 };
assert.equal(exportApi.render().byteLength, 12 * 7 * 4, "production focus path still renders to the attempt target");
assert.ok([...resources.keys()].some(target => target.texture?.name === "BokehPass.depth"), "actual Bokeh depth target was used");
assert.deepEqual(renderState(), initialState, "production focus pass restores editor render state");

readbackError = new Error("injected readback failure");
assert.throws(() => exportApi.render(), (error) => error === readbackError);
assert.equal(currentTarget, initialTarget, "failed capture restores render target");
assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50], "failed capture restores fog");
assert.deepEqual(renderState(), initialState, "failed focused capture restores viewport, scissor, output and clear state");
exportApi.dispose();
exportApi.dispose();
assert.equal(targets[1].disposals, 1, "attempt cleanup releases the export target");
assert.equal(resources.get(exportColor).disposals, 1);
assert.equal(resources.get(exportOutput).disposals, 1);
assert.equal(targets[2].disposals, 0, "attempt cleanup does not dispose the live preview");
assert.throws(() => exportApi.render(), /disposed/);
cleanup();
assert.ok(targets.every((target) => target.disposals === 1));
assert.ok([...resources.values()].every(resource => resource.disposals === 1), "all real target/pass material resources release exactly once");
console.log("PASS CaptureRig with production focus/output/Bokeh passes: independent dimensions, resize survival, failure restoration and exact resource disposal (CPU boundary)");
