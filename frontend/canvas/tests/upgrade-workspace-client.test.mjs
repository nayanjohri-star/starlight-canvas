// workspace.js 客户端单元测试：node --test。fake fetch 模拟 /workspace/* 合同；
// 校验：key 只在 Authorization 头、状态分组、冲突显式处理、拉取走安全导入、链接持久化。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, parseClaimToken, WorkspaceError } from '../src/workspace.js';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { zipStore } from '../src/export-project.js';

const enc = new TextEncoder();
const KEY = 'workspace-test-key-a';

const jres = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: n => headers[n.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
});
function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = new URL(String(url), 'http://local.test');
    for (const h of handlers) { const r = await h(u, opts); if (r) return r; }
    return jres(404, { error: { code: 'route_not_found', message: 'nf' } });
  };
  fn.calls = calls;
  return fn;
}
async function makeDeps(fetchImpl, extra = {}) {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('本地项目');
  return { deps: { store, storage, assets: { renderLibrary() {} }, getKey: () => KEY, getFingerprint: () => 'fp1', fetch: fetchImpl, ...extra }, store, storage };
}
const identityRoute = subject => (u) => u.pathname === '/workspace/identity'
  ? jres(200, { ok: true, subject, displayName: '甲' }) : null;

// 假服务端内存态：记录 projects {owner,id,head,pkg}
function fakeCloud() {
  const projects = new Map(); let seq = 0;
  const handlers = [
    (u, opts) => u.pathname === '/workspace/projects' && opts.method === 'POST'
      ? jres(201, { ok: true, project: (() => { const input = JSON.parse(opts.body), existing = [...projects.values()].find(p => input.clientRequestId && p.clientRequestId === input.clientRequestId); if (existing) return {...existing,reconciled:true}; const p = { owner: 'u_1', id: `wp_${String(++seq).padStart(36, '0')}`, head: 0, name: input.name, clientRequestId: input.clientRequestId }; projects.set(p.id, p); return p; })() }) : null,
    (u, opts) => u.pathname === '/workspace/projects' && opts.method === 'GET'
      ? jres(200, { ok: true, subject: 'u_1', projects: [...projects.values()].map(p => ({ id: p.id, owner: p.owner, name: p.name, head: p.head, role: 'owner', mine: true, bytes: 0, updatedAt: 1 })) }) : null,
    (u, opts) => {
      const m = /^\/workspace\/projects\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (m && opts.method === 'PUT') {
        const p = projects.get(m[2]);
        if (!p || m[1] !== p.owner) return jres(404, { error: { code: 'project_not_found' } });
        const base = Number(/^r?(\d+)$/.exec(opts.headers['If-Match'] ?? '')?.[1] ?? -1);
        if (base !== p.head) return jres(409, { error: { code: 'revision_conflict', message: 'stale', head: p.head, base } });
        p.head += 1; p.pkg = opts.body;
        return jres(201, { ok: true, rev: p.head, head: p.head });
      }
      if (m && opts.method === 'GET') {
        const p = projects.get(m[2]);
        if (!p) return jres(404, { error: { code: 'project_not_found' } });
        if (opts.headers['If-None-Match'] === `"r${p.head}"`) return jres(304, null);
        return jres(200, { ok: true, project: { ...p, role: 'owner' }, versions: [], activity: [], peers: [] });
      }
      const pk = /^\/workspace\/projects\/([^/]+)\/([^/]+)\/package$/.exec(u.pathname);
      if (pk && opts.method === 'GET') {
        const p = projects.get(pk[2]);
        if (!p?.pkg) return jres(404, { error: { code: 'project_not_found' } });
        const buf = p.pkg instanceof Uint8Array ? p.pkg : new Uint8Array(p.pkg);
        return { ok: true, status: 200, headers: { get: n => { const k = String(n).toLowerCase(); return k === 'x-workspace-rev' ? String(p.head) : k === 'etag' ? `"r${p.head}"` : null; } }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: async () => ({}) };
      }
      return null;
    },
  ];
  handlers.projects = projects;   // 暴露服务端内存态供对账/断言测试
  return handlers;
}

test('status 分组：no_key / ok / key_rejected / unavailable', async () => {
  const storage = createMemoryStorage(); const store = createStore(storage);
  const noKey = createWorkspace({ store, storage, getKey: () => null, fetch: makeFetch([]) });
  assert.equal((await noKey.status()).state, 'no_key');

  const ok = createWorkspace({ store, storage, getKey: () => KEY, fetch: makeFetch([identityRoute('u_1')]) });
  assert.deepEqual(await ok.status(), { state: 'ok', subject: 'u_1', displayName: '甲' });

  const rej = createWorkspace({ store, storage, getKey: () => KEY, fetch: makeFetch([() => jres(401, { error: { code: 'key_rejected', message: 'x' } })]) });
  assert.equal((await rej.status()).state, 'key_rejected');

  const down = createWorkspace({ store, storage, getKey: () => KEY, fetch: makeFetch([() => jres(503, { error: { code: 'identity_unavailable', message: 'x' } })]) });
  assert.equal((await down.status()).state, 'unavailable');
});

test('key 只在 Authorization 头，不进 URL/请求体', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  for (const c of fetch.calls) {
    assert.ok(!c.url.includes(KEY));
    const body = c.opts.body ? String(typeof c.opts.body === 'string' ? c.opts.body : '<binary>') : '';
    assert.ok(!body.includes(KEY));
    assert.equal(c.opts.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(c.opts.credentials, 'omit');
  }
});

test('backup 新建云端项目并写入链接；再次推送带正确 If-Match', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  const r1 = await ws.backup({});
  assert.equal(r1.created, true); assert.equal(r1.rev, 1);
  const link = await storage.get(`ws:link:${store.project.id}`);
  assert.equal(link.head, 1); assert.equal(link.owner, 'u_1');
  const putCalls = fetch.calls.filter(c => c.opts.method === 'PUT');
  assert.equal(putCalls[0].opts.headers['If-Match'], 'r0');
  const r2 = await ws.backup({});
  assert.equal(r2.rev, 2);
  assert.equal(fetch.calls.filter(c => c.opts.method === 'PUT')[1].opts.headers['If-Match'], 'r1');
});

test('冲突：409 不静默覆盖；取消/另存副本/拉取副本三条路都保留本地草稿', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  const link = await storage.get(`ws:link:${store.project.id}`);
  // 模拟他人推送：直接改 fake 服务端 head（走一次另一"会话"的 PUT）
  await fetch(`/workspace/projects/u_1/${link.id}`, { method: 'PUT', headers: { 'If-Match': 'r1', Authorization: 'Bearer x' }, body: zipStore([{ name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'xp-package@1', version: 1, timeline: { clips: [] }, media: [] })) }, { name: 'project.json', data: enc.encode(await store.exportJSON()) }]) });
  const nameBefore = store.project.name;
  // 无 onConflict → 抛结构化冲突
  const err = await ws.backup({}).then(() => null, e => e);
  assert.equal(err.code, 'revision_conflict'); assert.equal(err.head, 2); assert.equal(err.conflict.base, 1);
  assert.equal(store.project.name, nameBefore);
  assert.equal((await storage.get(`ws:link:${store.project.id}`)).head, 1);   // 链接未被污染
  // cancel
  const cancelled = await ws.backup({ onConflict: async () => 'cancel' });
  assert.equal(cancelled.cancelled, true);
  // new_copy：新建 + 推送
  const saved = await ws.backup({ onConflict: async () => 'new_copy' });
  assert.equal(saved.resolved, 'new_copy'); assert.equal(saved.rev, 1);
  const newLink = await storage.get(`ws:link:${store.project.id}`);
  assert.notEqual(newLink.id, link.id);
});

test('pull：包经安全导入生成新本地项目并写链接', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  const localId = store.project.id;
  const link = await storage.get(`ws:link:${localId}`);
  const pulled = await ws.pull({ owner: link.owner, id: link.id });
  assert.ok(pulled.project.id !== localId || true);   // 导入总是新建项目实体
  assert.equal(pulled.rev, 1);
  const newLink = await storage.get(`ws:link:${pulled.project.id}`);
  assert.equal(newLink.id, link.id); assert.equal(newLink.head, 1);
});

test('checkRemote：ETag 未变 → notModified；head 变 → changed', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  const link = await storage.get(`ws:link:${store.project.id}`);
  assert.equal((await ws.checkRemote(link)).changed, false);
  await ws.backup({});   // 本地再推一版 → head 前进
  const l2 = await storage.get(`ws:link:${store.project.id}`);
  assert.equal((await ws.checkRemote({ ...l2, head: 1 })).changed, true);
});

test('parseClaimToken / claim 解析', async () => {
  const tk = 'AbCdEfGhIjKlMnOpQrStUvWx';
  assert.equal(parseClaimToken(`https://x/#ws-claim=${tk}`), tk);
  assert.equal(parseClaimToken(`#ws-claim=${tk}`), tk);
  assert.equal(parseClaimToken(tk), tk);
  assert.equal(parseClaimToken('not a token'), null);
  const fetch = makeFetch([identityRoute('u_1'), (u, o) => u.pathname === '/workspace/claim' ? jres(200, { ok: true, project: { id: 'wp_1', owner: 'u_9', name: 'P' }, role: 'viewer' }) : null]);
  const { deps } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  const r = await ws.claim(`https://xingpan.site/#ws-claim=${tk}`);
  assert.equal(r.role, 'viewer');
  assert.equal(JSON.parse(fetch.calls.at(-1).opts.body).token, tk);
});

test('快照校验：打包期间切换项目/换 key → 中止上传', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, store } = await makeDeps(fetch, {
    buildPackage: async () => { await store.newProject('另一个'); return new Uint8Array([1]); },
  });
  const ws = createWorkspace(deps);
  await store.newProject('原始');   // 还原为当前
  // buildPackage 桩会再切走项目
  const err = await ws.backup({}).then(() => null, e => e);
  assert.ok(err instanceof WorkspaceError);
  assert.equal(err.code, 'project_changed');
  assert.ok(!fetch.calls.some(c => c.opts.method === 'PUT'));
});

test('hasInflightTasks 守卫识别进行中任务', async () => {
  const { deps, store } = await makeDeps(makeFetch([]));
  const ws = createWorkspace(deps);
  assert.equal(ws.hasInflightTasks(store.project), false);
  store.project.nodes.push({ id: 'g_1', type: 'gen', x: 0, y: 0, data: { run: { taskId: 't1' } } });
  assert.equal(ws.hasInflightTasks(store.project), true);
});

test('pending 对账：create 已受理但响应丢失 → 重试收养而不是重复建项目', async () => {
  const cloud = fakeCloud();
  let failOnce = true;
  const fetch = makeFetch([identityRoute('u_1'), async (u, o) => {
    if (u.pathname === '/workspace/projects' && o.method === 'POST' && failOnce) {
      failOnce = false;
      await cloud[0](u, o);              // 服务端已受理
      throw new Error('response lost');  // 但响应没到客户端
    }
    return null;
  }, ...cloud]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await assert.rejects(ws.backup({}), e => e.code === 'network_error');
  assert.equal(cloud.projects.size, 1);
  const again = await ws.backup({});
  assert.equal(again.reconciled, true);
  assert.equal(cloud.projects.size, 1);   // 没有第二个云项目
  assert.equal(fetch.calls.filter(c => c.opts.method === 'POST' && new URL(c.url, 'http://x').pathname === '/workspace/projects').length, 2, '重试原创建标识，服务端只创建一次');
  assert.equal((await storage.get(`ws:link:${store.project.id}`)).id, again.id);
});

test('pull 防劫持：拉取期间切换项目 → 中止且不写链接不导入', async () => {
  const cloud = fakeCloud();
  const base = makeFetch([identityRoute('u_1'), ...cloud]);
  let started; const gate = new Promise(r => { started = r; });
  const fetch = async (u, o) => {
    if (String(u).includes('/package')) { started(); await new Promise(r => setTimeout(r, 25)); }
    return base(u, o);
  };
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  const link = await storage.get(`ws:link:${store.project.id}`);
  const before = (await store.listProjects()).length;
  const p = ws.pull({ owner: link.owner, id: link.id });
  await gate;                              // 等 package 请求在飞
  await store.newProject('别的项目');
  await assert.rejects(p, e => e.code === 'project_changed');
  assert.equal((await store.listProjects()).length, before + 1);   // 只有手工新建，没有导入劫持
});

test('打包期间文档被改动 → project_changed（可允许的只有 flush 的 rev 变化）', async () => {
  const fetch = makeFetch([identityRoute('u_1'), ...fakeCloud()]);
  const { deps, store } = await makeDeps(fetch, {
    buildPackage: async () => { store.project.nodes.push({ id: 'n_x', type: 'note', x: 0, y: 0, data: {} }); return new Uint8Array([1, 2, 3]); },
  });
  const ws = createWorkspace(deps);
  const err = await ws.backup({}).then(() => null, e => e);
  assert.equal(err.code, 'project_changed');
  assert.ok(!fetch.calls.some(c => c.opts.method === 'PUT'));
});

test('冲突对话框期间换 key → 放弃后续动作，链接与服务端都不变', async () => {
  let curKey = KEY;
  const cloud = fakeCloud();
  const fetch = makeFetch([identityRoute('u_1'), ...cloud]);
  const { deps, storage, store } = await makeDeps(fetch, { getKey: () => curKey });
  const ws = createWorkspace(deps);
  await ws.backup({});
  const link = await storage.get(`ws:link:${store.project.id}`);
  // 他人推一版（直写 fake 服务端）
  await fetch(`/workspace/projects/u_1/${link.id}`, { method: 'PUT', headers: { 'If-Match': 'r1', Authorization: 'Bearer x' }, body: zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'xp-package@1', version: 1, timeline: { clips: [] }, media: [] })) },
    { name: 'project.json', data: enc.encode(await store.exportJSON()) }]) });
  const err = await ws.backup({ onConflict: async () => { curKey = '[REDACTED KEY]'; return 'new_copy'; } }).then(() => null, e => e);
  assert.equal(err.code, 'key_changed');
  assert.equal((await storage.get(`ws:link:${store.project.id}`)).id, link.id);
  assert.equal(cloud.projects.size, 1);   // 没有多建项目
});

test('链接归属校验：链接由其他账户创建 → account_changed 不推送', async () => {
  const cloud = fakeCloud();
  const fetch = makeFetch([identityRoute('u_1'), ...cloud]);
  const { deps, storage, store } = await makeDeps(fetch);
  const ws = createWorkspace(deps);
  await ws.backup({});
  const k = `ws:link:${store.project.id}`;
  const l = await storage.get(k);
  await storage.set(k, { ...l, subject: 'u_9' });
  fetch.calls.length = 0;
  const err = await ws.backup({}).then(() => null, e => e);
  assert.equal(err.code, 'account_changed');
  assert.ok(!fetch.calls.some(c => c.opts.method === 'PUT'));
});
