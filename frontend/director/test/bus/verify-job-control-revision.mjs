import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, deferred, result } from './fixture.mjs';

for (const action of ['job.await', 'job.cancel']) {
  test(`shared core: ${action} follows job identity, not an obsolete authored revision`, async () => {
    const f = fixture(), release = deferred(), completed = deferred();
    f.register('ai.prepareShot', async (_args, ctx) => { await release.promise; ctx.commit(() => f.edit(2)); return result(); }, { domain: 'shot' });
    const off = f.bus.subscribe(event => { if (event.type === 'job.completed') completed.resolve(event); });
    try {
      const started = await f.bus.run('ai.prepareShot', {}, f.request('agent', { wait: false }));
      // The controller refreshed here, but another authored transition reaches
      // the editor before its subsequent wire control command. Force that order.
      const admitted = f.request('agent');
      if (action === 'job.await') { release.resolve(); await completed.promise; }
      else f.edit(1, 'objects');
      const outcome = await f.bus.run(action, { jobId: started.jobId }, admitted);
      if (action === 'job.await') { assert.equal(outcome.status, 'completed', JSON.stringify(outcome)); assert.ok(outcome.undo.historyEntryId); }
      else { assert.equal(outcome.code, 'CANCELLED', JSON.stringify(outcome)); assert.equal(f.state.value, 1); }
      assert.equal((await f.bus.run(action, { jobId: started.jobId }, { ...f.request(), host: { ...f.state.host, documentEpoch: 'other' } })).code, 'STALE_SCENE');
    } finally { release.resolve(); try { await completed.promise; } finally { off(); f.bus.dispose(); } }
  });
}
