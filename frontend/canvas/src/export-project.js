// 时间线数据模型 + 互操作导出 + 可迁移项目包 + 渲染任务清单。
// 本模块全部为纯逻辑（无顶层 DOM 依赖），node --test 可直接覆盖；
// 需要 DOM 的浏览器编排（下载/文件选择）只在对应函数体内使用。
//
// 能力边界（不夸大兼容）：
//  · EDL：CMX3600 风格文本（V/AA 事件、源入出点/录机入出点、片段名）。供套底/核对，非完整工程。
//  · OTIO：OTIO JSON 子集（Timeline.1/Stack.1/Track.1/Clip.1 + ExternalReference.1）；
//          RationalTime 以 meta.fps 量化。未实现的字段（转场/效果）不写入文件。
//  · Premiere .prproj / 剪映草稿等私有格式：未实现（无可执行验证，不伪造兼容）。
//  · xp-package@1：STORE zip（无压缩）= manifest.json + project.json(store.exportJSON 输出) + media/*
//  · xp-render@1：浏览器渲染与本机 media-service 共用的渲染清单（服务端再次独立校验）。

import { uid, containsSecret } from './store.js';

// ---------- 时间线模型 ----------

export const TL_TRACKS = [
  { id: 'v1',  label: '视频',  accepts: ['video', 'image'], visual: true },
  { id: 'ov1', label: '叠加',  accepts: ['image', 'text'],  visual: true },
  { id: 'a1',  label: '音乐',  accepts: ['audio'] },
  { id: 'a2',  label: '配音',  accepts: ['audio'] },
  { id: 's1',  label: '字幕',  accepts: ['subtitle'] },
];
export const TL_TRACK_IDS = TL_TRACKS.map(t => t.id);
export const TL_TRACK_INDEX = Object.fromEntries(TL_TRACKS.map((t, i) => [t.id, i]));

export const TL_LIMITS = {
  maxClips: 500, maxClipsPerTrack: 200, maxSubtitles: 300,
  maxDuration: 600, minLen: 0.05,
  minSpeed: 0.25, maxSpeed: 4, maxFade: 30,
  maxText: 2000, maxName: 200,
};
export const TL_SIZES = [
  { id: 'hd720',    width: 1280, height: 720,  label: '横屏 1280×720（16:9）' },
  { id: 'hd1080',   width: 1920, height: 1080, label: '横屏 1920×1080（16:9）' },
  { id: 'vertical', width: 720,  height: 1280, label: '竖屏 720×1280（9:16）' },
  { id: 'square',   width: 1080, height: 1080, label: '方形 1080×1080（1:1）' },
];
export const TL_DEFAULT_META = Object.freeze({ version: 1, width: 1280, height: 720, fps: 30, background: '#000000' });
const CLIP_KINDS = new Set(['video', 'image', 'audio', 'text', 'subtitle']);
const MEDIA_KINDS = new Set(['video', 'image', 'audio']);
const num = (v, d, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v, max = TL_LIMITS.maxText) => typeof v === 'string' ? v.slice(0, max) : '';
const safeColor = v => /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#ffffff';

export function newClipId() { return uid('c'); }

// 由素材建片段：track 为目标轨（不校验 accepts，调用方负责配对）。
export function clipFromAsset(asset, track, { start = 0, len = 5 } = {}) {
  const media = MEDIA_KINDS.has(asset?.kind);
  const kind = media ? asset.kind : 'video';
  const dur = num(len, 5, TL_LIMITS.minLen, TL_LIMITS.maxDuration);
  return {
    id: newClipId(), track, kind,
    assetId: asset?.id ?? null, name: str(asset?.name ?? '片段', TL_LIMITS.maxName) || '片段',
    start, end: start + dur,
    in: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
    sourceDuration: Number.isFinite(asset?.durationSeconds) ? asset.durationSeconds : null,
  };
}
export function newTextClip(track = 'ov1', { start = 0, len = 3, text = '叠加文字' } = {}) {
  return {
    id: newClipId(), track, kind: 'text', assetId: null, name: '文字叠加',
    start, end: start + num(len, 3, TL_LIMITS.minLen, TL_LIMITS.maxDuration),
    in: 0, speed: 1, volume: 1, muted: true, fadeIn: 0, fadeOut: 0,
    text: str(text, TL_LIMITS.maxText),
    x: 0.1, y: 0.62, w: 0.8, h: 0.3, fontSize: 0.06, color: '#ffffff', align: 'center',
  };
}
export function newSubtitleClip({ start = 0, end = start + 2, text = '' } = {}) {
  const s = Math.max(0, Number(start) || 0), e = Math.max(s + TL_LIMITS.minLen, Number(end) || s + 2);
  return { id: newClipId(), track: 's1', kind: 'subtitle', assetId: null, name: '字幕',
    start: s, end: e, in: 0, speed: 1, volume: 1, muted: true, fadeIn: 0, fadeOut: 0,
    text: str(text, TL_LIMITS.maxText), subtitle: str(text, TL_LIMITS.maxText) };
}

function inferTrack(raw, kind) {
  if (TL_TRACK_INDEX[raw.track] != null && TL_TRACKS[TL_TRACK_INDEX[raw.track]].accepts.includes(kind)) return raw.track;
  if (kind === 'subtitle') return 's1';
  if (kind === 'text') return 'ov1';
  if (kind === 'audio') return 'a1';
  if (kind === 'image') return raw.track === 'ov1' ? 'ov1' : 'v1';
  return 'v1';
}
function inferKind(raw, assets) {
  if (CLIP_KINDS.has(raw.kind)) return raw.kind;
  const a = raw.assetId ? assets[raw.assetId] : null;
  if (a && MEDIA_KINDS.has(a.kind)) return a.kind === 'audio' ? 'audio' : a.kind;
  if (!raw.assetId && (str(raw.subtitle) || str(raw.text))) return 'subtitle';
  return raw.assetId ? 'video' : 'subtitle';
}

// 规范化整条时间线：补默认/夹取范围/排序/消除同轨重叠；返回 {clips, warnings}。
// 兼容旧版 core 形态 {assetId,start,end,subtitle,muted}：
//   媒体片段上的 subtitle 文本一次性迁移到 s1 轨（迁移后 clip.subtitle 置空，幂等）。
export function normalizeTimeline(raw, { assets = {}, migrate = true } = {}) {
  const warnings = [];
  const list = Array.isArray(raw) ? raw.slice(0, TL_LIMITS.maxClips) : [];
  if (Array.isArray(raw) && raw.length > TL_LIMITS.maxClips) warnings.push(`片段数量超过 ${TL_LIMITS.maxClips}，已截断`);
  const clips = [];
  for (const raw0 of list) {
    if (!raw0 || typeof raw0 !== 'object') continue;
    const kind = inferKind(raw0, assets);
    const track = inferTrack(raw0, kind);
    const start = num(raw0.start, 0, 0, TL_LIMITS.maxDuration);
    let end = num(raw0.end, start + TL_LIMITS.minLen, start + TL_LIMITS.minLen, TL_LIMITS.maxDuration);
    if (end <= start) end = start + TL_LIMITS.minLen;
    const len = end - start;
    const clip = {
      id: str(raw0.id, 128) || newClipId(),
      track, kind,
      assetId: str(raw0.assetId, 128) || null,
      name: str(raw0.name, TL_LIMITS.maxName),
      start, end,
      in: num(raw0.in, 0, 0, TL_LIMITS.maxDuration * TL_LIMITS.maxSpeed),
      speed: num(raw0.speed, 1, TL_LIMITS.minSpeed, TL_LIMITS.maxSpeed),
      volume: num(raw0.volume, 1, 0, 1),
      muted: raw0.muted === true,
      fadeIn: num(raw0.fadeIn, 0, 0, Math.min(TL_LIMITS.maxFade, len / 2)),
      fadeOut: num(raw0.fadeOut, 0, 0, Math.min(TL_LIMITS.maxFade, len / 2)),
    };
    if (Number.isFinite(raw0.sourceDuration)) clip.sourceDuration = num(raw0.sourceDuration, null, 0, 86400) ?? undefined;
    // 手动填写的片段时长是来源标记，不可在归一化时丢失，也不可冒充实测时长。
    if (raw0.durationManual === true && clip.sourceDuration == null) clip.durationManual = true;
    if (kind === 'text' || (kind === 'image' && track === 'ov1')) {
      // 叠加矩形（0..1 画面比例）：文字与图片叠加共用
      if (kind === 'text') clip.text = str(raw0.text ?? raw0.subtitle, TL_LIMITS.maxText);
      clip.x = num(raw0.x, 0.1, 0, 1); clip.y = num(raw0.y, kind === 'text' ? 0.62 : 0.05, 0, 1);
      clip.w = num(raw0.w, kind === 'text' ? 0.8 : 0.28, 0.02, 1); clip.h = num(raw0.h, kind === 'text' ? 0.3 : 0.28, 0.02, 1);
      if (clip.x + clip.w > 1) clip.x = Math.max(0, 1 - clip.w);
      if (clip.y + clip.h > 1) clip.y = Math.max(0, 1 - clip.h);
      if (kind === 'text') {
        clip.fontSize = num(raw0.fontSize, 0.06, 0.02, 0.3);
        clip.color = safeColor(raw0.color);
        clip.align = ['left', 'center', 'right'].includes(raw0.align) ? raw0.align : 'center';
        clip.muted = true; clip.volume = 0;
      }
    }
    if (kind === 'subtitle') {
      clip.text = str(raw0.text ?? raw0.subtitle, TL_LIMITS.maxText);
      clip.subtitle = clip.text;   // core 兼容字段：老版导入只保留它
      clip.muted = true; clip.volume = 0;
    }
    // 媒体片段引用的素材是否还在项目里（缺失仍可保留片段，渲染时显示缺素材占位）
    if (MEDIA_KINDS.has(kind)) clip.missing = clip.assetId ? !!assets[clip.assetId]?.missing || !assets[clip.assetId] : true;
    clips.push(clip);
    // 旧版：媒体片段自带 subtitle → 迁移为 s1 轨字幕片段（同区间同文本不重复）
    const legacySub = str(raw0.subtitle, TL_LIMITS.maxText);
    if (migrate && MEDIA_KINDS.has(kind) && legacySub) {
      const dup = clips.some(c => c.track === 's1' && c.start === clip.start && c.end === clip.end && c.text === legacySub);
      if (!dup) clips.push({ ...newSubtitleClip({ start: clip.start, end: clip.end, text: legacySub }) });
      clip.subtitle = '';
    } else if (!MEDIA_KINDS.has(kind)) {
      clip.subtitle = clip.track === 's1' ? clip.subtitle ?? '' : '';
    } else clip.subtitle = str(raw0.subtitle, TL_LIMITS.maxText);
  }
  // 同轨按 start 排序并消除重叠（后者整体后移）
  for (const t of TL_TRACK_IDS) {
    const lane = clips.filter(c => c.track === t).sort((a, b) => a.start - b.start || a.end - b.end);
    const cap = t === 's1' ? TL_LIMITS.maxSubtitles : TL_LIMITS.maxClipsPerTrack;
    let cursor = 0;
    for (const c of lane) {
      if (c.start < cursor) { const shift = cursor - c.start; c.start = cursor; c.end += shift; }
      if (c.end > TL_LIMITS.maxDuration) c.end = TL_LIMITS.maxDuration;
      if (c.end - c.start < TL_LIMITS.minLen) c.end = c.start + TL_LIMITS.minLen;
      cursor = c.end;
    }
    if (lane.length > cap) warnings.push(`${TL_TRACKS[TL_TRACK_INDEX[t]].label}轨片段超过 ${cap}，多余已丢弃`);
    const keep = new Set(lane.slice(0, cap).map(c => c.id));
    for (let i = clips.length - 1; i >= 0; i--) if (clips[i].track === t && !keep.has(clips[i].id)) clips.splice(i, 1);
  }
  clips.sort((a, b) => TL_TRACK_INDEX[a.track] - TL_TRACK_INDEX[b.track] || a.start - b.start);
  return { clips, warnings };
}

export const laneClips = (clips, track) => clips.filter(c => c.track === track).sort((a, b) => a.start - b.start || a.end - b.end);
export const timelineDuration = clips => clips.reduce((m, c) => Math.max(m, c.end), 0);
export const laneEnd = (clips, track) => laneClips(clips, track).reduce((m, c) => Math.max(m, c.end), 0);
export const activeClipsAt = (clips, track, t) => laneClips(clips, track).filter(c => t >= c.start && t < c.end);
export const clipSourceTime = (clip, t) => clip.in + Math.max(0, t - clip.start) * (clip.speed || 1);
export const clipVisualLen = clip => Math.max(TL_LIMITS.minLen, clip.end - clip.start);
// 淡入/淡出线性包络（0..1），预览增益与渲染 alpha 共用
export function fadeFactor(clip, t) {
  const len = clipVisualLen(clip), local = t - clip.start;
  let a = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) a = Math.min(a, Math.max(0, local / clip.fadeIn));
  if (clip.fadeOut > 0 && local > len - clip.fadeOut) a = Math.min(a, Math.max(0, (len - local) / clip.fadeOut));
  return Math.min(1, Math.max(0, a));
}

// 在 t 处分割片段（含 speed 折算入点）。返回 {second} 或 null。
export function splitClipAt(clips, id, t) {
  const i = clips.findIndex(c => c.id === id);
  const c = clips[i];
  if (!c || t <= c.start + TL_LIMITS.minLen || t >= c.end - TL_LIMITS.minLen) return null;
  const secondIn = c.in + (t - c.start) * (c.speed || 1);
  if (Number.isFinite(c.sourceDuration) && secondIn >= c.sourceDuration) return null;   // 检查先行，失败不改原片段
  const second = { ...c, id: newClipId(), start: t, fadeIn: 0, in: secondIn };
  c.end = t; c.fadeOut = 0;
  clips.splice(i + 1, 0, second);
  return { first: c, second };
}

// 同轨内移动：夹入相邻片段之间的空隙；返回实际 start。
export function moveClip(clips, id, newStart) {
  const c = clips.find(x => x.id === id); if (!c) return 0;
  const len = clipVisualLen(c);
  const lane = laneClips(clips, c.track).filter(x => x.id !== id);
  let start = Math.max(0, Math.min(Number(newStart) || 0, TL_LIMITS.maxDuration - len));
  for (const o of lane) {
    if (start < o.end && start + len > o.start) {
      // 与已有片段冲突：放到较近的一侧
      const before = o.start - len, after = o.end;
      start = (Math.abs(newStart - before) < Math.abs(after - newStart) && before >= 0) ? before : after;
    }
  }
  // 二次防重叠（极端相邻链）
  for (const o of lane) if (start < o.end && start + len > o.start) start = o.end;
  c.start = start; c.end = start + len;
  return start;
}

// 修剪片段边缘：edge='start'|'end'，夹取邻居与源时长（已知时）。
export function trimClipEdge(clips, id, edge, time, { sourceDuration } = {}) {
  const c = clips.find(x => x.id === id); if (!c) return;
  const lane = laneClips(clips, c.track).filter(x => x.id !== id);
  const srcDur = sourceDuration ?? c.sourceDuration;
  if (edge === 'start') {
    const prevEnd = lane.filter(o => o.end <= c.start + 1e-6).reduce((m, o) => Math.max(m, o.end), 0);
    let ns = Math.max(prevEnd, 0, Math.min(Number(time) || 0, c.end - TL_LIMITS.minLen));
    if (MEDIA_KINDS.has(c.kind) && Number.isFinite(srcDur)) {
      const maxShift = c.in / (c.speed || 1);              // 入点不得小于 0
      ns = Math.max(ns, c.start - maxShift);
    }
    const delta = ns - c.start;
    c.start = ns;
    if (MEDIA_KINDS.has(c.kind)) c.in = Math.max(0, c.in + delta * (c.speed || 1));
  } else {
    const nextStart = lane.filter(o => o.start >= c.end - 1e-6).reduce((m, o) => Math.min(m, o.start), TL_LIMITS.maxDuration);
    let ne = Math.max(c.start + TL_LIMITS.minLen, Math.min(Number(time) || c.end, nextStart, TL_LIMITS.maxDuration));
    if (MEDIA_KINDS.has(c.kind) && Number.isFinite(srcDur))
      ne = Math.min(ne, c.start + Math.max(TL_LIMITS.minLen, (srcDur - c.in) / (c.speed || 1)));
    c.end = ne;
  }
  c.fadeIn = Math.min(c.fadeIn, clipVisualLen(c) / 2);
  c.fadeOut = Math.min(c.fadeOut, clipVisualLen(c) / 2);
}

// 相邻交换（前移 dir=-1 / 后移 dir=+1），返回是否成功
export function reorderClip(clips, id, dir) {
  const c = clips.find(x => x.id === id); if (!c) return false;
  const lane = laneClips(clips, c.track);
  const i = lane.findIndex(x => x.id === id);
  const o = lane[i + dir]; if (!o) return false;
  const lenC = clipVisualLen(c), lenO = clipVisualLen(o);
  if (dir < 0) { c.start = o.start; c.end = c.start + lenC; o.start = c.end; o.end = o.start + lenO; }
  else { o.start = c.start; o.end = o.start + lenO; c.start = o.end; c.end = c.start + lenC; }
  return true;
}

export function subtitlesOf(clips) {
  return laneClips(clips, 's1').map(c => ({ id: c.id, start: c.start, end: c.end, text: c.text ?? c.subtitle ?? '' }));
}

// ---------- SRT 字幕 ----------

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}
export function parseSRTTime(s) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s);
  if (!m) return null;
  const ms = Number(m[4].padEnd(3, '0'));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}
// 宽容解析：块可带序号行；无效块跳过并计入 warnings；一个有效条目都没有则抛错。
export function parseSRT(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const entries = [], warnings = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l !== '');
    let i = 0;
    if (/^\d+$/.test(lines[0] ?? '')) i = 1;
    const tm = lines[i] && /^(.*?)-->/.test(lines[i]) ? lines[i] : null;
    const m = tm && /(.+?)-->\s*(.+)/.exec(tm);
    if (!m) { warnings.push('跳过无时间轴的字幕块'); continue; }
    const start = parseSRTTime(m[1]), end = parseSRTTime(m[2]);
    if (start == null || end == null || !(end > start)) { warnings.push(`跳过时间无效的字幕块：${lines[i]}`); continue; }
    const body = lines.slice(i + 1).join('\n').trim();
    if (!body) { warnings.push('跳过空字幕块'); continue; }
    entries.push({ start, end, text: body.slice(0, TL_LIMITS.maxText) });
  }
  if (!entries.length) throw new Error('SRT 文件没有有效字幕条目');
  entries.sort((a, b) => a.start - b.start);
  return { entries, warnings };
}
export function toSRT(subs) {
  const list = [...subs].sort((a, b) => a.start - b.start);
  return list.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${String(s.text).replace(/-->/g, '→').replace(/<\/?[^>]+>/g, '')}`).join('\n\n') + '\n';
}

// ---------- EDL（CMX3600 风格子集） ----------
// 支持字段：事件号、卷名(AX)、轨(V/AA)、Cut、源入/出点、录机入/出点、片段名注释。
// 不支持：转场/键控/变速事件——速度变化仅体现在源出入点跨度，需人工复核。
export function edlTimecode(sec, fps = 30) {
  const f = Math.max(0, Math.round(sec * fps));
  const ff = f % fps, s = Math.floor(f / fps) % 60, m = Math.floor(f / (fps * 60)) % 60, h = Math.floor(f / (fps * 3600));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}
export function toEDL(clips, { title = 'TIMELINE', fps = 30, assets = {} } = {}) {
  const out = [`TITLE: ${String(title).slice(0, 70)}`, 'FCM: NON-DROP FRAME', '* GENERATED BY XINGPAN-CANVAS xp-edl-subset-1'];
  let n = 1;
  const events = [
    ...laneClips(clips, 'v1').map(c => ({ c, tc: 'V  ' })),
    ...laneClips(clips, 'a1').map(c => ({ c, tc: 'AA ' })),
    ...laneClips(clips, 'a2').map(c => ({ c, tc: 'AA ' })),
  ];
  for (const { c, tc } of events) {
    const len = clipVisualLen(c), srcLen = len * (c.speed || 1);
    const srcIn = edlTimecode(c.in || 0, fps), srcOut = edlTimecode((c.in || 0) + srcLen, fps);
    const recIn = edlTimecode(c.start, fps), recOut = edlTimecode(c.end, fps);
    out.push(`${String(n++).padStart(3, '0')}  AX       ${tc}  C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    const a = c.assetId ? assets[c.assetId] : null;
    out.push(`* FROM CLIP NAME: ${a?.name ?? c.name ?? '（缺失素材）'}`);
    if (c.muted) out.push('* AUDIO CLIP MUTED');
    if ((c.speed || 1) !== 1) out.push(`* SPEED ${(c.speed * 100).toFixed(1)}%（源出入点已按速度折算）`);
  }
  return out.join('\n') + '\n';
}

// ---------- OTIO JSON 子集（v1：剪辑结构 + 媒体引用 + 时间范围；无转场/效果） ----------
export function toOTIO(project, clips, meta = TL_DEFAULT_META) {
  const rate = meta.fps || 30;
  const rt = sec => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: Math.round(sec * rate) });
  const range = (s, d) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(s), duration: rt(d) });
  const clipNode = c => ({
    OTIO_SCHEMA: 'Clip.1', name: c.name || c.id,
    source_range: range(c.start, clipVisualLen(c)),
    media_reference: c.assetId && project.assets?.[c.assetId]
      ? { OTIO_SCHEMA: 'ExternalReference.1', target_url: project.assets[c.assetId].name,
          available_range: range(c.in || 0, clipVisualLen(c) * (c.speed || 1)) }
      : { OTIO_SCHEMA: 'MissingReference.1' },
  });
  const trackNode = (id, kind) => ({
    OTIO_SCHEMA: 'Track.1', name: id, kind,
    children: laneClips(clips, id).map(clipNode),
  });
  return {
    OTIO_SCHEMA: 'Timeline.1', name: String(project?.name ?? 'timeline'),
    global_start_time: rt(0),
    'xp.note': 'OTIO 子集导出：仅剪辑结构与媒体引用；字幕在 s1 轨以 Clip 表示（无文字内容字段）',
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [
      trackNode('v1', 'Video'), trackNode('ov1', 'Video'),
      trackNode('a1', 'Audio'), trackNode('a2', 'Audio'), trackNode('s1', 'Audio'),
    ] },
  };
}

// ---------- STORE zip（无压缩、无数据描述符；读端仅接受此子集） ----------

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
const enc = new TextEncoder();
export const ZIP_LIMITS = { maxEntries: 1024, maxTotal: 768 * 1024 * 1024, maxName: 200 };

export function zipStore(entries) {
  if (entries.length > ZIP_LIMITS.maxEntries) throw new Error('打包文件数超限');
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameB = enc.encode(name);
    if (nameB.length > ZIP_LIMITS.maxName) throw new Error(`文件名过长：${name}`);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const crc = crc32(u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true);
    lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameB, u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true);
    ch.setUint16(28, nameB.length, true);
    for (const off of [30, 32, 34, 36]) ch.setUint16(off, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + u8.length;
  }
  const cdStart = offset;
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, cdStart, true);
  const total = cdStart + cdSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const c of central) { out.set(c, o); o += c.length; }
  out.set(new Uint8Array(eo.buffer), o);
  return out;
}

const ZIP_SAFE_NAME = /^(?!\/)(?!.*\.\.)(?!.*[\\:])[A-Za-z0-9_\-./\u4e00-\u9fff]+$/;
export function unzipStore(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const files = new Map();
  let pos = 0, total = 0;
  while (pos + 4 <= u8.length) {
    const sig = dv.getUint32(pos, true);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) throw new Error('不是有效的项目包（需要未压缩 zip）');
    if (pos + 30 > u8.length) throw new Error('项目包文件头损坏');
    const flags = dv.getUint16(pos + 6, true);
    const method = dv.getUint16(pos + 8, true);
    if (flags & 0x01) throw new Error('项目包含加密条目，已拒绝');
    if (flags & 0x08) throw new Error('项目包使用了数据描述符（仅接受本工具写出的 STORE 包）');
    if (method !== 0) throw new Error('项目包条目为压缩格式（仅接受 STORE/未压缩）');
    const comp = dv.getUint32(pos + 18, true), uncomp = dv.getUint32(pos + 22, true);
    const nameLen = dv.getUint16(pos + 26, true), extraLen = dv.getUint16(pos + 28, true);
    if (comp !== uncomp) throw new Error('项目包条目大小不一致');
    const name = new TextDecoder().decode(u8.subarray(pos + 30, pos + 30 + nameLen));
    if (!ZIP_SAFE_NAME.test(name)) throw new Error(`项目包内文件名不合法：${name.slice(0, 60)}`);
    if (files.has(name)) throw new Error(`项目包内文件重复：${name}`);
    const dataStart = pos + 30 + nameLen + extraLen;
    if (dataStart + comp > u8.length) throw new Error('项目包数据截断');
    total += uncomp;
    if (files.size >= ZIP_LIMITS.maxEntries) throw new Error('项目包文件数超限');
    if (total > ZIP_LIMITS.maxTotal) throw new Error('项目包总大小超限');
    const data = u8.slice(dataStart, dataStart + comp);
    if (crc32(data) !== dv.getUint32(pos + 14, true)) throw new Error(`项目包条目 CRC 校验失败：${name}`);
    files.set(name, data);
    pos = dataStart + comp;
  }
  if (!files.size) throw new Error('项目包为空');
  return files;
}

// ---------- xp-render@1 渲染清单（浏览器与服务端共用 schema；服务端独立再校验） ----------

export const MEDIA_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
};
export const MEDIA_FILE_RE = /^media\/[A-Za-z0-9_-]{1,64}\.(mp4|webm|png|jpe?g|webp|mp3|wav|m4a|aac)$/;
export const RENDER_FORMAT = 'xp-render@1';

// 项目包白名单独立于渲染白名单：FFmpeg 渲染只收上表媒体；
// 完整项目包另外允许项目内引用的二进制资产（导演台 GLB / glTF / 纹理缓冲 bin）。
// 不引入任意扩展名——MIME→扩展名仍是固定表，绝不按内容或文件名猜身份。
export const PACKAGE_MIME_EXT = {
  ...MEDIA_EXT,
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'application/octet-stream': 'bin',
  'application/json': 'cclayproject',
};
export const PACKAGE_FILE_RE = /^media\/[A-Za-z0-9_-]{1,64}\.(mp4|webm|png|jpe?g|webp|mp3|wav|m4a|aac|glb|gltf|bin|cclayproject)$/;
const PACKAGE_KINDS = new Set(['image', 'video', 'audio', 'file']);

function mediaKey(asset) {
  const ext = MEDIA_EXT[asset.mime];
  if (!ext) throw new Error(`素材「${asset.name}」类型 ${asset.mime} 不能用于渲染`);
  return `media/${asset.id}.${ext}`;
}

// 由项目时间线构建渲染清单；缺失素材片段跳过并记入 warnings。
// allowTextFallback：用户显式确认「本机服务可省略文字/字幕烧录」后才置 true——
// 服务端默认绝不静默丢用户内容（见 media-service render）。
export function buildRenderJob({ project, clips, meta = TL_DEFAULT_META, format = 'mp4', allowTextFallback = false }) {
  const { clips: tl, warnings } = normalizeTimeline(clips, { assets: project.assets ?? {} });
  const assets = project.assets ?? {};
  const media = new Map();
  const omitted = [];
  const fileOf = c => {
    const a = c.assetId ? assets[c.assetId] : null;
    if (!a || a.missing) {
      warnings.push(`片段「${c.name || c.id}」素材缺失，已跳过`);
      omitted.push({ id: c.id, clip: c.name || c.id, assetId: c.assetId ?? null, reason: 'missing' });
      return null;
    }
    if (!media.has(a.id)) {
      let key;
      try { key = mediaKey(a); }
      catch {
        warnings.push(`素材「${a.name}」类型 ${a.mime} 不能用于渲染，已跳过`);
        omitted.push({ id: c.id, clip: c.name || c.id, assetId: a.id, reason: 'unsupported' });
        return null;
      }
      media.set(a.id, { key, assetId: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size });
    }
    return media.get(a.id).key;
  };
  const base = c => ({
    start: c.start, end: c.end, in: c.in || 0, speed: c.speed || 1,
    volume: c.muted ? 0 : (c.volume ?? 1), fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
  });
  const job = {
    format: RENDER_FORMAT, version: 1,
    output: { width: meta.width, height: meta.height, fps: meta.fps, format, background: meta.background ?? '#000000' },
    duration: timelineDuration(tl),
    tracks: { video: [], overlay: [], audio: [], subtitle: [] },
    media: [], warnings, omitted,
    allowTextFallback: allowTextFallback === true,
  };
  for (const c of tl) {
    if (c.track === 'v1') {
      const file = fileOf(c); if (!file) continue;
      job.tracks.video.push({ file, ...base(c) });
    } else if (c.track === 'ov1') {
      if (c.kind === 'text') job.tracks.overlay.push({ kind: 'text', text: c.text ?? '', x: c.x, y: c.y, w: c.w, h: c.h, fontSize: c.fontSize, color: c.color, align: c.align, start: c.start, end: c.end, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 });
      else { const file = fileOf(c); if (file) job.tracks.overlay.push({ kind: 'image', file, x: c.x, y: c.y, w: c.w, h: c.h, start: c.start, end: c.end, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 }); }
    } else if (c.track === 'a1' || c.track === 'a2') {
      const file = fileOf(c); if (!file) continue;
      job.tracks.audio.push({ file, track: c.track, ...base(c) });
    } else if (c.track === 's1') {
      job.tracks.subtitle.push({ start: c.start, end: c.end, text: c.text ?? '' });
    }
  }
  job.media = [...media.values()];
  return job;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// 渲染清单的独立严格校验（服务端信任边界 + 客户端自检共用）。返回规范化 job。
// 边界语义：NaN/越界/类型不符一律拒绝，不把畸形负载夹取成“另一种导出”
// （宽容夹取只属于编辑器 normalizeTimeline，不属于信任边界）。
export function sanitizeRenderJob(raw) {
  const fail = m => { throw new Error(`渲染任务不合法：${m}`); };
  if (!isObj(raw) || raw.format !== RENDER_FORMAT) fail('format 须为 xp-render@1');
  if (!isObj(raw.output)) fail('output 缺失');
  const out = raw.output;
  const reqNum = (v, tag) => { const n = Number(v); if (!Number.isFinite(n)) fail(`${tag} 必须是有限数字`); return n; };
  const width = reqNum(out.width, '输出宽度');
  if (!Number.isInteger(width) || width < 16 || width > 1920) fail('输出宽度须为 16–1920 整数');
  const height = reqNum(out.height, '输出高度');
  if (!Number.isInteger(height) || height < 16 || height > 1920) fail('输出高度须为 16–1920 整数');
  const fps = reqNum(out.fps, '输出帧率');
  if (fps < 1 || fps > 60) fail('输出帧率须在 1–60');
  if (out.format !== 'mp4' && out.format !== 'webm') fail('输出格式必须显式声明 mp4/webm');
  const fmt = out.format;   // 服务端只产 mp4；webm 仅浏览器路径（render() 内再拒）
  const duration = reqNum(raw.duration, '时长');
  if (duration < 0.1 || duration > TL_LIMITS.maxDuration) fail(`时长须为 0.1–${TL_LIMITS.maxDuration} 秒`);
  if (width * height > 1920 * 1920) fail('输出像素超限');
  const background = safeColor(typeof out.background === 'string' ? out.background : '#000000');
  const tr = isObj(raw.tracks) ? raw.tracks : {};
  // 严格数值边界：显式给出的值必须是界内有限数字；只有字段缺省（null/undefined）才补默认。
  // 拒绝 NaN/负数/超界，绝不把畸形请求夹取成“另一种导出”（宽容夹取只属于编辑器 normalizeTimeline）。
  const reqRange = (v, lo, hi, tag) => {
    if (typeof v !== 'number') fail(`${tag}必须是有限数字`);
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`${tag}必须是有限数字`);
    if (n < lo || n > hi) fail(`${tag}须在 ${lo}–${hi} 之间（收到 ${String(v).slice(0, 40)}）`);
    return n;
  };
  const optRange = (v, dflt, lo, hi, tag) => v == null ? dflt : reqRange(v, lo, hi, tag);
  const mediaKeys = new Set();
  const media = [];
  const keyExt = k => { const e = k.split('.').pop(); return e === 'jpeg' ? 'jpg' : e; };
  const KIND_MIME = { image: 'image/', video: 'video/', audio: 'audio/' };
  const mediaList = Array.isArray(raw.media) ? raw.media : fail('media 缺失');
  for (const m of mediaList) {
    if (!isObj(m) || typeof m.key !== 'string' || !MEDIA_FILE_RE.test(m.key)) fail('media 键名不合法');
    if (mediaKeys.has(m.key)) fail('media 键重复');
    mediaKeys.add(m.key);
    if (typeof m.mime !== 'string' || !MEDIA_EXT[m.mime]) fail(`媒体 ${m.key} 的 MIME 不支持渲染`);
    if (keyExt(m.key) !== MEDIA_EXT[m.mime]) fail(`媒体 ${m.key} 扩展名与声明 MIME 不一致`);
    if (!Object.hasOwn(KIND_MIME, m.kind)) fail(`媒体 ${m.key} kind 不合法`);
    if (!m.mime.startsWith(KIND_MIME[m.kind])) fail(`媒体 ${m.key} kind 与 MIME 不一致`);
    media.push({ key: m.key, assetId: str(m.assetId, 128), name: str(m.name, 512), kind: m.kind, mime: m.mime, size: optRange(m.size, 0, 0, 1e10, `媒体 ${m.key} 大小`) });
  }
  if (media.length > 64) fail('媒体文件数超限');
  const kindOfFile = new Map(media.map(m => [m.key, m.kind]));
  const span = (c, tag) => {
    if (!isObj(c)) fail(`${tag} 片段不是对象`);
    const start = reqRange(c.start, 0, TL_LIMITS.maxDuration, `${tag} 片段起点`);
    const end = reqRange(c.end, 0, TL_LIMITS.maxDuration + 1, `${tag} 片段终点`);
    if (!(end > start) || end > duration + 0.5) fail(`${tag} 片段区间越界`);
    return { start, end };
  };
  const mediaSpan = (c, tag) => ({
    ...span(c, tag),
    in: optRange(c.in, 0, 0, 86400, `${tag} 片段入点`),
    speed: optRange(c.speed, 1, TL_LIMITS.minSpeed, TL_LIMITS.maxSpeed, `${tag} 片段速度`),
    volume: optRange(c.volume, 1, 0, 1, `${tag} 片段音量`),
    fadeIn: optRange(c.fadeIn, 0, 0, TL_LIMITS.maxFade, `${tag} 片段淡入`),
    fadeOut: optRange(c.fadeOut, 0, 0, TL_LIMITS.maxFade, `${tag} 片段淡出`),
  });
  const trackArr = (v, cap, tag) => {
    const l = Array.isArray(v) ? v : [];
    if (l.length > cap) fail(`${tag}片段数超限`);
    return l;
  };
  const needFile = (c, allow) => {
    if (typeof c.file !== 'string' || !mediaKeys.has(c.file)) fail(`片段引用不存在的媒体 ${String(c.file).slice(0, 60)}`);
    if (!allow.includes(kindOfFile.get(c.file))) fail(`媒体 ${c.file} 的 kind 不能用于该轨`);
    return c.file;
  };
  const video = trackArr(tr.video, 200, '视频').map(c => ({ file: needFile(c, ['video', 'image']), ...mediaSpan(c, '视频') }));
  const audio = trackArr(tr.audio, 200, '音频').map(c => ({ file: needFile(c, ['audio']), track: c.track === 'a2' ? 'a2' : 'a1', ...mediaSpan(c, '音频') }));
  const overlay = trackArr(tr.overlay, 200, '叠加').map(c => {
    const s = span(c, '叠加');
    const rect = { x: optRange(c.x, 0.1, 0, 1, '叠加 X'), y: optRange(c.y, 0.62, 0, 1, '叠加 Y'), w: optRange(c.w, 0.8, 0.01, 1, '叠加宽'), h: optRange(c.h, 0.3, 0.01, 1, '叠加高'), fadeIn: optRange(c.fadeIn, 0, 0, TL_LIMITS.maxFade, '叠加淡入'), fadeOut: optRange(c.fadeOut, 0, 0, TL_LIMITS.maxFade, '叠加淡出') };
    if (c.kind === 'text') return { kind: 'text', text: str(c.text, TL_LIMITS.maxText), fontSize: optRange(c.fontSize, 0.06, 0.02, 0.3, '文字字号'), color: safeColor(c.color), align: ['left', 'center', 'right'].includes(c.align) ? c.align : 'center', ...s, ...rect };
    return { kind: 'image', file: needFile(c, ['image']), ...s, ...rect };
  });
  const subtitle = trackArr(tr.subtitle, TL_LIMITS.maxSubtitles, '字幕').map(c => {
    const s = span(c, '字幕');
    const text = str(c.text, TL_LIMITS.maxText);
    if (!text.trim()) fail('字幕文本为空');
    return { ...s, text };
  });
  if (!video.length && !overlay.length && !subtitle.length && !audio.length) fail('没有任何可渲染内容');
  return {
    format: RENDER_FORMAT, version: 1,
    output: { width, height, fps, format: fmt, background },
    duration, tracks: { video, overlay, audio, subtitle }, media,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 50).map(w => str(w, 200)) : [],
    // 仅当调用方显式声明（用户已确认省略）才为 true；缺省/伪造一律 false
    allowTextFallback: raw.allowTextFallback === true,
  };
}

// ---------- xp-package@1 可迁移项目包 ----------
// manifest.json：{format,version,exportedAt,timeline:{clips,meta},media:[{path,assetId,name,kind,mime,size}]}
// project.json ：store.exportJSON() 原文（导入仍走 store.importJSON 全量消毒，不绕过）
// media/<assetId>.<ext>：本机素材 blob 原文；path 是确定性身份载体 media/<导出前assetId>.<MIME推导扩展名>

export const PACKAGE_FORMAT = 'xp-package@1';
const sha256Bytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');

export function sanitizeTimelineMeta(mm) {
  const m = isObj(mm) ? mm : {};
  return {
    version: 1,
    width: Math.round(num(m.width, TL_DEFAULT_META.width, 16, 1920)),
    height: Math.round(num(m.height, TL_DEFAULT_META.height, 16, 1920)),
    fps: num(m.fps, TL_DEFAULT_META.fps, 1, 60),
    background: safeColor(m.background ?? '#000000'),
  };
}

// 项目内对 file 类资产的引用收集：节点绑定/结果/输出/草稿@绑定、分镜、时间线、导演台 xp-asset:// 令牌。
// 非媒体文件（glb/gltf/bin）只有被项目引用才进包——绝不按扩展名盲打包任意文件。
function collectFileRefs(data) {
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

export async function buildProjectPackage({ projectJson, clips, meta, blobOf, assets }) {
  const entries = [];
  const mediaList = [];
  const skipped = [];
  let fileRefs = new Set();
  try { fileRefs = collectFileRefs(JSON.parse(String(projectJson))); } catch { /* 坏 projectJson 由导入侧拒绝 */ }
  for (const a of Object.values(assets ?? {})) {
    if (a.missing) { skipped.push(`${a.name}（本地文件标记缺失）`); continue; }
    const ext = PACKAGE_MIME_EXT[a.mime];
    if (!ext || !PACKAGE_KINDS.has(a.kind)) { skipped.push(`${a.name}（类型 ${a.mime ?? '?'} 不在项目包白名单）`); continue; }
    // 非媒体文件必须是项目内引用资产（导演台令牌/节点绑定/分镜/时间线/fromDirector）
    if (!MEDIA_KINDS.has(a.kind) && !fileRefs.has(a.id)) { skipped.push(`${a.name}（非媒体文件未被项目引用）`); continue; }
    const blob = await blobOf(a.id);
    if (!blob || !blob.size) { skipped.push(`${a.name}（无本地文件）`); continue; }
    const path = `media/${a.id}.${ext}`;
    if (!PACKAGE_FILE_RE.test(path)) { skipped.push(`${a.name}（素材 id 不适合打包）`); continue; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await sha256Bytes(bytes);
    if (a.sha256 && a.sha256 !== sha256) throw new Error(`素材「${a.name}」摘要不符，工程包未导出`);
    mediaList.push({ path, assetId: a.id, name: a.name, kind: a.kind, mime: a.mime, size: bytes.byteLength, sha256 });
    entries.push({ name: path, data: bytes });
  }
  const manifest = {
    format: PACKAGE_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    timeline: { clips: clips ?? [], meta: meta ?? TL_DEFAULT_META },
    media: mediaList,
    // 显式未打包清单：导出/导入两侧如实提示，绝不静默丢资产
    warnings: skipped,
  };
  entries.unshift({ name: 'project.json', data: enc.encode(projectJson) });
  entries.unshift({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  return zipStore(entries);
}

export function parseProjectPackage(buf) {
  const files = unzipStore(buf);
  const manifestRaw = files.get('manifest.json');
  const projectRaw = files.get('project.json');
  if (!manifestRaw || !projectRaw) throw new Error('项目包缺少 manifest.json / project.json');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestRaw)); } catch { throw new Error('manifest.json 不是合法 JSON'); }
  if (!isObj(manifest) || manifest.format !== PACKAGE_FORMAT) throw new Error('项目包 format 须为 xp-package@1');
  if (!Array.isArray(manifest.media)) throw new Error('项目包 media 不合法');
  if (manifest.media.length > ZIP_LIMITS.maxEntries) throw new Error('项目包媒体清单超限');
  const seen = new Set();
  for (const m of manifest.media) {
    if (!isObj(m) || typeof m.assetId !== 'string' || typeof m.name !== 'string'
      || !PACKAGE_KINDS.has(m.kind) || typeof m.mime !== 'string' || !PACKAGE_MIME_EXT[m.mime]
      || !Number.isFinite(m.size) || m.size < 0)
      throw new Error('项目包媒体清单字段不合法');
    // path = 确定性身份载体：media/<导出前assetId>.<MIME推导扩展名>，不接受任何自由命名
    if (m.path !== `media/${m.assetId}.${PACKAGE_MIME_EXT[m.mime]}`) throw new Error('项目包媒体路径与素材身份不一致');
    if (seen.has(m.assetId)) throw new Error('项目包媒体清单 assetId 重复');
    if (m.sha256 != null && (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)))
      throw new Error('项目包媒体清单 SHA-256 不合法');
    seen.add(m.assetId);
    if (!files.has(m.path)) throw new Error('项目包媒体清单引用了缺失文件');
  }
  const projectJson = new TextDecoder().decode(projectRaw);
  return { manifest, projectJson, files };
}

const tlSig = clips => clips.map(c => `${c.id}|${c.assetId}|${c.start}|${c.end}`).sort().join(';');
const isRichClips = l => Array.isArray(l) && l.some(c => isObj(c) && (c.track != null || c.kind != null));

// 旧版包：project.json 内时间线可能只剩旧 6 字段；manifest.timeline 保存了富时间线（导出前 assetId）。
// 在唯一的 importJSON 调用之前并回项目源。两边都含富时间线但不一致 = 疑似篡改 → 显式拒绝，不静默二选一。
function mergeManifestTimeline(data, manifest, srcAssets) {
  const tl = manifest?.timeline;
  if (!isObj(tl) || !Array.isArray(tl.clips)) return;
  if (!isObj(data.project.studio)) data.project.studio = {};
  const st = data.project.studio;
  const srcClips = (Array.isArray(st.timeline) ? st.timeline : []).filter(isObj);
  const mClips = normalizeTimeline(tl.clips.filter(isObj), { assets: srcAssets }).clips;
  if (srcClips.length && isRichClips(srcClips)) {
    if (mClips.length) {
      const sNorm = normalizeTimeline(srcClips, { assets: srcAssets }).clips;
      if (tlSig(sNorm) !== tlSig(mClips)) throw new Error('项目包时间线与 project.json 不一致（疑似篡改），已拒绝导入');
    }
    // manifest 无富时间线信息时以 project.json 为权威
  } else if (mClips.length) {
    // 源为空或只剩旧版 6 字段：以 manifest 富时间线为准（id 仍是导出前身份，由核心统一重映射）
    st.timeline = mClips;
  }
  if (!isObj(st.timelineMeta)) st.timelineMeta = sanitizeTimelineMeta(tl.meta);
}

// 导入编排（确定性身份版）：
//  · manifest.media[*].assetId = 导出前 id —— 先与源项目素材记录逐项核对（name/kind/mime/size），
//    再以 Map<原assetId, Blob> 交给 store.importJSON(projectJson, {assetBlobs}) 一次性提交：
//    核心用 assetIdMap 落到新身份、blob 键先于 KV 暂存、失败不切当前项目/不动 lastOpened。
//  · 绝不做“按 name+kind+size 猜绑定”和导入后逐个 setBlob 的旧路径。
//  · 未随包提供 blob 的素材保持 missing 占位；缺失名单如实返回。
export async function importProjectPackage(deps, buf) {
  const { store } = deps;
  const { manifest, projectJson, files } = parseProjectPackage(buf);
  let data;
  try { data = JSON.parse(projectJson); } catch { throw new Error('project.json 不是合法 JSON'); }
  if (!isObj(data) || !isObj(data.project)) throw new Error('project.json 缺少项目数据');
  if (containsSecret(data)) throw new Error('导入文件包含疑似密钥字段，已拒绝');
  const srcAssets = isObj(data.project.assets) ? data.project.assets : {};
  const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.slice(0, 50).map(w => str(w, 200)) : [];

  const assetBlobs = new Map();
  for (const m of manifest.media) {
    const src = srcAssets[m.assetId];
    if (!isObj(src)) throw new Error(`项目包媒体「${m.name}」的 assetId 在项目中不存在`);
    if (src.name !== m.name || src.kind !== m.kind || (typeof src.mime === 'string' && src.mime !== m.mime))
      throw new Error(`项目包媒体「${m.name}」与项目素材记录不一致`);
    if (Number.isFinite(src.size) && src.size !== m.size)
      throw new Error(`项目包媒体「${m.name}」大小与项目素材记录不一致`);
    const bytes = files.get(m.path);
    if (!bytes) throw new Error(`项目包缺少文件：${m.path}`);
    const sha256 = await sha256Bytes(bytes);
    if (m.sha256 && m.sha256 !== sha256 || src.sha256 && src.sha256 !== sha256)
      throw new Error(`项目包素材「${m.name}」SHA-256 摘要不符，导入未提交`);
    if (bytes.length !== m.size) {
      // 以实际字节为准修正源元数据（清单 size 失真不阻断身份明确的恢复）
      src.size = bytes.length;
      warnings.push(`媒体「${m.name}」清单大小失真，已按实际字节恢复`);
    }
    assetBlobs.set(m.assetId, new Blob([bytes], { type: m.mime }));
  }

  mergeManifestTimeline(data, manifest, srcAssets);

  // 本版本与核心的 assetBlobs 导入契约一起发布；默认参数不计入 Function.length。
  if (typeof store?.importJSON !== 'function')
    throw new Error('当前核心不支持随包素材导入（需要 importJSON(projectJson, {assetBlobs})）');
  const project = await store.importJSON(JSON.stringify(data), { assetBlobs, assertCurrent: deps.assertCurrent });
  // 导入后不再做按名重绑/补写：一切身份已由核心的 assetIdMap + 暂存 blob 决定
  const missing = Object.values(project.assets ?? {}).filter(a => a?.missing).map(a => a.name ?? a.id);
  if (missing.length) warnings.push(`未随包恢复的素材（保持缺失占位，可在素材库重新绑定）：${missing.slice(0, 10).join('、')}`);
  deps.assets?.renderLibrary?.();
  return { project, rebound: assetBlobs.size, missing, warnings };
}

// 浏览器渲染包：render.json + media/*（供本机 media-service 消费）
export async function buildRenderPackage(job, blobOf) {
  const entries = [{ name: 'render.json', data: enc.encode(JSON.stringify(job)) }];
  for (const m of job.media) {
    const blob = await blobOf(m.assetId);
    if (!blob || !blob.size) throw new Error(`渲染素材缺失：${m.name}`);
    entries.push({ name: m.key, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return zipStore(entries);
}
export function parseRenderPackage(buf) {
  const files = unzipStore(buf);
  const raw = files.get('render.json');
  if (!raw) throw new Error('渲染包缺少 render.json');
  let job;
  try { job = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error('render.json 不是合法 JSON'); }
  return { job, files };
}

// ---------- 浏览器侧下载（DOM 仅在本函数内） ----------
export function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
