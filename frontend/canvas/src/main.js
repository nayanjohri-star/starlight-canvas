// 星盘独立画布入口：装配存储/能力表/密钥/项目/编辑历史/节点板/素材库/
// 生成节点/导演台 + 六域模块（生成器/工具/工作流/分镜/素材库面板/时间轴/项目集线器/助手）。
// 新域模块按合同动态加载：缺席时界面给出明确「未就绪」提示，绝不静默或造假。

import { el, toast, modal, confirmDialog, fmtTime, fmtBytes } from './ui.js';
import { loadCapabilities, getModel, modelIds, fileKind, chatModelIdsFromCatalog, imageModelIds } from './capabilities.js';
import { createSiteClient } from './api.js';
import { initProviders, getProvider } from './providers.js';
import { openProviderSettings } from './provider-ui.js';
import * as keyvault from './keyvault.js';
import { createIdbStorage } from './storage.js';
import { createStore } from './store.js';
import { createBoard } from './board.js';
import { createEditor } from './editor.js';
import { createAssets, KIND_LABEL } from './assets.js';
import { createTaskRunner, genBody, genInspector } from './gennode.js';
import { createNodeComposer } from './node-composer.js';
import { createDirectorHost, directorBody } from './director.js';
import { createStudioShell, defaultNodeData, TYPE_LABEL } from './studio-shell.js';
import { applyIcon } from './icons.js';
import { BUILD } from './build-info.js';
import { RUNTIME, isHosted, feature } from './runtime-config.js';
import { signInGate, endHostedSession, finishHostedStartup, STORAGE_NOTICE } from './hosted-session.js';
import { createServiceStatus } from './service-status.js';
import { TOOLS, directVideoOutput } from './studio-schema.js';
import { canFetchContent, canRequestCancel, isFinalFailure, isSettled, isSupportedTaskRecord, needsTracking, taskPhase, V2_MARK_FIELDS } from './task-status.js';

const $ = s => document.querySelector(s);

function noteBody(node) {
  const ta = el('textarea', { value: node.data.text ?? '', placeholder: '备注…' });
  ta.addEventListener('input', () => { node.data.text = ta.value; store0.saveSoon(); });
  return ta;
}
let store0; // noteBody 闭包用

// 各域工厂合同（详见升级合同 v1）：缺席/导出缺失 → 记录状态并降级，不让应用崩溃
const MODULE_SPECS = [
  ['generators', './studio-gen.js', 'createGenerators'],   // 文本/图片节点：generate/body/inspector/quote/textModels/imageModels
  ['tools', './tools.js', 'createTools'],                  // 工具节点：execute/body/inspector
  ['workflow', './workflow.js', 'createWorkflow'],         // 工作流：preview/start/pause/resume/getState/panel
  ['storyboards', './storyboard.js', 'createStoryboards'], // 分镜：open/fromScript/createGrid/focusShot
  ['library', './library.js', 'createLibrary'],            // 素材库面板：open
  ['timeline', './timeline.js', 'createTimeline'],         // 时间轴：open/addAsset/renderExport
  ['projectHub', './project-hub.js', 'createProjectHub'],  // 项目：open/saveVersion/listVersions/restoreVersion
  ['workspace', './workspace.js', 'createWorkspace'],    // 账户工作区：身份验证后手动备份、分享和冲突处理
];

const WORKSPACE_DISABLED = '托管网页版暂不提供云端工作区：项目只保存在当前浏览器，请用“导出工程包”备份和迁移';
async function loadDomains(deps) {
  const modules = {}, status = {};
  for (const [name, path, factory] of MODULE_SPECS) {
    // 运行形态未开放的模块不加载（托管版：云端工作区依赖尚未部署的账户接口）
    if (name === 'workspace' && !feature('workspace')) { modules[name] = null; status[name] = { ok: false, disabled: true, error: WORKSPACE_DISABLED }; continue; }
    try {
      const m = await import(path);
      if (typeof m?.[factory] !== 'function') throw new Error(`缺少导出 ${factory}`);
      modules[name] = m[factory](deps);
      deps[name] = modules[name];
      status[name] = { ok: true };
    } catch (e) {
      modules[name] = null;
      status[name] = { ok: false, error: String(e?.message ?? e) };
    }
  }
  // 助手依赖其他域，待全部就绪后实例化（合同：data actions + 提案预览后执行）
  try {
    const m = await import('./assistant.js');
    if (typeof m?.createAssistant !== 'function') throw new Error('缺少导出 createAssistant');
    modules.assistant = m.createAssistant(deps);
    deps.assistant = modules.assistant;
    status.assistant = { ok: true };
  } catch (e) {
    modules.assistant = null;
    status.assistant = { ok: false, error: String(e?.message ?? e) };
  }
  return { modules, status };
}

// ---------- 面板纯函数段（导出供 node --test 模块测试；装配层语义不变）----------

// 键控列表增量重铺：按 key 复用既有 DOM 子树，sig 变化的项才重建。
// 复用项仅做原位移动（insertBefore），不从文档摘除——行内焦点与交互状态保留；
// 任务轮询驱动的高频刷新下未变行零重建（与节点 bodyKey 同一策略）。
const KEYED_LISTS = new WeakMap();   // listEl → Map(key → {el, sig})
export function reconcileKeyedList(list, entries) {
  let cache = KEYED_LISTS.get(list);
  if (!cache) { cache = new Map(); KEYED_LISTS.set(list, cache); }
  const used = new Set();
  let i = 0;
  for (const { key, sig, build } of entries) {
    used.add(key);
    let rec = cache.get(key);
    if (!rec || rec.sig !== sig) { rec = { el: build(), sig }; cache.set(key, rec); }
    const cur = list.children[i];
    if (cur !== rec.el) list.insertBefore(rec.el, cur ?? null);
    i++;
  }
  while (list.children.length > entries.length) list.lastElementChild.remove();
  for (const k of cache.keys()) if (!used.has(k)) cache.delete(k);
}

// 任务面板条目构建：key = 记录身份（pending 用幂等键、任务用 taskId）；
// sig = 影响渲染的全部字段快照——sig 不变即复用既有 .task-item，未变行不重建、行内交互态不丢。
// 需要点击时点最新状态的判断（节点是否已受理为任务）在 handler 内实时查 store，不依赖构建期快照。

// 统一任务中心视图（R05-A）：把核心五种独立事实（服务器生成 / 查询健康 / 本地保存 / 节点关联 / 本地实体）
// 映射为一个显示状态 + 一组明确动作。纯函数：local 为 runner.localResult 的摘要 {ready, reason}，
// 由调用方异步预取；未预取时视为未核验，绝不依据 resultBlobId/resultAssetId/hasLocalResult 显示「本地可用」。
// 不提供含糊的「重试」：每个动作都说明它做什么（只查询原任务 / 只下载原任务 / 只停本地 GET / 请求服务器取消 / 显式新版本）。
// queryError 为 {status, code, message}（旧记录可能是字符串）
const queryErrorText = e => (typeof e === 'object' ? `${e.status ? `HTTP ${e.status} ` : ''}${e.message ?? e.code ?? '查询失败'}` : String(e)).slice(0, 60);
const QUERY_TROUBLE = new Set(['retrying', 'needs_review', 'auth_required']);
export const TASK_CENTER_STATES = ['unsupported', 'save_pending', 'local_verified', 'need_key', 'query_review', 'paused',
  'server_failed', 'server_cancelled', 'server_expired', 'link_expired', 'ready_to_download', 'delivering', 'detached', 'reconciling', 'generating', 'accepted', 'preparing'];
export function taskCenterView(t, local, { keyFp, accountSubject = null, serverCancel = true } = {}) {
  const ready = local?.ready === true;
  const v = { state: '', label: '', tone: 'busy', detail: [],
    actions: { requery: false, download: false, stopWaiting: false, cancel: false, newVersion: false, preview: ready } };
  const say = s => v.detail.push(s);
  if (t.detached) say('已脱离节点：结果不会写回原节点');
  if (t.downloadExpired && ready) say('远端下载链接已过期；本机完整文件已校验，可继续预览、保存和用于时间线');
  if (!isSupportedTaskRecord(t)) {
    Object.assign(v, { state: 'unsupported', label: '记录版本较新 · 只读', tone: 'warn' });
    say('该任务由更新版本的画布写入，本版本不查询、不下载、不改写它');
    v.actions.preview = false;
    return v;
  }
  if (t.localSaveState === 'pending' || t.localSaveState === 'blocked') {
    Object.assign(v, { state: 'save_pending', label: '本地保存失败 · 待恢复', tone: 'err' });
    say(`任务状态尚未写入本机${t.localSaveError ? `（${String(t.localSaveError).slice(0, 60)}）` : ''}；请保持页面打开，系统按原任务号自动重试写入，期间不会新建付费任务`);
    return v;
  }
  if (ready) {
    Object.assign(v, { state: 'local_verified', label: '本地文件已校验', tone: 'ok' });
    v.actions.newVersion = isSettled(t);
    if (t.terminalConflict) say('服务器终态记录存在冲突，已按本机已校验文件展示；工作流不会据此自动推进');
    return v;
  }
  // 身份匹配与核心 task-status 同口径：已核验账户拥有该任务，或同一把密钥
  const idMatch = (accountSubject && t.ownerSubject === accountSubject) || (keyFp != null && t.keyFp === keyFp);
  const pausedForKey = t.paused && (t.authFailed || t.queryHealth === 'auth_required' || ((keyFp != null || accountSubject != null) && !idMatch));
  const cancelable = rec => serverCancel && canRequestCancel(rec);
  if (!serverCancel && canRequestCancel(t) && !isSettled(t)) say('服务器暂不支持取消：可以停止本地等待，但任务仍可能生成并计费');
  if (pausedForKey || (!t.paused && t.queryHealth === 'auth_required')) {
    Object.assign(v, { state: 'need_key', label: '需原密钥', tone: 'warn' });
    say('查询需要提交该任务时使用的密钥；换回原密钥后点「继续查询」');
    v.actions.requery = true;
    return v;
  }
  const unverifiedAbsence = (t.status === 'not_found' || t.status === 'expired') && !isFinalFailure(t) && !isSettled(t);
  // requery 在首个 GET 前把 queryHealth 置为 retrying 且无 queryError：那是「正在查询」，不是查询异常
  const queryTrouble = QUERY_TROUBLE.has(t.queryHealth) && !(t.queryHealth === 'retrying' && !t.queryError);
  if (!t.paused && (t.terminalConflict || queryTrouble || unverifiedAbsence)) {
    const retrying = t.queryHealth === 'retrying' && !t.terminalConflict && !unverifiedAbsence;
    Object.assign(v, { state: 'query_review', label: retrying ? '查询异常 · 自动重试中' : '查询异常 · 待核对', tone: 'warn' });
    if (t.terminalConflict) say('收到互相矛盾的终态，已保留首次落盘结果，待人工核对');
    if (unverifiedAbsence) say('查询未能确认任务状态（不等于生成失败）');
    if (t.queryError) say(`查询：${queryErrorText(t.queryError)}`);
    if (retrying && t.nextQueryAt) say(`下次查询约 ${fmtTime(t.nextQueryAt)}`);
    v.actions.requery = true;
    v.actions.stopWaiting = retrying;
    v.actions.cancel = cancelable(t);
    return v;
  }
  if (t.paused) {
    Object.assign(v, { state: 'paused', label: '已停止本地等待', tone: 'warn' });
    say('只是本机不再查询；服务器上的任务不受影响，可能仍会生成并计费');
    v.actions.requery = true;
    v.actions.cancel = cancelable(t);
    return v;
  }
  if (isFinalFailure(t)) {
    const st = t.status === 'cancelled' ? ['server_cancelled', '服务器已取消'] : t.status === 'failed' ? ['server_failed', '服务器生成失败'] : ['server_expired', '服务器已过期'];
    Object.assign(v, { state: st[0], label: st[1], tone: 'err' });
    if (t.error) say(String(t.error?.message ?? t.error).slice(0, 80));
    v.actions.newVersion = true;
    return v;
  }
  if (t.status === 'completed') {
    v.actions.newVersion = isSettled(t);
    if (t.downloadExpired) {
      Object.assign(v, { state: 'link_expired', label: '已生成 · 下载链接已过期', tone: 'err' });
      say(local?.reason ? `本机没有可用完整文件（${local.reason}）` : '本机没有可用完整文件');
      return v;
    }
    if (canFetchContent(t)) {
      Object.assign(v, { state: 'ready_to_download', label: '已生成 · 待下载到本机', tone: 'busy' });
      v.actions.download = true;
      return v;
    }
    Object.assign(v, { state: 'delivering', label: '已生成 · 交付中', tone: 'busy' });
    say('服务器已生成，正在准备可下载文件');
    v.actions.stopWaiting = needsTracking(t);
    v.actions.requery = !needsTracking(t);
    v.actions.cancel = cancelable(t);
    return v;
  }
  const phase = taskPhase(t, { keyFp, accountSubject });
  const inflight = t.detached ? ['detached', '已脱离节点'] : phase === 'delivering' ? ['delivering', '已生成 · 交付中']
    : phase === 'reconciling' ? ['reconciling', '服务器核对中'] : phase === 'generating' ? ['generating', '生成中']
    : phase === 'preparing' ? ['preparing', '准备中'] : ['accepted', '已受理'];
  Object.assign(v, { state: inflight[0], label: inflight[1], tone: t.detached ? 'warn' : 'busy' });
  if (t.cancelRequested) say('已请求停止后续尝试；任务仍可能成功交付并按原价收费');
  v.actions.stopWaiting = needsTracking(t);
  v.actions.requery = !needsTracking(t);
  v.actions.cancel = cancelable(t);
  return v;
}
const REQUERY_REASON = {
  task_missing: '本机找不到该任务记录',
  identity_changed: '当前项目或密钥与提交该任务时不一致，未查询',
  local_save_pending: '任务状态尚未写入本机，暂不能查询；请稍后再试',
  task_record_version_unsupported: '任务记录版本高于当前客户端，未查询',
};
// 首次终态等写盘失败时，持久稿仍是旧状态；运行器内存里的待恢复记录才是真相——覆盖显示，避免「本地保存失败」不可见
export const liveTaskRecords = (persisted, runner) => persisted.map(t => {
  const live = runner.taskPeek?.(t.taskId, t.projectId);
  return live && (live.localSaveState === 'pending' || live.localSaveState === 'blocked') ? live : t;
});
export const requeryReasonText = reason => REQUERY_REASON[reason] ?? `未能开始查询（${reason ?? '未知原因'}）`;


// v2 标记字段均参与 isV2Record → 谓词族，sig/bodyKey 必须全覆盖——
// 直接循环 task-status.js 导出的 V2_MARK_FIELDS，防止漏字段让受损-v2 翻转不重建。
// 无幂等键/无节点引用的 pending 记录按内容定键（state+createdAt+model+lastError），
// 避免数组位置退化为 key、列表收缩时同 index 复用错记录闭包。
const pendingKeyOf = r => `pending:${r.idempotencyKey ?? r.nodeId
  ?? JSON.stringify([r.state ?? '', r.createdAt ?? 0, r.model ?? '', String(r.lastError ?? '').slice(0, 40)])}`;
export function taskPanelEntries({ tasks = [], pending = [], store, runner, board, editor, keyFp, accountSubject = null, serverCancel = true, localOf = () => null, busyBtn = (b, f) => b.addEventListener('click', f) }) {
  const entries = [];
  for (const r of pending) {
    entries.push({
      key: pendingKeyOf(r),
      sig: JSON.stringify([r.state ?? '', r.model ?? '', r.createdAt ?? 0, r.lastError ?? '', r.nodeId ?? '', store.node(r.nodeId) ? 1 : 0]),
      build: () => {
        const recover = el('button', { class: 'mini', type: 'button', text: store.node(r.nodeId) ? '定位节点' : '恢复节点' });
        busyBtn(recover, async () => {
          const existing = store.node(r.nodeId);
          // 节点已受理为任务或已关联同键 pending → 仅定位，不覆盖（点击时实查任务集，避免复用行的陈旧快照）
          const accepted = (await store.tasksOfProject()).find(t => t.taskId === existing?.data.run?.taskId && t.idempotencyKey === r.idempotencyKey);
          if (accepted || existing?.data.run?.pendingKey === r.idempotencyKey) { board.focusNode(existing.id); return; }
          if (typeof runner.restorePending === 'function') {
            const n = await runner.restorePending(r.idempotencyKey);
            if (n) { board.focusNode(n.id); toast('已恢复未确认提交的节点', 'ok'); return; }
          }
          toast(existing ? '原节点已有在途提交，未覆盖' : '无法恢复：原节点已删除且恢复接口不可用', 'warn', 6000);
        });
        const rows = [
          el('div', { class: 'row' }, el('b', { text: getModel(r.model)?.display_name ?? r.model }), el('span', { class: `badge ${r.state === 'rejected' || r.state === 'conflict' ? 'err' : r.state === 'uncertain' ? 'busy' : 'warn'}`, text: { uncertain: '提交未确认', rejected: '已拒绝', conflict: '幂等冲突', abandoned: '已放弃跟踪', expired_window: '超出重试窗口' }[r.state] ?? r.state })),
          el('div', { class: 'row muted' }, el('span', { text: '提交于' }), el('span', { text: fmtTime(r.createdAt) })),
        ];
        if (r.lastError) rows.push(el('div', { class: 'row muted' }, el('span', { text: String(r.lastError).slice(0, 80) })));
        rows.push(el('div', { class: 'row actions' }, recover));
        return el('div', { class: 'task-item' }, ...rows);
      },
    });
  }
  for (const t of tasks) {
    // 本地实体核验摘要（refreshTasks 异步预取 runner.localResult；未预取 = 未核验，按不可用处理）
    const local = localOf(t.taskId) ?? { ready: false, reason: 'unchecked' };
    entries.push({
      key: `task:${t.taskId}`,
      // sig 覆盖谓词与渲染依赖的全部字段（合同 §8：统一谓词变化只重建该行）；
      // V2_MARK_FIELDS 循环保证 v2 标记字段全覆盖；0.5 核心新增的查询健康 / 本地保存 / 交付到期 /
      // 终态冲突 / 暂停来源 / 记录版本，以及本地实体核验结果，都会改变显示与可用动作。
      sig: JSON.stringify([t.status ?? '', t.deliveryStatus ?? '', t.paused === true, t.detached === true,
        ...V2_MARK_FIELDS.map(f => t[f] ?? null), t.downloadExpiresAt ?? null,
        t.cancelRequested === true, t.executorVersion ?? null,
        t.authFailed === true, t.keyFp ?? '', t.keyFp === keyFp ? 1 : 0, t.ownerSubject ?? '', accountSubject ?? '', serverCancel ? 1 : 0,
        t.queryHealth ?? '', t.queryError ? queryErrorText(t.queryError) : '', t.nextQueryAt ?? null,
        t.localSaveState ?? '', String(t.localSaveError ?? '').slice(0, 60), t.downloadExpired === true,
        t.terminalConflict ? 1 : 0, t.terminalEvidence ?? '', t.pauseSource ?? '', t.recVersion ?? null,
        t.resultBlobId ? 1 : 0, t.resultAssetId ?? '', local.ready === true, local.reason ?? '',
        t.model ?? '', t.createdAt ?? 0,
        String(t.error?.message ?? t.error ?? '').slice(0, 80), String(t.pollError ?? '').slice(0, 60),
        t.resultType ?? '', t.nodeId ?? '', store.node(t.nodeId) ? 1 : 0]),
      build: () => {
        const view = taskCenterView(t, local, { keyFp, accountSubject, serverCancel });
        const acts = [];
        const btn = (text, title, fn) => { const b = el('button', { class: 'mini', type: 'button', text, title }); busyBtn(b, fn); acts.push(b); return b; };
        if (view.actions.requery) btn('继续查询', '只查询原任务状态，不创建新任务、不重新计费', async () => {
          const r = typeof runner.requery === 'function' ? await runner.requery(t.taskId, t.projectId) : { started: false, reason: 'unavailable' };
          if (r?.started) toast('已开始查询原任务', 'ok');
          else toast(requeryReasonText(r?.reason), 'warn', 6000);
        });
        if (view.actions.download) btn('恢复下载', '只下载原任务的成片到本机', async () => {
          const ok = await runner.download(t.taskId);
          toast(ok === true ? '成片已保存到本机' : '下载尚未完成，可稍后再次恢复下载', ok === true ? 'ok' : 'warn');
        });
        if (view.actions.preview) {
          // 预览 / 保存：resultURL 与 releaseResultURL 成对调用（核心只校验实体，URL 生命周期由调用方负责）
          btn('预览', '播放本机已校验的成片', async () => {
            const u = await runner.resultURL(t.taskId, t.projectId);
            if (!u) { toast('本机成片未通过校验，请刷新任务列表', 'warn'); return; }
            const video = el('video', { src: u, controls: true, autoplay: true, style: 'width:100%;border-radius:8px' });
            const release = () => { video.pause(); video.removeAttribute('src'); video.load(); runner.releaseResultURL?.(u); };
            modal(el('div', {}, video), { onClose: release });   // 关闭（按钮 / 遮罩 / Esc）即释放 object URL
          });
          btn('保存', '把本机已校验的成片另存为文件', async () => {
            const u = await runner.resultURL(t.taskId, t.projectId);
            if (!u) { toast('本机成片未通过校验，请刷新任务列表', 'warn'); return; }
            try {
              const a = el('a', { href: u, download: `成片-${String(t.taskId).slice(0, 8)}.${t.resultType === 'video/webm' ? 'webm' : 'mp4'}` });
              document.body.append(a); a.click(); a.remove();
            } finally { setTimeout(() => runner.releaseResultURL?.(u), 30000); }   // 留足浏览器开始保存的时间
          });
        }
        // 停止本地等待：只停本端 GET，不代表服务器取消或失败
        if (view.actions.stopWaiting) btn('停止本地等待', '本机不再查询；服务器上的任务不受影响', () => runner.setPollPaused(t.taskId, true, t.projectId));
        // 请求取消仅 v2 在途开放（canRequestCancel 含 executorVersion===2 门槛）——旧接口不虚假开放
        if (view.actions.cancel) btn('请求取消', '请求服务器停止后续渠道尝试', async () => {
          const node = store.node(t.nodeId) ?? await runner.restoreTask(t.taskId);
          if (!node) { toast('节点已删除且无法找回，任务仍在任务列表跟踪', 'warn', 5000); return; }
          const ok = await confirmDialog('请求取消该任务？', el('p', { text: '将请求服务器停止后续渠道尝试；当前上游可能仍会生成，若最终可交付成功仍按原价收费，取消不保证立即退款。任务号保留。' }));
          if (ok) await runner.cancelTask(node);
        });
        // 创建新版本：显式动作，复制参数与连线为草稿，原任务与成片保留，新版本需手动提交
        if (view.actions.newVersion) btn('创建新版本', '复制参数和连线为新草稿；原任务及成片保留，新版本需手动提交', async () => {
          let n = store.node(t.nodeId);
          if (!n) n = await runner.restoreTask(t.taskId);
          if (!n) { toast('无法恢复该任务的节点（任务记录仍保留）', 'warn', 5000); return; }
          const copies = editor?.duplicate?.([n.id]) ?? [];
          if (copies[0]) { board.focusNode(copies[0].id); toast('新版本草稿已创建（未提交），原任务和成片保留', 'ok'); }
        });
        // 较新版本记录只读：只定位已持有该任务的节点，不走会改写记录/新增节点的 restoreTask
        const bound = (store.project?.nodes ?? []).find(n => n.data?.run?.taskId === t.taskId);
        if (view.state === 'unsupported') { if (bound) btn('定位节点', '', () => board.focusNode(bound.id)); }
        else btn(store.node(t.nodeId) ? '定位节点' : '找回节点', '', async () => {
          const existing = store.node(t.nodeId);
          if (existing?.data.run?.taskId === t.taskId) { board.focusNode(existing.id); return; }
          if (typeof runner.restoreTask === 'function') {
            const n = await runner.restoreTask(t.taskId);
            if (n) { board.focusNode(n.id); toast('已找回任务节点', 'ok'); return; }
            if (existing) { board.focusNode(existing.id); return; }
          }
          toast('无法恢复该任务的节点（任务记录仍保留）', 'warn', 5000);
        });
        const rows = [
          el('div', { class: 'row' }, el('b', { text: getModel(t.model)?.display_name ?? t.model }),
            el('span', { class: `badge ${view.tone}`, text: view.label, 'data-task-state': view.state })),
          el('div', { class: 'row muted' }, el('span', { class: 'task-id', text: String(t.taskId), title: '任务号（所有操作都保留该任务号）' }), el('span', { text: fmtTime(t.createdAt) })),
        ];
        for (const d of view.detail) rows.push(el('div', { class: 'row muted' }, el('span', { text: d })));
        if (t.pollError && !t.queryError) rows.push(el('div', { class: 'row muted' }, el('span', { text: `查询：${String(t.pollError).slice(0, 60)}` })));
        rows.push(el('div', { class: 'row actions' }, ...acts));
        return el('div', { class: 'task-item', 'data-task-id': String(t.taskId), 'data-task-state': view.state }, ...rows);
      },
    });
  }
  return entries;
}

// 工作流运行范围解析（合同 §6.2/§8）：'selection' 原样返回选中集——空选择即空集，
// 由启动方显式拒绝并提示先选择，绝不回落全画布；'all' 必须用户显式选择；
// 'group:<id>' 仅该组存活成员（必需上游闭包由工作流 plan 负责，见合同 §6.2）。
const WORKFLOW_RUNNABLE_TYPES = new Set(['gen', 'image', 'text', 'utility']);
export function workflowScopeTargets(scope = 'selection', { selectedIds = [], groups = [], nodes = [] } = {}) {
  if (typeof scope === 'string' && scope.startsWith('group:')) {
    const group = groups.find(g => g.id === scope.slice(6));
    if (!group?.members?.length) throw new Error('该分组已删除或没有节点，请重新选择运行范围');
    const members = group.members.filter(id => nodes.some(n => n.id === id));
    if (!members.length) throw new Error('该分组没有可运行节点');
    return members;
  }
  if (scope === 'all') return nodes.filter(n => WORKFLOW_RUNNABLE_TYPES.has(n.type)).map(n => n.id);
  return [...selectedIds];
}

async function boot() {
  initProviders();
  const rawStorage = await createIdbStorage();
  await loadCapabilities();
  // 托管形态：服务器核验账户之前不启动画布；账户存储、API 客户端与会话失效全部来自核心 openHostedCanvasSession。
  // 本机形态：原有 /site 代理与未分区存储，行为不变。
  // 会话失效状态先于登录门建立：失效可能发生在界面模块初始化完成之前
  const sessionState = { invalid: null, runnerStopped: false, closing: false, closed: false, pendingLocalSaves: 0 };
  const hosted = isHosted() ? await signInGate({ rawStorage, base: RUNTIME.apiBase, onSessionInvalid: info => invalidateSession(info) }) : null;
  const storage = hosted ? hosted.storage : rawStorage;
  const api = hosted ? hosted.api : createSiteClient({ base: RUNTIME.apiBase, getKey: keyvault.getKey, getProvider });
  const accountScope = hosted?.storage ?? null;
  const serverCancel = hosted ? hosted.features?.features?.cancel === true : true;
  const store = createStore(storage, {
    // rev_conflict＝其他标签页 CAS 拒收：本地草稿由 store 完整保留（不覆盖不丢弃），
    // 短提示指向既有「项目版本」面板内的冲突恢复入口；不自动弹窗、不改其他逻辑。
    onPersistError: e => e?.code === 'rev_conflict'
      ? toast('其他标签页已有更新，本地草稿已保留——到「版本」中处理冲突', 'warn', 5000)
      : toast(`本地保存失败（${e.name || 'Error'}）：${e.message}`, 'err', 6000),
  });
  store0 = store;
  const assets = createAssets({ store, storage, api, onSpawnNode: id => spawnAssetNode(id) });
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate: refreshDynamic, ...(accountScope ? { accountScope } : {}) });
  if (sessionState.invalid) applyInvalidProtection();   // 运行器创建前已失效：创建后立即补做保护
  const host = createDirectorHost({ store, storage, assets, api,
    spawnPosition: type => spawnPos(SPAWN_H[type]) });
  if (sessionState.invalid) host.closeAll('登录已失效');
  // 3D 导演台为「开发中」功能：插件资源（MiniMax 导演台）不随代码仓库分发。
  // 本机服务状态四态（检测中 / 可用 / 不可用 / 检测失败）：只有服务正面确认资源完整时才创建或打开导演台；
  // 检测中、超时、失败或旧服务未报告字段时给出说明与「重新检测」，绝不新建空白导演台节点。
  // 所有打开入口（顶栏、侧栏、添加菜单、节点卡片、检查器）都经 host.openEditor / directorGate，统一在此把关。
  const service = createServiceStatus({ build: BUILD, onChange: () => refreshServiceChrome() });
  service.check();
  const directorGate = retry => {
    if (service.state.director === 'available') return true;
    const st = service.state;
    const title = st.director === 'checking' ? '正在检测导演台资源…' : '3D 导演台（开发中）';
    const reason = st.director === 'checking' ? '正在向本机服务确认导演台插件资源，请稍候。'
      : st.director === 'unavailable' ? `导演台仍在开发中，当前环境无法打开：${st.directorReason}（插件资源不随代码仓库分发）。`
      : `无法确认导演台资源：${st.directorReason}。`;
    const again = el('button', { class: 'primary', type: 'button', text: '重新检测' });
    const { close } = modal(el('div', { class: 'director-gate' }, el('h3', { text: title }),
      el('p', { text: reason }),
      el('p', { class: 'hint', text: '画布、分镜、生成、任务、剪辑与工程包等其他功能不受影响；已有工程中的导演台节点与数据会原样保留。' }),
      el('div', { class: 'modal-actions' }, again)));
    again.addEventListener('click', async () => {
      again.disabled = true; again.textContent = '检测中…';
      await service.check();
      close();
      if (service.state.director === 'available') { if (typeof retry === 'function') retry(); }
      else directorGate(retry);
    });
    return false;
  };
  const openDirectorEditor = host.openEditor;
  host.openEditor = node => (directorGate(() => openDirectorEditor(node)) ? openDirectorEditor(node) : false);
  // 顶栏构建版本徽标 + 前后端不匹配提示条（以运行中服务报告为准）
  function refreshServiceChrome() {
    const st = service.state, h = st.health;
    const badge = document.getElementById('build-badge');
    if (badge) {
      badge.textContent = `v${BUILD.version}`;
      badge.title = [`页面构建 ${BUILD.version}${BUILD.sourceCommit ? `（${BUILD.sourceCommit.slice(0, 12)}${BUILD.sourceDirty ? '，含未提交改动' : ''}）` : ''}`,
        isHosted() ? `托管网页版（${RUNTIME.basePath}）：${st.compat === 'not-checked' ? '未配置托管就绪检查' : st.compatReason ?? '服务正常'}`
          : h ? `本机服务 ${h.version ?? '未报告版本'}（协议 ${h.apiLevel ?? '未报告'}${h.instance?.startedAt ? `，启动于 ${fmtTime(Date.parse(h.instance.startedAt))}` : ''}）` : `本机服务：${st.compatReason ?? '检测中'}`,
      ].join('\n');
      badge.dataset.compat = st.compat;
    }
    const bar = document.getElementById('service-banner');
    if (!bar) return;
    if (sessionState.invalid) return renderSessionExpired();
    const warn = ['service-outdated', 'page-outdated'].includes(st.compat) || (st.compat === 'unknown' && st.checkedAt);
    bar.hidden = !warn;
    const svc = isHosted() ? '托管服务' : '本机服务';
    if (warn) bar.replaceChildren(el('span', { text: st.compat === 'service-outdated'
        ? (isHosted() ? `${st.compatReason}。服务正在更新，请稍后刷新页面。` : `${st.compatReason}。请重启本机服务后刷新页面；未重启前部分新功能（如导演台检测）不可用。`)
      : st.compat === 'page-outdated' ? `${st.compatReason}。` : `无法确认${svc}状态：${st.compatReason}。` }),
      (() => { const b = el('button', { class: 'mini', type: 'button', text: '重新检测' }); b.addEventListener('click', () => service.check()); return b; })());
  }
  const devBadge = () => el('span', { class: 'dev-badge', text: '开发中', title: '功能开发中' });
  const editor = createEditor(store, storage);
  window.addEventListener('message', host.onMessage);

  // 导演台原生控件（父页侧模块，director 域提供）：加载失败仅降级检查器，不拖垮启动
  let dirCtl = null;
  try {
    const dm = await import('./director-controls.js');
    if (typeof dm?.createDirectorControls !== 'function') throw new Error('缺少导出 createDirectorControls');
    dirCtl = dm.createDirectorControls({ store, storage, host });
  } catch (e) {
    console.warn('[canvas] director-controls 未就绪：', e?.message ?? e);
  }

  await (await store.lastOpened() ?? store.newProject('默认画布'));

  // ---------- 项目 ----------
  async function refreshProjectList() {
    const items = await store.listProjects();
    $('#project-list').replaceChildren(...items.map(p => el('option', { value: p.id, text: p.name, selected: p.id === store.project?.id })));
    if (!items.length) $('#project-list').append(el('option', { text: '（无项目）' }));
  }
  $('#project-list').addEventListener('change', async e => {
    // An asynchronous list refresh can change the select while saving is pending.
    const projectId = e.target.value;
    await store.flush(); await store.openProject(projectId); await afterProjectSwitch();
  });
  $('#btn-new-project').addEventListener('click', async () => { await store.flush(); await store.newProject(); await afterProjectSwitch(); });
  $('#btn-rename').addEventListener('click', async () => {
    const input = el('input', { type: 'text', value: store.project.name });
    const ok = el('button', { class: 'primary', type: 'button', text: '保存' });
    const { close } = modal(el('div', {}, el('h3', { text: '重命名项目' }), input, el('div', { class: 'modal-actions' }, ok)));
    ok.addEventListener('click', async () => { store.project.name = input.value.trim() || store.project.name; await store.flush(); close(); refreshProjectList(); });
  });
  $('#btn-export').addEventListener('click', async () => {
    try {
      const text = await store.exportJSON();
      const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `${store.project.name}.canvas.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('已导出（不含 API Key 与素材文件本体；素材需重新绑定本地文件）', 'ok', 5000);
    } catch (e) { toast(`导出失败：${e.message}`, 'err'); }
  });
  function importCanvasFile() {
    const inp = el('input', { type: 'file', accept: '.json,application/json' });
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      try { const p = await store.importJSON(await file.text()); await afterProjectSwitch(); toast(`导入完成：${p.name}（缺失素材请在检查器中重新绑定文件）`, 'ok', 5000); }
      catch (e) { toast(`导入失败：${e.message}`, 'err', 6000); }
    });
    inp.click();
  }
  $('#btn-import').addEventListener('click', importCanvasFile);

  // ---------- API Key ----------
  // ---- 会话失效：单一、幂等的生命周期转换（不等用户点击） ----
  // ① 同步：会话守卫已拒绝本会话的一切新请求；停止任务运行器（轮询、上传、保存重试、对象 URL），记下待恢复的本地保存数。
  // ② 响应处理器之外（下一轮事件循环）：停止工作流调度 → 尽力把项目落盘到原账户 → 使账户存储会话失效。
  //    不在触发失效的那个请求回调里等待自身关停，避免死锁；迟到响应由核心按会话存活检查丢弃。
  // ③ 显示重新登录入口；重新登录后按原任务号恢复查询，不会重新生成。已中止的传输不作为“任务未受理”的证据。
  function invalidateSession(info) {
    if (!hosted || sessionState.invalid) return;
    sessionState.invalid = info ?? { kind: 'auth_invalid', at: Date.now() };
    applyInvalidProtection();
  }
  function applyInvalidProtection() {
    const st = sessionState;
    if (!st.invalid) return;
    try { host.closeAll('登录已失效'); } catch { /* host may still be initializing */ }
    if (!st.runnerStopped) {
      try { st.pendingLocalSaves = runner.stopForIdentityChange()?.pendingLocalSaves ?? 0; st.runnerStopped = true; }
      catch { /* 运行器尚未创建：创建后由调用方补做 */ }
    }
    if (st.runnerStopped && !st.closing) {
      st.closing = true;
      setTimeout(async () => {
        try { await modules.workflow?.stopForIdentityChange?.(); } catch { /* 模块未加载：加载后补做 */ }
        try { await store.flushForSwitch?.(); } catch { /* 尽力落盘；未写入的由重新登录后按原任务号恢复 */ }
        try { hosted.invalidate(); } catch { /* 已失效 */ }
        st.closed = true;
        renderSessionExpired();
        try { refreshDynamic(); } catch { /* 界面尚未就绪 */ }
      }, 0);
    }
    renderSessionExpired();
  }
  function renderSessionExpired() {
    const bar = document.getElementById('service-banner');
    if (!bar || !sessionState.invalid) return;
    const again = el('button', { class: 'mini', type: 'button', text: '重新登录' });
    again.addEventListener('click', () => signOut());
    const pending = sessionState.pendingLocalSaves;
    bar.hidden = false;
    bar.dataset.session = 'invalid';
    bar.replaceChildren(el('span', { text: `登录已失效（${sessionState.invalid.kind === 'identity_changed' ? '账户身份已变更' : sessionState.invalid.kind === 'identity_forbidden' ? '账户权限不可用' : '用户站登录已过期或退出'}），已停止本账户的任务查询、工作流与新的付费请求。`
      + (pending ? `有 ${pending} 个任务的最新状态尚未写入本机，重新登录后会按原任务号重新查询恢复。` : '')
      + '请重新登录后继续；进行中的任务会按原任务号恢复查询，不会重新生成。' }), again);
  }
  async function signOut() {
    // 尚未写入本机的任务状态：说明后再离开（重新登录后按原任务号重新查询恢复，不会重新生成）
    const pending = liveTaskRecords(await store.tasksOfProject().catch(() => []), runner)
      .filter(t => t.localSaveState === 'pending' || t.localSaveState === 'blocked').length;
    if (pending && !(await confirmDialog('仍有任务状态未写入本机', el('p', { text: `有 ${pending} 个任务的最新状态尚未保存到本机。现在退出后，重新登录时会按原任务号重新查询并恢复，不会重新生成或重复计费。` })))) return;
    host.closeAll('账号已退出');
    await endHostedSession({ session: hosted, runner, workflow: modules.workflow, store });
  }
  function keyBadge() {
    const b = $('#btn-key');
    if (hosted) {
      const who = hosted.identity.displayName || `账户 ${hosted.identity.subject}`;
      b.classList.add('ok'); b.textContent = who; b.setAttribute('aria-label', `当前账户：${who}`); b.title = `当前账户：${who}（点击切换账户或退出）`;
      applyIcon(b, 'key', who);
      return;
    }
    b.classList.toggle('ok', keyvault.hasKey());
    const status = keyvault.hasKey() ? '密钥已设置' : '未设密钥';
    const label = getProvider().id === 'xingpan' ? status : `${getProvider().name} · ${status}`;
    b.textContent = label; b.setAttribute('aria-label', label); b.title = label; applyIcon(b, 'key', label);
  }
  if (hosted) $('#btn-key').addEventListener('click', () => {
    const out = el('button', { class: 'primary', type: 'button', text: '切换账户 / 退出' });
    const { close } = modal(el('div', {}, el('h3', { text: '账户' }),
      el('p', { text: `当前账户：${hosted.identity.displayName || hosted.identity.subject}（由服务器核验）` }),
      el('p', { class: 'hint', text: STORAGE_NOTICE }),
      el('p', { class: 'hint', text: '切换账户会先停止本账户的任务查询与工作流，然后重新加载页面；另一账户看不到本账户的项目与任务。' }),
      el('div', { class: 'modal-actions' }, out)));
    out.addEventListener('click', () => { close(); signOut(); });
  });
  else $('#btn-key').addEventListener('click', () => openProviderSettings({ runner, onChanged: () => { keyBadge(); refreshDynamic(); } }));

  if (hosted) {
    try {
      const res = await api.listModels();
      const entries = Array.isArray(res?.data) ? res.data : [];
      keyvault.setModelCatalog(entries);
      keyvault.setAvailableModels(entries.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean));
    } catch (e) { toast(`无法读取可用型号：${e.message}`, 'warn', 6000); }
  }

  // ---------- 节点板 ----------
  const kindOf = node => {
    if (node.type === 'asset') return assets.assetOfNode(node)?.kind ?? 'media';
    if (node.type === 'gen') return 'video';
    if (node.type === 'image') return 'image';
    if (node.type === 'text') return 'text';
    if (node.type === 'utility') return 'any';
    if (node.type === 'director') return 'media';
    return 'media';
  };

  // 域模块占位（加载完成后填充）：renderBody/inspector 延迟读取，缺席走本地兜底
  let modules = {}, moduleStatus = {};
  let shell = null;

  // ---- 本地兜底节点体（域模块缺席时仍可用，无假能力）----
  function textBodyFallback(node) {
    const box = el('div', {});
    const ta = el('textarea', { value: node.data.text ?? '', placeholder: '文本内容（可作为下游文本/提示词来源）' });
    ta.addEventListener('input', () => { node.data.text = ta.value; store.saveSoon(); });
    box.append(ta);
    if (node.data.resultText) box.append(el('p', { class: 'hint', text: `最近生成：${String(node.data.resultText).slice(0, 60)}…` }));
    return box;
  }
  function imageBodyFallback(node) {
    const box = el('div', {});
    const first = node.data.outputAssetIds?.[0] ?? node.data.resultAssetId;
    if (first) assets.objectURL(first).then(u => { if (u) box.prepend(el('img', { class: 'preview', src: u })); });
    box.append(el('div', { class: 'row' }, el('span', { text: '提示词' }), el('b', { text: (node.data.prompt || '—').slice(0, 40) })));
    box.append(el('p', { class: 'hint', text: modules.generators ? '' : `图片生成模块未加载${moduleStatus.generators?.error ? `：${moduleStatus.generators.error}` : ''}` }));
    return box;
  }
  function toolBodyFallback(node) {
    const box = el('div', {});
    box.append(el('div', { class: 'row' }, el('span', { text: '工具' }), el('b', { text: TOOLS[node.data.tool] ?? node.data.tool ?? '未选择' })));
    if (node.data.outputText) box.append(el('p', { class: 'hint', text: String(node.data.outputText).slice(0, 60) }));
    box.append(el('p', { class: 'hint', text: '工具执行在检查器中操作' }));
    return box;
  }
  const renderBody = node => {
    if (node.type === 'asset') return assets.assetBody(node);
    if (node.type === 'gen') return genBody(node, { runner, store });
    if (node.type === 'director') return directorBody(node, { host });
    if (node.type === 'note') return noteBody(node);
    if (node.type === 'text') return modules.generators?.body?.(node) ?? textBodyFallback(node);
    if (node.type === 'image') return modules.generators?.body?.(node) ?? imageBodyFallback(node);
    if (node.type === 'utility') return modules.tools?.body?.(node) ?? toolBodyFallback(node);
    return el('div', { text: node.type });
  };
  let currentSel = null, nodeComposer = null;
  const board = createBoard({
    store, renderBody, kindOf, editor,
    bodyKey: node => {
      if (node.type !== 'gen') return null;
      const r = runner.taskPeek(node.data.run?.taskId);
      // 结果线索（blob 键或导入工程的素材映射）只决定是否缓存卡片；实体是否可播放由 genBody 内 runner.localResult 核验
      if (!(r?.resultBlobId || r?.resultAssetId) || r.status !== 'completed') return null;
      // 已缓存的成片不随其他节点/侧栏刷新反复重建 video，保持播放位置；0.5 核心的查询健康 / 本地保存 /
      // 交付到期 / 终态冲突 / 暂停来源 / 记录版本变化时重建，使卡片与任务中心同口径。
      return JSON.stringify([directVideoOutput(store.project, node), node.data.draft, node.data.run, r.status, r.resultBlobId ?? null, r.resultAssetId ?? null, r.paused,
        r.error, r.pollError, r.deliveryStatus, r.cancelRequested, r.authFailed, keyvault.getFingerprint(),
        r.queryHealth ?? null, r.queryError ? JSON.stringify(r.queryError) : null, r.localSaveState ?? null, r.downloadExpired === true, r.terminalConflict ? 1 : 0, r.pauseSource ?? null, r.recVersion ?? null,
        ...V2_MARK_FIELDS.map(f => r[f] ?? null), r.downloadExpiresAt ?? null]);   // v2 标记字段全覆盖 + 通用字段 downloadExpiresAt（同任务行 sig 口径）
    },
    onSelect: (sel, options) => {
      currentSel = sel; renderInspector(sel);
      shell?.refreshChrome();   // 选择态驱动壳显隐（has-selection/sel-bar），不 monkey-patch board.select
      if (sel && options?.inspect !== false && innerWidth > 900) shell?.showInspector?.();
      // 小屏选中节点自动展开检查器，不依赖用户再点 ⚙
      if (sel && options?.inspect !== false && innerWidth <= 900) openDrawer('#inspector');
    },
    onEdgesChanged: edge => { const n = store.node(edge.to.node); if (n?.type === 'director') host.notifyIncoming(n.id); refreshDynamic(); },
    onAddMenu: pos => shell?.openAddMenu(pos),
    onNodeMenu: (node, pos) => shell?.nodeMenu(node, pos),
    onWireEnd: (w, pos) => shell?.openAddMenu(pos, w),
    onGroupAction: (action, g, pos) => shell?.handleGroupAction(action, g, pos),
  });
  store.onChange(reason => {
    // 项目切换/导入/副本打开：丢弃旧项目的选中与检查器内容、清掉挂起的节流刷新，避免旧节点参数残留误导编辑
    if (reason?.type === 'project') {
      clearTimeout(inspTimer); clearTimeout(taskTimer);
      currentSel = null; renderInspector(null); refreshTasksSoon();
      // The project hub also opens copies/imports directly through the store.
      // Keep the header bound to that current project, not the previous option.
      void refreshProjectList().catch(e => toast(`项目列表刷新失败：${e.message}`, 'err'));
      const opened = store.project;
      Promise.resolve(modules.generators?.restoreOperations?.()).then(() => { if (store.project === opened) refreshDynamic(); }).catch(e => toast(`生成记录恢复失败：${e.message}`, 'err'));
      return;
    }
    // 纯坐标变化由 board 增量处理，不重刷与位置无关的任务或检查器。
    if (reason?.type === 'move') return;
    // Reference removal must invalidate a submit button even while the prompt
    // keeps keyboard focus and the normal inspector rebuild is postponed.
    if (reason?.type === 'structure') $('#inspector').querySelector('.generation-form, .image-generation-form')?.dispatchEvent(new Event('canvas-graph-change'));
    renderInspectorThrottled();
    refreshTasksSoon();
  });

  // 新节点落点 = 当前可视区中心（扣掉节点半宽并夹进可视区，平移/缩放/小屏下都真实可见）
  const NODE_W = 360, NODE_H = 280;
  // 新节点的高度估计：视频生成卡片明显高于其他卡片，按它的实际高度找空位，避免盖住下方节点
  const SPAWN_H = { gen: 440 };
  const spawnPos = (newH = NODE_H) => {
    const br = $('#board').getBoundingClientRect();
    const vl = -board.view.x / board.view.scale, vt = -board.view.y / board.view.scale;
    const vr = (br.width - board.view.x) / board.view.scale, vb = (br.height - board.view.y) / board.view.scale;
    const center = { x: (vl + vr - NODE_W) / 2, y: (vt + vb - NODE_H) / 2 };
    const occupied = store.project.nodes.map(n => {
      const box = document.querySelector(`[data-node="${n.id}"]`)?.getBoundingClientRect();
      return { x: n.x, y: n.y, w: (box?.width || NODE_W * board.view.scale) / board.view.scale,
        h: Math.max(SPAWN_H[n.type] ?? NODE_H, (box?.height || NODE_H * board.view.scale) / board.view.scale,
          Number(document.querySelector(`[data-node="${n.id}"]`)?.dataset.fullHeight) || 0) };   // 编辑中紧凑显示的卡片按完整高度占位
    });
    const candidates = [];
    for (let ring = 0; ring <= 12; ring++) for (let y = -ring; y <= ring; y++) for (let x = -ring; x <= ring; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
      candidates.push({ x: Math.round(center.x + x * (NODE_W + 28)), y: Math.round(center.y + y * (NODE_H + 80)) });
    }
    const free = p => !occupied.some(n => p.x < n.x + n.w + 16 && p.x + NODE_W + 16 > n.x && p.y < n.y + n.h + 16 && p.y + newH + 16 > n.y);
    return candidates.find(p => p.x >= vl + 8 && p.y >= vt + 8 && p.x + NODE_W < vr - 8 && p.y + newH < vb - 8 && free(p))
      ?? candidates.find(free) ?? { x: Math.round(vr + 28), y: Math.round(vt + 28) };
  };
  function spawnNodeAt(type, pos = spawnPos(SPAWN_H[type]), data = null) {
    const n = store.addNode(type, pos.x, pos.y, data ?? defaultNodeData(type));
    board.select('node', n.id);
    requestAnimationFrame(() => {
      if (store.node(n.id) !== n || board.selectedIds.length !== 1 || board.selectedIds[0] !== n.id) return;
      const r = document.querySelector(`[data-node="${n.id}"]`)?.getBoundingClientRect();
      const b = $('#board').getBoundingClientRect();
      if (r && (r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom)) board.focusNode(n.id);
    });
    return n;
  }
  function spawnAssetNode(id) {
    const a = store.project.assets[id]; if (!a) return;
    const p = spawnPos();
    store.addNode('asset', p.x, p.y, { assetId: id, title: a.name });
  }
  // 文件入库并在指定世界坐标生成素材节点（批量拖入时逐个错开）
  async function addFilesAt(files, pos = null) {
    const list = await assets.addFiles(files);
    list.forEach((a, i) => {
      const p = pos ?? spawnPos();
      store.addNode('asset', p.x + (i % 3) * 60, p.y + Math.floor(i / 3) * 60, { assetId: a.id, title: a.name });
    });
    return list;
  }
  document.querySelectorAll('[data-add-node]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.addNode === 'director' && !directorGate(() => b.click())) return;
    spawnNodeAt(b.dataset.addNode, spawnPos(SPAWN_H[b.dataset.addNode]));
    shell?.closeDock?.('create');
  }));

  $('#btn-add-asset').addEventListener('click', () => {
    const inp = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4' });
    inp.addEventListener('change', () => assets.addFiles([...inp.files]));
    inp.click();
  });

  // ---------- 拖入 / 粘贴 ----------
  // 拖入库素材 → 画布；拖入本地文件 → 入库并生成素材节点
  $('#board').addEventListener('dragover', e => e.preventDefault());
  $('#board').addEventListener('drop', e => {
    e.preventDefault();
    const pos = board.toWorld(e);
    const id = e.dataTransfer.getData('text/x-asset');
    const a = id && store.project.assets[id];
    if (a) { store.addNode('asset', pos.x, pos.y, { assetId: id, title: a.name }); return; }
    const files = [...(e.dataTransfer.files ?? [])];
    if (files.length) addFilesAt(files, pos);
  });
  // 粘贴：剪贴板图片/媒体文件 → 素材节点；纯文本或无文件 → 让位给 Ctrl+V 的节点粘贴
  document.addEventListener('paste', e => {
    if (e.target?.closest?.('input,textarea,select,[contenteditable]')) return;
    if (document.getElementById('overlay-root')?.childElementCount) return;
    // 剪贴板媒体文件优先：取消 keydown 阶段排队的节点粘贴，入库并生成素材节点
    const files = [...(e.clipboardData?.files ?? [])].filter(f => /^(image|video|audio)\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      board.cancelPendingPaste?.();
      addFilesAt(files, spawnPos()).then(list => {
        if (list.length) toast(`已粘贴 ${list.length} 个素材`, 'ok');
      });
      return;
    }
    // 剪贴板是显式文本数据：同样取消排队的节点粘贴——绝不把画布内旧节点当成“文本粘贴”的结果；
    // 文本落地为新的文本节点，所见即所得
    const text = e.clipboardData?.getData?.('text/plain') ?? '';
    if (text.trim()) {
      e.preventDefault();
      board.cancelPendingPaste?.();
      spawnNodeAt('text', spawnPos(), { title: '粘贴的文本', text: text.slice(0, 200000) });
      toast('已把剪贴板文本粘贴为文本节点', 'ok', 2500);
    }
  });

  // ---------- 检查器 ----------
  let inspTimer = null;
  // 检查器固定头：标题 + ×。renderInspector 每次 replaceChildren 但本元素只创建一次复用——
  // 不重建不重绘，输入焦点不丢；× 走现有 togglePanel('right') 仅折叠宽度，重开保留表单状态。
  const inspHeadTitle = el('b', { text: '检查器' });
  const inspHeadX = el('button', { class: 'insp-x', type: 'button', text: '×', title: '关闭检查器（底部「检查器」按钮可重开）' });
  inspHeadX.addEventListener('click', () => {
    const box = $('#inspector'); if (!box) return;
    if (globalThis.matchMedia?.('(max-width:900px)')?.matches) box.classList.remove('open');
    else shell?.togglePanel?.('right');
  });
  const inspHead = el('div', { class: 'insp-head' }, inspHeadTitle, inspHeadX);
  const cloneImage = el('button', { type: 'button', class: 'inspector-clone', text: '克隆节点', hidden: true, title: '复制节点参数与已有参考连线，不启动生成' });
  inspHeadX.before(cloneImage);
  cloneImage.addEventListener('click', () => {
    const node = currentSel?.type === 'node' ? store.node(currentSel.id) : null;
    if (!node || !['image', 'asset'].includes(node.type)) return;
    const copy = editor.duplicate([node.id])[0];
    if (copy) { board.focusNode(copy.id); toast('已克隆节点，未启动生成', 'ok'); }
  });
  $('#inspector')?.prepend?.(inspHead);
  nodeComposer = createNodeComposer({ board, store, box: $('#inspector'), closeButton: inspHeadX });
  function renderInspectorThrottled() {
    clearTimeout(inspTimer);
    inspTimer = setTimeout(() => {
      if (currentSel?.type !== 'node') return;
      // Only skip rebuild while the user is actively editing a field;
      // focus on a button/checkbox must not freeze inspector state updates.
      const ae = document.activeElement;
      const editing = ae && $('#inspector').contains(ae) &&
        ae.matches('input:not([type="checkbox"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable]');
      // Reference menus live outside the inspector. Keep their owner intact
      // while searching/selecting or awaiting a local media read.
      const pickingReference = $('#inspector').querySelector('.reference-trigger[aria-expanded="true"]');
      if (!editing && !pickingReference) renderInspector(currentSel);
    }, 250);
  }
  function renderInspector(sel) {
    const box = $('#inspector');
    const cloningNode = sel?.type === 'node' ? store.node(sel.id) : null;
    cloneImage.hidden = board.selectedIds.length !== 1 || !(cloningNode?.type === 'image' || (cloningNode?.type === 'asset' && store.project?.assets?.[cloningNode.data.assetId]?.kind === 'image'));
    nodeComposer?.setNode(sel?.type === 'node' && board.selectedIds.length === 1 ? store.node(sel.id) : null);
    // 更新参数内容时保留面板自身的关闭按钮，避免移动端失去退出入口。
    const closeButton = box.querySelector('.drawer-close');
    const replaceContent = (...children) => {
      const heading = children[0]?.tagName === 'H3' ? children.shift() : null;
      // 标题含元素（如「开发中」徽标）时保留结构；纯文字标题行为不变
      if (heading?.children?.length) inspHeadTitle.replaceChildren(...heading.childNodes);
      else inspHeadTitle.textContent = heading?.textContent || '检查器';
      box.replaceChildren(inspHead, ...(closeButton ? [closeButton] : []), ...children);
    };
    if (!sel || sel.type !== 'node') {
      if (sel?.type === 'edge') {
        const del = el('button', { class: 'danger', type: 'button', text: '删除连线' });
        del.addEventListener('click', () => { board.removeEdge(sel.id); renderInspector(null); });
        replaceContent(el('h3', { text: '连线' }), del); return;
      }
      replaceContent(el('div', { class: 'inspector-empty', text: '选中节点查看/编辑参数' })); return;
    }
    const ids = board.selectedIds;
    if (ids.length > 1) { replaceContent(el('h3', { text: `已选 ${ids.length} 个节点` }), multiInspector(ids)); return; }
    const node = store.node(sel.id);
    if (!node) { replaceContent(el('div', { class: 'inspector-empty' })); return; }
    if (node.type === 'gen') replaceContent(el('h3', { text: '视频生成' }), genInspector(node, { store, runner, assets, editor, refresh: refreshDynamic, generators: modules.generators,
      onDuplicate: source => {
        const copies = editor.duplicate([source.id]);
        if (copies[0]) { board.focusNode(copies[0].id); toast('新版本草稿已创建，原任务和成片保留', 'ok'); }
      },
    }));
    else if (node.type === 'asset') replaceContent(el('h3', { text: '素材' }), assetInspector(node));
    else if (node.type === 'director') replaceContent(el('h3', {}, el('span', { text: '导演台' }), ...(feature('hostedDirector') ? [] : [devBadge()])),
      feature('hostedDirector') ? directorInspector(node) : dirCtl?.inspector?.(node) ?? directorInspector(node));
    else if (node.type === 'note') replaceContent(el('h3', { text: '便签' }), noteBody(node));
    else if (node.type === 'text' || node.type === 'image')
      replaceContent(el('h3', { text: node.type === 'text' ? 'AI 改写' : TYPE_LABEL[node.type] ?? node.type }),
        modules.generators?.inspector?.(node) ?? studioFallbackInspector(node));
    else if (node.type === 'utility')
      replaceContent(el('h3', { text: '工具' }),
        modules.tools?.inspector?.(node) ?? toolFallbackInspector(node));
    else replaceContent(el('h3', { text: TYPE_LABEL[node.type] ?? node.type }), commonNodeFields(node));
  }
  // 通用：标题编辑（所有节点兜底共有）
  function commonNodeFields(node) {
    const title = el('input', { type: 'text', value: node.data.title ?? '' });
    title.addEventListener('input', () => { node.data.title = title.value; store.saveSoon(); });
    return el('div', {}, el('div', { class: 'field' }, el('label', { text: '标题' }), title));
  }
  function studioFallbackInspector(node) {
    const box = commonNodeFields(node);
    if (node.type === 'text') box.append(el('div', { class: 'field' }, el('label', { text: '文本' }), (() => {
      const ta = el('textarea', { value: node.data.text ?? '' });
      ta.addEventListener('input', () => { node.data.text = ta.value; store.saveSoon(); });
      return ta;
    })()));
    if (node.type === 'image') box.append(el('div', { class: 'field' }, el('label', { text: '提示词' }), (() => {
      const ta = el('textarea', { value: node.data.prompt ?? '' });
      ta.addEventListener('input', () => { node.data.prompt = ta.value; store.saveSoon(); });
      return ta;
    })()));
    box.append(el('p', { class: 'hint', text: `生成模块未加载${moduleStatus.generators?.error ? `（${moduleStatus.generators.error}）` : ''}：参数已保留，模块就绪后可执行生成。` }));
    return box;
  }
  function toolFallbackInspector(node) {
    const box = commonNodeFields(node);
    const sel = el('select', {}, Object.entries(TOOLS).map(([k, v]) => el('option', { value: k, text: v, selected: k === node.data.tool })));
    sel.addEventListener('change', () => { node.data.tool = sel.value; store.touch({ type: 'data', id: node.id }); });
    box.append(el('div', { class: 'field' }, el('label', { text: '工具类型' }), sel),
      el('p', { class: 'hint', text: `工具模块未加载${moduleStatus.tools?.error ? `（${moduleStatus.tools.error}）` : ''}：可选择类型并保留参数。` }));
    return box;
  }
  // 多选面板：批量操作（成组/排列/锁定/副本/删除）
  function multiInspector(ids) {
    const box = el('div', { class: 'multi-sel' });
    const byType = {};
    for (const id of ids) { const n = store.node(id); if (n) byType[n.type] = (byType[n.type] ?? 0) + 1; }
    for (const [t, c] of Object.entries(byType)) box.append(el('div', { class: 'row' }, el('span', { text: TYPE_LABEL[t] ?? t }), el('b', { text: `${c}` })));
    const lockedCount = ids.filter(id => store.node(id)?.data.locked).length;
    if (lockedCount) box.append(el('div', { class: 'row' }, el('span', { text: '已锁定（受保护）' }), el('b', { text: `${lockedCount}` })));
    const mk = (label, fn, cls = '') => { const b = el('button', { class: cls, type: 'button', text: label }); b.addEventListener('click', fn); return b; };
    box.append(el('div', { class: 'modal-actions' },
      mk('成组', () => { editor.group(ids); }),
      mk('排列', () => editor.arrange(ids, board.measureNode)),
      mk('锁定/解锁', () => editor.lock(ids)),
      mk('创建副本', () => board.selectMany(editor.duplicate(ids).map(n => n.id))),
      mk('删除', () => board.deleteSelection(), 'danger')));
    return box;
  }
  function assetInspector(node) {
    const a = assets.assetOfNode(node);
    const box = el('div', {});
    if (!a || a.missing) {
      box.append(el('p', { class: 'err-text', text: '素材文件缺失（导出不含文件本体）' }));
      const pick = el('button', { class: 'primary', type: 'button', text: '重新绑定本地文件' });
      pick.addEventListener('click', () => {
        const inp = el('input', { type: 'file' });
        inp.addEventListener('change', async () => {
          const f = inp.files[0]; if (!f) return;
          if (a) await assets.rebindFile(a.id, f);
          else {
            const rec = await assets.registerBlob(f, f.name, fileKind(f) ?? 'file');
            node.data.assetId = rec.id; node.data.needsRebind = false; node.data.title = f.name; store.touch({ type: 'data', id: node.id });
          }
          refreshDynamic();
        });
        inp.click();
      });
      box.append(pick);
      return box;
    }
    const up = el('button', { type: 'button', text: '上传到本站' });
    up.disabled = !keyvault.hasKey();
    up.addEventListener('click', async () => { try { await assets.upload(a.id); toast('上传成功', 'ok'); } catch (e) { toast(`上传失败：${e.message}`, 'err'); } });
    box.append(
      el('div', { class: 'kv' }, el('span', { text: '名称' }), el('span', { text: a.name })),
      el('div', { class: 'kv' }, el('span', { text: '类型' }), el('span', { text: KIND_LABEL[a.kind] ?? a.kind })),
      el('div', { class: 'kv' }, el('span', { text: '大小' }), el('span', { text: fmtBytes(a.size) })),
      el('div', { class: 'kv' }, el('span', { text: '远端' }), el('span', { text: assets.remoteValid(a) ? `有效至 ${fmtTime(a.remote.expiresAt * 1000)}` : '未上传/需重传' })),
      el('div', { class: 'modal-actions' }, up));
    return box;
  }
  function directorInspector(node) {
    const open = el('button', { class: 'primary', type: 'button', text: '打开导演台' });
    open.addEventListener('click', () => host.openEditor(node));
    if (feature('hostedDirector')) {
      const info = el('p', { class: 'hint', text: '读取工程保存状态…' });
      host.sceneInfo(node).then(result => { info.textContent = result?.saved ? `已保存场景：${result.summaryText}` : '新导演工程，编辑后自动保存到本项目'; })
        .catch(() => { info.textContent = '保存状态暂不可读取，请在导演台确认'; });
      return el('div', {}, commonNodeFields(node), info,
        el('p', { class: 'hint', text: '在导演台调整人物、动作与机位，并将 PNG、参考视频或镜头包回传画布。模型提案和视频生成由你主动发起。' }), open);
    }
    const scene = el('button', { type: 'button', text: '读取场景（scene.get）' });
    scene.addEventListener('click', async () => {
      try { const r = await host.invokeAgent(node.id, { method: 'scene.get', args: {} }); modal(el('div', {}, el('h3', { text: '场景结构' }), el('pre', { style: 'max-height:50vh;overflow:auto;font-size:11px', text: JSON.stringify(r, null, 2) }))); }
      catch (e) { toast(`读取失败：${e.message}`, 'err'); }
    });
    return el('div', {},
      el('p', { class: 'hint', text: '原版 3D 导演台插件经独立本机源嵌入；场景/机位/运镜在插件内编辑，状态自动存入本项目。' }),
      el('p', { class: 'hint', text: '插件内 AI 生成、Agent 写方法、手机虚拟摄像机等依赖 MiniMax 宿主的功能未接入，不代表本站能力。' }),
      el('div', { class: 'modal-actions' }, scene, open));
  }

  // ---------- 任务面板 ----------
  // 任务面板独立承载：查询状态 / 下载成片 / 访问本机结果 / 找回或重建关联节点（R05/R13）。
  // 恢复走 runner.restoreTask / runner.restorePending（任务域实现，绝不发起新 POST）；
  // 原节点已有任务或同键 pending 时仅定位——绝不用残留记录覆盖在途状态。
  let taskTimer = null;
  // 本地实体核验摘要短期缓存：轮询驱动的高频刷新不反复读 Blob；记录关键字段变化或超时即重新核验（素材被删能在数秒内反映）
  const localMemo = new Map(), LOCAL_MEMO_MS = 5000;
  function refreshTasksSoon() { clearTimeout(taskTimer); taskTimer = setTimeout(refreshTasks, 300); }
  async function refreshTasks() {
    const list = $('#task-list');
    if (!list) return;
    try {
      const pid = store.project?.id;
      const tasks = liveTaskRecords(await store.tasksOfProject(), runner);
      const pending = await store.listPending();
      // 本地实体核验（核心 runner.localResult）：只保留 {ready, reason} 摘要，不持有 Blob
      const locals = new Map(await Promise.all(tasks.map(async t => {
        try {
          const mk = JSON.stringify([t.projectId, t.taskId, t.status ?? '', t.contentReady ?? null, t.resultBlobId ?? '', t.resultAssetId ?? '', t.recVersion ?? null, t.rev ?? null]);
          const hit = localMemo.get(t.taskId);
          if (hit && hit.mk === mk && Date.now() - hit.at < LOCAL_MEMO_MS) return [t.taskId, hit.v];
          const r = typeof runner.localResult === 'function' ? await runner.localResult(t.taskId, t.projectId) : { ready: false, reason: 'unavailable' };
          const v = { ready: r?.ready === true, reason: r?.ready ? null : r?.reason ?? null, source: r?.source ?? null };
          localMemo.set(t.taskId, { mk, at: Date.now(), v });
          return [t.taskId, v];
        } catch (e) { return [t.taskId, { ready: false, reason: `check_failed:${e?.message ?? e}` }]; }
      })));
      if (store.project?.id !== pid) return;                  // await 期间切换项目 → 丢弃过期渲染
      const busyBtn = (btn, fn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await fn(); }
        catch (e) { toast(`任务操作失败：${e.message}`, 'err', 6000); }
        finally { btn.disabled = false; refreshTasksSoon(); }
      });
      // 键控增量重铺（C1b）：未变行复用 DOM 不重建；空态提示作为键控项统一进出
      // keyFp 当前密钥指纹：驱动 need_key 相位（换密钥后同任务相位翻转即重建该行）
      const entries = taskPanelEntries({ tasks, pending, store, runner, board, editor, busyBtn, keyFp: keyvault.getFingerprint(), accountSubject: accountScope?.subject ?? null, serverCancel, localOf: id => locals.get(id) });
      if (!entries.length) entries.push({ key: 'task-panel:empty', sig: '0', build: () => el('p', { class: 'hint', text: '暂无任务' }) });
      reconcileKeyedList(list, entries);
    } catch (e) {
      list.replaceChildren(el('p', { class: 'err-text', text: `任务列表刷新失败：${e.message}` }));
    }
  }

  // ---------- 工作流面板（本域控制条 + 模块 panel()）----------
  // 合同 §6.2/§8：'selection' 空选择返回空集，由启动方显式拒绝——绝不回落全画布
  const workflowTargets = (scope = 'selection') => workflowScopeTargets(scope, {
    selectedIds: board.selectedIds,
    groups: store.project?.studio?.groups ?? [],
    nodes: store.project?.nodes ?? [],
  });
  const emptyScopeRefusal = () => toast('运行范围为空：请先选中节点，或把「运行范围」改为「整个画布」', 'warn', 5000);
  function mountWorkflowPanel() {
    const box = $('#workflow-panel'); if (!box) return;
    const btnImport = el('button', { type: 'button', text: '导入工作流', title: '导入本站导出的 .canvas.json 文件；素材文件需重新绑定' });
    btnImport.addEventListener('click', importCanvasFile);
    const importHint = el('p', { class: 'hint', text: '支持本站 .canvas.json；导入为新项目，保留当前画布。' });
    const stateLine = el('div', { class: 'wf-state', text: '未运行' });
    const failBox = el('div', { class: 'wf-fail-list' });
    const budget = el('input', { type: 'number', min: 0, step: 1, placeholder: '预算上限 ¥', title: '本次运行预算上限（元）：留空不限；0 不允许付费节点' });
    const targetInfo = el('div', { class: 'hint', text: '按连线依赖顺序运行；选中节点时，运行选中节点及其必需输入' });
    const scope = el('select', { 'aria-label': '工作流运行范围' });
    const onlyEmpty = el('input', { type: 'checkbox', 'aria-label': '仅补齐空白节点' });
    onlyEmpty.checked = true;
    const scopeRow = el('label', { class: 'field' }, el('span', { text: '运行范围' }), scope);
    const emptyRow = el('label', { class: 'row' }, onlyEmpty, el('span', { text: '仅补齐空白节点，保留已有结果' }));
    let scopeSignature = '';
    const refreshScope = () => {
      const groups = store.project?.studio?.groups ?? [];
      const signature = JSON.stringify([store.project?.id, groups.map(g => [g.id, g.title])]);
      if (signature !== scopeSignature) {
        scopeSignature = signature;
        const old = scope.value;
        const options = [['selection', '当前选择（空选择不启动）'], ['all', '整个画布'], ...groups.map(g => [`group:${g.id}`, `分组：${g.title || '未命名'}`])];
        scope.replaceChildren(...options.map(([value, text]) => el('option', { value, text })));
        scope.value = options.some(([value]) => value === old) ? old : 'selection';
      }
      try {
        const count = workflowTargets(scope.value).length;
        targetInfo.textContent = scope.value === 'selection' && !count
          ? '当前未选中节点——空选择不启动：请先选中节点，或把「运行范围」改为「整个画布」。'
          : `本次选择 ${count} 个节点；按连线顺序处理，并包含必需输入。`;
      } catch (e) { targetInfo.textContent = e.message; }
    };
    scope.addEventListener('change', refreshScope);
    const btnPreview = el('button', { type: 'button', text: '预检' });
    const btnStart = el('button', { class: 'primary', type: 'button', text: '提交运行' });
    const btnPause = el('button', { type: 'button', text: '暂停' });
    const btnResume = el('button', { type: 'button', text: '继续' });
    const btnDetail = el('button', { type: 'button', text: '明细' });
    // 预算修正入口：仅当工作流模块实现 amend-budget 续跑接口且运行暂停时出现
    const btnAmend = el('button', { class: 'mini', type: 'button', text: '调整预算', style: 'display:none' });
    btnAmend.addEventListener('click', () => {
      const w = wf();
      if (typeof w?.resume !== 'function') return;
      const inp = el('input', { type: 'number', min: 0, step: 0.01, placeholder: '新预算上限 ¥' });
      const ok = el('button', { class: 'primary', type: 'button', text: '应用并继续' });
      const { close } = modal(el('div', {}, el('h3', { text: '调整工作流预算' }),
        el('p', { class: 'hint', text: '预算是标准估算的软上限，不是实际扣费' }), inp,
        el('div', { class: 'modal-actions' }, ok)));
      ok.addEventListener('click', async () => {
        try { if (inp.value === '') throw new Error('请填写新的预算上限'); await w.resume({ budgetYuan: Number(inp.value) }); close(); }
        catch (e) { toast(`预算调整失败：${e.message}`, 'err'); }
        refreshWf();
      });
      inp.focus?.();
    });
    const wf = () => modules.workflow;
    const fmtState = s => {
      if (!s) return '未运行';
      const parts = [({ idle: '未运行', running: '执行中', paused: '已暂停', done: '已完成', failed: '有失败项' })[s.status ?? s.state] ?? '等待处理'];
      if (Number.isFinite(s.done) && Number.isFinite(s.total)) parts.push(`${s.done}/${s.total}`);
      // spentYuan 是标准价估算累计而非实际扣费；未知报价如实显示，绝不 toFixed(null)
      if (Number.isFinite(s.spentYuan)) parts.push(`预计累计 ¥${s.spentYuan}（标准估算）`);
      if (s.status && s.status !== 'idle')
        parts.push(Number.isFinite(s.estimatedYuan) ? `预估 ¥${s.estimatedYuan}（标准估算）` : '预估 未知');
      return parts.join(' · ');
    };
    const refreshWf = () => {
      refreshScope();
      if (!wf()) { stateLine.textContent = `工作流模块未就绪${moduleStatus.workflow?.error ? `：${moduleStatus.workflow.error}` : ''}`; return; }
      try {
        const s = wf().getState?.();
        stateLine.textContent = fmtState(s);
        btnAmend.style.display = (s?.status === 'paused' && typeof wf().resume === 'function') ? '' : 'none';
        const failed = s?.failed ?? s?.failedItems ?? [];
        failBox.replaceChildren(...(Array.isArray(failed) ? failed : []).map(f => {
          const nid = f?.nodeId ?? f?.id ?? f;
          const label = store.node(nid)?.data.title ?? String(nid).slice(0, 18);
          const locate = el('button', { class: 'mini', type: 'button', text: '定位' });
          locate.addEventListener('click', () => board.focusNode(nid));
          return el('div', { class: 'row' }, el('span', { text: `${label}：${f?.error ?? f?.message ?? '失败'}` }), locate);
        }));
      } catch (e) { stateLine.textContent = `状态读取失败：${e.message}`; }
    };
    btnPreview.addEventListener('click', async () => {
      if (!wf()) { toast('工作流模块未就绪', 'warn'); return; }
      try {
        const targets = workflowTargets(scope.value);
        if (!targets.length) { emptyScopeRefusal(); return; }   // 空选择不启动（§6.2）
        const r = await Promise.resolve(wf().preview({ targets, onlyEmpty: onlyEmpty.checked }));
        const issues = [...(r?.fatal ?? []), ...(r?.issues ?? [])];
        modal(el('div', {},
          el('h3', { text: '工作流预检' }),
          el('div', { class: 'wf-issues' },
            el('div', { class: 'kv' }, el('span', { text: '节点数' }), el('span', { text: `${r?.nodeIds?.length ?? 0}` })),
            r?.skipSummary ? el('p', { class: 'hint', text: `新执行 ${r.skipSummary.run} · 复用 ${r.skipSummary.reused} · 暂不可执行 ${r.skipSummary.blocked}` }) : null,
            el('div', { class: 'kv' }, el('span', { text: '预估费用' }), el('span', { text: Number.isFinite(r?.estimatedYuan) ? `¥${r.estimatedYuan}（${r.priceKind ?? '估算价'}·标准估算）` : '未知（以实际为准）' })),
            issues.length ? el('div', {}, el('p', { class: 'err-text', text: '问题：' }), issues.map(i => el('div', { class: 'err-text', text: `· ${typeof i === 'string' ? i : i?.message ?? JSON.stringify(i)}` }))) : el('p', { class: 'hint', text: '未发现问题' }))));
      } catch (e) { toast(`预检失败：${e.message}`, 'err', 6000); }
    });
    async function confirmRegeneration(targets) {
      const probe = await Promise.resolve(wf().preview({ targets, onlyEmpty: true }));
      const full = await Promise.resolve(wf().preview({ targets, onlyEmpty: false }));
      const existing = (probe?.reusedIds ?? []).map(id => store.node(id)).filter(Boolean);   // 只列“已有可复用产出”的节点
      if (!existing.length) return true;
      const title = n => n.data?.title || TYPE_LABEL?.[n.type] || n.type;
      const recharged = existing.filter(n => n.type !== 'gen'), protectedVideos = existing.filter(n => n.type === 'gen');
      const list = (nodes, text) => nodes.length ? el('div', {}, el('p', { text }), el('ul', {}, nodes.slice(0, 30).map(n => el('li', { text: title(n) }))),
        nodes.length > 30 ? el('p', { class: 'hint', text: `…以及另外 ${nodes.length - 30} 个` }) : null) : null;
      return confirmDialog('将重新执行已有结果的节点', el('div', {},
        list(recharged, `以下 ${recharged.length} 个节点已有产出，会重新生成并再次计费：`),
        list(protectedVideos, `以下 ${protectedVideos.length} 个视频节点已有任务，不会重新提交；如需新版本，请在任务中心对原任务使用“创建新版本”：`),
        el('p', { class: 'hint', text: `本地估算：全部重新执行 ¥${full?.estimatedYuan ?? '未知'}；仅补空白 ¥${probe?.estimatedYuan ?? '未知'}（均非实际扣费）。如只想补齐缺失的部分，请取消并勾选“仅补齐空白节点”。` })));
    }
    btnStart.addEventListener('click', async () => {
      if (!wf()) { toast('工作流模块未就绪', 'warn'); return; }
      const budgetYuan = budget.value.trim() === '' ? undefined : Number(budget.value);
      // 确认弹窗由模块 start 自行完成（测试走 {confirmed:true} 旁路）
      try {
        const targets = workflowTargets(scope.value);
        if (!targets.length) { emptyScopeRefusal(); return; }   // 空选择不启动（§6.2）
        // 不勾选“仅补齐空白”= 会重新执行已有产出的节点：先按“仅补空白”分类找出这些节点，逐个列出并单独确认。
        // 图片/文本节点会重新生成并再次计费；视频节点已有任务时受任务身份保护，不会重新提交（新版本请在任务中心显式创建）。
        if (!onlyEmpty.checked && !(await confirmRegeneration(targets))) return;
        await wf().start({ targets, onlyEmpty: onlyEmpty.checked, budgetYuan });
      } catch (e) { toast(`工作流启动失败：${e.message}`, 'err', 6000); }
      refreshWf();
    });
    btnPause.addEventListener('click', async () => { try { await wf()?.pause?.(); } catch (e) { toast(e.message, 'err'); } refreshWf(); });
    btnResume.addEventListener('click', async () => { try { await wf()?.resume?.(); } catch (e) { toast(e.message, 'err'); } refreshWf(); });
    // panel() 两种合同形态都兼容：返回 DOM 节点 → 挂进弹窗；返回 {close} 等自管理弹层 → 不再挂载
    btnDetail.addEventListener('click', () => {
      if (!wf()) { toast('工作流模块未就绪', 'warn'); return; }
      try {
        const p = wf().panel();
        if (p instanceof Node) modal(el('div', {}, el('h3', { text: '工作流明细' }), p));
      } catch (e) { toast(`工作流面板打开失败：${e.message}`, 'err', 6000); }
    });
      box.replaceChildren(
      el('div', { class: 'wf-controls' },
        el('div', { class: 'wf-row' }, btnImport), importHint, scopeRow, targetInfo, emptyRow,
        el('div', { class: 'wf-row' }, btnPreview, btnStart),
        el('div', { class: 'wf-row' }, btnPause, btnResume, btnDetail, btnAmend, budget),
        stateLine, failBox));
    setInterval(refreshWf, 1500);
    refreshWf();
  }

  // ---------- 域模块入口 ----------
  const MODULE_TITLE = { storyboards: '分镜', library: '素材库', timeline: '时间轴', projectHub: '项目版本', assistant: '助手', workspace: '工作区' };
  function openModule(name) {
    if (name === 'director') {
      if (!directorGate(() => openModule('director'))) return false;   // 未确认可用：说明原因，不新建空白导演台节点
      // 模式入口复用当前项目的导演台；重复打开不新增节点或第二个 WebGL 会话。
      let node = board.selectedIds.map(id => store.node(id)).find(n => n?.type === 'director')
        ?? store.project.nodes.find(n => n.type === 'director');
      if (!node) { editor.checkpoint(); node = spawnNodeAt('director'); }
      board.focusNode(node.id);
      try { return !!host.openEditor(node); }
      catch (e) { toast(`导演台打开失败：${e.message}`, 'err', 6000); return false; }
    }
    const m = modules[name];
    if (!m) { toast(`${MODULE_TITLE[name] ?? name} 模块未就绪${moduleStatus[name]?.error ? `：${moduleStatus[name].error}` : ''}`, 'warn', 5000); return false; }
    try { m.open?.(); return true; }
    catch (e) { toast(`${MODULE_TITLE[name] ?? name} 打开失败：${e.message}`, 'err', 6000); return false; }
  }
  $('#btn-storyboard').addEventListener('click', () => openModule('storyboards'));
  $('#btn-director-mode').addEventListener('click', () => openModule('director'));
  $('#btn-library').addEventListener('click', () => openModule('library'));
  $('#btn-timeline').addEventListener('click', () => openModule('timeline'));
  $('#btn-hub').addEventListener('click', () => openModule('projectHub'));
  $('#btn-assistant').addEventListener('click', () => openModule('assistant'));
  if (feature('workspace')) $('#btn-workspace').addEventListener('click', () => openModule('workspace'));
  else { const b = $('#btn-workspace'); if (b) { b.disabled = true; b.title = WORKSPACE_DISABLED; b.setAttribute('aria-disabled', 'true'); } }

  // ---------- 汇总刷新 ----------
  function refreshDynamic() { board.render(); assets.renderLibrary(); refreshTasks(); renderInspectorThrottled(); shell?.refreshChrome(); }
  async function afterProjectSwitch() {
    refreshProjectList(); refreshDynamic(); keyBadge();
    await modules.generators?.restoreOperations?.();
    // 项目打开/切换/导入后恢复在途任务轮询（resumeAll 仅扫当前项目记录，
    // 内部已校验 keyFp 与终态——换密钥任务保持暂停，不产生新 POST）
    await runner.resumeAll();
  }

  // ---------- 域模块加载（合同 v1）----------
  const deps = { store, storage, assets, api, runner, editor, board, directorControls: dirCtl, onUpdate: refreshDynamic, openModule, spawnNodeAt, addFilesAt, ...(accountScope ? { accountScope } : {}) };
  const loaded = await loadDomains(deps);
  modules = loaded.modules; moduleStatus = loaded.status;
  if (sessionState.invalid) { try { await modules.workflow?.stopForIdentityChange?.(); } catch { /* 已停止 */ } renderSessionExpired(); }
  dirCtl?.configure?.({ generators: modules.generators });
  const moduleSummary = Object.entries(moduleStatus).map(([k, v]) => `${k}:${v.ok ? 'ok' : v.disabled ? '停用' : '缺'}`).join(' ');
  console.info('[canvas] 域模块', moduleSummary, dirCtl ? 'directorControls:ok' : 'directorControls:缺');
  if (Object.values(moduleStatus).some(s => !s.ok && !s.disabled)) toast('部分功能模块未就绪（详见控制台与本域提示）', 'warn', 5000);

  // ---------- 外壳（工具栏/搜索/空白态/菜单/状态栏/面板）----------
  shell = createStudioShell({
    store, editor, board, assets, spawnPos, spawnNodeAt, addFilesAt, openModule,
    storyboards: modules.storyboards, directorGate,
  });
  // 导演台入口标记「开发中」（在外壳注入图标之后追加，徽标不进入按钮可达名的主体文字）
  for (const b of feature('hostedDirector') ? [] : document.querySelectorAll('#btn-director-mode, [data-add-node="director"]')) {
    if (!b.querySelector('.dev-badge')) b.append(devBadge());
    b.title = '3D 导演台（开发中）';
  }

  mountWorkflowPanel();
  await afterProjectSwitch();

  // 调试/E2E 句柄（不含密钥）
  window.__xp = {
    store, assets, runner, host, board, editor, api, shell,
    modules, moduleStatus, directorControls: dirCtl,
    workflow: modules.workflow, generators: modules.generators, tools: modules.tools,
    storyboards: modules.storyboards, library: modules.library, timeline: modules.timeline,
    projectHub: modules.projectHub, assistant: modules.assistant, workspace: modules.workspace,
    taskPeek: id => runner.taskPeek(id),
    keyvault: { hasKey: keyvault.hasKey, getFingerprint: keyvault.getFingerprint },
    spawnNodeAt, addFilesAt, focusNode: id => board.focusNode(id),
    openModule, applyTemplate: k => shell.applyTemplate(k),
  };

  const t1 = el('button', { id: 'sidebar-toggle', type: 'button', text: '☰' });
  const t2 = el('button', { id: 'inspector-toggle', type: 'button', text: '⚙' });
  $('#topbar').prepend(t1); $('#topbar').append(t2);
  t1.addEventListener('click', () => { if ($('#sidebar').classList.contains('open')) $('#sidebar').classList.remove('open'); else openDrawer('#sidebar'); });
  t2.addEventListener('click', () => { if ($('#inspector').classList.contains('open')) $('#inspector').classList.remove('open'); else openDrawer('#inspector'); });
  // 窄屏两个抽屉宽度之和超过视口时互斥：打开一个即收起另一个，避免上层抽屉盖住下层的关闭按钮。
  // 按实际宽度判断（offsetWidth 不受滑入动画影响），放得下的宽度下行为不变。
  function openDrawer(id) {
    const me = $(id), other = $(id === '#sidebar' ? '#inspector' : '#sidebar');
    me.classList.add('open');
    if (other.classList.contains('open') && $('#sidebar').offsetWidth + $('#inspector').offsetWidth > innerWidth)
      other.classList.remove('open');
  }
  // 抽屉为全高浮层（盖住顶栏）：自带 × 关闭 + 点画布空白区也可关闭
  for (const id of ['#sidebar', '#inspector']) {
    const x = el('button', { class: 'drawer-close', type: 'button', text: '×', title: '关闭面板' });
    x.addEventListener('click', () => $(id).classList.remove('open'));
    $(id).prepend(x);
  }
  $('#board').addEventListener('pointerdown', e => {
    // 只在点击画布空白处收起抽屉；节点/连线点选由 board 处理（R08：移动端点选须能打开检查器）
    if (e.target !== e.currentTarget && e.target.id !== 'nodes' && e.target.id !== 'edges') return;
    $('#sidebar').classList.remove('open'); $('#inspector').classList.remove('open');
  });
  if (hosted) finishHostedStartup();
}

// node --test 环境无 DOM：守卫让纯导出（reconcileKeyedList/taskPanelEntries/workflowScopeTargets）
// 可被模块测试导入，浏览器入口行为不变（timeline.js `typeof document === 'undefined'` 同款先例）
if (typeof document !== 'undefined') boot().catch(e => {
  if (isHosted()) finishHostedStartup();
  document.body.append(el('div', { style: 'padding:40px;color:#e5604f', text: `画布初始化失败：${e.message}` }));
  console.error(e);
});
