// 冲突恢复入口（功能修复）UI 测试：node --test frontend/canvas/tests/review-conflict-ui.test.mjs
// 覆盖：冲突清单渲染 / saveCopy / reload / 失败保留草稿提示 / 操作中禁重点击 /
// modal 代次守卫（关面板不回写、不重开）/ 项目切换守卫（不对新项目生效）。
// 极简 DOM 桩仅注入 globalThis.document——不修改任何业务模块与业务全局。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectHub } from '../src/project-hub.js';

// ---------- 极简 DOM 桩 ----------
class StubEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.className = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.style = {};
    const self = this;
    this.classList = {
      add: (...cs) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); for (const c of cs) s.add(c); self.className = [...s].join(' '); },
      remove: (...cs) => { self.className = self.className.split(/\s+/).filter(x => x && !cs.includes(x)).join(' '); },
      contains: c => self.className.split(/\s+/).includes(c),
      toggle: (c, force) => { const on = force === undefined ? !self.classList.contains(c) : !!force; on ? self.classList.add(c) : self.classList.remove(c); return on; },
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent ?? '').join(''); }
  set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; }
  get childElementCount() { return this.children.length; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners[type]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }
  append(...cs) {
    for (const c of cs.flat()) {
      if (c == null) continue;
      const n = typeof c === 'object' ? c : Object.assign(new StubEl('#text'), { _text: String(c) });
      n.parentNode = this;
      this.children.push(n);
    }
  }
  appendChild(c) { this.append(c); return c; }
  prepend(...cs) { for (const c of cs.flat()) { if (c == null) continue; c.parentNode = this; this.children.unshift(c); } }
  replaceChildren(...cs) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...cs); }
  remove() { const p = this.parentNode; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  matches(sel) {
    const one = s0 => {
      let s = s0.trim();
      if (!s) return false;
      let attr = null;
      const am = s.match(/\[[\w-]+(?:="[^"]*")?\]/);
      if (am) { attr = am[0].slice(1, -1); s = s.replace(am[0], ''); }
      let cls = null;
      const cm = s.match(/\.[\w-]+/);
      if (cm) { cls = cm[0].slice(1); s = s.replace(cm[0], ''); }
      const tag = s.trim();
      if (tag && tag !== '*' && this.tagName !== tag.toUpperCase()) return false;
      if (cls && !this.classList.contains(cls)) return false;
      if (attr) {
        const eq = attr.indexOf('=');
        const k = eq < 0 ? attr : attr.slice(0, eq);
        const want = eq < 0 ? null : attr.slice(eq + 1).replace(/^"|"$/g, '');
        const v = this.getAttribute(k);
        if (v === null) return false;
        if (want !== null && v !== want) return false;
      }
      return true;
    };
    return String(sel).split(',').some(one);
  }
  closest(sel) { for (let x = this; x; x = x.parentNode) if (typeof x.matches === 'function' && x.matches(sel)) return x; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of n.children ?? []) { if (typeof c.matches === 'function' && c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  click() { if (this.disabled) return; this.dispatch('click', { target: this }); }   // 与真实 DOM 一致：disabled 不派发
  dispatch(type, ev = {}) { ev.type = type; ev.target ??= this; for (const f of [...(this.listeners[type] ?? [])]) f(ev); }
}

function installDom(t) {
  const prev = globalThis.document;
  const body = new StubEl('body');
  const docListeners = Object.create(null);
  const doc = {
    body,
    activeElement: null,
    createElement: tag => new StubEl(tag),
    getElementById(id) {
      const q = [body];
      while (q.length) {
        const n = q.shift();
        if (typeof n.getAttribute === 'function' && n.getAttribute('id') === id) return n;
        q.push(...(n.children ?? []));
      }
      return null;
    },
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
    removeEventListener: (type, fn) => { const l = docListeners[type]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); },
  };
  globalThis.document = doc;
  const toastRoot = new StubEl('div'); toastRoot.setAttribute('id', 'toast-root');
  const overlayRoot = new StubEl('div'); overlayRoot.setAttribute('id', 'overlay-root');
  body.append(toastRoot, overlayRoot);
  t.after(() => { globalThis.document = prev; });
  return { doc, body, toastRoot, overlayRoot };
}

// ---------- 内存 storage + store 桩（按任务给定的 store 契约接线）----------
function makeDeps({ projects = [], project = null, conflicts = {}, resolveImpl } = {}) {
  const mem = new Map();
  const storage = {
    get: async k => (mem.has(k) ? mem.get(k) : null),
    set: async (k, v) => { mem.set(k, v); return v; },
    keys: async () => [...mem.keys()],
  };
  const conflictMap = new Map(Object.entries(conflicts));
  const calls = [];
  const updates = [];
  // 默认契约语义：saveCopy 清冲突（副本另存+源载入外部稿）；reload 保留冲突快照供随后另存
  const impl = resolveImpl ?? ((pid, mode, cm) => {
    if (mode === 'saveCopy') { cm.delete(pid); return { copyId: `copy-${pid}` }; }
    return { reloaded: true };
  });
  const store = {
    calls,
    project,
    async listProjects() { return projects; },
    async listConflicts() { return [...conflictMap.keys()]; },
    async getConflict(pid) { return conflictMap.get(pid ?? store.project?.id) ?? null; },
    async resolveConflict(pid, mode) { calls.push({ pid, mode }); return impl(pid, mode, conflictMap); },
    // 显式守卫：本修复绝不走覆盖/丢弃路径——若被调用立即失败暴露
    async overwrite() { throw new Error('不应调用 overwrite'); },
    async discard() { throw new Error('不应调用 discard'); },
    async flush() {}, touch() {}, onChange() {},
    async renameProject() {}, async duplicateProject() { return { id: 'dup' }; },
    async trashProject() {}, async untrashProject() {},
    async openProject(id) { store.project = projects.find(p => p.id === id) ?? store.project; },
    async exportJSON() { return '{}'; }, async importJSON() { return { id: 'imp' }; },
  };
  const deps = {
    store, storage,
    submitLock: { request: (n, fn) => fn() },
    onUpdate: () => updates.push(store.project?.id),
    editor: { checkpoint() {} },
  };
  return { deps, store, storage, calls, updates, conflictMap };
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const walk = (n, out = []) => { for (const c of n.children ?? []) { out.push(c); walk(c, out); } return out; };
const byText = (root, text) => walk(root).find(c => c.tagName === 'BUTTON' && String(c.textContent).includes(text));

test('冲突清单：显示项目名/存储版本/当前标记，内联呈现不自动开额外弹窗', async t => {
  const { overlayRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  const B = { id: 'pB', name: '乙项目', rev: 5 };
  const { deps } = makeDeps({
    projects: [A, B], project: A,
    conflicts: {
      pA: { projectId: 'pA', storedRev: 8, at: 1720000000000, blocking: true },
      pB: { projectId: 'pB', storedRev: 9, at: 1720000001000, blocking: false },
    },
  });
  const hub = createProjectHub(deps);
  const panel = hub.open();
  await flush();
  const txt = overlayRoot.textContent;
  assert.match(txt, /本地冲突/);
  assert.match(txt, /甲项目/);
  assert.match(txt, /乙项目/);
  assert.match(txt, /r8/);
  assert.match(txt, /r9/);
  assert.match(txt, /当前项目/);
  assert.ok(byText(overlayRoot, '另存本地副本'), '存在「另存本地副本」操作');
  assert.ok(byText(overlayRoot, '加载外部版本'), '存在「加载外部版本（保留本地草稿）」操作');
  assert.equal(overlayRoot.childElementCount, 1, '只有项目中枢一个弹窗，不自动开额外弹窗抢焦点');
  panel.close();
});

test('另存本地副本：以点击行捕获的 pid 调 resolveConflict(saveCopy)，成功后清单清空', async t => {
  const { overlayRoot, toastRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  const B = { id: 'pB', name: '乙项目', rev: 5 };
  const { deps, calls, updates, conflictMap } = makeDeps({
    projects: [A, B], project: A,
    conflicts: { pB: { projectId: 'pB', storedRev: 9, at: 1, blocking: true } },
  });
  const hub = createProjectHub(deps);
  hub.open();
  await flush();
  const saveBtn = byText(overlayRoot, '另存本地副本');
  assert.ok(saveBtn);
  saveBtn.click();
  assert.equal(saveBtn.disabled, true, '操作中禁重点击');
  saveBtn.click();   // 禁用态重复点击不得重复调用
  await flush();
  assert.deepEqual(calls, [{ pid: 'pB', mode: 'saveCopy' }], '以被点行捕获的 pid（非当前项目）调用，仅一次');
  assert.equal(conflictMap.has('pB'), false);
  assert.match(toastRoot.textContent, /另存|副本/);
  assert.equal(updates.length, 0, '另存其他项目不重绘当前画布；清单独立刷新');
  assert.doesNotMatch(overlayRoot.textContent, /本地冲突/, '冲突清理后清单消失');
});

test('加载外部版本（保留本地草稿）：resolveConflict(reload)，不触碰 overwrite/discard', async t => {
  const { overlayRoot, toastRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  const { deps, calls, updates } = makeDeps({
    projects: [A], project: A,
    conflicts: { pA: { projectId: 'pA', storedRev: 8, at: 1, blocking: true } },
  });
  const hub = createProjectHub(deps);
  hub.open();
  await flush();
  const loadBtn = byText(overlayRoot, '加载外部版本');
  assert.ok(loadBtn);
  loadBtn.click();
  await flush();
  assert.deepEqual(calls, [{ pid: 'pA', mode: 'reload' }]);
  assert.match(toastRoot.textContent, /外部版本/);
  assert.match(toastRoot.textContent, /保留|快照/);
  assert.equal(updates.length, 1);
  assert.match(overlayRoot.textContent, /本地冲突/, 'reload 保留冲突快照，清单仍可随后另存');
});

test('失败路径：显式提示草稿仍保留、按钮恢复可点、冲突仍在', async t => {
  const { overlayRoot, toastRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  const { deps, calls, conflictMap } = makeDeps({
    projects: [A], project: A,
    conflicts: { pA: { projectId: 'pA', storedRev: 8, at: 1, blocking: true } },
    resolveImpl: () => { throw new Error('存储仍被外部更新'); },
  });
  const hub = createProjectHub(deps);
  hub.open();
  await flush();
  const saveBtn = byText(overlayRoot, '另存本地副本');
  saveBtn.click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(conflictMap.has('pA'), true, '失败不清理冲突');
  assert.equal(saveBtn.disabled, false, '失败后按钮恢复可重试');
  assert.match(toastRoot.textContent, /失败|未完成/);
  assert.match(toastRoot.textContent, /保留/);
  assert.match(overlayRoot.textContent, /本地冲突/, '清单仍显示冲突');
});

test('modal 代次守卫：面板关闭后异步返回不回写、不重开已关面板', async t => {
  const { overlayRoot, toastRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  let release;
  const { deps, updates } = makeDeps({
    projects: [A], project: A,
    conflicts: { pA: { projectId: 'pA', storedRev: 8, at: 1, blocking: true } },
    resolveImpl: () => new Promise(r => { release = r; }),
  });
  const hub = createProjectHub(deps);
  const panel = hub.open();
  await flush();
  byText(overlayRoot, '另存本地副本').click();
  panel.close();
  assert.equal(overlayRoot.childElementCount, 0, '面板已关闭');
  release({ copyId: 'copy-1' });
  await flush();
  assert.equal(overlayRoot.childElementCount, 0, '异步返回后不重新打开已关面板');
  assert.equal(updates.length, 0, '不触发已关面板衍生的画布刷新');
  assert.match(toastRoot.textContent, /副本/, '全局结果提示仍可见');
});

test('项目切换守卫：await 期间切走项目，返回结果不对新项目生效', async t => {
  const { overlayRoot } = installDom(t);
  const A = { id: 'pA', name: '甲项目', rev: 3 };
  const B = { id: 'pB', name: '乙项目', rev: 5 };
  let release;
  const { deps, calls, updates } = makeDeps({
    projects: [A, B], project: A,
    conflicts: { pA: { projectId: 'pA', storedRev: 8, at: 1, blocking: true } },
    resolveImpl: () => new Promise(r => { release = r; }),
  });
  const hub = createProjectHub(deps);
  const panel = hub.open();
  await flush();
  byText(overlayRoot, '加载外部版本').click();
  deps.store.project = B;   // 模拟 await 期间切走项目
  release({ reloaded: true });
  await flush();
  assert.deepEqual(calls, [{ pid: 'pA', mode: 'reload' }], '仍以点击时捕获的 pid 调用');
  assert.equal(updates.length, 0, '切走后不触发本面板刷新（不对新项目生效）');
  panel.close();
});

test('降级：store 无冲突接口时面板照常渲染、清单为空', async t => {
  const { overlayRoot } = installDom(t);
  const { deps, store } = makeDeps({ projects: [{ id: 'pA', name: '甲项目', rev: 1 }], project: { id: 'pA', name: '甲项目', rev: 1 } });
  delete store.listConflicts;
  const hub = createProjectHub(deps);
  const panel = hub.open();
  await flush();
  assert.match(overlayRoot.textContent, /项目中枢/);
  assert.match(overlayRoot.textContent, /版本/);
  assert.doesNotMatch(overlayRoot.textContent, /本地冲突/);
  panel.close();
});
