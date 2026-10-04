// 大画布可见性/性能回归：纯几何边界 + DOM 桩驱动 board.js 折叠路径（仅 node --test）。
//  · board-visibility.js：viewRect / inflate / intersects / classifyNode / liteModeFor / perfEnabled 边界
//  · 阈值门控：节点数 <40 完全不动；≥40 才启用 .perf-on
//  · 低缩放 lite：min-height 保持实测高、端口仍挂载、豁免（选中/焦点/拖线源）、迟滞带不抖、
//    输入元素实例与任务数据不变、缩放回退恢复
//  · 视口外 off：标记 + contain-intrinsic-size 保高种子，正文子树不卸载
//  · 模块级每项目视口记忆：切走保存、（store 支持重开时）切回恢复
//  · visStats() / boardEl.dataset.vis* 运行时只读统计一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { el } from '../src/ui.js';
import { createBoard } from '../src/board.js';
import {
  VIS_MIN_NODES, VIEW_MARGIN, LOW_ZOOM_ON, LOW_ZOOM_OFF,
  perfEnabled, viewRect, inflate, intersects, classifyNode, liteModeFor,
} from '../src/board-visibility.js';

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
  for (const elx of [boardEl, nodesEl, edgesSvg, overlay, toastRoot, topbar, body, html]) elx._l.clear();
  for (const c of [...boardEl.children]) if (c !== edgesSvg && c !== nodesEl) c.remove();
  DOC._hit = null; DOC.activeElement = null;
  DOC._l.clear(); WIN._l.clear();
  const store = createStore(createMemoryStorage());
  await store.newProject('t');
  return store;
}
const rootOf = id => nodesEl.children.find(c => c.dataset.node === id);
const bodySlotOf = id => rootOf(id).querySelector('.node-body');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 桩无布局：手工喂实测几何（真实浏览器由 offsetHeight 布局读出）
function fakeHeights(h = 120, rh = 200, w = 300) {
  for (const c of nodesEl.children) {
    if (!c.dataset?.node) continue;
    c.querySelector('.node-body').offsetHeight = h;
    c.offsetHeight = rh; c.offsetWidth = w;
  }
}
function seedNodes(store, n, type = 'text') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const data = type === 'text' ? { text: '' } : {};
    ids.push(store.addNode(type, (i % 9) * 340, Math.floor(i / 9) * 260, data).id);
  }
  return ids;
}

// ---------- 纯几何边界 ----------
test('viewRect：缩放/平移 → 世界坐标可视矩形；scale 0 兜底为 1', () => {
  assert.deepEqual(viewRect({ x: 0, y: 0, scale: 1 }, 1200, 800), { x: 0, y: 0, w: 1200, h: 800 });
  assert.deepEqual(viewRect({ x: -240, y: -160, scale: 2 }, 1200, 800), { x: 120, y: 80, w: 600, h: 400 });
  assert.deepEqual(viewRect({ x: 300, y: 150, scale: 0.5 }, 1000, 500), { x: -600, y: -300, w: 2000, h: 1000 });
  assert.deepEqual(viewRect({ x: 10, y: 20, scale: 0 }, 800, 600), { x: -10, y: -20, w: 800, h: 600 });
});

test('inflate：四向外扩余量', () => {
  assert.deepEqual(inflate({ x: 10, y: 20, w: 30, h: 40 }, 5), { x: 5, y: 15, w: 40, h: 50 });
  assert.deepEqual(inflate({ x: 0, y: 0, w: 100, h: 100 }, 0), { x: 0, y: 0, w: 100, h: 100 });
});

test('intersects：边缘相切算可见，外移 1px 不可见', () => {
  const vp = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(intersects({ x: 10, y: 10, w: 20, h: 20 }, vp), true);
  assert.equal(intersects({ x: 100, y: 0, w: 10, h: 10 }, vp), true, '右缘相切可见');
  assert.equal(intersects({ x: 101, y: 0, w: 10, h: 10 }, vp), false, '右缘外 1px 不可见');
  assert.equal(intersects({ x: -10, y: 50, w: 10, h: 10 }, vp), true, '左缘相切可见');
  assert.equal(intersects({ x: -11, y: 50, w: 10, h: 10 }, vp), false);
  assert.equal(intersects({ x: 0, y: -10, w: 10, h: 10 }, vp), true, '上缘相切可见');
  assert.equal(intersects({ x: 0, y: -11, w: 10, h: 10 }, vp), false);
  assert.equal(intersects({ x: 50, y: 100, w: 10, h: 10 }, vp), true, '下缘相切可见');
  assert.equal(intersects({ x: 50, y: 101, w: 10, h: 10 }, vp), false);
});

test('perfEnabled：阈值边界（<40 关闭 / ≥40 启用）', () => {
  assert.equal(perfEnabled(0), false);
  assert.equal(perfEnabled(VIS_MIN_NODES - 1), false);
  assert.equal(perfEnabled(VIS_MIN_NODES), true);
  assert.equal(perfEnabled(200), true);
});

test('classifyNode：exempt > lowZoom > 视口相交；余量内外边界', () => {
  const vp = inflate({ x: 0, y: 0, w: 1000, h: 800 }, VIEW_MARGIN);   // [-240,1240]×[-240,1040]
  const inside = { x: 100, y: 100, w: 300, h: 200 };
  const inMargin = { x: 1100, y: 100, w: 300, h: 200 };              // 出视口但在余量内
  const outside = { x: 1241, y: 100, w: 300, h: 200 };               // 余量外
  assert.equal(classifyNode({ rect: inside, vp }), 'full');
  assert.equal(classifyNode({ rect: inMargin, vp }), 'full', '余量内仍 full——平移不抖');
  assert.equal(classifyNode({ rect: outside, vp }), 'off');
  assert.equal(classifyNode({ rect: outside, vp, exempt: true }), 'full', '豁免优先于 off');
  assert.equal(classifyNode({ rect: inside, vp, lowZoom: true }), 'lite');
  assert.equal(classifyNode({ rect: outside, vp, lowZoom: true }), 'lite', '概览统一折叠');
  assert.equal(classifyNode({ rect: inside, vp, lowZoom: true, exempt: true }), 'full', '豁免优先于 lite');
});

test('liteModeFor：≤ON 进入，≥OFF 退出，中间带迟滞保持', () => {
  assert.equal(liteModeFor(LOW_ZOOM_ON, false), true);
  assert.equal(liteModeFor(LOW_ZOOM_ON + 0.001, false), false);
  assert.equal(liteModeFor(0.5, true), true, '迟滞带内保持 lite');
  assert.equal(liteModeFor(0.5, false), false, '迟滞带内保持 full');
  assert.equal(liteModeFor(LOW_ZOOM_OFF - 0.001, true), true);
  assert.equal(liteModeFor(LOW_ZOOM_OFF, true), false);
  assert.equal(liteModeFor(2, true), false);
});

// ---------- 阈值门控 ----------
test('阈值门控：<40 节点无任何标记；第 40 个起启用 perf-on + 概览折叠', async () => {
  const store = await freshCanvas();
  seedNodes(store, 39);
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' });
  board.render(); fakeHeights();
  board.view.scale = 0.3; board.applyView();
  await sleep(25); board.updateVisibility();
  assert.equal(nodesEl.classList.contains('perf-on'), false, '39 节点不启用');
  assert.equal(boardEl.dataset.visOn, '0');
  assert.equal(boardEl.dataset.visMode, 'full');
  for (const c of nodesEl.children) {
    assert.equal(c.classList.contains('lite'), false);
    assert.equal(c.classList.contains('vis-off'), false);
  }
  const st0 = board.visStats();
  assert.equal(st0.enabled, false); assert.equal(st0.lite, 0); assert.equal(st0.off, 0);
  assert.equal(st0.full, 39); assert.equal(st0.total, 39);
  const n40 = store.addNode('text', 6000, 6000, { text: '' });
  bodySlotOf(n40.id).offsetHeight = 120;
  board.updateVisibility();
  assert.equal(nodesEl.classList.contains('perf-on'), true, '40 节点启用');
  assert.equal(boardEl.dataset.visOn, '1');
  assert.equal(board.visStats().lite, 40, '低缩放下全部非豁免折叠');
});

// ---------- 低缩放 lite ----------
test('低缩放 lite：保高/保端口/豁免/迟滞/恢复；输入实例与任务数据原样', async () => {
  const store = await freshCanvas();
  const ids = seedNodes(store, 45);
  store.addEdge(ids[2], 'out', ids[3], 'prompt', 'text');
  const bodies = new Map();
  const board = createBoard({
    store, kindOf: () => 'media', bodyKey: () => 'v1',
    renderBody: n => { const inp = el('input', { type: 'text' }); bodies.set(n.id, inp); return inp; },
  });
  board.render(); fakeHeights();
  const inp2 = bodies.get(ids[2]);
  inp2.value = 'unsaved-draft';                          // 模拟未保存输入
  board.select('node', ids[0]);                          // 选中豁免
  bodies.get(ids[1]).focus();                            // 焦点豁免
  board.view.scale = 0.3; board.applyView();
  await sleep(25); board.updateVisibility();

  const st = board.visStats();
  assert.equal(st.liteMode, true);
  assert.equal(st.lite, 43, '45 - 选中 - 焦点');
  assert.equal(st.full, 2);
  assert.equal(st.off, 0);
  assert.equal(boardEl.dataset.visMode, 'lite');
  assert.equal(boardEl.dataset.visLite, '43');
  const [r0, r1, r2] = [rootOf(ids[0]), rootOf(ids[1]), rootOf(ids[2])];
  assert.equal(r0.classList.contains('lite'), false, '选中节点豁免');
  assert.equal(r1.classList.contains('lite'), false, '焦点节点豁免');
  assert.equal(r2.classList.contains('lite'), true);
  const slot2 = bodySlotOf(ids[2]);
  assert.equal(slot2.style.minHeight, '120px', '折叠保持实测高——端口/连线锚点不偏移');
  assert.equal(slot2.children[0], inp2, '正文子元素只隐藏不卸载');
  assert.equal(inp2.value, 'unsaved-draft', '未保存输入保留');
  assert.ok(r2.querySelector('.port.in .dot') && r2.querySelector('.port.out .dot'), '端口仍挂载');
  assert.ok(Number.isFinite(board.portCenter(ids[2], 'out', 'out').x), '连线端点可用');
  assert.ok(edgesSvg.querySelector('[data-edge]'), '连线 DOM 保留');
  assert.equal(board.measureNode(store.node(ids[2])).h, 200, '节点总高不变');

  // 拖线源豁免：lite 中从端口起拖 → 源节点恢复 full，松手后回到 lite
  fire(r2.querySelector('.port.out'), 'pointerdown', { button: 0, pointerId: 9, pointerType: 'mouse', buttons: 1, clientX: 700, clientY: 60 });
  board.updateVisibility();
  assert.equal(r2.classList.contains('lite'), false, '拖线源节点豁免折叠');
  assert.equal(board.visStats().lite, 42);
  fire(WIN, 'pointerup', { pointerId: 9, pointerType: 'mouse', buttons: 0, clientX: 700, clientY: 60 });
  board.updateVisibility();
  assert.equal(r2.classList.contains('lite'), true, '拖线结束回到 lite');

  // 迟滞带：0.5 保持 lite；升到 0.8 才退出
  board.view.scale = 0.5; board.applyView(); board.updateVisibility();
  assert.equal(board.visStats().liteMode, true, '迟滞带内保持 lite');
  board.view.scale = 0.8; board.applyView();
  await sleep(25); board.updateVisibility();
  const st2 = board.visStats();
  assert.equal(st2.lite, 0);
  assert.equal(st2.liteMode, false);
  assert.equal(r2.classList.contains('lite'), false);
  assert.equal(slot2.style.minHeight, '');
  assert.equal(slot2.children[0], inp2, '恢复后仍是同一元素实例');
  assert.equal(inp2.value, 'unsaved-draft', '往返后输入值仍在');
  // 任务数据不被折叠路径触碰
  store.updateNodeData(ids[4], { run: { state: 'running' } });
  board.updateVisibility();
  assert.equal(store.node(ids[4]).data.run.state, 'running', '进行中任务数据不变');
});

// ---------- 视口外 off ----------
test('常规缩放视口外标 vis-off：正文不卸载 + contain-intrinsic 保高；进入视口恢复', async () => {
  const store = await freshCanvas();
  const ids = [];
  for (let i = 0; i < 42; i++) ids.push(store.addNode('text', i * 400, 0, { text: '' }).id);
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' });
  board.render(); fakeHeights(110, 200, 300);
  board.updateVisibility();   // view {40,40,1} → 余量视口 x∈[-280,1400]：i≤3 full，i≥4 off
  const st = board.visStats();
  assert.equal(st.enabled, true);
  assert.equal(st.liteMode, false);
  assert.equal(st.full, 4);
  assert.equal(st.off, 38);
  const far = rootOf(ids[41]);   // x=16400 远在视口外
  const near = rootOf(ids[0]);   // x=0 视口内
  assert.equal(far.classList.contains('vis-off'), true);
  assert.equal(far.classList.contains('lite'), false, 'off 不折叠，仅靠 content-visibility 跳过');
  assert.equal(near.classList.contains('vis-off'), false);
  const slot = bodySlotOf(ids[41]);
  assert.equal(slot.style.containIntrinsicSize, 'auto 110px', 'offscreen 以实测高做占位种子');
  assert.equal(slot.children.length, 1, 'off 正文仍在 DOM');
  assert.equal(slot.style.minHeight ?? '', '', 'off 不写 min-height');
  assert.equal(boardEl.dataset.visOff, '38', 'dataset 与 stats 一致');
  assert.equal(boardEl.dataset.visMode, 'full');
  // 平移使远端节点进入视口 → 标记即时恢复
  board.view.x = -15800; board.applyView(); board.updateVisibility();
  assert.equal(far.classList.contains('vis-off'), false, '进入视口恢复 full');
  assert.equal(near.classList.contains('vis-off'), true, '原近处节点转 off');
});

// ---------- 每项目视口记忆 ----------
test('模块级每项目视口记忆：切走保存；store 支持重开时恢复', async () => {
  const store = await freshCanvas();
  const board = createBoard({ store, renderBody: () => el('div'), kindOf: () => 'media' });
  board.render();
  const pidA = store.project.id ?? store.project.name;
  board.view.x = -500; board.view.y = -260; board.view.scale = 0.1;
  board.applyView();
  await store.newProject('second');
  const pidB = store.project.id ?? store.project.name;
  assert.notEqual(pidB, pidA);
  assert.deepEqual(board.savedView(pidA), { x: -500, y: -260, scale: 0.1 }, '切换前视口已保存');
  assert.equal(board.savedView(pidB), null, '新项目暂无记忆');
  const reopen = ['openProject', 'loadProject', 'switchProject', 'selectProject', 'setProject']
    .find(m => typeof store[m] === 'function');
  if (reopen) {
    board.view.x = 1; board.view.y = 2; board.view.scale = 1.5; board.applyView();
    await store[reopen](pidA);
    assert.equal(board.view.x, -500);
    assert.equal(board.view.y, -260);
    assert.equal(board.view.scale, 0.1, 'fit 后的最小概览比例也必须原样恢复');
    assert.deepEqual(board.savedView(pidB), { x: 1, y: 2, scale: 1.5 }, '离开 B 时同样记忆');
  }
});

// ---------- 建议主控 e2e 场景（真实 Chromium + CANVAS_TEST_DIST 构建）----------
//  · 50/100/200 节点：滚轮缩至 ≤0.45 → #nodes.perf-on + .lite 生效；节点总高与端口
//    getBoundingClientRect 折叠前后差 <1px；缩放回到 ≥0.58 全部恢复。
//  · 概览下框选命中数不变、拖线可落 lite 节点端口；选中节点自动脱离 lite。
//  · 平移甩动：dataset.visOff 计数增长，node-body DOM 不增删（MutationObserver childList=0）。
//  · 项目 A 平移缩放 → 切 B → 切回 A：view 恢复；textarea 未保存内容折叠往返后保留。
