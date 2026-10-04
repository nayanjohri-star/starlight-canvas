// WO-C1b/WO-C4 模块测试：任务面板键控增量重铺 + 空选择不启动（仅 node --test）。
//  · reconcileKeyedList：同签名复用 DOM、变化才重建、换位移动不摘除、淘汰清理、空态键控进出
//  · taskPanelEntries：key=记录身份、sig 覆盖全部渲染字段、下载按钮沿用既有公式（C1a 换统一谓词）
//  · workflowScopeTargets：空选择=空集不回落全画布、all 显式、分组仅存活成员（合同 §6.2/§8）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canFetchContent } from '../src/task-status.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 极简 DOM 桩（只实现被测代码用到的 API；append/insertBefore 保持数组为真源） ----------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parent = null; this.children = [];
    this._l = new Map(); this._attrs = new Map();
    this._cls = ''; this._text = '';
    this.disabled = false; this.id = ''; this.value = '';
    this.dataset = {}; this.style = {};
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); }
  get classList() {
    const s = this;
    return {
      add(...cs) { s._cls = [...new Set([...s._cls.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
      remove(...cs) { const d = new Set(cs); s._cls = s._cls.split(/\s+/).filter(c => c && !d.has(c)).join(' '); },
      contains(c) { return s._cls.split(/\s+/).includes(c); },
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  hasAttribute(k) { return this._attrs.has(k); }
  addEventListener(t, fn) { const l = this._l.get(t) ?? this._l.set(t, []).get(t); l.push(fn); }
  removeEventListener() {}
  click() { for (const fn of [...(this._l.get('click') ?? [])]) fn({ type: 'click', target: this }); }
  append(...cs) {
    for (const c of cs.flat()) {
      if (c == null) continue;
      const n = c instanceof El ? c : Object.assign(new El('#text'), { _text: String(c) });
      n.remove(); n.parent = this; this.children.push(n);
    }
  }
  insertBefore(n, ref) {
    if (ref == null) { this.append(n); return n; }
    const i = this.children.indexOf(ref);
    n.remove(); n.parent = this;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  replaceChildren(...cs) { for (const c of this.children) c.parent = null; this.children = []; this.append(...cs); }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  contains(n) { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  focus() { DOC.activeElement = this; }
  _desc(out = []) { for (const c of this.children) { out.push(c); c._desc(out); } return out; }
}

const DOC = {
  _byId: new Map(),
  activeElement: null,
  body: new El('body'),
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  getElementById(id) { return this._byId.get(id) ?? null; },
  addEventListener() {}, removeEventListener() {},
};
DOC._byId.set('overlay-root', new El('div'));
DOC._byId.set('toast-root', new El('div'));

// 先 import（此时尚无 document，main.js 的 boot() 守卫跳过启动），再装 DOM 桩——
// 桩只服务被测函数调用期（el() → document.createElement），不引导整个装配层。
const { reconcileKeyedList, taskPanelEntries, workflowScopeTargets } = await import('../src/main.js');
globalThis.document = DOC;

test('reconcileKeyedList：同签名复用、变化重建、换位移动、淘汰清理', () => {
  const list = new El('div');
  let builds = 0;
  const mk = (key, sig) => ({ key, sig, build: () => { builds++; const e = new El('div'); e.className = 'task-item'; return e; } });
  reconcileKeyedList(list, [mk('a', 1), mk('b', 1), mk('c', 1)]);
  assert.equal(list.children.length, 3);
  assert.equal(builds, 3);
  const [a1, b1, c1] = list.children;
  reconcileKeyedList(list, [mk('a', 1), mk('b', 1), mk('c', 1)]);        // 同签名 → 零重建
  assert.equal(builds, 3, '未变行不重建（轮询期 DOM 零 churn）');
  assert.ok(list.children[0] === a1 && list.children[1] === b1 && list.children[2] === c1);
  reconcileKeyedList(list, [mk('a', 1), mk('b', 2), mk('c', 1)]);        // b 签名变 → 仅 b 重建
  assert.equal(builds, 4);
  assert.ok(list.children[0] === a1 && list.children[2] === c1 && list.children[1] !== b1);
  const b2 = list.children[1];
  reconcileKeyedList(list, [mk('c', 1), mk('a', 1), mk('b', 2)]);        // 换位 → 同实例移动
  assert.equal(builds, 4);
  assert.ok(list.children[0] === c1 && list.children[1] === a1 && list.children[2] === b2);
  reconcileKeyedList(list, [mk('a', 1)]);                               // 淘汰 → 行移除
  assert.equal(list.children.length, 1);
  assert.strictEqual(list.children[0], a1);
  reconcileKeyedList(list, [mk('a', 1), mk('b', 2)]);                    // 重新加入 → 新实例（缓存已清理）
  assert.equal(builds, 5);
  assert.ok(list.children[1] !== b1 && list.children[1] !== b2);
});

test('reconcileKeyedList：复用项移动不摘除——行内焦点保留', () => {
  const list = new El('div');
  const mk = key => ({ key, sig: '0', build: () => { const e = new El('div'); e.className = 'task-item'; e.append(new El('button')); return e; } });
  reconcileKeyedList(list, [mk('a'), mk('b'), mk('c')]);
  const btn = list.children[1].children[0];
  btn.focus();
  assert.equal(DOC.activeElement, btn);
  reconcileKeyedList(list, [mk('d'), mk('b'), mk('a'), mk('c')]);        // 插入+重排
  assert.equal(DOC.activeElement, btn, '复用行未摘除重建，行内焦点保留');
  assert.ok(list.contains(btn));
});

test('reconcileKeyedList：空态提示作为键控项进出', () => {
  const list = new El('div');
  const hint = () => ({ key: 'task-panel:empty', sig: '0', build: () => { const p = new El('p'); p.className = 'hint'; p._text = '暂无任务'; return p; } });
  reconcileKeyedList(list, [hint()]);
  assert.equal(list.children.length, 1);
  assert.ok(list.children[0].classList.contains('hint'));
  const h = list.children[0];
  reconcileKeyedList(list, [hint()]);
  assert.strictEqual(list.children[0], h, '空态行也复用');
  reconcileKeyedList(list, [{ key: 'task:t1', sig: 'x', build: () => { const d = new El('div'); d.className = 'task-item'; return d; } }]);
  assert.equal(list.children.length, 1);
  assert.ok(list.children[0].classList.contains('task-item'), '任务出现时提示让位');
  reconcileKeyedList(list, [hint()]);
  assert.ok(list.children[0].classList.contains('hint'));
});

const depsBase = {
  store: { node: () => null, tasksOfProject: async () => [] },
  runner: {
    poll() {}, async download() {}, async resultURL() { return null; },
    async restoreTask() { return null; }, async restorePending() { return null; },
    async setPollPaused() {}, async cancelTask() {},
  },
  board: { focusNode() {} },
  editor: { duplicate: () => [] },
  keyFp: 'fp1',
};

const btnOf = (item, text) => item._desc().find(b => b.tagName === 'BUTTON' && b.textContent === text);
const badgeOf = item => item._desc().find(b => b.classList.contains('badge'));

test('taskPanelEntries：key=记录身份，sig 覆盖谓词与渲染字段', () => {
  const mk = t => taskPanelEntries({ ...depsBase, tasks: [t], pending: [] });
  const base = { taskId: 't1', projectId: 'p1', model: 'm', status: 'in_progress', createdAt: 1 };
  const e1 = mk(base)[0];
  assert.equal(e1.key, 'task:t1');
  // 未渲染/未参与谓词的字段不进签名 → 复用（progress 不在面板展示）
  assert.equal(mk({ ...base, progress: 0.7 })[0].sig, e1.sig);
  // 谓词/渲染字段任一变化 → 签名变 → 该行重建（C1a：v2 字段全部进 sig）
  for (const t of [
    { ...base, status: 'completed' }, { ...base, deliveryStatus: 'delivering' },
    { ...base, paused: true }, { ...base, detached: true }, { ...base, stage: 'reconciling' },
    { ...base, contentReady: true }, { ...base, executorVersion: 2 }, { ...base, cancelRequested: true },
    { ...base, authFailed: true }, { ...base, keyFp: 'fp9' }, { ...base, resultBlobId: 'b1' },
    { ...base, resultAssetId: 'a1' },
    { ...base, pollError: 'x' }, { ...base, error: { message: 'e' } },
    { ...base, resultType: 'video/webm' }, { ...base, nodeId: 'n1' }, { ...base, model: 'm2' },
    { ...base, cancelPhase: 'requested' }, { ...base, downloadExpiresAt: 1770000000 },
  ]) assert.notEqual(mk(t)[0].sig, e1.sig, `签名未覆盖 ${JSON.stringify(t)}`);
  // 当前密钥指纹变化 → need_key 相位翻转触发重建
  assert.notEqual(taskPanelEntries({ ...depsBase, keyFp: 'fpX', tasks: [{ ...base, paused: true, keyFp: 'fp1' }], pending: [] })[0].sig,
    mk({ ...base, paused: true, keyFp: 'fp1' })[0].sig);
  // 节点存在性进入签名（定位↔找回标签切换）
  const store2 = { node: id => (id === 'n1' ? { id } : null), tasksOfProject: async () => [] };
  assert.notEqual(taskPanelEntries({ ...depsBase, tasks: [{ ...base, nodeId: 'n1' }], pending: [], store: store2 })[0].sig, e1.sig);
});

test('taskPanelEntries：pending 行 key=幂等键；受理判断点击时实查（复用旧行不读陈旧快照）', async () => {
  const r = { idempotencyKey: 'k1', nodeId: 'n1', state: 'uncertain', model: 'm1', createdAt: 1 };
  let focused = null, restored = 0;
  const store = {
    node: id => (id === 'n1' ? { id: 'n1', data: { run: { taskId: 't9' } } } : null),
    tasksOfProject: async () => [{ taskId: 't9', idempotencyKey: 'k1' }],
  };
  const runner = { async restorePending() { restored++; return { id: 'n1' }; } };
  const board = { focusNode: id => { focused = id; } };
  const entries = taskPanelEntries({ tasks: [], pending: [r], store, runner, board });
  assert.equal(entries[0].key, 'pending:k1');
  const btn = entries[0].build()._desc().find(b => b.tagName === 'BUTTON');
  assert.equal(btn.textContent, '定位节点', '节点已存在→定位而非恢复');
  btn.click();
  await new Promise(r2 => setTimeout(r2, 0));
  assert.equal(focused, 'n1', '同键任务已受理 → 仅定位节点');
  assert.equal(restored, 0, '已受理时不调 restorePending');
});

test('G3-M1/G4：downloadExpiresAt 进 sig 但非 v2 标记；cancelPhase 等真标记仍翻转谓词', () => {
  const mk = t => taskPanelEntries({ ...depsBase, tasks: [t], pending: [] });
  const base = { taskId: 't1', model: 'm', status: 'completed' };
  const s0 = mk(base)[0].sig;
  // 新语义（官方指南：download_expires_at 是查询响应通用可选字段，非 v2 标记）：
  // legacy completed + 仅加 downloadExpiresAt → 仍是 legacy，canFetchContent 不变（可下载）；
  // 但 sig 必须变化——字段值变化仍触发行级重建（过期时间展示/后续逻辑需要新行）。
  const withExpiry = { ...base, downloadExpiresAt: 1770000000 };
  assert.equal(canFetchContent(base), true);
  assert.equal(canFetchContent(withExpiry), true, '通用字段 downloadExpiresAt 不把 legacy 变 v2——下载保持可用');
  assert.notEqual(mk(withExpiry)[0].sig, s0, 'downloadExpiresAt 必须进 sig（行级刷新口径）');
  // 真 v2 标记字段（cancelPhase/contentReady/stage 任一）→ 受损 v2 → 谓词翻转 + sig 变
  const withCancelPhase = { ...base, cancelPhase: 'requested' };
  assert.equal(canFetchContent(withCancelPhase), false, 'cancelPhase 是 v2 标记：受损 v2 下载禁用');
  assert.notEqual(mk(withCancelPhase)[0].sig, s0, 'cancelPhase 必须进 sig');
  for (const f of ['contentReady', 'stage']) {
    const t = { ...base, [f]: f === 'contentReady' ? false : 'reconciling' };
    assert.equal(canFetchContent(t), false, `${f} 是 v2 标记：受损 v2 下载禁用`);
    assert.notEqual(mk(t)[0].sig, s0, `${f} 必须进 sig`);
  }
});

test('G3-m2：无幂等键 pending 按内容定键——不同记录不复用同一 key', () => {
  const store = { node: () => null, tasksOfProject: async () => [] };
  const runner = { async restorePending() { return null; } };
  const board = { focusNode() {} };
  const r1 = { state: 'uncertain', model: 'm1', createdAt: 1 };
  const r2 = { state: 'rejected', model: 'm1', createdAt: 2 };
  const e1 = taskPanelEntries({ tasks: [], pending: [r1], store, runner, board });
  const e2 = taskPanelEntries({ tasks: [], pending: [r2], store, runner, board });
  assert.notEqual(e1[0].key, e2[0].key, '内容不同的 keyless pending 不得同 key（防错闭包复用）');
  // 同记录重复调用 → key 稳定（增量语义保持，不每轮重建）
  const e1b = taskPanelEntries({ tasks: [], pending: [r1], store, runner, board });
  assert.equal(e1b[0].key, e1[0].key);
  // 有幂等键/节点引用时优先用身份键，不回退内容键
  const r3 = { idempotencyKey: 'k9', state: 'uncertain' };
  assert.equal(taskPanelEntries({ tasks: [], pending: [r3], store, runner, board })[0].key, 'pending:k9');
});

// ---------- C1a：任务面板消费 task-status.js 统一谓词（合同 §8）----------

// R05-A 起任务面板改为统一任务中心：不可下载时不再渲染禁用的「下载成片」，而是不提供「恢复下载」；
// 「本地可用」只来自 runner.localResult 的实体核验（localOf），元数据线索（resultBlobId）不再能点亮它。
const LOCAL_OK = { ready: true, source: 'result' };
const buildWith = (t, local) => taskPanelEntries({ ...depsBase, tasks: [t], pending: [], localOf: () => local })[0].build();

test('C1a 恢复下载=canFetchContent 且本机无已校验文件：v2 completed+!ready 不提供，ready 翻转后提供', () => {
  const build = t => buildWith(t);
  // 旧接口任务（无 executorVersion）：completed 即可下载（legacy 行为不收紧）
  assert.ok(btnOf(build({ taskId: 't1', model: 'm', status: 'completed' }), '恢复下载'));
  assert.equal(btnOf(build({ taskId: 't1', model: 'm', status: 'in_progress' }), '恢复下载'), undefined);
  assert.equal(btnOf(build({ taskId: 't1', model: 'm', status: 'completed', deliveryStatus: 'delivering' }), '恢复下载'), undefined);
  // v2：completed+contentReady!==true → 不提供（验收核心）；contentReady===true → 提供
  const v2wait = build({ taskId: 't2', model: 'm', status: 'completed', executorVersion: 2, contentReady: false });
  assert.equal(btnOf(v2wait, '恢复下载'), undefined, 'v2 completed+!ready 不得提供下载');
  const v2ok = build({ taskId: 't2', model: 'm', status: 'completed', executorVersion: 2, contentReady: true });
  assert.ok(btnOf(v2ok, '恢复下载'), 'v2 ready 后可下载');
  // 受损 v2（缺 executorVersion 带 v2 特征字段）同样按 v2 门槛——不降级
  const damaged = build({ taskId: 't3', model: 'm', status: 'completed', stage: 'succeeded' });
  assert.equal(btnOf(damaged, '恢复下载'), undefined, '受损 v2 不降级 legacy');
  // 已有本机已校验文件：不再下载，改为预览/保存
  const local = buildWith({ taskId: 't2', model: 'm', status: 'completed', executorVersion: 2, contentReady: true }, LOCAL_OK);
  assert.equal(btnOf(local, '恢复下载'), undefined);
  assert.ok(btnOf(local, '预览') && btnOf(local, '保存'));
  // 远端链接过期且本机无文件：不可下载、不可预览；有本机完整文件：仍可预览/保存
  const expiredNoLocal = build({ taskId: 't4', model: 'm', status: 'completed', executorVersion: 2, contentReady: true, downloadExpired: true });
  assert.equal(btnOf(expiredNoLocal, '恢复下载'), undefined);
  assert.equal(btnOf(expiredNoLocal, '预览'), undefined);
  const expiredLocal = buildWith({ taskId: 't4', model: 'm', status: 'completed', executorVersion: 2, contentReady: true, downloadExpired: true }, LOCAL_OK);
  assert.ok(btnOf(expiredLocal, '预览') && btnOf(expiredLocal, '保存'), '链接过期但本机完整文件仍可用');
});

test('C1a badge：v2 未 ready 不显示成功态；「本地文件已校验」只来自实体核验', () => {
  const badge = (t, local) => badgeOf(buildWith(t, local));
  // v2 completed+contentReady!==true → 交付中 busy，绝不 ok
  const unready = badge({ taskId: 't1', model: 'm', status: 'completed', executorVersion: 2, contentReady: false });
  assert.equal(unready.textContent, '已生成 · 交付中');
  assert.ok(unready.classList.contains('busy') && !unready.classList.contains('ok'), 'v2 未 ready 不得显示成功态');
  const deliv = badge({ taskId: 't1', model: 'm', status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'delivering' });
  assert.equal(deliv.textContent, '已生成 · 交付中');
  assert.ok(deliv.classList.contains('busy'));
  // 元数据线索不再冒充本地可用：只有 resultBlobId 而实体未核验 → 待下载，不是 ok
  const hint = badge({ taskId: 't1', model: 'm', status: 'completed', executorVersion: 2, contentReady: true, resultBlobId: 'b1' });
  assert.equal(hint.textContent, '已生成 · 待下载到本机');
  assert.ok(!hint.classList.contains('ok'), 'resultBlobId 不能点亮本地可用');
  const hintMissing = badge({ taskId: 't1', model: 'm', status: 'completed', executorVersion: 2, contentReady: true, resultBlobId: 'b1' }, { ready: false, reason: 'blob_missing' });
  assert.ok(!hintMissing.classList.contains('ok'));
  const local = badge({ taskId: 't1', model: 'm', status: 'completed', executorVersion: 2, contentReady: true }, LOCAL_OK);
  assert.equal(local.textContent, '本地文件已校验');
  assert.ok(local.classList.contains('ok'));
  // 管线相位
  assert.equal(badge({ taskId: 't1', model: 'm', status: 'in_progress' }).textContent, '生成中');
  assert.equal(badge({ taskId: 't1', model: 'm', status: 'in_progress', stage: 'reconciling' }).textContent, '服务器核对中');
  assert.equal(badge({ taskId: 't1', model: 'm', status: 'queued' }).textContent, '已受理');
  assert.equal(badge({ taskId: 't1', model: 'm', status: 'submitting' }).textContent, '准备中');
  const failed = badge({ taskId: 't1', model: 'm', status: 'failed', terminalEvidence: 'server_status' });
  assert.equal(failed.textContent, '服务器生成失败');
  assert.ok(failed.classList.contains('err'));
  // 关系相位：paused+密钥不匹配 → 需原密钥；detached → 已脱离节点
  const needKey = badge({ taskId: 't1', model: 'm', status: 'in_progress', paused: true, keyFp: 'other' });
  assert.equal(needKey.textContent, '需原密钥');
  assert.ok(needKey.classList.contains('warn'));
  const det = badge({ taskId: 't1', model: 'm', status: 'in_progress', detached: true });
  assert.equal(det.textContent, '已脱离节点');
  assert.ok(det.classList.contains('warn'));
});

test('C1a 动作显隐：请求取消仅 v2 在途；停止本地等待/继续查询；创建新版本仅终态', () => {
  const build = t => buildWith(t);
  // 旧接口任务：不显示「请求取消」（不虚假开放取消）
  const legacy = build({ taskId: 't1', model: 'm', status: 'in_progress' });
  assert.equal(btnOf(legacy, '请求取消'), undefined);
  assert.ok(btnOf(legacy, '停止本地等待'), '在途未暂停 → 停止本地等待');
  assert.equal(btnOf(legacy, '创建新版本'), undefined, '未终结不显示创建新版本');
  const v2live = build({ taskId: 't2', model: 'm', status: 'in_progress', executorVersion: 2 });
  assert.ok(btnOf(v2live, '请求取消'), 'v2 在途显示请求取消');
  // 已请求取消 → 按钮消失 + 提示出现
  const canceling = build({ taskId: 't2', model: 'm', status: 'in_progress', executorVersion: 2, cancelRequested: true });
  assert.equal(btnOf(canceling, '请求取消'), undefined);
  assert.ok(canceling._desc().some(n => String(n.textContent).includes('已请求停止后续尝试')), '已请求取消显示提示');
  // 暂停 → 继续查询；终态 → 创建新版本
  assert.ok(btnOf(build({ taskId: 't1', model: 'm', status: 'in_progress', paused: true }), '继续查询'));
  const settled = build({ taskId: 't1', model: 'm', status: 'completed' });
  assert.ok(btnOf(settled, '创建新版本'), '服务器侧终结 → 创建新版本');
  assert.equal(btnOf(settled, '停止本地等待'), undefined);
  assert.equal(btnOf(settled, '请求取消'), undefined);
  // v2 completed+!ready：未终结 → 仍可停止本地等待、请求取消，不可创建新版本
  const unready = build({ taskId: 't2', model: 'm', status: 'completed', executorVersion: 2, contentReady: false });
  assert.ok(btnOf(unready, '停止本地等待'), 'v2 未 ready 仍属在途');
  assert.ok(btnOf(unready, '请求取消'), 'v2 未 ready 仍可请求取消');
  assert.equal(btnOf(unready, '创建新版本'), undefined);
  // 任何状态都没有含糊的「重试」
  for (const t of [legacy, v2live, canceling, settled, unready]) assert.equal(btnOf(t, '重试'), undefined);
});

test('C1a 动作行为：停止本地等待→setPollPaused；创建新版本→editor.duplicate', async () => {
  let pausedArg = null, dupArg = null, focused = null;
  const deps = {
    ...depsBase,
    runner: { ...depsBase.runner, setPollPaused: async (id, p) => { pausedArg = [id, p]; } },
    editor: { duplicate: ids => { dupArg = ids; return [{ id: 'n1-copy' }]; } },
    board: { focusNode: id => { focused = id; } },
    store: { node: id => (id === 'n1' ? { id: 'n1' } : null), tasksOfProject: async () => [] },
  };
  const live = taskPanelEntries({ ...deps, tasks: [{ taskId: 't1', projectId: 'p1', model: 'm', status: 'in_progress' }], pending: [] })[0].build();
  btnOf(live, '停止本地等待').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(pausedArg, ['t1', true]);
  const settled = taskPanelEntries({ ...deps, tasks: [{ taskId: 't1', projectId: 'p1', model: 'm', status: 'completed', nodeId: 'n1' }], pending: [] })[0].build();
  btnOf(settled, '创建新版本').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(dupArg, ['n1'], '复制原节点参数与连线');
  assert.equal(focused, 'n1-copy');
});

test('C1a 静态防线：main.js 任务面板已接统一谓词与核心本地实体接口', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /from '\.\/task-status\.js'/, '导入 task-status 模块');
  assert.match(src, /canFetchContent\(t\)/, '恢复下载=canFetchContent');
  assert.match(src, /taskPhase\(t, \{ keyFp, accountSubject \}\)/, '管线相位=taskPhase(rec,{keyFp,accountSubject})（托管按已核验账户）');
  assert.match(src, /canRequestCancel\(t\)/, '请求取消=canRequestCancel');
  assert.match(src, /isSettled\(t\)/, '创建新版本=任务终结谓词');
  assert.match(src, /needsTracking\(t\)/, '轮询开关=needsTracking 层');
  assert.match(src, /runner\.localResult\(t\.taskId, t\.projectId\)/, '本地可用=runner.localResult 实体核验');
  assert.match(src, /runner\.requery\(t\.taskId, t\.projectId\)/, '继续查询=runner.requery');
  assert.match(src, /releaseResultURL/, 'resultURL 成对释放');
  assert.ok(!/hasLocalResult\(/.test(src), '元数据线索 hasLocalResult 不再决定「本地可用」');
  assert.ok(!/status === 'completed' && .*deliveryStatus !== 'delivering'/.test(src),
    '任务面板不再有散落的 completed+delivering 手写判断');
});

test('workflowScopeTargets：空选择=空集不回落全画布；all 显式；分组仅存活成员', () => {
  const nodes = [
    { id: 'a', type: 'text' }, { id: 'b', type: 'gen' }, { id: 'c', type: 'image' },
    { id: 'd', type: 'utility' }, { id: 'e', type: 'asset' }, { id: 'f', type: 'note' },
  ];
  assert.deepEqual(workflowScopeTargets('selection', { selectedIds: [], nodes }), [],
    '空选择=空集（§6.2：targets=[] 不再等价全画布）');
  assert.deepEqual(workflowScopeTargets('selection', { selectedIds: ['a', 'e'], nodes }), ['a', 'e']);
  assert.deepEqual(workflowScopeTargets(undefined, { selectedIds: ['a'], nodes }), ['a'], '缺省按 selection 语义');
  assert.deepEqual(workflowScopeTargets('all', { nodes }), ['a', 'b', 'c', 'd'], 'all 仅可运行类型（asset/note 排除）');
  const groups = [{ id: 'g1', members: ['a', 'ghost', 'b'] }, { id: 'g2', members: [] }, { id: 'g3', members: ['ghost'] }];
  assert.deepEqual(workflowScopeTargets('group:g1', { groups, nodes }), ['a', 'b'], '分组只含存活成员');
  assert.throws(() => workflowScopeTargets('group:gX', { groups, nodes }), /已删除或没有节点/);
  assert.throws(() => workflowScopeTargets('group:g2', { groups, nodes }), /已删除或没有节点/);
  assert.throws(() => workflowScopeTargets('group:g3', { groups, nodes }), /没有可运行节点/);
});

test('main.js 静态防线：增量重铺与空选择守卫已接线', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /reconcileKeyedList\(list, entries\)/, 'refreshTasks 走键控增量重铺');
  assert.match(src, /当前选择（空选择不启动）/, '范围文案明示空选择不启动');
  assert.match(src, /emptyScopeRefusal/, '预检/启动均有空选择拒绝守卫');
  assert.ok(!src.includes('未选中时为全部'), '旧「未选中时为全部」回落语义已移除');
  assert.match(src, /runner\.restoreTask\(t\.taskId\)/, '任务行找回入口保持');
  assert.match(src, /runner\.restorePending\(r\.idempotencyKey\)/, 'pending 行恢复入口保持');
  assert.match(src, /runner\.download\(t\.taskId\)/, '任务行下载入口保持');
  assert.match(src, /typeof document !== 'undefined'\) boot/, '无 DOM 环境守卫：模块可导入测试');
});
