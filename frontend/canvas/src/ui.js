// DOM 小工具：全部走外链脚本（父页 CSP 无 unsafe-inline）。

// 反射型布尔属性：真实浏览器中 attribute 与 IDL 属性互通（setAttribute('disabled','') → .disabled===true），
// 极简 DOM 桩不会自动反射——同时写属性与特性，两个世界语义一致。
const BOOL_PROPS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'multiple', 'autofocus', 'autoplay', 'controls', 'loop', 'muted', 'hidden']);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (BOOL_PROPS.has(k)) { node[k] = true; node.setAttribute(k, ''); }
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// 旧测试 DOM 桩可能没有 querySelectorAll：统一收口，缺 API 时退回空集而不是抛错
const qa = (root, sel) => (typeof root?.querySelectorAll === 'function' ? [...root.querySelectorAll(sel)] : []);

export function toast(message, type = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  const item = el('div', { class: `toast toast-${type}`, role: 'status', text: message });
  if (!root) return item;   // 根节点缺失（极端早期/测试环境）也不崩溃
  if (root.getAttribute?.('aria-live') !== 'polite') {
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('role', 'status');
  }
  root.append(item);
  setTimeout(() => item.remove(), ms);
  return item;
}

// 通用模态框：content 为 DOM；返回 close()。Esc / 点遮罩 / 右上角 × 关闭最上层弹窗；
// role=dialog + aria-modal + 打开初焦 + Tab 焦点圈禁 + 关闭还焦触发元素（UI-07）；
// 嵌套弹窗仅最上层响应按键。弹窗存在期间画布快捷键由 board 的 overlay 检测隔离（R06）；
// 焦点意外滞留弹窗外时 Enter/Space 一律拦截并收回——不得穿透激活背景的付费/破坏按钮。
export function modal(content, { wide = false, onClose } = {}) {
  const root = document.getElementById('overlay-root');
  const xBtn = el('button', { class: 'modal-x', type: 'button', 'aria-label': '关闭弹窗', title: '关闭（Esc）' });
  const box = el('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }, xBtn, content);
  const mask = el('div', { class: 'mask' }, box);
  const prevFocus = document.activeElement;
  let closed = false;
  const isTop = () => root.lastElementChild === mask;   // 嵌套时只响应最上层弹窗
  const SKIP_FOCUS_TYPES = new Set(['hidden', 'checkbox', 'radio', 'file', 'button', 'submit', 'range', 'color', 'image']);
  // 可见性判定：hidden 属性、type=hidden、[hidden]/[aria-hidden] 祖先、display:none、
  // visibility:hidden/collapse 一律不可聚焦；桩环境无 getComputedStyle 时退化为属性级判定
  const isShown = n => {
    if (n.hidden === true || n.getAttribute?.('hidden') != null) return false;
    if (String(n.getAttribute?.('type') ?? '').toLowerCase() === 'hidden') return false;
    if (n.closest?.('[hidden], [aria-hidden="true"]')) return false;
    if (typeof n.getClientRects === 'function' && !n.getClientRects().length) return false;
    const cs = globalThis.getComputedStyle?.(n);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
    return true;
  };
  const focusables = () => qa(box, 'button, input, select, textarea, a[href], [tabindex]')
    .filter(n => !n.disabled && n.getAttribute('tabindex') !== '-1' && isShown(n));
  // 合理初焦：首个文本类字段 → 首个非关闭钮的可交互元素 → 弹窗本体
  const initialFocus = () =>
    qa(box, 'input, textarea, select')
      .find(n => !n.disabled && isShown(n) && !SKIP_FOCUS_TYPES.has(String(n.getAttribute('type') ?? 'text').toLowerCase()))
    ?? focusables().find(n => n !== xBtn) ?? box;
  const onKey = e => {
    if (closed || !isTop()) return;
    if (e.isComposing) return;   // IME 组合输入中的按键属于输入法：Esc 只取消组合，不关整个弹窗
    if (e.key === 'Escape') {
      e.stopPropagation();                          // 弹窗打开时不让 Esc 穿透到画布
      close();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const items = focusables();
      if (!items.length) { box.focus?.(); return; }
      const i = items.indexOf(document.activeElement);
      if (e.shiftKey) items[i <= 0 ? items.length - 1 : i - 1].focus?.();
      else items[i === -1 || i === items.length - 1 ? 0 : i + 1].focus?.();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !mask.contains(e.target)) {
      e.preventDefault(); e.stopPropagation();
      try { initialFocus().focus?.(); } catch { /* 焦点回收失败不阻塞 */ }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    mask.remove();
    try {
      if (prevFocus && prevFocus !== document.body && document.body?.contains?.(prevFocus) !== false) prevFocus.focus?.();
    } catch { /* 触发元素已删等情况：还焦失败不阻塞关闭 */ }
    onClose?.();
  };
  xBtn.addEventListener('click', () => close());
  mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey, true);
  root.append(mask);
  const focusIn = () => { try { initialFocus().focus?.(); } catch { /* 初焦失败不阻塞弹窗 */ } };
  focusIn();
  setTimeout(() => {   // 内容为同步紧接填充（分镜/素材库 render()）时补一次初焦
    try { if (!closed && isTop() && (document.activeElement === box || !mask.contains(document.activeElement))) focusIn(); } catch { /* 尽力 */ }
  }, 0);
  return { close, box };
}

export function confirmDialog(title, body) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const yes = el('button', { class: 'primary', type: 'button', text: '确认' });
    const no = el('button', { type: 'button', text: '取消' });
    const { close } = modal(el('div', {},
      el('h3', { text: title }), el('div', { class: 'modal-body' }, body),
      el('div', { class: 'modal-actions' }, no, yes)), { onClose: () => finish(false) });
    yes.addEventListener('click', () => { finish(true); close(); });
    no.addEventListener('click', () => { finish(false); close(); });
  });
}

export const fmtBytes = n => n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
export const fmtTime = ts => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
export const fmtCountdown = ts => {
  const s = Math.max(0, Math.floor((ts * 1000 - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分${s % 60}秒`;
};

// 非模态定位弹层：右键菜单 / 搜索结果 / 小表单。直接挂在 overlay-root（计入 childElementCount，
// 弹层存在期间画布快捷键自动隔离）。Esc/点外部关闭最上层；close() 幂等。
export function popup(content, { x = 0, y = 0, onClose, maxHeight = 320 } = {}) {
  const root = document.getElementById('overlay-root');
  const box = el('div', { class: 'popup', style: `left:${x}px;top:${y}px;max-height:${maxHeight}px` }, content);
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    onClose?.(reason);
  };
  const onKey = e => {
    if (e.key !== 'Escape' || closed || e.isComposing) return;   // IME 组合输入中 Esc 不关闭弹层
    if (root.lastElementChild !== box) return;             // 只响应最上层弹层
    e.stopPropagation();
    close('escape');
  };
  const onDown = e => { if (!box.contains(e.target)) close('outside'); };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  root.append(box);
  // 出屏收拢：量到实际尺寸后再夹回视口（桩环境尺寸为 0 时保持原位）
  const w = box.offsetWidth || 0, h = box.offsetHeight || 0;
  const vw = globalThis.innerWidth ?? 0, vh = globalThis.innerHeight ?? 0;
  if (w && vw && x + w > vw - 8) box.style.left = Math.max(8, vw - w - 8) + 'px';
  if (h && vh && y + h > vh - 8) box.style.top = Math.max(8, vh - h - 8) + 'px';
  return { close, box };
}

// 菜单内容构造：items = [{label, hint?, danger?, disabled?, onPick} | {separator:true}]
export function menuList(items) {
  const list = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { list.append(el('div', { class: 'menu-sep' })); continue; }
    const b = el('button', { class: `menu-item${it.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', disabled: it.disabled === true },
      el('span', { class: 'menu-label', text: it.label }),
      it.hint ? el('span', { class: 'menu-hint', text: it.hint }) : null);
    b.addEventListener('click', () => it.onPick?.());
    list.append(b);
  }
  // 键盘导航：↑/↓ 在可用项间循环，Home/End 跳首尾；Enter/空格由按钮原生激活（UI-07）
  list.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const btns = qa(list, '.menu-item').filter(b => !b.disabled);
    if (!btns.length) return;
    e.preventDefault?.(); e.stopPropagation?.();
    const i = btns.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = btns[0];
    else if (e.key === 'End') next = btns[btns.length - 1];
    else if (i < 0) next = e.key === 'ArrowDown' ? btns[0] : btns[btns.length - 1];
    else next = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
    next.focus?.();
  });
  return list;
}

// 便捷弹菜单：在 (x,y) 弹出 items；onPick 后自动关闭
export function popupMenu(x, y, items, opts = {}) {
  const refs = popup(menuList(items.map(it => it && !it.separator ? { ...it, onPick: () => { refs?.close(); it.onPick?.(); } } : it)), { x, y, ...opts });
  // 上下文菜单语义：打开即聚焦首个可用项，↑/↓/Enter/Esc 全程键盘可达（UI-07）
  try { qa(refs.box, '.menu-item').find(b => !b.disabled)?.focus?.(); } catch { /* 聚焦失败不阻塞 */ }
  return refs;
}
