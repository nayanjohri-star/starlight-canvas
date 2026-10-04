// review 轮修复验收（node --test，无浏览器）：
//  · DIR-1 campath DSL fov 捕获组全指令生效（边界 10/120、越界 0/9/121/500、缺省放行）
//  · DIR-2 agent.setEditorState 写入前先过可序列化/5MiB/密钥字段/根类型闸；
//    原生插件以多行场景摘要字符串上送 → 规范为 {summary} 持久化，对象/null 旧契约不变，危险串照拒
//  · TL-1 剪掉片段立即 pause/disconnect/revoke/delete，不动共享素材文件
//  · TL-3 在途 load 遇 dispose/后续 load 不放回媒体、不建 AudioContext，闭包清理可验证
//  · TL-2 导出省略不烧「素材缺失」占位、保留底色与时间间隙；预览仍显示醒目占位
//  · TL-4 会话关闭/切项目后，进行中的拖动 pointerup 不写新项目、不造幽灵撤销步
//  · TL-5 媒体元素显式 preservesPitch（与服务端 atempo 保调一致）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createEditor } from '../src/editor.js';
import { studioState } from '../src/studio-schema.js';
import { loadLegacyDirectorSource } from './legacy-director-fixture.mjs';
import { parseCamPathDsl, CAMERA_PRESETS } from '../src/director-controls.js';
import { createTimelineEngine } from '../src/media-worker.js';
import { createTimeline } from '../src/timeline.js';
import { normalizeTimeline, TL_DEFAULT_META } from '../src/export-project.js';

// DIR-2 检查旧插件桥的安全契约，显式选择 legacy 分支；默认托管入口另有验收。
const { createDirectorHost, directorOrigin } = await loadLegacyDirectorSource();

// ---------- 极简 DOM / 媒体桩（与 upgrade-director.test.mjs 同构，扩展画布上下文与媒体元素） ----------
function fake2dCtx(rec) {
  return {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    shadowColor: '', shadowBlur: 0,
    save() {}, restore() {}, setLineDash() {}, strokeRect() {}, drawImage() {},
    fillRect() { rec?.fills?.push(this.fillStyle); },
    measureText() { return { width: 10 }; },
    fillText(t) { rec?.texts?.push(String(t)); },
  };
}
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parent = null; this.children = [];
    this._l = new Map(); this._attrs = new Map();
    this.dataset = {}; this.style = {}; this._cls = ''; this._text = '';
    this.value = ''; this.disabled = false; this.id = '';
    this.rect = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 };
  }
  get parentNode() { return this.parent; }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); }
  _hasCls(c) { return this._cls.split(/\s+/).includes(c); }
  get classList() {
    const self = this;
    return {
      add(...cs) { const s = new Set(self._cls.split(/\s+/).filter(Boolean)); for (const c of cs) s.add(c); self._cls = [...s].join(' '); },
      remove(...cs) { const s = new Set(self._cls.split(/\s+/).filter(Boolean)); for (const c of cs) s.delete(c); self._cls = [...s].join(' '); },
      contains(c) { return self._hasCls(c); },
      toggle(c, force) { const on = force === undefined ? !self._hasCls(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  addEventListener(t, fn, opt) { const l = this._l.get(t) ?? this._l.set(t, []).get(t); l.push({ fn, cap: opt === true || opt?.capture === true }); }
  removeEventListener(t, fn, opt) {
    const l = this._l.get(t); if (!l) return;
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
  prepend(...cs) { for (const c of cs.flat()) { if (c == null) continue; const n = c instanceof El ? c : Object.assign(new El('#text'), { _text: String(c) }); n.remove(); n.parent = this; this.children.unshift(n); } }
  replaceChildren(...cs) { for (const c of this.children) c.parent = null; this.children = []; this.append(...cs); }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  matches(sel) {
    sel = String(sel).trim();
    if (sel.includes(',')) return sel.split(',').some(s => this.matches(s));
    const am = sel.match(/^\[([^=\]]+)=["']?([^"'\]]*)["']?\]$/);
    if (am) return this._attrs.get(am[1]) === am[2];
    if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => c && this._hasCls(c));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n instanceof El && n.matches(sel)) return n; return null; }
  _desc(out = []) { for (const c of this.children) { out.push(c); c._desc(out); } return out; }
  querySelector(sel) { return this._desc().find(c => c.matches(sel)) ?? null; }
  querySelectorAll(sel) { return this._desc().filter(c => c.matches(sel)); }
  getBoundingClientRect() { return this.rect; }
  get clientWidth() { return this.rect.width; }
  get clientHeight() { return this.rect.height; }
  getContext() { return fake2dCtx(); }
  click() { for (const h of this._l.get('click') ?? []) h.fn({ stopPropagation() {}, preventDefault() {} }); }
  dispatch(type, props = {}) { for (const h of this._l.get(type) ?? []) h.fn({ type, target: this, ...props }); }
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
const DOC = mkTarget(), WIN = mkTarget();
const html = new El('html'), body = new El('body'), head = new El('head');
const overlay = new El('div'); overlay.id = 'overlay-root';
const toastRoot = new El('div'); toastRoot.id = 'toast-root';
html.append(head, body); body.append(overlay, toastRoot);

// 媒体元素桩：src 赋值后经 microtask 派发 loadeddata（并回调 onloadedmetadata，供 probeBlobAsset 使用）；
// 全局 __mediaGate 可挂起派发，验证在途加载取消语义。
const mediaEls = [];
function fakeMediaEl(tag) {
  const l = new Map();
  const elx = {
    tagName: String(tag).toUpperCase(),
    paused: true, readyState: 4, duration: 8,
    currentTime: 0, volume: 1, muted: false, playbackRate: 1,
    videoWidth: 320, videoHeight: 180, preload: '', playsInline: false,
    onloadedmetadata: null, onerror: null,
    addEventListener(t, fn) { (l.get(t) ?? l.set(t, []).get(t)).push(fn); },
    removeEventListener(t, fn) { const a = l.get(t); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    fire(t) { for (const f of [...(l.get(t) ?? [])]) f(); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() {}, removeAttribute() {}, setAttribute() {},
  };
  let _src = '';
  Object.defineProperty(elx, 'src', {
    get: () => _src,
    set: v => {
      _src = v;
      queueMicrotask(async () => {
        try { await globalThis.__mediaGate; } catch {}
        elx.onloadedmetadata?.();
        elx.fire('loadeddata');
      });
    },
  });
  mediaEls.push(elx);
  return elx;
}
Object.assign(DOC, {
  activeElement: null, body, head, documentElement: html,
  createElement: t => (t === 'video' || t === 'audio') ? fakeMediaEl(t) : new El(t),
  getElementById: id => ({ 'overlay-root': overlay, 'toast-root': toastRoot })[id] ?? null,
});
globalThis.document = DOC;
globalThis.window = WIN;
globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: '4178' };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
globalThis.__mediaGate = null;

let urlSeq = 0;
const createdUrls = [], revokedUrls = new Set();
URL.createObjectURL = () => { const u = `blob:mock-${++urlSeq}`; createdUrls.push(u); return u; };
URL.revokeObjectURL = u => { revokedUrls.add(u); };

globalThis.Image = class {
  constructor() { this.naturalWidth = 4; this.naturalHeight = 4; this._src = ''; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
};

const acState = { count: 0 };
globalThis.AudioContext = class {
  constructor() { acState.count++; this.destination = {}; this.currentTime = 0; }
  createGain() { return { gain: { value: 1 }, connect(x) { return x; }, disconnect() { this.disconnected = true; } }; }
  createMediaElementSource() { return { connect(x) { return x; }, disconnect() { this.disconnected = true; } }; }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] } }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};

const flush = () => new Promise(r => setTimeout(r, 0));
const vclip = (id, over = {}) => ({ id, kind: 'video', track: 'v1', assetId: 'va', start: 0, end: 4, in: 0, speed: 1, volume: 1, ...over });

test('浏览器导出：音频时钟批量推进不产生墙钟突发帧', async t => {
  let wallMs = 0;
  const frames = [];
  const track = { requestFrame() { frames.push(wallMs); }, stop() {} };
  class Stream {
    constructor(tracks = [track]) { this.tracks = tracks; }
    getVideoTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['recorded']) }); this.onstop(); }
  }
  const saved = Object.fromEntries(['HTMLCanvasElement', 'MediaStream', 'MediaRecorder'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  globalThis.HTMLCanvasElement = class { captureStream() {} };
  globalThis.MediaStream = Stream; globalThis.MediaRecorder = Recorder;
  t.mock.method(performance, 'now', () => wallMs);
  const create = DOC.createElement;
  t.mock.method(DOC, 'createElement', tag => {
    const el = create(tag);
    if (tag === 'canvas') el.captureStream = () => new Stream();
    return el;
  });
  const engine = createTimelineEngine({ blobOf: async () => null });
  t.after(() => engine.dispose());
  t.mock.method(globalThis, 'requestAnimationFrame', callback => {
    queueMicrotask(() => { wallMs += 12; engine.audioContext.currentTime += 0.032; callback(wallMs); });
    return 1;
  });
  const result = await engine.render({ clips: [{ id: 'title', kind: 'text', start: 0, end: 0.32, text: 'frame pacing' }], meta: { ...TL_DEFAULT_META, width: 320, height: 180, fps: 30 } });
  assert.ok(result.blob.size > 0);
  assert.ok(frames.length >= 3);
  assert.ok(frames.slice(1).every((time, i) => time - frames[i] >= 29), `音频时钟不能压缩出帧间隔：${frames.join(',')}`);
  assert.ok(Math.abs(wallMs - 320) <= 12, `导出时长必须遵循墙钟，不能随音频时钟跳动：${wallMs}ms`);
});

// ---------- DIR-1：fov 捕获组全指令真实生效 ----------
test('DIR-1：所有 DSL 指令 fov 校验生效（边界 10/120、越界 0/9/121/500、缺省逐指令覆盖）', () => {
  const wrap = lines => parseCamPathDsl('campath "t"\n  look at 0 1 0\n' + lines.join('\n'));
  // from 行
  for (const bad of [0, 9, 121, 500]) assert.throws(() => wrap([`from 0 1 4 fov ${bad}`, 'hold 1s']), /fov/, `from fov ${bad}`);
  for (const ok of [10, 45, 120]) assert.doesNotThrow(() => wrap([`from 0 1 4 fov ${ok}`, 'hold 1s']), `from fov ${ok}`);
  assert.doesNotThrow(() => wrap(['from 0 1 4', 'hold 1s']), 'from 缺省 fov');
  // 其余运镜段落逐指令覆盖
  const segs = [
    'move to 1 1 4 2s', 'dolly in 2 2s', 'dolly out 1 2s', 'truck left 1 2s', 'truck right 1 2s',
    'crane up 1 2s', 'crane down 1 2s', 'orbit left 90 2s', 'orbit right 180 3s rise 1 radius 2', 'hold 2s',
  ];
  for (const segLine of segs) {
    for (const bad of [0, 9, 121, 500])
      assert.throws(() => wrap(['from 0 1 4', `${segLine} fov ${bad}`]), /fov/, `${segLine} fov ${bad}`);
    for (const ok of [10, 120])
      assert.doesNotThrow(() => wrap(['from 0 1 4', `${segLine} fov ${ok}`]), `${segLine} fov ${ok}`);
    assert.doesNotThrow(() => wrap(['from 0 1 4', segLine]), `${segLine} 缺省 fov`);
  }
  // 合法真实 plugin DSL（全部机位预设）仍可解析，保留指令并规范化行首空白。
  for (const pr of CAMERA_PRESETS) {
    const p = parseCamPathDsl(pr.dsl);
    assert.equal(p.dsl, pr.dsl.split('\n').map(line => line.trim()).filter(Boolean).join('\n'), `预设 ${pr.id} 指令保持，空白按既有规则规范化`);
  }
});

// ---------- DIR-2：setEditorState 校验先于写入 ----------
test('DIR-2：agent.setEditorState——对象/null/摘要字符串合法；循环/BigInt/超5MiB/数字数组根/密钥内容一律拒绝且不覆盖旧值', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const assetsStub = { blobOf: async () => null, registerBlob: async () => { throw new Error('不可用'); }, objectURL: async () => null, assetOfNode: () => null, renderLibrary() {} };
  await store.newProject('A');
  const host = createDirectorHost({ store, storage, assets: assetsStub });
  t.after(() => { try { host.dispose(); } catch {} overlay.replaceChildren(); });
  const node = store.addNode('director', 0, 0, {});
  host.openEditor(node);
  const sess = host.sessionOf(node.id);
  sess.frame.contentWindow = { sent: [], postMessage(m, origin) { this.sent.push({ m, origin }); } };
  sess.frame.dispatch('load');
  const rpc = (state, id) => host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'rpc', id, method: 'agent.setEditorState', args: { state }, nonce: sess.nonce, nodeId: sess.nodeId } });
  const last = () => sess.win.sent.at(-1)?.m;

  rpc({ sel: ['c1'], cam: { x: 1 } }, 1); await flush();
  assert.equal(last().ok, true, '有效对象照常写入');
  assert.deepEqual(node.data.editorState, { sel: ['c1'], cam: { x: 1 } });

  const cyc = { a: 1 }; cyc.self = cyc;
  rpc(cyc, 2); await flush();
  assert.equal(last().ok, false, '循环引用必须拒绝');
  assert.match(last().error, /序列化/);
  assert.deepEqual(node.data.editorState, { sel: ['c1'], cam: { x: 1 } }, '拒绝不覆盖旧对象');

  rpc({ n: 1n }, 3); await flush();
  assert.equal(last().ok, false, 'BigInt 必须拒绝');
  assert.match(last().error, /序列化/);
  assert.deepEqual(node.data.editorState, { sel: ['c1'], cam: { x: 1 } }, '旧对象仍不覆盖');

  // 原生插件契约：hub.agent.setEditorState(c0(scene,selectedIds)) 上送 AI 编辑器上下文摘要——
  // 「3D Director Stage scene:」开头的多行字符串（场景对象另经 storage.set('composition') 持久化）。
  // 宿主规范为 {summary: 原文} 落盘：合法摘要的持久化字段形状必须精确。
  const summary = [
    '3D Director Stage scene:',
    'characters: hero@(1,0,0) extra@(-2,0,1)',
    'props: chair x2, table',
    'cameras: main fov45',
    'selectedIds: c1,c2',
    'timeline: 2 tracks, 4 clips',
  ].join('\n');
  rpc(summary, 4); await flush();
  assert.equal(last().ok, true, '原生多行摘要字符串是合法 editorState');
  assert.deepEqual(node.data.editorState, { summary }, '摘要字符串规范为 {summary} 持久化，逐行原文不丢');
  rpc('note: 这一帧需要重拍', 5); await flush();
  assert.equal(last().ok, true, '无前缀的合理摘要字符串同样合法——契约成立而非按前缀放行');
  assert.deepEqual(node.data.editorState, { summary: 'note: 这一帧需要重拍' });
  rpc(summary, 6); await flush();
  assert.equal(last().ok, true);
  assert.deepEqual(node.data.editorState, { summary });

  rpc({ pad: 'x'.repeat(5 * 1024 * 1024 + 16) }, 7); await flush();
  assert.equal(last().ok, false, '超 5MiB 必须拒绝');
  assert.match(last().error, /5MiB|上限/);
  rpc('p'.repeat(5 * 1024 * 1024 + 16), 8); await flush();
  assert.equal(last().ok, false, '超 5MiB 摘要字符串同样拒绝');
  assert.match(last().error, /5MiB|上限/);
  assert.deepEqual(node.data.editorState, { summary }, '超限拒绝不覆盖旧值');
  rpc('场'.repeat(2 * 1024 * 1024), 81); await flush();
  assert.equal(last().ok, false, '中文摘要按 UTF-8 字节大小限制');
  assert.deepEqual(node.data.editorState, { summary });

  for (const [id, root] of [[9, 42], [10, [1, 2]], [11, true]]) {
    rpc(root, id); await flush();
    assert.equal(last().ok, false, `无效根必须拒绝：${JSON.stringify(root)?.slice(0, 20)}`);
  }
  assert.deepEqual(node.data.editorState, { summary }, '数字/数组/布尔根仍拒绝且不覆盖');

  rpc({ apiKey: 'sk-live' }, 12); await flush();
  assert.equal(last().ok, false, '疑似密钥字段必须拒绝');
  assert.match(last().error, /密钥/);
  rpc(`3D Director Stage scene:\nnote: api_key=sk-${'a1'.repeat(24)}`, 13); await flush();
  assert.equal(last().ok, false, '含秘密样式的摘要字符串同样拒绝——危险串不放行');
  assert.match(last().error, /密钥/);
  assert.deepEqual(node.data.editorState, { summary }, '危险字符串不覆盖旧值');
  await store.flush();
  assert.deepEqual((await storage.get(`project:${store.project.id}`)).nodes.find(n => n.id === node.id).data.editorState, { summary }, '规范化摘要实际持久化到项目');

  rpc(null, 14); await flush();
  assert.equal(last().ok, true, 'null 合法清除');
  assert.equal(node.data.editorState, null);
  rpc('   ', 15); await flush();
  assert.equal(last().ok, true, '空白摘要按清除处理');
  assert.equal(node.data.editorState, null);
});

// ---------- TL-1：剪掉片段立即回收 ----------
test('TL-1：剪掉片段立即 pause/disconnect/revoke/delete；保留片段与共享素材文件不受影响', async () => {
  const engine = createTimelineEngine({ blobOf: async () => new Blob([1, 2, 3], { type: 'video/mp4' }) });
  const v = vclip('c-v');
  const a = { id: 'c-a', kind: 'audio', track: 'a1', assetId: 'au', start: 0, end: 4, in: 0, speed: 1, volume: 1 };
  const im = { id: 'c-i', kind: 'image', track: 'ov1', assetId: 'im', start: 0, end: 2 };
  const mark = createdUrls.length;
  await engine.load([v, a, im]);
  const recA = engine.mediaOf('c-a'), recI = engine.mediaOf('c-i');
  assert.ok(recA?.el && recI?.img, '音频/图片记录已就绪');
  const elA = recA.el, urlA = recA.url, urlI = recI.url, gainA = recA.gain, srcA = recA.src;
  assert.ok(urlA && urlI, '两条记录各有独立 blob URL');
  elA.paused = false;   // 模拟播放中删除
  await engine.load([v]);   // 剪掉音频与图片片段
  assert.equal(engine.mediaOf('c-a'), undefined, '剪掉片段的记录已从清单删除');
  assert.equal(engine.mediaOf('c-i'), undefined);
  assert.equal(elA.paused, true, '剪掉片段立即停播');
  assert.equal(srcA.disconnected, true, 'WebAudio 源已断开');
  assert.equal(gainA.disconnected, true, '增益节点已断开');
  assert.ok(revokedUrls.has(urlA) && revokedUrls.has(urlI), '被剪片段 blob URL 已回收');
  assert.ok(engine.mediaOf('c-v')?.el, '保留片段不受影响');
  assert.ok(!revokedUrls.has(engine.mediaOf('c-v').url), '保留片段 URL 未被误回收');
  engine.dispose();
  assert.ok(createdUrls.slice(mark).every(u => revokedUrls.has(u)), 'dispose 后无残留 URL');
});

// ---------- TL-3：在途 load 的取消正确性 ----------
test('TL-3：在途 load 遇 dispose/后续 load 不放回媒体、不建 AudioContext，闭包清理可验证', async () => {
  // A) load 进行中 dispose → 落地即回收
  let release1;
  globalThis.__mediaGate = new Promise(r => { release1 = r; });
  const engine = createTimelineEngine({ blobOf: async () => new Blob([1], { type: 'video/mp4' }) });
  const v = vclip('c-v');
  const markA = createdUrls.length;
  const p = engine.load([v]);
  await flush();   // 推进到解码等待（gate 挂起）
  const acBefore = acState.count;
  engine.dispose();
  release1();
  await p;
  assert.equal(engine.mediaOf('c-v'), undefined, 'dispose 后在途加载不得放回媒体');
  assert.equal(acState.count, acBefore, 'dispose 后不得新建 AudioContext');
  assert.equal(engine.audioContext, null);
  assert.ok(createdUrls.slice(markA).every(u => revokedUrls.has(u)), '在途创建的 URL 全部回收');
  await engine.load([v]);   // disposed 引擎拒收后续 load
  assert.equal(engine.mediaOf('c-v'), undefined);

  // B) 旧 load 被新 load 取代 → 剪掉片段不得由旧 load 放回
  let release2;
  globalThis.__mediaGate = new Promise(r => { release2 = r; });
  const eng2 = createTimelineEngine({ blobOf: async () => new Blob([1], { type: 'video/mp4' }) });
  const markB = createdUrls.length;
  const p1 = eng2.load([v]);
  await flush();
  await eng2.load([]);   // 新 load 剪掉片段
  release2();
  await p1;
  assert.equal(eng2.mediaOf('c-v'), undefined, '被剪掉的片段不得由旧 load 放回');
  assert.ok(createdUrls.slice(markB).every(u => revokedUrls.has(u)), '取代 load 的资源已回收');
  eng2.dispose();
  globalThis.__mediaGate = null;
});

// ---------- TL-2：导出省略语义与预览占位分离 ----------
test('TL-2：导出省略模式不烧「素材缺失」占位、保留底色；预览仍显示醒目占位', async () => {
  const engine = createTimelineEngine({ blobOf: async () => null });
  const missing = { id: 'm1', kind: 'video', track: 'v1', assetId: 'lost', start: 0, end: 2, in: 0, speed: 1, missing: true };
  await engine.load([missing]);   // missing → 不建记录
  const meta = { ...TL_DEFAULT_META, width: 320, height: 180, background: '#112233' };
  const rec = { texts: [], fills: [] };
  const g = fake2dCtx(rec);
  engine.draw(g, 1, [missing], meta);
  assert.ok(rec.texts.includes('素材缺失'), '预览应保留醒目占位');
  rec.texts.length = 0; rec.fills.length = 0;
  engine.draw(g, 1, [missing], meta, { omitMissingMedia: true });
  assert.ok(!rec.texts.some(t => /素材缺失|加载中/.test(t)), '导出省略不得把占位文字烧进成片');
  assert.deepEqual(rec.fills, ['#112233'], '省略时段露出用户设定底色（时间间隙由 duration 保留）');
  engine.dispose();
});

// ---------- TL-4：拖动回调跨项目守卫 ----------
test('TL-4：会话关闭/切项目后，进行中的拖动 pointerup 不写新项目、不造幽灵撤销步', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('A');
  store.project.assets['lost'] = { id: 'lost', name: 'G.mp4', kind: 'video', mime: 'video/mp4', size: 1, addedAt: 1, missing: true };
  const editor = createEditor(store);
  let checkpoints = 0, touches = 0;
  const origCp = editor.checkpoint?.bind(editor);
  if (origCp) editor.checkpoint = () => { checkpoints++; return origCp(); };
  const origTouch = store.touch.bind(store);
  store.touch = r => { touches++; return origTouch(r); };
  studioState(store.project).timeline = normalizeTimeline(
    [{ assetId: 'lost', start: 0, end: 5, kind: 'video', track: 'v1' }], { assets: store.project.assets }).clips;
  const tl = createTimeline({ store, storage, editor });
  const handle = tl.open();
  t.after(() => { try { handle?.close(); } catch {} overlay.replaceChildren(); });
  assert.ok(handle, '时间线会话已打开');
  const clipEl = overlay._desc().find(n => n._hasCls?.('tl-clip'));
  assert.ok(clipEl, '缺失素材片段仍渲染为可拖动块');
  const cpBefore = checkpoints, touchBefore = touches;
  clipEl.dispatch('pointerdown', { clientX: 100, target: clipEl, stopPropagation() {}, preventDefault() {} });
  const ups = [...(WIN._l.get('pointerup') ?? [])];
  const moves = [...(WIN._l.get('pointermove') ?? [])];
  assert.ok(ups.length && moves.length, '拖动已挂 window 监听');
  moves.forEach(h => h.fn({ clientX: 300 }));
  await store.newProject('B');   // 拖住不放切项目 → disposeSession 回收监听
  assert.equal(store.project.name, 'B');
  assert.equal(WIN._l.get('pointerup')?.length ?? 0, 0, '会话关闭已回收 pointerup');
  assert.equal(WIN._l.get('pointermove')?.length ?? 0, 0, '会话关闭已回收 pointermove');
  ups.forEach(h => h.fn({}));    // 残留的已派发回调不得落地
  assert.equal(checkpoints, cpBefore, '不得给新项目推入撤销步');
  assert.equal(touches, touchBefore, '不得给新项目标脏/触发保存');
  assert.equal(studioState(store.project).timeline?.length ?? 0, 0, '新项目时间线未被写');
});

// ---------- TL-5：preservesPitch 显式声明 ----------
test('TL-5：媒体元素显式 preservesPitch=true，与服务端 atempo 保调语义一致', async () => {
  const engine = createTimelineEngine({ blobOf: async () => new Blob([1], { type: 'video/mp4' }) });
  const v = vclip('c-v', { speed: 2 });
  await engine.load([v]);
  const el = engine.mediaOf('c-v').el;
  assert.equal(el.preservesPitch, true, '变速播放不变调（显式声明）');
  engine.sync?.(1, [v], true);
  assert.equal(el.preservesPitch, true, 'sync 不清除保调标记');
  engine.dispose();
});
