// 项目状态：节点/边/素材/任务/待创建幂等记录；持久化到 storage（IndexedDB）。
// 任务与待创建记录按项目命名空间隔离；导出为白名单 JSON（无密钥）；导入严格校验 + 全量重映射。

import { STUDIO_TYPES, sanitizeStudioNode, importStudio, sanitizeMeta, stripRuntime } from './studio-schema.js';
import { TASK_REC_VERSION, TASK_TERMINAL, isSupportedTaskRecord } from './task-status.js';
import { DIRECTOR_DOCUMENT_FORMAT, directorDocumentKey } from './director-protocol.js';
export const NODE_TYPES = {
  ...STUDIO_TYPES,
  asset:    { title: '素材',   ports: { out: [{ id: 'out', kind: 'media', label: '输出' }] } },
  gen:      { title: '视频生成', ports: { in: [{ id: 'prompt', kind: 'text', label: '提示词' }, { id: 'frames', kind: 'image', label: '首尾帧' }, { id: 'refs', kind: 'media', label: '素材' }], out: [{ id: 'out', kind: 'video', label: '成片' }] } },
  director: { title: '3D 导演台', ports: { in: [{ id: 'refs', kind: 'media', label: '素材' }] } },
  note:     { title: '便签',   ports: {} },
};

export function uid(prefix = 'n') {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)}`;
}

export function portAccepts(portKind, assetKind) {
  if (portKind === 'any') return ['image','video','audio','media','text','any'].includes(assetKind);
  if (portKind === 'media') return ['image', 'video', 'audio'].includes(assetKind);
  return portKind === assetKind;
}

// 秘密字段黑名单：导入（及出口校验）共用的密钥字段判定——防导出文件被植入密钥。
// 键名归一化（小写、去空白与 _-. 分隔符）后分两层：
//  · 凭据名（apikey/authorization/bearer/secret/password/accesstoken/refreshtoken 等）
//    子串命中即密钥——与值类型无关，数值值同样拒绝；
//  · 其余含 token 的键：仅「计量名 + 有限数值」放行（本站真实使用的 max_tokens 等
//    token 计数/额度参数）；字符串值按借计量名夹带凭据处理，裸 token 与未知 *token 键同拒。
const SECRET_NAME_RE = /apikey|authorization|bearer|secret|password|passwd|credential|privatekey|signingkey|encryptionkey|accesstoken|refreshtoken|idtoken|authtoken|oauthtoken|sessiontoken|csrftoken|xsrftoken|jwt/;
const TOKEN_METER_RE = /^(?:(?:max|min|num|total|input|output|prompt|completion|response|context|remaining|used|usage)tokens?|tokens|tokens?(?:count|limit|quota|usage|used|budget|remaining|requests|price|cost|rate|perrequest|perminute)s?)$/;
const isSecretEntry = (k, v) => {
  const nk = String(k).toLowerCase().replace(/[\s_.-]+/g, '');
  if (SECRET_NAME_RE.test(nk)) return true;
  if (!nk.includes('token')) return false;
  return !(TOKEN_METER_RE.test(nk) && typeof v === 'number' && Number.isFinite(v));
};
// 素材重映射“失效”哨兵：被 @绑定/输出列表引用、但源数据里不存在的素材 → 哨兵（真值）让
// resolvePromptRefs 记入 missing 显式拒绝，而不是静默回退到同位置的其他素材。
const MISSING_ASSET = '__missing__';
// 迭代 + 已访问集合的完整遍历：不设深度截断（第 9 层密钥照样拒绝），循环引用安全不栈溢出；
// 有界保护——扫描条目超上限按含密钥处理：宁可拒绝，不放过超限结构。
export function containsSecret(value) {
  const seen = new Set();
  const stack = [value];
  let scanned = 0;
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (++scanned > 200000) return true;
      if (isSecretEntry(k, v)) return true;
      if (v !== null && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 2048) => typeof v === 'string' && v.length <= max;
const num = v => typeof v === 'number' && Number.isFinite(v);

// New hosted documents keep binding fields as well as stable ref tokens. Both
// must move together when importing/cloning a canvas project.
function directorBindings(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('导演人物参考图清单不合法');
  return value.map(row => {
    if (!isObj(row) || !str(row.characterId, 128) || !str(row.assetId, 128) ||
        row.ref !== `xp-asset://${row.assetId}` || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
      throw new Error('导演人物参考图身份或摘要不合法');
    return { characterId: row.characterId, assetId: row.assetId, ref: row.ref, sha256: row.sha256 };
  });
}
function remapDirectorBindings(value, assetIdMap) {
  return directorBindings(value).map(row => {
    const assetId = assetIdMap.get(row.assetId) ?? row.assetId;
    return { ...row, assetId, ref: `xp-asset://${assetId}` };
  });
}
function remapDirectorRecord(value, { oldProjectId, oldNodeId, projectId, nodeId, assetIdMap }) {
  if (!isObj(value) || value.format !== DIRECTOR_DOCUMENT_FORMAT || !Number.isSafeInteger(value.rev) || value.rev < 1)
    throw new Error('导演工程版本不受支持，导入未提交，原工程包保留');
  if (value.projectId !== oldProjectId || value.nodeId !== oldNodeId)
    throw new Error('导演工程项目或节点绑定不一致');
  const remapRef = ref => {
    const m = typeof ref === 'string' && /^xp-asset:\/\/([A-Za-z0-9_-]+)$/.exec(ref);
    if (!m) throw new Error('导演工程素材引用不合法');
    return `xp-asset://${assetIdMap.get(m[1]) ?? m[1]}`;
  };
  if (!isObj(value.scene) || !/^[a-f0-9]{64}$/.test(value.scene.projectSha256 ?? '') || !Array.isArray(value.dependencies))
    throw new Error('导演工程场景或依赖清单不合法');
  const scene = { ...value.scene, projectRef: remapRef(value.scene.projectRef) };
  if (value.scene.characterBindings) scene.characterBindings = remapDirectorBindings(value.scene.characterBindings, assetIdMap);
  const dependencies = value.dependencies.map(dep => {
    if (!isObj(dep) || !/^[a-f0-9]{64}$/.test(dep.sha256 ?? '')) throw new Error('导演工程依赖摘要不合法');
    const ref = remapRef(dep.ref);
    const oldId = /^xp-asset:\/\/([A-Za-z0-9_-]+)$/.exec(dep.ref)[1];
    if (dep.assetId != null && dep.assetId !== oldId) throw new Error('导演工程依赖身份不一致');
    return { ...dep, ref, assetId: assetIdMap.get(oldId) ?? oldId };
  });
  if (!dependencies.some(dep => dep.ref === scene.projectRef && dep.sha256 === scene.projectSha256))
    throw new Error('导演工程依赖清单缺少完整工程');
  return { ...value, projectId, nodeId, scene, dependencies };
}

const sha256Blob = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
  .map(value => value.toString(16).padStart(2, '0')).join('');

function sanitizeAsset(a) {
  if (!isObj(a) || !str(a.id, 128) || !str(a.name, 512)) return null;
  const kind = ['image', 'video', 'audio', 'file'].includes(a.kind) ? a.kind : 'file';
  const out = { id: a.id, name: a.name, kind, mime: str(a.mime, 128) ? a.mime : 'application/octet-stream', size: num(a.size) ? a.size : 0, addedAt: num(a.addedAt) ? a.addedAt : Date.now() };
  // 远端地址不随导出迁移（24h 过期 + 绑定密钥指纹）；缺本地 blob 的素材标记 missing
  out.missing = true;
  if (a.fromDirector != null && str(a.fromDirector, 128)) out.fromDirector = '__node__:' + a.fromDirector;
  if (a.fromTask != null && str(a.fromTask, 256)) out.fromTask = a.fromTask;
  if (str(a.category, 40)) out.category = a.category;
  if (str(a.tags, 500)) out.tags = a.tags;
  if (typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256)) out.sha256 = a.sha256;
  if (str(a.directorRole, 64)) out.directorRole = a.directorRole;
  if (str(a.directorObjectId, 128)) out.directorObjectId = a.directorObjectId;
  if (isObj(a.directorOutput)) out.directorOutput = {
    sceneRevision: Number.isSafeInteger(a.directorOutput.sceneRevision) ? a.directorOutput.sceneRevision : null,
    shotId: str(a.directorOutput.shotId, 128) ? a.directorOutput.shotId : null,
    frameIndex: Number.isSafeInteger(a.directorOutput.frameIndex) ? a.directorOutput.frameIndex : null,
    fps: [24, 30].includes(a.directorOutput.fps) ? a.directorOutput.fps : null,
    frameCount: Number.isSafeInteger(a.directorOutput.frameCount) ? a.directorOutput.frameCount : null,
  };
  out.favorite = a.favorite === true;
  return out;
}
const sanitizeSwitches = sw => isObj(sw) ? { generate_audio: sw.generate_audio === true ? true : sw.generate_audio === false ? false : undefined, face_mode: sw.face_mode === true } : {};
function sanitizeDraft(dr) {
  if (!isObj(dr)) return null;
  const out = {
    model: str(dr.model, 128) ? dr.model : 'minimax-h3-768p-per-second',
    prompt: str(dr.prompt, 200000) ? dr.prompt : '',
    intent: str(dr.intent, 32) ? dr.intent : 'text',
    seconds: num(dr.seconds) ? Math.round(dr.seconds) : 5,
    ratio: str(dr.ratio, 16) ? dr.ratio : '16:9',
    switches: sanitizeSwitches(dr.switches),
  };
  // @引用稳定绑定：'kind:N' → assetId（导入时统一重映射）
  if (isObj(dr.bindings)) {
    out.bindings = {};
    for (const [k, v] of Object.entries(dr.bindings)) {
      if (/^(image|video|audio):\d{1,4}$/.test(k) && str(v, 128)) out.bindings[k] = '__asset__:' + v;
    }
  }
  return out;
}
// perModel 只缓存“该型号下的控件设置”：绝不写 model/prompt——切换型号时展开会覆盖公共草稿（R03）。
// 不补默认值：缺省字段让切换逻辑回退到该型号默认，而不是被导入时补的旧值覆盖。
function sanitizePerModel(dr) {
  if (!isObj(dr)) return null;
  const out = {};
  if (str(dr.intent, 32)) out.intent = dr.intent;
  if (num(dr.seconds)) out.seconds = Math.round(dr.seconds);
  if (str(dr.ratio, 16)) out.ratio = dr.ratio;
  if (isObj(dr.switches)) out.switches = sanitizeSwitches(dr.switches);
  if (isObj(dr.bindings)) {
    out.bindings = {};
    for (const [k, v] of Object.entries(dr.bindings)) {
      if (/^(image|video|audio):\d{1,4}$/.test(k) && str(v, 128)) out.bindings[k] = '__asset__:' + v;
    }
  }
  return out;
}
function sanitizeNode(n) {
  if (!isObj(n) || !str(n.id, 128) || !NODE_TYPES[n.type] || !num(n.x) || !num(n.y) || Math.abs(n.x) > 1e6 || Math.abs(n.y) > 1e6) return null;
  const data = {};
  const d = isObj(n.data) ? n.data : {};
  if (str(d.title, 256)) data.title = d.title;
  if (d.locked === true) data.locked = true;
  switch (n.type) {
    case 'text': case 'image': case 'utility':
      Object.assign(data, sanitizeStudioNode(d));
      break;
    case 'asset':
      if (str(d.assetId, 128)) data.assetId = '__asset__:' + d.assetId;
      break;
    case 'gen': {
      if (typeof d.directOutput === 'boolean') data.directOutput = d.directOutput;
      data.draft = sanitizeDraft(d.draft) ?? sanitizeDraft({});
      data.perModel = {};
      if (isObj(d.directorSource) && str(d.directorSource.nodeId, 128)) data.directorSource = {
        nodeId: d.directorSource.nodeId,
        sceneRevision: Number.isSafeInteger(d.directorSource.sceneRevision) ? d.directorSource.sceneRevision : null,
        shotId: str(d.directorSource.shotId, 128) ? d.directorSource.shotId : null,
        characterBindings: directorBindings(d.directorSource.characterBindings),
      };
      if (isObj(d.perModel)) for (const [k, v] of Object.entries(d.perModel)) {
        if (!str(k, 128)) continue;
        const sd = sanitizePerModel(v); if (sd) data.perModel[k] = sd;
      }
      if (str(d.resultAssetId, 128)) data.resultAssetId = '__asset__:' + d.resultAssetId;
      break;
    }
    case 'director':
      if (d.editorState != null && isObj(d.editorState)) data.editorState = d.editorState;
      break;
    case 'note':
      data.text = str(d.text, 20000) ? d.text : '';
      break;
  }
  return { id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), data };
}
// 非法连线 → 抛出（整份导入拒绝），不静默丢线让用户在残缺图上收费生成。
// 与 addEdge 同一合同：拒绝自环与端口类型不兼容（asset 节点 media 出口按素材实际
// kind 判定；素材记录缺失时按可重绑占位放行）；重复连线由调用方按 (to.node,to.port,from.node) 去重。
function sanitizeEdge(e, srcNodes, srcAssets = {}) {
  if (!isObj(e) || !isObj(e.from) || !isObj(e.to)) throw new Error('连线数据不合法');
  if (!srcNodes.has(e.from.node) || !srcNodes.has(e.to.node)) throw new Error('连线端点缺失，导入被拒绝');
  if (e.from.node === e.to.node) throw new Error('连线不允许自环，导入被拒绝');
  const target = NODE_TYPES[srcNodes.get(e.to.node).type];
  const inPort = target.ports.in?.find(p => p.id === e.to.port);
  if (!inPort) throw new Error('连线端口不存在，导入被拒绝');
  const source = NODE_TYPES[srcNodes.get(e.from.node).type];
  if (!str(e.from.port, 64) || !source.ports.out?.some(p => p.id === e.from.port)) throw new Error('连线来源端口不合法');
  const outPort = source.ports.out.find(p => p.id === e.from.port);
  // 素材节点 media 出口按素材实际 kind 判定；无记录时按占位放行（导入后可重绑，运行时显式报缺）
  let outKind = outPort?.kind;
  if (outKind === 'media') {
    const rec = srcNodes.get(e.from.node)?.data?.assetId ? srcAssets[srcNodes.get(e.from.node).data.assetId] : null;
    outKind = rec?.kind ?? null;
  }
  const compat = outKind == null ? (outPort.kind === 'media' && ['image', 'video', 'audio', 'media', 'any'].includes(inPort.kind))
    : (outKind === 'any' || inPort.kind === 'any') ? true
    : portAccepts(inPort.kind, outKind);
  if (!compat) throw new Error(`连线端口类型不兼容（${outKind ?? '未登记素材'} → ${inPort.kind}），导入被拒绝`);
  return { id: str(e.id, 128) ? e.id : uid('e'), from: { node: e.from.node, port: e.from.port }, to: { node: e.to.node, port: e.to.port }, order: num(e.order) ? e.order : 0 };
}
const PENDING_STATES = new Set(['uncertain', 'rejected', 'conflict', 'abandoned', 'expired_window']);
// 写侧对账吸收态：已定性结局不得被迟到的泛型在途写（uncertain）回退（跨标签一致性）
const PENDING_ABSORBING = new Set(['rejected', 'conflict', 'expired_window']);
function checkBodyString(bodyString, model) {
  let obj;
  try { obj = JSON.parse(bodyString); } catch { throw new Error('待创建记录请求体不是合法 JSON'); }
  if (containsSecret(obj)) throw new Error('待创建记录请求体包含疑似密钥字段，已拒绝');
  if (!isObj(obj) || obj.model !== model || !str(obj.prompt, 200000) || !Number.isFinite(obj.seconds)) throw new Error('待创建记录请求体与记录不一致');
  if (obj.metadata !== undefined && !isObj(obj.metadata)) throw new Error('待创建记录 metadata 不合法');
}
function sanitizeSnapshot(snap, idMap, assetIdMap) {
  if (!isObj(snap)) return null;
  const out = {};
  // 缺失项保留空位：恢复提交必须明确拒绝，不能丢掉参考素材后继续生成。
  if (Array.isArray(snap.refIds)) out.refIds = snap.refIds.map(id => assetIdMap.get(id) ?? null);
  if (Array.isArray(snap.frameIds)) out.frameIds = snap.frameIds.map(id => assetIdMap.get(id) ?? null);
  out.nodeId = idMap.get(snap.nodeId) ?? null;
  const sd = sanitizeDraft(snap.draft);
  if (sd) {
    // 快照内 @绑定与 refIds 走同一素材重映射，否则恢复时引用错指（R12）
    if (sd.bindings) for (const k of Object.keys(sd.bindings)) {
      const v = sd.bindings[k];
      if (typeof v === 'string' && v.startsWith('__asset__:')) sd.bindings[k] = assetIdMap.get(v.slice(10)) ?? MISSING_ASSET;
    }
    out.draft = sd;
  }
  out.at = num(snap.at) ? snap.at : null;
  return out;
}
function sanitizeTask(t, projectId, idMap, assetIdMap) {
  if (!isObj(t) || !str(t.taskId, 256) || !str(t.model, 128)) throw new Error('任务记录不合法');
  if (!isSupportedTaskRecord(t))
    throw new Error('任务记录版本未知，导入已停止以保留原任务保护');
  if (t.bodyString != null) checkBodyString(t.bodyString, t.model);
  const out = {
    taskId: t.taskId, projectId, model: t.model,
    status: str(t.status, 32) ? t.status : 'unknown',
    deliveryStatus: str(t.deliveryStatus, 32) ? t.deliveryStatus : null,
    progress: num(t.progress) ? t.progress : null,
    paused: t.paused === true,
    pauseSource: ['manual', 'identity', 'auth'].includes(t.pauseSource) ? t.pauseSource : null,
    detached: t.detached === true,
    authFailed: t.authFailed === true,
    resultDeferred: t.resultDeferred === true,
    downloadExpired: t.downloadExpired === true,
    cancelRequested: t.cancelRequested === true,
    keyFp: str(t.keyFp, 32) ? t.keyFp : null,
    createdAt: num(t.createdAt) ? t.createdAt : Date.now(),
    updatedAt: num(t.updatedAt) ? t.updatedAt : null,
    idempotencyKey: str(t.idempotencyKey, 256) ? t.idempotencyKey : null,
    bodyString: str(t.bodyString, 400000) ? t.bodyString : null,
    nodeId: idMap.get(t.nodeId) ?? null,
    resultBlobId: null, // 结果 blob 不随导出
    recVersion: TASK_REC_VERSION,   // 本地记录格式版本：导入盖戳（读宽容+写盖戳，合同 §2）
  };
  // v2 交付字段原样保留：缺失即缺失，绝不补默认值把 v2 任务降成可下载旧任务。
  // 受损 v2（缺 executorVersion 带特征字段）由 task-status.isV2Record 按 v2 门槛判读。
  if (str(t.stage, 64)) out.stage = t.stage;
  if (num(t.executorVersion)) out.executorVersion = t.executorVersion;
  if (t.contentReady === true || t.contentReady === false) out.contentReady = t.contentReady;
  if (str(t.cancelPhase, 64)) out.cancelPhase = t.cancelPhase;
  if (num(t.downloadExpiresAt)) out.downloadExpiresAt = t.downloadExpiresAt;
  if (str(t.resultType, 64)) out.resultType = t.resultType;
  if (['server_status', 'explicit_absence'].includes(t.terminalEvidence)) out.terminalEvidence = t.terminalEvidence;
  if (['ok', 'retrying', 'needs_review', 'auth_required'].includes(t.queryHealth)) out.queryHealth = t.queryHealth;
  if (Array.isArray(t.terminalConflict) && t.terminalConflict.length)
    out.terminalConflict = [...new Set(t.terminalConflict.filter(s => typeof s === 'string' && TASK_TERMINAL.has(s)))];
  if (str(t.error, 2000)) out.error = t.error;
  else if (isObj(t.error)) out.error = { message: str(t.error.message, 2000) ? t.error.message : null, status: num(t.error.status) ? t.error.status : null, code: str(t.error.code, 64) ? t.error.code : null };
  // 任务→素材关联经 assetIdMap 重映射；源素材不在导出集内 → 显式空位（不指向其他素材）
  if (t.resultAssetId != null) out.resultAssetId = assetIdMap.get(t.resultAssetId) ?? null;
  return out;
}
function sanitizePending(r, projectId, idMap, assetIdMap) {
  if (!isObj(r) || !str(r.idempotencyKey, 256) || !str(r.model, 128)) throw new Error('待创建记录不合法');
  if (r.bodyString != null) checkBodyString(r.bodyString, r.model);
  return {
    idempotencyKey: r.idempotencyKey, projectId, model: r.model,
    bodyString: str(r.bodyString, 400000) ? r.bodyString : null,
    nodeId: idMap.get(r.nodeId) ?? null,
    keyFp: str(r.keyFp, 32) ? r.keyFp : null,
    createdAt: num(r.createdAt) ? r.createdAt : Date.now(),
    lastSubmitAt: num(r.lastSubmitAt) ? r.lastSubmitAt : null,
    retryAfterMs: num(r.retryAfterMs) ? r.retryAfterMs : null,
    retryNotBefore: num(r.retryNotBefore) ? r.retryNotBefore : null,
    lastError: str(r.lastError, 2000) ? r.lastError : null,
    snapshot: sanitizeSnapshot(r.snapshot, idMap, assetIdMap),
    state: PENDING_STATES.has(r.state) ? r.state : 'uncertain',
  };
}

export function createStore(storage, { onPersistError } = {}) {
  const state = { project: null, listeners: new Set(), saveTimer: null, syncedRev: null, conflicts: new Map() };
  const reportError = e => onPersistError?.(e);
  let saveSuspended = 0;   // >0 期间防抖落盘挂起：瞬态视图（提交期代理接线等）不写入存储

  // 本实例内所有项目文档写一律串行排队：同实例两次落盘不得互相误判为外部写
  let writeTail = Promise.resolve();
  const projectBases = new WeakMap();
  // 仅记录已经落盘或另存副本、随后被同项目新对象替换的完整旧稿。
  // 后到的内容会使快照不再匹配，仍走正常保存/冲突保护。
  const preservedDrafts = new WeakMap();
  const enqueueWrite = fn => {
    const run = writeTail.then(fn);
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const revOf = doc => (doc !== null && typeof doc === 'object') ? (doc.rev ?? 0) : null;
  // CAS 写：优先用存储层单事务原语（IDB 单事务 读→比较→写）；无该能力的实现退化为读-比较-写兜底
  const casSet = async (key, expectedRev, value) => {
    if (typeof storage.setIfRev === 'function') return storage.setIfRev(key, expectedRev, value);
    const cur = await storage.get(key);
    const curRev = revOf(cur);
    if (curRev !== expectedRev) return { ok: false, storedRev: curRev };
    await storage.set(key, value);
    return { ok: true };
  };
  const conflictError = (pid, storedRev) => Object.assign(
    new Error('检测到其他标签页/窗口的更新写入，本次保存已拒绝，本地草稿已保留'),
    { code: 'rev_conflict', projectId: pid, storedRev: storedRev ?? null });
  const rememberConflict = (project, storedRev) => {
    const c = { projectId: project.id, storedRev: storedRev ?? null, at: Date.now(), blocking: true,
      localDoc: JSON.parse(JSON.stringify(project)) };
    state.conflicts.set(project.id, c);
    return c;
  };

  const emit = reason => { for (const fn of state.listeners) fn(reason); scheduleSave(); };
  const scheduleSave = () => {
    if (saveSuspended > 0) return;   // 恢复后统一排一次
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => persistQueued().catch(reportError), 400);
  };
  // 项目文档唯一落盘通道：以「本实例上次成功写入/载入的修订号」为基线做比较再写（CAS）。
  //  · 本实例自己的写、防抖自动保存、异步生成回写共用 syncedRev——绝不误报冲突
  //  · 存储稿被外部推进（stored.rev ≠ 基线）→ 拒写 + 记录冲突（含被拒稿 localDoc）；
  //    双方草稿都可恢复：resolveConflict('saveCopy'|'overwrite'|'reload'|'discard')
  //  · baseRev 显式给出 = 调用方已快照外部稿后的授权覆盖（如版本恢复）；成功后清除旧冲突记录
  //  · 写入 await 期间项目被切走：doc 仍写回自己的命名空间，但不抢新项目的 syncedRev/lastOpened
  async function persist(p, baseRev, queuedBase) {
    if (!p) return;
    if (baseRev === undefined && state.project !== p && preservedDrafts.get(p) === JSON.stringify(p)) return { superseded: true };
    const known = state.conflicts.get(p.id);
    if (baseRev === undefined && known?.blocking) {
      known.localDoc = JSON.parse(JSON.stringify(p));
      throw conflictError(p.id, known.storedRev);
    }
    const localBase = state.project === p ? state.syncedRev
      : projectBases.has(p) ? projectBases.get(p) : queuedBase;
    const expected = baseRev === undefined ? (localBase ?? null) : baseRev;
    p.updatedAt = Date.now();
    const doc = JSON.parse(JSON.stringify(p));
    doc.rev = (expected ?? 0) + 1;
    const res = await casSet(`project:${p.id}`, expected, doc);
    if (!res.ok) {
      rememberConflict(p, res.storedRev);
      throw conflictError(p.id, res.storedRev);
    }
    p.rev = doc.rev;
    projectBases.set(p, doc.rev);
    if (state.project === p) {
      state.syncedRev = doc.rev;
      if (baseRev !== undefined) state.conflicts.delete(p.id);
      await storage.set('lastOpened', p.id);
    }
  }
  const persistQueued = baseRev => {
    const project = state.project, queuedBase = state.syncedRev;
    return enqueueWrite(() => persist(project, baseRev, queuedBase));
  };
  // 切项目/导入/新建前的落盘：跨标签冲突不阻断——被拒稿已留 conflicts.localDoc，绝不卡死换项目
  const flushForSwitch = async () => {
    try { await persistQueued(); }
    catch (e) { if (e?.code !== 'rev_conflict') throw e; }
  };
  // 写入一律以记录自带 projectId 为准（切项目后异步入库不得写进新项目）
  const taskKey = (pid, id) => `task:${pid}:${id}`;
  const pendingKeyOf = (pid, k) => `pending:${pid}:${k}`;

  // 新项目命名空间整体落盘（导入/副本共用）：优先原子 batch；无 batch 时逐条写、
  // 失败仅回滚本次新建记录，绝不动既有用户数据。全部成功后才切换内存当前项目。
  async function commitEntries(entries, project, assertCurrent = () => {}) {
    const expected = state.project;
    const guard = () => {
      if (state.project !== expected) throw new Error('项目已切换，导入未提交');
      assertCurrent();
    };
    guard();
    const prevOpened = await storage.get('lastOpened');
    guard();
    const written = [];
    try {
      if (typeof storage.batch === 'function') {
        written.push(...entries.map(([k]) => k));
        await storage.batch(entries);
      } else {
        for (const [k, v] of entries) {
          guard();
          written.push(k);
          await storage.set(k, v);
        }
      }
      guard();
    } catch (e) {
      const rollbackErrors = [];
      for (const k of written.filter(k => k !== 'lastOpened')) {
        try { await storage.del(k); } catch (error) { rollbackErrors.push(error); }
      }
      if (written.includes('lastOpened')) {
        try {
          const activeId = state.project?.id ?? prevOpened;
          if (activeId == null) await storage.del('lastOpened'); else await storage.set('lastOpened', activeId);
        } catch (error) { rollbackErrors.push(error); }
      }
      if (rollbackErrors.length) throw new AggregateError([e, ...rollbackErrors], '导入已中止，部分临时记录清理失败；当前项目未替换');
      throw e;
    }
    state.project = project;
    state.syncedRev = project.rev ?? 1;   // 新命名空间已整批落盘：本实例基线同步，避免后续保存误报冲突
    emit({ type: 'project' });
    return project;
  }

  // 非当前项目的 读→改→写：以存储修订号为基线 CAS，外部并发写入时整轮在最新稿上重试，
  // 绝不盲覆盖。写当前项目时同步推进 syncedRev——旁路条件写不会再被误判成外部冲突。
  async function casMutateProject(id, mutate) {
    const local = state.project?.id === id ? state.project : null;
    const queuedBase = local ? state.syncedRev : null;
    return enqueueWrite(async () => {
      for (let i = 0; i < 4; i++) {
        const doc = await storage.get(`project:${id}`);
        if (!doc) return null;
        const base = doc.rev ?? 0;
        const r = await mutate(doc);
        if (r === false) return null;
        doc.rev = base + 1; doc.updatedAt = Date.now();
        const res = await casSet(`project:${id}`, base, doc);
        if (res.ok) {
          if (local) {
            const localBase = state.project === local ? state.syncedRev
              : projectBases.has(local) ? projectBases.get(local) : queuedBase;
            if (base === localBase && !state.conflicts.get(id)?.blocking) {
              // mutate 必须可重放（CAS 冲突时本就会重试）。对同一基线的本地对象
              // 应用同一字段变更，保留未保存字段和节点对象身份，才可推进其写入基线。
              try { await mutate(local); }
              catch (e) { rememberConflict(local, doc.rev); throw e; }
              local.rev = doc.rev;
              projectBases.set(local, doc.rev);
              if (state.project === local) state.syncedRev = doc.rev;
            } else {
              // 最新持久稿含外部修改：结果合并已成功，但旧内存没有覆盖许可。
              rememberConflict(local, doc.rev);
            }
          }
          return doc;
        }
      }
      throw conflictError(id, revOf(await storage.get(`project:${id}`)));
    });
  }

  // 项目文档克隆管线（副本/项目模板实例化/冲突另存副本共用）：
  // 全部节点/素材换新 id + 引用全量重映射 + 素材 blob 克隆到新键 + 导演台 KV 重键且令牌换绑；
  // 运行时付费身份剥离；缺失文件保持显式 missing 占位。
  // 只构造与暂存新键，不写 project:/lastOpened——提交归调用方；任何失败仅清理本次新键。
  async function stageProjectClone(srcDoc, { name, guard = () => {} } = {}) {
    const doc = JSON.parse(JSON.stringify(srcDoc));
    const clonedProjectId = uid('p');
    const idMap = new Map();
    for (const n of doc.nodes ?? []) { const nid = uid(String(n.type)[0] ?? 'n'); idMap.set(n.id, nid); n.id = nid; stripRuntime(n.data); }
    for (const e of doc.edges ?? []) { e.id = uid('e'); e.from.node = idMap.get(e.from.node) ?? e.from.node; e.to.node = idMap.get(e.to.node) ?? e.to.node; }
    // 素材克隆独立身份：新 assetId；blob 内容随后复制到 blob:<newId>（缺失文件保持 missing 占位）
    const assetIdMap = new Map();
    const assets = {};
    for (const [oldAid, a] of Object.entries(doc.assets ?? {})) {
      const naid = uid('a');
      assetIdMap.set(oldAid, naid);
      a.id = naid;
      if (a.fromDirector) a.fromDirector = idMap.get(a.fromDirector) ?? null;
      assets[naid] = a;
    }
    doc.assets = assets;
    const remapAsset = v => (typeof v === 'string' && v) ? (assetIdMap.get(v) ?? null) : v;
    const fixBindings = b => { if (b && typeof b === 'object') for (const k of Object.keys(b)) b[k] = remapAsset(b[k]); };
    for (const n of doc.nodes ?? []) {
      const d = n.data ?? {};
      if (n.type === 'asset') {
        const mapped = remapAsset(d.assetId);
        if (mapped) d.assetId = mapped;
        else if (d.assetId != null) { d.assetId = null; d.needsRebind = true; }
      }
      fixBindings(d.bindings); fixBindings(d.draft?.bindings);
      if (d.directorSource) { d.directorSource.nodeId = idMap.get(d.directorSource.nodeId) ?? null;
        d.directorSource.characterBindings = remapDirectorBindings(d.directorSource.characterBindings, assetIdMap); }
      for (const sd of Object.values(d.perModel ?? {})) fixBindings(sd?.bindings);
      // resultAssetId/outputAssetIds/run/operation 已由 stripRuntime 清除——克隆不继承付费产出身份
    }
    const stagedBlobs = [];
    const cleanup = async () => {
      for (const k of stagedBlobs) { try { await storage.delBlob(k); } catch { /* 尽力清理 */ } }
    };
    try {
      for (const [oldAid, naid] of assetIdMap) {
        const a = assets[naid];
        if (a.missing) continue;
        guard();
        const blob = await storage.getBlob(`blob:${oldAid}`);
        if (!blob || !blob.size) { a.missing = true; continue; }
        await storage.setBlob(`blob:${naid}`, blob);
        stagedBlobs.push(`blob:${naid}`);
      }
      // 导演台 KV：新节点 id 重键；值内 xp-asset:// 令牌换到新素材 id
      const kv = [];
      const allKeys = await storage.keys();
      for (const [oldId, nid] of idMap) {
        for (const k of allKeys.filter(k => k.startsWith(`dir:${oldId}:`) || k.startsWith(`dircfg:${oldId}:`))) {
          if (k.includes(':hosted-document:') && k !== directorDocumentKey(srcDoc.id, oldId) ||
            k.includes(':hosted-conflict:') && !k.startsWith(`dir:${oldId}:hosted-conflict:${srcDoc.id}:`)) continue;
          const v = await storage.get(k);
          if (k.startsWith(`dir:${oldId}:hosted-document:`) || k.startsWith(`dir:${oldId}:hosted-conflict:`)) {
            const mappedRecord = remapDirectorRecord(v, { oldProjectId: srcDoc.id, oldNodeId: oldId,
              projectId: clonedProjectId, nodeId: nid, assetIdMap });
            const key = k.startsWith(`dir:${oldId}:hosted-document:`) ? directorDocumentKey(clonedProjectId, nid)
              : `dir:${nid}:hosted-conflict:${clonedProjectId}:${v.conflictId}`;
            kv.push([key, mappedRecord]);
            continue;
          }
          if (typeof v === 'string' || isObj(v) || Array.isArray(v) || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            let j = JSON.stringify(v);
            if (j == null || j.length > 5e6) continue;
            j = j.replace(/xp-asset:\/\/([A-Za-z0-9_-]+)/g, (m0, aid) => `xp-asset://${assetIdMap.get(aid) ?? aid}`);
            try { kv.push([k.replace(`:${oldId}:`, `:${nid}:`), JSON.parse(j)]); } catch { /* 无法重编码的条目跳过 */ }
          }
        }
      }
      guard();
      if (doc.studio) {
        doc.studio.workflow = null;   // 克隆绝不携带可续跑的工作流身份
        for (const g of doc.studio.groups ?? []) g.members = (g.members ?? []).map(m => idMap.get(m)).filter(Boolean);
        for (const s of doc.studio.shots ?? []) {
          s.nodeId = idMap.get(s.nodeId) ?? null;
          s.imageNodeId = idMap.get(s.imageNodeId) ?? null;
          if (Array.isArray(s.assetIds)) s.assetIds = s.assetIds.map(x => x == null ? null : (assetIdMap.get(x) ?? null));
          if (Array.isArray(s.versions)) for (const v of s.versions) {
            if (v && typeof v === 'object') { v.nodeId = idMap.get(v.nodeId) ?? null; v.assetId = v.assetId ? (assetIdMap.get(v.assetId) ?? null) : null; }
          }
          if (isObj(s.sync) && typeof s.sync.assetId === 'string') s.sync.assetId = assetIdMap.get(s.sync.assetId) ?? null;
        }
        for (const c of doc.studio.timeline ?? []) if (c && typeof c === 'object' && c.assetId) c.assetId = assetIdMap.get(c.assetId) ?? null;
        for (const col of doc.studio.assetCollections ?? []) if (col && Array.isArray(col.assetIds)) col.assetIds = col.assetIds.map(x => assetIdMap.get(x)).filter(Boolean);
      }
      doc.id = clonedProjectId; doc.name = String(name ?? `${srcDoc.name ?? '项目'}（副本）`).slice(0, 256);
      doc.createdAt = doc.updatedAt = Date.now(); doc.rev = 1; delete doc.trashed; delete doc.trashedAt;
      return { doc, kv, stagedBlobs, cleanup, nodeMap: idMap, assetMap: assetIdMap };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }

  const store = {
    onChange: fn => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
    get project() { return state.project; },

    async listProjects({ includeTrashed = false } = {}) {
      const keys = (await storage.keys()).filter(k => k.startsWith('project:'));
      const out = [];
      for (const k of keys) {
        const p = await storage.get(k);
        if (p && (includeTrashed || !p.trashed)) out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, rev: p.rev ?? 0, trashed: p.trashed === true, trashedAt: p.trashedAt ?? null });
      }
      return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    async newProject(name = '未命名画布') {
      await flushForSwitch();
      state.project = { id: uid('p'), name, createdAt: Date.now(), updatedAt: Date.now(), rev: 1, nodes: [], edges: [], assets: {} };
      state.syncedRev = null;
      await persistQueued(); emit({ type: 'project' }); return state.project;
    },
    async openProject(id) {
      await flushForSwitch();
      const previous = state.project;
      const preserved = previous?.id === id ? JSON.stringify(previous) : null;
      const p = await storage.get(`project:${id}`);
      if (!p) return null;
      p.nodes ??= []; p.edges ??= []; p.assets ??= {};
      p.rev ??= 1;
      if (preserved && state.project === previous && JSON.stringify(previous) === preserved) preservedDrafts.set(previous, preserved);
      state.project = p;
      state.syncedRev = p.rev;
      const c = state.conflicts.get(id);
      if (c) c.blocking = false;   // 已载入外部新稿：被拒本地稿仍留 conflicts.localDoc 供另存，但不再阻塞正常保存
      await storage.set('lastOpened', id); emit({ type: 'project' }); return p;
    },
    // 重命名任意项目（不要求先打开）；写其他项目时不动内存当前项目；
    // 非当前项目走 CAS 读改写：另一标签页持有该项目时的并发写不被静默覆盖
    async renameProject(id, name) {
      const n = String(name ?? '').trim().slice(0, 256); if (!n) throw new Error('项目名不能为空');
      if (state.project?.id === id) { state.project.name = n; await persistQueued(); emit({ type: 'data' }); return state.project; }
      return casMutateProject(id, doc => { doc.name = n; });
    },
    // 非破坏性回收站：只在项目文档上打标记，绝不删除记录/素材/任务
    async trashProject(id) {
      if (state.project?.id === id) { state.project.trashed = true; state.project.trashedAt = Date.now(); await persistQueued(); emit({ type: 'data' }); return state.project; }
      return casMutateProject(id, doc => { doc.trashed = true; doc.trashedAt = Date.now(); });
    },
    async untrashProject(id) {
      const apply = p => { delete p.trashed; delete p.trashedAt; };
      if (state.project?.id === id) { apply(state.project); await persistQueued(); emit({ type: 'data' }); return state.project; }
      return casMutateProject(id, apply);
    },
    // 复制项目：新 id + 全部节点/素材换新独立身份——素材 blob 内容克隆到新键，
    // 副本重绑素材绝不能覆盖原项目的全局 blob 键。任务/未决记录不随副本走（源记录原样保留），
    // 节点付费运行时身份全部剥离；导演台 KV 按新节点 id 重键且值内 xp-asset:// 令牌换到新素材 id；
    // 分镜/时间线/合集素材引用全部换绑。缺失文件保持显式 missing 占位。
    // 任何一步失败仅清理本次新建键——当前项目与 lastOpened 不动。
    async duplicateProject(id, name) {
      await flushForSwitch();
      const openedAtStart = state.project;
      const src = id === openedAtStart?.id ? openedAtStart : await storage.get(`project:${id}`);
      if (!src) return null;
      const guard = () => { if (state.project !== openedAtStart) throw new Error('项目已切换，复制未提交'); };
      const staged = await stageProjectClone(src, { name: name ?? `${src.name ?? '项目'}（副本）`, guard });
      try {
        return await commitEntries([[`project:${staged.doc.id}`, staged.doc], ...staged.kv, ['lastOpened', staged.doc.id]], staged.doc);
      } catch (e) {
        await staged.cleanup();
        throw e;
      }
    },
    async lastOpened() {
      const id = await storage.get('lastOpened');
      return id ? store.openProject(id) : null;
    },
    async deleteProject(id) { await storage.del(`project:${id}`); if (state.project?.id === id) { state.project = null; state.syncedRev = null; } },
    // opts.baseRev：显式授权基线（版本恢复等已快照外部稿后的覆盖写）；缺省用本实例 syncedRev
    async flush(opts) { clearTimeout(state.saveTimer); await persistQueued(typeof opts === 'number' ? opts : opts?.baseRev); },
    flushForSwitch,   // 切项目前落盘：跨标签冲突不阻断（被拒稿留 conflicts.localDoc，绝不卡死换项目）
    touch(reason = { type: 'data' }) { emit(reason); },
    saveSoon() { scheduleSave(); },   // 静默持久化，不触发重渲染（文本输入用）
    // 瞬态保护区：先把已排队的改动落盘，fn 执行期间 emit/touch 不再触发落盘（监听器仍同步），
    // 结束后统一排一次保存。供「仅提交期间可见」的接线/文本汇聚使用——权威 edges/草稿不被瞬态污染。
    async withSuspendedSave(fn) {
      clearTimeout(state.saveTimer);            // 已排程的保存先落盘再挂起，避免中途写入瞬态
      try { await persistQueued(); } catch (e) { reportError(e); }
      saveSuspended++;
      try { return await fn(); }
      finally { if (--saveSuspended === 0) scheduleSave(); }
    },
    // ---- 跨标签写冲突：结构化状态 + 恢复接口（不删任何一方数据）----
    getConflict(pid = state.project?.id) {
      const c = state.conflicts.get(pid);
      return c ? { projectId: c.projectId, storedRev: c.storedRev, at: c.at, blocking: c.blocking !== false } : null;
    },
    listConflicts() { return [...state.conflicts.keys()]; },
    //  · 'saveCopy'  被拒本地稿经克隆管线另存为独立项目（全新节点/素材/blob/KV），当前项目再载入外部稿
    //  · 'overwrite' 以当前内存稿强制覆盖（仅当前项目；基线取最新 stored.rev，再被抢写则仍失败）
    //  · 'reload'    载入外部稿（当前项目）；被拒稿仍留 localDoc 供稍后备份
    //  · 'discard'   清除冲突记录（被拒稿随之放弃；当前内存不变）
    async resolveConflict(pid, mode = 'reload') {
      const c = state.conflicts.get(pid);
      if (!c) return null;
      if (mode === 'saveCopy') {
        const local = c.blocking && state.project?.id === pid ? state.project : null;
        const source = JSON.parse(JSON.stringify(local ?? c.localDoc));
        const staged = await stageProjectClone(source, { name: `${source.name ?? '项目'}（冲突副本）` });
        try {
          const entries = [[`project:${staged.doc.id}`, staged.doc], ...staged.kv];
          if (typeof storage.batch === 'function') await storage.batch(entries);
          else for (const [k, v] of entries) await storage.set(k, v);
        } catch (e) { await staged.cleanup(); throw e; }
        const latest = local ? await storage.get(`project:${pid}`) : null;
        if (local && JSON.stringify(local) !== JSON.stringify(source)) {
          c.localDoc = JSON.parse(JSON.stringify(local));
          return { copyId: staged.doc.id, remainingLocalChanges: true };
        }
        if (local && state.project === local) {
          if (!latest) return { copyId: staged.doc.id, remainingLocalChanges: true };
          // 副本已落盘，直接载入外部稿；不再 flush 被拒旧稿，也不抢切走的新项目。
          preservedDrafts.set(local, JSON.stringify(source));
          state.project = latest;
          state.syncedRev = latest.rev ?? 0;
          projectBases.set(latest, state.syncedRev);
          await storage.set('lastOpened', pid);
          emit({ type: 'project' });
        }
        state.conflicts.delete(pid);
        return { copyId: staged.doc.id };
      }
      if (mode === 'overwrite') {
        const p = state.project;
        if (p?.id !== pid) throw new Error('只能覆盖当前打开的项目');
        const guard = () => { if (state.project !== p) throw new Error('项目已切换，覆盖保存未执行'); };
        await enqueueWrite(async () => {
          guard();
          const stored = await storage.get(`project:${pid}`);
          guard();
          const base = revOf(stored);
          p.updatedAt = Date.now();
          const doc = JSON.parse(JSON.stringify(p));
          doc.rev = (base ?? 0) + 1;
          const res = await casSet(`project:${pid}`, base, doc);
          if (!res.ok) { c.storedRev = res.storedRev ?? null; throw conflictError(pid, res.storedRev); }
          p.rev = doc.rev; projectBases.set(p, doc.rev);
          if (state.project === p) {
            state.syncedRev = doc.rev;
            await storage.set('lastOpened', pid);
            if (state.project !== p && state.project?.id) await storage.set('lastOpened', state.project.id);
          }
        });
        if (state.conflicts.get(pid) === c) state.conflicts.delete(pid);
        return { overwritten: true };
      }
      if (mode === 'discard') { state.conflicts.delete(pid); return { discarded: true }; }
      if (state.project?.id === pid) { await store.openProject(pid); return { reloaded: true }; }
      return { reloaded: false, kept: true };   // 非当前项目：记录保留，待打开后处理
    },
    // 共享安全接口（供 generation 的 syncOpDoc、workflow 运行态等旁路写集成）：
    // 对任意项目文档做 读→改→CAS写，外部并发写在最新稿上重放 mutate；
    // 写的是当前项目时同步推进 syncedRev——旁路写不会再被误判成外部冲突。
    updateStoredProject(pid, mutate) { return casMutateProject(pid, mutate); },
    // 克隆暂存（project-hub 项目模板实例化用）：见 stageProjectClone 注释
    stageProjectClone: (srcDoc, opts) => stageProjectClone(srcDoc, opts),
    // 整批提交「新项目文档 + 附加 KV + lastOpened」并切换当前项目（模板实例化用）：失败仅回滚本次新建键
    commitProject(project, extraEntries = []) {
      return commitEntries([[`project:${project.id}`, project], ...extraEntries, ['lastOpened', project.id]], project);
    },

    // data 必须由调用方完整构造（含 draft 等），addNode 内部不再补默认值
    addNode(type, x, y, data = {}) {
      if (!NODE_TYPES[type]) throw new Error('未知节点类型');
      const node = { id: uid(type[0]), type, x: Math.round(x), y: Math.round(y), data };
      state.project.nodes.push(node); emit({ type: 'structure' }); return node;
    },
    publishAssetBatch(rows, x, y, { checkKey, checkRev, assertCurrent }) {
      clearTimeout(state.saveTimer);
      const project = state.project;
      return enqueueWrite(async () => {
        assertCurrent();
        if (state.project !== project || state.conflicts.get(project.id)?.blocking)
          throw conflictError(project.id, state.syncedRev);
        const expected = state.syncedRev ?? null;
        const nodes = rows.map(({ a }, index) => ({ id: uid('a'), type: 'asset', x: Math.round(x),
          y: Math.round(y + index * 120), data: { assetId: a.id, title: a.name } }));
        const draft = structuredClone(project);
        for (const { a, created } of rows) if (created) draft.assets[a.id] = structuredClone(a);
        draft.nodes.push(...nodes); draft.rev = (expected ?? 0) + 1; draft.updatedAt = Date.now();
        const result = await storage.setIfRevs([[`project:${project.id}`, expected], [checkKey, checkRev]], [[`project:${project.id}`, draft]]);
        if (!result.ok) throw Object.assign(new Error('项目或场景修订已改变，整批输出未发布'),
          { code: result.key?.endsWith(checkKey) ? 'revision_conflict' : 'rev_conflict' });
        // Commit point: metadata and every node already exist together on disk.
        for (const { a, created } of rows) if (created) project.assets[a.id] = a;
        project.nodes.push(...nodes); project.rev = draft.rev; project.updatedAt = draft.updatedAt;
        projectBases.set(project, draft.rev);
        if (state.project === project) {
          state.syncedRev = draft.rev;
          // Once CAS commits, a view listener cannot turn durable success into
          // a rollback that deletes bytes referenced by the saved document.
          for (const listener of state.listeners) {
            try { listener({ type: 'structure' }); } catch (error) { try { reportError(error); } catch {} }
          }
          scheduleSave();
        }
        return nodes;
      });
    },
    updateNodeData(id, patch) {
      const n = state.project.nodes.find(n => n.id === id); if (!n) return;
      Object.assign(n.data, patch); emit({ type: 'data', id });
    },
    moveNode(id, x, y) {
      const n = state.project.nodes.find(n => n.id === id); if (!n) return;
      n.x = Math.round(x); n.y = Math.round(y); emit({ type: 'move', id });
    },
    removeNode(id) {
      const p = state.project;
      p.edges = p.edges.filter(e => e.from.node !== id && e.to.node !== id);
      p.nodes = p.nodes.filter(n => n.id !== id); emit({ type: 'structure' });
    },
    addEdge(fromNode, fromPort, toNode, toPort, assetKind) {
      const p = state.project;
      const source = p.nodes.find(n => n.id === fromNode);
      if (!source || !NODE_TYPES[source.type]?.ports.out?.some(port => port.id === fromPort)) return null;
      const target = p.nodes.find(n => n.id === toNode);
      const def = NODE_TYPES[target?.type];
      const port = def?.ports?.in?.find(x => x.id === toPort);
      if (!port || !portAccepts(port.kind, assetKind)) return null;
      if (fromNode === toNode) return null;
      if (p.edges.some(e => e.to.node === toNode && e.to.port === toPort && e.from.node === fromNode)) return null;
      const order = p.edges.filter(e => e.to.node === toNode && e.to.port === toPort).length;
      const edge = { id: uid('e'), from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }, order };
      p.edges.push(edge); emit({ type: 'structure' }); return edge;
    },
    removeEdge(id) { state.project.edges = state.project.edges.filter(e => e.id !== id); emit({ type: 'structure' }); },
    reorderEdge(id, dir) {
      const list = store.edgesInto(state.project.edges.find(e => e.id === id)?.to.node, state.project.edges.find(e => e.id === id)?.to.port);
      const idx = list.findIndex(e => e.id === id); const swap = list[idx + dir];
      if (!swap) return;
      [list[idx].order, swap.order] = [swap.order, list[idx].order]; emit({ type: 'data' });
    },
    edgesInto(nodeId, portId) {
      return (state.project?.edges ?? []).filter(e => e.to.node === nodeId && e.to.port === portId).sort((a, b) => a.order - b.order);
    },
    node(id) { return state.project?.nodes.find(n => n.id === id) ?? null; },

    // ---- 待创建幂等记录 / 任务记录（按项目命名空间）----
    // pending 写侧对账：rejected/conflict/expired_window 是已定性结局，不得被迟到的
    // 泛型在途写（uncertain）回退；abandoned 不吸收（用户解除后可经恢复入口重新武装）。
    // 合法流转（→rejected/conflict/expired_window/abandoned）照常落盘。
    async savePendingCreate(rec) {
      const k = pendingKeyOf(rec.projectId ?? state.project.id, rec.idempotencyKey);
      const stored = await storage.get(k);
      if (isObj(stored) && PENDING_ABSORBING.has(stored.state) && rec.state === 'uncertain') rec.state = stored.state;
      await storage.set(k, rec);
    },
    async pendingCreate(key) { return storage.get(pendingKeyOf(state.project.id, key)); },
    async pendingCreateIn(pid, key) { return storage.get(pendingKeyOf(pid, key)); },
    async listPending() {
      const prefix = `pending:${state.project.id}:`;
      const out = [];
      for (const k of (await storage.keys()).filter(k => k.startsWith(prefix))) { const r = await storage.get(k); if (r) out.push(r); }
      return out;
    },
    async updatePendingCreate(rec) {
      const k = pendingKeyOf(rec.projectId ?? state.project.id, rec.idempotencyKey);
      const stored = await storage.get(k);
      if (isObj(stored) && PENDING_ABSORBING.has(stored.state) && rec.state === 'uncertain') rec.state = stored.state;
      await storage.set(k, rec);
    },
    async clearPendingCreate(recOrKey) {
      const pid = typeof recOrKey === 'object' ? (recOrKey.projectId ?? state.project.id) : state.project.id;
      const k = typeof recOrKey === 'object' ? recOrKey.idempotencyKey : recOrKey;
      await storage.del(pendingKeyOf(pid, k));
    },
    // 任务记录独立于项目文档使用原子 CAS；fields 指定本次写入真正拥有的字段，
    // 查询观察不得携带旧缓存中的暂停、脱离或素材关联覆盖另一标签页的本地操作。
    async saveTask(rec, { fields } = {}) {
      const key = taskKey(rec.projectId ?? state.project.id, rec.taskId);
      if (!isSupportedTaskRecord(rec))
        throw Object.assign(new Error('任务记录版本高于当前客户端，已拒绝改写'), {
          code: 'task_record_version_unsupported', taskId: rec.taskId,
        });
      if (typeof storage.setIfRev !== 'function') {
        throw Object.assign(new Error('任务存储缺少原子条件写能力，已拒绝覆盖'), {
          code: 'task_atomic_unavailable', taskId: rec.taskId,
        });
      }
      const merge = stored => {
        const next = fields && isObj(stored) ? { ...stored } : { ...(isObj(stored) ? stored : {}), ...rec };
        if (fields && isObj(stored)) for (const f of fields) {
          if (Object.hasOwn(rec, f)) next[f] = rec[f];
        }
        if (!isObj(stored)) Object.assign(next, rec);
        for (const f of ['taskId', 'projectId', 'idempotencyKey', 'keyFp', 'bodyString', 'ownerSubject']) {
          if (stored?.[f] != null && rec[f] != null && stored[f] !== rec[f])
            throw Object.assign(new Error('任务身份与持久记录冲突，已拒绝覆盖'), {
              code: 'task_identity_conflict', taskId: rec.taskId, field: f,
            });
          if (stored?.[f] != null) next[f] = stored[f];
        }
        if (stored?.contentReady === true) next.contentReady = true;
        if (stored?.cancelRequested === true) next.cancelRequested = true;
        if (stored?.downloadExpired === true) next.downloadExpired = true;
        for (const f of ['resultAssetId', 'resultBlobId', 'resultType']) {
          // 普通旧缓存不得改结果关联；仅下载收尾明确拥有该字段且已验证新素材时可修复。
          if (stored?.[f] != null && (!fields?.includes(f) || rec[f] == null)) next[f] = stored[f];
        }
        if (stored?.terminalConflict) next.terminalConflict = stored.terminalConflict;
        const trusted = r => TASK_TERMINAL.has(r?.status)
          && !(['not_found', 'expired'].includes(r.status) && !r.terminalEvidence);
        if (trusted(stored) && !trusted(next)) {
          for (const f of ['status', 'stage', 'error', 'progress', 'serverRevision', 'terminalEvidence'])
            if (Object.hasOwn(stored, f)) next[f] = stored[f];
        } else if (trusted(stored) && trusted(next) && stored.status !== next.status) {
          const oldVersion = Number(stored.serverRevision);
          const newVersion = Number(next.serverRevision);
          if (!(Number.isSafeInteger(oldVersion) && Number.isSafeInteger(newVersion) && newVersion > oldVersion)) {
            next.status = stored.status;
            next.terminalConflict = [...new Set([...(stored.terminalConflict ?? []), stored.status, rec.status])];
            next.queryHealth = 'needs_review';
          }
        }
        if (Number.isFinite(stored?.progress) && Number.isFinite(next.progress))
          next.progress = Math.max(stored.progress, next.progress);
        next.recVersion = TASK_REC_VERSION;
        return next;
      };
      for (let i = 0; i < 4; i++) {
        const stored = await storage.get(key);
        if (!isSupportedTaskRecord(stored))
          throw Object.assign(new Error('持久任务记录版本高于当前客户端，已拒绝覆盖'), {
            code: 'task_record_version_unsupported', taskId: rec.taskId,
          });
        const next = merge(stored);
        next.rev = isObj(stored) ? (stored.rev ?? 0) + 1 : 1;
        const r = await storage.setIfRev(key, isObj(stored) ? (stored.rev ?? 0) : null, next);
        if (r?.ok) {
          Object.assign(rec, next);
          return { ok: true, record: next, rev: next.rev };
        }
      }
      throw Object.assign(new Error('任务记录持续发生原子写冲突，已保留本地待处理内容'), {
        code: 'task_write_conflict', taskId: rec.taskId,
      });
    },
    async task(taskId) { return storage.get(taskKey(state.project.id, taskId)); },
    async taskIn(pid, taskId) { return storage.get(taskKey(pid, taskId)); },
    async tasksOfProject() {
      const prefix = `task:${state.project.id}:`;
      const out = [];
      for (const k of (await storage.keys()).filter(k => k.startsWith(prefix))) { const r = await storage.get(k); if (r) out.push(r); }
      return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    },
    // 导演台 KV（dir:/dircfg: 前缀，键内嵌节点 id）
    async directorKV(nodeId) {
      const prefix = `dir:${nodeId}:`, cfg = `dircfg:${nodeId}:`;
      const out = {};
      const projectId = state.project?.id;
      for (const k of (await storage.keys()).filter(k => k.startsWith(prefix) || k.startsWith(cfg))) {
        if (k.includes(':hosted-document:') && k !== directorDocumentKey(projectId, nodeId) ||
          k.includes(':hosted-conflict:') && !k.startsWith(`dir:${nodeId}:hosted-conflict:${projectId}:`)) continue;
        out[k] = await storage.get(k);
      }
      return out;
    },

    // ---- 导出：项目 + 素材元数据 + 任务/待创建 + 导演台 KV；无密钥、无 blob ----
    async exportJSON() {
      await store.flush();
      const p = state.project;
      const tasks = await store.tasksOfProject();
      const pending = await store.listPending();
      const director = {};
      for (const n of p.nodes.filter(n => n.type === 'director')) Object.assign(director, await store.directorKV(n.id));
      const data = {
        format: 'xingpan-canvas@2', exportedAt: new Date().toISOString(),
        project: p, tasks, pending, director,
        note: '不含 API Key 与素材文件本体；素材需重新添加本地文件后生成。',
      };
      // 导出密钥字段扫描口径统一：当前项目与其他项目导出同一防线，最常用路径不绕防泄漏兜底
      if (containsSecret(data)) throw new Error('导出被阻止：数据中存在疑似密钥字段，请先清理');
      return JSON.stringify(data, null, 2);
    },
    // options.assetBlobs：Map（或可枚举对象）按「源 assetId → Blob」精确键控的随包媒体——
    // 同名/同型/同大小文件绝不按文件名猜测；blob 暂存全部写全新键，任何失败仅清理本次新键。
    // options.assetIdMap：传入一个 Map 时回填 原assetId → 新assetId 映射（导入失败应整体丢弃）。
    async importJSON(text, { assetBlobs, assetIdMap: outAssetIdMap, assertCurrent = () => {} } = {}) {
      const projectAtStart = state.project;
      const guard = () => {
        if (state.project !== projectAtStart) throw new Error('项目已切换，导入未提交');
        assertCurrent();
      };
      guard();
      const data = JSON.parse(text);
      if (!isObj(data) || data.format !== 'xingpan-canvas@2' || !isObj(data.project)) throw new Error('不是有效的画布导出文件（需 format=xingpan-canvas@2）');
      if (containsSecret(data)) throw new Error('导入文件包含疑似密钥字段，已拒绝');
      const src = data.project;
      if (!str(src.name, 256) || !Array.isArray(src.nodes) || !Array.isArray(src.edges)) throw new Error('项目结构不合法');
      if (src.nodes.length > 500) throw new Error('节点数量超限');
      if (src.edges.length > 2000) throw new Error('连线数量超限');
      if (isObj(src.assets) && Object.keys(src.assets).length > 2000) throw new Error('素材数量超限');
      if (data.tasks != null && (!Array.isArray(data.tasks) || data.tasks.length > 500)) throw new Error('任务记录不合法或超限');
      if (data.pending != null && (!Array.isArray(data.pending) || data.pending.length > 200)) throw new Error('待创建记录不合法或超限');

      // 全量校验通过后才开始写入：任何一步 throw → 当前项目不动
      const nodes = [], idMap = new Map();
      for (const n of src.nodes) {
        const sn = sanitizeNode(n); if (!sn) throw new Error('节点数据不合法');
        const nid = uid(n.type[0]); idMap.set(n.id, nid); sn.id = nid; nodes.push(sn);
      }
      const srcNodes = new Map(src.nodes.filter(isObj).map(n => [n.id, n]));
      const edges = [];
      const seenEdges = new Set();   // 与 addEdge 同一去重面：(to.node,to.port,from.node)，合法扇入不受影响
      for (const e of src.edges) {
        const se = sanitizeEdge(e, srcNodes, src.assets ?? {});
        const dk = `${se.to.node} ${se.to.port} ${se.from.node}`;
        if (seenEdges.has(dk)) throw new Error('重复连线，导入被拒绝');
        seenEdges.add(dk);
        se.id = uid('e');
        se.from.node = idMap.get(se.from.node); se.to.node = idMap.get(se.to.node);
        edges.push(se);
      }
      // 素材统一换新 id（导入不得沿用原 blob/远端身份，防止重绑覆盖原项目数据）
      const assets = {}, assetIdMap = new Map();
      for (const [aid, a] of Object.entries(src.assets ?? {})) {
        const sa = sanitizeAsset(a); if (!sa) throw new Error('素材数据不合法');
        const nid = uid('a'); assetIdMap.set(aid, nid); sa.id = nid;
        if (sa.fromDirector?.startsWith('__node__:')) sa.fromDirector = idMap.get(sa.fromDirector.slice(9)) ?? null;
        assets[nid] = sa;
      }
      const remapAsset = v => (typeof v === 'string' && v.startsWith('__asset__:')) ? (assetIdMap.get(v.slice(10)) ?? MISSING_ASSET) : v;
      const remapBindings = draft => {
        if (!draft?.bindings) return;
        for (const k of Object.keys(draft.bindings)) draft.bindings[k] = remapAsset(draft.bindings[k]);
      };
      // 节点内素材引用重映射：assetId / resultAssetId / draft.bindings / perModel.bindings
      for (const n of nodes) {
        if (n.data.directorSource) { n.data.directorSource.nodeId = idMap.get(n.data.directorSource.nodeId) ?? null;
          n.data.directorSource.characterBindings = remapDirectorBindings(n.data.directorSource.characterBindings, assetIdMap); }
        if (n.type === 'asset') {
          const mapped = remapAsset(n.data.assetId);
          if (mapped && mapped !== MISSING_ASSET) n.data.assetId = mapped;
          else { n.data.assetId = null; n.data.needsRebind = true; }
        }
        if (['gen', 'image', 'utility', 'text'].includes(n.type)) {
          remapBindings(n.data.draft);
          remapBindings(n.data);   // image/utility/text 的 @绑定在 data.bindings 层
          for (const sd of Object.values(n.data.perModel ?? {})) remapBindings(sd);
          if (n.data.resultAssetId != null) n.data.resultAssetId = remapAsset(n.data.resultAssetId);
          if (n.data.outputAssetIds) n.data.outputAssetIds = n.data.outputAssetIds.map(remapAsset);
        }
      }
      const projectId = uid('p');
      const tasks = (data.tasks ?? []).map(t => sanitizeTask(t, projectId, idMap, assetIdMap));
      const pending = (data.pending ?? []).map(r => sanitizePending(r, projectId, idMap, assetIdMap));
      // R02：未决/超窗提交是持久化事实——导入后必须重建节点提交保护。
      // 只信校验过的 pending/task 记录；节点数据里的 run 字段本就不过 sanitizeNode，不得复活。
      const nodeById = new Map(nodes.map(n => [n.id, n]));
      for (const r of pending) {
        const n = r.nodeId ? nodeById.get(r.nodeId) : null;
        if (!n) continue;
        if (r.state === 'rejected') { n.data.run = { rejected: true, error: r.lastError ?? null }; continue; }
        n.data.run = { pendingKey: r.idempotencyKey };
        if (r.state === 'abandoned' || r.state === 'expired_window') n.data.run.detached = true;
        if (r.state === 'expired_window') n.data.run.expired = true;
      }
      // 已受理任务为权威：同键 pending → 升级为 taskId；节点上另有未确认键 → 保护优先，不覆盖
      for (const t of tasks) {
        if (t.detached) continue;
        const n = t.nodeId ? nodeById.get(t.nodeId) : null;
        if (!n) continue;
        if (n.data.run?.pendingKey && n.data.run.pendingKey !== t.idempotencyKey) continue;
        n.data.run = { taskId: t.taskId };
      }
      // 导演台 KV：键内节点 id 重映射；值内 xp-asset:// 令牌按 assetIdMap 重映射
      const director = {};
      for (const [k, v] of Object.entries(isObj(data.director) ? data.director : {})) {
        const m = k.match(/^(dir|dircfg):([^:]+):(.*)$/s); if (!m) continue;
        const mapped = idMap.get(m[2]); if (!mapped) continue;
        if (m[1] === 'dir' && (m[3].startsWith('hosted-document:') || m[3].startsWith('hosted-conflict:'))) {
          if (m[3].startsWith('hosted-document:') ? k !== directorDocumentKey(src.id, m[2])
            : k !== `dir:${m[2]}:hosted-conflict:${src.id}:${v?.conflictId}` || !str(v?.conflictId, 128))
            throw new Error('导演工程存储键与项目绑定不一致');
          const record = remapDirectorRecord(v, { oldProjectId: src.id, oldNodeId: m[2], projectId, nodeId: mapped, assetIdMap });
          const key = m[3].startsWith('hosted-document:') ? directorDocumentKey(projectId, mapped)
            : `dir:${mapped}:hosted-conflict:${projectId}:${v.conflictId}`;
          director[key] = record;
          continue;
        }
        if (typeof v !== 'string' && !isObj(v) && !Array.isArray(v) && typeof v !== 'number' && typeof v !== 'boolean' && v !== null) continue;
        let text = JSON.stringify(v);
        if (text.length > 5e6) throw new Error('导演台数据超限');
        text = text.replace(/xp-asset:\/\/([A-Za-z0-9_-]+)/g, (m0, id) => `xp-asset://${assetIdMap.get(id) ?? id}`);
        director[`${m[1]}:${mapped}:${m[3]}`] = JSON.parse(text);
      }

      const project = { id: projectId, name: (src.name || '导入项目') + '（导入）', createdAt: Date.now(), updatedAt: Date.now(), rev: 1, nodes, edges, assets, studio: importStudio(src.studio, idMap, assetIdMap, assets) };
      const meta = sanitizeMeta(src.meta); if (meta) project.meta = meta;

      // ---- 可选媒体随包：assetBlobs 按「源 assetId → Blob」精确键控。
      // 清单外文件一律不认；校验不过的（非 Blob/空文件）保持显式 missing 占位。
      const supplied = [];
      const directorDigests = new Map();
      for (const record of Object.values(director)) if (record?.format === DIRECTOR_DOCUMENT_FORMAT) {
        for (const dep of record.dependencies) {
          if (directorDigests.has(dep.assetId) && directorDigests.get(dep.assetId) !== dep.sha256 ||
            assets[dep.assetId]?.sha256 && assets[dep.assetId].sha256 !== dep.sha256)
            throw new Error(`导演素材「${dep.assetId}」依赖摘要不一致`);
          directorDigests.set(dep.assetId, dep.sha256);
        }
      }
      if (assetBlobs != null) {
        const srcBlobs = assetBlobs instanceof Map ? assetBlobs.entries() : Object.entries(assetBlobs);
        for (const [oldAid, blob] of srcBlobs) {
          const nid = assetIdMap.get(oldAid);
          if (!nid || !assets[nid]) continue;
          if (!blob || typeof blob.size !== 'number' || blob.size <= 0) continue;
          const rec = assets[nid];
          const expectedDigest = rec.sha256 ?? directorDigests.get(nid);
          if (expectedDigest && await sha256Blob(blob) !== expectedDigest) throw new Error(`素材「${rec.name}」SHA-256 摘要不符，导入未提交`);
          guard();
          rec.missing = false; rec.size = blob.size;
          if (typeof blob.type === 'string' && blob.type) rec.mime = blob.type;
          supplied.push([`blob:${nid}`, blob]);
        }
      }
      // 随包 blob 落位后重算时间线片段 missing：importStudio 早于 blob 暂存运行，
      // 片段缺失标记必须与最终素材可用性一致（完整恢复语义，不得残留错误占位）
      for (const c of project.studio.timeline ?? []) {
        if (c && c.assetId) c.missing = !project.assets[c.assetId] || project.assets[c.assetId].missing === true;
      }
      if (outAssetIdMap instanceof Map) for (const [k, v] of assetIdMap) outAssetIdMap.set(k, v);

      // R11：先把当前项目的防抖待写落盘（lastOpened 回到旧项目），再整体写入新命名空间；
      // 全部成功后才切换内存当前项目——任何存储失败都保留原项目与原任务上下文。
      await store.flushForSwitch();
      guard();
      const entries = [
        [`project:${projectId}`, JSON.parse(JSON.stringify(project))],
        ...tasks.map(t => [taskKey(projectId, t.taskId), t]),
        ...pending.map(r => [pendingKeyOf(projectId, r.idempotencyKey), r]),
        ...Object.entries(director),
        ['lastOpened', projectId],   // 必须最后：它是新项目可见性的指针
      ];
      // blob 暂存全部写全新键（uid 命名空间，不覆盖任何既有数据）；任一步失败仅清理本次新键。
      // 中途项目被切走同样视为失败：当前项目与 lastOpened 指针不动。
      const staged = [];
      try {
        for (const [k, blob] of supplied) {
          guard();
          await storage.setBlob(k, blob);
          staged.push(k);
        }
        guard();
        await commitEntries(entries, project, guard);
      } catch (e) {
        for (const k of staged) { try { await storage.delBlob(k); } catch { /* 尽力清理 */ } }
        throw e;
      }
      return project;
    },
  };
  return store;
}
