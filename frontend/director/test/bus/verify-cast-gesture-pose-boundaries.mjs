import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
test('cast keyboard undo settles an open producer gesture before traversing history', () => {
  const f = castFixture();
  try {
    const before = f.snapshot();
    f.cast.beginGesture(); f.cast.updateCharacterAt(0, { x: 2 });
    f.actual.undoScene();
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.cast.documentStore.depths().future, 1);
    f.actual.redoScene(); assert.equal(f.cast.read()[0].x, 2);
  } finally { f.dispose(); }
});
test('generic pose picks replace the complete saved pose rather than merging old bone rotations', () => {
  const f = castFixture();
  try {
    const first = { id: 'first', bones: { lArm: [1, 0, 0] }, label: 'First' };
    const second = { id: 'second', bones: { rArm: [0, 1, 0] }, label: 'Second' };
    f.poses.push(first, second);
    ok(f.run('character.set', { id: 'actor-a', set: { pose: first.id } }));
    const receipt = ok(f.run('character.set', { id: 'actor-a', set: { pose: second.id } }));
    assert.deepEqual(f.cast.read()[0].pose, second);
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.deepEqual(f.cast.read()[0].pose, first);
  } finally { f.dispose(); }
});
