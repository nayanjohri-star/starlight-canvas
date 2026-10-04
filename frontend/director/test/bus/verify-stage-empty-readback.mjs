import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';

for (const alias of [false, true]) {
  const f = stageFixture();
  try {
    const receipt = alias
      ? f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'stage' }, set: { environment: '', style: '' } }] }))
      : f.run('stage.set', { environment: '', style: '' }, 'agent');
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(f.stage.read().environment, '');
    assert.equal(f.stage.read().style, '');
    for (const path of ['stage.environment', 'stage.style']) {
      assert.deepEqual(receipt.delta[0].after.patched.find(row => row.path === path), { path, text: null });
    }
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    console.log(`PASS ${alias ? 'patch_elements' : 'stage.set'} clears text with valid measured receipts and undo`);
  } finally { f.dispose(); }
}
