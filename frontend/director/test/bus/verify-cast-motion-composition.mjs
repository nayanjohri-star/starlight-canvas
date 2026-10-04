import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture } from './generation-fixture.mjs';
import { installGenerated as install, prepareGeneration } from './install-generated-motion.mjs';
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const snapshot = f => ({ cast: structuredClone(f.cast.read()), motion: f.snapshot(),
  shots: structuredClone(f.scope.shotsDomain.state()) });

test('cast/motion: generation retains one composite receipt and restores both owners', async () => {
  const f = generationFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    prepareGeneration(f);
    const before = snapshot(f);
    const receipt = ok(await install(f));
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.undo.entries, 1);
    assert.ok(f.cast.read()[0].motionRef); assert.ok(f.buffer.current.motion);
    assert.equal(f.ports.isRetained(receipt), true);
    assert.equal(ok(f.run('edit.undo', { receiptId: receipt.receiptId })).status, 'undone');
    assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});

test('cast/motion: pose apply and reset clear the take in one undoable and cancellable gesture', async () => {
  const f = generationFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    ok(await install(f));
    const before = snapshot(f);
    const applied = ok(f.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave', clearMotion: true }));
    assert.equal(f.cast.read()[0].pose.id, 'pose-wave'); assert.equal(f.buffer.current.motion, null);
    assert.equal(f.cast.read()[0].motionRef, null); assert.equal(applied.undo.entries, 1);
    assert.equal(ok(f.run('edit.undo', { receiptId: applied.receiptId })).status, 'undone');
    assert.deepEqual(snapshot(f), before);
    const tx = ok(f.run('run.begin', { id: 'character.setPose', args: { characterId: 'actor-a', pose: null, clearMotion: true } }));
    ok(f.run('run.update', { txId: tx.txId, args: { characterId: 'actor-a', pose: null, clearMotion: true } }));
    assert.equal(f.buffer.current.motion, null);
    ok(f.run('run.cancel', { txId: tx.txId })); assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});
