// workspace-service 单元测试：node --test。全部使用注入 upstreamFetch 的假身份（两个稳定 subject、
// 多个 key、轮换同 subject），不打生产网络；数据目录一律 mkdtemp 临时目录，测试结束只清理自己创建的目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createWorkspaceService, WORKSPACE_IDENTITY_URL } from './workspace-service.mjs';
import { zipStore, parseProjectPackage } from '../src/export-project.js';

const enc = new TextEncoder();
const NOW = 1_700_000_000_000;
const createdDirs = [];
function tmpDir() { const d = mkdtempSync(join(tmpdir(), 'ws-svc-')); createdDirs.push(d); return d; }
process.on('exit', () => { for (const d of createdDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 只清理本测试创建的目录 */ } } });

const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(24).fill(0)]);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, ...new Array(16).fill(0)]);

function makePackage({ name = '测试项目', media = [], projectMutate } = {}) {
  // manifest.media[*] 必须与 project.assets[assetId] 精确一致（服务端逐条核对）；
  // file 类素材自动补一个引用节点（未引用的二进制会被服务端拒绝）
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

// keys: {key: {subject, name} | 'redirect' | 'down'} —— k-a1/k-a2 同属 u_1（轮换不变身份），k-b1 属 u_2
function makeService({ keys = {}, limits = {}, now = () => NOW, dataDir, hooks } = {}) {
  const dir = dataDir ?? tmpDir();
  const upstreamCalls = [];
  const upstreamFetch = async (url, opts = {}) => {
    upstreamCalls.push({ url: String(url), opts });
    const key = /^Bearer (.+)$/.exec(opts?.headers?.Authorization ?? '')?.[1] ?? '';
    const entry = keys[key];
    if (entry === 'redirect') return resp(302, {});
    if (entry === 'down') return resp(404, { code: false });
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
const KEYS = { 'k-a1': { subject: 'u_1', name: '甲' }, 'k-a2': { subject: 'u_1' }, 'k-b1': { subject: 'u_2', name: '乙' }, 'k-c1': { subject: 'u_3', name: '丙' }, 'k-redir': 'redirect', 'k-down': 'down' };

async function setupProject(svc, key = 'k-a1', name = 'P1') {
  const c = await call(svc, 'POST', '/workspace/projects', { key, body: JSON.stringify({ name }) });
  assert.equal(c.res.status, 201);
  const proj = c.res.json().project;
  const put = await call(svc, 'PUT', `/workspace/projects/${proj.owner}/${proj.id}`, { key, headers: { 'if-match': 'r0' }, body: makePackage({ name }) });
  assert.equal(put.res.status, 201);
  return { ...proj, head: put.res.json().head };
}

test('身份：固定上游地址 + 只带 Authorization/Accept；缺 key/坏 key/过期 key/重定向/未部署', async () => {
  const { svc, upstreamCalls } = makeService({ keys: KEYS });
  assert.equal((await call(svc, 'GET', '/workspace/projects')).res.status, 401);                    // 无证明
  assert.equal((await call(svc, 'GET', '/workspace/projects', { key: 'bad' })).res.status, 401);     // 坏 key（上游 401，含"过期/禁用"类失败证明）
  const redir = await call(svc, 'GET', '/workspace/projects', { key: 'k-redir' });
  assert.equal(redir.res.status, 502); assert.equal(redir.res.json().error.code, 'redirect_blocked'); // 重定向不跟随
  const down = await call(svc, 'GET', '/workspace/projects', { key: 'k-down' });
  assert.equal(down.res.status, 503); assert.equal(down.res.json().error.code, 'identity_unavailable'); // 未部署如实上报
  const ok = await call(svc, 'GET', '/workspace/identity', { key: 'k-a1' });
  assert.equal(ok.res.json().subject, 'u_1');
  assert.equal(upstreamCalls[0].url, WORKSPACE_IDENTITY_URL);
  assert.deepEqual(Object.keys(upstreamCalls[0].opts.headers).sort(), ['Accept', 'Authorization']);   // 不透传 Cookie/其他头
});

test('两用户 + 密钥轮换：subject 稳定，非成员连 UUID 也读不到', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc, 'k-a1');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);   // u_2 不知内容
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-b1' })).res.status, 404);
  const rot = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a2' });                        // 轮换 key → 同 subject → 照常
  assert.equal(rot.res.status, 200); assert.equal(rot.res.json().project.role, 'owner');
});

test('共享邀请：viewer 可读不可写、重复兑换、他人兑换 409、owner 撤销', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  const share = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer', expiresInHours: 24 }) });
  assert.equal(share.res.status, 201);
  const token = /ws-claim=([A-Za-z0-9_-]+)/.exec(share.res.json().invite.fragment)[1];
  // 兑换前 B 无权
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);
  const c1 = await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token }) });
  assert.equal(c1.res.status, 200); assert.equal(c1.res.json().role, 'viewer');
  const c2 = await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token }) });
  assert.equal(c2.res.status, 200); assert.equal(c2.res.json().already, true);                                    // 同人重复兑换幂等
  const c3 = await call(svc, 'POST', '/workspace/claim', { key: 'k-a2', body: JSON.stringify({ token }) });
  assert.equal(c3.res.status, 200); assert.equal(c3.res.json().already, true);                                     // owner 角色已满足 → 幂等 already（语义一致化）
  const c4 = await call(svc, 'POST', '/workspace/claim', { key: 'k-c1', body: JSON.stringify({ token }) });
  assert.equal(c4.res.status, 409); assert.equal(c4.res.json().error.code, 'invite_already_claimed');              // 第三人兑已消耗令牌 → 409
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-b1' })).res.status, 200);
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({}) });
  assert.equal(put.res.status, 403); assert.equal(put.res.json().error.code, 'role_required');                     // viewer 直接 PUT 也写不进
  const mem = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' });
  assert.equal(mem.res.json().members[0].subject, 'u_2');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-b1' })).res.status, 403); // 非 owner 不可列成员
  await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1' });
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);   // 撤销即失效
});

test('邀请过期与撤销；editor 邀请可写', async () => {
  let t = NOW;
  const { svc } = makeService({ keys: KEYS, now: () => t });
  const p = await setupProject(svc);
  const mk = async role => /ws-claim=([A-Za-z0-9_-]+)/.exec((await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role, expiresInHours: 1 }) })).res.json().invite.fragment)[1];
  const exp = await mk('viewer');
  t += 2 * 3600_000;
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: exp }) })).res.status, 410);
  const ed = await mk('editor');
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: ed }) })).res.json().role, 'editor');
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'B改' }) });
  assert.equal(put.res.status, 201);   // editor 可写
  const s = (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' })).res.json().shares.find(x => x.claimed);
  assert.ok(s);
  // 撤销未兑换邀请
  const free = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) });
  await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${free.res.json().share.id}`, { key: 'k-a1' });
  const tk = /ws-claim=([A-Za-z0-9_-]+)/.exec(free.res.json().invite.fragment)[1];
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: tk }) })).res.status, 404);
});

test('限定 owner 命名空间：项目 ID 替换/跨命名空间一律 404', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  assert.equal((await call(svc, 'GET', `/workspace/projects/u_2/${p.id}`, { key: 'k-a1' })).res.status, 404);       // 正确 pid + 错误 owner
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/wp_00000000-0000-0000-0000-000000000000`, { key: 'k-a1' })).res.status, 404);
  const put = await call(svc, 'PUT', `/workspace/projects/u_2/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r0' }, body: makePackage({}) });
  assert.equal(put.res.status, 404);
});

test('乐观并发：过期基线 409（带 head/base），双写只有一方胜出', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  const stale = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r0' }, body: makePackage({}) });
  assert.equal(stale.res.status, 409);
  const err = stale.res.json().error;
  assert.equal(err.code, 'revision_conflict'); assert.equal(err.head, 1); assert.equal(err.base, 0);              // 无 last-writer-wins
  const [w1, w2] = await Promise.all([
    call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'W1' }) }),
    call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'W2' }) }),
  ]);
  assert.deepEqual([w1.res.status, w2.res.status].sort(), [201, 409]);                                            // 恰好一方胜出
  const meta = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' });
  assert.equal(meta.res.json().project.head, 2);
  const nm = (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-a1' })).res.body();
  assert.ok(nm.includes('W1') || nm.includes('W2'));
  assert.ok(!(nm.includes('W1') && nm.includes('W2')));
});

test('缺 If-Match 428；ETag 轮询 304', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  assert.equal((await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', body: makePackage({}) })).res.status, 428);
  const m1 = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' });
  const et = m1.res.headers.ETag ?? m1.res.headers.etag;
  assert.equal(et, '"r1"');
  const m2 = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-none-match': et } });
  assert.equal(m2.res.status, 304);
});

test('重启持久化：新实例同 dataDir 可读回同修订与包', async () => {
  const keys = KEYS;
  const d = tmpDir();
  const s1 = makeService({ keys, dataDir: d });
  const p = await setupProject(s1.svc, 'k-a1', '持久化');
  const s2 = makeService({ keys, dataDir: d });   // 模拟重启
  const meta = await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a2' });
  assert.equal(meta.res.status, 200); assert.equal(meta.res.json().project.head, 1);
  const pkg = await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-a2' });
  assert.equal(pkg.res.status, 200);
  assert.ok(pkg.res.body().includes('持久化'));
});

test('磁盘失败不留半个项目', async () => {
  const blocker = join(tmpDir(), 'blocker');
  writeFileSync(blocker, 'x');                                  // dataDir 落在文件里 → mkdir 必然失败
  const { svc } = makeService({ keys: KEYS, dataDir: join(blocker, 'sub') });
  const c = await call(svc, 'POST', '/workspace/projects', { key: 'k-a1', body: JSON.stringify({ name: 'X' }) });
  assert.equal(c.res.status, 500);
  assert.ok(statSync(blocker).isFile());
  assert.ok(!existsSync(join(blocker, 'sub')));                 // 无半成品目录/索引
  const good = makeService({ keys: KEYS });
  assert.equal((await call(good.svc, 'GET', '/workspace/projects', { key: 'k-a1' })).res.json().projects.length, 0);
});

test('密钥字段负载拒绝 + 包/MIME 篡改拒绝', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  const put = (body, h = { 'if-match': 'r1' }) => call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: h, body });
  const secret = makePackage({ projectMutate: d => { d.project.apiKey = 'sk-xxx'; } });
  assert.equal((await put(secret)).res.json().error.code, 'secret_rejected');
  const badMime = makePackage({ media: [{ path: 'media/a_1.png', mime: 'image/png', data: enc.encode('not a png') }] });
  assert.equal((await put(badMime)).res.json().error.code, 'media_mime_mismatch');
  const badSize = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'xp-package@1', version: 1, timeline: { clips: [] }, media: [{ path: 'media/a_1.png', assetId: 'a_1', name: 'x', kind: 'image', mime: 'image/png', size: 999 }] })) },
    { name: 'project.json', data: enc.encode(JSON.stringify({ format: 'xingpan-canvas@2', project: { name: 't', nodes: [], edges: [], assets: {} } })) },
    { name: 'media/a_1.png', data: PNG },
  ]);
  assert.equal((await put(badSize)).res.json().error.code, 'media_tampered');
  assert.equal((await put(enc.encode('hello world'))).res.json().error.code, 'invalid_package');                 // 任意文本不是包
  const stray = zipStore([{ name: 'manifest.json', data: enc.encode('{}') }, { name: 'x.png', data: PNG }]);
  assert.equal((await put(stray)).res.json().error.code, 'invalid_package');                                     // 缺 project.json
  const extra = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'xp-package@1', version: 1, timeline: { clips: [] }, media: [] })) },
    { name: 'project.json', data: enc.encode(JSON.stringify({ format: 'xingpan-canvas@2', project: { name: 't', nodes: [], edges: [], assets: {} } })) },
    { name: 'media/evil.png', data: PNG },
  ]);
  assert.equal((await put(extra)).res.json().error.code, 'unexpected_entry');                                    // 未声明文件
  const okMedia = makePackage({ media: [{ path: 'media/a_1.mp4', mime: 'video/mp4', kind: 'video', data: MP4 }] });
  assert.equal((await put(okMedia)).res.status, 201);
});

test('配额上限：项目数 / 包体大小 / 成员设置权限', async () => {
  const { svc } = makeService({ keys: KEYS, limits: { maxProjectsPerSubject: 1, maxPackageBytes: 1024 } });
  const p = await setupProject(svc);
  const second = await call(svc, 'POST', '/workspace/projects', { key: 'k-a1', body: JSON.stringify({ name: 'P2' }) });
  assert.equal(second.res.status, 429); assert.equal(second.res.json().error.code, 'quota_exceeded');
  const big = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ media: [{ path: 'media/a_1.png', mime: 'image/png', data: Uint8Array.from([...PNG, ...new Array(4096).fill(1)]) }] }) });
  assert.equal(big.res.status, 413);
  // owner 可设成员，成员无权设成员（不可自助提权）
  const s1 = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'editor' }) });
  assert.equal(s1.res.status, 200);
  const s2 = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-b1', body: JSON.stringify({ role: 'owner' }) });
  assert.equal(s2.res.status, 400);   // 先被 role 校验拦住
  const s3 = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_1`, { key: 'k-b1', body: JSON.stringify({ role: 'viewer' }) });
  assert.equal(s3.res.status, 403);   // 非 owner 一律拒
});

test('命名版本 / 修订列表 / 分叉复用 blob', async () => {
  const { svc, dir } = makeService({ keys: KEYS });
  const p = await setupProject(svc, 'k-a1', 'V', );
  await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'V2', media: [{ path: 'media/a_1.mp4', mime: 'video/mp4', kind: 'video', data: MP4 }] }) });
  const v = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/versions`, { key: 'k-a1', body: JSON.stringify({ name: '定稿', rev: 2 }) });
  assert.equal(v.res.status, 201);
  const revs = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/revisions`, { key: 'k-a1' });
  assert.equal(revs.res.json().head, 2); assert.equal(revs.res.json().versions[0].name, '定稿');
  const pkg = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?version=${v.res.json().version.id}`, { key: 'k-a1' });
  assert.equal(new Headers(pkg.res.headers).get('x-workspace-rev'), '2'); assert.ok(pkg.res.body().includes('V2'));
  const fk = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/fork`, { key: 'k-b1', body: JSON.stringify({}) });
  assert.equal(fk.res.status, 404);                                   // 非成员不可分叉
  const share = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) });
  const tk = /ws-claim=([A-Za-z0-9_-]+)/.exec(share.res.json().invite.fragment)[1];
  await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: tk }) });
  const fk2 = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/fork`, { key: 'k-b1', body: JSON.stringify({ rev: 2 }) });
  assert.equal(fk2.res.status, 201);
  const blobDir = join(dir, 'blobs');
  assert.equal(readdirSync(blobDir).length, 1);                       // 同一视频只存一份
  const list = await call(svc, 'GET', '/workspace/projects', { key: 'k-b1' });
  assert.equal(list.res.json().projects.length, 2);                   // 共享项目 + 自己的分叉
});

test('presence 心跳：成员互相可见在线与编辑提示', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) });
  const b = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/presence`, { key: 'k-b1', body: JSON.stringify({ clientId: 'c1', editing: false }) });
  assert.equal(b.res.status, 200);
  const a = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/presence`, { key: 'k-a1', body: JSON.stringify({ clientId: 'c2', editing: true }) });
  const peers = a.res.json().peers;
  assert.equal(peers.length, 2);
  assert.ok(peers.some(x => x.subject === 'u_1' && x.editing));
  assert.equal((await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/presence`, { key: 'k-x', body: JSON.stringify({ clientId: 'c3' }) })).res.status, 401);
});

test('owner 的 Key 不出现在任何落盘文件或响应中', async () => {
  const { svc, dir } = makeService({ keys: KEYS });
  const p = await setupProject(svc, 'k-a1');
  await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) });
  await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) });
  const dump = [];
  const walk = d => { for (const f of readdirSync(d, { withFileTypes: true })) { const fp = join(d, f.name); f.isDirectory() ? walk(fp) : dump.push(readFileSync(fp)); } };
  walk(dir);
  const all = Buffer.concat(dump).toString('utf8');
  for (const k of ['k-a1', 'k-a2', 'k-b1', 'Bearer']) assert.ok(!all.includes(k), `落盘数据不得包含 ${k}`);
  const list = await call(svc, 'GET', '/workspace/projects', { key: 'k-a1' });
  assert.ok(!list.res.body().toString('utf8').includes('k-a1'));
});

test('导演台二进制素材：GLB 随包备份并按字节取回；gltf 外部 URI 与未引用文件拒绝', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  // 合法 GLB：magic 'glTF' + version=2 + 头部长度一致 + 一个 JSON chunk
  const jraw = enc.encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [] }));
  const pad = (4 - (jraw.length % 4)) % 4;
  const jchunk = Uint8Array.from([...jraw, ...new Array(pad).fill(0x20)]);
  const GLB = new Uint8Array(12 + 8 + jchunk.length);
  GLB.set([0x67, 0x6C, 0x54, 0x46, 2, 0, 0, 0]);
  const dv = new DataView(GLB.buffer);
  dv.setUint32(8, GLB.length, true); dv.setUint32(12, jchunk.length, true); dv.setUint32(16, 0x4E4F534A, true);
  GLB.set(jchunk, 20);
  let head = 1;
  const put = body => call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': `r${head}` }, body });
  const okPkg = makePackage({
    media: [{ path: 'media/a_glb.glb', assetId: 'a_glb', name: 'scene.glb', kind: 'file', mime: 'model/gltf-binary', data: GLB }],
    projectMutate: d => { d.director = { 'dir:n_a_glb:scene': { url: 'xp-asset://a_glb' } }; },
  });
  const r1 = await put(okPkg);
  assert.equal(r1.res.status, 201); head += 1;
  // 重新打开：取回的包与原字节完全一致（导演台 GLB 完整备份）
  const back = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package`, { key: 'k-a1' });
  assert.equal(back.res.status, 200);
  const { files } = parseProjectPackage(back.res.body());
  assert.deepEqual([...files.get('media/a_glb.glb')], [...GLB]);
  // 嵌入 gltf（data: URI 缓冲）合法
  const gltf = enc.encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAE=', byteLength: 2 }] }));
  const okGltf = makePackage({
    media: [{ path: 'media/a_g2.gltf', assetId: 'a_g2', name: 'm.gltf', kind: 'file', mime: 'model/gltf+json', data: gltf }],
  });
  assert.equal((await put(okGltf)).res.status, 201); head += 1;
  // 外部 URI 的 gltf：绝不接受（服务端不会去抓取外部资源）
  const extGltf = enc.encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://evil.example/x.bin', byteLength: 4 }] }));
  const badGltf = makePackage({
    media: [{ path: 'media/a_g3.gltf', assetId: 'a_g3', name: 'x.gltf', kind: 'file', mime: 'model/gltf+json', data: extGltf }],
  });
  assert.equal((await put(badGltf)).res.json().error.code, 'media_mime_mismatch');
  // 未引用 file：只挂了素材记录不算项目内容 → 拒绝
  const unref = makePackage({
    media: [{ path: 'media/a_b.bin', assetId: 'a_b', name: 'b.bin', kind: 'file', mime: 'application/octet-stream', data: Uint8Array.from([1, 2, 3, 4]) }],
    projectMutate: d => { d.project.nodes = []; },
  });
  assert.equal((await put(unref)).res.json().error.code, 'file_unreferenced');
  // 清单与项目素材记录不一致 → 拒绝
  const mismatch = makePackage({
    media: [{ path: 'media/a_glb.glb', assetId: 'a_glb', name: '别的名字.glb', kind: 'file', mime: 'model/gltf-binary', data: GLB }],
    projectMutate: d => { d.project.assets.a_glb.name = '原始名字.glb'; d.director = { 'dir:n_a_glb:scene': { url: 'xp-asset://a_glb' } }; },
  });
  assert.equal((await put(mismatch)).res.json().error.code, 'asset_mismatch');
  // 坏 GLB 魔数
  const badGlb = Uint8Array.from(GLB); badGlb[0] = 0x00;
  const badGlbPkg = makePackage({
    media: [{ path: 'media/a_g4.glb', assetId: 'a_g4', name: 'bad.glb', kind: 'file', mime: 'model/gltf-binary', data: badGlb }],
  });
  assert.equal((await put(badGlbPkg)).res.json().error.code, 'media_mime_mismatch');
});

test('配额归属 owner：成员推送按所有者计；分叉受项目数/全局/账户配额约束', async () => {
  const d = tmpDir();
  const s1 = makeService({ keys: KEYS, dataDir: d });
  const BIG = Uint8Array.from([...MP4, ...new Array(64 * 1024).fill(0)]);
  const c = await call(s1.svc, 'POST', '/workspace/projects', { key: 'k-a1', body: JSON.stringify({ name: 'Q' }) });
  const proj = c.res.json().project;
  assert.equal((await call(s1.svc, 'PUT', `/workspace/projects/${proj.owner}/${proj.id}`, { key: 'k-a1', headers: { 'if-match': 'r0' }, body: makePackage({ media: [{ path: 'media/a_1.mp4', assetId: 'a_1', name: 'v.mp4', kind: 'video', mime: 'video/mp4', data: BIG }] }) })).res.status, 201);
  await call(s1.svc, 'PUT', `/workspace/projects/${proj.owner}/${proj.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'editor' }) });
  const ownerBytes = (await call(s1.svc, 'GET', '/workspace/projects', { key: 'k-a1' })).res.json().projects[0].bytes;
  // 重启 + 收紧：上限 = owner 现用量 + 4K。u_2 推 ~6K 新媒体（不同哈希不走 dedup）：
  // 若按编辑者(u_2 用量 0)计会通过；按 owner(u_1)计必然 507 —— 证明配额归属所有者
  const s2 = makeService({ keys: KEYS, dataDir: d, limits: { maxAccountBytes: ownerBytes + 4096 } });
  const PNG2 = Uint8Array.from([...PNG, ...new Array(6 * 1024).fill(7)]);
  const put = await call(s2.svc, 'PUT', `/workspace/projects/${proj.owner}/${proj.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({ media: [{ path: 'media/a_2.png', assetId: 'a_2', name: 'p.png', kind: 'image', mime: 'image/png', data: PNG2 }] }) });
  assert.equal(put.res.status, 507); assert.equal(put.res.json().error.code, 'quota_exceeded');
  // 分叉：账户字节（新 owner=u_2 承担整包字节）
  const s3 = makeService({ keys: KEYS, dataDir: d, limits: { maxAccountBytes: ownerBytes - 1 } });
  assert.equal((await call(s3.svc, 'POST', `/workspace/projects/${proj.owner}/${proj.id}/fork`, { key: 'k-b1', body: '{}' })).res.status, 507);
  // 分叉：全局项目数 / 全局字节
  const s4 = makeService({ keys: KEYS, dataDir: d, limits: { maxProjectsGlobal: 1 } });
  assert.equal((await call(s4.svc, 'POST', `/workspace/projects/${proj.owner}/${proj.id}/fork`, { key: 'k-b1', body: '{}' })).res.status, 507);
  const s5 = makeService({ keys: KEYS, dataDir: d, limits: { maxTotalBytes: 1 } });
  assert.equal((await call(s5.svc, 'POST', `/workspace/projects/${proj.owner}/${proj.id}/fork`, { key: 'k-b1', body: '{}' })).res.status, 507);
});

test('邀请语义：viewer→editor 升级；消耗令牌不重授权；撤销联动移除成员；成员上限', async () => {
  const { svc } = makeService({ keys: KEYS });
  const p = await setupProject(svc);
  const mk = async role => /ws-claim=([A-Za-z0-9_-]+)/.exec((await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role }) })).res.json().invite.fragment)[1];
  const tv = await mk('viewer'); const te = await mk('editor');
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: tv }) })).res.json().role, 'viewer');
  assert.equal((await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({}) })).res.status, 403);
  // 既有 viewer 兑 editor 邀请 → 升级（旧代码只 if(!mine) 不会升）
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: te }) })).res.json().role, 'editor');
  assert.equal((await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({ name: 'B' }) })).res.status, 201);
  // owner 兑他人已消耗令牌：角色已满足 → 幂等 already（一致的 200 语义，不消耗/不重授权）
  const oc = await call(svc, 'POST', '/workspace/claim', { key: 'k-a1', body: JSON.stringify({ token: te }) });
  assert.equal(oc.res.status, 200); assert.equal(oc.res.json().already, true);
  // 直接移除成员（邀请本身未撤）→ 再兑同令牌：已消耗不自动重授权
  await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1' });
  const re = await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: te }) });
  assert.equal(re.res.status, 409); assert.equal(re.res.json().error.code, 'invite_consumed');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);
  // 撤销已兑换邀请 → 联动移除经该邀请加入的成员；状态字段准确
  const tv2 = await mk('viewer');
  await call(svc, 'POST', '/workspace/claim', { key: 'k-c1', body: JSON.stringify({ token: tv2 }) });
  const claimed = (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' })).res.json().shares.find(s => s.claimedBy === 'u_3');
  const rv = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${claimed.id}`, { key: 'k-a1' });
  assert.equal(rv.res.json().memberRemoved, 'u_3');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-c1' })).res.status, 404);
  const sh2 = (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' })).res.json().shares.find(s => s.id === claimed.id);
  assert.equal(sh2.revoked, true); assert.equal(sh2.memberRemoved, true);
  // 成员上限同样约束兑换路径
  const svc2 = makeService({ keys: KEYS, limits: { maxMembers: 1 } });
  const p2 = await setupProject(svc2.svc);
  const mk2 = async () => /ws-claim=([A-Za-z0-9_-]+)/.exec((await call(svc2.svc, 'POST', `/workspace/projects/${p2.owner}/${p2.id}/shares`, { key: 'k-a1', body: '{}' })).res.json().invite.fragment)[1];
  assert.equal((await call(svc2.svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: await mk2() }) })).res.status, 200);
  const over = await call(svc2.svc, 'POST', '/workspace/claim', { key: 'k-c1', body: JSON.stringify({ token: await mk2() }) });
  assert.equal(over.res.status, 429); assert.equal(over.res.json().error.code, 'quota_exceeded');
});

test('提交点故障注入：index 写失败不产生半个可见更新（同实例与重启两条读路径）', async () => {
  let fail = true;
  const d = tmpDir();
  const s1 = makeService({ keys: KEYS, dataDir: d, hooks: { onCommit: async () => { if (fail) throw new Error('injected commit failure'); } } });
  assert.equal((await call(s1.svc, 'POST', '/workspace/projects', { key: 'k-a1', body: JSON.stringify({ name: 'X' }) })).res.status, 500);
  fail = false;
  const p = await setupProject(s1.svc, 'k-a1');
  fail = true;
  const r = await call(s1.svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: '半截' }) });
  assert.equal(r.res.status, 500);
  // rev 文件已暂存但不可达；ACL 变更同样被回滚
  assert.ok(existsSync(join(d, 'projects', p.id, 'rev', '2.json')));
  assert.equal((await call(s1.svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'editor' }) })).res.status, 500);
  fail = false;
  // 同实例读路径
  assert.equal((await call(s1.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' })).res.json().project.head, 1);
  // 重启实例读路径：同一权威 index —— head/ACL 均未前进
  const s2 = makeService({ keys: KEYS, dataDir: d });
  assert.equal((await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1' })).res.json().project.head, 1);
  assert.equal((await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/package?rev=2`, { key: 'k-a1' })).res.status, 404);   // 暂存修订不可达
  assert.equal((await call(s2.svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);              // 成员未生效
  // 恢复后重试正常
  assert.equal((await call(s1.svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-a1', headers: { 'if-match': 'r1' }, body: makePackage({ name: '完整' }) })).res.status, 201);
});

test('孤儿 meta.json 不可服务：索引无条目一律 404', async () => {
  const { svc, dir } = makeService({ keys: KEYS });
  const pid = 'wp_00000000-0000-0000-0000-000000000000';
  mkdirSync(join(dir, 'projects', pid), { recursive: true });
  writeFileSync(join(dir, 'projects', pid, 'meta.json'), JSON.stringify({ format: 'xp-workspace@1', id: pid, owner: 'u_1', name: '孤儿', head: 5, members: {}, versions: [], shares: {}, revLog: [], activity: [], blobIndex: {}, blobBytes: 0, docBytes: 0, bytes: 0 }));
  assert.equal((await call(svc, 'GET', `/workspace/projects/u_1/${pid}`, { key: 'k-a1' })).res.status, 404);
});

test('身份验证有界：超时→503；超大响应→502', async () => {
  const slow = createWorkspaceService({
    dataDir: tmpDir(), limits: { identityFetchTimeoutMs: 20 },
    upstreamFetch: (u, o) => new Promise((_, rej) => { o?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); }),
  });
  assert.equal((await call(slow, 'GET', '/workspace/projects', { key: 'k-a1' })).res.status, 503);
  const big = createWorkspaceService({
    dataDir: tmpDir(), limits: { identityMaxResponseBytes: 16 },
    upstreamFetch: async () => resp(200, { success: true, data: { subject: 'u_1', display_name: 'x'.repeat(200) } }),
  });
  const r2 = await call(big, 'GET', '/workspace/projects', { key: 'k-a1' });
  assert.equal(r2.res.status, 502); assert.equal(r2.res.json().error.code, 'identity_bad_response');
});
