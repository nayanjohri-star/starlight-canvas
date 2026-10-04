import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generationFixture, motionBytes } from './generation-fixture.mjs';
import { createAgentHandler } from '../../bin/agent/agent-routes.mjs';
import { createSessionStore } from '../../bin/agent/session-store.mjs';
import { createFakeModel } from '../fixtures/fake-model.mjs';

test('#444.4: the real agent HTTP route returns the shared take receipt and edit.undo removes it', async () => {
  const f = generationFixture(), originalFetch = globalThis.fetch, dir = mkdtempSync(join(tmpdir(), 'motion-route-'));
  const faux = createFakeModel(), calls = [];
  faux.script([{ type: 'toolCall', id: 'generate', name: 'generate_motion', arguments: { characterId: 'actor-a', source: { kind: 'generate', beats: [{ text: 'Walk' }], durationSeconds: 4, seed: 17 } } }, { type: 'text', text: 'Done' }]);
  const hub = { workspaceId: () => f.host().workspaceId, resolveWorkspace: value => value, command: async (name, args) => { calls.push(name); return f.binding.handlers[name](args); } };
  let server;
  const handler = createAgentHandler({ auth: { getAccessToken: async () => 'fixture' }, models: faux.models, fauxProvider: faux.fauxProvider, liveHub: hub,
    sessionStore: createSessionStore(dir), port: () => server.address().port });
  server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  try {
    const ready = once(server, 'listening'); server.listen(0, '127.0.0.1'); await ready;
    const character = f.cast.read()[0];
    assert.equal(f.run('cast.setLayer', { characterId: 'actor-a', layer: { waypoints: [{ id: 'path', frame: 72, x: character.x, z: character.z + 3 }] } }).ok, true);
    const before = f.snapshot();
    globalThis.fetch = async (url, options) => {
      if (url === '/ardy/generate') return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n');
      if (url === '/ardy/motions/123456-abcdef') return new Response(motionBytes);
      return originalFetch(url, options);
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/agent/turn', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'studio', sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), text: 'Walk along the path', context: f.binding.context() }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const events = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
    const done = events.find(event => event.type === 'tool.done');
    assert.equal(done?.ok, true, JSON.stringify(events));
    const receipt = done.result;
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.action, 'motion.generate');
    assert.equal(receipt.undo.entries, 1); assert.ok(f.motion.motionFor('actor-a'));
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(calls.includes('prepare_motion_install'), false, 'no agent-only installation pipeline');
  } finally { globalThis.fetch = originalFetch; await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
