import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shotsFixture } from './shots-fixture.mjs';
import { mountShots } from './shots-hook.mjs';

function withWindow(run) {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try { return run(globalThis.window); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}
test('the target-model None choice clears the persisted field through shot.set', () => {
  const f = shotsFixture();
  try {
    assert.equal(f.run('shot.set', { id: 'shot-a', set: { targetModel: 'seedance-2.5' } }).ok, true);
    const receipt = f.run('shot.set', { id: 'shot-a', set: { targetModel: null } });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(f.shots.read()[0].targetModel, undefined);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.equal(f.shots.read()[0].targetModel, 'seedance-2.5');
  } finally { f.dispose(); }
});
test('a retained owner captures the current render framing, not its first render', () => {
  const f = shotsFixture();
  try {
    const framing = { pos: { x: 4, y: 2, z: 6 }, yaw: 0.2, pitch: -0.1, fovDeg: 35 };
    const current = mountShots(f.scope.appContext.forRender({ ...f.scope, captureCurrentFraming: () => framing }));
    assert.equal(current.documentStore, f.shots.documentStore);
    current.addCameraKeyframe(7, 'shot-a');
    assert.deepEqual(f.shots.read()[0].cameraKeys.find(key => key.frame === 7).framing, framing);
  } finally { f.dispose(); }
});
test('crane ticks own one gesture and external cancellation retires its local session', () => withWindow(window => {
  const f = shotsFixture();
  const calls = [], run = f.binding.bus.run;
  f.binding.bus.run = (...args) => { const receipt = run(...args); calls.push(receipt); return receipt; };
  try {
    assert.equal(f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] }).ok, true);
    calls.length = 0;
    const before = f.snapshot(), depth = f.shots.documentStore.depths().past;
    for (const height of [2, 3, 4]) f.shots.changeCranePoints([{ t: 0, height: 1 }, { t: 1, height }], { dragging: true });
    assert.equal(f.shots.documentStore.depths().past, depth);
    window.dispatchEvent(new Event('pointerup'));
    const receipts = calls.filter(receipt => receipt.authored);
    assert.equal(receipts.length, 1, JSON.stringify(calls));
    assert.equal(receipts[0].undo.entries, 1);
    assert.equal(f.shots.documentStore.depths().past, depth + 1);
    assert.equal(f.run('edit.undo', { receiptId: receipts[0].receiptId }).status, 'undone');
    assert.deepEqual(f.snapshot(), before);
    calls.length = 0;
    f.shots.changeCraneRail([{ x: 0, z: 0 }, { x: 1, z: 2 }], { dragging: true });
    const tx = calls.find(receipt => receipt.action === 'run.begin');
    assert.equal(f.run('run.cancel', { txId: tx.txId }).ok, true);
    assert.doesNotThrow(() => f.shots.finishGesture(), 'a bus cancellation must retire the producer token');
    assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
}));
