// 审查交互修复回归（UI-01/02/03/05/06/07）：极简 DOM 桩直接驱动 board.js / ui.js 事件路径。
// 覆盖：modal role/aria-modal/初焦/Tab 焦点圈禁/Esc 仅顶层/焦点归还/弹窗外 Enter·Space 拦截、
//       菜单 ↑↓ 导航、toast aria-live；连线 <g data-edge> 加宽透明命中/点选/右键 onEdgeMenu、
//       拖线落节点体不弹建点且高亮兼容端口、落空建点保留；框选过程零 reconcile/零 onSelect、
//       松手一次提交（50 节点手势有界 render）；节点拖动 move 重绘 rAF 合并+松手 flush；
//       长 textarea 滚轮自滚 vs Ctrl+wheel 缩放保留；Esc 序：输入/IME 不清选择、弹层优先、
//       手势取消保留。UI-01 仅做样式接线检查（真实渲染由主控浏览器验收）。
// 本文件只需 node --test；真实浏览器回归由主控 e2e 独立验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { el, modal, popup, popupMenu, toast } from '../src/ui.js';
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
    if (t.index !== pos) return false;
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
    this._l = new Map();
    this._attrs = new Map();
    this.dataset = {};
    this.style = {};
    this._cls = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.id = '';
    this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    this.clientWidth = 0; this.clientHeight = 0;
    this.offsetWidth = 0; this.offsetHeight = 0;
    this.scrollHeight = 0; this.scrollWidth = 0;
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
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { const matches = new Set(sel.split(',').flatMap(s => qsAll(this, s.trim()))); return this._desc().filter(n => matches.has(n)); }
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
boardEl.clientWidth = 1200; boardEl.clientHeight = 800;
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
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });

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
  // 真实 DOM 在派发到某节点时快照其监听列表：监听器内 removeEventListener 不影响本次派发。
  // 直接迭代活数组时，手势收尾函数摘除自身会跳过后续监听器——selects=0 的夹具根因之一。
  for (let i = path.length - 1; i >= 0 && !e._stop; i--) {
    const n = path[i]; e.currentTarget = n;
    for (const h of [...(n._l?.get(type) ?? [])]) { if (h.cap) { h.fn(e); if (e._stopIm) break; } }
  }
  for (let i = 0; i < path.length && !e._stop; i++) {
    const n = path[i]; e.currentTarget = n;
    for (const h of [...(n._l?.get(type) ?? [])]) { if (!h.cap) { h.fn(e); if (e._stopIm) break; } }
  }
  return e;
}

async function freshCanvas() {
  nodesEl.replaceChildren(); edgesSvg.replaceChildren(); overlay.replaceChildren(); toastRoot.replaceChildren();
  // 共享骨架元素等价于"同一个页面"：上一用例装配的 board 仍挂在 boardEl 等元素上的监听会吃到
  // 本用例事件（旧 board 的 pointerup 会提交它自己的旧 lasso → 额外 reconcile/选中），必须清成
  // 全新页面状态——这是 selects=0 / edgeRenders 多 1 两个失败的夹具根因。
  for (const elx of [boardEl, nodesEl, edgesSvg, overlay, toastRoot, topbar, body, html]) elx._l.clear();
  for (const c of [...boardEl.children]) if (c !== edgesSvg && c !== nodesEl) c.remove();   // 旧 board 的 minimap 等挂饰一并清除
  DOC._hit = null; DOC.activeElement = null;
  DOC._l.clear(); WIN._l.clear();
  const store = createStore(createMemoryStorage());
  await store.newProject('t');
  return store;
}
const rootOf = id => nodesEl.children.find(c => c.dataset.node === id);

// ---------- UI-07：modal 语义 ----------
test('UI-07 modal：role/aria-modal/初焦/Tab 圈禁/Esc 仅顶层/焦点归还/弹窗外 Enter 拦截', async () => {
  await freshCanvas();
  const opener = el('button', { text: '打开' }); body.append(opener); opener.focus();
  const input = el('input', { type: 'text' });
  const ok = el('button', { class: 'ok-b', text: '好' });
  modal(el('div', {}, input, ok));
  const mask = overlay.children[0];
  const box = mask.querySelector('.modal');
  assert.equal(box.getAttribute('role'), 'dialog', '弹窗声明 dialog 角色');
  assert.equal(box.getAttribute('aria-modal'), 'true', '弹窗声明 aria-modal');
  assert.ok(box.querySelector('.modal-x'), '存在可见关闭钮');
  assert.equal(DOC.activeElement, input, '初焦落在首个文本字段');

  const items = [...box.querySelectorAll('button, input')];   // [×, input, 好]
  DOC.activeElement = items[items.length - 1];
  const e1 = fire(items[items.length - 1], 'keydown', { key: 'Tab' });
  assert.ok(e1.defaultPrevented, 'Tab 被圈禁');
  assert.equal(DOC.activeElement, items[0], 'Tab 末项后环绕到首项');
  fire(items[0], 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(DOC.activeElement, items[items.length - 1], 'Shift+Tab 首项后环绕到末项');

  DOC.activeElement = body;                                  // 焦点意外滞留背景
  const e2 = fire(body, 'keydown', { key: 'Enter' });
  assert.ok(e2.defaultPrevented, '弹窗外 Enter 被拦截，不激活背景控件');
  assert.ok(mask.contains(DOC.activeElement), '焦点被收回弹窗内');
  const e3 = fire(body, 'keydown', { key: ' ' });
  assert.ok(e3.defaultPrevented, '弹窗外 Space 同样拦截');

  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0, 'Esc 关闭弹窗');
  assert.equal(DOC.activeElement, opener, '关闭后焦点归还触发元素');
  opener.remove();
});

test('UI-07 嵌套弹窗仅顶层响应；触发元素已删/无字段弹窗不崩溃', async () => {
  await freshCanvas();
  const aIn = el('input', { type: 'text' });
  modal(el('div', {}, aIn));                                 // 底层 A
  const maskA = overlay.children[0];
  const bOk = el('button', { text: 'B-ok' });
  const mB = modal(el('div', {}, bOk));                      // 顶层 B
  const maskB = overlay.children[1];
  assert.equal(DOC.activeElement, bOk, '顶层弹窗获得初焦');
  DOC.activeElement = aIn;                                   // 模拟焦点滞留在底层
  fire(aIn, 'keydown', { key: 'Tab' });
  assert.ok(maskB.contains(DOC.activeElement), 'Tab 被顶层弹窗接管，不穿入底层');
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 1, 'Esc 只关顶层');
  assert.equal(overlay.children[0], maskA);
  assert.equal(DOC.activeElement, aIn, '顶层关闭后焦点归还底层内的原焦点元素');

  const gone = el('button', { text: 'g' }); body.append(gone); gone.focus(); gone.remove();
  const mC = modal(el('div', {}, el('button', { class: 'cb', text: 'c' })));
  mC.close();
  assert.ok(DOC.activeElement !== gone, '触发元素已删：关闭不抛错、不复活还焦');
  assert.equal(overlay.childElementCount, 1, '底层弹窗仍在');

  const mD = modal(el('div', { text: '纯文本' }));            // 无字段弹窗（仅 ×）
  const maskD = overlay.children[overlay.children.length - 1];
  const e4 = fire(maskD.querySelector('.modal'), 'keydown', { key: 'Tab' });
  assert.ok(e4.defaultPrevented);
  assert.ok(maskD.contains(DOC.activeElement), '无字段弹窗 Tab 焦点不逃逸');
  mD.close(); mB.close(); maskA && fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0);
});

test('UI-07 焦点圈禁跳过隐藏字段；IME 组合中 Esc 不关弹窗/弹层', async () => {
  await freshCanvas();
  const hiddenTyped = el('input', { type: 'hidden', value: 'x' });
  const wrapped = el('input', { type: 'text' });
  const visible = el('input', { type: 'text' });
  const ok = el('button', { text: '行' });
  modal(el('div', {}, hiddenTyped, el('div', { hidden: true }, wrapped), visible, ok));
  const mask = overlay.children[0];
  assert.equal(DOC.activeElement, visible, '初焦跳过 type=hidden 与 hidden 容器内字段');
  DOC.activeElement = ok;
  fire(ok, 'keydown', { key: 'Tab' });
  assert.equal(DOC.activeElement, mask.querySelector('.modal-x'), 'Tab 序列不含隐藏字段');
  fire(mask.querySelector('.modal-x'), 'keydown', { key: 'Tab' });
  assert.equal(DOC.activeElement, visible, '隐藏字段永不进入圈禁序列');

  fire(visible, 'keydown', { key: 'Escape', isComposing: true });
  assert.equal(overlay.childElementCount, 1, 'IME 组合输入中的 Esc 不关闭弹窗');
  fire(visible, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0, '组合输入外的 Esc 正常关闭');

  const pIn = el('input', { type: 'text' });
  popup(el('div', {}, pIn), { x: 5, y: 5 });
  fire(pIn, 'keydown', { key: 'Escape', isComposing: true });
  assert.equal(overlay.childElementCount, 1, 'IME 组合中 Esc 不关闭弹层');
  fire(pIn, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0);
});

test('UI-07 菜单 ↑↓ 导航跳过禁用项并循环；toast 容器 aria-live', async () => {
  await freshCanvas();
  popupMenu(10, 10, [
    { label: '一', onPick() {} },
    { label: '二', onPick() {} },
    { separator: true },
    { label: '三', disabled: true, onPick() {} },
  ]);
  const pop = overlay.querySelector('.popup');
  const items = [...pop.querySelectorAll('.menu-item')];
  assert.equal(items.length, 3);
  assert.equal(items[2].disabled, true, '禁用项真实禁用');
  assert.equal(DOC.activeElement, items[0], '菜单打开聚焦首个可用项');
  fire(items[0], 'keydown', { key: 'ArrowDown' });
  assert.equal(DOC.activeElement, items[1]);
  fire(items[1], 'keydown', { key: 'ArrowDown' });
  assert.equal(DOC.activeElement, items[0], '末项后循环回首项（禁用项不计）');
  fire(items[0], 'keydown', { key: 'ArrowUp' });
  assert.equal(DOC.activeElement, items[1], '首项上箭头跳过禁用项到末位可用项');
  fire(items[1], 'keydown', { key: 'Home' });
  assert.equal(DOC.activeElement, items[0]);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0);

  toast('测试提示');
  assert.equal(toastRoot.getAttribute('aria-live'), 'polite', 'toast 容器可播报');
  assert.equal(toastRoot.getAttribute('role'), 'status');
});

// ---------- UI-02：连线命中/右键/拖线落点 ----------
test('UI-02 连线 <g> 加宽透明命中可点选；右键触发 onEdgeMenu；拖线落节点体不弹建点', async () => {
  const store = await freshCanvas();
  const a = store.addNode('image', 60, 100, {});
  const b = store.addNode('gen', 420, 100, { draft: {}, run: null });
  let edgeMenuCall = null, wireEnd = 0;
  const board = createBoard({
    store,
    renderBody: () => el('div'),
    kindOf: n => (n.type === 'gen' ? 'video' : n.type === 'image' ? 'image' : 'media'),
    onWireEnd: () => wireEnd++,
    onEdgeMenu: (e, pos) => { edgeMenuCall = { e, pos }; },
  });
  const edge = store.addEdge(a.id, 'out', b.id, 'refs', 'image');
  board.render();
  assert.equal(edgesSvg.children.length, 1, 'edges 子节点数=连线数（既有契约不变）');
  const g = edgesSvg.children[0];
  assert.equal(g.dataset.edge, edge.id, '连线 <g> 携带 data-edge');
  assert.equal(g.children.length, 2, '可视描边 + 命中层');
  assert.equal(g.children[0].style.pointerEvents, 'none', '可视描边不截获指针');
  assert.equal(g.children[1].getAttribute('stroke'), 'transparent', '命中层透明');
  assert.equal(g.children[1].getAttribute('stroke-width'), '14', '命中宽度加宽');
  assert.equal(g.children[1].style.pointerEvents, 'stroke');

  fire(g, 'pointerdown', { clientX: 200, clientY: 100, button: 0 });
  assert.equal(board.selected?.type, 'edge', '连线可点选');
  assert.equal(board.selected?.id, edge.id);
  fire(edgesSvg.children[0], 'contextmenu', { clientX: 200, clientY: 100 });
  assert.equal(edgeMenuCall?.e?.id, edge.id, '右键连线回调 onEdgeMenu');
  assert.equal(edgeMenuCall?.pos?.clientX, 200);

  // 右键 pointerdown 不得重建连线层：真实浏览器 contextmenu 以按下时的元素为派发目标，
  // 重建会让菜单事件落到已分离节点（右键菜单丢失）；右键选中交给 contextmenu 完成
  const gLive = edgesSvg.children[0];
  fire(gLive, 'pointerdown', { clientX: 200, clientY: 100, button: 2 });
  assert.equal(edgesSvg.children[0], gLive, '右键按下不重建 <g>，contextmenu 目标存活');
  fire(gLive, 'contextmenu', { clientX: 210, clientY: 110 });
  assert.equal(edgeMenuCall?.e?.id, edge.id, '右键菜单经 contextmenu 正常触发');
  assert.equal(edgeMenuCall?.pos?.clientX, 210);

  // 拖线落在节点体（非端口）：不弹建点菜单、不自动接线、高亮兼容端口
  const outRow = rootOf(a.id).querySelector('.port.out');
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 1, button: 0 });
  DOC._hit = rootOf(b.id);
  fire(rootOf(b.id), 'pointerup', { clientX: 430, clientY: 140, pointerId: 1 });
  assert.equal(wireEnd, 0, '落节点体不触发建点菜单');
  assert.equal(store.project.edges.length, 1, '不静默猜端口接线');
  const hot = rootOf(b.id).querySelectorAll('.port.in .dot').filter(d => d.classList.contains('hot'));
  assert.ok(hot.length >= 1, '兼容输入端口已高亮提示');
  assert.ok([...toastRoot.children].some(c => c.textContent.includes('端口')), '有可见提示');

  // 落空白仍走建点菜单（既有功能保留）
  fire(outRow, 'pointerdown', { clientX: 100, clientY: 150, pointerId: 2, button: 0 });
  DOC._hit = null;
  fire(boardEl, 'pointerup', { clientX: 700, clientY: 500, pointerId: 2 });
  assert.equal(wireEnd, 1, '落空建点菜单保留');
});

// ---------- UI-03：框选/拖动渲染有界 ----------
test('UI-03 50 节点框选：拖动过程零 reconcile/零 onSelect，松手一次提交', async () => {
  const store = await freshCanvas();
  for (let i = 0; i < 50; i++) store.addNode('note', (i % 10) * 300, Math.floor(i / 10) * 300, { text: '' });
  let bodyBuilds = 0, selects = 0;
  const board = createBoard({
    store,
    renderBody: () => { bodyBuilds++; return el('div'); },
    kindOf: () => 'media',
    onSelect: () => selects++,
  });
  board.render();
  assert.equal(bodyBuilds, 50);
  let edgeRenders = 0;
  const origRC = edgesSvg.replaceChildren.bind(edgesSvg);
  edgesSvg.replaceChildren = (...x) => { edgeRenders++; return origRC(...x); };

  fire(boardEl, 'pointerdown', { shiftKey: true, clientX: 5, clientY: 5, pointerId: 9, button: 0 });
  for (const [cx, cy] of [[200, 200], [500, 400], [1100, 700], [900, 500]])
    fire(boardEl, 'pointermove', { clientX: cx, clientY: cy, pointerId: 9 });
  assert.ok(nodesEl.querySelector('.selection-box'), '选框可见');
  assert.ok(nodesEl.querySelector('.in-lasso'), '框内节点有预览高亮');
  assert.equal(bodyBuilds, 50, '框选过程不重建节点体');
  assert.equal(selects, 0, '框选过程不触发 onSelect/检查器重建');
  assert.equal(edgeRenders, 0, '框选过程不重绘连线');
  fire(boardEl, 'pointerup', { clientX: 900, clientY: 500, pointerId: 77 });   // 异 pointerId 的松开不结算
  assert.equal(selects, 0, '异 pointerId 的松开不提交框选');
  assert.ok(nodesEl.querySelector('.selection-box'), '框选手势未被外部指针打断');
  fire(boardEl, 'pointerup', { clientX: 900, clientY: 500, pointerId: 9 });
  assert.equal(selects, 1, '松手一次性提交选择');
  assert.ok(board.selectedIds.length >= 4, '套索命中框内节点');
  assert.equal(bodyBuilds, 50, '提交不额外重建节点体');
  assert.equal(edgeRenders, 0, '提交选择也不全量重建连线DOM');
  assert.ok(!nodesEl.querySelector('.in-lasso'), '预览高亮已清理');

  // 项目切换：进行中的框选被清理且不提交，迟到的 pointerup 不得复活旧框选
  fire(boardEl, 'pointerdown', { shiftKey: true, clientX: 5, clientY: 5, pointerId: 11, button: 0 });
  fire(boardEl, 'pointermove', { clientX: 1000, clientY: 700, pointerId: 11 });
  assert.ok(nodesEl.querySelector('.selection-box'));
  const callsBefore = selects;
  store.touch({ type: 'project' });
  assert.ok(!nodesEl.querySelector('.selection-box'), '项目切换清理选框');
  fire(boardEl, 'pointerup', { clientX: 1000, clientY: 700, pointerId: 11 });
  assert.equal(selects, callsBefore + 1, '仅项目切换的一次清空通知，迟到的松开不再提交');
  assert.equal(board.selectedIds.length, 0);
});

test('UI-03 节点拖动：边重绘 rAF 合并，松手立即 flush 末状态', async () => {
  const store = await freshCanvas();
  const a = store.addNode('text', 100, 100, { title: 't', text: '' });
  const b = store.addNode('gen', 500, 100, { draft: {}, run: null });
  store.addEdge(a.id, 'out', b.id, 'prompt', 'text');
  const board = createBoard({
    store, renderBody: () => el('div'),
    kindOf: n => (n.type === 'gen' ? 'video' : 'text'),
  });
  board.render();
  let edgeRenders = 0;
  const origRC = edgesSvg.replaceChildren.bind(edgesSvg);
  edgesSvg.replaceChildren = (...x) => { edgeRenders++; return origRC(...x); };
  const head = rootOf(a.id).querySelector('.node-head');
  fire(head, 'pointerdown', { clientX: 150, clientY: 120, pointerId: 7, button: 0 });
  const base = edgeRenders;   // pointerdown 选中本身一次 reconcile
  fire(head, 'pointermove', { clientX: 250, clientY: 220, pointerId: 7 });
  fire(head, 'pointermove', { clientX: 300, clientY: 260, pointerId: 7 });
  fire(head, 'pointermove', { clientX: 340, clientY: 300, pointerId: 7 });
  assert.equal(edgeRenders, base, '拖动中边重绘被合并（同步路径零全量重建）');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(a.x, 100, '下一帧节点已跟随指针');
  fire(head, 'pointerup', { clientX: 340, clientY: 300, pointerId: 70 });   // 异 pointerId 不结束拖动
  fire(head, 'pointermove', { clientX: 360, clientY: 320, pointerId: 7 });
  assert.equal(edgeRenders, base, '异 pointerId 的松开不结束手势');
  fire(head, 'pointerup', { clientX: 360, clientY: 320, pointerId: 7 });
  assert.equal(edgeRenders, base, '松手更新原连线，不拆建SVG');
  assert.notEqual(a.x, 100, '松手已经提交最后坐标');
});

// ---------- UI-05：滚轮归属 ----------
test('UI-05 可滚动 textarea 滚轮滚自身；Ctrl+wheel 与空白滚轮维持缩放约定', async () => {
  const store = await freshCanvas();
  const ta = el('textarea');
  ta.scrollHeight = 400; ta.clientHeight = 60;               // 可滚动
  const board = createBoard({
    store,
    renderBody: () => { const b = el('div'); b.append(ta); return b; },
    kindOf: () => 'media',
  });
  store.addNode('note', 100, 100, { text: '' });
  board.render();
  const s0 = board.view.scale;
  const e1 = fire(ta, 'wheel', { deltaY: 120, clientX: 150, clientY: 150 });
  assert.equal(board.view.scale, s0, '可滚动 textarea 上滚轮不缩放画布');
  assert.equal(e1.defaultPrevented, false, '不 preventDefault，原生滚动生效');
  const e2 = fire(boardEl, 'wheel', { deltaY: 120, clientX: 600, clientY: 400 });
  assert.ok(e2.defaultPrevented && board.view.scale < s0, '空白处滚轮仍缩放');
  const s2 = board.view.scale;
  const e3 = fire(ta, 'wheel', { deltaY: -120, clientX: 150, clientY: 150, ctrlKey: true });
  assert.ok(e3.defaultPrevented && board.view.scale > s2, 'Ctrl+wheel 捏合缩放保留');
});

// ---------- UI-06：Esc 顺序 ----------
test('UI-06 Esc 序：输入/IME 不清选择，弹层优先，拖线/手势取消保留', async () => {
  const store = await freshCanvas();
  const a = store.addNode('text', 100, 100, { title: 't', text: '' });
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'text' });
  board.render();
  board.select('node', a.id);

  const inp = el('input', { type: 'text' }); body.append(inp); inp.focus();
  fire(inp, 'keydown', { key: 'Escape' });
  assert.deepEqual(board.selectedIds, [a.id], '输入中 Esc 不清选择');
  assert.equal(DOC.activeElement, null, '输入中 Esc 仅退出编辑焦点');
  inp.remove();

  fire(body, 'keydown', { key: 'Escape', isComposing: true });
  assert.deepEqual(board.selectedIds, [a.id], 'IME 组合输入 Esc 不清选择');

  popup(el('div', { text: 'p' }), { x: 10, y: 10 });
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay.childElementCount, 0, '弹层 Esc 正常关闭');
  assert.deepEqual(board.selectedIds, [a.id], '弹层 Esc 不连带清选择');

  const outRow = rootOf(a.id).querySelector('.port.out');
  fire(outRow, 'pointerdown', { clientX: 150, clientY: 150, pointerId: 3, button: 0 });
  assert.equal(edgesSvg.children.length, 1, '拖线预览出现');
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(edgesSvg.children.length, 0, '拖线中 Esc 仍取消手势');
  assert.deepEqual(board.selectedIds, [a.id], '取消手势不连带清选择');

  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(board.selected, null, '画布焦点下 Esc 正常清选择');
});

// ---------- UI-01：样式接线检查（真实渲染由主控浏览器验收）----------
test('UI-01 app.css 补齐分镜/素材库/通用样式规则（接线检查，非主要正确性证明）', () => {
  const css = readFileSync(join(HERE, '..', 'src', 'app.css'), 'utf8');
  for (const re of [
    /\.sb-grid\s*\{[^}]*display:\s*grid/, /\.sb-thumb img\s*\{[^}]*object-fit:\s*cover/,
    /\.lib-grid\s*\{[^}]*display:\s*grid/, /\.lib-pv img\s*\{[^}]*object-fit:\s*cover/,
    /\.lib-col\s*\{[^}]*cursor:\s*pointer/, /\.chip\s*\{/, /^\.row\s*\{/m,
    /\.modal-x/, /\.node\.in-lasso/, /\.edge-hit/,
  ]) assert.match(css, re, `app.css 缺规则 ${re}`);
});
