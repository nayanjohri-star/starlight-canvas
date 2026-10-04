// 画布外壳（canvas 域自有）：顶部工具栏、节点搜索/聚焦、空白态与模板、
// 添加节点菜单（右键/双击/拖线落空）、节点右键菜单、分组动作、状态栏、侧栏缩放/折叠。
// 全部走 ui.js 的安全 DOM（el/popup/menuList），不写 innerHTML。

import { el, toast, popup, popupMenu, menuList, confirmDialog } from './ui.js';
import { icon, applyIcon } from './icons.js';
import { NODE_TYPES } from './store.js';
import { studioState } from './studio-schema.js';
import { feature } from './runtime-config.js';

// 极简 queryAll：旧测试 DOM 桩可能缺 querySelectorAll——退回空集而不是抛错（与 ui.js 同策略）
const qa = (root, sel) => (typeof root?.querySelectorAll === 'function' ? [...root.querySelectorAll(sel)] : []);

// 添加菜单顺序与默认数据（asset 不在菜单：素材节点由素材库/拖文件/粘贴生成）
export const ADD_MENU_TYPES = ['text', 'image', 'gen', 'utility', 'director', 'note'];
export const TYPE_LABEL = Object.fromEntries(Object.entries(NODE_TYPES).map(([k, v]) => [k, v.title]));

export function defaultNodeData(type) {
  switch (type) {
    case 'gen':
      return { title: '视频生成', draft: { model: 'minimax-h3-768p-per-second', intent: 'text', seconds: 15, ratio: '16:9', prompt: '', switches: { generate_audio: true, face_mode: false } }, perModel: {}, run: null };
    case 'text':
      return { title: '文本 / 剧本', text: '', resultText: '' };
    case 'image':
      return { title: '图片生成', prompt: '', params: {}, outputAssetIds: [] };
    case 'utility':
      return { title: '工具', tool: 'text_input', params: {}, outputText: '', outputAssetIds: [] };
    case 'director':
      return { title: '导演台' };
    case 'note':
      return { title: '便签', text: '' };
    default:
      return {};
  }
}

export const TEMPLATES = [
  { key: 'text2video', title: '文本 → 视频', desc: '文本节点驱动视频生成提示词' },
  { key: 'refvideo', title: '素材参考视频', desc: '图片/视频/音频素材进参考口' },
  { key: 'frames', title: '首尾帧视频', desc: '首帧/首尾帧图片驱动生成' },
  { key: 'grid', title: '分镜网格 ×4', desc: '创建四个分镜，分别编辑画面和生成参数' },
  { key: 'batch', title: '批量生成', desc: 'CSV 批量表 + 文本 + 视频生成' },
];

export function createStudioShell({ store, editor, board, assets, spawnPos, spawnNodeAt, addFilesAt, openModule, storyboards, directorGate }) {
  const $ = s => document.querySelector(s);
  const disposers = [];
  const boardWrap = $('#board-wrap');
  // 桌面壳媒体查询：桩环境无 matchMedia 时按桌面处理——壳全部装配，行为可断言
  const mqDesktop = globalThis.matchMedia?.('(min-width:901px)') ?? null;
 const isDesktop = () => (mqDesktop ? !!mqDesktop.matches : true);

  // ---------- 小工具 ----------
  function checkpointed(fn) { editor?.checkpoint(); fn(); }
  function studio() { return studioState(store.project); }

  // ---------- 状态栏 ----------
  const statusbar = $('#statusbar');
  let statusExtra = '';
  function refreshStatus() {
    if (!statusbar) return;
    const p = store.project;
    const sel = board.selectedIds.length;
    const groups = p?.studio?.groups?.length ?? 0;
    const parts = [
      `节点 ${p?.nodes.length ?? 0}`, `连线 ${p?.edges.length ?? 0}`,
      `缩放 ${Math.round(board.view.scale * 100)}%`,
      sel ? `选中 ${sel}` : null, groups ? `分组 ${groups}` : null,
      statusExtra || null,
    ].filter(Boolean);
    const text = parts.join(' · ');
    if (statusbar.textContent !== text) statusbar.textContent = text;
    // 选择态驱动壳显隐：sel-bar 只在有选中时出现（undo/redo/paste 在视图条常驻，不受此影响）
    boardWrap?.classList?.toggle('has-selection', sel > 0);
    refreshSelActions(p, board.selectedIds);
  }
  // 选中操作按当前选择给出可用性：不适用的操作禁用并在提示中说明原因；锁定按钮在全部已锁定时显示「解锁」
  function refreshSelActions(p, ids) {
    const chosen = new Set(ids);
    const inGroup = (p?.studio?.groups ?? []).some(g => g.members?.some(id => chosen.has(id)));
    const nodes = ids.map(id => store.node(id)).filter(Boolean);
    const allLocked = nodes.length > 0 && nodes.every(n => n.data?.locked === true);
    const avail = (id, ok, why) => {
      const btn = document.getElementById(id); if (!btn) return;
      btn.dataset.origTitle ??= btn.title ?? '';
      if (btn.disabled !== !ok) btn.disabled = !ok;
      const title = ok ? btn.dataset.origTitle : why;
      if (btn.title !== title) btn.title = title;
    };
    avail('btn-group', ids.length >= 2, '成组需要至少选中 2 个节点');
    avail('btn-ungroup', inGroup, '所选节点不在任何分组中');
    avail('btn-arrange', ids.length >= 2, '排列需要至少选中 2 个节点');
    const lockLabel = document.getElementById('btn-lock')?.querySelector?.('.ic-label');
    const lockText = allLocked ? '解锁' : '锁定';
    if (lockLabel && lockLabel.textContent !== lockText) lockLabel.textContent = lockText;
  }
  function setStatus(text) { statusExtra = text ?? ''; refreshStatus(); }

  // ---------- 空白态 ----------
  const emptyEl = $('#empty-state');
  function refreshEmpty() {
    if (!emptyEl) return;
    const empty = !(store.project?.nodes.length);
    emptyEl.classList.toggle('hidden', !empty);
  }
  const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4';
  // 真实上传入口：文件入库并在世界坐标落素材节点（空态/添加菜单共用，无伪实现、不碰付费路径）
  function pickFiles(worldPos = null) {
    const inp = el('input', { type: 'file', multiple: true, accept: FILE_ACCEPT });
    inp.addEventListener('change', () => addFilesAt([...inp.files], worldPos ?? undefined));
    inp.click();
  }
  function buildEmpty() {
    if (!emptyEl) return;
    const action = (title, desc, iconName, fn) => {
      const b = el('button', { class: 'tpl-item', type: 'button' },
        icon(iconName),
        el('span', { class: 'tpl-txt' },
          el('b', { text: title }), el('small', { class: 'muted', text: desc })));
      b.addEventListener('click', fn);
      return b;
    };
    // 四个真正可用的开始动作：建生成节点 / 上传素材 / 两个模板；其余模板迁到创建面板「工具」组
    emptyEl.replaceChildren(
      el('div', { class: 'empty-card' },
        el('h3', { text: '从空白画布开始' }),
        el('div', { class: 'tpl-grid' },
          action('新建视频节点', '生成节点 · 选模型写提示词', 'video', () => { spawnNodeAt('gen', spawnPos(), defaultNodeData('gen')); }),
          action('上传素材', '图片/视频/音频入库并落到画布', 'upload', () => pickFiles()),
          action('模板：文本 → 视频', '文本节点驱动视频生成', 'template', () => applyTemplate('text2video')),
          action('模板：分镜网格 ×4', '创建四个分镜，成组编辑', 'arrange', () => applyTemplate('grid'))),
        el('p', { class: 'hint', text: '双击或右键画布空白处添加节点；拖入图片/视频/音频文件直接建素材节点；Ctrl+V 可粘贴剪贴板图片。' })));
  }

  // ---------- 模板（真实节点图，可撤销）----------
  function applyTemplate(key) {
    const p = spawnPos();
    editor?.checkpoint();
    const made = [];
    const put = (type, dx, dy, data) => {
      const n = spawnNodeAt(type, { x: p.x + dx * 1.25, y: p.y + dy * 1.35 }, data ?? defaultNodeData(type));
      made.push(n); return n;
    };
    switch (key) {
      case 'text2video': {
        const t = put('text', -140, 0, { title: '剧本 / 提示词', text: '' });
        const g = put('gen', 160, 0);
        store.addEdge(t.id, 'out', g.id, 'prompt', 'text');
        break;
      }
      case 'refvideo': {
        put('note', -140, -30, { title: '用法', text: '上传素材 → 拖到画布生成素材节点 → 连到「素材」输入口；提示词内可用 @图片1/@视频1/@音频1 引用。' });
        const g = put('gen', 160, 0);
        g.data.draft.intent = 'refs';
        break;
      }
      case 'frames': {
        put('note', -140, -30, { title: '用法', text: '把图片素材节点连到「首尾帧」输入口：SD 需恰好两张，H3 支持 1–2 张。' });
        const g = put('gen', 160, 0);
        g.data.draft.intent = 'frames';
        break;
      }
      case 'grid': {
        if (typeof storyboards?.createGrid === 'function') { storyboards.createGrid(4); break; }
        const imgs = [[-140, -120], [160, -120], [-140, 160], [160, 160]].map(([dx, dy]) => put('image', dx, dy));
        studio().groups.push({ id: `g_${crypto.randomUUID?.() ?? Date.now()}`, title: '分镜组（4）', members: imgs.map(n => n.id) });
        store.touch({ type: 'structure' });
        break;
      }
      case 'batch': {
        put('utility', -160, 0, { title: 'CSV 批量表', tool: 'batch_table', params: {}, outputText: '', outputAssetIds: [] });
        const t = put('text', -160, 200, { title: '提示词模板', text: '主体：{{主体}}，风格：{{风格}}' });
        const g = put('gen', 180, 60);
        store.addEdge(t.id, 'out', g.id, 'prompt', 'text');
        put('note', 180, 260, { title: '用法', text: '在批量表节点贴入 CSV（表头即字段名），用「工作流」面板按行批量提交；提示词里写 {{列名}} 取该行字段。' });
        break;
      }
      default: return;
    }
    store.touch({ type: 'structure' });
    if (made.length) board.selectMany(made.map(n => n.id));
    refreshChrome();
    toast('模板已创建，可撤销（Ctrl+Z）', 'ok');
  }

  // ---------- 添加节点菜单 ----------
  // pos = {world:{x,y}, clientX, clientY}；wire = 拖线落空时待接的 {from:{node,port,kind}}
  function openAddMenu(pos, wire = null) {
    const items = [];
    if (wire) items.push({ label: '创建并连接到来源', disabled: true, hint: { image: '图片', video: '视频', audio: '音频', text: '文本', media: '素材', any: '任意' }[wire.from.kind] ?? wire.from.kind });
    for (const t of ADD_MENU_TYPES) {
      items.push({
        label: `＋ ${TYPE_LABEL[t] ?? t}`,
        ...(t === 'director' && !feature('hostedDirector') ? { hint: '开发中' } : {}),
        onPick: () => {
          // 导演台只在服务确认资源完整时创建；否则说明原因，重新检测通过后再执行本次创建
          if (t === 'director' && directorGate && !directorGate(() => { const n = spawnNodeAt(t, pos.world, defaultNodeData(t)); if (wire) connectWire(n, wire); })) return;
          const n = spawnNodeAt(t, pos.world, defaultNodeData(t));
          if (wire) connectWire(n, wire);
        },
      });
    }
    items.push({ separator: true });
    for (const t of TEMPLATES) items.push({ label: `模板：${t.title}`, hint: '多节点', onPick: () => applyTemplate(t.key) });
    items.push({ separator: true });
    items.push({
      label: '上传素材文件…', hint: '拖文件到画布也可以',
      onPick: () => pickFiles(pos.world),
    });
    popupMenu(pos.clientX, pos.clientY, items);
  }
  // 拖线落空 → 新建节点自动接第一个兼容输入口
  function connectWire(node, wire) {
    const def = NODE_TYPES[node.type];
    const port = (def?.ports?.in ?? []).find(p =>
      p.kind === 'any' || p.kind === wire.from.kind ||
      (p.kind === 'media' && ['image', 'video', 'audio'].includes(wire.from.kind)) ||
      (wire.from.kind === 'any'));
    if (!port) { toast(`「${TYPE_LABEL[node.type]}」没有接受 ${wire.from.kind} 类型的输入口，已仅创建节点`, 'warn'); return; }
    const edge = store.addEdge(wire.from.node, wire.from.port, node.id, port.id, wire.from.kind);
    if (edge) toast(`已连到「${port.label || port.id}」`, 'ok');
    else toast('接线失败（类型不符或已连接）', 'warn');
  }

  // ---------- 节点右键菜单 ----------
  function nodeMenu(node, pos) {
    const st = studio();
    const inGroup = st.groups.find(g => g.members.includes(node.id));
    const sel = board.selectedIds;
    const items = [
      { label: '重命名', hint: '', onPick: () => renameNode(node, pos) },
      { label: '居中查看', hint: 'F 全图适配', onPick: () => board.focusNode(node.id) },
      { separator: true },
      { label: '复制', hint: 'Ctrl+C', onPick: () => { if (!editor.copy(sel.length ? sel : [node.id])) toast('没有可复制的节点', 'warn'); } },
      { label: '创建副本', hint: 'Ctrl+D', onPick: () => board.selectMany(editor.duplicate(sel.length ? sel : [node.id]).map(n => n.id)) },
      { label: '粘贴', hint: 'Ctrl+V', onPick: () => board.pasteNodes() },
      { separator: true },
      { label: node.data.locked ? '解除锁定' : '锁定（防误删）', hint: 'Ctrl+L', onPick: () => editor.lock(sel.length ? sel : [node.id]) },
      sel.length > 1 ? { label: `成组（${sel.length} 个节点）`, hint: 'Ctrl+G', onPick: () => editor.group(sel) } : null,
      inGroup ? { label: '脱离分组', hint: 'Ctrl+Shift+G', onPick: () => ungroup(node.id) } : null,
      sel.length > 1 ? { label: '排列对齐', hint: '', onPick: () => editor.arrange(sel) } : null,
      { separator: true },
      { label: '删除', hint: 'Delete', danger: true, onPick: () => {
        if (node.data.locked) { toast('节点已锁定（受保护），请先解锁', 'warn'); return; }
        if (sel.includes(node.id)) board.deleteSelection(); else editor.delete([node.id]);
      } },
    ];
    popupMenu(pos.clientX, pos.clientY, items);
  }
  function renameNode(node, pos) {
    const input = el('input', { type: 'text', value: node.data.title ?? '', placeholder: '节点名称' });
    const refs = popup(el('div', { class: 'rename-pop' }, input), { x: pos.clientX, y: pos.clientY });
    const commit = () => { const v = input.value.trim(); if (v) { editor?.checkpoint(); store.updateNodeData(node.id, { title: v }); } refs.close(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); e.stopPropagation(); });
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.focus?.();
    input.select?.();
  }
  function ungroup(nodeId) {
    const st = studio();
    const g = st.groups.find(g => g.members.includes(nodeId));
    if (!g) return;
    checkpointed(() => {
      g.members = g.members.filter(id => id !== nodeId);
      if (!g.members.length) st.groups.splice(st.groups.indexOf(g), 1);
    });
    store.touch({ type: 'structure' });
  }
  // ---------- 连线右键菜单（board.setEdgeMenu 后置注入；main.js 传 onEdgeMenu 亦兼容）----------
  function edgeMenu(edge, pos) {
    const from = store.node(edge.from.node), to = store.node(edge.to.node);
    popupMenu(pos.clientX, pos.clientY, [
      { label: '定位起点', hint: from ? (from.data.title || TYPE_LABEL[from.type] || from.type) : '节点已删', disabled: !from, onPick: () => board.focusNode(edge.from.node) },
      { label: '定位终点', hint: to ? (to.data.title || TYPE_LABEL[to.type] || to.type) : '节点已删', disabled: !to, onPick: () => board.focusNode(edge.to.node) },
      { separator: true },
      { label: '删除连线', hint: 'Delete', danger: true, onPick: () => board.removeEdge(edge.id) },
    ]);
  }
  board.setEdgeMenu?.((edge, pos) => edgeMenu(edge, pos));
  // 分组框动作（board 回调）：重命名 / 解散
  function handleGroupAction(action, g, pos) {
    const st = studio();
    if (action === 'ungroup') {
      checkpointed(() => st.groups.splice(st.groups.indexOf(g), 1));
      store.touch({ type: 'structure' });
      toast(`已解散分组「${g.title || '分组'}」（节点保留）`, 'ok');
      return;
    }
    if (action === 'rename') {
      const input = el('input', { type: 'text', value: g.title ?? '', placeholder: '分组名称' });
      const refs = popup(el('div', { class: 'rename-pop' }, input), { x: pos?.clientX ?? 80, y: pos?.clientY ?? 80 });
      const commit = () => { const v = input.value.trim(); if (v) { editor?.checkpoint(); g.title = v; store.touch({ type: 'structure' }); } refs.close(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); e.stopPropagation(); });
      input.addEventListener('pointerdown', e => e.stopPropagation());
      input.focus?.(); input.select?.();
    }
  }

  // ---------- 搜索 ----------
  function searchNodes(q) {
    const query = String(q ?? '').trim().toLowerCase();
    if (!query) return [];
    return (store.project?.nodes ?? [])
      .filter(n => {
        const hay = `${n.data.title ?? ''} ${TYPE_LABEL[n.type] ?? n.type} ${n.data.text ?? ''} ${n.data.prompt ?? ''} ${n.data.draft?.prompt ?? ''}`.toLowerCase();
        return hay.includes(query);
      })
      .slice(0, 12)
      .map(n => ({ id: n.id, title: n.data.title || TYPE_LABEL[n.type] || n.type, type: n.type }));
  }
  const searchInput = $('#node-search');
  let searchPop = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const hits = searchNodes(searchInput.value);
      searchPop?.close(); searchPop = null;
      if (!hits.length) return;
      const r = searchInput.getBoundingClientRect();
      searchPop = popup(menuList(hits.map(h => ({
        label: `${h.title}`,
        hint: TYPE_LABEL[h.type] ?? h.type,
        onPick: () => focusNode(h.id),
      }))), { x: r.left, y: r.bottom + 4, onClose: reason => {
        searchPop = null;
        if (reason === 'escape') { searchInput.value = ''; searchInput.blur(); }
      } });
    });
    searchInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { const h = searchNodes(searchInput.value)[0]; if (h) focusNode(h.id); }
      if (e.key === 'ArrowDown') {   // ↓ 进入结果列表，之后 ↑/↓/Enter 由菜单键盘导航接管（UI-07）
        const first = searchPop ? [...searchPop.box.querySelectorAll('.menu-item')].find(b => !b.disabled) : null;
        first?.focus?.();
      }
      if (e.key === 'Escape') { searchInput.value = ''; searchInput.blur(); searchPop?.close(); }
    });
    disposers.push(() => searchPop?.close());
  }
  function focusNode(id) {
    if (board.focusNode(id)) { searchPop?.close(); searchPop = null; if (searchInput) searchInput.value = ''; }
  }
  // '/' 聚焦搜索（与画布快捷键同级隔离：输入控件/弹层打开时不触发）
  const onSlash = e => {
    if (e.key !== '/' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.getElementById('overlay-root')?.childElementCount) return;
    if (e.target.matches?.('input,textarea,select,button,[contenteditable]')) return;
    e.preventDefault(); searchInput?.focus();
  };
  document.addEventListener('keydown', onSlash);
  disposers.push(() => document.removeEventListener('keydown', onSlash));

  // ---------- 工具栏 ----------
  const selAction = fn => () => {
    const ids = board.selectedIds;
    if (!ids.length) { toast('先选中节点', 'warn'); return; }
    fn(ids);
  };
  const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); return b; };
  bind('#btn-undo', () => { if (!editor?.undo()) toast('没有可撤销的操作', 'warn'); });
  bind('#btn-redo', () => { if (!editor?.redo()) toast('没有可重做的操作', 'warn'); });
  bind('#btn-copy', selAction(ids => { editor.copy(ids); toast(`已复制 ${ids.length} 个节点`, 'ok'); }));
  bind('#btn-paste', () => board.pasteNodes());
  bind('#btn-dup', selAction(ids => board.selectMany(editor.duplicate(ids).map(n => n.id))));
  bind('#btn-group', selAction(ids => ids.length > 1 ? editor.group(ids) : toast('成组需先选中至少 2 个节点', 'warn')));
  bind('#btn-ungroup', selAction(() => board.ungroupSelection()));
  bind('#btn-lock', selAction(ids => editor.lock(ids)));
  bind('#btn-arrange', selAction(ids => editor.arrange(ids, board.measureNode)));
  bind('#btn-del-sel', selAction(() => board.deleteSelection()));
  bind('#btn-fit', () => board.fit());
  bind('#btn-zoom-in', () => board.zoomBy(1.2));
  bind('#btn-zoom-out', () => board.zoomBy(1 / 1.2));
  const snapBtn = bind('#btn-snap', () => {
    board.snap.grid = !board.snap.grid; board.snap.align = board.snap.grid;
    snapBtn.setAttribute('aria-pressed', String(board.snap.grid));
    toast(board.snap.grid ? '吸附已开启' : '吸附已关闭', 'info', 1500);
  });
  const mapBtn = bind('#btn-minimap', () => {
    const mm = $('.minimap'); if (!mm) return;
    const hide = !mm.classList.contains('hidden');
    mm.classList.toggle('hidden', hide); mapBtn.setAttribute('aria-pressed', String(!hide));
    try { localStorage.setItem('xp-minimap', hide ? '0' : '1'); } catch { /* 偏好可选 */ }
  });
  try {
    if (localStorage.getItem('xp-minimap') === '0') { $('.minimap')?.classList.add('hidden'); mapBtn?.setAttribute('aria-pressed', 'false'); }
  } catch { /* 偏好可选 */ }
  bind('#btn-left-panel', () => togglePanel('left'));
  bind('#btn-right-panel', () => togglePanel('right'));

  // ---------- 面板缩放/折叠（桌面端；≤900 由 CSS 抽屉接管）----------
  const PREF = 'xp-panels';
  const panelState = { layout: 2, left: 296, right: 380, leftCollapsed: true, rightCollapsed: true, dock: 'create' };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF) || '{}');
    for (const side of ['left', 'right']) {
      if (Number.isFinite(saved[side])) panelState[side] = Math.min(560, Math.max(200, saved[side]));
      if (saved.layout === 2 && typeof saved[`${side}Collapsed`] === 'boolean') panelState[`${side}Collapsed`] = saved[`${side}Collapsed`];
    }
    if (['create', 'asset', 'run', 'task'].includes(saved.dock)) panelState.dock = saved.dock;
  } catch { /* 忽略坏偏好 */ }
  function savePanels() { try { localStorage.setItem(PREF, JSON.stringify(panelState)); } catch { /* 偏好可选 */ } }
  let activeDock = typeof panelState.dock === 'string' ? panelState.dock : 'create';
  const DOCK_LEFT = 82;   // rail(12px 起 ~58px 宽)右缘 + 间距；dock 左缘与 resizer 定位基准
  function applyDock() {
    const sb = $('#sidebar');
    if (sb) for (const p of qa(sb, '.panel')) p.classList.toggle('on', p.dataset?.dock === activeDock);
    if (rail) for (const b of qa(rail, 'button')) b.setAttribute('aria-pressed', String(b.dataset?.rail === activeDock && !panelState.leftCollapsed));
  }
  function applyPanels() {
    const sb = $('#sidebar'), ins = $('#inspector');
    const desktop = isDesktop();
    if (sb) {
      sb.style.width = panelState.leftCollapsed ? '0' : panelState.left + 'px';
      sb.style.minWidth = sb.style.width;
      // collapsed 仅桌面生效：移动抽屉靠 .open 开合，继承 collapsed 会把抽屉内容裁没
      sb.classList.toggle('collapsed', panelState.leftCollapsed && desktop);
      sb.inert = panelState.leftCollapsed && desktop;
    }
    if (ins) {
      ins.style.width = panelState.rightCollapsed ? '0' : panelState.right + 'px';
      ins.style.minWidth = ins.style.width;
      ins.classList.toggle('collapsed', panelState.rightCollapsed && desktop);
      ins.inert = panelState.rightCollapsed && desktop;
    }
    const sr = $('#sidebar-resizer');
    if (sr) {
      sr.style.display = panelState.leftCollapsed ? 'none' : '';
      sr.style.left = (DOCK_LEFT + (panelState.leftCollapsed ? 0 : panelState.left)) + 'px';
    }
    boardWrap?.classList?.toggle('dock-open', !panelState.leftCollapsed && desktop);
    if (boardWrap?.style?.setProperty) boardWrap.style.setProperty('--dock-width', `${panelState.left}px`);
    const ir = $('#inspector-resizer');
    if (ir) ir.style.display = panelState.rightCollapsed ? 'none' : '';
    $('#btn-left-panel')?.setAttribute('aria-pressed', String(!panelState.leftCollapsed));
    $('#btn-right-panel')?.setAttribute('aria-pressed', String(!panelState.rightCollapsed));
    applyDock();
  }
  function togglePanel(side) {
    if (side === 'left') panelState.leftCollapsed = !panelState.leftCollapsed;
    else panelState.rightCollapsed = !panelState.rightCollapsed;
    applyPanels(); savePanels();
  }
  function showInspector() {
    if (!panelState.rightCollapsed) return;
    panelState.rightCollapsed = false;
    applyPanels(); savePanels();
  }
  function closeDock(name) {
    if (!isDesktop() || activeDock !== name || panelState.leftCollapsed) return;
    panelState.leftCollapsed = true;
    applyPanels(); savePanels();
  }
  // 工具轨互斥切换：同钮再点收起 dock；面板只换 .on，节点不 remove，表单/工作流状态不丢
  function toggleDock(name) {
    if (!name) return;
    if (activeDock !== name) {
      activeDock = name; panelState.dock = name; panelState.leftCollapsed = false;
    } else {
      panelState.leftCollapsed = !panelState.leftCollapsed;
    }
    applyPanels(); savePanels();
  }
  function bindResizer(id, side) {
    const bar = $(id); if (!bar) return;
    bar.addEventListener('pointerdown', e => {
      e.preventDefault();
      bar.setPointerCapture?.(e.pointerId);
      const target = side === 'left' ? $('#sidebar') : $('#inspector');
      const startX = e.clientX, startW = target.getBoundingClientRect().width || (side === 'left' ? panelState.left : panelState.right);
      const move = ev => {
        const d = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.min(560, Math.max(200, Math.round(startW + d)));
        if (side === 'left') { panelState.left = w; panelState.leftCollapsed = false; }
        else { panelState.right = w; panelState.rightCollapsed = false; }
        applyPanels();
      };
      const done = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', done); bar.removeEventListener('pointercancel', done); savePanels(); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', done); bar.addEventListener('pointercancel', done);
    });
    bar.addEventListener('dblclick', () => togglePanel(side));
  }
  bindResizer('#sidebar-resizer', 'left');
  bindResizer('#inspector-resizer', 'right');

  // ---------- 桌面壳 chrome：工具轨 / 视图条 / 选中条（元素常驻，显隐走 hidden/CSS）----------
  const RAIL_ITEMS = [['create', '创建', 'plus'], ['asset', '素材', 'folder'], ['run', '工作流', 'workflow'], ['task', '任务', 'tasks']];
  const rail = boardWrap ? el('nav', { id: 'rail', 'aria-label': '创作面板', hidden: true },
    RAIL_ITEMS.map(([key, label, iconName]) => {
      const b = el('button', { type: 'button', title: `${label}面板`, 'aria-label': `${label}面板`, 'aria-pressed': 'false' },
        icon(iconName), el('span', { class: 'ic-label', text: label }));
      b.setAttribute('data-rail', key);
      b.addEventListener('click', () => toggleDock(key));
      return b;
    })) : null;
  const viewBar = boardWrap ? el('div', { id: 'view-bar', role: 'toolbar', 'aria-label': '视图与历史', hidden: true }) : null;
  const selBar = boardWrap ? el('div', { id: 'sel-bar', role: 'toolbar', 'aria-label': '选中节点操作', hidden: true }) : null;
  if (boardWrap) boardWrap.append(rail, viewBar, selBar);

  // 桌面模式把原工具行按钮迁入浮动条：undo/redo/paste 常驻视图条（无选中也可达），
  // 纯选择动作进 sel-bar；≤900 还原原始 DOM 顺序，小屏工具行既有行为不变。
  const VIEW_BAR_IDS = ['btn-undo', 'btn-redo', 'btn-paste', 'btn-snap', 'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-minimap', 'node-search', 'btn-left-panel', 'btn-right-panel'];
  const VIEW_SEP_AFTER = new Set(['btn-redo', 'btn-paste', 'btn-minimap', 'node-search']);
  const SEL_BAR_IDS = ['btn-copy', 'btn-dup', 'btn-del-sel', 'btn-group', 'btn-ungroup', 'btn-lock', 'btn-arrange'];
  const SEL_SEP_AFTER = new Set(['btn-del-sel']);
  // 壳按钮统一注入线性图标：原文字包进 .ic-label（可达名/快捷键提示/事件身份不变），重复调用幂等
  const SHELL_ICONS = {
    'btn-undo': 'undo', 'btn-redo': 'redo', 'btn-paste': 'paste', 'btn-snap': 'snap',
    'btn-zoom-out': 'zoom-out', 'btn-zoom-in': 'zoom-in', 'btn-fit': 'fit', 'btn-minimap': 'map',
    'btn-left-panel': 'panel-left', 'btn-right-panel': 'panel-right',
    'btn-copy': 'copy', 'btn-dup': 'duplicate', 'btn-del-sel': 'trash',
    'btn-group': 'group', 'btn-ungroup': 'ungroup', 'btn-lock': 'lock', 'btn-arrange': 'arrange',
    'btn-new-project': 'plus', 'btn-rename': 'edit', 'btn-hub': 'history', 'btn-workspace': 'users',
    'btn-export': 'export', 'btn-import': 'import',
    'btn-storyboard': 'film', 'btn-director-mode': 'video', 'btn-timeline': 'timeline', 'btn-assistant': 'chat', 'btn-key': 'key',
  };
  for (const [id, name] of Object.entries(SHELL_ICONS)) applyIcon(document.getElementById(id), name);
  const toolbar = $('#canvas-toolbar');
  const toolbarOrig = toolbar ? [...toolbar.children] : [];
  const menuHome = $('#project-menu-home');
  const menuPop = menuHome?.querySelector?.('.menu-pop') ?? menuHome?.firstElementChild ?? null;
  const menuBtnIds = ['btn-new-project', 'btn-rename', 'btn-hub', 'btn-workspace', 'btn-import'];
  const menuBtns = menuBtnIds.map(id => document.getElementById(id)).filter(Boolean);
  const menuHost = menuBtns[0]?.parentNode ?? null;   // 原保留位置（.h-left），小屏迁回
  const btnProjectMenu = $('#btn-project-menu');
  let projPop = null;
  let downStartedWithPop = false;
  const onAnyDown = e => { downStartedWithPop = !!projPop && !!btnProjectMenu?.contains?.(e.target); };
  // 注册早于弹层的 onDown（弹层在 open 时才挂监听）：忠实记录按下瞬间菜单是否开着
  document.addEventListener('pointerdown', onAnyDown, true);
  disposers.push(() => document.removeEventListener('pointerdown', onAnyDown, true));

  function applyShellMode() {
    const desktop = isDesktop();
    if (rail) rail.hidden = !desktop;
    if (viewBar) viewBar.hidden = !desktop;
    if (selBar) selBar.hidden = !desktop;
    if (btnProjectMenu) btnProjectMenu.hidden = !desktop;
    if (desktop) {
      if (selBar) {
        for (const s of qa(selBar, '.tb-sep')) s.remove();
        for (const id of SEL_BAR_IDS) {
          const n = document.getElementById(id); if (n) selBar.append(n);
          if (SEL_SEP_AFTER.has(id)) selBar.append(el('span', { class: 'tb-sep' }));
        }
      }
      if (viewBar) {
        for (const s of qa(viewBar, '.tb-sep')) s.remove();
        for (const id of VIEW_BAR_IDS) {
          const n = document.getElementById(id); if (n) viewBar.append(n);
          if (VIEW_SEP_AFTER.has(id)) viewBar.append(el('span', { class: 'tb-sep' }));
        }
      }
      if (menuPop) for (const b of menuBtns) {
        b.classList.add('menu-item'); b.setAttribute('role', 'menuitem');
        menuPop.append(b);
      }
    } else {
      projPop?.close();
      if (toolbar && toolbarOrig.length) toolbar.append(...toolbarOrig);
      for (const b of menuBtns) { b.classList.remove('menu-item'); b.removeAttribute('role'); menuHost?.append(b); }
      if (menuPop && menuHome && !menuHome.contains(menuPop) && !menuPop.closest?.('.popup')) menuHome.append(menuPop);
    }
    applyPanels();
  }
  mqDesktop?.addEventListener?.('change', applyShellMode);
  disposers.push(() => mqDesktop?.removeEventListener?.('change', applyShellMode));

  // ---------- 项目菜单：原按钮本体进弹层（监听只绑一次）；关闭回巢不被 remove ----------
  if (btnProjectMenu && menuPop && menuHome) {
    menuPop.addEventListener('click', e => {
      // 委托一次：动作触发后收菜单。按钮自身监听先执行（如重命名开模态框），模态晚于
      // popup 入 overlay-root——close() 只摘自身 box，不会误关刚打开的模态。
      if (e.target?.closest?.('.menu-item')) projPop?.close();
    });
    menuPop.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const btns = qa(menuPop, '.menu-item').filter(b => !b.disabled);
      if (!btns.length) return;
      e.preventDefault?.(); e.stopPropagation?.();
      const i = btns.indexOf(document.activeElement);
      const next = e.key === 'Home' ? btns[0]
        : e.key === 'End' ? btns[btns.length - 1]
        : i < 0 ? (e.key === 'ArrowDown' ? btns[0] : btns[btns.length - 1])
        : btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      next?.focus?.();
    });
    btnProjectMenu.addEventListener('click', () => {
      if (downStartedWithPop && !projPop) { downStartedWithPop = false; return; }   // 本次按下已由“点外部”收掉菜单 → 视作关闭
      downStartedWithPop = false;
      if (projPop) { projPop.close(); return; }
      const r = btnProjectMenu.getBoundingClientRect?.() ?? { left: 8, bottom: 48 };
      projPop = popup(menuPop, {
        x: r.left ?? 8, y: (r.bottom ?? 48) + 6,
        onClose: reason => {
          projPop = null;
          menuHome.append(menuPop);   // 按钮本体随容器回巢：监听与 ID 不变，下次可再开
          btnProjectMenu.setAttribute('aria-expanded', 'false');
          if (reason === 'escape') btnProjectMenu.focus?.();
        },
      });
      btnProjectMenu.setAttribute('aria-expanded', 'true');
      try { qa(menuPop, '.menu-item').find(b => !b.disabled)?.focus?.(); } catch { /* 聚焦失败不阻塞 */ }
    });
    disposers.push(() => projPop?.close());
  }

  // ---------- 创建面板：模板按钮注入 + 分组内搜索过滤 ----------
  const TPL_ICONS = { text2video: 'template', refvideo: 'folder', frames: 'image', grid: 'arrange', batch: 'tasks' };
  const tplHost = document.getElementById('tpl-list');
  if (tplHost) for (const t of TEMPLATES) {
    const b = el('button', { class: 'tpl-item', type: 'button', 'data-tpl': t.key },
      icon(TPL_ICONS[t.key] ?? 'template'),
      el('span', { class: 'tpl-txt' },
        el('b', { text: t.title }), el('small', { class: 'muted', text: t.desc })));
    b.addEventListener('click', () => applyTemplate(t.key));
    tplHost.append(b);
  }
  const createSearch = document.getElementById('create-search');
  if (createSearch) {
    const filterCreate = () => {
      const q = (createSearch.value ?? '').trim().toLowerCase();
      const panel = createSearch.closest?.('.panel');
      if (!panel) return;
      for (const b of qa(panel, 'button')) b.hidden = !!(q && !(b.textContent ?? '').toLowerCase().includes(q));
      for (const g of qa(panel, '.cg')) g.hidden = !!(q && !qa(g, 'button').some(b => !b.hidden));
    };
    createSearch.addEventListener('input', filterCreate);
    createSearch.addEventListener('keydown', e => {
      e.stopPropagation?.();
      if (e.isComposing) return;
      if (e.key === 'Escape') { createSearch.value = ''; filterCreate(); createSearch.blur?.(); }
    });
  }

  applyShellMode();   // 初始装配：内含 applyPanels/applyDock

  // ---------- 汇总刷新 ----------
  function refreshChrome() { refreshEmpty(); refreshStatus(); }
  // 视图变化（缩放/平移）不走 store 事件：订阅 board.onViewChange——内部闭包与外部调用共用
  // 同一出口，滚轮缩放/平移/聚焦/zoomBy 都可靠刷新状态栏缩放值；dispose 退订，不再猴子补丁
  const offView = board.onViewChange?.(() => refreshStatus());
  if (typeof offView === 'function') disposers.push(offView);
  buildEmpty();
  refreshChrome();
  const offStore = store.onChange(reason => { if (reason?.type !== 'move') refreshChrome(); });
  disposers.push(offStore);

  return {
    openAddMenu, nodeMenu, applyTemplate, focusNode, searchNodes, refreshChrome, setStatus,
    handleGroupAction, connectWire, edgeMenu,
    togglePanel, toggleDock, closeDock, showInspector, applyShellMode,
    dispose() { for (const d of disposers) d(); },
  };
}
