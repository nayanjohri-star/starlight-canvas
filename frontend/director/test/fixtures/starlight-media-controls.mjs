// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';

function checkedClock(value) {
  // The version-4 authoring serializer omits only its canonical 24-fps default.
  const authorFps = value.authorFps === undefined ? 24 : value.authorFps;
  assert.ok([24, 30].includes(authorFps), 'Unknown authored timeline fps');
  assert.ok([24, 30].includes(value.liveFps), 'Unknown live timeline fps');
  for (const [name, count] of [['authorFrameCount', value.authorFrameCount], ['liveFrameCount', value.liveFrameCount]]) {
    assert.ok(Number.isSafeInteger(count) && count > 0, `Invalid ${name}`);
  }
  assert.ok(Number.isSafeInteger(value.shotStart) && Number.isSafeInteger(value.shotEnd)
    && value.shotStart >= 0 && value.shotEnd >= value.shotStart, 'Invalid authored shot range');
  return { ...value, authorFps };
}
const settled = value => value.authorFps === value.liveFps && value.authorFrameCount === value.liveFrameCount
  && value.shotStart === value.liveRangeStart && value.shotEnd === value.liveRangeEnd;

// Read the actual serializer and live ports together. A successful fps command
// can resample duration; decide the next mutation ONLY after those ports agree.
export async function synchronizeMediaClock({ fps, seconds, shotId, read, run, timeoutMs = 20_000,
  now = Date.now, delay = () => new Promise(resolve => setTimeout(resolve, 100)), onCommand = () => {} }) {
  assert.ok([24, 30].includes(fps), 'Unsupported requested fps');
  assert.ok(Number.isFinite(seconds) && seconds > 0, 'Invalid requested duration');
  const count = Math.round(fps * seconds);
  assert.ok(Number.isSafeInteger(count) && count > 0, 'Invalid requested frame count');
  assert.ok(typeof shotId === 'string' && shotId, 'Actual QA shot id is required');
  async function wait(predicate, phase) {
    const deadline = now() + timeoutMs; let value;
    while (now() < deadline) {
      value = checkedClock(await read());
      if (settled(value) && predicate(value)) return value;
      await delay();
    }
    throw new Error(`Media clock did not settle (${phase}): ${JSON.stringify(value)}`);
  }
  async function command(id, args) {
    onCommand(id, args);
    const receipt = await run(id, args);
    assert.equal(receipt?.ok, true, `${id}: ${JSON.stringify(receipt)}`);
  }
  let value = await wait(() => true, 'initial authored/live ports');
  if (value.authorFps !== fps) {
    await command('shot.setFps', { fps });
    value = await wait(value => value.authorFps === fps, 'fps resampling');
  }
  if (value.authorFrameCount !== count) {
    await command('shot.setDuration', { seconds });
    value = await wait(value => value.authorFps === fps && value.authorFrameCount === count, 'duration');
  }
  if (value.shotStart !== 0 || value.shotEnd !== count - 1) {
    await command('shot.setRange', { shotId, range: { startFrame: 0, endFrameExclusive: count } });
    value = await wait(value => value.authorFps === fps && value.authorFrameCount === count
      && value.shotStart === 0 && value.shotEnd === count - 1, 'shot range');
  }
  assert.equal(value.liveFps, fps); assert.equal(value.liveFrameCount, count);
  assert.equal(value.liveRangeStart, 0); assert.equal(value.liveRangeEnd, count - 1);
  return count;
}

// These commands affect the real window/target. Focus emulation stays disabled;
// an activation receipt alone is never accepted as proof of actual visibility.
export async function activateActualForeground({ send, targetId, readVisibility, timeoutMs = 20_000,
  now = Date.now, delay = () => new Promise(resolve => setTimeout(resolve, 100)) }) {
  await send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await send('Target.activateTarget', { targetId });
  const initialVisibility = await readVisibility(); let restoredWindow = false;
  if (initialVisibility !== 'visible') {
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    assert.ok(Number.isInteger(windowId), 'Actual native browser window id is required');
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await send('Target.activateTarget', { targetId }); restoredWindow = true;
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const visibility = await readVisibility();
    assert.ok(['visible', 'hidden'].includes(visibility), 'Unknown actual document visibility');
    if (visibility === 'visible') return { initialVisibility, restoredWindow, visibility };
    await delay();
  }
  throw new Error('Actual QA document stayed hidden after target activation/window restore');
}
