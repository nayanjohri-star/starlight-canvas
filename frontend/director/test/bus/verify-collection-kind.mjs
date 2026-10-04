import assert from 'node:assert/strict';
import { collectionFixture, kind } from './collection-fixture.mjs';
const f = collectionFixture();
try {
  const receipt = f.patch([{ target: { kind, id: 'item-b' }, set: { amount: 6 } }]);
  assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
  assert.deepEqual(receipt.affectedIds, ['item-b']);
  assert.equal(receipt.action, `${kind}.set`);
  assert.deepEqual(f.domain.read(), [{ id: 'item-a', amount: 0, name: 'A' }, { id: 'item-b', amount: 6, name: 'B' }]);
  assert.ok(receipt.delta[0].after.patched.some(row => row.path === `${kind}.amount` && row.number === 6));
  const inspected = f.binding.handlers.inspect_studio({ scope: 'document', ids: ['item-b'] });
  assert.deepEqual(inspected.document[kind], [f.domain.read()[1]]);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.equal(f.domain.read()[1].amount, 2);
  const batch = f.patch([
    { target: { kind, id: 'item-a' }, set: { name: 'First' } },
    { target: { kind, id: 'item-b' }, set: { amount: 7 } },
  ]);
  assert.equal(batch.status, 'applied', JSON.stringify(batch));
  assert.deepEqual(batch.affectedIds, ['item-a', 'item-b']);
  assert.equal(f.run('edit.undo', { receiptId: batch.receiptId }).status, 'undone');
  assert.deepEqual(f.domain.read(), [{ id: 'item-a', amount: 0, name: 'A' }, { id: 'item-b', amount: 2, name: 'B' }]);
  console.log('PASS #480.1 collection item targeting, per-id readback/inspection and atomic multi-item undo');
} finally { f.dispose(); }
