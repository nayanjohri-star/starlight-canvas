// 文本 / 图片生成节点：本站同步接口 + 每节点持久化操作守卫。
// 与视频任务的关键差别：同步调用没有 24h 幂等承诺——
//  · 操作记录先落盘（saved → sent 含 sentAt）再发请求；未持久化绝不发 POST
//  · 结果未明一律置 unresolved 并锁定节点，绝不自动重放；须人工确认后解除
//  · 明确拒绝（4xx）与不确定失败分开：rejected 可改参数后重新生成
//  · 快照固定 项目 / 密钥指纹 / 节点 / 请求摘要：任一不一致即不发送、不回写结果

import { el, toast, confirmDialog } from './ui.js';
import {
  getImageModel, imageModelIds, imageRatios, imageResolutions, imageSizeFor,
  buildChatBody, buildImageBody, buildImageEditBody, decodeBase64, sniffImageMime, bytesToBase64,
  chatModelIdsFromCatalog, wiredOutputs, effectivePrompt, IMAGE_EDIT_MAX_BYTES, IMAGE_EDIT_MAX_REFERENCES,
  imagePriceInfo, localImageDecode, IMAGE_DECODE_MAX_SIDE, IMAGE_DECODE_MAX_PIXELS,
  b64DecodedSize, IMAGE_RESULT_MAX_BYTES,
  syncPromptBindings, resolvePromptRefs,
} from './capabilities.js';
import { promptReferencePicker } from './prompt-references.js';
import { getProvider } from './providers.js';
import { isExternalProvider } from './provider-config.js';
import { openMediaPreview } from './media-preview.js';
import { timingElement, fmtDuration } from './task-timing.js';
import { ApiError, chatResponseText, imageResponseB64 } from './api.js';
import { getFingerprint, hasKey, isModelUsable, getModelCatalog, getAvailableModels, getSitePricing } from './keyvault.js';
import { createSubmitLock } from './submit-lock.js';
import { uid } from './store.js';
import { findRole, resolveRoles, roleFits, renderRolePrompt, parseRewriteOutput, pushVersion, DEFAULT_ROLE_ID, ROLE_SCOPES } from './rewrite-roles.js';
import { roleChips, openRoleManager, downstreamH3Intents } from './rewrite-ui.js';

export const OP_LABEL = {
  saved: '待发送', sent: '已发送待确认', unresolved: '结果未确认', uncertain: '结果未确认',
  completed: '已完成', rejected: '已拒绝', abandoned: '已放弃',
};
// 这些状态代表“可能已计费/结果未知”：一律阻挡新请求（含导入映射来的 uncertain）
const BLOCKING = new Set(['sent', 'unresolved', 'uncertain']);
const KNOWN_REJECT = new Set([400, 401, 403, 404, 409, 413, 415, 422]);

const bodyHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };

// 参考图 → dataURL：类型白名单 + 30MiB + 魔数与声明一致
async function blobToImageDataURL(blob) {
  const mime = (blob?.type || '').toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('参考图仅支持 PNG/JPEG/WebP');
  if (!blob.size || blob.size > IMAGE_EDIT_MAX_BYTES) throw new Error('参考图为空或超过 30MiB');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (sniffImageMime(bytes) !== mime) throw new Error('参考图内容与格式声明不符');
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function createGenerators(deps) {
  const { store, api, assets } = deps;
  const xlock = typeof deps.submitLock === 'function' ? { request: deps.submitLock }
    : deps.submitLock?.request ? deps.submitLock
      // 托管形态：付费提交锁按已核验账户分区，会话失效后拒绝新提交（核心合同）
      : createSubmitLock(deps.accountScope ? { namespace: deps.accountScope.lockNamespace, assertActive: deps.accountScope.assertActive } : {});
  const busy = new Set();   // 节点级内存忙标记：双击/轮询期间不再进入
  const storage = deps.storage ?? null;

  // 运行阶段变化（开始提交 / 请求已发出 / 结束）时通知界面：检查器表单原位刷新状态与按钮
  // （用户正在输入时检查器不整体重建，状态也不能停在旧值），卡片与任务区走 onUpdate。
  // 延后到微任务：sentAt 落盘与 req.send() 之间必须同步且不能被界面异常打断。
  function runChanged(node, { update = true } = {}) {
    queueMicrotask(() => {
      try {
        if (typeof document !== 'undefined')
          for (const f of document.querySelectorAll('[data-gen-node]'))
            if (f.dataset.genNode === node.id) f.dispatchEvent(new Event('gen-run-change'));
        if (update) deps.onUpdate?.();
      } catch { /* 界面刷新失败不影响生成 */ }
    });
  }

  // ---- 持久化操作守卫：op:<projectId>:<nodeId> 独立命名空间 ----
  // 真相不放在可变项目快照里：其他窗口/重开/导入都以 durable 记录为准。
  const opStamp = o => Math.max(o?.completedAt ?? 0, o?.resolvedAt ?? 0, o?.sentAt ?? 0, o?.createdAt ?? 0);
  const opKeyOf = (pid, nodeId) => `op:${pid}:${nodeId}`;
  const writeOpRec = async (node, pid) => {
    const op = node.data.operation;
    if (!storage || !op?.id || !pid) return true;
    try {
      await storage.set(opKeyOf(pid, node.id), { ...JSON.parse(JSON.stringify(op)), projectId: pid, nodeId: node.id });
      return true;
    } catch { return false; }
  };
  // 文档同步：经 store.updateStoredProject 对“最新持久稿”做 CAS 定向合并——
  // 只写本节点的操作/结果字段及其引用的结果素材登记，绝不整份覆盖
  // （其他窗口的新节点/改名/外部新稿必须保留），也绝不用陈旧内存稿 flush 顶替；
  // 素材登记只取自本操作所属项目的内存稿，绝不写进其他项目。
  async function syncOpDoc(node, project) {
    if (!storage || typeof store.updateStoredProject !== 'function') return false;
    let wantsCommit = false;
    const doc = await store.updateStoredProject(project.id, async stored => {
      const sn = stored?.nodes?.find?.(n => n.id === node.id);
      if (!sn) return false;   // 节点不在最新持久稿：op: 独立记录即权威真相，不重建节点
      sn.data ??= {};
      if (node.data.operation) sn.data.operation = JSON.parse(JSON.stringify(node.data.operation));
      else delete sn.data.operation;
      for (const k of ['resultText', 'outputText', 'resultAssetId', 'outputAssetIds'])
        if (node.data[k] !== undefined) sn.data[k] = JSON.parse(JSON.stringify(node.data[k]));
      // 只写 resultAssetId 会留悬空引用：结果素材登记随结果字段一起合并进原项目持久稿
      const ids = new Set(node.data.outputAssetIds ?? []);
      if (node.data.resultAssetId) ids.add(node.data.resultAssetId);
      for (const id of ids) {
        const rec = project.assets?.[id];
        if (rec && typeof rec === 'object') (stored.assets ??= {})[id] = JSON.parse(JSON.stringify(rec));
      }
      wantsCommit = true;
      return true;
    });
    if (doc) return true;
    if (wantsCommit) throw new Error('项目文档合并失败');   // 已要求提交但未写回：视同持久化失败，不谎报成功
    return false;
  }
  // 持久化操作事实：durable op: 记录必须成功；项目文档同步按场景选择——
  //  · 存储文档比本窗口新（stored.rev > project.rev）→ 只合并本节点，绝不冲刷陈旧快照
  //  · 项目/密钥已切走 → 合并写回“原项目”文档；节点不在文档不视为失败（op: 记录即真相），且绝不写当前项目
  async function persistOp(node, project) {
    const pid = project?.id;
    let ok = true;
    if (store.project === project && store.node(node.id) === node) {
      const stored = storage ? await storage.get(`project:${pid}`).catch(() => null) : null;
      if (stored && (stored.rev ?? 0) > (project.rev ?? 0)) {
        try { await syncOpDoc(node, project); } catch { ok = false; }
      } else {
        store.touch({ type: 'data', id: node.id });
        try { await store.flush(); } catch (e) { toast(`操作记录落盘失败：${e.message}`, 'err', 6000); ok = false; }
      }
    } else {
      try { await syncOpDoc(node, project); } catch { /* op: 记录仍是持久真相 */ }
    }
    if (!await writeOpRec(node, pid)) { toast('操作记录落盘失败', 'err', 6000); ok = false; }
    return ok;
  }
  // 锁内重读持久化事实（跨窗口防双扣）：durable op: 记录与存储文档都可能比本窗口内存新；
  // 采用更新的操作与结果，绝不把陈旧快照冲刷回去。adopted=true 表示本窗口此前不知道这笔操作。
  async function adoptDurable(node, project) {
    if (!storage || !project) return { adopted: false };
    const pid = project.id;
    const [rec, doc] = await Promise.all([
      storage.get(opKeyOf(pid, node.id)).catch(() => null),
      storage.get(`project:${pid}`).catch(() => null),
    ]);
    const docData = doc?.nodes?.find?.(n => n.id === node.id)?.data ?? {};
    const mem = node.data.operation ?? null;
    let best = null;
    for (const o of [rec, docData.operation])
      if (o && typeof o === 'object' && o.id && (!best || opStamp(o) > opStamp(best))) best = o;
    const adopted = !!best && (!mem?.id || mem.id !== best.id || opStamp(best) > opStamp(mem));
    if (adopted) node.data.operation = JSON.parse(JSON.stringify(best));
    if (node.data.operation?.state === 'completed') {
      for (const k of ['resultText', 'outputText', 'resultAssetId', 'outputAssetIds'])
        if (node.data[k] === undefined && docData[k] !== undefined) node.data[k] = docData[k];
      // 采用持久稿结果时同步补齐素材登记，否则本窗口只剩 resultAssetId 悬空引用
      if (doc?.assets) {
        const ids = new Set(node.data.outputAssetIds ?? []);
        if (node.data.resultAssetId) ids.add(node.data.resultAssetId);
        for (const id of ids)
          if (doc.assets[id] && !project.assets?.[id])
            (project.assets ??= {})[id] = JSON.parse(JSON.stringify(doc.assets[id]));
      }
    }
    return { adopted };
  }
  // 已终结/被取代的操作压入审计历史（≤10 条）：付费事实不随新操作消失
  const archiveOp = (node, note) => {
    const op = node.data.operation; if (!op) return;
    node.data.operationLog = [...(node.data.operationLog ?? []),
      { ...op, state: op.state === 'saved' ? 'abandoned' : op.state, note }].slice(-10);
    node.data.operation = null;
  };

  // 守卫判定：可续用的 op / null（新建）/ Error（阻挡）
  function guardOrReuse(node, summary, fp) {
    const op = node.data.operation;
    if (!op) return null;
    if (BLOCKING.has(op.state)) {
      return Object.assign(new Error(
        `该节点存在「${OP_LABEL[op.state] ?? '未确认'}」状态的操作记录（型号 ${op.model ?? '未知'}），` +
        '已锁定防止重复扣费；请在检查器中人工确认后解除'), { code: 'operation_blocked' });
    }
    if (op.state === 'saved' && !op.sentAt) {
      // 上次在真正发送前中断：同密钥同请求 → 可安全续发；否则按未发送安全放弃
      if (op.keyFp === fp && op.requestSummary === summary) return op;
      archiveOp(node, '请求未实际发出，被新操作取代');
      return null;
    }
    archiveOp(node, '操作已终结，保留审计记录');
    return null;
  }

  // build()：校验并返回 { model, bodyString, summary, send, apply }；其中 throw 一律发生在发送前
  async function guardedCall(node, kind, build) {
    const project = store.project, fp = getFingerprint();
    const current = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node;
    return xlock.request(`xp-genop:${project.id}:${node.id}`, async () => {
      // 锁内先核对持久化事实：另一窗口可能已对本节点发出/完成操作（防止跨窗口重复扣费）
      const { adopted } = await adoptDurable(node, project);
      const seen = node.data.operation;
      if (adopted && seen?.state === 'completed') {
        // 本窗口没见过这笔已完成结果：直接采用持久化结果，绝不重发收费请求。
        // （同一窗口已完成、用户见过结果后再点生成，会走下方 archive → 新操作，属显式新请求）
        return {
          text: node.data.resultText ?? node.data.outputText ?? '',
          assetId: node.data.resultAssetId ?? null,
          assetIds: node.data.outputAssetIds ?? null,
          adopted: true,
        };
      }
      if (seen && BLOCKING.has(seen.state)) {
        throw Object.assign(new Error(
          `该节点存在「${OP_LABEL[seen.state] ?? '未确认'}」状态的操作记录（型号 ${seen.model ?? '未知'}），` +
          '已锁定防止重复扣费；请在检查器中人工确认后解除'), { code: 'operation_blocked' });
      }
      const req = await build();
      let op = guardOrReuse(node, req.summary, fp);
      if (op instanceof Error) throw op;
      if (!op) {
        op = {
          id: uid('op'), kind, model: req.model, state: 'saved',
          ...(kind === 'image' && api.supportsImageJobs ? { imageJob: true } : {}),
          projectId: project.id, nodeId: node.id, keyFp: fp, requestSummary: req.summary,
          ...(isExternalProvider(getProvider()) ? { provider: api.providerInfo?.() } : {}),
          createdAt: Date.now(), sentAt: null, error: null,
        };
        node.data.operation = op;
      }
      if (!current()) throw new Error('项目、密钥或节点已变更，请求未发送');
      if (!await persistOp(node, project)) throw new Error('本地存储失败，请求未发送');
      // sentAt 必须先于 POST 持久化：若落不下这个标记，崩溃后无法区分“未发/已发”，故不发送
      op.state = 'sent'; op.sentAt = Date.now();
      if (!await persistOp(node, project)) { op.state = 'saved'; op.sentAt = null; throw new Error('本地存储失败，请求未发送'); }
      runChanged(node);   // 提交中 → 生成中：从 sentAt 起计时
      if (!current()) {
        // sentAt 落盘与 req.send() 之间没有 await：此处可证明请求未实际发送——
        // 回退 saved（同密钥同摘要可续发），不留在 sent 阻塞态；
        // 回退写回失败时 durable 仍是 sent——内存必须恢复同一保护，否则 UI 显示可发而持久层仍锁
        const sentAt = op.sentAt;
        op.state = 'saved'; op.sentAt = null;
        op.error = '项目、密钥或节点在发送前已变更，请求未发送';
        if (!await persistOp(node, project)) {
          op.state = 'sent'; op.sentAt = sentAt;
          op.error = '请求未实际发送，但解除保护的写回失败；节点保持锁定防止重复扣费，请检查本地存储后重试';
          throw Object.assign(new Error('请求未发送，但本地解除保护写回失败，节点保持锁定防止重复扣费'), { code: 'unresolved' });
        }
        throw Object.assign(new Error('项目、密钥或节点已变更，请求未发送'), { code: 'unsent' });
      }
      let json;
      try { json = await req.send(op); }
      catch (e) {
        if (e instanceof ApiError && (KNOWN_REJECT.has(e.status) || e.code === 'image_jobs_busy') && e.code !== 'image_job_conflict') {
          op.state = 'rejected'; op.error = `${e.status} ${e.code || ''} ${e.message}`.trim(); op.resolvedAt = Date.now();
          await persistOp(node, project);
          throw Object.assign(new Error(`请求被拒绝（${e.status}${e.code ? ' ' + e.code : ''}）：${e.message}`), { code: 'rejected' });
        }
        op.state = 'unresolved'; op.error = String(e?.message ?? e ?? '网络错误'); op.resolvedAt = Date.now();
        await persistOp(node, project);
        throw Object.assign(new Error(`操作结果未确认（${e?.code || e?.message || '网络错误'}）。请求可能已被受理，节点已锁定防止重复扣费`), { code: 'unresolved' });
      }
      // 响应已返回但身份变更：不回写节点；未确认事实保留在原项目命名空间，不冲刷当前项目
      if (!current()) {
        op.state = 'unresolved'; op.error = '项目、密钥或节点在请求期间已变更，结果未写回'; op.resolvedAt = Date.now();
        await persistOp(node, project);
        throw Object.assign(new Error('项目、密钥或节点在请求期间已变更，结果未写回'), { code: 'unresolved' });
      }
      try {
        const result = await req.apply(json);
        op.state = 'completed'; op.completedAt = Date.now(); op.error = null;
        if (!await persistOp(node, project)) {
          // 完成记录落不下 = 结果未持久化：回退为未确认并保留禁发守卫，绝不谎报完成
          op.state = 'unresolved'; op.error = '结果已生成但完成记录落盘失败'; op.resolvedAt = Date.now();
          await persistOp(node, project);
          throw Object.assign(new Error('结果已生成但完成记录落盘失败。生成可能已扣费，节点保持锁定防止重复请求'), { code: 'unresolved' });
        }
        return result;
      } catch (e) {
        if (e?.code === 'unresolved') throw e;
        op.state = 'unresolved'; op.error = `结果保存失败：${e.message}`;
        await persistOp(node, project);
        throw Object.assign(new Error(`结果保存失败：${e.message}。生成可能已扣费，节点保持锁定`), { code: 'unresolved' });
      }
    });
  }

  // 结果图片解码：deps.decodeImage 注入（单测）> createImageBitmap > <img> > 本地结构解析。
  // 只解码已收到的本地字节，绝不拉取响应里的任何 url；解码失败即抛错，操作保持未确认。
  async function decodeResultImage(blob, bytes, mime) {
    if (typeof deps.decodeImage === 'function') return deps.decodeImage(blob);
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      return dims;
    }
    if (typeof Image === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error('图片解码失败'));
          i.src = url;
        });
        return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
      } finally { URL.revokeObjectURL(url); }
    }
    return localImageDecode(bytes, mime);
  }

  // 请求体由显式字段构造；params 只清理「确知属于其他请求合同」的残留字段。
  // shotId/bindings/quoteEstimateYuan 等画布元数据一律保留，绝不因清理丢失产品状态。
  const FOREIGN_REQUEST_KEYS = new Set(['size', 'resolution', 'aspect_ratio', 'quality', 'n', 'response_format', 'image', 'mask', 'negative_prompt', 'style']);
  function pruneParams(node) {
    const p = node.data.params;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { if (p !== undefined) node.data.params = {}; return; }
    if (node.type === 'text') {
      for (const k of Object.keys(p)) if (FOREIGN_REQUEST_KEYS.has(k)) delete p[k];
      if (Number.isFinite(p.max_tokens)) p.max_tokens = Math.min(128000, Math.max(1, Math.round(p.max_tokens)));
      if (Number.isFinite(p.temperature)) p.temperature = Math.min(2, Math.max(0, p.temperature));
    }
    // image：params 不承载任何请求字段，整段保留（含 shotId 等分镜链路元数据）
  }

  // 节点当前的改写角色。旧节点没有改写设置时视为「不使用角色」，保持原有的系统提示行为。
  function rewriteRoleOf(node) {
    const d = node.data;
    const id = d.rewrite?.roleId ?? (d.rewrite ? DEFAULT_ROLE_ID : 'none');
    const role = id === 'none' ? null : findRole(store.project, id);
    return { id: role ? id : 'none', role, rolePrompt: d.rewrite?.promptOverride ?? role?.prompt ?? '' };
  }

  // H3 视频节点里的一次性改写：不写回任何节点，结果交给调用方让用户确认后再替换。
  const rewriteInflight = new Set();
  async function rewriteText({ model, system, prompt, maxTokens = 1024, key = 'rewrite' }) {
    if (!hasKey()) throw new Error('请先输入本站 API Key');
    if (!isModelUsable(model)) throw new Error('该型号不在当前密钥可用范围');
    if (rewriteInflight.has(key)) throw new Error('正在改写，请稍候');
    const project = store.project, fp = getFingerprint();
    rewriteInflight.add(key);
    try {
      const json = await api.chatCompletion(buildChatBody({ model, system, prompt, maxTokens }));
      if (store.project !== project || getFingerprint() !== fp) throw new Error('项目或密钥已变更，结果已丢弃');
      return parseRewriteOutput(chatResponseText(json));
    } finally { rewriteInflight.delete(key); }
  }

  async function runText(node, { signal } = {}) {
    const d = node.data;
    if (!d.model) {
      // 手动文本：不涉费，直接合成连线文本 + 自身内容
      const eff = effectivePrompt(store, node, d.text ?? '');
      if (eff.problems.length) throw new Error(eff.problems[0]);
      d.resultText = eff.prompt; d.outputText = eff.prompt;
      store.touch({ type: 'data', id: node.id });
      return { text: eff.prompt };
    }
    if (!hasKey()) throw new Error('请先输入本站 API Key');
    if (!isModelUsable(d.model)) throw new Error('该型号不在当前密钥可用范围');
    const proj0 = store.project, fp0 = getFingerprint();
    return guardedCall(node, 'text', () => {
      pruneParams(node);
      const eff = effectivePrompt(store, node, d.text ?? '');
      if (eff.problems.length) throw new Error(eff.problems[0]);
      if (!eff.prompt.trim()) throw new Error('原文不能为空');
      // AI 改写：所选角色的提示词（或本次临时修改的版本）在改写前注入；不使用角色时沿用节点自己的系统提示
      const { role, rolePrompt } = rewriteRoleOf(node);
      const { system, prompt } = role
        ? renderRolePrompt(rolePrompt, { source: eff.prompt, request: d.rewrite?.request })
        : { system: d.system, prompt: d.rewrite?.request?.trim() ? `${eff.prompt}

【改写要求】${d.rewrite.request.trim()}` : eff.prompt };
      const bodyString = buildChatBody({
        model: d.model, system, prompt,
        maxTokens: d.params?.max_tokens ?? 1024, temperature: d.params?.temperature,
      });
      let t0 = 0;
      return {
        model: d.model, bodyString,
        summary: `text:${d.model}:${bodyHash(bodyString)}`,
        send: () => { t0 = performance.now(); return api.chatCompletion(bodyString, { signal }); },
        apply: async json => {
          const parsed = parseRewriteOutput(chatResponseText(json));
          // 回写前复核身份：请求发出后项目/密钥/节点的任何变更都让结果留在未确认态，不写错对象
          if (store.project !== proj0 || getFingerprint() !== fp0 || store.node(node.id) !== node)
            throw Object.assign(new Error('项目、密钥或节点已变更，结果未写回'), { code: 'unsent' });
          d.resultText = parsed.text; d.outputText = parsed.text;
          // 新结果成为当前版本，旧版本保留（最近 5 版），可在「上一版」找回
          d.rewrite = pushVersion(d.rewrite, { text: parsed.text, ...(parsed.en ? { en: parsed.en } : {}), at: Date.now(),
            roleId: role?.id ?? 'none', roleName: role?.name ?? '不使用角色', model: d.model, ms: t0 ? Math.round(performance.now() - t0) : undefined });
          return { text: parsed.text };
        },
      };
    });
  }

  async function applyImageResult(node, json) {
    const d = node.data;
          const proj = store.project, fp0 = getFingerprint();
          const still = () => store.project === proj && getFingerprint() === fp0 && store.node(node.id) === node;
          const staleFail = () => { throw Object.assign(new Error('项目、密钥或节点在结果处理期间已变更，结果未写回'), { code: 'unsent' }); };
          if (!still()) staleFail();
          const b64 = imageResponseB64(json);
          const b64Size = b64DecodedSize(b64);
          if (b64Size < 0) throw new Error('返回图片 base64 长度非法，已拒绝解码');
          if (b64Size > IMAGE_RESULT_MAX_BYTES)
            throw new Error(`返回图片超过 ${IMAGE_RESULT_MAX_BYTES / 1048576}MiB 接收上限，已拒绝解码入库`);
          const bytes = decodeBase64(b64);
          const mime = sniffImageMime(bytes);
          if (!mime || !bytes.length) throw new Error('返回内容不是可识别的 PNG/JPEG/WebP 图片');
          // 结构完整性先行（截断/伪造必拒）；随后必须过真实像素解码，两处尺寸须一致
          const structural = localImageDecode(bytes, mime);
          const blob = new Blob([bytes], { type: mime });
          const dims = await decodeResultImage(blob, bytes, mime);
          if (!still()) staleFail();   // 解码等待期间切项目/换钥/删节点：绝不继续入库
          if (!dims?.width || !dims?.height || dims.width > IMAGE_DECODE_MAX_SIDE || dims.height > IMAGE_DECODE_MAX_SIDE
            || dims.width * dims.height > IMAGE_DECODE_MAX_PIXELS)
            throw new Error(`返回图片解码失败或尺寸越界（${dims?.width ?? '?'}x${dims?.height ?? '?'}），已拒绝入库`);
          if (dims.width !== structural.width || dims.height !== structural.height)
            throw new Error('返回图片像素尺寸与文件结构不一致，已拒绝入库');
          if (!still()) staleFail();   // 注册前最后一次确认：身份已变则不开始入库（registerBlob 绑定其起始项目）
          const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
          let a;
          try {
            a = await assets.registerBlob(blob, `生成图-${String(d.title || node.id).slice(0, 24)}-${Date.now().toString(36)}.${ext}`, 'image', { category: 'gen' });
          } catch (e) { if (!still()) staleFail(); throw e; }
          if (!still()) {
            // 注册完成后身份才变（如换钥）：回收刚入库的素材与 blob，结果不写回节点
            try { delete proj.assets[a.id]; } catch { /* 尽力清理 */ }
            try { await storage?.delBlob?.(`blob:${a.id}`); } catch { /* 尽力清理 */ }
            staleFail();
          }
          d.resultAssetId = a.id; d.outputAssetIds = [a.id];
          return { assetId: a.id, asset: a };
  }

  async function runImage(node, { signal } = {}) {
    const d = node.data;
    if (!hasKey()) throw new Error('请先输入本站 API Key');
    return guardedCall(node, 'image', async () => {
      pruneParams(node);
      const model = d.model;
      if (!getImageModel(model)) throw new Error('未选择图片型号');
      if (!isModelUsable(model)) throw new Error('该型号不在当前密钥可用范围');
      const eff = effectivePrompt(store, node, d.prompt ?? '');
      if (eff.problems.length) throw new Error(eff.problems[0]);
      if (!eff.prompt.trim()) throw new Error('提示词不能为空');
      const size = imageSizeFor(d.resolution ?? '1K', d.ratio ?? '1:1');
      if (!size) throw new Error('该档位不支持所选比例');
      const refs = wiredOutputs(store, node.id, 'refs');
      if (refs.problems.length) throw new Error(refs.problems[0]);
      if (refs.texts.length) throw new Error('参考图端口不接受文本输出');
      if (refs.items.length > IMAGE_EDIT_MAX_REFERENCES) throw new Error(`本站最多支持 ${IMAGE_EDIT_MAX_REFERENCES} 张参考图`);
      if (refs.items.some(ref => ref.kind !== 'image')) throw new Error('参考图必须为图片素材');
      const resolved = resolvePromptRefs(eff.prompt, refs.items, d.bindings);
      if (resolved.missing.length) throw new Error(`提示词引用已失效：${resolved.missing.join('、')}`);
      let bodyString, send;
      if (refs.items.length) {
        const imageDataUrls = [];
        let total = 0;
        for (const ref of refs.items) {
          const blob = await assets.blobOf(ref.id);
          if (!blob) throw new Error(`参考图「${ref.name}」本地文件缺失`);
          total += blob.size;
          if (total > IMAGE_EDIT_MAX_BYTES) throw new Error('参考图合计超过 30MiB 上限');
          imageDataUrls.push(await blobToImageDataURL(blob));
        }
        bodyString = buildImageEditBody({ model, prompt: resolved.normalized, size, imageDataUrls });
        send = op => api.imageEdit(bodyString, { signal, operationId: op.imageJob ? op.id : undefined });
      } else {
        bodyString = buildImageBody({ model, prompt: resolved.normalized, size });
        send = op => api.imageGeneration(bodyString, { signal, operationId: op.imageJob ? op.id : undefined });
      }
      return {
        model, bodyString,
        summary: `image:${model}:${bodyHash(bodyString)}`,
        send,
        // 长度门槛（分配前）→ 魔数核对 → 结构完整性 → 真实像素解码 → 尺寸一致性与上界 → 入库；
        // 绝不拉取响应里的任何 url。每个 await 之后重新核验项目/密钥/节点身份：
        // 解码或注册期间切走 → 不开始注册、不写回节点、不污染新项目。
        apply: json => applyImageResult(node, json),
      };
    });
  }

  // generate：仅在结果已保存到本地后 resolve；其余路径一律 throw（rejected/unresolved 可区分）
  async function generate(node, options = {}) {
    if (!node || store.node(node.id) !== node) throw new Error('节点不存在或已删除');
    if (busy.has(node.id)) throw new Error('该节点正在生成中');
    busy.add(node.id);
    runChanged(node);   // 提交中
    try {
      if (node.type === 'text') return await runText(node, options);
      if (node.type === 'image') return await runImage(node, options);
      throw new Error('该节点类型不支持生成');
    } finally { busy.delete(node.id); deps.onUpdate?.(); runChanged(node, { update: false }); }
  }

  // 界面运行状态：只由本窗口的内存忙标记 + 持久化操作记录推导，不另存。
  //  · 本窗口正在等待：请求发出前为「提交中」，发出后为「生成中」并从 sentAt 计时；
  //  · 已完成：保留从请求发出到结果保存到本地的总用时（人工确认的记录没有真实用时，不显示）；
  //  · 已发出但本窗口不在等待（刷新/其他窗口）：结果未知，沿用「已发送待确认」保护语义。
  function runStatus(node) {
    const op = node?.data?.operation;
    if (busy.has(node?.id)) {
      if (op?.state === 'sent' && Number.isFinite(op.sentAt)) return { phase: 'running', label: '生成中', tone: 'busy', since: op.sentAt };
      return { phase: 'submitting', label: '提交中', tone: 'busy' };
    }
    if (!op) return null;
    const span = end => (!op.note && Number.isFinite(op.sentAt) && Number.isFinite(end) && end >= op.sentAt ? end - op.sentAt : null);
    if (op.state === 'completed') return { phase: 'done', label: '已完成', tone: 'ok', ms: span(op.completedAt) };
    if (op.state === 'rejected') return { phase: 'failed', label: '生成失败', tone: 'err', ms: span(op.resolvedAt), error: op.error };
    if (BLOCKING.has(op.state)) return { phase: 'unresolved', label: OP_LABEL[op.state] ?? '结果未确认', tone: 'warn', error: op.error };
    if (op.state === 'saved' && !op.sentAt) return { phase: 'unsent', label: op.error ? '提交失败（请求未发出）' : '待发送', tone: 'info', error: op.error };
    return null;
  }
  function runStatusView(node, { withError = false } = {}) {
    const s = runStatus(node);
    if (!s) return [];
    const parts = [el('span', { class: `badge ${s.tone}`, text: s.label })];
    if (s.since) {
      const t = timingElement({ running: true, since: s.since }, { prefix: '已用时 ' });
      // 每秒跳动的计时不进入读屏播报（状态行本身是 polite 播报区）
      if (t) { t.title = '从请求发出时开始计算'; t.setAttribute('aria-live', 'off'); parts.push(t); }
    } else if (s.ms != null) {
      parts.push(el('span', { class: 'task-elapsed', text: `用时 ${s.ms < 1000 ? '不足1秒' : fmtDuration(s.ms)}`,
        title: s.phase === 'done' ? '从请求发出到结果保存到本机' : '从请求发出到收到拒绝' }));
    }
    if (withError && s.error && s.phase !== 'done') parts.push(el('span', { class: 'err-text gen-run-error', text: String(s.error) }));
    return parts;
  }

  // Recovery is GET-only: no original prompt/reference files or paid repost needed.
  async function recoverImage(node) {
    const project = store.project, fp = getFingerprint();
    if (!project || busy.has(node.id) || node.type !== 'image') return;
    busy.add(node.id); deps.onUpdate?.();
    try {
      return await xlock.request(`xp-genop:${project.id}:${node.id}`, async () => {
        await adoptDurable(node, project);
        const op = node.data.operation;
        const current = () => store.project === project && getFingerprint() === fp && store.node(node.id) === node;
        if (!current() || !op?.imageJob || op.keyFp !== fp || !BLOCKING.has(op.state)) return;
        try {
          const json = await api.waitImageJob(op.id);
          if (!current()) throw new Error('账户或项目已切换，原任务可稍后恢复');
          await applyImageResult(node, json);
          op.state = 'completed'; op.completedAt = Date.now(); op.error = null;
          if (!await persistOp(node, project)) throw new Error('图片完成记录未保存，请再次查询原任务');
        } catch (e) {
          op.state = e.code === 'image_job_rejected' ? 'rejected' : 'unresolved';
          op.error = e.message; op.resolvedAt = Date.now();
          await persistOp(node, project);
        }
      });
    } finally { busy.delete(node.id); deps.onUpdate?.(); }
  }

  // 人工确认操作结局（仅 UI 显式动作调用）：abandon=按未受理处理并解除保护；
  // acknowledge=确认已受理（留档，无本地产物）。
  // 防覆盖：进入与提交相同的节点级锁，锁内重读 durable 事实并采用更新者——
  // 其他窗口已终结/已推进的操作绝不被本窗口的旧内存态覆盖；
  // 每个 await 之后重新核验项目与节点身份。
  async function resolveOperation(node, action) {
    if (!node || !['abandon', 'acknowledge'].includes(action)) return false;
    const project = store.project;
    if (!project || store.node(node.id) !== node) return false;
    return xlock.request(`xp-genop:${project.id}:${node.id}`, async () => {
      await adoptDurable(node, project);
      if (store.project !== project || store.node(node.id) !== node) return false;
      const op = node.data.operation;
      if (!op?.id) return false;
      if (!BLOCKING.has(op.state)) return true;   // 已被终结（可能由其他窗口）：不覆盖，幂等返回
      // 先提交独立操作记录，再解除内存与项目文档中的保护。不能先改 op 后走
      // persistOp：文档或独立记录任一写入失败，会留下时间更新却未确认的解锁态。
      if (!storage) return false;
      const resolved = { ...op, resolvedAt: Math.max(Date.now(), opStamp(op) + 1) };
      if (action === 'abandon') { resolved.state = 'abandoned'; resolved.note = '人工确认按未受理处理'; }
      else { resolved.state = 'completed'; resolved.note = '人工确认已受理（本地无结果）'; resolved.completedAt ??= resolved.resolvedAt; }
      const captured = { ...node, data: { ...node.data, operation: resolved } };
      if (!await writeOpRec(captured, project.id)) {
        toast('确认未保存，原请求保护仍保留，请检查本地存储后重试', 'err', 6000);
        return false;
      }
      // 独立记录提交即确认成功；项目同步失败可从该记录恢复，不能将成功冒充失败。
      // 等待期间切换项目或删除节点，只同步原项目，不改新项目的同名节点。
      if (store.project === project && store.node(node.id) === node && node.data.operation === op)
        node.data.operation = resolved;
      try { await syncOpDoc(captured, project); }
      catch { toast('确认已保存，项目同步暂未完成，重开项目后可恢复', 'info', 6000); }
      return true;
    });
  }

  // 打开项目后由 main 调用：durable op: 记录回填到节点守卫（比文档快照新）；
  // 文档自带的 operation 守卫（含导入的 uncertain）照常生效，不依赖本函数。
  // 每个 await 之后重新核验捕获的项目仍是当前项目：切走后绝不把旧项目记录
  // 写进新项目的同名节点。返回 {restored} 供调用方/测试观察。
  async function restoreOperations() {
    const project = store.project;
    if (!project || !storage) return { restored: 0 };
    const prefix = `op:${project.id}:`;
    let keys = [];
    try { keys = (await storage.keys()).filter(k => k.startsWith(prefix)); } catch { return { restored: 0 }; }
    if (store.project !== project) return { restored: 0 };
    let restored = 0;
    for (const k of keys) {
      const o = await storage.get(k).catch(() => null);
      if (store.project !== project) return { restored };   // 等待期间已切走：停止恢复
      if (!o?.nodeId) continue;
      const n = project.nodes.find(x => x.id === o.nodeId);   // 查捕获项目自身节点，不用 store.node（可能已切到别的项目）
      if (!n || store.node(n.id) !== n) continue;
      const mem = n.data.operation;
      if (!mem?.id || mem.id !== o.id || opStamp(o) > opStamp(mem)) { n.data.operation = o; restored++; }
    }
    for (const node of project.nodes) {
      const op = node.data?.operation;
      if (node.type === 'image' && op?.imageJob && BLOCKING.has(op.state) && op.keyFp === getFingerprint())
        void recoverImage(node).catch(() => {});
    }
    return { restored };
  }

  const isBusy = id => busy.has(id);
  // unverified = 尚未校验（/v1/models 未拉取过）；unavailable = 已校验且不在当前密钥范围（才可禁用）
  const availOf = id => { const a = getAvailableModels(); return a == null ? 'unverified' : a.has(id) ? 'available' : 'unavailable'; };
  const textModels = () => chatModelIdsFromCatalog(getModelCatalog()).map(id => ({ id, name: id, usable: isModelUsable(id), availability: availOf(id) }));
  const imageModels = () => imageModelIds().map(id => ({ id, name: getImageModel(id).display_name, usable: isModelUsable(id), availability: availOf(id) }));

  const PRICE_KIND_LABEL = { standard: '标准价', standard_estimate: '标准估算（非实际分组价）', manual: '手动估算', unknown: '未知' };
  // 手动估算（元/次）：params.quoteEstimateYuan——明确标注 manual，绝不是实际扣费/硬上限
  const manualEstimate = node => {
    const v = Number(node?.data?.params?.quoteEstimateYuan);
    return Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null;
  };
  // 站点公开价目（keys 为显式字段名）：只取纯数字，未知语义字段不猜
  const sitePrice = (modelId, keys) => {
    if (isExternalProvider(getProvider())) return null;
    const p = getSitePricing()?.[modelId];
    if (!p || typeof p !== 'object') return null;
    for (const k of keys) { const v = p[k]; if (Number.isFinite(v) && v >= 0 && v < 1e6) return v; }
    return null;
  };

  function quote(node) {
    const issues = [];
    if (node?.type === 'image') {
      const d = node.data;
      const res0 = d.resolution ?? '1K';
      if (!getImageModel(d.model)) issues.push('未选择图片型号');
      else if (!isModelUsable(d.model)) issues.push('型号不在当前密钥可用范围');
      if (!imageSizeFor(res0, d.ratio ?? '1:1')) issues.push('该档位不支持所选比例');
      const eff = effectivePrompt(store, node, d.prompt ?? '');
      issues.push(...eff.problems);
      if (!eff.prompt.trim()) issues.push('提示词不能为空');
      const refs = wiredOutputs(store, node.id, 'refs');
      issues.push(...refs.problems);
      if (refs.items.length > IMAGE_EDIT_MAX_REFERENCES) issues.push(`本站最多支持 ${IMAGE_EDIT_MAX_REFERENCES} 张参考图`);
      if (refs.items.some(ref => ref.kind !== 'image')) issues.push('参考图必须为图片素材');
      if (refs.items.reduce((sum, ref) => sum + (ref.size || 0), 0) > IMAGE_EDIT_MAX_BYTES) issues.push('参考图合计超过 30MiB 上限');
      const missing = resolvePromptRefs(eff.prompt, refs.items, d.bindings).missing;
      if (missing.length) issues.push(`提示词引用已失效：${missing.join('、')}`);
      // 报价阶梯：已验证标准价 → 站点公开价目 → 版本化基线估算 → 手动估算 → 未知（绝不当 0/免费）
      const info = imagePriceInfo(d.model, res0);
      let yuan = info.yuan, priceKind = info.kind;
      if (yuan == null) { const sp = sitePrice(d.model, [res0]); if (sp != null) { yuan = sp; priceKind = 'standard'; } }
      if (yuan == null) { const me = manualEstimate(node); if (me != null) { yuan = me; priceKind = 'manual'; } }
      return { nodeIds: [node.id], estimatedYuan: yuan, priceKind, kind: priceKind, priceLabel: PRICE_KIND_LABEL[priceKind], issues };
    }
    if (node?.type === 'text') {
      const d = node.data;
      issues.push(...effectivePrompt(store, node, d.text ?? '').problems);
      if (d.model && !isModelUsable(d.model)) issues.push('型号不在当前密钥可用范围');
      if (!d.model) return { nodeIds: [node.id], estimatedYuan: 0, priceKind: 'standard', kind: 'standard', priceLabel: PRICE_KIND_LABEL.standard, issues };
      const sp = sitePrice(d.model, ['per_request', 'per_op']);
      const me = manualEstimate(node);
      const yuan = sp ?? me;
      const priceKind = sp != null ? 'standard' : me != null ? 'manual' : 'unknown';
      return { nodeIds: [node.id], estimatedYuan: yuan, priceKind, kind: priceKind, priceLabel: PRICE_KIND_LABEL[priceKind], issues };
    }
    return { nodeIds: node ? [node.id] : [], estimatedYuan: null, priceKind: 'unknown', kind: 'unknown', priceLabel: PRICE_KIND_LABEL.unknown, issues: ['不支持的节点类型'] };
  }

  // ---------------- 节点 body ----------------
  function body(node) {
    const d = node.data ?? {};
    const box = el('div', {});
    if (node.type === 'text') {
      box.append(el('div', { class: 'row' }, el('span', { text: '类型' }), el('b', { text: d.model ? `AI 改写 · ${d.model}` : '手动文本' })));
      const t = d.resultText || d.text || '';
      if (t) box.append(el('div', { class: 'preview-text', text: t.slice(0, 120) + (t.length > 120 ? '…' : '') }));
    } else if (node.type === 'image') {
      const m = getImageModel(d.model);
      box.append(
        el('div', { class: 'row' }, el('span', { text: '型号' }), el('b', { text: m?.display_name ?? d.model ?? '—' })),
        el('div', { class: 'row' }, el('span', { text: '尺寸' }), el('b', { text: imageSizeFor(d.resolution ?? '1K', d.ratio ?? '1:1') ?? '—' })),
      );
      const ra = d.resultAssetId ? store.project?.assets?.[d.resultAssetId] : null;
      if (ra && !ra.missing && assets.objectURL) assets.objectURL(ra.id).then(u => { if (u) box.prepend(el('img', { class: 'preview', src: u })); });
      else box.prepend(el('div', { class: 'generation-empty-preview' }, el('span', { class: 'preview-symbol', text: '▧', 'aria-hidden': 'true' }), el('span', { text: '图片预览' })));
    }
    // AI 改写的完成用时按版本显示在检查器里（切换版本时各不相同），卡片只给进行中与异常状态
    const status = node.type === 'text' && runStatus(node)?.phase === 'done' ? [] : runStatusView(node);
    if (status.length) box.append(el('div', { class: 'row gen-run-row' }, el('span', { text: '状态' }), el('b', { class: 'gen-run-status' }, ...status)));
    return box;
  }

  // ---------------- 检查器 ----------------
  function inspector(node) {
    const d = node.data;
    const wrap = el('div', {});
    const rerender = () => wrap.replaceChildren(build());
    const refresh = () => { rerender(); deps.onUpdate?.(); };

    // stateRow=false：调用方已有状态行（图片表单底部），这里只给说明与人工确认操作
    function opPanel({ stateRow = true } = {}) {
      const op = d.operation;
      // 本窗口仍在等待这次请求：不给人工确认入口（结果马上会回来，确认动作也会排在请求之后）
      const show = op && !isBusy(node.id) && (BLOCKING.has(op.state) || op.state === 'rejected' || (op.state === 'saved' && !op.sentAt));
      if (!show) return null;
      const box = el('div', { class: 'op-panel' });
      if (stateRow) {
        box.append(el('div', { class: 'row' }, el('span', { text: '操作状态' }),
          el('b', {}, el('span', { class: `badge ${BLOCKING.has(op.state) ? 'warn' : op.state === 'rejected' ? 'err' : 'info'}`, text: OP_LABEL[op.state] ?? op.state }))));
        if (op.error) box.append(el('div', { class: 'err-text', text: String(op.error) }));
      }
      if (op.state === 'sent' && !stateRow) box.append(el('p', { class: 'hint', text: '请求已发出，但本页没有收到结果（页面曾刷新，或在其他窗口发起）。为避免重复扣费，节点保持锁定。' }));
      if (op.imported || op.state === 'uncertain') box.append(el('p', { class: 'hint', text: '该记录来自导入或异常中断，发送结果不可知' }));
      const acts = el('div', { class: 'modal-actions' });
      if (op.state === 'saved' && !op.sentAt) {
        const resume = el('button', { class: 'primary', type: 'button', text: '继续发送（上次未实际发出）' });
        resume.addEventListener('click', () => generate(node).then(refresh).catch(e => { toast(e.message, 'err', 6000); refresh(); }));
        acts.append(resume);
      }
      if (BLOCKING.has(op.state)) {
        if (op.imageJob && op.keyFp === getFingerprint()) {
          const recover = el('button', { type: 'button', text: '查询原任务并取回图片（不重新生成）' });
          recover.addEventListener('click', () => recoverImage(node).then(refresh).catch(e => { toast(e.message, 'err'); refresh(); }));
          acts.append(recover);
        }
        const ab = el('button', { type: 'button', text: '人工确认：按未受理处理' });
        ab.addEventListener('click', async () => {
          const ok = await confirmDialog('解除本次操作保护？', el('p', { text: '仅在你已确认该请求未被受理/未扣费时继续。解除后可重新生成；若实际已受理，重复提交会产生二次扣费。' }));
          if (ok) { await resolveOperation(node, 'abandon'); refresh(); }
        });
        const ack = el('button', { type: 'button', text: '人工确认：已受理/已扣费' });
        ack.addEventListener('click', async () => {
          const ok = await confirmDialog('标记为已受理？', el('p', { text: '表示你已确认服务端受理了该请求。记录将标记完成；本地没有可回写的结果，不会自动补写素材。' }));
          if (ok) { await resolveOperation(node, 'acknowledge'); refresh(); }
        });
        acts.append(ab, ack);
      }
      if (acts.children.length) box.append(acts);
      return box;
    }

    // AI 改写：改写结果在最上方（下游使用这里的内容），其次原文、改写要求、角色与参数，生成按钮固定在底部。
    function buildText() {
      const box = el('div', { class: 'generation-form rewrite-form' });
      if (typeof d.model !== 'string') d.model = '';
      if (!d.params || typeof d.params !== 'object' || Array.isArray(d.params)) d.params = {};
      const eff = effectivePrompt(store, node, d.text ?? '');
      const expand = () => {
        const b = el('button', { type: 'button', class: 'composer-expand', title: '放大编辑区' },
          el('span', { class: 'when-collapsed', text: '⤢ 展开编辑' }), el('span', { class: 'when-expanded', text: '⤡ 收起' }));
        b.addEventListener('click', () => b.dispatchEvent(new CustomEvent('composer-expand', { bubbles: true })));
        return b;
      };
      const head = (title, ...rest) => el('div', { class: 'composer-section-head' }, el('span', { class: 'composer-section-title', text: title }), ...rest);

      // ---- 改写结果（有型号时是主要内容）----
      if (d.model) {
        const rw = d.rewrite ?? {};
        const history = rw.history ?? [];
        const idx = Number.isInteger(rw.index) ? rw.index : history.length - 1;
        const cur = history[idx];
        const result = el('textarea', { class: 'rewrite-result', value: d.resultText ?? '', 'aria-label': '改写结果',
          placeholder: '点击底部「改写」后，结果显示在这里；可以直接修改，下游节点使用这里的内容' });
        result.addEventListener('input', () => {
          d.resultText = result.value; d.outputText = result.value;
          if (cur) cur.text = result.value;   // 手改保存在当前版本里，切换版本不丢
          store.saveSoon();
        });
        const meta = cur ? [`第 ${idx + 1} / ${history.length} 版`, cur.roleName, cur.ms ? `用时 ${Math.max(1, Math.round(cur.ms / 1000))}秒` : ''].filter(Boolean).join(' · ') : '';
        const nav = (label, to) => {
          const b = el('button', { type: 'button', class: 'link-btn', text: label, disabled: to < 0 || to >= history.length });
          b.addEventListener('click', () => {
            d.rewrite = { ...rw, index: to };
            d.resultText = history[to].text; d.outputText = history[to].text;
            store.saveSoon(); store.touch({ type: 'data', id: node.id }); rerender();
          });
          return b;
        };
        const copy = el('button', { type: 'button', class: 'link-btn', text: '复制', disabled: !d.resultText });
        copy.addEventListener('click', () => navigator.clipboard?.writeText(d.resultText ?? '').then(() => toast('已复制', 'ok', 1500), () => toast('复制失败', 'err')));
        const section = el('section', { class: 'ins-group rewrite-result-group' },
          head('改写结果', el('span', { class: 'hint', text: meta || '可直接修改 · 下游使用这里的内容' }),
            el('span', { class: 'rewrite-nav' }, nav('‹ 上一版', idx - 1), nav('下一版 ›', idx + 1), copy), expand()),
          el('div', { class: 'field' }, result));
        if (cur?.en) section.append(el('details', { class: 'rewrite-en' }, el('summary', { text: '英文版' }), el('pre', { text: cur.en })));
        box.append(section);
      }

      // ---- 原文 ----
      const ta = el('textarea', { class: 'rewrite-source-input', value: d.text ?? '', rows: d.model ? 3 : 6, 'aria-label': '原文',
        placeholder: d.model ? '要改写的原文。连线进来的上游文本会排在它前面' : '文本内容。连线文本会按顺序合并在本内容之前' });
      ta.addEventListener('input', () => { d.text = ta.value; store.saveSoon(); });
      const src = el('section', { class: 'ins-group' },
        head(d.model ? '原文' : '文本内容', el('span', { class: 'hint', text: eff.wired ? `已连线 ${store.edgesInto(node.id, 'prompt').length} 段上游文本，排在本框之前` : '暂无上游连线' }), d.model ? null : expand()),
        el('div', { class: 'field' }, ta));
      for (const p of eff.problems) src.append(el('div', { class: 'err-text', text: p }));
      box.append(src);

      // ---- 改写要求 + 角色 ----
      if (d.model) {
        // 已有结果或系统提示的旧节点默认「不使用角色」，保持原行为；新节点默认专业编剧
        d.rewrite ??= { roleId: d.system?.trim() || d.resultText ? 'none' : DEFAULT_ROLE_ID };
        const rw = d.rewrite;
        const req = el('textarea', { rows: 2, value: rw.request ?? '', 'aria-label': '改写要求', placeholder: '可选，例如：写成 3 场戏，每场不超过 200 字' });
        req.addEventListener('input', () => { rw.request = req.value; store.saveSoon(); });
        box.append(el('section', { class: 'ins-group' }, head('改写要求', el('span', { class: 'hint', text: '可选，只影响这一次改写的方向' })), el('div', { class: 'field' }, req)));

        const h3Intents = downstreamH3Intents(store, node.id);
        const roles = resolveRoles(store.project);
        const { id: roleId, role } = rewriteRoleOf(node);
        const pick = id => { rw.roleId = id; delete rw.promptOverride; store.saveSoon(); store.touch({ type: 'data', id: node.id }); rerender(); };
        const chips = roleChips({ roles, selectedId: roleId, h3Intents, onPick: pick,
          onManage: () => openRoleManager({ store, editor: deps.editor, onChange: rerender }) });
        const none = el('button', { type: 'button', class: 'rewrite-role', role: 'radio', 'aria-checked': String(roleId === 'none'), text: '不使用角色', title: '只用下方自定义的系统提示' });
        none.addEventListener('click', () => pick('none'));
        chips.insertBefore(none, chips.querySelector('.rewrite-manage'));
        const roleBox = el('section', { class: 'ins-group rewrite-role-group' }, head('角色', el('span', { class: 'hint', text: '改写前注入的提示词' })), chips);
        const hiddenH3 = roles.filter(r => r.scope && !roleFits(r, h3Intents));
        if (hiddenH3.length) roleBox.append(el('p', { class: 'hint', text: `「${hiddenH3.map(r => r.name).join('」「')}」专为 MiniMax H3 编写：把本节点连到对应模式的 H3 视频节点后显示。` }));
        if (role && !roleFits(role, h3Intents)) {
          const back = el('button', { type: 'button', class: 'mini', text: '改用专业编剧' });
          back.addEventListener('click', () => pick(DEFAULT_ROLE_ID));
          roleBox.append(el('p', { class: 'warn-line' }, el('span', { text: `下游没有${ROLE_SCOPES[role.scope]?.label.replace('仅 ', '') ?? '适用'}的视频节点，这个角色的改写结果可能不适用。` }), back));
        }
        // 本次注入的提示词：可临时修改，不影响角色本身
        const injected = el('textarea', { rows: 6, class: 'rewrite-injected-input', 'aria-label': '本次注入的提示词',
          value: role ? (rw.promptOverride ?? role.prompt ?? '') : (d.system ?? ''), placeholder: '系统提示（可选）' });
        injected.addEventListener('input', () => {
          if (role) { if (injected.value === role.prompt) delete rw.promptOverride; else rw.promptOverride = injected.value; }
          else d.system = injected.value;
          store.saveSoon();
        });
        const det = el('details', { class: 'rewrite-injected', open: roleId === 'none' || rw.promptOverride != null },
          el('summary', { text: role ? (rw.promptOverride != null ? '本次注入的提示词（已临时修改）' : '查看本次注入的提示词') : '系统提示' }), injected);
        if (role && rw.promptOverride != null) {
          const reset = el('button', { type: 'button', class: 'mini', text: '恢复角色原文' });
          reset.addEventListener('click', () => { delete rw.promptOverride; store.saveSoon(); rerender(); });
          det.append(reset);
        }
        if (role) det.append(el('p', { class: 'hint', text: '临时修改只对本节点生效；要长期修改请在「管理角色」中编辑。' }));
        roleBox.append(det);
        box.append(roleBox);
      }

      // ---- 参数 ----
      const models = textModels();
      const sel = el('select', { 'aria-label': '文本型号' }, el('option', { value: '', text: '不调用模型（只合并文本）', selected: !d.model }));
      for (const m of models)
        sel.append(el('option', { value: m.id, text: `${m.id}${m.availability === 'unavailable' ? '（当前密钥不可用）' : m.availability === 'unverified' ? '（可用性未验证）' : ''}`, selected: d.model === m.id, disabled: m.availability === 'unavailable' }));
      sel.addEventListener('change', () => { d.model = sel.value; store.touch({ type: 'data', id: node.id }); rerender(); });
      const params = el('section', { class: 'ins-group composer-parameters rewrite-params' }, el('div', { class: 'field' }, el('label', { text: '文本型号' }), sel));
      if (d.model) {
        const mt = el('input', { type: 'number', min: 1, max: 128000, step: 1, value: d.params.max_tokens ?? 1024, 'aria-label': '最大输出 tokens' });
        mt.addEventListener('input', () => { d.params.max_tokens = Math.min(128000, Math.max(1, Math.round(Number(mt.value) || 1))); store.saveSoon(); });
        const est = el('input', { type: 'number', min: 0, max: 999999, step: 0.01, value: d.params.quoteEstimateYuan ?? '', 'aria-label': '手动估算（元/次）', placeholder: '可选' });
        est.addEventListener('input', () => {
          const v = Number(est.value);
          if (est.value === '' || !Number.isFinite(v) || v < 0) delete d.params.quoteEstimateYuan;
          else d.params.quoteEstimateYuan = v;
          store.saveSoon();
        });
        params.append(el('div', { class: 'field' }, el('label', { text: '最大输出 tokens' }), mt),
          el('div', { class: 'field' }, el('label', { text: '手动估算（元/次）' }), est));
      }
      if (!models.length) params.append(el('p', { class: 'hint', text: '尚无可用文本型号——在顶栏输入 API Key 后自动拉取' }));
      box.append(params);

      const panel = opPanel(); if (panel) box.append(panel);
      const hasResult = !!d.resultText;
      const btn = el('button', { class: 'primary', type: 'button', text: d.model ? (hasResult ? '重新改写' : '改写') : '合成文本（合并连线）',
        title: d.model && hasResult ? '当前结果会成为上一版，可随时找回' : '' });
      btn.disabled = isBusy(node.id) || BLOCKING.has(d.operation?.state) || (!!d.model && !hasKey());
      if (isBusy(node.id)) { btn.classList.add('busy'); btn.textContent = '改写中'; }
      btn.addEventListener('click', () => generate(node).then(refresh).catch(e => { toast(e.message, 'err', 6000); refresh(); }));
      const cta = el('section', { class: 'ins-group gen-cta' },
        el('div', { class: 'field' }, d.model ? el('span', { class: 'warn-line' }, el('span', { text: '标准价未知，费用以实际扣费为准' })) : el('span', { class: 'hint', text: '不调用模型，不产生费用' })),
        btn);
      if (d.model && !hasKey()) cta.append(el('p', { class: 'hint', text: '先在顶栏输入 API Key' }));
      box.append(cta);
      return box;
    }

    function buildImage() {
      const box = el('div', { class: 'image-generation-form' });
      if (!d.model) d.model = imageModelIds()[0] ?? '';
      if (!d.resolution) d.resolution = imageResolutions()[0];
      if (!d.ratio) d.ratio = imageRatios(d.resolution)[0] ?? '1:1';
      pruneParams(node);
      if (!d.params || typeof d.params !== 'object' || Array.isArray(d.params)) d.params = {};

      const sel = el('select', {}, imageModels().map(m =>
        el('option', { value: m.id, text: `${m.name}（${m.id}）${m.availability === 'unavailable' ? ' · 当前密钥不可用' : m.availability === 'unverified' ? ' · 可用性未验证' : ''}`, selected: m.id === d.model, disabled: m.availability === 'unavailable' })));
      if (d.model && !getImageModel(d.model)) sel.prepend(el('option', { value: d.model, text: `${d.model} · 当前接口不支持，请选择型号`, selected: true, disabled: true }));
      sel.addEventListener('change', () => {
        d.model = sel.value;
        if (!imageResolutions().includes(d.resolution)) d.resolution = imageResolutions()[0];
        if (!imageSizeFor(d.resolution, d.ratio)) d.ratio = imageRatios(d.resolution)[0];
        store.touch({ type: 'data', id: node.id }); rerender();
      });
      const res = el('select', {}, imageResolutions().map(r => el('option', { value: r, text: r, selected: r === d.resolution })));
      if (!imageResolutions().includes(d.resolution)) res.prepend(el('option', { value: d.resolution, text: `${d.resolution} · 当前接口不支持`, selected: true, disabled: true }));
      res.addEventListener('change', () => {
        d.resolution = res.value;
        if (!imageSizeFor(d.resolution, d.ratio)) d.ratio = imageRatios(d.resolution)[0];   // 档位切换时重置失效比例（陈旧的 UI-only 参数不留）
        store.touch({ type: 'data', id: node.id }); rerender();
      });
      const ratio = el('select', {}, imageRatios(d.resolution).map(r =>
        el('option', { value: r, text: `${r}（${imageSizeFor(d.resolution, r)}）`, selected: r === d.ratio })));
      if (!imageRatios(d.resolution).includes(d.ratio)) ratio.prepend(el('option', { value: d.ratio, text: `${d.ratio} · 当前接口不支持`, selected: true, disabled: true }));
      ratio.addEventListener('change', () => { d.ratio = ratio.value; store.touch({ type: 'data', id: node.id }); rerender(); });
      box.append(
        el('div', { class: 'field' }, el('label', { text: '图片型号' }), sel),
        el('div', { class: 'field' }, el('label', { text: '档位' }), res),
        el('div', { class: 'field' }, el('label', { text: '比例' }), ratio),
      );
      const ta = el('textarea', { value: d.prompt ?? '', rows: 4, 'aria-label': '图片提示词', placeholder: '描述画面，输入 @ 选择参考图片…' });
      const expandImage = el('button', { type: 'button', class: 'composer-expand', title: '在大窗口中编辑提示词和参考图片', 'aria-pressed': 'false' },
        el('span', { class: 'when-collapsed', text: '放大编辑' }), el('span', { class: 'when-expanded', text: '收起编辑' }));
      expandImage.addEventListener('click', () => expandImage.dispatchEvent(new CustomEvent('composer-expand', { bubbles: true })));
      ta.addEventListener('input', () => { d.prompt = ta.value; d.bindings = syncPromptBindings(d.prompt, wiredOutputs(store, node.id, 'refs').items, d.bindings); store.saveSoon(); updateValidation(); });
      box.append(el('section', { class: 'composer-prompt' }, promptReferencePicker({ textarea: ta, store, node, assets, editor: deps.editor, kinds: ['image'], onInsert: (prompt, caret) => {
        const panel = wrap.closest('#inspector'), scroll = panel?.scrollTop ?? 0, textScroll = ta.scrollTop;
        d.prompt = prompt; store.saveSoon(); rerender();
        const input = wrap.querySelector('textarea'); input?.focus({ preventScroll: true }); input?.setSelectionRange(caret, caret);
        if (input) input.scrollTop = textScroll;
        if (panel) panel.scrollTop = scroll;
        store.touch({ type: 'data', id: node.id });
      } }), el('div', { class: 'composer-section-head' }, el('label', { text: '提示词' }), expandImage), el('div', { class: 'field' }, ta)));
      const refs = wiredOutputs(store, node.id, 'refs');
      d.bindings = syncPromptBindings(d.prompt, refs.items, d.bindings);
      box.append(el('p', { class: 'hint', text: refs.items.length ? `参考图 ${refs.items.length}/${IMAGE_EDIT_MAX_REFERENCES} · 合计上限 30MiB` : '无参考图（文生图）' }));
      for (const [index, ref] of refs.items.entries())
        box.append(el('p', { class: 'hint', text: `上传图片${index + 1}：${ref.name}` }));
      for (const p of refs.problems) box.append(el('div', { class: 'err-text', text: p }));
      const q = quote(node);
      if (isExternalProvider(getProvider())) box.append(el('p', { class: 'hint', text: `由 ${getProvider().name} 按其价格扣费；本站价格不适用` }));
      const priceField = el('div', { class: 'field' },
        el('span', { class: 'cost', text: q.estimatedYuan != null ? `预估 ¥${q.estimatedYuan.toFixed(2)}/张` : '预估价未知' }),
        el('span', { class: 'hint', text: ` ${q.priceLabel ?? '未知'}（估算，非实际扣费）` }));
      const est = el('input', { type: 'number', min: 0, max: 999999, step: 0.01, value: d.params.quoteEstimateYuan ?? '' });
      est.addEventListener('input', () => {
        const v = Number(est.value);
        if (est.value === '' || !Number.isFinite(v) || v < 0) delete d.params.quoteEstimateYuan;
        else d.params.quoteEstimateYuan = v;
        store.saveSoon();
      });
      box.append(el('div', { class: 'field' }, el('label', { text: '手动估算（元/张，可选）' }), est));
      // 结果预览：固定高度的取景框内等比完整显示（不按原图像素撑开面板），点击打开可缩放的大图
      const ra = d.resultAssetId ? store.project?.assets?.[d.resultAssetId] : null;
      if (ra && !ra.missing && assets.objectURL) {
        const img = el('img', { alt: `生成结果：${ra.name ?? ''}`, draggable: false });
        const view = el('button', { type: 'button', class: 'image-result-preview', title: '点击查看大图', 'aria-label': '查看生成图片大图' }, img);
        view.addEventListener('click', () => openMediaPreview({ store, assets, assetId: ra.id }));
        assets.objectURL(ra.id).then(u => { if (u) img.src = u; else view.remove(); }, () => view.remove());
        box.prepend(view);
      }
      const panel = opPanel({ stateRow: false }); if (panel) box.append(panel);
      const idleLabel = refs.items.length ? '按参考图编辑' : '生成图片';
      const btn = el('button', { class: 'primary', type: 'button', text: idleLabel });
      const errors = el('div', { class: 'image-prompt-errors', role: 'status' });
      const statusLine = el('div', { class: 'gen-run-line', role: 'status', 'aria-live': 'polite' });
      function paintStatus() {
        const s = runStatus(node);
        statusLine.replaceChildren(...runStatusView(node, { withError: true }));
        statusLine.hidden = !statusLine.childNodes.length;
        const running = s?.phase === 'submitting' || s?.phase === 'running';
        btn.classList.toggle('busy', running);
        btn.textContent = running ? s.label : idleLabel;   // 进行中按钮显示阶段（不可点）
      }
      function updateValidation() {
        const issues = quote(node).issues;
        btn.disabled = isBusy(node.id) || BLOCKING.has(d.operation?.state) || !hasKey() || issues.length > 0;
        errors.replaceChildren(...issues.map(text => el('p', { class: 'err-text', text })));
      }
      box.dataset.genNode = node.id;
      box.addEventListener('canvas-graph-change', updateValidation);
      box.addEventListener('gen-run-change', () => { paintStatus(); updateValidation(); });
      paintStatus(); updateValidation(); box.append(errors);
      btn.addEventListener('click', () => generate(node).then(refresh).catch(e => { toast(e.message, 'err', 6000); refresh(); }));
      box.append(el('section', { class: 'gen-cta' }, statusLine, priceField, btn));
      if (!hasKey()) box.append(el('p', { class: 'hint', text: '先在顶栏输入 API Key' }));
      return box;
    }

    function build() {
      if (node.type === 'image') return buildImage();
      if (node.type === 'text') return buildText();
      return el('div', { class: 'err-text', text: '不支持的节点类型' });
    }
    rerender();
    return wrap;
  }

  return { generate, recoverImage, body, inspector, quote, textModels, imageModels, resolveOperation, restoreOperations, isBusy, rewriteText, rewriteRoleOf };
}
