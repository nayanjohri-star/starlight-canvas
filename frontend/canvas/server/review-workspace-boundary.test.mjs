// 审查修复回归测试（server 侧边界）：node --test。
// 覆盖：邀请 ACL 授权来源追踪——viewer S1 + editor S2 双顺序撤销（撤谁只影响谁）、
// direct 明确管理员授权优先且不受邀请撤销影响、旧成员记录（无 grants 字段）按 via 派生兼容；
// 以及画布父页 frame-ancestors 收紧为仅 'self'（导演台隔离源不可反向嵌入父页，
// 父页 iframe 嵌入导演台路径不受影响——由导演台文档自身 frame-ancestors 放行）。
// 全部注入假身份与临时目录，不打生产网络；CSP 用真实本地监听验证。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { createWorkspaceService } from './workspace-service.mjs';
import { createCanvasServer } from './app.mjs';
import { zipStore } from '../src/export-project.js';

const enc = new TextEncoder();
const NOW = 1_700_000_000_000;
const createdDirs = [];
function tmpDir() { const d = mkdtempSync(join(tmpdir(), 'ws-boundary-')); createdDirs.push(d); return d; }
process.on('exit', () => { for (const d of createdDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 只清理本测试创建的目录 */ } } });

function makePackage({ name = '测试项目' } = {}) {
  const doc = { format: 'xingpan-canvas@2', exportedAt: '2026-01-01T00:00:00Z', project: { name, nodes: [], edges: [], assets: {} }, tasks: [], pending: [], director: {} };
  const manifest = { format: 'xp-package@1', version: 1, exportedAt: '2026-01-01T00:00:00Z', timeline: { clips: [], meta: { version: 1, width: 1280, height: 720, fps: 30 } }, media: [] };
  return zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    { name: 'project.json', data: enc.encode(JSON.stringify(doc)) },
  ]);
}

function resp(status, body) {
  const text = JSON.stringify(body);
  return { status, headers: { get: () => null }, body: { cancel() {} }, json: async () => body, text: async () => text, arrayBuffer: async () => enc.encode(text).buffer };
}

const KEYS = { 'k-a1': { subject: 'u_1', name: '甲' }, 'k-a2': { subject: 'u_1' }, 'k-b1': { subject: 'u_2', name: '乙' }, 'k-c1': { subject: 'u_3', name: '丙' } };
function makeService({ keys = KEYS, limits = {}, now = () => NOW, dataDir, hooks } = {}) {
  const dir = dataDir ?? tmpDir();
  const upstreamFetch = async (url, opts = {}) => {
    const key = /^Bearer (.+)$/.exec(opts?.headers?.Authorization ?? '')?.[1] ?? '';
    const entry = keys[key];
    if (!entry) return resp(401, { code: false });
    return resp(200, { success: true, message: 'ok', data: { subject: entry.subject, display_name: entry.name ?? null } });
  };
  const svc = createWorkspaceService({ dataDir: dir, upstreamFetch, limits, clock: now, hooks });
  return { dir, svc };
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
async function mkShare(svc, p, role) {
  const r = await call(svc, 'POST', `/workspace/projects/${p.owner}/${p.id}/shares`, { key: 'k-a1', body: JSON.stringify({ role }) });
  assert.equal(r.res.status, 201);
  const j = r.res.json();
  return { sid: j.share.id, token: /ws-claim=([A-Za-z0-9_-]+)/.exec(j.invite.fragment)[1] };
}
const memberOf = async (svc, p, subject) =>
  (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' })).res.json().members.find(m => m.subject === subject);

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
function hreq(port, method, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Authorization: 'Bearer k-a1', ...headers } }, res => {
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

test('邀请 ACL 来源追踪：viewer S1 + editor S2，撤 S2 降级 viewer 不踢出，再撤 S1 才移除', async () => {
  const { svc } = makeService();
  const p = await setupProject(svc);
  const s1 = await mkShare(svc, p, 'viewer');
  const s2 = await mkShare(svc, p, 'editor');
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: s1.token }) })).res.json().role, 'viewer');
  assert.equal((await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: s2.token }) })).res.json().role, 'editor');
  // 两份授予分别入账
  const m0 = await memberOf(svc, p, 'u_2');
  assert.equal(m0.role, 'editor');
  assert.equal(m0.grants[`share:${s1.sid}`], 'viewer');
  assert.equal(m0.grants[`share:${s2.sid}`], 'editor');
  // 撤 S2：只回收 editor 来源 → 降级为 viewer，成员资格保留（修复前 via 停在 S1，撤 S2 完全无效）
  const rv2 = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s2.sid}`, { key: 'k-a1' });
  assert.equal(rv2.res.status, 200);
  assert.equal(rv2.res.json().memberRemoved, null);
  assert.deepEqual(rv2.res.json().memberUpdated, { subject: 'u_2', role: 'viewer' });
  const meta1 = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' });
  assert.equal(meta1.res.status, 200);
  assert.equal(meta1.res.json().project.role, 'viewer');
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({}) });
  assert.equal(put.res.status, 403);   // 有效角色 viewer：不可写
  const m1 = await memberOf(svc, p, 'u_2');
  assert.equal(m1.role, 'viewer');
  assert.deepEqual(Object.keys(m1.grants), [`share:${s1.sid}`]);
  // 再撤 S1：来源清空 → 成员才移除，share 上 memberRemoved 状态准确
  const rv1 = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s1.sid}`, { key: 'k-a1' });
  assert.equal(rv1.res.json().memberRemoved, 'u_2');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);
  const sh1 = (await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}/members`, { key: 'k-a1' })).res.json().shares.find(s => s.id === s1.sid);
  assert.equal(sh1.revoked, true); assert.equal(sh1.memberRemoved, true);
});

test('邀请 ACL 来源追踪：反序——撤 S1 后 S2 仍有效（editor 可写），再撤 S2 才移除', async () => {
  const { svc } = makeService();
  const p = await setupProject(svc);
  const s1 = await mkShare(svc, p, 'viewer');
  const s2 = await mkShare(svc, p, 'editor');
  await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: s1.token }) });
  await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: s2.token }) });
  // 先撤 S1（修复前 via=share:S1 会把仍持有效 S2 授权的成员整个踢出）
  const rv1 = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s1.sid}`, { key: 'k-a1' });
  assert.equal(rv1.res.status, 200);
  assert.equal(rv1.res.json().memberRemoved, null);
  assert.equal(rv1.res.json().memberUpdated, undefined);   // 有效角色不变
  const meta = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' });
  assert.equal(meta.res.status, 200);
  assert.equal(meta.res.json().project.role, 'editor');
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({ name: '仍可写' }) });
  assert.equal(put.res.status, 201);   // S2 授予仍有效——可写
  const rv2 = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s2.sid}`, { key: 'k-a1' });
  assert.equal(rv2.res.json().memberRemoved, 'u_2');
  assert.equal((await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' })).res.status, 404);
});

test('direct 明确管理员授权：优先于邀请来源且不受邀请撤销影响', async () => {
  const { svc } = makeService();
  const p = await setupProject(svc);
  const s1 = await mkShare(svc, p, 'editor');
  await call(svc, 'POST', '/workspace/claim', { key: 'k-b1', body: JSON.stringify({ token: s1.token }) });
  // 管理员显式设为 viewer → direct 优先：有效角色立即 viewer，不被残留的 editor 邀请授予抬权
  assert.equal((await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_2`, { key: 'k-a1', body: JSON.stringify({ role: 'viewer' }) })).res.status, 200);
  const m = await memberOf(svc, p, 'u_2');
  assert.equal(m.role, 'viewer');
  assert.equal(m.via, 'direct');
  assert.equal(m.grants[`share:${s1.sid}`], 'editor');   // 邀请来源仍记录，但被 direct 压制
  assert.equal(m.grants.direct, 'viewer');
  const put = await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1', headers: { 'if-match': 'r1' }, body: makePackage({}) });
  assert.equal(put.res.status, 403);
  // 撤销该邀请 → direct 授予独立存在 → 成员保留且仍是 viewer
  const rv = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s1.sid}`, { key: 'k-a1' });
  assert.equal(rv.res.json().memberRemoved, null);
  const meta = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-b1' });
  assert.equal(meta.res.status, 200);
  assert.equal(meta.res.json().project.role, 'viewer');
  // 反向：viewer 邀请加入 → direct 升 editor → 撤邀请后 direct 授予不受影响（仍是 editor）
  const s2 = await mkShare(svc, p, 'viewer');
  await call(svc, 'POST', '/workspace/claim', { key: 'k-c1', body: JSON.stringify({ token: s2.token }) });
  await call(svc, 'PUT', `/workspace/projects/${p.owner}/${p.id}/members/u_3`, { key: 'k-a1', body: JSON.stringify({ role: 'editor' }) });
  const rv3 = await call(svc, 'DELETE', `/workspace/projects/${p.owner}/${p.id}/shares/${s2.sid}`, { key: 'k-a1' });
  assert.equal(rv3.res.json().memberRemoved, null);
  const meta3 = await call(svc, 'GET', `/workspace/projects/${p.owner}/${p.id}`, { key: 'k-c1' });
  assert.equal(meta3.res.status, 200);
  assert.equal(meta3.res.json().project.role, 'editor');
});

test('旧成员记录按实际邀请来源恢复：撤 editor 邀请后降为 viewer', async () => {
  const dir = tmpDir();
  const pid = 'wp_00000000-0000-0000-0000-000000000001';
  const s1 = 'sh_00000000000000a1', s2 = 'sh_00000000000000b2';
  const meta = {
    format: 'xp-workspace@1', id: pid, owner: 'u_1', name: '旧项目', head: 1,
    // 旧版升级遗留形态：u_2 由 S1 加入后又兑 S2 提为 editor，但 via 仍指 S1、无 grants 字段
    members: { u_2: { role: 'editor', at: NOW, by: 'u_1', via: `share:${s1}` } },
    shares: {
      [s1]: { hash: 'h1', role: 'viewer', createdAt: NOW, expiresAt: NOW + 86400_000, revokedAt: null, claimedBy: 'u_2', claimedAt: NOW },
      [s2]: { hash: 'h2', role: 'editor', createdAt: NOW, expiresAt: NOW + 86400_000, revokedAt: null, claimedBy: 'u_2', claimedAt: NOW },
    },
    versions: [], revLog: [], activity: [], blobIndex: {}, blobBytes: 0, docBytes: 0, bytes: 0,
  };
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    format: 'xp-workspace@2', projects: { [pid]: meta },
    shares: { h1: { pid, sid: s1, expiresAt: NOW + 86400_000 }, h2: { pid, sid: s2, expiresAt: NOW + 86400_000 } },
  }));
  const { svc } = makeService({ dataDir: dir });
  const p = { owner: 'u_1', id: pid };
  const m0 = await memberOf(svc, p, 'u_2');
  assert.equal(m0.role, 'editor');
  assert.deepEqual(m0.grants, { [`share:${s1}`]: 'viewer', [`share:${s2}`]: 'editor' });
  // 撤 S2：仅保留 S1 的 viewer 权限。
  const rv2 = await call(svc, 'DELETE', `/workspace/projects/u_1/${pid}/shares/${s2}`, { key: 'k-a1' });
  assert.equal(rv2.res.json().memberRemoved, null);
  assert.equal((await call(svc, 'GET', `/workspace/projects/u_1/${pid}`, { key: 'k-b1' })).res.json().project.role, 'viewer');
  // 撤 S1：派生来源 share:s1 被移除 → 无剩余来源 → 成员移除（与旧撤销语义一致）
  const rv1 = await call(svc, 'DELETE', `/workspace/projects/u_1/${pid}/shares/${s1}`, { key: 'k-a1' });
  assert.equal(rv1.res.json().memberRemoved, 'u_2');
  assert.equal((await call(svc, 'GET', `/workspace/projects/u_1/${pid}`, { key: 'k-b1' })).res.status, 404);
});

function legacyFixture(member, shares) {
  const dir=tmpDir(),pid='wp_00000000-0000-0000-0000-000000000010';
  const meta={format:'xp-workspace@1',id:pid,owner:'u_1',name:'旧项目',head:1,members:{u_2:member},shares,versions:[],revLog:[],activity:[],blobIndex:{},blobBytes:0,docBytes:0,bytes:0};
  writeFileSync(join(dir,'index.json'),JSON.stringify({format:'xp-workspace@2',projects:{[pid]:meta},shares:{}}));
  return {svc:makeService({dataDir:dir}).svc,p:{owner:'u_1',id:pid}};
}
const legacyInvite=(role,at,expires=NOW+86400000)=>({hash:'mock',role,createdAt:at,expiresAt:expires,revokedAt:null,claimedBy:'u_2',claimedAt:at});

test('独立权限复审：撤销唯一旧邀请必须移除空成员，而非只隐藏权限',async()=>{
 const sid='sh_00000000000000a1';const {svc,p}=legacyFixture({role:'viewer',at:NOW,via:`share:${sid}`},{[sid]:legacyInvite('viewer',NOW)});
 const result=await call(svc,'DELETE',`/workspace/projects/${p.owner}/${p.id}/shares/${sid}`,{key:'k-a1'});
 assert.equal(result.res.json().memberRemoved,'u_2');
 assert.equal(await memberOf(svc,p,'u_2'),undefined,'空成员必须从列表和配额中移除');
 assert.equal((await call(svc,'GET',`/workspace/projects/${p.owner}/${p.id}`,{key:'k-b1'})).res.status,404);
});

test('独立权限复审：移除成员前的旧已消费邀请不能复活，已绑定邀请过期不踢人',async()=>{
 const old='sh_00000000000000a0',current='sh_00000000000000a1';
 const {svc,p}=legacyFixture({role:'viewer',at:NOW,via:`share:${current}`},{[old]:legacyInvite('editor',NOW-2000),[current]:legacyInvite('viewer',NOW,NOW-1)});
 const m=await memberOf(svc,p,'u_2');assert.equal(m.role,'viewer');assert.deepEqual(m.grants,{[`share:${current}`]:'viewer'});
 assert.equal((await call(svc,'GET',`/workspace/projects/${p.owner}/${p.id}`,{key:'k-b1'})).res.status,200);
});

test('独立权限复审：旧管理员明确降级不被历史编辑邀请抬权',async()=>{
 const sid='sh_00000000000000a1';const {svc,p}=legacyFixture({role:'viewer',at:NOW,via:'direct'},{[sid]:legacyInvite('editor',NOW)});
 const m=await memberOf(svc,p,'u_2');assert.equal(m.role,'viewer');assert.equal(m.grants.direct,'viewer');
 const out=await call(svc,'PUT',`/workspace/projects/${p.owner}/${p.id}`,{key:'k-b1',headers:{'if-match':'r1'},body:makePackage({})});assert.equal(out.res.status,403);
});

test('CSP：父页 frame-ancestors 仅 self（导演台隔离源不可反向嵌入），父页嵌导演台不受影响', async t => {
  const { svc } = makeService();
  const port = await httpServer(t, svc);
  const home = await hreq(port, 'GET', '/');
  assert.equal(home.status, 200);
  // 父页祖先策略精确为 'self'——对侧导演台源（localhost:port）不在其中，无法 iframe 反向嵌入父页
  assert.deepEqual(cspList(home, 'frame-ancestors'), [`'self'`]);
  // 父页仍可嵌入对侧导演台：frame-src 继续放行对侧源 + blob:
  assert.deepEqual(new Set(cspList(home, 'frame-src')), new Set([`http://localhost:${port}`, 'blob:']));
  // 导演台文档仍精确放行对侧画布源——父页 iframe 嵌入路径保持可用
  const d = await hreq(port, 'GET', '/director/index.html', { headers: { Host: `localhost:${port}` } });
  assert.equal(d.status, 200);
  assert.deepEqual(cspList(d, 'frame-ancestors'), [`http://127.0.0.1:${port}`]);
  // 静态区其他文档同样只许 self 祖先
  const page2 = await hreq(port, 'GET', '/index.html');
  assert.deepEqual(cspList(page2, 'frame-ancestors'), [`'self'`]);
});
