// R10 回归：成片下载安全校验（纯模拟 fetchImpl，无网络/代理/真实上游，无付费调用）。
// 完整下载不得接受局部 206；分段 API 仅在区间严格校验后放行；实收字节必须匹配声明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteClient, ApiError } from '../src/api.js';

function client(handler, calls) {
  return createSiteClient({
    base: '/site', getKey: () => 'test-key',
    fetchImpl: async (url, init) => { calls?.push({ url, init }); return handler(url, init); },
  });
}
// 鸭式 Response：仅覆盖 request()/downloadContent 实际访问面，避免依赖具体 Response 实现的头同步行为
function fakeRes(status, headers, bytes) {
  return {
    status, ok: status >= 200 && status < 300, headers: new Headers(headers),
    blob: async () => new Blob([bytes]),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}
// 以 ftyp box 头开头的 mp4 形字节（前 8 字节为合法 box 头），尾部填 0；n>=8
const mp4 = n => { const b = new Uint8Array(n); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]); return b; };
const webm = n => { const b = new Uint8Array(n); b.set([0x1a, 0x45, 0xdf, 0xa3]); return b; };
const rejects = (p, code, extra = {}) => assert.rejects(p, e =>
  e instanceof ApiError && e.code === code && Object.entries(extra).every(([k, v]) => e[k] === v));

test('200 完整下载：返回完整 blob 与类型，未发送 Range', async () => {
  const calls = [];
  const c = client(() => fakeRes(200, { 'content-type': 'video/mp4', 'content-length': '64' }, mp4(64)), calls);
  const r = await c.downloadContent('task-1');
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'video/mp4');
  assert.equal(r.blob.size, 64);
  assert.equal(calls[0].init.headers.Range, undefined);
});

test('200 webm 完整下载放行；Content-Type 带参数仍按视频识别', async () => {
  const c = client(() => fakeRes(200, { 'content-type': 'video/webm; codecs=vp9' }, webm(32)));
  const r = await c.downloadContent('task-1');
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'video/webm');
  assert.equal(r.blob.size, 32);
});

test('JSON 错标失败之一：200 但 Content-Type 为 application/json → 拒绝', async () => {
  const c = client(() => fakeRes(200, { 'content-type': 'application/json' },
    new TextEncoder().encode('{"error":{"code":"task_not_ready","message":"not ready"}}')));
  await rejects(c.downloadContent('task-1'), 'unexpected_content_type', { status: 200 });
});

test('JSON 错标失败之二：Content-Type 谎称 video/mp4 但负载是 JSON → 嗅探拒绝', async () => {
  const c = client(() => fakeRes(200, { 'content-type': 'video/mp4' },
    new TextEncoder().encode('{"error":{"code":"expired","message":"link expired"}}')));
  await rejects(c.downloadContent('task-1'), 'not_video_payload');
});

test('非 2xx 的 JSON 错误体：status/code 原样透传', async () => {
  const c = client(() => fakeRes(409, { 'content-type': 'application/json' },
    new TextEncoder().encode('{"error":{"code":"task_not_ready","message":"还没好"}}')));
  await rejects(c.downloadContent('task-1'), 'task_not_ready', { status: 409 });
});

test('合法 206：请求 bytes=100-，返回 100-999/1000 且 900 字节齐全 → 放行', async () => {
  const calls = [];
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 100-999/1000', 'content-length': '900',
  }, mp4(900)), calls);
  const r = await c.downloadContent('task-1', { rangeStart: 100 });
  assert.equal(r.status, 206);
  assert.equal(r.blob.size, 900);
  assert.equal(r.contentRange, 'bytes 100-999/1000');
  assert.equal(calls[0].init.headers.Range, 'bytes=100-');
});

test('未请求分段却回 206 但区间覆盖全文（0-15/16 且字节齐全）：等价完整内容放行', async () => {
  const c = client(() => fakeRes(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-15/16' }, mp4(16)));
  const r = await c.downloadContent('task-1');
  assert.equal(r.status, 206);
  assert.equal(r.blob.size, 16);
});

test('分段请求被回 200（服务端忽略 Range）：按完整内容校验并放行', async () => {
  const c = client(() => fakeRes(200, { 'content-type': 'video/mp4' }, mp4(64)));
  const r = await c.downloadContent('task-1', { rangeStart: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.blob.size, 64);
});

test('R10 复现：未请求分段收到局部 206（bytes 100-103/1000 + 4 字节）→ 拒绝，不得冒充完整成片', async () => {
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 100-103/1000',
  }, mp4(8).slice(0, 4)));
  await rejects(c.downloadContent('task-1'), 'incomplete_content', { status: 206 });
});

test('未请求分段的 206 起点为 0 但未覆盖全文（0-499/1000）→ 拒绝', async () => {
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 0-499/1000',
  }, mp4(500)));
  await rejects(c.downloadContent('task-1'), 'incomplete_content');
});

test('分段请求起点不符（请求 100-，返回 50-999/1000）→ 拒绝', async () => {
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 50-999/1000',
  }, mp4(950)));
  await rejects(c.downloadContent('task-1', { rangeStart: 100 }), 'range_mismatch');
});

test('分段未覆盖到末尾（请求 100-，返回 100-149/1000）→ 拒绝', async () => {
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 100-149/1000',
  }, mp4(50)));
  await rejects(c.downloadContent('task-1', { rangeStart: 100 }), 'incomplete_content');
});

test('非法/越界 Content-Range 一律拒绝', async () => {
  const cases = [
    ['bytes abc-def/xyz', 'bad_content_range'],
    ['items 0-9/100', 'bad_content_range'],
    ['bytes 5-3/100', 'bad_content_range'],                          // start > end
    ['bytes 0-100/100', 'bad_content_range'],                        // end >= total
    ['bytes 0-9/*', 'bad_content_range'],                            // 总长未知，无法验证完整性
    ['bytes 0-99999999999999999999/99999999999999999999', 'bad_content_range'], // 超安全整数
  ];
  for (const [cr, code] of cases) {
    const c = client(() => fakeRes(206, { 'content-type': 'video/mp4', 'content-range': cr }, mp4(16)));
    await rejects(c.downloadContent('task-1'), code);
  }
  // Content-Range 头缺失
  const c = client(() => fakeRes(206, { 'content-type': 'video/mp4' }, mp4(16)));
  await rejects(c.downloadContent('task-1'), 'bad_content_range');
});

test('分段实收字节少于 Content-Range 声明（100-999/1000 只到 500 字节）→ 拒绝', async () => {
  const c = client(() => fakeRes(206, {
    'content-type': 'video/mp4', 'content-range': 'bytes 100-999/1000',
  }, mp4(500)));
  await rejects(c.downloadContent('task-1', { rangeStart: 100 }), 'truncated_content');
});

test('200 声明 Content-Length 与实收不符 → 拒绝（截断保护）', async () => {
  const c = client(() => fakeRes(200, {
    'content-type': 'video/mp4', 'content-length': '1000',
  }, mp4(32)));
  await rejects(c.downloadContent('task-1'), 'truncated_content');
});

test('非法 Content-Length 头 → 拒绝', async () => {
  const c = client(() => fakeRes(200, {
    'content-type': 'video/mp4', 'content-length': '1e5',
  }, mp4(32)));
  await rejects(c.downloadContent('task-1'), 'bad_content_length');
});

test('完整下载返回空体 → 拒绝，空文件不得入库', async () => {
  const c = client(() => fakeRes(200, { 'content-type': 'video/mp4', 'content-length': '0' }, new Uint8Array(0)));
  await rejects(c.downloadContent('task-1'), 'empty_content');
});

test('非法下载起点（负数/非整数/非安全整数）不发请求直接拒绝', async () => {
  let called = 0;
  const c = createSiteClient({
    base: '/site', getKey: () => 'test-key',
    fetchImpl: async () => { called++; return fakeRes(200, {}, mp4(8)); },
  });
  await rejects(c.downloadContent('task-1', { rangeStart: -1 }), 'invalid_range');
  await rejects(c.downloadContent('task-1', { rangeStart: 0.5 }), 'invalid_range');
  await rejects(c.downloadContent('task-1', { rangeStart: Number.MAX_SAFE_INTEGER + 1 }), 'invalid_range');
  assert.equal(called, 0);
});
