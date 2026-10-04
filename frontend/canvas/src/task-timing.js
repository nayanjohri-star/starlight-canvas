// 生成耗时：只展示能从记录确定的时间，刷新后按持久化时间戳继续，不重新计时。
//  · 进行中：从提交时刻（submittedAt，旧记录回退 createdAt）起算“已等待”；
//  · 已结束：服务端同时给出创建/完成时间 → 精确用时；否则按本机观测区间——
//    结束前最后一次“仍在进行”的观测与首次观测到结束之间足够接近才给“约”，否则给出区间。
import { el } from './ui.js';
import { isSettled } from './task-status.js';

const APPROX_GAP_MS = 20000;

// 服务端时间戳：秒 / 毫秒 / ISO 字符串均可；无法解析返回 null
function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
export function serverTimes(resp) {
  const r = resp && typeof resp === 'object' ? resp : {};
  return {
    createdAt: toMs(r.created_at),
    completedAt: toMs(r.completed_at ?? r.finished_at ?? r.finish_time),
  };
}

// 查询响应合并后调用：记录服务端时间，以及首次观测到结束的时刻与之前最后一次“进行中”观测。
export function noteTaskTiming(rec, resp, { wasSettled, previousObservedAt, now = Date.now() } = {}) {
  const t = serverTimes(resp);
  if (t.createdAt && rec.serverCreatedAt == null) rec.serverCreatedAt = t.createdAt;
  if (t.completedAt && isSettled(rec)) rec.serverCompletedAt = t.completedAt;
  if (!wasSettled && isSettled(rec) && rec.settledObservedAt == null) {
    rec.settledObservedAt = now;
    rec.lastActiveObservedAt = Number.isFinite(previousObservedAt) ? previousObservedAt : null;
  }
  return rec;
}
export const TIMING_FIELDS = ['serverCreatedAt', 'serverCompletedAt', 'settledObservedAt', 'lastActiveObservedAt'];

export function taskStart(rec) {
  if (Number.isFinite(rec?.submittedAt)) return rec.submittedAt;
  return Number.isFinite(rec?.createdAt) ? rec.createdAt : null;
}

// → { running, since } | { exact } | { approx } | { min, max } | null
export function taskTiming(rec) {
  if (!rec) return null;
  const start = taskStart(rec);
  if (!isSettled(rec)) return start ? { running: true, since: start } : null;
  const sc = rec.serverCreatedAt, se = rec.serverCompletedAt;
  if (Number.isFinite(sc) && Number.isFinite(se) && se >= sc) {
    // 与“已等待”同一起点：本机测得的上传与提交时间 + 服务器记录的生成时间（各自同一时钟内相减）
    const submit = Number.isFinite(rec.submittedAt) && Number.isFinite(rec.createdAt) ? Math.max(0, rec.createdAt - rec.submittedAt) : 0;
    return { exact: submit + (se - sc), generation: se - sc, submit };
  }
  if (start && Number.isFinite(rec.settledObservedAt) && rec.settledObservedAt >= start) {
    const max = rec.settledObservedAt - start;
    const min = Number.isFinite(rec.lastActiveObservedAt) ? Math.max(0, Math.min(max, rec.lastActiveObservedAt - start)) : 0;
    return max - min <= APPROX_GAP_MS ? { approx: max } : { min, max };
  }
  return null;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${String(r).padStart(2, '0')}秒`;
  return `${r}秒`;
}

export function timingText(t) {
  if (!t) return '';
  if (t.running) return `已等待 ${fmtDuration(Date.now() - t.since)}`;
  if (t.exact != null) return `用时 ${fmtDuration(t.exact)}`;
  if (t.approx != null) return `用时约 ${fmtDuration(t.approx)}`;
  if (t.max != null) return `用时 ${fmtDuration(t.min)}–${fmtDuration(t.max)}`;
  return '';
}
export function timingTitle(t) {
  if (!t) return '';
  if (t.running) return '从提交时开始计算，刷新页面后继续累计';
  if (t.exact != null) return t.submit ? `从提交到完成：上传与提交 ${fmtDuration(t.submit)} + 服务器生成 ${fmtDuration(t.generation)}` : '按服务器记录的开始与完成时间计算';
  if (t.approx != null) return '按本机查询到完成的时刻估算';
  return '任务在查询间隔或页面关闭期间完成，只能确定这个范围';
}

// 进行中的计时每秒原地刷新文本，不重建节点或检查器（不影响布局与输入焦点）。
let ticker = 0;
function tick() {
  const live = document.querySelectorAll('[data-elapsed-since]');
  if (!live.length) { clearInterval(ticker); ticker = 0; return; }
  for (const span of live) {
    const since = Number(span.dataset.elapsedSince);
    if (Number.isFinite(since)) span.textContent = `${span.dataset.elapsedPrefix ?? '已等待 '}${fmtDuration(Date.now() - since)}`;
  }
}
export function timingElement(t, { prefix = '已等待 ' } = {}) {
  const text = timingText(t);
  if (!text) return null;
  const span = el('span', { class: 'task-elapsed', text, title: timingTitle(t) });
  if (t.running) {
    span.dataset.elapsedSince = String(t.since);
    span.dataset.elapsedPrefix = prefix;
    span.textContent = `${prefix}${fmtDuration(Date.now() - t.since)}`;
    if (!ticker && typeof setInterval === 'function') { ticker = setInterval(tick, 1000); ticker?.unref?.(); }
  }
  return span;
}
