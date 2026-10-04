import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { createCanvasServer, SITE_ORIGIN } from './app.mjs';

async function harness(t, upstream = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) {
  const root = await mkdtemp(join(tmpdir(), 'xingpan-canvas-http-test-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Canvas test</title>');
  await writeFile(join(root, 'assets', 'index-test.js'), '/* local test */');
  const calls = [];
  const server = createCanvasServer({ staticDir: root, directorDir: root, upstreamFetch: async (...args) => { calls.push(args); return upstream(...args); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const headers = { Origin: base, Authorization: 'Bearer test-only-placeholder', 'Content-Type': 'application/json', 'Idempotency-Key': 'canvas-test-one' };
  return { base, headers, calls, server, root };
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

test('serves only local static files and original director assets', async t => {
  const { base, calls } = await harness(t);
  const home = await fetch(base); assert.equal(home.status, 200); assert.match(await home.text(), /Canvas test/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await fetch(base + '/director/assets/index-test.js')).status, 200);
  assert.equal((await fetch(base + '/director/manifest.json')).status, 404);
  assert.equal((await fetch(base + '/server/app.mjs')).status, 404);
  assert.equal((await raw(base, '/%2e%2e/private.txt')).status, 400);
  assert.equal((await raw(base, '/assets%5c..%5cprivate.txt')).status, 400);
  assert.equal(calls.length, 0);
});

test('serves director WOFF, TTF and WOFF2 bytes over GET and HEAD without forwarding', async t => {
  const { base, calls, root } = await harness(t);
  // Distinct local files exercise the real static route and MIME allowlist.
  await mkdir(join(root, 'director', 'unicode-local', 'slice'), { recursive: true });
  await writeFile(join(root, 'director', 'index.html'), '<!doctype html><title>Hosted director</title>');
  const files = [['unicode-local/slice/sans-serif.normal.400.woff', 'font/woff'], ['inter-latin.ttf', 'font/ttf'], ['inter-latin.woff2', 'font/woff2']];
  const bytes = Buffer.from([0, 1, 3, 7, 255]);
  for (const [file] of files) await writeFile(join(root, 'director', file), bytes);
  for (const [file, mime] of files) for (const method of ['GET', 'HEAD']) {
    const response = await raw(base, `/director/${file}`, { method });
    assert.equal(response.status, 200); assert.equal(response.headers['content-type'], mime);
    assert.equal(Number(response.headers['content-length']), bytes.length);
    assert.deepEqual(response.body, method === 'GET' ? bytes : Buffer.alloc(0));
  }
  assert.equal((await fetch(base + '/director/absent.ttf')).status, 404);
  assert.equal((await fetch(base + '/director/private.exe')).status, 404);
  assert.equal(calls.length, 0);
});

test('rejects DNS rebinding, cross-site requests and missing POST origin before forwarding', async t => {
  const { base, headers, calls } = await harness(t);
  assert.equal((await raw(base, '/health', { headers: { Host: 'attacker.invalid' } })).status, 403);
  assert.equal((await fetch(base + '/site/v1/models', { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
  const noOrigin = { ...headers }; delete noOrigin.Origin;
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers: noOrigin, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/site/v1/models', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(calls.length, 0);
});

test('advertises a separate director origin, allows only local widget assets across origins', async t => {
  const { base, headers, calls } = await harness(t);
  const info = await (await fetch(base + '/health')).json();
  const expected = base.replace('127.0.0.1', 'localhost');
  assert.equal(info.director_url, expected + '/director/');
  const assetHeaders = { Origin: expected, 'Sec-Fetch-Site': 'cross-site' };
  const director = await fetch(base + '/director/assets/index-test.js', { headers: assetHeaders });
  assert.equal(director.status, 200);
  assert.match(director.headers.get('content-security-policy'), /https:\/\/cdn\.hailuoai\.com/);
  const directorPolicy = director.headers.get('content-security-policy');
  const parentPolicy = (await fetch(base)).headers.get('content-security-policy');
  const sources = (policy, name) => policy.split(';').find(x => x.trim().startsWith(name + ' ')).trim().split(/\s+/).slice(1);
  assert.ok(sources(directorPolicy, 'connect-src').includes('data:'), 'local canvas image export can turn data URLs into Blobs');
  assert.ok(sources(directorPolicy, 'media-src').includes('https://filecdn.minimax.chat/public/hub-plugins/3d-director-stage/campath-previews/'));
  assert.ok(!sources(parentPolicy, 'connect-src').includes('data:'), 'director exception does not widen the parent policy');
  assert.ok(!sources(parentPolicy, 'media-src').some(x => x.startsWith('https:')));
  assert.doesNotMatch(parentPolicy, /hailuoai/);
  assert.equal((await fetch(base + '/director/index.html', { headers: { ...assetHeaders, Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(base + '/site/v1/models', { headers: { ...headers, ...assetHeaders } })).status, 403);
  assert.equal(calls.length, 0);
});

test('forwards only fixed site paths and never cookies or arbitrary destinations', async t => {
  const { base, headers, calls } = await harness(t);
  const response = await fetch(base + '/site/v1/models', { headers: { ...headers, Cookie: 'not-a-real-cookie', 'X-Upstream-URL': 'https://example.invalid' } });
  assert.equal(response.status, 200);
  assert.equal(String(calls[0][0]), SITE_ORIGIN + '/v1/models');
  assert.equal(calls[0][1].headers.Cookie, undefined);
  assert.equal(calls[0][1].headers['X-Upstream-URL'], undefined);
  assert.equal((await fetch(base + '/site/api/user/self', { headers })).status, 404);
  assert.equal((await fetch(base + '/site/v1/models?key=not-a-real-key', { headers })).status, 400);
  assert.equal(calls.length, 1);
});

test('requires bearer key, JSON and explicit idempotency; preserves exact POST bytes', async t => {
  const { base, headers, calls } = await harness(t);
  const body = '{ "model": "minimax-h3-768p-per-second", "seconds": 4 }';
  const noKey = { ...headers }; delete noKey.Authorization;
  const noIdempotency = { ...headers }; delete noIdempotency['Idempotency-Key'];
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers: noKey, body })).status, 401);
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers: noIdempotency, body })).status, 400);
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers, body: 'invalid' })).status, 400);
  assert.equal((await fetch(base + '/site/v1/videos', { method: 'POST', headers, body })).status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].body.toString(), body);
  assert.equal(calls[0][1].headers['Idempotency-Key'], 'canvas-test-one');
});

test('streams raw reference uploads; rejects wrong MIME and declared oversized material', async t => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let received;
  const { base, headers, calls } = await harness(t, async (_url, init) => {
    const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
    received = Buffer.concat(chunks);
    return new Response('{"kind":"image"}', { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal((await fetch(base + '/site/reference-assets', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: bytes })).status, 200);
  assert.deepEqual(received, bytes);
  assert.equal((await fetch(base + '/site/reference-assets', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })).status, 415);
  const over = await raw(base, '/site/reference-assets', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': 30 * 1024 * 1024 + 1 } });
  assert.equal(over.status, 413); assert.equal(calls.length, 1);
});

test('passes Retry-After and safe headers without cookies or server identifiers', async t => {
  const { base, headers } = await harness(t, async () => new Response('{"error":{"message":"请稍后重试"}}', { status: 429, headers: { 'Retry-After': '12', 'Content-Type': 'application/json', 'Set-Cookie': 'never-forward', Server: 'private-server' } }));
  const r = await fetch(base + '/site/v1/models', { headers });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '12');
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('server'), null);
});

test('accepts exactly 30 MiB and rejects a chunked upload exceeding the image limit', async t => {
  const { base, headers, calls } = await harness(t, async (_url, init) => {
    let bytes = 0; for await (const chunk of init.body) bytes += chunk.length;
    return Response.json({ bytes });
  });
  const limit = 30 * 1024 * 1024;
  const exact = await fetch(base + '/site/reference-assets', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: Buffer.alloc(limit, 1) });
  assert.equal(exact.status, 200); assert.equal((await exact.json()).bytes, limit);
  const oversized = await raw(base, '/site/reference-assets', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' }, body: Buffer.alloc(limit + 1, 1) });
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, 2);
});

test('does not follow upstream redirects or forward private redirect addresses', async t => {
  const { base, headers, calls } = await harness(t, async () => new Response(null, { status: 302, headers: { Location: 'https://private.invalid/private' } }));
  const r = await fetch(base + '/site/v1/models', { headers });
  assert.equal(r.status, 502); assert.equal(r.headers.get('location'), null);
  assert.doesNotMatch(await r.text(), /private\.invalid/);
  assert.equal(calls[0][1].redirect, 'manual'); assert.equal(calls.length, 1);
});

test('streams content and retains valid byte-range semantics', async t => {
  const { base, headers, calls } = await harness(t, async () => new Response(Buffer.from('12345'), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/20', 'Accept-Ranges': 'bytes', 'Content-Length': '5' } }));
  const r = await fetch(base + '/site/v1/videos/task_example/content', { headers: { ...headers, Range: 'bytes=0-4' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 0-4/20');
  assert.equal(await r.text(), '12345'); assert.equal(calls[0][1].headers.Range, 'bytes=0-4');
  assert.equal((await fetch(base + '/site/v1/videos/task_example/content', { headers: { ...headers, Range: 'bytes=0-4,10-15' } })).status, 400);
});

test('does not retry a failed POST and hides underlying exception details', async t => {
  const { base, headers, calls } = await harness(t, async () => { throw new Error('upstream private URL + a credential must never appear'); });
  const r = await fetch(base + '/site/v1/videos', { method: 'POST', headers, body: '{"model":"wan-3.0"}' });
  assert.equal(r.status, 502); assert.equal(calls.length, 1);
  const text = await r.text(); assert.doesNotMatch(text, /credential|private URL/); assert.match(text, /幂等键/);
});
