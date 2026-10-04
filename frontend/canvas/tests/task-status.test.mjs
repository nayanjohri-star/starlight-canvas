// 统一任务状态合同（task-status.js）纯函数单测：冻结签名全导出覆盖。
// 边界：v2 completed+contentReady=false、delivering、受损 v2、legacy、paused/detached/authFailed、
// 粘性 contentReady/cancelRequested、终态不被旧响应回退。无 DOM/存储/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_REC_VERSION, TASK_TERMINAL, STATUS_LABEL, V2_MARK_FIELDS,
  normalizeTaskResponse, mergeTaskResponse,
  isV2Record, isSettled, canFetchContent, isFinalFailure, needsTracking,
  canRequestCancel, canAttachResult, hasLocalResult,
  statusLabel, statusTone, taskPhase,
} from '../src/task-status.js';

const v2 = (over = {}) => ({ taskId: 't', status: 'in_progress', executorVersion: 2, keyFp: 'fp', ...over });
const legacy = (over = {}) => ({ taskId: 't', status: 'in_progress', keyFp: 'fp', ...over });

test('常量：TASK_REC_VERSION=2 且 ≠ 服务器 executor_version；TASK_TERMINAL 五项', () => {
  assert.equal(TASK_REC_VERSION, 2);
  assert.deepEqual([...TASK_TERMINAL].sort(), ['cancelled', 'completed', 'expired', 'failed', 'not_found']);
});

test('V2_MARK_FIELDS：合同导出——受损 v2 特征字段集合（C 侧 sig 指纹校验消费）', () => {
  assert.deepEqual([...V2_MARK_FIELDS].sort(), ['cancelPhase', 'contentReady', 'stage']);
  // 与 isV2Record 判定同源：带任一特征字段且缺 executorVersion 即受损 v2
  for (const f of V2_MARK_FIELDS) assert.ok(isV2Record({ taskId: 't', status: 'completed', [f]: 1 }), f);
  // downloadExpiresAt 是查询响应通用可选字段（接入指南 §6），单独携带不证明 v2 身份
  assert.equal(isV2Record({ taskId: 't', status: 'completed', downloadExpiresAt: 1899999999 }), false);
});

test('normalizeTaskResponse：snake→camel 全字段；空/非对象输入全部 undefined', () => {
  const n = normalizeTaskResponse({
    status: 'completed', stage: 'succeeded', executor_version: 2, content_ready: true,
    delivery_status: 'ready', progress: 100, error: null, download_expires_at: 123,
    cancel_requested: true, cancel_phase: 'done', download_expired: false, extra_unknown: 'x',
  });
  assert.deepEqual(n, {
    status: 'completed', stage: 'succeeded', executorVersion: 2, contentReady: true,
    deliveryStatus: 'ready', progress: 100, error: null, downloadExpiresAt: 123,
    cancelRequested: true, cancelPhase: 'done', downloadExpired: false,
  });
  for (const bad of [null, undefined, 0, 'x', []]) {
    const m = normalizeTaskResponse(bad);
    assert.ok(Object.values(m).every(v => v === undefined));
  }
});

test('mergeTaskResponse：字段合并 + 下载到期不覆盖生成成功', () => {
  const rec = v2({ status: 'in_progress', progress: 40 });
  mergeTaskResponse(rec, { status: 'completed', stage: 'succeeded', content_ready: true, progress: 100, delivery_status: 'ready' });
  assert.equal(rec.status, 'completed');
  assert.equal(rec.contentReady, true);
  assert.equal(rec.progress, 100);
  // 远端链接到期是交付事实，不是生成失败
  mergeTaskResponse(rec, { download_expired: true });
  assert.equal(rec.status, 'completed');
  assert.equal(rec.downloadExpired, true);
  const rec2 = v2({ status: 'in_progress' });
  mergeTaskResponse(rec2, { delivery_status: 'expired' });
  assert.equal(rec2.status, 'in_progress');
  assert.equal(rec2.downloadExpired, true);
});

test('mergeTaskResponse：终态不被迟到的非终态响应回退；非终态照常更新', () => {
  const rec = v2({ status: 'completed', contentReady: true });
  mergeTaskResponse(rec, { status: 'in_progress', progress: 30 });
  assert.equal(rec.status, 'completed', '终态不得回退为生成中');
  assert.equal(rec.progress, 30, '其余字段仍如实刷新');
  // completed→expired 只说明下载期限变化
  mergeTaskResponse(rec, { status: 'expired' });
  assert.equal(rec.status, 'completed');
  assert.equal(rec.downloadExpired, true);
  // 非终态自由更新
  const live = v2({ status: 'in_progress' });
  mergeTaskResponse(live, { status: 'failed' });
  assert.equal(live.status, 'failed');
});

test('mergeTaskResponse：contentReady/cancelRequested 粘性真值', () => {
  const rec = v2({ status: 'completed', contentReady: true, cancelRequested: true });
  mergeTaskResponse(rec, { content_ready: false, cancel_requested: false });
  assert.equal(rec.contentReady, true, 'ready 不回退');
  assert.equal(rec.cancelRequested, true, 'cancelRequested 不回退');
  const rec2 = v2({ status: 'in_progress', contentReady: false });
  mergeTaskResponse(rec2, { content_ready: false });
  assert.equal(rec2.contentReady, false, 'false 可记录');
  mergeTaskResponse(rec2, {});
  assert.equal(rec2.contentReady, false, '响应未携带则保持');
});

test('isV2Record：executorVersion=2；受损 v2（缺版本带特征字段）判真；legacy 判假', () => {
  assert.equal(isV2Record(v2()), true);
  assert.equal(isV2Record(legacy({ contentReady: false })), true, '受损 v2：contentReady');
  assert.equal(isV2Record(legacy({ stage: 'running' })), true, '受损 v2：stage');
  assert.equal(isV2Record(legacy({ cancelPhase: 'stopping' })), true, '受损 v2：cancelPhase');
  assert.equal(isV2Record(legacy({ downloadExpiresAt: 1899999999 })), false, 'downloadExpiresAt 是通用可选字段，不构成 v2 证据');
  assert.equal(isV2Record(legacy()), false);
  assert.equal(isV2Record(legacy({ executorVersion: 1 })), false);
  assert.equal(isV2Record(null), false);
});

test('isSettled：终态且非交付中；v2 completed+!contentReady 不算终结；受损 v2 同门槛', () => {
  assert.equal(isSettled(legacy({ status: 'completed' })), true);
  assert.equal(isSettled(v2({ status: 'completed', contentReady: true })), true);
  assert.equal(isSettled(v2({ status: 'completed', contentReady: false })), false, 'v2 未 ready 未终结');
  assert.equal(isSettled(v2({ status: 'completed' })), false, 'v2 缺 contentReady 未终结');
  assert.equal(isSettled(legacy({ status: 'completed', contentReady: false })), false, '受损 v2 按 v2 门槛');
  assert.equal(isSettled(v2({ status: 'completed', contentReady: true, deliveryStatus: 'delivering' })), false, '交付中未终结');
  assert.equal(isSettled(v2({ status: 'failed' })), true);
  assert.equal(isSettled(v2({ status: 'in_progress' })), false);
});

test('canFetchContent：v2 须 contentReady===true；delivering 不放行；legacy 按旧行为', () => {
  assert.equal(canFetchContent(v2({ status: 'completed', contentReady: true })), true);
  assert.equal(canFetchContent(v2({ status: 'completed', contentReady: false })), false);
  assert.equal(canFetchContent(v2({ status: 'completed', contentReady: true, deliveryStatus: 'delivering' })), false);
  assert.equal(canFetchContent(v2({ status: 'completed', contentReady: true, downloadExpired: true })), false);
  assert.equal(canFetchContent({ status: 'completed', executorVersion: 3 }), false, '未知显式 executor 版本不得按 legacy 放行');
  assert.equal(canFetchContent(legacy({ status: 'completed' })), true, 'legacy completed 放行');
  assert.equal(canFetchContent(legacy({ status: 'completed', contentReady: false })), false, '受损 v2 不放行');
  assert.equal(canFetchContent(legacy({ status: 'completed', downloadExpiresAt: 1899999999 })), true, 'legacy+downloadExpiresAt 保持可下载');
  // e2e 回归：legacy completed 收到含 download_expires_at 的查询响应，经 merge 后不得被误判受损 v2
  const leg = legacy({ status: 'completed' });
  mergeTaskResponse(leg, { status: 'completed', download_expires_at: 1899999999 });
  assert.equal(isV2Record(leg), false, '吸收通用可选字段不得误判受损 v2');
  assert.equal(canFetchContent(leg), true, '合并后下载键不得被禁用');
  assert.equal(canFetchContent(v2({ status: 'failed' })), false);
  assert.equal(canFetchContent(null), false);
});

test('isFinalFailure：仅可信缺失/到期可终结，旧无来源记录待核对', () => {
  for (const s of ['failed', 'cancelled']) assert.equal(isFinalFailure(v2({ status: s })), true, s);
  for (const s of ['not_found', 'expired']) {
    assert.equal(isFinalFailure(v2({ status: s })), false, s + ' 缺终态证据');
    assert.equal(isFinalFailure(v2({ status: s, terminalEvidence: 'server_status' })), true, s + ' 有服务器证据');
  }
  assert.equal(isFinalFailure(v2({ status: 'failed', deliveryStatus: 'delivering' })), false);
  assert.equal(isFinalFailure(v2({ status: 'completed', contentReady: true })), false);
  assert.equal(isFinalFailure(v2()), false);
});

test('needsTracking：未终结且未暂停且未脱离', () => {
  assert.equal(needsTracking(v2()), true);
  assert.equal(needsTracking(v2({ paused: true })), false);
  assert.equal(needsTracking(v2({ detached: true })), false);
  assert.equal(needsTracking(v2({ status: 'completed', contentReady: true })), false);
  assert.equal(needsTracking(v2({ status: 'failed' })), false);
});

test('canRequestCancel：仅 v2 在途未请求；非 v2 不开放', () => {
  assert.equal(canRequestCancel(v2()), true);
  assert.equal(canRequestCancel(legacy()), false, 'legacy 不提供服务端取消');
  assert.equal(canRequestCancel(v2({ cancelRequested: true })), false);
  assert.equal(canRequestCancel(v2({ status: 'completed', contentReady: true })), false);
  assert.equal(canRequestCancel(v2({ status: 'failed' })), false);
});

test('canAttachResult：节点仍绑定本任务且未脱离（A1 核心）', () => {
  const rec = v2({ status: 'completed', contentReady: true });
  assert.equal(canAttachResult(rec, { data: { run: { taskId: 't' } } }), true);
  assert.equal(canAttachResult(rec, { data: { run: { taskId: 'other' } } }), false, '已重绑其他任务');
  assert.equal(canAttachResult(rec, { data: { run: null } }), false, '已脱离清空');
  assert.equal(canAttachResult(rec, { data: {} }), false);
  assert.equal(canAttachResult({ ...rec, detached: true }, { data: { run: { taskId: 't' } } }), false, '关联已撤销');
  assert.equal(canAttachResult(rec, null), false, '节点已删除');
  assert.equal(canAttachResult(null, { data: { run: { taskId: 't' } } }), false);
});

test('hasLocalResult：resultBlobId 或 resultAssetId 在机', () => {
  assert.equal(hasLocalResult(v2({ resultBlobId: 'result:p:t' })), true);
  assert.equal(hasLocalResult(v2({ resultAssetId: 'a1' })), true);
  assert.equal(hasLocalResult(v2()), false);
  assert.equal(hasLocalResult(null), false);
});

test('statusLabel/statusTone：paused/authFailed/need_key 优先级与 badge 配色', () => {
  assert.equal(statusLabel(v2({ paused: true, authFailed: true }), { keyFp: 'fp' }), '需原密钥');
  assert.equal(statusLabel(v2({ paused: true }), { keyFp: 'other' }), '需原密钥', '指纹不符按 need_key');
  assert.equal(statusLabel(v2({ paused: true }), { keyFp: 'fp' }), '已暂停查询');
  assert.equal(statusLabel(v2({ status: 'completed', contentReady: true, deliveryStatus: 'delivering' })), '交付中');
  assert.equal(statusLabel(v2({ status: 'failed' })), '失败');
  assert.equal(statusLabel(v2({ detached: true })), '已脱离节点');
  assert.equal(statusTone(v2({ status: 'completed', contentReady: true })), 'ok');
  assert.equal(statusTone(v2({ status: 'failed' })), 'err');
  assert.equal(statusTone(v2({ status: 'cancelled' })), 'err');
  assert.equal(statusTone(v2({ paused: true }), { keyFp: 'fp' }), 'warn');
  assert.equal(statusTone(v2({ status: 'in_progress' })), 'busy');
  assert.equal(statusTone(v2({ status: 'completed', contentReady: true, deliveryStatus: 'delivering' })), 'busy');
});

test('taskPhase：统一相位覆盖关系/终态/管线', () => {
  assert.equal(taskPhase(v2({ detached: true })), 'detached');
  assert.equal(taskPhase(v2({ paused: true, authFailed: true }), { keyFp: 'fp' }), 'need_key');
  assert.equal(taskPhase(v2({ paused: true }), { keyFp: 'fp' }), 'paused');
  assert.equal(taskPhase(v2({ status: 'failed' })), 'final_failed');
  assert.equal(taskPhase(v2({ status: 'cancelled' })), 'cancelled');
  assert.equal(taskPhase(v2({ status: 'completed', contentReady: true })), 'local_ready');
  assert.equal(taskPhase(v2({ status: 'completed', contentReady: false })), 'delivering', 'v2 未 ready 属交付中');
  assert.equal(taskPhase(v2({ status: 'completed', contentReady: true, resultBlobId: 'r' })), 'local_ready');
  assert.equal(taskPhase(v2({ status: 'in_progress', deliveryStatus: 'delivering' })), 'delivering');
  assert.equal(taskPhase(v2({ status: 'in_progress', stage: 'reconciling' })), 'reconciling');
  assert.equal(taskPhase(v2({ status: 'in_progress' })), 'generating');
  assert.equal(taskPhase(v2({ status: 'queued' })), 'accepted');
  assert.equal(taskPhase(null), 'preparing');
  // detached/终态优先于管线字段
  assert.equal(taskPhase(v2({ status: 'in_progress', detached: true })), 'detached');
  assert.equal(taskPhase(v2({ status: 'failed', resultBlobId: 'r' })), 'final_failed');
});
