import assert from 'node:assert/strict';
import { collectionFixture, kind } from './collection-fixture.mjs';
let failures = 0;
function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
}
test('collection aliases resolve the command undoDomain, not the element kind', () => {
  const f = collectionFixture('fixtureItems');
  try {
    const receipt = f.patch([{ target: { kind, id: 'item-a' }, set: { amount: 4 } }]);
    assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
    assert.equal(f.domain.read()[0].amount, 4);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  } finally { f.dispose(); }
});
test('unchanged collection patches return valid noop receipts without history', () => {
  const f = collectionFixture();
  try {
    const receipt = f.patch([{ target: { kind, id: 'item-a' }, set: { amount: 0 } }]);
    assert.equal(receipt.status, 'noop', JSON.stringify(receipt));
    assert.deepEqual(receipt.delta, []);
    assert.equal(receipt.undo, null);
    assert.deepEqual(f.domain.documentStore.depths(), { past: 0, future: 0 });
  } finally { f.dispose(); }
});
assert.equal(failures, 0);
