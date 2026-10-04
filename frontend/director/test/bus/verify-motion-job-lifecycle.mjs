import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture, motionBytes } from './generation-fixture.mjs';
import { deferred } from './fixture.mjs';

test('#444.5: generation after its foreground deadline returns started, then awaits one undoable install', async () => {
  const f = generationFixture(), fetch = globalThis.fetch, timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const entered = deferred(), release = deferred(), timers = new Map(), events = [];
  let running;
  globalThis.setTimeout = (fn, ms, ...args) => { if (![1000, 300000].includes(ms)) return timeout(fn, ms, ...args); const id = {}; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => { if (!timers.delete(id)) clear(id); };
  globalThis.fetch = async url => {
    if (url === '/ardy/generate') { entered.resolve(); await release.promise; return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n'); }
    return new Response(motionBytes);
  };
  f.binding.bus.subscribe(event => events.push(event));
  try {
    running = f.run('motion.generate', { characterId: 'actor-a', blocks: [{ id: 'block', text: 'Walk', startFrame: 0, endFrame: 96 }], seed: 17 }, 'agent');
    await entered.promise;
    assert.equal(f.motion.motionFor('actor-a'), null);
    const foreground = [...timers.values()].find(timer => timer.ms === 1000); assert.ok(foreground);
    foreground.fn();
    const started = await running;
    assert.equal(started.status, 'started', JSON.stringify(started)); assert.ok(started.jobId);
    const completed = f.run('job.await', { jobId: started.jobId }, 'agent');
    release.resolve(); const receipt = await completed;
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); assert.equal(receipt.undo.entries, 1);
    assert.equal(f.motion.motionFor('actor-a').frames, 96); assert.equal(f.motion.documentStore.depths().past, 1);
    assert.equal(events.filter(event => event.type === 'job.completed').length, 1);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone'); assert.equal(f.motion.motionFor('actor-a'), null);
    assert.equal(timers.size, 0);
  } finally { release.resolve(); if (running) await running; globalThis.fetch = fetch; globalThis.setTimeout = timeout; globalThis.clearTimeout = clear; f.dispose(); }
});
