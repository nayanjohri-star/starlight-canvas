// 导演台宿主桥（父页侧）：iframe 异源嵌入原版 3D 导演台插件（MiniMax 参考插件，独立本机源隔离）。
// 安全与生命周期约束：
//  · 会话 nonce 绑定 nodeId+projectId+iframe 窗口；每条消息校验 e.origin/e.source/nonce/nodeId，不可伪造
//  · 同一节点只允许一个会话；项目切换/导入、节点删除、弹窗关闭（按钮/遮罩/Esc）统一走 cleanup：
//    拒绝全部悬挂 RPC、关闭素材选择器等会话内弹窗、清握手超时定时器、摘除 iframe（WebGL 上下文随 DOM 移除释放）
//  · 写项目数据的 RPC 在 await 前后都校验 sess.closed 与 projectId —— 关闭/切项目期间的悬挂写入
//    不会落进新项目（跨项目零泄漏）
//  · iframe 内 blob: URL ↔ xp-asset:// 令牌由 __hub-sdk__.js 处理：GLB/贴图经素材库托管后可跨会话恢复；
//    宿主侧再守一道：storage.set/config.set 拒绝仍含未托管 blob: 或指向不可用素材的 xp-asset 引用——
//    坏存档绝不覆盖上一份可恢复场景
//  · 密钥不出父页：iframe 是独立源，拿不到 /site 凭据、IndexedDB 与父页 DOM
//  · WebGL/第三方 bundle 只在用户点「打开导演台」后加载；握手超时/iframe 错误进入可重试的错误边界，
//    不影响画布其余功能
// 宿主未接入能力（诚实降级，不伪造）：插件内 AI 生成/积分、hub.python.*（vcam 手机虚拟摄影机/mocap）、
// 云端素材库 —— 对应 RPC 以明确错误拒绝，UI 明示。

import { el, toast, modal } from './ui.js';
import { fileKind } from './capabilities.js';
import { uid, containsSecret } from './store.js';
import { KIND_LABEL } from './assets.js';
import { isHosted, feature } from './runtime-config.js';
import { createHostedDirectorHost } from './director-hosted.js';

const NS = 'xp-hub';
const MiB = 1024 * 1024;
// 与本站素材上传上限一致：图片 30MiB / 视频 100MiB；插件落盘文件（GLB 等）按 100MiB
export const DIRECTOR_LIMITS = { image: 30 * MiB, video: 100 * MiB, file: 100 * MiB };
const HELLO_TIMEOUT_MS = 25000;   // iframe 握手超时 → 错误边界
const INVOKE_TIMEOUT_MS = 15000;  // agent 调用超时
const KV_VALUE_MAX = 5 * MiB;     // 与 store 导出校验一致
const NOTIFY_TYPES = { info: 'info', warn: 'warn', warning: 'warn', err: 'err', error: 'err', ok: 'ok', success: 'ok' };
// 跨会话必死的本地引用：blob:<scheme>://…（普通文本里的 "blob:" 字样不算）
const EPHEMERAL_URL_RE = /blob:[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const ASSET_TOKEN_RE = /xp-asset:\/\/[A-Za-z0-9_-]+/g;

export function directorOrigin() {
  const other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  return `${location.protocol}//${other}:${location.port}`;
}
export function directorURL(nodeId, nonce) {
  return `${directorOrigin()}/director/index.html?node=${encodeURIComponent(nodeId)}&nonce=${encodeURIComponent(nonce)}`;
}

// TypedArray/DataView 只取视图自身范围——绝不用 data.buffer 把整个底层缓冲写进去
export function toBlob(data, mime) {
  if (data instanceof Blob) return data;
  const type = mime || 'application/octet-stream';
  if (data instanceof ArrayBuffer) return new Blob([data], { type });
  if (ArrayBuffer.isView(data)) return new Blob([data], { type });
  return null; // 字符串 URL 一律拒绝：不替 iframe 抓取来历不明地址
}

const typeMatches = (kind, type) =>
  !type || (Array.isArray(type) ? type.includes(kind) : kind === type);

// directorBody 现有调用点只传 {host}——宿主创建时记住 storage，让节点体场景摘要照常工作
let hostStorage = null;

export function createDirectorHost({ store, storage, assets, api, spawnPosition }) {
  hostStorage = storage ?? null;
  if (isHosted() || feature('hostedDirector')) return createHostedDirectorHost({ store, storage, assets, api, spawnPosition });
  const sessions = new Map();     // nodeId → session
  const winToSession = new Map(); // iframe Window → session
  let disposed = false;

  // 会话存活性：写操作与回复前都必须过这道闸（关闭中的会话与已切换项目一律拒绝）
  const checkLive = sess => {
    if (sess.closed || disposed) throw new Error('导演台会话已关闭');
    if (store.project?.id !== sess.projectId) throw new Error('项目已切换，本次导演台操作已取消');
  };

  // 可恢复性闸：待写值中不得含未托管的 blob: 引用（跨会话必成死链）；
  // xp-asset:// 令牌必须指向本项目存在且有本地字节的素材，否则恢复时只会拿到死引用。
  // 任一不满足即拒绝保存——坏数据绝不覆盖上一份可恢复存档（SDK 侧同样守着，此为纵深防御）。
  function assertPersistable(text) {
    if (EPHEMERAL_URL_RE.test(text)) throw new Error('场景仍含未托管的本地 blob 引用，已拒绝保存（上一份可恢复存档保留）');
    const ids = [...new Set((text.match(ASSET_TOKEN_RE) ?? []).map(t => t.slice('xp-asset://'.length)))];
    const missing = ids.filter(id => { const a = store.project?.assets?.[id]; return !a || a.missing; });
    if (missing.length) throw new Error(`场景引用了 ${missing.length} 个本项目不可用素材（${missing.slice(0, 3).join('、')}），已拒绝保存`);
  }

  async function assetPayload(a) {
    const blob = await assets.blobOf(a.id);
    if (!blob) return null;
    return { assetId: a.id, name: a.name, type: a.kind, mime: a.mime, bytes: await blob.arrayBuffer() };
  }
  const wiredAssets = nodeId =>
    store.edgesInto(nodeId, 'refs').map(e => store.node(e.from.node))
      .filter(n => n?.type === 'asset').map(n => assets.assetOfNode(n)).filter(Boolean);

  async function handleRpc(sess, method, args = {}) {
    checkLive(sess);
    const nodeId = sess.nodeId;
    switch (method) {
      case 'ui.close': {
        setTimeout(() => cleanup(sess, '导演台已关闭'), 0);
        return true;
      }
      case 'canvas.getIncomingResources': {
        const list = wiredAssets(nodeId).filter(a => typeMatches(a.kind, args.type));
        const out = [];
        for (const a of list) { const p = await assetPayload(a); if (p) out.push(p); }
        checkLive(sess);
        return out;
      }
      case 'canvas.pickAsset': {
        const picked = await pickAssets(sess, args.type, args.multiple ? Math.min(12, args.maxCount ?? 4) : 1);
        checkLive(sess);
        const out = [];
        for (const a of picked) { const p = await assetPayload(a); if (p) out.push(p); }
        return out;
      }
      case 'canvas.insertImageNode': case 'canvas.insertVideoNode': case 'canvas.insertFileNode':
        return insertAsset(sess, args, method);
      case 'files.writeToPluginDir': {
        // 插件 GLB/贴图/导出落盘 → 存为素材库条目（重开可恢复，blob 留 IDB）
        const blob = toBlob(args.bytes ?? args.data ?? args.source, args.mime);
        if (!blob || !blob.size) throw new Error('写入内容为空');
        if (blob.size > DIRECTOR_LIMITS.file) throw new Error('文件超过 100MiB');
        const a = await assets.registerBlob(blob, String(args.name ?? args.path ?? 'plugin-file').slice(0, 200), 'file', { fromDirector: nodeId, category: 'director' });
        checkLive(sess);
        return { ok: true, assetId: a.id, name: a.name };
      }
      case 'asset.embed': {
        // iframe 内创建的 blob（插件内导入的 GLB/纹理）→ 托管入库，换取 xp-asset:// 稳定令牌
        const blob = toBlob(args.bytes, args.mime);
        if (!blob || !blob.size) throw new Error('空内容');
        if (blob.size > DIRECTOR_LIMITS.file) throw new Error('文件超过 100MiB');
        const kind = fileKind({ type: blob.type }) ?? 'file';
        const a = await assets.registerBlob(blob, String(args.name ?? `导演台内嵌-${Date.now()}`).slice(0, 200), kind, { fromDirector: nodeId, category: 'director' });
        checkLive(sess);
        return { assetId: a.id };
      }
      case 'asset.bytes': {
        // 重开恢复：xp-asset:// 令牌 → 字节（shim 重建 blob URL）；缺字节的 id 不进 map，
        // shim 侧据不完整映射显式报错，不静默留死引用
        const ids = Array.isArray(args.ids) ? args.ids.slice(0, 50) : [];
        const out = {};
        for (const id of ids) {
          checkLive(sess);
          const a = typeof id === 'string' ? store.project.assets[id] : null;
          const blob = a && !a.missing ? await assets.blobOf(id) : null;
          if (blob) out[id] = { mime: a.mime, bytes: await blob.arrayBuffer() };
        }
        return out;
      }
      case 'storage.get': {
        const key = kvKey(args.key); if (key == null) throw new Error('存储键不合法');
        return storage.get(`dir:${nodeId}:${key}`);
      }
      case 'storage.set': {
        const key = kvKey(args.key); if (key == null) throw new Error('存储键不合法');
        const text = checkKvValue(args.value);
        assertPersistable(text);   // 坏存档拒绝覆盖上一份可恢复场景
        await storage.set(`dir:${nodeId}:${key}`, args.value);
        checkLive(sess);   // 落盘期间项目可能已切换——报告失败而不是假装成功
        return true;
      }
      case 'config.get': {
        const key = kvKey(args.key); if (key == null) throw new Error('配置键不合法');
        return storage.get(`dircfg:${nodeId}:${key}`);
      }
      case 'config.set': {
        const key = kvKey(args.key); if (key == null) throw new Error('配置键不合法');
        const text = checkKvValue(args.value);
        assertPersistable(text);
        await storage.set(`dircfg:${nodeId}:${key}`, args.value);
        checkLive(sess);
        return true;
      }
      case 'ui.notify': {
        toast(String(args.message ?? '').slice(0, 500), NOTIFY_TYPES[args.type] ?? 'info');
        return true;
      }
      case 'agent.setEditorState': {
        // 写入身份绑定：只许写本会话本项目的导演台节点
        const node = store.project.nodes.find(n => n.id === nodeId && n.type === 'director');
        if (!node) throw new Error('导演台节点已删除');
        node.data.editorState = normalizeEditorState(args.state);   // 校验+规范化先于写入：坏 state 不进项目数据，不伪造成功
        store.saveSoon();
        return true;
      }
      default:
        // 未接入的宿主能力一律明确拒绝（python/AI 生成/云盘等），不返回伪造成功
        throw new Error(`本站导演台宿主未接入该能力：${method}`);
    }
  }

  const kvKey = k => (typeof k === 'string' && k.length > 0 && k.length <= 256 ? k : null);
  function checkKvValue(v) {
    let text;
    try { text = JSON.stringify(v); } catch { throw new Error('存储值不可序列化'); }
    if (text == null || text.length > KV_VALUE_MAX) throw new Error('存储值超过 5MiB 上限');
    return text;
  }

  // editorState 写入闸（与 checkKvValue 同规格）：先试序列化（循环引用/BigInt 抛错即拒）、
  // 5MiB 上限、密钥字段黑名单，以及摘要中明确的凭据格式检查。
  // 根契约：对象 / null（清除）/ 字符串——原版插件 hub.agent.setEditorState(c0(...)) 上送的是
  // AI 编辑器上下文摘要：「3D Director Stage scene:」开头的多行文本，并非场景对象本身
  // （场景对象另经 storage.set('composition') 持久化）。字符串属合理契约：统一规范为
  // {summary: 原文} 后走同一套校验与存储形状，而非按前缀硬放行；空白摘要等价于清除，
  // 超限或含疑似密钥的字符串同样拒绝，数字/数组等无效根维持拒绝。
  // 校验先于写入——坏数据落进项目会让 saveSoon 的 JSON.stringify 持续失败，拖垮自动保存。
  function normalizeEditorState(v) {
    if (v == null) return null;   // null/undefined = 清除状态
    if (typeof v === 'string') {
      if (!v.trim()) return null;   // 空白摘要等价于清除状态
      v = { summary: v };   // 原生上下文摘要字符串 → 对象包裹，复用同一套校验与存储形状
    }
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('editorState 根节点必须是对象、摘要字符串或 null');
    let text;
    try { text = JSON.stringify(v); } catch { throw new Error('editorState 不可 JSON 序列化（含循环引用或 BigInt），已拒绝'); }
    if (text == null || text.length > KV_VALUE_MAX || new TextEncoder().encode(text).byteLength > KV_VALUE_MAX)
      throw new Error('editorState 超过 5MiB 上限，已拒绝');
    if (containsSecret(v)) throw new Error('editorState 包含疑似密钥字段，已拒绝');
    if (typeof v.summary === 'string' && /\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/i.test(v.summary))
      throw new Error('editorState 摘要包含疑似密钥，已拒绝');
    return v;
  }

  function pickAssets(sess, kind, max) {
    const kinds = Array.isArray(kind) ? kind : kind ? [kind] : null;
    const all = Object.values(store.project?.assets ?? {}).filter(a => a && !a.missing && typeMatches(a.kind, kinds));
    return new Promise(resolve => {
      let settled = false;
      let closeModal = () => {};
      const finish = v => {
        if (settled) return;
        settled = true;
        sess.pickClosers?.delete(finish);
        closeModal();
        resolve(v);
      };
      // 会话清理时强制关闭选择器：弹窗与悬挂 RPC 不得泄漏进新项目
      (sess.pickClosers ??= new Set()).add(finish);
      const grid = el('div', { class: 'picker-grid' });
      const chosen = new Set();
      const done = el('button', { class: 'primary', type: 'button', text: '确定' });
      const cancel = el('button', { type: 'button', text: '取消' });
      for (const a of all) {
        const item = el('div', { class: 'picker-item' }, el('div', { text: a.name }), el('small', { class: 'muted', text: KIND_LABEL[a.kind] ?? a.kind }));
        if (a.kind === 'image') assets.objectURL(a.id).then(u => { if (u) item.prepend(el('img', { src: u })); });
        item.addEventListener('click', () => {
          if (chosen.has(a.id)) { chosen.delete(a.id); item.classList.remove('sel'); }
          else if (chosen.size < max) { chosen.add(a.id); item.classList.add('sel'); }
        });
        grid.append(item);
      }
      const label = kinds ? kinds.map(k => KIND_LABEL[k] ?? k).join('/') : '任意';
      const m = modal(el('div', {},
        el('h3', { text: `选择素材（${label}，最多 ${max}）` }),
        all.length ? grid : el('p', { class: 'hint', text: '素材库为空，先在左侧上传' }),
        el('div', { class: 'modal-actions' }, cancel, done)),
        { onClose: () => finish([]) });   // Esc/遮罩关闭 = 取消，不再悬挂 RPC
      closeModal = m.close;
      done.addEventListener('click', () => finish(all.filter(a => chosen.has(a.id))));
      cancel.addEventListener('click', () => finish([]));
    });
  }

  // 导出 = 真实字节 → 素材库条目 + 画布素材节点；fromDirector 绑定来源节点，可回连生成/分镜。
  async function insertAsset(sess, args, method) {
    const blob = toBlob(args.bytes ?? args.source ?? args.data, args.mime);
    if (!blob || !blob.size) throw new Error('导出内容为空或不受支持（不接受 URL 字符串）');
    const want = method === 'canvas.insertImageNode' ? 'image' : method === 'canvas.insertVideoNode' ? 'video' : null;
    const limit = want ? DIRECTOR_LIMITS[want] : DIRECTOR_LIMITS.file;
    if (blob.size > limit) throw new Error(`导出文件超过 ${Math.round(limit / MiB)}MiB 上限`);
    const kind = fileKind({ type: blob.type }) ?? want ?? 'file';
    if (want && kind !== want) throw new Error(`导出类型不符：期望 ${want}`);
    const name = String(args.name || `导演台导出-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`).slice(0, 200);
    const a = await assets.registerBlob(blob, name, kind, { fromDirector: sess.nodeId, category: 'director' });
    checkLive(sess);   // registerBlob 自身也会拒绝跨项目写入，这里再守一次后续建节点
    const node = store.node(sess.nodeId);
    store.addNode('asset', (node?.x ?? 100) + 280, (node?.y ?? 100) + 40, { assetId: a.id, title: name });
    assets.renderLibrary();
    toast(`已加入素材库：${name}`, 'ok');
    return { assetId: a.id };
  }

  function sendInit(sess) {
    if (sess.closed || !sess.win) return;
    const theme = document.documentElement?.dataset?.theme === 'light' ? 'light' : 'dark';
    sess.win.postMessage({
      ns: NS, kind: 'init', nonce: sess.nonce,
      payload: {
        locale: 'zh-CN', theme, region: 'cn',
        width: sess.frame.clientWidth || 1280, height: sess.frame.clientHeight || 800,
        // 显式能力边界：插件据此降级，不要把未接入能力当成可用
        unsupported: ['python', 'aiGenerate', 'vcam', 'mocap', 'phoneCamera', 'cloudAssets'],
      },
    }, directorOrigin());
  }

  function mountFrame(sess) {
    // 重挂帧前清掉旧窗口的全部悬挂状态：invoke waiter 与素材选择器等会话内弹窗
    // 不得悬挂到重试之后（它们绑定的是已失效的旧窗口）
    if (sess.win) { winToSession.delete(sess.win); sess.win = null; }
    for (const w of sess.invokeWaiters.values()) { clearTimeout(w.timer); w.reject(new Error('3D 导演台已重新加载，请重试')); }
    sess.invokeWaiters.clear();
    for (const f of [...(sess.pickClosers ?? [])]) { try { f([]); } catch { /* 忽略 */ } }
    try { if (sess.frame) sess.frame.src = 'about:blank'; } catch { /* 忽略 */ }
    sess.frame?.remove();
    sess.nonce = uid('s');
    sess.greeted = false;
    const frame = el('iframe', {
      class: 'director-frame', src: directorURL(sess.nodeId, sess.nonce),
      sandbox: 'allow-scripts allow-same-origin allow-downloads',
      allow: 'autoplay; encrypted-media; gyroscope',
    });
    sess.frame = frame;
    sess.frameSlot.replaceChildren(frame);
    sess.statusEl.textContent = '正在加载 3D 导演台…';
    clearTimeout(sess.readyTimer);
    sess.readyTimer = setTimeout(() => { if (!sess.closed && !sess.greeted) showLoadError(sess); }, HELLO_TIMEOUT_MS);
    sess.readyTimer?.unref?.();
    frame.addEventListener('load', () => {
      if (sess.closed || sess.frame !== frame) return;
      sess.win = frame.contentWindow ?? null;
      if (sess.win) {
        winToSession.set(sess.win, sess);
        // hello 可能先于 load 到达（winToSession 尚未建立）→ 主动补发 init
        sendInit(sess);
      }
    });
    frame.addEventListener('error', () => { if (sess.frame === frame) showLoadError(sess); });
  }

  function showLoadError(sess) {
    if (sess.closed) return;
    sess.statusEl.textContent = '加载失败';
    const retry = el('button', { class: 'primary', type: 'button', text: '重试加载' });
    retry.addEventListener('click', () => { sess.frameSlot.replaceChildren(); mountFrame(sess); });
    sess.frameSlot.replaceChildren(el('div', {
      style: 'flex:1;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;padding:24px;text-align:center',
    },
      el('b', { text: '3D 导演台未能加载' }),
      el('p', { class: 'hint', text: '已保存的场景数据仍在项目中，不会丢失。请确认本机服务提供了导演台页面资源，且当前环境支持 WebGL，然后重试。' }),
      retry));
  }

  function openEditor(node) {
    if (!node || node.type !== 'director') return null;
    const existing = sessions.get(node.id);
    if (existing && !existing.closed) {
      // 同一节点重开：聚焦已有会话而非叠第二个 iframe（双 WebGL 上下文抢资源且状态会分叉）
      // 移动包含 iframe 的 DOM 会重建其浏览上下文；复用会话时保持原位置。
      existing.modal?.box?.focus?.();
      toast('该节点的导演台已在编辑中', 'info');
      return existing;
    }
    const projectId = store.project?.id;
    if (!projectId) { toast('请先打开项目', 'warn'); return null; }

    const statusEl = el('span', { class: 'muted', text: '' });
    const frameSlot = el('div', { style: 'flex:1;display:flex;min-height:0' });
    const sceneBtn = el('button', { type: 'button', text: '读取场景' });
    const runBtn = el('button', { type: 'button', text: '▶ 运行' });
    const closeBtn = el('button', { type: 'button', text: '关闭' });
    const head = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px;align-items:center;flex:none' },
      el('b', { text: '3D 导演台' }), statusEl,
      el('span', { style: 'flex:1' }), sceneBtn, runBtn, closeBtn);
    const wrap = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, head, frameSlot);

    let sess = null;
    const m = modal(wrap, { wide: true, onClose: () => { if (sess) cleanup(sess, '导演台已关闭'); } });
    sess = {
      nodeId: node.id, projectId, nonce: '', frame: null, win: null,
      invokeWaiters: new Map(), invokeSeq: 0, closed: false, greeted: false,
      readyTimer: null, modal: m, statusEl, frameSlot,
      pickClosers: new Set(),   // 会话内弹窗（素材选择器等）的强制关闭句柄，随 cleanup 统一关闭
    };
    sessions.set(node.id, sess);
    mountFrame(sess);

    closeBtn.addEventListener('click', () => cleanup(sess, '导演台已关闭'));
    runBtn.addEventListener('click', () => {
      if (sess.closed || !sess.win) { toast('插件未就绪', 'warn'); return; }
      sess.win.postMessage({ ns: NS, kind: 'event', name: 'run', nonce: sess.nonce }, directorOrigin());
    });
    sceneBtn.addEventListener('click', async () => {
      try {
        const res = await invokeAgent(node.id, { method: 'scene.get', args: {} });
        modal(el('div', {}, el('h3', { text: 'scene.get' }), el('pre', { style: 'max-height:50vh;overflow:auto;font-size:11px', text: JSON.stringify(res, null, 2) })));
      } catch (e) { toast(`scene.get 失败：${e.message}`, 'err'); }
    });
    return sess;
  }

  // 统一清理：拒绝悬挂 invoke、关闭会话内弹窗、断开窗口映射、摘 iframe（释放 WebGL）、关弹窗。幂等。
  function cleanup(sess, reason = '导演台已关闭') {
    if (!sess || sess.closed) return;
    sess.closed = true;
    clearTimeout(sess.readyTimer);
    for (const w of sess.invokeWaiters.values()) { clearTimeout(w.timer); w.reject(new Error(reason)); }
    sess.invokeWaiters.clear();
    for (const f of [...(sess.pickClosers ?? [])]) { try { f([]); } catch { /* 忽略 */ } }
    sess.pickClosers?.clear();
    if (sess.win) { winToSession.delete(sess.win); sess.win = null; }
    if (sessions.get(sess.nodeId) === sess) sessions.delete(sess.nodeId);
    try { if (sess.frame) sess.frame.src = 'about:blank'; } catch { /* 忽略 */ }
    sess.frame?.remove();   // 显式摘除 iframe：不依赖弹窗关闭路径也能释放 WebGL 上下文
    sess.frame = null;
    sess.modal?.close();
  }

  function closeAll(reason = '导演台已关闭') {
    for (const sess of [...sessions.values()]) cleanup(sess, reason);
  }

  function invokeAgent(nodeId, payload, timeoutMs = INVOKE_TIMEOUT_MS) {
    const sess = sessions.get(nodeId);
    if (!sess || sess.closed || !sess.win) return Promise.reject(new Error('导演台未打开'));
    return new Promise((resolve, reject) => {
      const id = 'inv_' + ++sess.invokeSeq;
      const timer = setTimeout(() => {
        if (sess.invokeWaiters.delete(id)) reject(new Error('插件未响应（可能未注册 agent.onInvoke）'));
      }, timeoutMs);
      timer?.unref?.();
      sess.invokeWaiters.set(id, { resolve, reject, timer });
      sess.win.postMessage({ ns: NS, kind: 'invoke', id, nonce: sess.nonce, method: payload.method, args: payload.args ?? {} }, directorOrigin());
    });
  }

  function onMessage(e) {
    if (disposed) return;
    const d = e.data;
    if (!d || d.ns !== NS) return;
    if (e.origin !== directorOrigin()) return;
    let sess = winToSession.get(e.source);
    if (!sess) {
      // hello 可能早于 load 事件到达：按 frame.contentWindow 找回会话再绑定
      for (const s of sessions.values()) {
        if (!s.closed && s.frame && s.frame.contentWindow === e.source) {
          s.win = e.source; winToSession.set(e.source, s); sess = s; break;
        }
      }
    }
    if (!sess || sess.closed || d.nonce !== sess.nonce || d.nodeId !== sess.nodeId) return; // 会话校验：防伪冒/防串台
    if (!sess.greeted) {   // 首次合法会话消息 = 握手成功：状态转「已就绪」并停掉加载超时定时器
      sess.greeted = true;
      if (sess.statusEl) sess.statusEl.textContent = '已就绪';
      clearTimeout(sess.readyTimer);
    }
    if (d.kind === 'hello') { sendInit(sess); return; }
    if (d.kind === 'invoke-res') {
      const w = sess.invokeWaiters.get(d.id);
      if (w) { sess.invokeWaiters.delete(d.id); clearTimeout(w.timer); d.ok ? w.resolve(d.result) : w.reject(new Error(d.error)); }
      return;
    }
    if (d.kind !== 'rpc') return;
    handleRpc(sess, d.method, d.args ?? {})
      .then(result => sess.win?.postMessage({ ns: NS, kind: 'rpc-res', id: d.id, ok: true, result, nonce: sess.nonce }, directorOrigin()))
      .catch(err => sess.win?.postMessage({ ns: NS, kind: 'rpc-res', id: d.id, ok: false, error: String(err?.message ?? err), nonce: sess.nonce }, directorOrigin()));
  }

  function notifyIncoming(nodeId) {
    const sess = sessions.get(nodeId);
    if (sess && !sess.closed) sess.win?.postMessage({ ns: NS, kind: 'event', name: 'incoming-change', nonce: sess.nonce }, directorOrigin());
  }

  // 项目切换/导入、节点删除 → 终结对应会话（不等项目切面泄漏写入）
  const offStore = store.onChange(reason => {
    if (disposed) return;
    if (reason?.type === 'project') { closeAll('项目已切换，导演台已关闭'); return; }
    if (reason?.type === 'structure') {
      for (const sess of [...sessions.values()]) {
        if (!store.project?.nodes.some(n => n.id === sess.nodeId && n.type === 'director')) cleanup(sess, '导演台节点已删除');
      }
    }
  });

  return {
    openEditor,
    closeEditor: nodeId => cleanup(sessions.get(nodeId), '导演台已关闭'),
    closeAll,
    dispose() { disposed = true; offStore(); closeAll('宿主已销毁'); },
    isOpen: nodeId => { const s = sessions.get(nodeId); return !!s && !s.closed; },
    sessionOf: nodeId => sessions.get(nodeId) ?? null,   // 调试/测试句柄（含 nonce/win，勿外传给插件外代码）
    onMessage, notifyIncoming, invokeAgent,
  };
}

export function directorBody(node, { host, storage } = {}) {
  const box = el('div', {});
  const info = el('p', { class: 'hint', text: '场景自动保存到当前项目，导出后可用于生成和剪辑' });
  box.append(
    el('div', { class: 'row' }, el('span', { text: '引擎' }), el('b', { text: '3D 导演台' })),
    info,
  );
  const kv = storage ?? hostStorage;
  if (host?.sceneInfo) {
    host.sceneInfo(node).then(i => { if (i?.saved) info.textContent = `已保存场景：${i.summaryText}`; }).catch(() => {});
  } else if (kv) {
    import('./director-controls.js')
      .then(m => m.readSceneInfo(kv, node.id))
      .then(i => { if (i?.saved) info.textContent = `已保存场景：${i.summaryText}`; })
      .catch(() => { /* 摘要失败不影响节点体 */ });
  }
  const btn = el('button', { class: 'primary', type: 'button', text: '打开导演台' });
  btn.addEventListener('click', e => { e.stopPropagation(); host.openEditor(node); });
  box.append(btn);
  return box;
}
