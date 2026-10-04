import assert from 'node:assert/strict';
import { documentFixture } from './document-store-fixture.mjs';

const { store, bus, run, register } = documentFixture();
const before = store.getSnapshot();
try {
  const opened = run('run.begin', { id: 'stage.set', args: { value: 1 } });
  run('run.update', { txId: opened.txId, args: { value: 2 } });
  run('run.update', { txId: opened.txId, args: { value: 9 } });
  const cancelled = run('run.cancel', { txId: opened.txId });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.deepEqual(store.getSnapshot().slices, before.slices);
  assert.equal(store.read('stage'), before.slices.stage);
  assert.equal(store.getSnapshot().domainRevisions.stage, 3, 'rollback advances the job fence, never rewinds it');
  assert.deepEqual(store.depths(), { past: 0, future: 0 });
  const abandoned = store.beginAction('stage');
  abandoned.run(() => store.write('stage', { intensity: 4 }));
  abandoned.cancel();
  assert.throws(() => abandoned.run(() => store.write('stage', { intensity: 5 })), { code: 'STALE_TARGET' });
  assert.equal(abandoned.cancel(), false);
  register('stage.fail', 'stage', () => { store.write('stage', { intensity: 99 }); throw new Error('Rejected edit'); });
  assert.equal(run('stage.fail', { value: 0 }).ok, false);
  assert.deepEqual(store.getSnapshot().slices, before.slices);
  await assert.rejects(store.recordAction('stage', async () => {
    store.write('stage', { intensity: 100 }); throw new Error('Rejected async edit');
  }), /Rejected async edit/);
  assert.deepEqual(store.getSnapshot().slices, before.slices);
  assert.equal(run('stage.set', { value: 7 }).ok, true, 'failure releases the transaction');
} finally { bus.dispose(); }
console.log('PASS document store 2: cancellation and rejected actions restore the pre-image and retire the session');
