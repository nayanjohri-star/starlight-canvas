// 显式旧插件 source fixture 的宿主桥升级回归（node --test，无浏览器）：
// 极简 DOM 桩驱动 director.js / director-controls.js 的真实代码路径。
// 覆盖：同节点双开防护、Esc/关闭清理（waiter 全拒）、项目切换与节点删除终结会话、
//       素材选择器随会话关闭不泄漏、RPC nonce/nodeId/origin 校验、导出素材类型与
//       30MiB/100MiB 上限、TypedArray 子区间字节、关闭中/跨项目悬挂 RPC 零泄漏、
//       storage.set 可恢复性闸（未托管 blob:/死 xp-asset 引用拒写）、场景摘要与机位预设契约。
// 每个用例经 mkHost 的 t.after 兜底 dispose + 清空 overlay——单测失败不向后续用例级联。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore, uid } from '../src/store.js';
import { loadLegacyDirectorSource } from './legacy-director-fixture.mjs';
const { createDirectorHost, directorBody, directorOrigin, toBlob } = await loadLegacyDirectorSource();
import { createDirectorControls, summarizeComposition, readSceneInfo, parseCamPathDsl, extractCamPathDsl, CAMERA_PRESETS, DIRECTOR_UNSUPPORTED } from '../src/director-controls.js';

// ---------- 极简 DOM 桩（与 ui-safety-fixes.test.mjs 同构，只实现被测路径用到的 API）----------
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
    if (sel.startsWith('.')) return this._hasCls(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n instanceof El && n.matches(sel)) return n; return null; }
  _desc(out = []) { for (const c of this.children) { out.push(c); c._desc(out); } return out; }
  querySelector(sel) { return this._desc().find(c => c.matches(sel)) ?? null; }
  querySelectorAll(sel) { return this._desc().filter(c => c.matches(sel)); }
  getBoundingClientRect() { return this.rect; }
  get clientWidth() { return this.rect.width; }
  get clientHeight() { return this.rect.height; }
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
const html = new El('html'), body = new El('body');
const overlay = new El('div'); overlay.id = 'overlay-root';
const toastRoot = new El('div'); toastRoot.id = 'toast-root';
html.append(body); body.append(overlay, toastRoot);
Object.assign(DOC, {
  activeElement: null, body, documentElement: html,
  createElement: t => new El(t),
  getElementById: id => ({ 'overlay-root': overlay, 'toast-root': toastRoot })[id] ?? null,
});
globalThis.document = DOC;
globalThis.window = WIN;
globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: '4178' };
const flush = () => new Promise(r => setTimeout(r, 0));

// 事件派发：capture 监听从 DOC/WIN 向下，冒泡从 target 向上（驱动 modal 的 Esc）
function fire(target, type, props = {}) {
  const path = [];
  for (let n = target; n; n = n.parent) path.push(n);
  path.push(DOC, WIN);
  const e = { type, target, defaultPrevented: false, _stop: false, stopPropagation() { this._stop = true; }, preventDefault() { this.defaultPrevented = true; }, ...props };
  for (let i = path.length - 1; i >= 0 && !e._stop; i--) for (const h of path[i]._l?.get(type) ?? []) if (h.cap) h.fn(e);
  for (let i = 0; i < path.length && !e._stop; i++) for (const h of path[i]._l?.get(type) ?? []) if (!h.cap) h.fn(e);
  return e;
}

// ---------- 依赖桩 ----------
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
function freshDeps() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const assets = {
    // 与 createAssets 同一存储语义：字节走全局 blob:<id>，元数据绑定调用开始时的项目对象；
    // blobOf 读同一 storage（旧桩读私有 Map 而 registerBlob 写 storage，永远读不到 → 假双已修）
    blobOf: id => storage.getBlob(`blob:${id}`),
    registerBlob: async (blob, name, kind, extra = {}) => {
      const project = store.project;
      const rec = { id: uid('a'), name, kind, mime: blob.type || 'application/octet-stream', size: blob.size, addedAt: Date.now(), ...extra };
      await storage.setBlob(`blob:${rec.id}`, blob);
      if (store.project !== project) throw new Error('项目已切换，素材未入库');
      project.assets[rec.id] = rec; store.touch();
      return rec;
    },
    objectURL: async () => null,
    assetOfNode: n => (n?.type === 'asset' && n.data.assetId ? store.project.assets[n.data.assetId] ?? null : null),
    renderLibrary() {},
  };
  return { storage, store, assets };
}
// 每个用例统一入口：建项目 + 建宿主 + t.after 兜底清理（dispose + 清空 overlay）。
// 单测中途失败也不会把会话/iframe/弹窗泄漏给后续用例。
async function mkHost(t, projectName = 'A') {
  const deps = freshDeps();
  await deps.store.newProject(projectName);
  const host = createDirectorHost(deps);
  t.after(() => { try { host.dispose(); } catch { /* 已清理 */ } overlay.replaceChildren(); });
  return { ...deps, host };
}
// 模拟 iframe 侧窗口：收集父页 postMessage
function fakeWin() { return { sent: [], postMessage(m, origin) { this.sent.push({ m, origin }); } }; }
function bindWin(host, node) {
  const sess = host.sessionOf(node.id);
  sess.frame.contentWindow = fakeWin();
  sess.frame.dispatch('load');
  return sess;
}
const rpc = (host, sess, method, args = {}, extra = {}) =>
  host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'rpc', id: extra.id ?? 1, method, args, nonce: sess.nonce, nodeId: sess.nodeId } });
const lastRes = sess => sess.win.sent.at(-1)?.m;

test('toBlob：TypedArray 视图只取自身子区间，不带上整个底层缓冲', async () => {
  const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 4, 8, 8, 8]);
  const view = backing.subarray(3, 7);
  const blob = toBlob(view, 'image/png');
  assert.equal(blob.size, 4, '视图范围字节数');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(toBlob('https://x/evil.png'), null, '字符串 URL 一律拒绝');
});

test('打开/双开防护/hello→init/会话身份', async t => {
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  const s1 = host.openEditor(node);
  assert.ok(s1, '首次打开建立会话');
  assert.equal(host.isOpen(node.id), true);
  const s2 = host.openEditor(node);
  assert.equal(s2, s1, '同节点重复打开复用同一会话');
  assert.equal(overlay.querySelectorAll('iframe').length, 1, '不叠加第二个 iframe');

  const sess = bindWin(host, node);
  assert.match(sess.frame.getAttribute('src'), /^http:\/\/localhost:4178\/director\/index\.html\?node=/, 'iframe 走隔离源');
  // hello → init
  host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'hello', nonce: sess.nonce, nodeId: sess.nodeId } });
  const init = sess.win.sent.find(x => x.m.kind === 'init');
  assert.ok(init && init.origin === directorOrigin(), 'init 发向导演台源');
  assert.equal(init.m.nonce, sess.nonce);
  assert.ok(init.m.payload.unsupported.includes('vcam'), 'init 明示未接入能力');
  // 错 nonce 的 RPC 静默丢弃
  host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'rpc', id: 9, method: 'ui.notify', args: { message: 'x' }, nonce: 'forged', nodeId: sess.nodeId } });
  await flush();
  assert.ok(!sess.win.sent.some(x => x.m.id === 9), '伪造 nonce 不得获得应答');
  // 错 origin 一律丢弃
  host.onMessage({ origin: 'http://evil.example', source: sess.win, data: { ns: 'xp-hub', kind: 'rpc', id: 10, method: 'ui.notify', args: {}, nonce: sess.nonce, nodeId: sess.nodeId } });
  await flush();
  assert.ok(!sess.win.sent.some(x => x.m.id === 10), '异源消息不得获得应答');
  host.dispose();
});

test('导出图片 RPC：真实字节入素材库 + 素材节点 + fromDirector 绑定', async t => {
  const { store, assets, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  rpc(host, sess, 'canvas.insertImageNode', { name: '机位A.png', mime: 'image/png', bytes: new Uint8Array(PNG).buffer });
  await flush(); await flush();
  const res = lastRes(sess);
  assert.equal(res?.kind, 'rpc-res');
  assert.equal(res.ok, true, JSON.stringify(res));
  const assetId = res.result.assetId;
  const rec = store.project.assets[assetId];
  assert.ok(rec, '素材已登记');
  assert.equal(rec.kind, 'image');
  assert.equal(rec.fromDirector, node.id, 'fromDirector 绑定来源节点');
  const assetNode = store.project.nodes.find(n => n.type === 'asset' && n.data.assetId === assetId);
  assert.ok(assetNode, '画布生成素材节点');
  assert.equal(assetNode.data.title, '机位A.png', '节点带导出标题');
  const blob = await assets.blobOf(assetId);
  assert.ok(blob, 'blobOf 读同一 storage 应命中');
  assert.equal(blob.size, PNG.length, '素材库字节完整');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], PNG, '素材库字节逐位一致');
  host.dispose();
});

test('导出大小上限：图片 >30MiB 拒绝，文件 >100MiB 拒绝', async t => {
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  const big = new ArrayBuffer(31 * 1024 * 1024);
  rpc(host, sess, 'canvas.insertImageNode', { name: 'big.png', mime: 'image/png', bytes: big });
  await flush();
  assert.equal(lastRes(sess).ok, false, '超限图片被拒绝');
  assert.match(lastRes(sess).error, /30MiB/);
  assert.equal(Object.keys(store.project.assets).length, 0, '未入库');
  host.dispose();
});

test('storage KV 按 dir:<nodeId> 命名空间；非法键与超大值拒绝', async t => {
  const { store, storage, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  rpc(host, sess, 'storage.set', { key: 'composition', value: { cameras: [{ id: 'c1' }] } });
  await flush();
  assert.equal(lastRes(sess).ok, true);
  assert.deepEqual(await storage.get(`dir:${node.id}:composition`), { cameras: [{ id: 'c1' }] });
  rpc(host, sess, 'storage.set', { key: '', value: 1 }, { id: 2 });
  await flush();
  assert.equal(lastRes(sess).ok, false, '空键拒绝');
  host.dispose();
});

test('storage.set 可恢复性闸：未托管 blob: 与死 xp-asset 引用拒写且不覆盖旧档', async t => {
  const { store, storage, assets, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  rpc(host, sess, 'storage.set', { key: 'composition', value: { cameras: [{ id: 'c1' }] } });
  await flush();
  assert.equal(lastRes(sess).ok, true, '上一份可恢复存档');
  // 字面 blob: 引用 → 拒绝且旧档完好
  rpc(host, sess, 'storage.set', { key: 'composition', value: { scene: 'blob:http://localhost:4178/dead' } }, { id: 2 });
  await flush();
  assert.equal(lastRes(sess).ok, false, '未托管 blob 引用必须拒绝');
  assert.match(lastRes(sess).error, /blob|托管/);
  assert.deepEqual(await storage.get(`dir:${node.id}:composition`), { cameras: [{ id: 'c1' }] }, '上一份可恢复存档未被覆盖');
  // 指向不存在素材的 xp-asset 令牌 → 拒绝
  rpc(host, sess, 'storage.set', { key: 'composition', value: { scene: 'xp-asset://a_nope' } }, { id: 3 });
  await flush();
  assert.equal(lastRes(sess).ok, false, '死 xp-asset 令牌必须拒绝');
  assert.match(lastRes(sess).error, /素材|不可用/);
  // 指向本项目真实素材的 xp-asset 令牌 → 允许
  const rec = await assets.registerBlob(new Blob([new Uint8Array(PNG)], { type: 'image/png' }), '贴图.png', 'image');
  rpc(host, sess, 'storage.set', { key: 'composition', value: { tex: `xp-asset://${rec.id}` } }, { id: 4 });
  await flush();
  assert.equal(lastRes(sess).ok, true, '真实素材令牌可保存');
  assert.deepEqual(await storage.get(`dir:${node.id}:composition`), { tex: `xp-asset://${rec.id}` });
  host.dispose();
});

test('项目切换：会话终结、悬挂 invoke 被拒、在途 RPC 不写新项目', async t => {
  const { store, storage, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  const win = sess.win;
  // 悬挂 invoke
  const pending = host.invokeAgent(node.id, { method: 'scene.get', args: {} });
  const assertion = assert.rejects(pending, /已关闭|已切换/);
  // 慢速 IDB 写：延迟打在 registerBlob 内部真实的 storage.setBlob await 上——
  // registerBlob 已捕获旧项目对象，写盘落定后才做同项目校验（与生产路径一致）
  let release;
  const slow = new Promise(r => { release = r; });
  const origSetBlob = storage.setBlob.bind(storage);
  storage.setBlob = async (...a) => { await slow; return origSetBlob(...a); };
  rpc(host, sess, 'canvas.insertImageNode', { name: 'late.png', mime: 'image/png', bytes: new Uint8Array(PNG).buffer }, { id: 7 });
  await store.newProject('B');
  assert.equal(host.isOpen(node.id), false, '切项目即关会话');
  assert.equal(overlay.querySelectorAll('iframe').length, 0, 'iframe 已摘除');
  release();
  await flush(); await flush();
  assert.equal(Object.keys(store.project.assets).length, 0, '在途导出不得落进新项目');
  assert.equal(store.project.nodes.length, 0, '新项目无残留节点');
  assert.ok(!win.sent.some(x => x.m.id === 7), '在途 RPC 不得收到伪造成功应答');
  await assertion;
  host.dispose();
});

test('素材选择器随会话清理关闭：切项目不残留弹窗、不应答悬挂 RPC', async t => {
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  const win = sess.win;
  rpc(host, sess, 'canvas.pickAsset', { type: 'image', multiple: false }, { id: 11 });
  await flush();
  assert.ok(overlay.textContent.includes('选择素材'), '选择器弹窗已打开');
  assert.equal(overlay.querySelectorAll('.mask').length, 2, '导演台弹窗 + 选择器弹窗共两层');
  await store.newProject('B');
  await flush();
  assert.equal(overlay.querySelectorAll('.mask').length, 0, '两层弹窗均随会话关闭');
  assert.equal(overlay.querySelectorAll('iframe').length, 0, 'iframe 已摘除');
  assert.ok(!win.sent.some(x => x.m.id === 11), '悬挂 pickAsset 不得应答');
  host.dispose();
});

test('Esc 关闭走同一 cleanup：waiter 拒绝、会话移除、iframe 摘除', async t => {
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  const previousWindow = sess.win;
  const pending = host.invokeAgent(node.id, { method: 'scene.get', args: {} });
  const assertion = assert.rejects(pending, /已关闭/);
  fire(body, 'keydown', { key: 'Escape' });
  assert.equal(host.isOpen(node.id), false);
  assert.equal(overlay.querySelectorAll('iframe').length, 0);
  await assertion;
  // 会话死后消息一律忽略
  host.onMessage({ origin: directorOrigin(), source: previousWindow, data: { ns: 'xp-hub', kind: 'rpc', id: 3, method: 'storage.get', args: { key: 'x' }, nonce: sess.nonce, nodeId: sess.nodeId } });
  await flush();
  assert.ok(!previousWindow.sent.some(x => x.m.id === 3), '已关闭会话不再应答');
  host.dispose();
});

test('节点删除终结会话；agent.setEditorState 只写本项目导演台节点', async t => {
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  rpc(host, sess, 'agent.setEditorState', { state: { sel: ['c1'] } });
  await flush();
  assert.equal(lastRes(sess).ok, true);
  assert.deepEqual(store.node(node.id).data.editorState, { sel: ['c1'] });
  store.removeNode(node.id);
  assert.equal(host.isOpen(node.id), false, '删除节点即关会话');
  host.dispose();
});

test('directorBody：打开按钮真实接线；场景摘要随存储显示', async t => {
  const { store, storage, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  const elBody = directorBody(node, { host, storage });
  const btn = elBody.querySelector('button');
  assert.equal(btn.textContent, '打开导演台');
  btn.click();
  assert.ok(host.isOpen(node.id), '点击后导演台打开');
  host.dispose();
});

test('summarizeComposition / readSceneInfo：防御性计数', async () => {
  const s = summarizeComposition({
    characters: [{ id: 'a' }, { id: 'b' }], props: [{ id: 'p' }], cameras: [{ id: 'c', label: '正面' }],
    camPaths: [{ id: 'k', label: '推近' }], camTimeline: { tracks: [{ clips: [{ id: 1 }, { id: 2 }] }] },
  });
  assert.equal(s.counts.characters, 2);
  assert.equal(s.counts.cameras, 1);
  assert.equal(s.counts.clips, 2);
  assert.deepEqual(s.camPaths, ['推近']);
  assert.equal(summarizeComposition(null), null);
  const { storage } = freshDeps();
  assert.equal((await readSceneInfo(storage, 'n_x')).saved, false, '无记录诚实返回未保存');
  await storage.set('dir:n_y:composition', { cameras: [{ id: 'c' }] });
  const info = await readSceneInfo(storage, 'n_y');
  assert.equal(info.saved, true);
  assert.equal(info.counts.cameras, 1);
});

test('机位预设：经 scene.edit 发 set_campath DSL；失败原样上抛', async t => {
  const { store, storage, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  host.openEditor(node);
  const sess = bindWin(host, node);
  const controls = createDirectorControls({ store, storage, host });
  const apply = controls.applyCameraPreset(node.id, 'dolly_in');
  await flush();
  const inv = sess.win.sent.find(x => x.m.kind === 'invoke');
  assert.ok(inv, 'invoke 发到插件');
  assert.equal(inv.m.method, 'scene.edit');
  const op = inv.m.args.operations[0];
  assert.equal(op.type, 'set_campath');
  assert.match(op.dsl, /^campath "缓推近"/);
  assert.match(op.dsl, /dolly in 3 4s/);
  host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'invoke-res', id: inv.m.id, ok: true, result: { ok: true, revision: 3 }, nonce: sess.nonce, nodeId: sess.nodeId } });
  const res = await apply;
  assert.equal(res.revision, 3);
  // 插件侧校验失败 → 调用方拿到明细错误
  const failing = controls.applyCameraPreset(node.id, 'top_down');
  await flush();
  const inv2 = sess.win.sent.filter(x => x.m.kind === 'invoke').at(-1);
  host.onMessage({ origin: directorOrigin(), source: sess.win, data: { ns: 'xp-hub', kind: 'invoke-res', id: inv2.m.id, ok: true, result: { ok: false, results: [{ detail: 'look target missing' }] }, nonce: sess.nonce, nodeId: sess.nodeId } });
  await assert.rejects(failing, /look target missing/);
  host.dispose();
});

test('能力边界清单诚实标注未接入项；未注册 agent 的调用明确报错', async t => {
  assert.ok(DIRECTOR_UNSUPPORTED.join('').includes('vcam'), 'mocap/vcam 明示未接入');
  assert.ok(DIRECTOR_UNSUPPORTED.join('').includes('AI'), '宿主 AI 明示未接入');
  const { store, host } = await mkHost(t);
  const node = store.addNode('director', 100, 100, {});
  await assert.rejects(host.invokeAgent(node.id, { method: 'scene.get' }), /未打开/, '未打开时报错而非伪造结果');
  host.dispose();
});

// ---------- AI 运镜提案与包裹场景记录（本轮新增）----------
function stubHost(handlers = {}) {
  const calls = [];
  return {
    calls,
    isOpen: () => true,
    openEditor() {},
    invokeAgent: async (nodeId, payload) => {
      calls.push({ nodeId, method: payload.method, args: payload.args ?? {} });
      const fn = handlers[payload.method];
      if (!fn) throw new Error(`未编排的调用 ${payload.method}`);
      return fn(payload.args ?? {});
    },
  };
}
function mockGenerators(output, models) {
  const calls = [];
  return {
    calls,
    textModels: () => models ?? [{ id: 'chat-mock', name: 'chat-mock', usable: true }],
    imageModels: () => [],
    generate: async node => { calls.push(node.id); node.data.resultText = output; node.data.outputText = output; return { text: output }; },
  };
}
const DSL_OK = 'campath "验收推近"\n  look at 0 1.2 0\n  from 0 1.6 6 fov 45\n  dolly in 2 4s\n  hold 0.5s';

test('readSceneInfo：识别 {schemaVersion,savedAt,composition} 包裹记录，兼容旧对象/字符串', async () => {
  const { storage } = freshDeps();
  const comp = { characters: [{ id: 'a' }], cameras: [{ id: 'c', label: 'A' }], camPaths: [{ id: 'k', label: '推' }], camTimeline: { durationMs: 4000, tracks: [{ clips: [{ id: 1 }] }] } };
  await storage.set('dir:n_w:composition', { schemaVersion: 1, savedAt: 1700000000000, composition: comp });
  const w = await readSceneInfo(storage, 'n_w');
  assert.equal(w.saved, true, '包裹记录应识别为已保存');
  assert.equal(w.wrapped, true);
  assert.equal(w.savedAt, 1700000000000);
  assert.equal(w.counts.characters, 1);
  assert.equal(w.counts.camPaths, 1);
  assert.equal(w.counts.clips, 1);
  await storage.set('dir:n_o:composition', comp);
  const o = await readSceneInfo(storage, 'n_o');
  assert.equal(o.saved, true, '旧版纯对象仍可读');
  assert.equal(o.wrapped, false);
  assert.equal(o.counts.cameras, 1);
  await storage.set('dir:n_s:composition', JSON.stringify(comp));
  assert.equal((await readSceneInfo(storage, 'n_s')).counts.camPaths, 1, '旧版字符串仍可读');
  await storage.set('dir:n_ws:composition', JSON.stringify({ schemaVersion: 1, savedAt: 1, composition: comp }));
  assert.equal((await readSceneInfo(storage, 'n_ws')).counts.clips, 1, '包裹字符串同样可读');
  await storage.set('dir:n_b:composition', '{bad json');
  assert.equal((await readSceneInfo(storage, 'n_b')).saved, false, '坏 JSON 诚实报未保存');
  await storage.set('dir:n_n:composition', 42);
  assert.equal((await readSceneInfo(storage, 'n_n')).saved, false);
  await storage.set('dir:n_e:composition', { schemaVersion: 1, savedAt: 1 });
  assert.equal((await readSceneInfo(storage, 'n_e')).saved, false, '包裹外壳缺内容不得虚报已保存');
});

test('parseCamPathDsl / extractCamPathDsl：严格语法边界', () => {
  const p = parseCamPathDsl(DSL_OK);
  assert.equal(p.name, '验收推近');
  assert.equal(p.durationSec, 4.5);
  assert.equal(p.segments, 2);
  assert.throws(() => parseCamPathDsl('campath "x"'), /look|from|段落/);
  assert.throws(() => parseCamPathDsl('campath "x"\n  look at 0 1 0\n  from 0 1 5\n  hold 0.2s'), /时长|0\.5/);
  assert.throws(() => parseCamPathDsl('x'.repeat(5000)), /4000|上限/);
  assert.throws(() => parseCamPathDsl(DSL_OK + '\n  hold 200s'), /120/);
  const ex = extractCamPathDsl('前言\n```\n' + DSL_OK + '\n```\n后记');
  assert.equal(ex.name, '验收推近');
  assert.throws(() => extractCamPathDsl('没有任何 DSL'), /campath/);
  for (const pr of CAMERA_PRESETS) assert.doesNotThrow(() => parseCamPathDsl(pr.dsl), `预设 ${pr.id} 须过严格语法`);
});

test('AI 运镜提案：显式 generate → 严格解析 → 恰好一次 validateOnly + 一次 apply', async t => {
  const { store, storage } = freshDeps();
  await store.newProject('A');
  t.after(() => overlay.replaceChildren());
  const node = store.addNode('director', 100, 100, {});
  let revision = 7;
  const host = stubHost({
    'scene.get': () => ({ revision, camPaths: revision >= 8 ? [{ id: 'kp_1', label: '验收推近', durationMs: 4500 }] : [] }),
    'scene.edit': args => args.validateOnly
      ? { ok: true, validateOnly: true, applied: 0, results: [{ ok: true }] }
      : { ok: true, applied: 1, revision: ++revision, affectedIds: ['kp_1'], summary: '1 path, 1 track', results: [{ ok: true, id: 'kp_1' }] },
  });
  const gens = mockGenerators('说明\n```\n' + DSL_OK + '\n```\n以上是方案');
  const controls = createDirectorControls({ store, storage, host });
  controls.configure({ generators: gens });
  controls.inspector(node);   // 构建检查器不得触发任何生成调用
  assert.equal(gens.calls.length, 0, '打开检查器不产生自动付费调用');
  const proposal = await controls.proposeCamPath(node.id, { prompt: '缓推到特写', model: 'chat-mock' });
  assert.equal(gens.calls.length, 1, '仅显式提案调用一次 generate');
  assert.equal(proposal.name, '验收推近');
  assert.equal(proposal.durationSec, 4.5);
  assert.equal(proposal.revision, 7);
  assert.match(proposal.dsl, /^campath "验收推近"/);
  assert.equal(controls.getProposal(node.id)?.id, proposal.id);
  const draft = store.node(proposal.draftNodeId);
  assert.ok(draft && draft.type === 'text', '提案正文持久在文本节点');
  assert.equal(draft.data.model, 'chat-mock');
  assert.match(draft.data.resultText, /campath/);
  assert.equal(store.node(node.id).data.aiProposal?.id, proposal.id, '提案记录留在导演台节点数据');
  assert.equal(host.calls.filter(c => c.method === 'scene.edit').length, 0, '提案阶段零场景写');
  const r = await controls.applyCamPathProposal(node.id, proposal);
  const edits = host.calls.filter(c => c.method === 'scene.edit');
  assert.equal(edits.filter(c => c.args.validateOnly === true).length, 1, '恰好一次 validateOnly');
  assert.equal(edits.filter(c => c.args.validateOnly !== true).length, 1, '恰好一次 apply');
  assert.equal(edits[0].args.validateOnly, true, '先校验后应用');
  assert.equal(edits[1].args.operations[0].type, 'set_campath');
  assert.match(edits[1].args.operations[0].dsl, /dolly in 2 4s/);
  assert.equal(r.revision, 8);
});

test('AI 运镜提案：场景修订漂移与项目切换均阻止应用', async t => {
  const { store, storage } = freshDeps();
  await store.newProject('A');
  t.after(() => overlay.replaceChildren());
  const node = store.addNode('director', 100, 100, {});
  let revision = 7;
  const host = stubHost({
    'scene.get': () => ({ revision, camPaths: [] }),
    'scene.edit': () => ({ ok: true, applied: 1, results: [{ ok: true }] }),
  });
  const controls = createDirectorControls({ store, storage, host, generators: mockGenerators(DSL_OK) });
  const proposal = await controls.proposeCamPath(node.id, { prompt: '推近' });
  assert.equal(proposal.revision, 7);
  revision = 9;   // 场景在他处被改（revision 漂移）
  await assert.rejects(controls.applyCamPathProposal(node.id, proposal), /revision|修改|变更/);
  assert.equal(host.calls.filter(c => c.method === 'scene.edit').length, 0, '漂移时不得发起 scene.edit');
  const callsNow = host.calls.length;
  await store.newProject('B');
  await assert.rejects(controls.applyCamPathProposal(node.id, { ...proposal, revision: 9 }), /项目已切换/);
  assert.equal(host.calls.length, callsNow, '跨项目提案在任何 RPC 前被拒绝');
});

test('AI 运镜提案：坏模型输出与坏 DSL 一律拒绝且不发生场景写', async t => {
  const { store, storage } = freshDeps();
  await store.newProject('A');
  t.after(() => overlay.replaceChildren());
  const node = store.addNode('director', 100, 100, {});
  const host = stubHost({
    'scene.get': () => ({ revision: 3, camPaths: [] }),
    'scene.edit': () => ({ ok: true, applied: 1, results: [{ ok: true }] }),
  });
  const badGens = mockGenerators('这是一段没有任何 DSL 的自然语言回答');
  const controls = createDirectorControls({ store, storage, host, generators: badGens });
  await assert.rejects(controls.proposeCamPath(node.id, { prompt: '环绕' }), /campath|DSL/);
  assert.equal(host.calls.filter(c => c.method === 'scene.edit').length, 0, '坏输出不得触碰场景写');
  const callsNow = host.calls.length;
  await assert.rejects(
    controls.applyCamPathProposal(node.id, { nodeId: node.id, projectId: store.project.id, revision: 3, dsl: 'campath "x"\n  eval(process.exit)' }),
    /DSL|行|指令/);
  assert.equal(host.calls.length, callsNow, '坏 DSL 在任何 RPC 前被拒绝');
  await assert.rejects(
    controls.applyCamPathProposal(node.id, { nodeId: node.id, projectId: store.project.id, revision: 3, dsl: 'campath "x"\n  look at 0 1 0\n  from 0 1 5\n  hold 999s' }),
    /时长|120/);
  assert.equal(host.calls.length, callsNow, '越界 DSL 同样零 RPC');
});

test('AI 运镜提案：未配置/无可用型号时明确拒绝，不调用 generate', async t => {
  const { store, storage } = freshDeps();
  await store.newProject('A');
  t.after(() => overlay.replaceChildren());
  const node = store.addNode('director', 100, 100, {});
  const host = stubHost({ 'scene.get': () => ({ revision: 1, camPaths: [] }) });
  const controls = createDirectorControls({ store, storage, host });
  await assert.rejects(controls.proposeCamPath(node.id, { prompt: '推近' }), /未接入|文本生成/);
  const gens = mockGenerators(DSL_OK, [{ id: 'm-x', name: 'm-x', usable: false }]);
  controls.configure({ generators: gens });
  await assert.rejects(controls.proposeCamPath(node.id, { prompt: '推近' }), /无可用|不可用/);
  assert.equal(gens.calls.length, 0, '无可用型号不发起 generate');
});
