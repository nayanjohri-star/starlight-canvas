// 时间线剪辑器：五条轨（v1 视频 / ov1 叠加 / a1 音乐 / a2 配音 / s1 字幕）。
// 数据落在 project.studio.timeline（片段数组）+ project.studio.timelineMeta（输出设置）。
//  · 片段字段：track/kind/assetId/start/end/in/speed/volume/muted/fadeIn/fadeOut/text/位置矩形
//  · 旧版 core 形态 {assetId,start,end,subtitle,muted} 由 normalizeTimeline 一次性迁移/兼容
//  · 所有改动先 editor.checkpoint()（undo 走编辑历史）；导入/导出经 export-project 消毒
//  · 预览与导出都过 media-worker 引擎；导出还可走本机 /media（FFmpeg，mp4）或浏览器（WebM/MP4）
//
// 导出能力如实标注：EDL=CMX3600 子集、OTIO=JSON 子集、SRT=标准字幕；
// Premiere/剪映草稿未实现（不伪造兼容）。浏览器导出 WebM 优先、MP4 视支持。

import { el, toast, modal, confirmDialog } from './ui.js';
import { studioState, outputOf } from './studio-schema.js';
import { KIND_LABEL } from './assets.js';
import {
  TL_TRACKS, TL_TRACK_INDEX, TL_SIZES, TL_DEFAULT_META, TL_LIMITS,
  normalizeTimeline, laneClips, timelineDuration, laneEnd, clipVisualLen,
  clipFromAsset, newTextClip, newSubtitleClip, splitClipAt, moveClip, trimClipEdge,
  reorderClip, subtitlesOf, parseSRT, toSRT, toEDL, toOTIO,
  buildRenderJob, buildRenderPackage, buildProjectPackage, importProjectPackage,
  downloadBlob, PACKAGE_MIME_EXT,
} from './export-project.js';
import { createTimelineEngine, probeRenderSupport, probeBlobAsset } from './media-worker.js';
import { feature, isHosted } from './runtime-config.js';

// toast 在无 DOM 环境（node 测试）会抛 ReferenceError：包一层保证纯逻辑可测
const note = (m, t, ms) => { try { toast(m, t, ms); } catch { /* headless */ } };

const fmtT = s => {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
};

// 轨道辅助说明（仅视图层 tooltip/hint，未知轨道 id 自动留空）
const LANE_HINTS = { v1: '主画面', ov1: '叠加/文字', a1: '音乐', a2: '配音', s1: '字幕' };
// 刻度尺候选步长（秒）：按当前缩放挑出间隔 ≥64px 的最小步长
const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

// X-Render-Warnings：服务端返回的可读告警（如「按确认省略字幕烧录」），原样提示用户；
// 头部缺失/解析失败只当作无告警，绝不把技术细节拼进结果。
const parseRenderWarnings = res => {
  try {
    const h = res?.headers?.get?.('X-Render-Warnings');
    if (!h) return [];
    const list = JSON.parse(decodeURIComponent(h));
    return Array.isArray(list) ? list.filter(w => typeof w === 'string' && w).slice(0, 10) : [];
  } catch { return []; }
};

export function createTimeline(deps) {
  const { store, storage, assets, editor } = deps;
  const blobOf = id => assets?.blobOf ? assets.blobOf(id) : storage.getBlob(`blob:${id}`);

  const studio = () => studioState(store.project);
  function ensure() {
    const st = studio();
    if (!Array.isArray(st.timeline)) st.timeline = [];
    const mm = st.timelineMeta;
    if (!mm || typeof mm !== 'object' || !Number.isFinite(mm.width) || !Number.isFinite(mm.height)) {
      st.timelineMeta = { ...TL_DEFAULT_META };
    } else {
      // 夹取输出设置：尺寸 16–1920、fps 1–60、背景 #rrggbb
      mm.width = Math.min(1920, Math.max(16, Math.round(mm.width)));
      mm.height = Math.min(1920, Math.max(16, Math.round(mm.height)));
      mm.fps = Math.min(60, Math.max(1, Number(mm.fps) || TL_DEFAULT_META.fps));
      if (!/^#[0-9a-fA-F]{6}$/.test(mm.background)) mm.background = TL_DEFAULT_META.background;
      mm.version = 1;
    }
    return st;
  }
  const clips = () => ensure().timeline;
  const meta = () => ensure().timelineMeta;

  // 规范化 + 旧字段迁移（写回）。checkpoint 由调用方决定（初次打开不算用户改动）。
  function tidy({ checkpoint = false, silent = true } = {}) {
    const st = ensure();
    const before = JSON.stringify(st.timeline);
    const { clips: nc, warnings } = normalizeTimeline(st.timeline, { assets: store.project?.assets ?? {} });
    if (JSON.stringify(nc) !== before) {
      if (checkpoint) editor?.checkpoint();
      st.timeline = nc;
      store.touch({ type: 'data' });
    }
    if (!silent) for (const w of warnings) note(w, 'warn', 5000);
    return st.timeline;
  }

  // 所有用户改动的统一入口：先 checkpoint（编辑历史可撤销），后 touch + 刷新。
  function mutate(fn, { refresh = true } = {}) {
    editor?.checkpoint();
    const r = fn(clips());
    tidy();
    store.touch({ type: 'data' });
    deps.onUpdate?.();
    if (refresh) session?.refresh();
    return r;
  }

  // 探测素材源时长/尺寸（失败不阻塞添加，仅影响修剪上限提示）
  async function probeAsset(assetId) {
    const blob = await blobOf(assetId);
    if (!blob) return null;
    return probeBlobAsset(blob).catch(() => null);
  }

  // 契约接口：把库内素材追加到对应轨（video/image→v1，audio→a1；可用 track 覆盖）
  async function addAsset(assetId, { track } = {}) {
    const project = store.project;
    const a = store.project?.assets?.[assetId];
    if (!a) { note('素材不存在', 'err'); return null; }
    if (a.missing) { note(`素材「${a.name}」本地文件缺失，请先在素材库重新绑定`, 'err', 5000); return null; }
    if (!['video', 'image', 'audio'].includes(a.kind)) { note('该素材类型不能进时间线', 'err'); return null; }
    const lane = track ?? (a.kind === 'audio' ? 'a1' : 'v1');
    const info = await probeAsset(assetId);
    if (store.project !== project || project.assets[assetId] !== a) { note('项目或素材已变更，未加入时间线', 'warn'); return null; }
    const len = a.kind === 'image' ? 5 : Math.min(Math.max(info?.duration ?? 5, TL_LIMITS.minLen), TL_LIMITS.maxDuration);
    const clip = clipFromAsset(a, lane, { start: laneEnd(clips(), lane), len });
    if (info?.duration) clip.sourceDuration = info.duration;
    if (a.kind === 'image' && lane === 'ov1') Object.assign(clip, { x: 0.05, y: 0.05, w: 0.28, h: 0.28 });
    mutate(cs => cs.push(clip));
    note(`已加入${TL_TRACKS[TL_TRACK_INDEX[lane]].label}轨：${a.name}`, 'ok');
    return clip;
  }

  // ---------- 分镜成片按序入轨（合同 §6.3 + 裁决15：内容级判重，先预览后确认，应用全或无）----------
  // 入口由时间线面板「分镜入轨」触发；分镜侧按钮挂点属 B（storyboards 面板），
  // 其数据层直接调本组接口即可——两入口共享同一 plan/判重语义。

  const SHOTS_TL_MAX = 10;
  // 入轨片段时长上限与时间线一致；手动时长同样受此约束
  const MANUAL_DUR_MAX = TL_LIMITS.maxDuration;

  // shot → 成片素材：shot.nodeId → 生成节点 → outputOf 首个 video 素材。
  // 缺失引用/尚无成片一律进问题清单，绝不拿残缺素材静默入轨。
  function shotVideoItem(s) {
    const node = s?.nodeId ? store.node(s.nodeId) : null;
    if (!node) return { ok: false, code: 'no_node', reason: '未关联视频节点（先在分镜里生成或补建节点）' };
    const out = outputOf(store.project, node);
    if (out.missing.length) return { ok: false, code: 'asset_missing', reason: '成片素材引用缺失' };
    const a = out.assets.find(x => x.kind === 'video' && !x.missing);
    if (!a) return { ok: false, code: 'no_result', reason: '尚无成片（先生成并下载该镜头的视频）' };
    return { ok: true, asset: a };
  }

  // 选择校验（入轨的前提）：
  //  · 必须显式给出非空 shotIds——空选择不代表「全部」；
  //  · 含未知/已删除的 id 或重复 id → 明确失败，不静默过滤；
  //  · 超过单批上限 → 明确失败，不静默截断。
  function checkShotSelection(shotIds) {
    if (!Array.isArray(shotIds) || !shotIds.length)
      return { ok: false, code: 'empty_selection', reason: '请先选择要加入时间线的分镜（空选择不代表全部）' };
    if (new Set(shotIds).size !== shotIds.length)
      return { ok: false, code: 'duplicate_ids', reason: '分镜选择中有重复项' };
    const all = studio().shots ?? [];
    const known = new Set(all.map(s => s.id));
    const unknownIds = shotIds.filter(id => !known.has(id));
    if (unknownIds.length)
      return { ok: false, code: 'unknown_shots', unknownIds, reason: `所选分镜不存在或已删除：${unknownIds.slice(0, 5).join('、')}${unknownIds.length > 5 ? ` 等 ${unknownIds.length} 个` : ''}` };
    if (shotIds.length > SHOTS_TL_MAX)
      return { ok: false, code: 'too_many', reason: `单次最多加入 ${SHOTS_TL_MAX} 个分镜（已选 ${shotIds.length} 个），请分批操作` };
    // 顺序取分镜权威顺序（project.studio.shots 数组序），不取点击顺序
    return { ok: true, picked: all.filter(s => shotIds.includes(s.id)) };
  }

  // 元数据可在本地文件被清理后仍存在；签发计划与真正入轨前都核验视频实体。
  async function localShotBlob(a) {
    const blob = await blobOf(a.id).catch(() => null);
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) return null;
    if (Number.isFinite(a.size) && a.size > 0 && blob.size !== a.size) return null;
    const type = (blob.type || a.mime || '').toLowerCase();
    if (type !== 'video/mp4' && type !== 'video/webm') return null;
    if (typeof blob.slice === 'function') {
      const head = new TextDecoder().decode(await blob.slice(0, 64).arrayBuffer()).trimStart();
      if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) return null;
    }
    return blob;
  }

  // 可信源时长：素材登记时由服务端探测得到的 durationSeconds（未标记 durationUntrusted），
  // 或本地实测（probeBlobAsset 解码媒体元数据）。探测失败绝不以剧本时长或默认值顶替。
  async function measuredDuration(a, blob) {
    if (Number.isFinite(a.durationSeconds) && a.durationSeconds > 0 && a.durationUntrusted !== true) return { ok: true, value: a.durationSeconds, source: 'asset' };
    const info = await probeBlobAsset(blob).catch(() => null);
    if (Number.isFinite(info?.duration) && info.duration > 0) return { ok: true, value: info.duration, source: 'probe' };
    return { ok: false };
  }

  // 计划身份：项目 + 目标轨全部片段 + 逐项指纹 + 选项。任一变化即过期，apply 拒绝并要求重新预览。
  // 逐项指纹覆盖：条目快照（含时长与来源）、分镜现态（标题/提示词/时长/关联节点/素材/更新时间）、
  // 节点关联与产出、素材现态（缺失/名称/实测时长/内容修订/大小）。
  function shotPlanSig(project, items, lane, opts) {
    const shots = studio().shots ?? [];
    const fp = items.map(it => {
      const s = shots.find(x => x.id === it.shotId) ?? null;
      const a = store.project?.assets?.[it.assetId] ?? null;
      const node = s?.nodeId ? store.node(s.nodeId) : null;
      return [it.shotId ?? null, it.assetId ?? null, it.title ?? null, it.name ?? null,
        it.duration ?? null, it.durationSource ?? null, it.sourceDuration ?? null, it.expectedDuration ?? null,
        s == null ? 'gone' : [s.title ?? null, s.prompt ?? null, s.videoPrompt ?? null, s.duration ?? null,
          s.durationInvalid === true, s.durationRaw ?? null, s.nodeId ?? null, s.imageNodeId ?? null,
          Array.isArray(s.assetIds) ? s.assetIds.join(',') : '', s.updatedAt ?? null],
        node == null ? 'no-node' : [node.id, node.data?.resultAssetId ?? null, JSON.stringify(node.data?.outputAssetIds ?? null)],
        a == null ? 'gone'
          : [a.missing === true, a.name ?? null, a.durationSeconds ?? null, a.durationUntrusted === true,
             a.contentRevision ?? null, a.size ?? null]];
    });
    return JSON.stringify([project?.id ?? null, lane, fp,
      laneClips(clips(), lane).map(c => [c.id, c.assetId, c.start, c.end]),
      opts.allowDup === true, opts.allowPartial === true, JSON.stringify(opts.omitted ?? [])]);
  }

  // 签发登记：apply 只接受 previewShotsToTimeline 签发的 plan 对象本身；同一计划只能消费一次
  //（包括 allowDuplicate 的计划）。「再次插入」必须重新预览、重新确认。
  const issuedPlans = new WeakSet();
  const consumedPlans = new WeakSet();
  const laneCheck = lane => Object.hasOwn(TL_TRACK_INDEX, lane)
    ? null : `非法目标轨「${lane}」（合法轨：${Object.keys(TL_TRACK_INDEX).join('/')}）`;

  // previewShotsToTimeline({shotIds, track='v1', allowDuplicate, allowPartial, manualDurations}) →
  //   { ok, blocked?, plan?, items, conflicts, total, code?, reason? }
  //  · 任一所选分镜不可用（无成片、素材缺失、时长无法实测）→ 默认整批阻止（ok=false、blocked=true），
  //    只有显式 allowPartial 才生成「仅可用镜头」计划，并在 plan.omitted 列出被略过的镜头；
  //  · 时长探测失败的镜头进问题清单（retryable）；手动时长须经 manualDurations 显式提供，
  //    记为 durationSource='manual'，apply 时还须 confirmManual:true 再次确认；
  //  · 纯本地解析：零网络请求。
  async function previewShotsToTimeline({ shotIds, track = 'v1', allowDuplicate = false, allowPartial = false, manualDurations = {} } = {}) {
    const bad = laneCheck(track);
    if (bad) return { ok: false, code: 'bad_track', reason: bad, items: [], conflicts: [], total: 0 };
    const sel = checkShotSelection(shotIds);
    if (!sel.ok) return { ok: false, code: sel.code, reason: sel.reason, unknownIds: sel.unknownIds ?? [], items: [], conflicts: [], total: Array.isArray(shotIds) ? shotIds.length : 0 };
    const project = store.project;
    const items = [], conflicts = [];
    for (const [i, s] of sel.picked.entries()) {
      const title = s.title || `镜头 ${i + 1}`;
      const r = shotVideoItem(s);
      if (!r.ok) { conflicts.push({ shotId: s.id, title, code: r.code, reason: r.reason, retryable: false }); continue; }
      const a = r.asset;
      const blob = await localShotBlob(a);
      if (store.project !== project) return { ok: false, code: 'project_switched', reason: '项目已切换，预览作废', items: [], conflicts: [], total: sel.picked.length };
      if (!blob) { conflicts.push({ shotId: s.id, title, code: 'local_file_missing', reason: '本机成片文件缺失或不完整，请恢复原任务下载或重新绑定素材', retryable: false }); continue; }
      const measured = await measuredDuration(a, blob);
      if (store.project !== project) return { ok: false, code: 'project_switched', reason: '项目已切换，预览作废', items: [], conflicts: [], total: sel.picked.length };
      const expectedDuration = Number.isFinite(s.duration) ? s.duration : null;
      let duration = null, durationSource = null;
      if (measured.ok) { duration = measured.value; durationSource = 'measured'; }
      else {
        const manual = Number(manualDurations?.[s.id]);
        if (Number.isFinite(manual) && manual >= TL_LIMITS.minLen && manual <= MANUAL_DUR_MAX) { duration = manual; durationSource = 'manual'; }
        else {
          conflicts.push({ shotId: s.id, title, code: 'duration_probe_failed', retryable: true, assetId: a.id,
            reason: '成片时长无法实测（可重新探测，或显式填写手动时长并确认）' });
          continue;
        }
      }
      items.push({ shotId: s.id, title, assetId: a.id, name: a.name, duration, durationSource, expectedDuration,
        sourceDuration: durationSource === 'measured' ? duration : null });
    }
    const blocked = conflicts.length > 0 && !allowPartial;
    if (blocked || !items.length)
      return { ok: false, blocked: conflicts.length > 0, code: conflicts.length ? 'unavailable_shots' : 'nothing_to_insert',
        reason: conflicts.length ? `所选分镜中有 ${conflicts.length} 个不可用，已整批阻止（可修复后重试，或明确选择仅加入可用镜头）` : '没有可加入的镜头',
        items, conflicts, total: sel.picked.length };
    const plan = {
      items, lane: track, allowDup: allowDuplicate === true, allowPartial: allowPartial === true,
      omitted: allowPartial ? conflicts.map(c => ({ shotId: c.shotId, title: c.title, reason: c.reason })) : [],
      needsManualConfirm: items.some(it => it.durationSource === 'manual'),
      dup: shotSeqDuplicate(items, track),
    };
    plan.sig = shotPlanSig(project, items, track, plan);
    issuedPlans.add(plan);
    return { ok: true, plan, items, conflicts, total: sel.picked.length };
  }

  // 内容级判重（裁决15）：目标轨轨尾若已排同一 assetId 序列 → 视为重复确认。
  function shotSeqDuplicate(items, lane) {
    if (!items.length) return false;
    const tail = laneClips(clips(), lane).slice(-items.length).map(c => c.assetId);
    return tail.length === items.length && items.every((it, i) => it.assetId === tail[i]);
  }

  // applyTimelinePlan(plan, {confirmManual})：签发校验 → 实体复核 → 一次性消费 → 全或无单次 mutate。
  async function applyTimelinePlan(plan, { confirmManual = false } = {}) {
    if (!plan?.items?.length) return { ok: false, reason: '计划为空' };
    const bad = laneCheck(plan.lane);
    if (bad) return { ok: false, reason: bad };
    if (!issuedPlans.has(plan))
      return { ok: false, reason: '计划未经预览签发——请调用 previewShotsToTimeline 生成' };
    if (consumedPlans.has(plan))
      return { ok: false, code: 'consumed', reason: '该计划已经加入过时间线；如需再次插入，请重新预览并确认' };
    if (shotPlanSig(store.project, plan.items, plan.lane, plan) !== plan.sig)
      return { ok: false, code: 'stale', reason: '计划已过期（分镜/素材/节点关联/轨道或项目已变化），请重新预览' };
    if (!plan.allowDup && shotSeqDuplicate(plan.items, plan.lane))
      return { ok: false, code: 'duplicate', reason: '轨尾已存在同一分镜序列——如需重复请显式「再次插入」' };
    if (plan.needsManualConfirm && confirmManual !== true)
      return { ok: false, code: 'manual_unconfirmed', reason: '计划含手动填写的时长（非实测），需明确确认后才能加入' };
    const project = store.project;
    for (const it of plan.items) {
      const a = project?.assets?.[it.assetId];
      if (!a || a.missing) return { ok: false, code: 'stale', reason: `素材「${it.name ?? it.assetId}」已缺失或解绑` };
      if (!await localShotBlob(a)) return { ok: false, code: 'local_file_missing', reason: `素材「${it.name ?? it.assetId}」的本机文件缺失或不完整，未加入时间线` };
    }
    if (store.project !== project || shotPlanSig(project, plan.items, plan.lane, plan) !== plan.sig)
      return { ok: false, code: 'stale', reason: '核验文件期间项目、分镜或素材已变化，请重新预览' };
    let start = laneEnd(clips(), plan.lane);
    const made = [];
    for (const it of plan.items) {
      const a = store.project?.assets?.[it.assetId];
      if (!a || a.missing) return { ok: false, reason: `素材「${it.name ?? it.assetId}」已缺失或解绑` };
      if (!(Number.isFinite(it.duration) && it.duration > 0)) return { ok: false, reason: `「${it.title}」缺少可信时长` };
      const clip = clipFromAsset(a, plan.lane, { start, len: it.duration });
      if (it.durationSource === 'measured') clip.sourceDuration = it.duration;
      else clip.durationManual = true;   // 手动时长：不冒充实测源时长
      made.push(clip);
      start += it.duration;
    }
    mutate(cs => cs.push(...made));   // 单次 checkpoint+touch+refresh：全或无
    consumedPlans.add(plan);
    return { ok: true, clips: made, omitted: plan.omitted };
  }

  // 分镜入轨交互：先显式选择分镜 → 预览 → 确认。「再次插入」「仅加入可用镜头」「手动时长」都是新的预览与确认。
  async function insertFromShots(opts = {}) {
    const project = store.project;
    const shots = studio().shots ?? [];
    if (!shots.length) { note('当前项目尚无分镜——先在分镜面板拆解剧本', 'warn'); return; }
    if (!Array.isArray(opts.shotIds)) { openShotPicker(shots); return; }
    const r = await previewShotsToTimeline(opts);
    if (!r || store.project !== project || session?.closed) return;
    if (!r.ok && !r.blocked) { note(r.reason, 'warn', 6000); return; }
    openShotInsertModal(r, opts);
  }
  function openShotPicker(shots) {
    const boxes = shots.map((s, i) => {
      const cb = el('input', { type: 'checkbox', value: s.id });
      const ready = shotVideoItem(s).ok;
      return { cb, row: el('label', { class: 'tl-shot-row' }, cb,
        el('span', { class: 'tl-shot-no mono', text: `${i + 1}` }),
        el('span', { class: 'tl-shot-title', text: s.title || `镜头 ${i + 1}` }),
        el('span', { class: 'tl-shot-dur muted', text: ready ? '已有成片' : '尚无成片' })), ready };
    });
    const count = el('span', { class: 'hint', text: '已选 0 个' });
    const next = el('button', { class: 'primary', type: 'button', text: '预览', disabled: true });
    const sync = () => { const n = boxes.filter(b => b.cb.checked).length; count.textContent = `已选 ${n} 个`; next.disabled = n === 0; };
    for (const b of boxes) b.cb.addEventListener('change', sync);
    const all = el('button', { type: 'button', text: '选择全部已有成片' });
    all.addEventListener('click', () => { for (const b of boxes) b.cb.checked = b.ready; sync(); });
    const m = modal(el('div', {},
      el('h3', { text: '选择要加入时间线的分镜' }),
      el('p', { class: 'hint', text: `按分镜顺序加入；单次最多 ${SHOTS_TL_MAX} 个。` }),
      el('div', { class: 'tl-shot-list' }, ...boxes.map(b => b.row)),
      el('div', { class: 'modal-actions' }, count, all, next)));
    next.addEventListener('click', () => {
      const ids = boxes.filter(b => b.cb.checked).map(b => b.cb.value);
      m.close();
      insertFromShots({ shotIds: ids });
    });
  }
  function openShotInsertModal(r, opts) {
    const plan = r.plan ?? null;
    const lane = plan?.lane ?? opts.track ?? 'v1';
    const laneLabel = TL_TRACKS[TL_TRACK_INDEX[lane]]?.label ?? lane;
    const rows = r.items.map((it, i) => el('div', { class: 'tl-shot-row' },
      el('span', { class: 'tl-shot-no mono', text: `${i + 1}` }),
      el('span', { class: 'tl-shot-title', text: it.title }),
      el('span', { class: 'tl-shot-asset muted', text: `→ ${it.name}` }),
      el('span', { class: 'tl-shot-dur mono muted', text: `${it.durationSource === 'manual' ? '手动' : '实测'} ${fmtT(it.duration)}｜剧本 ${fmtT(it.expectedDuration)}` })));
    const manualInputs = new Map();
    const conflicts = (r.conflicts ?? []).map(c => {
      const line = el('div', { class: 'err-text tl-shot-conflict' }, el('span', { text: `· ${c.title ?? c.shotId ?? '（未知镜头）'}：${c.reason}` }));
      if (c.code === 'duration_probe_failed') {
        const inp = el('input', { type: 'number', min: TL_LIMITS.minLen, max: MANUAL_DUR_MAX, step: 0.1, placeholder: '手动时长（秒）', class: 'tl-manual-dur' });
        manualInputs.set(c.shotId, inp);
        line.append(inp);
      }
      return line;
    });
    const dup = plan?.dup === true, allowDup = plan?.allowDup === true;
    const actions = [];
    if (r.conflicts?.some(c => c.retryable)) {
      const retry = el('button', { type: 'button', text: '重新探测' });
      retry.addEventListener('click', () => { m.close(); insertFromShots({ ...opts }); });
      actions.push(retry);
    }
    if (manualInputs.size) {
      const useManual = el('button', { type: 'button', text: '使用手动时长预览' });
      useManual.addEventListener('click', () => {
        const manualDurations = { ...(opts.manualDurations ?? {}) };
        for (const [id, inp] of manualInputs) if (inp.value !== '') manualDurations[id] = Number(inp.value);
        m.close(); insertFromShots({ ...opts, manualDurations });
      });
      actions.push(useManual);
    }
    if (r.blocked && r.items.length) {
      const partial = el('button', { type: 'button', text: `仅加入可用的 ${r.items.length} 个镜头…` });
      partial.addEventListener('click', () => { m.close(); insertFromShots({ ...opts, allowPartial: true }); });
      actions.push(partial);
    }
    let manualAck = null;
    if (plan?.needsManualConfirm) manualAck = el('input', { type: 'checkbox' });
    const okBtn = plan ? el('button', { class: 'primary', type: 'button', disabled: (dup && !allowDup) || !!manualAck,
      text: allowDup && dup ? `确认重复加入 ${plan.items.length} 个片段` : `确认加入 ${plan.items.length} 个片段` }) : null;
    manualAck?.addEventListener('change', () => { okBtn.disabled = (dup && !allowDup) || !manualAck.checked; });
    const againBtn = el('button', { type: 'button', text: '再次插入（会重复添加）' });
    const m = modal(el('div', {},
      el('h3', { text: '按分镜顺序加入时间线' }),
      el('p', { class: 'hint', text: `按分镜顺序排到「${laneLabel}」轨轨尾；片段时长取成片实测，剧本时长仅对照显示，不裁剪、不变速、不拉伸。` }),
      rows.length ? el('div', { class: 'tl-shot-list' }, ...rows) : el('p', { class: 'hint', text: '没有可入轨的镜头' }),
      conflicts.length ? el('div', { class: 'tl-shot-conflicts' },
        el('p', { class: 'err-text', text: r.blocked ? `${r.reason}：` : '以下镜头将被略过：' }), ...conflicts) : null,
      plan?.omitted?.length ? el('p', { class: 'hint', text: `本次仅加入可用镜头，略过 ${plan.omitted.length} 个（见上方清单）。` }) : null,
      manualAck ? el('label', { class: 'hint' }, manualAck, el('span', { text: ' 我确认部分片段使用手动填写的时长（非实测），如与成片实际长度不符需自行调整' })) : null,
      dup ? el('p', { class: 'err-text', text: allowDup
        ? '轨尾已有同一分镜序列——本次为显式「再次插入」，将重复添加这些片段。'
        : '轨尾已存在同一分镜序列——若非误点，请用「再次插入」显式重复添加。' }) : null,
      el('div', { class: 'modal-actions' }, ...actions, ...(plan ? [againBtn, okBtn] : []))));
    againBtn.style.display = dup && !allowDup ? '' : 'none';
    okBtn?.addEventListener('click', async () => {
      const res = await applyTimelinePlan(plan, { confirmManual: manualAck?.checked === true });
      if (!res.ok) { note(res.reason, 'err', 6000); m.close(); return; }
      m.close();
      note(`已按分镜顺序加入 ${res.clips.length} 个片段${res.omitted?.length ? `，略过 ${res.omitted.length} 个` : ''}`, 'ok');
    });
    // 显式「再次插入」= 新预览（allowDuplicate 进签名）→ 新 plan，用户在新弹窗里再次确认
    againBtn.addEventListener('click', () => { m.close(); insertFromShots({ ...opts, allowDuplicate: true }); });
  }

  // ---------- 渲染导出 ----------

  let renderBusy = null;   // 串行票据：一次一个导出任务（进入即占槽，覆盖确认/探测/打包/渲染全程）
  async function serverCaps(signal) {
    if (!feature('serverRender')) return null;
    try {
      const res = await fetch('/media/capabilities', { signal });
      if (!res.ok) return null;
      const j = await res.json();
      return j?.available ? j : null;
    } catch { return null; }
  }

  // renderExport(options)：options {format:'auto'|'webm'|'mp4', via:'auto'|'browser'|'server',
  //   onProgress(ratio,phase), signal, omitMissing（确认省略缺失素材片段）,
  //   allowTextFallback（确认本机服务可省略文字/字幕烧录）, silent:true 时不弹窗直接返回 {blob,...}}
  // 快照语义：进入时固定「当前项目」的片段/输出设置/素材清单；任何 await 期间发生切项目或
  // 取消都中止整条流水线——不渲染新项目数据、不向新项目素材库写入、不注册新素材。
  async function renderExport(options = {}) {
    if (renderBusy) throw new Error('已有导出任务进行中');
    if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    const ticket = {};
    renderBusy = ticket;   // 先占槽再异步：确认弹窗/能力探测期间的第二次调用一律被拒
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    // 切项目 = 本次导出失效：中止探测/打包/编码/下载所有在途阶段
    const unsub = store.onChange?.(r => { if (r?.type === 'project') ac.abort(); });
    const project = store.project;
    const assetsSnap = JSON.parse(JSON.stringify(project?.assets ?? {}));
    const clipsSnap = JSON.parse(JSON.stringify(clips()));
    const metaSnap = JSON.parse(JSON.stringify(meta()));
    const guard = () => {
      if (store.project !== project) throw Object.assign(new Error('项目已切换，导出已中止'), { name: 'AbortError' });
      if (ac.signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    };
    // 只取快照项目素材：切项目后立即中止，绝不读到新项目同名素材
    const blobOfSnap = async id => {
      guard();
      if (!assetsSnap[id]) throw new Error(`素材 ${id} 不属于导出时的项目快照`);
      return blobOf(id);
    };
    const task = (async () => {
      try {
        const job = buildRenderJob({ project: { name: project?.name, assets: assetsSnap }, clips: clipsSnap, meta: metaSnap, format: 'mp4' });
        if (!job.duration) throw new Error('时间线为空，无内容可导出');

        // 缺失/不支持素材预检：默认阻断导出，必须显式确认省略
        // （options.silent 测试/无头路径用 omitMissing:true 声明知情省略；UI 路径弹窗确认）
        let allowMissing = options.omitMissing === true;
        if (job.omitted?.length && !allowMissing) {
          const names = job.omitted.map(o => `「${o.clip}」${o.reason === 'missing' ? '素材缺失' : '类型不支持'}`).join('、');
          if (options.silent || typeof document === 'undefined')
            throw new Error(`时间线有 ${job.omitted.length} 个片段无法渲染：${names}。确认省略请显式传 omitMissing:true`);
          const ok = await confirmDialog('导出将省略部分片段', el('div', {},
            el('p', { text: '以下片段因素材缺失或类型不受支持，不会出现在成片里：' }),
            el('ul', {}, job.omitted.map(o => el('li', { text: `${o.clip} — ${o.reason === 'missing' ? '素材缺失' : '类型不支持渲染'}` }))),
            el('p', { class: 'hint', text: '「确认」＝省略这些片段继续导出；「取消」＝返回修复素材。' })));
          guard();   // 弹窗等待期间切项目/取消 → 不再开始渲染
          if (!ok) throw new Error('导出已取消（存在缺失素材片段）');
          allowMissing = true;
        }

        const run = async progress => {
          guard();   // 起步前再核验：预检/确认等待期间的取消与切项目不发请求、不取媒体
          const viaWanted = options.via ?? 'auto';
          let via = 'browser';
          if (viaWanted !== 'browser') {
            // 明确选本机渲染时给冷启动工具探测足够时间；自动模式仍快速回退。
            const capsTimeout = viaWanted === 'server' ? 10000 : 1500;
            const capsSignal = typeof AbortSignal !== 'undefined' && AbortSignal.any && AbortSignal.timeout
              ? AbortSignal.any([ac.signal, AbortSignal.timeout(capsTimeout)])
              : (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(capsTimeout) : ac.signal);
            const caps = await serverCaps(capsSignal);
            guard();   // 探测期间切项目/取消 → 不使用结果、不进入打包
            if (caps) via = 'server';
            else if (viaWanted === 'server') throw new Error(feature('serverRender') ? '本机渲染服务不可用（未接入 /media 或 FFmpeg 缺失）' : '托管网页版不提供服务器渲染（MP4）；请使用浏览器导出');
          }
          if (via === 'server') {
            progress({ phase: 'package', ratio: 0.02 });
            const post = async allowText => {
              const pkg = await buildRenderPackage(allowText ? { ...job, allowTextFallback: true } : job, blobOfSnap);
              guard();   // 打包期间切项目/取消 → 不发 POST
              progress({ phase: 'render', ratio: 0.05 });
              const r = await fetch('/media/render', { method: 'POST', body: new Blob([pkg], { type: 'application/zip' }), signal: ac.signal });
              guard();
              return r;
            };
            let res = await post(false);
            if (!res.ok) {
              let msg = `渲染服务错误 ${res.status}`, code = '';
              try { const j = await res.json(); msg = j?.error?.message ?? msg; code = j?.error?.code ?? ''; } catch {}
              if (code !== 'text_unsupported') throw new Error(msg);
              // 服务端拒绝静默省略文字/字幕：只有显式批准才带 allowTextFallback 降级重试一次
              let approved = options.allowTextFallback === true;
              if (!approved && !options.silent && typeof document !== 'undefined') {
                approved = await confirmDialog('本机渲染无法烧录文字/字幕', el('div', {},
                  el('p', { text: msg }),
                  el('p', { class: 'hint', text: '「确认」＝省略叠加文字与字幕继续导出（字幕仍可单独导出 SRT）；「取消」＝中止导出，可改用浏览器导出。' })));
                guard();
              }
              if (!approved) throw new Error(msg);
              res = await post(true);
            }
            if (!res.ok) {
              let msg = `渲染服务错误 ${res.status}`;
              try { msg = (await res.json())?.error?.message ?? msg; } catch {}
              throw new Error(msg);
            }
            const blob = await res.blob();
            guard();
            if (blob.type !== 'video/mp4' || !blob.size) throw new Error('渲染服务返回内容不是有效 MP4');
            const warnings = parseRenderWarnings(res);
            progress({ phase: 'done', ratio: 1 });
            return { blob, mime: 'video/mp4', ext: 'mp4', seconds: job.duration, via: 'server', warnings };
          }
          const support = probeRenderSupport();
          const want = options.format === 'mp4' ? support.mp4 : options.format === 'webm' ? support.webm : (support.webm ?? support.mp4);
          if (!want) throw new Error('当前浏览器不支持 MediaRecorder 导出（可改用本机渲染服务）');
          const engine = createTimelineEngine({ blobOf: blobOfSnap });
          try {
          const r = await engine.render({
            clips: clipsSnap, meta: metaSnap, mime: want, signal: ac.signal, allowMissing,
            omitClipIds: (job.omitted ?? []).map(o => o.id).filter(Boolean),
            onProgress: p => progress({ phase: 'render', ratio: p.ratio }),
          });
            guard();   // 渲染期间切项目：结果作废，不交给调用方
            progress({ phase: 'done', ratio: 1 });
            return r;
          } finally { engine.dispose(); }
        };

        if (options.silent) return await run(options.onProgress ?? (() => {}));
        return await renderWithModal(run, ac, job, project);
      } finally {
        unsub?.();
        options.signal?.removeEventListener?.('abort', onAbort);
        if (renderBusy === ticket) renderBusy = null;
      }
    })();
    task.catch(() => {});   // 票据不消费拒绝；同一 promise 仍返回给调用方
    return task;
  }

  // UI 托管导出：进度弹窗 + 取消；完成后给「下载/存入素材库」动作。
  // project 为导出启动时的项目身份：入库只写回该项目，切换后一律拒绝（registerBlob 内部亦有守卫）。
  function renderWithModal(run, ac, job, project) {
    return new Promise((resolve, reject) => {
      const bar = el('progress', { max: 100, value: 0 });
      const noteEl = el('p', { class: 'hint', text: '准备中…' });
      const cancel = el('button', { type: 'button', class: 'danger', text: '取消导出' });
      const { close } = modal(el('div', {},
        el('h3', { text: '导出视频' }),
        el('div', { class: 'modal-body' },
          el('p', { class: 'hint', text: `输出 ${job.output.width}×${job.output.height} @${job.output.fps}fps · 时长 ${fmtT(job.duration)}` }),
          bar, noteEl),
        el('div', { class: 'modal-actions' }, cancel)),
        { onClose: () => { ac.abort(); } });
      cancel.addEventListener('click', () => ac.abort());
      run(p => {
        bar.value = Math.round((p.ratio ?? 0) * 100);
        noteEl.textContent = p.phase === 'render' ? `渲染中 ${fmtT(p.t ?? 0)} / ${fmtT(job.duration)}（实时导出）`
          : p.phase === 'package' ? '打包媒体中…' : p.phase === 'done' ? '完成' : '准备中…';
      }).then(r => {
        close();
        const ext = r.ext ?? 'webm';
        const name = `${project?.name ?? '时间线'}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;
        const dl = el('button', { class: 'primary', type: 'button', text: `下载 ${name}` });
        const save = el('button', { type: 'button', text: '存入素材库' });
        const pvUrl = URL.createObjectURL(r.blob);
        const m2 = modal(el('div', {},
          el('h3', { text: `导出完成（${ext.toUpperCase()}${r.via === 'server' ? ' · 本机服务' : ' · 浏览器' }${r.warnings?.length ? ' · 有省略项' : ''}）` }),
          el('div', { class: 'modal-body' },
            el('video', { src: pvUrl, controls: true, style: 'width:100%;border-radius:8px;background:#000' }),
            el('p', { class: 'hint', text: `${fmtT(r.seconds)} · ${(r.blob.size / 1048576).toFixed(1)} MB` }),
            ...(r.warnings?.length ? [el('p', { class: 'hint', text: `提示：${r.warnings.join('；')}` })] : [])),
          el('div', { class: 'modal-actions' }, save, dl)), { onClose: () => URL.revokeObjectURL(pvUrl) });
        dl.addEventListener('click', () => downloadBlob(name, r.blob));
        save.addEventListener('click', async () => {
          try {
            if (store.project !== project) { note('项目已切换，成片未入库', 'warn'); return; }
            const a = await assets?.registerBlob?.(r.blob, name, 'video');
            if (store.project !== project) { note('项目已切换，成片未入库', 'warn'); return; }
            if (a) { note('已存入素材库', 'ok'); m2.close(); }
            else note('素材库接口不可用', 'err');
          } catch (e) { note(`入库失败：${e.message}`, 'err'); }
        });
        resolve(r);
      }).catch(e => {
        close();
        if (e?.name === 'AbortError' || e?.message === '已取消') { note(e?.message && e.message !== '已取消' ? e.message : '导出已取消', 'warn'); reject(e); }
        else { note(`导出失败：${e.message}`, 'err', 6000); reject(e); }
      });
    });
  }

  // ---------- UI ----------

  let session = null;

  // 视图样式集中在 timeline-ui.css（由 module-ui.css 聚合、index.html 引入）；
  // 本文件只保留 DOM 结构与行为，不再注入 <style>。

  function open() {
    if (typeof document === 'undefined') return null;
    if (session) return session.handle;
    tidy({ silent: false });

    const engine = createTimelineEngine({ blobOf });
    const S = {
      sel: null, playhead: 0, playing: false, raf: 0, playT0: 0, playBase: 0,
      zoom: 40, engine, unsub: null, closed: false,
    };
    session = S;

    // TL-4：拖动/修剪挂在 window 的监听统一登记——松手自回收；会话关闭/切项目时
    // disposeSession 兜底回收，且 move/up 落地前再核「会话仍活 + 项目未换」，
    // 杜绝松手写进新项目/制造幽灵撤销步。
    const projectAtOpen = store.project;
    const drags = new Set();
    function bindDrag({ onMove, onUp }) {
      if (S.closed) return;
      const move = ev => { if (!S.closed && store.project === projectAtOpen) onMove(ev); };
      const up = () => {
        unbind();
        if (S.closed || session !== S || store.project !== projectAtOpen) return;
        onUp();
      };
      function unbind() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        drags.delete(rec);
      }
      const rec = { unbind };
      drags.add(rec);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    // 修剪落库前守卫：媒体片段源长未知时先探测；仍探不到就只允许缩短，
    // 禁止把边缘拉过未知源长（防止导出截断/末帧定格成用户不预期的结果）。
    async function trimGuarded(c, edge, v) {
      if (['video', 'audio'].includes(c.kind) && c.assetId && !Number.isFinite(c.sourceDuration)) {
        const info = await probeAsset(c.assetId).catch(() => null);
        if (S.closed || session !== S || store.project !== projectAtOpen) return;
        if (info?.duration) c.sourceDuration = info.duration;
        else if ((edge === 'end' && v > c.end) || (edge === 'start' && v < c.start && (c.in ?? 0) <= 0)) {
          note('素材源时长未知且探测失败，已阻止拉长片段（可在素材库确认文件后重试）', 'warn', 5000);
          return;
        }
      }
      mutate(cs => trimClipEdge(cs, c.id, edge, v));
    }

    // --- DOM ---
    const canvas = el('canvas', { class: 'tl-canvas', width: meta().width, height: meta().height });
    const g2d = canvas.getContext('2d');
    const timeEl = el('span', { class: 'tl-time mono' });
    const backBtn = el('button', { type: 'button', class: 'mini', text: '回到开头', title: '回到开头' });
    const playBtn = el('button', { type: 'button', class: 'mini', text: '▶ 播放' });
    const scrub = el('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'tl-scrub' });
    const splitBtn = el('button', { type: 'button', class: 'mini', text: '✂ 在播放头分割', title: '在播放头位置分割当前选中的片段' });
    const lanesBox = el('div', { class: 'tl-lanes' });
    const inspector = el('div', { class: 'tl-inspector' });
    const countEl = el('span', { class: 'tl-count' });
    const sizeSel = el('select', { class: 'tl-size' },
      TL_SIZES.map(s => el('option', { value: s.id, text: s.label, selected: s.width === meta().width && s.height === meta().height })));
    const zoomSel = el('select', { class: 'tl-zoom' },
      [[20, '缩放 50%'], [40, '缩放 100%'], [80, '缩放 200%']].map(([v, t]) => el('option', { value: v, text: t, selected: v === S.zoom })));
    const undoBtn = el('button', { type: 'button', class: 'mini', text: '↶ 撤销' });
    const redoBtn = el('button', { type: 'button', class: 'mini', text: '↷ 重做' });

    // 顶栏分组：标题+片段统计 ｜ 输出/缩放/撤销重做/导出（右）；「添加」低频动作独立一行
    const box = el('div', { class: 'tl-root' },
      el('div', { class: 'tl-toolbar' },
        el('div', { class: 'tl-head' },
          el('div', { class: 'tl-head-l' },
            el('b', { class: 'tl-title', text: '时间线剪辑' }),
            countEl),
          el('div', { class: 'tl-head-r' },
            sizeSel, zoomSel,
            el('span', { class: 'tl-sep' }),
            undoBtn, redoBtn,
            el('span', { class: 'tl-sep' }),
            exportMenu())),
        el('div', { class: 'tl-tools' },
          el('span', { class: 'tl-tools-label', text: '添加到轨道' }),
          toolbarButton('＋片段', pickAssetForLane.bind(null, 'v1')),
          toolbarButton('＋叠加', pickOverlay),
          toolbarButton('＋音频', pickAudio),
          toolbarButton('＋文字', addTextOverlay),
          toolbarButton('＋字幕', addSubtitle),
          el('span', { class: 'tl-sep' }),
          toolbarButton('导入SRT', importSRT),
          toolbarButton('分镜入轨', insertFromShots, '按分镜顺序把各镜头成片追加到视频轨轨尾（先预览后确认）'))),
      el('div', { class: 'tl-preview' },
        el('div', { class: 'tl-canvas-wrap' }, canvas),
        el('div', { class: 'tl-transport' }, backBtn, playBtn, timeEl, scrub, splitBtn)),
      lanesBox, inspector);
    const handle = modal(box, { wide: true, onClose: disposeSession });
    S.handle = handle;

    function toolbarButton(text, fn, title) { const b = el('button', { type: 'button', class: 'mini', text, title }); b.addEventListener('click', fn); return b; }
    // 导出前说明可用路线、格式与限制，由用户选择后才开始（托管版只有浏览器路线）
    async function exportVideoDialog() {
      const sup = probeRenderSupport();
      const serverOk = feature('serverRender') ? Boolean(await serverCaps(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined)) : false;
      const meta = { ...(studioState(store.project).timelineMeta ?? {}) };
      const dur = Math.max(0, ...clips().map(c => c.end));
      const fmt = [sup.webm && 'WebM（VP9/Opus）', sup.mp4 && 'MP4（H.264/AAC）'].filter(Boolean).join('、') || '无（浏览器不支持 MediaRecorder）';
      const rows = [
        ['浏览器导出', sup.supported ? `可用：${fmt}；按时间线实时录制，约需 ${Math.ceil(dur)} 秒，期间请保持本页在前台` : '不可用：当前浏览器不支持 canvas 录制'],
        ['服务器渲染（MP4）', feature('serverRender') ? (serverOk ? '可用：本机 FFmpeg 服务' : '不可用：未检测到本机渲染服务') : '托管网页版不提供（没有隔离的服务器渲染服务）'],
        ['输出', `${meta.width ?? '?'}×${meta.height ?? '?'}，${meta.fps ?? 30} fps，时长 ${dur.toFixed(1)} 秒`],
        ['限制', `时间线最长 ${TL_LIMITS.maxDuration} 秒；单帧不超过 1920×1920 像素；缺失素材的片段默认阻止导出`],
      ];
      const table = el('table', { class: 'tl-export-info' }, ...rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: v }))));
      const acts = el('div', { class: 'modal-actions' });
      const m = modal(el('div', {}, el('h3', { text: '导出视频' }), table, acts));
      const go = via => { m.close?.(); renderExport({ via }).catch(e => { if (e?.name !== 'AbortError' && e?.message) note(e.message, 'err', 5000); }); };
      const b1 = el('button', { type: 'button', class: 'primary', text: '用浏览器导出', disabled: !sup.supported || !dur });
      b1.addEventListener('click', () => go('browser'));
      acts.append(b1);
      if (serverOk) { const b2 = el('button', { type: 'button', text: '用本机服务导出 MP4', disabled: !dur }); b2.addEventListener('click', () => go('server')); acts.append(b2); }
    }
    function exportMenu() {
      const wrap = el('span', { class: 'tl-export' });
      const btn = el('button', { type: 'button', class: 'mini primary', text: '导出 ▾' });
      const menu = el('div', { class: 'tl-menu', style: 'display:none' });
      const item = (text, fn, title) => { const b = el('button', { type: 'button', class: 'mini', text, title }); b.addEventListener('click', () => { menu.style.display = 'none'; fn(); }); return b; };
      menu.append(
        item(isHosted() ? '导出视频（浏览器）…' : '导出视频（浏览器/本机服务）…', () => exportVideoDialog().catch(e => note(e?.message ?? '无法打开导出选项', 'err', 5000)), '先查看可用格式与限制，再开始导出'),
        item('导出 SRT 字幕', exportSRT),
        item('导出 EDL（CMX3600 子集）', exportEDL, '仅剪辑结构：V/AA 事件 + 出入点 + 片段名；不含转场/变速'),
        item('导出 OTIO（JSON 子集 v1）', exportOTIO, 'Timeline/Track/Clip + 媒体引用；Premiere/剪映草稿格式未实现'),
        item('导出项目包（含媒体 zip）', exportPackage, 'xp-package@1：manifest + project.json + 媒体文件；无密钥'),
        item('导入项目包', importPackage, '恢复为新项目，保留分镜、场景和素材；缺失文件会明确标记'),
      );
      // 点菜单外任意处收起（不替代按钮切换/点项关闭，仅补齐易可达性）
      const onDocDown = e => { if (!wrap.contains(e.target)) menu.style.display = 'none'; };
      document.addEventListener('pointerdown', onDocDown, true);
      drags.add({ unbind: () => document.removeEventListener('pointerdown', onDocDown, true) });
      btn.addEventListener('click', () => { menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; });
      wrap.append(btn, menu);
      return wrap;
    }

    // --- 播放 ---
    const dur = () => timelineDuration(clips());
    function drawAt(t) { engine.draw(g2d, t, clips(), meta()); }
    // 播放头游标随 seek/play 同步（各轨与刻度尺上的 .tl-playhead 都是纯视图元素）
    function syncPlayheadEls() {
      const x = `${S.playhead * pps()}px`;
      lanesBox.querySelectorAll('.tl-playhead').forEach(n => { n.style.left = x; });
    }
    function setPlayhead(t) {
      S.playhead = Math.max(0, Math.min(t, dur()));
      scrub.value = String(Math.round((dur() ? S.playhead / dur() : 0) * 1000));
      timeEl.textContent = `${fmtT(S.playhead)} / ${fmtT(dur())}`;
      syncPlayheadEls();
      engine.sync(S.playhead, clips(), false);
      drawAt(S.playhead);
    }
    function stopLoop() { cancelAnimationFrame(S.raf); S.raf = 0; }
    function pause() {
      stopLoop();
      S.playing = false; playBtn.textContent = '▶ 播放';
      engine.pauseAll();
      drawAt(S.playhead);
    }
    function play() {
      if (S.playing) return pause();
      if (S.playhead >= dur() - 0.02) S.playhead = 0;
      S.playing = true; playBtn.textContent = '⏸ 暂停';
      engine.audioContext?.resume?.().catch(() => {});
      S.playT0 = performance.now(); S.playBase = S.playhead;
      const step = () => {
        if (S.closed) return;
        const t = S.playBase + (performance.now() - S.playT0) / 1000;
        if (t >= dur()) { setPlayhead(dur()); pause(); return; }
        S.playhead = t;
        scrub.value = String(Math.round((dur() ? t / dur() : 0) * 1000));
        timeEl.textContent = `${fmtT(t)} / ${fmtT(dur())}`;
        syncPlayheadEls();
        engine.sync(t, clips(), true);
        drawAt(t);
        S.raf = requestAnimationFrame(step);
      };
      step();
    }
    backBtn.addEventListener('click', () => { pause(); setPlayhead(0); });
    playBtn.addEventListener('click', play);
    scrub.addEventListener('input', () => { pause(); setPlayhead(dur() * Number(scrub.value) / 1000); });
    sizeSel.addEventListener('change', () => {
      const s = TL_SIZES.find(x => x.id === sizeSel.value); if (!s) return;
      mutate(() => { meta().width = s.width; meta().height = s.height; });
      canvas.width = s.width; canvas.height = s.height;
      drawAt(S.playhead);
    });
    zoomSel.addEventListener('change', () => { S.zoom = Number(zoomSel.value); renderLanes(); });
    undoBtn.addEventListener('click', () => { pause(); if (editor?.undo()) { tidy(); refresh(); note('已撤销', 'ok'); } });
    redoBtn.addEventListener('click', () => { pause(); if (editor?.redo()) { tidy(); refresh(); note('已重做', 'ok'); } });
    splitBtn.addEventListener('click', () => {
      if (!S.sel) { note('先选中一个片段', 'warn'); return; }
      const c = clips().find(x => x.id === S.sel);
      if (!c) return;
      if (!(S.playhead > c.start + TL_LIMITS.minLen && S.playhead < c.end - TL_LIMITS.minLen)) { note('播放头不在选中片段内', 'warn'); return; }
      mutate(cs => splitClipAt(cs, c.id, S.playhead));
      note('已分割', 'ok');
    });

    // --- 轨道渲染 ---
    const pps = () => S.zoom;
    function renderLanes() {
      const D = dur();
      const minW = `${Math.max(600, (D + 6) * pps())}px`;
      const lanes = TL_TRACKS.map(t => {
        const strip = el('div', { class: 'tl-strip', 'data-track': t.id });
        strip.style.minWidth = minW;
        strip.style.backgroundSize = `${pps()}px 100%`;
        for (const c of laneClips(clips(), t.id)) strip.append(clipBlock(c, t));
        // 播放头游标
        const ph = el('div', { class: 'tl-playhead' });
        ph.style.left = `${S.playhead * pps()}px`;
        strip.append(ph);
        strip.addEventListener('pointerdown', e => {
          if (e.target === strip) { const r = strip.getBoundingClientRect(); pause(); setPlayhead((e.clientX - r.left) / pps()); }
        });
        const hint = LANE_HINTS[t.id];
        return el('div', { class: 'tl-lane' },
          el('div', { class: 'tl-lane-label', text: t.label, title: hint || null }), strip);
      });
      // 顶部刻度尺：与轨道同一横向滚动容器、同一 pps 缩放；点击定位播放头（纯视图）
      const rulerStrip = el('div', { class: 'tl-ruler' });
      rulerStrip.style.minWidth = minW;
      const step = TICK_STEPS.find(s => s * pps() >= 64) ?? 300;
      const tEnd = Math.max(D + 6, 600 / pps());
      for (let t = 0; t <= tEnd + 1e-6; t += step) {
        rulerStrip.append(el('span', { class: 'tl-tick', text: fmtT(t), style: `left:${(t * pps()).toFixed(1)}px` }));
      }
      const rph = el('div', { class: 'tl-playhead' });
      rph.style.left = `${S.playhead * pps()}px`;
      rulerStrip.append(rph);
      rulerStrip.addEventListener('pointerdown', e => {
        const r = rulerStrip.getBoundingClientRect(); pause(); setPlayhead((e.clientX - r.left) / pps());
      });
      const ruler = el('div', { class: 'tl-ruler-row' },
        el('div', { class: 'tl-ruler-corner' }, el('small', { text: '时间' })), rulerStrip);
      lanesBox.replaceChildren(ruler, ...lanes);
      // 空态：空轨仍在原位，其上叠加一条主引导（pointer-events 只放卡片，不挡轨道）
      if (!clips().length) {
        const go = el('button', { type: 'button', class: 'mini primary', text: '＋ 添加片段' });
        go.addEventListener('click', () => pickAssetForLane('v1'));
        lanesBox.append(el('div', { class: 'tl-empty' },
          el('div', { class: 'tl-empty-card' },
            el('b', { text: '时间线还没有片段' }),
            el('p', { class: 'hint', text: '从素材库把视频/图片放进视频轨、音频放进音轨，或用上方「添加到轨道」一行加文字与字幕。' }),
            go)));
      }
      // 标题旁片段统计（含缺失数警示），随每次重铺刷新
      const miss = clips().filter(c => c.missing).length;
      countEl.textContent = `${clips().length} 个片段 · 全长 ${fmtT(D)}${miss ? ` · ${miss} 缺失` : ''}`;
      countEl.classList.toggle('warn', miss > 0);
    }
    function clipBlock(c, t) {
      const len = clipVisualLen(c);
      const b = el('div', {
        class: `tl-clip k-${c.kind}${c.id === S.sel ? ' sel' : ''}${c.missing ? ' missing' : ''}`,
        'data-clip': c.id, title: `${c.name || c.text?.slice(0, 20) || c.kind} · ${fmtT(c.start)}→${fmtT(c.end)}`,
      });
      b.style.left = `${c.start * pps()}px`;
      b.style.width = `${Math.max(14, len * pps())}px`;
      const label = c.kind === 'subtitle' || c.kind === 'text' ? (c.text || '').split('\n')[0] : c.name || c.kind;
      b.append(
        el('div', { class: 'tl-clip-edge l' }),
        el('span', { class: 'tl-clip-name', text: `${c.muted && c.kind !== 'text' && c.kind !== 'subtitle' ? '🔇 ' : ''}${c.missing ? '⚠ ' : ''}${label || '片段'} ${len.toFixed(1)}s` }),
        el('div', { class: 'tl-clip-edge r' }));
      // 选中
      b.addEventListener('pointerdown', e => { e.stopPropagation(); select(c.id); });
      // 边缘修剪
      b.querySelector('.tl-clip-edge.l').addEventListener('pointerdown', e => startTrim(e, c, 'start'));
      b.querySelector('.tl-clip-edge.r').addEventListener('pointerdown', e => startTrim(e, c, 'end'));
      // 拖动整段：拖动中只移动 DOM，不碰数据；松手时一次 mutate（checkpoint 在改动前）。
      // 全局监听走 bindDrag：关会话/切项目后松手不写（TL-4）
      b.addEventListener('pointerdown', e => {
        if (e.target.classList.contains('tl-clip-edge')) return;
        let cand = c.start, moved = false;
        const x0 = e.clientX, s0 = c.start;
        bindDrag({
          onMove: ev => {
            cand = Math.max(0, s0 + (ev.clientX - x0) / pps());
            if (Math.abs(cand - s0) > 0.02) moved = true;
            if (moved) b.style.left = `${cand * pps()}px`;
          },
          onUp: () => { if (moved) mutate(cs => moveClip(cs, c.id, cand)); },
        });
      });
      return b;
    }
    function startTrim(e, c, edge) {
      e.stopPropagation(); e.preventDefault();
      select(c.id);
      const x0 = e.clientX;
      const orig = edge === 'start' ? c.start : c.end;
      let cand = orig, moved = false;
      const block = lanesBox.querySelector(`[data-clip="${c.id}"]`);
      bindDrag({
        onMove: ev => {
          cand = Math.max(0, orig + (ev.clientX - x0) / pps());
          moved = true;
          if (block) {
            if (edge === 'start') {
              const s = Math.min(cand, c.end - TL_LIMITS.minLen);
              block.style.left = `${s * pps()}px`;
              block.style.width = `${Math.max(14, (c.end - s) * pps())}px`;
            } else {
              const en = Math.max(cand, c.start + TL_LIMITS.minLen);
              block.style.width = `${Math.max(14, (en - c.start) * pps())}px`;
            }
          }
        },
        onUp: () => { if (moved) trimGuarded(c, edge, cand); },
      });
    }

    // 轻量选中：不重铺轨道（避免拖动/修剪中的元素被替换丢反馈），只换高亮 + 刷新检查器
    function select(id) {
      S.sel = id;
      lanesBox.querySelectorAll('.tl-clip.sel').forEach(n => n.classList.remove('sel'));
      lanesBox.querySelector(`[data-clip="${id}"]`)?.classList.add('sel');
      renderInspector();
    }

    // --- 检查器 ---
    function field(label, input) { return el('div', { class: 'field' }, el('label', { text: label }), input); }
    function numIn(value, { min = 0, max = 999, step = 0.1 } = {}) {
      const i = el('input', { type: 'number', value, min, max, step });
      return i;
    }
    // 检查器分区容器：仅视觉分组，字段数据键与提交逻辑不变
    function sec(label, ...kids) {
      return el('div', { class: 'tl-sec' },
        el('div', { class: 'tl-sec-label', text: label }),
        el('div', { class: 'tl-sec-body' }, ...kids));
    }
    function renderInspector() {
      const c = clips().find(x => x.id === S.sel);
      if (!c) {
        inspector.replaceChildren(el('div', { class: 'tl-ins-empty' },
          el('b', { text: '未选中片段' }),
          el('p', { class: 'hint', text: '点击片段进行编辑：修剪/移动/分割/音量/淡入淡出/位置' })));
        return;
      }
      const rows = [];
      const commitNum = (input, apply) => {
        input.addEventListener('change', () => mutate(() => apply(Number(input.value))));
      };
      rows.push(el('div', { class: 'tl-ins-head' },
        el('h3', { text: `${TL_TRACKS[TL_TRACK_INDEX[c.track]].label} · ${c.name || c.kind}` }),
        el('span', { class: 'chip', text: `${fmtT(c.start)} – ${fmtT(c.end)}` })));
      if (c.missing) rows.push(el('p', { class: 'err-text', text: '素材文件缺失（保留片段占位；重新绑定素材后可渲染）' }));

      const startIn = numIn(c.start), endIn = numIn(c.end);
      startIn.addEventListener('change', () => trimGuarded(c, 'start', Number(startIn.value)));
      endIn.addEventListener('change', () => trimGuarded(c, 'end', Number(endIn.value)));
      const timeKids = [el('div', { class: 'tl-grid2' }, field('开始（秒）', startIn), field('结束（秒）', endIn))];

      if (['video', 'audio'].includes(c.kind)) {
        const inIn = numIn(c.in ?? 0);
        commitNum(inIn, v => { c.in = Math.max(0, v); });
        timeKids.push(field(`入点（源秒${c.sourceDuration ? ` · 源长 ${c.sourceDuration.toFixed(1)}s` : ''}）`, inIn));
      }
      if (c.kind === 'video') {
        const sp = numIn(c.speed ?? 1, { min: TL_LIMITS.minSpeed, max: TL_LIMITS.maxSpeed, step: 0.05 });
        commitNum(sp, v => { c.speed = Math.min(TL_LIMITS.maxSpeed, Math.max(TL_LIMITS.minSpeed, v || 1)); });
        timeKids.push(field('播放速度 ×', sp));
      }
      rows.push(sec('时间', ...timeKids));
      if (['video', 'audio'].includes(c.kind)) {
        const vol = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: c.volume ?? 1 });
        vol.addEventListener('change', () => mutate(() => { c.volume = Number(vol.value); }));
        const mute = el('input', { type: 'checkbox' }); mute.checked = c.muted === true;
        mute.addEventListener('change', () => mutate(() => { c.muted = mute.checked; }));
        const fi = numIn(c.fadeIn ?? 0, { max: 30 }), fo = numIn(c.fadeOut ?? 0, { max: 30 });
        commitNum(fi, v => { c.fadeIn = Math.max(0, v); });
        commitNum(fo, v => { c.fadeOut = Math.max(0, v); });
        rows.push(sec('声音',
          field('音量', vol),
          el('div', { class: 'check' }, mute, el('span', { text: '静音' })),
          el('div', { class: 'tl-grid2' }, field('淡入（秒）', fi), field('淡出（秒）', fo))));
      }
      if (c.kind === 'text') {
        const ta = el('textarea', { value: c.text ?? '' });
        ta.addEventListener('change', () => mutate(() => { c.text = ta.value.slice(0, TL_LIMITS.maxText); }));
        const pos = ['x', 'y', 'w', 'h'].map(k => {
          const i = numIn(c[k] ?? 0, { min: 0, max: 1, step: 0.01 });
          commitNum(i, v => { c[k] = Math.min(1, Math.max(0, v)); });
          return field(k.toUpperCase(), i);
        });
        const fs = numIn(c.fontSize ?? 0.06, { min: 0.02, max: 0.3, step: 0.01 });
        commitNum(fs, v => { c.fontSize = v; });
        const col = el('input', { type: 'color', value: c.color ?? '#ffffff' });
        col.addEventListener('change', () => mutate(() => { c.color = col.value; }));
        const al = el('select', {}, ['left', 'center', 'right'].map(a => el('option', { value: a, text: { left: '左', center: '中', right: '右' }[a], selected: a === c.align })));
        al.addEventListener('change', () => mutate(() => { c.align = al.value; }));
        rows.push(sec('文字与位置',
          field('文字内容', ta),
          el('div', { class: 'tl-grid4' }, ...pos),
          el('div', { class: 'tl-grid2' }, field('字号（画面比例）', fs), field('对齐', al)),
          field('颜色', col)));
      }
      if (c.kind === 'subtitle') {
        const ta = el('textarea', { value: c.text ?? '' });
        ta.addEventListener('change', () => mutate(() => { c.text = ta.value.slice(0, TL_LIMITS.maxText); c.subtitle = c.text; }));
        rows.push(sec('字幕', field('字幕文本', ta)));
      }
      if (c.kind === 'image') {
        const pos = ['x', 'y', 'w', 'h'].map(k => {
          const i = numIn(c[k] ?? 0, { min: 0, max: 1, step: 0.01 });
          commitNum(i, v => { c[k] = Math.min(1, Math.max(0, v)); });
          return field(k.toUpperCase(), i);
        });
        if (c.track === 'ov1') rows.push(sec('位置与大小', el('div', { class: 'tl-grid4' }, ...pos)));
      }
      const act = el('div', { class: 'modal-actions tl-ins-actions' });
      const back = el('button', { class: 'mini', type: 'button', text: '前移' });
      const fwd = el('button', { class: 'mini', type: 'button', text: '后移' });
      const del = el('button', { class: 'mini danger', type: 'button', text: '删除片段' });
      back.addEventListener('click', () => mutate(cs => reorderClip(cs, c.id, -1)));
      fwd.addEventListener('click', () => mutate(cs => reorderClip(cs, c.id, +1)));
      del.addEventListener('click', async () => {
        if (await confirmDialog('删除片段', `删除「${c.name || c.text?.slice(0, 12) || c.kind}」？可用撤销恢复。`))
          mutate(cs => { const i = cs.findIndex(x => x.id === c.id); if (i >= 0) cs.splice(i, 1); });
      });
      act.append(back, fwd, del);
      rows.push(act);
      inspector.replaceChildren(...rows);
    }

    // --- 素材选择器 ---
    function assetPicker(title, filter, onPick) {
      const items = Object.values(store.project?.assets ?? {}).filter(filter);
      const grid = el('div', { class: 'picker-grid' });
      if (!items.length) grid.append(el('p', { class: 'hint', text: '素材库中没有可用素材' }));
      const m = modal(el('div', {}, el('h3', { text: title }), el('div', { class: 'modal-body' }, grid)));
      for (const a of items) {
        const it = el('div', { class: `picker-item${a.missing ? ' missing' : ''}` },
          el('b', { text: a.name }),
          el('div', { class: 'hint', text: `${KIND_LABEL[a.kind] ?? a.kind}${a.missing ? ' · 缺文件' : ''}` }));
        it.addEventListener('click', () => { m.close(); onPick(a); });
        grid.append(it);
      }
    }
    function pickAssetForLane(lane) {
      assetPicker('添加片段到视频轨', a => ['video', 'image'].includes(a.kind), a => addAsset(a.id, { track: lane }));
    }
    function pickOverlay() {
      assetPicker('添加图片叠加', a => a.kind === 'image', a => addAsset(a.id, { track: 'ov1' }));
    }
    function pickAudio() {
      const items = Object.values(store.project?.assets ?? {}).filter(a => a.kind === 'audio');
      const laneSel = el('select', {}, [['a1', '音乐轨'], ['a2', '配音轨']].map(([v, t]) => el('option', { value: v, text: t })));
      const grid = el('div', { class: 'picker-grid' });
      const m = modal(el('div', {}, el('h3', { text: '添加音频' }), el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', { text: '目标轨' }), laneSel), grid,
        items.length ? null : el('p', { class: 'hint', text: '素材库中没有音频' }))));
      for (const a of items) {
        const it = el('div', { class: `picker-item${a.missing ? ' missing' : ''}` },
          el('b', { text: a.name }), el('div', { class: 'hint', text: a.missing ? '缺文件' : '音频' }));
        it.addEventListener('click', () => { m.close(); addAsset(a.id, { track: laneSel.value }); });
        grid.append(it);
      }
    }
    function addTextOverlay() {
      mutate(cs => cs.push(newTextClip('ov1', { start: Math.min(S.playhead, Math.max(0, dur() - 3)) })));
    }
    function addSubtitle() {
      const start = Math.min(S.playhead, Math.max(0, dur() || 0));
      mutate(cs => cs.push(newSubtitleClip({ start, end: start + 2, text: '新字幕' })));
    }

    // --- SRT / EDL / OTIO / 项目包 ---
    function exportSRT() {
      const subs = subtitlesOf(clips());
      if (!subs.length) { note('没有字幕可导出', 'warn'); return; }
      downloadBlob(`${store.project?.name ?? 'timeline'}.srt`, new Blob([toSRT(subs)], { type: 'text/plain;charset=utf-8' }));
      note(`已导出 ${subs.length} 条字幕`, 'ok');
    }
    function importSRT() {
      const inp = el('input', { type: 'file', accept: '.srt,text/plain' });
      inp.addEventListener('change', async () => {
        try {
          const { entries, warnings } = parseSRT(await inp.files[0].text());
          for (const w of warnings.slice(0, 3)) note(w, 'warn');
          mutate(cs => { for (const e of entries) cs.push(newSubtitleClip(e)); });
          note(`已导入 ${entries.length} 条字幕`, 'ok');
        } catch (e) { note(`SRT 导入失败：${e.message}`, 'err', 5000); }
      });
      inp.click();
    }
    function exportEDL() {
      const text = toEDL(clips(), { title: store.project?.name ?? 'TIMELINE', fps: meta().fps, assets: store.project?.assets ?? {} });
      downloadBlob(`${store.project?.name ?? 'timeline'}.edl`, new Blob([text], { type: 'text/plain;charset=utf-8' }));
      note('已导出 EDL（CMX3600 子集：V/AA 事件 + 出入点）', 'ok', 5000);
    }
    function exportOTIO() {
      const obj = toOTIO(store.project, clips(), meta());
      downloadBlob(`${store.project?.name ?? 'timeline'}.otio`, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
      note('已导出 OTIO JSON 子集（仅剪辑结构+媒体引用）', 'ok', 5000);
    }
    async function exportPackage() {
      try {
        const skipped = Object.values(store.project?.assets ?? {}).filter(a => a.missing || !PACKAGE_MIME_EXT[a.mime]);
        const projectJson = await store.exportJSON();
        const u8 = await buildProjectPackage({
          projectJson, clips: clips(), meta: meta(), blobOf, assets: store.project?.assets ?? {},
        });
        downloadBlob(`${store.project?.name ?? 'project'}-项目包.zip`, new Blob([u8], { type: 'application/zip' }));
        note(`项目包已导出，包含工程和素材${skipped.length ? `；${skipped.length} 项缺失或不支持的素材未打包：${skipped.slice(0, 4).map(a => a.name).join('、')}` : ''}`, skipped.length ? 'warn' : 'ok', 6000);
      } catch (e) { note(`项目包导出失败：${e.message}`, 'err', 6000); }
    }
    function importPackage() {
      const inp = el('input', { type: 'file', accept: '.zip,application/zip' });
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; if (!f) return;
        if (!await confirmDialog('导入项目包', '将创建一个新项目并重建素材与时间线。当前项目不受影响。继续？')) return;
        try {
          const r = await importProjectPackage(deps, new Uint8Array(await f.arrayBuffer()));
          note(`导入完成：${r.project.name}（随包媒体 ${r.rebound} 个${r.missing.length ? `，仍缺失 ${r.missing.length}` : ''}）`, 'ok', 6000);
          for (const w of (r.warnings ?? []).slice(0, 3)) note(w, 'warn', 7000);
          disposeSession(); handle.close();
          deps.onUpdate?.();
        } catch (e) { note(`项目包导入失败：${e.message}`, 'err', 6000); }
      });
      inp.click();
    }

    // --- 会话生命周期 ---
    async function refreshMedia() { await engine.load(clips()); drawAt(S.playhead); }
    function refresh() { renderLanes(); renderInspector(); setPlayhead(S.playhead); refreshMedia(); }
    function disposeSession() {
      if (S.closed) return;
      S.closed = true;
      for (const d of [...drags]) d.unbind();   // 拖动中关会话：回收 window 级 pointer 监听
      stopLoop(); engine.dispose();
      S.unsub?.();
      session = null;
    }
    S.refresh = refresh;
    S.dispose = disposeSession;
    S.unsub = store.onChange(reason => {
      if (reason?.type === 'project') { disposeSession(); handle.close(); return; }
      if (S.closed) return;
      renderLanes(); setPlayhead(S.playhead);
    });
    box.addEventListener('keydown', e => {
      if (S.closed) return;
      if (e.target.matches('input, textarea, select')) return;
      if (e.code === 'Space') { e.preventDefault(); play(); }
    });
    box.tabIndex = -1;
    refresh();
    return handle;
  }

  return { open, addAsset, renderExport,
    // 分镜成片按序入轨（C3）：storyboards 面板入口可直接调用本组接口共享 plan/判重语义；
    // insertFromShots 提供完整预览→确认流（B 侧按钮挂点直接调它即可）
    previewShotsToTimeline, applyTimelinePlan, insertFromShots,
    // 测试/集成用只读入口
    clips: () => clips(), meta: () => meta(), tidy };
}
