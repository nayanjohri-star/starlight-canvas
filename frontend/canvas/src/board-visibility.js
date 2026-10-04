// 大画布可见性纯几何模块：无 DOM / 无状态依赖，供 board.js 与单元测试共用。
// 视口外扩余量 + 低缩放迟滞带，避免边界节点进出视口/缩放阈值时反复抖动切换。

export const VIS_MIN_NODES = 40;   // 节点数低于阈值完全不做优化（小画布零行为差异）
export const VIEW_MARGIN = 240;    // 视口外扩余量（世界 px）：平移时边缘节点不频繁进出
export const LOW_ZOOM_ON = 0.45;   // 缩放 ≤ 此值进入概览：非豁免节点折叠正文为简卡
export const LOW_ZOOM_OFF = 0.58;  // 缩放 ≥ 此值退出概览；两阈值之间保持前一状态（迟滞）

// 节点数门控：阈值以下一律返回 false，调用方据此完全跳过可见性分级
export function perfEnabled(nodeCount) {
  return nodeCount >= VIS_MIN_NODES;
}

// 视图变换 {x,y,scale}（translate + scale）→ 世界坐标可视矩形；w/h 为画布像素尺寸
export function viewRect(view, w, h) {
  const s = view.scale || 1;
  return { x: -view.x / s || 0, y: -view.y / s || 0, w: w / s, h: h / s };
}

// 矩形四向外扩 m（世界 px）
export function inflate(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

// AABB 相交：边缘相切算可见（保守——贴边节点不闪隐）
export function intersects(a, b) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

// 概览模式迟滞：scale ≤ LOW_ZOOM_ON 进入，≥ LOW_ZOOM_OFF 退出，中间带维持 prev
export function liteModeFor(scale, prev) {
  return prev ? scale < LOW_ZOOM_OFF : scale <= LOW_ZOOM_ON;
}

// 单节点可见性分级，优先级：exempt > lowZoom > 视口相交。
//   'full' —— 完整渲染（视口内，或豁免：选中 / 内含焦点 / 拖动中 / 拖线源）
//   'off'  —— 常规缩放下在带余量视口外：CSS content-visibility 跳过正文渲染，DOM 保留
//   'lite' —— 概览缩放折叠正文：保节点头 / 端口 / 实测高度；子元素只隐藏不卸载
// rect 为节点实测几何 {x,y,w,h}（世界坐标），vp 为已外扩的可视矩形。
export function classifyNode({ rect, vp, lowZoom = false, exempt = false }) {
  if (exempt) return 'full';
  if (lowZoom) return 'lite';
  return intersects(rect, vp) ? 'full' : 'off';
}
