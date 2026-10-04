import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema, readElement } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';
const kind = 'fixtureVector';
registerElementKind(kind, { collection: true,
  elements: [
    { path: `${kind}.position`, type: 'vec3', agentExposure: 'patch', documentPath: { x: 'x', y: 'y', z: 'z' } },
    { path: `${kind}.rotation`, type: 'vec3', agentExposure: 'patch', documentPath: { x: 'rotX', y: 'rot', z: 'rotZ' } },
    { path: `${kind}.scale`, type: 'vec3', agentExposure: 'patch', documentPath: { x: 'scaleX', y: 'scaleY', z: 'scaleZ' } },
  ], normalize: row => ({ ...row, y: Math.max(0, row.y) }),
});
const f = stageFixture(), app = f.scope.appContext;
const initial = [{ id: 'vector-a', x: 0, y: 0, z: 0, rotX: 0, rot: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, untouched: true }];
const store = createDocumentStore({ owned: { [kind]: initial } });
const domain = { documentStore: store, document: () => ({ [kind]: store.read(kind) }), read: () => store.read(kind), write: value => store.write(kind, value),
  beginAction: () => store.beginAction(kind), canUndo: id => store.canUndo(id), stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
const release = app.registerStoreDomain(kind, domain);
try {
  registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: 'Vector', description: 'Split fields', kind: 'mutation', undoDomain: kind, input: elementSetSchema(kind) });
  const set = { position: { x: 4, y: -2, z: 6 }, rotation: { x: 10, y: 20, z: 30 }, scale: { x: 2, y: 3, z: 4 } };
  const direct = f.run(`${kind}.set`, { id: 'vector-a', set });
  assert.equal(direct.status, 'applied', JSON.stringify(direct));
  const expected = [{ id: 'vector-a', x: 4, y: 0, z: 6, rotX: 10, rot: 20, rotZ: 30, scaleX: 2, scaleY: 3, scaleZ: 4, untouched: true }];
  assert.deepEqual(domain.read(), expected);
  assert.deepEqual(readElement(domain.read()[0], `${kind}.position`), { x: 4, y: 0, z: 6 });
  assert.equal(f.run('edit.undo', { receiptId: direct.receiptId }).status, 'undone');
  const alias = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind, id: 'vector-a' }, set }] }));
  assert.equal(alias.status, 'partial', JSON.stringify(alias));
  assert.deepEqual(domain.read(), expected, 'direct and alias sets have identical stored fields');
  assert.deepEqual(alias.ops[0].droppedPaths, [`${kind}.position`]);
  assert.deepEqual(alias.delta[0].after.patched, [
    { path: `${kind}.position`, vec: { x: 4, y: 0, z: 6 } },
    { path: `${kind}.rotation`, vec: set.rotation }, { path: `${kind}.scale`, vec: set.scale },
  ]);
  console.log('PASS #480.3b split vec3 fields, canonical readback and direct/alias parity');
} finally { release(); store.dispose(); f.dispose(); }
