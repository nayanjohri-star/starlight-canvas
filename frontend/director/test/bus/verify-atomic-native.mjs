import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';
const f = appFixture();
try {
 const object = { ...createSceneObject('cube', []), id: 'object-1' };
 f.store.current.applyAtomic(() => [object]);
 const run = (id, args) => f.binding.bus.run(id, args, { origin: 'agent', host: f.host(), commandId: crypto.randomUUID(), expectedRevision: f.binding.refresh().revision });
 const beforeDepth = f.store.current.depths().past;
 const opened = await run('run.begin', { id: 'object.attach', args: { objectId: object.id, characterId: 'actor-a' } });
 const first = await run('run.update', { txId: opened.txId, args: { objectId: object.id, characterId: 'actor-a', bone: 'rightHand' } });
 assert.equal(first.ok, true, JSON.stringify(first));
 const second = await run('run.update', { txId: opened.txId, args: { objectId: object.id, characterId: 'actor-a', bone: 'leftHand' } });
 assert.equal(second.ok, true, JSON.stringify(second));
 const committed = await run('run.commit', { txId: opened.txId });
 assert.equal(committed.ok, true, JSON.stringify(committed));
 assert.equal(f.store.current.depths().past, beforeDepth + 1);
 assert.equal((await run('edit.undo', { receiptId: committed.receiptId })).status, 'undone');
 assert.deepEqual(f.store.current.objects, [object]);
 f.registry.register({ id: 'shot.composite', kind: 'mutation', undoDomain: 'shot', input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
  run: (_args, context) => { context.run('shot.create'); context.run('object.duplicate', { objectId: object.id }); return { affectedIds: f.live.current.shots.map(s => s.id), summary: 'Composite edit.' }; } });
 const receipt = await f.binding.bus.run('shot.composite', {}, { origin: 'ui' });
 assert.equal(receipt.ok, true, JSON.stringify(receipt));
 assert.ok(receipt.affectedIds.includes('copy-1'), 'nested targets are accumulated');
 assert.equal((await run('edit.undo', { receiptId: receipt.receiptId })).status, 'undone');
 assert.equal(f.live.current.shots.length, 0);
 assert.deepEqual(f.store.current.objects, [object]);
} finally { f.dispose(); }
console.log('PASS bus native atomicity: wire object previews and cross-domain nested Undo');
