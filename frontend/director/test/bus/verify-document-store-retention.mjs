import assert from 'node:assert/strict';
import { documentFixture } from './document-store-fixture.mjs';
import { HISTORY_LIMIT } from '../../src/history.js';

const { store, bus, run } = documentFixture();
try {
  const first = run('stage.set', { value: 2 });
  const id = first.undo.historyEntryId;
  for (let i = 2; i <= HISTORY_LIMIT; i++) assert.equal(run('stage.set', { value: i + 1 }).ok, true);
  assert.equal(store.isRetained(id), true, 'entry 1 is retained through commit 50');
  const last = run('stage.set', { value: 52 });
  assert.equal(store.isRetained(id), false, 'commit 51 evicts entry 1, not commit 52');
  assert.equal(store.depths().past, 50);
  assert.equal(run('edit.undo', { receiptId: first.receiptId }).code, 'UNDO_EXPIRED');
  assert.equal(run('edit.undo', { receiptId: last.receiptId }).status, 'undone');
  assert.equal(store.read('stage').intensity, 51);
  assert.equal(store.isRetained(last.undo.historyEntryId), true, 'redo still retains the entry');
  assert.equal(store.canUndo(last.undo.historyEntryId), false);
  assert.equal(store.redo().historyEntryId, last.undo.historyEntryId);
  assert.equal(store.read('stage').intensity, 52);
  store.undo();
  run('stage.set', { value: 99 });
  assert.equal(store.isRetained(last.undo.historyEntryId), false, 'branching discards redo identities');
  for (let i = 0; i < HISTORY_LIMIT; i++) assert.ok(store.undo());
  assert.equal(store.undo(), null);
  assert.equal(store.read('stage').intensity, 2, 'the oldest retained pre-image is still restorable');
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), true);
} finally { bus.dispose(); }
console.log('PASS document store 3: exactly 50 undoable entries, receipt expiry and redo branch invalidation');
