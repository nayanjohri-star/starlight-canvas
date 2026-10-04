import assert from 'node:assert/strict';
import { fixture, deferred, result } from './fixture.mjs';
for (const changed of ['shot', 'objects', 'token']) {
  const f = fixture(), ready = deferred(), release = deferred();
  f.register('ai.prepareShot', async (_args, context) => {
    ready.resolve(); await release.promise;
    return context.commit(() => { f.edit(20); return result(); });
  }, { domain: 'shot', target: () => 'target' });
  const events = [], off = f.bus.subscribe(event => events.push(event));
  const started = await f.bus.run('ai.prepareShot', {}, f.request('agent', { wait: false }));
  await ready.promise;
  assert.equal(started.status, 'started');
  assert.equal(typeof started.jobId, 'string');
  if (changed === 'token') f.patch({ tokens: { target: 'replacement' } });
  else f.edit(7, changed);
  const awaiting = f.bus.run('job.await', { jobId: started.jobId, timeoutMs: 1000 }, f.request());
  release.resolve();
  const done = await awaiting;
  if (changed === 'objects') {
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(f.state.value, 20, 'an unrelated edit does not invalidate the job');
    assert.ok(done.undo.historyEntryId);
  } else {
    assert.equal(done.code, 'STALE_TARGET', JSON.stringify(done));
    assert.equal(f.state.value, changed === 'token' ? 0 : 7, 'a stale job must apply nothing');
  }
  assert.equal(events.filter(event => event.type === 'job.completed').length, 1);
  assert.equal(events[0].jobId, started.jobId);
  off(); f.bus.dispose();
}
const f = fixture(), ready = deferred();
let signal;
f.register('ai.prepareShot', (_args, context) => { signal = context.signal; ready.resolve(); return new Promise(() => {}); });
const started = await f.bus.run('ai.prepareShot', {}, f.request('ui', { wait: false }));
await ready.promise;
const cancelled = await f.bus.run('job.cancel', { jobId: started.jobId }, f.request('ui'));
assert.equal(cancelled.code, 'CANCELLED');
assert.equal(signal.aborted, true);
assert.equal((await f.bus.run('job.await', { jobId: started.jobId, timeoutMs: 1000 }, f.request('ui'))).code, 'CANCELLED');
f.bus.dispose();
console.log('PASS bus acceptance 5: target/domain fence, unrelated edits, job await/cancel and completion events');
