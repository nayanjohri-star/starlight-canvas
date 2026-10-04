// 能力表加载与适配：数据源为构建期拷入的 capabilities.json（即 docs/星盘AI_视频模型能力表.json）。
// 提供 UI 意图→metadata.mode 映射、费用估算、提交前校验。纯逻辑，node 可测。
// 画布侧规则数据/常量集中于 capability-rules.js（§6.5），本模块消费并转发，导出面不变。

import { newGenerationBlock } from './runtime-config.js';
import { getProvider } from './providers.js';
import { isExternalProvider, EXTERNAL_IMAGE_SIZES } from './provider-config.js';
import { getModelCatalog } from './keyvault.js';
import { outputOf } from './studio-schema.js';
import {
  INTENTS, MEDIA_KINDS, MEDIA_SECONDS_RULES, REMOTE_GRACE_MS,
  IMAGE25_MODELS, IMAGE_SIZES, VALID_IMAGE_SIZES,
  IMAGE_DECODE_MAX_SIDE, IMAGE_DECODE_MAX_PIXELS, IMAGE_RESULT_MAX_BYTES, IMAGE_EDIT_MAX_BYTES, IMAGE_EDIT_MAX_REFERENCES,
  CHAT_NAME_RE, NON_CHAT_NAME_RE,
} from './capability-rules.js';
export {
  INTENTS, MEDIA_KINDS, MEDIA_SECONDS_RULES, REMOTE_GRACE_MS,
  IMAGE25_MODELS, IMAGE_SIZES, VALID_IMAGE_SIZES,
  IMAGE_DECODE_MAX_SIDE, IMAGE_DECODE_MAX_PIXELS, IMAGE_RESULT_MAX_BYTES, IMAGE_EDIT_MAX_BYTES, IMAGE_EDIT_MAX_REFERENCES,
  CHAT_NAME_RE, NON_CHAT_NAME_RE,
} from './capability-rules.js';

let table = null;

export async function loadCapabilities(fetchImpl) {
  const res = await (fetchImpl ?? fetch)('capabilities.json');
  if (!res.ok) throw new Error('能力表加载失败');
  table = await res.json();
  return table;
}
export function setCapabilities(t) { table = t; }
export function capabilities() { return table; }
export function modelIds() { return table ? Object.keys(table.models) : []; }
export function getModel(id) { return table?.models?.[id] ?? null; }

// UI 意图 → request metadata.mode 映射表已迁入 capability-rules.js（INTENTS）；
// 意图集合按 family 过滤的规则保持原语义。
export function intentsFor(modelId) {
  const m = getModel(modelId);
  if (!m) return [];
  // 旧版能力表没有 capability_modes，沿用其 family 契约；新版按显式能力过滤。
  // last_frame 复用 frames mode 与同一输入口，仅型号显式声明 supports_last_frame_only 时提供。
  return (INTENTS[m.family] ?? []).filter(i => {
    if (i.intent === 'frames') return !m.capability_modes || m.capability_modes.includes('first_last_frame');
    if (i.intent === 'last_frame') return m.supports_last_frame_only === true;
    return true;
  });
}
export function modeForIntent(modelId, intent) {
  const hit = intentsFor(modelId).find(x => x.intent === intent);
  return hit ? hit.mode : null;
}

export function estimateCost(modelId, seconds) {
  if (isExternalProvider(getProvider())) return null;
  const m = getModel(modelId);
  if (!m || !Number.isFinite(seconds)) return null;
  return m.billing_unit === 'request' ? m.price_cny_per_request : Math.round(m.price_cny_per_second * seconds * 100) / 100;
}

export const UPLOAD_LIMITS = () => table?.upload_limits ?? null;

export function fileKind(file) {
  const u = UPLOAD_LIMITS(); if (!u) return null;
  for (const kind of MEDIA_KINDS) if (u[kind].content_types.includes(file.type)) return kind;
  return null;
}
export function fileMaxBytes(kind) { const u = UPLOAD_LIMITS(); return u ? u[kind].max_mib * 1024 * 1024 : 0; }

// 型号级素材介质限制（能力表可选字段 media_max_bytes / media_content_types）。
// mediaLimitSummary(modelId) → {image,video,audio:{maxBytes:number|null,contentTypes:string[]|null}}；
// 型号未声明任何介质限制 → null。供 UI 提示与提交前预检共用。
export function mediaLimitSummary(modelId) {
  const m = getModel(modelId);
  if (!m) return null;
  const out = {};
  let any = false;
  for (const k of MEDIA_KINDS) {
    const max = m.media_max_bytes?.[k], types = m.media_content_types?.[k];
    out[k] = { maxBytes: Number.isFinite(max) ? max : null, contentTypes: Array.isArray(types) ? types.slice() : null };
    if (out[k].maxBytes != null || out[k].contentTypes != null) any = true;
  }
  return any ? out : null;
}
// 型号级素材时长合同（秒）：能力表尚无 media_seconds 字段的画布侧声明已迁入
// capability-rules.js（MEDIA_SECONDS_RULES）；表内字段存在时优先。
// mediaDurationRule(modelId) → {min,max,kind_total} 或 null；本地提示与 post 核验共用同一词表。
export function mediaDurationRule(modelId) {
  const r = getModel(modelId)?.media_seconds ?? MEDIA_SECONDS_RULES[modelId];
  return r && Number.isFinite(r.min) && Number.isFinite(r.max) ? r : null;
}
// 介质预检：只用本地元数据 a.mime / a.size —— 明确非法或超限才拒绝；元数据缺失给可操作提示。
// 不查 remote/时长：陈旧过期 remote 不得在 pre 阶段阻挡重新上传。返回 '' 表示通过。
export function mediaPrecheckError(modelId, assets) {
  const lim = mediaLimitSummary(modelId);
  if (!lim) return '';
  for (const a of assets ?? []) {
    const r = lim[a?.kind]; if (!r) continue;
    const name = `素材「${a?.name ?? '?'}」`;
    if (r.contentTypes) {
      if (typeof a.mime !== 'string' || !a.mime) return `${name}缺少本地格式信息，请重新绑定文件`;
      if (!r.contentTypes.includes(a.mime)) return `${name}格式 ${a.mime} 不在该型号支持范围（${r.contentTypes.join('、')}）`;
    }
    if (r.maxBytes != null) {
      if (!Number.isFinite(a.size)) return `${name}缺少本地大小信息，请重新绑定文件`;
      if (!Number.isInteger(a.size) || a.size <= 0) return `${name}本地文件为空或大小异常，请重新绑定文件`;
      if (a.size > r.maxBytes) return `${name}超过该型号单文件上限（${r.maxBytes / 1000000}MB，1MB=1,000,000字节）`;
    }
  }
  return '';
}

// 素材条目形如 {id,name,kind,remote:{url,expiresAt,durationSeconds}}。
// @引用稳定绑定：bindings = { 'image:1': assetId, 'video:2': assetId, ... }。
// 绑定按“第 N 个该类素材”首次出现时固化到 assetId；此后素材被删/换序不会让 @图片N 悄悄指到别的素材——
// 绑定对象不在当前连线里 → missing（引用失效），不静默错指。
export function resolvePromptRefs(prompt, refs, bindings = {}) {
  const byKind = { image: refs.filter(r => r.kind === 'image'), video: refs.filter(r => r.kind === 'video'), audio: refs.filter(r => r.kind === 'audio') };
  const missing = [];
  const labelOf = { image: '图片', video: '视频', audio: '音频' };
  const normalized = String(prompt ?? '').replace(/@(图片|视频|音频)(\d+)/g, (m0, label, idx) => {
    const kind = Object.keys(labelOf).find(k => labelOf[k] === label);
    const boundId = bindings?.[`${kind}:${idx}`];
    let i;
    if (boundId) {
      i = byKind[kind].findIndex(a => a.id === boundId);
      if (i < 0) { missing.push(m0); return m0; }
    } else {
      i = Number(idx) - 1;
      if (!byKind[kind][i]) { missing.push(m0); return m0; }
    }
    // 本站规范 token：图片→@N，视频→@视频N，音频→@音频N（与 Portal normalizedReferencePrompt 一致）
    return kind === 'image' ? `@${i + 1}` : `@${label}${i + 1}`;
  });
  return { normalized, missing };
}

// 为 prompt 中未绑定的 @XN 固化当前位置绑定（返回新 bindings，不 mutate 入参）
export function syncPromptBindings(prompt, refs, bindings = {}) {
  const byKind = { image: refs.filter(r => r.kind === 'image'), video: refs.filter(r => r.kind === 'video'), audio: refs.filter(r => r.kind === 'audio') };
  const labelOf = { image: '图片', video: '视频', audio: '音频' };
  const next = { ...bindings };
  String(prompt ?? '').replace(/@(图片|视频|音频)(\d+)/g, (m0, label, idx) => {
    const kind = Object.keys(labelOf).find(k => labelOf[k] === label);
    const key = `${kind}:${idx}`;
    if (!next[key] && byKind[kind][Number(idx) - 1]) next[key] = byKind[kind][Number(idx) - 1].id;
    return m0;
  });
  return next;
}

function remoteProblem(a) {
  if (a.missing) return `素材「${a.name ?? '?'}」本地文件缺失`;
  const r = a.remote;
  if (!r || typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) return `素材「${a.name ?? '?'}」缺少有效远端地址（需先上传成功）`;
  if (!Number.isFinite(r.expiresAt) || r.expiresAt * 1000 <= Date.now() + REMOTE_GRACE_MS) return `素材「${a.name ?? '?'}」远端已过期/缺少有效期，请重新上传`;
  return null;
}

// 提交校验。phase='pre'：上传前——只验型号/参数/数量/类型/模式；素材远端与时长不验（本地文件还没有服务端探测）。
//          phase='post'：全部上传完成后——远端地址/有效期/服务端时长严格验证，任何缺失即拒绝 POST。
// 新生成准入（运行形态）：只拦截新的提交（phase='pre'）；同幂等键重试未确认提交、查询与下载不经过这里
export function modelAvailability(modelId) {
  const reason = newGenerationBlock(modelId);
  return reason ? { newGeneration: false, reason } : { newGeneration: true, reason: null };
}
export function validateDraft(modelId, draft, refs, frames, wireProblems = [], phase = 'pre') {
  const m = getModel(modelId);
  if (!m) return '未选择型号';
  if (phase === 'pre') { const blocked = newGenerationBlock(modelId); if (blocked) return blocked; }
  if (wireProblems.length) return `连线来源未就绪：${wireProblems[0]}`;
  const { seconds, ratio, intent, prompt, switches = {} } = draft;
  if (!Number.isInteger(seconds) || seconds < m.seconds.min || seconds > m.seconds.max || (m.allowed_seconds && !m.allowed_seconds.includes(seconds)))
    return m.allowed_seconds ? `时长须为 ${m.allowed_seconds.join('/')} 秒` : `时长须为 ${m.seconds.min}–${m.seconds.max} 整数秒`;
  if (!m.ratios.options.includes(ratio)) return '比例不在该型号支持范围';
  if ((m.billing_unit === 'request' || m.supports_last_frame_only) && ratio === 'auto' && !refs.concat(frames).some(x=>x.kind!=='audio')) return '自适应比例需要视觉素材';
  const mode = modeForIntent(modelId, intent);
  if (!mode) return '该型号不支持所选模式';
  if (!prompt || !prompt.trim()) return '提示词不能为空';
  if ([...prompt].length > m.prompt_max_characters) return `提示词超过 ${m.prompt_max_characters} 字符上限`;
  // 任何非图/视频/音频素材一律拒绝（file/未知 kind 不可作为参考上传）
  if (refs.concat(frames).some(a => !MEDIA_KINDS.includes(a.kind))) return '连线素材类型不可作为视频参考';

  const lim = m.reference_limits;
  const count = k => refs.filter(r => r.kind === k).length;
  const nImg = count('image'), nVid = count('video'), nAud = count('audio');

  if (intent === 'text' && (refs.length || frames.length)) return '纯文字模式不应连接素材';
  if (intent === 'refs') {
    if (!refs.length) return '素材参考模式需要至少一个素材';
    if (frames.length) return '素材参考模式不应连接首尾帧';
    if (nImg > lim.image || nVid > lim.video || nAud > lim.audio) return '素材数量超过该型号分项上限';
    if (refs.length > lim.total) return `素材合计超过 ${lim.total} 上限`;
    if (m.family === 'h3' && !m.supports_audio_only && nAud > 0 && nImg + nVid === 0) return 'H3 音频参考需要同时带图片或视频';
  }
  if (intent === 'i2v') {
    if (m.family !== 'wan') return '该型号不支持单图模式';
    if (!(nImg === 1 && nVid === 0 && nAud === 0) || frames.length) return '单图模式需要且仅能使用一张图片';
  }
  if (intent === 'frames') {
    if (m.family === 'wan') return 'Wan 不支持首尾帧';
    if (refs.length) return '首尾帧模式不应连接普通素材';
    if (frames.some(f => f.kind !== 'image')) return '首尾帧只能使用图片';
    if (m.family === 'sd25' && frames.length !== 2) return 'SD 首尾帧需要恰好两张图片（首帧+尾帧）';
    if (m.family === 'h3' && (frames.length < 1 || frames.length > 2)) return 'H3 首帧模式需要 1–2 张图片（可只有首帧）';
  }
  if (intent === 'last_frame') {
    if (refs.length) return '仅尾帧模式不应连接普通素材';
    if (frames.length !== 1) return '仅尾帧模式需要恰好一张图片';
    if (frames[0].kind !== 'image') return '仅尾帧只能使用图片';
  }
  // 型号级介质预检（mime/size 本地元数据）：明确非法/超限在此拒绝，缺失给可操作提示
  const mediaErr = mediaPrecheckError(modelId, refs.concat(frames));
  if (mediaErr) return mediaErr;
  if (m.switches.face_mode && switches.face_mode === true && nImg + frames.length === 0)
    return '人脸模式需要参考图片或首尾帧';
  const { missing, normalized } = resolvePromptRefs(prompt, refs, draft.bindings);
  if (missing.length) return `提示词引用未连接素材或已失效：${missing.join('、')}`;
  if ([...normalized].length > m.prompt_max_characters) return `规范化后提示词超过 ${m.prompt_max_characters} 字符上限`;
  if (phase === 'post') {
    for (const a of [...refs, ...frames]) { const p = remoteProblem(a); if (p) return p; }
    if (m.family === 'sd25') {
      const vids = refs.filter(r => r.kind === 'video');
      if (vids.some(v => !Number.isFinite(v.remote?.durationSeconds) || v.remote.durationSeconds <= 0))
        return '参考视频缺少可信时长（duration_seconds），请重新上传';
      if (Math.ceil(vids.reduce((s, v) => s + v.remote.durationSeconds, 0)) > 30)
        return '参考视频合计时长超过 30 秒（服务端上限）';
    }
    // 型号级素材时长合同（如满参慢速版：每条 2–15s、各类型合计 ≤15s）：只认上传后的
    // remote.durationSeconds——缺失/不可信即拒绝创建；pre 阶段与本地时长都不走这里。
    const dr = mediaDurationRule(modelId);
    if (dr) {
      const kindLabel = { video: '视频', audio: '音频' };
      for (const k of ['video', 'audio']) {
        const items = refs.filter(r => r.kind === k);
        if (items.some(v => !Number.isFinite(v.remote?.durationSeconds) || v.remote.durationSeconds <= 0))
          return `参考${kindLabel[k]}缺少可信时长（duration_seconds），请重新上传`;
        if (items.some(v => v.remote.durationSeconds < dr.min || v.remote.durationSeconds > dr.max))
          return `参考${kindLabel[k]}每条须为 ${dr.min}–${dr.max} 秒`;
        if (Number.isFinite(dr.kind_total) &&
          Math.ceil(items.reduce((s, v) => s + v.remote.durationSeconds, 0)) > dr.kind_total)
          return `参考${kindLabel[k]}合计时长超过 ${dr.kind_total} 秒`;
      }
    }
  }
  return '';
}

// 构造创建请求体字符串。严格：任一素材类型不明 / 缺 url / 过期 → 抛错（不静默丢素材、不收费）。
// 构建后由调用方持久化原始字符串，重试不得重新序列化。
export function buildCreateBody(modelId, draft, refs, frames) {
  const m = getModel(modelId);
  if (!m) throw new Error('未选择型号');
  const mode = modeForIntent(modelId, draft.intent);
  if (!mode) throw new Error('该型号不支持所选模式');
  const urlOf = a => {
    if (!MEDIA_KINDS.includes(a?.kind)) throw new Error(`素材「${a?.name ?? '?'}」类型不可作为视频参考`);
    const p = remoteProblem(a);
    if (p) throw new Error(p);
    return a.remote.url;
  };
  const { normalized, missing } = resolvePromptRefs(draft.prompt, refs, draft.bindings);
  if (missing.length) throw new Error(`提示词引用未连接素材或已失效：${missing.join('、')}`);
  if ([...normalized].length > m.prompt_max_characters) throw new Error(`规范化后提示词超过 ${m.prompt_max_characters} 字符上限`);
  const metadata = { ratio: draft.ratio, mode };
  if (draft.intent === 'frames') {
    if (frames[0]) metadata.first_frame_url = urlOf(frames[0]);
    if (frames[1]) metadata.last_frame_url = urlOf(frames[1]);
    if (!metadata.first_frame_url && metadata.last_frame_url) throw new Error('不能只给尾帧');
  } else if (draft.intent === 'last_frame') {
    // 仅尾帧：恰好一张图片 → 只发 last_frame_url，不发 first_frame_url / 普通素材数组
    if (refs.length) throw new Error('仅尾帧模式不应连接普通素材');
    if (frames.length !== 1) throw new Error('仅尾帧模式需要恰好一张图片');
    if (frames[0].kind !== 'image') throw new Error('仅尾帧只能使用图片');
    metadata.last_frame_url = urlOf(frames[0]);
  } else {
    // 任何未知类型素材一律抛错——不得被过滤成纯文字请求后收费
    for (const a of refs) if (!MEDIA_KINDS.includes(a?.kind)) throw new Error(`素材「${a?.name ?? '?'}」类型不可作为视频参考`);
    const pick = k => refs.filter(r => r.kind === k).map(urlOf);
    const im = pick('image'), vi = pick('video'), au = pick('audio');
    if (im.length) metadata.image_urls = im;
    if (vi.length) metadata.video_urls = vi;
    if (au.length) metadata.audio_urls = au;
  }
  // 仅能力允许的开关才发送；显式 false 保留；不支持的型号一律不带
  if (m.switches.generate_audio && draft.switches?.generate_audio !== undefined)
    metadata.generate_audio = !!draft.switches.generate_audio;
  if (m.switches.face_mode && draft.switches?.face_mode !== undefined)
    metadata.face_mode = !!draft.switches.face_mode;
  return JSON.stringify({ model: modelId, prompt: normalized, seconds: draft.seconds, metadata });
}

// ==================== 同步文本 / 图片生成能力（本站合同）====================

// image2.5 型号目录与 档位→比例→尺寸 表已迁入 capability-rules.js
//（IMAGE25_MODELS / IMAGE_SIZES / VALID_IMAGE_SIZES）；下列助手语义不变。
export const imageModelIds = () => {
  const p = getProvider();
  if (p.protocol !== 'openai') return Object.keys(IMAGE25_MODELS);
  const discovered = (getModelCatalog() ?? []).filter(e => {
    const id = typeof e === 'string' ? e : e?.id;
    return e?.endpoints?.some?.(x => /images\/generations/.test(x)) || /^(?:gpt-image-|dall-e-)/i.test(id ?? '');
  }).map(e => typeof e === 'string' ? e : e.id);
  return [...new Set([...p.imageModels, ...discovered])];
};
export const getImageModel = id => getProvider().protocol === 'openai'
  ? imageModelIds().includes(id) ? { id, display_name: id, external: true } : null : IMAGE25_MODELS[id] ?? null;

const imageSizes = () => getProvider().protocol === 'openai' ? EXTERNAL_IMAGE_SIZES : IMAGE_SIZES;
export const imageResolutions = () => Object.keys(imageSizes());
export const imageRatios = resolution => Object.keys(imageSizes()[resolution] ?? {});
export const imageSizeFor = (resolution, ratio) => imageSizes()[resolution]?.[ratio] ?? null;

// 返回 ¥/张；无可靠标准价 → null（UI 标注「标准价未验证」）
export function estimateImageYuan(modelId, resolution) {
  const v = getImageModel(modelId)?.price?.[resolution];
  return Number.isFinite(v) ? v : null;
}

// 图片报价详情：已验证标准价（standard）→ 版本化基线估算（standard_estimate）→ unknown。
// 站点公开价目与手动估算由调用方（studio-gen.quote）在此之上合并。
export function imagePriceInfo(modelId, resolution) {
  if (isExternalProvider(getProvider())) return { yuan: null, kind: 'unknown' };
  const m = getImageModel(modelId);
  const v = m?.price?.[resolution];
  if (Number.isFinite(v)) return { yuan: v, kind: 'standard' };
  const e = m?.standard_estimate?.[resolution];
  if (Number.isFinite(e)) return { yuan: e, kind: 'standard_estimate', version: m.estimate_version ?? null };
  return { yuan: null, kind: 'unknown' };
}

// /api/pricing 响应的安全解析：只保留 {型号:{字段:number}} 或 {型号:number} 中的纯数字，
// 字符串/表达式（billing_expr 等）与未知结构一律丢弃——绝不 eval、不推断语义。
export function parsePricing(data) {
  const out = {};
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6;
  const src = (data && typeof data === 'object' && !Array.isArray(data))
    ? (data.models && typeof data.models === 'object' && !Array.isArray(data.models) ? data.models
      : data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data)
    : {};
  for (const [id, v] of Object.entries(src)) {
    if (typeof id !== 'string' || !id || id.length > 256) continue;
    if (ok(v)) { out[id] = { unit: v }; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nums = {};
      for (const [k, x] of Object.entries(v)) if (typeof k === 'string' && k.length <= 64 && ok(x)) nums[k] = x;
      if (Object.keys(nums).length) out[id] = nums;
    }
  }
  return out;
}

// 图片结构解析（非浏览器环境的本地解码兜底）：不只看魔数——
// PNG 需完整 IHDR+IEND；JPEG 需扫到 SOF 且以 EOI 结尾；WebP 解析 VP8X/VP8L/VP8 尺寸且 RIFF 长度须完整。
// 截断/伪造文件在此失败，不得入库。返回 {width,height}，失败抛错。
export function localImageDecode(bytes, mime) {
  const fail = () => { throw new Error('图片内容不完整或已损坏，解码校验未通过'); };
  const tag = o => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (mime === 'image/png') {
    if (bytes.length < 45) fail();
    if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 0x0D || tag(12) !== 'IHDR') fail();
    const w = (bytes[16] * 0x1000000 + bytes[17] * 0x10000 + bytes[18] * 0x100 + bytes[19]) >>> 0;
    const h = (bytes[20] * 0x1000000 + bytes[21] * 0x10000 + bytes[22] * 0x100 + bytes[23]) >>> 0;
    if (!w || !h) fail();
    if (tag(bytes.length - 8) !== 'IEND') fail();   // 截断 PNG 没有结尾 IEND 块
    return { width: w, height: h };
  }
  if (mime === 'image/jpeg') {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) fail();
    let i = 2, w = 0, h = 0;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xD9) break;                                   // EOI
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2 || i + 2 + len > bytes.length) fail();            // 段越界 = 截断
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        h = (bytes[i + 5] << 8) | bytes[i + 6]; w = (bytes[i + 7] << 8) | bytes[i + 8]; break;
      }
      i += 2 + len;
    }
    if (!w || !h) fail();
    if (bytes[bytes.length - 2] !== 0xFF || bytes[bytes.length - 1] !== 0xD9) fail();   // 无 EOI = 截断
    return { width: w, height: h };
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30) fail();
    const riffSize = (bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24) >>> 0;
    if (riffSize + 8 > bytes.length) fail();                        // RIFF 声明超出实际 = 截断
    if (tag(12) === 'VP8X') return { width: 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16), height: 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16) };
    if (tag(12) === 'VP8L') {
      if (bytes[20] !== 0x2F) fail();
      const b = bytes[21] | bytes[22] << 8 | bytes[23] << 16 | bytes[24] << 24;
      return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 };
    }
    if (tag(12) === 'VP8 ') {
      if (bytes[23] !== 0x9D || bytes[24] !== 0x01 || bytes[25] !== 0x2A) fail();
      return { width: (bytes[26] | bytes[27] << 8) & 0x3FFF, height: (bytes[28] | bytes[29] << 8) & 0x3FFF };
    }
    fail();
  }
  fail();
}
// 结果图片上界/接收上限已迁入 capability-rules.js
//（IMAGE_DECODE_MAX_SIDE / IMAGE_DECODE_MAX_PIXELS / IMAGE_RESULT_MAX_BYTES / IMAGE_EDIT_MAX_BYTES）。
// 接收侧仍先按 b64 字符串长度估出原始字节数——绝不先分配几十 MB 解码缓冲再发现异常。
// 不解码计算 b64 载荷字节数；长度非法（%4===1）返回 -1
export function b64DecodedSize(b64) {
  const clean = String(b64 ?? '').replace(/\s+/g, '');
  if (!clean.length || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || (clean.includes('=') && clean.length % 4 !== 0)) return -1;
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor(clean.length * 3 / 4) - pad;
}

// ---- 图片编解码与校验：解码 + 魔数核对后才允许入库/上传 ----

export function decodeBase64(b64) {
  const clean = String(b64 ?? '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}
export function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
}
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}
// 单张参考图 dataURL：PNG/JPEG/WebP、≤30MiB、声明类型与魔数一致
export function parseImageDataURL(url) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(url ?? '');
  if (!m) throw new Error('参考图必须为 PNG/JPEG/WebP 的 data URL');
  const bytes = decodeBase64(m[2]);
  if (!bytes.length) throw new Error('参考图内容为空');
  if (bytes.length > IMAGE_EDIT_MAX_BYTES) throw new Error('参考图超过 30MiB 上限');
  if (sniffImageMime(bytes) !== `image/${m[1]}`) throw new Error('参考图内容与声明格式不符');
  return { mime: `image/${m[1]}`, bytes };
}

// ---- 请求体构造：同步接口。stream 恒 false；max_tokens 必须显式；图片恒 n=1 + b64_json ----
export function buildChatBody({ model, system, prompt, messages, maxTokens, temperature } = {}) {
  if (typeof model !== 'string' || !model || model.length > 256) throw new Error('未选择文本型号');
  const msgs = messages ?? [
    ...(system?.trim() ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt ?? '' },
  ];
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 200) throw new Error('对话内容不能为空');
  const clean = msgs.map(m => {
    if (!m || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 200000)
      throw new Error('对话内容为空或超长');
    return { role: ['system', 'assistant'].includes(m.role) ? m.role : 'user', content: m.content };
  });
  const mt = Number(maxTokens);
  if (!Number.isInteger(mt) || mt < 1 || mt > 128000) throw new Error('max_tokens 必须为 1–128000 的整数');
  const body = { model, messages: clean, stream: false, max_tokens: mt };
  if (Number.isFinite(temperature)) body.temperature = Math.min(2, Math.max(0, temperature));
  return JSON.stringify(body);
}

export function buildImageBody({ model, prompt, size } = {}) {
  if (!getImageModel(model)) throw new Error('未选择图片型号');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('提示词不能为空');
  if ([...prompt].length > 32000) throw new Error('提示词超过 32000 字符上限');
  if (typeof size !== 'string' || !/^\d{3,5}x\d{3,5}$/.test(size)) throw new Error('尺寸不合法');
  const [w, h] = size.split('x').map(Number);
  if (!w || !h || w > 3840 || h > 3840) throw new Error('边长超过 3840 上限');
  const valid = getProvider().protocol === 'openai' ? new Set(Object.values(EXTERNAL_IMAGE_SIZES['1K'])) : VALID_IMAGE_SIZES;
  if (!valid.has(size)) throw new Error('尺寸不在当前接口支持范围');
  return JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' });
}
export function buildImageEditBody({ model, prompt, size, imageDataUrl, imageDataUrls } = {}) {
  const base = JSON.parse(buildImageBody({ model, prompt, size }));
  if (getProvider().protocol === 'openai' && /^dall-e-/i.test(model)) throw new Error('此适配器不支持 DALL-E 参考图编辑');
  if (imageDataUrl !== undefined && imageDataUrls !== undefined) throw new Error('参考图输入重复');
  const refs = imageDataUrls ?? [imageDataUrl];
  if (!Array.isArray(refs) || !refs.length || refs.length > IMAGE_EDIT_MAX_REFERENCES)
    throw new Error(`请选择 1–${IMAGE_EDIT_MAX_REFERENCES} 张参考图`);
  let total = 0;
  for (const ref of refs) {
    total += parseImageDataURL(ref).bytes.length;
    if (total > IMAGE_EDIT_MAX_BYTES) throw new Error('参考图合计超过 30MiB 上限');
  }
  if (refs.length === 1) base.image = refs[0];
  else base.images = refs;
  return JSON.stringify(base);
}

// 从 /v1/models 原始目录挑文本型号：只认明确迹象（endpoints/tags/name），不臆测能力；
// 视频型号与图片型号一律排除，且绝不回写视频能力表。
// 名称词表（CHAT_NAME_RE / NON_CHAT_NAME_RE）已迁入 capability-rules.js：
// 缺少显式端点声明时一律排除非对话用途；有显式 endpoints 时以端点为准（声明优先于名字猜测）。
export function chatModelIdsFromCatalog(entries) {
  if (!Array.isArray(entries)) return [];
  const video = new Set(modelIds()), image = new Set(imageModelIds());
  const out = [];
  for (const e of entries) {
    const id = typeof e === 'string' ? e : e?.id;
    if (!id || video.has(id) || image.has(id) || out.includes(id)) continue;
    const endpoints = Array.isArray(e?.endpoints) ? e.endpoints.filter(x => typeof x === 'string') : null;
    if (endpoints?.length) {
      // 显式端点声明优先：声明了对话接口才收；只声明图片/视频端点的型号绝不靠名字混进对话列表
      if (endpoints.some(x => /chat\/completions|\/chat\b/i.test(x))) out.push(id);
      continue;
    }
    if (NON_CHAT_NAME_RE.test(id)) continue;
    const tags = Array.isArray(e?.tags) ? e.tags.join(' ') : (typeof e?.tags === 'string' ? e.tags : '');
    if (/对话|聊天|文本|chat|llm/i.test(tags) || CHAT_NAME_RE.test(id)) out.push(id);
  }
  return out;
}

// ==================== 节点输出解析（连线输入统一入口）====================
// outputOf 会把丢失素材静默过滤（.filter(Boolean)）；付费安全要求“缺一个报一个”，
// 因此这里以原始输出 id 列表为准——缺失即显式问题，绝不静默丢引用后继续生成。

export function nodeOutputIds(node) {
  const d = node?.data ?? {};
  if (node?.type === 'asset') return d.assetId ? [d.assetId] : [];
  if (Array.isArray(d.outputAssetIds) && d.outputAssetIds.length) return d.outputAssetIds;
  return d.resultAssetId ? [d.resultAssetId] : [];
}
export function nodeOutputs(project, node) {
  if (!node) return { text: '', assets: [], missing: ['来源节点已删除'], assetIds: [] };
  const label = `「${node.data?.title || node.id}」`;
  const ids = nodeOutputIds(node);
  const assets = [], missing = [];
  for (const id of ids) {
    const a = id ? project.assets?.[id] : null;
    if (!a) missing.push(`${label}引用的素材已不存在`);
    else if (a.missing) missing.push(`素材「${a.name}」本地文件缺失`);
    else assets.push(a);
  }
  return { text: outputOf(project, node).text ?? '', assets, missing, assetIds: ids };
}
// 某端口全部连线的输出合集：素材、文本、问题三类；每条线要么有可用输出，要么产生显式问题
export function wiredOutputs(store, nodeId, port) {
  const items = [], texts = [], problems = [];
  const seenAssets = new Set();
  for (const e of store.edgesInto(nodeId, port)) {
    const src = store.node(e.from.node);
    const out = nodeOutputs(store.project, src);
    problems.push(...out.missing);
    // The same image may be connected through its generator and a materialized
    // asset node. Submit that asset once, without traversing the source inputs.
    for (const asset of out.assets) if (!seenAssets.has(asset.id)) { seenAssets.add(asset.id); items.push(asset); }
    if (out.text?.trim()) texts.push(out.text);
    if (src && !out.missing.length && !out.assets.length && !out.text?.trim())
      problems.push(`「${src.data?.title || src.id}」尚无可用输出（需先生成或绑定素材）`);
  }
  return { items, texts, problems };
}
// 有效提示词：上游连线文本（按连线顺序）+ 节点自身内容。素材误接到文本口/缺失输出都是显式问题。
export function effectivePrompt(store, node, base) {
  const w = wiredOutputs(store, node.id, 'prompt');
  const problems = [...w.problems];
  if (w.items.length) problems.push('文本端口不接受素材输出');
  const parts = [...w.texts];
  if (base?.trim()) parts.push(String(base).trim());
  return { prompt: parts.join('\n\n'), problems, wired: w.texts.length > 0 };
}
