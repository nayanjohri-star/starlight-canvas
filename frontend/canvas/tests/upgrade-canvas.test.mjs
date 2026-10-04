// 升级验收（canvas 域）：真实 store/editor/schema + 极简 DOM 桩驱动 board.js / studio-shell.js / ui.js。
// 覆盖：空白态模板（含分镜模块委托）、添加菜单（右键/拖线落空自动接线与不兼容拒绝）、节点菜单
//       （重命名/锁定保护/副本）、快捷键与套索框选、Ctrl+V 媒体粘贴让位、搜索聚焦、
//       面板折叠/吸附/缩放/缩略图、分组框动作、端口接线约束、弹层快捷键隔离、popup 语义、
//       受保护节点删除保留选中、显式文本剪贴板让位。
// 装配层 main.js 由静态防线断言 + e2e-upgrade.test.mjs 真实浏览器验收；本文件只需 node --test。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createEditor } from '../src/editor.js';
import { el, popup, menuList } from '../src/ui.js';
import { createBoard } from '../src/board.js';
import { createStudioShell, defaultNodeData } from '../src/studio-shell.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = p => readFileSync(join(HERE, '..', 'src', p), 'utf8');

// ---------- 极简 DOM 桩 ----------
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
// 真实 DOM 中布尔 attribute 与 IDL 属性互通（存在即 true），桩如实反射
const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'multiple', 'autofocus', 'autoplay', 'controls', 'loop', 'muted', 'hidden']);

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
    if (BOOL_ATTRS.has(k)) this[k] = true;
  }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  hasAttribute(k) { return this._attrs.has(k); }
  removeAttribute(k) {
    this._attrs.delete(k);
    if (k === 'id') this.id = '';
    if (BOOL_ATTRS.has(k)) this[k] = false;
  }
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
  click() { if (this.disabled === true) return; fire(this, 'click'); }   // 真实 DOM 禁用控件不分派 click
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
const htmlEl = new El('html');
let body;
let D;                                  // 当前 DOM 元件表（id → El）
const BTN_IDS = ['btn-undo', 'btn-redo', 'btn-copy', 'btn-paste', 'btn-dup', 'btn-del-sel',
  'btn-group', 'btn-ungroup', 'btn-lock', 'btn-arrange', 'btn-snap', 'btn-zoom-out', 'btn-zoom-in',
  'btn-fit', 'btn-minimap', 'btn-left-panel', 'btn-right-panel'];

function buildDom() {
  body = new El('body');
  const made = {};
  const mk = (tag, id, cls) => {
    const e = new El(tag);
    if (id) e.setAttribute('id', id);
    if (cls) e.className = cls;
    if (id) made[id] = e;
    return e;
  };
  const sidebar = mk('aside', 'sidebar');
  sidebar.append(mk('div', 'asset-list'), mk('div', 'workflow-panel'), mk('div', 'task-list'));
  const wrap = mk('div', 'board-wrap');
  const tb = mk('div', 'canvas-toolbar');
  for (const id of BTN_IDS) tb.append(mk('button', id));
  tb.append(mk('input', 'node-search'));
  const boardEl = mk('div', 'board');
  boardEl.rect = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  boardEl.clientWidth = 1200; boardEl.clientHeight = 800;
  boardEl.append(mk('svg', 'edges'), mk('div', 'nodes'));
  wrap.append(tb, boardEl, mk('div', 'empty-state', 'hidden'), mk('div', 'statusbar'));
  body.append(mk('header', 'topbar'), sidebar, mk('div', 'sidebar-resizer'), wrap,
    mk('div', 'inspector-resizer'), mk('aside', 'inspector'), mk('div', 'overlay-root'), mk('div', 'toast-root'));
  return made;
}
function mountDom() {
  htmlEl.replaceChildren(body);
  DOC._byId = new Map(Object.entries(D));
  DOC.activeElement = null; DOC._hit = null;
}
Object.assign(DOC, {
  body: null, documentElement: htmlEl,
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  elementFromPoint: () => DOC._hit,
});
DOC.getElementById = id => DOC._byId.get(id) ?? null;
DOC.querySelector = s => { for (const part of s.split(',')) { const r = qs(body, part.trim()); if (r) return r; } return null; };
DOC.querySelectorAll = s => { const out = []; for (const part of s.split(',')) out.push(...qsAll(body, part.trim())); return out; };
globalThis.document = DOC;
globalThis.window = WIN;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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

// ---------- 画布装配（与 main.js 回调同构）----------
let store, editor, board, shell, selLog;
async function fresh(opts = {}) {
  D = buildDom(); mountDom();
  DOC._l.clear(); WIN._l.clear();
  store = createStore(createMemoryStorage());
  await store.newProject('t');
  editor = createEditor(store);
  selLog = [];
  const kindOf = n =>
    n.type === 'gen' ? 'video' : n.type === 'image' ? 'image' : n.type === 'text' ? 'text'
      : n.type === 'utility' ? 'any' : n.type === 'asset' ? (store.project.assets[n.data.assetId]?.kind ?? 'media') : 'media';
  board = createBoard({
    store, editor, kindOf,
    renderBody: n => el('div', { class: `body-${n.type}`, text: n.type }),
    onSelect: s => selLog.push(s),
    onAddMenu: pos => shell?.openAddMenu(pos),
    onNodeMenu: (n, pos) => shell?.nodeMenu(n, pos),
    onWireEnd: (w, pos) => shell?.openAddMenu(pos, w),
    onGroupAction: (a, g, pos) => shell?.handleGroupAction(a, g, pos),
  });
  shell = createStudioShell({
    store, editor, board, assets: {},
    spawnPos: () => ({ x: 500, y: 400 }),
    spawnNodeAt: (t, p, d) => { const n = store.addNode(t, p.x, p.y, d ?? defaultNodeData(t)); board.select('node', n.id); return n; },
    addFilesAt: async () => [],
    openModule: () => true,
    storyboards: opts.storyboards ?? null,
  });
  board.render();
  return { store, editor, board, shell };
}
const $id = id => DOC._byId.get(id);
const nodesEl = () => $id('nodes');
const edgesSvg = () => $id('edges');
const overlay = () => $id('overlay-root');
const toastRoot = () => $id('toast-root');
const rootOf = id => nodesEl().children.find(c => c.dataset.node === id);
const menuItem = (pop, text) => [...pop.querySelectorAll('.menu-item')].find(b => b.textContent.includes(text));
const tick = () => new Promise(r => setTimeout(r, 10));

test('空白态与模板：模板建真实节点图、可撤销；grid 模板有分镜模块时委托 createGrid', async () => {
  await fresh();
  const empty = $id('empty-state');
  assert.ok(!empty.classList.contains('hidden'), '空项目显示空白态');
  const tplBtn = [...empty.querySelectorAll('.tpl-item')].find(b => b.textContent.includes('文本 → 视频'));
  assert.ok(tplBtn, '空白态提供模板入口');
  tplBtn.click();
  assert.equal(store.project.nodes.length, 2);
  assert.equal(store.project.edges.length, 1);
  const e0 = store.project.edges[0];
  assert.equal(store.node(e0.from.node).type, 'text');
  assert.equal(store.node(e0.to.node).type, 'gen');
  assert.equal(e0.to.port, 'prompt');
  assert.ok(empty.classList.contains('hidden'), '有节点后空白态隐藏');
  editor.undo();
  assert.equal(store.project.nodes.length, 0, '模板可撤销');
  assert.ok(!empty.classList.contains('hidden'), '撤销回空项目空白态恢复');

  shell.applyTemplate('grid');
  assert.equal(store.project.nodes.filter(n => n.type === 'image').length, 4, '无分镜模块时本地建 4 图成组');
  assert.equal(store.project.studio.groups.length, 1);

  const calls = [];
  await fresh({ storyboards: { createGrid: n => calls.push(n) } });
  shell.applyTemplate('grid');
  assert.deepEqual(calls, [4], '有分镜模块时委托 createGrid(4)');
  assert.equal(store.project.nodes.length, 0, '委托路径不建本地兜底节点');

  shell.applyTemplate('batch');
  const util = store.project.nodes.find(n => n.type === 'utility');
  assert.equal(util.data.tool, 'batch_table', '批量模板建 CSV 工具节点');
  assert.ok(store.project.nodes.some(n => n.type === 'gen') && store.project.edges.length >= 1);
});

test('添加菜单：右键空白在指定世界坐标建节点；拖线落空自动接兼容口，不兼容显式拒绝', async () => {
  await fresh();
  fire($id('board'), 'contextmenu', { clientX: 600, clientY: 450 });
  const pop = overlay().querySelector('.popup');
  assert.ok(pop, '右键空白弹出添加菜单');
  assert.ok(pop.querySelectorAll('.menu-item').length >= 12, '菜单含 6 类节点 + 模板 + 上传');
  menuItem(pop, '图片生成').click();
  assert.equal(store.project.nodes.length, 1);
  const img = store.project.nodes[0];
  assert.equal(img.type, 'image');
  assert.equal(img.x, 560, '节点落在右键的世界坐标');
  assert.equal(img.y, 410);
  assert.deepEqual(board.selectedIds, [img.id]);

  const t = store.addNode('text', 100, 100, defaultNodeData('text'));
  board.render();
  const outRow = rootOf(t.id).querySelector('.port.out');
  fire(outRow, 'pointerdown', { clientX: 200, clientY: 150, pointerId: 1, button: 0 });
  DOC._hit = null;
  fire($id('board'), 'pointerup', { clientX: 700, clientY: 500, pointerId: 1 });
  const pop2 = overlay().querySelector('.popup');
  assert.ok(pop2, '拖线落空弹出创建并连接菜单');
  menuItem(pop2, '图片生成').click();
  assert.equal(store.project.edges.length, 1, '新节点自动接第一个兼容输入口');
  assert.equal(store.project.edges[0].from.node, t.id);
  assert.equal(store.project.edges[0].to.port, 'prompt');

  const g = store.addNode('gen', 100, 500, defaultNodeData('gen'));
  board.render();
  fire(rootOf(g.id).querySelector('.port.out'), 'pointerdown', { clientX: 200, clientY: 560, pointerId: 2, button: 0 });
  fire($id('board'), 'pointerup', { clientX: 700, clientY: 700, pointerId: 2 });
  const pop3 = overlay().querySelector('.popup');
  const before = store.project.nodes.length;
  menuItem(pop3, '文本 / 剧本').click();
  assert.equal(store.project.nodes.length, before + 1, '无兼容口仍创建节点');
  assert.equal(store.project.edges.length, 1, '不兼容类型不接线');
  assert.ok([...toastRoot().children].some(c => c.textContent.includes('仅创建节点')), '拒绝原因有可见提示');
});

test('节点菜单：重命名提交、锁定删除保护、复制副本剥运行时身份', async () => {
  await fresh();
  const n = store.addNode('text', 300, 300, { ...defaultNodeData('text'), run: { taskId: 'paid-task' } });
  board.render();
  const nEl = rootOf(n.id);
  fire(nEl, 'contextmenu', { clientX: 320, clientY: 320 });
  menuItem(overlay().querySelector('.popup'), '重命名').click();
  const input = overlay().querySelector('.rename-pop input');
  assert.ok(input, '重命名弹出输入框');
  input.value = '镜头一脚本';
  fire(input, 'keydown', { key: 'Enter' });
  assert.equal(store.node(n.id).data.title, '镜头一脚本');

  fire(nEl, 'contextmenu', { clientX: 320, clientY: 320 });
  menuItem(overlay().querySelector('.popup'), '锁定（防误删）').click();
  assert.equal(store.node(n.id).data.locked, true);
  fire(nEl, 'contextmenu', { clientX: 320, clientY: 320 });
  menuItem(overlay().querySelector('.popup'), '删除').click();
  assert.ok(store.node(n.id), '锁定节点拒绝删除');
  assert.ok([...toastRoot().children].some(c => c.textContent.includes('锁定')));
  fire(nEl, 'contextmenu', { clientX: 320, clientY: 320 });
  menuItem(overlay().querySelector('.popup'), '解除锁定').click();
  fire(nEl, 'contextmenu', { clientX: 320, clientY: 320 });
  menuItem(overlay().querySelector('.popup'), '删除').click();
  assert.equal(store.node(n.id), null, '解锁后可删除');

  const m = store.addNode('gen', 500, 500, { ...defaultNodeData('gen'), run: { taskId: 'paid' }, resultAssetId: 'a1' });
  board.render();
  fire(rootOf(m.id), 'contextmenu', { clientX: 520, clientY: 520 });
  menuItem(overlay().querySelector('.popup'), '创建副本').click();
  const copy = store.project.nodes.find(x => x.id !== m.id && x.type === 'gen');
  assert.ok(copy && copy.id !== m.id);
  assert.equal(copy.data.run, undefined, '副本不继承任务');
  assert.equal(copy.data.resultAssetId, undefined, '副本不继承结果身份');
});

test('快捷键：全选/副本/成组/锁定/删除保护/Esc 取消选择；套索框选按包围盒命中', async () => {
  await fresh();
  store.addNode('text', 0, 0, defaultNodeData('text'));
  store.addNode('note', 400, 0, defaultNodeData('note'));
  store.addNode('note', 2000, 0, defaultNodeData('note'));
  board.render();
  const [a, b, far] = store.project.nodes;

  fire(body, 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(board.selectedIds.length, 3, 'Ctrl+A 全选');
  fire(body, 'keydown', { key: 'd', ctrlKey: true });
  assert.equal(store.project.nodes.length, 6, 'Ctrl+D 副本');
  assert.equal(board.selectedIds.length, 3, '副本被选中');

  board.selectMany([a.id, b.id]);
  fire(body, 'keydown', { key: 'g', ctrlKey: true });
  assert.equal(store.project.studio.groups.length, 1, 'Ctrl+G 成组');
  fire(body, 'keydown', { key: 'l', ctrlKey: true });
  assert.ok(store.node(a.id).data.locked && store.node(b.id).data.locked);
  fire(body, 'keydown', { key: 'Delete' });
  assert.ok(store.node(a.id) && store.node(b.id), '锁定节点不被 Delete 删除');
  assert.deepEqual(new Set(board.selectedIds), new Set([a.id, b.id]), '删除未发生时不丢选中（可继续 Ctrl+L 解锁）');
  fire(body, 'keydown', { key: 'l', ctrlKey: true });
  fire(body, 'keydown', { key: 'Delete' });
  assert.equal(store.node(a.id), null, '解锁后 Delete 删除');

  board.selectMany([far.id]);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(board.selected, null, 'Esc 清空选择');

  fire($id('board'), 'pointerdown', { shiftKey: true, clientX: 10, clientY: 10, pointerId: 9, button: 0 });
  fire($id('board'), 'pointermove', { clientX: 800, clientY: 700, pointerId: 9 });
  fire($id('board'), 'pointerup', { clientX: 800, clientY: 700, pointerId: 9 });
  const hit = new Set(board.selectedIds);
  assert.ok(!hit.has(far.id), '套索不命中框外节点');
  assert.ok(hit.size >= 1, '套索命中框内节点');
});

test('Ctrl+V 媒体粘贴让位：cancelPendingPaste 取消排队粘贴，否则正常粘贴并剥运行时', async () => {
  await fresh();
  const n = store.addNode('text', 100, 100, { ...defaultNodeData('text'), run: { taskId: 'x' } });
  board.select('node', n.id);
  fire(body, 'keydown', { key: 'c', ctrlKey: true });
  fire(body, 'keydown', { key: 'v', ctrlKey: true });
  board.cancelPendingPaste();
  await tick();
  assert.equal(store.project.nodes.length, 1, '媒体文件消费剪贴板后不再粘一份节点');
  fire(body, 'keydown', { key: 'v', ctrlKey: true });
  await tick();
  assert.equal(store.project.nodes.length, 2, '无文件抢占时节点粘贴照常');
  const pasted = store.project.nodes.find(x => x.id !== n.id);
  assert.equal(pasted.data.run, undefined, '粘贴剥掉运行时身份');
});

test('搜索：输入命中弹层点击聚焦选中；“/”聚焦搜索框', async () => {
  await fresh();
  const n = store.addNode('text', 900, 700, { ...defaultNodeData('text'), title: '主镜头脚本' });
  store.addNode('note', 0, 0, defaultNodeData('note'));
  board.render();
  const search = $id('node-search');
  fire(body, 'keydown', { key: '/' });
  assert.equal(DOC.activeElement, search, '/ 聚焦搜索框');
  search.value = '镜头';
  fire(search, 'input');
  const pop = overlay().querySelector('.popup');
  assert.ok(pop, '命中结果弹层');
  menuItem(pop, '主镜头脚本').click();
  assert.deepEqual(board.selectedIds, [n.id], '点击结果聚焦并选中节点');
  assert.equal(overlay().childElementCount, 0, '选中后弹层关闭');
});

test('面板折叠/吸附/缩放/缩略图/适配工具栏动作真实生效', async () => {
  await fresh();
  const sidebar = $id('sidebar'), inspector = $id('inspector');
  assert.ok(sidebar.classList.contains('collapsed'), '新桌面布局默认收起侧栏');
  $id('btn-left-panel').click();
  assert.ok(!sidebar.classList.contains('collapsed'), '面板左按钮展开侧栏');
  $id('btn-left-panel').click();
  assert.ok(sidebar.classList.contains('collapsed'), '面板左按钮折叠侧栏');
  assert.equal($id('btn-left-panel').getAttribute('aria-pressed'), 'false');
  fire($id('sidebar-resizer'), 'dblclick');
  assert.ok(!sidebar.classList.contains('collapsed'), '双击分隔条恢复');
  assert.ok(inspector.classList.contains('collapsed'), '检查器默认收起');
  $id('btn-right-panel').click();
  assert.ok(!inspector.classList.contains('collapsed'), '检查器按钮展开');
  $id('btn-right-panel').click();
  assert.ok(inspector.classList.contains('collapsed'));
  $id('btn-right-panel').click();

  $id('btn-snap').click();
  assert.equal(board.snap.grid, false);
  assert.equal(board.snap.align, false, '吸附开关同时关对齐');
  assert.equal($id('btn-snap').getAttribute('aria-pressed'), 'false');
  $id('btn-snap').click();
  assert.equal(board.snap.grid, true);

  const s0 = board.view.scale;
  $id('btn-zoom-in').click();
  assert.ok(board.view.scale > s0, '放大生效');
  store.addNode('note', 0, 0, defaultNodeData('note'));
  store.addNode('note', 5000, 0, defaultNodeData('note'));
  $id('btn-fit').click();
  assert.ok(board.view.scale < 1, '适配收缩到全部节点');
  $id('btn-minimap').click();
  assert.ok(DOC.querySelector('.minimap').classList.contains('hidden'), '缩略图可关');
});

test('分组框：标题点选整组、双击重命名、× 解散保留节点', async () => {
  await fresh();
  const a = store.addNode('text', 100, 100, defaultNodeData('text'));
  const b = store.addNode('note', 400, 100, defaultNodeData('note'));
  editor.group([a.id, b.id], '场景A');
  board.render();
  const box = nodesEl().querySelector('.group-box');
  assert.ok(box, '成组渲染分组框');
  const title = box.querySelector('.group-title');
  fire(title, 'pointerdown', { clientX: 120, clientY: 80, button: 0 });
  assert.deepEqual(new Set(board.selectedIds), new Set([a.id, b.id]), '点标题选中整组');
  fire(title, 'dblclick', { clientX: 120, clientY: 80 });
  const input = overlay().querySelector('.rename-pop input');
  input.value = '新组名';
  fire(input, 'keydown', { key: 'Enter' });
  assert.equal(store.project.studio.groups[0].title, '新组名');
  fire(box.querySelector('.group-x'), 'click');
  assert.equal(store.project.studio.groups.length, 0, '× 解散分组');
  assert.ok(store.node(a.id) && store.node(b.id), '解散保留节点');
});

test('端口接线约束：图片输出可进视频参考口；类型不符/自连/重复显式拒绝', async () => {
  await fresh();
  const img = store.addNode('image', 0, 0, defaultNodeData('image'));
  const gen = store.addNode('gen', 400, 0, defaultNodeData('gen'));
  const txt = store.addNode('text', 0, 400, defaultNodeData('text'));
  assert.ok(store.addEdge(img.id, 'out', gen.id, 'refs', 'image'), '图片节点输出必须能接入视频参考口');
  assert.ok(store.addEdge(txt.id, 'out', gen.id, 'prompt', 'text'), '文本可进提示词口');
  assert.equal(store.addEdge(txt.id, 'out', gen.id, 'refs', 'text'), null, '文本不可进素材口');
  assert.equal(store.addEdge(gen.id, 'out', gen.id, 'refs', 'video'), null, '自连拒绝');
  assert.equal(store.addEdge(img.id, 'out', gen.id, 'refs', 'image'), null, '重复连线拒绝');
  board.render();
  assert.equal(edgesSvg().children.length, 2, '连线渲染为路径');
  fire(edgesSvg().children[0], 'pointerdown', { clientX: 200, clientY: 100, button: 0 });
  assert.equal(board.selected?.type, 'edge', '连线可选中');
});

test('弹层隔离：菜单打开时画布快捷键不生效，Esc 只关最上层', async () => {
  await fresh();
  store.addNode('text', 0, 0, defaultNodeData('text'));
  store.addNode('note', 400, 0, defaultNodeData('note'));
  board.render();
  const nEl = rootOf(store.project.nodes[0].id);
  fire(nEl, 'contextmenu', { clientX: 60, clientY: 60 });
  assert.ok(overlay().childElementCount > 0);
  const ctxSel = store.project.nodes[0].id;
  assert.deepEqual(board.selectedIds, [ctxSel], '右键节点菜单会选中目标节点');
  fire(body, 'keydown', { key: 'a', ctrlKey: true });
  assert.deepEqual(board.selectedIds, [ctxSel], '弹层打开时 Ctrl+A 被隔离，选择不扩散');
  fire(body, 'keydown', { key: 'Delete' });
  assert.equal(store.project.nodes.length, 2, '弹层打开时 Delete 不删节点');
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay().childElementCount, 0);
  fire(body, 'keydown', { key: 'a', ctrlKey: true });
  assert.equal(board.selectedIds.length, 2, '关闭后快捷键恢复');
});

test('ui.js popup/menuList：点击外部关闭、Esc 只关最上层、菜单项禁用态', async () => {
  await fresh();
  popup(menuList([{ label: 'A', onPick: () => {} }, { separator: true }, { label: 'B', disabled: true, onPick: () => {} }]), { x: 50, y: 50 });
  const pop1 = overlay().querySelector('.popup');
  assert.equal(pop1.querySelectorAll('.menu-item').length, 2);
  assert.equal(pop1.querySelectorAll('.menu-item')[1].disabled, true, '禁用项真实禁用');
  popup(el('div', { text: 'second' }), { x: 80, y: 80 });
  assert.equal(overlay().childElementCount, 2);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(overlay().childElementCount, 1, 'Esc 只关最上层弹层');
  fire(body, 'pointerdown', { clientX: 5, clientY: 5 });
  assert.equal(overlay().childElementCount, 0, '点外部关闭剩余弹层');
});

test('main.js 静态防线：域模块合同装配、无直发付费请求、文件粘贴让位、抽屉/检查器选择器', () => {
  const src = SRC('main.js');
  for (const f of ['createGenerators', 'createTools', 'createWorkflow', 'createStoryboards',
    'createLibrary', 'createTimeline', 'createProjectHub', 'createAssistant'])
    assert.ok(src.includes(f), `main.js 缺工厂 ${f}`);
  assert.match(src, /modules\.generators\?\.body/, 'text/image 节点体优先走生成模块');
  assert.match(src, /modules\.tools\?\.inspector/, '工具检查器优先走工具模块');
  assert.match(src, /openModule\('projectHub'\)/);
  assert.match(src, /openModule\('assistant'\)/);
  assert.match(src, /moduleStatus/, '模块就绪状态显式可查');
  assert.match(src, /cancelPendingPaste/, '媒体文件粘贴让位节点粘贴');
  assert.ok(!/\.generate\(|createTask\(|uploadAsset\(/.test(src), '装配层不直发付费请求');
  assert.ok(!/\.start\(\{[^}]*confirmed/.test(src), 'UI 启动工作流不绕过确认');
  assert.match(src, /workflowTargets/, '工作流目标=选中集或全部可执行节点');
  assert.match(src, /drawer-close/, '检查器重建保留抽屉关闭钮');
  assert.match(src, /e\.target !== e\.currentTarget && e\.target\.id !== 'nodes' && e\.target\.id !== 'edges'/,
    '仅空白画布点击才收起抽屉');
  assert.match(src, /reason\?\.type === 'project'/, '项目切换清理检查器选中态');
  assert.match(src, /setModelCatalog/, '密钥校验把 /v1/models 全量目录入库（文本/图片探测）');
  const keyUi = SRC('provider-ui.js');
  assert.match(keyUi, /getFingerprint\(\) !== fp/, '密钥指纹快照，await 后丢弃过期校验');
  assert.match(keyUi, /setAvailableModels\(availableIds\)/, '可用集合为密钥返回全部 id，视频仅子集');
  assert.match(src, /createDirectorControls/, '导演台原生控件接入检查器');
  assert.match(src, /预计累计/, '花费显示为标准估算而非已扣费');
  assert.match(src, /text\/plain/, '显式文本剪贴板让位节点粘贴');

  const boardSrc = SRC('board.js');
  assert.match(boardSrc, /getElementById\('board-wrap'\) \?\?/, '缩略图宿主缺位时回退到 board');
  assert.match(boardSrc, /pasteAcrossProject|pasteIntoCurrent/, '跨项目粘贴走 editor 异步适配');
  assert.match(boardSrc, /reason\.type === 'project'/, '项目切换清空按项目隔离的选中集');

  const html = SRC('index.html');
  for (const id of ['project-list', 'btn-new-project', 'btn-rename', 'btn-hub', 'btn-export', 'btn-import',
    'btn-storyboard', 'btn-timeline', 'btn-library', 'btn-assistant', 'btn-key', 'btn-add-asset',
    'workflow-panel', 'task-list', 'asset-list', 'node-search', 'empty-state', 'statusbar',
    'sidebar-resizer', 'inspector-resizer', 'sidebar', 'inspector', 'board', 'nodes', 'edges',
    'overlay-root', 'toast-root', 'btn-undo', 'btn-redo', 'btn-copy', 'btn-paste', 'btn-dup',
    'btn-del-sel', 'btn-group', 'btn-ungroup', 'btn-lock', 'btn-arrange', 'btn-snap',
    'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-minimap', 'btn-left-panel', 'btn-right-panel'])
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}`);
  for (const t of ['text', 'image', 'gen', 'utility', 'director', 'note'])
    assert.ok(html.includes(`data-add-node="${t}"`), `调色板缺 ${t}`);

  const css = SRC('app.css');
  assert.match(css, /@media \(max-width: 900px\)/, '移动端抽屉断点');
  assert.match(css, /\.drawer-close/, '抽屉关闭钮样式');
  assert.match(css, /#sidebar\.open/, '抽屉展开态');
  assert.match(css, /#btn-left-panel, #btn-right-panel \{ display: none/, '抽屉模式隐藏折叠按钮');
});
