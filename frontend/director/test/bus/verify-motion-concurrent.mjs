import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture, motionBytes } from './generation-fixture.mjs';
import { deferred } from './fixture.mjs';

export const motionJobParity = [];
for (const origin of ['ui', 'agent', 'mcp', 'cli']) for (const edit of ['target', 'motion-domain', 'removed-target', 'unrelated-object']) {
  test(`#444.6: job after concurrent edit / ${origin} / ${edit}`, async () => {
    const f = generationFixture(), originalFetch = globalThis.fetch, entered = deferred(), release = deferred();
    let downloads = 0, pending;
    globalThis.fetch = async url => {
      if (url === '/ardy/generate') { entered.resolve(); await release.promise; return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n'); }
      downloads++; return new Response(motionBytes);
    };
    try {
      const started = await f.run('motion.generate', { characterId: 'actor-a', blocks: [{ id: 'block', text: 'Walk', startFrame: 0, endFrame: 96 }], seed: 17 }, origin, { wait: false });
      assert.equal(started.status, 'started', JSON.stringify(started)); await entered.promise;
      if (edit === 'target') assert.equal(f.run('character.update', { characterId: 'actor-a', patch: { x: 2 } }).ok, true);
      if (edit === 'motion-domain') assert.equal(f.run('ik.setKey', { characterId: 'actor-b', frame: 0, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }).ok, true);
      if (edit === 'removed-target') assert.equal(f.run('character.remove', { characterId: 'actor-a' }).ok, true);
      if (edit === 'unrelated-object') assert.equal((await f.call('arrange_objects', f.request('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { world: { x: 8, y: 0, z: 8 } } }] }))).ok, true);
      const afterEdit = f.snapshot();
      pending = f.run('job.await', { jobId: started.jobId }, origin); release.resolve();
      const done = await pending;
      if (edit === 'unrelated-object') {
        assert.equal(done.status, 'completed', JSON.stringify(done)); assert.ok(done.undo.historyEntryId); assert.equal(f.motion.motionFor('actor-a').frames, 96);
      } else {
        assert.equal(done.code, 'STALE_TARGET', JSON.stringify(done)); assert.deepEqual(f.snapshot(), afterEdit);
        assert.equal(downloads, 0, 'a stale response is fenced before decode, not only at publication');
      }
      const row = { command: 'motion.generate', origin, check: 'job after concurrent edit', edit, ok: true };
      motionJobParity.push(row); console.log('BUS PARITY ' + JSON.stringify(row));
    } finally { release.resolve(); if (pending) await pending; globalThis.fetch = originalFetch; f.dispose(); }
  });
}
