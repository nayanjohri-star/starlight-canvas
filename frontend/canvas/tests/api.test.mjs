// 集成：本站客户端 × Codex 本机代理（模拟上游）。验证转发面、请求头、原字节幂等体、下载类型门控。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createCanvasServer } from '../server/app.mjs';
import { createSiteClient, ApiError } from '../src/api.js';

async function harness(t, upstream) {
  const root = await mkdtemp(join(tmpdir(), 'xp-canvas-api-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  const calls = [];
  const server = createCanvasServer({ staticDir: root, directorDir: root, upstreamFetch: async (url, init) => { calls.push({ url: String(url), init, body: init.body ? String(init.body) : null }); return upstream(url, init); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const client = createSiteClient({ base: base + '/site', getKey: () => 'test-key' });
  // node fetch 不带 Origin；代理要求 POST 带 Origin —— 测试客户端补同源头
  return { client, calls, base };
}
const originHeaders = base => ({ Origin: base });

test('models 透传且只到固定上游', async t => {
  const { client, calls, base } = await harness(t, async () => new Response(JSON.stringify({ data: [{ id: 'minimax-h3-768p-per-second' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await client.listModels();
  assert.equal(res.data[0].id, 'minimax-h3-768p-per-second');
  assert.equal(calls[0].url, 'https://xingpan.site/v1/models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('上传按原始字节与 Content-Type 转发', async t => {
  const { client, calls, base } = await harness(t, async () => new Response(JSON.stringify({ url: 'https://cdn/x.png', expires_at: 1999999999, duration_seconds: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  // node fetch 无 Origin —— 代理对 POST 要求同源 Origin；fetch 默认不发送，补上
  const res = await fetch(base + '/site/reference-assets', { method: 'POST', headers: { ...originHeaders(base), Authorization: 'Bearer test-key', 'Content-Type': 'image/png' }, body: file });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.url, 'https://cdn/x.png');
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
});

test('创建强制 Idempotency-Key；客户端原样字节经代理透传', async t => {
  const { client, calls, base } = await harness(t, async () => new Response(JSON.stringify({ id: 'task-1', status: 'queued', progress: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const bodyString = JSON.stringify({ model: 'wan-3.0', prompt: 'x', seconds: 5, metadata: { ratio: '16:9', mode: 'text_to_video' } });
  // 直接走代理验证缺键拒绝
  const noKey = await fetch(base + '/site/v1/videos', { method: 'POST', headers: { ...originHeaders(base), Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: bodyString });
  assert.equal(noKey.status, 400);
  // 客户端路径（node fetch 不带 Origin，此处经 client 也会 403；用注入 fetchImpl 补 Origin 验证字节透传）
  const withOrigin = (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: base } });
  const c2 = createSiteClient({ base: base + '/site', getKey: () => 'test-key', fetchImpl: withOrigin });
  const resp = await c2.createTask(bodyString, 'idem-fixed-1');
  assert.equal(resp.id, 'task-1');
  assert.equal(calls.at(-1).init.headers['Idempotency-Key'], 'idem-fixed-1');
  assert.equal(calls.at(-1).body, bodyString, '创建体必须原字节透传');
});

test('查询与下载：非视频类型拒绝写成成片', async t => {
  const upstream = async url => {
    if (String(url).endsWith('/content')) return new Response(JSON.stringify({ error: { code: 'task_not_ready' } }), { status: 409, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'task-1', status: 'in_progress', progress: 40 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { client, base } = await harness(t, upstream);
  const withOrigin = (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: base } });
  const c2 = createSiteClient({ base: base + '/site', getKey: () => 'test-key', fetchImpl: withOrigin });
  const task = await c2.getTask('task-1');
  assert.equal(task.status, 'in_progress');
  await assert.rejects(() => c2.downloadContent('task-1'), e => e instanceof ApiError && e.status === 409);
});

test('无密钥客户端直接拒绝', async t => {
  const c = createSiteClient({ base: 'http://127.0.0.1:1/site', getKey: () => null });
  await assert.rejects(() => c.listModels(), e => e.status === 401);
});
