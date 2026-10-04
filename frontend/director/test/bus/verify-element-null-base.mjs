import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';

const kind = 'fixtureNullable';
registerElementKind(kind, { collection: true, elements: [
  { path: `${kind}.settings.axis.value`, type: 'number', agentExposure: 'patch' },
], normalize: value => value });
const f = stageFixture(), app = f.scope.appContext;
const initial = [{ id: 'nullable-a', settings: null, untouched: true }];
const store = createDocumentStore({ owned: { [kind]: initial } });
const domain = { documentStore: store, document: () => ({ [kind]: store.read(kind) }),
  read: () => store.read(kind), write: value => store.write(kind, value),
  beginAction: () => store.beginAction(kind), canUndo: id => store.canUndo(id),
  stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
const release = app.registerStoreDomain(kind, domain);
try {
  registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: 'Nullable fixture',
    description: 'Patch a nested nullable field', kind: 'mutation', undoDomain: kind, input: elementSetSchema(kind) });
  const receipt = f.run(`${kind}.set`, { id: 'nullable-a', set: { settings: { axis: { value: 3 } } } });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.deepEqual(domain.read(), [{ id: 'nullable-a', settings: { axis: { value: 3 } }, untouched: true }]);
  assert.deepEqual(initial, [{ id: 'nullable-a', settings: null, untouched: true }]);
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
  assert.deepEqual(domain.read(), initial);
  console.log('PASS generic set merges a nested object into a null base and undo restores null');
} finally { release(); store.dispose(); f.dispose(); }
