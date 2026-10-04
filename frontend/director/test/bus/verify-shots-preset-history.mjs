import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
const f = objectsFixture();
try {
  const snapshot = () => structuredClone({ stage: f.stage.read(), shots: f.scope.shotsDomain.read(), camera: f.actual.readStudioState().camera });
  const before = snapshot();
  const preset = f.run('shot.frame', { preset: 'mocapInteraction' });
  assert.equal(preset.ok, true, JSON.stringify(preset));
  assert.equal(f.stage.read().cameraPresetId, 'mocapInteraction', 'the legacy preset label remains persisted');
  assert.equal(preset.undo.entries, 1);
  const framed = snapshot();
  const manual = f.run('shot.placeCamera', { x: 3 });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  assert.equal(f.stage.read().cameraPresetId, null, 'manual placement invalidates the recorded preset');
  assert.equal(f.run('edit.undo', { receiptId: manual.receiptId }).status, 'undone');
  assert.deepEqual(snapshot(), framed);
  assert.equal(f.run('edit.undo', { receiptId: preset.receiptId }).status, 'undone');
  assert.deepEqual(snapshot(), before, 'one preset receipt restores both camera and stage metadata');
  console.log('PASS shot framing composes stage preset metadata in the same undo entry');
} finally { f.dispose(); }
