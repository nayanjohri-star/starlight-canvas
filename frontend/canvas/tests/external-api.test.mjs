import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasServer } from '../server/app.mjs';
import { createSiteClient } from '../src/api.js';
import { DEFAULT_PROVIDER, normalizeProvider, providerHeaders, upstreamUrl } from '../src/provider-config.js';
import { initProviders, saveProvider, selectProvider, getProvider } from '../src/providers.js';
import * as vault from '../src/keyvault.js';
import { imagePriceInfo, estimateCost, buildImageBody, imageModelIds } from '../src/capabilities.js';

const candidate = () => normalizeProvider({ id: 'external-test', name: '测试服务商', baseUrl: 'https://provider.example/openai/v1/', protocol: 'openai', textModels: 'custom-chat', imageModels: 'gpt-image-1' });
async function harness(t, response = () => new Response('{"data":[]}')) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-external-'));
  await writeFile(join(root, 'index.html'), '<title>Test</title>');
  const calls = [];
  const server = createCanvasServer({ staticDir: root, directorDir: root, mediaService: false,
    upstreamFetch: async (url, init) => { calls.push({ url: String(url), init }); return response(url, init); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  return { calls, base, fetchImpl: (u, o) => fetch(u, { ...o, headers: { ...o?.headers, Origin: base } }) };
}

test('external addresses normalize version/prefix and reject credential-bearing URLs', () => {
  const p = candidate();
  assert.equal(upstreamUrl(p, '/v1/models'), 'https://provider.example/openai/v1/models');
  for (const baseUrl of ['http://provider.example', 'https://user:secret@provider.example', 'https://provider.example?key=secret', 'https://provider.example/%2e%2e', 'https://provider.example/#secret'])
    assert.throws(() => normalizeProvider({ ...p, baseUrl }));
  assert.equal(normalizeProvider({ ...p, baseUrl: 'http://127.0.0.1:9911/v1' }).baseUrl, 'http://127.0.0.1:9911/v1');
});

test('local proxy forwards models/text to selected provider with no cookies or profile headers upstream', async t => {
  const h = await harness(t), p = candidate();
  const api = createSiteClient({ base: h.base + '/site', getKey: () => 'test-only-key', getProvider: () => p, fetchImpl: h.fetchImpl });
  await api.listModels();
  await api.chatCompletion(JSON.stringify({ model: 'custom-chat', messages: [{ role: 'user', content: 'test' }], stream: false, max_tokens: 10 }));
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, 'https://provider.example/openai/v1/chat/completions');
  assert.deepEqual(Object.keys(h.calls[1].init.headers).sort(), ['Accept', 'Authorization', 'Content-Type'].sort());
  assert.equal((await api.pricing()).external, true); assert.equal(h.calls.length, 2);
  await assert.rejects(api.getTask('task_one'), { code: 'video_contract_required' }); assert.equal(h.calls.length, 2);
});

test('standard GPT Image generation removes unsupported response_format and reference edit becomes multipart', async t => {
  const h = await harness(t), p = candidate();
  const headers = { Origin: h.base, Authorization: 'Bearer test-only-key', ...providerHeaders(p), 'Content-Type': 'application/json' };
  const body = { model: 'gpt-image-1', prompt: 'test', size: '1536x1024', n: 1, response_format: 'b64_json' };
  assert.equal((await fetch(h.base + '/site/v1/images/generations', { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
  assert.equal(JSON.parse(h.calls[0].init.body).response_format, undefined);
  body.images = ['data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='];
  assert.equal((await fetch(h.base + '/site/v1/images/edits', { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
  const form = h.calls[1].init.body;
  assert.ok(form instanceof FormData); assert.equal(form.getAll('image[]').length, 2);
  assert.equal(form.get('model'), 'gpt-image-1'); assert.equal(h.calls[1].init.headers['Content-Type'], undefined);
});

test('invalid provider/cross-site/unknown endpoints cause no upstream traffic', async t => {
  const h = await harness(t);
  const headers = { ...providerHeaders(candidate()), Authorization: 'Bearer test-only-key' };
  const bad = await fetch(h.base + '/site/v1/models', { headers: { ...headers, 'X-Canvas-Api-Base': 'https%3A%2F%2Fprovider.example%3Fkey%3Dsecret' } });
  assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes('secret'));
  assert.equal((await fetch(h.base + '/site/v1/models', { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(h.base + '/site/private', { headers })).status, 404);
  assert.equal(h.calls.length, 0);
});

test('old local server is rejected before any external key is sent', async () => {
  const calls = [];
  const api = createSiteClient({ getProvider: candidate, getKey: () => 'test-only-key', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ service: 'xingpan-canvas', apiLevel: 5 }));
  } });
  await assert.rejects(api.listModels(), { code: 'external_api_unavailable' });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/health'); assert.equal(calls[0].init.headers, undefined);
});

test('a gateway error cannot persist its echoed API credential', async t => {
  const key = 'test-only-echo-key';
  const h = await harness(t, () => Response.json({ error: { code: key, message: `invalid ${key}` } }, { status: 401 }));
  const api = createSiteClient({ base: h.base + '/site', getKey: () => key, getProvider: candidate, fetchImpl: h.fetchImpl });
  await assert.rejects(api.listModels(), e => e.status === 401 && !e.code.includes(key) && !e.message.includes(key));
});

test('switching provider during a response discards it instead of attaching to another provider', async () => {
  let selected = candidate();
  const api = createSiteClient({ getProvider: () => selected, getKey: () => 'test-only-key', fetchImpl: async url => {
    if (url === '/health') return new Response('{"service":"xingpan-canvas","apiLevel":6,"externalApi":true}');
    selected = { ...selected, baseUrl: 'https://other.example/v1' }; return new Response('{"data":[]}');
  } });
  await assert.rejects(api.listModels(), { code: 'identity_changed' });
});

test('profiles persist metadata only, bind task fingerprints to endpoint and remove site quotes', async () => {
  let value = null; const storage = { getItem: () => value, setItem: (_k, v) => { value = v; } };
  initProviders(storage); vault.clearKey();
  await vault.setKey('test-only-key'); const siteFp = vault.getFingerprint();
  saveProvider({ ...candidate(), apiKey: 'never-save-this' }, storage);
  assert.equal(vault.hasKey(), false); await vault.setKey('test-only-key'); const externalFp = vault.getFingerprint();
  assert.notEqual(externalFp, siteFp); assert.ok(!value.includes('never-save-this')); assert.ok(!value.includes('test-only-key'));
  assert.deepEqual(imageModelIds(), ['gpt-image-1']);
  assert.equal(JSON.parse(buildImageBody({ model: 'gpt-image-1', prompt: 'test', size: '1536x1024' })).size, '1536x1024');
  assert.equal(imagePriceInfo('gpt-image-2.5-flare', '1K').yuan, null); assert.equal(estimateCost('minimax-h3-768p-per-second', 5), null);
  saveProvider({ ...candidate(), id: 'other', baseUrl: 'https://other.example' }, storage); await vault.setKey('test-only-key');
  assert.notEqual(vault.getFingerprint(), externalFp);
  selectProvider(candidate().id, storage); assert.equal(vault.hasKey(), false);
  await vault.setKey('test-only-key'); assert.equal(vault.getFingerprint(), externalFp);
  selectProvider(DEFAULT_PROVIDER.id, storage); vault.clearKey();
});
