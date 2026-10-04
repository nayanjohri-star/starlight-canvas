import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { shipped } from './verify-motion-private-owners-removed.mjs';
import * as runtime from '../../bin/agent/motion-runtime.mjs';
import { LiveHub, DEFAULT_COMMAND_TIMEOUT_MS } from '../../mcp/live-hub.mjs';

test('#452.1: shipped source contains no prepare operation and the sidecar retains only the shared stream decoder', () => {
  const hits = shipped().flatMap(path => readFileSync(path, 'utf8').includes('prepare_motion_install') ? [path.pathname] : []);
  assert.deepEqual(hits, []);
  assert.deepEqual(Object.keys(runtime).sort(), ['extractNdjsonRecords', 'readMotionStream']);
  for (const name of ['prepare_motion_install', 'verify_motion_candidate', 'repair_motion_candidate', 'commit_motion_candidate']) {
    assert.equal(LiveHub.commandTimeoutMs(name), DEFAULT_COMMAND_TIMEOUT_MS);
    assert.equal(LiveHub.commandMayMutate(name), false);
  }
});
