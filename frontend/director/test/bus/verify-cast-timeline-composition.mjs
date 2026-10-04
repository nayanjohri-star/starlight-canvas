import assert from 'node:assert/strict';
import { castFixture } from './cast-fixture.mjs';
const f = castFixture();
try {
  const shots = f.scope.shotsDomain;
  shots.load({ ...shots.state(), frameCount: 360, camera: f.actual.readStudioCamera() });
  const before = { cast: f.snapshot(), shots: structuredClone(shots.state()) };
  const receipt = f.run('character.addPromptBlock', { characterId: 'actor-a', frame: 0 });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const renderExtent = () => {
    Object.assign(f.scope, { characters: f.characterRef.current, activeChar: f.characterRef.current[0],
      promptClips: f.buffer.current.promptClips, motion: f.buffer.current.motion, multiModelFootage: null });
    shots.syncTimelineExtent();
  };
  renderExtent();
  assert.equal(shots.state().frameCount, 48);
  const undone = f.run('edit.undo', { receiptId: receipt.receiptId });
  assert.equal(undone.status, 'undone', JSON.stringify(undone));
  renderExtent();
  assert.deepEqual({ cast: f.snapshot(), shots: shots.state() }, before);
  assert.equal(f.cast.documentStore.depths().future, 1);
  console.log('PASS prompt authoring composes the content-driven timeline before the render effect; one undo restores both');
} finally { f.dispose(); }
