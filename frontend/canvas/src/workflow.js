// 工作流执行器：DAG 编排 + CSV 批量 + 预算护栏。
// 关键约束：
//  · 预检 preview 给出显式报价（标准价估算，非实际账单、非服务端硬限额）；start 必须 UI 确认或 confirmed:true
//  · 未知报价 ≠ 免费：估不出价的付费节点一律 blocked，绝不按 0 元放行
//  · 金额用微元（1e-6）整数比较/累计——厘级费用不被舍入成 0；界面另行格式化
//  · 运行态整体持久化在 project.studio.workflow；任何付费操作前先落盘，再发请求
//  · CSV 每行克隆一份独立子图节点（data.batch={run,row,src}），行/节点身份互不串用
//  · 视频生成一律走 runner.submit/adoptDurable——绝不绕过任务域直发请求
//  · 未确认提交（pendingKey）不自动重放；失败行只能显式 retryRow 重跑
//  · 暂停/项目或密钥变更即停止调度；已受理任务记录保留，可在节点上继续
//  · 下游只消费已下载并校验过的本地素材（outputOf 缺失引用以占位条目保留）
//  · 文本汇聚与素材解析由 runner.wired/effectivePrompt 与生成器侧直读真实 edges/outputOf——
//    工作流只把原始节点交给执行器，绝不在异步付费调用前后改写权威 edges 或草稿字段

import { el, toast, modal, confirmDialog } from './ui.js';
import { orderedGraph, outputOf, template, clone, studioState, parseCSV, RUNTIME_KEYS } from './studio-schema.js';
import { estimateCost, capabilities as capabilityTable } from './capabilities.js';
import { getFingerprint } from './keyvault.js';
import { createSubmitLock } from './submit-lock.js';
import { uid } from './store.js';
import { canFetchContent, isFinalFailure, needsTracking } from './task-status.js';

// 金额内部精度：微元（1e-6）整数比较/累计；不再用 round2（会把 0.001 元抹成 0 穿透预算）
const micro = n => Math.round(n * 1e6);
const round6 = n => Math.round(n * 1e6) / 1e6;
const title = n => n?.data?.title || n?.data?.draft?.model || n?.type || '?';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const localDrivers = new Map(); // 同一 JS realm 的测试/非浏览器驱动存活证明
const DRIVER_LEASE_MS = 30_000;

function normalizeRows(rows) {
  if (rows == null) return null;                    // 无批量：单行就地运行原节点
  const list = typeof rows === 'string' ? parseCSV(rows) : rows;
  if (!Array.isArray(list)) throw new Error('rows 必须是对象数组或 CSV 文本');
  if (list.length > 100) throw new Error('单批最多 100 行');
  return list.map(r => (r && typeof r === 'object' && !Array.isArray(r) ? r : {}));
}

// 深度对 data 内所有含 {{field}} 的字符串做模板校验/替换；运行时事实与批量标记不参与模板
const SKIP_TEMPLATE_KEYS = new Set([...RUNTIME_KEYS, 'batch']);
function walkStrings(data, fn, skipRuntime = true) {
  if (!data || typeof data !== 'object') return;
  for (const [k, v] of Object.entries(data)) {
    if (skipRuntime && SKIP_TEMPLATE_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.includes('{{')) data[k] = fn(v);
    else if (v && typeof v === 'object') walkStrings(v, fn, skipRuntime);
  }
}
const checkTemplates = (data, fields) => walkStrings(data, s => { template(s, fields); return s; });
const applyTemplates = (data, fields) => walkStrings(data, s => template(s, fields));

export function createWorkflow(deps) {
  const { store, storage } = deps;
  const runner = () => deps.runner;
  const pollMs = deps.pollMs ?? 5000;
  const xlock = deps.submitLock ? { request: deps.submitLock } : createSubmitLock({ force: deps.lockForce,
    namespace: deps.accountScope?.lockNamespace, assertActive: deps.accountScope?.assertActive });
  const sessionFp = getFingerprint();
  let disposed = false;
  const sessionAlive = () => !disposed && (!deps.accountScope ||
    (deps.accountScope.active && getFingerprint() === sessionFp));
  const assertSession = () => {
    if (!sessionAlive()) throw Object.assign(new Error('账户已切换，工作流会话已停止'), { code: 'identity_changed' });
  };
  const workflowIdentity = () => deps.accountScope?.subject ?? getFingerprint();
  let current = null;   // {run, project} —— 供 pause/resume 在项目被切走后仍能找到运行对象
  let driving = false;
  // 本实例驱动代际：同一 run 只能被一个标签页驱动（resume/retryRow 在 xp-workflow 锁内过户；
  // drive 每拍校验存储稿 driverId——被接管即只读退出，避免双驱动并发提交/交错落盘）
  const driverId = uid('drv');
  const driverLockName = run => `${deps.accountScope?.lockNamespace ?? ''}xp-workflow-driver:${run.id}`;
  // 浏览器驱动全程持有 Web Lock：页面关闭即释放；锁查询可区分活跃标签和刷新遗留的 running 稿。
  // 非浏览器测试使用同 realm 的驱动登记，历史稿再以 driverAt 租约保守兜底。
  async function foreignDriverActive(run) {
    if (!run || run.driverId === driverId || run.status !== 'running') return false;
    const locks = globalThis.navigator?.locks;
    if (locks?.request && locks?.query) {
      try {
        const state = await locks.query();
        return state.held?.some(lock => lock.name === driverLockName(run)) === true;
      } catch { return true; } // 无法核验活锁时不抢占他端
    }
    if (localDrivers.get(driverLockName(run)) === run.driverId) return true;
    return Number.isFinite(run.driverAt) && Date.now() - run.driverAt < DRIVER_LEASE_MS;
  }

  // ---------- 冻结运行计划（§6.2）----------
  // preview 签发带签名的 plan 对象；start({plan}) 逐项核验 项目/密钥/签名/估价版本/一次性。
  // WeakMap 只认本实例签发的对象：计划是会话内令牌，不随导出迁移，伪造对象无记录。
  const runPlans = new WeakMap();
  // 计划签名：节点草稿 + 触及计划节点的全部连线 + 素材状态摘要。
  // 素材 missing/size/contentRevision 纳入签名——改素材视同内容变更，必须重新预览；
  // 新增外部连线到计划节点同样失效（必需上游闭包可能已变）。
  const sigOf = (project, ids) => JSON.stringify({
    d: ids.map(id => project.nodes.find(n => n.id === id)?.data ?? null),
    e: project.edges.filter(e => ids.includes(e.from.node) || ids.includes(e.to.node)),
    a: Object.keys(project.assets ?? {}).sort().map(aid => {
      const a = project.assets[aid];
      return [aid, a?.missing ? 0 : 1, a?.size ?? -1, a?.contentRevision ?? ''];
    }),
  });
  // 运行中逐节点核对原确认输入；排除执行器产生的 run/result 等运行时字段，
  // 只比较启动时已存在的素材，避免新产出素材误触发重新确认。
  const inputOf = (project, nodeId, originalAssetIds) => {
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node) return null;
    const data = clone(node.data ?? {});
    for (const key of RUNTIME_KEYS) delete data[key];
    delete data.batch;
    return JSON.stringify({
      type: node.type, data,
      edges: project.edges.filter(e => e.to.node === nodeId),
      assets: originalAssetIds.map(id => {
        const a = project.assets?.[id];
        return [id, a?.kind ?? null, a?.missing === true, a?.size ?? null, a?.contentRevision ?? null];
      }),
    });
  };
  // 估价依据版本：能力表版本 + 全型号计费字段摘要——换表/改价即失效，预估必须重报
  const estimateVersionOf = () => {
    const t = capabilityTable();
    if (!t) return 'cap-unset';
    return JSON.stringify({
      v: t.version ?? null,
      p: Object.entries(t.models ?? {}).map(([id, m]) =>
        [id, m.billing_unit ?? null, m.price_cny_per_request ?? null, m.price_cny_per_second ?? null]).sort(),
    });
  };

  // ---------- 估价 ----------
  // 返回 {yuan, kind}：yuan 为微元精度元数；估不出价时 yuan=null + kind='unknown'。
  // 未知报价不是 0 元——调度侧必须显式阻止，绝不当免费放行。
  function quote(node) {
    // 视频有自己的按秒能力表；图片/文本执行器的“不支持该类型”不可覆盖视频报价。
    if (node.type === 'gen') {
      const s = node.data?.draft?.seconds;
      // 模板展开后数字可能是字符串形态：可解析才折算，不可解析仍按未知报价拦截
      const c = estimateCost(node.data?.draft?.model, typeof s === 'string' && s.trim() !== '' ? Number(s) : s);
      return c != null && Number.isFinite(c) ? { yuan: round6(c), kind: 'standard' } : { yuan: null, kind: 'unknown' };
    }
    const q = deps.generators?.quote?.(node);
    if (typeof q === 'number') return Number.isFinite(q) ? { yuan: round6(Math.max(0, q)), kind: 'standard' } : { yuan: null, kind: 'unknown' };
    if (q && typeof q === 'object') {
      const raw = q.yuan ?? q.estimatedYuan;
      if (typeof raw === 'number' && Number.isFinite(raw)) return { yuan: round6(Math.max(0, raw)), kind: q.kind ?? 'standard' };
      return { yuan: null, kind: 'unknown' };
    }
    if (node.type === 'gen') {
      const c = estimateCost(node.data?.draft?.model, node.data?.draft?.seconds);
      if (c != null && Number.isFinite(c)) return { yuan: round6(c), kind: 'standard' };
    }
    return { yuan: null, kind: 'unknown' };
  }
  const isPaidKind = n => n.type === 'gen' || n.type === 'image' || (n.type === 'text' && !!n.data?.model);

  // ---------- onlyEmpty：仅补空白（显式 opt-in，默认路径不变）----------
  // 复用判定 = 付费结果已确认完成 + 本地素材实体可验证（非仅 metadata.missing=false）。
  // 未决态（pendingKey / 未确认 operation / 未完结任务）既不是「可复用」也不是「空」：
  // 一律 blocked——绝不静默重发，也绝不把失效产出当空节点重新扣费。
  const OP_SETTLED = new Set(['completed', 'failed', 'cancelled', 'rejected']);
  async function blobOk(a) {
    if (!a || a.missing) return false;
    let b = null;
    if (typeof deps.assets?.blobOf === 'function') b = await deps.assets.blobOf(a.id).catch(() => null);
    if (!b && typeof storage?.getBlob === 'function') b = await storage.getBlob(`blob:${a.id}`).catch(() => null);
    if (!b || !Number.isFinite(b.size) || b.size <= 0) return false;
    if (a.kind === 'video' && !['video/mp4', 'video/webm'].includes((b.type || a.mime || '').toLowerCase())) return false;
    return true;
  }
  // 产出可用性：缺失引用一律不可用；有素材逐个验证本地实体非空；纯文本需非空
  async function usableOutput(project, node) {
    const out = outputOf(project, node);
    if (out.missing.length) return false;
    if (out.assets.length) {
      for (const a of out.assets) if (!await blobOk(a)) return false;
      return true;
    }
    const generatedText = node.type === 'text' && node.data?.model ? node.data.resultText || node.data.outputText : out.text;
    return typeof generatedText === 'string' && generatedText.trim().length > 0;
  }
  // 复用产出身份快照：消费前复核；id/大小/实体可用性/操作与任务身份任一变化即不一致
  async function outSnapshot(project, node) {
    const out = outputOf(project, node);
    const assets = [];
    for (const a of out.assets) assets.push(`${a?.id ?? ''}:${a?.size ?? -1}:${a?.contentRevision ?? ''}:${a && !a.missing && await blobOk(a) ? 1 : 0}`);
    return JSON.stringify({ t: out.text ?? '', a: assets, op: node.data?.operation ?? null, task: node.data?.run ?? null });
  }
  // 节点分类：run=真实新工作；reuse=复用既有产出（零费用）；
  // resume=认领在途/可下载任务（只查询/等待/下载，零新增 POST、零计价）；
  // blocked=未决提交/终态失败/记录缺席/身份冲突/不可信产出，禁止静默重发
  async function classifyOnlyEmpty(node, project) {
    const d = node.data ?? {};
    if (node.type === 'note') return { kind: 'run' };
    if (d.run?.pendingKey)
      return { kind: 'blocked', reason: 'unsettled', pendingKey: d.run.pendingKey,
        error: '存在未确认的持久化提交：不重发也不按空节点重试，请在节点上人工处理' };
    const op = d.operation;
    if (op && (op.state == null ? !!op.sentAt : !OP_SETTLED.has(op.state)))
      return { kind: 'blocked', reason: 'unsettled',
        error: `付费操作结果未确认（${op.state ?? '已发送未回执'}）：不重发也不按空节点重试` };
    if (!isPaidKind(node)) return { kind: 'run' };          // 免费节点照常执行：幂等零费用，衍生内容随上游保持一致
    const ok = await usableOutput(project, node);
    if (node.type === 'gen' && d.run?.taskId) {
      const taskId = d.run.taskId;
      const rec = typeof runner()?.recOf === 'function' ? await Promise.resolve(runner().recOf(taskId, project.id)).catch(() => null) : null;
      if (!rec || rec.taskId !== taskId)
        return { kind: 'blocked', reason: 'unsettled',
          error: '视频任务记录缺失或身份不符：无法核验任务状态与归属，不会重新提交' };
      if (isFinalFailure(rec))
        return { kind: 'blocked', reason: 'unsettled',
          error: `视频任务已终结（${rec.status}${rec.error ? '：' + String(rec.error?.message ?? rec.error) : ''}）：不会重新提交，请人工处理` };
      if (ok) {
        const linked = outputOf(project, node).assets.every(a => a.kind === 'video' && (a.fromTask === taskId || rec.resultAssetId === a.id));
        return linked && rec.status === 'completed' ? { kind: 'reuse' }
          : { kind: 'blocked', reason: 'unsettled',
              error: '本地产出与当前任务归属/状态不一致：不会重新提交，请人工确认' };
      }
      if (canFetchContent(rec) || needsTracking(rec))
        return { kind: 'resume', reason: canFetchContent(rec) ? 'downloadable' : 'inflight', taskId };
      return { kind: 'blocked', reason: 'unsettled',
        error: '视频任务已暂停查询或脱离节点：不会重新提交，请在节点上人工确认' };
    }
    if (ok) return { kind: 'reuse' };
    if (op?.state === 'completed' || d.resultAssetId || d.outputAssetIds?.length || d.resultText || d.outputText)
      return { kind: 'blocked', reason: 'invalid-output',
        error: '该节点曾完成付费操作但本地产出缺失或失效：不按空节点重新扣费，请人工确认' };
    return { kind: 'run' };
  }

  // ---------- 预检 ----------
  // opts.scope {kind:'selection'|'group'|'all', ids:[...]}：显式范围；缺省按 targets 语义推断
  //（缺省→selection；全画布必须显式 scope:{kind:'all'}）。selection/group 空 ids → 拒绝（§6.2 空选择不启动）；
  // group 的 nodeIds = members + orderedGraph 必需上游闭包（与 C 的 UI 语义一致）。
  async function preview({ targets, rows, onlyEmpty, scope, budgetYuan } = {}) {
    assertSession();
    const project = store.project;
    if (!project) throw new Error('没有打开的项目');
    if (onlyEmpty && rows != null)
      throw new Error('onlyEmpty 仅支持就地单行运行：批量行克隆的是全新节点、没有可复用产出，请改用普通批量');
    const kind = scope?.kind ?? 'selection';   // 未给显式范围一律按选择处理：空 targets 拒绝，绝不隐式回落全画布
    const ids = kind === 'all' ? [] : (Array.isArray(scope?.ids) ? [...scope.ids] : (targets?.length ? [...targets] : []));
    if (!['selection', 'group', 'all'].includes(kind)) throw new Error(`未知运行范围：${scope?.kind}`);
    if (kind !== 'all' && !ids.length) throw new Error('空选择不启动：请先选择节点或改用「整个画布」');
    const issues = [], fatal = [];
    let order = [];
    try { order = orderedGraph(project, kind === 'all' ? null : ids); }
    catch (e) { fatal.push(e.message); }
    let rowFields = null;
    try { rowFields = normalizeRows(rows); }
    catch (e) { fatal.push(e.message); rowFields = [{}]; }
    // onlyEmpty：逐节点做 复用/未决 分类；预估只计真正会新跑的节点，与确认报价一致
    const plan = onlyEmpty ? new Map() : null;
    if (plan) for (const id of order) {
      const n = project.nodes.find(x => x.id === id);
      if (n) plan.set(id, await classifyOnlyEmpty(n, project));
    }
    if (plan) for (const id of order) {
      if (project.edges.some(e => e.to.node === id && plan.get(e.from.node)?.kind === 'blocked'))
        plan.set(id, { kind: 'blocked', reason: 'dependency', error: '必需上游未就绪，本次不生成，请先处理上游问题' });
    }
    const unknownIds = new Set();
    let total = 0;
    // 估价先按 CSV 行展开模板：resolution/seconds 等定价字段可被 {{field}} 升档，
    // 确认框的预估必须与各行展开后的真实价格一致（运行时价格闸对克隆节点另行把关）
    for (const [i, fields] of (rowFields ?? [null]).entries()) {
      for (const id of order) {
        const n = project.nodes.find(x => x.id === id);
        if (!n) { if (i === 0) fatal.push(`工作流包含缺失节点：${id}`); continue; }
        const p = plan?.get(id);
        if (p && p.kind !== 'run') {
          if (i === 0 && p.kind === 'blocked') issues.push(`节点「${title(n)}」：${p.error}`);
          continue;
        }
        let priced = n;
        if (fields) {
          const expanded = { id: n.id, type: n.type, data: clone(n.data) };
          try { applyTemplates(expanded.data, fields); priced = expanded; }
          catch (e) { fatal.push(`第 ${i + 1} 行：${e.message}`); }
        }
        const q = quote(priced);
        if (q.yuan == null) {
          if (isPaidKind(n) && !unknownIds.has(id)) {
            unknownIds.add(id);
            issues.push(`节点「${title(n)}」暂无法估价：未知报价不等于免费，运行时不会发起付费调用`);
          }
        } else total += q.yuan;
      }
    }
    for (const id of order) {
      const n = project.nodes.find(x => x.id === id);
      if (!n) continue;
      for (const e of project.edges.filter(e => e.to.node === id)) {
        const src = project.nodes.find(x => x.id === e.from.node);
        if (!src) { issues.push(`节点「${title(n)}」的输入来源已缺失`); continue; }
        const out = outputOf(project, src);
        for (const a of out.missing) issues.push(`上游「${title(src)}」引用缺失素材 ${a.id}，需重新绑定本地文件`);
        if (src.type === 'asset' && (!src.data.assetId || !project.assets[src.data.assetId])) issues.push(`素材节点「${title(src)}」未绑定素材`);
      }
    }
    if (!order.length && !fatal.length) issues.push('没有可执行节点');
    // Ordinary in-place runs can regenerate an already paid text/image result.
    // Batch runs clone fresh nodes, and accepted video tasks stay under the
    // runner's original-task guard, so neither belongs in this warning.
    const regeneration = [];
    if (!onlyEmpty && rowFields == null) for (const id of order) {
      const n = project.nodes.find(x => x.id === id);
      if (!n || (n.type !== 'image' && !(n.type === 'text' && n.data?.model))) continue;
      if (n.data?.operation?.state === 'completed' || await usableOutput(project, n))
        regeneration.push({ id, title: title(n), type: n.type });
    }
    const res = { nodeIds: order, estimatedYuan: round6(total), priceKind: 'standard',
      unknownPaid: unknownIds.size, regeneration, issues, fatal };
    if (plan) {
      const runIds = [], reusedIds = [], blockedIds = [], resumeIds = [];
      for (const id of order) {
        const k = plan.get(id)?.kind;
        if (k === 'reuse') reusedIds.push(id);
        else if (k === 'blocked') blockedIds.push(id);
        else if (k === 'resume') resumeIds.push(id);
        else runIds.push(id);
      }
      res.onlyEmpty = true;
      res.scope = { selected: targets?.length ? [...targets] : null, nodeIds: [...order] };
      res.runIds = runIds; res.reusedIds = reusedIds; res.blockedIds = blockedIds; res.resumeIds = resumeIds;
      res.skipSummary = {
        total: order.length, run: runIds.length, reused: reusedIds.length, resumed: resumeIds.length, blocked: blockedIds.length,
        paid: runIds.filter(id => isPaidKind(project.nodes.find(x => x.id === id))).length,
      };
    }
    // 冻结运行计划（§6.2）：随预检签发，绑定项目/密钥/画布签名/估价版本——
    // start({plan}) 逐项核验后按 plan.nodeIds/rows/budgetYuan/onlyEmpty 执行
    assertSession();
    const runPlan = {
      id: uid('plan'), projectId: project.id, keyFp: workflowIdentity() ?? null,
      scope: { kind, ids },
      nodeIds: [...order], sig: sigOf(project, order),
      rows: rowFields ? rowFields.map(r => clone(r)) : null,   // 深冻结：嵌套字段值不与调用方共享引用（A 审 m4）
      budgetYuan: Number.isFinite(budgetYuan) ? budgetYuan : null,
      onlyEmpty: onlyEmpty === true,
      estimatedYuan: res.estimatedYuan, priceKind: res.priceKind,
      estimateVersion: estimateVersionOf(), createdAt: Date.now(),
    };
    res.plan = runPlan;
    runPlans.set(runPlan, { project, pre: res, used: false });
    return res;
  }

  // ---------- 行克隆 ----------
  function cloneRowNodes(project, order, fields, run, row, rowIndex) {
    const map = new Map();
    const nodes = [];
    for (const srcId of order) {
      const src = project.nodes.find(n => n.id === srcId);
      if (!src) continue;
      const c = clone(src);
      c.id = uid(src.type[0] ?? 'n'); map.set(srcId, c.id);
      c.data ??= {};
      c.x = src.x + 40 * (rowIndex % 5); c.y = src.y + 420 * (rowIndex + 1);
      for (const k of RUNTIME_KEYS) delete c.data[k];
      applyTemplates(c.data, fields);
      c.data.batch = { run: run.id, row: row.id, src: srcId };
      nodes.push(c);
    }
    const edges = [];
    for (const e of project.edges) {
      if (!map.has(e.from.node) || !map.has(e.to.node)) continue;
      edges.push({ id: uid('e'), from: { node: map.get(e.from.node), port: e.from.port }, to: { node: map.get(e.to.node), port: e.to.port }, order: e.order ?? 0 });
    }
    project.nodes.push(...nodes); project.edges.push(...edges);
    return { nodeIds: nodes.map(n => n.id), edgeIds: edges.map(e => e.id) };
  }

  // ---------- 文本汇聚（仅本地文本节点；付费节点由执行器自行直读连线） ----------
  // 本地（无 model）文本节点：上游文本按连线 order 在前、自身 text 在后，合成 resultText；
  // 不改写 text/draft。来源节点已删除 → 显式失败——缺失输入绝不静默流向下游付费节点。
  function collectWiredText(node, project) {
    const texts = [], missing = [];
    for (const e of store.edgesInto(node.id, 'prompt')) {
      const src = project.nodes.find(n => n.id === e.from.node);
      if (!src) { missing.push(e.from.node); continue; }
      const t = outputOf(project, src).text;
      if (t) texts.push(t);
    }
    return { texts, missing };
  }

  // ---------- 持久化 ----------
  // 当前项目走 store 防抖/落盘通道；被切走的项目直接写文档（并入最新 rev，冲突感知）
  async function persistRun(run, project) {
    run.updatedAt = Date.now();
    if (run.status === 'running' && run.driverId === driverId) run.driverAt = run.updatedAt;
    if (store.project === project) {
      store.touch({ type: 'data' });
      await store.flush();
      return;
    }
    // 已切走的项目：走共享条件更新——把运行态合并进最新存储稿（CAS 重放），绝不整份盲覆盖
    const doc = await store.updateStoredProject(project.id, d => {
      d.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
      d.studio.workflow = JSON.parse(JSON.stringify(run));
    });
    if (!doc) run.issues = [...(run.issues ?? []), '项目文档已不存在，运行态未持久化'];
  }
  async function markPaused(run, project, reason) {
    if (run.status === 'paused') return;
    run.status = 'paused'; run.pauseReason = reason;
    await persistRun(run, project);
  }
  async function ownsDrive(run, project, { allowOwnPause = false } = {}) {
    try {
      const persisted = await storage.get('project:' + project.id);
      const active = persisted?.studio?.workflow;
      return active?.id === run.id && active.driverId === driverId
        && (active.status === 'running' || (allowOwnPause && run.status === 'paused' && active.status === 'paused'));
    } catch { return false; } // 存储不可读时不得继续推进付费步骤
  }
  async function paidStepReady(run, project, node, ns) {
    if (!await ownsDrive(run, project)) return false;
    if (run.inputByNode?.[node.id] === inputOf(project, node.id, run.originalAssetIds ?? [])
      && run.estimateVersion === estimateVersionOf()) return true;
    ns.status = 'blocked'; ns.reason = 'plan_changed';
    ns.error = '已确认的输入或估价依据发生变化，请重新预检并确认；未发送新请求';
    await markPaused(run, project, ns.error);
    return false;
  }

  // ---------- 节点执行 ----------
  async function execNode(run, row, nodeId, project, alive) {
    const ns = run.nodes[nodeId];
    const node = project.nodes.find(n => n.id === nodeId);
    if (!ns) return;
    if (!node) { ns.status = 'skipped'; ns.error = '节点已删除'; return; }
    if (ns.status === 'done') return;                        // 幂等：已完成步骤绝不重放
    if (ns.status === 'blocked' && ns.pendingKey) return;    // 未确认提交不自动重放
    if (isPaidKind(node) && !node.data?.run?.taskId && !node.data?.run?.pendingKey
      && !await paidStepReady(run, project, node, ns)) return 'pause';
    // 必需上游必须全部真实完成：failed/blocked/manual/skipped/缺席 一律把下游传成 skipped——
    // 失败不会被中间节点的 skipped 状态「吸收」后继续执行付费节点。
    for (const e of project.edges.filter(e => e.to.node === nodeId && row.nodeIds.includes(e.from.node))) {
      const upId = e.from.node;
      const ups = run.nodes[upId];
      // onlyEmpty：被复用的上游产出在交给消费者前先复核身份快照——
      // 运行期间产出被换掉/删除时暂停等待人工，绝不拿过期结果继续、也不静默重生成
      if (ups?.outSnap != null) {
        const upNode = project.nodes.find(n => n.id === upId);
        if (!upNode || await outSnapshot(project, upNode) !== ups.outSnap) {
          await markPaused(run, project, `复用的上游产出「${title(upNode)}」在运行期间发生变化，已暂停以免消费过期结果`);
          return 'pause';
        }
      }
      const s = ups?.status;
      if (s !== 'done') {
        ns.status = 'skipped'; ns.error = `上游「${title(project.nodes.find(n => n.id === upId))}」未产出（${s ?? '缺席'}）`;
        return;
      }
    }
    if (run.onlyEmpty) {
      const cls = await classifyOnlyEmpty(node, project);
      if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
      if (cls.kind === 'reuse') {
        ns.status = 'done'; ns.reused = true; ns.reason = 'reused'; ns.error = null;
        ns.outSnap = await outSnapshot(project, node);   // 决策+快照随运行态落盘：重开/续跑不会意外重生成
        if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
        await persistRun(run, project);
        return;
      }
      if (cls.kind === 'blocked') {
        ns.status = 'blocked'; ns.reason = cls.reason; ns.error = cls.error;
        if (cls.pendingKey) ns.pendingKey = cls.pendingKey;
        await persistRun(run, project);
        return;
      }
      if (cls.kind === 'resume') ns.resumed = true;   // 认领在途/可下载任务：execGen 见 taskId 直接进 waitTask，不新增提交
    }
    ns.status = 'running'; ns.error = null;
    await persistRun(run, project);
    let r;
    try {
      switch (node.type) {
        case 'asset': {
          const a = node.data.assetId ? project.assets[node.data.assetId] : null;
          if (!a || a.missing) { ns.status = 'failed'; ns.error = '素材未绑定或本地文件缺失'; }
          else ns.status = 'done';
          break;
        }
        case 'note': ns.status = 'skipped'; break;
        case 'director': {
          const out = outputOf(project, node);
          if (out.assets.length && out.assets.every(x => !x.missing)) ns.status = 'done';
          else { ns.status = 'manual'; ns.error = '导演台节点需在编辑器中手动导出素材后再运行'; }
          break;
        }
        case 'text': r = await execText(run, row, ns, node, project, alive); break;
        case 'image': r = await execPaidNode(run, row, ns, node, project, alive); break;
        case 'utility': r = await execTool(run, row, ns, node, project); break;
        case 'gen': r = await execGen(run, row, ns, node, project, alive); break;
        default: ns.status = 'skipped';
      }
    } catch (e) { ns.status = 'failed'; ns.error = e?.message ?? '执行失败'; }
    // 用户在付费调用已经发出后暂停时，要把该次已完成的结果落盘，恢复才不会重发同一步。
    if (!await ownsDrive(run, project, { allowOwnPause: true })) return 'pause';
    if (ns.status === 'done' && ns.outSnap == null) ns.outSnap = await outSnapshot(project, node);
    run.updatedAt = Date.now();
    await persistRun(run, project);
    return r;
  }

  // ---------- 价格闸 ----------
  // 预算护栏 = 本地标准价估算的软上限：不是服务端限额，也不是实际扣费记录。
  // 未知报价（quote 给不出确定金额）一律 blocked——未知不是 0 元，不得穿过任何预算（含 0）。
  async function priceGate(run, ns, node, project, q) {
    if (q.yuan == null) {
      ns.status = 'blocked'; ns.reason = 'unpriced';
      ns.error = '该节点暂无法估价（未知报价≠免费），已阻止付费调度';
      await persistRun(run, project);
      return 'blocked';
    }
    if (run.budgetYuan != null && micro((run.estimatedSpendYuan ?? 0) + q.yuan) > micro(run.budgetYuan)) {
      ns.status = 'blocked'; ns.reason = 'budget';
      ns.error = `预估 ¥${q.yuan} 将超出预算上限 ¥${run.budgetYuan}（本地估算护栏）`;
      run.status = 'paused'; run.pauseReason = `预算上限 ¥${run.budgetYuan}（本地估算，非实际扣费）`;
      await persistRun(run, project);
      return 'pause';
    }
    return null;
  }
  // 估算消耗记账：微元精度累计，仅在实际发起/未确认的付费调用之后记录。
  // estimatedSpendYuan 为正名；spentYuan 保留镜像（既有文档/面板兼容）。
  function recordSpend(run, yuan) {
    run.estimatedSpendYuan = round6((run.estimatedSpendYuan ?? run.spentYuan ?? 0) + yuan);
    run.spentYuan = run.estimatedSpendYuan;
  }

  // 文本节点：有 model 走 generators.generate（付费）；否则本地落实 resultText
  async function execText(run, row, ns, node, project, alive) {
    if (node.data.model) {
      if (!deps.generators) { ns.status = 'failed'; ns.error = '生成执行器未接入'; return; }
      return execPaidNode(run, row, ns, node, project, alive);
    }
    const { texts, missing } = collectWiredText(node, project);
    if (missing.length) { ns.status = 'failed'; ns.error = `上游文本来源已缺失（${missing.length} 个连线）`; return; }
    const own = node.data.text ?? '';
    node.data.resultText = [...texts, ...(typeof own === 'string' && own.trim() ? [own] : [])].join('\n\n');
    ns.status = 'done';
  }

  // image / text-gen 共用的 generators 通道：报价→价格闸→落盘→瞬态汇聚→generate→核验输出
  async function execPaidNode(run, row, ns, node, project, alive) {
    if (!deps.generators) { ns.status = 'failed'; ns.error = '生成执行器未接入'; return; }
    const q = quote(node);
    const gate = await priceGate(run, ns, node, project, q);
    if (gate === 'pause') return 'pause';
    if (gate) return;                                   // blocked：不发起付费调用，下游按未产出跳过
    ns.status = 'submitting'; ns.cost = q.yuan;
    await persistRun(run, project);          // 付费前先落盘
    if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
    if (!await paidStepReady(run, project, node, ns)) return 'pause';
    // 原始节点交给生成器：连线文本/素材引用由生成侧按真实 edges/outputOf 直读，不做瞬态图改写
    try {
      await deps.generators.generate(node, { runId: run.id, rowId: row.id });
    } catch (e) {
      // 结果未明但请求可能已发出：op.sentAt 已持久化即按“可能已扣费”预留一次预算；
      // 同一操作只记一次（spendKey=op.id 去重）；可证明未发送（saved/无 sentAt）不计
      const op = node.data?.operation;
      if (op?.sentAt && ns.spendKey !== op.id) { recordSpend(run, q.yuan); ns.spendKey = op.id; }
      throw e;
    }
    recordSpend(run, q.yuan);
    if (node.data?.operation?.id) ns.spendKey = node.data.operation.id;
    const out = outputOf(project, node);
    if (!out.text && !out.assets.length && node.data?.operation?.state !== 'completed') {
      ns.status = 'failed'; ns.error = '生成结束但未产出可用结果';
      return;
    }
    ns.status = 'done';
  }

  async function execTool(run, row, ns, node, project) {
    if (!deps.tools?.execute) { ns.status = 'failed'; ns.error = '工具执行器未接入'; return; }
    const r = await deps.tools.execute(node);
    if (r && typeof r === 'object') {
      if (r.text != null && node.data.outputText == null) node.data.outputText = String(r.text);
      if (Array.isArray(r.assets) && !node.data.outputAssetIds?.length) {
        // 工具按合同应自行持久化 outputAssetIds；仅回填缺口的本地素材元数据
        const ids = [];
        for (const a of r.assets) {
          if (!a?.id) continue;
          project.assets[a.id] ??= a;
          ids.push(a.id);
        }
        if (ids.length) node.data.outputAssetIds = ids;
      }
    }
    ns.status = 'done';
  }

  // 视频生成：绝不绕过 runner.submit/adoptDurable；任务完成后必须下载校验为本地素材
  async function execGen(run, row, ns, node, project, alive) {
    const r0 = runner();
    if (!r0) { ns.status = 'failed'; ns.error = '任务执行器未接入'; return; }
    if (typeof r0.adoptDurable === 'function') await r0.adoptDurable(node, alive);   // 认领持久化记录（重开/多标签安全）
    let runState = node.data.run;
    if (runState?.pendingKey) {
      ns.status = 'blocked'; ns.pendingKey = runState.pendingKey;
      ns.error = '有一次提交的结果还未确认：请在节点上点“再次确认结果”，工作流不会自动重发';
      return;
    }
    if (!runState?.taskId) {
      const q = quote(node);
      const gate = await priceGate(run, ns, node, project, q);
      if (gate === 'pause') return 'pause';
      if (gate) return;
      ns.status = 'submitting'; ns.cost = q.yuan;
      await persistRun(run, project);        // 付费前先落盘
      if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
      if (!await paidStepReady(run, project, node, ns)) return 'pause';
      // runner.submit 内部 wired()/effectivePrompt 直读真实连线与上游产出，无需瞬态接线层
      await r0.submit(node);
      runState = node.data.run;
      // 只有真实发起（taskId）或结果未确认（pendingKey）的提交才计入估算消耗——校验未过/未发送不计；
      // 同一任务/同一未确认键只记一次（retryRow 重跑交付分支不再重复计费）
      const spendKey = runState?.taskId ?? runState?.pendingKey;
      if (spendKey && ns.spendKey !== spendKey) { recordSpend(run, q.yuan); ns.spendKey = spendKey; }
    }
    if (runState?.pendingKey) {
      ns.status = 'blocked'; ns.pendingKey = runState.pendingKey;
      ns.error = '提交结果未确认（已持久化幂等记录），请人工处理';
      return;
    }
    if (runState?.taskId) {
      ns.taskId = runState.taskId; ns.status = 'waiting';
      await persistRun(run, project);
      return waitTask(run, row, ns, node, project, alive);
    }
    ns.status = 'failed'; ns.error = runState?.error ?? (runState?.rejected ? '请求被拒绝' : '提交未产生任务');
  }

  // 等待任务终结：无超时上限；每一拍都检查暂停/身份。completed 后强制下载成本地校验过的素材。
  async function waitTask(run, row, ns, node, project, alive) {
    const taskId = ns.taskId;
    if (typeof runner().recOf !== 'function' || typeof runner().download !== 'function') {
      ns.status = 'failed'; ns.error = '任务查询/下载接口未接入'; return;
    }
    for (;;) {
      if (run.status !== 'running') return;
      if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
      const rec = await Promise.resolve(runner().recOf(taskId, project.id)).catch(() => null) ?? null;
      if (rec) {
        if (rec.localSaveState === 'pending' || rec.localSaveState === 'blocked') {
          ns.status = 'blocked'; ns.reason = 'local_save_pending';
          ns.error = '服务器结果已收到，但本地记录尚未可靠保存；恢复存储后只查询原任务';
          return;
        }
        if (rec.terminalConflict) {
          ns.status = 'blocked'; ns.reason = 'query_review';
          ns.error = '原任务查询结果待核对；暂停依赖链，不创建新任务';
          return;
        }
        const local = typeof runner().localResult === 'function'
          ? await runner().localResult(taskId, project.id) : null;
        if (rec.status === 'completed' && local?.ready && local.assetId) {
          const out = outputOf(project, node);
          if (out.assets.length && (await Promise.all(out.assets.map(async a =>
            a.kind === 'video' && (a.fromTask === taskId || rec.resultAssetId === a.id) && await blobOk(a)))).every(Boolean)) {
            ns.status = 'done'; return;
          }
        }
        // 统一终态（task-status.js）：可交付才下载；delivering、v2 completed+contentReady!==true、
        // 非终态与记录缺席一律继续等待——绝不把交付中的任务误判失败，也不对未就绪成片发起下载。
        if (rec.queryHealth === 'needs_review' && !local?.ready) {
          ns.status = 'blocked'; ns.reason = 'query_review';
          ns.error = '原任务查询结果待核对；暂停依赖链，不创建新任务';
          return;
        }
        if (canFetchContent(rec) || (rec.status === 'completed' && local?.ready)) {
          const ok = await runner().download(taskId);
          if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); return 'pause'; }
          const out = outputOf(project, node);
          if (ok && out.assets.length && (await Promise.all(out.assets.map(async a =>
            !a.missing && a.kind === 'video' && (a.fromTask === taskId || rec.resultAssetId === a.id) && await blobOk(a)))).every(Boolean)) {
            ns.status = 'done'; return;
          }
          // 交付失败 ≠ 生成失败：任务已完成且成片在服务端，重试只能走下载/入库（GET），
          // 绝不允许 detach 后重新 POST 造成第二次付费请求
          ns.status = 'failed'; ns.reason = 'delivery'; ns.error = '成片未能入库为本地素材';
          return;
        }
        if (isFinalFailure(rec)) {
          ns.status = 'failed'; ns.error = `任务${rec.status}${rec.error ? '：' + String(rec.error?.message ?? rec.error) : ''}`;
          return;
        }
      }
      if (rec?.downloadExpired) {
        ns.status = 'blocked'; ns.reason = 'missing_local_result';
        ns.error = '远端下载已过期且本地成片缺失；只能恢复原任务或人工处理，不会重新生成';
        return;
      }
      await sleep(pollMs);
    }
  }

  // ---------- 调度主循环 ----------
  async function driveOwned(run, project) {
    if (driving) return;
    driving = true;
    current = { run, project };
    let detached = false;   // 外部接管/取代/移除：本实例只做只读退出，绝不回写存储稿
    const alive = () => sessionAlive() && store.project === project && workflowIdentity() === run.keyFp;
    try {
      for (let ri = run.cursor.row; ri < run.rows.length; ri++) {
        if (run.status !== 'running') break;
        if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); break; }
        // 跨标签页/崩溃恢复检查：存储稿中同一 run 被外部暂停/改写/接管时，本实例停止调度。
        // 被接管/被取代时不回写——避免把外部驱动器的状态又盖回去
        const stored = await storage.get(`project:${project.id}`).catch(() => null);
        const ext = stored?.studio?.workflow;
        if (stored && !ext) { detached = true; break; }              // 运行记录被外部移除
        if (ext && ext.id !== run.id) { detached = true; break; }    // 已被另一个运行取代
        if (ext && ext.status !== 'running') { run.status = ext.status; run.pauseReason = ext.pauseReason ?? run.pauseReason; detached = true; break; }
        if (ext?.driverId && ext.driverId !== run.driverId) {        // 另一标签页接管了同一 run
          run.status = 'paused'; run.pauseReason = '另一个标签页已接管调度';
          detached = true; break;
        }
        const row = run.rows[ri];
        if (!['pending', 'running', 'paused'].includes(row.status)) { run.cursor.row = ri + 1; continue; }
        row.status = 'running';
        for (const nid of row.nodeIds) {
          if (run.status !== 'running') break;
          if (!alive()) { await markPaused(run, project, '项目或密钥已变更，调度已停止'); break; }
          if (!await ownsDrive(run, project)) { detached = true; break; }
          const r = await execNode(run, row, nid, project, alive);
          if (!await ownsDrive(run, project)) { detached = true; break; }
          if (r === 'pause') break;
        }
        if (detached) break;
        if (row.status === 'running')
          row.status = run.status === 'paused' ? 'paused'
            : row.nodeIds.every(id => ['done', 'skipped'].includes(run.nodes[id]?.status)) ? 'done' : 'failed';
        // 只有真正跑完的行才前进游标；暂停的行 resume 后从原行重进
        if (row.status === 'done' || row.status === 'failed') run.cursor.row = ri + 1;
        await persistRun(run, project);
      }
      if (run.status === 'running')
        run.status = run.rows.every(r => r.status === 'done') ? 'done' : 'failed';
      if (!detached) await persistRun(run, project);   // 被外部接管/取代的 run 不回写
      if (alive()) store.touch({ type: 'data' });
      deps.onUpdate?.();
    } finally { driving = false; }
  }

  async function drive(run, project) {
    const name = driverLockName(run);
    const owned = async () => {
      if (!sessionAlive()) return;
      const ext = (await storage.get(`project:${project.id}`).catch(() => null))?.studio?.workflow;
      if (ext?.id !== run.id || ext.driverId !== driverId || ext.status !== 'running') return;
      localDrivers.set(name, driverId);
      try { await driveOwned(run, project); }
      finally { if (localDrivers.get(name) === driverId) localDrivers.delete(name); }
    };
    const locks = globalThis.navigator?.locks;
    return locks?.request ? locks.request(name, { mode: 'exclusive' }, owned) : owned();
  }

  // ---------- 对外 API ----------
  // 两种入口：
  //  · start({plan, confirmed})——冻结计划路径：plan 为 preview 签发的会话令牌，逐项核验
  //    身份/项目/签名/估价版本，任一变化即拒绝并提示重新预览；同一 plan 只消费一次。
  //  · start({targets, rows, onlyEmpty, budgetYuan, confirmed})——无 plan 旧调用，保持原路径。
  async function start({ targets, rows, budgetYuan, confirmed, onlyEmpty, scope, plan } = {}) {
    assertSession();
    const project = store.project;
    if (!project) throw new Error('没有打开的项目');
    const st = studioState(project);
    if (st.workflow?.status === 'running') throw new Error('已有工作流正在运行；请先暂停或等待结束');
    const previousWorkflow = st.workflow;
    let pre, rowFields, effBudget, effOnlyEmpty, planRec = null, guard;
    if (plan != null) {
      planRec = plan && typeof plan === 'object' ? runPlans.get(plan) : null;
      if (!planRec) throw new Error('运行计划无效或已过期，请重新预览生成');
      if (planRec.used) throw new Error('该运行计划已提交执行，请重新预览确认新计划');
      if (plan.projectId !== project.id) throw new Error('计划归属项目已切换，工作流未启动');
      if (plan.keyFp !== (workflowIdentity() ?? null)) throw new Error('密钥已变更，请重新预览');
      if (estimateVersionOf() !== plan.estimateVersion) throw new Error('估价依据（能力表）已变化，请重新预览');
      const sigNow = sigOf(project, plan.nodeIds ?? []);
      if (sigNow !== plan.sig) throw new Error('画布或素材在预览后已修改，请重新预览确认');
      pre = planRec.pre;
      rowFields = plan.rows;
      effBudget = plan.budgetYuan;
      effOnlyEmpty = plan.onlyEmpty;
      // 确认等待期间的守卫：同一组校验在异步边界后复核（含估价版本——等待期换表/改价同样拒绝）
      guard = phase => {
        assertSession();
        if (store.project !== project) throw new Error(`${phase}项目已切换，工作流未启动`);
        if ((workflowIdentity() ?? null) !== plan.keyFp) throw new Error(`${phase}密钥已变更，请重新预览`);
        if (estimateVersionOf() !== plan.estimateVersion) throw new Error(`${phase}估价依据（能力表）已变化，请重新预览`);
        if (sigOf(project, plan.nodeIds ?? []) !== plan.sig) throw new Error(`${phase}画布已修改，请重新预览确认`);
      };
    } else {
      if (onlyEmpty && rows != null)
        throw new Error('onlyEmpty 不能与批量行同时使用：每行克隆的是全新节点、没有可复用产出，请分开执行');
      // 异步预检前的身份/内容基线：预览期间切项目/换密钥/改图，所有路径（含 confirmed:true）都不得照旧启动
      const fp0 = workflowIdentity() ?? null;
      // sig0 必须与 preview 同一套范围解析（scope 优先于 targets）：两套推导不一致会使
      // scope.selection/group 的正常启动被签名守卫确定性误拒（A 审 M1）
      const kind0 = scope?.kind ?? 'selection';
      const ids0 = kind0 === 'all' ? null : (Array.isArray(scope?.ids) ? scope.ids : (targets?.length ? targets : []));
      let sig0 = null;
      try { sig0 = sigOf(project, orderedGraph(project, ids0)); } catch { sig0 = null; }
      pre = await preview({ targets, rows, onlyEmpty, scope });
      // 预检异步期间的身份/内容守卫：confirmed:true 的调用方同样适用
      guard = phase => {
        assertSession();
        if (store.project !== project) throw new Error(`${phase}项目已切换，工作流未启动`);
        if ((workflowIdentity() ?? null) !== fp0) throw new Error(`${phase}密钥已变更，请重新预览确认`);
        if (sig0 != null && sigOf(project, pre.nodeIds) !== sig0) throw new Error(`${phase}画布已修改，请重新预览确认`);
      };
      guard('预检期间');
      rowFields = normalizeRows(rows);
      effBudget = budgetYuan;
      effOnlyEmpty = onlyEmpty;
    }
    if (pre.fatal.length) { const e = new Error('工作流预检未通过：' + pre.fatal.join('；')); e.issues = pre.fatal; throw e; }
    if (rowFields && !rowFields.length) throw new Error('批量行不能为空');
    const rowCount = rowFields?.length ?? 1;
    if (effBudget != null && (!Number.isFinite(effBudget) || effBudget < 0)) throw new Error('预算上限不合法');
    if (!confirmed) {
      if (typeof document === 'undefined' || !document.getElementById)
        throw new Error('启动工作流需要显式确认（测试路径请传 confirmed:true）');
      const ok = await confirmDialog('确认运行工作流', el('div', {},
        el('p', { text: `将执行 ${pre.nodeIds.length} 个节点 × ${rowCount} 行` }),
        pre.onlyEmpty ? el('p', { text: `仅补空白：复用 ${pre.skipSummary.reused} 个既有产出，续跑 ${pre.skipSummary.resumed} 个在途任务（只查询/下载，不新增付费请求），新执行 ${pre.skipSummary.run} 个节点，拦截 ${pre.skipSummary.blocked} 个未确认节点` }) : null,
        pre.regeneration?.length ? el('p', { class: 'err-text', text: `以下已有付费产出的节点将重新生成，可能再次计费：${pre.regeneration.map(n => n.title).join('、')}。如只需补齐空白，请取消并选择「仅补齐空白节点」。` }) : null,
        el('p', { text: `预估费用 ¥${pre.estimatedYuan.toFixed(4)}（标准价估算，非实际账单）` }),
        pre.unknownPaid ? el('p', { class: 'err-text', text: `${pre.unknownPaid} 个付费节点无法估价，将不会发起付费调用（未知≠免费）` }) : null,
        effBudget != null ? el('p', { text: `预算上限 ¥${effBudget}（本地估算软护栏，超出自动暂停；非服务端限额）` }) : null,
        pre.issues.length ? el('p', { class: 'err-text', text: '注意：' + pre.issues.join('；') }) : null));
      if (!ok) return { cancelled: true, preview: pre };
      // 确认等待期间的身份/内容守卫：用户看的是当时的预检，切项目/换密钥/改图后不得照旧启动
      guard('确认等待期间');
    }
    const run = {
      id: uid('run'), projectId: project.id, keyFp: workflowIdentity() ?? null, driverId, driverAt: Date.now(),
      status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
      budgetYuan: Number.isFinite(effBudget) ? effBudget : null,
      estimatedYuan: pre.estimatedYuan, estimatedSpendYuan: 0, spentYuan: 0, priceKind: pre.priceKind,
      unknownPaid: pre.unknownPaid ?? 0,
      onlyEmpty: effOnlyEmpty === true,
      estimateVersion: estimateVersionOf(),
      originalAssetIds: Object.keys(project.assets ?? {}).sort(),
      inputByNode: {},
      targets: [...pre.nodeIds], issues: [...pre.issues], rows: [], nodes: {}, cursor: { row: 0 },
    };
    if (run.onlyEmpty)
      run.issues.push('仅补空白模式的复用决策不随导出迁移：导入后的运行请重新预检确认后再继续');
    // 临界区：另一标签页不得同时建起第二个运行中的工作流；任何付费操作之前先落盘。
    // 克隆行节点在锁内就推入 project——首次落盘失败必须完整回滚本次新增节点/边，不留批量孤儿。
    const addedN = new Set(), addedE = new Set();
    try {
      await xlock.request(`xp-workflow:${project.id}`, async () => {
        if (store.project !== project) throw new Error('项目已切换，工作流未启动');
        const stored = await storage.get(`project:${project.id}`).catch(() => null);
        const other = stored?.studio?.workflow;
        guard('启动等待期间');
        if (other && other.status === 'running' && other.id !== run.id)
          throw new Error('已有工作流在运行（可能来自其他标签页）');
        if (store.project !== project) throw new Error('项目已切换，工作流未启动');
        for (const [i, fields] of (rowFields ?? [null]).entries()) {
          const row = { id: uid('row'), index: i, fields: fields ?? {}, status: 'pending', nodeIds: [], error: null };
          const cloned = rowFields == null ? null : cloneRowNodes(project, pre.nodeIds, fields, run, row, i);
          row.nodeIds = rowFields == null ? pre.nodeIds : cloned.nodeIds;
          for (const nid of cloned?.nodeIds ?? []) addedN.add(nid);
          for (const eid of cloned?.edgeIds ?? []) addedE.add(eid);
          run.rows.push(row);
          for (const nid of row.nodeIds) {
            const n = project.nodes.find(x => x.id === nid);
            run.nodes[nid] = { src: n?.data?.batch?.src ?? nid, type: n?.type, status: 'pending', cost: null, taskId: null, pendingKey: null, reason: null, error: null };
            run.inputByNode[nid] = inputOf(project, nid, run.originalAssetIds);
          }
        }
        st.workflow = run;
        store.touch({ type: 'structure' });
        await store.flush();                 // 首次持久化先于任何付费工作
        if (store.project !== project) throw new Error('项目已切换，工作流未启动');
      });
    } catch (e) {
      if (st.workflow === run) st.workflow = previousWorkflow; // 失败的新运行不得清掉已有记录或并发更新
      if (addedN.size) project.nodes = project.nodes.filter(n => !addedN.has(n.id));
      if (addedE.size) project.edges = project.edges.filter(x => !addedE.has(x.id));
      if (addedN.size || addedE.size) store.touch({ type: 'structure' });
      throw e;
    }
    if (planRec) planRec.used = true;   // 计划一次性消费：同一确认不得再次启动重复工作
    await drive(run, project);
    return getState();
  }

  async function pause() {
    const proj = store.project;
    const run = proj?.studio?.workflow;
    if (run && run.status === 'running' && proj) {
      // 同一把项目级锁内写暂停：与 resume/retryRow 的接管写排序，互不交错
      await xlock.request(`xp-workflow:${proj.id}`, async () => {
        const ext = (await storage.get(`project:${proj.id}`).catch(() => null))?.studio?.workflow;
        if (ext?.id !== run.id || ext.status !== 'running') return;
        if (await foreignDriverActive(ext)) return; // 活跃的其他标签页只能由其自身暂停
        // 本实例的驱动可能正在完成异步节点；保留同一个 run 对象，不能用早一拍的存储副本覆盖其结果。
        const target = current?.project === proj && current.run.id === ext.id && ext.driverId === driverId
          ? current.run : ext;
        target.status = 'paused'; target.pauseReason = '用户暂停';
        studioState(proj).workflow = target;
        current = { run: target, project: proj };
        await persistRun(target, proj);
      });
    }
    return getState();
  }

  // opts.budgetYuan：显式改预算并沿用同一 run 继续（面板「调整预算并继续」）。
  // 只重新排队「因预算被拦」的节点；不新建运行、不清已完成节点、不动 pendingKey/任务身份。
  async function resume({ budgetYuan } = {}) {
    assertSession();
    if (store.project?.studio?.workflow?.imported)
      throw new Error(store.project.studio.workflow.onlyEmpty
        ? '导入的仅补空白工作流需重新预检并提交运行，不支持直接续跑旧记录'
        : '导入的工作流需重新预检并提交新运行；原任务仍可在任务中心恢复');
    // openProject 会重新载入项目对象；运行身份以当前项目中的持久化 run.id 为准。
    const proj = store.project;
    let run = proj?.studio?.workflow;
    if (!run || !proj) return getState();
    if (run.imported) throw new Error('导入的工作流需重新预检并提交新运行；原任务仍可在任务中心恢复');
    if (driving || !['paused', 'running'].includes(run.status)) return getState();
    if (run.projectId !== proj.id || workflowIdentity() !== run.keyFp)
      throw new Error('项目或密钥已变更，无法继续调度');
    let toDrive = null;
    // 同一 run 的驱动互斥：xp-workflow 锁内复核持久化稿 status/driverId 代际——
    // 他端已在驾驶就绝不让第二个驱动器上路（提交侧另有 runner 幂等与节点锁兜底，此处不宣称必然双扣）。
    // 锁内只做 复核+过户+落盘，drive 在锁外跑——与 start 同级，不与节点提交锁嵌套。
    await xlock.request(`xp-workflow:${proj.id}`, async () => {
      const stored = await storage.get(`project:${proj.id}`).catch(() => null);
      assertSession();
      const ext = stored?.studio?.workflow;
      if (!ext) { // 删除或存储不可读时，不从内存旧稿重新创建一个运行
        run.issues = [...(run.issues ?? []), '无法核对持久化运行，未继续调度'];
        return;
      }
      if (ext && ext.id !== run.id) {                          // 存储里已是另一个运行：以持久化稿为准
        run = ext;
        if (store.project === proj) { studioState(proj).workflow = ext; current = { run: ext, project: proj }; }
        return;
      }
      if (await foreignDriverActive(ext)) {                    // 活跃的他端驱动仍持有运行权
        run = ext;
        if (store.project === proj) { studioState(proj).workflow = ext; current = { run: ext, project: proj }; }
        return;
      }
      const target = ext ?? run;                               // 持久化稿优先（他端进度不丢）
      if (!['paused', 'running'].includes(target.status)) { run = target; return; }
      if (target.projectId !== proj.id || workflowIdentity() !== target.keyFp)
        throw new Error('项目或密钥已变更，无法继续调度');
      if (budgetYuan !== undefined) {
        if (budgetYuan != null && (!Number.isFinite(budgetYuan) || budgetYuan < 0)) throw new Error('预算上限不合法');
        target.budgetYuan = budgetYuan;
        for (const ns of Object.values(target.nodes)) {
          if (ns.status === 'blocked' && ns.reason === 'budget') { ns.status = 'pending'; ns.error = null; ns.reason = null; }
        }
        for (const r of target.rows) {
          if (['failed', 'done'].includes(r.status) && r.nodeIds.some(id => ['pending', 'running'].includes(target.nodes[id]?.status))) {
            r.status = 'pending'; r.error = null;
          }
        }
        const first = target.rows.findIndex(r => ['pending', 'paused', 'running'].includes(r.status));
        if (first >= 0) target.cursor.row = Math.min(target.cursor.row, first);
      }
      target.status = 'running'; target.pauseReason = null;
      target.driverId = driverId; target.driverAt = Date.now();
      if (store.project === proj) studioState(proj).workflow = target;
      await persistRun(target, proj);
      run = target; toDrive = target; current = { run: target, project: proj };
    });
    if (toDrive && sessionAlive()) await drive(toDrive, proj);
    return getState();
  }

  // 显式失败行重试：只有用户点「重试该行」才会重置；未确认提交（pendingKey）永远不在此重发
  async function retryRow(rowId) {
    assertSession();
    if (store.project?.studio?.workflow?.imported)
      throw new Error(store.project.studio.workflow.onlyEmpty
        ? '导入的仅补空白工作流需重新预检并提交运行，不支持重试旧记录'
        : '导入的工作流需重新预检并提交新运行；原任务仍可在任务中心恢复');
    if (driving) return getState();                          // 调度进行中不接受重试，先暂停
    const proj = store.project;
    let run = proj?.studio?.workflow;
    if (!run || !proj) return getState();
    if (run.imported) throw new Error('导入的工作流需重新预检并提交新运行；原任务仍可在任务中心恢复');
    if (run.projectId !== proj.id || workflowIdentity() !== run.keyFp)
      throw new Error('项目或密钥已变更，无法重试该行');
    let toDrive = null;
    // 与 resume 同一把锁：锁内按持久化稿复核（他端接管/换 run 即放弃），再重置行并过户 driverId
    await xlock.request(`xp-workflow:${proj.id}`, async () => {
      const stored = await storage.get(`project:${proj.id}`).catch(() => null);
      assertSession();
      const ext = stored?.studio?.workflow;
      if (!ext) { run.issues = [...(run.issues ?? []), '无法核对持久化运行，未重试该行']; return; }
      if (ext && ext.id !== run.id) {
        run = ext;
        if (store.project === proj) { studioState(proj).workflow = ext; current = { run: ext, project: proj }; }
        return;
      }
      if (await foreignDriverActive(ext)) {
        run = ext;
        if (store.project === proj) { studioState(proj).workflow = ext; current = { run: ext, project: proj }; }
        return;
      }
      const target = ext ?? run;
      if (target.projectId !== proj.id || workflowIdentity() !== target.keyFp)
        throw new Error('项目或密钥已变更，无法重试该行');
      const row = target.rows.find(r => r.id === rowId || String(r.index) === String(rowId));
      if (!row) throw new Error('找不到该行');
      for (const nid of row.nodeIds) {
        const ns = target.nodes[nid];
        if (!ns || !['failed', 'blocked', 'skipped'].includes(ns.status)) continue;
        if (ns.pendingKey) continue;                            // 未确认提交只能在节点上人工重试
        const node = proj.nodes.find(n => n.id === nid);
        if (node?.data?.run?.taskId) {
          const canQuery = typeof runner()?.recOf === 'function';
          const rec = canQuery
            ? await Promise.resolve(runner().recOf(node.data.run.taskId, proj.id)).catch(() => null)
            : null;
          if (rec && !isFinalFailure(rec)) {
            // 可下载/在途/交付中/未就绪的任务：保留任务身份，重跑只走 waitTask 的查询/下载入库分支——
            // 绝不 detach 后再 submit 造成第二次付费请求；终态失败才允许脱离重发
            ns.status = 'pending'; ns.error = null; ns.reason = null;
            continue;
          }
          if (!rec) continue;   // 无法核验原任务状态（记录缺失或查询接口缺席）：保持失败走人工恢复，绝不盲目 detach 重发
          if (typeof runner()?.detach !== 'function') continue; // 没有脱离接口就不能安全重置
          await runner().detach(node);
        }
        if (node?.data?.run?.pendingKey) continue;
        ns.status = 'pending'; ns.error = null; ns.taskId = null; ns.reason = null;
      }
      row.status = 'pending'; row.error = null;
      target.status = 'running'; target.pauseReason = null;
      target.driverId = driverId; target.driverAt = Date.now();
      target.cursor.row = Math.min(target.cursor.row, row.index);
      if (store.project === proj) studioState(proj).workflow = target;
      await persistRun(target, proj);
      run = target; toDrive = target; current = { run: target, project: proj };
    });
    if (toDrive && sessionAlive()) await drive(toDrive, proj);
    return getState();
  }

  function getState() {
    const run = store.project?.studio?.workflow ?? current?.run ?? null;
    return run ? clone(run) : { status: 'idle' };
  }

  // ---------- 面板（DOM）----------
  function panel() {
    if (typeof document === 'undefined' || !document.getElementById) return { close() {} };
    const STATUS = { pending: '待执行', running: '执行中', submitting: '提交中', waiting: '等待任务', done: '完成', failed: '失败', skipped: '跳过', blocked: '需人工', manual: '需手动导出' };
    const ROW = { pending: '待执行', running: '执行中', done: '完成', failed: '失败', paused: '已暂停' };
    const box = el('div', {});
    const { close } = modal(el('div', {}, el('h3', { text: '工作流' }), box), { wide: true, onClose: () => clearInterval(timer) });
    const timer = setInterval(render, 1500);
    function chip(ns) {
      const cls = ns.status === 'done' ? 'ok' : ['failed', 'blocked'].includes(ns.status) ? 'err' : ['running', 'submitting', 'waiting'].includes(ns.status) ? 'busy' : 'warn';
      return el('span', { class: `badge ${cls}`, title: ns.error ?? '', text: ns.reused ? '复用' : (ns.resumed && ['pending', 'running', 'waiting'].includes(ns.status) ? '续跑' : STATUS[ns.status] ?? ns.status) });
    }
    function onlyEmptySummary(run) {
      const ns = Object.values(run.nodes ?? {});
      const reused = ns.filter(n => n?.reused).length;
      const resumed = ns.filter(n => n?.resumed).length;
      const blocked = ns.filter(n => n?.status === 'blocked' && ['unsettled', 'invalid-output', 'dependency'].includes(n?.reason)).length;
      return `仅补空白：已复用 ${reused} 个产出，续跑 ${resumed} 个在途任务，拦截 ${blocked} 个未确认/失效节点`;
    }
    function render() {
      const run = current?.run ?? store.project?.studio?.workflow;
      if (!run) { box.replaceChildren(el('p', { class: 'hint', text: '当前项目没有工作流运行记录' })); return; }
      const head = el('div', {},
        el('div', { class: 'row' }, el('span', { text: '状态' }), el('b', { text: { running: '运行中', paused: '已暂停', done: '已完成', failed: '有失败行' }[run.status] ?? run.status })),
        el('div', { class: 'row' }, el('span', { text: '费用估算' }), el('b', { text: `已消耗约 ¥${(run.estimatedSpendYuan ?? run.spentYuan ?? 0).toFixed(4)} / 预估 ¥${(run.estimatedYuan ?? 0).toFixed(4)}（标准价估算，非实际扣费）` })),
        run.budgetYuan != null ? el('div', { class: 'row' }, el('span', { text: '预算护栏' }), el('b', { text: `¥${run.budgetYuan}（本地估算软上限，非服务端限额）` })) : null,
        run.unknownPaid ? el('div', { class: 'row muted' }, el('span', { text: `${run.unknownPaid} 个节点报价未知，已跳过付费调用` })) : null,
        run.onlyEmpty ? el('div', { class: 'row muted' }, el('span', { text: onlyEmptySummary(run) })) : null,
        run.pauseReason ? el('div', { class: 'row muted' }, el('span', { text: run.pauseReason })) : null);
      const actions = el('div', { class: 'modal-actions' });
      if (run.status === 'running') {
        const b = el('button', { type: 'button', text: '暂停调度' });
        b.addEventListener('click', () => pause().then(render).catch(e => toast(e.message, 'err')));
        actions.append(b);
      }
      if (run.status === 'paused') {
        const b = el('button', { class: 'primary', type: 'button', text: '继续运行' });
        b.addEventListener('click', () => resume().then(render).catch(e => toast(e.message, 'err')));
        actions.append(b);
        // 显式改预算并沿用同一 run 继续：不新建运行、不重跑已完成节点
        const budgetIn = el('input', { type: 'number', min: 0, step: 0.0001, value: run.budgetYuan ?? '', placeholder: '预算 ¥（留空不限）' });
        const amend = el('button', { type: 'button', text: '调整预算并继续' });
        amend.addEventListener('click', () => {
          const v = budgetIn.value === '' ? null : Number(budgetIn.value);
          resume({ budgetYuan: v }).then(render).catch(e => toast(e.message, 'err'));
        });
        actions.append(el('span', { class: 'row' }, budgetIn, amend));
      }
      const rows = el('div', {});
      for (const r of run.rows) {
        const cells = r.nodeIds.map(nid => chip(run.nodes[nid] ?? { status: 'pending' }));
        const retry = el('button', { class: 'mini', type: 'button', text: '重试该行' });
        retry.addEventListener('click', () => retryRow(r.id).then(render).catch(e => toast(e.message, 'err')));
        rows.append(el('div', { class: 'task-item' },
          el('div', { class: 'row' }, el('b', { text: `第 ${r.index + 1} 行` }), el('span', { class: `badge ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'err' : 'busy'}`, text: ROW[r.status] ?? r.status })),
          el('div', { class: 'row' }, ...cells),
          r.error ? el('div', { class: 'err-text', text: r.error }) : null,
          r.status === 'failed' ? el('div', { class: 'row actions' }, retry) : null));
      }
      box.replaceChildren(head, actions, rows,
        run.issues?.length ? el('p', { class: 'hint', text: run.issues.join('；') }) : null);
    }
    render();
    return { close };
  }

  async function stopForIdentityChange() {
    if (sessionAlive()) await pause().catch(() => {});
    disposed = true;
  }
  return { preview, start, pause, resume, retryRow, stopForIdentityChange, getState, panel };
}
