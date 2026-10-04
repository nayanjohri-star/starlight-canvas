// SPDX-License-Identifier: AGPL-3.0-or-later
// CPU scheduling/visibility counterexamples, not native browser evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeMediaClock, activateActualForeground } from '../../director/test/fixtures/starlight-media-controls.mjs';

const clock = (fps = 24, count = 150) => ({ authorFps: fps, authorFrameCount: count, shotStart: 0, shotEnd: count - 1,
  liveFps: fps, liveFrameCount: count, liveRangeStart: 0, liveRangeEnd: count - 1 });
function fixture(value = clock()) {
  let tick = 0; const commands = [], reads = []; let afterDelay;
  return { value, commands, reads, options: { shotId: 'actual-qa-shot', read() { reads.push(structuredClone(value)); return value; },
    async run(id, args) {
      commands.push({ id, args });
      if (id === 'shot.setFps') {
        const count = Math.round(value.authorFrameCount / (value.authorFps ?? 24) * args.fps);
        Object.assign(value, clock(args.fps, count));
      } else if (id === 'shot.setDuration') Object.assign(value, clock(value.authorFps, Math.round(value.authorFps * args.seconds)));
      else if (id === 'shot.setRange') Object.assign(value, { shotStart: args.range.startFrame, shotEnd: args.range.endFrameExclusive - 1,
        liveRangeStart: args.range.startFrame, liveRangeEnd: args.range.endFrameExclusive - 1 });
      return { ok: true };
    }, now: () => tick, delay: async () => { tick++; afterDelay?.(); }, timeoutMs: 5 }, onDelay(fn) { afterDelay = fn; } };
}
test('already satisfied canonical 24fps/150/full shot does not call any no-op mutation', async () => {
  const f = fixture(); delete f.value.authorFps;
  assert.equal(await synchronizeMediaClock({ ...f.options, fps: 24, seconds: 6.25 }), 150);
  assert.deepEqual(f.commands, []);
});
test('fps ACK waits for actual resampling ports before deciding duration/range', async () => {
  const f = fixture(clock(30, 188)), run = f.options.run;
  f.options.run = async (id, args) => {
    const receipt = await run(id, args);
    if (id === 'shot.setFps') { f.value.liveFps = 30; f.value.liveFrameCount = 188; f.value.liveRangeEnd = 187; }
    return receipt;
  };
  f.onDelay(() => Object.assign(f.value, { liveFps: 24, liveFrameCount: 150, liveRangeEnd: 149 }));
  assert.equal(await synchronizeMediaClock({ ...f.options, fps: 24, seconds: 6.25 }), 150);
  assert.deepEqual(f.commands.map(row => row.id), ['shot.setFps']);
  assert.ok(f.reads.some(row => row.authorFrameCount === 150 && row.liveFrameCount === 188));
});
test('wrong duration and range still require real successful commands and exact final ports', async () => {
  const f = fixture(clock(24, 24)), originalRun = f.options.run;
  f.options.run = async (id, args) => { const receipt = await originalRun(id, args);
    if (id === 'shot.setDuration') Object.assign(f.value, { shotEnd: 23, liveRangeEnd: 23 }); return receipt; };
  assert.equal(await synchronizeMediaClock({ ...f.options, fps: 24, seconds: 6.25 }), 150);
  assert.deepEqual(f.commands.map(row => row.id), ['shot.setDuration', 'shot.setRange']);
  assert.deepEqual(f.commands[1].args, { shotId: 'actual-qa-shot', range: { startFrame: 0, endFrameExclusive: 150 } });
});
test('all eight original requested fps/duration combinations are reached without redundant edits', async () => {
  const f = fixture(); const addressed = [];
  for (const fps of [24, 30]) for (const seconds of [1, 6.25, 15, 30]) addressed.push(await synchronizeMediaClock({ ...f.options, fps, seconds }));
  assert.deepEqual(addressed, [24, 150, 360, 720, 30, 188, 450, 900]);
});
test('false TARGET_NOT_READY receipt is rejected rather than accepted as a no-op success', async () => {
  for (const value of [clock(30, 188), clock(24, 24), { ...clock(), shotEnd: 39, liveRangeEnd: 39 }]) {
    const f = fixture(value); f.options.run = async () => ({ ok: false, code: 'TARGET_NOT_READY', mutated: false });
    await assert.rejects(synchronizeMediaClock({ ...f.options, fps: 24, seconds: 6.25 }), /TARGET_NOT_READY/);
  }
});
test('unsettled ports time out; read exceptions and unknown fps remain failures', async () => {
  const f = fixture(); f.value.liveFrameCount = 151;
  await assert.rejects(synchronizeMediaClock({ ...f.options, fps: 24, seconds: 6.25 }), /did not settle/); assert.deepEqual(f.commands, []);
  const broken = fixture(); broken.options.read = () => { throw new Error('real authoring read failure'); };
  await assert.rejects(synchronizeMediaClock({ ...broken.options, fps: 24, seconds: 6.25 }), /real authoring read failure/);
  for (const authorFps of [null, 0, 25, '24']) {
    const invalid = fixture({ ...clock(), authorFps });
    await assert.rejects(synchronizeMediaClock({ ...invalid.options, fps: 24, seconds: 6.25 }), /Unknown authored/);
  }
});
test('actual foreground disables emulation and activates target without unnecessary window mutations', async () => {
  const sent = []; const proof = await activateActualForeground({ targetId: 'real-page',
    send: async (method, params) => { sent.push({ method, params }); }, readVisibility: async () => 'visible' });
  assert.deepEqual(sent, [ { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    { method: 'Target.activateTarget', params: { targetId: 'real-page' } } ]);
  assert.equal(proof.restoredWindow, false);
});
test('hidden native window is really restored and observed visible, never emulated visible', async () => {
  let visibility = 'hidden'; const sent = [];
  const proof = await activateActualForeground({ targetId: 'real-page', readVisibility: async () => visibility,
    send: async (method, params) => { sent.push({ method, params }); if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Browser.setWindowBounds') visibility = 'visible'; } });
  assert.equal(proof.restoredWindow, true); assert.equal(proof.visibility, 'visible');
  assert.deepEqual(sent.map(row => row.method), ['Emulation.setFocusEmulationEnabled', 'Target.activateTarget', 'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Target.activateTarget']);
  assert.deepEqual(sent[3].params, { windowId: 7, bounds: { windowState: 'normal' } });
  assert.ok(sent.filter(row => row.method === 'Emulation.setFocusEmulationEnabled').every(row => row.params.enabled === false));
});
test('activation/window receipts cannot pass a document that really remains hidden', async () => {
  let tick = 0;
  await assert.rejects(activateActualForeground({ targetId: 'real-page', readVisibility: async () => 'hidden',
    send: async method => method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {},
    now: () => tick, delay: async () => { tick++; }, timeoutMs: 3 }), /stayed hidden/);
});
