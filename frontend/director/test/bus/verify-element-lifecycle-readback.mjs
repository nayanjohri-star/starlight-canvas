import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema, elementReadback } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';
const kind = 'fixtureLifecycle', key = 'fixtureLifecycleItems', reads = [];
registerElementKind(kind, { collection: true, documentKey: key, normalize: row => ({ ...row, amount: Math.min(10, row.amount) }),
  elements: [
    { path: `${kind}.amount`, type: 'number', agentExposure: 'patch' },
    { path: `${kind}.retire`, type: 'boolean', agentExposure: 'patch', readback: (item, document) => { reads.push({ item, document }); return { flag: item === undefined }; } },
  ],
});
const f = stageFixture(), initial = [{ id: 'life-a', amount: 0 }, { id: 'life-b', amount: 2 }];
const store = createDocumentStore({ owned: { [key]: initial } });
const domain = { documentStore: store, read: () => store.read(key), write: rows => store.write(key, rows.filter(row => !row.retire)),
  document: () => ({ [key]: store.read(key) }), beginAction: () => store.beginAction(key),
  canUndo: id => store.canUndo(id), stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
const release = f.scope.appContext.registerStoreDomain(key, domain);
try {
  registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: 'Lifecycle', description: 'Fixture lifecycle', kind: 'mutation', undoDomain: key, input: elementSetSchema(kind) });
  assert.deepEqual(elementReadback(kind, domain.read()[0], [`${kind}.retire`], domain.read()), [{ path: `${kind}.retire`, flag: false }]);
  const request = f.request('patch_elements', { ops: [{ target: { kind, id: 'life-a' }, set: { retire: true } }] });
  const receipt = f.binding.handlers.patch_elements(request);
  assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
  assert.deepEqual(receipt.ops, [{ index: 0, status: 'applied' }]);
  assert.deepEqual(receipt.delta[0].after.patched, [{ path: `${kind}.retire`, flag: true }]);
  assert.ok(reads.some(read => read.item === undefined && read.document === domain.read()), 'patch readback receives the persisted collection');
  assert.deepEqual(domain.read(), [initial[1]]);
  assert.deepEqual(f.binding.handlers.patch_elements(request), receipt);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(domain.read(), initial);
  const partial = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind, id: 'life-a' }, set: { amount: 50, retire: false } }] }));
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  assert.deepEqual(partial.ops[0].droppedPaths, [`${kind}.amount`]);
  assert.deepEqual(partial.delta[0].after.patched, [{ path: `${kind}.amount`, number: 10 }, { path: `${kind}.retire`, flag: false }]);
  console.log('PASS lifecycle readback: present/absent items, document context, no false drops, ordinary clamps, replay and undo');
} finally { release(); store.dispose(); f.dispose(); }
