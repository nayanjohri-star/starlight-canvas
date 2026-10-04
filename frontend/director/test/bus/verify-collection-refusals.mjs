import assert from 'node:assert/strict';
import { collectionFixture, kind } from './collection-fixture.mjs';
const f = collectionFixture();
try {
  const before = f.domain.read(), depths = f.domain.documentStore.depths();
  const missing = f.patch([
    { target: { kind, id: 'item-a' }, set: { amount: 5 } },
    { target: { kind, id: 'missing-item' }, set: { amount: 4 } },
  ]);
  assert.equal(missing.code, 'TARGET_NOT_READY', JSON.stringify(missing));
  assert.ok(missing.message.includes('missing-item'));
  assert.equal(missing.mutated, false);
  assert.equal(f.domain.read(), before, 'a missing batch target cannot partially publish');
  assert.deepEqual(f.domain.documentStore.depths(), depths);
  const request = f.request('patch_elements', { ops: [
    { target: { kind, id: 'item-b' }, set: { amount: 99, name: 'Changed' } },
    { target: { kind, id: 'item-a' }, set: { amount: 3 } },
  ] });
  const receipt = f.binding.handlers.patch_elements(request);
  assert.equal(receipt.status, 'partial', JSON.stringify(receipt));
  assert.deepEqual(receipt.ops, [
    { index: 0, status: 'partial', droppedPaths: [`${kind}.amount`] }, { index: 1, status: 'applied' },
  ]);
  assert.deepEqual(receipt.affectedIds, ['item-b', 'item-a']);
  assert.deepEqual(receipt.delta[0], { id: 'item-b', after: { patched: [
    { path: `${kind}.amount`, number: 10 }, { path: `${kind}.name`, text: 'Changed' },
  ] } });
  assert.deepEqual(f.binding.handlers.patch_elements(request), receipt, 'retry replays the enriched journal receipt');
  assert.deepEqual(f.binding.handlers.reconcile_studio_command(request).receipt, receipt);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(f.domain.read(), before);
  const stale = f.binding.handlers.patch_elements({ ...request, commandId: crypto.randomUUID(), expectedRevision: -1 });
  assert.equal(stale.code, 'STALE_SCENE');
  console.log('PASS #480.2 unknown-id atomic refusal, per-item partial/dropped paths, journal replay and undo');
} finally { f.dispose(); }
