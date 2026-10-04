// 画布助手：调用可用文本型号产出“结构化修改建议”，预览后由用户显式应用。
// 安全边界：
//  · 动作类型白名单；节点/素材/镜头一律经句柄（N1/A1/S1）或真实 id 解析，越界即跳过
//  · 只产生数据修改（文本/提示词/参数/连线/镜头/便签），绝不执行 JS、不触碰端点、不触发生成
//  · 应用前经 editor.checkpoint()，可撤销；生成与扣费只能由用户之后手动发起

import { el, modal, confirmDialog } from './ui.js';
import { buildChatBody, chatModelIdsFromCatalog, nodeOutputs } from './capabilities.js';
import { ApiError, chatResponseText } from './api.js';
import { getModelCatalog, getAvailableModels, getFingerprint, hasKey, isModelUsable } from './keyvault.js';
import { studioState, SHOT_FIELDS } from './studio-schema.js';
import { NODE_TYPES, uid } from './store.js';
import { createSubmitLock } from './submit-lock.js';

const s = (v, max = 20000) => typeof v === 'string' ? v.slice(0, max) : '';
const clampInt = (v, min, max, dflt = null) =>
  Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : dflt;

// 从模型输出中提取 JSON 对象（允许前后有说明文字或代码围栏）
export function extractJson(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// 画布现状 + 句柄表：模型只能用这些句柄引用实体
export function buildContext(store) {
  const handles = new Map();
  const lines = [];
  let ni = 0, ai = 0, si = 0;
  for (const n of store.project?.nodes ?? []) {
    const h = `N${++ni}`;
    handles.set(h, { kind: 'node', id: n.id });
    const out = nodeOutputs(store.project, n);
    lines.push(`${h} [${n.type}] ${s(n.data?.title, 80) || '(无标题)'} 位置(${n.x},${n.y})` +
      `${out.text ? ' 文本:' + out.text.slice(0, 60) : ''}${out.assets.length ? ` 素材×${out.assets.length}` : ''}`);
  }
  for (const a of Object.values(store.project?.assets ?? {})) {
    const h = `A${++ai}`;
    handles.set(h, { kind: 'asset', id: a.id });
    lines.push(`${h} [素材:${a.kind}] ${s(a.name, 80)}${a.missing ? '（缺文件）' : ''}`);
  }
  for (const shot of studioState(store.project).shots) {
    const h = `S${++si}`;
    handles.set(h, { kind: 'shot', id: shot.id });
    lines.push(`${h} [镜头] ${s(shot.title, 80)}`);
  }
  return { handles, text: lines.join('\n') || '(空画布)' };
}

// 结构签名：方案应用前校验画布未变。节点 id/类型/位置/全部数据、连线、素材、分镜全部计入；
// 仅排除 operation 记录内的时间戳（轮询/确认产生的时间推进不算结构变化）。
export function canvasSignature(project) {
  const cleanData = d => {
    const c = JSON.parse(JSON.stringify(d ?? {}));
    if (c.operation && typeof c.operation === 'object' && !Array.isArray(c.operation))
      for (const k of ['createdAt', 'sentAt', 'resolvedAt', 'completedAt', 'at', 'updatedAt']) delete c.operation[k];
    return c;
  };
  return JSON.stringify({
    nodes: (project?.nodes ?? []).map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, data: cleanData(n.data) })),
    edges: (project?.edges ?? []).map(e => [e.from?.node, e.from?.port, e.to?.node, e.to?.port, e.order ?? 0]),
    assets: Object.fromEntries(Object.entries(project?.assets ?? {}).map(([k, a]) => [k, [a?.kind, a?.name, a?.missing === true]])),
    shots: studioState(project ?? {}).shots ?? [],
  });
}

// 方案失效判定：项目对象 / 项目 id / 密钥指纹 / 结构签名任一不符即整批作废。
// planMeta 在发送前冻结：{project, projectId, keyFp, signature, handles(Map: 句柄→{kind,id})}——
// 句柄到实体的对应关系随快照冻结，同一序号句柄绝不漂移到后建的新节点。
export function planStale(meta, store) {
  if (!meta) return true;
  if (store.project !== meta.project || store.project?.id !== meta.projectId) return true;
  if (getFingerprint() !== meta.keyFp) return true;
  return canvasSignature(store.project) !== meta.signature;
}

const SYSTEM = `你是画布创作助手。根据用户指令与画布现状，只输出一个 JSON 对象（不要输出其他内容）：
{"reply":"给用户的简短中文说明","actions":[动作,...]}
允许的动作（除此之外一律不要输出）：
- {"type":"add_note","text":"便签内容","x":100,"y":100}
- {"type":"add_text","title":"标题","text":"文本内容","x":100,"y":100}
- {"type":"rename_node","node":"N1","title":"新标题"}
- {"type":"set_node_text","node":"N1","text":"新文本"}（仅文本节点）
- {"type":"set_prompt","node":"N1","prompt":"新提示词"}（文本/图片/视频生成节点）
- {"type":"set_draft","node":"N1","seconds":5,"ratio":"16:9","intent":"text"}（仅视频生成节点，字段可选）
- {"type":"move_node","node":"N1","x":100,"y":100}
- {"type":"connect","from":"N1","to":"N2","fromPort":"out","toPort":"prompt"}
- {"type":"add_shot","title":"镜头名","duration":5,"description":"...","videoPrompt":"..."}
- {"type":"update_shot","shot":"S1","fields":{"description":"..."}}
节点用 N1/N2…、素材 A1…、镜头 S1… 句柄引用，不得使用不存在的句柄。
你只提出修改建议：不执行生成、不调用接口、不承诺结果。镜头字段仅限已知字段名。`;

// 逐条校验动作 → {ok, line, run}。run() 只在用户点“应用”后执行。
export function planActions(raw, { store, handles }) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map(a => planOne(a, { store, handles }));
}

function planOne(a, { store, handles }) {
  const bad = line => ({ ok: false, line: `跳过：${line}`, run: null });
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return bad('动作格式错误');
  const nodeOf = v => {
    const key = s(v, 128);
    const hit = handles?.get(key);
    return store.node(hit?.kind === 'node' ? hit.id : key) ?? null;
  };
  switch (a.type) {
    case 'add_note': {
      const text = s(a.text);
      if (!text) return bad('便签内容为空');
      return { ok: true, line: `新增便签：${text.slice(0, 40)}`, run: () => store.addNode('note', clampInt(a.x, -1e5, 1e5, 160), clampInt(a.y, -1e5, 1e5, 160), { text }) };
    }
    case 'add_text': {
      const text = s(a.text);
      if (!text) return bad('文本为空');
      return { ok: true, line: `新增文本节点：${s(a.title, 40) || text.slice(0, 30)}`, run: () => store.addNode('text', clampInt(a.x, -1e5, 1e5, 160), clampInt(a.y, -1e5, 1e5, 160), { title: s(a.title, 256), text }) };
    }
    case 'rename_node': {
      const n = nodeOf(a.node); if (!n) return bad('节点不存在');
      const t = s(a.title, 256); if (!t) return bad('标题为空');
      const nid = n.id;
      return { ok: true, line: `重命名 ${nid} → ${t}`, run: () => {
        if (!store.node(nid)) throw new Error(`节点 ${nid} 已删除`);
        store.updateNodeData(nid, { title: t });
      } };
    }
    case 'set_node_text': {
      const n = nodeOf(a.node); if (!n) return bad('节点不存在');
      if (n.type !== 'text') return bad('仅文本节点可设置文本');
      const t = s(a.text, 200000);
      const nid = n.id;
      return { ok: true, line: `设置 ${nid} 文本（${t.length} 字）`, run: () => {
        const cur = store.node(nid);
        if (!cur || cur.type !== 'text') throw new Error(`节点 ${nid} 已删除或类型已变`);
        cur.data.text = t; delete cur.data.resultText; store.touch({ type: 'data', id: nid });
      } };
    }
    case 'set_prompt': {
      const n = nodeOf(a.node); if (!n) return bad('节点不存在');
      const p = s(a.prompt, 200000); if (!p.trim()) return bad('提示词为空');
      if (!['gen', 'image', 'text'].includes(n.type)) return bad('该节点类型不支持提示词');
      const nid = n.id, ptype = n.type;
      return { ok: true, line: `设置 ${nid} ${ptype === 'gen' ? '视频' : ''}提示词`, run: () => {
        const cur = store.node(nid);
        if (!cur || cur.type !== ptype) throw new Error(`节点 ${nid} 已删除或类型已变`);
        if (cur.type === 'gen') cur.data.draft = { ...(cur.data.draft ?? {}), prompt: p };
        else cur.data.prompt = p;
        store.touch({ type: 'data', id: nid });
      } };
    }
    case 'set_draft': {
      const n = nodeOf(a.node); if (!n || n.type !== 'gen') return bad('仅视频生成节点支持参数调整');
      const patch = {};
      if (a.seconds != null) patch.seconds = clampInt(a.seconds, 1, 60, undefined);
      if (a.ratio != null) patch.ratio = s(a.ratio, 16);
      if (a.intent != null) patch.intent = s(a.intent, 32);
      if (!Object.keys(patch).length) return bad('无有效字段');
      const nid = n.id;
      return { ok: true, line: `调整 ${nid} 生成参数（${Object.keys(patch).join('/')}）`, run: () => {
        const cur = store.node(nid);
        if (!cur || cur.type !== 'gen') throw new Error(`节点 ${nid} 已删除或类型已变`);
        cur.data.draft = { ...(cur.data.draft ?? {}), ...patch }; store.touch({ type: 'data', id: nid });
      } };
    }
    case 'move_node': {
      const n = nodeOf(a.node); if (!n) return bad('节点不存在');
      const x = clampInt(a.x, -1e6, 1e6), y = clampInt(a.y, -1e6, 1e6);
      if (x == null || y == null) return bad('坐标无效');
      const nid = n.id;
      return { ok: true, line: `移动 ${nid} → (${x},${y})`, run: () => {
        if (!store.node(nid)) throw new Error(`节点 ${nid} 已删除`);
        store.moveNode(nid, x, y);
      } };
    }
    case 'connect': {
      const f = nodeOf(a.from), t = nodeOf(a.to);
      if (!f || !t) return bad('连线端点不存在');
      const fp = s(a.fromPort, 64) || 'out', tp = s(a.toPort, 64);
      if (!tp) return bad('缺少目标端口');
      const pkind = NODE_TYPES[f.type]?.ports?.out?.find(p => p.id === fp)?.kind;
      if (!pkind) return bad('来源端口不存在');
      const fid = f.id, tid = t.id;
      return { ok: true, line: `连接 ${fid}.${fp} → ${tid}.${tp}`, run: () => {
        const cf = store.node(fid), ct = store.node(tid);
        if (!cf || !ct) throw new Error('连线端点已删除');
        // 资产种类在执行时重取真实输出（asset 节点声明是 media，实际是 image 时要按 image 判定）
        const outs = nodeOutputs(store.project, cf);
        const kind = outs.assets[0]?.kind ?? (outs.text?.trim() ? 'text' : pkind);
        if (!store.addEdge(fid, fp, tid, tp, kind)) throw new Error('端口不兼容或重复连线');
      } };
    }
    case 'add_shot': {
      if ((studioState(store.project).shots?.length ?? 0) >= 200) return bad('分镜数量已达上限（≤200）');
      const fields = {};
      for (const [k] of SHOT_FIELDS) if (a[k] != null) fields[k] = k === 'duration' ? clampInt(a[k], 1, 30, 5) : s(a[k]);
      if (!fields.title && !fields.description) return bad('镜头内容为空');
      return { ok: true, line: `新增镜头：${s(a.title, 40) || '(无标题)'}`, run: () => { studioState(store.project).shots.push({ id: uid('s'), nodeId: null, imageNodeId: null, assetIds: [], ...fields }); store.touch({ type: 'structure' }); } };
    }
    case 'update_shot': {
      const key = s(a.shot, 128);
      const hit = handles?.get(key);
      const shot = studioState(store.project).shots.find(x => x.id === (hit?.kind === 'shot' ? hit.id : key));
      if (!shot) return bad('镜头不存在');
      const f = a.fields;
      if (!f || typeof f !== 'object' || Array.isArray(f)) return bad('缺少 fields');
      const patch = {};
      for (const [k] of SHOT_FIELDS) if (f[k] != null) patch[k] = k === 'duration' ? clampInt(f[k], 1, 30, shot.duration ?? 5) : s(f[k]);
      if (!Object.keys(patch).length) return bad('无有效字段');
      const sid = shot.id;
      return { ok: true, line: `更新镜头 ${s(shot.title, 30) || sid}（${Object.keys(patch).join('/')}）`, run: () => {
        const cur = studioState(store.project).shots.find(x => x.id === sid);
        if (!cur) throw new Error(`镜头 ${sid} 已删除`);
        Object.assign(cur, patch); store.touch({ type: 'structure' });
      } };
    }
    default:
      return bad(`不支持的动作类型 ${s(a.type, 40)}`);
  }
}

export function createAssistant(deps) {
  const { store, api, editor, onUpdate } = deps;
  const storage = deps.storage ?? null;
  const xlock = typeof deps.submitLock === 'function' ? { request: deps.submitLock }
    : deps.submitLock?.request ? deps.submitLock
      // 托管形态：付费提交锁按已核验账户分区，会话失效后拒绝新提交（核心合同）
      : createSubmitLock(deps.accountScope ? { namespace: deps.accountScope.lockNamespace, assertActive: deps.accountScope.assertActive } : {});
  let sending = false;

  // ---- 持久化操作守卫：op:<projectId>:assistant ----
  // 同步文本调用无幂等承诺：结果未明一律锁定，人工确认前绝不静默再发付费请求；
  // 记录独立于项目文档快照，跨窗口/重开同样生效。
  const BLOCK = new Set(['sent', 'unresolved', 'uncertain']);
  const REJECT = new Set([400, 401, 403, 404, 409, 413, 415, 422]);
  const OP_STATE = { saved: '待发送', sent: '已发送待确认', unresolved: '结果未确认', completed: '已完成', rejected: '已拒绝', abandoned: '已放弃' };
  const opKeyOf = pid => `op:${pid}:assistant`;
  const loadOp = async pid => { try { return await storage?.get(opKeyOf(pid)) ?? null; } catch { return null; } };
  const saveOp = async rec => { if (!storage) return false; try { await storage.set(opKeyOf(rec.projectId), rec); return true; } catch { return false; } };
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };

  function open() {
    const usable = chatModelIdsFromCatalog(getModelCatalog()).filter(isModelUsable);
    const unverified = getAvailableModels() == null;
    const status = el('p', { class: 'hint' });
    const replyBox = el('div', { class: 'assistant-reply' });
    const list = el('div', { class: 'assistant-actions' });
    const input = el('textarea', { rows: 4, style: 'width:100%', placeholder: '例如：把这段剧本拆成 6 个镜头并各写一条视频提示词；把场景描述文本连到镜头 1 的提示词口' });
    const modelSel = el('select', {}, usable.length
      ? usable.map(id => el('option', { value: id, text: `${id}${unverified ? '（可用性未验证）' : ''}` }))
      : [el('option', { value: '', text: '（无可用文本型号）' })]);
    const send = el('button', { class: 'primary', type: 'button', text: '生成修改建议' });
    const apply = el('button', { type: 'button', text: '应用变更', disabled: true });
    let planned = [], rawActions = null, planMeta = null;

    // 未确认记录的人工解除：仅在用户确认「未被受理/未扣费」后才允许再次调用
    const guardPanel = rec => {
      const box = el('div', { class: 'modal-actions' });
      const ab = el('button', { type: 'button', text: '人工确认：按未受理处理（解除锁定）' });
      ab.addEventListener('click', async () => {
        const ok = await confirmDialog('解除助手调用保护？', el('p', { text: '仅在你已确认该请求未被受理/未扣费时继续。若实际已受理，再次调用会产生二次扣费。' }));
        if (!ok) return;
        rec.state = 'abandoned'; rec.resolvedAt = Date.now(); rec.note = '人工确认按未受理处理';
        await saveOp(rec);
        status.textContent = '已解除锁定，可重新生成建议';
      });
      box.append(ab);
      return box;
    };

    loadOp(store.project?.id).then(rec => {
      if (rec && BLOCK.has(rec.state)) {
        status.textContent = `存在未确认的助手调用记录（${OP_STATE[rec.state] ?? rec.state}）。为防止重复扣费已锁定，请先人工确认。`;
        list.append(guardPanel(rec));
      }
    });

    send.addEventListener('click', async () => {
      if (sending) return;
      const model = modelSel.value;
      if (!model) { status.textContent = '无可用文本型号——请先在顶栏输入 API Key 并拉取 /v1/models'; return; }
      if (!hasKey()) { status.textContent = '请先输入本站 API Key'; return; }
      const instruction = input.value.trim();
      if (!instruction) { status.textContent = '请先输入修改要求'; return; }
      const project = store.project, fp = getFingerprint();
      const current = () => store.project === project && getFingerprint() === fp;
      sending = true; send.disabled = true; apply.disabled = true; planned = [];
      rawActions = null; planMeta = null;
      status.textContent = '助手思考中……'; replyBox.replaceChildren(); list.replaceChildren();
      try {
        await xlock.request(`xp-assistant:${project.id}`, async () => {
          if (!current()) { status.textContent = '项目或密钥已变更，请求未发送'; return; }
          // 持久化守卫核查：上一笔未确认绝不静默重发（跨窗口/重开同样生效）
          const prev = await loadOp(project.id);
          if (prev && BLOCK.has(prev.state)) {
            status.textContent = `上一次助手调用结果未确认（${prev.model ?? ''}）。已锁定防止重复扣费，请先人工确认。`;
            list.append(guardPanel(prev));
            return;
          }
          const { handles, text } = buildContext(store);
          // 发送前冻结不可变身份：项目对象 + 密钥指纹 + 结构签名 + 句柄→实体 id 映射。
          // 响应返回时画布可能已变——planMeta 以发送前快照为准，应用时整批重验。
          const meta0 = { project, projectId: project.id, keyFp: fp, signature: canvasSignature(project), handles };
          const body = buildChatBody({ model, system: SYSTEM, prompt: `画布现状：\n${text}\n\n用户要求：${instruction}`, maxTokens: 2048 });
          const rec = { id: uid('asst'), kind: 'assistant', state: 'saved', projectId: project.id, keyFp: fp, model, requestSummary: `${model}:${hash(body)}`, createdAt: Date.now(), sentAt: null, error: null };
          if (!await saveOp(rec)) { status.textContent = '本地存储失败，请求未发送'; return; }
          rec.state = 'sent'; rec.sentAt = Date.now();
          if (!await saveOp(rec)) { rec.state = 'saved'; rec.sentAt = null; status.textContent = '本地存储失败，请求未发送'; return; }
          if (!current()) { rec.state = 'saved'; rec.sentAt = null; await saveOp(rec); status.textContent = '项目或密钥已变更，请求未发送'; return; }
          let content;
          try {
            content = chatResponseText(await api.chatCompletion(body));
          } catch (e) {
            if (e instanceof ApiError && REJECT.has(e.status)) {
              rec.state = 'rejected'; rec.error = `${e.status} ${e.code || ''} ${e.message}`.trim(); rec.resolvedAt = Date.now();
              await saveOp(rec);
              status.textContent = `助手请求被拒绝（${e.status}${e.code ? ' ' + e.code : ''}）：${e.message}`;
            } else {
              rec.state = 'unresolved'; rec.error = String(e?.message ?? e ?? '网络错误'); rec.resolvedAt = Date.now();
              await saveOp(rec);
              status.textContent = `助手调用结果未确认（${e?.code || e?.message || '网络错误'}）。请求可能已扣费，已锁定防止重复调用；请人工确认后解除。`;
              list.append(guardPanel(rec));
            }
            return;
          }
          if (!current()) {
            rec.state = 'unresolved'; rec.error = '项目或密钥在请求期间已变更，响应未采用'; rec.resolvedAt = Date.now();
            await saveOp(rec);
            status.textContent = '项目或密钥在请求期间已变更，响应未采用（记录已保留）';
            return;
          }
          rec.state = 'completed'; rec.resolvedAt = Date.now();
          if (!await saveOp(rec)) {
            // 完成记录落不下 ≠ 已完成：回退未确认并保持锁定，绝不谎报成功
            rec.state = 'unresolved'; rec.error = '完成记录落盘失败'; rec.resolvedAt = Date.now();
            await saveOp(rec);
            status.textContent = '助手响应已返回但完成记录落盘失败。请求可能已扣费，已锁定防止重复调用；请人工确认后解除。';
            list.append(guardPanel(rec));
            return;
          }
          const parsed = extractJson(content);
          if (!parsed || typeof parsed !== 'object') {
            replyBox.replaceChildren(el('pre', { class: 'preview-text', text: content }));
            status.textContent = '助手未返回结构化方案，未做任何修改';
            return;
          }
          replyBox.replaceChildren(el('p', { text: s(parsed.reply, 2000) || '（无说明）' }));
          rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
          planned = planActions(rawActions, { store, handles });
          // 方案绑定发送前冻结的不可变快照（项目/密钥/结构签名/句柄映射）
          planMeta = meta0;
          list.replaceChildren(...planned.map(p => el('div', { class: `assistant-action${p.ok ? '' : ' skip'}`, text: p.line })));
          const okCount = planned.filter(p => p.ok).length;
          apply.disabled = !okCount;
          status.textContent = `建议已生成：${okCount} 项可应用${planned.length - okCount ? `，${planned.length - okCount} 项被跳过` : ''}。请检查后点击「应用变更」。`;
        });
      } catch (e) {
        status.textContent = `助手调用失败：${e.message}`;
      } finally { sending = false; send.disabled = false; }
    });

    apply.addEventListener('click', async () => {
      if (!planned.length || !planMeta || !rawActions) return;
      // 项目对象/密钥指纹/结构签名三重校验：任一不符整批作废（旧闭包不得改动别的项目）
      if (planStale(planMeta, store)) {
        status.textContent = '画布、项目或密钥在建议生成后已变化，整批建议已失效，请重新生成';
        planned = []; apply.disabled = true; return;
      }
      const runnable0 = planned.filter(p => p.ok);
      const ok = await confirmDialog('应用助手建议的变更？', el('p', { text: `将执行 ${runnable0.length} 项画布修改（不触发任何生成/计费）。可用撤销恢复。` }));
      if (!ok) return;
      // 异步确认后再验一次：确认期间画布/密钥可能已被修改
      if (planStale(planMeta, store)) {
        status.textContent = '确认期间画布、项目或密钥已变化，已放弃整批应用';
        planned = []; apply.disabled = true; return;
      }
      editor?.checkpoint?.();
      const runnable = planned.filter(p => p.ok);
      try {
        for (const p of runnable) p.run();
      } catch (e) {
        // 回滚只在仍是原项目时才有意义；已切走则绝不碰新项目
        if (store.project === planMeta.project) { try { editor?.undo?.(); } catch { /* 尽力回滚 */ } }
        status.textContent = `应用失败，已整体回滚：${e.message}`;
        planned = []; apply.disabled = true; return;
      }
      store.touch({ type: 'structure' });
      // 先落盘再宣称成功：批量修改没写进存储就不报「已应用」
      try { await store.flush?.(); } catch (e) {
        status.textContent = `已应用 ${runnable.length} 项，但落盘失败（${e.message}）；请检查存储后手动保存`;
        planned = []; rawActions = null; apply.disabled = true; onUpdate?.(); return;
      }
      onUpdate?.();
      status.textContent = `已应用 ${runnable.length} 项`;
      apply.disabled = true; planned = []; rawActions = null;
    });

    modal(el('div', { class: 'assistant' },
      el('h3', { text: '画布助手' }),
      el('div', { class: 'field' }, el('label', { text: '文本型号' }), modelSel),
      input,
      el('div', { class: 'modal-actions' }, send, apply),
      status, replyBox, list,
      el('p', { class: 'hint', text: '助手只能提出结构化修改建议；所有变更经你确认后应用，不会自动执行生成或扣费。' }),
    ), { wide: true });
  }

  return { open };
}
