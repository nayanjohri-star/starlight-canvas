// /site 代理扩展测试：chat/completions 与 images/generations|edits 的窄化放行 + 原有防护不回归。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasServer } from './app.mjs';
import { checkStudioBody } from './studio-proxy.mjs';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, port, staticDir, directorDir;
let upstreamCalls;
let upstreamImpl;

before(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'cv-static-'));
  directorDir = await mkdtemp(join(tmpdir(), 'cv-dir-'));
  await writeFile(join(staticDir, 'index.html'), '<html></html>');
  upstreamCalls = [];
  upstreamImpl = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  server = createCanvasServer({
    staticDir, directorDir,
    upstreamFetch: async (url, opts) => { upstreamCalls.push({ url: String(url), opts }); return upstreamImpl(url, opts); },
    mediaService: { handleRequest: (req, res, pathname) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`media ${pathname}`); } },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  server?.close();
  await rm(staticDir, { recursive: true, force: true });
  await rm(directorDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;
const headers = () => ({ Origin: base(), Authorization: 'Bearer mock-generated-test', 'Content-Type': 'application/json' });
const post = (path, body, extra = {}) => fetch(`${base()}${path}`, {
  method: 'POST', headers: { ...headers(), ...extra },
  body: Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body),
});

const chatBody = (over = {}) => ({
  model: 'deepseek-chat', stream: false, max_tokens: 256,
  messages: [{ role: 'user', content: 'hi' }], ...over,
});
const imgBody = (over = {}) => ({
  model: 'gpt-image-2.5-flare', prompt: 'a', size: '1024x1024', n: 1, response_format: 'b64_json', ...over,
});

test('chat/completions 透传：路径/鉴权头/原字节', async () => {
  const res = await post('/site/v1/chat/completions', chatBody());
  assert.equal(res.status, 200);
  const call = upstreamCalls.at(-1);
  assert.equal(call.url, 'https://xingpan.site/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer mock-generated-test');
  assert.equal(call.opts.headers['Content-Type'], 'application/json');
  assert.ok(!('Cookie' in call.opts.headers));
});

test('chat/completions 窄化：stream/工具/缺 max_tokens 拒绝', async () => {
  assert.equal((await post('/site/v1/chat/completions', chatBody({ stream: true }))).status, 400);
  const noTokens = chatBody(); delete noTokens.max_tokens;
  assert.equal((await post('/site/v1/chat/completions', noTokens)).status, 400);
  assert.equal((await post('/site/v1/chat/completions', chatBody({ tools: [] }))).status, 400);
  const badMsg = chatBody({ messages: [{ role: 'system', content: 'x', extra: 1 }] });
  assert.equal((await post('/site/v1/chat/completions', badMsg)).status, 400);
});

test('images/generations 窄化', async () => {
  assert.equal((await post('/site/v1/images/generations', imgBody())).status, 200);
  assert.equal((await post('/site/v1/images/generations', imgBody({ model: 'dall-e-3' }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', imgBody({ size: '4096x4096' }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', imgBody({ size: '999x999' }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', imgBody({ n: 2 }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', imgBody({ response_format: 'url' }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', imgBody({ size: '1024x1024', resolution: '1K' }))).status, 400);
  assert.equal((await post('/site/v1/images/generations', { ...imgBody(), size: undefined, resolution: '4K', aspect_ratio: '16:9' })).status, 200);
});

test('images/edits JSON：有序多图；mask/url/混用字段拒绝', async () => {
  const ok = { ...imgBody(), image: `data:image/png;base64,${PNG_1PX}` };
  assert.equal((await post('/site/v1/images/edits', ok)).status, 200);
  const multi = { ...ok, image: undefined, images: [ok.image, ok.image, ok.image] };
  assert.equal((await post('/site/v1/images/edits', multi)).status, 200);
  assert.deepEqual(JSON.parse(upstreamCalls.at(-1).opts.body.toString()).images, multi.images);
  assert.equal((await post('/site/v1/images/edits', { ...multi, image: ok.image })).status, 400);
  assert.equal((await post('/site/v1/images/edits', { ...multi, images: Array(9).fill(ok.image) })).status, 400);
  assert.equal((await post('/site/v1/images/edits', { ...multi, images: [ok.image, 'invalid'] })).status, 400);
  assert.equal((await post('/site/v1/images/edits', { ...ok, mask: 'x' })).status, 400);
  assert.equal((await post('/site/v1/images/edits', { ...ok, image: 'https://example.com/a.png' })).status, 400);
  assert.equal((await post('/site/v1/images/edits', { ...ok, image: 'data:image/png;base64,/9j/AA==' })).status, 400);   // 声明与魔数不符
  assert.equal((await post('/site/v1/images/edits', { ...ok, image: ['data:image/png;base64,' + PNG_1PX] })).status, 400);
});

test('images/edits multipart：单文件流透传', async () => {
  const boundary = '----cvtestboundary';
  const png = Buffer.from(PNG_1PX, 'base64');
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field('model', 'gpt-image-2.5-flare') + field('prompt', '改成蓝色') + field('size', '1024x1024') + field('n', '1') + field('response_format', 'b64_json')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await post('/site/v1/images/edits', body, { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(res.status, 200);
  const call = upstreamCalls.at(-1);
  assert.match(call.opts.headers['Content-Type'], /multipart\/form-data; boundary=/);
});

test('原有防护不回归', async () => {
  // 未知路由 404
  assert.equal((await post('/site/v1/other', {})).status, 404);
  // POST 缺 Origin → 403
  const res = await fetch(`${base()}/site/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer mock-generated-test', 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()),
  });
  assert.equal(res.status, 403);
  // 上游重定向不跟随
  upstreamImpl = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  assert.equal((await post('/site/v1/chat/completions', chatBody())).status, 502);
  upstreamImpl = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  // /v1/models 与视频路由照常
  assert.equal((await fetch(`${base()}/site/v1/models`, { headers: { Origin: base(), Authorization: 'Bearer mock-generated-test' } })).status, 200);
  assert.equal((await post('/site/v1/videos', { model: 'x' })).status, 400);   // 缺 Idempotency-Key
  // 媒体服务挂载点
  const m = await fetch(`${base()}/media/clip/abc`, { headers: { Origin: base() } });
  assert.equal(m.status, 200);
  assert.equal(await m.text(), 'media /media/clip/abc');
  // 媒体接口拒绝查询参数；POST 无 Origin → 403
  assert.equal((await fetch(`${base()}/media/render?path=/etc/x`, { headers: { Origin: base() } })).status, 400);
  const noOrigin = await fetch(`${base()}/media/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
});

test('公开价目 /site/api/pricing：无凭据转发 + 响应 JSON 校验', async () => {
  upstreamImpl = () => new Response(JSON.stringify({ models: { 'gpt-image-2.5-flare': { '1K': 0.03 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const res = await fetch(`${base()}/site/api/pricing`, { headers: { Origin: base() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.models['gpt-image-2.5-flare']['1K'], 0.03);
  const call = upstreamCalls.at(-1);
  assert.equal(call.url, 'https://xingpan.site/api/pricing');
  assert.equal(call.opts.headers.Authorization, undefined);
  upstreamImpl = () => new Response('[1]', { status: 200 });
  assert.equal((await fetch(`${base()}/site/api/pricing`, { headers: { Origin: base() } })).status, 502);
  upstreamImpl = () => new Response('not json', { status: 200 });
  assert.equal((await fetch(`${base()}/site/api/pricing`, { headers: { Origin: base() } })).status, 502);
  upstreamImpl = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
});

test('checkStudioBody 单元校验', () => {
  assert.doesNotThrow(() => checkStudioBody('chat', Buffer.from(JSON.stringify(chatBody()))));
  assert.throws(() => checkStudioBody('chat', Buffer.from('{"a":1}')), e => e.status === 400);
  assert.throws(() => checkStudioBody('image_gen', Buffer.from(JSON.stringify(imgBody({ quality: 'hd' })))), e => e.code === 'bad_quality');
  assert.throws(() => checkStudioBody('image_edit', Buffer.from(JSON.stringify(imgBody()))), e => e.code === 'bad_image');
  assert.throws(() => checkStudioBody('nope', Buffer.from('{}')), e => e.status === 404);
});


test('multipart multi-image uploads validate every part rather than only the final duplicate field', async () => {
  const boundary = 'multi-image-boundary';
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const png = Buffer.from(PNG_1PX, 'base64');
  const requestBody = images => Buffer.concat([
    Buffer.from(Object.entries(imgBody()).map(([name, value]) => field(name, value)).join('')),
    ...images.flatMap(bytes => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  upstreamImpl = () => Response.json({ok: true});
  const headers = {'Content-Type': `multipart/form-data; boundary=${boundary}`};
  const body = requestBody([png, png, png]);
  const success = await post('/site/v1/images/edits', body, headers); assert.equal(success.status, 200);
  assert.deepEqual(upstreamCalls.at(-1).opts.body, body);
  const before = upstreamCalls.length;
  assert.equal((await post('/site/v1/images/edits', requestBody([Buffer.from('invalid'), png, png]), headers)).status, 400);
  assert.equal((await post('/site/v1/images/edits', requestBody(Array(9).fill(png)), headers)).status, 400);
  assert.equal(upstreamCalls.length, before);
});
