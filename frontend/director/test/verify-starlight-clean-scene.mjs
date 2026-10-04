import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Mesh, PlaneGeometry, MeshLambertMaterial, MeshNormalMaterial, Color, Vector4, PerspectiveCamera,
  SRGBColorSpace, LinearSRGBColorSpace, ACESFilmicToneMapping, NoToneMapping } from 'three';
import { withCleanSceneMaterials } from '../src/clean-scene.js';
import { createFocusedRenderer } from '../src/focused-render.js';

test('shot rendering hides the measuring floor, retains shading and restores working materials on success or failure', () => {
  const scene = new Scene(), grid = new MeshLambertMaterial(), clean = new MeshLambertMaterial({ color: '#fffdf7' });
  const floor = new Mesh(new PlaneGeometry(2, 2), grid), prop = new Mesh(new PlaneGeometry(1, 1), grid);
  floor.userData.cleanExportMaterial = clean; floor.receiveShadow = true; scene.add(floor, prop);
  const camera = { userData: {} }, renderer = { setRenderTarget() {}, render(s) {
    assert.equal(s, scene); assert.equal(floor.material, clean); assert.equal(prop.material, grid);
    assert.equal(clean.map, null); assert.equal(floor.receiveShadow, true);
  } };
  const focused = createFocusedRenderer();
  focused.render({ renderer, scene, camera, width: 64, height: 64 });
  assert.equal(floor.material, grid);
  renderer.render = () => { assert.equal(floor.material, clean); throw new Error('GPU failure'); };
  assert.throws(() => focused.render({ renderer, scene, camera, width: 64, height: 64 }), /GPU failure/);
  assert.equal(floor.material, grid);
  withCleanSceneMaterials(scene, () => withCleanSceneMaterials(scene, () => assert.equal(floor.material, clean)));
  assert.equal(floor.material, grid);
  focused.dispose(); floor.geometry.dispose(); prop.geometry.dispose(); grid.dispose(); clean.dispose();
});

test('the actual Three.js DOF passes run and restore renderer state after a depth-render failure', () => {
  const scene = new Scene(), camera = new PerspectiveCamera(45, 16 / 9, .1, 100);
  camera.userData.focus = { focusDistance: 4, fStop: 2.8, depthOfField: true };
  const target = {}, initialColor = new Color('#123456'), rect = new Vector4(4, 5, 60, 40);
  const state = { target, color: initialColor.clone(), alpha: .4, viewport: rect.clone(), scissor: rect.clone(), test: true };
  let draws = 0, fail = false;
  const flags = [];
  const renderer = { autoClear: true, outputColorSpace: SRGBColorSpace, toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1,
    getRenderTarget: () => state.target, setRenderTarget: value => { state.target = value; },
    getScissor: value => value.copy(state.scissor), setScissor: value => { state.scissor.copy(value); },
    getViewport: value => value.copy(state.viewport), setViewport: value => { state.viewport.copy(value); },
    getScissorTest: () => state.test, setScissorTest: value => { state.test = value; },
    getClearColor: value => value.copy(state.color), getClearAlpha: () => state.alpha,
    setClearColor: (color, alpha) => { state.color.set(color); if (alpha !== undefined) state.alpha = alpha; },
    setClearAlpha: value => { state.alpha = value; }, clear() {},
    render() { draws++; flags.push({ toneMapping: this.toneMapping, colorSpace: this.outputColorSpace });
      if (fail && scene.overrideMaterial?.isMeshDepthMaterial) throw new Error('depth GPU failure'); }
  };
  const focused = createFocusedRenderer();
  const assertRestored = () => { assert.equal(state.target, target); assert.deepEqual(state.color, initialColor);
    assert.equal(state.alpha, .4); assert.equal(renderer.autoClear, true); assert.equal(scene.overrideMaterial, null);
    assert.equal(renderer.toneMapping, ACESFilmicToneMapping); assert.equal(renderer.outputColorSpace, SRGBColorSpace);
    assert.equal(state.test, true); assert.deepEqual(state.viewport, rect); assert.deepEqual(state.scissor, rect); };
  focused.render({ renderer, scene, camera, target, width: 64, height: 36 });
  assert.equal(draws, 4, 'color, actual depth pass, bokeh and output pass all render'); assertRestored();
  fail = true; assert.throws(() => focused.render({ renderer, scene, camera, target, width: 64, height: 36 }), /depth GPU failure/);
  assertRestored(); fail = false;
  focused.render({ renderer, scene, camera, target, width: 64, height: 36 }); assertRestored();
  camera.userData.focus.depthOfField = false;
  const beforePlain = draws;
  focused.render({ renderer, scene, camera, target, width: 64, height: 36 });
  assert.equal(draws - beforePlain, 2, 'plain captures also render linear color plus one final output conversion'); assertRestored();
  const normal = new MeshNormalMaterial(); scene.overrideMaterial = normal; camera.userData.focus.depthOfField = true;
  const beforeData = draws;
  focused.render({ renderer, scene, camera, target, width: 64, height: 36 });
  assert.equal(draws - beforeData, 2, 'geometry channels bypass lens blur');
  assert.deepEqual(flags.at(-1), { toneMapping: NoToneMapping, colorSpace: LinearSRGBColorSpace }, 'geometry channels bypass the display look');
  assert.equal(scene.overrideMaterial, normal); scene.overrideMaterial = null; normal.dispose(); assertRestored();
  focused.dispose(); focused.dispose();
});
