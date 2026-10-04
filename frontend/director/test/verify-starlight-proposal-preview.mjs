import assert from 'node:assert/strict';
import { beginProposalPreview } from '../integration/proposal-preview.js';
import { motionFixture } from './bus/motion-fixture.mjs';
const f = motionFixture(), context = f.scope.appContext;
const snapshot = () => structuredClone({ cast: context.storeDomain('cast').documentStore.getSnapshot().slices,
  motion: context.storeDomain('motion').documentStore.getSnapshot().slices });
const commands = [
  { id: 'character.addWaypoint', args: { characterId: 'actor-a', frame: 30, position: { x: 1, z: 2 } } },
  { id: 'ik.applyPose', args: { characterId: 'actor-a', frame: 0, pose: { bones: { lArm: [.5, .1, 0] } } } },
];
try {
  const before = snapshot(), history = context.historyEntry();
  const first = beginProposalPreview(context, commands);
  assert.notDeepEqual(snapshot(), before); assert.equal(context.historyEntry(), history, 'a preview creates no committed history');
  assert.equal(f.run('character.addWaypoint', { characterId: 'actor-a', frame: 60, position: { x: 2, z: 2 } }).code, 'TARGET_BUSY');
  first.discard(); assert.deepEqual(snapshot(), before); assert.equal(first.discard(), false);
  const second = beginProposalPreview(context, commands), after = snapshot();
  const applied = second.apply(); assert.ok(applied.historyEntryId); assert.equal(context.historyEntry(), applied.historyEntryId);
  assert.equal(second.discard(), false); assert.throws(() => second.apply(), /ended/);
  assert.equal(f.run('edit.undo').ok, true); assert.deepEqual(snapshot(), before, 'one native undo restores both cast and motion owners');
  assert.equal(f.run('edit.redo').ok, true); assert.deepEqual(snapshot(), after);
  assert.throws(() => beginProposalPreview(context, [{ id: 'motion.applyPreset', args: {} }]), /cannot be previewed/);
  assert.throws(() => beginProposalPreview(context, []), /1–32/);
  f.run('edit.undo');
  assert.throws(() => beginProposalPreview(context, [commands[0], { id: 'character.moveWaypoint', args:
    { characterId: 'actor-a', frame: 60, position: { x: 3, z: 2 } } }]), /waypoint|path|pin|경로|웨이/);
  assert.deepEqual(snapshot(), before, 'an actual native command refusal rolls back earlier provisional edits');
  const disposable = beginProposalPreview(context, commands); f.binding.bus.dispose(); assert.deepEqual(snapshot(), before);
  assert.equal(disposable.discard(), false);
  console.log('PASS real App owners and command bus: live preview, discard, one compound undo/redo, failure rollback and disposal without model jobs');
} finally { f.dispose(); }
