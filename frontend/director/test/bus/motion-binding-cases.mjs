// Historical binding scenarios, now driven through motion.generate and jobs.
import assert from 'node:assert/strict';
import { generationFixture, motionBytes } from './generation-fixture.mjs';
import { appFixture } from './app-fixture.mjs';
import { sha256Hex } from '../../src/motion-resources.js';
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const bounded = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('motion binding signal deadline')), 15000); })]).finally(() => clearTimeout(timer)); };
export async function runMotionBindingCase(name) {
  const f = generationFixture(), originalFetch = globalThis.fetch, requests = [];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const held = ['selected-B-while-A-generates', 'edit-during-generation', 'stop-before-commit', 'motion-job-states'].includes(name);
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === '/ardy/generate') { entered.resolve(); if (held) await release.promise; return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n'); }
    assert.equal(url, '/ardy/motions/123456-abcdef'); return new Response(motionBytes);
  };
  const args = { characterId: 'actor-a', durationSeconds: 4, seed: 17, blocks: [{ id: 'stand', text: 'Stand', startFrame: 0, endFrame: 96 }] };
  let pending, unsubscribe;
  try {
    const before = f.snapshot();
    if (name === 'invalid-prepare') {
      const result = await f.run('motion.generate', { ...args, durationSeconds: 0 });
      assert.equal(result.ok, false); assert.equal(result.mutated, false); assert.deepEqual(f.snapshot(), before); assert.deepEqual(requests, []); return;
    }
    if (name === 'motion-preserves-playhead') { f.live.current.studioView.frame = 80; f.scope.tlFrameRef.current = 80; }
    let stored;
    if (name === 'agent-motion-survives-reload') {
      stored = Promise.withResolvers(); unsubscribe = f.motionCache.subscribe(stored.resolve);
    }
    const events = [];
    if (name === 'motion-job-states') unsubscribe = f.binding.bus.subscribe(event => events.push(event));
    const started = ok(await f.run('motion.generate', args, 'agent', { wait: false }));
    assert.equal(started.status, 'started'); await bounded(entered.promise);
    pending = f.run('job.await', { jobId: started.jobId }, 'agent');
    if (name === 'selected-B-while-A-generates') {
      f.cast.setActiveCharacterId('actor-b'); f.cast.switchActiveCharacterLayer();
      // The selected id is published to App's live read port on React render.
      f.live.current.activeCharacterId = 'actor-b';
    }
    if (name === 'edit-during-generation') ok(f.run('character.update', { characterId: 'actor-a', patch: { x: 2 } }));
    if (name === 'stop-before-commit') assert.equal((await f.run('job.cancel', { jobId: started.jobId })).code, 'CANCELLED');
    if (name === 'motion-job-states') assert.deepEqual(events, [], 'held generation has not completed');
    release.resolve(); const take = await bounded(pending);
    if (name === 'stop-before-commit' || name === 'edit-during-generation') {
      assert.equal(take.code, name === 'stop-before-commit' ? 'CANCELLED' : 'STALE_TARGET');
      assert.equal(f.motion.motionFor('actor-a'), null);
      assert.equal(requests.filter(url => url.endsWith('abcdef')).length, 0);
      if (name === 'edit-during-generation') assert.equal(f.cast.read()[0].x, 2);
      return;
    }
    ok(take); assert.equal(take.status, 'completed'); assert.equal(take.undo.entries, 1);
    assert.equal(f.motion.motionFor('actor-a').frames, 96);
    if (name === 'selected-B-while-A-generates') { assert.equal(f.binding.refresh().activeCharacterId, 'actor-b'); assert.equal(f.motion.motionFor('actor-b'), null); }
    if (name === 'motion-preserves-playhead') assert.equal(f.binding.context().view.frame, 80);
    if (name === 'motion-job-states') {
      assert.equal(events.length, 1); assert.equal(events[0].type, 'job.completed');
      assert.equal(events[0].jobId, started.jobId); assert.equal(events[0].receipt.status, 'completed');
    }
    if (['unverified-default-refusal', 'explicit-unverified-acceptance'].includes(name)) {
      const verified = await f.tools().internal.invoke('verify_result', { receiptId: take.receiptId, checks: ['motion'], visual: 'none' });
      assert.equal(verified.verification.status, 'unverified');
      assert.equal(verified.verification.evaluatedFrames, 96);
      // No pre-install policy/accept action remains. The actual take is already
      // installed; the user/agent rejects it using its retained history receipt.
      ok(f.run('edit.undo', { receiptId: take.receiptId })); assert.deepEqual(f.snapshot(), before);
    }
    if (name === 'agent-motion-survives-reload') {
      const record = await bounded(stored.promise), motion = f.motion.motionFor('actor-a');
      assert.equal(record.motionId, await sha256Hex(motionBytes));
      const installed = f.cast.read()[0].motionRef;
      assert.equal(installed.motionId, record.motionId); assert.equal(installed.url, '/ardy/motions/123456-abcdef');
      f.actual.undoScene(); assert.equal(f.motion.motionFor('actor-a'), null);
      f.actual.redoScene(); assert.deepEqual(f.cast.read()[0].motionRef, installed);
      const saved = JSON.parse(JSON.stringify(f.cast.read().map(({ sessionMotion, ...entry }) => entry)));
      const page = appFixture({ characters: saved, motionStore: f.motionCache.records });
      try {
        page.setUrlLoader(async url => { throw new Error(`Reload must use cached bytes, not ${url}`); });
        const restored = page.nextMotion(); page.actual.restoreMotionRefs(saved);
        const clip = await bounded(restored);
        assert.deepEqual([clip.rotMats, clip.rootPos, clip.posedJoints], [motion.rotMats, motion.rootPos, motion.posedJoints]);
        assert.deepEqual([clip.frames, clip.fps, clip.anchorX, clip.anchorZ, clip.rotationDeg], [motion.frames, motion.fps, motion.anchorX, motion.anchorZ, motion.rotationDeg]);
      } finally { page.dispose(); }
    }
  } finally { release.resolve(); if (pending) await pending; unsubscribe?.(); globalThis.fetch = originalFetch; f.dispose(); }
}
