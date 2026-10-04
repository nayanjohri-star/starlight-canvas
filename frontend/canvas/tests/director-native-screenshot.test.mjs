// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureNativeViewport, pngDimensions } from './fixtures/director-native-screenshot.mjs';

// Synthetic IHDR only: CPU dimension observations, never GPU/image evidence.
function header(width, height) {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  return png;
}
function fixture(t, { cssWidth, cssHeight, dpr = 1, pngWidth, pngHeight, error }) {
  const dir = mkdtempSync(join(tmpdir(), 'f-native-screenshot-cpu-')), path = join(dir, 'native.png');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = header(pngWidth ?? cssWidth, pngHeight ?? cssHeight), calls = [];
  let detached = 0;
  const session = { send: async (method, params) => {
    calls.push({ method, params }); if (error) throw error; return { data: png.toString('base64') };
  }, detach: async () => { detached++; } };
  const page = { evaluate: async () => ({ innerWidth: cssWidth, innerHeight: cssHeight, dpr, visualScale: 1, cssZoom: '1' }),
    context: () => ({ newCDPSession: async target => { assert.equal(target, page); return session; } }) };
  return { page, path, png, calls, detached: () => detached };
}

test('native 100% capture uses the whole CDP surface without clip or resampling', async t => {
  const f = fixture(t, { cssWidth: 1366, cssHeight: 768 });
  const result = await captureNativeViewport(f.page, { path: f.path, width: 1366, height: 768 });
  assert.deepEqual(f.calls, [{ method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true, captureBeyondViewport: false } }]);
  assert.deepEqual([result.width, result.height], [1366, 768]);
  assert.deepEqual(readFileSync(f.path), f.png); assert.equal(f.detached(), 1);
});
test('genuine 125% capture records physical dimensions rather than CSS dimensions', async t => {
  const f = fixture(t, { cssWidth: 1093, cssHeight: 614, dpr: 1.25, pngWidth: 1366, pngHeight: 768 });
  const result = await captureNativeViewport(f.page, { path: f.path, width: 1366, height: 768 });
  assert.deepEqual([result.width, result.height], [1366, 768]);
  assert.deepEqual(result.physicalViewport, { width: 1366.25, height: 767.5 });
  assert.equal(f.detached(), 1);
});
test('the old 125% CSS-sized cropped image fails and its original bytes remain inspectable', async t => {
  const f = fixture(t, { cssWidth: 1093, cssHeight: 614, dpr: 1.25, pngWidth: 1093, pngHeight: 614 });
  await assert.rejects(captureNativeViewport(f.page, { path: f.path, width: 1366, height: 768 }), /full viewport PNG size mismatch/);
  assert.deepEqual(readFileSync(f.path), f.png); assert.equal(f.detached(), 1);
});
test('native 1920 calibration retains the existing one-pixel rounding allowance', async t => {
  const f = fixture(t, { cssWidth: 1537, cssHeight: 864, dpr: 1.25, pngWidth: 1921, pngHeight: 1080 });
  const result = await captureNativeViewport(f.page, { path: f.path, width: 1920, height: 1080 });
  assert.deepEqual([result.width, result.height], [1921, 1080]);
});
test('PNG dimensions reject truncated, corrupt and empty IHDR metadata', () => {
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /complete PNG IHDR/);
  const corrupt = header(1366, 768); corrupt[0] = 0; assert.throws(() => pngDimensions(corrupt), /PNG signature/);
  assert.throws(() => pngDimensions(header(0, 768)), /dimensions are positive/);
});
test('native capture failures propagate and detach the CDP session without a fabricated screenshot', async t => {
  const error = new Error('native surface capture failed');
  const f = fixture(t, { cssWidth: 1366, cssHeight: 768, error });
  await assert.rejects(captureNativeViewport(f.page, { path: f.path, width: 1366, height: 768 }), error);
  assert.equal(f.detached(), 1); assert.equal(existsSync(f.path), false);
});
