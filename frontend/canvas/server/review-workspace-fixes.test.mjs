// 审查修复回归测试（server 侧）：node --test。
// 覆盖 WS-1 配额提示与不自动清理、WS-2 CSP 双源隔离、WS-4 索引损坏与 v1 显式迁移、
// WS-5 写操作现场身份复核、WS-6 版本歧义、WS-7 HEAD+keep-alive 回归。
// 全部注入假身份与临时目录，不打生产网络；HTTP 边界用真实本地监听验证。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { Readable } from 'node:stream';
import { createWorkspaceService } from './workspace-service.mjs';
import { createCanvasServer } from './app.mjs';
import { zipStore } from '../src/export-project.js';

const enc = new TextEncoder();
const NOW = 1_700_000_000_000;
const createdDirs = [];
function tmpDir() { const d = mkdtempSync(join(tmpdir(), 'ws-fix-')); createdDirs.push(d); return d; }
process.on('exit', () => { for (const d of createdDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 只清理本测试创建的目录 */ } } });

const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(24).fill(0)]);

function makePackage({ name = '测试项目', media = [], projectMutate } = {}) {
  const assets = {};
  const refNodes = [];
  for (const m of media) {
    const aid = m.assetId ?? 'a_1';
    assets[aid] = { id: aid, name: m.name ?? 'm', kind: m.kind ?? 'image', mime: m.mime, size: m.data.length };
    if ((m.kind ?? 'image') === 'file') refNodes.push({ id: `n_${aid}`, type: 'director', x: 0, y: 0, data: { assetId: aid } });
  }
  const project = { name, nodes: refNodes, edges: [], assets };
  const doc = { format: 'xingpan-canvas@2', exportedAt: '2026-01-01T00:00:00Z', project, tasks: [], pending: [], director: {} };
  projectMutate?.(doc);
  const manifest = {
    format: 'xp-package@1', version: 1, exportedAt: '2026-01-01T00:00:00Z',
    timeline: { clips: [], meta: { version: 1, width: 1280, height: 720, fps: 30 } },
    media: media.map(m => ({ path: m.path, assetId: m.assetId ?? 'a_1', name: m.name ?? 'm', kind: m.kind ?? 'image', mime: m.mime, size: m.data.length })),
  };
  return zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    { name: 'project.json', data: enc.encode(JSON.stringify(doc)) },
    ...media.map(m => ({ name: m.path, data: m.data })),
  ]);
}

function resp(status, body) {
  const text = JSON.stringify(body);
  return { status, headers: { get: () => null }, body: { cancel() {} }, json: async () => body, text: async () => text, arrayBuffer: async () => enc.encode(text).buffer };
}

// keys 可传映射表或函数（key → entry|null），便于模拟「先有效后吊销」
const KEYS = { 'k-a1': { subject: 'u_1', name: '甲' }, 'k-a2': { subject: 'u_1' }, 'k-b1': { subject: 'u_2', name: '乙' } };
function makeService({ keys = KEYS, limits = {}, now = () => NOW, dataDir, hooks } = {}) {
  const dir = dataDir ?? tmpDir();
  const lookup = typeof keys === 'function' ? keys : k => keys[k];
  const upstreamCalls = [];
  const upstreamFetch = async (url, opts = {}) => {
    upstreamCalls.push({ url: String(url), opts });
    const key = /^Bearer (.+)$/.exec(opts?.headers?.Authorization ?? '')?.[1] ?? '';
    const entry = lookup(key);
    if (!entry) return resp(401, { code: false });
    return resp(200, { success: true, message: 'ok', data: { subject: entry.subject, display_name: entry.name ?? null } });
  };
  const svc = createWorkspaceService({ dataDir: dir, upstreamFetch, limits, clock: now, hooks });
  return { dir, svc, upstreamCalls };
}

function mockRes() {
  const res = {
    status: 0, headers: {}, chunks: [],
    writeHead(s, h = {}) { res.status = s; Object.assign(res.headers, h); return res; },
    write(d) { res.chunks.push(Buffer.from(d)); },
    end(d) { if (d != null) res.chunks.push(Buffer.from(d)); },
    on() {}, off() {},
    get headersSent() { return res.status !== 0; }, destroyed: false,
    destroy() { res.destroyed = true; },
    body() { return Buffer.concat(res.chunks); },
    json() { return JSON.parse(res.body().toString('utf8')); },
  };
  return res;
}
function mockReq(method, { key, headers = {}, body } = {}) {
  const r = Readable.from(body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  r.method = method;
  r.headers = { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9', ...headers };
  if (key) r.headers.authorization = `Bearer ${key}`;
  return r;
}
async function call(svc, method, path, opts = {}) {
  const res = mockRes();
  const handled = await svc.handleRequest(mockReq(method, opts), res, path);
  return { handled, res };
}
async function setupProject(svc, key = 'k-a1', name = 'P1') {
  const c = await call(svc, 'POST', '/workspace/projects', { key, body: JSON.stringify({ name }) });
  assert.equal(c.res.status, 201);
  const proj = c.res.json().project;
  const put = await call(svc, 'PUT', `/workspace/projects/${proj.owner}/${proj.id}`, { key, headers: { 'if-match': 'r0' }, body: makePackage({ name }) });
  assert.equal(put.res.status, 201);
  return { ...proj, head: put.res.json().head };
}

// 真实 HTTP 边界：本地监听 + 真实 Host 头 / keep-alive 连接
async function httpServer(t, svc) {
  const root = tmpDir();
  mkdirSync(join(root, 'static')); mkdirSync(join(root, 'director'));
  writeFileSync(join(root, 'static', 'index.html'), '<!doctype html><title>canvas</title>');
  writeFileSync(join(root, 'director', 'index.html'), '<!doctype html><title>director</title>');
  const server = createCanvasServer({
    staticDir: join(root, 'static'), directorDir: join(root, 'director'),
    upstreamFetch: async () => new Response('{}'),
    mediaService: false, workspaceService: svc,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return server.address().port;
}
function hreq(port, method, path, { headers = {}, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent, headers: { Authorization: 'Bearer k-a1', ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const cspList = (res, name) => String(res.headers['content-security-policy'] ?? '')
  .split(';').map(s => s.trim()).find(s => s.startsWith(name + ' '))?.split(/\s+/).slice(1) ?? [];

test('WS-4 合法 JSON 但结构损坏的 index.json 一律 storage_corrupt，绝不重置为空索引', async () => {
  const cases = [
    { name: 'projects 为数组', idx: { format: 'xp-workspace@2', projects: [], shares: {} } },
    { name: '缺 shares', idx: { format: 'xp-workspace@2', projects: {} } },
    { name: '未知格式', idx: { format: 'xp-workspace@9', projects: {}, shares: {} } },
    { name: '顶层非对象', idx: [1, 2, 3] },
    { name: '项目条目损坏', idx: { format: 'xp-workspace@2', projects: { wp_bad: 'junk' }, shares: {} } },
    { name: '邀请索引损坏', idx: { format: 'xp-workspace@2', projects: {}, shares: { abc: 'junk' } } },
  ];
  for (const c of cases) {
    const dir = tmpDir();
    writeFileSync(join(dir, 'index.json'), JSON.stringify(c.idx));
    const before = readFileSync(join(dir, 'index.json'), 'utf8');
    const { svc } = makeService({ dataDir: dir });
    const r = await call(svc, 'GET', '/workspace/projects', { key: 'k-a1' });
    assert.equal(r.res.status, 500, c.name);
    assert.equal(r.res.json().error.code, 'storage_corrupt', c.name);
    // 写操作同样拒绝，且绝不覆盖原文件
    const w = await call(svc, 'POST', '/workspace/projects', { key: 'k-a1', body: JSON.stringify({ name: 'X' }) });
    assert.equal(w.res.status, 500, c.name);
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before, c.name);
  }
  // 结构完好的空索引正常工作
  const dir = tmpDir();
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ format: 'xp-workspace@2', projects: {}, shares: {} }));
  const { svc } = makeService({ dataDir: dir });
  assert.deepEqual((await call(svc, 'GET', '/workspace/projects', { key: 'k-a1' })).res.json().projects, []);
});

test('WS-4 v1 索引显式迁移：meta.json 读入内联、原文件不动、损坏如实报错', async () => {
  const dir = tmpDir();
  const pid = 'wp_00000000-0000-0000-0000-000000000001';
  const metaFile = join(dir, 'projects', pid, 'meta.json');
  mkdirSync(join(dir, 'projects', pid), { recursive: true });
  const meta = { format: 'xp-workspace@1', id: pid, owner: 'u_1', name: '旧项目', head: 3, members: {}, versions: [], shares: {}, revLog: [], activity: [], blobIndex: {}, blobBytes: 0, docBytes: 0, bytes: 0 };
  writeFileSync(metaFile, JSON.stringify(meta));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ format: 'xp-workspace@1', projects: { [pid]: { owner: 'u_1', head: 3 } }, shares: {} }));
  const { svc } = makeService({ dataDir: dir });
  const r = await call(svc, 'GET', `/workspace/projects/u_1/${pid}`, { key: 'k-a1' });
  assert.equal(r.res.status, 200);
  assert.equal(r.res.json().project.name, '旧项目');
  assert.equal(r.res.json().project.head, 3);
  // 迁移不写盘：原 index 仍是 v1、meta.json 未被删除/移动
  assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).format, 'xp-workspace@1');
  assert.ok(existsSync(metaFile));
  // 下一次写以 @2 提交，meta.json 仍保留
  const rn = await call(svc, 'POST', `/workspace/projects/u_1/${pid}/rename`, { key: 'k-a1', body: JSON.stringify({ name: '新名' }) });
  assert.equal(rn.res.status, 200);
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.format, 'xp-workspace@2');
  assert.equal(idx.projects[pid].name, '新名');
  assert.ok(existsSync(metaFile));
  // v1 残项读不到权威 meta → 按孤儿摘除，不影响其余索引
  const dir2 = tmpDir();
  const orphan = 'wp_00000000-0000-0000-0000-000000000002';
  writeFileSync(join(dir2, 'index.json'), JSON.stringify({ format: 'xp-workspace@1', projects: { [orphan]: { owner: 'u_1' } }, shares: {} }));
  const { svc: svc2 } = makeService({ dataDir: dir2 });
  assert.deepEqual((await call(svc2, 'GET', '/workspace/projects', { key: 'k-a1' })).res.json().projects, []);
  assert.equal((await call(svc2, 'GET', `/workspace/projects/u_1/${orphan}`, { key: 'k-a1' })).res.status, 404);
  // meta.json 存在但损坏 → storage_corrupt，不静默丢项目
  const dir3 = tmpDir();
  const broken = 'wp_00000000-0000-0000-0000-000000000003';
  mkdirSync(join(dir3, 'projects', broken), { recursive: true });
  writeFileSync(join(dir3, 'projects', broken, 'meta.json'), '{broken');
  writeFileSync(join(dir3, 'index.json'), JSON.stringify({ format: 'xp-workspace@1', projects: { [broken]: { owner: 'u_1' } }, shares: {} }));
  const { svc: svc3 } = makeService({ dataDir: dir3 });
  const bad = await call(svc3, 'GET', '/workspace/projects', { key: 'k-a1' });
  assert.equal(bad.res.status, 500);
  assert.equal(bad.res.json().error.code, 'storage_corrupt');
});

test('WS-5 写操作绕过身份缓存现场复核：上游吊销后写拒绝、旧项目不变', async () => {
  let revoked = false;
  const { svc } = makeService({ keys: k => (k === 'k-a1' && revoked ? null : KEYS[k] ?? null) });
  const p = await setupProject(svc, 'k-a1');                 // 首个 identity 成功并进入缓存
  revoked = true;                                           // 上游随后禁用/删除该 key（仍在 60s TTL 内）
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: ' revoked' }) });
  assert.equal(put.res.status, 401);
  assert.equal(put.res.json().error.code, 'key_rejected');  // 写项目拒绝：不能用缓存旧身份
  const share = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: '{"role":"viewer"}' });
  assert.equal(share.res.status, 401);                      // 建邀请同样拒绝
  const claim = await call(svc, 'POST', '/workspace/claim', { key: 'k-a1', body: JSON.stringify({ token: 'AbCdEfGhIjKlMnOpQrStUv' }) });
  assert.equal(claim.res.status, 401);
  // 上游明确 401 后缓存项作废——读也不再按 TTL 放行
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' })).res.status, 401);
  // 同账户仍有效的另一把 key 读回：旧项目 head 不变，没有任何写入生效
  const meta = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a2' });
  assert.equal(meta.res.status, 200);
  assert.equal(meta.res.json().project.head, 1);
});

test('WS-6 ?version= 版本 ID 优先；同名多版本 409 歧义；唯一名称兼容', async () => {
  const { svc } = makeService();
  const p = await setupProject(svc, 'k-a1');
  await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'V2' }) });
  const mkv = async (name, rev) => (await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/versions`, { key: 'k-a1', body: JSON.stringify({ name, rev }) })).res.json().version;
  const v1 = await mkv('定稿', 1);
  const v2 = await mkv('定稿', 2);
  const v3 = await mkv('别名', 2);
  // 同名 → 409 歧义（不静默取第一个），错误里给出候选版本 ID
  const amb = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?version=${encodeURIComponent('定稿')}`, { key: 'k-a1' });
  assert.equal(amb.res.status, 409);
  assert.equal(amb.res.json().error.code, 'version_ambiguous');
  assert.deepEqual(new Set(amb.res.json().error.matches), new Set([v1.id, v2.id]));
  // 版本 ID 精确命中
  const byId = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?version=${v1.id}`, { key: 'k-a1' });
  assert.equal(byId.res.status, 200);
  assert.equal(new Headers(byId.res.headers).get('x-workspace-rev'), '1');
  // 唯一名称仍兼容
  const byName = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?version=${encodeURIComponent('别名')}`, { key: 'k-a1' });
  assert.equal(byName.res.status, 200);
  assert.equal(new Headers(byName.res.headers).get('x-workspace-rev'), '2');
  // 名称撞他人版本 ID → ID 优先
  assert.equal((await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/versions`, { key: 'k-a1', body: JSON.stringify({ name: v3.id, rev: 1 }) })).res.status, 201);
  const prefer = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?version=${v3.id}`, { key: 'k-a1' });
  assert.equal(new Headers(prefer.res.headers).get('x-workspace-rev'), '2');   // 命中 v3（rev 2），不是同名新版本的 rev 1
});

test('WS-1 配额写满：如实报告用量与出路，历史修订与 blob 不自动清理、读与导出照常', async () => {
  const d = tmpDir();
  const s1 = makeService({ dataDir: d });
  const p = await setupProject(s1.svc, 'k-a1');
  const used = (await call(s1.svc, 'GET', '/workspace/projects', { key: 'k-a1' })).res.json().projects[0].bytes;
  // 收紧上限：现用量 + 1KiB，下一次推送（>4KiB 新媒体）必然 507
  const s2 = makeService({ dataDir: d, limits: { maxAccountBytes: used + 1024 } });
  const BIG = Uint8Array.from([...PNG, ...new Array(8 * 1024).fill(3)]);
  const put = await call(s2.svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ media: [{ path: 'media/a_2.png', assetId: 'a_2', name: 'p.png', kind: 'image', mime: 'image/png', data: BIG }] }) });
  assert.equal(put.res.status, 507);
  const err = put.res.json().error;
  assert.equal(err.code, 'quota_exceeded');
  assert.equal(err.limitBytes, used + 1024);
  assert.ok(err.usedBytes >= used && err.neededBytes > 0);
  assert.match(err.message, /仍可正常读取/);   // 明确「可读取可导出/联系扩容」的可操作提示
  assert.match(err.message, /扩容|本地导出/);
  assert.match(err.message, /不会自动删除/);
  // 未授权的数据清理不存在：quotaCheck 在暂存之前执行，连暂存文件都不产生
  assert.ok(existsSync(join(d, 'projects', p.id, 'rev', '1.json')));
  assert.ok(!existsSync(join(d, 'projects', p.id, 'rev', '2.json')));
  // 读与导出照常可用
  assert.equal((await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' })).res.status, 200);
  assert.equal((await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-a1' })).res.status, 200);
});

test('WS-2 CSP：导演台文档只允许对侧画布源嵌入；父页 frame-src 只放行对侧导演台源', async t => {
  const { svc } = makeService();
  const port = await httpServer(t, svc);
  // 真实嵌入路径：父页在 127.0.0.1，iframe 请求 localhost 上的导演台文档 → 祖先只许 127.0.0.1
  const d1 = await hreq(port, 'GET', '/director/index.html', { headers: { Host: `localhost:${port}` } });
  assert.equal(d1.status, 200);
  assert.deepEqual(cspList(d1, 'frame-ancestors'), [`http://127.0.0.1:${port}`]);
  // 反向：127.0.0.1 上的导演台文档 → 只许 localhost 画布源（同源嵌入路径被封死）
  const d2 = await hreq(port, 'GET', '/director/index.html');
  assert.equal(d2.status, 200);
  assert.deepEqual(cspList(d2, 'frame-ancestors'), [`http://localhost:${port}`]);
  for (const d of [d1, d2]) {
    assert.ok(!cspList(d, 'frame-ancestors').includes("'self'"), '导演台文档不得被本源页面嵌入');
    assert.ok(cspList(d, 'frame-src').includes("'self'"), '插件内部子帧能力保持');
  }
  // 父页：frame-src 只含对侧源 + blob:，不再含 'self'/本源
  const home = await hreq(port, 'GET', '/');
  assert.equal(home.status, 200);
  assert.deepEqual(new Set(cspList(home, 'frame-src')), new Set([`http://localhost:${port}`, 'blob:']));
  assert.ok(cspList(home, 'frame-ancestors').includes("'self'"), '父页自身祖先策略不变');
});

test('WS-7 HEAD 不写出正文：keep-alive 连接上 HEAD 后再发 GET 仍可正常解析', async t => {
  const { svc } = makeService();
  const p = await setupProject(svc, 'k-a1');
  const port = await httpServer(t, svc);
  // Node 的 ServerResponse 对 HEAD 自动抑制正文——本测试验证该行为在 /workspace 链路上成立：
  // 若有正文漏出，同一 socket 上的下一个响应将无法解析，第二请求会报错而非 200。
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const h = await hreq(port, 'HEAD', `/workspace/projects/${p.owner}/${p.id}`, { agent });
    assert.equal(h.status, 200);
    assert.equal(h.body.length, 0);
    const g = await hreq(port, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { agent });
    assert.equal(g.status, 200);
    assert.equal(JSON.parse(g.body.toString('utf8')).project.head, 1);
  } finally { agent.destroy(); }
});
