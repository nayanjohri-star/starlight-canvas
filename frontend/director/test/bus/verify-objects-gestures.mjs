import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
const f = objectsFixture();
try {
  const before = structuredClone(f.objects.store.objects);
  const token = f.objects.beginSceneTransaction({ owner: 'gizmo', cancel: () => {} });
  assert.equal(typeof token, 'string', 'gizmo token is the bus transaction id');
  for (const x of [1, 2, 3]) f.objects.changeSceneObject('cube', { x }, token);
  assert.equal(f.objects.store.depths().past, 0, 'preview has no retained entry');
  const receipt = f.objects.endSceneTransaction(token, { commit: true });
  assert.equal(receipt.action, 'run.commit');
  assert.equal(receipt.undo.entries, 1);
  assert.equal(f.objects.store.depths().past, 1);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(f.objects.store.objects, before);
  const cancelled = f.objects.beginSceneTransaction({ owner: 'scrub', cancel: () => {} });
  f.objects.changeSceneObject('cube', { x: 7 }, cancelled);
  f.objects.endSceneTransaction(cancelled, { commit: false });
  assert.deepEqual(f.objects.store.objects, before);
  assert.equal(f.objects.store.depths().past, 0);
  console.log('PASS real gizmo/scrub callbacks: run.begin/update/commit, one receipt and entry, exact undo and cancellation');
} finally { f.dispose(); }
