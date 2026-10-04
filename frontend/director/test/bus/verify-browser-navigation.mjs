import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';

// Exercise the shipped gate's sender, not a second implementation of it.
const source = readFileSync(new URL('../verify-camera-rail-browser.mjs', import.meta.url), 'utf8');
const ast = parseSync('camera-rail.mjs', source).program;
const sender = ast.body.flatMap(node => node.declarations ?? []).find(node => node.id?.name === 'send').init;
const handler = ast.body.find(node => node.expression?.left?.object?.name === 'ws' && node.expression.left.property?.name === 'onmessage').expression;
const helperUrl = new URL('./browser-navigation.mjs', import.meta.url);
const afterPageLoad = existsSync(helperUrl) ? (await import(helperUrl)).afterPageLoad : undefined;

class ProtocolSocket extends EventTarget {
  listeners = new Set();
  sent = [];
  addEventListener(type, fn, options) { if (type === 'message') this.listeners.add(fn); super.addEventListener(type, fn, options); }
  removeEventListener(type, fn, options) { if (type === 'message') this.listeners.delete(fn); super.removeEventListener(type, fn, options); }
  send(text) { this.sent.push({ ...JSON.parse(text), listenersAtSend: this.listeners.size }); this.onSend?.(); }
  receive(message) { const event = new MessageEvent('message', { data: JSON.stringify(message) }); this.dispatchEvent(event); this.onmessage(event); }
  loaded() { this.receive({ method: 'Page.loadEventFired', params: { timestamp: 1 } }); }
  acknowledge(result = { frameId: 'new-document' }) { this.receive({ id: this.sent.at(-1).id, result }); }
}
function fixture() {
  const socket = new ProtocolSocket();
  const send = new Function('ws', 'afterPageLoad', `let nextId = 1; const pending = new Map(); ${source.slice(handler.start, handler.end)}; return (${source.slice(sender.start, sender.end)});`)(socket, afterPageLoad);
  return { socket, send };
}

for (const method of ['Page.navigate', 'Page.reload']) test(`camera-rail gate: ${method} waits for the new document, not just its acknowledgement`, { timeout: 5000 }, async () => {
  const { socket, send } = fixture();
  let completed = false;
  const navigation = send(method, method === 'Page.navigate' ? { url: 'http://127.0.0.1:5248/app/' } : {}).then(value => { completed = true; return value; });
  try {
    socket.acknowledge();
    // Drain acknowledgement promise reactions at an event-loop checkpoint;
    // no sleep, polling, or wall-clock guess about when a page will load.
    await new Promise(setImmediate);
    assert.equal(completed, false, 'the old document can still be visible after the protocol acknowledgement');
    assert.equal(socket.sent[0].listenersAtSend, 1, 'subscribe before triggering navigation');
    socket.receive({ method: 'Page.domContentEventFired', params: { timestamp: 1 } });
    assert.equal(socket.listeners.size, 1, 'an unrelated event must not release the navigation fence');
    socket.loaded();
    assert.deepEqual(await navigation, { frameId: 'new-document' });
    assert.equal(socket.listeners.size, 0);
  } finally { socket.acknowledge(); socket.loaded(); await navigation; }
});

test('camera-rail gate: a synchronous load signal is retained and a failed navigation releases its listener', { timeout: 5000 }, async () => {
  const first = fixture();
  first.socket.onSend = () => { first.socket.loaded(); first.socket.acknowledge(); };
  assert.deepEqual(await first.send('Page.reload'), { frameId: 'new-document' });
  assert.equal(first.socket.sent[0].listenersAtSend, 1);
  assert.equal(first.socket.listeners.size, 0);
  const second = fixture();
  second.socket.onSend = () => second.socket.receive({ id: second.socket.sent.at(-1).id, error: { code: -32000, message: 'fixture' } });
  await assert.rejects(second.send('Page.reload'), error => JSON.parse(error.message).code === -32000);
  assert.equal(second.socket.listeners.size, 0);
});
