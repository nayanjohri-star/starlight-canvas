// R05 验收用极简 DOM 桩（与 task-panel-incremental 同口径）：只实现任务中心行构建与 toast 用到的 API。
// 调用方须先 import 被测模块（此时无 document，main.js 的 boot() 守卫跳过启动），再 installDom()。
export class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parent = null; this.children = [];
    this._l = new Map(); this._attrs = new Map();
    this._cls = ''; this._text = '';
    this.disabled = false; this.id = ''; this.value = '';
    this.dataset = {}; this.style = {};
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); }
  get classList() {
    const s = this;
    return {
      add(...cs) { s._cls = [...new Set([...s._cls.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
      remove(...cs) { const d = new Set(cs); s._cls = s._cls.split(/\s+/).filter(c => c && !d.has(c)).join(' '); },
      contains(c) { return s._cls.split(/\s+/).includes(c); },
      toggle(c, on) { if (on ?? !this.contains(c)) this.add(c); else this.remove(c); },
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  hasAttribute(k) { return this._attrs.has(k); }
  removeAttribute(k) { this._attrs.delete(k); }
  addEventListener(t, fn) { const l = this._l.get(t) ?? this._l.set(t, []).get(t); l.push(fn); }
  removeEventListener() {}
  click() { for (const fn of [...(this._l.get('click') ?? [])]) fn({ type: 'click', target: this }); }
  append(...cs) {
    for (const c of cs.flat()) {
      if (c == null) continue;
      const n = c instanceof El ? c : Object.assign(new El('#text'), { _text: String(c) });
      n.remove(); n.parent = this; this.children.push(n);
    }
  }
  prepend(...cs) { const old = this.children; this.children = []; this.append(...cs); for (const c of old) { c.parent = this; this.children.push(c); } }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  replaceChildren(...cs) { for (const c of this.children) c.parent = null; this.children = []; this.append(...cs); }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected() { let p = this; while (p.parent) p = p.parent; return p === DOC.body || p === DOC._root; }
  contains(n) { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  focus() { DOC.activeElement = this; }
  _desc(out = []) { for (const c of this.children) { out.push(c); c._desc(out); } return out; }
}
export const DOC = {
  _byId: new Map(), _root: new El('html'),
  activeElement: null,
  body: new El('body'),
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t),
  getElementById(id) { return this._byId.get(id) ?? null; },
  addEventListener() {}, removeEventListener() {},
};
DOC._byId.set('overlay-root', new El('div'));
DOC._byId.set('toast-root', new El('div'));
export function installDom() { globalThis.document = DOC; return DOC; }
export const toasts = () => DOC._byId.get('toast-root')._desc().map(n => n._text).filter(Boolean);
export const btnOf = (item, text) => item._desc().find(b => b.tagName === 'BUTTON' && b.textContent === text);
export const buttons = item => item._desc().filter(b => b.tagName === 'BUTTON').map(b => b.textContent);
export const badgeOf = item => item._desc().find(b => b.classList.contains('badge'));
