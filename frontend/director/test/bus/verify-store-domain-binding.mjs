import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';

registerElementKind('fixture', {
  elements: [{ path: 'fixture.amount', type: 'number', agentExposure: 'patch' }],
  normalize: value => ({ amount: Math.min(10, value.amount) }),
});
const f = stageFixture(), app = f.scope.appContext;
const store = createDocumentStore({ owned: { fixture: { amount: 0 } } });
const domain = {
  documentStore: store, document: () => ({ fixture: store.read('fixture') }),
  read: () => store.read('fixture'), write: value => store.write('fixture', value),
  beginAction: () => store.beginAction('fixture'), canUndo: id => store.canUndo(id),
  stepHistory: redo => Boolean((redo ? store.redo : store.undo)()),
};
const release = app.registerStoreDomain('fixture', domain);
try {
  // No fixture-specific port is supplied. The App facade is the sole routing
  // source, exactly as in the mounted stage hook.
  Object.assign(f.ports, app.ports);
  Object.assign(f.actionHandlers.current, app.actionPorts);
  f.ports.canUndo = f.actual.canUndoStudioReceipt;
  registerElementSet(f.registry, f.actionHandlers.current, { id: 'fixture.set', label: 'Fixture', description: 'Fixture',
    kind: 'mutation', undoDomain: 'fixture', input: elementSetSchema('fixture') });
  const inspect = () => f.binding.handlers.inspect_studio({ scope: 'document', select: ['fixture'] });
  assert.deepEqual(inspect().document, { fixture: { amount: 0 } }, 'document scope aggregates registered projections');
  assert.deepEqual(inspect().schema.fixture, elementSetSchema('fixture'));
  const before = f.binding.refresh();
  const receipt = f.run('fixture.set', { amount: 40 }, 'agent');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.revision.after, receipt.revision.before + 1);
  assert.equal(f.binding.refresh().domainRevisions.fixture, before.domainRevisions.fixture + 1);
  assert.deepEqual(inspect().document, { fixture: { amount: 10 } });
  assert.ok(receipt.delta[0].after.patched.some(row => row.path === 'fixture.amount' && row.number === 10));
  assert.equal(f.actual.isStudioHistoryRetained(receipt), true);
  assert.equal(f.actual.canUndoStudioReceipt(receipt), true);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(inspect().document, { fixture: { amount: 0 } });
  const alias = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'fixture' }, set: { amount: 3 } }] }));
  assert.equal(alias.ok, true, JSON.stringify(alias));
  assert.equal(alias.action, 'fixture.set');
  assert.deepEqual(inspect().document, { fixture: { amount: 3 } });
  const rejected = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [
    { target: { kind: 'fixture' }, set: { amount: 5 } }, { target: { kind: 'stage' }, set: { style: 'No partial commit' } },
  ] }));
  assert.equal(rejected.ok, false);
  assert.deepEqual(inspect().document, { fixture: { amount: 3 } });
  console.log('PASS registered fixture binding: document/schema, normalized set, revisions, receipt, undo, patch alias and atomic rejection');
} finally { release(); store.dispose(); f.dispose(); }
