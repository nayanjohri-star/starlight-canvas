// 交互状态回归（本轮三项修复）：极简 DOM 桩直接驱动 board.js / studio-shell.js 事件路径。
//  1) board.onViewChange 订阅统一视图通知出口——滚轮/平移/zoomBy/外部 applyView 任一入口都通知；
//     shell 经订阅刷新状态栏缩放并在 dispose 退订（不再猴子补丁 board.applyView，内部闭包不再绕过）。
//  2) select(null) 真正清空——selected 收敛为 null（不再留下 {type:null} 真值对象）；
//     shift 取消当前/最后节点后 selected 落在仍选中节点或 null，onSelect 同步一致（不遗留已取消节点的检查器）。
//  3) 节点头 pointerdown 仅左键可拖——右键移动不改位置、contextmenu 菜单照常选中+弹出；
//     中键不 preventDefault、不装手势，不干扰中键平移（空白处中键平移保留）。
// 本文件只需 node --test；真实浏览器回归由主控 e2e 独立验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { el } from '../src/ui.js';
import { createBoard } from '../src/board.js';
import { createStudioShell } from '../src/studio-shell.js';

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
const statusbarEl = new El('div'); statusbarEl.id = 'statusbar';
body.append(topbar, boardEl, overlay, toastRoot, statusbarEl);
Object.assign(DOC, {
  _byId: new Map(Object.entries({ board: boardEl, nodes: nodesEl, edges: edgesSvg, 'overlay-root': overlay, 'toast-root': toastRoot, topbar, statusbar: statusbarEl })),
  _hit: null,
  activeElement: null,
  body,
  documentElement: html,
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
});
DOC.getElementById = id => DOC._byId.get(id) ?? null;
DOC.querySelector = sel => qs(html, sel);
DOC.querySelectorAll = sel => qsAll(html, sel);
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
  // 派发时快照各节点监听列表：收尾函数摘除自身不跳过后续监听器
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
  statusbarEl.textContent = '';
  for (const elx of [boardEl, nodesEl, edgesSvg, overlay, toastRoot, topbar, statusbarEl, body, html]) elx._l.clear();
  for (const c of [...boardEl.children]) if (c !== edgesSvg && c !== nodesEl) c.remove();
  DOC._hit = null; DOC.activeElement = null;
  DOC._l.clear(); WIN._l.clear();
  const store = createStore(createMemoryStorage());
  await store.newProject('t');
  return store;
}
const rootOf = id => nodesEl.children.find(c => c.dataset.node === id);

// ---------- 1) onViewChange：统一视图通知出口 ----------
test('board.onViewChange：滚轮/平移/zoomBy/外部 applyView 统一通知；退订后静默', async () => {
  const store = await freshCanvas();
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' });
  board.render();
  const seen = [];
  const off = board.onViewChange(v => seen.push(v.scale));
  // 滚轮缩放走内部闭包 applyView——旧猴子补丁 board.applyView 无法覆盖的路径
  fire(boardEl, 'wheel', { deltaY: -120, clientX: 600, clientY: 400 });
  assert.equal(seen.length, 1, '滚轮缩放经内部 applyView 通知订阅者');
  assert.equal(seen.at(-1), board.view.scale);
  // 空白平移同样经同一出口通知
  fire(boardEl, 'pointerdown', { button: 0, clientX: 600, clientY: 400, pointerId: 21 });
  fire(boardEl, 'pointermove', { button: 0, clientX: 640, clientY: 420, pointerId: 21 });
  assert.ok(seen.length >= 2, '平移同样通知');
  fire(boardEl, 'pointerup', { button: 0, pointerId: 21 });
  // 工具栏缩放入口与旧契约外部 applyView 都经同一出口
  const n0 = seen.length;
  board.zoomBy(1.2);
  board.applyView();
  assert.equal(seen.length, n0 + 2, 'zoomBy 与外部 applyView 都通知');
  assert.equal(typeof board.onViewChange('not-fn'), 'function', '非函数订阅返回安全退订');
  off();
  const n1 = seen.length;
  board.zoomBy(1 / 1.2);
  fire(boardEl, 'wheel', { deltaY: 120, clientX: 600, clientY: 400 });
  assert.equal(seen.length, n1, '退订后不再收到通知');
});

test('createBoard 选项回调 onViewChange 等价订阅；shell 订阅刷新缩放并在 dispose 退订', async () => {
  const store = await freshCanvas();
  const optSeen = [];
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media', onViewChange: v => optSeen.push(v.scale) });
  board.render();
  const shell = createStudioShell({
    store, editor: null, board, assets: {},
    spawnPos: () => ({ x: 0, y: 0 }), spawnNodeAt: () => null,
    addFilesAt: async () => [], openModule: () => false, storyboards: null,
  });
  assert.match(statusbarEl.textContent, /缩放 100%/);
  const beforeWheel = optSeen.length;
  fire(boardEl, 'wheel', { deltaY: -120, clientX: 600, clientY: 400 });
  assert.equal(optSeen.length, beforeWheel + 1, '选项式 onViewChange 回调同样收到通知');
  assert.match(statusbarEl.textContent, /缩放 110%/, '滚轮缩放后状态栏即时同步（内部闭包路径不再绕过）');
  board.zoomBy(1 / 1.1);
  assert.match(statusbarEl.textContent, /缩放 100%/, 'zoomBy 同样驱动状态栏');
  shell.dispose();
  const frozen = statusbarEl.textContent;
  fire(boardEl, 'wheel', { deltaY: -120, clientX: 600, clientY: 400 });
  board.zoomBy(1.2);
  assert.equal(statusbarEl.textContent, frozen, 'dispose 后订阅已清理，状态栏不再刷新');
});

// ---------- 2) select 状态一致性 ----------
test('select(null)：selected 收敛为真 null，onSelect 收到 null；已空重复清空幂等', async () => {
  const store = await freshCanvas();
  const a = store.addNode('note', 100, 100, { text: '' });
  const calls = [];
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media', onSelect: s => calls.push(s) });
  board.render();
  board.select('node', a.id);
  assert.equal(board.selected?.id, a.id);
  calls.length = 0;
  board.select(null, null);
  assert.equal(board.selected, null, 'selected 是真 null，不再留下 {type:null} 对象');
  assert.deepEqual(board.selectedIds, []);
  assert.deepEqual(calls, [null], 'onSelect 收到真 null——检查器可同步清空');
  board.select(null, null);
  assert.equal(calls.length, 1, '已空时重复清空幂等，不重复通知');
  // 事件路径：选中后点空白 → 走 select(null) 真正清空
  board.select('node', a.id);
  calls.length = 0;
  fire(boardEl, 'pointerdown', { button: 0, clientX: 600, clientY: 400, pointerId: 31 });
  assert.equal(board.selected, null, '空白 pointerdown 真正清空 selected');
  assert.deepEqual(calls, [null]);
  fire(boardEl, 'pointerup', { button: 0, pointerId: 31 });
});

test('shift 取消选中：selected 落在仍选中节点或 null，onSelect 同步不遗留已取消节点', async () => {
  const store = await freshCanvas();
  const a = store.addNode('note', 100, 100, { text: '' });
  const b = store.addNode('note', 400, 100, { text: '' });
  const seen = [];
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media', onSelect: s => seen.push(s) });
  board.render();
  board.select('node', a.id);
  board.select('node', b.id, true);                        // shift 加选
  assert.deepEqual(new Set(board.selectedIds), new Set([a.id, b.id]));
  assert.equal(board.selected.id, b.id);
  board.select('node', b.id, true);                        // shift 取消“当前”节点
  assert.deepEqual(board.selectedIds, [a.id]);
  assert.equal(board.selected?.id, a.id, 'selected 回退到仍选中节点，不指向已取消的 b');
  assert.equal(seen.at(-1)?.id, a.id, 'onSelect 同步仍选中节点');
  board.select('node', a.id, true);                        // shift 移除最后一个
  assert.equal(board.selected, null, '移除最后节点后 selected 为 null');
  assert.equal(seen.at(-1), null, 'onSelect 收到 null——不遗留已取消节点的检查器');
  // 事件路径：shift+pointerdown 在节点头切换，同样收敛
  board.selectMany([a.id, b.id]);
  const headA = rootOf(a.id).querySelector('.node-head');
  fire(headA, 'pointerdown', { button: 0, shiftKey: true, clientX: 150, clientY: 120, pointerId: 33 });
  assert.deepEqual(board.selectedIds, [b.id], 'shift 点击节点头取消 a');
  assert.equal(board.selected?.id, b.id, 'selected 收敛到仍选中的 b');
  fire(headA, 'pointerup', { button: 0, pointerId: 33 });
  assert.equal(seen.at(-1)?.id, b.id, '点选完成的 onSelect 同样一致');
});

// ---------- 3) 节点头按钮门控 ----------
test('节点头仅左键可拖：右键移动不改位置且菜单照常；中键不拦截；左键拖动保留', async () => {
  const store = await freshCanvas();
  const a = store.addNode('note', 100, 100, { text: 'x' });
  let checkpoints = 0;
  const menus = [];
  const board = createBoard({
    store, renderBody: () => el('div'), kindOf: () => 'media',
    editor: { checkpoint: () => checkpoints++ },
    onNodeMenu: (n, pos) => menus.push({ n, pos }),
  });
  board.render();
  const head = rootOf(a.id).querySelector('.node-head');

  // 右键：不 preventDefault（contextmenu 依赖默认流程）、不装拖动手势
  const rdown = fire(head, 'pointerdown', { button: 2, clientX: 150, clientY: 120, pointerId: 41 });
  assert.equal(rdown.defaultPrevented, false, '右键 pointerdown 不 preventDefault，菜单可达');
  fire(head, 'pointermove', { button: 2, clientX: 500, clientY: 400, pointerId: 41 });
  assert.equal(a.x, 100); assert.equal(a.y, 100);
  fire(head, 'contextmenu', { button: 2, clientX: 150, clientY: 120 });
  assert.equal(menus.length, 1, '右键菜单照常打开');
  assert.equal(menus[0].n.id, a.id);
  assert.ok(board.selectedIds.includes(a.id), 'contextmenu 路径选中节点');
  assert.equal(checkpoints, 0, '右键不产生拖动历史');

  // 中键：不 preventDefault、不拖动；空白处中键平移保留
  const mdown = fire(head, 'pointerdown', { button: 1, clientX: 150, clientY: 120, pointerId: 42 });
  assert.equal(mdown.defaultPrevented, false, '中键不被拦截');
  fire(head, 'pointermove', { button: 1, clientX: 500, clientY: 400, pointerId: 42 });
  assert.equal(a.x, 100, '中键不拖动节点');
  const vx = board.view.x, vy = board.view.y;
  fire(boardEl, 'pointerdown', { button: 1, clientX: 600, clientY: 400, pointerId: 43 });
  fire(boardEl, 'pointermove', { button: 1, clientX: 660, clientY: 430, pointerId: 43 });
  assert.ok(board.view.x !== vx || board.view.y !== vy, '空白处中键平移不受头部门控影响');
  fire(boardEl, 'pointerup', { button: 1, pointerId: 43 });

  // 左键拖动完整保留：选中 + 位移 + 首次移动一次 checkpoint
  fire(head, 'pointerdown', { button: 0, clientX: 150, clientY: 120, pointerId: 44 });
  assert.equal(board.selected?.id, a.id);
  fire(head, 'pointermove', { button: 0, clientX: 250, clientY: 220, pointerId: 44 });
  await new Promise(resolve => setTimeout(resolve, 20)); // 位移按帧提交；此 DOM 桩用16ms定时器模拟rAF
  assert.ok(a.x !== 100 || a.y !== 100, '左键拖动仍可移动节点');
  assert.equal(checkpoints, 1, '左键拖动首移落一次历史');
  fire(head, 'pointerup', { button: 0, clientX: 250, clientY: 220, pointerId: 44 });
});
