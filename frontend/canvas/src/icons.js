// 线性图标库（壳专用）：全部手绘 24×24 stroke 图形，stroke=currentColor 继承按钮颜色，
// 零外部依赖、无字体/图片资源。
// icon(name, size=18) 返回 SVG 元素；applyIcon(button, name, label?) 把图标插到按钮最前，
// 原文字收进 .ic-label——按钮 id/事件/文字内容全部保留，缺可达名时用 label/title 补齐。
// 极简 DOM 桩没有 createElementNS 时退回同尺寸占位 <span class="ic">，不破坏调用方布局。

const NS = 'http://www.w3.org/2000/svg';
// 与 ui.js 同策略：旧测试 DOM 桩可能缺 querySelectorAll——退回空集而不是抛错
const qa = (root, sel) => (typeof root?.querySelectorAll === 'function' ? [...root.querySelectorAll(sel)] : []);

// 字符串 → <path d>；{tag, ...attrs} → 任意 SVG 形状（rect/circle 等）
const ICONS = {
  // 通用
  'plus': ['M12 5.5v13', 'M5.5 12h13'],
  'x': ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-down': ['M6 9.5l6 6 6-6'],
  'search': [{ tag: 'circle', cx: 11, cy: 11, r: 6.5 }, 'M20.5 20.5 15.8 15.8'],
  'star': ['M12 3.6l2.5 5.4 5.9.6-4.4 4 1.2 5.8L12 16.5l-5.2 2.9 1.2-5.8-4.4-4 5.9-.6z'],
  'key': [{ tag: 'circle', cx: 8, cy: 14.5, r: 4.2 }, 'M11.2 11.3 19.5 3', 'M15.5 6.5l2.6 2.6', 'M13 9l2 2'],
  // 顶栏 / 项目菜单 / 工作模式
  'chat': ['M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 17 15H9.2L4.5 19.5z', 'M8.3 8.5h7.4', 'M8.3 11.5h4.4'],
  'export': ['M12 14.5V3.8', 'M7.6 8.2 12 3.8l4.4 4.4', 'M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
  'import': ['M12 3.8v10.7', 'M7.6 10.1 12 14.5l4.4-4.4', 'M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
  'edit': ['M4 20l1.2-4.2L16.6 4.4a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.2 18.8z', 'M14.5 6.5l3 3'],
  'history': ['M4.5 5.5v4h4', 'M4.9 9.5a8 8 0 1 1-1 5.5', 'M12 8v4.5l3 1.8'],
  'users': [{ tag: 'circle', cx: 9, cy: 8, r: 3.4 }, 'M3.5 19.5a5.5 5.5 0 0 1 11 0', 'M15.5 5.2a3.4 3.4 0 0 1 0 5.7', 'M17.5 14.5a5.5 5.5 0 0 1 3 5'],
  'film': [{ tag: 'rect', x: 3.5, y: 5, width: 17, height: 14, rx: 2 }, 'M8.2 5v14', 'M15.8 5v14', 'M3.5 9.7h4.7', 'M3.5 14.3h4.7', 'M15.8 9.7h4.7', 'M15.8 14.3h4.7'],
  'timeline': [{ tag: 'rect', x: 3.5, y: 5, width: 12, height: 4, rx: 1.4 }, { tag: 'rect', x: 8.5, y: 10.5, width: 12, height: 4, rx: 1.4 }, { tag: 'rect', x: 3.5, y: 16, width: 8, height: 4, rx: 1.4 }],
  // 工具轨
  'folder': ['M3.5 6.8A2.3 2.3 0 0 1 5.8 4.5h3.3a2.3 2.3 0 0 1 1.8.9l1.1 1.4a1.2 1.2 0 0 0 .9.4h5.3a2.3 2.3 0 0 1 2.3 2.3v7.8a2.3 2.3 0 0 1-2.3 2.3H5.8a2.3 2.3 0 0 1-2.3-2.3z'],
  'workflow': [{ tag: 'circle', cx: 6, cy: 6, r: 2.4 }, { tag: 'circle', cx: 18, cy: 6, r: 2.4 }, { tag: 'circle', cx: 12, cy: 18, r: 2.4 }, 'M8.4 6h7.2', 'M7 8.2l3.7 7.5', 'M17 8.2l-3.7 7.5'],
  'tasks': ['M9 6.5h11', 'M9 12h11', 'M9 17.5h11', 'M3.6 5.9l1.2 1.2 2-2.2', 'M3.6 11.4l1.2 1.2 2-2.2', 'M3.6 16.9l1.2 1.2 2-2.2'],
  // 底部胶囊条
  'undo': ['M8.5 13.5 4 9l4.5-4.5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  'redo': ['M15.5 13.5 20 9l-4.5-4.5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  'paste': [{ tag: 'rect', x: 5, y: 4.5, width: 14, height: 16, rx: 2 }, 'M9 4.5V3.6A1.6 1.6 0 0 1 10.6 2h2.8A1.6 1.6 0 0 1 15 3.6v.9', 'M9 11h6', 'M9 15h4'],
  'snap': ['M6.5 3.5V11a5.5 5.5 0 0 0 11 0V3.5', 'M6.5 3.5h4v4h-4z', 'M13.5 3.5h4v4h-4z'],
  'zoom-in': [{ tag: 'circle', cx: 11, cy: 11, r: 6.5 }, 'M11 8.5v5', 'M8.5 11h5', 'M20.5 20.5 16 16'],
  'zoom-out': [{ tag: 'circle', cx: 11, cy: 11, r: 6.5 }, 'M8.5 11h5', 'M20.5 20.5 16 16'],
  'fit': ['M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9', 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9', 'M20 15v3.5A1.5 1.5 0 0 1 18.5 20H15', 'M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15'],
  'map': [{ tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }, { tag: 'rect', x: 13.5, y: 12.5, width: 5, height: 4.5, rx: 1 }],
  'panel-left': [{ tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }, 'M9.5 4.5v15'],
  'panel-right': [{ tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }, 'M14.5 4.5v15'],
  // 选中操作条
  'copy': [{ tag: 'rect', x: 8.5, y: 8.5, width: 11.5, height: 11.5, rx: 2 }, 'M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3'],
  'duplicate': [{ tag: 'rect', x: 8, y: 8, width: 12, height: 12, rx: 2 }, 'M15.5 8V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5H8', 'M14 11.5v5', 'M11.5 14h5'],
  'trash': ['M4.5 6.5h15', 'M9 6V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V6', 'M6.6 6.5l.7 12.4a1.8 1.8 0 0 0 1.8 1.6h5.8a1.8 1.8 0 0 0 1.8-1.6l.7-12.4', 'M10 10.5v6', 'M14 10.5v6'],
  'group': ['M8.5 4H5.5A1.5 1.5 0 0 0 4 5.5v3', 'M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3', 'M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3', 'M4 15.5v3A1.5 1.5 0 0 0 5.5 20h3', { tag: 'rect', x: 9, y: 9, width: 6, height: 6, rx: 1.5 }],
  'ungroup': [{ tag: 'rect', x: 9, y: 9, width: 6, height: 6, rx: 1.5 }, 'M7.5 7.5 4 4', 'M16.5 7.5 20 4', 'M7.5 16.5 4 20', 'M16.5 16.5 20 20'],
  'lock': [{ tag: 'rect', x: 5.5, y: 10.5, width: 13, height: 10, rx: 2 }, 'M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3', 'M12 14.3v2.4'],
  'arrange': [{ tag: 'rect', x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.5 }, { tag: 'rect', x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1.5 }, { tag: 'rect', x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 }, { tag: 'rect', x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 1.5 }],
  // 空态 / 模板
  'video': [{ tag: 'rect', x: 3.5, y: 6, width: 17, height: 12, rx: 2.5 }, 'M10.2 9.3l4.8 2.7-4.8 2.7z'],
  'upload': ['M12 15V4.2', 'M7.4 8.6 12 4l4.6 4.6', 'M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
  'template': [{ tag: 'rect', x: 4, y: 4, width: 16, height: 16, rx: 2.5 }, 'M4 9.5h16', 'M9.5 9.5V20'],
  'image': [{ tag: 'rect', x: 4, y: 5, width: 16, height: 14, rx: 2 }, { tag: 'circle', cx: 9, cy: 10, r: 1.6 }, 'M4.5 16.5 9 12.5l2.7 2.7 3.6-3.7 4.2 4.2'],
};

export const iconNames = () => Object.keys(ICONS);

export function icon(name, size = 18) {
  if (typeof document?.createElementNS !== 'function') {
    const span = document.createElement('span');
    span.className = 'ic';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (typeof svg.classList?.add === 'function') svg.classList.add('ic');
  else svg.setAttribute('class', 'ic');
  for (const d of ICONS[name] ?? []) {
    if (typeof d === 'string') {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    } else if (d && d.tag) {
      const s = document.createElementNS(NS, d.tag);
      for (const [k, v] of Object.entries(d)) if (k !== 'tag') s.setAttribute(k, String(v));
      svg.append(s);
    }
  }
  return svg;
}

export function applyIcon(button, name, label) {
  if (!button || typeof button.append !== 'function' || !button.childNodes) return button;
  for (const s of qa(button, '.ic')) s.remove();   // 幂等：先清旧图标，包含无 SVG 的测试环境回退
  let labelEl = null;
  try { labelEl = button.querySelector?.('.ic-label') ?? null; } catch { labelEl = null; }
  // 可达名优先取显式 label → 既有 .ic-label → aria-label → 按钮文字 → title
  const labelText = String(label ?? labelEl?.textContent ?? button.getAttribute?.('aria-label')
    ?? button.textContent ?? button.getAttribute?.('title') ?? '').trim();
  if (!labelEl) {
    labelEl = document.createElement('span');
    labelEl.className = 'ic-label';
    for (const n of [...(button.childNodes ?? [])]) {
      const isOldIcon = n?.nodeType === 1 &&
        (n.tagName === 'svg' || n.tagName === 'SVG' || n.classList?.contains?.('ic'));
      if (!isOldIcon) labelEl.append(n);
    }
    if (!labelEl.childNodes.length && labelText) labelEl.textContent = labelText;
    button.append(labelEl);
  }
  const ic = icon(name);
  if (typeof button.prepend === 'function') button.prepend(ic);
  else button.append(ic);
  if (labelText) {
    if (!button.getAttribute?.('aria-label')) button.setAttribute('aria-label', labelText);
    if (!button.getAttribute?.('title')) button.setAttribute('title', labelText);
  }
  return button;
}
