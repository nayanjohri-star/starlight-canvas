import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture, motionBytes } from './generation-fixture.mjs';
import { deferred } from './fixture.mjs';
test('motion: a duplicate request cannot rewrite blocks and stale the running generation', async () => {
  const f = generationFixture(), originalFetch = globalThis.fetch, entered = deferred(), release = deferred();
  globalThis.fetch = async url => {
    if (url === '/ardy/generate') { entered.resolve(); await release.promise; return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n'); }
    return new Response(motionBytes);
  };
  let completion;
  try {
    const args = { characterId: 'actor-a', blocks: [{ id: 'block', text: 'Walk', startFrame: 0, endFrame: 96 }], seed: 17 };
    const started = await f.run('motion.generate', args, 'agent', { wait: false }); await entered.promise;
    const before = structuredClone(f.cast.read());
    const refused = await f.run('motion.generate', { ...args, blocks: [{ ...args.blocks[0], text: 'Run' }] });
    assert.equal(refused.code, 'TARGET_BUSY'); assert.deepEqual(f.cast.read(), before);
    completion = f.run('job.await', { jobId: started.jobId }); release.resolve();
    assert.equal((await completion).status, 'completed');
  } finally { release.resolve(); if (completion) await completion; f.binding.bus.dispose(); globalThis.fetch = originalFetch; f.dispose(); }
});
