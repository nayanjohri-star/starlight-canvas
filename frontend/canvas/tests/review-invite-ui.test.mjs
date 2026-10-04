// 邀请链接面板内存态回归测试（client 侧）：node --test。
// 覆盖审查修复：生成邀请链接后 run() 包装器的整树重绘不再丢失链接（改由 state 驱动重建）；
// 重复生成只显示最新链接且每次点击只创建一条邀请；链接限定当前面板/选中项目/账户-指纹身份——
// 切换选中项目、指纹变化、关闭面板即清除；令牌不写入本地存储、不自动进入剪贴板。
// DOM 用最小桩实现；fetch 用假 /workspace 合同，不打网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../src/workspace.js';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';

const KEY = 'invite-ui-test-key';

// ---------- 最小 DOM 桩 ----------
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], listeners: {}, attrs: {},
    style: {}, className: '', textContent: '', value: undefined, disabled: false, parent: null,
    append(...cs) { for (const c of cs.flat()) if (c != null) { node.children.push(c); c.parent = node; } },
    appendChild(c) { node.append(c); return c; },
    replaceChildren(...cs) { node.children = []; node.append(...cs); },
    remove() { const p = node.parent; if (p) p.children = p.children.filter(x => x !== node); node.parent = null; },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return node.attrs[k] ?? null; },
    addEventListener(t, fn) { (node.listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) { node.listeners[t] = (node.listeners[t] ?? []).filter(f => f !== fn); },
    contains(n) { for (let c = n; c; c = c.parent) if (c === node) return true; return false; },
    querySelectorAll() { return []; },
    select() { node.selectedAll = true; },
    focus() { stubDoc.activeElement = node; },
    get lastElementChild() { return node.children[node.children.length - 1] ?? null; },
    get childElementCount() { return node.children.length; },
  };
  return node;
}
const stubDoc = {
  _ids: {}, activeElement: null,
  createElement: t => makeNode(t),
  getElementById(id) { return stubDoc._ids[id] ?? null; },
  addEventListener() {}, removeEventListener() {},
};
function installDom() {
  stubDoc._ids = { 'overlay-root': makeNode('div'), 'toast-root': makeNode('div') };
  stubDoc.activeElement = null;
  globalThis.document = stubDoc;
  globalThis.location = { origin: 'http://canvas.local', hash: '', pathname: '/', search: '' };
}
function* walk(n) { yield n; for (const c of [...(n.children ?? [])]) yield* walk(c); }
const overlay = () => stubDoc._ids['overlay-root'];
const allNodes = () => [...walk(overlay())];
const findBtns = text => allNodes().filter(n => n.tagName === 'BUTTON' && n.textContent === text && !n.disabled);
const findInput = value => allNodes().find(n => n.tagName === 'INPUT' && n.value === value);
const inviteInputs = () => allNodes().filter(n => n.tagName === 'INPUT' && n.getAttribute?.('aria-label') === '本次生成的邀请链接');
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
async function click(node) {
  assert.ok(node, '目标按钮应存在');
  await Promise.all((node.listeners.click ?? []).map(f => f({ target: node, preventDefault() {}, stopPropagation() {} })));
  await settle();
}

// ---------- 假 /workspace 合同 ----------
const jres = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: n => headers[String(n).toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
});
function fakeCloud() {
  const projects = [
    { id: 'wp_a', owner: 'u_1', name: '项目甲', head: 3, role: 'owner', mine: true, bytes: 0, updatedAt: 2 },
    { id: 'wp_b', owner: 'u_1', name: '项目乙', head: 1, role: 'owner', mine: true, bytes: 0, updatedAt: 1 },
  ];
  const sharesByPid = new Map(); let seq = 0;
  const created = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local.test');
    const m = /^\/workspace\/projects\/([^/]+)\/([^/]+)(?:\/(members|revisions|shares))?$/.exec(u.pathname);
    if (u.pathname === '/workspace/identity') return jres(200, { ok: true, subject: 'u_1', displayName: '甲' });
    if (u.pathname === '/workspace/projects') return jres(200, { ok: true, subject: 'u_1', projects });
    if (m?.[3] === 'revisions') return jres(200, { ok: true, head: projects.find(p => p.id === m[2])?.head ?? 0, revisions: [], versions: [] });
    if (m?.[3] === 'members') {
      const shares = [...(sharesByPid.get(m[2]) ?? [])].map(s => ({ id: s.id, role: s.role, createdAt: 1, expiresAt: s.expiresAt, revoked: !!s.revoked, claimed: false, claimedBy: null, memberRemoved: false }));
      return jres(200, { ok: true, members: [], shares });
    }
    if (m?.[3] === 'shares' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      const token = `tok_test_${++seq}_${'x'.repeat(20)}`;
      const share = { id: `sh_${String(seq).padStart(16, '0')}`, role: body.role === 'editor' ? 'editor' : 'viewer', expiresAt: Date.now() + 72 * 3600e3 };
      if (!sharesByPid.has(m[2])) sharesByPid.set(m[2], []);
      sharesByPid.get(m[2]).push(share);
      created.push({ pid: m[2], share, token, url: `http://canvas.local/#ws-claim=${token}` });
      return jres(201, { ok: true, share: { id: share.id, role: share.role, expiresAt: share.expiresAt }, invite: { fragment: `#ws-claim=${token}` } });
    }
    return jres(404, { error: { code: 'route_not_found', message: 'nf' } });
  };
  return { fetch, created };
}

test('生成邀请链接：run() 整树重绘后仍显示；重复生成显示最新；身份/项目变化即清除；令牌不落存储', async () => {
  installDom();
  const cloud = fakeCloud();
  const storage = createMemoryStorage();
  const writes = [];
  const origSet = storage.set.bind(storage);
  storage.set = async (k, v) => { writes.push([String(k), JSON.stringify(v)]); return origSet(k, v); };
  const store = createStore(storage);
  await store.newProject('本地项目');
  let fp = 'fp1';
  const ws = createWorkspace({ store, storage, getKey: () => KEY, getFingerprint: () => fp, fetch: cloud.fetch });
  const panel = ws.open();
  assert.ok(panel, '面板打开');
  await settle();

  // 选中「项目甲」并展开成员/邀请区
  await click(findBtns('创建邀请链接')[0]);
  const gen = () => findBtns('生成邀请链接')[0];
  assert.ok(gen(), '成员区渲染出生成按钮');

  await click(gen());
  const url1 = cloud.created[0].url;
  assert.equal(cloud.created.length, 1, '每次点击只创建一条邀请');
  assert.ok(findInput(url1), '生成后链接输入框可见');
  assert.equal(inviteInputs().length, 1);

  // run() 每次动作后整树重绘——链接由面板 state 重建，不再附着于被丢弃的旧 mbox：
  await click(findBtns('版本/成员')[0]);          // 同一项目重载详情（触发完整 rerender）
  assert.ok(findInput(url1), '整树重绘后链接仍显示');

  // 重复生成：第二次点击只创建一条新邀请，界面显示最新链接（旧链接被替换）
  await click(gen());
  assert.equal(cloud.created.length, 2, '每次点击只创建一条邀请');
  const url2 = cloud.created[1].url;
  assert.ok(findInput(url2), '显示最新生成的链接');
  assert.ok(!findInput(url1), '旧链接不再显示');
  assert.equal(inviteInputs().length, 1);

  // 连接身份变化（密钥指纹变更）→ 渲染入口判定即丢弃
  fp = 'fp2';
  await click(findBtns('版本/成员')[0]);
  assert.equal(inviteInputs().length, 0, '密钥指纹变化后邀请链接清除');
  fp = 'fp1';
  await click(gen());
  assert.equal(cloud.created.length, 3);
  assert.ok(findInput(cloud.created[2].url));

  // 切换选中项目 → 上下文变化清除
  await click(findBtns('版本/成员')[1]);
  assert.equal(inviteInputs().length, 0, '切换选中项目后邀请链接清除');

  // 令牌不落本地存储（任何 key/value 都不得包含 token）
  for (const c of cloud.created)
    assert.ok(!writes.some(([k, v]) => k.includes(c.token) || (v ?? '').includes(c.token)), `分享令牌不得写入 storage：${c.token}`);

  // 关闭即清除：重开面板展开同项目成员区，不残留旧链接
  panel.close();
  const panel2 = ws.open();
  await settle();
  await click(findBtns('创建邀请链接')[0]);
  assert.equal(inviteInputs().length, 0, '重开面板不残留旧链接');
  panel2.close();
});
