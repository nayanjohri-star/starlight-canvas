#!/usr/bin/env node
// Depth/normal passes (#165). The override material is borrowed from the LIVE
// scene the viewport draws from, so the only thing that keeps the studio from
// turning permanently grey is putting it back. These checks pin the naming and
// that restore, including on a render that throws.
import assert from "node:assert/strict";
import * as THREE from "three";
import { WebGLPrograms } from "three/src/renderers/webgl/WebGLPrograms.js";
import { passFileName, renderPass, PASS_KINDS, DEPTH_RANGE_M } from "../src/render-passes.js";
import { createProceduralRig, disposeProceduralRig } from "../src/procedural-rig.js";

assert.equal(passFileName("depth"), "blocking-frame-depth.png");
assert.equal(passFileName("normal"), "blocking-frame-normal.png");
assert.throws(() => passFileName("albedo"), /Unknown render pass: albedo/, "an unknown pass is a hard error, not a mystery file name");
assert.deepEqual(PASS_KINDS, ["depth", "normal"]);
console.log("PASS render passes: file names for depth and normal, unknown kinds rejected");

// A stub rig that records what the scene looked like at the moment of the draw.
function stubCapture(scene, { fail = false } = {}) {
	const seen = [];
	const backgrounds = [];
	return {
		seen,
		backgrounds,
		render() {
			seen.push(scene.overrideMaterial);
			backgrounds.push(scene.background);
			if (fail) throw new Error("context lost");
			return new Uint8Array([1, 2, 3, 255]);
		},
	};
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.25, 100);

const depthRig = stubCapture(scene);
const depthBuffer = renderPass(depthRig, scene, camera, "depth");
assert.equal(depthRig.seen.length, 1, "the depth pass renders exactly once");
assert.ok(depthRig.seen[0] instanceof THREE.ShaderMaterial, "the depth pass overrides with the depth-to-grey shader");
assert.equal(depthRig.seen[0].uniforms.uNear.value, 0.25, "the ramp starts at the shot camera's near plane");
assert.equal(depthRig.seen[0].uniforms.uRange.value, DEPTH_RANGE_M, "the ramp spans the stage's working depth");
assert.equal(depthRig.seen[0].fog, false, "the stage fog does not tint the depth plate");
assert.match(depthRig.seen[0].fragmentShader, /1\.0 - normalized/, "near reads white, far reads black");
assert.equal(scene.overrideMaterial, null, "the depth override is taken back off the scene");
assert.deepEqual([...depthBuffer], [1, 2, 3, 255], "without a converter the raw read-back comes back");

// CPU regression for the live character's depth draw. Three selects skinning
// per object, not through an obsolete ShaderMaterial.skinning flag. Verify the
// actual program parameters and standard chunks, then follow their matrix path
// using the production rig's bone-texture data. Native rasterisation is checked
// separately; this test deliberately creates no WebGL context.
const depthMaterial = depthRig.seen[0];
const rig = createProceduralRig();
rig.scale.setScalar(0.01);
rig.position.set(0.6, 0.2, -0.4);
rig.rotation.y = 0.35;
scene.add(rig);
const mesh = rig.getObjectByName("Starlight_Surface");
assert.ok(mesh?.isSkinnedMesh, "the fixture is the shipped, bone-weighted character surface");
const programs = WebGLPrograms({
	getRenderTarget: () => null,
	state: { buffers: { depth: { getReversed: () => false } } },
	toneMapping: THREE.NoToneMapping,
	outputColorSpace: THREE.LinearSRGBColorSpace,
	shadowMap: { enabled: false, type: THREE.PCFShadowMap },
}, { get: () => null }, { has: () => false }, {
	precision: "highp", logarithmicDepthBuffer: false, getMaxPrecision: value => value,
}, {}, { numPlanes: 0, numIntersection: 0 });
const lights = Object.fromEntries([
	"directional", "point", "spot", "spotLightMap", "rectArea", "hemi",
	"directionalShadowMap", "pointShadowMap", "spotShadowMap",
].map(key => [key, []]));
lights.numSpotLightShadowsWithMaps = 0;
lights.numLightProbes = 0;
const parameters = programs.getParameters(depthMaterial, lights, [], scene, mesh, []);
assert.equal(parameters.skinning, true, "Three enables USE_SKINNING for the real depth override draw");
assert.equal(parameters.vertexShader, depthMaterial.vertexShader);
const plainMesh = new THREE.Mesh(mesh.geometry, depthMaterial);
assert.equal(programs.getParameters(depthMaterial, lights, [], scene, plainMesh, []).skinning, false,
	"ordinary stage geometry still uses the non-skinned branch of the same override");

const chunks = [...parameters.vertexShader.matchAll(/#include <([^>]+)>/g)].map(match => match[1]);
const pipeline = ["skinning_pars_vertex", "skinbase_vertex", "begin_vertex", "skinning_vertex", "project_vertex"];
let previousChunk = -1;
for (const chunk of pipeline) {
	const index = chunks.indexOf(chunk);
	assert.ok(index > previousChunk, `${chunk} is present in the standard skinning-to-projection order`);
	previousChunk = index;
}
const resolved = parameters.vertexShader.replace(/#include <([^>]+)>/g, (_, chunk) => {
	assert.equal(typeof THREE.ShaderChunk[chunk], "string", `Three provides ${chunk}`);
	return THREE.ShaderChunk[chunk];
});
assert.match(resolved, /getBoneMatrix\(\s*skinIndex\.x\s*\)/, "bone texture matrices enter the shader");
assert.match(resolved, /transformed\s*=\s*\(\s*bindMatrixInverse\s*\*\s*skinned\s*\)\.xyz/);
assert.match(resolved, /vec4 mvPosition\s*=\s*vec4\(\s*transformed,\s*1\.0\s*\)/);
assert.match(resolved, /gl_Position\s*=\s*projectionMatrix\s*\*\s*mvPosition;\s*vViewDepth\s*=\s*-mvPosition\.z;/,
	"both rasterised position and linear depth use the posed view-space vertex");
assert.doesNotMatch(parameters.vertexShader, /vec4\(\s*position,/, "depth cannot bypass skinning with the bind vertex");

const shotCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.25, 100);
shotCamera.position.set(3, 2, 6);
shotCamera.lookAt(0, 1, 0);
shotCamera.updateMatrixWorld(true);
mesh.skeleton.computeBoneTexture();
const skinIndices = mesh.geometry.attributes.skinIndex;
const vertexForBone = name => {
	const boneIndex = mesh.skeleton.bones.findIndex(bone => bone.name === name);
	for (let index = 0; index < skinIndices.count; index++) if (skinIndices.getX(index) === boneIndex) return index;
	assert.fail(`production surface has no weighted vertex for ${name}`);
};
const armVertex = vertexForBone("mixamorigRightForeArm");
const bodyVertex = vertexForBone("mixamorigHips");
function posedDepth(index) {
	scene.updateMatrixWorld(true);
	mesh.skeleton.update();
	const bindVertex = new THREE.Vector4().fromArray([
		...new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index).toArray(), 1,
	]).applyMatrix4(mesh.bindMatrix);
	const skinned = new THREE.Vector4(0, 0, 0, 0);
	for (let channel = 0; channel < 4; channel++) {
		const boneIndex = skinIndices.getComponent(index, channel);
		const weight = mesh.geometry.attributes.skinWeight.getComponent(index, channel);
		const boneMatrix = new THREE.Matrix4().fromArray(mesh.skeleton.boneTexture.image.data, boneIndex * 16);
		skinned.add(bindVertex.clone().applyMatrix4(boneMatrix).multiplyScalar(weight));
	}
	skinned.applyMatrix4(mesh.bindMatrixInverse);
	const transformed = new THREE.Vector3(skinned.x, skinned.y, skinned.z);
	const actualPosedVertex = mesh.getVertexPosition(index, new THREE.Vector3());
	assert.ok(transformed.distanceTo(actualPosedVertex) < 0.0001,
		"shader bone-texture path agrees with Three's actual deformed mesh vertex");
	const modelView = new THREE.Matrix4().multiplyMatrices(shotCamera.matrixWorldInverse, mesh.matrixWorld);
	return -transformed.applyMatrix4(modelView).z;
}
const restArmDepth = posedDepth(armVertex), restBodyDepth = posedDepth(bodyVertex);
rig.getObjectByName("mixamorigRightArm").rotation.x = 0.8;
const movingArmDepth = posedDepth(armVertex), movingBodyDepth = posedDepth(bodyVertex);
assert.ok(Math.abs(movingArmDepth - restArmDepth) > 0.02, "moving the real arm changes its linear view depth");
assert.ok(Math.abs(movingBodyDepth - restBodyDepth) < 1e-7, "the unmoved torso keeps its depth");
const grey = value => 1 - THREE.MathUtils.clamp((value - camera.near) / (DEPTH_RANGE_M - camera.near), 0, 1);
assert.notEqual(grey(movingArmDepth), grey(restArmDepth), "the posed depth reaches the delivered grey ramp");
scene.remove(rig);
disposeProceduralRig(rig);
programs.dispose();
console.log("PASS render passes: production bone-texture deformation enters depth and projection; static geometry stays stable (CPU)");

// Empty sky is infinitely far away: on a depth plate it reads black, not the
// studio's pale stage colour.
const stageBackground = new THREE.Color("#eef4f3");
scene.background = stageBackground;
const backgroundRig = stubCapture(scene);
renderPass(backgroundRig, scene, camera, "depth");
assert.equal(backgroundRig.backgrounds[0].getHex(), 0x000000, "the depth pass draws over a black sky");
assert.equal(scene.background, stageBackground, "the stage colour is put back after the depth pass");
const normalBackgroundRig = stubCapture(scene);
renderPass(normalBackgroundRig, scene, camera, "normal");
assert.equal(normalBackgroundRig.backgrounds[0], stageBackground, "the normal pass leaves the sky alone");
scene.background = null;

const normalRig = stubCapture(scene);
const dataUrl = renderPass(normalRig, scene, camera, "normal", (buffer) => `data:image/png;base64,${buffer.length}`);
assert.ok(normalRig.seen[0] instanceof THREE.MeshNormalMaterial, "the normal pass overrides with MeshNormalMaterial");
assert.equal(scene.overrideMaterial, null, "the normal override is taken back off the scene");
assert.equal(dataUrl, "data:image/png;base64,4", "the buffer goes through the caller's PNG encoder");
console.log("PASS render passes: overrideMaterial is set for the draw and restored after");

// A pass taken while another override is in place must restore THAT one, not null.
const existing = new THREE.MeshBasicMaterial();
scene.overrideMaterial = existing;
renderPass(stubCapture(scene), scene, camera, "depth");
assert.equal(scene.overrideMaterial, existing, "an override that was already in place survives the pass");
scene.overrideMaterial = null;

// A render that throws still gives the scene back.
const brokenRig = stubCapture(scene, { fail: true });
assert.throws(() => renderPass(brokenRig, scene, camera, "normal"), /context lost/);
assert.equal(scene.overrideMaterial, null, "a failed render does not leave the studio wearing the pass material");
console.log("PASS render passes: a failed render restores the scene material");

// Missing rig, scene or camera is "not ready", not a crash.
assert.equal(renderPass(null, scene, camera, "depth"), null);
assert.equal(renderPass(stubCapture(scene), null, camera, "depth"), null);
assert.equal(renderPass(stubCapture(scene), scene, null, "depth"), null);
// A rig that renders nothing (no shot camera yet) reports nothing.
assert.equal(renderPass({ render: () => null }, scene, camera, "depth", () => "never"), null);
assert.throws(() => renderPass(stubCapture(scene), scene, camera, "albedo"), /Unknown render pass/);
assert.equal(scene.overrideMaterial, null, "the rejected kind never touched the scene");
console.log("PASS render passes: an unready rig reports null instead of throwing");
