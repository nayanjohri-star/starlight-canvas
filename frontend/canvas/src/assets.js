// 素材库：文件入库（本地 blob 存 IDB）、上传远端（/site/reference-assets）、素材节点渲染。
// 素材实体存于 project.assets[id]；远端上传记录绑定密钥指纹（换密钥后需重传）。
// 缺 expires_at 不视为永久有效；近过期自动重传；导入缺失素材支持重新绑定本地文件。

import { el, toast, fmtBytes, fmtCountdown } from './ui.js';
import { fileKind, fileMaxBytes, UPLOAD_LIMITS } from './capabilities.js';
import { uid } from './store.js';
import { getFingerprint } from './keyvault.js';
import { DEFAULT_PROVIDER, upstreamUrl } from './provider-config.js';
import { studioState } from './studio-schema.js';
import { openMediaPreview } from './media-preview.js';

export const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', file: '文件' };
// LibTV 风格分类维度：角色/场景/道具/风格/镜头/其他
export const ASSET_CATEGORIES = { character: '角色', scene: '场景', prop: '道具', style: '风格', lens: '镜头', other: '其他' };
const EXPIRY_MARGIN_MS = 120_000; // 距过期不足 2 分钟视为需重传
// 上传响应绑定当前 API 服务商的素材路径；外域、凭据和 hash 一律拒绝。

export function createAssets({ store, storage, api, onError, onSpawnNode }) {
  const blobKey = id => `blob:${id}`;
  const urls = new Map();

  async function blobOf(id) { return storage.getBlob(blobKey(id)); }
  async function objectURL(id) {
    if (urls.has(id)) return urls.get(id);
    const b = await blobOf(id); if (!b) return null;
    const u = URL.createObjectURL(b); urls.set(id, u); return u;
  }

  // 整批校验通过才入库：任一文件不合格 → 全部拒绝；整批固定起始项目。
  async function addFiles(files) {
    const limits = UPLOAD_LIMITS();
    const project = store.project;
    const checked = [];
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) { toast(`不支持的素材格式：${file.name}，本批未入库`, 'err', 5000); return []; }
      const max = fileMaxBytes(kind);
      if (!file.size || file.size > max) { toast(`${file.name} 超过 ${limits[kind].max_mib}MiB 上限或为空，本批未入库`, 'err', 5000); return []; }
      checked.push({ file, kind });
    }
    const out = [];
    for (const { file, kind } of checked) {
      if (store.project !== project) { toast('项目已切换，剩余素材未入库', 'warn'); break; }
      out.push(await registerBlob(file, file.name, kind));
    }
    renderLibrary();
    return out;
  }

  // 把任意 Blob 注册为素材（上传文件/导演台导出/任务结果共用）。
  // 绑定调用开始时的项目对象：await 期间切项目不得污染新项目。
  // 可选 scope={project,nodeId}（第 5 参，旧调用兼容）：把整次入库钉在发起时的
  // 项目/节点上——写 blob 前与写入后都核验，项目已切换或发起节点已删除即中止，
  // 产出绝不落进新项目，也不残留孤儿 blob。
  async function registerBlob(blob, name, kind, extra = {}, scope = null) {
    const project = scope?.project ?? store.project;
    if (!project) throw new Error('无打开的项目，素材未入库');
    const scopeAlive = () => {
      try { scope?.assertCurrent?.(); } catch { return false; }
      return storage.active !== false && store.project === project &&
        (!scope?.nodeId || project.nodes.some(n => n.id === scope.nodeId));
    };
    if (!scopeAlive()) throw new Error('项目已切换或发起节点已删除，素材未入库');
    const id = uid('a');
    await storage.setBlob(blobKey(id), blob);
    const rec = { id, name, kind, mime: blob.type || 'application/octet-stream', size: blob.size, addedAt: Date.now(), remote: null, ...extra };
    if (!scopeAlive()) {   // 不写入已脱离的旧对象；回收已落盘的孤儿 blob
      try { await storage.delBlob(blobKey(id)); } catch { /* 回收尽力而为 */ }
      throw new Error('项目已切换，素材未入库');
    }
    // A director output is staged until its fixed scene revision is verified.
    // The caller publishes its record/node together; failed encoding or a
    // stale revision must not appear as a successful library asset.
    if (!scope?.stageOnly) { project.assets[id] = rec; store.touch(); renderLibrary(); }
    return rec;
  }

  // 上传响应校验（本站合同）：https url 指向 /reference-assets/；扩展名与 kind 一致；
  // kind/content_type 与声明类型一致；expires_at 必须在未来；duration_seconds 类型正确才采纳。
  const EXT_BY_KIND = { image: ['png', 'jpg', 'jpeg', 'webp'], video: ['mp4', 'webm'], audio: ['mp3', 'wav', 'm4a'] };
  function validateUploadResponse(info, kind, keyFp) {
    if (!info || typeof info.url !== 'string') throw new Error('上传响应缺少有效 url');
    let u; try { u = new URL(info.url); } catch { throw new Error('上传响应 url 不合法'); }
    const provider = api.providerInfo?.() ?? DEFAULT_PROVIDER;
    const target = new URL(upstreamUrl(provider, '/reference-assets/'));
    if (u.protocol !== target.protocol || u.origin !== target.origin || u.username || u.password || u.hash ||
      !u.pathname.startsWith(target.pathname)) throw new Error('上传响应 url 不是本站素材地址或当前服务商素材地址');
    const ext = u.pathname.split('.').pop()?.toLowerCase();
    if (EXT_BY_KIND[kind] && !EXT_BY_KIND[kind].includes(ext)) throw new Error(`上传响应扩展名 .${ext} 与素材类型不符`);
    if (info.kind != null && info.kind !== kind) throw new Error(`上传响应 kind=${info.kind} 与素材类型不符`);
    if (info.content_type != null && fileKind({ type: info.content_type }) !== kind) throw new Error(`上传响应 content_type=${info.content_type} 与素材类型不符`);
    if (!Number.isFinite(info.expires_at) || info.expires_at * 1000 <= Date.now()) throw new Error('上传响应缺少有效 expires_at');
    const r = { url: info.url, uploadedAt: Date.now(), expiresAt: info.expires_at, keyFp };
    if (typeof info.id === 'string') r.assetId = info.id;
    r.durationSeconds = Number.isFinite(info.duration_seconds) ? info.duration_seconds : null;
    if (kind === 'video' && r.durationSeconds == null) r.durationUntrusted = true;
    return r;
  }

  // 素材本地版本（仅会话内不落盘）：rebind 成功 / removeAsset 删除或墓碑化时推进。
  // 在飞 upload/rebind 以「同一素材对象 + 版本」核验——同 size/mime 的重绑也能识别，
  // 绝不把旧文件内容的上传/重绑结果写到新内容上。
  const revs = new WeakMap();
  const revOf = a => revs.get(a) ?? 0;
  const bumpRev = a => revs.set(a, revOf(a) + 1);

  // 身份在调用开始即捕获；读 blob、发请求、收响应三个阶段都核验指纹、项目与素材版本。
  // 在飞碰撞守卫：上传期间素材被强制删除（墓碑/移除）或重绑了新文件 → 结果一律作废，
  // 绝不把已删除的墓碑再次标成「上传成功」，也不把旧 remote 绑到新文件上。
  async function upload(id, { signal, keyFp } = {}) {
    const project = store.project;
    const a = project?.assets?.[id]; if (!a) throw new Error('素材不存在');
    if (a.missing || a.deletedAt) throw new Error(`素材「${a.name}」本地文件缺失或已删除，请先重绑`);
    const fp = keyFp ?? getFingerprint();
    const sizeAt = a.size, mimeAt = a.mime, revAt = revOf(a);
    const file = await blobOf(id);
    if (store.project !== project || project.assets[id] !== a)
      throw Object.assign(new Error('密钥或项目已变更，上传未发送'), { code: 'identity_changed' });
    if (!file) { a.missing = true; store.touch(); throw new Error(`素材「${a.name}」本地文件缺失`); }
    if (revOf(a) !== revAt)
      throw Object.assign(new Error('素材在上传前已重绑，上传未发送'), { code: 'asset_rebound' });
    if (getFingerprint() !== fp)
      throw Object.assign(new Error('密钥或项目已变更，上传未发送'), { code: 'identity_changed' });
    const info = await api.uploadAsset(file, { signal });
    if (getFingerprint() !== fp || store.project !== project)
      throw Object.assign(new Error('密钥或项目在上传期间已变更，结果丢弃'), { code: 'identity_changed' });
    if (project.assets[id] !== a || a.missing || a.deletedAt)
      throw Object.assign(new Error('素材在上传期间已删除，结果未写入'), { code: 'asset_removed' });
    if (a.size !== sizeAt || a.mime !== mimeAt || revOf(a) !== revAt)
      throw Object.assign(new Error('素材在上传期间已重绑，结果作废'), { code: 'asset_rebound' });
    a.remote = validateUploadResponse(info, a.kind, fp);
    store.touch(); renderLibrary(); return a.remote;
  }

  // 远端可用性：有 url、未过期（留 2 分钟余量）、属于当前密钥
  function remoteValid(a) {
    const r = a?.remote;
    return !!r?.url && Number.isFinite(r.expiresAt) && r.expiresAt * 1000 - Date.now() > EXPIRY_MARGIN_MS && r.keyFp === getFingerprint();
  }
  // 不按 assetId 做在飞去重：assetId 可能跨项目共享（旧副本/旧导入），复用旧 Promise
  // 会把旧项目/旧密钥指纹/旧 signal 的上传结果错发给新调用方，取消一个 signal 还会
  // 误伤另一请求。每次调用独立上传，只写回自己捕获的项目对象/素材对象/版本，互不干扰。
  async function ensureRemote(id, opts) {
    const a = store.project?.assets?.[id]; if (!a) throw new Error('素材不存在');
    if (remoteValid(a)) return a.remote;
    return upload(id, opts);
  }

  // 重绑校验（纯函数，可测）：类型须一致、文件非空且不超该类型大小上限
  function validateRebind(a, file) {
    if (!a) return '素材不存在';
    if (!file || typeof file.size !== 'number') return '未选择有效文件';
    const kind = fileKind(file);
    if (kind !== a.kind) return `类型不符：需要 ${KIND_LABEL[a.kind] ?? a.kind}`;
    const max = fileMaxBytes(a.kind);
    if (!file.size || file.size > max) return `文件为空或超过 ${UPLOAD_LIMITS()?.[a.kind]?.max_mib ?? '?'}MiB 上限`;
    return '';
  }

  // 同一 assetId 的重绑串行化（素材级锁，非项目全局锁）：防止两次重绑交错，
  // 也保证「写入后被删除」的清理不会误删排队中下一次重绑刚写的内容。
  const rebindQueue = new Map();
  function rebindFile(assetId, file) {
    // 调用即捕获项目与素材身份：排队等待期间项目可能已切换——轮到执行时
    // 绝不能再抓「当前项目」，否则会把文件绑到另一项目的同名素材上
    const project = store.project;
    const a = project?.assets?.[assetId];
    if (!a) return Promise.resolve(null);
    const prior = rebindQueue.get(assetId) ?? Promise.resolve();
    const p = prior.then(() => rebindFileNow(assetId, file, project, a));
    const tail = p.then(() => {}, () => {});
    rebindQueue.set(assetId, tail);
    tail.then(() => { if (rebindQueue.get(assetId) === tail) rebindQueue.delete(assetId); });
    return p;
  }
  // 重新绑定素材的本地文件（导入/换机/墓碑恢复）：与入库同样校验类型与大小。
  // project/a 由 rebindFile 在调用时捕获传入；轮到执行时先复核身份——
  // 项目已切换或素材已删除/替换 → 明确拒绝，绝不动当前项目里的同名素材。
  // 每个 await 之后都核验「同一项目 + 同一素材对象 + 同一本地版本」。
  // 写 blob 后失效按原因区分回滚：项目切换 → 恢复原 blob；素材被删除/墓碑化 →
  // 清掉本次写入（不回滚 prev——删除是更晚的用户意图，也绝不覆盖后续重绑内容）。
  async function rebindFileNow(assetId, file, project, a) {
    if (store.project !== project || project.assets[assetId] !== a) {
      toast('项目已切换或素材已变更，重绑未生效', 'warn'); return null;
    }
    const err = validateRebind(a, file);
    if (err) { toast(err, 'err'); return null; }
    const key = blobKey(assetId);
    const revAt = revOf(a);
    const alive = () => store.project === project && project.assets[assetId] === a && revOf(a) === revAt;
    // blob:assetId 是全局键（项目副本可共享同一 assetId）：写前先留存原 blob，
    // 供写入后项目切换时回滚，不污染另一项目同名素材的内容。
    const prev = await blobOf(assetId);
    if (!alive()) { toast('项目已切换或素材已变更，重绑未生效', 'warn'); return null; }
    // blob:assetId 是全局键：历史项目（旧副本/旧导入）可能仍共用同一文件本体，
    // 直接覆盖会篡改其他项目内容——阻止破坏性重绑，引导用户另上传为新素材。
    const shared = await blobSharedElsewhere(assetId, project);
    if (!alive()) { toast('项目已切换或素材已变更，重绑未生效', 'warn'); return null; }
    if (shared) {
      toast(`「${a.name}」与其他项目共享同一文件本体，重绑会改动其他项目内容；请用「添加文件」另上传为新素材`, 'err', 7000);
      return null;
    }
    await storage.setBlob(key, file);
    if (store.project !== project) {
      try { prev ? await storage.setBlob(key, prev) : await storage.delBlob(key); }
      catch { /* 回滚尽力而为 */ }
      toast('项目已切换，重绑未生效', 'warn'); return null;
    }
    if (project.assets[assetId] !== a || revOf(a) !== revAt) {
      // 写入期间素材被删除/墓碑化：本次写入作废并清理，不复活记录、不回滚旧 blob
      try { await storage.delBlob(key); } catch { /* 清理尽力而为 */ }
      toast('素材在重绑期间已删除，重绑未生效', 'warn'); return null;
    }
    bumpRev(a);   // 推进本地版本：在飞 upload 等凭旧版本核验的调用一律作废
    a.missing = false; delete a.deletedAt; a.size = file.size; a.mime = file.type; a.remote = null;
    a.contentRevision = uid('media'); // 工作流跨重载复核：同大小文件重绑也属于新的素材内容。
    delete a.sha256; // Rebound bytes must never inherit the old immutable content digest.
    const u = urls.get(assetId);
    if (u) { try { URL.revokeObjectURL?.(u); } catch { /* 忽略回收失败 */ } urls.delete(assetId); }
    store.touch(); renderLibrary();
    return a;
  }

  // ---------- 分类 / 标签 / 收藏 / 合集 / 检索 ----------

  // 合集存于 project.studio.assetCollections：[{id,name,assetIds}]（单归属，文件夹语义）
  const collectionList = (project = store.project) => {
    if (!project) return [];
    const st = studioState(project);
    return st.assetCollections ??= [];
  };
  function listCollections() { return collectionList(); }
  function createCollection(name) {
    const title = String(name ?? '').trim().slice(0, 60);
    if (!title) { toast('合集名不能为空', 'err'); return null; }
    const c = { id: uid('c'), name: title, assetIds: [] };
    collectionList().push(c); store.touch({ type: 'data' }); return c;
  }
  function renameCollection(id, name) {
    const c = collectionList().find(x => x.id === id); if (!c) return null;
    const title = String(name ?? '').trim().slice(0, 60);
    if (!title) return null;
    c.name = title; store.touch({ type: 'data' }); return c;
  }
  function deleteCollection(id) {
    const list = collectionList();
    const i = list.findIndex(x => x.id === id); if (i < 0) return false;
    list.splice(i, 1); store.touch({ type: 'data' }); return true;   // 仅删合集，素材保留
  }
  function setAssetCollection(assetId, collectionId) {
    const list = collectionList();
    const target = collectionId ? list.find(c => c.id === collectionId) : null;
    if (collectionId && !target) return false;
    for (const c of list) c.assetIds = c.assetIds.filter(x => x !== assetId);
    if (target) target.assetIds.push(assetId);
    store.touch({ type: 'data' }); return true;
  }
  function collectionOf(assetId) { return collectionList().find(c => c.assetIds.includes(assetId)) ?? null; }

  function setCategory(id, category) {
    const a = store.project?.assets?.[id]; if (!a || !ASSET_CATEGORIES[category]) return null;
    a.category = category; store.touch(); return a;
  }
  const normTags = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,，]/)).map(t => String(t).trim()).filter(Boolean).slice(0, 20);
  function tagList(a) { return normTags(a?.tags); }
  function setTags(id, tags) {
    const a = store.project?.assets?.[id]; if (!a) return null;
    a.tags = normTags(tags).join(',').slice(0, 500); store.touch(); return a;
  }
  function setFavorite(id, fav = true) {
    const a = store.project?.assets?.[id]; if (!a) return null;
    a.favorite = fav === true; store.touch(); return a;
  }

  // 组合检索：kind/category/collectionId/favorite/tag/text（名称+标签+MIME）
  function queryAssets(q = {}) {
    const items = Object.values(store.project?.assets ?? {});
    const text = String(q.text ?? '').trim().toLowerCase();
    return items.filter(a => {
      if (q.kind && a.kind !== q.kind) return false;
      if (q.category && (a.category ?? 'other') !== q.category) return false;
      if (q.favorite && a.favorite !== true) return false;
      if (q.collectionId) {
        const c = collectionList().find(x => x.id === q.collectionId);
        if (!c?.assetIds.includes(a.id)) return false;
      }
      if (q.tag && !tagList(a).includes(q.tag)) return false;
      if (text && !`${a.name} ${a.tags ?? ''} ${a.mime ?? ''}`.toLowerCase().includes(text)) return false;
      return true;
    }).sort((x, y) => (y.favorite === true) - (x.favorite === true) || (y.addedAt ?? 0) - (x.addedAt ?? 0));
  }

  // 引用位置扫描。同步部分：节点（素材绑定/结果/输出/草稿@绑定/perModel/导演台内嵌场景）
  // + 分镜 + 时间线。异步 assetRefs 在此基础上再查导演台 KV 与任务快照。
  const XP_TOKEN = 'xp-asset://';
  function textHasXpAsset(v, assetId) {
    let text;
    try { text = JSON.stringify(v); } catch { return false; }
    if (typeof text !== 'string' || !text.includes(XP_TOKEN)) return false;
    const needle = XP_TOKEN + assetId;
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      const nx = text[i + needle.length];
      if (!nx || !/[A-Za-z0-9_-]/.test(nx)) return true;   // token 边界，防 id 前缀误命中
    }
    return false;
  }
  function assetRefsLocal(assetId) {
    const p = store.project; const refs = [];
    if (!p) return refs;
    for (const n of p.nodes) {
      const d = n.data ?? {};
      const hit = d.assetId === assetId || d.resultAssetId === assetId ||
        (Array.isArray(d.outputAssetIds) && d.outputAssetIds.includes(assetId)) ||
        Object.values(d.draft?.bindings ?? {}).includes(assetId) ||
        Object.values(d.perModel ?? {}).some(sd => Object.values(sd?.bindings ?? {}).includes(assetId));
      if (hit) refs.push({ type: 'node', id: n.id, title: d.title || n.type });
      else if (n.type === 'director' && textHasXpAsset(d, assetId))
        refs.push({ type: 'director', id: n.id, title: d.title || '导演台' });
    }
    for (const s of p.studio?.shots ?? []) if (s.assetIds?.includes(assetId)) refs.push({ type: 'shot', id: s.id, title: s.title || s.id });
    for (const c of p.studio?.timeline ?? []) if (c.assetId === assetId) refs.push({ type: 'timeline', id: c.id });
    return refs;
  }
  // 完整引用扫描（异步）：本地引用 + 导演台 KV（dir:/dircfg:）内 xp-asset://<id> 资源——
  // GLB/纹理可经 asset.embed 入库而没有素材节点，删除前必须识别——
  // + fromDirector 保守守卫 + 待创建/进行中任务快照（refIds/frameIds/draft.bindings）。
  async function assetRefs(assetId) {
    const p = store.project;
    if (!p) return [];
    const refs = assetRefsLocal(assetId);
    const seen = new Set(refs.map(r => `${r.type}:${r.id}`));
    const push = r => { const k = `${r.type}:${r.id}`; if (!seen.has(k)) { seen.add(k); refs.push(r); } };
    // 单趟 keys：导演台 KV（dir:/dircfg: 全局键，保守扫描）+ 本项目命名空间下的
    // 待创建快照（pending:<pid>:，绑定入口捕获的项目 id——await 期间切项目不会扫到新项目记录）。
    let keys = [];
    try { keys = await storage.keys(); } catch { keys = []; }
    for (const k of keys) {
      if (k.startsWith('dir:') || k.startsWith('dircfg:')) {
        try {
          if (textHasXpAsset(await storage.get(k), assetId)) {
            const m = k.match(/^(?:dir|dircfg):([^:]+):/);
            push({ type: 'director', id: `kv:${m?.[1] ?? k}`, title: `导演台场景（${m?.[1] ?? k}）` });
          }
        } catch { /* 单条 KV 失败不影响其余扫描 */ }
      } else if (k.startsWith(`pending:${p.id}:`)) {
        try {
          const r = await storage.get(k);
          const s = r?.snapshot;
          if (s && (s.refIds?.includes(assetId) || s.frameIds?.includes(assetId) ||
            Object.values(s.draft?.bindings ?? {}).includes(assetId) ||
            Object.values(s.perModel ?? {}).some(sd => Object.values(sd?.bindings ?? {}).includes(assetId))))
            push({ type: 'pending', id: r?.idempotencyKey ?? k, title: '待确认生成任务' });
        } catch { /* 同上 */ }
      }
    }
    const a = p.assets?.[assetId];
    if (a?.fromDirector && p.nodes.some(n => n.id === a.fromDirector && n.type === 'director'))
      push({ type: 'director', id: a.fromDirector, title: '导演台来源' });
    return refs;
  }
  // 共享身份保守检查：其他项目文档的 assets 表持有同一 assetId 即视为共享 blob:<assetId> 全局键。
  // 扫描失败按「共享」处理——宁可保留 blob，绝不误删/误改其他项目的数据。
  async function blobSharedElsewhere(assetId, project) {
    try {
      for (const k of await storage.keys()) {
        if (!k.startsWith('project:') || k === `project:${project.id}`) continue;
        const p = await storage.get(k);
        if (p?.assets && Object.prototype.hasOwnProperty.call(p.assets, assetId)) return true;
      }
      return false;
    } catch { return true; }
  }

  // 删除素材：仍被引用（含导演台场景/待确认任务快照）时默认拒绝。
  // force 时引用一律转为显式缺失而非静默过滤：素材节点 assetId→null+needsRebind；
  // resultAssetId/outputAssetIds/draft.bindings/perModel/分镜 assetIds/时间线/导演台 KV
  // 令牌/任务快照全部保留原 id——解析到缺失素材即为占位标记，生成侧据此拒绝。
  // 有引用的首次 force 删除保留素材记录为 missing 墓碑（合集归属不丢），可重绑恢复；
  // 墓碑上再次 force（或无引用删除）→ 记录彻底移除。
  async function removeAsset(assetId, { force = false } = {}) {
    const project = store.project;
    const a = project?.assets?.[assetId]; if (!a) return false;
    const refs = await assetRefs(assetId);
    // 每个 await 之后都核验项目身份：扫描期间切换项目即中止，refs 与删除只作用于发起项目
    if (store.project !== project) { toast('项目已切换，删除已中止', 'warn'); return false; }
    if (refs.length && !force) {
      const where = refs.slice(0, 5).map(r => r.title || r.id).join('、');
      toast(`素材仍被 ${refs.length} 处引用（${where}），未删除`, 'err', 5000);
      return false;
    }
    // 老共享身份保守检查：其他项目还持有同一 assetId 时，物理 blob 不属于本项目独占
    const shared = await blobSharedElsewhere(assetId, project);
    if (store.project !== project) { toast('项目已切换，删除已中止', 'warn'); return false; }
    // 共享 blob 绝不删；非共享时先删 blob 再改记录：delBlob 失败则素材记录与引用
    // 原样保留（可重试恢复），不假报成功、不留「记录没了文件还在」的半删除态
    if (!shared) {
      try { await storage.delBlob(blobKey(assetId)); }
      catch (e) {
        toast(`本地文件删除失败：${e.message}——素材记录与引用未改动，可重试`, 'err', 6000);
        return false;
      }
    }
    // 以下同步变更写入捕获的发起项目对象：delBlob 之后无 await，不与其他操作交错；
    // 即使期间项目已切走也照写旧项目对象并尽力补落盘，绝不污染新项目
    bumpRev(a);   // 推进本地版本：在飞 upload/rebind 一律作废
    if (refs.length) {
      for (const n of project.nodes) {
        const d = n.data ?? {};
        if (d.assetId === assetId) { d.assetId = null; d.needsRebind = true; }
      }
    }
    const tombstone = refs.length > 0 && a.missing !== true;
    if (tombstone) {
      a.missing = true; a.remote = null; a.deletedAt = Date.now();   // 墓碑：可重绑恢复
    } else {
      delete project.assets[assetId];
      for (const c of collectionList(project)) c.assetIds = c.assetIds.filter(x => x !== assetId);
    }
    if (shared) {
      // 共享 blob 保留：只移除本项目的记录与引用，不物理删除其他项目还使用的文件本体；
      // 需要独立文件时请改用「添加文件」另上传新素材
      toast('该素材与其他项目共享文件本体：已仅移除本项目记录与引用，文件本体保留', 'warn', 6000);
    }
    if (store.project !== project) {
      // 切换时的 flush 可能早于本次变更：把「本次素材删除/墓碑 + 相关引用与合集变化」
      // 经 updateStoredProject 合并进存储稿——CAS 读改写只动该素材记录、引用它的节点与
      // 合集成员，绝不整篇盲写：外部新稿的节点/素材/改名一律保留；存储稿里仍引用该素材
      // 的节点同样转显式缺失（assetId→null+needsRebind），仍被引用时按墓碑保留可重绑。
      // 合并失败如实返回 false 不静默吞——记录仍留在存储稿，重新打开该项目后可重试。
      try {
        await store.updateStoredProject(project.id, doc => {
          let changed = false;
          const docReferenced = (doc.nodes ?? []).some(n => n.data?.assetId === assetId);
          for (const n of doc.nodes ?? []) {
            const d = n.data ?? {};
            if (d.assetId === assetId) { d.assetId = null; d.needsRebind = true; changed = true; }
          }
          const rec = doc.assets?.[assetId];
          const keep = rec != null && (tombstone || docReferenced);
          if (rec) {
            if (keep) {
              if (rec.missing !== true || rec.remote != null || rec.deletedAt == null) changed = true;
              rec.missing = true; rec.remote = null; rec.deletedAt = Date.now();
            } else {
              delete doc.assets[assetId]; changed = true;
            }
          }
          if (!keep) {
            for (const c of doc.studio?.assetCollections ?? []) {
              if (Array.isArray(c.assetIds) && c.assetIds.includes(assetId)) {
                c.assetIds = c.assetIds.filter(x => x !== assetId); changed = true;
              }
            }
          }
          if (!changed) return false;   // 存储稿无本素材痕迹：不重放不写，避免无意义 rev 推进
        });
      } catch (e) {
        toast(`删除结果保存失败：${e.message}——素材记录仍保留在存储中，重新打开该项目后可重试`, 'err', 6000);
        return false;
      }
    }
    const u = urls.get(assetId);
    if (u) { try { URL.revokeObjectURL?.(u); } catch { /* 忽略回收失败 */ } urls.delete(assetId); }
    if (store.project === project) { store.touch({ type: 'structure' }); renderLibrary(); }
    return true;
  }

  function assetOfNode(node) {
    if (node?.type !== 'asset') return null;
    const id = node.data.assetId;
    return id ? store.project.assets[id] ?? null : null;
  }

  function renderLibrary() {
    if (typeof document === 'undefined') return;   // 非浏览器环境（单测）跳过 DOM
    const list = document.getElementById('asset-list');
    if (!list) return;
    const items = Object.values(store.project?.assets ?? {});
    list.replaceChildren(...items.map(a => {
      const badge = a.missing ? ['err', '缺文件'] : remoteValid(a) ? ['ok', '已上传'] : ['warn', '本机'];
      const item = el('div', { class: 'asset-item', draggable: 'true', 'data-asset': a.id },
        el('div', { class: 'meta' }, el('b', { text: a.name }), el('small', { text: `${KIND_LABEL[a.kind] ?? a.kind} · ${fmtBytes(a.size)}` })),
        el('span', { class: `badge ${badge[0]}`, text: badge[1] }),
        el('button', { class: 'mini', type: 'button', text: '＋节点', title: '在画布可视区生成素材节点' }));
      item.addEventListener('dragstart', e => e.dataTransfer.setData('text/x-asset', a.id));
      item.querySelector('button').addEventListener('click', () => onSpawnNode?.(a.id));
      if (a.kind === 'image') objectURL(a.id).then(u => { if (u) item.prepend(el('img', { src: u, alt: '' })); }).catch(() => {});
      return item;
    }));
    if (!items.length) list.append(el('p', { class: 'hint', text: '尚无素材' }));
  }

  function assetBody(node) {
    const a = assetOfNode(node);
    if (!a) return el('div', { text: '素材未绑定（导入缺失）— 在检查器中重新选择文件' });
    const box = el('div', {});
    if (a.missing) {
      box.append(el('div', { class: 'badge err', text: '本地文件缺失' }));
      return box;
    }
    if (['image', 'video'].includes(a.kind)) {
      const open = e => { e.stopPropagation(); preview(a.id); };
      const frame = el('div', { class: 'asset-preview-frame' }); box.append(frame);
      if (a.kind === 'image') {
        const target = el('button', { type: 'button', class: 'asset-preview-image', title: '点击放大预览', 'aria-label': `放大预览 ${a.name}`, onclick: open });
        frame.append(target);
        objectURL(a.id).then(u => { if (u) target.append(el('img', { class: 'preview', src: u, alt: a.name, draggable: false })); }).catch(() => {});
      } else {
        objectURL(a.id).then(u => { if (u) frame.prepend(el('video', { class: 'preview', src: u, controls: true, muted: true, playsinline: true })); }).catch(() => {});
      }
      frame.append(el('button', { type: 'button', class: 'asset-preview-open', text: '放大预览', 'aria-label': `打开大预览 ${a.name}`, onclick: open }));
    }
    if (a.kind === 'audio') objectURL(a.id).then(u => { if (u) box.prepend(el('audio', { src: u, controls: true, style: 'width:100%' })); }).catch(() => {});
    box.append(
      el('div', { class: 'row' }, el('span', { text: '类型' }), el('b', { text: KIND_LABEL[a.kind] ?? a.kind })),
      el('div', { class: 'row' }, el('span', { text: '大小' }), el('b', { text: fmtBytes(a.size) })),
      el('div', { class: 'row' }, el('span', { text: '远端' }), el('b', { text: remoteValid(a) ? `有效 ·剩${fmtCountdown(a.remote.expiresAt)}` : '未上传/需重传' })),
    );
    return box;
  }

  const preview = assetId => openMediaPreview({ store, assets: { blobOf }, assetId });
  return { addFiles, registerBlob, upload, ensureRemote, remoteValid, validateUploadResponse, objectURL, blobOf, preview, rebindFile, validateRebind, assetOfNode, renderLibrary, assetBody,
    setCategory, setTags, tagList, setFavorite, queryAssets, assetRefs, assetRefsLocal, removeAsset,
    createCollection, renameCollection, deleteCollection, listCollections, setAssetCollection, collectionOf };
}
