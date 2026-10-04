// 审查修复的非 GPU 单元回归：极简 DOM 桩直接驱动 board.js / ui.js 的事件路径。
// 覆盖：R04 任务驱动节点体随 render 刷新且不打断编辑焦点、R06 弹窗/IME/控件聚焦时
//       Delete/Backspace 不删背景、R07 画布外松开/pointercancel/Esc 清理拖线且普通点击不接线、
//       R15 输出端口圆点顺序、modal Esc 只关最上层、confirmDialog 关闭视为取消。
// 真实浏览器复现回归由 e2e-safety-fixes.test.mjs 负责；本文件只需 node --test。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { el, modal, confirmDialog } from '../src/ui.js';
import { createBoard } from '../src/board.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 极简 DOM 桩（只实现被测代码用到的 API）----------
function matchSimple(node, s) {
  const m = s.match(/^([a-zA-Z*][\w-]*)?(.*)$/s);
  if (!m) return false;
  if (m[1] && m[1] !== '*' && node.tagName !== m[1].toUpperCase()) return false;
  const rest = m[2] ?? '';
  const re = /([.#])([\w-]+)|\[([\w-]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g;
  let pos = 0, t;
  while ((t = re.exec(rest))) {
    if (t.index !== pos) return false;                    // 不支持的 token（如 :not）→ 不匹配
    if (t[1] === '.') { if (!node._hasCls(t[2])) return false; }
    else if (t[1] === '#') { if (node.id !== t[2]) return false; }
    else {
      if (!node.hasAttribute(t[3])) return false;
      if (t[4] !== undefined && node.getAttribute(t[3]) !== t[4]) return false;
    }
    pos = re.lastIndex;
  }
  return pos === rest.length;
}
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parent = null;
    this.children = [];
    this._l = new Map();                                   // type → [{fn, cap}]
    this._attrs = new Map();
    this.dataset = {};
    this.style = {};
    this._cls = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.id = '';
    this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); }
  _hasCls(c) { return this._cls.split(/\s+/).includes(c); }
  get classList() {
    const self = this;
    return {
      add(...cs) { const s = new Set(self._cls.split(/\s+/).filter(Boolean)); for (const c of cs) s.add(c); self._cls = [...s].join(' '); },
      remove(...cs) { const s = new Set(self._cls.split(/\s+/).filter(Boolean)); for (const c of cs) s.delete(c); self._cls = [...s].join(' '); },
      toggle(c, f) { const has = self._hasCls(c); const want = f === undefined ? !has : !!f; if (want) this.add(c); else this.remove(c); return want; },
      contains(c) { return self._hasCls(c); },
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get lastElementChild() { return this.lastChild; }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k === 'id') this.id = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  hasAttribute(k) { return this._attrs.has(k); }
  addEventListener(type, fn, opt) { const l = this._l.get(type) ?? this._l.set(type, []).get(type); l.push({ fn, cap: opt === true || opt?.capture === true }); }
  removeEventListener(type, fn, opt) {
    const l = this._l.get(type); if (!l) return;
    const cap = opt === true || opt?.capture === true;
    const i = l.findIndex(h => h.fn === fn && h.cap === cap);
    if (i >= 0) l.splice(i, 1);
  }
  append(...cs) {
    for (const c of cs.flat()) {
      if (c == null) continue;
      const n = c instanceof El ? c : Object.assign(new El('#text'), { _text: String(c) });
      n.remove(); n.parent = this; this.children.push(n);
    }
  }
  prepend(...cs) {
    for (const c of cs.flat()) {
      if (c == null) continue;
      const n = c instanceof El ? c : Object.assign(new El('#text'), { _text: String(c) });
      n.remove(); n.parent = this; this.children.unshift(n);
    }
  }
  replaceChildren(...cs) { for (const c of this.children) c.parent = null; this.children = []; this.append(...cs); }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n instanceof El && n.matches(sel)) return n; return null; }
  matches(sel) { return sel.split(',').some(s => matchSimple(this, s.trim())); }
  _desc(out = []) { for (const c of this.children) { out.push(c); c._desc(out); } return out; }
  querySelector(sel) { for (const s of sel.split(',')) { const r = qs(this, s.trim()); if (r) return r; } return null; }
  querySelectorAll(sel) { const out = []; for (const s of sel.split(',')) out.push(...qsAll(this, s.trim())); return out; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() { DOC.activeElement = this; }
  blur() { if (DOC.activeElement === this) DOC.activeElement = null; }
  click() { fire(this, 'click'); }
}
function qs(root, s) {
  const parts = s.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  for (const c of root._desc()) {
    if (!c.matches(last)) continue;
    let cur = c.parent, i = parts.length - 2, ok = true;
    while (i >= 0) {
      while (cur && cur !== root && !cur.matches(parts[i])) cur = cur.parent;
      if (!cur || cur === root) { ok = false; break; }
      cur = cur.parent; i--;
    }
    if (ok) return c;
  }
  return null;
}
function qsAll(root, s) {
  const parts = s.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return root._desc().filter(c => {
    if (!c.matches(last)) return false;
    let cur = c.parent, i = parts.length - 2;
    while (i >= 0) {
      while (cur && cur !== root && !cur.matches(parts[i])) cur = cur.parent;
      if (!cur || cur === root) return false;
      cur = cur.parent; i--;
    }
    return true;
  });
}
function mkTarget() {
  return {
    _l: new Map(),
    addEventListener(t, fn, opt) { const l = this._l.get(t) ?? this._l.set(t, []).get(t); l.push({ fn, cap: opt === true || opt?.capture === true }); },
    removeEventListener(t, fn, opt) {
      const l = this._l.get(t); if (!l) return;
      const cap = opt === true || opt?.capture === true;
      const i = l.findIndex(h => h.fn === fn && h.cap === cap);
      if (i >= 0) l.splice(i, 1);
    },
  };
}

const DOC = mkTarget();
const WIN = mkTarget();
const html = new El('html');
const body = new El('body');
html.append(body);
const topbar = new El('header'); topbar.id = 'topbar';
const boardEl = new El('div'); boardEl.id = 'board';
const edgesSvg = new El('svg'); edgesSvg.id = 'edges';
const nodesEl = new El('div'); nodesEl.id = 'nodes';
boardEl.append(edgesSvg, nodesEl);
boardEl.rect = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
const overlay = new El('div'); overlay.id = 'overlay-root';
const toastRoot = new El('div'); toastRoot.id = 'toast-root';
body.append(topbar, boardEl, overlay, toastRoot);
Object.assign(DOC, {
  _byId: new Map(Object.entries({ board: boardEl, nodes: nodesEl, edges: edgesSvg, 'overlay-root': overlay, 'toast-root': toastRoot, topbar })),
  _hit: null,
  activeElement: null,
  body,
  documentElement: html,
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
});
DOC.getElementById = id => DOC._byId.get(id) ?? null;
DOC.elementFromPoint = () => DOC._hit;
globalThis.document = DOC;
globalThis.window = WIN;

// 捕获/冒泡双阶段事件派发：capture 监听从 window 向下，冒泡从 target 向上
function fire(target, type, props = {}) {
  const path = [];
  for (let n = target; n; n = n.parent) path.push(n);
  path.push(DOC, WIN);
  const e = {
    type, target, currentTarget: null, defaultPrevented: false, _stop: false, _stopIm: false,
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._stopIm = true; },
    preventDefault() { this.defaultPrevented = true; },
    composedPath() { return path; },
    ...props,
  };
  for (let i = path.length - 1; i >= 0 && !e._stop; i--) {
    const n = path[i]; e.currentTarget = n;
    for (const h of n._l?.get(type) ?? []) { if (h.cap) { h.fn(e); if (e._stopIm) break; } }
  }
  for (let i = 0; i < path.length && !e._stop; i++) {
    const n = path[i]; e.currentTarget = n;
    for (const h of n._l?.get(type) ?? []) { if (!h.cap) { h.fn(e); if (e._stopIm) break; } }
  }
  return e;
}

async function freshCanvas() {
  nodesEl.replaceChildren(); edgesSvg.replaceChildren(); overlay.replaceChildren(); toastRoot.replaceChildren();
  DOC._hit = null; DOC.activeElement = null;
  DOC._l.clear(); WIN._l.clear();
  const store = createStore(createMemoryStorage());
  await store.newProject('t');
  return store;
}
const rootOf = id => nodesEl.children.find(c => c.dataset.node === id);

// ---------- R07 ----------
test('R07 拖线在画布外松开/cancel/Esc 均清理 wire，普通点击不接线', async () => {
  const store = await freshCanvas();
  const g1 = store.addNode('gen', 60, 120, { draft: {}, run: null });
  const g2 = store.addNode('gen', 420, 120, { draft: {}, run: null });
  let sel = null; const edgeEvts = [];
  createBoard({
    store,
    renderBody: n => el('div', { class: `body-${n.type}` }),
    kindOf: n => (n.type === 'gen' ? 'video' : 'media'),
    onSelect: s => { sel = s; },
    onEdgesChanged: e => edgeEvts.push(e),
  }).render();
  const outRow = rootOf(g1.id).querySelector('.port.out');
  const refsRow2 = rootOf(g2.id).querySelector('.port[data-port="refs"]');
  const refsRow1 = rootOf(g1.id).querySelector('.port[data-port="refs"]');
  assert.ok(outRow && refsRow1 && refsRow2, '端口已渲染');

  // a) 画布外（顶栏）松开 → wire 清除 → 之后点击输入端口不得接线
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 1, button: 0 });
  assert.equal(edgesSvg.children.length, 1, '拖线预览出现');
  fire(topbar, 'pointermove', { clientX: 500, clientY: 20, pointerId: 1 });
  DOC._hit = topbar;
  fire(topbar, 'pointerup', { clientX: 500, clientY: 20, pointerId: 1 });
  assert.equal(edgesSvg.children.length, 0, '画布外松开后预览清除');
  DOC._hit = refsRow2;
  fire(refsRow2, 'pointerdown', { clientX: 420, clientY: 160, pointerId: 1 });
  fire(refsRow2, 'pointerup', { clientX: 420, clientY: 160, pointerId: 1 });
  assert.equal(store.project.edges.length, 0, '普通点击不得复用已结束的拖线');
  assert.equal(sel?.id, g2.id, '普通点击仍可选中节点');

  // b) Esc 取消
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 2 });
  assert.equal(edgesSvg.children.length, 1);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(edgesSvg.children.length, 0, 'Esc 清除拖线预览');
  DOC._hit = refsRow2;
  fire(refsRow2, 'pointerdown', { clientX: 420, clientY: 160, pointerId: 2 });
  fire(refsRow2, 'pointerup', { clientX: 420, clientY: 160, pointerId: 2 });
  assert.equal(store.project.edges.length, 0, 'Esc 后点击不接线');

  // c) pointercancel 取消
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 3 });
  fire(outRow, 'pointercancel', { pointerId: 3 });
  assert.equal(edgesSvg.children.length, 0, 'pointercancel 清除拖线预览');
  assert.equal(store.project.edges.length, 0);

  // d) 正常拖线到另一节点 refs 口仍然接线（对照）
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 4 });
  DOC._hit = refsRow2;
  fire(refsRow2, 'pointerup', { clientX: 420, clientY: 160, pointerId: 4 });
  assert.equal(store.project.edges.length, 1, '正常拖线仍应接线');
  assert.equal(edgeEvts.length, 1, 'onEdgesChanged 回调触发');

  // e) 自连/类型不符 → 拒绝且不静默（toast 可见）
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 5 });
  DOC._hit = refsRow1;
  fire(refsRow1, 'pointerup', { clientX: 60, clientY: 160, pointerId: 5 });
  assert.equal(store.project.edges.length, 1, '自连不新增边');
  assert.ok(toastRoot.children.length >= 1, '拒绝原因有可见提示');

  // f) Esc 取消进行中的节点拖动手势
  const head1 = rootOf(g1.id).querySelector('.node-head');
  fire(head1, 'pointerdown', { clientX: 100, clientY: 130, pointerId: 6, button: 0 });
  const beforeX = g1.x;
  fire(head1, 'pointermove', { clientX: 300, clientY: 400, pointerId: 6 });
  await new Promise(resolve => setTimeout(resolve, 20)); // 等待本地rAF回退帧提交
  assert.notEqual(g1.x, beforeX, '拖动中节点跟随指针');
  fire(body, 'keydown', { key: 'Escape' });
  const afterEsc = g1.x;
  fire(head1, 'pointermove', { clientX: 999, clientY: 999, pointerId: 6 });
  assert.equal(g1.x, afterEsc, 'Esc 后拖动监听已移除，节点不再跟随');
});

// ---------- R06 ----------
test('R06 弹窗/组合输入/控件聚焦时 Delete·Backspace 不删背景图', async () => {
  const store = await freshCanvas();
  const g1 = store.addNode('gen', 60, 120, { draft: {}, run: null });
  const api = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' });
  api.render();
  api.select('node', g1.id);

  const m = modal(el('div', {}, el('button', { class: 'mb', text: '保存' })));
  const mb = overlay.querySelector('.mb');
  fire(mb, 'keydown', { key: 'Delete' });
  assert.ok(store.node(g1.id), '弹窗内 Delete 不得穿透删除节点');
  fire(mb, 'keydown', { key: 'Backspace' });
  assert.ok(store.node(g1.id), '弹窗内 Backspace 同样隔离');
  m.close();
  assert.equal(overlay.childElementCount, 0);

  const inp = el('input'); body.append(inp); inp.focus();
  fire(inp, 'keydown', { key: 'Delete' });
  assert.ok(store.node(g1.id), '输入控件聚焦时不删');
  fire(body, 'keydown', { key: 'Delete', isComposing: true });
  assert.ok(store.node(g1.id), 'IME 组合输入期间不删');
  fire(body, 'keydown', { key: 'Delete' });
  assert.equal(store.node(g1.id), null, '画布焦点下 Delete 正常删除');
  inp.remove();
});

// ---------- R04 ----------
test('R04 gen 节点体随 render 刷新任务状态；编辑焦点与非任务节点不重建', async () => {
  const store = await freshCanvas();
  const g1 = store.addNode('gen', 60, 120, { draft: {}, run: { status: 'queued' } });
  const note = store.addNode('note', 60, 420, { text: 'x' });
  const bodies = new Map();
  const api = createBoard({
    store,
    renderBody: n => { const b = el('div', { class: `body-${n.type}`, text: n.data.run?.status ?? 'note' }); bodies.set(n.id, b); return b; },
    kindOf: () => 'media',
  });
  api.render();
  const g1Root = rootOf(g1.id);
  const genBody1 = bodies.get(g1.id), noteBody1 = bodies.get(note.id);
  g1.data.run = { status: 'completed' };
  api.render();                                            // 等同 putRec → onUpdate → board.render
  assert.notEqual(bodies.get(g1.id), genBody1, 'gen 节点体随任务状态刷新');
  assert.ok(g1Root.querySelector('.body-gen').textContent.includes('completed'), '节点体显示最新状态');
  assert.equal(bodies.get(note.id), noteBody1, '非任务驱动节点不重建');

  const inp = el('input'); g1Root.children[1].append(inp); inp.focus();   // 焦点进入节点体
  const genBody2 = bodies.get(g1.id);
  g1.data.run = { status: 'failed' };
  api.render();
  assert.equal(bodies.get(g1.id), genBody2, '节点体内编辑焦点不被打断');
  inp.blur();
  api.render();
  assert.notEqual(bodies.get(g1.id), genBody2, '失焦后恢复刷新');
});

// ---------- R15 ----------
test('R15 输出端口圆点殿后于标签；CSS 保留外悬与右对齐', async () => {
  const store = await freshCanvas();
  const g1 = store.addNode('gen', 60, 120, { draft: {}, run: null });
  createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' }).render();
  const root = rootOf(g1.id);
  const outRow = root.querySelector('.port.out');
  assert.ok(outRow.children.at(-1)._hasCls('dot'), '输出端口圆点殿后，标签不再被覆盖');
  assert.ok(!outRow.children[0]._hasCls('dot'), '输出端口标签在圆点之前');
  const inRow = root.querySelector('.port.in');
  assert.ok(inRow.children[0]._hasCls('dot'), '输入端口圆点仍居左前');
  const css = readFileSync(join(HERE, '..', 'src', 'app.css'), 'utf8');
  assert.match(css, /\.port\.out\s*\{[^}]*flex-end/, '输出端口保持右对齐');
  assert.match(css, /\.port\.out\s+\.dot\s*\{[^}]*margin-right:\s*-16px/, '圆点保持外悬右缘');
});

// ---------- ui.js 弹层语义 ----------
test('modal：Esc 只关最上层；confirmDialog 关闭视为取消', async () => {
  DOC._l.clear();
  overlay.replaceChildren();
  modal(el('div', { text: 'A' }));
  modal(el('div', { text: 'B' }));
  assert.equal(overlay.children.length, 2);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.children.length, 1, 'Esc 只关最上层弹窗');
  assert.equal(overlay.children[0].textContent, 'A');
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.children.length, 0);

  const p1 = confirmDialog('确认？', 'x');
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(await p1, false, 'Esc 视为取消');
  const p2 = confirmDialog('确认？', 'x');
  fire(overlay.children[0], 'pointerdown', {});            // 点击遮罩自身
  assert.equal(await p2, false, '点遮罩视为取消');
  const p3 = confirmDialog('确认？', 'x');
  fire(overlay.querySelector('.primary'), 'click');
  assert.equal(await p3, true, '确认按钮 resolve true');
  assert.equal(overlay.children.length, 0, '确认后弹窗关闭');
});

// ---------- main.js 静态防线（真实行为由浏览器 e2e 验收）----------
test('main.js 静态检查：空白处点击才收抽屉；任务面板含查询/下载/恢复入口', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /e\.target !== e\.currentTarget && e\.target\.id !== 'nodes' && e\.target\.id !== 'edges'/,
    '仅空白画布点击才收起抽屉（R08）');
  assert.match(src, /runner\.restoreTask\(t\.taskId\)/, '任务行提供 runner.restoreTask 找回入口（R13）');
  assert.match(src, /runner\.restorePending\(r\.idempotencyKey\)/, 'pending 行提供 runner.restorePending 恢复入口（R13）');
  assert.match(src, /runner\.download\(t\.taskId\)/, '任务行提供独立下载入口（R05）');
});
