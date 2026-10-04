// R05 安全复核（本机服务）独立验收：直接以原始 HTTP 请求打真实 createCanvasServer（上游为本地替身）。
// 覆盖：DNS 重绑定 Host、跨源/跨站、POST 必须本机 Origin、固定路由白名单（不是任意 URL 代理）、
// 地址中带密钥、缺密钥、路径穿越、请求体与上传大小/类型上限、上游重定向不外泄、错误信息脱敏、
// 安全响应头（CSP/nosniff/frame-ancestors）、只监听回环地址。
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasServer } from '../server/app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'sk-synthetic-SECRET-MARKER-7f3a';

async function boot(t, upstreamImpl) {
  const upstream = { calls: [] };
  const server = createCanvasServer({
    staticDir: join(ROOT, 'src'), directorDir: join(ROOT, 'tests', 'no-director-assets'), mediaService: false,
    upstreamFetch: async (url, init = {}) => { upstream.calls.push({ url: String(url), method: init.method ?? 'GET' }); return upstreamImpl ? upstreamImpl(url, init) : Response.json({ data: [] }); },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const port = server.address().port;
  const send = ({ method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
  const self = `http://127.0.0.1:${port}`;
  return { send, upstream, port, self };
}
const auth = { authorization: `Bearer ${SECRET}` };

test('DNS 重绑定：非本机 Host 一律拒绝（含 localhost 以外的名字和错端口）', async t => {
  const { send, port } = await boot(t);
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `0.0.0.0:${port}`, `[::1]:${port}`]) {
    const r = await send({ path: '/', headers: { host } });
    assert.equal(r.status, 403, host); assert.equal(r.json?.error?.code, 'invalid_host', host);
  }
  assert.equal((await send({ path: '/health', headers: { host: `localhost:${port}` } })).status, 200);
});

test('跨源与跨站：其他 Origin 拒绝；POST 必须带本机 Origin；Sec-Fetch-Site cross-site 拒绝', async t => {
  const { send, upstream, self } = await boot(t);
  assert.equal((await send({ path: '/health', headers: { origin: 'https://evil.example' } })).json.error.code, 'invalid_origin');
  assert.equal((await send({ path: '/health', headers: { 'sec-fetch-site': 'cross-site' } })).json.error.code, 'cross_site_request');
  const noOrigin = await send({ method: 'POST', path: '/site/v1/videos', headers: { ...auth, 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.equal(noOrigin.status, 403); assert.equal(noOrigin.json.error.code, 'origin_required');
  const evil = await send({ method: 'POST', path: '/site/v1/videos', headers: { ...auth, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.equal(evil.status, 403);
  assert.equal(upstream.calls.length, 0, '被拒请求不得到达上游');
  const ok = await send({ method: 'POST', path: '/site/v1/videos', headers: { ...auth, origin: self, 'content-type': 'application/json', 'idempotency-key': 'k1' }, body: '{"model":"m"}' });
  assert.notEqual(ok.status, 403, '本机 Origin 的 POST 可通过');
});

test('不是任意 URL 代理：只放行固定路由；绝对地址/双斜杠/未知路径与 HTTP 方法均拒绝且不触达上游', async t => {
  const { send, upstream } = await boot(t);
  const bad = ['/site/https://evil.example/x', '/site/v1/../../admin', '/site/v1/videos/abc/../../x', '/site/api/usage/token/canvas-identity',
    '/site/v1/videos/a%2Fb', '/site/v1/files', '/site/v1/videos/abc/content/extra', '//evil.example/site/v1/models'];
  for (const path of bad) {
    const r = await send({ path, headers: auth });
    assert.ok([400, 404].includes(r.status), `${path} → ${r.status}`);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.ok([403, 404, 405].includes((await send({ method, path: '/site/v1/videos/abc', headers: auth })).status), method);
  assert.equal(upstream.calls.length, 0);
  // 放行的固定路由只指向本站源
  await send({ path: '/site/v1/models', headers: auth });
  assert.equal(upstream.calls.length, 1);
  assert.equal(new URL(upstream.calls[0].url).origin, 'https://xingpan.site');
});

test('密钥卫生：地址查询参数拒绝（防止密钥进地址/日志）；缺密钥 401 且不访问上游', async t => {
  const { send, upstream } = await boot(t);
  const q = await send({ path: `/site/v1/models?key=${SECRET}`, headers: auth });
  assert.equal(q.status, 400); assert.equal(q.json.error.code, 'query_not_allowed');
  assert.ok(!q.text.includes(SECRET));
  const none = await send({ path: '/site/v1/models' });
  assert.equal(none.status, 401); assert.equal(none.json.error.code, 'key_required');
  const malformed = await send({ path: '/site/v1/models', headers: { authorization: 'Basic abc' } });
  assert.equal(malformed.status, 401);
  assert.equal(upstream.calls.length, 0);
});

test('路径穿越与编码攻击：不泄露仓库或系统文件', async t => {
  const { send } = await boot(t);
  for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/index.html%00.js', '/%E0%A4%A', '/director/../../package.json', '/director/assets/../../../package.json']) {
    const r = await send({ path });
    assert.ok(r.status >= 400, `${path} → ${r.status}`);
    assert.ok(!/"name"\s*:\s*"xingpan|"dependencies"/.test(r.text), `${path} 泄露了文件内容`);
  }
});

test('大小与类型上限：超大 JSON 413；未知上传类型 415；声明超限的上传 413；均不转发', async t => {
  const { send, upstream, self } = await boot(t);
  const huge = '{"model":"m","prompt":"' + 'x'.repeat(8 * 1024 * 1024 + 10) + '"}';
  const r1 = await send({ method: 'POST', path: '/site/v1/videos', headers: { ...auth, origin: self, 'content-type': 'application/json', 'idempotency-key': 'k' }, body: huge });
  assert.equal(r1.status, 413);
  const r2 = await send({ method: 'POST', path: '/site/reference-assets', headers: { ...auth, origin: self, 'content-type': 'application/x-msdownload' }, body: 'MZ' });
  assert.equal(r2.status, 415);
  const r3 = await send({ method: 'POST', path: '/site/reference-assets', headers: { ...auth, origin: self, 'content-type': 'image/png', 'content-length': String(31 * 1024 * 1024) }, body: '' }).catch(e => ({ status: 413, error: e.code }));
  assert.equal(r3.status, 413);
  assert.equal(upstream.calls.length, 0);
});

test('上游重定向不跟随、不向客户端透传 Location；上游异常信息与密钥不出现在响应中', async t => {
  let mode = 'redirect';
  const { send, upstream } = await boot(t, async () => {
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: `https://evil.example/steal?k=${SECRET}` } });
    throw new Error(`upstream exploded with ${SECRET} at C:\\secret\\path`);
  });
  const r = await send({ path: '/site/v1/models', headers: auth });
  assert.equal(upstream.calls.length, 1, '只请求一次，不跟随重定向');
  assert.equal(r.headers.location, undefined);
  assert.ok(!r.text.includes(SECRET) && !r.text.includes('evil.example'));
  mode = 'throw';
  const e = await send({ path: '/site/v1/models', headers: auth });
  assert.ok(e.status >= 500);
  assert.ok(!e.text.includes(SECRET) && !e.text.includes('secret\\path') && !e.text.includes('exploded'), e.text);
});

test('安全响应头：页面带 CSP（object-src none、frame-ancestors、base-uri）与 nosniff、no-referrer', async t => {
  const { send } = await boot(t);
  const r = await send({ path: '/' });
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'] ?? '';
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", 'frame-ancestors']) assert.ok(csp.includes(d), `CSP 缺少 ${d}`);
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp), '主页面脚本不允许 unsafe-eval');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  const api = await send({ path: '/health' });
  assert.equal(api.headers['cache-control'], 'no-store');
});

test('只监听回环地址：启动脚本固定 127.0.0.1（不是 0.0.0.0）', () => {
  const main = readFileSync(join(ROOT, 'server', 'main.mjs'), 'utf8');
  assert.match(main, /listen\(port, '127\.0\.0\.1'/);
  assert.ok(!/0\.0\.0\.0|'::'/.test(main));
});
