// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';

// V11 asks for identical composition; contract 7 fixes scene/camera/assets and
// integer frame timing. These are predeclared engineering quality limits, NOT
// a tolerance promised by OpenGL or a claim that different GL results are random.
// One RGB delivery-byte step is 1/255; 10 ppm allows at most 9 changed pixels at
// 720p / 20 at 1080p. State, dimensions, address, timing and alpha remain exact.
// Historical SHA failures remain diagnostic failures; this defines a new check.
export const COMPOSITION_LIMITS = Object.freeze({ maxRgbByteDelta: 1, maxChangedPixelRatio: 1 / 100_000, alphaExact: true });
export const isModelRequestPath = path => /\/(?:canvas-api\/)?v1\/(?:chat\/completions|images\/(?:generations|edits)|videos(?:\/|$))/.test(path);

export function assertHostedMediaTarget({ artifact, hostUrl, parentUrl, frameUrl, realmUrl, baseURI }) {
  assert.equal(artifact.sourceDirty, false); assert.equal(artifact.mode, 'hosted'); assert.equal(artifact.basePath, '/canvas/');
  assert.match(artifact.assetPath, /^releases\/[a-f0-9]{64}\/$/);
  const host = new URL(hostUrl), parent = new URL(parentUrl), frame = new URL(frameUrl), realm = new URL(realmUrl), base = new URL(baseURI);
  assert.equal(parent.origin, host.origin, 'Parent is on the tested host');
  assert.ok(['/canvas/', '/canvas/index.html'].includes(parent.pathname), 'Parent is the actual hosted canvas route');
  const directory = new URL(artifact.basePath + artifact.assetPath + 'director/', host.origin), entry = new URL('index.html', directory);
  for (const [name, value] of [['frame', frame], ['realm', realm]]) {
    assert.equal(value.origin, entry.origin, `${name} must use the tested host`);
    assert.equal(value.pathname, entry.pathname, `${name} must use the artifact's immutable director entry`);
  }
  assert.equal(realm.href, frame.href, 'CDP context must be the actual selected iframe');
  assert.equal(base.origin, directory.origin, 'Director baseURI must use the tested host');
  assert.ok([directory.pathname, entry.pathname].includes(base.pathname), 'Director baseURI must resolve resources within this immutable artifact');
  return { parentUrl: parent.href, frameUrl: frame.href, baseURI: base.href, immutableEntry: entry.href };
}

export function compareRgbaComposition(expected, actual) {
  assert.equal(actual.width, expected.width, 'Output width changed');
  assert.equal(actual.height, expected.height, 'Output height changed');
  const { width, height } = expected;
  assert.ok(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, 'Invalid output dimensions');
  const pixels = width * height;
  assert.ok(Number.isSafeInteger(pixels * 4), 'Invalid RGBA length');
  assert.ok(expected.rgba instanceof Uint8Array && actual.rgba instanceof Uint8Array, 'Real RGBA byte arrays are required');
  assert.equal(expected.rgba.length, pixels * 4, 'Baseline RGBA is incomplete');
  assert.equal(actual.rgba.length, pixels * 4, 'Observed RGBA is incomplete');
  let changedPixels = 0, maxRgbByteDelta = 0;
  const samples = [];
  for (let at = 0; at < pixels * 4; at += 4) {
    if (actual.rgba[at + 3] !== expected.rgba[at + 3]) assert.fail(`Alpha changed at pixel ${at / 4}`);
    let changed = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(actual.rgba[at + channel] - expected.rgba[at + channel]);
      maxRgbByteDelta = Math.max(maxRgbByteDelta, delta);
      if (delta > COMPOSITION_LIMITS.maxRgbByteDelta) assert.fail(`RGB delta ${delta} exceeds one delivery byte at pixel ${at / 4}, channel ${channel}`);
      changed ||= delta !== 0;
    }
    if (changed) {
      changedPixels++;
      if (samples.length < 10) samples.push({ x: (at / 4) % width, y: Math.floor(at / 4 / width), expected: Array.from(expected.rgba.subarray(at, at + 4)), actual: Array.from(actual.rgba.subarray(at, at + 4)) });
    }
  }
  const allowedChangedPixels = Math.floor(pixels * COMPOSITION_LIMITS.maxChangedPixelRatio);
  assert.ok(changedPixels <= allowedChangedPixels, `${changedPixels} changed pixels exceed the fixed 10 ppm limit (${allowedChangedPixels})`);
  return { changedPixels, allowedChangedPixels, changedPixelRatio: changedPixels / pixels, maxRgbByteDelta, alphaExact: true, samples };
}

export function assertAddressedFrameState(expected, actual) {
  for (const frame of [expected, actual]) {
    assert.ok([24, 30].includes(frame.fps) && Number.isSafeInteger(frame.frameIndex) && frame.frameIndex >= 0, 'Valid addressed frame is required');
    assert.equal(frame.timestamp, Math.round(frame.frameIndex * 1_000_000 / frame.fps), 'Timestamp must address the integer frame');
    assert.equal(frame.duration, Math.round((frame.frameIndex + 1) * 1_000_000 / frame.fps) - frame.timestamp, 'Duration must follow the integer clock');
    assert.match(frame.authoredSha256, /^[a-f0-9]{64}$/, 'Complete authored project/asset SHA is required');
    assert.ok(frame.renderState?.camera && frame.renderState.objects?.some(object => object.skeleton), 'Observed camera and actual rig state are required');
    assert.equal(frame.renderState.productionTarget?.type, 1016, 'Production HalfFloat capture is required');
    assert.equal(frame.renderState.productionTarget?.samples, 4, 'Production MSAA4 capture is required');
    const framebuffer = frame.renderState.actualFramebuffer;
    assert.ok(framebuffer, 'Actual framebuffer observation is required');
    assert.equal(framebuffer.samples, 4); assert.equal(framebuffer.status, 36053); assert.equal(framebuffer.componentType, 5126);
    assert.deepEqual(framebuffer.channelBits, [16, 16, 16, 16]);
  }
  for (const key of ['frameIndex', 'fps', 'timestamp', 'duration', 'width', 'height', 'authoredSha256']) {
    assert.equal(actual[key], expected[key], `Frame ${expected.frameIndex}: ${key} changed`);
  }
  assert.deepEqual(actual.renderState, expected.renderState, `Frame ${expected.frameIndex}: exact camera/bone/world/material/asset state changed`);
}
export function compareAddressedFrames(expected, actual) {
  assertAddressedFrameState(expected, actual);
  return compareRgbaComposition(expected, actual);
}
