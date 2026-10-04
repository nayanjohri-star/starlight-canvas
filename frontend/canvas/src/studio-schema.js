// 本站创作节点合同。与竞品代码及私有接口无依赖。
import { sanitizeRewriteState, sanitizeRewriteRoles } from './rewrite-roles.js';
export const STUDIO_TYPES = {
  text: { title: '文本 / 剧本', ports: { in: [{ id: 'prompt', kind: 'text', label: '文本' }], out: [{ id: 'out', kind: 'text', label: '文本' }] } },
  image: { title: '图片生成', ports: { in: [{ id: 'prompt', kind: 'text', label: '提示词' }, { id: 'refs', kind: 'image', label: '参考图' }], out: [{ id: 'out', kind: 'image', label: '图片' }] } },
  utility: { title: '工具', ports: { in: [{ id: 'refs', kind: 'any', label: '输入' }], out: [{ id: 'out', kind: 'any', label: '结果' }] } },
};
export const SHOT_FIELDS = [
  ['title', '镜头'], ['duration', '时长'], ['description', '画面内容'], ['shotSize', '景别'],
  ['camera', '运镜'], ['emotion', '情绪'], ['lighting', '光线'], ['dialogue', '对白'],
  ['sound', '声音'], ['characters', '角色 / 场景 / 道具'], ['imagePrompt', '图片提示词'], ['videoPrompt', '视频提示词'],
];
export const TOOLS = {
  text_input: '文本输入', json_parse: 'JSON 提取', index_selector: '选择第 N 项',
  resource_merge: '素材合并', grid_split: '图片切格', grid_merge: '图片拼格',
  crop: '图片裁切', video_frame_extract: '提取视频帧', shot_extraction: '等间隔抽帧', batch_table: 'CSV 批量表',
};
export const clone = value => structuredClone(value);
// 展示偏好不进入生成请求。旧项目已有输出连线时保持工作流模式，不能隐藏或丢弃连线。
export function directVideoOutput(project, node) {
  return node?.type === 'gen' && node.data?.directOutput !== false
    && !(project?.edges ?? []).some(edge => edge.from.node === node.id && edge.from.port === 'out');
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v);
const textOf = (v, max = 20000) => typeof v === 'string' ? v.slice(0, max) : '';
const hasText = v => typeof v === 'string' && v.length > 0;
const isStr = (v, max = 2048) => typeof v === 'string' && v.length <= max;

// 运行时单向事实字段：任务、未确认提交、结果身份。编辑历史/复制/版本恢复都不得凭空增删它们——
// 只能「以持久化记录为准」合并（captureRuntime/mergeRuntime）。
export const RUNTIME_KEYS = ['run', 'operation', 'resultAssetId', 'resultText', 'outputAssetIds', 'outputText'];
// 批量克隆来源标记：同样是不得被编辑操作复制的内置身份
export const BATCH_KEY = 'batch';
export function stripRuntime(data) {
  if (!isObj(data)) return;
  for (const k of RUNTIME_KEYS) delete data[k];
  delete data[BATCH_KEY];
}
// 当前在内存中的运行时事实快照（nodeId → {run,operation,...}，仅含存在的键）
export function captureRuntime(nodes) {
  const m = new Map();
  for (const n of nodes ?? []) {
    const r = {};
    for (const k of RUNTIME_KEYS) if (n.data?.[k] !== undefined) r[k] = clone(n.data[k]);
    m.set(n.id, r);
  }
  return m;
}
// 把运行时事实按 nodeId 覆盖回一组节点：先清掉文档里残留的运行时键，再套用最接近当前事实的值。
// 不在 map 里的节点保持文档原样（版本恢复时节点自带的事实身份仍有效，对应持久化任务记录）。
export function mergeRuntime(nodes, runtime) {
  for (const n of nodes ?? []) {
    const r = runtime.get(n.id);
    if (!r) continue;
    for (const k of RUNTIME_KEYS) delete n.data[k];
    Object.assign(n.data, clone(r));
  }
}

// 高级元数据白名单：名字必须显式（x_ 前缀或字母开头的普通标识符），值只接受标量。
export function sanitizeMeta(input, maxEntries = 64) {
  if (!isObj(input)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (Object.keys(out).length >= maxEntries) break;
    if (!/^(x_[a-zA-Z0-9_.-]{1,60}|[a-zA-Z][\w.-]{0,60})$/.test(k)) continue;
    if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) {
      if (typeof v === 'string' && v.length > 4000) continue;
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function outputOf(project, node) {
  if (!node) return { text: '', assets: [], missing: [] };
  const d = node.data ?? {};
  const ids = node.type === 'asset' ? [d.assetId] : Array.isArray(d.outputAssetIds) && d.outputAssetIds.length ? d.outputAssetIds : d.resultAssetId ? [d.resultAssetId] : [];
  // 缺失引用不静默丢弃：null/失效 id 同样以 missing 占位条目保留在 assets 顺序位上，
  // 下游据此显式拒绝，而不是拿残缺输入去收费生成。
  const missing = [];
  const assets = ids.map(id => {
    const a = id ? project?.assets?.[id] : null;
    if (a) return a;
    const stub = { id: id ?? null, name: '（缺失素材）', kind: 'file', missing: true, size: 0 };
    missing.push(stub);
    return stub;
  });
  return { text: node.type === 'text' ? (d.resultText || d.text || '') : (d.outputText || d.resultText || ''), assets, missing };
}
// @引用稳定绑定（'kind:N' → '__asset__:id' 占位，由导入方重映射）。image/utility/text 同样可用。
function sanitizeBindings(b) {
  if (!isObj(b)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (/^(image|video|audio):\d{1,4}$/.test(k) && typeof v === 'string' && v.length <= 128) out[k] = '__asset__:' + v;
  }
  return Object.keys(out).length ? out : undefined;
}
export function sanitizeStudioNode(data) {
  const out = {};
  for (const k of ['title', 'text', 'model', 'prompt', 'system', 'resultText', 'outputText', 'tool', 'resolution', 'ratio'])
    if (typeof data[k] === 'string' && data[k].length <= 200000) out[k] = data[k];
  for (const k of ['seconds', 'width', 'height', 'count', 'index', 'n'])
    if (num(data[k])) out[k] = data[k];
  if (data.params && typeof data.params === 'object' && !Array.isArray(data.params)) {
    out.params = {};
    for (const [k,v] of Object.entries(data.params)) if (/^[a-zA-Z_]{1,40}$/.test(k) && ['number','string','boolean'].includes(typeof v) && String(v).length < 200000) out.params[k] = v;
  }
  const bindings = sanitizeBindings(data.bindings);
  if (bindings) out.bindings = bindings;
  if (typeof data.resultAssetId === 'string') out.resultAssetId = '__asset__:' + data.resultAssetId;
  // 缺失槽位保留 null（不拼成 '__asset__:null'）：导入方重映射后仍是显式占位
  if (Array.isArray(data.outputAssetIds)) out.outputAssetIds = data.outputAssetIds.slice(0, 100).map(id => (typeof id === 'string' && id) ? '__asset__:' + id : null);
  // 未确认的同步图片/文本请求禁止在导入后自动重发。只保留状态，不携带请求与凭据。
  if (data.operation?.state) out.operation = { state: data.operation.state === 'completed' ? 'completed' : 'uncertain', imported: true };
  const meta = sanitizeMeta(data.meta);
  if (meta) out.meta = meta;
  const rewrite = sanitizeRewriteState(data.rewrite);   // AI 改写：所选角色、改写要求、最近 5 版结果
  if (rewrite) out.rewrite = rewrite;
  return out;
}
export function studioState(project) {
  return project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
}

// 工作流运行态导入：running/submitting/waiting 一律降为 paused/pending——
// 导入后绝不自动续跑；未确认提交身份保留文本，由节点上的持久化守卫（而非运行态）决定是否可重发。
const WF_STATUS = new Set(['running', 'paused', 'done', 'failed']);
const WF_NODE_STATUS = new Set(['pending', 'submitting', 'waiting', 'running', 'done', 'failed', 'skipped', 'blocked', 'manual']);
const WF_ROW_STATUS = new Set(['pending', 'running', 'done', 'failed', 'paused']);
function sanitizeWorkflow(w, nodeMap) {
  if (!isObj(w)) return null;
  const text = (v, max = 20000) => typeof v === 'string' ? v.slice(0, max) : '';
  const out = {
    id: text(w.id, 128) || crypto.randomUUID(),
    status: WF_STATUS.has(w.status) ? (w.status === 'running' ? 'paused' : w.status) : 'paused',
    imported: true,
    onlyEmpty: w.onlyEmpty === true,
    pauseReason: '导入的工作流需重新预检并确认新运行；原任务可在任务中心恢复',
    createdAt: num(w.createdAt) ? w.createdAt : Date.now(),
    updatedAt: num(w.updatedAt) ? w.updatedAt : Date.now(),
    budgetYuan: num(w.budgetYuan) ? w.budgetYuan : null,
    estimatedYuan: num(w.estimatedYuan) ? w.estimatedYuan : 0,
    // 本地标准价估算消耗（非实际扣费）；estimatedSpendYuan 为正名，spentYuan 为旧字段镜像
    estimatedSpendYuan: spendOf(w),
    spentYuan: spendOf(w),
    unknownPaid: num(w.unknownPaid) ? w.unknownPaid : 0,
    priceKind: 'standard',
    targets: Array.isArray(w.targets) ? w.targets.map(id => nodeMap.get(id)).filter(Boolean).slice(0, 500) : [],
    cursor: isObj(w.cursor) && num(w.cursor.row) ? { row: Math.max(0, Math.floor(w.cursor.row)) } : { row: 0 },
    rows: [], nodes: {},
    issues: Array.isArray(w.issues) ? w.issues.slice(0, 100).map(i => text(i, 500)) : [],
  };
  for (const r of (Array.isArray(w.rows) ? w.rows : []).slice(0, 200)) {
    if (!isObj(r)) continue;
    out.rows.push({
      id: text(r.id, 128) || crypto.randomUUID(),
      index: num(r.index) ? r.index : out.rows.length,
      fields: isObj(r.fields) ? Object.fromEntries(Object.entries(r.fields).slice(0, 200).map(([k, v]) => [text(k, 200), text(v, 20000)])) : {},
      status: WF_ROW_STATUS.has(r.status) ? (r.status === 'running' ? 'paused' : r.status) : 'pending',
      nodeIds: Array.isArray(r.nodeIds) ? r.nodeIds.map(id => nodeMap.get(id)).filter(Boolean) : [],
      error: text(r.error, 1000) || null,
    });
  }
  for (const [k, v] of Object.entries(isObj(w.nodes) ? w.nodes : {})) {
    const nk = nodeMap.get(k);
    if (!nk || !isObj(v)) continue;
    out.nodes[nk] = {
      src: nodeMap.get(v.src) ?? null,
      type: text(v.type, 32),
      status: WF_NODE_STATUS.has(v.status) ? (['submitting', 'waiting', 'running'].includes(v.status) ? 'pending' : v.status) : 'pending',
      cost: num(v.cost) ? v.cost : null,
      taskId: text(v.taskId, 256) || null,
      pendingKey: text(v.pendingKey, 256) || null,
      reason: text(v.reason, 64) || null,
      error: text(v.error, 1000) || null,
    };
  }
  return out;
}
// 读取估算消耗：新字段优先，兼容旧文档里的 spentYuan
const spendOf = w => num(w.estimatedSpendYuan) ? w.estimatedSpendYuan : (num(w.spentYuan) ? w.spentYuan : 0);

// ---- 富时间线/分镜/合集字段（与 export-project.js normalizeTimeline 同一字段合同）----
const TL_TRACK_SET = new Set(['v1', 'ov1', 'a1', 'a2', 's1']);
const TL_TRACK_ACCEPTS = { v1: ['video', 'image'], ov1: ['image', 'text'], a1: ['audio'], a2: ['audio'], s1: ['subtitle'] };
const TL_CLIP_KINDS = new Set(['video', 'image', 'audio', 'text', 'subtitle']);
const TL_MEDIA_KINDS = new Set(['video', 'image', 'audio']);
const TL_MAX_DURATION = 600, TL_MIN_LEN = 0.05;
const clampNum = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const safeColor = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : '#ffffff';

// 逐字段校验 + assetId 重映射；不重排、不去重叠（布局归一化是时间线侧 tidy() 的职责）。
// 媒体片段缺引用 → missing 占位（片段保留，时间线显示缺素材，绝不静默丢片段）。
function sanitizeTimelineClip(raw, assetMap, assets) {
  if (!isObj(raw)) return null;
  const mappedAsset = hasText(raw.assetId) ? (assetMap.get(raw.assetId) ?? null) : null;
  let kind = TL_CLIP_KINDS.has(raw.kind) ? raw.kind : null;
  if (!kind) {
    const a = mappedAsset ? assets?.[mappedAsset] : null;
    if (a && TL_MEDIA_KINDS.has(a.kind)) kind = a.kind;
    else if (!raw.assetId && (hasText(raw.subtitle) || hasText(raw.text))) kind = 'subtitle';
    else kind = raw.assetId ? 'video' : 'subtitle';
  }
  const track = TL_TRACK_SET.has(raw.track) && TL_TRACK_ACCEPTS[raw.track].includes(kind)
    ? raw.track
    : kind === 'subtitle' ? 's1' : kind === 'text' ? 'ov1' : kind === 'audio' ? 'a1' : (kind === 'image' && raw.track === 'ov1') ? 'ov1' : 'v1';
  const start = clampNum(raw.start, 0, 0, TL_MAX_DURATION);
  let end = clampNum(raw.end, start + TL_MIN_LEN, start + TL_MIN_LEN, TL_MAX_DURATION);
  if (end <= start) end = start + TL_MIN_LEN;
  const len = end - start;
  const clip = {
    id: isStr(raw.id, 128) ? raw.id : crypto.randomUUID(),
    track, kind,
    assetId: mappedAsset,
    name: textOf(raw.name, 200),
    start, end,
    in: clampNum(raw.in, 0, 0, TL_MAX_DURATION * 4),
    speed: clampNum(raw.speed, 1, 0.25, 4),
    volume: clampNum(raw.volume, 1, 0, 1),
    muted: raw.muted === true,
    fadeIn: clampNum(raw.fadeIn, 0, 0, Math.min(30, len / 2)),
    fadeOut: clampNum(raw.fadeOut, 0, 0, Math.min(30, len / 2)),
  };
  if (Number.isFinite(raw.sourceDuration)) clip.sourceDuration = clampNum(raw.sourceDuration, 0, 0, 86400);
  if (raw.durationManual === true && clip.sourceDuration == null) clip.durationManual = true;
  if (kind === 'text' || (kind === 'image' && track === 'ov1')) {
    if (kind === 'text') clip.text = textOf(raw.text ?? raw.subtitle, 2000);
    clip.x = clampNum(raw.x, 0.1, 0, 1); clip.y = clampNum(raw.y, kind === 'text' ? 0.62 : 0.05, 0, 1);
    clip.w = clampNum(raw.w, kind === 'text' ? 0.8 : 0.28, 0.02, 1); clip.h = clampNum(raw.h, kind === 'text' ? 0.3 : 0.28, 0.02, 1);
    if (clip.x + clip.w > 1) clip.x = Math.max(0, 1 - clip.w);
    if (clip.y + clip.h > 1) clip.y = Math.max(0, 1 - clip.h);
    if (kind === 'text') {
      clip.fontSize = clampNum(raw.fontSize, 0.06, 0.02, 0.3);
      clip.color = safeColor(raw.color);
      clip.align = ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
      clip.muted = true; clip.volume = 0;
    }
  }
  if (kind === 'subtitle') {
    clip.text = textOf(raw.text ?? raw.subtitle, 2000);
    clip.subtitle = clip.text;
    clip.muted = true; clip.volume = 0;
  } else if (TL_MEDIA_KINDS.has(kind)) {
    if (hasText(raw.subtitle)) clip.subtitle = textOf(raw.subtitle, 2000);   // 旧版字幕文本随片段保留，由时间线侧迁移到 s1
    clip.missing = mappedAsset ? (!assets?.[mappedAsset] || assets[mappedAsset].missing === true) : true;
  } else clip.subtitle = '';
  const m = sanitizeMeta(raw.meta); if (m) clip.meta = m;
  return clip;
}

// 分镜时长合同（与 storyboard.js SHOT_DURATION_MIN/MAX 同口径）：1–30 整数秒。
// 导入侧不静默夹逼——保留原值；非法/非数值来源标 durationInvalid + durationRaw，
// 由分镜面板显式修正。durationRaw 接受短字符串或有限数字标量。
const shotDurOK = v => Number.isInteger(v) && v >= 1 && v <= 30;
const shotDurRaw = (v, s) => {
  const r = s?.durationRaw;
  if ((typeof r === 'number' && Number.isFinite(r)) || (typeof r === 'string' && r.length <= 64)) return r;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return v.slice(0, 64);
  return v == null ? null : String(v).slice(0, 64);
};
function sanitizeShotDuration(shot, s) {
  const n = Number(s?.duration);
  shot.duration = Number.isFinite(n) ? n : 5;
  if (!shotDurOK(n)) { shot.durationInvalid = true; shot.durationRaw = shotDurRaw(s?.duration, s); }
}

// 分镜：id 稳定保留（节点 params.shotId 等引用不失效）；node/asset 引用重映射，缺失留空位。
function sanitizeShot(s, nodeMap, assetMap) {
  const shot = { id: isStr(s.id, 128) ? s.id : crypto.randomUUID() };
  for (const [k] of SHOT_FIELDS) {
    if (k === 'duration') { sanitizeShotDuration(shot, s); continue; }
    shot[k] = textOf(s[k]);
  }
  shot.nodeId = nodeMap.get(s.nodeId) ?? null;
  shot.imageNodeId = nodeMap.get(s.imageNodeId) ?? null;
  // assetIds 保留空位（null）：缺失引用在恢复时可见，不得悄悄缩减
  shot.assetIds = Array.isArray(s.assetIds) ? s.assetIds.slice(0, 500).map(id => assetMap.get(id) ?? null) : [];
  if (Array.isArray(s.versions)) {
    shot.versions = s.versions.slice(0, 50).map(v => {
      if (!isObj(v)) return null;
      const ver = {
        id: isStr(v.id, 128) ? v.id : crypto.randomUUID(),
        assetId: hasText(v.assetId) ? (assetMap.get(v.assetId) ?? null) : null,
        nodeId: nodeMap.get(v.nodeId) ?? null,
        at: num(v.at) ? v.at : null,
      };
      // versions[].fields 是回滚所需的 12 字段快照：按 SHOT_FIELDS 白名单导入并校验，
      // 缺失/非对象的 fields 保持缺省——回滚侧据此给出明确错误而不是 TypeError
      if (isObj(v.fields)) {
        const f = {};
        for (const [k] of SHOT_FIELDS)
          f[k] = k === 'duration' ? (Number.isFinite(Number(v.fields[k])) ? Number(v.fields[k]) : 5) : textOf(v.fields[k]);
        ver.fields = f;
      }
      for (const k of ['prompt', 'label', 'note']) if (hasText(v[k])) ver[k] = textOf(v[k]);
      if (isStr(v.source, 64)) ver.source = v.source;
      if (isStr(v.kind, 32)) ver.kind = v.kind;
      const vm = sanitizeMeta(v.meta); if (vm) ver.meta = vm;
      return ver;
    }).filter(Boolean);
  }
  if (isObj(s.sync)) {
    const sync = {};
    for (const [k, v] of Object.entries(s.sync)) {
      if (num(v) || typeof v === 'boolean') sync[k] = v;
      else if (typeof v === 'string' && v.length <= 20000) sync[k] = v;
    }
    if (s.sync.nodeId != null) sync.nodeId = nodeMap.get(s.sync.nodeId) ?? null;
    if (s.sync.imageNodeId != null) sync.imageNodeId = nodeMap.get(s.sync.imageNodeId) ?? null;
    if (s.sync.assetId != null) sync.assetId = hasText(s.sync.assetId) ? (assetMap.get(s.sync.assetId) ?? null) : null;
    if (Object.keys(sync).length) shot.sync = sync;
  }
  if (num(s.syncedAt)) shot.syncedAt = s.syncedAt;
  if (s.synced === true) shot.synced = true;
  if (hasText(s.script)) shot.script = textOf(s.script, 200000);
  const m = sanitizeMeta(s?.meta); if (m) shot.meta = m;
  return shot;
}

// assets（可选第 4 参）：新项目的素材表（新 assetId → 记录），用于推断片段 kind 与 missing 标记。
export function importStudio(input, nodeMap, assetMap, assets) {
  const out = { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  if (!input) return out;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('创作数据不合法');
  for (const key of ['groups','shots','timeline']) if (input[key] && (!Array.isArray(input[key]) || input[key].length > 500)) throw new Error('创作数据数量超限');
  const meta = sanitizeMeta(input.meta);
  if (meta) out.meta = meta;
  const roles = sanitizeRewriteRoles(input.rewriteRoles);   // 项目里的 AI 改写角色
  if (roles?.length) out.rewriteRoles = roles;
  out.groups = (input.groups ?? []).map(g => {
    const group = { id: isStr(g?.id, 128) ? g.id : crypto.randomUUID(), title: textOf(g?.title, 256), members: (g?.members ?? []).map(id => nodeMap.get(id)).filter(Boolean) };
    for (const k of ['x', 'y', 'w', 'h']) if (num(g?.[k])) group[k] = g[k];   // 画布分组几何/样式（如画布使用）
    if (isStr(g?.color, 32)) group.color = g.color;
    if (isStr(g?.style, 64)) group.style = g.style;
    const m = sanitizeMeta(g?.meta); if (m) group.meta = m;
    return group;
  });
  out.shots = (input.shots ?? []).map(s => sanitizeShot(s, nodeMap, assetMap));
  out.timeline = (input.timeline ?? []).map(c => sanitizeTimelineClip(c, assetMap, assets)).filter(Boolean);
  if (isObj(input.timelineMeta)) {
    const mm = input.timelineMeta;
    out.timelineMeta = {
      version: 1,
      width: Math.round(clampNum(mm.width, 1280, 16, 1920)),
      height: Math.round(clampNum(mm.height, 720, 16, 1920)),
      fps: clampNum(mm.fps, 30, 1, 60),
      background: safeColor(mm.background ?? '#000000'),
    };
  }
  if (isObj(input.storyboard)) {
    const sb = {};
    if (hasText(input.storyboard.script)) sb.script = textOf(input.storyboard.script, 200000);
    if (num(input.storyboard.updatedAt)) sb.updatedAt = input.storyboard.updatedAt;
    const sm = sanitizeMeta(input.storyboard.meta); if (sm) sb.meta = sm;
    if (Object.keys(sb).length) out.storyboard = sb;
  }
  // 剧本编辑器保存 {text, updatedAt}；导出再导入须保留原文和过期判断。
  // 老版字符串同时归一化，避免进入编辑器时给字符串赋属性。
  const scriptText = typeof input.script === 'string' ? input.script : isObj(input.script) ? input.script.text : undefined;
  if (scriptText !== undefined) {
    if (typeof scriptText !== 'string' || scriptText.length > 8 * 1024 * 1024)
      throw new Error('剧本原文不合法或超过 8MiB 字符上限，整份未导入');
    out.script = { text: scriptText, updatedAt: isObj(input.script) && num(input.script.updatedAt) ? input.script.updatedAt : 0 };
  }
  if (Array.isArray(input.assetCollections)) {
    out.assetCollections = input.assetCollections.slice(0, 200).map(c => {
      if (!isObj(c)) return null;
      const col = { id: isStr(c.id, 128) ? c.id : crypto.randomUUID(), name: textOf(c.name, 60) || '未命名合集',
        assetIds: (Array.isArray(c.assetIds) ? c.assetIds : []).slice(0, 2000).map(a => assetMap.get(a)).filter(Boolean) };
      const cm = sanitizeMeta(c.meta); if (cm) col.meta = cm;
      return col;
    }).filter(Boolean);
  }
  out.workflow = sanitizeWorkflow(input.workflow, nodeMap);
  return out;
}
export function orderedGraph(project, targets) {
  const wanted = new Set(targets?.length ? targets : project.nodes.map(n => n.id));
  const visit = id => { for (const e of project.edges.filter(e => e.to.node === id)) if (!wanted.has(e.from.node)) { wanted.add(e.from.node); visit(e.from.node); } };
  [...wanted].forEach(visit);
  const degree = new Map([...wanted].map(id => [id,0]));
  for (const e of project.edges) if (wanted.has(e.from.node) && wanted.has(e.to.node)) degree.set(e.to.node, degree.get(e.to.node)+1);
  const queue = [...degree].filter(([,d]) => d === 0).map(([id]) => id), ordered = [];
  while (queue.length) { const id = queue.shift(); ordered.push(id); for (const e of project.edges.filter(e => e.from.node === id && wanted.has(e.to.node))) { const d = degree.get(e.to.node)-1; degree.set(e.to.node,d); if (!d) queue.push(e.to.node); } }
  if (ordered.length !== wanted.size) throw new Error('工作流存在循环连线，请先断开循环');
  if (ordered.some(id => !project.nodes.some(n => n.id === id))) throw new Error('工作流包含缺失节点');
  return ordered;
}
export function parseCSV(raw) {
  const rows = []; let row=[], cell='', quote=false;
  const text=String(raw).replace(/^\uFEFF/,'');
  for (let i=0;i<text.length;i++) { const c=text[i]; if(c==='"') { if(quote && text[i+1]==='"'){cell+='"';i++;}else quote=!quote; } else if(c===','&&!quote){row.push(cell);cell='';} else if((c==='\n'||c==='\r')&&!quote){ if(c==='\r'&&text[i+1]==='\n')i++; row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell=''; }else cell+=c; }
  if(quote)throw new Error('CSV 引号未闭合'); row.push(cell);if(row.some(x=>x!==''))rows.push(row);
  const headers=rows.shift()??[];
  if(!headers.length || headers.some(x=>!x.trim()) || new Set(headers).size!==headers.length)throw new Error('CSV 表头不能为空或重复');
  if(rows.length>100)throw new Error('单批最多 100 行');
  return rows.map(r=>{if(r.length!==headers.length)throw new Error('CSV 行列数不一致');return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));});
}
export function template(text,row) { return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_,k)=>{if(!Object.hasOwn(row,k))throw new Error(`缺少批量字段：${k}`);return String(row[k]);}); }

