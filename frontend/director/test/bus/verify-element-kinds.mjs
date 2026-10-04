import assert from 'node:assert/strict';
import * as elements from '../../src/commands/elements.js';
import { createStudioActionRegistry } from '../../src/studio-actions.js';
import { createDocumentStore } from '../../src/document-store.js';
import { createCommandBus } from '../../src/command-bus.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';

assert.equal(typeof elements.registerElementKind, 'function', 'generic set/read must expose an element-kind registry');
// A second kind proves the machinery consumes the registered spec, not a
// hard-coded stage branch or only the global STUDIO_ELEMENTS table.
const fields = [
  { path: 'fixture.amount', documentPath: 'nested.amount', type: 'number', agentExposure: 'patch' },
  { path: 'fixture.title', type: 'string', agentExposure: 'patch' },
];
elements.registerElementKind('fixture', {
  elements: fields,
  normalize: value => ({ ...value, nested: { amount: Math.min(10, value.nested.amount) } }),
});
const schema = elements.elementSetSchema('fixture');
assert.equal(schema.properties.nested.properties.amount.type, 'number');
assert.equal(schema.additionalProperties, false);
const patch = elements.elementPatchArgs('fixture', { ops: [{ target: { kind: 'fixture' }, set: { amount: 500, title: 'Changed' } }] });
assert.deepEqual(patch, { nested: { amount: 500 }, title: 'Changed' });
const store = createDocumentStore({ owned: { fixture: { nested: { amount: 1 }, title: 'Before' } } });
const registry = createStudioActionRegistry();
const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
elements.registerElementSet(registry, {
  storeDomain: domain => { assert.equal(domain, 'fixture'); return { read: () => store.read('fixture'), write: value => store.write('fixture', value) }; },
  state: () => ({ activeSceneId: host.sceneId }),
}, { id: 'fixture.set', label: 'Fixture', description: 'Registry fixture', kind: 'mutation', undoDomain: 'fixture', input: schema });
const journal = createStudioCommandJournal({ host });
const bus = createCommandBus({ registry, ports: {
  read: () => ({ ...store.getSnapshot(), host }), journal: () => journal,
  recordAction: store.recordAction, beginAction: store.beginAction,
} });
try {
  const receipt = bus.run('fixture.set', patch);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(elements.readElement(store.read('fixture'), 'fixture.amount'), 10);
  assert.deepEqual(elements.elementReadback('fixture', store.read('fixture')), [
    { path: 'fixture.amount', number: 10 }, { path: 'fixture.title', text: 'Changed' },
  ]);
  const reply = elements.readElementDocument({ fixture: store.read('fixture') }, { select: ['fixture'] }, host.sceneId);
  assert.deepEqual(reply.schema.fixture, schema);
  assert.deepEqual(reply.document.fixture, store.read('fixture'));
  assert.notEqual(reply.document.fixture, store.read('fixture'));
  store.undo();
  assert.equal(store.read('fixture').nested.amount, 1);
} finally { bus.dispose(); store.dispose(); }
// The stage module is itself a registration, while semantic commands only
// choose subsets of its generated schema.
await import('../../src/commands/elements/stage.js');
assert.equal(elements.elementSetSchema('stage').properties.keyLight.properties.intensity.type, 'number');
console.log('PASS self-registering stage and independent kind share generated set, normalization, patch, readback and document schema');
