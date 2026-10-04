import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';
const kind = 'fixtureMappedItem', documentKey = 'fixtureMappedItems';
registerElementKind(kind, { collection: true, documentKey,
  elements: [{ path: `${kind}.amount`, type: 'number', agentExposure: 'patch' }],
  normalize: row => ({ ...row, amount: Math.min(10, row.amount) }),
});
const f = stageFixture(), store = createDocumentStore({ owned: { [documentKey]: [{ id: 'mapped-a', amount: 0 }, { id: 'mapped-b', amount: 2 }] } });
const domain = { documentStore: store, read: () => store.read(documentKey), write: value => store.write(documentKey, value),
  document: () => ({ [documentKey]: store.read(documentKey) }), beginAction: () => store.beginAction(documentKey),
  canUndo: id => store.canUndo(id), stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
const release = f.scope.appContext.registerStoreDomain(documentKey, domain);
try {
  registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: 'Mapped item', description: 'Mapped collection', kind: 'mutation', undoDomain: documentKey, input: elementSetSchema(kind) });
  for (const select of [[kind], [documentKey]]) {
    const reply = f.binding.handlers.inspect_studio({ scope: 'document', select });
    assert.deepEqual(reply.document, domain.document());
    assert.deepEqual(reply.schema[documentKey], elementSetSchema(kind));
  }
  for (const id of [kind, documentKey, f.host().sceneId]) assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'document', select: [kind], ids: [id] }).document, domain.document());
  assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'document', select: [kind], ids: ['mapped-b'] }).document, { [documentKey]: [domain.read()[1]] });
  assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'document', select: [kind], ids: ['missing'] }).document, {});
  const direct = f.run(`${kind}.set`, { id: 'mapped-a', set: { amount: 4 } });
  assert.equal(direct.status, 'applied', JSON.stringify(direct));
  assert.deepEqual(direct.delta[0].after.patched, [{ path: `${kind}.amount`, number: 4 }]);
  assert.equal(f.run('edit.undo', { receiptId: direct.receiptId }).status, 'undone');
  const request = f.request('patch_elements', { ops: [{ target: { kind, id: 'mapped-a' }, set: { amount: 50 } }] });
  const receipt = f.binding.handlers.patch_elements(request);
  assert.equal(receipt.status, 'partial', JSON.stringify(receipt));
  assert.deepEqual(receipt.ops[0].droppedPaths, [`${kind}.amount`]);
  assert.deepEqual(receipt.delta[0].after.patched, [{ path: `${kind}.amount`, number: 10 }]);
  assert.deepEqual(f.binding.handlers.patch_elements(request), receipt);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.equal(domain.read()[0].amount, 0);
  assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'document', select: ['stage'] }).document.stage, f.stage.document().stage);
  console.log('PASS documentKey: persisted keys, kind/key/id filters, schema, action readback, partial patch receipt, replay and undo');
} finally { release(); store.dispose(); f.dispose(); }
