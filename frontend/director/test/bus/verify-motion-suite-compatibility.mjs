import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('#452.5: the existing binding reload acceptance runs against the shared installer', () => {
  const result = spawnSync(process.execPath, ['test/verify-studio-agent-binding.mjs', '--case', 'agent-motion-survives-reload'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
