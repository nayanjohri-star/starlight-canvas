#!/usr/bin/env node
// The private candidate state machine is retired. Its installation, Stop,
// staleness and generation-gate regressions now exercise the shared editor jobs.
import './bus/verify-motion-route-undo.mjs';
import './bus/verify-motion-route-cancel.mjs';
import './bus/verify-motion-concurrent.mjs';
import './bus/verify-motion-job-lifecycle.mjs';
import './bus/verify-motion-exposure-gate.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractNdjsonRecords, readMotionStream } from '../bin/agent/motion-runtime.mjs';

const url = '/ardy/motions/123456-abcdef';
const done = JSON.stringify({ event: 'done', motionUrl: url });
test('retained MCP decoder consumes EOF and duplicate final artifacts, never EOF alone', async () => {
  assert.equal(await readMotionStream(new Response(done)), url);
  assert.equal(await readMotionStream(new Response(done + '\n' + done)), url);
  for (const text of ['', '{"event":', '{"event":"progress"}\n', done + '\n{bad', 'null', '{"event":"done","motionUrl":"http://other/take"}', done + '\n' + JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/654321-fedcba' })]) {
    await assert.rejects(readMotionStream(new Response(text)), { code: 'BACKEND_UNAVAILABLE' });
  }
});
test('retained MCP decoder carries bridge refusals and streamed failures', async () => {
  await assert.rejects(readMotionStream(new Response(JSON.stringify({ reason: 'box offline' }), { status: 503 })), error => error.code === 'BACKEND_UNAVAILABLE' && error.message.includes('box offline'));
  await assert.rejects(readMotionStream(new Response(JSON.stringify({ reason: 'prompt too long' }), { status: 400 })), error => error.code === 'INVALID_ARGUMENT' && error.message.includes('prompt too long'));
  await assert.rejects(readMotionStream(new Response('{"event":"error","message":"generator failed"}')), error => error.code === 'BACKEND_UNAVAILABLE' && error.message.includes('generator failed'));
});
test('retained MCP decoder bounds records and buffers split UTF-8 streams', async () => {
  assert.deepEqual(extractNdjsonRecords(done.slice(0, 10)), { records: [], remainder: done.slice(0, 10) });
  assert.throws(() => extractNdjsonRecords('x'.repeat(65537)), { code: 'BACKEND_UNAVAILABLE' });
  assert.throws(() => extractNdjsonRecords('x'.repeat(65537) + '\n'), { code: 'BACKEND_UNAVAILABLE' });
  const bytes = new TextEncoder().encode(JSON.stringify({ event: 'progress', progress: .25, message: '걷기' }) + '\n' + done), progress = [];
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await readMotionStream(new Response(stream), { onProgress: value => progress.push(value) }), url);
  assert.deepEqual(progress, [.25]);
});
