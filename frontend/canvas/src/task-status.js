// 统一任务状态合同（contracts.md §2 冻结 v1）：视频任务记录的单一判定来源。
// 无副作用纯模块：不读写存储/DOM/网络，只解释记录字段。
// gennode.js / workflow.js / main.js 三处共用；禁止再各写 `status === 'completed'` 判断。
//
// 冻结规则：
//  · stage 永不单独判终态；本地暂停、服务器取消、节点脱离、服务器失败分开表达。
//  · 本地已下载可预览（resultBlobId/本地素材）与 canFetchContent（允许再向服务器取）是独立判断。
//  · isSettled 回答「服务器侧是否终结」；needsTracking 回答「本端现在是否还应查询」，
//    paused（含 authFailed 情形）与 detached 在此层排除。
//  · studio-gen.js 的 operation.* 是文本/图片同步操作独立状态机，不并入本模块。

export const TASK_REC_VERSION = 2;   // 本地记录格式版本，≠ 服务器 executor_version
export function isSupportedTaskRecord(rec) {
  const v = rec?.recVersion;
  return v == null || (Number.isSafeInteger(v) && v >= 1 && v <= TASK_REC_VERSION);
}
export const TASK_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'not_found', 'expired']);
const FAIL_TERMINAL = new Set(['failed', 'cancelled', 'not_found', 'expired']);
// v2 特征字段：缺 executorVersion 但带任一这些字段 = 受损 v2 记录，按 v2 门槛处理（裁决 1，不降级 legacy）。
// 只收 v2 专属字段（接入指南正文未出现、仅多渠道 executor 响应携带）；downloadExpiresAt 是指南明示的
// 查询响应通用可选字段（指南 §6：客户端兼容其缺失），legacy 任务也会携带——不得作 v2 标记。
// 导出为只读常量供消费方做字段覆盖校验（如 B/C 侧 sig 指纹漏字段检查）；消费方不得修改。
export const V2_MARK_FIELDS = ['contentReady', 'stage', 'cancelPhase'];

export const STATUS_LABEL = {
  queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消',
  submitting: '提交中', uploading: '上传素材中', uncertain: '提交结果未明', need_key: '需原密钥',
  rejected: '已拒绝', conflict: '幂等冲突', not_found: '任务不存在', expired: '已过期', abandoned: '已放弃跟踪',
  ready: '可下载', delivering: '交付中', paused: '已暂停查询', detached: '已脱离节点', unknown: '未知',
  query_unknown: '查询待核对', save_pending: '本地保存待恢复',
};

// 响应 snake_case → 记录 camelCase 唯一映射入口（doCreate/poll/cancelTask 三处内联映射合并于此）。
// 只映射合同字段；undefined 表示响应未携带，由 merge/调用方决定取舍，绝不补默认值。
export function normalizeTaskResponse(resp) {
  const r = resp && typeof resp === 'object' ? resp : {};
  return {
    status: r.status,
    stage: r.stage,
    executorVersion: r.executor_version,
    contentReady: r.content_ready,
    deliveryStatus: r.delivery_status,
    progress: r.progress,
    error: r.error,
    downloadExpiresAt: r.download_expires_at,
    cancelRequested: r.cancel_requested,
    cancelPhase: r.cancel_phase,
    downloadExpired: r.download_expired,
  };
}

// 响应合并进既有记录，编码单调性（冻结）：
//  · 终态不被迟到的非终态响应回退（completed 任务不被旧 in_progress 响应改回生成中）
//  · contentReady / cancelRequested 粘性真值：一旦 true 不被后续响应回退
//  · download_expired / delivery_status='expired' 只改变远端交付能力，不抹去已确认的生成成功
// 非终态记录照常吸收响应字段；调用方负责写盘。
export function mergeTaskResponse(rec, resp) {
  const cur = normalizeTaskResponse(resp);
  const wasTerminal = isSettled(rec);
  rec.stage = cur.stage ?? rec.stage;
  rec.executorVersion = cur.executorVersion ?? rec.executorVersion;
  if (cur.contentReady === true) rec.contentReady = true;
  else if (cur.contentReady != null && rec.contentReady !== true) rec.contentReady = cur.contentReady;
  rec.cancelRequested = Boolean(cur.cancelRequested || rec.cancelRequested);
  rec.cancelPhase = cur.cancelPhase ?? rec.cancelPhase;
  rec.deliveryStatus = cur.deliveryStatus ?? rec.deliveryStatus;
  rec.progress = cur.progress ?? rec.progress;
  rec.error = cur.error ?? rec.error;
  rec.downloadExpiresAt = cur.downloadExpiresAt ?? rec.downloadExpiresAt;
  if (cur.status === 'expired' && rec.status === 'completed') rec.downloadExpired = true;
  else if (!(wasTerminal && !TASK_TERMINAL.has(cur.status ?? rec.status))) rec.status = cur.status ?? rec.status;
  // 链接到期只改变交付能力，不能抹掉已确认的生成成功。
  if (cur.downloadExpired || cur.deliveryStatus === 'expired') rec.downloadExpired = true;
  if (TASK_TERMINAL.has(cur.status)) rec.terminalEvidence = 'server_status';
  return rec;
}

// v2 记录判定：executorVersion===2；或缺 executorVersion 但带 v2 特征字段（受损 v2 不降级 legacy）
export function isV2Record(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.executorVersion === 2) return true;
  return rec.executorVersion == null && V2_MARK_FIELDS.some(f => rec[f] != null);
}

const unverifiedAbsence = rec =>
  (rec?.status === 'not_found' || rec?.status === 'expired')
  && !['server_status', 'explicit_absence'].includes(rec.terminalEvidence);
// 显式未知版本不能按旧版的无 content_ready 门槛放行；缺版本且无 v2 特征的历史记录
// 仍沿用原 0.4.4 兼容语义，后续查询会补齐服务器版本。
const needsReadyProof = rec => isV2Record(rec)
  || (rec?.executorVersion != null && rec.executorVersion !== 1 && rec.executorVersion !== 2);

// 服务器侧终结：终态且非交付中；v2 completed 但 contentReady!==true 仍不算终结
export function isSettled(rec) {
  return isSupportedTaskRecord(rec) && TASK_TERMINAL.has(rec?.status) && rec.deliveryStatus !== 'delivering'
    && !rec?.terminalConflict && !unverifiedAbsence(rec)
    && !(needsReadyProof(rec) && rec.status === 'completed' && rec.contentReady !== true);
}

// 允许向服务器取交付内容：completed 且非交付中；v2（含受损 v2）必须 contentReady===true
export function canFetchContent(rec) {
  return Boolean(rec) && isSupportedTaskRecord(rec) && rec.status === 'completed' && rec.deliveryStatus !== 'delivering'
    && !rec.downloadExpired && !rec.terminalConflict
    && (needsReadyProof(rec) ? rec.contentReady === true : true);
}

// 终态失败：status∈{failed,cancelled,not_found,expired} 且非交付中
export function isFinalFailure(rec) {
  return isSupportedTaskRecord(rec) && FAIL_TERMINAL.has(rec?.status) && rec.deliveryStatus !== 'delivering'
    && !rec?.terminalConflict && !unverifiedAbsence(rec);
}

// 本端现在是否还应查询（操作谓词）：未终结、未本地暂停、节点未脱离。
// 注意：任务记录级轮询是否继续另有判定（detached 任务仍按 isSettled 跟踪服务器事实），
// 本谓词供「继续查询/恢复等待」类界面动作使用。
export function needsTracking(rec) {
  return isSupportedTaskRecord(rec) && !isSettled(rec) && !rec?.paused && !rec?.detached;
}

// 是否可请求服务器取消（仅 v2 在途且未请求过）；非 v2 不虚假开放取消能力
export function canRequestCancel(rec) {
  return isSupportedTaskRecord(rec) && rec?.executorVersion === 2 && !isSettled(rec) && !rec.cancelRequested;
}

// A1 核心守卫：节点当前仍绑定该任务且关联未撤销，才允许把结果写回节点输出
export function canAttachResult(rec, node) {
  return Boolean(rec) && isSupportedTaskRecord(rec) && Boolean(node) && node.data?.run?.taskId === rec.taskId && !rec.detached;
}

// 本机已有结果可预览（resultBlobId 已持久化 blob，或已注册成本地素材）；
// 与「允许再次从服务器下载」是两个独立判断。blob 实体校验由调用方走 storage 层。
export function hasLocalResult(rec) {
  return Boolean(rec) && Boolean(rec.resultBlobId || rec.resultAssetId);
}

// 展示键：本地暂停（含需原密钥）> 脱离 > 交付中 > 原始 status
function taskIdentityMatches(rec, keyFp, accountSubject) {
  if (accountSubject && rec?.ownerSubject === accountSubject) return true;
  return keyFp != null && rec?.keyFp === keyFp;
}

function statusKey(rec, { keyFp, accountSubject } = {}) {
  if (rec?.localSaveState === 'pending' || rec?.localSaveState === 'blocked') return 'save_pending';
  if (!isSupportedTaskRecord(rec)) return 'query_unknown';
  if (rec?.paused) return (rec.authFailed ||
    ((keyFp != null || accountSubject != null) && !taskIdentityMatches(rec, keyFp, accountSubject))) ? 'need_key' : 'paused';
  if (rec?.detached) return 'detached';
  if (rec?.terminalConflict || unverifiedAbsence(rec) || rec?.queryHealth === 'needs_review') return 'query_unknown';
  if (rec?.status === 'completed' && rec.deliveryStatus === 'delivering') return 'delivering';
  return rec?.status ?? 'unknown';
}
export function statusLabel(rec, opts) {
  const k = statusKey(rec, opts);
  return STATUS_LABEL[k] ?? k;
}
export function statusTone(rec, opts) {
  const k = statusKey(rec, opts);
  if (k === 'completed' || k === 'ready') return 'ok';
  if (FAIL_TERMINAL.has(k)) return 'err';
  if (k === 'need_key' || k === 'paused' || k === 'detached' || k === 'query_unknown' || k === 'save_pending') return 'warn';
  return 'busy';
}

// 统一相位（C 四类界面同一标签源）：准备素材→已受理→生成中→核对中/交付中→本地可用。
// 关系与终态优先于管线相位：detached > 暂停/需密钥 > 终态失败/取消 > 本地就绪 > 交付/核对 > 生成 > 受理。
const RECONCILE_STAGES = new Set(['reconciling', 'needs_review', 'cost_unknown', 'no_candidates',
  'send_lease_expired', 'submit_uncertain', 'upstream_not_found', 'finalizing_failure', 'candidates_exhausted']);
const DELIVERY_STAGES = new Set(['delivering', 'awaiting_delivery', 'delivery_fault', 'finalizing_success', 'succeeded', 'done']);
export function taskPhase(rec, { keyFp, accountSubject } = {}) {
  if (!rec || typeof rec !== 'object') return 'preparing';
  if (!isSupportedTaskRecord(rec)) return 'reconciling';
  if (rec.detached) return 'detached';
  if (rec.localSaveState === 'pending' || rec.localSaveState === 'blocked') return 'reconciling';
  if (rec.paused) return (rec.authFailed ||
    ((keyFp != null || accountSubject != null) && !taskIdentityMatches(rec, keyFp, accountSubject))) ? 'need_key' : 'paused';
  if (rec.terminalConflict || unverifiedAbsence(rec) || rec.queryHealth === 'needs_review') return 'reconciling';
  if (isFinalFailure(rec)) return rec.status === 'cancelled' ? 'cancelled' : 'final_failed';
  if (hasLocalResult(rec)) return 'local_ready';
  if (rec.status === 'completed') return canFetchContent(rec) ? 'local_ready' : 'delivering';
  if (rec.deliveryStatus === 'delivering' || DELIVERY_STAGES.has(rec.stage)) return 'delivering';
  if (RECONCILE_STAGES.has(rec.stage)) return 'reconciling';
  if (rec.status === 'queued') return 'accepted';
  if (rec.status === 'in_progress') return 'generating';
  if (rec.status === 'submitting' || rec.status === 'uploading') return 'preparing';
  return 'accepted';
}
