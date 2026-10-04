import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { deferred } from './fixture.mjs';

const f = projectFixture(), previousWindow = globalThis.window;
try {
  globalThis.window = { showSaveFilePicker() {}, showOpenFilePicker: async () => [{ getFile: async () => ({ name: 'invalid.cclayproject', text: async () => 'not json' }) }] };
  assert.equal((await f.run('project.open')).code, 'TARGET_NOT_READY', 'invalid picker bytes do not claim an opened project');
  assert.equal((await f.project.openProjectByHandle({ queryPermission: async () => 'denied', requestPermission: async () => 'denied' })).code, 'TARGET_NOT_READY');
  const fresh = ok(await f.run('project.new', { name: '  Trimmed project  ' }));
  assert.equal(fresh.output.opened, true);
  assert.equal(f.project.metadata().name, 'Trimmed project');
  f.project.refreshProjectDirty();
  const rename = ok(await f.run('scene.rename', { sceneId: f.project.read()[0].id, name: 'Saved name' }));
  const entered = deferred(), release = deferred();
  f.scope.projectHandleRef.current = { name: 'Trimmed project.cclayproject', createWritable: async () => ({
    write: async () => { entered.resolve(); await release.promise; }, close: async () => {},
  }) };
  const saving = f.run('project.save');
  await entered.promise;
  ok(await f.run('project.rename', { name: 'Edited during save' }));
  release.resolve(); ok(await saving);
  assert.equal(f.project.metadata().name, 'Edited during save', 'late save completion cannot replace a newer project name');
  assert.equal(f.project.dirtyStore.read('projectDirty'), true);
  assert.equal(f.project.documentStore.isRetained(rename.undo.historyEntryId), true, 'saving does not reset authored undo');
  console.log('PASS real project file boundaries: invalid/denied opens, normalized new name, late-save fencing and retained undo');
} finally { f.dispose(); globalThis.window = previousWindow; }
