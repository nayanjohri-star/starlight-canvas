// 导演台原生辅助（父页侧）：机位预设、已保存场景信息、AI 运镜提案（本站文本型号）、能力边界声明、检查器面板。
// 对场景的写操作只经 host.invokeAgent 走插件 agent 契约（scene.edit 的 set_campath，
// DSL 见 bundled plugin agent/references/campath-dsl.md）；不复制插件实现、不直连任何模型。
// 读取走 storage 的 dir:<nodeId>:composition 键（插件自动保存场景的位置）。

import { el, toast, modal } from './ui.js';
import { uid } from './store.js';
import { getFingerprint } from './keyvault.js';

// 机位预设：用 campath DSL 经 scene.edit set_campath 落入场景（含 look at / from / fov / hold）。
// 静态机位 = from + hold；运镜预设 = 段落链。全部为文档化 DSL，插件侧校验失败会原样报错。
export const CAMERA_PRESETS = [
  {
    id: 'front_medium', label: '正面中景', note: '胸前高度 · 平视 · 标准对话机位',
    dsl: 'campath "正面中景"\n  look at 0 1.2 0\n  from 0 1.5 4.2 fov 40\n  hold 4s',
  },
  {
    id: 'front_close', label: '正面特写', note: '面部高度近距 · 情绪特写',
    dsl: 'campath "正面特写"\n  look at 0 1.45 0\n  from 0 1.5 1.8 fov 35\n  hold 4s',
  },
  {
    id: 'three_quarter', label: '三分侧身', note: '45° 侧前 · 双人/对话常用',
    dsl: 'campath "三分侧身"\n  look at 0 1.2 0\n  from 3 1.6 3 fov 45\n  hold 4s',
  },
  {
    id: 'dolly_in', label: '缓推近', note: '4 秒匀速推近 3 米',
    dsl: 'campath "缓推近"\n  look at 0 1.2 0\n  from 0 1.6 6 fov 50\n  dolly in 3 4s\n  hold 0.5s',
  },
  {
    id: 'orbit_half', label: '半环绕', note: '6 秒右绕 180°，环视主体',
    dsl: 'campath "半环绕"\n  look at 0 1.2 0\n  from 0 1.6 5 fov 45\n  orbit right 180 6s\n  hold 0.5s',
  },
  {
    id: 'top_down', label: '俯拍', note: '高位俯视 · 走位/调度示意',
    dsl: 'campath "俯拍"\n  look at 0 0.4 0\n  from 0 5.5 2.5 fov 50\n  hold 4s',
  },
];

// 宿主能力边界：明确标出未接入项，不把宿主 AI/传感器能力伪装成本站能力。
export const DIRECTOR_SUPPORTED = [
  '3D 场景编辑：素体角色 / 道具目录 / GLB·GLTF 模型（素材库托管，重开可恢复）',
  '机位 / 运镜路径 / 时间线关键帧；场景自动保存到当前项目并随导出迁移',
  '导出图片（≤30MiB）与运镜视频（≤100MiB）→ 素材库，可连线给生成/分镜复用',
  '读取场景 / 场景诊断 / 机位预设与 AI 运镜提案（提案文本走本站文本型号）',
];
export const DIRECTOR_UNSUPPORTED = [
  '插件内 AI 生成与积分扣费：依赖外部账号体系，本站未接入（运镜提案改用本站文本型号）',
  '手机虚拟摄像机 vcam 与 mocap 传感器：需要专用本机守护进程，本站不提供',
  '云端素材库 / 模型市场 / 账号同步：无对应服务',
];

const arr = v => (Array.isArray(v) ? v : []);

// composition 摘要：字段全部防御性读取；任何缺失按 0 计，不臆造。
export function summarizeComposition(comp) {
  if (!comp || typeof comp !== 'object' || Array.isArray(comp)) return null;
  const tracks = arr(comp.camTimeline?.tracks ?? comp.timeline?.tracks);
  const clips = tracks.reduce((n, t) => n + arr(t?.clips).length, 0);
  const counts = {
    characters: arr(comp.characters).length,
    props: arr(comp.props).length,
    models: arr(comp.models).length + arr(comp.codeModels).length,
    cameras: arr(comp.cameras).length,
    camPaths: arr(comp.camPaths).length,
    motions: arr(comp.customMotions).length,
    groups: arr(comp.groups).length,
    clips,
  };
  const labelOf = x => String(x?.label ?? x?.name ?? x?.id ?? '').slice(0, 40);
  return {
    counts,
    cameras: arr(comp.cameras).map(labelOf).filter(Boolean),
    camPaths: arr(comp.camPaths).map(labelOf).filter(Boolean),
    durationMs: Number.isFinite(comp.camTimeline?.durationMs) ? comp.camTimeline.durationMs : null,
    summaryText: `角色${counts.characters} · 道具${counts.props} · 模型${counts.models} · 机位${counts.cameras} · 运镜${counts.camPaths} · 时间线${counts.clips}段`,
  };
}

// 落盘真实格式（插件 P0/I0 契约）：{schemaVersion, savedAt, composition:{...}} 对象。
// 兼容旧文档：直接存 composition 对象或整份 JSON 字符串；坏记录返回 null，不臆造。
export function unwrapComposition(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.composition && typeof v.composition === 'object' && !Array.isArray(v.composition))
    return { comp: v.composition, savedAt: Number.isFinite(v.savedAt) ? v.savedAt : null, schemaVersion: Number.isFinite(v.schemaVersion) ? v.schemaVersion : null, wrapped: true };
  // 包裹外壳但内容缺失/损坏（无任何场景字段）→ 视为无有效存档，不虚报已保存
  if (('schemaVersion' in v || 'savedAt' in v) &&
      !['characters', 'cameras', 'camPaths', 'camTimeline', 'timeline', 'props', 'models', 'codeModels', 'groups', 'environment'].some(k => k in v))
    return null;
  return { comp: v, savedAt: null, schemaVersion: null, wrapped: false };
}

export async function readSceneInfo(storage, nodeId) {
  const raw = await storage.get(`dir:${nodeId}:composition`);
  const u = unwrapComposition(raw);
  const info = u && summarizeComposition(u.comp);
  if (!info) return { saved: false, summaryText: '', counts: null, cameras: [], camPaths: [], raw: null };
  return { saved: true, raw: u.comp, savedAt: u.savedAt, schemaVersion: u.schemaVersion, wrapped: u.wrapped, ...info };
}

// ---- campath DSL 严格校验（与插件 campath-dsl.md 语法一致；AI 提案与机位预设共用）----
// 任何一行不匹配已知语法即整体拒绝——模型输出绝不求值、绝不进场景。
const DSL_MAX_CHARS = 4000, DSL_MAX_LINES = 60;
const NUM = '-?\\d+(?:\\.\\d+)?';
const DUR = '\\d+(?:\\.\\d+)?';
// FOV 只占 1 个捕获组——各指令的 fov 组号：from=4 move=5 dolly/truck/crane=4 orbit=6 hold=2
const FOV = `(?:\\s+fov\\s+(${NUM}))?`;
const LINE = {
  header: /^campath\s+"([^"\r\n]{1,60})"$/,
  lookAt: new RegExp(`^look\\s+at\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})$`),
  lookTarget: /^look\s+target\s+"[^"\r\n]{1,64}"$/,
  lookAhead: /^look\s+ahead$/,
  easing: /^easing\s+(?:linear|easeIn|easeOut|easeInOut|smoothstep)$/,
  loop: /^loop(?:\s+pingpong)?$/,
  from: new RegExp(`^from\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})${FOV}$`),
  move: new RegExp(`^move\\s+to\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${DUR})s${FOV}$`),
  dolly: new RegExp(`^dolly\\s+(in|out)\\s+(${NUM})\\s+(${DUR})s${FOV}$`),
  truck: new RegExp(`^truck\\s+(left|right)\\s+(${NUM})\\s+(${DUR})s${FOV}$`),
  crane: new RegExp(`^crane\\s+(up|down)\\s+(${NUM})\\s+(${DUR})s${FOV}$`),
  orbit: new RegExp(`^orbit\\s+(left|right)\\s+(${NUM})\\s+(${DUR})s(?:\\s+rise\\s+(${NUM}))?(?:\\s+radius\\s+(${NUM}))?${FOV}$`),
  hold: new RegExp(`^hold\\s+(${DUR})s${FOV}$`),
};
const bounded = (v, max) => Number.isFinite(v) && Math.abs(v) <= max;
const fovOk = v => v == null || (v >= 10 && v <= 120);

export function parseCamPathDsl(source) {
  const text = String(source ?? '').trim();
  if (!text) throw new Error('DSL 为空');
  if (text.length > DSL_MAX_CHARS) throw new Error(`DSL 超过 ${DSL_MAX_CHARS} 字符上限`);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > DSL_MAX_LINES) throw new Error(`DSL 超过 ${DSL_MAX_LINES} 行上限`);
  const bad = (i, msg) => new Error(`DSL 第${i + 1}行：${msg}`);
  const head = lines[0].match(LINE.header);
  if (!head) throw bad(0, '缺少 campath "名称" 头部');
  const name = head[1].trim();
  if (!name) throw bad(0, '运镜名称不能为空');
  let look = null, sawFrom = false, duration = 0, segments = 0;
  const seg = (i, kind, dur, fov) => {
    const d = Number(dur);
    if (!(d > 0)) throw bad(i, '时长必须为正数');
    if (d > 120) throw bad(i, '单段时长超过 120s');
    if (fov != null && !fovOk(Number(fov))) throw bad(i, 'fov 须在 10–120');
    if (look === 'ahead' && !['move', 'crane', 'hold'].includes(kind))
      throw bad(i, 'look ahead 模式只允许 move/crane/hold 段落');
    duration += d; segments++;
  };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!sawFrom) {
      if ((m = l.match(LINE.lookAt))) {
        if (look) throw bad(i, '重复的 look 指令');
        if (!m.slice(1, 4).map(Number).every(v => bounded(v, 1000))) throw bad(i, 'look at 坐标超出 ±1000m 范围');
        look = 'at'; continue;
      }
      if (LINE.lookTarget.test(l)) { if (look) throw bad(i, '重复的 look 指令'); look = 'target'; continue; }
      if (LINE.lookAhead.test(l)) { if (look) throw bad(i, '重复的 look 指令'); look = 'ahead'; continue; }
      if (LINE.easing.test(l) || LINE.loop.test(l)) continue;
      if ((m = l.match(LINE.from))) {
        if (!m.slice(1, 4).map(Number).every(v => bounded(v, 1000))) throw bad(i, 'from 起点坐标超出 ±1000m 范围');
        if (!fovOk(m[4] != null ? Number(m[4]) : null)) throw bad(i, 'fov 须在 10–120');
        sawFrom = true; continue;
      }
      throw bad(i, `无法识别的指令「${l.slice(0, 40)}」（from 之前仅允许 look/easing/loop）`);
    }
    if ((m = l.match(LINE.move))) {
      if (!m.slice(1, 4).map(Number).every(v => bounded(v, 1000))) throw bad(i, 'move 目标坐标超出 ±1000m 范围');
      seg(i, 'move', m[4], m[5]); continue;
    }
    if ((m = l.match(LINE.dolly)) || (m = l.match(LINE.truck)) || (m = l.match(LINE.crane))) {
      if (!bounded(Number(m[2]), 200)) throw bad(i, '位移距离超出 ±200m 范围');
      seg(i, l.split(/\s+/)[0], m[3], m[4]); continue;
    }
    if ((m = l.match(LINE.orbit))) {
      if (!bounded(Number(m[2]), 1440)) throw bad(i, 'orbit 角度超出 ±1440° 范围');
      if (m[4] != null && !bounded(Number(m[4]), 200)) throw bad(i, 'rise 超出 ±200m 范围');
      if (m[5] != null && !bounded(Number(m[5]), 200)) throw bad(i, 'radius 超出 ±200m 范围');
      seg(i, 'orbit', m[3], m[6]); continue;
    }
    if ((m = l.match(LINE.hold))) { seg(i, 'hold', m[1], m[2]); continue; }
    throw bad(i, `无法识别的运镜段落「${l.slice(0, 40)}」`);
  }
  if (!look) throw new Error('DSL 缺少 look 指令');
  if (!sawFrom) throw new Error('DSL 缺少 from 起点');
  if (!segments) throw new Error('DSL 至少需要一个运镜段落');
  if (duration < 0.5 || duration > 120) throw new Error(`DSL 总时长 ${Math.round(duration * 100) / 100}s 须在 0.5–120s`);
  return { dsl: lines.join('\n'), name, durationSec: Math.round(duration * 1000) / 1000, segments };
}

// 从模型输出中提取第一条 campath 代码块：头部之后收集到空行/围栏/下一条 campath 为止，
// 收集到的每一行都必须过严格语法——夹杂私货即整体拒绝。
export function extractCamPathDsl(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*campath\s+"/.test(l));
  if (start < 0) throw new Error('输出中未找到 campath DSL');
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*```/.test(l) || /^\s*campath\s/i.test(l)) break;
    block.push(l);
  }
  return parseCamPathDsl(block.join('\n'));
}

// 提案节点的系统指令：要求模型只输出 DSL 本身；用户意图走 text 字段
export function buildCamPathPrompt(userText) {
  const system = [
    '你是 3D 导演台的运镜编排器。只输出一条 campath DSL，不要输出解释、标题或多余文字；可将 DSL 放在 ``` 代码块中。',
    '语法：',
    'campath "名称"',
    '  look at x y z            （或 look target "对象id" / look ahead，三者选一）',
    '  easing easeInOut          （可选：linear|easeIn|easeOut|easeInOut|smoothstep）',
    '  loop pingpong             （可选）',
    '  from x y z fov 45         （必需，fov 10–120）',
    '  dolly in 2 4s             （段落可连续多行：move to x y z Ns / dolly in|out M Ns / truck left|right M Ns / crane up|down M Ns / orbit left|right 度数 Ns [rise M] [radius M] / hold Ns；段落均可追加 fov N）',
    '约束：坐标单位米；总时长 0.5–120 秒。',
  ].join('\n');
  return { system, text: `运镜需求：${userText}` };
}

export function createDirectorControls({ store, storage, host, generators } = {}) {
  let gen = generators ?? null;   // 站点生成能力（也可后经 configure 注入）；AI 提案只经它走文本型号
  const proposals = new Map();    // nodeId → 最近提案（正文另存画布文本节点，可追踪/重试）

  function configure({ generators: g } = {}) {
    if (g && typeof g.generate === 'function') gen = g;
    return controls;
  }

  // 机位预设写入：scene.edit 原子批，单操作失败 = 零写入；插件返回的明细原样上抛。
  async function applyCameraPreset(nodeId, presetId) {
    const p = CAMERA_PRESETS.find(x => x.id === presetId);
    if (!p) throw new Error('未知机位预设');
    const parsed = parseCamPathDsl(p.dsl);   // 预设均为已知合法 DSL；与 AI 提案过同一严格语法闸
    const res = await host.invokeAgent(nodeId, {
      method: 'scene.edit',
      args: { description: `添加机位预设「${p.label}」`, operations: [{ type: 'set_campath', dsl: parsed.dsl }] },
    });
    if (res && res.ok === false) {
      const detail = res.results?.[0]?.detail ?? res.summary ?? '插件拒绝了该机位操作';
      throw new Error(detail);
    }
    return res;
  }

  // AI 运镜提案：显式调用才产生一次本站文本生成（经 generators.generate，含持久化操作守卫，
  // 绝不直发请求）；模型输出经严格 DSL 解析，坏输出直接拒绝——提案阶段对场景零写入。
  async function proposeCamPath(nodeId, { prompt, model } = {}) {
    const node = store.node(nodeId);
    if (!node || node.type !== 'director') throw new Error('导演台节点不存在');
    const project = store.project, keyFp = getFingerprint();
    const assertCurrent = () => { if (store.project !== project || store.node(nodeId) !== node || getFingerprint() !== keyFp) throw new Error('项目、密钥或导演台节点已变更，已停止生成运镜提案'); };
    const intent = String(prompt ?? '').trim();
    if (!intent) throw new Error('请先描述想要的运镜效果');
    if (intent.length > 2000) throw new Error('运镜描述过长（≤2000 字）');
    if (!gen?.generate) throw new Error('文本生成能力未接入');
    const usable = (gen.textModels?.() ?? []).filter(m => m && m.id && m.usable !== false);
    const picked = model ?? usable[0]?.id;
    if (!picked || !usable.some(m => m.id === picked))
      throw new Error(usable.length ? '所选文本型号当前不可用' : '当前密钥下无可用文本型号');
    // 提案基线：当前场景 revision（导演台未打开时记 null，应用时仍会现场校验）
    let revision = null;
    try {
      const scene = await host.invokeAgent(nodeId, { method: 'scene.get', args: {} });
      if (Number.isFinite(scene?.revision)) revision = scene.revision;
    } catch { revision = null; }
    assertCurrent();
    if (revision == null) throw new Error('请先打开导演台并等待场景就绪，再生成运镜提案');
    // 提案正文持久在画布文本节点：可复查、可人工确认/重试；generate 内部有操作守卫
    let draftNode = node.data.aiDraftNodeId ? store.node(node.data.aiDraftNodeId) : null;
    if (!draftNode || draftNode.type !== 'text') {
      draftNode = store.addNode('text', (node.x ?? 0) + 300, (node.y ?? 0) + 200, { title: '运镜提案', text: '' });
      node.data.aiDraftNodeId = draftNode.id;
    }
    const brief = buildCamPathPrompt(intent);
    draftNode.data.model = picked;
    draftNode.data.system = brief.system;
    draftNode.data.text = brief.text;
    draftNode.data.title = `运镜提案 · ${picked}`;
    store.touch({ type: 'data', id: node.id });
    const out = await gen.generate(draftNode);   // 失败（含「结果未确认」）原样上抛，提案节点保留现场
    assertCurrent();
    const sourceText = String(draftNode.data.resultText ?? out?.text ?? '');
    const parsed = extractCamPathDsl(sourceText);   // 坏模型输出在此被拒绝：不评估、不写场景
    const proposal = {
      id: uid('cp'), nodeId, projectId: project.id, revision,
      dsl: parsed.dsl, name: parsed.name, durationSec: parsed.durationSec,
      prompt: intent, model: picked, draftNodeId: draftNode.id, createdAt: Date.now(),
    };
    proposals.set(nodeId, proposal);
    node.data.aiProposal = {
      id: proposal.id, name: proposal.name, dsl: proposal.dsl, durationSec: proposal.durationSec,
      revision, projectId: proposal.projectId, model: picked, draftNodeId: draftNode.id, createdAt: proposal.createdAt,
    };
    store.touch({ type: 'data', id: node.id });
    await store.flush();
    assertCurrent();
    return proposal;
  }

  // 应用提案：同项目 + 场景 revision 未漂移 → validateOnly 校验 → 应用 → scene.get 复核。
  // 任一前置不满足即在发起场景写之前拒绝；插件侧失败明细原样上抛。
  async function applyCamPathProposal(nodeId, proposal) {
    proposal ??= proposals.get(nodeId) ?? null;
    if (!proposal || proposal.nodeId !== nodeId) throw new Error('没有可应用的运镜提案');
    if (!store.project || store.project.id !== proposal.projectId)
      throw new Error('项目已切换，该提案已失效，请重新生成');
    const node = store.node(nodeId);
    if (!node || node.type !== 'director') throw new Error('导演台节点已删除');
    const parsed = parseCamPathDsl(proposal.dsl);   // 应用前重新严格校验：坏 DSL 零场景写、零 RPC
    const before = await host.invokeAgent(nodeId, { method: 'scene.get', args: {} });
    if (proposal.revision != null && Number.isFinite(before?.revision) && before.revision !== proposal.revision)
      throw new Error(`场景已在别处修改（revision ${proposal.revision} → ${before.revision}），请重新生成提案`);
    const check = await host.invokeAgent(nodeId, {
      method: 'scene.edit',
      args: { description: `校验运镜「${parsed.name}」`, validateOnly: true, operations: [{ type: 'set_campath', dsl: parsed.dsl }] },
    });
    if (!check || check.ok === false)
      throw new Error(check?.results?.[0]?.detail ?? check?.summary ?? '插件校验未通过');
    const mid = await host.invokeAgent(nodeId, { method: 'scene.get', args: {} });
    if (Number.isFinite(before?.revision) && Number.isFinite(mid?.revision) && mid.revision !== before.revision)
      throw new Error('校验期间场景被修改，已中止应用');
    const res = await host.invokeAgent(nodeId, {
      method: 'scene.edit',
      args: { description: `应用运镜「${parsed.name}」`, operations: [{ type: 'set_campath', dsl: parsed.dsl }] },
    });
    if (!res || res.ok === false)
      throw new Error(res?.results?.[0]?.detail ?? res?.summary ?? '插件拒绝了该运镜');
    const after = await host.invokeAgent(nodeId, { method: 'scene.get', args: {} }).catch(() => null);
    if (after && Array.isArray(after.camPaths)) {
      const ids = new Set(res.affectedIds ?? []);
      if (!after.camPaths.some(p => ids.has(p.id) || (p.label ?? p.name) === parsed.name))
        throw new Error('应用后复核未在场景中找到该运镜路径');
    }
    proposal.revision = Number.isFinite(after?.revision) ? after.revision : res.revision ?? proposal.revision;
    proposal.appliedAt = Date.now();
    return { result: res, revision: proposal.revision };
  }

  async function showJson(title, promise) {
    try {
      const res = await promise;
      modal(el('div', {}, el('h3', { text: title }), el('pre', { style: 'max-height:50vh;overflow:auto;font-size:11px', text: JSON.stringify(res, null, 2) })));
      return res;
    } catch (e) {
      toast(`${title}失败：${e.message}`, 'err');
      return null;
    }
  }

  function inspector(node) {
    const box = el('div', {});
    const infoEl = el('p', { class: 'hint', text: '读取已保存场景…' });
    readSceneInfo(storage, node.id)
      .then(i => { infoEl.textContent = i.saved ? `已保存场景：${i.summaryText}` : '尚无已保存场景（打开导演台编辑后自动保存）'; })
      .catch(() => { infoEl.textContent = '场景信息读取失败（不影响编辑）'; });

    const open = el('button', { class: 'primary', type: 'button', text: host.isOpen?.(node.id) ? '导演台编辑中' : '打开导演台' });
    open.addEventListener('click', () => host.openEditor(node));

    const sceneBtn = el('button', { type: 'button', text: '读取场景' });
    sceneBtn.addEventListener('click', () => showJson('scene.get', host.invokeAgent(node.id, { method: 'scene.get', args: {} })));
    const diagBtn = el('button', { type: 'button', text: '场景诊断' });
    diagBtn.addEventListener('click', () => showJson('scene.diagnostics', host.invokeAgent(node.id, { method: 'scene.diagnostics', args: {} })));

    // 机位预设：仅导演台打开时可用（写操作要走活的插件会话）
    const sel = el('select', {}, ...CAMERA_PRESETS.map(p => el('option', { value: p.id, text: `${p.label} — ${p.note}` })));
    const apply = el('button', { type: 'button', text: '添加该机位到场景' });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const res = await applyCameraPreset(node.id, sel.value);
        toast(res ? `已添加机位预设（revision ${res.revision ?? '?'}）` : '机位预设未生效', res ? 'ok' : 'warn');
      } catch (e) { toast(`机位预设失败：${e.message}`, 'err', 6000); }
      finally { apply.disabled = false; }
    });

    // AI 运镜提案区：显式点击才产生文本生成调用；打开检查器/挂载绝不自动发请求
    const aiModels = () => (gen?.textModels?.() ?? []).filter(m => m && m.id);
    const aiUsable = () => aiModels().filter(m => m.usable !== false);
    const aiSel = el('select', {}, ...aiModels().map(m =>
      el('option', { value: m.id, text: `${m.name ?? m.id}${m.usable === false ? '（当前密钥不可用）' : ''}`, disabled: m.usable === false })));
    const aiInput = el('textarea', { rows: 2, placeholder: '例：从正面缓慢推近到角色特写，约 4 秒' });
    const aiPreview = el('pre', { class: 'preview-text', style: 'display:none;white-space:pre-wrap' });
    const aiStatus = el('p', { class: 'hint' });
    const aiGen = el('button', { type: 'button', text: '生成运镜提案' });
    const aiApply = el('button', { class: 'primary', type: 'button', text: '校验并应用到场景', disabled: true });
    let aiCurrent = proposals.get(node.id) ?? null;
    const aiShow = p => {
      aiCurrent = p;
      aiPreview.style.display = '';
      aiPreview.textContent = `「${p.name}」 约 ${p.durationSec}s\n${p.dsl}`;
      aiApply.disabled = false;
    };
    if (aiCurrent) aiShow(aiCurrent);
    if (!gen) aiStatus.textContent = '未接入文本生成能力，暂不可用';
    else if (!aiUsable().length) aiStatus.textContent = '当前密钥下暂无可用文本型号（顶栏输入 API Key 后自动拉取）';
    aiGen.disabled = !gen || !aiUsable().length;
    aiGen.addEventListener('click', async () => {
      aiGen.disabled = true;
      try {
        const p = await proposeCamPath(node.id, { prompt: aiInput.value, model: aiSel.value || undefined });
        aiShow(p);
        aiStatus.textContent = '提案已生成，正文保留在画布「运镜提案」文本节点中；确认无误后再写入场景';
        toast('运镜提案已生成', 'ok');
      } catch (e) {
        aiStatus.textContent = `生成失败：${e.message}`;
        toast(`运镜提案失败：${e.message}`, 'err', 6000);
      } finally { aiGen.disabled = !gen || !aiUsable().length; }
    });
    aiApply.addEventListener('click', async () => {
      if (!aiCurrent) return;
      aiApply.disabled = true;
      try {
        const r = await applyCamPathProposal(node.id, aiCurrent);
        aiStatus.textContent = `已写入场景（revision ${r.revision ?? '?'}）`;
        toast('运镜已应用到场景', 'ok');
        readSceneInfo(storage, node.id)
          .then(i => { if (i.saved) infoEl.textContent = `已保存场景：${i.summaryText}`; })
          .catch(() => { /* 摘要失败无碍 */ });
      } catch (e) {
        aiStatus.textContent = `应用失败：${e.message}`;
        toast(`应用运镜失败：${e.message}`, 'err', 6000);
        aiApply.disabled = false;
      }
    });
    const aiBox = el('div', {},
      el('p', { class: 'hint', text: '用自然语言描述运镜，经所选本站文本型号生成提案（消耗该型号文本额度）；校验通过后才会写入场景。' }),
      el('div', { class: 'field' }, el('label', { text: '文本型号' }), aiSel),
      aiInput,
      el('div', { class: 'modal-actions' }, aiGen, aiApply),
      aiPreview,
      aiStatus);

    const detail = el('details', {},
      el('summary', { text: '能力说明' }),
      el('p', { class: 'hint', text: '已接入：' + DIRECTOR_SUPPORTED.join('；') }),
      el('p', { class: 'hint', text: '暂不支持：' + DIRECTOR_UNSUPPORTED.join('；') }));

    box.append(
      el('p', { class: 'hint', text: '场景自动保存到当前项目，导出后可用于生成和剪辑。' }),
      infoEl,
      el('div', { class: 'modal-actions' }, open, sceneBtn, diagBtn),
      el('h3', { text: '机位预设' }),
      sel, apply,
      el('h3', { text: 'AI 运镜提案' }),
      aiBox,
      detail,
    );
    return box;
  }

  const controls = {
    inspector,
    applyCameraPreset,
    configure,
    proposeCamPath,
    applyCamPathProposal,
    getProposal: nodeId => proposals.get(nodeId) ?? null,
    readSceneInfo: nodeId => readSceneInfo(storage, nodeId),
    sceneSummary: summarizeComposition,
    presets: CAMERA_PRESETS,
  };
  return controls;
}
