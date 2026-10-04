import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { deferred } from './fixture.mjs';
const f = appFixture();
try {
 const completion = deferred();
 let context;
 f.stand.promptBlockCount = 1;
 f.actionHandlers.current.runAllPromptBlocks = value => { context = value; return completion.promise; };
 const event = deferred();
 const unsubscribe = f.binding.bus.subscribe(e => { if (e.type === 'job.completed') event.resolve(e); });
 const running = f.actual.runStudioAction('motion.generateAllBlocks');
 assert.ok(context.signal instanceof AbortSignal);
 completion.resolve();
 const completed = await running;
 assert.equal(completed?.status, 'completed', JSON.stringify(completed));
 assert.equal((await event.promise).receipt.receiptId, completed.receiptId);
 unsubscribe();
 const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
 f.registry.register({ id: 'shot.nested', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true,
  run: (_args, ctx) => { const created = ctx.run('shot.create'); ctx.run('shot.setCameraRail', { shotId: created.affectedIds[0], points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }); return { affectedIds: f.live.current.shots.map(s => s.id), summary: 'Two nested edits.' }; } });
 const before = f.scope.shotsDomain.documentStore.depths().past;
 const receipt = await f.actual.runStudioAction('shot.nested');
 assert.equal(receipt?.ok, true, JSON.stringify(receipt));
 assert.equal(f.scope.shotsDomain.documentStore.depths().past, before + 1);
 assert.equal(f.history.current.past.length, 0, 'nested shots do not add native cast entries');
 const undo = await f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId }, { origin: 'ui' });
 assert.equal(undo.status, 'undone', JSON.stringify(undo));
 assert.equal(f.live.current.shots.length, 0);
} finally { f.dispose(); }
console.log('PASS bus native adapters: deferred generation lifecycle and nested atomic undo');
