import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectFixture, ok } from './project-fixture.mjs';
import { declarations as sceneCommands } from '../../src/commands/scene.js';
import { declarations as projectCommands } from '../../src/commands/project.js';
import { deferred } from './fixture.mjs';

const cases = {
  'scene.set': { id: 'scene', set: { name: 'Generic name', order: 1 } },
  'scene.rename': { sceneId: 'scene', name: 'Named scene' },
  'scene.reorder': { sceneId: 'scene-b', order: 0 },
  'project.rename': { name: 'Named project' },
};
assert.deepEqual(Object.keys(cases).sort(), [...sceneCommands, ...projectCommands].filter(entry => entry.kind === 'mutation').map(entry => entry.id).sort());
for (const [command, args] of Object.entries(cases)) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
  const f = projectFixture();
  const snapshot = () => structuredClone(f.binding.handlers.inspect_studio({ scope: 'document' }).document);
  try {
    const initial = f.project.read(), metadata = f.project.metadata();
    const reset = () => { f.project.replaceDocument(initial, metadata.activeSceneId, metadata.name); f.binding.refresh(); };
    const before = snapshot();
    const receipt = ok(await f.run(command, args, origin));
    assert.equal(receipt.revision.after, receipt.revision.before + 1);
    assert.ok(receipt.affectedIds.length && receipt.undo?.historyEntryId);
    assert.equal((await f.run('edit.undo', { receiptId: receipt.receiptId }, origin)).status, 'undone');
    assert.deepEqual(snapshot(), before);
    reset();
    const first = ok(await f.run(command, args, origin));
    for (let i = 0; i < 51; i++) ok(await f.run('scene.rename', { sceneId: 'scene', name: `Retention ${i}` }, origin));
    assert.equal((await f.run('edit.undo', { receiptId: first.receiptId }, origin)).code, 'UNDO_EXPIRED');
    reset();
    const saved = snapshot();
    const tx = ok(await f.run('run.begin', { id: command, args }, origin));
    ok(await f.run('run.update', { txId: tx.txId, args }, origin));
    ok(await f.run('run.cancel', { txId: tx.txId }, origin));
    assert.deepEqual(snapshot(), saved);
    reset();
    const revision = f.binding.refresh().revision;
    ok(await f.run('scene.rename', { sceneId: 'scene', name: 'Concurrent name' }));
    const stale = await f.run(command, args, origin, { expectedRevision: revision });
    assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
    reset();
    const ready = deferred();
    f.registry.register({ id: 'fixture.projectJob', label: 'Project job', description: 'Project job', kind: 'job', domain: command.startsWith('project.') ? 'project' : 'scenes',
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
      run: async (_args, context) => { await ready.promise; context.commit(() => f.project.renameProject('Prepared project')); return { affectedIds: ['scene'], summary: 'Prepared' }; } });
    const job = f.run('fixture.projectJob', {}, origin);
    ok(await f.run(command, args, origin));
    const concurrent = snapshot(); ready.resolve();
    assert.equal((await job).code, 'STALE_TARGET');
    assert.deepEqual(snapshot(), concurrent);
    console.log(`PASS real project parity ${command} ${origin}: receipt, undo, expiry, cancel, revision policy, concurrent job`);
  } finally { f.dispose(); }
}
{
  const f = projectFixture();
  try {
    const snapshots = [], receipts = [];
    const snapshot = () => structuredClone(f.binding.handlers.inspect_studio({ scope: 'document' }).document);
    snapshots.push(snapshot());
    for (const [command, args] of [
      ['stage.setStyle', { style: 'First stage edit' }], ['scene.rename', { sceneId: 'scene', name: 'After stage' }],
      ['project.rename', { name: 'After scene' }], ['object.rename', { id: 'cube', name: 'After project' }],
      ['scene.reorder', { sceneId: 'scene', order: 1 }],
    ]) { receipts.push(ok(await f.run(command, args))); snapshots.push(snapshot()); }
    for (let i = receipts.length - 1; i >= 0; i--) {
      assert.equal((await f.run('edit.undo', { receiptId: receipts[i].receiptId })).status, 'undone');
      assert.deepEqual(snapshot(), snapshots[i]);
    }
    for (let i = 1; i < snapshots.length; i++) { f.actual.redoScene(); assert.deepEqual(snapshot(), snapshots[i]); }
    const patch = ok(await f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'scene', id: 'scene' }, set: { name: 'Alias', order: 500 } }] })));
    assert.equal(patch.status, 'partial');
    assert.deepEqual(patch.ops[0].droppedPaths, ['scene.order']);
    assert.equal(patch.delta[0].after.patched.find(row => row.path === 'scene.order').number, 1);
    assert.equal((await f.run('scene.set', { id: 'missing', set: { name: 'Absent' } })).code, 'TARGET_NOT_READY');
    console.log('PASS project chronological undo/redo and generic collection alias/readback');
  } finally { f.dispose(); }
}
assert.deepEqual(JSON.parse(readFileSync(new URL('./parity-pending/project.json', import.meta.url))).pending, [], 'real project rows are no longer pending');
console.log('PASS all 96 real project mutation origin/check rows; project pending is empty');
