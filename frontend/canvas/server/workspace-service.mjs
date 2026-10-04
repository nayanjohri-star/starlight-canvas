// 云端工作区服务（本地持久化实现）：账户级项目库 / 修订与命名版本 / ACL + 邀请 / 在线提示。
// 合同与 media-service 相同：createWorkspaceService(opts) → { handleRequest(req, res, pathname) }，
// 不自行监听端口/绑定网络；由 app.mjs 在 assertLocalRequest 之后挂载 /workspace 前缀。
//
// 身份模型（Origin/回环只是传输隔离，不是认证）：
//  · 所有 /workspace 路由必须携带 Authorization: Bearer <本站 API Key>；
//    服务端固定 GET https://xingpan.site/api/usage/token/canvas-identity 验证，
//    可信身份只有其响应里的 subject（账户 id 派生，换 Key 不变）——绝不接受调用方提交的 userId，
//    也不用 key 的哈希当身份。Key 不落盘、不进日志、不进任何响应或文件名；
//    内存身份缓存以 sha256(key) 为索引、仅存 subject/displayName。
//  · 上游 3xx 一律不跟随；非 200（除 401/403）视为"端点未部署/不可用"如实上报，绝不回退匿名身份。
//
// 存储布局（dataDir 由宿主固定注入，绝不默认源码目录；不在此处创建/删除客户数据——仅随用户动作写盘）：
//   index.json                  唯一权威提交点（xp-workspace@2）：projects 内联完整项目元数据
//                               {owner,name,head,members,shares(仅存哈希),versions,revLog,activity,用量} + shares 令牌哈希索引
//   blobs/<sha256>              内容寻址媒体块（跨修订/分叉共享，从不自动删除——修订不再整包复制视频）
//   projects/<pid>/rev/<n>.json 修订记录：project.json+manifest 原文 + media→blob 哈希映射
//   projects/<pid>/meta.json    旧 schema（xp-workspace@1）遗留文件：仅在索引迁移时读取，不再写出
// 写序：blob/rev 先暂存（index 提交前一律不可达）→ index.json 单次 tmp+fsync+rename 原子提交，
// 一次性推进 head/ACL/邀请/配额——崩溃只留不可达孤儿文件，绝不出现“meta 已写/索引未写”的半个可见更新
// （不声称目录 fsync 级掉电保证）。所有变更经单写队列串行（两个并发写必然只有一个胜出）。
// 不做任何自动清理/历史删除；配额超限显式报错。

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProjectPackage, zipStore, PACKAGE_MIME_EXT, PACKAGE_FILE_RE } from '../src/export-project.js';
import { containsSecret } from '../src/store.js';

export const WORKSPACE_IDENTITY_URL = 'https://xingpan.site/api/usage/token/canvas-identity';
const META_FORMAT = 'xp-workspace@1';
const INDEX_FORMAT = 'xp-workspace@2';   // index.json schema：项目元数据全量内联（权威提交点）
const REV_FORMAT = 'xp-workspace-rev@1';
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
// 授权来源追踪（向后兼容）：成员资格由若干授予来源组成 grants = { direct?: role, 'share:<sid>'?: role }。
// 旧数据没有 grants 字段：按 member.via + meta.shares 的兑换记录（claimedBy/claimedAt/role/revokedAt）
// 恢复真实来源集合——绝不能把 via 停在加入时那张邀请上的旧记录直接绑上后来升级到的角色：
//  · via='direct' 或缺失 → direct 明确管理员授权（有效角色中 direct 优先，显式设置不被邀请悄悄抬权/压权）；
//  · via='share:<sid>' → 该邀请是本成员资格的由来：记录仍在且未撤销按其声明 role 入账（不是成员后来升到的 role），
//    记录缺失才退回旧语义（via 绑定 m.role）；已撤销邀请不再贡献授予；
//  · 另恢复当前资格期内由本成员兑换的其他邀请（claimedBy 匹配且 claimedAt >= member.at）——
//    成员被移除后再领新邀请时，早于 member.at 的旧已消费邀请绝不复活（旧消费不自动重授权）；
//    claimedAt 缺失属证据不足，保守不计，不推测扩权；
//  · 邀请过期只禁止兑换，不使已绑定成员自动过期——不检查 expiresAt。
// 有效角色：direct 优先，否则取各邀请来源的最高角色；无有效来源 → null。
function deriveGrants(meta, subject, m) {
  const grants = {};
  const shares = isObj(meta?.shares) ? meta.shares : {};
  const via = typeof m?.via === 'string' ? m.via : null;
  const since = Number.isFinite(m?.at) ? m.at : -Infinity;
  if (!via || via === 'direct') {
    if (ROLE_RANK[m?.role]) grants.direct = m.role;
  } else if (via.startsWith('share:')) {
    const s = shares[via.slice(6)];
    if (!s) { if (ROLE_RANK[m?.role]) grants[via] = m.role; }
    else if (!s.revokedAt && ROLE_RANK[s.role]) grants[via] = s.role;
  }
  for (const [sid, s] of Object.entries(shares)) {
    const key = `share:${sid}`;
    if (key in grants || !isObj(s) || s.revokedAt) continue;
    if (s.claimedBy !== subject || !ROLE_RANK[s.role]) continue;
    if (!Number.isFinite(s.claimedAt) || s.claimedAt < since) continue;
    grants[key] = s.role;
  }
  return grants;
}
function effectiveGrant(grants) {
  if (ROLE_RANK[grants?.direct]) return { role: grants.direct, via: 'direct' };
  let best = null;
  for (const [src, role] of Object.entries(grants ?? {}))
    if (src.startsWith('share:') && ROLE_RANK[role] && (!best || ROLE_RANK[role] > ROLE_RANK[best.role])) best = { role, via: src };
  return best;   // null = 已无有效来源
}
const SUBJECT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PID_RE = /^wp_[0-9a-f-]{36}$/;
const SHARE_ID_RE = /^sh_[0-9a-f]{16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;
const MiB = 1024 * 1024;
const enc = new TextEncoder();

const DEFAULT_LIMITS = {
  maxPackageBytes: 384 * MiB,        // 单包请求体上限
  maxJsonBytes: 64 * 1024,           // JSON 控制请求体上限
  maxProjectJsonBytes: 32 * MiB,     // 包内 project.json 上限
  maxBlobBytes: 128 * MiB,           // 单个媒体块上限
  maxProjectsPerSubject: 64,
  maxAccountBytes: 768 * MiB,
  maxTotalBytes: 4 * 1024 * MiB,
  maxProjectsGlobal: 10_000,
  maxMembers: 64,
  maxShares: 64,
  maxVersions: 200,
  maxRevLog: 500,
  maxActivity: 200,
  maxShareIndex: 10_000,
  presenceTtlMs: 45_000,
  identityCacheTtlMs: 60_000,
  identityCacheMax: 2_000,
  identityFetchTimeoutMs: 8_000,         // 身份验证请求超时上限
  identityMaxResponseBytes: 64 * 1024,   // 身份验证响应体上限
};

export class WorkspaceHttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; if (extra) this.extra = extra; }
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256hex = data => createHash('sha256').update(data).digest('hex');
const etag = rev => `"r${rev}"`;

function parseIfMatch(v) {
  if (typeof v !== 'string') return null;
  const m = /^(?:W\/)?"?r?(\d+)"?$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

// 声明 MIME ↔ 魔数校验：防止任意图片/文本文件伪装成合法项目包内容
function sniffOk(u8, mime) {
  const at = (i, ...b) => b.every((x, k) => u8[i + k] === x);
  const riff4 = tag => u8.length > 12 && at(0, 0x52, 0x49, 0x46, 0x46) && u8[8] === tag.charCodeAt(0) && u8[9] === tag.charCodeAt(1) && u8[10] === tag.charCodeAt(2) && u8[11] === tag.charCodeAt(3);
  switch (mime) {
    case 'image/png': return u8.length > 8 && at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
    case 'image/jpeg': return u8.length > 3 && at(0, 0xFF, 0xD8, 0xFF);
    case 'image/webp': return riff4('WEBP');
    case 'audio/wav': case 'audio/x-wav': return riff4('WAVE');
    case 'video/mp4': case 'audio/mp4': case 'audio/x-m4a': return u8.length > 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70; // 'ftyp'
    case 'video/webm': return u8.length > 4 && at(0, 0x1A, 0x45, 0xDF, 0xA3);
    case 'audio/mpeg': return u8.length > 3 && (at(0, 0x49, 0x44, 0x33) || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0));
    case 'audio/aac': return u8.length > 4 && (at(0, 0x41, 0x44, 0x49, 0x46) || (u8[0] === 0xFF && (u8[1] & 0xF6) === 0xF0));
    case 'model/gltf-binary': {   // GLB 头：magic 'glTF' + version=2 + 头部声明长度必须等于文件长度
      if (u8.length < 20 || !at(0, 0x67, 0x6C, 0x54, 0x46)) return false;
      if (u8[4] !== 2 || u8[5] !== 0 || u8[6] !== 0 || u8[7] !== 0) return false;
      return ((u8[8] | u8[9] << 8 | u8[10] << 16 | u8[11] << 24) >>> 0) === u8.length;
    }
    case 'application/octet-stream': return true;   // .bin 无魔数：由清单身份 + 大小上限 + 项目引用约束
    default: return false;
  }
}

// 嵌入 glTF JSON（.gltf）：必须含 asset.version；buffers/images 只允许 data: URI 或缺省（GLB 内嵌缓冲）——
// 绝不接受 http(s)/file/相对路径等外部 URI：本服务与客户端都不会抓取或执行包内引用的外部资源。
function gltfJsonOk(u8) {
  let g;
  try { g = JSON.parse(new TextDecoder().decode(u8)); } catch { return false; }
  if (!isObj(g) || !isObj(g.asset) || typeof g.asset.version !== 'string') return false;
  for (const r of [...(Array.isArray(g.buffers) ? g.buffers : []), ...(Array.isArray(g.images) ? g.images : [])])
    if (r?.uri != null && (typeof r.uri !== 'string' || !r.uri.startsWith('data:'))) return false;
  return true;
}

// 项目内对 file 类资产的引用收集（与客户端 export-project.collectFileRefs 同规则）：
// 节点绑定/结果/输出/草稿@绑定、分镜、时间线、导演台 xp-asset:// 令牌、fromDirector 标记。
// 非媒体文件（glb/gltf/bin）只有被项目实际引用才允许随包——不接受“只挂了素材记录”的任意二进制。
function collectPackageRefs(data) {
  const refs = new Set();
  const p = data?.project;
  if (!isObj(p)) return refs;
  for (const n of p.nodes ?? []) {
    const d = n?.data;
    if (!isObj(d)) continue;
    if (typeof d.assetId === 'string') refs.add(d.assetId);
    if (typeof d.resultAssetId === 'string') refs.add(d.resultAssetId);
    for (const x of Array.isArray(d.outputAssetIds) ? d.outputAssetIds : []) if (typeof x === 'string') refs.add(x);
    for (const b of Object.values(isObj(d.draft?.bindings) ? d.draft.bindings : {})) if (typeof b === 'string') refs.add(b);
  }
  for (const s of p.studio?.shots ?? []) for (const x of s?.assetIds ?? []) if (typeof x === 'string') refs.add(x);
  for (const c of p.studio?.timeline ?? []) if (typeof c?.assetId === 'string') refs.add(c.assetId);
  for (const m of JSON.stringify(data?.director ?? {}).matchAll(/xp-asset:\/\/([A-Za-z0-9_-]+)/g)) refs.add(m[1]);
  for (const a of Object.values(isObj(p.assets) ? p.assets : {})) if (typeof a?.fromDirector === 'string' && typeof a?.id === 'string') refs.add(a.id);
  return refs;
}

export function createWorkspaceService({ dataDir, upstreamFetch = fetch, limits = {}, clock = () => Date.now(), hooks = {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('createWorkspaceService 需要宿主注入固定数据目录 dataDir（绝不默认源码目录）');
  const L = { ...DEFAULT_LIMITS, ...limits };
  const indexPath = join(dataDir, 'index.json');
  const blobPath = h => join(dataDir, 'blobs', h);
  const metaPath = pid => join(dataDir, 'projects', pid, 'meta.json');
  const revPath = (pid, n) => join(dataDir, 'projects', pid, 'rev', `${n}.json`);
  const revDir = pid => join(dataDir, 'projects', pid, 'rev');

  const identityCache = new Map();   // sha256(key) → {identity, expires}；仅存 subject/displayName，绝不存 key
  const presence = new Map();        // pid → Map<'subject:clientId', {subject, clientId, editing, at}>（易失，不落盘）
  let writeQueue = Promise.resolve();
  // 单写队列：所有持久化变更串行执行——两个并发写同一个项目，后到者在队列内重读 head 必然 409
  const mutate = fn => {
    const run = writeQueue.then(fn);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  // ---------- 基础 IO ----------
  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new WorkspaceHttpError(413, 'body_too_large', '请求体超过大小限制');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req, limit = L.maxJsonBytes) {
    const raw = await readBody(req, limit);
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new WorkspaceHttpError(400, 'invalid_json', '请求体不是合法 JSON'); }
  }
  function send(res, status, obj, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(obj));
  }
  function sendErr(res, e) {
    const err = e instanceof WorkspaceHttpError ? e : new WorkspaceHttpError(500, 'workspace_storage_error', '工作区存储暂时不可用');
    send(res, err.status, { error: { code: err.code, message: err.message, type: 'canvas_error', ...(err.extra ?? {}) } });
  }
  async function writeAtomic(file, data) {
    await mkdir(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    const fh = await open(tmp, 'w');
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, file);
  }
  async function readJsonFile(file) {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    // ENOENT（文件不存在）→ undefined，与"文件存在但内容为 JSON null"严格区分——后者已存在即损坏，按 storage_corrupt 拒写
    catch (e) { if (e?.code === 'ENOENT') return undefined; throw e; }
    try { return JSON.parse(raw); } catch { throw new WorkspaceHttpError(500, 'storage_corrupt', '工作区存储数据损坏'); }
  }
  // 索引条目/邀请索引项的最小结构验证：损坏即 storage_corrupt，绝不静默当空索引
  // （否则下一次 commitIndex 会把旧索引内容正式覆盖掉，表现等同数据丢失）。
  const indexEntryOk = e => isObj(e) && e.format === META_FORMAT && typeof e.owner === 'string' && SUBJECT_RE.test(e.owner);
  const shareRefOk = r => isObj(r) && typeof r.pid === 'string' && typeof r.sid === 'string';
  const corrupt = msg => new WorkspaceHttpError(500, 'storage_corrupt', msg);
  const loadIndex = async () => {
    const idx = await readJsonFile(indexPath);
    if (idx === undefined) return { format: INDEX_FORMAT, projects: {}, shares: {} };   // 索引文件不存在 = 全新存储（唯一合法的空索引）
    // 可解析但结构/格式不符 → storage_corrupt，与不可解析分支同语义
    // （含字面量 null：文件已存在即非"空索引"，拒绝覆盖，原字节与全部历史数据保留供恢复）
    if (!isObj(idx) || !isObj(idx.projects)) throw corrupt('工作区索引结构损坏');
    if (idx.format === META_FORMAT) {
      // 旧 schema（xp-workspace@1）显式迁移：完整元数据在 projects/<pid>/meta.json——读入并内联；
      // 读不到权威元数据的索引残项按孤儿摘除（孤儿 meta.json 不再可服务）；
      // meta.json 存在但损坏则 storage_corrupt 原样上抛，不静默丢项目；
      // 非项目 id 形态的键不按路径使用。迁移只发生在内存：下一次 commitIndex 才以 @2 落盘，
      // 原 v1 文件不删除、不移动。
      if (idx.shares != null && !isObj(idx.shares)) throw corrupt('工作区索引结构损坏');
      idx.shares ??= {};
      for (const [pid, e] of Object.entries(idx.projects)) {
        if (indexEntryOk(e)) continue;
        if (!PID_RE.test(pid)) { delete idx.projects[pid]; continue; }
        const legacy = await readJsonFile(metaPath(pid));
        if (indexEntryOk(legacy)) idx.projects[pid] = legacy;
        else delete idx.projects[pid];
      }
      idx.format = INDEX_FORMAT;
    } else if (idx.format !== INDEX_FORMAT) {
      throw corrupt('工作区索引格式不可识别');
    }
    if (!isObj(idx.shares)) throw corrupt('工作区索引结构损坏');
    for (const [pid, e] of Object.entries(idx.projects))
      if (!indexEntryOk(e)) throw corrupt(`工作区索引中项目 ${String(pid).slice(0, 24)} 的元数据损坏`);
    for (const r of Object.values(idx.shares))
      if (!shareRefOk(r)) throw corrupt('工作区索引中邀请记录损坏');
    return idx;
  };
  // 唯一权威提交点：调用方须先完成 rev/blob 暂存（提交前不可达）；
  // 这里单次原子替换 index.json 推进 head/ACL/份额/配额——要么全生效要么全不生效。
  async function commitIndex(index) {
    await hooks.onCommit?.(index);   // 测试故障注入点：抛出 = 提交失败，已暂存内容保持不可达
    index.format = INDEX_FORMAT;
    await writeAtomic(indexPath, JSON.stringify(index));
  }

  // ---------- 身份 ----------
  async function authenticate(req, { fresh = false } = {}) {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !/^Bearer [^\s]+$/.test(auth) || auth.length > 2048)
      throw new WorkspaceHttpError(401, 'key_required', '云端工作区需要本站 API Key');
    const key = auth.slice(7);
    const cacheId = sha256hex(key);
    const cached = identityCache.get(cacheId);
    // 读操作允许短 TTL 缓存；写操作（fresh）绕过缓存现场向上游复核——
    // 被禁用/撤销的 key 不能靠缓存身份继续写项目、建邀请或兑换。
    if (!fresh && cached && cached.expires > clock()) return cached.identity;
    if (identityCache.size > L.identityCacheMax) {
      const t = clock();
      for (const [k, v] of identityCache) if (v.expires <= t) identityCache.delete(k);
      if (identityCache.size > L.identityCacheMax) identityCache.clear();
    }
    let upstream, payload, reader, timer;
    const ac = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new WorkspaceHttpError(503, 'identity_unavailable', '账户验证超时，工作区未启用'));
      }, L.identityFetchTimeoutMs);
    });
    const bounded = operation => Promise.race([operation, deadline]);
    try {
      upstream = await bounded(upstreamFetch(WORKSPACE_IDENTITY_URL, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: ac.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      }));
      if (upstream.status >= 300 && upstream.status < 400) throw new WorkspaceHttpError(502, 'redirect_blocked', '账户验证接口返回重定向，已拒绝跟随');
      if (upstream.status === 401 || upstream.status === 403) {
        identityCache.delete(cacheId);   // 上游明确拒绝：立即作废缓存项，不再按 TTL 继续放行
        throw new WorkspaceHttpError(401, 'key_rejected', 'API Key 未通过账户验证');
      }
      if (upstream.status !== 200) throw new WorkspaceHttpError(503, 'identity_unavailable', '账户验证接口未部署或暂不可用，工作区未启用');
      const declared = Number(upstream.headers?.get?.('content-length'));
      if (declared > L.identityMaxResponseBytes) throw new WorkspaceHttpError(502, 'identity_bad_response', '账户验证响应超过大小上限');
      let bytes;
      if (upstream.body?.getReader) {
        reader = upstream.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const { done, value } = await bounded(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > L.identityMaxResponseBytes) throw new WorkspaceHttpError(502, 'identity_bad_response', '账户验证响应超过大小上限');
          chunks.push(value);
        }
        bytes = Buffer.concat(chunks, size);
      } else if (typeof upstream.text === 'function') {
        bytes = Buffer.from(await bounded(upstream.text()), 'utf8');
      } else if (typeof upstream.arrayBuffer === 'function') {
        bytes = Buffer.from(await bounded(upstream.arrayBuffer()));
      } else {
        bytes = Buffer.from(JSON.stringify(await bounded(upstream.json())), 'utf8');
      }
      if (bytes.length > L.identityMaxResponseBytes) throw new WorkspaceHttpError(502, 'identity_bad_response', '账户验证响应超过大小上限');
      payload = JSON.parse(bytes.toString('utf8'));
      if (payload?.success !== true && payload?.code !== true) throw new WorkspaceHttpError(502, 'identity_bad_response', '账户验证接口未确认成功');
    } catch (e) {
      if (e instanceof WorkspaceHttpError) throw e;
      throw new WorkspaceHttpError(upstream ? 502 : 503, upstream ? 'identity_bad_response' : 'identity_unavailable', upstream ? '账户验证响应无效' : '账户验证接口暂不可用');
    } finally {
      clearTimeout(timer);
      try { Promise.resolve(reader ? reader.cancel() : upstream?.body?.cancel?.()).catch(() => {}); } catch {}
    }
    const data = isObj(payload?.data) ? payload.data : payload;
    const subject = typeof data?.subject === 'string' ? data.subject : null;
    if (!subject || !SUBJECT_RE.test(subject)) throw new WorkspaceHttpError(502, 'identity_bad_response', '账户验证接口未返回有效身份');
    const identity = { subject, displayName: typeof data.display_name === 'string' ? data.display_name.slice(0, 128) : null };
    identityCache.set(cacheId, { identity, expires: clock() + L.identityCacheTtlMs });
    return identity;
  }
  // 写操作独立再校验 Origin（读操作由 Bearer 认证覆盖）
  function enforceWriteOrigin(req) {
    if (req.headers.origin !== `http://${req.headers.host}`)
      throw new WorkspaceHttpError(403, 'invalid_origin', '写操作必须来自本机画布页面');
  }

  // ---------- 项目/索引 ----------
  const roleOf = (meta, subject) => {
    if (subject === meta.owner) return 'owner';
    const m = meta.members?.[subject];
    if (!isObj(m)) return null;
    // 授权来源集（grants）存在时按来源重算有效角色；旧记录无 grants 字段则按邀请兑换记录恢复来源集
    return effectiveGrant(isObj(m.grants) ? m.grants : deriveGrants(meta, subject, m))?.role ?? null;
  };
  // index.json 是唯一权威：projects[pid] 内联完整 meta；索引里不存在的项目一律 404——
  // 磁盘上的孤儿 meta.json/rev 文件（写入失败残留/旧 schema 残项）都不会变成可见项目。
  const metaFrom = (index, ownerSeg, pid) => {
    if (!PID_RE.test(pid)) throw new WorkspaceHttpError(404, 'project_not_found', '项目不存在或无权访问');
    if (!SUBJECT_RE.test(ownerSeg)) throw new WorkspaceHttpError(404, 'project_not_found', '项目不存在或无权访问');
    const meta = index.projects[pid];
    // 限定 owner 命名空间：知道项目 UUID 但走错命名空间 → 404，拒绝项目 ID 替换
    if (!isObj(meta) || meta.format !== META_FORMAT || meta.owner !== ownerSeg)
      throw new WorkspaceHttpError(404, 'project_not_found', '项目不存在或无权访问');
    meta.id ??= pid; meta.head ??= 0;
    meta.members ??= {}; meta.shares ??= {}; meta.versions ??= []; meta.revLog ??= []; meta.activity ??= [];
    meta.blobIndex ??= {}; meta.docBytes ??= 0; meta.blobBytes ??= 0; meta.bytes ??= 0;
    return meta;
  };
  const requireMeta = async (ownerSeg, pid) => metaFrom(await loadIndex(), ownerSeg, pid);
  const requireRole = (meta, subject, min) => {
    const role = roleOf(meta, subject);
    if (!role) throw new WorkspaceHttpError(404, 'project_not_found', '项目不存在或无权访问');   // 非成员不泄露存在性
    if (ROLE_RANK[role] < ROLE_RANK[min]) throw new WorkspaceHttpError(403, 'role_required', `需要${min === 'owner' ? '所有者' : '编辑者'}及以上权限`);
    return role;
  };
  function appendActivity(meta, subject, action, detail) {
    meta.activity.push({ at: clock(), subject, action, ...(detail ? { detail } : {}) });
    if (meta.activity.length > L.maxActivity) meta.activity.splice(0, meta.activity.length - L.maxActivity);
  }
  // 配额一律按「项目所有者」计账户用量——编辑者推送不能绕过 owner 配额
  function quotaCheck(index, owner, addBytes) {
    let account = 0, global = 0;
    for (const e of Object.values(index.projects)) { global += e.bytes ?? 0; if (e.owner === owner) account += e.bytes ?? 0; }
    // 配额是用户已知的容量边界：只如实报告用量与出路（可读/可导出/扩容或本地备份），
    // 绝不自动删除历史修订或回收 blob——任何清理都必须由用户显式发起，不在此处实现。
    const mib = n => `${(n / MiB).toFixed(1)}MiB`;
    if (account + addBytes > L.maxAccountBytes)
      throw new WorkspaceHttpError(507, 'quota_exceeded',
        `账户云端存储配额已满（已用 ${mib(account)}/上限 ${mib(L.maxAccountBytes)}，本次约需 ${mib(addBytes)}）。已有项目仍可正常读取、拉取与导出；请联系扩容，或用本地导出备份后继续——服务不会自动删除历史修订或媒体。`,
        { usedBytes: account, limitBytes: L.maxAccountBytes, neededBytes: addBytes });
    if (global + addBytes > L.maxTotalBytes)
      throw new WorkspaceHttpError(507, 'quota_exceeded',
        `工作区全局存储配额已满（全局已用 ${mib(global)}/上限 ${mib(L.maxTotalBytes)}）。已有项目仍可正常读取与导出；请联系管理员扩容。`,
        { usedBytes: global, limitBytes: L.maxTotalBytes, neededBytes: addBytes });
  }

  // ---------- 包校验：完整 xp-package@1 + 结构 + 密钥黑名单 + 声明一致性 + 魔数 ----------
  function validatePackage(buf) {
    let parsed;
    try { parsed = parseProjectPackage(buf); }
    catch (e) { throw new WorkspaceHttpError(422, 'invalid_package', `不是有效的项目包：${e.message}`); }
    const { manifest, projectJson, files } = parsed;
    if (projectJson.length > L.maxProjectJsonBytes) throw new WorkspaceHttpError(413, 'project_too_large', '项目数据超过大小限制');
    let exportDoc;
    try { exportDoc = JSON.parse(projectJson); } catch { throw new WorkspaceHttpError(422, 'invalid_project', 'project.json 不是合法 JSON'); }
    if (!isObj(exportDoc) || exportDoc.format !== 'xingpan-canvas@2' || !isObj(exportDoc.project))
      throw new WorkspaceHttpError(422, 'invalid_project', '项目包内项目数据不合法');
    const proj = exportDoc.project;
    if (typeof proj.name !== 'string' || proj.name.length > 256) throw new WorkspaceHttpError(422, 'invalid_project', '项目名不合法');
    if ((proj.nodes != null && !Array.isArray(proj.nodes)) || (proj.edges != null && !Array.isArray(proj.edges)) || (proj.assets != null && !isObj(proj.assets)))
      throw new WorkspaceHttpError(422, 'invalid_project', '项目结构不合法');
    if (containsSecret(exportDoc) || containsSecret(manifest))
      throw new WorkspaceHttpError(422, 'secret_rejected', '项目包含疑似密钥字段，已拒绝');
    const declared = new Set(manifest.media.map(m => m.path));
    for (const name of files.keys())
      if (name !== 'manifest.json' && name !== 'project.json' && !declared.has(name))
        throw new WorkspaceHttpError(422, 'unexpected_entry', `项目包包含未声明的文件：${name.slice(0, 80)}`);
    // 与导入侧同规则：manifest.media[*] 必须与 project.assets[assetId] 精确一致（身份/名称/类型/大小）；
    // file 类素材（导演台 glb/gltf/bin）还必须被项目实际引用——不接受任意挂载的二进制。
    const srcAssets = isObj(proj.assets) ? proj.assets : {};
    const fileRefs = collectPackageRefs(exportDoc);
    const media = manifest.media.map(m => {
      const data = files.get(m.path);
      if (!data || data.length !== m.size) throw new WorkspaceHttpError(422, 'media_tampered', '项目包媒体与清单不一致');
      if (data.length > L.maxBlobBytes) throw new WorkspaceHttpError(413, 'media_too_large', '单个媒体文件超过大小限制');
      const ext = PACKAGE_MIME_EXT[m.mime];
      if (!ext || !PACKAGE_FILE_RE.test(m.path) || m.path !== `media/${m.assetId}.${ext}`)
        throw new WorkspaceHttpError(422, 'media_tampered', '媒体类型与扩展名/素材身份不一致');
      const a = srcAssets[m.assetId];
      if (!isObj(a) || a.name !== m.name || a.kind !== m.kind
        || (typeof a.mime === 'string' && a.mime !== m.mime)
        || (Number.isFinite(a.size) && a.size !== m.size))
        throw new WorkspaceHttpError(422, 'asset_mismatch', `媒体「${String(m.name).slice(0, 60)}」与项目内素材记录不一致`);
      if (m.kind === 'file' && !fileRefs.has(m.assetId))
        throw new WorkspaceHttpError(422, 'file_unreferenced', `文件类素材「${String(m.name).slice(0, 60)}」未被项目引用`);
      const ok = m.mime === 'model/gltf+json' ? gltfJsonOk(data) : sniffOk(data, m.mime);
      if (!ok) throw new WorkspaceHttpError(422, 'media_mime_mismatch', `媒体「${String(m.name).slice(0, 60)}」内容与声明类型不符`);
      return { path: m.path, hash: sha256hex(data), mime: m.mime, size: data.length, data };
    });
    return { manifest, projectJson, media, name: proj.name.slice(0, 256) };
  }

  async function storeBlob(hash, data) {
    try { const s = await stat(blobPath(hash)); if (s.size === data.length) return; } catch { /* 不存在则写 */ }
    await writeAtomic(blobPath(hash), data);
  }
  // 暂存阶段：blob（内容寻址，天然幂等去重）+ rev 文件先落盘——index 提交前一律不可达
  async function stageRevision(pid, rev, pkg, { by, baseRev, kind, forkedFrom }) {
    const revDoc = {
      format: REV_FORMAT, rev, at: clock(), by, baseRev, kind, name: pkg.name,
      projectJson: pkg.projectJson, manifest: pkg.manifest,
      media: pkg.media.map(({ data, ...rest }) => rest),
      ...(forkedFrom ? { forkedFrom } : {}),
    };
    for (const m of pkg.media) await storeBlob(m.hash, m.data);
    await writeAtomic(revPath(pid, rev), JSON.stringify(revDoc));
  }
  // 提交阶段：只在内存对象上推进 head/用量——随后 commitIndex 一次性原子生效
  function applyRevision(meta, rev, pkg, { by, kind }) {
    meta.head = rev;
    meta.docBytes += pkg.projectJson.length + JSON.stringify(pkg.manifest).length + 1024;
    for (const m of pkg.media) if (!(m.hash in meta.blobIndex)) { meta.blobIndex[m.hash] = m.size; meta.blobBytes += m.size; }
    meta.bytes = meta.docBytes + meta.blobBytes;
    meta.revLog.push({ rev, at: clock(), by, kind });
    if (meta.revLog.length > L.maxRevLog) meta.revLog.splice(0, meta.revLog.length - L.maxRevLog);
  }
  const pub = meta => ({ id: meta.id, owner: meta.owner, name: meta.name, head: meta.head, updatedAt: meta.updatedAt });
  function peersFor(pid, subject) {
    const map = presence.get(pid);
    const t = clock(); const out = [];
    if (map) for (const [k, p] of map) {
      if (t - p.at > L.presenceTtlMs) { map.delete(k); continue; }
      out.push({ subject: p.subject, clientId: p.clientId, editing: p.editing === true, at: p.at, self: p.subject === subject });
    }
    return out;
  }

  // ---------- 路由处理 ----------
  async function listProjects(res, identity) {
    const index = await loadIndex();
    const projects = [];
    for (const [id, e] of Object.entries(index.projects)) {
      const role = roleOf(e, identity.subject);   // 与读写路径同一套来源重算：旧记录按兑换记录恢复
      if (!role) continue;
      projects.push({ id, owner: e.owner, name: e.name, head: e.head ?? 0, updatedAt: e.updatedAt ?? null, bytes: e.bytes ?? 0, role, mine: e.owner === identity.subject });
    }
    projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    send(res, 200, { ok: true, subject: identity.subject, projects });
  }

  async function createProject(req, res, identity) {
    const body = await readJson(req);
    const clientRequestId = body?.clientRequestId;
    if (clientRequestId != null && (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(clientRequestId)))
      throw new WorkspaceHttpError(400, 'invalid_request_id', '创建请求标识不合法');
    const name = (typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : '未命名项目').slice(0, 256);
    const out = await mutate(async () => {
      const index = await loadIndex();
      const existing = clientRequestId && Object.values(index.projects).find(p => p.owner === identity.subject && p.clientRequestId === clientRequestId);
      if (existing) {
        if (existing.name !== name && existing.head === 0) throw new WorkspaceHttpError(409, 'request_conflict', '同一创建请求标识不能用于不同项目');
        return { id: existing.id, owner: existing.owner, name: existing.name, head: existing.head, reconciled: true };
      }
      if (Object.values(index.projects).filter(e => e.owner === identity.subject).length >= L.maxProjectsPerSubject)
        throw new WorkspaceHttpError(429, 'quota_exceeded', '云端项目数量已达上限');
      if (Object.keys(index.projects).length >= L.maxProjectsGlobal)
        throw new WorkspaceHttpError(507, 'quota_exceeded', '工作区项目总数已达上限');
      quotaCheck(index, identity.subject, 0);   // 全局/账户字节配额同样约束项目创建
      const pid = 'wp_' + randomUUID();
      const meta = {
        format: META_FORMAT, id: pid, owner: identity.subject, name,
        ...(clientRequestId ? { clientRequestId } : {}),
        createdAt: clock(), updatedAt: clock(), head: 0,
        members: {}, versions: [], shares: {}, revLog: [], activity: [{ at: clock(), subject: identity.subject, action: 'create' }],
        blobIndex: {}, blobBytes: 0, docBytes: 0, bytes: 0,
      };
      index.projects[pid] = meta;
      await commitIndex(index);   // 单次原子提交：项目要么整体可见要么不可见
      return { id: pid, owner: identity.subject, name, head: 0 };
    });
    send(res, 201, { ok: true, project: out });
  }

  async function getProject(req, res, ownerSeg, pid, identity) {
    const meta = await requireMeta(ownerSeg, pid);
    const role = requireRole(meta, identity.subject, 'viewer');
    const et = etag(meta.head);
    if (req.headers['if-none-match'] === et) { res.writeHead(304, { ETag: et, 'Cache-Control': 'no-store' }); return res.end(); }
    send(res, 200, {
      ok: true,
      project: { ...pub(meta), createdAt: meta.createdAt, role, memberCount: Object.keys(meta.members).length },
      versions: meta.versions.map(v => ({ id: v.id, name: v.name, rev: v.rev, at: v.at, by: v.by })),
      activity: meta.activity.slice(-20),
      peers: peersFor(pid, identity.subject),
    }, { ETag: et });
  }

  async function getPackage(req, res, ownerSeg, pid, identity, query) {
    const meta = await requireMeta(ownerSeg, pid);
    requireRole(meta, identity.subject, 'viewer');   // viewer 可读；非成员（仅知 UUID）404
    let rev = meta.head;
    if (query.get('version') != null) {
      const q = query.get('version');
      let v = meta.versions.find(v => v.id === q);   // 版本 ID 优先——名称撞 ID 时按 ID 取
      if (!v) {
        const named = meta.versions.filter(v => v.name === q);
        if (named.length > 1)
          throw new WorkspaceHttpError(409, 'version_ambiguous', `存在 ${named.length} 个同名版本「${q.slice(0, 60)}」，请改用版本 ID 指定`, { matches: named.map(x => x.id) });
        v = named[0] ?? null;   // 名称唯一命中仍兼容
      }
      if (!v) throw new WorkspaceHttpError(404, 'version_not_found', '版本不存在');
      rev = v.rev;
    } else if (query.get('rev') != null) {
      rev = Number(query.get('rev'));
      if (!Number.isInteger(rev) || rev < 1 || rev > meta.head) throw new WorkspaceHttpError(404, 'revision_not_found', '修订不存在');
    }
    const et = etag(rev);
    if (req.headers['if-none-match'] === et) { res.writeHead(304, { ETag: et, 'Cache-Control': 'no-store' }); return res.end(); }
    const revDoc = await readJsonFile(revPath(pid, rev));
    if (!revDoc || revDoc.format !== REV_FORMAT) throw new WorkspaceHttpError(404, 'revision_not_found', '修订不存在');
    const entries = [
      { name: 'manifest.json', data: enc.encode(JSON.stringify(revDoc.manifest)) },
      { name: 'project.json', data: enc.encode(revDoc.projectJson) },
    ];
    for (const m of revDoc.media) {
      let data;
      try { data = await readFile(blobPath(m.hash)); } catch { throw new WorkspaceHttpError(500, 'blob_missing', '存储中的媒体块缺失'); }
      entries.push({ name: m.path, data });
    }
    const zip = zipStore(entries);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': zip.length,
      ETag: et, 'X-Workspace-Rev': String(rev), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(Buffer.from(zip));
  }

  async function putProject(req, res, ownerSeg, pid, identity) {
    const base = parseIfMatch(req.headers['if-match']);
    if (base == null) throw new WorkspaceHttpError(428, 'base_revision_required', '推送必须携带 If-Match 基线修订号');
    const buf = await readBody(req, L.maxPackageBytes);
    if (!buf.length) throw new WorkspaceHttpError(400, 'empty_package', '项目包为空');
    const pkg = validatePackage(buf);   // 锁外完成 CPU 校验；角色/基线在锁内复核
    const result = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'editor');   // viewer 直接 HTTP PUT 也写不进去
      if (meta.head !== base)
        throw new WorkspaceHttpError(409, 'revision_conflict', `基线修订过期：远端已到 r${meta.head}`, { head: meta.head, base });
      const addBytes = pkg.projectJson.length + JSON.stringify(pkg.manifest).length + 4096
        + pkg.media.filter(m => !(m.hash in meta.blobIndex)).reduce((s, m) => s + m.size, 0);
      quotaCheck(index, meta.owner, addBytes);   // 按项目所有者计配额——编辑者不能以自己名义绕过 owner 配额
      const rev = meta.head + 1;
      await stageRevision(pid, rev, pkg, { by: identity.subject, baseRev: base, kind: 'push' });   // 先暂存（不可达）
      applyRevision(meta, rev, pkg, { by: identity.subject, kind: 'push' });
      meta.name = pkg.name; meta.updatedAt = clock();
      appendActivity(meta, identity.subject, 'push', { rev });
      await commitIndex(index);   // 唯一权威提交点：head/用量/名称一次生效
      return { rev, head: rev, bytes: meta.bytes };
    });
    send(res, 201, { ok: true, ...result }, { ETag: etag(result.head) });
  }

  async function renameProject(req, res, ownerSeg, pid, identity) {
    const body = await readJson(req);
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 256) : '';
    if (!name) throw new WorkspaceHttpError(400, 'invalid_name', '项目名不能为空');
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'editor');
      meta.name = name; meta.updatedAt = clock();
      appendActivity(meta, identity.subject, 'rename');
      await commitIndex(index);
      return pub(meta);
    });
    send(res, 200, { ok: true, project: out });
  }

  async function getRevisions(res, ownerSeg, pid, identity) {
    const meta = await requireMeta(ownerSeg, pid);
    requireRole(meta, identity.subject, 'viewer');
    send(res, 200, { ok: true, head: meta.head, revisions: meta.revLog, versions: meta.versions, truncated: meta.revLog.length >= L.maxRevLog });
  }

  async function createVersion(req, res, ownerSeg, pid, identity) {
    const body = await readJson(req);
    const name = (typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : '未命名版本').slice(0, 200);
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'editor');
      const rev = body?.rev == null ? meta.head : Number(body.rev);
      if (!Number.isInteger(rev) || rev < 1 || rev > meta.head || !(await readJsonFile(revPath(pid, rev))))
        throw new WorkspaceHttpError(404, 'revision_not_found', '修订不存在');
      if (meta.versions.length >= L.maxVersions) throw new WorkspaceHttpError(429, 'quota_exceeded', '命名版本数量已达上限');
      const v = { id: 'v_' + randomBytes(8).toString('hex'), name, rev, at: clock(), by: identity.subject };
      meta.versions.push(v);
      appendActivity(meta, identity.subject, 'version', { rev, name });
      await commitIndex(index);
      return v;
    });
    send(res, 201, { ok: true, version: out });
  }

  async function forkProject(req, res, ownerSeg, pid, identity) {
    const body = await readJson(req);
    const out = await mutate(async () => {
      const index = await loadIndex();
      const src = metaFrom(index, ownerSeg, pid);
      requireRole(src, identity.subject, 'viewer');   // viewer 可读即可分叉为自己的副本
      const rev = body?.rev == null ? src.head : Number(body.rev);
      if (!Number.isInteger(rev) || rev < 1 || rev > src.head) throw new WorkspaceHttpError(404, 'revision_not_found', '修订不存在');
      const revDoc = await readJsonFile(revPath(pid, rev));
      if (!revDoc) throw new WorkspaceHttpError(404, 'revision_not_found', '修订不存在');
      if (Object.values(index.projects).filter(e => e.owner === identity.subject).length >= L.maxProjectsPerSubject)
        throw new WorkspaceHttpError(429, 'quota_exceeded', '云端项目数量已达上限');
      if (Object.keys(index.projects).length >= L.maxProjectsGlobal)
        throw new WorkspaceHttpError(507, 'quota_exceeded', '工作区项目总数已达上限');
      const npid = 'wp_' + randomUUID();
      const meta = {
        format: META_FORMAT, id: npid, owner: identity.subject,
        name: (typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : `${src.name}（分叉）`).slice(0, 256),
        createdAt: clock(), updatedAt: clock(), head: 0, members: {}, versions: [],
        shares: {}, revLog: [], activity: [{ at: clock(), subject: identity.subject, action: 'fork', detail: { from: pid, rev } }],
        blobIndex: {}, blobBytes: 0, docBytes: 0, bytes: 0,
      };
      // 分叉复用同一批内容寻址 blob，不复制媒体文件
      for (const m of revDoc.media) { meta.blobIndex[m.hash] = m.size; meta.blobBytes += m.size; }
      meta.docBytes = revDoc.projectJson.length + JSON.stringify(revDoc.manifest).length + 1024;
      meta.bytes = meta.docBytes + meta.blobBytes;
      quotaCheck(index, identity.subject, meta.bytes);   // 分叉计入新 owner 的账户/全局字节配额
      const newRev = { ...revDoc, rev: 1, at: clock(), by: identity.subject, baseRev: null, kind: 'fork', forkedFrom: { project: pid, rev }, name: meta.name };
      await writeAtomic(revPath(npid, 1), JSON.stringify(newRev));   // 暂存：index 提交前不可达
      meta.head = 1;
      meta.revLog.push({ rev: 1, at: clock(), by: identity.subject, kind: 'fork' });
      index.projects[npid] = meta;
      await commitIndex(index);
      return { id: npid, owner: identity.subject, name: meta.name, head: 1, fromRev: rev };
    });
    send(res, 201, { ok: true, project: out });
  }

  async function getMembers(res, ownerSeg, pid, identity) {
    const meta = await requireMeta(ownerSeg, pid);
    requireRole(meta, identity.subject, 'owner');   // 成员/邀请列表仅所有者
    send(res, 200, {
      ok: true,
      members: Object.entries(meta.members).map(([subject, m]) => {
        const grants = isObj(m.grants) ? m.grants : deriveGrants(meta, subject, m);   // 旧记录按兑换记录恢复来源展示
        const eff = effectiveGrant(grants);
        return { subject, role: eff?.role ?? m.role ?? null, at: m.at, via: eff?.via ?? m.via ?? null, grants };
      }),
      shares: Object.entries(meta.shares).map(([id, s]) => ({ id, role: s.role, createdAt: s.createdAt, expiresAt: s.expiresAt, revoked: !!s.revokedAt, claimed: !!s.claimedBy, claimedBy: s.claimedBy ?? null, memberRemoved: !!s.memberRemovedAt })),
    });
  }

  async function setMember(req, res, ownerSeg, pid, target, identity) {
    const body = await readJson(req);
    const role = body?.role;
    if (!SUBJECT_RE.test(target)) throw new WorkspaceHttpError(400, 'invalid_subject', '目标身份不合法');
    if (role !== 'editor' && role !== 'viewer') throw new WorkspaceHttpError(400, 'invalid_role', '角色仅支持 editor / viewer');
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'owner');   // 仅所有者可设置成员——非所有者无法自助提权
      if (target === meta.owner || target === identity.subject) throw new WorkspaceHttpError(400, 'cannot_change_self', '不能修改所有者自身身份');
      const cur = meta.members[target];
      if (!cur && Object.keys(meta.members).length >= L.maxMembers) throw new WorkspaceHttpError(429, 'quota_exceeded', '成员数量已达上限');
      if (!cur) {
        meta.members[target] = { role, at: clock(), by: identity.subject, via: 'direct', grants: { direct: role } };
      } else {
        // direct 是明确管理员授权：只覆盖 direct 来源（邀请来源保留在案），且 direct 在有效角色中优先——
        // 例如显式降级为 viewer 不会被仍有效的 editor 邀请授予悄悄抬回
        if (!isObj(cur.grants)) cur.grants = deriveGrants(meta, target, cur);
        cur.grants.direct = role;
        cur.at = clock(); cur.by = identity.subject;
        const eff = effectiveGrant(cur.grants);
        cur.role = eff.role; cur.via = eff.via;
      }
      appendActivity(meta, identity.subject, 'member_set', { target, role });
      await commitIndex(index);
      return { subject: target, role };
    });
    send(res, 200, { ok: true, member: out });
  }

  async function removeMember(res, ownerSeg, pid, target, identity) {
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'owner');
      if (target === meta.owner) throw new WorkspaceHttpError(400, 'cannot_remove_owner', '不能移除所有者');
      if (!meta.members[target]) throw new WorkspaceHttpError(404, 'member_not_found', '成员不存在');
      delete meta.members[target];
      appendActivity(meta, identity.subject, 'member_revoked', { target });
      await commitIndex(index);
      return { subject: target };
    });
    send(res, 200, { ok: true, removed: out });
  }

  async function createShare(req, res, ownerSeg, pid, identity) {
    const body = await readJson(req);
    const role = body?.role === 'editor' ? 'editor' : 'viewer';
    const hours = Math.min(720, Math.max(1, Number(body?.expiresInHours) || 72));
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'owner');
      const active = Object.values(meta.shares).filter(s => !s.revokedAt && s.expiresAt > clock()).length;
      if (active >= L.maxShares) throw new WorkspaceHttpError(429, 'quota_exceeded', '有效邀请数量已达上限');
      const token = randomBytes(24).toString('base64url');         // 只进响应一次，绝不落盘
      const hash = sha256hex(token);                                // 服务端只存哈希
      const sid = 'sh_' + randomBytes(8).toString('hex');
      const share = { hash, role, createdAt: clock(), expiresAt: clock() + hours * 3600_000, revokedAt: null, claimedBy: null, claimedAt: null };
      meta.shares[sid] = share;
      appendActivity(meta, identity.subject, 'share_created', { role, id: sid });
      if (Object.keys(index.shares).length > L.maxShareIndex) {
        const t = clock();
        for (const [h, r] of Object.entries(index.shares)) if (r.expiresAt <= t) delete index.shares[h];
      }
      index.shares[hash] = { pid, sid, expiresAt: share.expiresAt };
      await commitIndex(index);   // 邀请与令牌哈希索引同一提交点生效——不存在“meta 有邀请/索引无令牌”的中间态
      return { id: sid, role, expiresAt: share.expiresAt, fragment: `#ws-claim=${token}` };   // 令牌只出现在 URL 片段
    });
    send(res, 201, { ok: true, share: { id: out.id, role: out.role, expiresAt: out.expiresAt }, invite: { fragment: out.fragment } });
  }

  async function revokeShare(res, ownerSeg, pid, sid, identity) {
    if (!SHARE_ID_RE.test(sid)) throw new WorkspaceHttpError(404, 'invite_not_found', '邀请不存在');
    const out = await mutate(async () => {
      const index = await loadIndex();
      const meta = metaFrom(index, ownerSeg, pid);
      requireRole(meta, identity.subject, 'owner');
      const share = meta.shares[sid];
      if (!share) throw new WorkspaceHttpError(404, 'invite_not_found', '邀请不存在');
      share.revokedAt = clock();
      let memberRemoved = null, memberUpdated = null;
      // 按来源撤销：只移除本邀请贡献的授予 share:<sid>，其余来源（其他邀请 / direct 明确授权）不受影响。
      // 有效角色按剩余来源重算——全部来源失效才移除成员：不再因 via 恰好指这张邀请而误踢仍持有效授权的成员，
      // 也不会因 via 停在旧邀请上而让已撤销的提权继续有效。
      const grantKey = `share:${sid}`;
      for (const [subj, m] of Object.entries(meta.members)) {
        if (!isObj(m)) continue;
        const legacy = !isObj(m.grants);
        if (legacy) m.grants = deriveGrants(meta, subj, m);
        // deriveGrants 已排除刚撤销的来源，旧记录仍须重算和清理空成员。
        if (!legacy && !(grantKey in m.grants)) continue;
        delete m.grants[grantKey];
        const eff = effectiveGrant(m.grants);
        if (!eff) {
          delete meta.members[subj];
          share.memberRemovedAt = clock();
          memberRemoved = subj;
          appendActivity(meta, identity.subject, 'member_revoked', { target: subj, via: grantKey });
        } else if (eff.role !== m.role || eff.via !== m.via) {
          m.role = eff.role; m.via = eff.via;
          memberUpdated = { subject: subj, role: eff.role };
          appendActivity(meta, identity.subject, 'member_role_changed', { target: subj, via: grantKey, role: eff.role });
        }
      }
      appendActivity(meta, identity.subject, 'share_revoked', { id: sid });
      await commitIndex(index);
      return { memberRemoved, memberUpdated };
    });
    send(res, 200, { ok: true, memberRemoved: out.memberRemoved, ...(out.memberUpdated ? { memberUpdated: out.memberUpdated } : {}) });
  }

  async function claim(req, res, identity) {
    const body = await readJson(req);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!TOKEN_RE.test(token)) throw new WorkspaceHttpError(400, 'invite_invalid', '邀请令牌格式不合法');
    const hash = sha256hex(token);
    const out = await mutate(async () => {
      const index = await loadIndex();
      const ref = index.shares[hash];
      if (!ref) throw new WorkspaceHttpError(404, 'invite_not_found', '邀请不存在或已被撤销');
      const meta = isObj(index.projects[ref.pid]) && index.projects[ref.pid].format === META_FORMAT ? index.projects[ref.pid] : null;
      const share = meta?.shares?.[ref.sid];
      if (!meta || !share || share.revokedAt) throw new WorkspaceHttpError(404, 'invite_not_found', '邀请不存在或已被撤销');
      if (share.expiresAt <= clock()) throw new WorkspaceHttpError(410, 'invite_expired', '邀请已过期');
      const mine = roleOf(meta, identity.subject);
      // 角色已满足（含 owner/同级成员兑他人令牌）：幂等返回 already——不消耗令牌、不看 claimedBy
      if (mine && ROLE_RANK[mine] >= ROLE_RANK[share.role])
        return { already: true, project: pub(meta), role: mine };
      // 需要此邀请才能加入/提权：已消耗令牌绝不自动重授权
      if (share.claimedBy && share.claimedBy !== identity.subject)
        throw new WorkspaceHttpError(409, 'invite_already_claimed', '邀请已被其他账户兑换');
      if (share.claimedBy === identity.subject)
        throw new WorkspaceHttpError(409, 'invite_consumed', '邀请已兑换且成员资格已被移除，不自动重新授权——请由所有者再次邀请');
      meta.members ??= {};
      const member = meta.members[identity.subject];
      // 授权按来源入账：本邀请只贡献 grants['share:<sid>'] 一份授予，不动其他来源；
      // 有效角色按全部来源重算（direct 明确授权优先，否则各邀请来源取最高）——
      // viewer 邀请后再兑 editor 邀请两份授予都记录在案，撤销其一只回收对应来源。
      if (!member) {
        if (Object.keys(meta.members).length >= L.maxMembers) throw new WorkspaceHttpError(429, 'quota_exceeded', '成员数量已达上限');
        meta.members[identity.subject] = { role: share.role, at: clock(), by: meta.owner, via: `share:${ref.sid}`, grants: { [`share:${ref.sid}`]: share.role } };
      } else {
        if (!isObj(member.grants)) member.grants = deriveGrants(meta, identity.subject, member);   // 旧记录按邀请兑换记录恢复等价来源
        member.grants[`share:${ref.sid}`] = share.role;
        const eff = effectiveGrant(member.grants);
        member.role = eff.role; member.via = eff.via;
        member.upgradedAt = clock();
      }
      share.claimedBy = identity.subject; share.claimedAt = clock();   // 授权绑定到已验证 subject
      appendActivity(meta, identity.subject, 'claim', { role: share.role, id: ref.sid });
      await commitIndex(index);
      return { already: false, project: pub(meta), role: meta.members[identity.subject].role };
    });
    send(res, 200, { ok: true, ...out });
  }

  async function presenceBeat(req, res, ownerSeg, pid, identity) {
    const body = await readJson(req);
    const clientId = typeof body?.clientId === 'string' ? body.clientId.slice(0, 64) : null;
    if (!clientId) throw new WorkspaceHttpError(400, 'invalid_client', 'clientId 不合法');
    const meta = await requireMeta(ownerSeg, pid);
    requireRole(meta, identity.subject, 'viewer');
    let map = presence.get(pid);
    if (!map) presence.set(pid, map = new Map());
    map.set(`${identity.subject}:${clientId}`, { subject: identity.subject, clientId, editing: body.editing === true, at: clock() });
    send(res, 200, { ok: true, head: meta.head, peers: peersFor(pid, identity.subject) });
  }

  async function getPresence(res, ownerSeg, pid, identity) {
    const meta = await requireMeta(ownerSeg, pid);
    requireRole(meta, identity.subject, 'viewer');
    send(res, 200, { ok: true, head: meta.head, peers: peersFor(pid, identity.subject) });
  }

  const dec = s => { try { return decodeURIComponent(s); } catch { throw new WorkspaceHttpError(400, 'invalid_path', '地址编码无效'); } };

  async function handleRequest(req, res, rawPath) {
    const [pathOnly, qs] = String(rawPath ?? '').split('?');
    if (!pathOnly.startsWith('/workspace')) return false;
    try {
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(req.method)) throw new WorkspaceHttpError(405, 'method_not_allowed', '不支持此请求方法');
      const isWrite = !['GET', 'HEAD'].includes(req.method);
      if (isWrite) enforceWriteOrigin(req);
      const identity = await authenticate(req, { fresh: isWrite });   // 所有 /workspace 路由都要已验证身份；写操作现场复核，不用 TTL 缓存
      const segs = pathOnly.split('/').filter(Boolean).slice(1).map(dec);
      const query = new URLSearchParams(qs ?? '');
      const [s0, s1, s2, s3, s4] = segs;
      if (s0 === 'identity' && segs.length === 1 && req.method === 'GET')
        return send(res, 200, { ok: true, subject: identity.subject, displayName: identity.displayName }), true;
      if (s0 === 'claim' && segs.length === 1 && req.method === 'POST') { await claim(req, res, identity); return true; }
      if (s0 === 'projects') {
        if (segs.length === 1) {
          if (req.method === 'GET') { await listProjects(res, identity); return true; }
          if (req.method === 'POST') { await createProject(req, res, identity); return true; }
        } else if (segs.length >= 3) {
          const [owner, pid, sub, sub2] = [s1, s2, s3, s4];
          if (segs.length === 3) {
            if (req.method === 'GET' || req.method === 'HEAD') { await getProject(req, res, owner, pid, identity); return true; }
            if (req.method === 'PUT') { await putProject(req, res, owner, pid, identity); return true; }
          } else if (sub === 'package' && segs.length === 4 && req.method === 'GET') { await getPackage(req, res, owner, pid, identity, query); return true; }
          else if (sub === 'revisions' && segs.length === 4 && req.method === 'GET') { await getRevisions(res, owner, pid, identity); return true; }
          else if (sub === 'versions' && segs.length === 4 && req.method === 'POST') { await createVersion(req, res, owner, pid, identity); return true; }
          else if (sub === 'fork' && segs.length === 4 && req.method === 'POST') { await forkProject(req, res, owner, pid, identity); return true; }
          else if (sub === 'rename' && segs.length === 4 && req.method === 'POST') { await renameProject(req, res, owner, pid, identity); return true; }
          else if (sub === 'members' && segs.length === 4 && req.method === 'GET') { await getMembers(res, owner, pid, identity); return true; }
          else if (sub === 'members' && segs.length === 5 && req.method === 'PUT') { await setMember(req, res, owner, pid, sub2, identity); return true; }
          else if (sub === 'members' && segs.length === 5 && req.method === 'DELETE') { await removeMember(res, owner, pid, sub2, identity); return true; }
          else if (sub === 'shares' && segs.length === 4 && req.method === 'POST') { await createShare(req, res, owner, pid, identity); return true; }
          else if (sub === 'shares' && segs.length === 5 && req.method === 'DELETE') { await revokeShare(res, owner, pid, sub2, identity); return true; }
          else if (sub === 'presence' && segs.length === 4 && req.method === 'POST') { await presenceBeat(req, res, owner, pid, identity); return true; }
          else if (sub === 'presence' && segs.length === 4 && req.method === 'GET') { await getPresence(res, owner, pid, identity); return true; }
        }
      }
      throw new WorkspaceHttpError(404, 'route_not_found', '工作区路由不存在');
    } catch (e) { sendErr(res, e); }
    return true;
  }

  return { handleRequest };
}
