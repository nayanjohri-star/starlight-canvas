// 视频生成节点：参数联动表单、费用预估、上传→幂等提交→轮询→鉴权下载。
// 关键约束（防重复收费/可恢复）：
//  · 每节点互斥锁覆盖上传+创建+重试；双击/轮询期间不可二次提交
//  · 上传前快照：draft 副本 + 素材 id 顺序 + projectId/nodeId/密钥指纹；快照外的后续改动不影响本次请求
//  · 上传并发 ≤3，任一失败 AbortController 取消其余；用户可取消；全部成功才创建
//  · 创建前持久化 {key, 完整body字符串, model, keyFp, firstSubmitAt, snapshot}；收到 taskId 先落任务记录再清 pending
//  · 未确认提交不允许抹掉换键重发；400 等明确拒绝与 429/5xx/断网分开；重试同 body/key/密钥，24h 窗内，尊重 Retry-After
//  · 每次 poll/download 校验密钥指纹；换密钥暂停而非继续

import { el, toast, modal, confirmDialog } from './ui.js';
import { getModel, intentsFor, modeForIntent, estimateCost, validateDraft, buildCreateBody, modelIds, syncPromptBindings, nodeOutputs, effectivePrompt, MEDIA_KINDS, UPLOAD_LIMITS, mediaDurationRule } from './capabilities.js';
import { getFingerprint, hasKey, isModelUsable } from './keyvault.js';
import { getProvider } from './providers.js';
import { isExternalProvider } from './provider-config.js';
import { createSubmitLock } from './submit-lock.js';
import { directVideoOutput } from './studio-schema.js';
import { promptReferencePicker, referenceToken } from './prompt-references.js';
import { TASK_TERMINAL, STATUS_LABEL, normalizeTaskResponse, mergeTaskResponse, isV2Record, isSettled, canFetchContent, canRequestCancel, canAttachResult, hasLocalResult, isSupportedTaskRecord, statusLabel, statusTone } from './task-status.js';
import { serverTimes, noteTaskTiming, TIMING_FIELDS, taskTiming, timingElement } from './task-timing.js';
import { renderFrameSlots, renderUnused, portEntries, frameAssignment, disconnectEntries } from './frame-slots.js';
import { canRewriteH3, openH3Rewrite } from './rewrite-ui.js';

const IDEM_WINDOW_MS = 24 * 3600 * 1000;

// stage 仅展示不判终态：accepted→finalizing_* 均非终态；终态只看 status
const STAGE_LABEL = {
  accepted: '已受理', preparing: '准备中', queued: '排队中', running: '生成中',
  switching: '切换渠道', reconciling: '核对结果', needs_review: '待复核',
  delivering: '交付中', finalizing_success: '收尾中', finalizing_failure: '收尾中',
  succeeded: '已成功', failed: '已失败', cancelled: '已取消',
  prepare_retry: '恢复素材准备', prepare_fault: '素材准备待处理', sending: '提交中',
  upstream_running: '生成中', submit_uncertain: '核对提交结果', upstream_not_found: '核对上游任务',
  send_lease_expired: '核对提交结果', awaiting_delivery: '视频交付中', delivery_fault: '恢复视频交付',
  cost_unknown: '待复核', no_candidates: '待复核', candidates_exhausted: '收尾中',
  cancelled_pre_send: '取消处理中', done: '已完成',
};
// 停轮/可下载判定统一走 task-status.js 合同（isSettled/canFetchContent），本文件不再重复实现

// ---- last_frame 意图与型号级媒体限制（画布交互侧）----
// 不新增 draft 字段：意图复用 draft.intent 存储与 perModel 恢复；metadata.mode=frames 映射
// 与请求体 last_frame_url 构建由 capabilities 负责。仅当能力表显式声明
//（supports_last_frame_only=true 或 intentsFor 已含该意图）时提供，不支持型号一律不泄漏。
const KIND_SHORT = { image: '图片', video: '视频', audio: '音频' };
const MIME_EXT = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'video/mp4': 'MP4', 'video/webm': 'WebM', 'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/x-wav': 'WAV', 'audio/mp4': 'M4A' };
const FRAMES_FAMILY_INTENTS = new Set(['frames', 'last_frame']);
const extList = types => [...new Set((types ?? []).map(t => MIME_EXT[t] ?? t))].join('/');
// 各模式实际使用的输入口（编辑面板展示与提交同一口径）：
//  · 首尾帧 / 仅尾帧只用「首尾帧」口——首尾帧取前两张（首帧、尾帧），仅尾帧取最后一张；
//  · 素材参考 / 单图只用「素材」口；
//  · 另一口上残留的连线既不提交也不参与校验，编辑面板把它们单独列为“不会提交”并可一键断开。
// 纯文字模式保持原校验：连着素材时要求切换模式或断开，避免按纯文字收费却以为素材参与了生成。
// 提交前后比对草稿用的签名：只看影响请求的字段，与键顺序无关；空的 @绑定 与没有绑定等价。
// 检查器重建、绑定同步这类不改变请求的写入不会让一次正常提交被当成“等待期间已修改”而中止。
export function draftSignature(draft) {
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sort(v[k])])) : v;
  const { bindings, ...rest } = draft ?? {};
  return JSON.stringify(sort({ ...rest, bindings: bindings && Object.keys(bindings).length ? bindings : {} }));
}
export function modeInputs(intent, refsW, framesW) {
  if (FRAMES_FAMILY_INTENTS.has(intent)) {
    const frames = intent === 'last_frame' ? framesW.items.slice(-1) : framesW.items.slice(0, 2);
    return { refs: [], frames, problems: [...framesW.problems] };
  }
  if (intent === 'refs' || intent === 'i2v') return { refs: refsW.items, frames: [], problems: [...refsW.problems] };
  return { refs: refsW.items, frames: framesW.items, problems: [...refsW.problems, ...framesW.problems] };
}
export function supportsLastFrameOnly(modelId) {
  return getModel(modelId)?.supports_last_frame_only === true || intentsFor(modelId).some(i => i.intent === 'last_frame');
}
// 时长控件标签：离散档位（受限版 6/10/15）不得显示成连续区间
export function secondsFieldLabel(m) {
  return m?.allowed_seconds?.length ? `时长 ${m.allowed_seconds.join('/')} 秒` : `时长 ${m?.seconds.min ?? '?'}–${m?.seconds.max ?? '?'} 秒`;
}
// 带 media_max_bytes/media_content_types 的型号（满参慢速版等）：十进制 MB + 收窄格式；
// 时长文案取 mediaDurationRule 的素材合同（参考视频/音频每条与各类合计上限）——
// 输出时长 seconds.max 是生成参数，不得拿来充当参考素材限制；图片不参与时长限制。
export function mediaLimitsHint(m, modelId) {
  const mb = m?.media_max_bytes;
  if (!mb || typeof mb !== 'object') return null;
  const parts = [];
  for (const k of MEDIA_KINDS) {
    if (!Number.isFinite(mb[k])) continue;
    let s = `${KIND_SHORT[k]}≤${Math.round(mb[k] / 1e6)}MB`;
    const types = m.media_content_types?.[k];
    const globalTypes = UPLOAD_LIMITS()?.[k]?.content_types ?? [];
    if (Array.isArray(types) && types.length && types.length < globalTypes.length) s += `（仅 ${extList(types)}）`;
    parts.push(s);
  }
  if (!parts.length) return null;
  const dr = mediaDurationRule(modelId);
  const dur = dr ? `；参考视频/音频每条 ${dr.min}–${dr.max} 秒` + (Number.isFinite(dr.kind_total) ? `、各类合计≤${dr.kind_total} 秒` : '') : '';
  return `素材限制：${parts.join(' · ')}${dur}`;
}
// 单个已连接素材的型号级问题：逐条显示在对应素材行下；只说明，不静默清理
export function assetMediaProblems(m, a) {
  const out = [];
  const maxB = m?.media_max_bytes?.[a?.kind];
  if (Number.isFinite(maxB) && Number.isFinite(a?.size) && a.size > maxB)
    out.push(`大小约 ${Math.round(a.size / 1e6)}MB 超过该型号上限 ${Math.round(maxB / 1e6)}MB`);
  const types = m?.media_content_types?.[a?.kind];
  if (Array.isArray(types) && types.length && a?.mime && !types.includes(a.mime))
    out.push(`格式 ${a.mime} 不受该型号支持（仅 ${extList(types)}）`);
  return out;
}
export function createTaskRunner({ store, storage, api, assets, onUpdate, submitLock, pollScheduler, saveScheduler,
  accountScope }) {
  const pollLater = (fn, ms) => {
    const timer = pollScheduler?.setTimeout ? pollScheduler.setTimeout(fn, ms) : setTimeout(fn, ms);
    timer?.unref?.(); // Node 回归完成后不因未决任务的后台查询计时器拖住进程
    return timer;
  };
  const cancelPoll = id => pollScheduler?.clearTimeout ? pollScheduler.clearTimeout(id) : clearTimeout(id);
  const saveLater = (fn, ms) => saveScheduler?.setTimeout ? saveScheduler.setTimeout(fn, ms) : setTimeout(fn, ms);
  const cancelSave = id => saveScheduler?.clearTimeout ? saveScheduler.clearTimeout(id) : clearTimeout(id);
  const pollers = new Map();   // `${projectId}:${taskId}` → timeout
  const pollVersions = new Map(); // old in-flight GET responses cannot overwrite a newer poll
  const locks = new Set();     // nodeId → 正在 上传+创建/重试
  const aborts = new Map();    // nodeId → AbortController（上传阶段）
  const pendingSaves = new Map(); // 首次终态落盘失败时也保留原记录，独立于网络轮询重试
  const saveTimers = new Map();
  const resultURLs = new Set(); // URL 归调用方生命周期管理，核心提供成对释放入口
  const cache = new Map();     // `${projectId}:${taskId}` → 最近任务记录（不同项目同 taskId 不串）
  const runnerKeyFp = getFingerprint();
  let disposed = false;
  const sessionAlive = () => !disposed && (!accountScope ||
    (accountScope.active && getFingerprint() === runnerKeyFp));
  // Hosted task IDs are verified by the server on every GET. An imported task
  // may carry an old local key fingerprint; it never authorizes a new POST.
  const canQueryTask = rec => sessionAlive() && (!accountScope ||
    !rec.ownerSubject || rec.ownerSubject === accountScope.subject) &&
    (!!accountScope || rec.keyFp === getFingerprint());
  // The video gateway scopes idempotency to the original raw Key. A new Key
  // for the same account cannot safely replay an uncertain POST: it would
  // reserve another public vjob rather than reconcile the first one.
  const canRetryPending = rec => sessionAlive() && rec.keyFp === getFingerprint();
  // 跨标签页提交互斥（按 项目:节点 粒度，绝不锁整个账户）；无 Web Locks 的浏览器 fail closed
  const xlock = typeof submitLock === 'function' ? { request: submitLock } : submitLock ?? createSubmitLock({
    namespace: accountScope?.lockNamespace, assertActive: accountScope?.assertActive,
  });

  const tkey = (pid, id) => `${pid}:${id}`;
  const recOf = async (id, pid = store.project?.id) => {
    const hit = cache.get(tkey(pid, id));
    if (hit) return hit;
    const rec = await storage.get(`task:${tkey(pid, id)}`);
    if (rec) cache.set(tkey(pid, id), rec);
    return rec;
  };
  const putRec = async (rec, fields) => {
    const pk = tkey(rec.projectId, rec.taskId);
    rec.updatedAt = Date.now();
    rec.localSaveState = 'saved';
    rec.localSaveError = null;
    cache.set(pk, rec);
    const owned = fields ? [...new Set([...fields, 'updatedAt', 'localSaveState', 'localSaveError'])] : undefined;
    try {
      const saved = await store.saveTask(rec, { fields: owned });
      Object.assign(rec, saved.record);
      pendingSaves.delete(pk);
      cancelSave(saveTimers.get(pk)); saveTimers.delete(pk);
      onUpdate?.();
      return saved;
    } catch (e) {
      rec.localSaveState = 'pending';
      rec.localSaveError = e?.message ?? String(e);
      pendingSaves.set(pk, { rec, fields: owned, failures: (pendingSaves.get(pk)?.failures ?? 0) + 1 });
      scheduleSaveRetry(pk);
      onUpdate?.();
      throw e;
    }
  };
  function scheduleSaveRetry(pk) {
    if (saveTimers.has(pk)) return;
    const pending = pendingSaves.get(pk); if (!pending) return;
    const delay = Math.min(30000, 1500 * 2 ** Math.min(4, pending.failures - 1));
    const timer = saveLater(async () => {
      saveTimers.delete(pk);
      const latest = pendingSaves.get(pk); if (!latest) return;
      try { await putRec(latest.rec, latest.fields); }
      catch { /* putRec 已安排下一次有限退避；不清除原任务身份 */ }
    }, delay);
    timer.unref?.();
    saveTimers.set(pk, timer);
  }
  const projectSavePending = pid => [...pendingSaves.keys()].some(k => k.startsWith(pid + ':'));

  // ---- 连线解析：每条入线必须能解析成素材，否则为显式问题。
  // 统一走 nodeOutputs（outputOf 语义 + 缺失引用显式报告），覆盖 asset/gen/image/utility 等全部来源。
  function wired(nodeId, port) {
    const items = [], problems = [];
    for (const e of store.edgesInto(nodeId, port)) {
      const src = store.node(e.from.node);
      if (!src) { problems.push('来源节点已删除'); continue; }
      if (src.type === 'asset' && !src.data.assetId) { problems.push('素材节点未绑定文件'); continue; }
      const out = nodeOutputs(store.project, src);
      problems.push(...out.missing);
      items.push(...out.assets);
      if (!out.missing.length && !out.assets.length) {
        problems.push(src.type === 'director'
          ? '导演台请先在编辑器中导出为素材节点'
          : out.text?.trim()
            ? `「${src.data?.title || src.id}」输出为文本，不能作为素材参考`
            : `「${src.data?.title || src.id}」尚无可用输出（需先生成或绑定素材）`);
      }
    }
    return { items, problems };
  }

  // ---- 上传：并发 ≤3，任一失败中止其余；每个请求前后校验密钥指纹与项目身份 ----
  async function uploadAll(list, nodeId, snapFp, snapProjectId, onStep) {
    const need = list.filter(a => !assets.remoteValid(a));
    if (!need.length) return;
    const ac = new AbortController(); aborts.set(nodeId, ac);
    const checkIdentity = () => {
      if (getFingerprint() !== snapFp || store.project?.id !== snapProjectId)
        throw Object.assign(new Error('密钥或项目在上传期间已变更，中止后续请求'), { code: 'identity_changed' });
    };
    let i = 0, failed = null;
    const worker = async () => {
      while (i < need.length && !ac.signal.aborted) {
        const a = need[i++];
        onStep?.(`上传 ${a.name}`);
        try {
          checkIdentity();
          await assets.upload(a.id, { signal: ac.signal, keyFp: snapFp });
          checkIdentity();
        } catch (e) { failed ??= e; ac.abort(); }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, need.length) }, worker));
    } finally { aborts.delete(nodeId); }
    if (failed) throw failed;
    if (ac.signal.aborted) throw new Error('已取消');
    checkIdentity();
  }
  function cancelUpload(nodeId) { aborts.get(nodeId)?.abort(); }

  // 待决记录 → 节点守卫态：uncertain/abandoned/conflict/expired_window 一律保持禁发；
  // rejected 不恢复守卫（已明确拒绝，节点可修正后新建）
  const pendingGuardRun = (r, prevDetached) =>
    r.state === 'expired_window'
      ? { pendingKey: r.idempotencyKey, detached: true, expired: true }
      : { pendingKey: r.idempotencyKey, ...(r.state === 'abandoned' || prevDetached ? { detached: true } : {}) };

  // 可证明未构建/未发送：bodyString 从未成形且 lastSubmitAt 未落盘——POST 只发生在
  // 「bodyString 持久化 → lastSubmitAt 持久化」之后，两者皆空即证明请求从未发出。
  // lastSubmitAt 单独缺失不能证明（旧版/导入记录可能缺该字段）；有完整 body 的一律按可能已发守 24h。
  const provablyUnsent = r => r != null && r.bodyString == null && r.lastSubmitAt == null;

  // 锁内持久化核查（R01）：另一标签页可能已为本节点留下任务/未决记录 → 认领而非新建。
  // 任务记录 detached=true 表示用户已主动脱离，不阻挡本节点的新提交。
  async function adoptDurable(node, isCurrent = () => true) {
    const pid = store.project?.id;
    if (!pid) return false;
    const t = (await store.tasksOfProject()).find(t => t.nodeId === node.id && (!t.detached || !isSupportedTaskRecord(t)));
    if (!isCurrent()) return true;
    if (t) {
      if (node.data.run?.taskId !== t.taskId) {
        node.data.run = { taskId: t.taskId };
        store.touch({ type: 'data', id: node.id });
        toast('该节点已有持久化任务记录（可能来自其他标签页），已关联现有任务', 'warn', 6000);
      }
      cache.set(tkey(pid, t.taskId), t);
      // 401/403 鉴权失败是粘性状态：无身份更新时不得自动唤醒空转，仅显式恢复才重启 GET
      if (isSupportedTaskRecord(t) && !t.authFailed && (!t.paused || t.pauseSource === 'identity') && !isSettled(t))
        poll(t.taskId, pid);
      onUpdate?.();
      return true;
    }
    const p = (await store.listPending())
      .filter(r => r.nodeId === node.id && r.state !== 'rejected'
        && !(r.state === 'abandoned' && provablyUnsent(r)))   // 已解除且从未发送的记录不得再武装守卫
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!isCurrent()) return true;
    if (p) {
      node.data.run = pendingGuardRun(p);
      store.touch({ type: 'data', id: node.id }); onUpdate?.();
      toast('该节点有一次提交的结果还未确认，已恢复保护：可在节点上点“再次确认结果”', 'warn', 6000);
      return true;
    }
    return false;
  }

  // 新 pending 落盘失败（R14）：显式可恢复错误态，绝不绕过存储发付费请求
  async function persistNewPending(rec, node) {
    try { await store.savePendingCreate(rec); return true; }
    catch (e) {
      node.data.run = { error: `本地存储写入失败，请求未发送（${e.message}）。草稿保留，修复存储后可重新提交`, storageError: true };
      store.touch({ type: 'data', id: node.id }); onUpdate?.();
      toast('本地存储写入失败，本次请求未发送', 'err', 6000);
      return false;
    }
  }

  // ---- 创建（同 key 同 body 原字节）----
  async function doCreate(rec) {
    const node = store.node(rec.nodeId);
    const priorAttempt = Number.isFinite(rec.lastSubmitAt) && rec.lastSubmitAt > 0;
    // 任何持久化失败一律不得发 POST；已发出的请求若落盘失败也要保住 pendingKey 守卫
    const tryPersist = async r => {
      try { await store.updatePendingCreate(r); return true; }
      catch (e) { toast(`提交记录无法保存到本机（${e.message}），本次未发送；为避免重复收费，节点暂不能新建任务`, 'err', 7000); return false; }
    };
    const markNeedOriginalKey = async () => {
      rec.state = 'uncertain'; rec.lastError = '密钥/项目已变更，请求未发送';
      await tryPersist(rec);
      if (node) { node.data.run = { pendingKey: rec.idempotencyKey }; store.touch({ type: 'data', id: node.id }); }
      toast('密钥已变更，本次请求未发送；切回原密钥后可在节点上点“再次确认结果”', 'warn', 6000);
      onUpdate?.();
    };
    // 每个持久化 await 之后、网络请求之前必须重新核验身份
    if (!canRetryPending(rec) || store.project?.id !== rec.projectId) return markNeedOriginalKey();
    rec.lastSubmitAt = Date.now();
    if (!await tryPersist(rec)) {
      rec.lastError = '本地存储失败，请求未发送';
      if (node) { node.data.run = { pendingKey: rec.idempotencyKey, error: rec.lastError }; store.touch({ type: 'data', id: node.id }); }
      onUpdate?.();
      return;
    }
    if (!canRetryPending(rec) || store.project?.id !== rec.projectId) return markNeedOriginalKey();
    try {
      const resp = await api.createTask(rec.bodyString, rec.idempotencyKey);
      const taskId = resp.id ?? resp.task_id;
      if (!taskId) throw new Error('创建响应缺少任务 id');
      // 先持久化任务+节点关联，再清 pending
      const cur = normalizeTaskResponse(resp);
      const task = {
        taskId, projectId: rec.projectId, nodeId: rec.nodeId, model: rec.model,
        idempotencyKey: rec.idempotencyKey, bodyString: rec.bodyString, keyFp: rec.keyFp,
        ...(accountScope ? { ownerSubject: accountScope.subject } : {}),
        // 提交时刻（待确认记录的创建时间）：耗时从用户点击提交起算，刷新后不重新计时
        ...(Number.isFinite(rec.createdAt) ? { submittedAt: rec.createdAt } : {}),
        ...(serverTimes(resp).createdAt ? { serverCreatedAt: serverTimes(resp).createdAt } : {}),
        createdAt: Date.now(), status: cur.status ?? 'queued', deliveryStatus: cur.deliveryStatus ?? null,
        stage: cur.stage ?? null, executorVersion: cur.executorVersion ?? null,
        contentReady: cur.contentReady ?? null, cancelRequested: cur.cancelRequested ?? false,
        cancelPhase: cur.cancelPhase ?? null,
        progress: cur.progress ?? 0, error: null,
      };
      await putRec(task);
      const node = store.node(rec.nodeId);
      if (node) { node.data.run = { taskId }; store.touch({ type: 'data', id: node.id }); }
      await store.clearPendingCreate(rec);
      poll(taskId, rec.projectId);
      toast(`任务已受理：${taskId}`, 'ok');
    } catch (e) {
      const node = store.node(rec.nodeId);
      const status = e.status ?? 0;
      if (!priorAttempt && (status === 400 || status === 401 || status === 403 || status === 404 || status === 422 ||
          (status === 409 && e.code === 'model_billing_unverified'))) {
        // 明确拒绝：未创建任务；保留拒绝记录供审计，节点允许修正后新建
        rec.state = 'rejected'; rec.lastError = `${status} ${e.code || ''} ${e.message}`;
        await tryPersist(rec);
        if (node) { node.data.run = { rejected: true, error: e.message }; store.touch({ type: 'data', id: node.id }); }
        toast(`请求被拒绝（${status} ${e.code || ''}）：${e.message}`, 'err', 6000);
      } else if (status === 409 && e.code === 'idempotency_conflict') {
        rec.state = 'conflict'; rec.lastError = e.message;
        await tryPersist(rec);
        if (node) { node.data.run = { pendingKey: rec.idempotencyKey }; store.touch({ type: 'data', id: node.id }); }
        toast('服务器认为这次提交与之前的同一提交内容不一致，已拒绝；原记录保留，请检查后创建新版本', 'err', 6000);
      } else {
        // 不确定：断网/超时/5xx/429 —— 只能同键同体重试，24h 窗内
        rec.state = 'uncertain'; rec.lastError = e.message;
        rec.retryAfterMs = Number.isFinite(e.retryAfter) ? e.retryAfter * 1000 : null;
        rec.lastSubmitAt = Date.now();   // R09：退避以收到响应的时刻起算，而非请求发出时刻
        rec.retryNotBefore = Number.isFinite(e.retryAfter) ? rec.lastSubmitAt + rec.retryAfterMs : null;
        await tryPersist(rec);
        if (node) { node.data.run = { pendingKey: rec.idempotencyKey }; store.touch({ type: 'data', id: node.id }); }
        toast(`没有收到服务器的明确答复（${e.code || e.message}）。为避免重复收费，节点暂不能新建任务；可在节点上点“再次确认结果”`, 'warn', 6000);
      }
      onUpdate?.();
    }
  }

  async function submit(node) {
    if (!node || store.node(node.id) !== node) return;
    if (isExternalProvider(getProvider()) && !getProvider().videoEnabled) { toast('当前服务商未启用画布兼容视频任务，请在 API 设置中选择兼容接口', 'err'); return; }
    if (locks.has(node.id)) { toast('该节点正在提交中', 'warn'); return; }
    const d = node.data;
    if (!hasKey()) { toast('请先输入本站 API Key', 'err'); return; }
    if (projectSavePending(store.project?.id)) { toast('任务记录尚未可靠保存，已阻止新的付费提交；请先恢复本地存储', 'err', 7000); return; }
    // 未确认提交 guard：run.pendingKey 在则禁止新建（detach 也不清除），只能同键重试/等窗口过期
    if (d.run?.taskId || d.run?.pendingKey) { toast('该节点已有任务或待确认的提交，请先在节点上处理', 'warn'); return; }
    if (!isModelUsable(d.draft.model)) { toast('该型号不在当前密钥可用范围', 'err'); return; }
    const project = store.project, fp = getFingerprint();
    const isCurrent = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node;
    const draftAtClick = draftSignature(d.draft);
    const edgesAtClick = JSON.stringify([...store.edgesInto(node.id, 'refs'), ...store.edgesInto(node.id, 'frames')]);

    locks.add(node.id);   // 首个 await 之前取锁，覆盖所有 return
    try {
      // 跨标签页互斥区（R01）：持久化核查→写 pending→创建 全部在同一临界区内
      await xlock.request(`xp-submit:${project.id}:${node.id}`, async () => {
        if (!isCurrent()) { toast('项目、密钥或节点已变更，本次点击未提交', 'warn'); return; }
        // 等待锁期间另一标签页可能已提交：先复查内存守卫，再做持久化核查
        if (d.run?.taskId || d.run?.pendingKey) { toast('该节点已有任务或待确认的提交，请先在节点上处理', 'warn'); return; }
        if (await adoptDurable(node, isCurrent)) return;
        if (projectSavePending(project.id)) { toast('任务记录保存待恢复，已阻止新的付费提交', 'err'); return; }
        if (!isCurrent()) return;
        if (draftSignature(d.draft) !== draftAtClick || JSON.stringify([...store.edgesInto(node.id, 'refs'), ...store.edgesInto(node.id, 'frames')]) !== edgesAtClick) {
          toast('等待期间草稿或连线已修改，请确认后重新提交', 'warn'); return;
        }
        // 快照：draft + 素材 id 顺序 + 身份；上传期间用户改动不影响本次请求
        const draft = JSON.parse(JSON.stringify(d.draft));
        // 只取当前模式使用的输入口（与编辑面板展示一致），另一口的残留连线不提交
        const refsWired = wired(node.id, 'refs');
        const inputs = modeInputs(draft.intent, refsWired, wired(node.id, 'frames'));
        // 文本连线：上游文本输出 + 本节点提示词合成有效提示词；缺失的连线输出是显式问题。
        // @绑定对合并后的完整文本同步，wired 文本里的 @XN 同样固化到素材 id。
        // 绑定只是稳定映射，按全部已连接参考素材固化（切换模式/型号不丢）；实际提交与校验只用本模式输入口。
        const eff = effectivePrompt(store, node, draft.prompt);
        draft.bindings = syncPromptBindings(eff.prompt, refsWired.items, draft.bindings);
        d.draft.bindings = draft.bindings;
        const draftForSubmit = { ...draft, prompt: eff.prompt };
        // 上传前校验（pre）：型号/参数/数量/类型/模式/引用；远端与时长留待上传后
        const err = validateDraft(draft.model, draftForSubmit, inputs.refs, inputs.frames, [...inputs.problems, ...eff.problems], 'pre');
        if (err) { toast(err, 'err'); return; }

        const snap = {
          draft: draftForSubmit, refIds: inputs.refs.map(a => a.id), frameIds: inputs.frames.map(a => a.id),
          projectId: store.project.id, nodeId: node.id, keyFp: getFingerprint(), at: Date.now(),
        };
        d.run = { state: 'uploading' }; store.touch({ type: 'data', id: node.id }); onUpdate?.();
        try {
          await uploadAll([...inputs.refs, ...inputs.frames], node.id, snap.keyFp, snap.projectId, msg => { d.run = { state: 'uploading', note: msg }; onUpdate?.(); });
        } catch (e) {
          d.run = { error: e.message === '已取消' ? '已取消上传，未创建任务' : `素材上传失败：${e.message}` };
          store.touch({ type: 'data', id: node.id }); onUpdate?.();
          toast('素材未全部上传，已取消创建（草稿与素材保留）', 'warn', 5000);
          return;
        }
        // 身份复核：上传期间密钥/项目变更 → 不发新请求；记录 pending 待原密钥恢复
        if (getFingerprint() !== snap.keyFp || store.project?.id !== snap.projectId) {
          const rec = { idempotencyKey: crypto.randomUUID(), projectId: snap.projectId, nodeId: snap.nodeId,
            model: draft.model, keyFp: snap.keyFp, bodyString: null, createdAt: Date.now(),
            lastSubmitAt: null, state: 'uncertain', snapshot: snap,
            ...(accountScope ? { ownerSubject: accountScope.subject } : {}) };
          if (!await persistNewPending(rec, node)) return;
          d.run = { pendingKey: rec.idempotencyKey }; store.touch({ type: 'data', id: node.id }); onUpdate?.();
          toast('密钥或项目在上传期间已变更，本次请求未发送；切回原密钥后可在节点上点“再次确认结果”', 'warn', 6000);
          return;
        }
        // 快照完整性：上传期间被删/被换的素材必须中止创建，不得静默丢图
        const byId = id => store.project.assets[id];
        const refs = snap.refIds.map(byId), frames = snap.frameIds.map(byId);
        const lost = [...refs, ...frames].findIndex(a => !a);
        if (lost >= 0) {
          d.run = { error: '连线素材在上传期间被移除，已中止创建' };
          store.touch({ type: 'data', id: node.id }); onUpdate?.();
          toast('素材在上传期间被移除，已中止创建', 'err', 5000);
          return;
        }
        // 上传完成后强校验（post）：远端地址/有效期/服务端时长
        const postErr = validateDraft(draftForSubmit.model, draftForSubmit, refs, frames, [...inputs.problems, ...eff.problems], 'post');
        if (postErr) {
          d.run = { error: `上传后校验失败：${postErr}` };
          store.touch({ type: 'data', id: node.id }); onUpdate?.();
          toast(`上传后校验失败：${postErr}`, 'err', 5000);
          return;
        }
        let bodyString;
        try { bodyString = buildCreateBody(draftForSubmit.model, draftForSubmit, refs, frames); }
        catch (e) { d.run = { error: e.message }; store.touch({ type: 'data', id: node.id }); onUpdate?.(); toast(e.message, 'err', 5000); return; }
        const rec = {
          idempotencyKey: crypto.randomUUID(), projectId: snap.projectId, nodeId: snap.nodeId,
          model: draftForSubmit.model, bodyString, keyFp: snap.keyFp, createdAt: Date.now(), lastSubmitAt: null,
          ...(isExternalProvider(getProvider()) ? { provider: api.providerInfo?.() } : {}),
          state: 'uncertain', snapshot: snap,
          ...(accountScope ? { ownerSubject: accountScope.subject } : {}),
        };
        if (!await persistNewPending(rec, node)) return;  // 先持久化，再发送；写不进去绝不发 POST
        d.run = { pendingKey: rec.idempotencyKey, state: 'submitting' }; store.touch({ type: 'data', id: node.id });
        await doCreate(rec);
      });
    } catch (e) {
      // 锁不可用（不支持 Web Locks 的浏览器）或意外异常：保持显式错误态，不卡在 submitting
      if (!d.run?.taskId && !d.run?.pendingKey) { d.run = { error: e?.message ?? '提交失败' }; store.touch({ type: 'data', id: node.id }); onUpdate?.(); }
      toast(e?.message ?? '提交失败', 'err', 6000);
    } finally { locks.delete(node.id); onUpdate?.(); }
  }

  async function retrySubmit(node) {
    if (!node || store.node(node.id) !== node) return;
    const key = node.data.run?.pendingKey;
    if (!key) return;
    if (locks.has(node.id)) { toast('正在提交中，请稍候', 'warn'); return; }
    const project = store.project, fp = getFingerprint();
    const isCurrent = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node;
    locks.add(node.id);   // 首个 await 之前取锁，双点只进一次
    try {
      // 同一把跨标签页锁：记录状态在锁内重新读取，另一标签页的拒绝/受理结果不会漏看
      await xlock.request(`xp-submit:${project.id}:${node.id}`, async () => {
        if (!isCurrent()) { toast('项目、密钥或节点已变更，本次重试未发送', 'warn'); return; }
        const rec = await store.pendingCreate(key);
        if (!isCurrent()) return;
        if (!rec) {
          // pending 消失：可能已被其他标签页受理成任务 → 认领任务，绝不新建
          const t = (await store.tasksOfProject()).find(t => t.idempotencyKey === key);
          if (!isCurrent()) return;
          if (t) {
            node.data.run = { taskId: t.taskId }; store.touch({ type: 'data', id: node.id });
            if (!isSettled(t)) poll(t.taskId, t.projectId);
            onUpdate?.(); toast('该提交已被受理为任务，已关联现有记录', 'ok');
          } else toast('未找到待确认记录', 'err');
          return;
        }
        if (rec.state === 'rejected' || rec.state === 'conflict') { toast('该请求已被明确拒绝，请修正参数后新建提交', 'warn'); return; }
        if (rec.state === 'expired_window') { toast('已超窗的未决提交不可重发；原请求是否受理仍不可知', 'err', 6000); return; }
        if (!canRetryPending(rec)) { toast('请切回提交时使用的密钥再确认结果；换用新密钥会被当成另一次提交', 'err', 6000); return; }
        if (!rec.bodyString && rec.snapshot) {
          // 密钥在上传期间变更导致未发送：用快照重建原请求体（同 key 同体）
          const byId = id => store.project.assets[id];
          const refs = (rec.snapshot.refIds ?? []).map(byId), frames = (rec.snapshot.frameIds ?? []).map(byId);
          if (refs.some(r => !r) || frames.some(f => !f)) { toast('提交时使用的素材已被删除，无法再次确认', 'err'); return; }
          const validationError = validateDraft(rec.model, rec.snapshot.draft, refs, frames, [], 'post');
          if (validationError) { toast(`恢复素材校验失败：${validationError}`, 'err'); return; }
          try {
            rec.bodyString = buildCreateBody(rec.model, rec.snapshot.draft, refs, frames);
            await store.updatePendingCreate(rec);
          } catch (e2) { toast(`无法还原原提交内容：${e2.message}`, 'err'); return; }
        }
        if (!rec.bodyString) { toast('没有找到原提交内容，无法再次确认', 'err'); return; }
        if (Date.now() - rec.createdAt > IDEM_WINDOW_MS) { toast('已超过 24 小时，无法再确认原提交；如需重新生成，请创建新版本', 'err', 6000); return; }
        // R09：以「收到响应时刻」持久化的 retryNotBefore 为准；旧记录回退到 lastSubmitAt+retryAfterMs
        const notBefore = rec.retryNotBefore ?? (Number.isFinite(rec.retryAfterMs) && rec.lastSubmitAt ? rec.lastSubmitAt + rec.retryAfterMs : 0);
        if (notBefore && Date.now() < notBefore) {
          toast(`上游要求等待，请 ${Math.ceil((notBefore - Date.now()) / 1000)} 秒后重试`, 'warn'); return;
        }
        if (isCurrent()) await doCreate(rec);
      });
    } catch (e) {
      toast(e?.message ?? '提交锁异常', 'err', 6000);
    } finally { locks.delete(node.id); onUpdate?.(); }
  }

  // 404 次数只用于降低查询频率，绝不推断生成任务已删除。
  const V2_404_GRACE = 5;
  const QUERY_FIELDS = [
    'status', 'stage', 'executorVersion', 'contentReady', 'deliveryStatus', 'progress',
    'error', 'downloadExpiresAt', 'downloadExpired', 'cancelRequested', 'cancelPhase',
    'terminalEvidence', 'serverObservedAt', 'serverRevision', 'terminalConflict',
    'queryHealth', 'queryError', 'nextQueryAt', 'pollFails', 'notFoundPolls', 'pollError', 'authFailed',
    ...TIMING_FIELDS,
  ];

  // ---- 轮询：paused 是本地暂停标志，与服务端真实 status 分离 ----
  function poll(taskId, pid = store.project?.id, { immediate = false, force = false, resumePaused = true } = {}) {
    if (!sessionAlive()) return;
    const pk = tkey(pid, taskId);
    cancelPoll(pollers.get(pk));
    const version = (pollVersions.get(pk) ?? 0) + 1;
    pollVersions.set(pk, version);
    const current = () => pollVersions.get(pk) === version;
    const tick = async () => {
      if (!sessionAlive()) return;
      const rec = await recOf(taskId, pid); if (!rec || !isSupportedTaskRecord(rec)) return;
      if (!current()) return;
      // 跨标签页较新的本地暂停/脱离以持久稿为准；待保存的内存终态不得被旧稿覆盖。
      try {
        const stored = await store.taskIn(pid, taskId);
        if (stored && !pendingSaves.has(pk) && (stored.rev ?? 0) > (rec.rev ?? 0)) Object.assign(rec, stored);
      } catch { /* 已有记录仍可查询，写失败由独立保存重试处理 */ }
      if (!isSupportedTaskRecord(rec)) return;
      // 本地落盘失败不杀死轮询：内存记录不丢、不串任务，标记 pollError 后按退避继续——
      // 存储恢复后下一次 putRec 自然收敛（saveTask 写侧对账保证不丢单调状态）
      const persist = async (fields = QUERY_FIELDS) => {
        try { await putRec(rec, fields); return true; }
        // 落盘失败始终刷新文案（覆盖同 tick 的网络错误可接受：落盘失败意味着记录未达磁盘，
        // 是比查询错误更需可见的本地状态；网络侧影响已由 pollFails/退避表达）
        catch (pe) { rec.pollError = `本地落盘失败：${pe?.message ?? pe}`; return false; }
      };
      if (!canQueryTask(rec) || store.project?.id !== rec.projectId) { // 换账户/切项目 → 暂停
        rec.paused = true; rec.pauseSource = 'identity'; await persist(['paused', 'pauseSource']); return;
      }
      if ((rec.paused || rec.authFailed) && resumePaused) {
        rec.paused = false; rec.authFailed = false; rec.pauseSource = null;
        if (!await persist(['paused', 'authFailed', 'pauseSource'])) return;
      }
      if (rec.paused || rec.authFailed) return;
      if (isSettled(rec) && !force) return;
      let delay = 6000;
      try {
        const cur = await api.getTask(taskId);
        if (!current() || !sessionAlive()) return;
        if (accountScope && !rec.ownerSubject) rec.ownerSubject = accountScope.subject;
        rec.pollError = null; rec.pollFails = 0; rec.authFailed = false; rec.notFoundPolls = 0;
        rec.queryHealth = 'ok'; rec.queryError = null; rec.nextQueryAt = null;
        const wasSettled = isSettled(rec), previousObservedAt = rec.serverObservedAt;
        mergeTaskResponse(rec, cur);   // 单调合并：终态不被迟到旧响应回退，contentReady/cancelRequested 粘性
        noteTaskTiming(rec, cur, { wasSettled, previousObservedAt });   // 服务端时间与首次观测到结束的时刻（耗时展示）
        rec.serverObservedAt = Date.now();
        if (!await persist(accountScope ? [...QUERY_FIELDS, 'ownerSubject'] : QUERY_FIELDS)) {
          rec.pollFails = (rec.pollFails ?? 0) + 1; delay = Math.min(30000, delay * 2 ** Math.min(4, rec.pollFails));
        }
      } catch (e) {
        if (!current() || !sessionAlive()) return;
        rec.pollFails = (rec.pollFails ?? 0) + 1; rec.pollError = e.message;
        rec.queryError = { status: e.status ?? null, code: e.code ?? '', message: e.message ?? '查询失败' };
        if (e.status === 404) {
          rec.notFoundPolls = (rec.notFoundPolls ?? 0) + 1;
          rec.queryHealth = rec.notFoundPolls >= V2_404_GRACE ? 'needs_review' : 'retrying';
        }
        else if (e.status === 410) {
          rec.notFoundPolls = 0;
          rec.queryHealth = 'needs_review'; // GET 410 的资源范围不明，不伪造视频生成终态
          if (e.code === 'content_expired') rec.downloadExpired = true;
        }
        else if (e.status === 401 || e.status === 403) {
          // 鉴权失败不是暂时性错误：暂停轮询并保留任务；密钥更新后由 resumeAll/显式 poll 仅恢复查询
          rec.notFoundPolls = 0; rec.paused = true; rec.pauseSource = 'auth'; rec.authFailed = true; rec.queryHealth = 'auth_required';
        }
        else { rec.notFoundPolls = 0; rec.queryHealth = 'retrying'; }
        delay = Math.min(60000, 6000 * 2 ** Math.min(4, rec.pollFails));
        if (rec.queryHealth === 'needs_review') delay = Math.max(delay, 60000);
        if (Number.isFinite(e.retryAfter)) delay = Math.max(delay, e.retryAfter * 1000);
        rec.nextQueryAt = rec.paused ? null : Date.now() + delay;
        await persist(rec.paused ? [...QUERY_FIELDS, 'paused', 'pauseSource'] : QUERY_FIELDS);
      }
      if (current() && sessionAlive() && !rec.paused && !rec.terminalConflict && !isSettled(rec))
        pollers.set(pk, pollLater(tick, delay));
    };
    pollers.set(pk, pollLater(tick, immediate ? 0 : 1200));
  }

  // 启动恢复：先载任务（幂等键→任务 为权威映射），再扫 pending；
  // 已受理的任务记录优先于节点上残留的陈旧 pendingKey（崩溃于清 pending/写节点之间时自愈）。
  async function resumeAll() {
    const project = store.project;              // 捕获启动时项目：每个 await 后仍是当前项目才写节点/轮询
    const live = () => sessionAlive() && store.project === project;
    const tasks = await store.tasksOfProject();
    if (!live()) return;
    const byIdem = new Map(tasks.filter(t => t.idempotencyKey).map(t => [t.idempotencyKey, t]));
    for (const r of await store.listPending()) {
      if (!live()) return;
      const node = store.node(r.nodeId);
      if (!node) continue;
      const accepted = byIdem.get(r.idempotencyKey);
      if (accepted) {
        if (accepted.detached) continue;
        // 已受理为权威；不覆盖节点上另一个活动任务
        if (node.data.run?.taskId === accepted.taskId || (!node.data.run?.taskId && (!node.data.run?.pendingKey || node.data.run.pendingKey === r.idempotencyKey))) node.data.run = { taskId: accepted.taskId };
      } else if (r.state === 'rejected') {
        // 已明确拒绝：不恢复守卫，节点可修正后新建
      } else if (r.state === 'abandoned' && provablyUnsent(r)) {
        // 已显式解除且可证明从未发送：不再恢复禁发守卫（兼容旧版 abandoned 标记的遗留记录）
      } else if (r.state === 'expired_window') {
        // R02：超窗未决仍是持久化事实，导入/重开后也必须恢复禁发守卫
        if (!node.data.run?.taskId && (!node.data.run?.pendingKey || node.data.run.pendingKey === r.idempotencyKey)) node.data.run = pendingGuardRun(r, true);
      } else if (!node.data.run?.taskId && (!node.data.run?.pendingKey || node.data.run.pendingKey === r.idempotencyKey)) {
        node.data.run = pendingGuardRun(r, node.data.run?.detached);
      }
    }
    for (const t of tasks) {
      if (!live()) return;
      if (t.status === 'need_key') { t.status = 'queued'; t.paused = true; t.pauseSource = 'identity'; } // 旧记录明确为需原密钥
      cache.set(tkey(t.projectId, t.taskId), t);
      const node = store.node(t.nodeId);
      if (node && !t.detached) {
        if (node.data.run?.pendingKey === t.idempotencyKey) node.data.run = { taskId: t.taskId }; // 已受理为权威
        else if (!node.data.run?.taskId && !node.data.run?.pendingKey) node.data.run = { taskId: t.taskId };
      }
      if (!isSupportedTaskRecord(t) || isSettled(t)) continue;
      // 先保留用户暂停或来源不明的旧暂停；换密钥不能把它改写成可自动恢复的身份暂停。
      if (t.paused && t.pauseSource !== 'identity') continue;
      if (!canQueryTask(t)) { t.paused = true; t.pauseSource = 'identity'; await putRec(t, ['paused', 'pauseSource']); continue; }
      // 401/403 鉴权失败为粘性状态：无身份更新时 resumeAll 不得反复唤醒空转；
      // 仅用户显式恢复（runner.poll）或换用新密钥身份后的明确动作才重启 GET
      if (t.authFailed) { if (!t.paused) { t.paused = true; t.pauseSource = 'auth'; await putRec(t, ['paused', 'pauseSource']); } continue; }
      poll(t.taskId, t.projectId);
    }
    onUpdate?.();
  }

  // ---- 下载：严格 video/*，结果入库为可连线素材 ----
  // 幂等：同任务并发/重复调用共享同一进行中下载；已入库素材+blob 有效直接复用；
  // 素材在但本地 blob 缺失时优先用已下载的结果 blob 修复，绝不重复注册素材。
  const downloads = new Map();   // `${projectId}:${taskId}` → 进行中的下载 Promise
  async function download(taskId) {
    // 固定下载开始时的项目/密钥身份（含 recOf 之前）；任何 await 后变更 → 结果只留原任务记录，延后关联
    const project = store.project, fp = getFingerprint();
    const stale = () => !sessionAlive() || getFingerprint() !== fp || store.project !== project;
    const defer = async rec => { rec.resultDeferred = true; await putRec(rec, ['resultDeferred']); toast('密钥或项目已变更，下载结果保留在原任务记录，未写入当前项目', 'warn', 6000); return null; };
    const rec = await recOf(taskId, project?.id); if (!rec) return null;
    if (!isSupportedTaskRecord(rec)) { toast('任务记录版本高于当前客户端，已停止改写和下载', 'err'); return null; }
    if (!project || rec.projectId !== project.id) { toast('任务记录与当前项目不一致，未下载', 'err'); return null; }
    if (stale()) return defer(rec);
    const local = await localResult(taskId, project.id);
    if (stale()) return defer(rec);
    if (!canQueryTask(rec) && !local.ready) { toast('当前账户不能访问该任务', 'err'); return null; }
    if (!local.ready && !canFetchContent(rec)) { toast('原任务远端不可下载且本地成片缺失；不会重新生成', 'warn'); return null; }
    const k = tkey(rec.projectId, taskId);
    if (downloads.has(k)) return downloads.get(k);
    const p = doDownload(rec, project, stale, defer);
    downloads.set(k, p);
    try { return await p; } finally { downloads.delete(k); }
  }

  async function doDownload(rec, project, stale, defer) {
    const { taskId } = rec;
    const checkedLocal = await localResult(taskId, rec.projectId);
    const resultKey = (ownedResultKey(rec.resultBlobId, rec.projectId, taskId) ? rec.resultBlobId : null)
      ?? (checkedLocal.ready && checkedLocal.source === 'result' ? checkedLocal.key : null)
      ?? `result:${rec.projectId}:${taskId}`;
    if (rec.projectId !== project?.id) return null;   // 命名空间错乱的记录不得在别的项目下入库
    // 三条成功分支（新素材入库/已入库复用/本地 blob 缺失修复）共用的落盘收尾：
    // 仅当仍是原项目+原密钥时把节点关联写进当前项目，并立即 flush——素材元信息与
    // 节点关联随项目文档先落盘，成功后再持久化 任务→素材 关联（按 rec.projectId
    // 命名空间，与当前项目无关）——全部落盘才返回 true，绝不只 toast 却报成功。
    // flush/putRec 抛错由外层 catch 统一转 null：已下载结果 blob、已注册素材与
    // rec 缓存全部保留，重试按 resultBlobId/fromTask/节点关联找回，只补齐落盘。
    const finalize = async (asset, okMsg) => {
      if (stale()) return defer(rec);                // 切项目/换钥：结果保留在原任务记录，不触碰新项目
      const n = store.node(rec.nodeId);
      const durableProject = await storage.get('project:' + rec.projectId);
      if (stale()) return defer(rec);
      const durableNode = durableProject?.nodes?.find(x => x.id === rec.nodeId);
      // A1：仅在节点当前仍绑定本任务且关联未撤销时写回节点输出；已脱离/重绑其他任务
      // 的节点不得被旧任务结果改写——结果仍存原任务记录与素材库，重试按 fromTask/任务关联找回
      const oldAssetId = n?.data?.resultAssetId;
      const durableRun = durableNode?.data?.run;
      const attached = canAttachResult(rec, n) && (!durableRun
        || (!durableRun.taskId && !durableRun.pendingKey) || canAttachResult(rec, durableNode));
      if (attached && n.data.resultAssetId !== asset.id) { n.data.resultAssetId = asset.id; store.touch({ type: 'data', id: n.id }); }
      try { await store.flush(); }                    // 外部抢先重绑会触发项目 CAS 拒写
      catch (e) {
        if (attached && n?.data?.resultAssetId === asset.id) n.data.resultAssetId = oldAssetId;
        throw e;
      }
      rec.resultAssetId = asset.id;                  // 先写回缓存对象：即便 putRec 失败，重试仍能按关联找回同一素材
      if (rec.resultDeferred) delete rec.resultDeferred;   // 已正式入库，旧的「结果待关联」标记作废
      await putRec(rec, ['resultAssetId', 'resultBlobId', 'resultType', 'resultDeferred']);
      if (okMsg && !stale()) toast(okMsg, 'ok');
      return true;
    };
    try {
      if (stale()) return defer(rec);
      // 已入库素材复用：必须确属本任务——kind=video 且 fromTask/任务记录关联指向本 taskId；
      // 节点当前 resultAssetId 可能已被其他任务改写，仅凭它不能冒充本任务成片。
      const node0 = store.node(rec.nodeId);
      const linkedId = rec.resultAssetId ?? node0?.data?.resultAssetId ?? null;
      let existing = linkedId ? project.assets?.[linkedId] ?? null : null;
      if (existing && !(existing.kind === 'video' && (existing.fromTask
        ? existing.fromTask === taskId : rec.resultAssetId === existing.id)))
        existing = null;
      if (!existing)
        // 部分入库恢复：上次注册成功但任务关联未落盘/进程重开 → 按 fromTask 找回同一素材复用，绝不重复注册
        existing = Object.values(project.assets ?? {}).find(a => a?.kind === 'video' && a.fromTask === taskId) ?? null;
      if (existing) {
        const hasBlob = checkedLocal.ready && checkedLocal.source === 'asset' && checkedLocal.assetId === existing.id;
        if (stale()) return defer(rec);
        if (hasBlob) {
          if (existing.missing) { existing.missing = false; delete existing.deletedAt; store.touch({ type: 'data' }); }
          return await finalize(existing);
        }
        // 素材在但 blob 缺失：优先用已下载结果 blob 修复；结果 blob 也缺失才重新 GET
        let blob = await storage.getBlob(resultKey).catch(() => null);
        if (stale()) return defer(rec);
        if (!blob || !blob.size) {
          if (!canFetchContent(rec)) { toast('本地文件缺失，原任务远端不可恢复', 'err'); return null; }
          const dl = await api.downloadContent(taskId);
          if (stale()) return defer(rec);
          if (!['video/mp4', 'video/webm'].includes(dl.contentType)) { toast(`返回类型非视频：${dl.contentType}`, 'err'); return null; }
          blob = dl.blob;
          await storage.setBlob(resultKey, blob);
          if (stale()) return defer(rec);
        }
        await storage.setBlob(`blob:${existing.id}`, blob);
        if (stale()) return defer(rec);
        existing.missing = false; delete existing.deletedAt;
        existing.size = blob.size;
        if (blob.type) existing.mime = blob.type;
        store.touch({ type: 'data' });
        rec.resultBlobId = resultKey;
        if (blob.type) rec.resultType = blob.type;
        return await finalize(existing, '成片已恢复到本地素材');
      }
      // 尚无入库素材：结果 blob 仍在 → 直接注册不重复 GET；否则鉴权下载后入库
      let blob = await storage.getBlob(resultKey).catch(() => null);
      if (stale()) return defer(rec);            // 缓存读取期间切项目/换钥 → 绝不继续入册
      let contentType = rec.resultType ?? null;
      if (!blob || !blob.size) {
        if (!canFetchContent(rec)) { toast('本地文件缺失，原任务远端不可恢复', 'err'); return null; }
        const dl = await api.downloadContent(taskId);
        if (stale()) return defer(rec);
        if (!['video/mp4', 'video/webm'].includes(dl.contentType)) { toast(`返回类型非视频：${dl.contentType}`, 'err'); return null; }
        blob = dl.blob; contentType = dl.contentType;
        await storage.setBlob(resultKey, blob);
        if (stale()) return defer(rec);
        rec.resultBlobId = resultKey; rec.resultType = contentType;
        await putRec(rec, ['resultBlobId', 'resultType']); // 结果 blob 落盘事实先行持久化
        if (stale()) return defer(rec);
      } else contentType = blob.type || contentType || 'video/mp4';
      if (stale()) return defer(rec);            // 注册前最后核验（含缓存 blob 分支）：切走后不入册新项目
      // 产出落成素材（registerBlob 内部按其起始项目绑定，期间切走会抛错并回收 blob）
      const a = await assets.registerBlob(blob, `成片-${taskId.slice(0, 8)}.${contentType === 'video/webm' ? 'webm' : 'mp4'}`, 'video', { fromTask: taskId }, { project });
      // 注册完成后才切换由 finalize 首行核验转 defer：保留原项目素材与已下载文件，
      // 后续按 fromTask 找回同一素材复用；绝不删除已持久化结果，也绝不写进新项目。
      return await finalize(a, '成片已下载并加入素材库');
    } catch (e) {
      if (stale()) return defer(rec);
      toast(`下载失败：${e.message}`, 'err', 5000); return null;
    }
  }
  // 元数据只是线索；本地使用前核验实体、类型、字节与任务归属。导入工程可能只含
  // 素材 blob，也可能结果 blob 与素材 blob 使用不同键，因此分别读取。
  const ownedResultKey = (key, pid, taskId) =>
    key === `result:${pid}:${taskId}` || key === `result:${taskId}`;
  async function localResult(taskId, pid = store.project?.id) {
    const rec = await recOf(taskId, pid);
    if (!rec || rec.projectId !== pid) return { ready: false, reason: 'task_missing' };
    if (!isSupportedTaskRecord(rec)) return { ready: false, reason: 'task_record_version_unsupported' };
    const project = store.project?.id === pid ? store.project : await storage.get('project:' + pid);
    let asset = rec.resultAssetId ? project?.assets?.[rec.resultAssetId] : null;
    if (!asset) asset = Object.values(project?.assets ?? {}).find(a => a?.kind === 'video' && a.fromTask === taskId) ?? null;
    if (asset && (asset.kind !== 'video' || (asset.fromTask && asset.fromTask !== taskId)
      || (!asset.fromTask && rec.resultAssetId !== asset.id))) asset = null;
    const keys = [...new Set([
      asset ? 'blob:' + asset.id : null,
      ownedResultKey(rec.resultBlobId, pid, taskId) ? rec.resultBlobId : null,
      'result:' + pid + ':' + taskId, 'result:' + taskId,
    ].filter(Boolean))];
    for (const key of keys) {
      let blob = null;
      try { blob = await storage.getBlob(key); } catch { continue; }
      if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) continue;
      if (key.startsWith('blob:') && Number.isFinite(asset?.size) && asset.size > 0 && blob.size !== asset.size) continue;
      const type = (blob.type || (key.startsWith('blob:') ? asset?.mime : rec.resultType) || '').toLowerCase();
      if (!['video/mp4', 'video/webm'].includes(type)) continue;
      if (typeof blob.slice === 'function') {
        const head = new TextDecoder().decode(await blob.slice(0, 64).arrayBuffer()).trimStart();
        if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) continue;
      }
      return { ready: true, source: key.startsWith('blob:') ? 'asset' : 'result', key, assetId: asset?.id ?? null, blob };
    }
    return { ready: false, reason: keys.length ? 'missing_or_invalid_blob' : 'no_local_reference' };
  }
  async function resultURL(taskId, pid = store.project?.id) {
    const local = await localResult(taskId, pid);
    if (!local.ready) return null;
    const url = URL.createObjectURL(local.blob);
    resultURLs.add(url);
    return url;
  }
  function releaseResultURL(url) {
    if (resultURLs.delete(url)) URL.revokeObjectURL(url);
  }

  // 本地「停止等待/继续查询」：与服务端取消不同，只控制本端 GET 轮询节奏；
  // 暂停不删除任务记录，继续查询即恢复轮询（密钥不一致仍按既有守卫保持暂停）
  async function setPollPaused(taskId, paused, pid = store.project?.id) {
    const rec = await recOf(taskId, pid); if (!rec) return;
    rec.paused = Boolean(paused);
    rec.pauseSource = paused ? 'manual' : null;
    if (!paused) rec.authFailed = false;
    await putRec(rec, ['paused', 'authFailed', 'pauseSource']);
    const pk = tkey(rec.projectId, taskId);
    if (paused) { cancelPoll(pollers.get(pk)); pollVersions.set(pk, (pollVersions.get(pk) ?? 0) + 1); }
    else if (!isSettled(rec)) poll(taskId, rec.projectId, { immediate: true });
  }

  // 明确的原任务重新查询：只读 GET；不改变 taskId、幂等键或原请求正文。
  async function requery(taskId, pid = store.project?.id) {
    const rec = await recOf(taskId, pid);
    if (!rec || rec.projectId !== pid) return { started: false, reason: 'task_missing' };
    if (!isSupportedTaskRecord(rec)) return { started: false, reason: 'task_record_version_unsupported' };
    if (store.project?.id !== pid || !canQueryTask(rec))
      return { started: false, reason: 'identity_changed' };
    rec.paused = false; rec.authFailed = false;
    rec.pauseSource = null;
    rec.queryHealth = 'retrying'; rec.nextQueryAt = Date.now();
    try { await putRec(rec, ['paused', 'authFailed', 'pauseSource', 'queryHealth', 'nextQueryAt']); }
    catch { return { started: false, reason: 'local_save_pending' }; }
    poll(taskId, pid, { immediate: true, force: true });
    return { started: true };
  }

  // 停止后续渠道尝试（仅 executor_version=2）：双击幂等（节点锁 + cancelRequested/cancelInFlight 去重），
  // 与生成锁同为节点级互斥但绝不嵌套等待，不会死锁；密钥/项目变更只暂停不发送。
  // 取消成功不直接把本地标 cancelled——以响应 status 为准继续跟踪；
  // 409 表示已撞终态 → 刷新原任务；网络异常只提示未确认，绝不重新生成。
  async function cancelTask(node) {
    if (!node || store.node(node.id) !== node) return;
    const taskId = node.data.run?.taskId;
    if (!taskId) return;
    if (locks.has(node.id)) { toast('该节点操作进行中，请稍候', 'warn'); return; }
    locks.add(node.id);
    try {
      const rec = await recOf(taskId);
      if (!rec || rec.projectId !== store.project?.id) return;
      if (!isSupportedTaskRecord(rec)) { toast('任务记录版本高于当前客户端，已停止改写', 'err'); return; }
      if (rec.executorVersion !== 2) { toast('该任务不是多渠道 v2 任务，保持「停止等待」即可', 'warn'); return; }
      if (isSettled(rec)) { toast('任务已进入终态', 'warn'); return; }
      if (rec.cancelRequested) { toast('已请求停止后续尝试，按任务状态继续跟踪', 'warn'); return; }
      if (!canQueryTask(rec)) { rec.paused = true; await putRec(rec, ['paused']); toast('当前账户与任务不一致，已暂停查询', 'warn'); return; }
      const cur = await api.cancelTask(taskId);
      if (isSettled(rec)) { toast('任务已结束，保留最新终态', 'ok'); return; }
      // 刚发出取消请求：响应未显式携带 cancel_requested 时按已请求计（原行为）
      const wasSettled = isSettled(rec), previousObservedAt = rec.serverObservedAt;
      mergeTaskResponse(rec, { ...cur, cancel_requested: cur.cancel_requested ?? true });
      noteTaskTiming(rec, cur, { wasSettled, previousObservedAt });
      delete rec.cancelInFlight;
      await putRec(rec, QUERY_FIELDS);
      if (!isSettled(rec)) poll(taskId, rec.projectId);
      toast('已请求停止后续尝试；当前上游仍可能完成，若可交付成功仍按原价收费', 'ok', 6000);
    } catch (e) {
      const rec = await recOf(taskId).catch(() => null);
      if (rec) delete rec.cancelInFlight;
      if (e?.status === 409) {
        if (rec) { rec.pollError = '取消与终态冲突，已刷新任务状态'; await putRec(rec, ['pollError']); }
        poll(taskId, rec?.projectId ?? store.project?.id);   // 终态冲突：刷新原任务，绝不新 POST
        toast('任务已进入终态，正在刷新状态', 'warn');
      } else if (e?.code === 'cancel_unsupported') {
        toast('托管版暂不支持服务端取消；任务仍可查询和下载', 'warn');
      } else {
        if (rec) { rec.pollError = `取消结果未确认：${e.message}`; await putRec(rec, ['pollError']); }
        toast(`取消结果未确认（${e.message}）；任务仍在跟踪，切勿重新提交`, 'warn', 6000);
      }
    } finally { locks.delete(node.id); onUpdate?.(); }
  }

  // ---- 找回（R05/R13）：从持久化任务/待决记录恢复或重建关联节点。绝不发起 POST。----
  // 仅展示用安全草稿：snapshot.draft 优先，否则解析原始 bodyString；不用于重发
  // （重试始终走原 bodyString/原幂等键，这里只还原用户可读的参数）。
  function displayDraft(rec) {
    const base = { model: rec.model ?? 'minimax-h3-768p-per-second', intent: 'text', seconds: 5, ratio: '16:9', prompt: '', switches: {}, bindings: {} };
    const snap = rec.snapshot?.draft;
    if (snap && typeof snap === 'object')
      return { ...base, ...JSON.parse(JSON.stringify(snap)), model: rec.model ?? snap.model ?? base.model };
    try {
      const b = JSON.parse(rec.bodyString);
      if (b && typeof b === 'object') {
        if (typeof b.prompt === 'string') base.prompt = b.prompt;
        if (Number.isFinite(b.seconds)) base.seconds = Math.round(b.seconds);
        const md = b.metadata;
        if (md && typeof md === 'object') {
          if (typeof md.ratio === 'string') base.ratio = md.ratio;
          const mode2intent = { text_to_video: 'text', references: 'refs', omni_reference: 'refs', frames: 'frames', image_to_video: 'i2v' };
          if (mode2intent[md.mode]) base.intent = mode2intent[md.mode];
          // 仅 bodyString 无 snapshot 的恢复：frames 请求体只带 last_frame_url → 还原 last_frame 意图；
          // 型号未声明支持时回落 frames（由提交校验如实报错），绝不把 last_frame 泄漏到不支持型号
          if (md.mode === 'frames' && typeof md.last_frame_url === 'string' && md.last_frame_url && md.first_frame_url == null)
            base.intent = supportsLastFrameOnly(base.model) ? 'last_frame' : 'frames';
          base.switches = {
            ...(typeof md.generate_audio === 'boolean' ? { generate_audio: md.generate_audio } : {}),
            ...(typeof md.face_mode === 'boolean' ? { face_mode: md.face_mode } : {}),
          };
        }
      }
    } catch { /* 展示兜底：解析失败用默认草稿 */ }
    return base;
  }

  // 按 taskId 找回：已受理任务 → 恢复原节点（若空闲）或重建展示节点；不覆盖另一活动 run。
  async function restoreTask(taskId, pid = store.project?.id) {
    const project = store.project, fp = getFingerprint();
    const isCurrent = () => store.project === project && getFingerprint() === fp;
    if (!pid || !taskId || pid !== project?.id) return null;
    const rec = await recOf(taskId, pid);
    if (!isCurrent() || !rec || rec.projectId !== pid || !isSupportedTaskRecord(rec)) return null;
    for (const n of store.project?.nodes ?? [])
      if (n.type === 'gen' && n.data.run?.taskId === taskId) return n;   // 已有节点持有该任务
    let node = rec.nodeId ? store.node(rec.nodeId) : null;
    if (node && node.type !== 'gen') node = null;
    if (node && (locks.has(node.id) || node.data.run?.state || node.data.run?.taskId || (node.data.run?.pendingKey && node.data.run.pendingKey !== rec.idempotencyKey))) node = null;
    if (node) {
      node.data.run = { taskId };
      store.touch({ type: 'data', id: node.id });
    } else {
      node = store.addNode('gen', 140, 140, { title: '找回的生成任务', draft: displayDraft(rec), perModel: {}, run: { taskId } });
    }
    rec.nodeId = node.id; rec.detached = false;                          // 持久化恢复后的关联
    await putRec(rec, ['nodeId', 'detached']);
    if (!isCurrent()) return null;
    await store.flush();
    if (!isCurrent()) return null;
    if (!isSettled(rec)) poll(taskId, pid);
    return node;
  }

  // 按幂等键找回：已受理任务优先于残留 pending；rejected 只还原拒绝态（不发新 POST），
  // conflict/expired_window 恢复禁发守卫，uncertain/abandoned 恢复同键重试入口。
  async function restorePending(idempotencyKey, pid = store.project?.id) {
    const project = store.project, fp = getFingerprint();
    const isCurrent = () => store.project === project && getFingerprint() === fp;
    if (!pid || !idempotencyKey || pid !== project?.id) return null;
    const accepted = (await store.tasksOfProject()).find(t => t.idempotencyKey === idempotencyKey);
    if (!isCurrent()) return null;
    if (accepted) {
      if (!isSupportedTaskRecord(accepted)) return null;
      try { await store.clearPendingCreate({ projectId: pid, idempotencyKey }); } catch { /* 残留无害 */ }
      if (!isCurrent()) return null;
      return restoreTask(accepted.taskId, pid);
    }
    const rec = await store.pendingCreateIn(pid, idempotencyKey);
    if (!isCurrent() || !rec) return null;
    for (const n of store.project?.nodes ?? [])
      if (n.type === 'gen' && n.data.run?.pendingKey === idempotencyKey) return n;
    const runFor = r => r.state === 'rejected' ? { rejected: true, error: r.lastError } : pendingGuardRun(r);
    let node = rec.nodeId ? store.node(rec.nodeId) : null;
    if (node && node.type !== 'gen') node = null;
    if (node && (locks.has(node.id) || node.data.run?.state || node.data.run?.taskId || (node.data.run?.pendingKey && node.data.run.pendingKey !== idempotencyKey))) node = null;
    if (node) {
      node.data.run = runFor(rec);
      store.touch({ type: 'data', id: node.id });
    } else {
      node = store.addNode('gen', 140, 140, { title: '找回的提交', draft: displayDraft(rec), perModel: {}, run: runFor(rec) });
    }
    rec.nodeId = node.id;                                                // 持久化恢复后的关联（原 key/body 不动）
    await store.updatePendingCreate(rec);
    if (!isCurrent()) return null;
    await store.flush();
    if (!isCurrent()) return null;
    onUpdate?.();
    return node;
  }

  return {
    submit, retrySubmit, poll, requery, resumeAll, download, localResult, resultURL, releaseResultURL, recOf, wired, cancelUpload,
    restoreTask, restorePending, cancelTask, setPollPaused,
    // 跨标签页/重开的持久化认领（集成点：workflow.execGen 预检调用，传 isCurrent）。
    // 只读持久化记录并关联到节点，绝不发起付费请求；submit 内部仍在锁内复核，为最终兜底。
    adoptDurable,
    submitLockScope: xlock.scope ?? 'injected',
    accountSubject: accountScope?.subject ?? null,
    stopForIdentityChange() {
      disposed = true;
      for (const id of pollers.values()) cancelPoll(id);
      pollers.clear();
      for (const [pk, version] of pollVersions) pollVersions.set(pk, version + 1);
      for (const id of saveTimers.values()) cancelSave(id);
      saveTimers.clear();
      for (const ac of aborts.values()) ac.abort();
      aborts.clear();
      for (const url of resultURLs) URL.revokeObjectURL(url);
      resultURLs.clear();
      return { pendingLocalSaves: pendingSaves.size };
    },
    taskPeek: (id, pid) => cache.get(tkey(pid ?? store.project?.id, id)) ?? null,
    taskLive: (id, pid) => { const r = cache.get(tkey(pid ?? store.project?.id, id)); return r ? !isSettled(r) : false; },
    canDownload: (id, pid) => canFetchContent(cache.get(tkey(pid ?? store.project?.id, id))),
    isBusy: id => locks.has(id),
    // 提交时需要先上传的素材数（与 uploadAll 同一判定：远端无效/过期才上传），供按钮文案如实反映将要发生的动作
    uploadCount: id => {
      const inputs = modeInputs(store.node(id)?.data?.draft?.intent, wired(id, 'refs'), wired(id, 'frames'));
      return [...inputs.refs, ...inputs.frames].filter(a => !assets.remoteValid(a)).length;
    },
    // 节点脱离：任务/未确认记录不删除。未确认提交必须保留 pendingKey guard——
    // 只允许停止本地等待或同键重试，绝不允许换键重发造成重复收费。
    async detach(node) {
      const d = node.data, run = d.run, project = store.project, fp = getFingerprint();
      const isCurrent = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node && d.run === run;
      try {
        if (run?.pendingKey) {
          const r = await store.pendingCreateIn(project.id, run.pendingKey);
          if (!isCurrent()) return false;
          if (r) { if (r.state === 'uncertain') r.state = 'abandoned'; await store.updatePendingCreate(r); }
          if (!isCurrent()) return false;
          d.run = { ...run, pendingKey: run.pendingKey, detached: true };
          store.touch({ type: 'data', id: node.id }); onUpdate?.();
          toast('已暂停等待。原提交结果仍待确认，记录保留；24 小时内可随时再次确认结果', 'warn', 6000);
          return true;
        }
        if (run?.taskId) {
          const r = await recOf(run.taskId, project.id);
          if (!isCurrent()) return false;
          if (r) {
            if (!TASK_TERMINAL.has(r.status)) toast('任务仍在进行，已保留在任务列表；节点解除关联', 'warn');
            if (r.nodeId === node.id) { r.detached = true; await putRec(r, ['detached']); }
          }
        }
        if (!isCurrent()) return false;
        d.run = null; store.touch({ type: 'data', id: node.id }); onUpdate?.();
        return true;
      } catch (e) { toast(`解除关联保存失败：${e.message}，原状态已保留`, 'err', 6000); return false; }
    },
    // 解除提交保护：与提交/重试共用同一把 xp-submit 跨标签页锁——另一实例持锁提交时本函数排队，
    // 锁内重读持久化事实并复核当前 项目/密钥/节点/记录状态，绝不在在途提交期间放行。
    // 可证明未发送（bodyString 从未成形且未到达发送点）的记录：显式解除即真正清除，
    // 不沿用 abandoned（其语义是「已发送但脱离」，不等于没发），也不会被 adoptDurable/resumeAll 重新武装。
    // 有完整请求体的旧记录（lastSubmitAt 缺失不能证明没发过）仍守 24h 幂等窗；
    // 超窗也无法证明未受理——标记 expired_window 但 guard 永留，确需新任务请删除节点重建。
    async releasePending(node) {
      if (!node || store.node(node.id) !== node) return;
      const key = node.data.run?.pendingKey; if (!key) return;
      if (locks.has(node.id)) { toast('正在提交中，请稍候', 'warn'); return; }
      const project = store.project, fp = getFingerprint();
      if (!project) return;
      const isCurrent = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node;
      locks.add(node.id);
      try {
        await xlock.request(`xp-submit:${project.id}:${node.id}`, async () => {
          const r = await store.pendingCreateIn(project.id, key);
          if (!isCurrent()) return;
          if (!r) {
            // pending 已被清理：可能已被其他标签页受理为任务 → 认领；都没有才解除
            const t = (await store.tasksOfProject()).find(t => t.idempotencyKey === key);
            if (!isCurrent() || node.data.run?.pendingKey !== key) return;
            if (t) {
              node.data.run = { taskId: t.taskId }; store.touch({ type: 'data', id: node.id });
              if (!t.authFailed && !isSettled(t)) poll(t.taskId, t.projectId);
              onUpdate?.(); toast('该提交已被受理为任务，已关联现有记录', 'ok');
            } else {
              node.data.run = null; store.touch({ type: 'data', id: node.id });
              onUpdate?.(); toast('没有找到待确认的记录，已解除限制', 'ok');
            }
            return;
          }
          // 可证明未发送：记录从未成形请求体、从未到达发送点 → 真正清除，不沿用 abandoned
          if (provablyUnsent(r)) {
            await store.clearPendingCreate({ projectId: project.id, idempotencyKey: key });
            if (!isCurrent()) return;
            if (node.data.run?.pendingKey === key) { node.data.run = null; store.touch({ type: 'data', id: node.id }); }
            onUpdate?.();
            toast('确认原请求没有发出，已解除限制，可以重新提交', 'ok', 5000);
            return;
          }
          if (r.state === 'rejected') {
            if (node.data.run?.pendingKey === key) { node.data.run = null; store.touch({ type: 'data', id: node.id }); onUpdate?.(); }
            toast('原提交已被服务器拒绝，修改后可以重新提交', 'warn', 5000);
            return;
          }
          if (Date.now() - r.createdAt <= IDEM_WINDOW_MS) { toast('原提交还在 24 小时确认期内，不能直接放弃；请先点“再次确认结果”查看服务器是否已受理', 'warn', 5000); return; }
          r.state = 'expired_window'; await store.updatePendingCreate(r);
          if (!isCurrent()) return;
          if (node.data.run?.pendingKey === key) { node.data.run = { pendingKey: key, detached: true, expired: true }; store.touch({ type: 'data', id: node.id }); }
          onUpdate?.();
          toast('已超过 24 小时，无法确认原提交是否被受理，此节点保持禁止新建；如需重新生成，请创建新版本', 'warn', 7000);
        });
      } catch (e) {
        toast(`检查失败：${e.message}；原状态保留`, 'err', 6000);
      } finally { locks.delete(node.id); onUpdate?.(); }
    },
  };
}

// ---------------- 节点 body ----------------

// 每个页面会话对同一任务最多自动取片一次；失败后保留显式下载按钮，避免重绘触发GET风暴。
const previewDownloads = new WeakMap();
function releaseWhenRemoved(element, url, runner) {
  if (typeof MutationObserver !== 'function' || !document?.documentElement) return;
  let mounted = element.isConnected;
  const release = () => { observer.disconnect(); runner.releaseResultURL?.(url); };
  const observer = new MutationObserver(() => {
    if (element.isConnected) mounted = true;
    else if (mounted) release();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setTimeout(() => { if (!element.isConnected) release(); }, 5000);
  timer.unref?.();
}

export function genBody(node, { runner, store }) {
  const d = node.data;
  const m = getModel(d.draft?.model);
  const box = el('div', {});
  const run = d.run;
  const project = store?.project;
  const current = () => !store || (store.project === project && store.node(node.id) === node && node.data.run?.taskId === run?.taskId);
  // 预览区固定为 16:9：未生成/生成中显示文字占位，成片下载到本机后原位换成真实视频——
  // 卡片高度不随任务状态变化（编辑面板锚定在卡片下方，不会因此移动）。占位只有说明文字，不伪造任何媒体。
  const direct = directVideoOutput(store?.project, node);
  const placeholder = text => el('div', { class: 'generation-empty-preview' }, el('span', { class: 'preview-symbol', text: '▷', 'aria-hidden': 'true' }), el('span', { text }));
  // 预览框在“未生成”与“节点内预览”下的所有状态都存在（上传/提交/待确认也占同样高度）
  const media = direct || !run ? el('div', { class: 'gen-media gen-preview-box' }, placeholder(!run ? '视频预览' : run.taskId ? '成片完成后在这里预览' : run.state === 'uploading' ? '上传素材中…' : run.pendingKey ? '结果待确认' : '视频预览')) : null;
  if (media) box.append(media);
  // 单行状态摘要：编辑器打开时卡片隐藏摘要行、只显示这一行（始终占位，卡片高度不随状态变化）
  const statusLine = el('div', { class: 'gen-card-status' }, el('span', { class: 'hint', text: '未生成' }));
  const setLine = (...parts) => statusLine.replaceChildren(...parts.filter(Boolean));
  box.append(statusLine);
  if (media && direct && run?.taskId && typeof runner.resultURL === 'function') {
    Promise.resolve(runner.recOf(run.taskId)).then(async rec => {
      if (!current()) return null;
      let url = await runner.resultURL(run.taskId);
      if (!current() || !directVideoOutput(store?.project, node)) {
        if (url) runner.releaseResultURL?.(url);
        return null;
      }
      if (!url && canFetchContent(rec) && hasKey() &&
          (runner.accountSubject ? (!rec.ownerSubject || rec.ownerSubject === runner.accountSubject) : rec.keyFp === getFingerprint()) &&
          !rec.paused && typeof runner.download === 'function') {
        let attempted = previewDownloads.get(runner);
        if (!attempted) { attempted = new Set(); previewDownloads.set(runner, attempted); }
        const key = `${rec.projectId}:${run.taskId}`;
        if (!attempted.has(key)) {
          attempted.add(key);
          await runner.download(run.taskId); // 只鉴权下载原成片，不创建生成任务
          if (current()) url = await runner.resultURL(run.taskId);
        }
      }
      return url;
    }).then(u => {
      if (u && current() && directVideoOutput(store?.project, node)) {
        media.replaceChildren(el('video', { class: 'preview', src: u, controls: true, playsInline: true, preload: 'metadata' }));
        releaseWhenRemoved(media, u, runner);
      } else if (u) runner.releaseResultURL?.(u);
    }).catch(() => {});
  }
  box.append(
    el('div', { class: 'row' }, el('span', { text: '型号' }), el('b', { text: m?.display_name ?? d.draft?.model ?? '—' })),
    el('div', { class: 'row' }, el('span', { text: '参数' }), el('b', { text: `${d.draft?.seconds ?? '?'}s · ${d.draft?.ratio ?? '?'} · ${intentsFor(d.draft?.model).find(x => x.intent === d.draft?.intent)?.label ?? (d.draft?.intent === 'last_frame' ? '仅尾帧' : '')}` })),
    el('div', { class: 'row' }, el('span', { text: '预估' }), el('b', { text: `¥${estimateCost(d.draft?.model, d.draft?.seconds)?.toFixed(2) ?? '—'}（标准价${m?.billing_unit === 'request' ? '·按次' : m ? '·按秒' : ''}）` })),
  );
  const badge = (cls, text) => el('span', { class: `badge ${cls}`, text });
  if (run?.taskId) {
    const row = el('div', { class: 'row' }, el('span', { text: '状态' }), el('b', { text: '…' }));
    const timeRow = el('div', { class: 'row task-time-row' }, el('span', { text: '耗时' }), el('b', { text: '—' }));
    const details = el('div', { class: 'task-details' });
    box.append(row, timeRow, el('div', { class: 'row' }, el('span', { text: '任务' }), el('b', { text: String(run.taskId).slice(0, 18) })), details);
    const paint = rec => {
      if (!rec) { row.lastChild.textContent = '记录缺失'; return; }
      const identity = { keyFp: getFingerprint(), accountSubject: runner.accountSubject };
      row.lastChild.replaceChildren(badge(statusTone(rec, identity), statusLabel(rec, identity)));
      const timing = timingElement(taskTiming(rec));
      if (timing) timeRow.lastChild.replaceChildren(timing); else timeRow.hidden = true;
      setLine(badge(statusTone(rec, identity), statusLabel(rec, identity)), timingElement(taskTiming(rec)));
      details.replaceChildren();
      if (rec.progress != null && !TASK_TERMINAL.has(rec.status)) details.append(el('progress', { max: 100, value: rec.progress }));
      if (rec.error) details.append(el('div', { class: 'err-text', text: `任务失败：${String(rec.error?.message ?? rec.error)}` }));
      if (rec.pollError) details.append(el('div', { class: 'muted', text: `查询暂时失败，将自动重试：${rec.pollError}` }));
      if (rec.executorVersion === 2 && rec.stage) details.append(el('div', { class: 'muted', text: `阶段：${STAGE_LABEL[rec.stage] ?? rec.stage}` }));
      if (rec.cancelRequested && !isSettled(rec)) details.append(el('div', { class: 'muted', text: '已请求停止后续尝试' }));
    };
    // 有缓存时同步绘制，避免卡片先矮后高（编辑面板锚定在卡片下方，高度抖动会带着面板跳动）
    const cached = runner.taskPeek?.(run.taskId);
    if (cached) paint(cached); else runner.recOf(run.taskId).then(rec => { if (current()) paint(rec); });
  } else if (run?.pendingKey) {
    const label = run.expired ? '无法确认（已超 24 小时）' : run.detached ? '结果待确认 · 已暂停等待' : '结果待确认';
    box.append(el('div', { class: 'row' }, el('span', { text: '状态' }), el('b', {}, badge('warn', label))));
    const timeRow = el('div', { class: 'row task-time-row', hidden: true }, el('span', { text: '耗时' }), el('b', {}));
    box.append(timeRow);
    setLine(badge('warn', label));
    Promise.resolve(store?.pendingCreateIn?.(project?.id, run.pendingKey)).then(r => {
      if (!r || !current() || !Number.isFinite(r.createdAt) || run.expired) return;
      const timing = timingElement({ running: true, since: r.createdAt });
      if (timing) { timeRow.lastChild.replaceChildren(timing); timeRow.hidden = false; }
      setLine(badge('warn', label), timingElement({ running: true, since: r.createdAt }));
    }).catch(() => {});
    if (run.error) box.append(el('div', { class: 'err-text', text: `最近一次确认失败：${run.error}` }));
  } else if (run?.rejected) {
    setLine(badge('err', '已被拒绝'));
    box.append(el('div', { class: 'row' }, el('span', { text: '状态' }), el('b', {}, badge('err', '已被拒绝'))), run.error ? el('div', { class: 'err-text', text: `服务器拒绝：${run.error}` }) : null);
  } else if (run?.state) {
    setLine(badge('busy', STATUS_LABEL[run.state]));
    box.append(el('div', { class: 'row' }, el('span', { text: '状态' }), el('b', {}, badge('busy', STATUS_LABEL[run.state]))), run.note ? el('div', { class: 'muted', text: run.note }) : null);
  } else if (run?.error) {
    setLine(badge('err', '上次提交未完成'));
    box.append(el('div', { class: 'err-text', text: `上次提交未完成：${run.error}` }));
  }
  if (direct && run?.taskId) {
    const taskId = run.taskId;
    // 该按钮把成片保存为本机文件（本机尚无成片时先从服务器取回），与检查器「保存到电脑」同名同义
    const download = el('button', { type: 'button', class: 'gen-result-download', text: '保存到电脑', disabled: true });
    Promise.resolve(runner.recOf(taskId)).then(async rec => {
      if (!current()) return;
      const local = typeof runner.localResult === 'function'
        ? (await runner.localResult(taskId)).ready : hasLocalResult(rec);
      download.disabled = !local && !canFetchContent(rec);
      download.title = local ? '' : download.disabled ? '成片尚未就绪' : '将先从服务器下载成片，再保存到电脑';
    }).catch(() => {});
    download.addEventListener('click', async () => {
      download.disabled = true;
      let url = null;
      try {
        if (!current()) return;
        url = await runner.resultURL(taskId);
        if (!current()) return;
        if (!url) {
          await runner.download(taskId);
          if (!current()) return;
          url = await runner.resultURL(taskId);
        }
        if (!current()) return;
        if (!url) { toast('成片暂未下载成功，请稍后重试', 'warn'); return; }
        const rec = await runner.recOf(taskId);
        if (!current()) return;
        const ext = rec?.resultType === 'video/webm' ? 'webm' : 'mp4';
        const a = el('a', { href: url, download: `成片-${taskId.slice(0, 8)}.${ext}` });
        document.body.append(a); a.click(); a.remove();
        const urlForSave = url;
        const cleanup = setTimeout(() => runner.releaseResultURL?.(urlForSave), 10 * 60 * 1000);
        cleanup.unref?.();
        url = null; // 浏览器保存仍可能读取该 URL，交由延迟清理负责
      } catch (e) { if (current()) toast(`下载失败：${e.message}`, 'err'); }
      finally { if (url) runner.releaseResultURL?.(url); if (current()) download.disabled = false; }
    });
    box.append(download);
  } else if (direct) {
    // 编辑中预留同一按钮的位置（不可见）：编辑器打开期间卡片高度不随提交而变化
    box.append(el('button', { type: 'button', class: 'gen-result-download reserved', text: '保存到电脑', disabled: true, tabindex: '-1', 'aria-hidden': 'true' }));
  }
  return box;
}

// ---------------- 检查器表单 ----------------

// 清理不属于当前型号/模式的 UI 隐藏参数（含历史/导入残留），防止陈旧值被带进提交。
function pruneDraftParams(m, draft) {
  if (!m || !draft || typeof draft !== 'object') return;
  for (const k of Object.keys(draft.switches ?? {})) if (!m.switches?.[k]) delete draft.switches[k];
  for (const k of ['size', 'resolution', 'aspect_ratio', 'quality', 'n', 'response_format', 'image', 'mask'])
    delete draft[k];
}

// 型号默认值与切换（R03）：perModel 只承载控件设置；当前选定型号与公共 prompt
// 是全局草稿属性，任何 perModel 存档（含导入残留的整份草稿/畸形数据）都不得覆盖它们。
function modelDefaults(modelId) {
  const m = getModel(modelId);
  return { intent: intentsFor(modelId)[0]?.intent ?? 'text', seconds: m?.seconds.default ?? 5, ratio: m?.ratios.default ?? '16:9', switches: { generate_audio: true, face_mode: false } };
}
export function applyModelSwitch(d, modelId) {
  const m = getModel(modelId);
  const def = modelDefaults(modelId);
  const cur = d.draft ?? {};
  d.perModel ??= {};
  if (cur.model) d.perModel[cur.model] = { intent: cur.intent, seconds: cur.seconds, ratio: cur.ratio, switches: cur.switches, bindings: cur.bindings };
  const saved = d.perModel[modelId];
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  d.draft = {
    model: modelId,
    prompt: cur.prompt,
    intent: intentsFor(modelId).some(i => i.intent === s.intent) || (s.intent === 'last_frame' && supportsLastFrameOnly(modelId)) ? s.intent : def.intent,
    seconds: Number.isInteger(s.seconds) && m && s.seconds >= m.seconds.min && s.seconds <= m.seconds.max && (!m.allowed_seconds || m.allowed_seconds.includes(s.seconds)) ? s.seconds : def.seconds,
    ratio: m?.ratios.options.includes(s.ratio) ? s.ratio : def.ratio,
    switches: s.switches && typeof s.switches === 'object' && !Array.isArray(s.switches) ? s.switches : def.switches,
    bindings: s.bindings && typeof s.bindings === 'object' && !Array.isArray(s.bindings) ? s.bindings : cur.bindings,
  };
  pruneDraftParams(m, d.draft);
  return d.draft;
}

export function genInspector(node, ctx) {
  const { store, runner, refresh, assets, onDuplicate, editor, generators } = ctx;
  const d = node.data;
  // 只补缺省字段，不替换草稿对象：重建检查器不应改变草稿本身（键顺序、引用都保持不变）
  if (!d.draft || typeof d.draft !== 'object') d.draft = {};
  const draftDefaults = { model: 'minimax-h3-768p-per-second', intent: 'text', seconds: 15, ratio: '16:9', prompt: '', switches: { generate_audio: true, face_mode: false } };
  for (const [k, v] of Object.entries(draftDefaults)) if (d.draft[k] === undefined) d.draft[k] = v;
  if (!getModel(d.draft.model)) d.draft.model = 'minimax-h3-768p-per-second';
  d.perModel ??= {};
  const wrap = el('div', {});
  function rerender() { wrap.replaceChildren(build()); }

  function build() {
    const m = getModel(d.draft.model);
    if (!m) return el('div', { class: 'err-text', text: '型号不在能力表内' });
    const intent = d.draft.intent;
    const frameMode = FRAMES_FAMILY_INTENTS.has(intent);
    // 分区：参考素材 → 提示词 → 参数 → 任务状态 → 固定在底部的预估与生成按钮
    const box = el('div', { class: 'generation-form', 'data-intent': intent });

    const intents = [...intentsFor(d.draft.model)];
    // 能力表已声明 last_frame 支持但 intentsFor 尚未提供时的本地补齐；未声明型号一律不追加
    if (supportsLastFrameOnly(d.draft.model) && !intents.some(i => i.intent === 'last_frame'))
      intents.push({ intent: 'last_frame', mode: 'frames', label: '仅尾帧' });
    const modeLabel = intents.find(i => i.intent === intent)?.label ?? '当前';
    const switchIntent = next => { d.draft.intent = next; pruneDraftParams(m, d.draft); store.touch({ type: 'data', id: node.id }); rerender(); };

    const refsW = runner.wired(node.id, 'refs'), framesW = runner.wired(node.id, 'frames');
    const inputs = modeInputs(intent, refsW, framesW);
    // 连线素材 + @绑定顺序（新出现的 @XN 固化到当前第 N 个素材 id，之后删/换不再静默错指）；
    // 绑定按全部已连接参考素材固化，切换模式或型号不丢，提交与校验只用本模式输入口
    d.draft.bindings = syncPromptBindings(d.draft.prompt, refsW.items, d.draft.bindings);
    const slotCtx = { store, node, assets, editor, model: m, intent, onChange: () => { rerender(); refresh?.(); } };
    const mHint = mediaLimitsHint(m, d.draft.model);

    // ---- 提示词（先建输入框：参考素材的 @ 选择器绑定在它上面）----
    const ta = el('textarea', { value: d.draft.prompt ?? '', 'aria-label': '视频提示词',
      placeholder: frameMode ? '描述首帧到尾帧之间的画面变化、镜头运动和动作…' : '描述你想生成的画面，输入 @ 选择图片、视频或音频…' });
    const count = el('span', { class: 'prompt-count', 'aria-live': 'off' });
    const updateCount = () => {
      const n = [...(ta.value ?? '')].length, max = m.prompt_max_characters;
      count.textContent = Number.isFinite(max) ? `${n}/${max}` : `${n} 字`;
      count.classList.toggle('over', Number.isFinite(max) && n > max);
    };
    ta.addEventListener('input', () => { d.draft.prompt = ta.value; store.saveSoon(); updateCount(); refreshValidation(); });
    updateCount();
    const expand = el('button', { type: 'button', class: 'composer-expand', title: '放大编辑区，便于编写和查看长提示词', 'aria-pressed': 'false' },
      el('span', { class: 'when-collapsed', text: '⤢ 展开编辑' }), el('span', { class: 'when-expanded', text: '⤡ 收起' }));
    expand.addEventListener('click', () => expand.dispatchEvent(new CustomEvent('composer-expand', { bubbles: true })));
    const wireHint = el('p', { class: 'hint' });
    // MiniMax H3 的首帧/首尾帧、素材参考模式：提示词可用对应的专用角色 AI 改写（其他型号与模式不显示）
    let rewriteBtn = null;
    if (canRewriteH3(d.draft) && generators?.rewriteText) {
      rewriteBtn = el('button', { type: 'button', class: 'composer-rewrite', text: '✦ AI 改写',
        title: `用「${intent === 'refs' ? '参考生视频润色' : '图生视频润色'}」改写当前提示词（专为 MiniMax H3 编写），确认后才替换` });
      rewriteBtn.addEventListener('click', () => openH3Rewrite({ store, node, generators, editor, onApply: () => { rerender(); refresh?.(); } }));
    }
    const promptG = el('section', { class: 'ins-group composer-prompt' },
      el('div', { class: 'composer-section-head' }, el('span', { class: 'composer-section-title', text: '提示词' }), count, rewriteBtn, expand),
      el('div', { class: 'field' }, ta), wireHint);

    // ---- 参考素材 / 首尾帧 ----
    const refSection = el('section', { class: 'ins-group composer-references', 'data-mode': frameMode ? 'frames' : intent });
    if (frameMode) {
      refSection.append(renderFrameSlots(slotCtx));
      const stray = portEntries(store, node.id, 'refs');
      if (stray.length) refSection.append(renderUnused(slotCtx, stray, `「${modeLabel}」不使用普通参考素材，下面的素材不会提交`));
    } else {
      const lim = m.reference_limits;
      const picker = promptReferencePicker({ textarea: ta, store, node, assets, editor,
        kinds: ['image', 'video', 'audio'].filter(kind => lim[kind] > 0),
        onInsert: (prompt, caret) => {
          const panel = wrap.closest('#inspector'), scroll = panel?.scrollTop ?? 0, textScroll = ta.scrollTop;
          d.draft.prompt = prompt; store.saveSoon(); rerender();
          const input = wrap.querySelector('textarea'); input?.focus({ preventScroll: true }); input?.setSelectionRange(caret, caret);
          if (input) input.scrollTop = textScroll;
          if (panel) panel.scrollTop = scroll;
          store.touch({ type: 'data', id: node.id });
        } });
      const n = k => refsW.items.filter(r => r.kind === k).length;
      refSection.append(el('div', { class: 'composer-section-head' },
        el('span', { class: 'composer-section-title', text: intent === 'text' ? '参考素材（可选）' : '参考素材' }),
        el('span', { class: 'hint ref-counts', text: `图片 ${n('image')}/${lim.image} · 视频 ${n('video')}/${lim.video} · 音频 ${n('audio')}/${lim.audio} · 合计 ${refsW.items.length}/${lim.total}` })),
      picker);
      const entries = portEntries(store, node.id, 'refs');
      if (entries.length) {
        const thumbs = el('div', { class: 'ref-thumbs', 'aria-label': '参考素材预览' });
        const problems = [];
        for (const x of entries) {
          const a = x.asset;
          const token = referenceToken(a, refsW.items, d.draft.bindings, d.draft.prompt).text;
          const insert = el('button', { type: 'button', class: 'ref-thumb', title: `插入 ${token} · ${a.name}`, 'aria-label': `插入引用 ${token} ${a.name}` }, el('span', { text: token }));
          insert.addEventListener('click', () => {
            const liveRefs = runner.wired(node.id, 'refs').items;
            if (!liveRefs.some(ref => ref.id === a.id)) { toast('素材已不在引用中，请重新选择', 'warn'); return; }
            const picked = referenceToken(a, liveRefs, d.draft.bindings, d.draft.prompt);
            d.draft.bindings = picked.bindings;
            ta.setRangeText(`${picked.text} `, ta.selectionStart, ta.selectionEnd, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
          });
          if (a.kind === 'image' || a.kind === 'video') assets?.objectURL?.(a.id).then(u => {
            if (u) insert.prepend(el(a.kind === 'image' ? 'img' : 'video', { src: u, alt: a.name, muted: true, preload: 'metadata' }));
          }).catch(() => {});
          const remove = el('button', { type: 'button', class: 'ref-remove', text: '×', title: `移除 ${a.name}`, 'aria-label': `移除参考素材 ${a.name}` });
          remove.addEventListener('click', () => { disconnectEntries(slotCtx, [x]); slotCtx.onChange(); });
          thumbs.append(el('div', { class: 'ref-item' }, insert, remove));
          for (const p of assetMediaProblems(m, a)) problems.push(`${a.name}：${p}`);
        }
        refSection.append(thumbs, ...problems.map(p => el('div', { class: 'err-text', text: p })));
      } else if (intent !== 'text') refSection.append(el('p', { class: 'hint', text: '点击「+ 参考素材」或在提示词中输入 @ 选择素材。' }));
      const strayFrames = portEntries(store, node.id, 'frames');
      if (strayFrames.length) refSection.append(renderUnused(slotCtx, strayFrames, intent === 'text'
        ? '纯文字模式不使用首尾帧图片：请切换为首尾帧模式或断开'
        : `「${modeLabel}」不使用首尾帧图片，下面的图片不会提交`));
    }
    for (const p of inputs.problems) refSection.append(el('div', { class: 'err-text', text: p }));
    if (mHint) refSection.append(el('details', { class: 'gen-help' }, el('summary', { text: '素材要求' }), el('p', { class: 'hint', text: mHint })));

    // ---- 参数 ----
    const sel = el('select', { value: d.draft.model, 'aria-label': '视频生成型号' });
    const famLabel = { h3: 'H3（视频专线）', sd25: 'SD 2.5', wan: 'Wan' };
    for (const fam of ['h3', 'sd25', 'wan']) {
      const g = el('optgroup', { label: famLabel[fam] });
      for (const id of modelIds().filter(id => getModel(id).family === fam)) {
        const usable = isModelUsable(id);
        g.append(el('option', { value: id, text: `${getModel(id).display_name} · ¥${getModel(id).billing_unit === 'request' ? getModel(id).price_cny_per_request : getModel(id).price_cny_per_second}/${getModel(id).billing_unit === 'request' ? '次' : '秒'}${usable ? '' : '（当前密钥不可用）'}`, selected: id === d.draft.model, disabled: !usable }));
      }
      sel.append(g);
    }
    sel.addEventListener('change', () => {
      // prompt 与 @绑定都保留：删除/切换不得把旧引用指向别的素材；型号/提示词永不被存档覆盖
      applyModelSwitch(d, sel.value);
      store.touch({ type: 'data', id: node.id }); rerender();
    });
    const basics = el('section', { class: 'ins-group gen-basics composer-parameters' });
    basics.append(el('div', { class: 'field' }, el('label', { text: '模型' }), sel));
    const modeSel = el('select', { value: intent, 'aria-label': '生成模式' }, intents.map(i => el('option', { value: i.intent, text: i.label, selected: i.intent === intent })));
    modeSel.addEventListener('change', () => switchIntent(modeSel.value));
    basics.append(el('div', { class: 'field' }, el('label', { text: '模式' }), modeSel));
    const sec = m.allowed_seconds ? el('select', { value: d.draft.seconds, 'aria-label': '生成时长（秒）' }, m.allowed_seconds.map(n => el('option', { value: n, text: n + ' 秒', selected: n === d.draft.seconds }))) : el('input', { type: 'number', min: m.seconds.min, max: m.seconds.max, step: 1, value: d.draft.seconds, 'aria-label': '生成时长（秒）' });
    // 输入即时同步：节点体摘要/预估费用/校验即时跟随（refreshValidation 原地更新，不重建 DOM，不丢焦点）
    sec.addEventListener('input', () => {
      d.draft.seconds = Math.round(Number(sec.value));
      store.saveSoon(); store.touch({ type: 'data', id: node.id }); refreshValidation();
    });
    const ratio = el('select', { value: d.draft.ratio, 'aria-label': '画面比例' }, m.ratios.options.map(r => el('option', { value: r, text: r, selected: r === d.draft.ratio })));
    ratio.addEventListener('change', () => { d.draft.ratio = ratio.value; store.saveSoon(); store.touch({ type: 'data', id: node.id }); refreshValidation(); });
    basics.append(el('div', { class: 'gen-param-pair' },
      el('div', { class: 'field' }, el('label', { text: secondsFieldLabel(m) }), sec),
      // 自适应提示仅用于两个多渠道 H3 型号；独立慢速版及 last_frame 只显示比例。
      el('div', { class: 'field' }, el('label', { text: '比例' + (/^minimax-h3-(768p|2k)-per-second$/.test(d.draft.model) && intent === 'frames' ? '（首尾帧随素材自适应）' : '') }), ratio),
    ));
    if (m.switches.generate_audio || m.switches.face_mode) {
      const sw = el('div', { class: 'field' }, el('label', { text: '开关' }));
      if (m.switches.generate_audio) {
        const c = el('input', { type: 'checkbox' }); c.checked = d.draft.switches?.generate_audio !== false;
        c.addEventListener('change', () => { d.draft.switches = { ...d.draft.switches, generate_audio: c.checked }; store.saveSoon(); });
        sw.append(el('div', { class: 'check' }, c, el('span', { text: '生成声音' })));
      }
      if (m.switches.face_mode) {
        const c = el('input', { type: 'checkbox' }); c.checked = d.draft.switches?.face_mode === true;
        c.addEventListener('change', () => { d.draft.switches = { ...d.draft.switches, face_mode: c.checked }; store.saveSoon(); });
        sw.append(el('div', { class: 'check' }, c, el('span', { text: '人脸模式（需参考图）' })));
      }
      basics.append(sw);
    }

    // ---- 提交区：只显示“当前输入”的问题；原任务的状态与操作在任务区单独展示 ----
    const errBox = el('div', { class: 'input-check' });
    const costEl = el('div', { class: 'field' }, el('span', { class: 'cost', text: `预估 ¥${estimateCost(d.draft.model, d.draft.seconds)?.toFixed(2)}` }), el('span', { class: 'hint', text: ` 标准价估算 · ${m.billing_unit === 'request' ? '按次' : '按秒'}计费` }));
    const submitBtn = el('button', { class: 'primary', type: 'button', text: '提交生成' });
    const firstEmptySlot = () => wrap.querySelector('.frame-slot-empty:not(:disabled)')?.click();
    // 首尾帧类模式不提交参考素材：提示词里残留的 @图片N 等引用不会生效
    const staleRefs = err => (frameMode ? /^提示词引用未连接素材或已失效：(.+)$/.exec(err)?.[1]?.split('、') : null);
    const describe = err => {
      const stale = staleRefs(err);
      return stale ? `「${modeLabel}」不使用参考素材，提示词中的 ${stale.join('、')} 不会生效` : err;
    };
    // 阻断提示附带一键处理：只在用户点击时执行对应的明确操作，不自动改模式或参数
    function fixFor(err) {
      const stale = staleRefs(err);
      if (stale) return ['从提示词中移除这些引用', () => {
        let v = ta.value;
        for (const t of stale) v = v.replace(new RegExp(`${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)\\s?`, 'g'), '');
        ta.value = v.trim(); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
      }];
      if (err === '提示词不能为空') return ['填写提示词', () => ta.focus()];
      if (err === '纯文字模式不应连接素材') {
        const want = runner.wired(node.id, 'refs').items.length ? 'refs' : runner.wired(node.id, 'frames').items.length ? 'frames' : null;
        const opt = intents.find(i => i.intent === want);
        if (opt) return [`切换为「${opt.label}」`, () => switchIntent(opt.intent)];
      }
      if (/首帧|尾帧|首尾帧/.test(err) && frameMode && wrap.querySelector('.frame-slot-empty:not(:disabled)')) return ['选择图片', firstEmptySlot];
      if (err === '素材参考模式需要至少一个素材') return ['添加参考素材', () => wrap.querySelector('.reference-trigger')?.click()];
      return null;
    }
    function errRow(err) {
      const row = el('div', { class: 'err-text err-fixable' }, el('span', { text: `提交前请调整：${describe(err)}` }));
      const fix = fixFor(err);
      if (fix) { const b = el('button', { type: 'button', class: 'mini err-fix', text: fix[0] }); b.addEventListener('click', fix[1]); row.append(b); }
      return row;
    }
    function refreshValidation() {
      const liveRefs = runner.wired(node.id, 'refs');
      const live = modeInputs(d.draft.intent, liveRefs, runner.wired(node.id, 'frames'));
      const eff = effectivePrompt(store, node, d.draft.prompt);
      d.draft.bindings = syncPromptBindings(eff.prompt, liveRefs.items, d.draft.bindings);
      wireHint.textContent = eff.wired ? '已合并连线文本输入（上游文本在前，本框内容在后）' : '';
      // 介质大小/格式阻断统一由 validateDraft 内 mediaPrecheckError 负责；assetMediaProblems 仅供行内逐条提示
      const err = validateDraft(d.draft.model, { ...d.draft, prompt: eff.prompt }, live.refs, live.frames, [...live.problems, ...eff.problems], 'pre');
      const taskActive = !!d.run?.taskId || !!d.run?.pendingKey;
      errBox.replaceChildren(...(err && !taskActive ? [errRow(err)] : []));
      costEl.firstChild.textContent = `预估 ¥${estimateCost(d.draft.model, d.draft.seconds)?.toFixed(2)}`;
      const uploads = runner.uploadCount?.(node.id) ?? 0;
      const label = uploads ? '上传并提交生成' : '提交生成';
      if (submitBtn.textContent !== label) submitBtn.textContent = label;
      submitBtn.title = uploads ? `将先上传 ${uploads} 个本机素材，再提交生成` : '';
      submitBtn.disabled = !!err || !hasKey() || runner.isBusy(node.id) || taskActive || !isModelUsable(d.draft.model);
    }
    submitBtn.addEventListener('click', () => runner.submit(node).then(refresh));
    box.addEventListener('canvas-graph-change', refreshValidation);
    const cta = el('section', { class: 'ins-group gen-cta' }, costEl, submitBtn, errBox);
    if (!hasKey()) {
      const openKey = el('button', { type: 'button', class: 'mini err-fix', text: '输入密钥' });
      openKey.addEventListener('click', () => document.getElementById('btn-key')?.click());
      cta.append(el('p', { class: 'hint err-fixable' }, el('span', { text: '先在顶栏输入 API Key' }), openKey));
    }
    if (!isModelUsable(d.draft.model)) cta.append(el('p', { class: 'err-text', text: '该型号不在当前密钥分组，不可提交' }));
    const run = d.run;
    submitBtn.hidden = !!run?.taskId || !!run?.pendingKey;
    refreshValidation();

    // 有任务时任务区放在最上方：打开编辑器即可看到状态、耗时与可做的操作
    const task = taskPanel(run);
    if (task) box.append(task);
    box.append(refSection, promptG, basics, cta);
    return box;
  }

  // ---- 任务区：按任务实际状态给出可理解的操作；与“当前输入有误”分开展示 ----
  function taskPanel(run) {
    if (!run) return null;
    const section = el('section', { class: 'ins-group gen-task', 'aria-label': '任务状态' });
    const head = (title, ...extra) => el('div', { class: 'composer-section-head' }, el('span', { class: 'composer-section-title', text: title }), ...extra);
    const actions = el('div', { class: 'modal-actions task-actions' });
    const badge = (cls, text) => el('span', { class: `badge ${cls}`, text });
    if (run.state === 'uploading') {
      const cancel = el('button', { type: 'button', text: '取消上传' });
      cancel.addEventListener('click', () => runner.cancelUpload(node.id));
      actions.append(cancel);
      section.append(head('正在上传素材', badge('busy', STATUS_LABEL.uploading)), run.note ? el('p', { class: 'hint', text: run.note }) : null, actions);
      return section;
    }
    if (run.taskId) {
      const projectAtOpen = store.project;
      const stillCurrent = () => store.project === projectAtOpen && store.node(node.id) === node && node.data.run?.taskId === run.taskId;
      const status = el('span', { class: 'task-status-slot' }), time = el('span', { class: 'task-time-slot' });
      const details = el('div', { class: 'task-details' });
      section.append(head('当前任务', status, time), details, actions);
      const paint = rec => {
        if (!rec) { status.replaceChildren(badge('warn', '记录缺失')); return; }
        const identity = { keyFp: getFingerprint(), accountSubject: runner.accountSubject };
        status.replaceChildren(badge(statusTone(rec, identity), statusLabel(rec, identity)));
        const timing = timingElement(taskTiming(rec));
        time.replaceChildren(...(timing ? [timing] : []));
        details.replaceChildren();
        if (rec.progress != null && !TASK_TERMINAL.has(rec.status)) details.append(el('progress', { max: 100, value: rec.progress }));
        if (rec.executorVersion === 2 && rec.stage) details.append(el('p', { class: 'hint', text: `阶段：${STAGE_LABEL[rec.stage] ?? rec.stage}` }));
        if (rec.error) details.append(el('p', { class: 'err-text', text: `任务失败：${String(rec.error?.message ?? rec.error)}` }));
        if (rec.pollError) details.append(el('p', { class: 'hint', text: `查询暂时失败，将自动重试：${rec.pollError}` }));
        if (rec.cancelRequested && runner.taskLive(run.taskId)) details.append(el('p', { class: 'hint', text: '已请求停止后续尝试；任务仍可能成功交付并按原价收费' }));
      };
      const rec = runner.taskPeek(run.taskId);
      if (rec) paint(rec); else runner.recOf(run.taskId).then(r => { if (stillCurrent()) paint(r); }).catch(() => {});
      const dl = el('button', { type: 'button', text: '下载成片' });
      const pv = el('button', { type: 'button', text: '预览' });
      const save = el('button', { type: 'button', text: '保存到电脑' });
      const detach = el('button', { type: 'button', text: '移出节点', title: '任务和成片保留在任务列表中；节点可以修改后重新生成' });
      dl.addEventListener('click', async () => { await runner.download(run.taskId); refresh?.(); });   // 取回后刷新：预览/保存随即可用
      // 记录显示已在本机但文件实际缺失（如浏览器数据被清）时，预览/保存先自动取回原任务成片，不会卡住
      const localURL = async () => {
        let u = await runner.resultURL(run.taskId);
        if (!u && runner.canDownload(run.taskId)) { await runner.download(run.taskId); u = await runner.resultURL(run.taskId); }
        return u;
      };
      pv.addEventListener('click', async () => {
        const u = await localURL();
        if (!stillCurrent()) { if (u) runner.releaseResultURL?.(u); return; }
        if (u) modal(el('div', {}, el('video', { src: u, controls: true, autoplay: true, style: 'width:100%;border-radius:8px' })), {
          onClose: () => runner.releaseResultURL?.(u),
        });
        else toast('尚未下载到本机，请先下载', 'warn');
      });
      // 保存到电脑：复用已鉴权下载的本地 Blob，不重复请求；扩展名随真实 content-type
      save.addEventListener('click', async () => {
        const u = await localURL();
        if (!stillCurrent()) { if (u) runner.releaseResultURL?.(u); return; }
        if (!u) { toast('尚未下载到本机，请先点「下载成片」', 'warn'); return; }
        const r = await runner.recOf(run.taskId);
        if (!stillCurrent()) { runner.releaseResultURL?.(u); return; }
        const ext = r?.resultType === 'video/webm' ? 'webm' : 'mp4';
        const a = el('a', { href: u, download: `成片-${run.taskId.slice(0, 8)}.${ext}` });
        document.body.append(a); a.click(); a.remove();
        const cleanup = setTimeout(() => runner.releaseResultURL?.(u), 10 * 60 * 1000);
        cleanup.unref?.();
      });
      detach.addEventListener('click', () => runner.detach(node));
      if (onDuplicate && rec && isSettled(rec)) {
        const next = el('button', { class: 'primary', type: 'button', text: '创建新版本', title: '复制参数和连线，保留当前任务及成片；新版本需手动提交' });
        next.addEventListener('click', () => onDuplicate(node));
        actions.append(next);
      }
      if (rec && !runner.canDownload(run.taskId)) { dl.disabled = true; dl.title = '成片尚未就绪'; }
      const local = hasLocalResult(rec);
      if (!local) for (const b of [pv, save]) { b.disabled = true; b.title = '先「下载成片」到本机'; }
      actions.append(...(local ? [] : [dl]), pv, save);
      if (rec && runner.taskLive(run.taskId)) {
        // v2：「停止后续尝试」（服务端取消，需确认）与「暂停查询/继续查询」（本地暂停）相互独立
        if (canRequestCancel(rec)) {
          const cancel = el('button', { type: 'button', text: '停止后续尝试' });
          cancel.addEventListener('click', async () => {
            const ok = await confirmDialog('停止后续渠道尝试？', el('p', { text: '将停止后续渠道尝试；当前上游可能仍会生成，若最终可交付成功仍按原价收费，取消不保证立即退款。' }));
            if (ok) await runner.cancelTask(node);
            refresh();
          });
          actions.append(cancel);
        }
        const pause = el('button', { type: 'button', text: rec.paused ? '继续查询' : '暂停查询',
          title: rec.paused ? '恢复自动查询任务结果' : '暂停后不再自动查询结果，任务仍在服务器上继续；可随时继续查询' });
        pause.addEventListener('click', () => runner.setPollPaused(run.taskId, !rec.paused).then(refresh));
        actions.append(pause);
      }
      actions.append(detach);
      return section;
    }
    if (run.pendingKey) {
      const busy = runner.isBusy(node.id) || run.state === 'submitting';
      const time = el('span', { class: 'task-time-slot' });
      const title = busy ? '正在提交' : run.expired ? '原提交无法确认' : '原任务结果待确认';
      const tone = run.expired ? badge('err', '已超 24 小时') : run.detached ? badge('warn', '已暂停等待') : badge('warn', busy ? '提交中' : '待确认');
      const explain = run.expired
        ? '已超过 24 小时，无法再确认原提交是否被服务器受理。为避免重复收费，此节点不会再发送；如需重新生成，请创建新版本。'
        : run.detached
          ? '已暂停等待。原提交结果仍未确认，为避免重复收费，此节点暂不能新建任务；24 小时内可随时再次确认。'
          : '提交请求已经发出，但还没有收到服务器的明确答复。为避免重复收费，此节点暂不能新建任务。';
      section.append(head(title, tone, time), el('p', { class: 'hint', text: busy ? '正在等待服务器答复…' : explain }));
      if (run.error) section.append(el('p', { class: 'err-text', text: `最近一次确认失败：${run.error}` }));
      Promise.resolve(store.pendingCreateIn?.(store.project?.id, run.pendingKey)).then(r => {
        if (!r || run.expired || !Number.isFinite(r.createdAt) || node.data.run !== run) return;
        const t = timingElement({ running: true, since: r.createdAt });
        if (t) time.replaceChildren(t);
      }).catch(() => {});
      const retry = el('button', { class: 'primary', type: 'button', text: '再次确认结果', disabled: !!run.expired || busy,
        title: '用同一请求再次发送，服务器会识别为同一次提交，不会重复收费' });
      retry.addEventListener('click', () => runner.retrySubmit(node).then(refresh));
      actions.append(retry);
      if (!run.detached && !run.expired) {
        const detach = el('button', { type: 'button', text: '暂停等待', disabled: busy, title: '只在本机暂停等待；原提交若已被受理仍会生成并计费' });
        detach.addEventListener('click', async () => {
          const ok = await confirmDialog('暂停等待这次提交的结果？', el('p', { text: '只是暂停在本机等待。原提交如果已被服务器受理，仍会正常生成并计费。为避免重复收费，此节点仍不能新建任务；24 小时内可随时点“再次确认结果”找回。' }));
          if (ok) runner.detach(node);
        });
        actions.append(detach);
      }
      const release = el('button', { type: 'button', text: '检查能否重新提交', disabled: busy,
        title: '能证明原请求没有发出或已被拒绝时解除限制；否则保持限制，避免重复收费' });
      release.addEventListener('click', () => runner.releasePending(node));
      actions.append(release);
      if (run.expired && onDuplicate) {
        const next = el('button', { type: 'button', text: '创建新版本', title: '复制参数和连线为新节点；原记录保留' });
        next.addEventListener('click', () => onDuplicate(node));
        actions.append(next);
      }
      section.append(actions);
      return section;
    }
    if (run.rejected) {
      section.append(head('上次提交被拒绝', badge('err', '已被拒绝')),
        run.error ? el('p', { class: 'err-text', text: `服务器拒绝：${run.error}` }) : null,
        el('p', { class: 'hint', text: '没有生成任务，也不会收费。修改参数后可以重新提交。' }));
      return section;
    }
    if (run.error) {
      section.append(head('上次提交未完成'), el('p', { class: 'err-text', text: run.error }),
        el('p', { class: 'hint', text: '草稿和素材都已保留，可以直接再次提交。' }));
      return section;
    }
    if (run.state) {
      section.append(head(STATUS_LABEL[run.state] ?? '处理中', badge('busy', STATUS_LABEL[run.state] ?? run.state)), run.note ? el('p', { class: 'hint', text: run.note }) : null);
      return section;
    }
    return null;
  }
  rerender();
  return wrap;
}
