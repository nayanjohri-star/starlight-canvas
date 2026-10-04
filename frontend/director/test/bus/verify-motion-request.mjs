import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenerationRequest } from '../../src/motion/generation.js';
import { judgeAuthoredPath, toSceneRootOffset } from '../../src/ardy/waypoints.js';

test('#444.1: an infeasible root leg is a coded refusal carrying the path judge result', () => {
  const character = { x: 0, z: 0, rot: 0 }, waypoints = [{ frame: 24, x: 0, z: 4 }];
  const judge = judgeAuthoredPath([{ frame: 0, x: 0, z: 0, heading: null }, ...waypoints], 24, 96);
  assert.throws(() => buildGenerationRequest({ character, waypoints, waypointMode: true, prompt: 'Walk', durationSeconds: 4, seed: 17 }), error => {
    assert.equal(error.code, 'INVALID_RANGE');
    // Compare shipped judge output, not a separately pinned prose sentence.
    assert.ok(error.message.includes(judge.errors[0]));
    assert.ok(error.uiMessage); return true;
  });
});

const base = { character: { x: 2, z: 3, rot: 30 }, prompt: 'Walk', durationSeconds: 4, seed: 17 };
const blocks = [{ startFrame: 0, endFrame: 48, text: 'Walk' }, { startFrame: 48, endFrame: 96, text: 'Stop' }];
test('#444.2: blocks and a world-space path survive together without mutating the inputs', () => {
  const input = { ...base, blocks, waypoints: [{ frame: 72, x: 2, z: 6 }] }, before = structuredClone(input);
  const request = buildGenerationRequest(input);
  assert.deepEqual(request.body.segments, blocks.map(({ startFrame, endFrame, text }) => ({ startFrame, endFrame, prompt: text })));
  const endpoint = request.body.waypoints.at(-1), world = toSceneRootOffset(endpoint.x, endpoint.z, request.rootRotationDeg);
  assert.ok(Math.abs(world.x) < 1e-8); assert.ok(Math.abs(world.z - 3) < 1e-8);
  assert.equal(request.body.posePin, false); assert.equal(request.body.seed, 17);
  assert.deepEqual(input, before); assert.deepEqual(buildGenerationRequest(input), request);
});
test('#444.2: preserve follows matching duration/prompt, fresh and schedule exclusions', () => {
  const recipe = { seed: 17, blocks: [{ prompt: 'Walk', duration: 4 }], lineEdits: [] };
  const input = { ...base, motion: { frames: 96, fps: 24, url: '/ardy/motions/source' }, recipe };
  assert.deepEqual(buildGenerationRequest(input).body.preserve, { sourceMotion: input.motion.url, strength: 0.5, editRanges: [] });
  for (const patch of [{ fresh: true }, { prompt: 'Run' }, { durationSeconds: 5 }, { blocks }, { preserveStrength: 0 }, { recipe: null }]) {
    assert.equal(buildGenerationRequest({ ...input, ...patch }).body.preserve, undefined);
  }
});
test('#444.2: pose placement, IK edits and seed/replay lineage are data, not rig effects', () => {
  const pose = { joints: [1, 2, 3] };
  const pinned = buildGenerationRequest({ ...base, startFromPose: true, posePlacement: 'end', poses: [{ frame: 95, pose }] });
  assert.deepEqual(pinned.constraintFrames, [95]); assert.deepEqual(pinned.body.poses, [{ frame: 95, pose }]);
  assert.equal(buildGenerationRequest({ ...base, blocks, startFromPose: true }).body.posePin, false);
  const ikKeys = new Map([[24, new Map([['leftHand', {}]])]]);
  const edited = buildGenerationRequest({ ...base, blocks, motion: { frames: 96, fps: 24, url: '/ardy/motions/source' }, ikKeys, poses: [{ frame: 24, pose }] });
  assert.equal(edited.body.motionEdit.sourceMotion, '/ardy/motions/source');
  assert.deepEqual(edited.committedEditKeys, [{ frame: 24, tracks: ['leftHand'] }]);
  assert.equal(edited.body.segments, undefined);
  const recipe = { seed: 17, blocks: [], lineEdits: [{ track: 'root', frameRange: [0, 24], pins3d: [] }] };
  assert.deepEqual(buildGenerationRequest({ ...base, recipe }).body.replay, recipe.lineEdits);
  assert.equal(buildGenerationRequest({ ...base, recipe: { ...recipe, seed: null } }).body.replay, undefined);
  assert.throws(() => buildGenerationRequest({ ...base, seed: -1 }), { code: 'INVALID_ARGUMENT' });
});
