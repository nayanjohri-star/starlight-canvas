// 节点板：平移/缩放/框选/多选拖动/分组框/吸附/拖线/缩略图/聚焦。
// 稳定 DOM：移动只改 style、数据变更只刷新 .node-body，不在拖动/连线过程中重建节点元素
// （避免 pointer capture 丢失与输入抢焦点）。快捷键一律隔离：输入控件/IME/弹层打开时不触发。

import { el, toast } from './ui.js';
import { NODE_TYPES, portAccepts as storeAccepts } from './store.js';
import { studioState, directVideoOutput } from './studio-schema.js';
import { VIEW_MARGIN, viewRect, inflate, classifyNode, liteModeFor, perfEnabled } from './board-visibility.js';

const KIND_CLASS = { image: 'img', video: 'vid', audio: 'aud', text: 'txt', media: '', any: '' };
const NODE_W = 230, NODE_H_EST = 210;
const GRID = 8, SNAP_T = 6;
// 每项目视口记忆：模块级 Map（纯运行态，不进 schema / 持久化）——项目切换时恢复上次平移/缩放
const projectViews = new Map();

export function createBoard({ store, renderBody, bodyKey, kindOf, onSelect, onEdgesChanged, editor, onAddMenu, onNodeMenu, onWireEnd, onEdgeMenu, onGroupAction, onViewChange: onViewChangeCb }) {
  const board = document.getElementById('board');
  const nodesLayer = document.getElementById('nodes');
  const edgesSvg = document.getElementById('edges');
  // 拖动实时层：拖动中与移动节点相连的连线以临时副本画在这层（独立合成层），原连线元素原地隐藏、
  // 不移动不重建；主 SVG 在拖动帧内不被修改，避免上千条连线整层重录制。松手后原连线一次性更新并恢复。
  // 拖线预览也画在这层。宿主缺 SVG 能力（测试桩）时为 null，退回全部画在主层。
  const edgesLive = typeof document.createElementNS === 'function' && edgesSvg?.after
    ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : null;
  if (edgesLive) { edgesLive.id = 'edges-live'; edgesLive.setAttribute('aria-hidden', 'true'); edgesSvg.after(edgesLive); }
  const liveCopies = new Map();   // edgeId → 实时层中的临时路径
  const view = { x: 40, y: 40, scale: 1 };
  let selected = null;
  const selectedIds = new Set();
  const snap = { grid: true, align: true };
  // 导航缩略图：容器 .minimap（显隐开关沿用 .hidden）内含画布、尺寸/折叠按钮与折叠后的「地图」小按钮。
  // 尺寸偏好只是本机浏览器的显示偏好（localStorage，可缺失）。
  const MAP_SIZES = { normal: [240, 150], large: [380, 238] };
  const readMapPref = () => { try { const v = globalThis.localStorage?.getItem('xp-minimap-size'); return ['normal', 'large', 'collapsed'].includes(v) ? v : 'normal'; } catch { return 'normal'; } };
  let mapState = readMapPref(), mapLastOpen = mapState === 'collapsed' ? 'normal' : mapState;
  const minimap = el('div', { class: 'minimap', 'data-size': mapState });
  const mapCanvas = el('canvas', { class: 'minimap-canvas', title: '导航缩略图：点击定位，拖动视口框平移画布', 'aria-label': '导航缩略图' });
  const mapSizeBtn = el('button', { type: 'button', class: 'minimap-btn', 'data-minimap-action': 'size' });
  const mapFoldBtn = el('button', { type: 'button', class: 'minimap-btn', 'data-minimap-action': 'collapse', text: '–', title: '收起缩略图', 'aria-label': '收起缩略图' });
  const mapChip = el('button', { type: 'button', class: 'minimap-chip', 'data-minimap-action': 'expand', text: '地图', title: '展开导航缩略图', 'aria-label': '展开导航缩略图' });
  minimap.append(mapCanvas, el('div', { class: 'minimap-tools' }, mapSizeBtn, mapFoldBtn), mapChip);
  // 宿主兜底：缺 #board-wrap（旧装配/极简测试桩）时挂到 board 本身，缩略图不缺席
  (document.getElementById('board-wrap') ?? board).append(minimap);
  // 分组框层：置于节点层之下，随画布变换；宿主不支持 prepend 时退化为 append
  const groupLayer = el('div', { id: 'group-layer' });
  if (nodesLayer?.prepend) nodesLayer.prepend(groupLayer); else nodesLayer?.append?.(groupLayer);
  let bounds = { x:0,y:0,w:1,h:1 };
  let wire = null;              // {from:{node,port,kind}, x,y}
  let endWireSession = null;    // 拖线期间窗口级监听的清理函数
  let cancelGesture = null;     // 进行中的节点拖动/平移/框选手势取消器（Esc 用）
  let pendingNodePaste = false; // Ctrl+V 排队的节点粘贴：paste 事件消费媒体文件时取消
  const nodeEls = new Map();    // nodeId → {root, bodySlot}
  const edgeEls = new Map();    // 连线保留 DOM，只更新路径，不在每个拖动帧拆掉命中区
  let wirePath = null;
  const nodeSize = n => {
    const rec = nodeEls.get(n.id);
    if (rec?.meas) return { w: rec.meas.w, h: rec.meas.h };
    return nodeSizeRaw(rec);
  };
  const nodeSizeRaw = rec => ({
    w: rec?.root.offsetWidth || NODE_W,
    h: Math.max(rec?.root.offsetHeight || NODE_H_EST, Number(rec?.root.dataset?.fullHeight) || 0),   // 编辑中紧凑显示的卡片按完整高度占位
  });
  // 端口锚点缓存：端口圆点中心相对节点左上角的世界坐标偏移。节点内部布局不变时（拖动、平移、缩放）
  // 锚点 = 节点坐标 + 偏移，渲染连线无需逐端口 getBoundingClientRect——大画布拖动时这是主要的强制布局来源。
  // 节点尺寸变化（ResizeObserver）、正文重建、数据更新、重建与窗口变化时失效，下次渲染重新实测。
  const portOffsets = new Map();   // nodeId → Map(`${dir}/${portId}` → {dx, dy})
  const invalidatePorts = id => { if (id == null) portOffsets.clear(); else portOffsets.delete(id); };
  const resizeObserver = globalThis.ResizeObserver
    ? new ResizeObserver(entries => {
      for (const en of entries) { invalidatePorts(en.target?.dataset?.node); const rec = nodeEls.get(en.target?.dataset?.node); if (rec) rec.meas = null; }
      scheduleOverlay(); scheduleVis(); drawMap();
    }) : null;

  // 视图变化订阅：applyView 是唯一出口——滚轮/平移/聚焦/minimap/zoomBy/fit 任一入口改视图都通知，
  // 内部闭包与外部 board.applyView() 调用走同一路径，不再存在绕过订阅的口子。
  // 两种集成形态：createBoard 选项回调 onViewChange，或 board.onViewChange(fn) 方法订阅（返回退订函数）。
  // 订阅者异常不阻断视图更新本身。向后兼容：applyView 仍对外暴露，旧调用语义不变。
  const viewSubs = new Set();
  if (typeof onViewChangeCb === 'function') viewSubs.add(onViewChangeCb);
  function onViewChange(fn) {
    if (typeof fn !== 'function') return () => {};
    viewSubs.add(fn);
    return () => viewSubs.delete(fn);
  }
  function applyView() {
    const t = `translate(${view.x}px,${view.y}px) scale(${view.scale})`;
    nodesLayer.style.transform = t; edgesSvg.style.transform = t; edgesSvg.style.transformOrigin = '0 0';
    if (edgesLive) { edgesLive.style.transform = t; edgesLive.style.transformOrigin = '0 0'; }
    drawMap(); scheduleVis();   // 可见性分级按帧合并，不新增每帧全量渲染
    for (const fn of [...viewSubs]) { try { fn(view); } catch { /* 订阅者异常不阻断视图 */ } }
  }
  let mapColors = null;   // 主题色缓存（TTL 800ms）：平移/缩放每帧不再重复 getComputedStyle（UI-03）
  let mapDrag = null;     // 拖动视口框期间冻结映射，避免视口移动改变缩略图范围造成抖动
  const mapSize = () => MAP_SIZES[mapState === 'collapsed' ? mapLastOpen : mapState] ?? MAP_SIZES.normal;
  function setMapState(next, { remember = true } = {}) {
    mapState = next;
    if (next !== 'collapsed') mapLastOpen = next;
    minimap.dataset.size = next;
    minimap.setAttribute?.('data-size', next);
    mapSizeBtn.textContent = next === 'large' ? '缩小' : '放大';
    mapSizeBtn.title = next === 'large' ? '缩小缩略图' : '放大缩略图';
    mapSizeBtn.setAttribute?.('aria-label', mapSizeBtn.title);
    const [w, h] = mapSize(), dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    mapCanvas.width = Math.round(w * dpr); mapCanvas.height = Math.round(h * dpr);
    mapCanvas.style.width = `${w}px`; mapCanvas.style.height = `${h}px`;
    if (remember) { try { globalThis.localStorage?.setItem('xp-minimap-size', next); } catch { /* 偏好可选 */ } }
    updateMapYield(); drawMap();
  }
  // 世界坐标 ↔ 缩略图坐标：统一比例（不拉伸），范围 = 全部节点 ∪ 当前视口，视口框始终完整可见
  function mapTransform() {
    const [W, H] = mapSize(), pad = 6;
    const b = mapDrag?.bounds ?? bounds;
    const s = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
    return { W, H, s, ox: (W - b.w * s) / 2 - b.x * s, oy: (H - b.h * s) / 2 - b.y * s };
  }
  function viewWorld() {
    return { x: -view.x / view.scale, y: -view.y / view.scale, w: board.clientWidth / view.scale, h: board.clientHeight / view.scale };
  }
  function drawMap() {
    const nodes = store.project?.nodes ?? [];
    const sizes = nodes.map(nodeSize);
    if (!mapDrag) {
      const v = viewWorld();
      const x0 = Math.min(v.x, ...nodes.map(n => n.x)), y0 = Math.min(v.y, ...nodes.map(n => n.y));
      const x1 = Math.max(v.x + v.w, ...nodes.map((n, i) => n.x + sizes[i].w)), y1 = Math.max(v.y + v.h, ...nodes.map((n, i) => n.y + sizes[i].h));
      const m = Math.max(40, (x1 - x0) * 0.04);
      bounds = { x: x0 - m, y: y0 - m, w: Math.max(400, x1 - x0 + 2 * m), h: Math.max(250, y1 - y0 + 2 * m) };
    }
    if (minimap.classList?.contains('hidden') || mapState === 'collapsed') return;   // 隐藏/折叠时只更新范围
    const g = mapCanvas.getContext?.('2d'); if (!g) return;
    const now = Date.now();
    if (!mapColors || now - mapColors.at > 800) {
      const cs = getComputedStyle(board);
      mapColors = { at: now, dim: cs.getPropertyValue('--dim') || '#9aa3b2', accent: cs.getPropertyValue('--accent') || '#4f8cff', panel: cs.getPropertyValue('--panel') || '#1b1f27' };
    }
    const { W, H, s, ox, oy } = mapTransform();
    const dpr = mapCanvas.width / W || 1;
    g.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    // 节点块半透明圆角、选中节点用强调色；视口外整体压暗、视口框加粗——一眼看出"我在哪、选中在哪"
    const block = (n, i) => {
      const px = ox + n.x * s, py = oy + n.y * s, w = Math.max(sizes[i].w * s, 2.5), h = Math.max(sizes[i].h * s, 2.5);
      g.beginPath(); g.roundRect ? g.roundRect(px, py, w, h, 2) : g.rect(px, py, w, h); g.fill();
    };
    g.clearRect(0, 0, W, H);
    g.globalAlpha = 0.5; g.fillStyle = mapColors.dim;
    nodes.forEach((n, i) => { if (!selectedIds.has(n.id)) block(n, i); });
    g.globalAlpha = 0.95; g.fillStyle = mapColors.accent;
    nodes.forEach((n, i) => { if (selectedIds.has(n.id)) block(n, i); });
    const v = viewWorld();
    const vx = ox + v.x * s, vy = oy + v.y * s, vw = Math.max(v.w * s, 4), vh = Math.max(v.h * s, 4);
    g.globalAlpha = 0.45; g.fillStyle = mapColors.panel;
    g.beginPath(); g.rect(0, 0, W, H); g.rect(vx, vy, vw, vh); g.fill('evenodd');
    g.globalAlpha = 0.1; g.fillStyle = mapColors.accent; g.fillRect(vx, vy, vw, vh);
    g.globalAlpha = 1; g.strokeStyle = mapColors.accent; g.lineWidth = 2;
    g.strokeRect(vx + 1, vy + 1, Math.max(vw - 2, 2), Math.max(vh - 2, 2));
    g.lineWidth = 1;
  }
  // 缩略图点 → 世界坐标
  function mapPointToWorld(e) {
    const r = mapCanvas.getBoundingClientRect(), { W, H, s, ox, oy } = mapTransform();
    const mx = (e.clientX - r.left) / (r.width || W) * W, my = (e.clientY - r.top) / (r.height || H) * H;
    return { x: (mx - ox) / s, y: (my - oy) / s };
  }
  function centerViewOn(p) {
    view.x = board.clientWidth / 2 - p.x * view.scale;
    view.y = board.clientHeight / 2 - p.y * view.scale;
    applyView();
  }
  // 点击视口框外：以该点为中心定位；按住视口框（或定位后继续按住）拖动：视口随指针移动
  mapCanvas.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;   // 右键/中键不跳转视图，也不吞掉画布右键菜单
    e.preventDefault?.();
    mapDrag = { bounds: { ...bounds }, pointerId: e.pointerId };
    const p = mapPointToWorld(e), v = viewWorld();
    const inside = p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h;
    if (!inside) centerViewOn(p);
    const nv = viewWorld();
    mapDrag.grab = { dx: p.x - nv.x, dy: p.y - nv.y };
    try { mapCanvas.setPointerCapture?.(e.pointerId); } catch { /* 桩环境 */ }
    minimap.classList?.add('dragging');
  });
  mapCanvas.addEventListener('pointermove', e => {
    if (!mapDrag || (mapDrag.pointerId != null && e.pointerId !== mapDrag.pointerId)) return;
    const p = mapPointToWorld(e);
    view.x = -(p.x - mapDrag.grab.dx) * view.scale;
    view.y = -(p.y - mapDrag.grab.dy) * view.scale;
    applyView();
  });
  const endMapDrag = () => { if (!mapDrag) return; mapDrag = null; minimap.classList?.remove('dragging'); drawMap(); };
  mapCanvas.addEventListener('pointerup', endMapDrag);
  mapCanvas.addEventListener('pointercancel', endMapDrag);
  mapCanvas.addEventListener('lostpointercapture', endMapDrag);
  mapSizeBtn.addEventListener('click', () => setMapState(mapState === 'large' ? 'normal' : 'large'));
  mapFoldBtn.addEventListener('click', () => setMapState('collapsed'));
  mapChip.addEventListener('click', () => setMapState(mapLastOpen));
  // 避让浮动编辑面板：两者重叠时缩略图临时收成「地图」小按钮；小按钮也被挡住则暂时隐藏，面板离开后恢复。
  let mapAvoid = null;
  function mapRectFor(state) {
    const wrap = minimap.parentElement?.getBoundingClientRect?.();
    if (!wrap || typeof getComputedStyle !== 'function') return null;
    const cs = getComputedStyle(minimap);
    const right = wrap.right - (parseFloat(cs.right) || 0), bottom = wrap.bottom - (parseFloat(cs.bottom) || 0);
    const [w, h] = state === 'chip' ? [64, 30] : mapSize();
    return { left: right - w - 2, top: bottom - h - 2, right, bottom };
  }
  function updateMapYield() {
    const hit = r => !!(r && mapAvoid && mapAvoid.left < r.right && mapAvoid.right > r.left && mapAvoid.top < r.bottom && mapAvoid.bottom > r.top);
    const yieldMap = mapState !== 'collapsed' && hit(mapRectFor('open'));
    minimap.classList?.toggle('yield', yieldMap);
    minimap.classList?.toggle('yield-hidden', (yieldMap || mapState === 'collapsed') && hit(mapRectFor('chip')));
  }
  function minimapAvoid(rect) {
    mapAvoid = rect && rect.width > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    updateMapYield();
  }
  setMapState(mapState, { remember: false });
  // 边/分组重绘 rAF 合并：手势期每帧最多一次（桩/无 rAF 环境退化 16ms 定时器），手势结束立即 flush（UI-03）
  const raf = globalThis.requestAnimationFrame?.bind(globalThis) ?? (f => setTimeout(f, 16));
  const caf = globalThis.cancelAnimationFrame?.bind(globalThis) ?? (id => clearTimeout(id));
  let overlayFrame = 0;
  // 数据更新后待重测锚点的节点：正文重建的同一任务内布局可能先缩后涨（异步补齐的状态行、按钮），
  // 立即测量会记下过渡位置，而帧末尺寸与上次一致时 ResizeObserver 不再通知——连线就停在错误端口高度。
  // 因此数据更新只登记，到下一帧（该任务的 DOM 全部落定后）再失效重测并重绘。
  const staleAnchors = new Set();   // nodeId；null 表示全部
  const dropStaleAnchors = () => {
    if (staleAnchors.has(null)) invalidatePorts(); else for (const id of staleAnchors) invalidatePorts(id);
    staleAnchors.clear();
  };
  function scheduleOverlay() {
    if (overlayFrame) return;
    overlayFrame = raf(() => { overlayFrame = 0; dropStaleAnchors(); renderEdges(); renderGroups(); });
  }
  function flushOverlay() {
    if (!overlayFrame) return;
    caf(overlayFrame); overlayFrame = 0;
    dropStaleAnchors(); renderEdges(); renderGroups();
  }
  const toWorld = e => {
    const r = board.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.scale, y: (e.clientY - r.top - view.y) / view.scale };
  };
  function portCenter(nodeId, portId, dir, byId) {
    const node = byId ? byId.get(nodeId) ?? null : store.node(nodeId);
    if (!node) return { x: 0, y: 0 };
    const key = `${dir}/${portId}`;
    const hit = portOffsets.get(nodeId)?.get(key);
    if (hit) return { x: node.x + hit.dx, y: node.y + hit.dy };
    const root = nodeEls.get(nodeId)?.root;
    const dot = root?.querySelector(`[data-port="${portId}"][data-dir="${dir}"] .dot`);
    if (!dot) return { x: node.x, y: node.y };
    // 相对节点自身外框测量：与节点 DOM 坐标是否已同步到 store 无关
    const rb = root.getBoundingClientRect(), db = dot.getBoundingClientRect();
    if (!db.width && !db.height) return { x: node.x, y: node.y };   // 隐藏端口不入缓存
    const off = { dx: (db.left + db.width / 2 - rb.left) / view.scale, dy: (db.top + db.height / 2 - rb.top) / view.scale };
    let m = portOffsets.get(nodeId);
    if (!m) portOffsets.set(nodeId, m = new Map());
    m.set(key, off);
    return { x: node.x + off.dx, y: node.y + off.dy };
  }

  // ---------- 大画布性能：视口外正文跳过渲染 + 低缩放概览折叠 ----------
  // 仅 ≥VIS_MIN_NODES 启用（小画布零行为差异）。两级：
  //   off  —— 常规缩放下节点在带余量视口外：.vis-off 标记 + content-visibility 跳过正文渲染；
  //   lite —— 缩放 ≤LOW_ZOOM_ON 进概览：.node-body 子树 display:none，bodySlot 内联 min-height
  //           保持折叠前实测高度 → 节点总高 / 端口 / 连线锚点 / 框选几何全部不变。
  // 豁免：选中、内含焦点、拖动中、拖线源节点恒为 full。正文子元素只隐藏不卸载——
  // 未保存输入、媒体元素与进行中任务状态原样保留；恢复仅摘 class，不重挂载。
  let liteMode = false;            // 概览迟滞态（liteModeFor 滞回）
  let dragMoving = null;           // 进行中的节点拖动集合（豁免）
  let visFrame = 0;                // 可见性重算按帧合并
  let lastProjId = projectIdOf(store.project);
  function projectIdOf(p) { return p ? (p.id ?? p.name ?? null) : null; }
  function applyVis(rec, state, bodyH) {
    if (bodyH > 0) rec.bodyH = bodyH;
    if (!rec.bodyH) state = 'full'; // 无真实测量时不裁剪，不能把占位高度当成正文高度。
    if (state === 'lite') {
      if (!rec.bodyH) state = 'full';                    // 高度不可测不折叠，避免端口/锚点跳动
      else {
        const mh = rec.bodyH + 'px';
        if (rec.bodySlot.style.minHeight !== mh) rec.bodySlot.style.minHeight = mh;
      }
    }
    if (state === 'off' && rec.bodyH) {
      // 视口外正文被跳过时以此实测高占位 → 节点总高稳定、锚点不偏移
      const cis = `auto ${rec.bodyContentH ?? rec.bodyH}px`;
      if (rec.bodySlot.style.containIntrinsicSize !== cis) rec.bodySlot.style.containIntrinsicSize = cis;
    }
    if (rec.vis === state) return;
    const wasLite = rec.vis === 'lite';
    rec.vis = state;
    rec.root.classList.toggle('lite', state === 'lite');
    rec.root.classList.toggle('vis-off', state === 'off');
    if (wasLite && state !== 'lite') { rec.bodySlot.style.minHeight = ''; scheduleOverlay(); }
  }
  function updateVisibility() {
    const nodes = store.project?.nodes ?? [];
    const enabled = perfEnabled(nodes.length);
    nodesLayer.classList.toggle('perf-on', enabled);
    if (!enabled) {
      liteMode = false;
      for (const rec of nodeEls.values()) applyVis(rec, 'full', 0);
      board.dataset.visOn = '0'; board.dataset.visMode = 'full';
      board.dataset.visLite = '0'; board.dataset.visOff = '0';
      return;
    }
    liteMode = liteModeFor(view.scale, liteMode);
    const vp = inflate(viewRect(view, board.clientWidth, board.clientHeight), VIEW_MARGIN);
    const active = document.activeElement;
    // 先集中读布局再统一写 class：避免逐节点读写交错（layout thrash）
    const list = [], meas = [];
    // 实测缓存 rec.meas：只在节点可见性状态未变、且未被 ResizeObserver / 正文重建 / 结构调和 / 窗口变化失效时复用。
    // 进出视口的节点状态会变化，照常重新实测；其余节点平移时不再逐帧读 offset*/getComputedStyle。
    for (const n of nodes) {
      const rec = nodeEls.get(n.id);
      if (!rec) continue;
      list.push({ n, rec });
      // 正文高度为 0 表示尚未真正测得（内容未就绪），不复用，下一次照常实测
      if (rec.meas && rec.meas.vis === rec.vis && rec.meas.bh > 0) { meas.push(rec.meas); continue; }
      const cs = !rec.vis || rec.vis === 'full' ? getComputedStyle(rec.bodySlot) : null;
      const inset = cs ? ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, key) => n + (parseFloat(cs[key]) || 0), 0) : 0;
      rec.meas = { vis: rec.vis, w: rec.root.offsetWidth || NODE_W, h: Math.max(rec.root.offsetHeight || NODE_H_EST, Number(rec.root.dataset?.fullHeight) || 0), bh: rec.bodySlot.offsetHeight, inset };
      meas.push(rec.meas);
    }
    let lite = 0, off = 0;
    for (let i = 0; i < list.length; i++) {
      const { n, rec } = list[i], m = meas[i];
      const exempt = selectedIds.has(n.id) || dragMoving?.has(n.id) === true
        || wire?.from.node === n.id || !!(active && rec.root.contains(active));
      const measured = !rec.vis || rec.vis === 'full' ? m.bh : 0;
      if (measured > 0) rec.bodyContentH = Math.max(0, measured - m.inset);
      applyVis(rec, classifyNode({ rect: { x: n.x, y: n.y, w: m.w, h: m.h }, vp, lowZoom: liteMode, exempt }), measured);
      if (rec.vis === 'lite') lite++; else if (rec.vis === 'off') off++;
    }
    board.dataset.visOn = '1'; board.dataset.visMode = liteMode ? 'lite' : 'full';
    board.dataset.visLite = String(lite); board.dataset.visOff = String(off);
  }
  function scheduleVis() {
    if (visFrame) return;
    visFrame = raf(() => { visFrame = 0; updateVisibility(); });
  }
  function visStats() {
    let lite = 0, off = 0, full = 0;
    for (const rec of nodeEls.values()) {
      if (rec.vis === 'lite') lite++;
      else if (rec.vis === 'off') off++;
      else full++;
    }
    return { enabled: nodesLayer.classList.contains('perf-on'), liteMode, lite, off, full, total: nodeEls.size, scale: view.scale };
  }

  // ---------- 吸附：先对齐其他节点边缘/中线，落空再贴网格 ----------
  function snapAxis(v, ownSpan, others, mapper, grid = true) {
    if (snap.align) {
      for (const o of others) {
        for (const c of mapper(o)) {
          for (const ePos of [v, v + ownSpan / 2, v + ownSpan]) {
            if (Math.abs(ePos - c) <= SNAP_T) return v + (c - ePos);
          }
        }
      }
    }
    return grid && snap.grid ? Math.round(v / GRID) * GRID : v;
  }
  // 对主拖动节点求吸附后的目标位置；返回吸附是否命中（供测试与提示）
  function snapPoint(node, moving, x, y, geometry, grid = true) {
    // 拖动开始时集中测量；pointermove 内不交错读取布局与写入坐标。
    const others = geometry?.others ?? (store.project?.nodes ?? []).filter(o => o.id !== node.id && !moving.has(o.id)).map(o => ({ x: o.x, y: o.y, ...nodeSize(o) }));
    const own = geometry?.own ?? nodeSize(node);
    const nx = snapAxis(x, own.w, others, o => [o.x, o.x + o.w / 2, o.x + o.w], grid);
    const ny = snapAxis(y, own.h, others, o => [o.y, o.y + o.h / 2, o.y + o.h], grid);
    return { x: nx, y: ny, snapped: nx !== x || ny !== y };
  }

  // ---------- 分组框 ----------
  function renderGroups() {
    const groups = studioState(store.project)?.groups ?? [];
    const boxes = [];
    for (const g of groups) {
      const members = g.members.map(id => store.node(id)).filter(Boolean);
      if (!members.length) continue;
      const x = Math.min(...members.map(n => n.x)) - 16;
      const y = Math.min(...members.map(n => n.y)) - 40;
      const w = Math.max(...members.map(n => n.x + nodeSize(n).w)) - x + 16;
      const h = Math.max(...members.map(n => n.y + nodeSize(n).h)) - y + 16;
      const title = el('span', { class: 'group-title', text: g.title || '分组', title: '点击选中整组 · 双击重命名' });
      title.addEventListener('pointerdown', e => { e.stopPropagation(); selectMany(members.map(n => n.id)); });
      title.addEventListener('dblclick', e => { e.stopPropagation(); onGroupAction?.('rename', g, { clientX: e.clientX, clientY: e.clientY }); });
      const ungroup = el('button', { class: 'group-x', type: 'button', text: '×', title: '解散分组（节点保留）' });
      ungroup.addEventListener('click', e => { e.stopPropagation(); onGroupAction?.('ungroup', g); });
      boxes.push(el('div', { class: 'group-box', 'data-group': g.id, style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px` }, title, ungroup));
    }
    groupLayer.replaceChildren(...boxes);
  }
  // 删除后清理：成员为空的组一并移除（在 checkpoint 之后调用方负责）
  function pruneGroups() {
    const st = store.project?.studio; if (!st?.groups?.length) return false;
    const before = st.groups.length;
    st.groups = st.groups.map(g => ({ ...g, members: g.members.filter(id => store.node(id)) })).filter(g => g.members.length);
    return st.groups.length !== before;
  }

  function portRow(node, port, dir) {
    // 输出端口标签在前、圆点殿后（外悬于节点右缘，不再与标签重叠，R15）；输入端口保持圆点居左
    const label = el('span', { text: port.label || port.id });
    const dot = el('span', { class: 'dot' });
    const row = el('div', { class: `port ${dir} ${KIND_CLASS[port.kind] ?? ''}`, 'data-port': port.id, 'data-dir': dir },
      ...(dir === 'out' ? [label, dot] : [dot, label]));
    if (dir === 'out') {
      row.addEventListener('pointerdown', e => {
        if (e.button != null && e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        if (wire) cancelWire();                  // 兜底清理异常残留的拖线会话（如指针释放事件丢失）
        beginWire(e, node, port);
      });
    }
    return row;
  }
  // 素材类型 → 输入端口兼容判定（与 studio-shell.connectWire 同一规则，不静默猜端口只做提示）
  const portAccepts = (pk, wk) => pk === 'any' || pk === wk || (pk === 'media' && ['image', 'video', 'audio'].includes(wk)) || wk === 'any';
  // 拖线落在节点体（非端口）：不弹建点菜单、不自动接线——高亮兼容输入口并提示（UI-02）
  function hintPorts(nodeId, wk) {
    const rec = nodeEls.get(nodeId), node = store.node(nodeId);
    if (!rec || !node) return;
    const dots = (NODE_TYPES[node.type]?.ports?.in ?? [])
      .filter(p => portAccepts(p.kind, wk))
      .map(p => rec.root.querySelector(`.port.in[data-port="${p.id}"] .dot`))
      .filter(Boolean);
    if (!dots.length) { toast(`「${node.data.title || node.type}」没有可接 ${wk} 类型的输入端口`, 'warn'); return; }
    for (const d of dots) d.classList.add('hot');
    toast('连线需落在输入端口上——兼容端口已高亮', 'info', 2400);
    setTimeout(() => { for (const d of dots) d.classList.remove('hot'); }, 1600);
  }
  // 拖线会话：窗口级 move/up/cancel/blur —— 在画布外松开、pointercancel、Esc 都会终止并清空 wire，
  // 之后的普通点击不会复用已结束的拖线状态（R07）
  function beginWire(e, node, port) {
    const pointerId = e.pointerId, captureTarget = e.currentTarget;
    wire = { from: { node: node.id, port: port.id, kind: kindOf(node) }, ...toWorld(e) };
    board.classList.add('is-connecting');
    markWireTargets(node.id, wire.from.kind);
    const move = ev => {
      if (ev.pointerId !== pointerId) return;
      if (ev.pointerType === 'mouse' && ev.buttons === 0) { cancelWire(); return; }
      if (wire) { Object.assign(wire, toWorld(ev)); renderEdges(); }
    };
    const up = ev => {
      if (ev.pointerId !== pointerId) return;
      const w = wire;
      // Resolve the target while floating editors still yield to the wire.
      const elAt = w ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
      cancelWire();
      if (!w) return;
      const hit = elAt?.closest?.('.port.in');
      if (hit) {
        const nodeEl = hit.closest('[data-node]');
        const edge = nodeEl && store.addEdge(w.from.node, w.from.port, nodeEl.dataset.node, hit.dataset.port, w.from.kind);
        if (!edge) toast(wireRefusal(w, nodeEl?.dataset.node, hit.dataset.port), 'warn', 4000);
        else onEdgesChanged?.(edge);
        return;
      }
      // 落在节点体而非端口：不弹建点菜单、不猜端口（UI-02）
      const nodeEl = elAt?.closest?.('[data-node]');
      if (nodeEl) { hintPorts(nodeEl.dataset.node, w.from.kind); return; }
      // 落到空白处：交给上层弹「添加节点」菜单，选中后自动接线
      onWireEnd?.(w, { clientX: ev.clientX, clientY: ev.clientY, world: toWorld(ev) });
    };
    const cancel = ev => { if (ev?.pointerId == null || ev.pointerId === pointerId) cancelWire(); };
    endWireSession = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      captureTarget?.removeEventListener('lostpointercapture', cancel);
      try { if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId); } catch { /* 指针已结束 */ }
      endWireSession = null;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    captureTarget?.addEventListener('lostpointercapture', cancel);
    try { captureTarget?.setPointerCapture?.(pointerId); } catch { /* 合成事件无原生捕获，仍按 pointerId 隔离 */ }
    renderEdges();
  }
  // 拖线期间：所有可接收当前类型的输入端口高亮、其余变淡，落点前即可看清能接到哪里（不猜端口，UI-02）
  const KIND_NAME = { text: '文本', image: '图片', video: '视频', audio: '音频', media: '素材', any: '任意内容' };
  const wireAccepts = (fromNode, kind, toNode, portDef) => toNode !== fromNode && storeAccepts(portDef.kind, kind)
    && !(store.project?.edges ?? []).some(x => x.from.node === fromNode && x.to.node === toNode && x.to.port === portDef.id);
  let wireMarked = [];
  function markWireTargets(fromNode, kind) {
    clearWireTargets();
    board.classList.add('wiring'); setOverlaysThrough(true);
    for (const [id, rec] of nodeEls) {
      const n = store.node(id);
      for (const p of NODE_TYPES[n?.type]?.ports?.in ?? []) {
        if (!wireAccepts(fromNode, kind, id, p)) continue;
        const row = rec.root.querySelector(`.port.in[data-port="${p.id}"]`);
        if (row) { row.classList.add('wire-ok'); wireMarked.push(row); }
      }
    }
  }
  function clearWireTargets() {
    board.classList.remove('wiring'); setOverlaysThrough(false);
    for (const row of wireMarked) row.classList.remove('wire-ok');
    wireMarked = [];
  }
  // 落在输入端口却接不上：说明具体原因，并列出该节点上可接的端口
  function wireRefusal(w, toNode, toPort) {
    const n = store.node(toNode), defs = NODE_TYPES[n?.type]?.ports?.in ?? [];
    const p = defs.find(x => x.id === toPort), what = KIND_NAME[w.from.kind] ?? '该内容';
    if (toNode === w.from.node) return '不能连接到节点自身';
    if (p && (store.project?.edges ?? []).some(x => x.from.node === w.from.node && x.to.node === toNode && x.to.port === toPort)) return `已连接到「${p.label || p.id}」`;
    const ok = defs.filter(x => wireAccepts(w.from.node, w.from.kind, toNode, x)).map(x => `「${x.label || x.id}」`);
    return `「${p?.label || toPort}」不接收${what}` + (ok.length ? `；可接到${ok.join('、')}` : '；该节点没有可接收的端口');
  }
  // ---------- 浮层与端口 ----------
  // 底部视图条、缩略图、顶部选中条和左侧栏悬浮在画布之上，卡片变高后端口可能落在它们下面。
  //  · 拖线/拖动节点期间：浮层变淡且不拦截指针，被盖住的端口可见、可作为落点；
  //  · 纯点击选中卡片时：若其端口被浮层挡住，按最小距离平移画布让出（标题保持可见）。
  const OVERLAY_SELECTOR = '#view-bar, #sel-bar, #rail, .minimap';
  const wrapEl = board.closest?.('#board-wrap') ?? board.parentElement ?? board;
  function setOverlaysThrough(on) { wrapEl?.classList?.toggle('overlays-through', !!on); }
  function visibleOverlays() {
    return [...(wrapEl?.querySelectorAll?.(OVERLAY_SELECTOR) ?? [])]
      .filter(o => !o.hidden && !o.classList.contains('hidden') && getComputedStyle(o).display !== 'none' && getComputedStyle(o).visibility !== 'hidden')
      .map(o => o.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  }
  function ensurePortsClear(id) {
    const rec = nodeEls.get(id); if (!rec || typeof getComputedStyle !== 'function') return;
    const ovs = visibleOverlays();
    const br = board.getBoundingClientRect(), midY = br.top + br.height / 2;
    const dots = [...rec.root.querySelectorAll('.port .dot')].map(d => d.getBoundingClientRect()).filter(d => d.width);
    // 逐轮试算：平移后可能又落到另一个浮层下（如从窗口外移到底部视图条下），最多 4 轮直到全部端口可见
    let ax = 0, ay = 0;
    for (let pass = 0; pass < 4; pass++) {
      let up = 0, down = 0, right = 0, left = 0;
      for (const d0 of dots) {
        const d = { left: d0.left + ax, right: d0.right + ax, top: d0.top + ay, bottom: d0.bottom + ay };
        // 画布可视区边缘同样视为遮挡：卡片变高后超出窗口的端口也让出来
        if (d.bottom > br.bottom - 8) up = Math.min(up, br.bottom - 8 - d.bottom);
        if (d.right > br.right - 8) left = Math.min(left, br.right - 8 - d.right);
        if (d.left < br.left + 8) right = Math.max(right, br.left + 8 - d.left);
        for (const o of ovs) {
          if (d.right < o.left || d.left > o.right || d.bottom < o.top || d.top > o.bottom) continue;
          if (o.height > br.height / 2) right = Math.max(right, o.right + 12 - d.left);   // 竖向侧栏：向右让
          else if (o.top > midY) up = Math.min(up, o.top - 12 - d.bottom);             // 底部浮层：向上让
          else down = Math.max(down, o.bottom + 12 - d.top);                           // 顶部浮层：向下让
        }
      }
      const dy = up < 0 ? up : down, dx = right > 0 ? right : left;
      if (!dy && !dx) break;
      ax += dx; ay += dy;
    }
    if (ay < 0) {   // 向上让出时标题不越过画布顶部可视区（卡片高于可视区时优先保留标题）
      const head = rec.root.querySelector('.node-head')?.getBoundingClientRect();
      if (head) ay = Math.min(0, Math.max(ay, br.top + 64 - head.top));
    }
    if (!ax && !ay) return;
    view.x += ax; view.y += ay;
    applyView();
  }
  function cancelWire() {
    if (!wire) return;
    clearWireTargets();
    endWireSession?.();
    board.classList.remove('is-connecting');
    wire = null; renderEdges();
  }

  function buildNodeEl(node) {
    const def = NODE_TYPES[node.type];
    const bodySlot = el('div', { class: 'node-body' });
    const root = el('div', { class: `node node-${node.type}`, 'data-node': node.id });
    const delBtn = el('button', { class: 'del', type: 'button', title: '删除节点', text: '✕' });
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      const live = store.node(node.id);
      if (live?.data.locked) { toast('节点已锁定（受保护），请先解锁再删除', 'warn'); return; }
      if (editor) editor.delete([node.id]); else store.removeNode(node.id);
      pruneGroups();
    });
    const head = el('div', { class: 'node-head' },
      el('span', { class: 'title', text: node.data.title || def.title }), delBtn);
    head.addEventListener('pointerdown', e => {
      // 仅左键可拖：右键不 preventDefault、不装手势——contextmenu 照常弹出节点菜单且绝不改位置；
      // 中键同样不拦截不 preventDefault，不干扰中键平移
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('button')) return;
      const live = store.node(node.id);
      if (!live || live.data.locked) return;
      e.preventDefault(); e.stopPropagation();
      const start = toWorld(e);
      // 多选优先；节点在组内且未选中 → 整组跟随；否则单节点
      const grp = (store.project.studio?.groups ?? []).find(g => g.members.includes(node.id));
      const moving = new Set(selectedIds.has(node.id) ? [...selectedIds] : grp?.members ?? [node.id]);
      const origins = [...moving].map(id => store.node(id)).filter(n => n && !n.data.locked).map(n => ({ id: n.id, x: n.x, y: n.y }));
      dragMoving = moving;   // 拖动集合概览豁免：拖动期间不做 lite 状态切换
      select('node', node.id, e.shiftKey, { inspect: false });
      const project = store.project;
      const origin = origins.find(o => o.id === node.id);
      if (!origin) return;
      const geometry = { own: nodeSize(live), others: project.nodes.filter(n => !moving.has(n.id)).map(n => ({ x: n.x, y: n.y, ...nodeSize(n) })) };
      const boardRect = board.getBoundingClientRect();
      let moved = false, ended = false;
      let moveFrame = 0, pending = null, lastPoint = null;
      const stillCurrent = () => store.project === project && store.node(node.id) === live;
      const applyPoint = (p, finish = false) => {
        if (!p || !stillCurrent()) return;
        const dx = p.x - start.x, dy = p.y - start.y;
        // 拖动期间连续跟手；保留节点对齐，8px 网格只在松手时应用。
        const s = snapPoint(live, moving, origin.x + dx, origin.y + dy, finish ? null : geometry, finish);
        for (const o of origins) {
          const n = store.node(o.id), x = Math.round(o.x + s.x - origin.x), y = Math.round(o.y + s.y - origin.y);
          if (n && !n.data.locked && (n.x !== x || n.y !== y)) store.moveNode(o.id, x, y);
        }
        flushOverlay();   // 节点和线在同一帧更新，不让连线落后一帧
      };
      try { head.setPointerCapture?.(e.pointerId); } catch { /* 合成事件无原生捕获 */ }
      const move = ev => {
        if (e.pointerId != null && ev.pointerId != null && ev.pointerId !== e.pointerId) return;
        if (!stillCurrent()) return;
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        if (!moved) { moved = true; editor?.checkpoint(); setOverlaysThrough(true); }   // 首次位移才落历史，纯点击不留空撤销
        pending = lastPoint = { x: (ev.clientX - boardRect.left - view.x) / view.scale, y: (ev.clientY - boardRect.top - view.y) / view.scale };
        if (!moveFrame) moveFrame = raf(() => { moveFrame = 0; const p = pending; pending = null; applyPoint(p); });
      };
      const done = ev => {
        if (ended) return;
        if (e.pointerId != null && ev?.pointerId != null && ev.pointerId !== e.pointerId) return;   // 只认起始指；Esc/失捕兜底（无 ev）仍生效
        ended = true;
        if (moveFrame) { caf(moveFrame); moveFrame = 0; }
        dragMoving = null;
        if (moved) applyPoint(lastPoint, ev?.type === 'pointerup');
        setOverlaysThrough(false);
        if (!moved && ev?.type === 'pointerup') ensurePortsClear(node.id);   // 纯点击标题：端口被浮层挡住时最小平移让出
        if (liveCopies.size) renderEdges();   // 结束（含纯点击/Esc/失捕）：原连线一次性更新几何并恢复显示
        pending = null;
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', done);
        head.removeEventListener('pointercancel', done);
        head.removeEventListener('lostpointercapture', done);
        if (cancelGesture === done) cancelGesture = null;
        try { if (head.hasPointerCapture?.(e.pointerId)) head.releasePointerCapture(e.pointerId); } catch { /* 捕获可能已自动释放 */ }
        flushOverlay();   // 拖动结束立即 flush 边/分组末状态（UI-03）
        if (moved && stillCurrent()) drawMap();
        if (!moved && ev?.type === 'pointerup') onSelect?.(selected);
      };
      cancelGesture = done;
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', done);
      head.addEventListener('pointercancel', done); head.addEventListener('lostpointercapture', done);
    });
    root.append(head, bodySlot);
    for (const p of def.ports?.in ?? []) root.append(portRow(node, p, 'in'));
    let syncOutput = null;
    if (node.type === 'gen') {
      const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': '节点内预览' });
      const label = el('label', { class: 'gen-output-toggle' }, toggle, el('span', { text: '节点内预览' }));
      const hint = el('p', { class: 'gen-output-hint' });
      const port = portRow(node, { ...def.ports.out[0], label: '视频输出' }, 'out');
      port.title = '拖动连接到下游节点';
      const footer = el('section', { class: 'gen-output-footer', 'aria-label': '结果输出方式' }, label, hint, port);
      syncOutput = () => {
        const live = store.node(node.id); if (!live) return;
        const linked = store.project.edges.filter(edge => edge.from.node === node.id && edge.from.port === 'out').length;
        const direct = directVideoOutput(store.project, live);
        toggle.checked = direct; toggle.disabled = linked > 0;
        toggle.setAttribute('aria-checked', String(direct));
        label.title = linked ? '已连接下游；先断开输出连线，再开启节点内预览' : '只切换结果显示方式，不会自动生成或收费';
        hint.textContent = linked ? `输出至 ${linked} 个下游节点` : direct ? '完成后在此预览、下载；不会自动提交' : '拖动右侧接口，连接下游节点';
        port.hidden = direct;
        footer.classList.toggle('direct', direct);
      };
      toggle.addEventListener('change', () => {
        const live = store.node(node.id); if (!live) return;
        if (store.project.edges.some(edge => edge.from.node === node.id && edge.from.port === 'out')) { syncOutput(); return; }
        editor?.checkpoint();
        store.updateNodeData(node.id, { directOutput: toggle.checked });
      });
      root.append(footer);
    } else for (const p of def.ports?.out ?? []) root.append(portRow(node, p, 'out'));
    // 节点体点选同样限左键：右键由 contextmenu 统一选中并开菜单，中键不抢事件（不干扰平移）
    root.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      select('node', node.id, e.shiftKey);
    });
    root.addEventListener('click', e => {
      if (e.button !== 0 || e.shiftKey || e.target.closest('.node-head, .port, input, textarea, select, button, a, video, audio')) return;
      if (selectedIds.size === 1 && selectedIds.has(node.id)) ensurePortsClear(node.id);
    });
    return { root, bodySlot, syncOutput };
  }
  function refreshBody(id) {
    const rec = nodeEls.get(id), node = store.node(id);
    if (!rec || !node) return;
    invalidatePorts(id);   // 输出口显隐/正文重建都可能移动端口锚点
    staleAnchors.add(id); scheduleOverlay();   // 同一任务内后续 DOM 变动落定后，下一帧再测一次
    rec.syncOutput?.();
    // 正在编辑该节点内容（输入中）时跳过 body 重建，只刷标题
    if (rec.bodySlot.contains(document.activeElement)) { rec.root.querySelector('.title').textContent = node.data.title || NODE_TYPES[node.type].title; return; }
    const key = bodyKey?.(node);
    if (key != null && rec.bodyKey === key) {
      rec.root.querySelector('.title').textContent = node.data.title || NODE_TYPES[node.type].title;
      return;
    }
    applyVis(rec, 'full', 0);
    rec.meas = null;
    rec.bodyH = 0;
    rec.bodyContentH = 0;
    rec.bodySlot.style.containIntrinsicSize = '';
    rec.bodySlot.replaceChildren(renderBody(node));
    rec.bodyKey = key;
    rec.root.querySelector('.title').textContent = node.data.title || NODE_TYPES[node.type].title;
  }
  function reconcile() {
    const nodes = store.project?.nodes ?? [];
    invalidatePorts();   // 结构变化：全部锚点下次渲染重新实测
    for (const rec of nodeEls.values()) rec.meas = null;
    staleAnchors.add(null); scheduleOverlay();   // 本次同步渲染之后的 DOM 变动由下一帧复测兜底
    const alive = new Set(nodes.map(n => n.id));
    for (const [id, rec] of nodeEls) if (!alive.has(id)) { resizeObserver?.unobserve(rec.root); rec.root.remove(); nodeEls.delete(id); }
    for (const id of [...selectedIds]) if (!alive.has(id)) selectedIds.delete(id);   // 已删节点不留选择残留
    for (const n of nodes) {
      let rec = nodeEls.get(n.id);
      if (!rec) { rec = buildNodeEl(n); nodeEls.set(n.id, rec); nodesLayer.append(rec.root); refreshBody(n.id); resizeObserver?.observe(rec.root); }
      // 任务驱动的节点随 render 同步状态区（R04）；refreshBody 内部保留节点内编辑焦点
      else if (['gen', 'image', 'text', 'utility'].includes(n.type)) refreshBody(n.id);
      rec.root.style.left = n.x + 'px'; rec.root.style.top = n.y + 'px';
      rec.root.classList.toggle('selected', selectedIds.has(n.id));
      rec.root.classList.toggle('locked', n.data.locked === true);
    }
    renderEdges();
    renderGroups();
    drawMap();
    updateVisibility();
  }
  function edgePath(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  function renderEdges() {
    const ns = 'http://www.w3.org/2000/svg';
    const edges = store.project?.edges ?? [];
    // 所有端口先读后写，多个共享端口只测一次；锚点走 portOffsets 缓存，拖动/平移帧内零布局读取。
    const ports = new Map();
    const byId = new Map((store.project?.nodes ?? []).map(n => [n.id, n]));
    const center = (node, port, dir) => {
      const key = `${node}/${dir}/${port}`;
      if (!ports.has(key)) ports.set(key, portCenter(node, port, dir, byId));
      return ports.get(key);
    };
    const paths = edges.map(edge => ({ edge, d: edgePath(center(edge.from.node, edge.from.port, 'out'), center(edge.to.node, edge.to.port, 'in')) }));
    const preview = wire ? edgePath(center(wire.from.node, wire.from.port, 'out'), wire) : null;
    const alive = new Set(edges.map(edge => edge.id));
    for (const [id, rec] of edgeEls) if (!alive.has(id)) { rec.g.remove(); edgeEls.delete(id); }
    // 拖动中：与移动节点相连的连线走实时层副本，主层对应元素仅隐藏（不移动、不重建、不改几何）
    const liveIds = new Set();
    if (edgesLive && dragMoving?.size)
      for (const { edge } of paths) if (dragMoving.has(edge.from.node) || dragMoving.has(edge.to.node)) liveIds.add(edge.id);
    for (const [id, copy] of liveCopies) if (!liveIds.has(id)) {
      copy.remove(); liveCopies.delete(id);
      const rec = edgeEls.get(id); if (rec) rec.g.style.visibility = '';
    }
    for (const { edge, d } of paths) {
      let rec = edgeEls.get(edge.id);
      if (!rec) {
        // 可视2px描边与14px透明命中区共用同一条几何路径。
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'edge'); g.setAttribute('data-edge', edge.id);
        const viewPath = document.createElementNS(ns, 'path');
        viewPath.setAttribute('fill', 'none');
        viewPath.setAttribute('stroke-width', '2');
        viewPath.style.pointerEvents = 'none';
        const hit = document.createElementNS(ns, 'path');
        hit.setAttribute('fill', 'none');
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '14');
        hit.setAttribute('class', 'edge-hit');
        hit.style.pointerEvents = 'stroke';
        g.addEventListener('pointerdown', e => {
          e.stopPropagation();
          if (e.button === 2) return; // 右键选中与菜单统一由contextmenu处理
          select('edge', edge.id);
        });
        g.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          if (selected?.type !== 'edge' || selected.id !== edge.id) select('edge', edge.id);
          const current = store.project?.edges.find(x => x.id === edge.id);
          if (onEdgeMenu && current) onEdgeMenu(current, posOf(e));
          else toast('已选中连线（Delete 删除）', 'info');
        });
        g.append(viewPath, hit);
        edgesSvg.append(g);
        rec = { g, viewPath, hit }; edgeEls.set(edge.id, rec);
      }
      const stroke = selected?.type === 'edge' && selected.id === edge.id ? 'var(--accent)' : 'var(--edge)';
      if (liveIds.has(edge.id)) {
        let copy = liveCopies.get(edge.id);
        if (!copy) {
          copy = document.createElementNS(ns, 'path');
          copy.setAttribute('fill', 'none'); copy.setAttribute('stroke-width', '2');
          copy.setAttribute('data-live-edge', edge.id);
          copy.style.pointerEvents = 'none';
          edgesLive.append(copy); liveCopies.set(edge.id, copy);
          rec.g.style.visibility = 'hidden';
        }
        if (copy.getAttribute('d') !== d) copy.setAttribute('d', d);
        if (copy.getAttribute('stroke') !== stroke) copy.setAttribute('stroke', stroke);
        continue;   // 主层几何留到松手后一次性更新
      }
      if (rec.d !== d) { rec.viewPath.setAttribute('d', d); rec.hit.setAttribute('d', d); rec.d = d; }
      if (rec.stroke !== stroke) { rec.viewPath.setAttribute('stroke', stroke); rec.stroke = stroke; }
    }
    if (wire) {
      if (!wirePath) {
        wirePath = document.createElementNS(ns, 'path');
        wirePath.setAttribute('stroke', 'var(--accent)'); wirePath.setAttribute('stroke-dasharray', '6 4');
        wirePath.setAttribute('fill', 'none'); wirePath.setAttribute('stroke-width', '2');
        wirePath.style.pointerEvents = 'none';
        (edgesLive ?? edgesSvg).append(wirePath);
      }
      wirePath.setAttribute('d', preview);
    } else if (wirePath) { wirePath.remove(); wirePath = null; }
  }
  function select(type, id, additive = false, options) {
    // select(null, …)：真正清空——selected 收敛为 null（旧实现留下 {type:null} 真值对象，
    // board.selected 判空失真，Esc/Delete 等按 truthy 判断的分支会误以为仍有选中）。
    // 已空时幂等：不重复通知，但仍 reconcile 保持视图同步。
    if (type == null) {
      const had = selected != null || selectedIds.size > 0;
      selectedIds.clear(); selected = null;
      if (had) onSelect?.(null, options);
      reconcile();
      return;
    }
    if (!additive && !(type === 'node' && selectedIds.has(id))) selectedIds.clear();
    if (type === 'node') {
      if (additive && selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      // shift 取消当前/最后一个节点：selected 必须落在仍选中节点上，否则为 null——
      // 绝不指向刚被取消的节点，onSelect 同步一致（不遗留已取消节点的检查器）
      selected = selectedIds.has(id) ? { type: 'node', id }
        : selectedIds.size ? { type: 'node', id: [...selectedIds][0] } : null;
    } else {
      selectedIds.clear();
      selected = { type, id };
    }
    onSelect?.(selected, options); reconcile();
  }
  function selectMany(ids) {
    selectedIds.clear(); ids.forEach(id => { if (store.node(id)) selectedIds.add(id); });
    selected = selectedIds.size ? { type: 'node', id: [...selectedIds][0] } : null;
    onSelect?.(selected); reconcile();
  }
  function removeEdge(id) {
    if (!store.project?.edges.some(edge => edge.id === id)) return false;
    editor?.checkpoint();
    store.removeEdge(id);
    if (selected?.type === 'edge' && selected.id === id) { selected = null; onSelect?.(null); }
    return true;
  }
  // 选中集合删除：锁定（受保护）节点拒绝删除并显式提示
  function deleteSelection() {
    const ids = [...selectedIds];
    const locked = ids.filter(id => store.node(id)?.data.locked);
    const free = ids.filter(id => !store.node(id)?.data.locked);
    if (locked.length) toast(`已跳过 ${locked.length} 个受保护节点（先解锁再删除）`, 'warn');
    if (free.length) {
      if (editor) editor.delete(free); else for (const id of free) store.removeNode(id);
      pruneGroups();
      // 删除集不留残留；仍存活的受保护节点保持选中——可直接 Ctrl+L 解锁后再删
      selectedIds.clear();
      for (const id of locked) if (store.node(id)) selectedIds.add(id);
      selected = selectedIds.size ? { type: 'node', id: [...selectedIds][0] } : null;
      onSelect?.(selected); reconcile();
    } else if (locked.length) {
      // 全部命中受保护节点：一次都没删 → 不改选中态（Delete 不等于取消选择）
      reconcile();
    }
  }
  function ungroupSelection() {
    const st = studioState(store.project); if (!st.groups.length) return;
    const hit = st.groups.filter(g => g.members.some(id => selectedIds.has(id)));
    if (!hit.length) { toast('选中节点不在任何分组内', 'warn'); return; }
    editor?.checkpoint();
    for (const g of hit) st.groups.splice(st.groups.indexOf(g), 1);
    store.touch({ type: 'structure' });
  }

  // 节点粘贴：同项目走同步快速路径；剪贴板属于其他项目且 editor 提供异步导入适配时才跨项目粘贴。
  // 异步适配是受保护的导入（新 id、剥运行时身份），失败只报错不半截落地。
  async function pasteNodes() {
    const local = editor?.paste?.() ?? [];
    if (local.length) { selectMany(local.map(n => n.id)); return; }
    const cross = editor?.pasteAcrossProject ?? editor?.pasteIntoCurrent;
    if (typeof cross === 'function') {
      try {
        const ns = await cross.call(editor);
        if (ns?.length) { selectMany(ns.map(n => n.id ?? n)); return; }
      } catch (e) { toast(`跨项目粘贴失败：${e.message}`, 'err', 6000); return; }
    }
    toast('剪贴板为空或属于其他项目（先在画布内 Ctrl+C 复制节点）', 'warn');
  }

  store.onChange(reason => {
    if (!reason) return reconcile();
    if (reason.type === 'project') {
      // 项目切换：选中集按项目隔离，拖线/手势残留一并清掉，旧项目 id 绝不带进新项目
      if (lastProjId != null) projectViews.set(lastProjId, { x: view.x, y: view.y, scale: view.scale });
      selectedIds.clear(); selected = null; cancelWire(); cancelGesture?.();
      dragMoving = null; liteMode = false;
      onSelect?.(null);
      // 新项目若来过则恢复上次视口（模块级记忆；首次进入保留当前视图不强制复位）
      lastProjId = projectIdOf(store.project);
      const saved = lastProjId != null ? projectViews.get(lastProjId) : null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.scale)) {
        view.x = saved.x; view.y = saved.y; view.scale = Math.min(2, Math.max(0.1, saved.scale));
        applyView();
      }
      return reconcile();
    }
    if (reason.type === 'move') {
      const n = store.node(reason.id), rec = nodeEls.get(reason.id);
      if (n && rec) { rec.root.style.left = n.x + 'px'; rec.root.style.top = n.y + 'px'; }
      scheduleOverlay();   // 移动中的边/分组重绘按帧合并，松手由手势 done 处 flush（UI-03）
    } else if (reason.type === 'data') {
      refreshBody(reason.id);
      staleAnchors.add(reason.id ?? null);   // 帧内重测：见 staleAnchors 注释
      scheduleOverlay(); scheduleVis();
    }
    else reconcile();
  });

  // 画布上的拖动/平移/框选/拖线期间禁止页面文字选择：拖过工具栏、侧栏或状态栏时不会误选中文字。
  // 节点内输入框不受影响；手势结束（松开/取消/失焦）立即恢复。
  const endNoSelect = () => document.body?.classList.remove('xp-gesture');
  board.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    document.body?.classList.add('xp-gesture');
  }, true);
  for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, endNoSelect, true);
  window.addEventListener('blur', endNoSelect);
  board.addEventListener('pointerdown', e => {
    if (e.target !== board && e.target !== nodesLayer && e.target !== edgesSvg && e.target !== groupLayer) return;
    if (e.button === 2) return;
    cancelWire();                               // 空白处按下也清掉可能残留的拖线预览
    if (e.shiftKey) {
      // 框选：拖动过程只更新选框与 in-lasso 预览高亮（零 reconcile/检查器重建），
      // 松手一次性 selectMany 提交；Esc/pointercancel/失捕/项目切换仅清理不提交（UI-03）
      const pid = e.pointerId;
      const a = toWorld(e), box = el('div', { class: 'selection-box' });
      nodesLayer.append(box);
      try { board.setPointerCapture?.(pid); } catch { /* 合成事件无原生捕获 */ }
      let lasso = new Set(), dirty = false, finished = false;
      const samePointer = ev => pid == null || ev?.pointerId == null || ev.pointerId === pid;
      const preview = ids => { for (const [id, rec] of nodeEls) rec.root.classList.toggle('in-lasso', ids.has(id)); };
      const move = ev => {
        if (!samePointer(ev)) return;
        dirty = true;
        const b = toWorld(ev), x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
        Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        lasso = new Set(store.project.nodes.filter(n => n.x + nodeSize(n).w >= x && n.x <= x + w && n.y + nodeSize(n).h >= y && n.y <= y + h).map(n => n.id));
        preview(lasso);
      };
      const finish = commit => {
        if (finished) return;                              // pointerup/cancel/失捕不重复结算
        finished = true;
        box.remove(); preview(new Set()); flushOverlay();
        board.removeEventListener('pointermove', move);
        board.removeEventListener('pointerup', onUp);
        board.removeEventListener('pointercancel', onCancel);
        board.removeEventListener('lostpointercapture', onCancel);
        if (cancelGesture === cancel) cancelGesture = null;
        if (commit && dirty) selectMany([...lasso]);   // 一次 commit：有界 render 数
      };
      const onUp = ev => { if (samePointer(ev)) finish(true); };       // 异 pointerId 的松开不结算
      const onCancel = ev => { if (samePointer(ev)) finish(false); };  // cancel/失捕/项目切换只清理不提交
      const cancel = () => finish(false);
      cancelGesture = cancel;
      board.addEventListener('pointermove', move); board.addEventListener('pointerup', onUp);
      board.addEventListener('pointercancel', onCancel); board.addEventListener('lostpointercapture', onCancel);
      return;
    }
    select(null, null);
    const pid = e.pointerId;
    const sx = e.clientX - view.x, sy = e.clientY - view.y;
    try { board.setPointerCapture?.(pid); } catch { /* 合成事件无原生捕获 */ }
    // 平移期间把节点层/连线层提升为独立合成层（只改 transform 时不重绘 200 张卡片与全部连线）；
    // 结束即撤销，缩放后的文字按最终比例重新栅格化，不留模糊
    board.classList.add('panning');
    const move = ev => {
      if (pid != null && ev.pointerId != null && ev.pointerId !== pid) return;
      view.x = ev.clientX - sx; view.y = ev.clientY - sy;
      applyView(); scheduleOverlay();      // 边/分组重绘按帧合并（UI-03）
    };
    let ended = false;
    const done = ev => {
      if (ended) return;
      if (pid != null && ev?.pointerId != null && ev.pointerId !== pid) return;   // 只认起始指；Esc 兜底（无 ev）仍生效
      ended = true;
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerup', done);
      board.removeEventListener('pointercancel', done);
      board.removeEventListener('lostpointercapture', done);
      if (cancelGesture === done) cancelGesture = null;
      board.classList.remove('panning');
      flushOverlay();                       // 平移结束立即 flush 末状态
    };
    cancelGesture = done;
    board.addEventListener('pointermove', move); board.addEventListener('pointerup', done);
    board.addEventListener('pointercancel', done); board.addEventListener('lostpointercapture', done);
  });
  board.addEventListener('wheel', e => {
    // 节点内可滚动控件（长 textarea / contenteditable / .scrollable）滚轮滚自身；
    // Ctrl/Meta+wheel（触控板捏合）与空白处滚轮保持画布缩放约定（UI-05）
    if (!e.ctrlKey && !e.metaKey) {
      const sc = e.target?.closest?.('textarea, [contenteditable], .scrollable');
      if (sc && (sc.scrollHeight ?? 0) > (sc.clientHeight ?? 0) + 1) return;
    }
    e.preventDefault();
    const p = toWorld(e);
    const next = Math.min(2, Math.max(0.25, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.x = e.clientX - board.getBoundingClientRect().left - p.x * next;
    view.y = e.clientY - board.getBoundingClientRect().top - p.y * next;
    view.scale = next; applyView(); renderEdges();
  }, { passive: false });
  const posOf = e => ({ world: toWorld(e), clientX: e.clientX, clientY: e.clientY });
  board.addEventListener('contextmenu', e => {
    if (e.target.closest('input,textarea')) return;
    e.preventDefault();
    // 连线右键：命中 data-edge <g>/透明命中层 → 选中并交给上层连线菜单（删除/定位，UI-02）
    const edgeEl = e.target.closest?.('[data-edge]');
    if (edgeEl) {
      const edge = (store.project?.edges ?? []).find(x => x.id === edgeEl.dataset.edge);
      if (edge) {
        if (selected?.type !== 'edge' || selected.id !== edge.id) select('edge', edge.id);
        if (onEdgeMenu) onEdgeMenu(edge, posOf(e));
        else toast('已选中连线（Delete 删除）', 'info');
      }
      return;
    }
    const nodeEl = e.target.closest?.('[data-node]');
    if (nodeEl) {
      const n = store.node(nodeEl.dataset.node);
      if (n) { if (!selectedIds.has(n.id)) select('node', n.id); onNodeMenu?.(n, posOf(e)); }
      return;
    }
    onAddMenu?.(posOf(e));
  });
  board.addEventListener('dblclick', e => {
    if (e.target.closest?.('[data-edge]')) return;   // 双击连线不弹建点菜单
    const nodeEl = e.target.closest?.('[data-node]');
    if (nodeEl) { const n = store.node(nodeEl.dataset.node); if (n) onNodeMenu?.(n, posOf(e)); return; }
    if (!e.target.closest('.group-box')) onAddMenu?.(posOf(e));
  });
  // 拖线 move/up 已由 beginWire 的窗口级会话监听接管（画布外释放同样生效）
  document.addEventListener('keydown', e => {
    // 顺序：IME → 弹层 → Esc（手势先取消、输入中仅退焦）→ 输入控件 → 快捷键（UI-06）。
    // 输入中/IME 的 Esc 不清选择、不销毁检查器焦点；活动拖线/手势的 Esc 取消保留；
    // 弹层 Esc 由其自身 capture 监听先行消费（R06 隔离不变）。
    if (e.isComposing) return;                                                   // IME 组合输入期间一律不触发（含 Esc）
    if (document.getElementById('overlay-root')?.childElementCount) return;      // 弹窗/菜单打开时隔离画布快捷键（R06）
    const inField = !!e.target?.matches?.('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape') {
      const hadWire = !!wire, hadGesture = !!cancelGesture;
      cancelWire(); cancelGesture?.();
      if (inField) { e.target.blur?.(); return; }          // 输入中 Esc：仅退出编辑焦点，选择/检查器保留
      if (!hadWire && !hadGesture && selected) select(null, null);
      return;
    }
    if (inField || e.target?.matches?.('button')) return;
    if (editor && (e.ctrlKey || e.metaKey)) {
      const k = e.key.toLowerCase();
      // 'v' 不 preventDefault：真实 paste 事件必须照常派发——剪贴板是媒体文件时由 main.js
      // 的 paste 监听消费并调 cancelPendingPaste()，节点粘贴自动让位，绝不双份执行。
      if (['z','y','a','c','d','g','l'].includes(k)) e.preventDefault();
      if (k === 'z') e.shiftKey ? editor.redo() : editor.undo();
      else if (k === 'y') editor.redo();
      else if (k === 'a') selectMany(store.project.nodes.map(n => n.id));
      else if (k === 'c') { if (!editor.copy([...selectedIds])) toast('没有可复制的选中节点', 'warn'); }
      else if (k === 'v') {
        // 节点粘贴排队到本任务末尾：paste 事件（若有媒体文件/显式文本）先于 setTimeout 派发并可取消它；
        // 系统剪贴板为空 → paste 监听不消费，节点粘贴照常执行。
        pendingNodePaste = true;
        setTimeout(() => {
          if (!pendingNodePaste) return;
          pendingNodePaste = false;
          void pasteNodes();
        }, 0);
      }
      else if (k === 'd') selectMany(editor.duplicate([...selectedIds]).map(n => n.id));
      else if (k === 'g') { e.shiftKey ? ungroupSelection() : (selectedIds.size > 1 ? editor.group([...selectedIds]) : toast('成组需先选中至少 2 个节点', 'warn')); }
      else if (k === 'l') { if (selectedIds.size) { editor.lock([...selectedIds]); } }
      return;
    }
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey) { fit(); return; }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (selected?.type === 'node') deleteSelection();
    else if (selected?.type === 'edge') removeEdge(selected.id);
    else return;
  });
  window.addEventListener('resize', () => { invalidatePorts(); for (const rec of nodeEls.values()) rec.meas = null; renderEdges(); scheduleVis(); drawMap(); });
  function fit() {
    const ns = store.project.nodes; if (!ns.length) return;
    const x = Math.min(...ns.map(n => n.x)), y = Math.min(...ns.map(n => n.y));
    const w = Math.max(...ns.map(n => n.x + nodeSize(n).w)) - x, h = Math.max(...ns.map(n => n.y + nodeSize(n).h)) - y;
    const rail = document.getElementById('rail');
    const dock = document.getElementById('sidebar');
    const br = board.getBoundingClientRect();
    const obstacle = dock && !dock.inert ? dock : rail && !rail.hidden ? rail : null;
    const left = Math.min(Math.max(30, (obstacle?.getBoundingClientRect?.().right || 0) - br.left + 24), Math.max(30, board.clientWidth - 140));
    const top = 76, bottom = 120;
    view.scale = Math.max(.1, Math.min(1, (board.clientWidth - left - 30) / w, (board.clientHeight - top - bottom) / h));
    view.x = left - x * view.scale; view.y = top - y * view.scale; applyView();
  }
  // 以画布中心为锚缩放（工具栏 ＋/－）
  function zoomBy(f) {
    const cx = board.clientWidth / 2, cy = board.clientHeight / 2;
    const wx = (cx - view.x) / view.scale, wy = (cy - view.y) / view.scale;
    view.scale = Math.min(2, Math.max(0.25, view.scale * f));
    view.x = cx - wx * view.scale; view.y = cy - wy * view.scale;
    applyView(); renderEdges();
  }
  // 搜索/任务面板定位：居中 + 选中 + 闪烁提示
  function focusNode(id) {
    const n = store.node(id); if (!n) return false;
    const cx = board.clientWidth / 2, cy = board.clientHeight / 2;
    view.x = cx - (n.x + nodeSize(n).w / 2) * view.scale;
    view.y = cy - (n.y + nodeSize(n).h / 2) * view.scale;
    applyView();
    select('node', id);
    const rec = nodeEls.get(id);
    if (rec) { rec.root.classList.add('flash'); setTimeout(() => rec.root.classList.remove('flash'), 1400); }
    return true;
  }

  applyView();
  return {
    render: reconcile, select, selectMany, fit, applyView, onViewChange, view, portCenter, refreshBody,
    focusNode, zoomBy, minimapAvoid, deleteSelection, removeEdge, ungroupSelection, renderGroups, snap, measureNode: nodeSize,
    toWorld,
    pasteNodes,
    updateVisibility, visStats,
    savedView: id => projectViews.get(id) ?? null,   // 调试/测试只读：项目 id → 上次视口
    cancelPendingPaste() { pendingNodePaste = false; },
    // 连线右键菜单回调：装配层可在 createBoard 传 onEdgeMenu，也可由此后置注入（studio-shell 自动接线）
    setEdgeMenu(fn) { onEdgeMenu = fn; },
    get selectedIds() { return [...selectedIds]; },
    get selected() { return selected; },
  };
}
