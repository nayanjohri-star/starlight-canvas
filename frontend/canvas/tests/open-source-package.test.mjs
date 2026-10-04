import test from 'node:test';
import assert from 'node:assert/strict';
import { secretFindings, sourceFiles } from '../scripts/package-open-source.mjs';

test('source scan reports positions without printing credential values', () => {
  const fake = 'sk-' + 'a'.repeat(48);
  const findings = secretFindings('fixture.js', Buffer.from(`const x = '${fake}';`));
  assert.equal(findings.length, 1); assert.equal(findings[0].kind, 'api-key');
  assert.ok(!JSON.stringify(findings).includes(fake));
  const url = new URL('https://untrusted.invalid/path'); url.username = 'a'; url.password = 'b';
  assert.ok(secretFindings('fixture.js', Buffer.from(url.href)).length > 0);
  assert.deepEqual(secretFindings('fixture.js', Buffer.from('https://user:pw@provider.example/path')), []);
});

test('source scan rejects private key material and ignores binary payloads', () => {
  const header = '-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5);
  assert.equal(secretFindings('fixture.js', Buffer.from(header)).length, 1);
  assert.deepEqual(secretFindings('sample.png', Buffer.from([0, 1, 255, 45])), []);
});

test('community source includes its contracts without private deployment reports or runtime files', async () => {
  const files = await sourceFiles();
  assert.ok(files.has('frontend/canvas/server/external-api.mjs'));
  assert.ok(files.has('frontend/canvas/contracts/site-video-capabilities.json'));
  assert.ok(files.has('frontend/canvas/LICENSE'));
  assert.equal(files.has('frontend/canvas/docs/canvas-release/0.5/astra-closure-register.md'), false);
  const publicGuides = new Set(['frontend/canvas/docs/canvas-release/0.5/core-contract.md',
    'frontend/canvas/docs/canvas-release/0.5/hosted-api-contract.md']);
  for (const path of files.keys()) {
    assert.ok(!path.startsWith('deploy/'));
    assert.ok(!/(?:^|\/)(?:\.git|node_modules|release-packages|outputs|logs|secrets|cookies|sessions)(?:\/|$)/i.test(path));
    if (path.startsWith('frontend/canvas/docs/canvas-release/')) assert.ok(publicGuides.has(path), path);
  }
});
