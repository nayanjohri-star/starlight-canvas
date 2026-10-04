import assert from 'node:assert/strict';
import { documentFixture } from './document-store-fixture.mjs';

const { store, bus, run } = documentFixture();
try {
  const original = store.getSnapshot();
  assert.equal(original, store.getSnapshot(), 'external-store snapshots are cached');
  const notifications = [];
  const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot()));
  const opened = run('run.begin', { id: 'stage.set', args: { value: 1 } }, 'agent');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  for (const value of [2, 3]) {
    const update = run('run.update', { txId: opened.txId, args: { value } }, 'agent');
    assert.equal(update.ok, true, JSON.stringify(update));
    assert.equal(store.read('stage').intensity, value);
    assert.deepEqual(store.depths(), { past: 0, future: 0 });
  }
  const receipt = run('run.commit', { txId: opened.txId }, 'agent');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(typeof receipt.undo.historyEntryId, 'string');
  assert.equal(receipt.undo.entries, 1);
  assert.deepEqual(store.depths(), { past: 1, future: 0 });
  assert.equal(store.history().present.historyEntryId, receipt.undo.historyEntryId);
  assert.deepEqual(Object.keys(store.history()).sort(), ['future', 'past', 'present']);
  assert.deepEqual(store.history().past[0].snapshot, original.slices);
  assert.equal(store.getSnapshot().domainRevisions.stage, 2);
  assert.equal(store.getSnapshot().domainRevisions.shot, 0);
  assert.equal(notifications.length, 2);
  unsubscribe();
  const noOp = store.recordAction('stage', () => store.write('stage', value => value));
  assert.equal(noOp.historyEntryId, null);
  assert.equal(store.depths().past, 1);
} finally { bus.dispose(); }
console.log('PASS document store 1: wire previews commit one scene-shaped history entry and stable domain snapshots');
