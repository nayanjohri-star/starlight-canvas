import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.mjs';
import { objectsFixture } from './objects-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';

const input = { type: 'object', properties: {}, required: [], additionalProperties: false };
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const snapshot = f => structuredClone({ shots: f.live.current.shots, objects: f.store.current.objects,
  characters: f.actual.readStudioState().characters });
function register(f, root, surface) {
  f.registry.register({ id: 'fixture.appComposite', label: 'App composite', description: 'Exercise actual App composition ports',
    kind: 'mutation', undoDomain: root, input, available: () => true, run: (_args, context) => {
      // Wire updates do not expose context.run. Their nested editor callbacks
      // use App's same recordStudioAction port over prepared real commands.
      const run = surface === 'action' ? context.run : (id, args = {}) => {
        const prepared = f.registry.prepare(id, args);
        return f.actual.recordStudioAction(prepared.entry.undoDomain,
          () => f.registry.invoke(prepared.entry, prepared.args, context), null, true).result;
      };
      const created = run('shot.create');
      run('object.duplicate', { objectId: 'cube' });
      run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } });
      return { affectedIds: created.affectedIds, summary: 'Composed through App.' };
    } });
}
for (const root of ['shot', 'cast']) for (const surface of ['action', 'transaction']) test(`App ${surface}, ${root} root: one undo restores owned shots, objects and native cast`, () => {
  const f = objectsFixture();
  try {
    register(f, root, surface);
    const before = snapshot(f);
    let receipt;
    if (surface === 'action') receipt = ok(f.run('fixture.appComposite'));
    else {
      const tx = ok(f.run('run.begin', { id: 'fixture.appComposite', args: {} }));
      const preview = ok(f.run('run.update', { txId: tx.txId, args: {} }));
      assert.equal(preview.undo, null);
      receipt = ok(f.run('run.commit', { txId: tx.txId }));
    }
    assert.equal(receipt.undo.entries, 1);
    const after = snapshot(f);
    assert.notDeepEqual(after.shots, before.shots);
    assert.notDeepEqual(after.objects, before.objects);
    assert.notDeepEqual(after.characters, before.characters);
    assert.equal(ok(f.run('edit.undo', { receiptId: receipt.receiptId })).status, 'undone');
    assert.deepEqual(snapshot(f), before);
    f.actual.redoScene(); assert.deepEqual(snapshot(f), after);
  } finally { f.dispose(); }
});
test('App owned/native object composition undoes the native object member, not only the shot', () => {
  const f = appFixture();
  try {
    const object = { ...createSceneObject('cube'), id: 'cube' };
    f.store.current.applyAtomic(() => [object]);
    f.registry.register({ id: 'fixture.nativeObject', label: 'Native object', description: 'Native object history remains supported',
      kind: 'mutation', undoDomain: 'shot', input, available: () => true, run: (_args, context) => {
        const shot = context.run('shot.create'); context.run('object.duplicate', { objectId: 'cube' });
        return { affectedIds: shot.affectedIds, summary: 'Shot and native object.' };
      } });
    const before = snapshot(f), receipt = ok(f.binding.bus.run('fixture.nativeObject')), after = snapshot(f);
    assert.equal(receipt.undo.entries, 1);
    const undo = ok(f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }));
    assert.equal(undo.status, 'undone');
    assert.deepEqual(snapshot(f), before, 'the native duplicate must disappear with the shot');
    f.actual.redoScene(); assert.deepEqual(snapshot(f), after);
  } finally { f.dispose(); }
});
