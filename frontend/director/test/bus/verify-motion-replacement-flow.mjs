import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture, motionBytes } from './generation-fixture.mjs';

test('#452.2: agent generation, installed verification, optional repairs and receipt undo use only the bus', { timeout: 60000 }, async () => {
  const f = generationFixture(), originalFetch = globalThis.fetch, requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push(url);
      if (url === '/ardy/generate') return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n');
      if (url === '/ardy/motions/123456-abcdef') return new Response(motionBytes);
      throw new Error(`Unexpected fetch ${url}`);
    };
    const before = f.snapshot(), bones = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const invoke = f.tools().internal.invoke;
    const take = await invoke('generate_motion', { characterId: 'actor-a', source: { kind: 'generate', beats: [{ text: 'Stand' }], durationSeconds: 4, seed: 17 } });
    assert.equal(take.status, 'completed'); assert.equal(take.action, 'motion.generate');
    assert.equal(take.undo.entries, 1); assert.ok(f.motion.motionFor('actor-a'));
    const verify = () => invoke('verify_result', { targets: ['actor-a'], checks: ['motion'], visual: 'none' });
    const measured = await verify();
    assert.deepEqual(measured.unsupportedChecks, []);
    assert.equal(measured.verification.evaluatedFrames, 96);
    assert.equal(measured.verification.status, 'unverified', 'the hovering fixture must not be silently certified');
    assert.equal(measured.verification.unsupportedFrames, 96);
    const review = await invoke('run_action', { action: 'motion.autoPhysics', args: { characterId: 'actor-a', apply: false } });
    assert.equal(review.status, 'completed');
    const corrected = await invoke('run_action', { action: 'motion.fixCollisions', args: { characterId: 'actor-a', scope: 'frame' } });
    assert.equal(corrected.ok, true);
    assert.equal((await verify()).verification.evaluatedFrames, 96);
    if (corrected.undo) assert.equal((await invoke('run_action', { action: 'edit.undo', args: { receiptId: corrected.receiptId } })).status, 'undone');
    assert.equal((await invoke('run_action', { action: 'edit.undo', args: { receiptId: take.receiptId } })).status, 'undone');
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), bones);
    assert.equal(requests.filter(url => url === '/ardy/generate').length, 1);
    // The replacement must be the only editor installation surface, not a
    // second path alongside the private candidate protocol.
    for (const name of ['prepare_motion_install', 'verify_motion_candidate', 'repair_motion_candidate', 'commit_motion_candidate', 'discard_motion_candidate', 'cancel_motion_install']) {
      assert.equal(Object.hasOwn(f.binding.handlers, name), false, `retired editor operation ${name}`);
    }
  } finally { globalThis.fetch = originalFetch; f.dispose(); }
});
