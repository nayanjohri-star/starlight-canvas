
// ===== 桌面壳（SWE-2）追加测试 =====
// 自带极简 DOM 桩，不复用既有夹具、不改既有断言。覆盖：模块/模型缺席可装配、
// rail 互斥与关闭、创建搜索过滤与清空、项目菜单反复开关+触发模态不误关、选择态显隐。
const { test: dtest } = await import('node:test');
const dassert = (await import('node:assert')).strict;

function dMatch(n, sel) {
  return String(sel).split(',').some(raw => {
    const s = raw.trim(); if (!s) return false;
    let m = s.match(/^#([\w-]+)$/); if (m) return n.attrs?.id === m[1];
    m = s.match(/^\.([\w-]+)$/); if (m) return n.classes?.has(m[1]);
    m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); if (m) return m[2] === undefined ? n.attrs?.[m[1]] != null : n.attrs?.[m[1]] === m[2];
    m = s.match(/^([\w-]+)\.([\w-]+)$/); if (m) return n.tagName === m[1].toUpperCase() && n.classes?.has(m[2]);
    if (/^[\w-]+$/.test(s)) return n.tagName === s.toUpperCase();
    return false;
  });
}
function dQsa(root, sel) {
  const out = [];
  (function walk(n) { for (const c of n.children ?? []) { if (c.tagName && dMatch(c, sel)) out.push(c); walk(c); } })(root);
  return out;
}
function dEl(tag) {
  const ls = {};
  let text = null;
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, attrs: {}, style: {}, dataset: {},
    classes: new Set(),
    hidden: false, disabled: false, value: '',
    offsetWidth: 0, offsetHeight: 0,
    _ls: () => ls,
    get className() { return [...node.classes].join(' '); },
    set className(v) { node.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get classList() {
      return {
        add: (...c) => c.forEach(x => node.classes.add(x)),
        remove: (...c) => c.forEach(x => node.classes.delete(x)),
        toggle: (c, f) => { const on = f === undefined ? !node.classes.has(c) : !!f; if (on) node.classes.add(c); else node.classes.delete(c); return on; },
        contains: c => node.classes.has(c),
      };
    },
    get textContent() { return text ?? node.children.map(c => c.textContent ?? '').join(''); },
    set textContent(v) { text = String(v); node.children.length = 0; },
    get childElementCount() { return node.children.length; },
    get lastElementChild() { return node.children[node.children.length - 1] ?? null; },
    get firstElementChild() { return node.children[0] ?? null; },
    get isConnected() { let n = node; while (n.parentNode) n = n.parentNode; return n === dRoot; },
    setAttribute(k, v) {
      node.attrs[k] = String(v);
      if (k.startsWith('data-')) node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    },
    getAttribute(k) { return node.attrs[k] ?? null; },
    removeAttribute(k) { delete node.attrs[k]; },
    addEventListener(t, fn) { (ls[t] ??= []).push(fn); },
    removeEventListener(t, fn) { const a = ls[t]; const i = a ? a.indexOf(fn) : -1; if (i >= 0) a.splice(i, 1); },
    dispatchEvent(e) {
      e.target ??= node; e._stop = false;
      e.stopPropagation ??= () => { e._stop = true; };
      e.preventDefault ??= () => {};
      let n = node;
      while (n) {
        for (const fn of [...(n._ls?.()[e.type] ?? [])]) fn(e);
        if (e._stop) break;
        n = n.parentNode;
      }
      return true;
    },
    click() { node.dispatchEvent({ type: 'click', button: 0 }); },
    focus() { dDoc.activeElement = node; },
    blur() { if (dDoc.activeElement === node) dDoc.activeElement = null; },
    select() {},
    append(...kids) { for (const k of kids.flat()) { if (k == null) continue; k.remove?.(); k.parentNode = node; node.children.push(k); } },
    prepend(...kids) { for (const k of kids.flat()) { if (k == null) continue; k.remove?.(); k.parentNode = node; node.children.unshift(k); } },
    replaceChildren(...kids) { for (const c of node.children) c.parentNode = null; node.children = []; text = null; node.append(...kids); },
    remove() { const p = node.parentNode; if (p) { const i = p.children.indexOf(node); if (i >= 0) p.children.splice(i, 1); node.parentNode = null; } },
    contains(o) { let n = o; while (n) { if (n === node) return true; n = n.parentNode; } return false; },
    matches(sel) { return dMatch(node, sel); },
    closest(sel) { let n = node; while (n) { if (n.matches?.(sel)) return n; n = n.parentNode; } return null; },
    querySelector(sel) { return dQsa(node, sel)[0] ?? null; },
    querySelectorAll(sel) { return dQsa(node, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}
const dRoot = dEl('body');
const dDoc = {
  activeElement: null,
  createElement: t => dEl(t),
  createElementNS: (ns, t) => dEl(t),
  getElementById: id => dQsa(dRoot, `#${id}`)[0] ?? null,
  querySelector: s => (dMatch(dRoot, s) ? dRoot : (dQsa(dRoot, s)[0] ?? null)),
  querySelectorAll: s => dQsa(dRoot, s),
  addEventListener() {}, removeEventListener() {},
  body: dRoot,
};
function dSetup() {
  const prev = {
    document: globalThis.document, matchMedia: globalThis.matchMedia,
    innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
    localStorage: globalThis.localStorage,
  };
  for (const c of dRoot.children) c.parentNode = null;
  dRoot.children = []; dDoc.activeElement = null;
  globalThis.document = dDoc;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.innerWidth = 1440; globalThis.innerHeight = 900;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  return () => Object.assign(globalThis, prev);
}
function dFixture() {
  const topbar = dEl('header'); topbar.setAttribute('id', 'topbar');
  const hLeft = dEl('div'); hLeft.className = 'h-left';
  const pl = dEl('select'); pl.setAttribute('id', 'project-list');
  const pmb = dEl('button'); pmb.setAttribute('id', 'btn-project-menu'); pmb.textContent = '项目 ▾';
  const home = dEl('div'); home.setAttribute('id', 'project-menu-home'); home.hidden = true;
  const pop = dEl('div'); pop.className = 'menu-pop';
  home.append(pop);
  hLeft.append(pl, pmb, home);
  for (const id of ['btn-new-project', 'btn-rename', 'btn-hub', 'btn-workspace', 'btn-export', 'btn-import']) {
    const b = dEl('button'); b.setAttribute('id', id); b.textContent = id; hLeft.append(b);
  }
  topbar.append(hLeft);
  const boardWrap = dEl('main'); boardWrap.setAttribute('id', 'board-wrap');
  const toolbar = dEl('div'); toolbar.setAttribute('id', 'canvas-toolbar');
  for (const id of ['btn-undo', 'btn-redo', 'btn-copy', 'btn-paste', 'btn-dup', 'btn-del-sel', 'btn-group', 'btn-ungroup', 'btn-lock', 'btn-arrange', 'btn-snap', 'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-minimap', 'btn-left-panel', 'btn-right-panel']) {
    const b = dEl('button'); b.setAttribute('id', id); b.textContent = id; toolbar.append(b);
  }
  const ns = dEl('input'); ns.setAttribute('id', 'node-search'); toolbar.append(ns);
  const sidebar = dEl('aside'); sidebar.setAttribute('id', 'sidebar');
  const panels = {};
  const mk = (dock, build) => { const s = dEl('section'); s.className = 'panel'; s.setAttribute('data-dock', dock); build?.(s); sidebar.append(s); panels[dock] = s; };
  mk('create', s => {
    const cs = dEl('input'); cs.setAttribute('id', 'create-search'); s.append(cs);
    const g1 = dEl('div'); g1.className = 'cg';
    const up = dEl('button'); up.setAttribute('id', 'btn-add-asset'); up.textContent = '上传素材'; g1.append(up); s.append(g1);
    const g2 = dEl('div'); g2.className = 'cg';
    for (const [t, label] of [['text', '＋ 文本 / 剧本'], ['image', '＋ 图片生成'], ['gen', '＋ 视频生成'], ['director', '＋ 导演台'], ['note', '＋ 便签']]) {
      const b = dEl('button'); b.setAttribute('data-add-node', t); b.textContent = label; g2.append(b);
    }
    s.append(g2);
    const g3 = dEl('div'); g3.className = 'cg';
    const ub = dEl('button'); ub.setAttribute('data-add-node', 'utility'); ub.textContent = '＋ 工具'; g3.append(ub);
    const tl = dEl('div'); tl.setAttribute('id', 'tpl-list'); g3.append(tl);
    s.append(g3);
  });
  mk('asset', s => { const l = dEl('div'); l.setAttribute('id', 'asset-list'); s.append(l); });
  mk('run', s => { const w = dEl('div'); w.setAttribute('id', 'workflow-panel'); s.append(w); });
  mk('task', s => { const t = dEl('div'); t.setAttribute('id', 'task-list'); s.append(t); });
  const statusbar = dEl('div'); statusbar.setAttribute('id', 'statusbar');
  const empty = dEl('div'); empty.setAttribute('id', 'empty-state'); empty.className = 'hidden';
  const sbr = dEl('div'); sbr.setAttribute('id', 'sidebar-resizer');
  boardWrap.append(toolbar, statusbar, empty, sidebar, sbr);
  const inspector = dEl('aside'); inspector.setAttribute('id', 'inspector');
  const ibr = dEl('div'); ibr.setAttribute('id', 'inspector-resizer');
  const overlay = dEl('div'); overlay.setAttribute('id', 'overlay-root');
  const toastR = dEl('div'); toastR.setAttribute('id', 'toast-root');
  dRoot.append(topbar, boardWrap, inspector, ibr, overlay, toastR);
  return { topbar, boardWrap, toolbar, sidebar, panels, home, pop, overlay, statusbar, empty };
}
function dDeps() {
  const spawned = [];
  const store = {
    project: { nodes: [], edges: [], assets: {}, studio: { groups: [] } },
    onChange() { return () => {}; },
    node(id) { return this.project.nodes.find(n => n.id === id) ?? null; },
    touch() {}, saveSoon() {}, addEdge() { return null; },
  };
  const board = {
    selectedIds: [], view: { scale: 1 }, snap: { grid: true, align: true },
    onViewChange() { return () => {}; }, setEdgeMenu() {},
    focusNode() { return true; }, selectMany() {}, pasteNodes() {},
    deleteSelection() {}, ungroupSelection() {}, removeEdge() {},
    fit() {}, zoomBy() {}, toWorld: () => ({ x: 0, y: 0 }),
  };
  const editor = {
    checkpoint() {}, copy: () => true, undo: () => true, redo: () => true,
    duplicate: () => [], group() {}, lock() {}, arrange() {}, delete() {},
  };
  return {
    store, editor, board, spawned,
    assets: null,
    spawnPos: () => ({ x: 0, y: 0 }),
    spawnNodeAt: (type, pos, data) => { const n = { id: `n${spawned.length + 1}`, type, data: data ?? {} }; spawned.push(n); store.project.nodes.push(n); return n; },
    addFilesAt: async () => [],
    openModule: () => true,
    storyboards: null,
  };
}

dtest('桌面壳：域模块/模型缺席也能装配，空态四动作真实可用', async () => {
  const undo = dSetup();
  try {
    const fx = dFixture(); const deps = dDeps();
    const { createStudioShell } = await import('../src/studio-shell.js');
    const shell = createStudioShell(deps);
    dassert.ok(shell?.refreshChrome, 'shell 装配成功');
    dassert.ok(dDoc.getElementById('rail'), 'rail 已创建');
    dassert.equal(fx.panels.create.classList.contains('on'), true, '默认仅轻量创建面板激活');
    dassert.match(fx.statusbar.textContent, /节点 0/, '状态栏渲染');
    const cards = dQsa(dDoc.getElementById('empty-state'), '.tpl-item');
    dassert.equal(cards.length, 4, '空态恰四个动作');
    cards[0].click();
    dassert.equal(deps.spawned[0]?.type, 'gen', '「新建视频节点」真实落 gen 节点');
    cards[2].click();
    dassert.deepEqual(deps.spawned.map(n => n.type).slice(1), ['text', 'gen'], 'text2video 模板真实建图');
    cards[3].click();
    dassert.equal(deps.spawned.filter(n => n.type === 'image').length, 4, 'grid 模板缺分镜模块时兜底建 4 图');
    shell.dispose?.();
  } finally { undo(); }
});

dtest('桌面壳：rail 互斥切换与关闭重开', async () => {
  const undo = dSetup();
  try {
    const fx = dFixture(); const deps = dDeps();
    const shell = (await import('../src/studio-shell.js')).createStudioShell(deps);
    const rail = dDoc.getElementById('rail');
    const [bCreate, bAsset] = rail.children;
    dassert.equal(fx.sidebar.classList.contains('collapsed'), true, '默认收起，空画布不被创建面板遮住');
    dassert.equal(fx.panels.create.classList.contains('on'), true);
    dassert.equal(fx.panels.asset.classList.contains('on'), false);
    bAsset.click();
    dassert.equal(fx.panels.asset.classList.contains('on'), true, '素材面板独占显示');
    dassert.equal(fx.panels.create.classList.contains('on'), false);
    dassert.equal(bAsset.getAttribute('aria-pressed'), 'true');
    bAsset.click();
    dassert.equal(fx.sidebar.classList.contains('collapsed'), true, '同钮再点收起 dock');
    dassert.equal(fx.sidebar.style.width, '0', '宽度只走 panelState 内联为 0');
    bAsset.click();
    dassert.equal(fx.sidebar.classList.contains('collapsed'), false, '重开不丢面板');
    dassert.equal(fx.panels.asset.classList.contains('on'), true);
    bCreate.click();
    dassert.equal(fx.panels.create.classList.contains('on'), true);
    dassert.equal(fx.panels.asset.classList.contains('on'), false);
    shell.dispose?.();
  } finally { undo(); }
});

dtest('桌面壳：创建面板搜索过滤与清空恢复', async () => {
  const undo = dSetup();
  try {
    const fx = dFixture(); const deps = dDeps();
    (await import('../src/studio-shell.js')).createStudioShell(deps);
    const cs = dDoc.getElementById('create-search');
    dassert.equal(dQsa(dDoc.getElementById('tpl-list'), 'button').length, 5, '五个模板全部可达');
    cs.value = '视频';
    cs.dispatchEvent({ type: 'input' });
    const vis = dQsa(fx.panels.create, 'button').filter(b => !b.hidden).map(b => b.textContent);
    dassert.ok(vis.some(t => t.includes('视频生成')), '视频生成节点可见');
    dassert.ok(vis.some(t => t.includes('文本 → 视频')), '模板可搜到');
    dassert.ok(!vis.some(t => t.includes('便签')), '无关项隐藏');
    cs.value = '';
    cs.dispatchEvent({ type: 'input' });
    dassert.ok(dQsa(fx.panels.create, 'button').every(b => !b.hidden), '清空后全部恢复');
    dassert.ok(dQsa(fx.panels.create, '.cg').every(g => !g.hidden), '分组全部恢复');
  } finally { undo(); }
});

dtest('桌面壳：项目菜单反复开关、按钮回巢、触发模态不被误关', async () => {
  const undo = dSetup();
  try {
    const fx = dFixture(); const deps = dDeps();
    const { createStudioShell } = await import('../src/studio-shell.js');
    const { modal } = await import('../src/ui.js');
    createStudioShell(deps);
    const pmb = dDoc.getElementById('btn-project-menu');
    const overlay = dDoc.getElementById('overlay-root');
    const home = dDoc.getElementById('project-menu-home');
    const pop = home.querySelector('.menu-pop');
    dassert.equal(dQsa(pop, '.menu-item').length, 5, '五枚项目动作在菜单内，导出独立放在顶栏');
    dassert.ok(!pop.contains(dDoc.getElementById('btn-export')), '导出不被迁入隐藏容器');
    let modalOpened = 0;
    dDoc.getElementById('btn-rename').addEventListener('click', () => { modalOpened++; modal(dEl('div')); });
    pmb.click();
    dassert.equal(overlay.childElementCount, 1, '弹层打开');
    dassert.ok(overlay.contains(pop), '菜单容器在弹层内');
    dDoc.getElementById('btn-rename').click();
    dassert.equal(modalOpened, 1, '原按钮监听仍生效');
    dassert.equal(overlay.childElementCount, 1, '菜单已关且新模态未被误关');
    dassert.ok(home.contains(pop), '菜单容器回到保留容器');
    pmb.click();
    dassert.equal(overlay.childElementCount, 2, '菜单可再次打开（模态+弹层）');
    dDoc.getElementById('btn-import').click();
    dassert.equal(overlay.childElementCount, 1, '再次触发动作后菜单关闭、模态仍在');
    pmb.click();
    dassert.equal(overlay.childElementCount, 2, '第三次仍能打开');
    dassert.equal(dQsa(pop, '.menu-item').length, 5, '按钮本体未被 remove');
  } finally { undo(); }
});

dtest('桌面壳：选择态驱动 sel-bar 显隐，undo/redo/paste 常驻视图条', async () => {
  const undo = dSetup();
  try {
    const fx = dFixture(); const deps = dDeps();
    const shell = (await import('../src/studio-shell.js')).createStudioShell(deps);
    const viewBar = dDoc.getElementById('view-bar'), selBar = dDoc.getElementById('sel-bar');
    dassert.ok(viewBar.contains(dDoc.getElementById('btn-undo')), 'undo 常驻视图条');
    dassert.ok(viewBar.contains(dDoc.getElementById('btn-redo')), 'redo 常驻视图条');
    dassert.ok(viewBar.contains(dDoc.getElementById('btn-paste')), 'paste 常驻视图条');
    dassert.ok(viewBar.contains(dDoc.getElementById('btn-right-panel')), '检查器重开钮常驻');
    dassert.ok(selBar.contains(dDoc.getElementById('btn-copy')), 'copy 在选中条');
    dassert.ok(selBar.contains(dDoc.getElementById('btn-del-sel')), '删除在选中条');
    dassert.equal(fx.toolbar.children.length, 0, '桌面模式工具行已腾空');
    deps.board.selectedIds = ['n1'];
    shell.refreshChrome();
    dassert.equal(fx.boardWrap.classList.contains('has-selection'), true, '有选择→has-selection');
    deps.board.selectedIds = [];
    shell.refreshChrome();
    dassert.equal(fx.boardWrap.classList.contains('has-selection'), false, '无选择→撤标记');
    shell.dispose?.();
  } finally { undo(); }
});
