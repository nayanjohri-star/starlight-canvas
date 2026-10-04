import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema } from '../../src/commands/elements.js';
import { stageFixture } from './stage-fixture.mjs';

export const kind = 'fixtureItem';
registerElementKind(kind, {
  collection: true,
  elements: [
    { path: `${kind}.amount`, type: 'number', agentExposure: 'patch' },
    { path: `${kind}.name`, type: 'string', agentExposure: 'patch' },
  ],
  normalize: value => ({ ...value, amount: Math.min(10, value.amount) }),
});
export function collectionFixture(undoDomain = kind) {
  const f = stageFixture(), app = f.scope.appContext;
  const store = createDocumentStore({ owned: { [kind]: [
    { id: 'item-a', amount: 0, name: 'A' }, { id: 'item-b', amount: 2, name: 'B' },
  ] } });
  const domain = {
    documentStore: store, document: () => ({ [kind]: store.read(kind) }),
    read: () => store.read(kind), write: value => store.write(kind, value),
    beginAction: () => store.beginAction(kind), canUndo: id => store.canUndo(id),
    stepHistory: redo => Boolean((redo ? store.redo : store.undo)()),
  };
  const release = app.registerStoreDomain(undoDomain, domain);
  registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: 'Fixture item', description: 'Collection fixture',
    kind: 'mutation', undoDomain, input: elementSetSchema(kind) });
  const patch = ops => f.binding.handlers.patch_elements(f.request('patch_elements', { ops }));
  return { ...f, domain, patch, dispose() { release(); store.dispose(); f.dispose(); } };
}
