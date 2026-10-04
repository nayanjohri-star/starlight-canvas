import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { scenePerformanceStatus } from '../src/scene-performance.js';
import { createSceneObject, createMeshObject, createCutoutObject, setSceneObjectParent } from '../src/scene-objects.js';
import { createCharacterEntry } from '../src/scenes.js';
import { meshIdFromDigest, assetIdFromDigest } from '../src/scene-assets.js';
import { objectSelectionFixture } from './bus/object-selection-fixture.mjs';

const characters = [0, 1].map(index => createCharacterEntry({ id: `character-${index}` }, index));
const baseline = [];
for (let index = 0; index < 20; index++) baseline.push(createSceneObject(index === 1 ? 'sphere' : 'cube', baseline));
const f = objectSelectionFixture();
const profile = (environmentImage = null, cast = characters) => scenePerformanceStatus({ characters: cast, objects: f.objects.read(), environmentImage });
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
try {
  f.objects.load(baseline);
  assert.equal(profile().visibleProps, 20); assert.equal(profile().beyondTested, false);
  const extra = ok(f.run('object.add', { kind: 'cube' }));
  assert.equal(profile().visibleProps, 21); assert.equal(profile().beyondTested, true);
  ok(f.run('edit.undo', { receiptId: extra.receiptId }));
  assert.equal(profile().beyondTested, false, 'undo clears the range notice with the authored scene');

  ok(f.run('object.group', { parent: 'sphere', children: ['cube'] }));
  assert.equal(profile().visibleProps, 20, 'a renderable parent remains a prop when it carries a group');
  ok(f.run('object.update', { id: 'sphere', patch: { hidden: true } }));
  assert.equal(profile().visibleProps, 18, 'hidden grouping parents also hide carried children');
  const mesh = createMeshObject({ assetId: meshIdFromDigest('a'.repeat(64)) }, f.objects.read());
  f.objects.load(setSceneObjectParent([...f.objects.read(), mesh], mesh.id, 'sphere'));
  assert.equal(profile().customMeshes, 0); assert.equal(profile().beyondTested, false);
  ok(f.run('object.update', { id: 'sphere', patch: { hidden: false } }));
  assert.equal(profile().customMeshes, 1); assert.equal(profile().beyondTested, true);
  ok(f.run('object.remove', { ids: [mesh.id] }));
  assert.equal(profile().beyondTested, false, 'deleting the referenced model clears the notice');

  const cutout = createCutoutObject({ assetId: assetIdFromDigest('b'.repeat(64)) }, []);
  f.objects.load([cutout]);
  assert.equal(profile().imageCutouts, 1); assert.equal(profile().beyondTested, true);
  ok(f.run('object.update', { id: cutout.id, patch: { hidden: true } }));
  assert.equal(profile().imageCutouts, 0); assert.equal(profile().beyondTested, false);
  const hiddenCast = characters.map(row => row.id === characters[0].id ? { ...row, hidden: true } : row);
  f.objects.load([{ ...cutout, hidden: false, attach: { characterId: characters[0].id, bone: null } }]);
  assert.equal(profile(null, hiddenCast).visibleProps, 0, 'a hidden carrier hides its attached texture');

  // Container/source fixture: PropVisual has no renderer for a group row.
  // It must not inflate the actual drawn prop count, while its hidden state
  // still applies to descendants exactly as the stage visibility helper does.
  f.objects.load([{ id: 'container', renderer: 'group', hidden: false }, { ...cutout, parent: 'container' }]);
  assert.equal(profile().visibleProps, 1);
  ok(f.run('object.update', { id: 'container', patch: { hidden: true } }));
  assert.equal(profile().visibleProps, 0);
  f.objects.load(baseline);
  const unused = scenePerformanceStatus({ characters, objects: baseline, imageAssetIds: [cutout.assetId], meshAssetIds: [mesh.assetId] });
  assert.equal(unused.beyondTested, false, 'unused shelf ids do not create scene texture or model references');
  assert.equal(profile('data:image/png;base64,aGVsbG8=').environmentTexture, true);
  assert.equal(profile('data:image/png;base64,aGVsbG8=').beyondTested, true);
  assert.equal(profile(null).beyondTested, false, 'clearing the environment reference clears the notice');
  const third = createCharacterEntry({ id: 'character-2' }, 2);
  assert.equal(profile(null, [...characters, third]).beyondTested, true);
  assert.equal(profile(null, [...characters, { ...third, hidden: true }]).beyondTested, false);
  console.log('PASS actual object bus references, threshold undo/delete, grouping/hidden/attached resources and unused shelf exclusion');
} finally { f.dispose(); }

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{
  name: 'performance-panel-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return 'export const sceneObjectNameDisplayKo = name => name; export const sceneRendererLabelKo = name => name;';
  },
}] });
let PropsPanel, AssetPane;
try {
  PropsPanel = (await server.ssrLoadModule('/src/panels/PropsPanel.jsx')).default;
  AssetPane = (await server.ssrLoadModule('/src/asset-pane.jsx')).default;
} finally { await server.close(); }
const status = scenePerformanceStatus({ characters, objects: [createMeshObject({ assetId: meshIdFromDigest('c'.repeat(64)) })] });
const props = renderToStaticMarkup(createElement(PropsPanel, { performanceStatus: status, selectedHierarchyId: 'object:mesh', inspectorDrop: { handlers: {} }, sceneObjects: [], cutoutInputRef: { current: null }, meshInputRef: { current: null } }));
assert.match(props, /data-testid="scene-performance-props"/);
assert.ok(props.indexOf('data-testid="scene-performance-props"') < props.indexOf('class="card foldout'), 'the notice remains visible after an import selects the new object');
assert.doesNotMatch(props, /<button[^>]*disabled/);
const assets = renderToStaticMarkup(createElement(AssetPane, { performanceStatus: status, imageAssetIds: [], meshAssetIds: [] }));
assert.match(assets, /data-testid="scene-performance-assets"/);
assert.doesNotMatch(assets, /<button[^>]*disabled/);
const clean = renderToStaticMarkup(createElement(AssetPane, { performanceStatus: scenePerformanceStatus({ characters, objects: baseline }), imageAssetIds: [assetIdFromDigest('b'.repeat(64))], meshAssetIds: [meshIdFromDigest('a'.repeat(64))] }));
assert.doesNotMatch(clean, /data-testid="scene-performance-assets"/);
console.log('PASS actual PropsPanel/AssetPane notice wiring, object-selected visibility and unchanged enabled controls');
