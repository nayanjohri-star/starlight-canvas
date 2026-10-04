// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectFixture } from './bus/project-fixture.mjs';
import { writeMotionSnapshot } from '../src/motion-snapshot.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';

const f = projectFixture({ singleScene: true });
const take = { frames: 2, fps: 24, rotMats: new Float32Array(486), rootPos: new Float32Array(6), posedJoints: new Float32Array(162), personScale: 1 };
for (let frame = 0; frame < 2; frame++) for (let joint = 0; joint < 27; joint++) {
  take.rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (frame * 27 + joint) * 9);
  take.posedJoints.set(CSKEL27_NEUTRAL[joint], (frame * 27 + joint) * 3);
}
const source = writeMotionSnapshot(take);
const original = source.slice();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let writes = 0;
const cache = new class extends WeakMap { set(key, value) { writes++; return super.set(key, value); } }();
const characterId = f.scope.actorStageRef.current.characters[0].id;
Object.assign(f.scope, { motionFullRef: { current: new Map([[characterId, { sourceBytes: source }]]) },
  motionEncodingCacheRef: { current: cache }, projectMotionsRef: { current: new Map() } });
async function serialize(frozen = f.project.captureProjectSave('Heist'), check) {
  const document = JSON.parse(await f.project.collectProjectSerialized('Heist', frozen, check));
  const id = document.scenes.scenes[0].stage.characters.find(row => row.id === characterId).motionRef.motionId;
  return document.resources.motions.find(row => row.motionId === id);
}
try {
  const frozen = f.project.captureProjectSave('Heist');
  assert.equal(frozen.fullSourceIdentities.get(characterId), source);
  assert.notEqual(frozen.fullSources.get(characterId), source);
  const first = await serialize(frozen);
  assert.equal(first.motionId, hash(original)); assert.equal(writes, 1);
  const cached = cache.get(source);
  await serialize(); await serialize();
  assert.equal(cache.get(source), cached); assert.equal(writes, 1, 'unchanged saves reuse the actual owner encoding cache');

  // DOS timestamp in a ZIP local header can change without changing its valid
  // motion arrays. Change it in place to exercise identical identity/new bytes.
  assert.deepEqual([...source.slice(0, 4)], [0x50, 0x4b, 3, 4]); source[10] ^= 1;
  const changedHash = hash(source); assert.notEqual(changedHash, first.motionId);
  const changed = await serialize();
  assert.equal(changed.motionId, changedHash); assert.equal(writes, 2);
  await serialize(); assert.equal(writes, 2);
  const older = await serialize(frozen);
  assert.equal(older.motionId, hash(original));
  assert.deepEqual(Buffer.from(older.data, 'base64'), Buffer.from(original));
  assert.equal(writes, 3, 'an old frozen save cannot reuse the newer content record');
  await serialize(); assert.equal(writes, 4); await serialize(); assert.equal(writes, 4);

  // A guard failure after awaiting the cache digest must not publish/re-encode.
  const stop = new Error('retired save'); let checkpoints = 0;
  await assert.rejects(serialize(undefined, () => { if (++checkpoints === 5) throw stop; }), error => error === stop);
  assert.equal(writes, 4);
  // Corruption with the same identity must be validated, never masked by cache.
  source.fill(0);
  await assert.rejects(serialize(), error => error.code === 'bad-npz');
  assert.equal(writes, 4); assert.equal(cache.get(source).motionId, changedHash);
  console.log('PASS actual scene owner: frozen NPZ bytes, unchanged encoding reuse, in-place edits, stale snapshots, guard and corruption');
} finally { f.dispose(); }
