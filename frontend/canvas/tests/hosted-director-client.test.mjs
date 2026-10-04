import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorClient } from '../../director/integration/client.js';
import { directorEnvelope } from '../src/director-protocol.js';

const scope = { sessionId: 'session-A', projectId: 'project-A', nodeId: 'node-A' };
function fakeWindow() {
  const listeners = new Set();
  const sent = [];
  const parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  return { parent, location: { origin: 'https://starlight.test' }, sent,
    addEventListener: (_, handler) => listeners.add(handler), removeEventListener: (_, handler) => listeners.delete(handler),
    emit(data, origin = 'https://starlight.test', source = parent) { for (const handler of listeners) handler({ data, origin, source }); },
    get listeners() { return listeners.size; } };
}

test('director child accepts only its captured host, origin, session, method and protocol version', async () => {
  const win = fakeWindow();
  const client = createDirectorClient({ window: win, scope, timeout: 1000 });
  const promise = client.request('document.load');
  const request = win.sent[0];
  assert.equal(request.origin, win.location.origin);
  const response = directorEnvelope(scope, request.data.requestId, 'document.load', { ok: true, result: { rev: 4 } }, 'response');
  for (const invalid of [
    { ...response, version: 2 }, { ...response, sessionId: 'old-session' },
    { ...response, nodeId: 'node-B' }, { ...response, projectId: 'project-B' },
    { ...response, method: 'asset.read' },
  ]) win.emit(invalid);
  win.emit(response, 'https://attacker.test');
  win.emit(response, win.location.origin, {});
  win.emit(response);
  assert.deepEqual(await promise, { rev: 4 });
  client.dispose(); assert.equal(win.listeners, 0);
});

test('director child preserves conflict details and rejects pending work on authenticated close', async () => {
  const win = fakeWindow();
  const client = createDirectorClient({ window: win, scope, timeout: 1000 });
  const conflict = client.request('document.save');
  win.emit(directorEnvelope(scope, win.sent[0].data.requestId, 'document.save', {
    ok: false, error: { code: 'revision_conflict', message: '修订冲突', storedRevision: 7, conflictId: 'copy-1' },
  }, 'response'));
  await assert.rejects(conflict, error => error.code === 'revision_conflict' && error.storedRevision === 7 && error.conflictId === 'copy-1');
  const pending = client.request('asset.read');
  win.emit(directorEnvelope(scope, 'close-event', 'session.close', {}, 'event'));
  await assert.rejects(pending, /会话已关闭/);
  assert.equal(client.closed, true); assert.equal(win.listeners, 0);
  await assert.rejects(client.request('document.save'), /会话已关闭/);
});
