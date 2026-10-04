import { createDocumentStore } from '../../src/document-store.js';
import { createCommandBus } from '../../src/command-bus.js';
import { createStudioActionRegistry } from '../../src/studio-actions.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';

export function documentFixture(options = {}) {
  const store = createDocumentStore({ owned: { stage: { intensity: 1 }, shot: { frame: 0 } }, dev: true, ...options });
  const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
  const receipts = new Map();
  const read = () => ({ ...store.getSnapshot(), host });
  const registry = createStudioActionRegistry({ readState: read });
  const journal = createStudioCommandJournal({ host, isRetained: r => store.isRetained(r.undo?.historyEntryId) });
  const bus = createCommandBus({ registry, ports: {
    read, journal: () => journal,
    beginAction: store.beginAction, recordAction: store.recordAction,
    remember: r => receipts.set(r.receiptId, r), receipt: id => receipts.get(id),
    isRetained: r => store.isRetained(r.undo?.historyEntryId),
    canUndo: r => store.canUndo(r.undo?.historyEntryId), undo: store.undo,
    readTarget: () => 'target-token',
  } });
  const register = (id, domain, run, extra = {}) => registry.register({ id, kind: 'mutation', undoDomain: domain,
    input: { type: 'object', properties: { value: { type: 'number' }, ...(domain === 'motion' ? { characterId: { type: 'string', default: 'actor' } } : {}) }, required: ['value'], additionalProperties: false },
    available: () => true, run: (args, context) => { const result = run(args, context); return result ?? { affectedIds: ['target'], summary: 'Authored edit.' }; }, ...extra });
  register('stage.set', 'stage', ({ value }) => { store.write('stage', { intensity: value }); });
  register('shot.set', 'shot', ({ value }) => { store.write('shot', { frame: value }); });
  const run = (id, args = {}, origin = 'ui', options = {}) => bus.run(id, args, { origin, host, expectedRevision: store.getSnapshot().revision, ...options });
  return { store, bus, run, register, host };
}
