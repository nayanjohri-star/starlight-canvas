import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generationFixture } from './generation-fixture.mjs';
import { createAgentHandler } from '../../bin/agent/agent-routes.mjs';
import { createSessionStore } from '../../bin/agent/session-store.mjs';
import { createFakeModel } from '../fixtures/fake-model.mjs';

test('#444: agent Stop cancels the shared bus job and settles the held tool without a late take', async () => {
  const f = generationFixture(), originalFetch = globalThis.fetch, dir = mkdtempSync(join(tmpdir(), 'motion-route-cancel-'));
  const faux = createFakeModel();
  faux.script([{ type: 'toolCall', id: 'generate', name: 'generate_motion', arguments: { characterId: 'actor-a', source: { kind: 'generate', beats: [{ text: 'Walk' }], durationSeconds: 4 } } }, { type: 'text', text: 'Done' }]);
  const hub = { workspaceId: () => f.host().workspaceId, resolveWorkspace: value => value, command: async (name, args) => f.binding.handlers[name](args) };
  let server, signal;
  const handler = createAgentHandler({ auth: { getAccessToken: async () => 'fixture' }, models: faux.models, fauxProvider: faux.fauxProvider, liveHub: hub,
    sessionStore: createSessionStore(dir), port: () => server.address().port });
  server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  try {
    const ready = once(server, 'listening'); server.listen(0, '127.0.0.1'); await ready;
    globalThis.fetch = async (url, options) => {
      if (url !== '/ardy/generate') return originalFetch(url, options);
      signal = options.signal;
      return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    };
    const origin = `http://127.0.0.1:${server.address().port}`, sessionId = crypto.randomUUID(), turnId = crypto.randomUUID();
    const post = (path, body, cookie) => fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const response = await post('/agent/turn', { surface: 'studio', sessionId, turnId, text: 'Walk', context: f.binding.context() });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0], reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
    let carry = '', jobId;
    async function read() {
      const { value, done } = await reader.read(); if (done) return false;
      carry += decoder.decode(value, { stream: true }); const records = carry.split('\n'); carry = records.pop();
      for (const line of records) if (line.startsWith('data: ')) { const event = JSON.parse(line.slice(6)); events.push(event); if (event.type === 'job.state' && event.state === 'generating') jobId = event.jobId; }
      return true;
    }
    while (!jobId && await read()) { /* consume the exact job acknowledgement */ }
    assert.ok(jobId, JSON.stringify(events));
    const stopped = await post('/agent/stop', { surface: 'studio', sessionId, turnId, jobId }, cookie);
    assert.equal(stopped.status, 200); const outcome = (await stopped.json()).outcome; assert.equal(outcome.code, 'CANCELLED');
    while (await read()) { /* drain the held tool's terminal result */ }
    assert.equal(signal.aborted, true); assert.equal(f.motion.motionFor('actor-a'), null);
    assert.equal(events.filter(event => event.type === 'tool.done').length, 1);
    assert.equal(events.find(event => event.type === 'tool.done').result.code, 'CANCELLED');
    assert.equal(events.some(event => event.type === 'error' && event.code === 'aborted'), false);
  } finally { f.binding.bus.dispose(); globalThis.fetch = originalFetch; await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
