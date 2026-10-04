// SPDX-License-Identifier: AGPL-3.0-or-later
// CPU-only validation of synthetic network instrumentation. No browser or fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { directorUiApi, TEXT_MODEL, VIDEO_MODEL, digest } from './director-ui-api.mjs';
const headers = { authorization: 'Bearer sk-synth-alice' };
async function endpoint(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('UI fixture observes unconsumed binary bytes, exact idempotent bodies, and query/content failures', async t => {
  const api = directorUiApi(), supplier = await endpoint(t, api.handler), gateway = await endpoint(t, api.gatewayHandler);
  const bytes = Buffer.from([0, 255, 90, 128]);
  const response = await fetch(supplier + '/reference-assets', { method: 'POST', headers: { ...headers, 'content-type': 'video/mp4' }, body: bytes });
  const upload = await response.json(); assert.equal(response.status, 200); assert.equal(upload.duration_seconds, 6.25);
  assert.deepEqual(api.state.uploadDetails, [{ mime: 'video/mp4', size: 4, sha256: digest(bytes), remoteUrl: upload.url }]);
  assert.equal(api.state.uploads[0].size, 4);
  const request = { model: VIDEO_MODEL, prompt: 'F 合成描述', seconds: 6, metadata: { video_urls: [upload.url] } };
  const create = () => fetch(gateway + '/v1/videos', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'f-fixture-one-key' }, body: JSON.stringify(request) }).then(r => r.json());
  const first = await create(), retry = await create(); assert.equal(retry.id, first.id);
  assert.equal(api.state.creates.length, 1); assert.equal(api.state.createAttempts.length, 2);
  assert.deepEqual(api.state.createAttempts, [{ key: 'f-fixture-one-key', body: request }, { key: 'f-fixture-one-key', body: request }]);
  api.failQueries(first.id, 1); assert.equal((await fetch(gateway + `/v1/videos/${first.id}`)).status, 503);
  await fetch(gateway + `/v1/videos/${first.id}`); await fetch(gateway + `/v1/videos/${first.id}`);
  api.failContent(first.id, 1); assert.equal((await fetch(gateway + `/v1/videos/${first.id}/content`)).status, 502);
  assert.equal((await fetch(gateway + `/v1/videos/${first.id}/content`)).status, 200);
  assert.deepEqual(api.state.failures.map(row => row.status), [503, 502]);
  assert.equal(api.state.directVideoPosts, 0);
});
test('UI fixture quotes a configured text model and releases a delayed data-only proposal using real request context', async t => {
  const api = directorUiApi(), supplier = await endpoint(t, api.handler);
  const price = await (await fetch(supplier + '/api/pricing')).json();
  assert.equal(price.data[0].model_name, TEXT_MODEL); assert.equal(price.data[0].billing_configured, true);
  const context = { frameCount: 150, characters: [{ id: 'f-independent-a' }], shots: [{ id: 'f-ui-shot' }] };
  const request = { model: TEXT_MODEL, messages: [{ role: 'user', content: `提案类型：motion\n场景：${JSON.stringify(context)}\n用户要求：用户保留合成角色甲。` }] };
  api.holdNextChat(); let completed = false;
  const pending = fetch(supplier + '/v1/chat/completions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(request) }).then(async r => { completed = true; return r.json(); });
  const until = Date.now() + 5000;
  while (!api.state.chats.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(api.state.chats.length, 1); assert.equal(completed, false);
  api.releaseChat(); const response = await pending;
  const proposal = JSON.parse(response.choices[0].message.content);
  assert.equal(proposal.commands.length, 3);
  assert.equal(proposal.commands[0].args.characterId, context.characters[0].id);
  assert.equal(proposal.commands[2].args.blocks[0].endFrame, 150);
  assert.equal(api.state.creates.length, 0);
});
