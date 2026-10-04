import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 3 4\n';
const source = `data:model/obj;base64,${Buffer.from(obj).toString('base64')}`;
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Asset event deadline')), 10000); })]).finally(() => clearTimeout(timer));
}
const f = objectsFixture();
try {
  const before = structuredClone(f.objects.read());
  const receipt = await f.run('asset.import', { source, name: 'Fixture.obj', placeAs: 'mesh' }, 'agent');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.kind, 'job');
  assert.ok(receipt.undo.historyEntryId);
  const mesh = f.objects.read().find(row => row.renderer === 'mesh');
  assert.ok(f.assetDb.records.has(mesh.assetId), 'bytes are stored before publishing the object');
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(f.objects.read(), before);
  assert.ok(f.assetDb.records.has(mesh.assetId), 'undo only removes the instance, not shared bytes');
  await f.objects.importMesh(new File([obj], 'UI.obj', { type: 'model/obj' }));
  assert.equal(f.objects.read().filter(row => row.renderer === 'mesh').length, 1);
  await f.objects.spawnMeshAt(mesh.assetId, { x: 4, z: 3 });
  assert.ok(f.objects.read().some(row => row.renderer === 'mesh' && row.x === 4 && row.z === 3));
  const gate = f.assetDb.holdNextWrite();
  const importing = f.run('asset.import', { source, name: 'Concurrent.obj', placeAs: 'mesh' }, 'agent');
  await bounded(gate.arrived);
  const edited = f.run('object.rename', { id: 'cube', name: 'During import' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = structuredClone(f.objects.read());
  gate.release();
  assert.equal((await bounded(importing)).code, 'STALE_TARGET');
  assert.deepEqual(f.objects.read(), saved, 'late preparation cannot publish over a concurrent edit');
  console.log('PASS asset.import: real OBJ parsing, IndexedDB event seam, one commit, retained bytes, UI file/shelf routing and concurrent fence');
} finally { f.dispose(); }
