import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { SCENES_STORAGE_KEY } from '../../src/scenes.js';

const f = projectFixture();
try {
  ok(await f.run('scene.reorder', { sceneId: 'scene-b', order: 0 }));
  ok(await f.run('scene.delete', { sceneId: 'scene-b' }));
  assert.equal(f.scope.appContext.live.scenes, f.project.read(), 'deleting another scene keeps the owned read-only projection');
  assert.throws(() => { f.scope.appContext.live.scenes[0].name = 'bypass'; }, TypeError);
  assert.deepEqual(JSON.parse(f.storage.get(SCENES_STORAGE_KEY)).scenes, f.project.snapshotActiveScene(), 'localStorage keeps normalized order after deletion');
  ok(await f.run('scene.create'));
  assert.equal(f.scope.appContext.live.scenes, f.project.read());
  ok(await f.run('scene.switch', { sceneId: 'scene' }));
  assert.equal(f.scope.appContext.live.scenes, f.project.read());
  console.log('PASS scene document transitions retain the immutable owner projection and normalized cache');
} finally { f.dispose(); }
