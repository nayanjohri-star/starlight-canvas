// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual Three CPU objects; supplied counters are explicitly not GPU evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDirectorSceneBudget } from './fixtures/director-scene-budget.mjs';
const THREE = await import(new URL('../../director/node_modules/three/build/three.module.js', import.meta.url));
const cpuRenderer = () => ({ info: { autoReset: true, render: { frame: 1, calls: 3, triangles: 36, points: 0, lines: 4 }, memory: { geometries: 1, textures: 1 } } });
test('actual BoxGeometry topology/shared instances and texture sizes are deduplicated', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), geometry = new THREE.BoxGeometry();
  const data = new Uint8Array(4 * 8 * 4), map = new THREE.DataTexture(data, 4, 8), material = new THREE.MeshStandardMaterial({ map });
  scene.add(new THREE.Mesh(geometry, material), new THREE.InstancedMesh(geometry, material, 2));
  const snapshot = inspectDirectorSceneBudget(scene, cpuRenderer(), camera);
  assert.equal(snapshot.uniqueGeometries, 1); assert.equal(snapshot.uniqueTopologyTriangles, 12); assert.equal(snapshot.instancedTopologyTriangles, 36);
  assert.equal(snapshot.uniqueTextures, 1); assert.deepEqual(snapshot.textures[0].faces, [{ width: 4, height: 8, sourceTypedArrayBytes: 128 }]);
  assert.equal(snapshot.rgba8BaseLevelEquivalentBytes, 128); assert.equal(snapshot.rgba8FullMipChainEquivalentBytes, 172);
  assert.equal(snapshot.cpuGeometryBufferBytes, 840); assert.equal(snapshot.actualDrawCounters.triangles, 36);
  assert.match(snapshot.textureEstimateScope, /not measured GPU allocation/);
});
test('hidden parents/materials and other camera layers do not inflate the visible inventory', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), geometry = new THREE.BoxGeometry();
  const visible = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); scene.add(visible);
  const hidden = new THREE.Group(); hidden.visible = false; hidden.add(new THREE.Mesh(geometry, visible.material)); scene.add(hidden);
  const other = new THREE.Mesh(geometry, visible.material); other.layers.set(3); scene.add(other);
  const hiddenMaterial = new THREE.MeshStandardMaterial(); hiddenMaterial.visible = false; scene.add(new THREE.Mesh(geometry, hiddenMaterial));
  assert.equal(inspectDirectorSceneBudget(scene, cpuRenderer(), camera).visibleMeshCandidates, 1);
});
test('cube faces, environment and uniform reuse retain real dimensions without treating estimates as GPU capacity', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const env = new THREE.CubeTexture(Array.from({ length: 6 }, () => ({ width: 2, height: 2 }))); scene.environment = env;
  const material = new THREE.ShaderMaterial({ uniforms: { source: { value: { array: [env, env] } } } }); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
  const snapshot = inspectDirectorSceneBudget(scene, cpuRenderer(), camera);
  assert.equal(snapshot.uniqueTextures, 1); assert.equal(snapshot.rgba8BaseLevelEquivalentBytes, 96); assert.equal(snapshot.rgba8FullMipChainEquivalentBytes, 120);
  assert.equal(snapshot.textures[0].faces.length, 6); assert.deepEqual(snapshot.textures[0].roles, ['scene.environment', 'uniform.source']);
});
test('unknown texture dimensions are explicit and malformed actual counters fail', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); scene.environment = new THREE.Texture();
  const result = inspectDirectorSceneBudget(scene, cpuRenderer(), camera);
  assert.equal(result.texturesWithUnknownDimensions, 1); assert.equal(result.textures[0].rgba8BaseLevelEquivalentBytes, null);
  const invalid = cpuRenderer(); invalid.info.render.triangles = NaN;
  assert.throws(() => inspectDirectorSceneBudget(scene, invalid, camera), /Invalid actual/);
  const aggregated = cpuRenderer(); aggregated.info.autoReset = false;
  assert.throws(() => inspectDirectorSceneBudget(scene, aggregated, camera), /Per-render/);
});
