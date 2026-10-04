import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { createProjectDocument } from '../../src/project.js';
import { SCENES_VERSION } from '../../src/scenes.js';

for (const origin of ['agent', 'mcp', 'cli']) {
  const f = projectFixture();
  try {
    const serialized = JSON.stringify(createProjectDocument({ name: 'Incoming', scenesDocument: {
      version: SCENES_VERSION, activeSceneId: 'incoming', scenes: [{ ...f.project.snapshotActiveScene()[1], id: 'incoming' }],
    } }));
    assert.equal((await f.run('project.open', { serialized }, origin)).code, 'CONFIRMATION_REQUIRED');
    assert.equal((await f.run('scene.delete', { sceneId: 'scene-b' }, origin)).code, 'CONFIRMATION_REQUIRED');
    let writes = 0;
    f.scope.projectHandleRef.current = { name: 'Heist.cclayproject', createWritable: async () => ({ write: async () => { writes++; }, close: async () => {} }) };
    assert.equal((await f.run('project.save', {}, origin)).code, 'CONFIRMATION_REQUIRED');
    assert.equal(writes, 0);
    const previousWindow = globalThis.window;
    globalThis.window = { showOpenFilePicker() {}, showSaveFilePicker() {} };
    try { ok(await f.run('project.save')); assert.equal(writes, 1); }
    finally { globalThis.window = previousWindow; }
    const opened = ok(await f.run('project.open', { serialized }));
    assert.equal(opened.kind, 'document');
    assert.equal(f.scope.activeSceneIdRef.current, 'incoming');
    assert.equal(f.project.metadata().name, 'Incoming');
    console.log(`PASS project exposure ${origin}: open/delete/overwrite refuse before side effects; UI save/open run`);
  } finally { f.dispose(); }
}
for (const command of ['scene.create', 'scene.duplicate']) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
  const f = projectFixture();
  try {
    const args = command === 'scene.create' ? {} : { sceneId: 'scene' };
    const before = f.project.read().length;
    assert.equal((await f.run('run.begin', { id: command, args }, origin)).code, 'INVALID_ARGUMENT');
    assert.equal(f.project.read().length, before);
    const receipt = ok(await f.run(command, args, origin));
    assert.equal(receipt.kind, 'document'); assert.equal(receipt.status, 'completed'); assert.equal(receipt.undo, null);
    assert.equal(f.project.read().length, before + 1);
    const index = command === 'scene.create' ? before : 1;
    assert.equal(f.scope.activeSceneIdRef.current, f.project.read()[index].id);
    if (command === 'scene.duplicate') assert.deepEqual(f.project.read()[index].objects, f.project.read()[0].objects);
    assert.deepEqual(f.project.documentStore.depths(), { past: 0, future: 0 });
    console.log(`PASS #480 document contract ${command} ${origin}: receipt, non-transactional, legacy count/open target`);
  } finally { f.dispose(); }
}
{
  const f = projectFixture();
  try {
    const document = { version: SCENES_VERSION, activeSceneId: 'scene-b', scenes: f.project.snapshotActiveScene() };
    ok(await f.run('load_scenes', { document }, 'mcp'));
    assert.equal(f.scope.activeSceneIdRef.current, 'scene-b');
    const replacement = { ...document, activeSceneId: 'other', scenes: [{ ...document.scenes[0], id: 'other' }] };
    assert.equal((await f.run('load_scenes', { document: replacement }, 'mcp')).code, 'CONFIRMATION_REQUIRED');
    const refused = await f.project.loadLiveScenes({ document: replacement });
    assert.equal(refused.code, 'CONFIRMATION_REQUIRED', 'legacy live handler cannot bypass replacement confirmation');
    assert.equal(f.scope.activeSceneIdRef.current, 'scene-b');
    console.log('PASS real load_scenes: same-id switch allowed, replacement confirmation enforced on legacy surface');
  } finally { f.dispose(); }
}
