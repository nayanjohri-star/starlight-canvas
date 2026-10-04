import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { createStudioAppActions } from '../../src/commands/index.js';
import { SCENES_VERSION } from '../../src/scenes.js';

const f = projectFixture();
try {
  const unmounted = createStudioAppActions({ state: () => f.registry.state() });
  assert.doesNotThrow(() => unmounted.list(), 'unmounted owners report unavailable with a reason');
  assert.equal(unmounted.list().find(row => row.id === 'project.rename').available, false);
  ok(await f.run('stage.setStyle', { style: 'Other department edit' }));
  const before = f.project.documentStore.depths();
  const noop = ok(await f.run('scene.rename', { sceneId: 'scene', name: 'First' }));
  assert.equal(noop.status, 'noop', 'renaming to the same name never snapshots other domains into scene history');
  assert.deepEqual(f.project.documentStore.depths(), before);
  const legacy = await f.project.loadLiveScenes({ document: { version: SCENES_VERSION, activeSceneId: 'scene-b', scenes: f.project.snapshotActiveScene() } });
  assert.equal(legacy.activeSceneId, 'scene-b', 'legacy load retains its successful result shape');
  ok(await f.run('project.new', { name: 'Fresh' }));
  f.project.refreshProjectDirty();
  assert.equal(f.project.dirtyStore.read('projectDirty'), false, 'a new project is clean after the first dirty refresh');
  const previousWindow = globalThis.window;
  globalThis.window = { showSaveFilePicker() {}, showOpenFilePicker: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } };
  try { assert.equal((await f.run('project.open')).code, 'TARGET_NOT_READY', 'closing the picker must not claim an opened document'); }
  finally { globalThis.window = previousWindow; }
  console.log('PASS project adapters: unmounted discovery, cross-domain noop, legacy output, clean new project, cancelled picker');
} finally { f.dispose(); }
