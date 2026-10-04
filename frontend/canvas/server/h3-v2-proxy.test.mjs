// H3 v2 cancel 代理白名单回归：本机 proxy→fake upstream 验证 method/body/凭据，非仅 client mock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { createCanvasServer, SITE_ORIGIN } from './app.mjs';

async function harness(t, upstream = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) {
  const root = await mkdtemp(join(tmpdir(), 'xingpan-canvas-h3v2-test-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Canvas test</title>');
  const calls = [];
  const server = createCanvasServer({ staticDir: root, directorDir: root, upstreamFetch: async (...args) => { calls.push(args); return upstream(...args); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const headers = { Origin: base, Authorization: 'Bearer test-only-placeholder', 'Content-Type': 'application/json' };
  return { base, headers, calls };
}
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base, { path, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('POST /site/v1/videos/<id>/cancel 透传同路径：方法/请求体/凭据正确', async t => {
  let seen;
  const { base, headers } = await harness(t, async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"status":"in_progress","cancel_requested":true,"executor_version":2}', { headers: { 'Content-Type': 'application/json' } });
  });
  const r = await fetch(base + '/site/v1/videos/vjob_abc-1/cancel', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'in_progress', cancel_requested: true, executor_version: 2 });
  assert.equal(seen.url, SITE_ORIGIN + '/v1/videos/vjob_abc-1/cancel');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body.toString(), '{}');
  assert.equal(seen.init.headers.Authorization, headers.Authorization);
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.headers['Idempotency-Key'], undefined, '取消不要求专属幂等键');
});

test('cancel 白名单收窄：鉴权/同源/JSON/体量/任意路径一律不触达上游', async t => {
  const { base, headers, calls } = await harness(t);
  const noKey = { ...headers }; delete noKey.Authorization;
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers: noKey, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers, body: 'not-json' })).status, 400);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers, body: '[1]' })).status, 400);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel?key=x', { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel', { headers })).status, 404);
  assert.equal((await raw(base, '/site/v1/videos/vjob_1/cancel', { method: 'DELETE', headers })).status, 404);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1/cancel/extra', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/site/v1/videos/vjob_1', { method: 'POST', headers, body: '{}' })).status, 404);
  const big = await raw(base, '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers: { ...headers, 'Content-Length': '5000' }, body: Buffer.alloc(5000, 123) });
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0, '被拒绝请求不得触达上游');
});

test('cancel 上游失败不重试、不透出内部细节', async t => {
  const { base, headers, calls } = await harness(t, async () => { throw new Error('upstream private detail must never appear'); });
  const r = await fetch(base + '/site/v1/videos/vjob_1/cancel', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 502);
  assert.equal(calls.length, 1, '代理不得自动重试');
  assert.doesNotMatch(await r.text(), /private detail/);
});
