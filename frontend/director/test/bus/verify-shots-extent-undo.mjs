import assert from 'node:assert/strict';
import { shotsFixture } from './shots-fixture.mjs';
const f = shotsFixture();
try {
  Object.assign(f.scope, { characters: f.characterRef.current, activeChar: f.characterRef.current[0],
    motion: null, promptClips: f.buffer.current.promptClips, multiModelFootage: null });
  f.shots.syncTimelineExtent();
  assert.equal(f.run('shot.setCameraRail', { shotId: 'shot-a', points: [{ x: 0, z: 0 }, { x: 1, z: 2 }] }).ok, true);
  // A take can finish hydrating after a camera edit. Its new extent is one
  // update; the effect re-render caused by Undo must not author it again.
  f.scope.motion = { frames: 432 };
  f.shots.syncTimelineExtent();
  assert.equal(f.live.current.timeline.frameCount, 432);
  f.actual.undoScene();
  const undone = f.snapshot(), depths = f.shots.documentStore.depths();
  assert.equal(depths.future, 1);
  f.shots.syncTimelineExtent();
  assert.deepEqual(f.snapshot(), undone, 'a shot-history render must not recreate the extent edit');
  assert.deepEqual(f.shots.documentStore.depths(), depths, 'Undo retains its redo entry');
  f.actual.redoScene();
  assert.equal(f.live.current.timeline.frameCount, 432);
  f.scope.motion = { frames: 240 };
  f.shots.syncTimelineExtent();
  assert.equal(f.live.current.timeline.frameCount, 240, 'a changed take still resizes the timeline');
  console.log('PASS timeline extent reacts to content changes without overwriting shot Undo');
} finally { f.dispose(); }
