import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, deferred, result } from './fixture.mjs';

for (const mode of ['finish', 'ceiling', 'cancel', 'foreground']) {
  test(`shared core: background-capable job ${mode}`, async () => {
    const f = fixture(), release = deferred(), entered = deferred(), timers = new Map(), events = [];
    let next = 0, signal;
    f.ports.setTimeout = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; };
    f.ports.clearTimeout = id => timers.delete(id);
    f.register('ai.prepareShot', async (_args, context) => {
      signal = context.signal; entered.resolve(); await release.promise;
      context.commit(() => f.edit(3)); return { ...result(), output: { installed: true } };
    }, { domain: 'shot', target: () => 'target', background: true, timeoutMs: 17 });
    const expire = ms => { const timer = [...timers.values()].find(row => row.ms === ms); assert.ok(timer, `missing ${ms}ms timer`); timer.fn(); };
    f.bus.subscribe(event => events.push(event));
    try {
      const request = f.request(), pending = f.bus.run('ai.prepareShot', {}, request);
      await entered.promise;
      if (mode === 'foreground') {
        release.resolve(); const done = await pending;
        assert.equal(done.status, 'completed'); assert.ok(done.undo.historyEntryId);
      } else {
        expire(17);
        const started = await pending;
        assert.equal(started.status, 'started', JSON.stringify(started)); assert.equal(signal.aborted, false);
        assert.equal((await f.bus.run('ai.prepareShot', {}, request)).jobId, started.jobId, 'idempotent admission');
        const awaited = f.bus.run(mode === 'cancel' ? 'job.cancel' : 'job.await', { jobId: started.jobId }, f.request());
        if (mode === 'ceiling') expire(300_000);
        release.resolve(); const done = await awaited;
        if (mode === 'finish') {
          assert.equal(done.status, 'completed'); assert.deepEqual(done.output, { installed: true });
          assert.ok(done.undo.historyEntryId);
          assert.equal(f.bus.run('edit.undo', { receiptId: done.receiptId }, f.request()).status, 'undone');
        } else { assert.equal(done.code, mode === 'ceiling' ? 'TIMEOUT' : 'CANCELLED'); assert.equal(signal.aborted, true); assert.equal(f.state.value, 0); }
      }
      assert.equal(events.filter(event => event.type === 'job.completed').length, 1);
      assert.equal(timers.size, 0);
    } finally { release.resolve(); f.bus.dispose(); }
  });
}
