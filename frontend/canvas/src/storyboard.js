// 分镜表（LibTV 风格）：project.studio.shots 为唯一权威数据。
// 行/网格编辑 12 字段、脚本/严格 JSON 导入、AI 拆分经 generators 文本节点
//（非本地伪 AI）、2/4/9/12/25 镜头网格、每镜独立图片/视频生成节点、
// 视频型号按能力表×密钥可用目录真实选型（videoModels 助手缺席时回退能力表，
// 未拉取 /v1/models 记为可用性未验证而非不可用），单图锚点按 family 接真实端口：
// H3→frames 首帧、SD→refs 素材参考（首尾帧需两张）、Wan→refs i2v 单图；
// 版本历史、排序、CSV 导出、素材按角色分类共享并可一键连线、批量走
// workflow.preview/start（显式确认）。行↔节点提示词用显式双向同步 + 分歧标记，
// 不做隐式互写，避免两个事实源发散。

import { el, modal, toast, confirmDialog, fmtBytes } from './ui.js';
import { SHOT_FIELDS, studioState, clone } from './studio-schema.js';
import { uid } from './store.js';
import { ASSET_CATEGORIES, KIND_LABEL } from './assets.js';
import { getModel, modelIds, modeForIntent, nodeOutputIds } from './capabilities.js';
import { isModelUsable } from './keyvault.js';
import { prepareImportFiles } from './script-import.js';
import { openAssetReuse } from './asset-reuse.js';

export const SHOT_FIELD_LABEL = Object.fromEntries(SHOT_FIELDS);
export const GRID_COUNTS = [2, 4, 9, 12, 25];
const MAX_SHOTS = 200;
const MAX_VERSIONS = 30;
const SHOT_SIZE_OPTS = ['', '远景', '全景', '中景', '近景', '特写'];
const CAMERA_OPTS = ['', '固定', '推', '拉', '摇', '移', '跟', '升降', '手持'];
const LIGHT_OPTS = ['', '自然光', '顺光', '逆光', '侧光', '顶光', '夜景', '霓虹'];
const SELECT_OPTS = { shotSize: SHOT_SIZE_OPTS, camera: CAMERA_OPTS, lighting: LIGHT_OPTS };
const AREA_FIELDS = new Set(['description', 'dialogue', 'sound', 'characters', 'imagePrompt', 'videoPrompt']);
// 编辑弹窗 12 字段分区：仅视觉分组，数据键与保存逻辑不变；未映射键自动归入「其他」
const FIELD_GROUPS = [
  ['基本信息', ['title', 'duration']],
  ['画面', ['description', 'characters', 'emotion', 'imagePrompt']],
  ['镜头', ['shotSize', 'camera', 'lighting', 'videoPrompt']],
  ['声音', ['dialogue', 'sound']],
];
const DEFAULT_VIDEO_MODEL = 'minimax-h3-768p-per-second';
const IMAGE_NODE_MAX_REFS = 1;   // 本站 image2.5 编辑接口仅支持一张参考图

// 单图锚点 → 各 family 的真实单图模式与连线端口（纯函数，可测）：
// H3 首帧模式接 frames 口；SD 首尾帧必须恰好两张 → 单图只能走 refs 素材参考；
// Wan 不支持首尾帧 → i2v 单图接 refs 口。未知 family 按能力声明探测 frames→i2v→refs。
export function singleImagePlan(modelId) {
  const m = getModel(modelId);
  if (!m) return null;
  if (m.family === 'h3') return modeForIntent(modelId, 'frames') ? { intent: 'frames', port: 'frames' } : { intent: 'refs', port: 'refs' };
  if (m.family === 'wan') return { intent: 'i2v', port: 'refs' };
  if (m.family === 'sd25') return { intent: 'refs', port: 'refs' };
  if (modeForIntent(modelId, 'frames')) return { intent: 'frames', port: 'frames' };
  if (modeForIntent(modelId, 'i2v')) return { intent: 'i2v', port: 'refs' };
  if (modeForIntent(modelId, 'refs')) return { intent: 'refs', port: 'refs' };
  return null;
}

// 剧本编号行：第3镜/第2场/镜头5/镜5/3./3、/3:/3-/3)
// 编号标点右侧不得紧跟数字：「3.5秒」「3-4秒」是小数时长/区间而非标号（防幻影切分+错读时长）
const MARK_RE = /^(?:\s*第\s*\d{1,3}\s*[镜场幕号]|\s*镜头?\s*\d{1,3}|\s*\d{1,3}\s*[、.．:：\-)](?!\d))/;
// 时长匹配：≤3 位数字（可带小数）+「秒」或英文 s。
// 中文「秒」没有 ASCII 词边界——右侧允许空白/标点/行尾/后续中文；
// 英文 s 右侧不得紧跟词字符（防 8shot 误中）；数字左侧不得为词字符或「.」
//（防镜头编号残留、f1.8s 光圈值、长串数字被截断误读为时长）。
const DURATION_RE = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s*(?:秒|s(?![\w]))/i;

// 12 字段 → CSV（转义可被 parseCSV 回读）。纯函数，可测。
export function shotsToCSV(list) {
  const esc = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const lines = [SHOT_FIELDS.map(([, l]) => esc(l)).join(',')];
  for (const s of list) lines.push(SHOT_FIELDS.map(([k]) => esc(s[k])).join(','));
  return lines.join('\r\n');
}

// ---------- 脚本解析（模块级纯函数：粘贴导入与文件导入共用） ----------
const MAX_FIELD_CHARS = 20000;
// 分镜时长合同：1–30 整数秒。非法/超范围/小数时长绝不静默取整或夹逼——
// 解析与导入保留原值并打 durationInvalid/durationRaw 标记，由用户在分镜表修正；
// 建视频节点/提交校验对非法值显式报错。
export const SHOT_DURATION_MIN = 1, SHOT_DURATION_MAX = 30;
export const isValidShotDuration = v => Number.isInteger(v) && v >= SHOT_DURATION_MIN && v <= SHOT_DURATION_MAX;
// 标记/清除时长非法标记；raw 为来源原文（如 '3.5秒' / 45 / 导入文档原值）
const flagDuration = (s, raw) => {
  if (isValidShotDuration(s.duration)) { delete s.durationInvalid; delete s.durationRaw; }
  else { s.durationInvalid = true; s.durationRaw = raw ?? s.duration; }
};
const blank = () => Object.fromEntries(SHOT_FIELDS.map(([k]) => [k, k === 'duration' ? 5 : '']));

export function parseScriptJSON(t) {
  let doc; try { doc = JSON.parse(t); } catch (e) { throw new Error(`JSON 解析失败：${e.message}`); }
  const arr = Array.isArray(doc) ? doc : doc?.shots;
  if (!Array.isArray(arr) || !arr.length) throw new Error('JSON 需为分镜数组或含 shots 数组');
  if (arr.length > MAX_SHOTS) throw new Error(`分镜数量超限（≤${MAX_SHOTS}）`);
  const allowed = new Set(SHOT_FIELDS.map(([k]) => k));
  return arr.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error(`第 ${i + 1} 个分镜不是对象`);
    const f = blank();
    for (const [k, v] of Object.entries(s)) {
      if (!allowed.has(k)) throw new Error(`第 ${i + 1} 个分镜含未知字段：${k}`);
      if (k === 'duration') {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`第 ${i + 1} 个分镜 duration 须为数字`);
        f.duration = v;   // 保留原值；非法值由 flagDuration 标记，不取整不夹逼
      } else {
        if (typeof v !== 'string') throw new Error(`第 ${i + 1} 个分镜 ${k} 须为字符串`);
        if (v.length > MAX_FIELD_CHARS) throw new Error(`第 ${i + 1} 个分镜 ${k} 超长`);
        f[k] = v;
      }
    }
    if (!f.title) f.title = `镜头 ${i + 1}`;
    flagDuration(f, f.duration);
    return f;
  });
}
// 文件与粘贴导入均对超长单段整批拒绝，不做静默截断。
// 编号行之前的导语段保留为首个分镜——原文不静默丢弃。
export function parseScriptText(t) {
  const lines = t.split(/\r?\n/);
  const marks = [];
  lines.forEach((l, i) => { if (MARK_RE.test(l)) marks.push(i); });
  let chunks;
  if (marks.length >= 2) {
    chunks = [];
    const preamble = lines.slice(0, marks[0]).join('\n').trim();
    if (preamble) chunks.push(preamble);
    for (let k = 0; k < marks.length; k++) {
      const seg = lines.slice(marks[k], k + 1 < marks.length ? marks[k + 1] : lines.length).join('\n').trim();
      if (seg) chunks.push(seg.replace(MARK_RE, '').trim() || seg);
    }
  } else {
    chunks = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  }
  if (!chunks.length) chunks = [t];
  if (chunks.length > MAX_SHOTS) throw new Error(`分镜数量超限（≤${MAX_SHOTS}）`);
  return chunks.map((c, i) => {
    if (c.length > MAX_FIELD_CHARS)
      throw new Error(`第 ${i + 1} 段超过 ${MAX_FIELD_CHARS} 字符上限，整批未导入`);
    const f = blank();
    f.title = `镜头 ${i + 1}`;
    f.description = c;
    const m = c.match(DURATION_RE);
    if (m) { f.duration = Number(m[1]); flagDuration(f, m[0].trim()); }
    return f;
  });
}
export function parseScript(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('脚本内容为空');
  return t.startsWith('{') || t.startsWith('[') ? parseScriptJSON(t) : parseScriptText(t);
}

export function createStoryboards(deps) {
  const { store } = deps;
  const shots = () => studioState(store.project).shots;
  const script = () => { const st = studioState(store.project); if (typeof st.script === 'string') st.script = { text: st.script, updatedAt: 0 }; return st.script ??= { text: '', updatedAt: 0 }; };
  const find = id => shots().find(s => s.id === id) ?? null;

  // ---------- 数据层 ----------
  function pushVersion(s) {
    const snap = {};
    for (const [k] of SHOT_FIELDS) snap[k] = s[k];
    const last = s.versions?.[s.versions.length - 1];
    if (last && SHOT_FIELDS.every(([k]) => last.fields[k] === snap[k])) return;
    (s.versions ??= []).push({ at: Date.now(), fields: snap });
    if (s.versions.length > MAX_VERSIONS) s.versions.shift();
  }
  // 时长写入：合法 → 存入并清标记；非法且未显式带 durationInvalid 标记 → 拒绝（不静默改写）；
  // 显式带标记（导入/恢复路径）→ 保留原值与 durationRaw，交由用户修正。
  const writeDuration = (s, value, fields) => {
    if (isValidShotDuration(value)) { s.duration = value; delete s.durationInvalid; delete s.durationRaw; return; }
    if (fields?.durationInvalid !== true)
      throw new Error(`分镜时长须为 ${SHOT_DURATION_MIN}–${SHOT_DURATION_MAX} 的整数秒（收到 ${value}），未写入`);
    s.duration = value; s.durationInvalid = true;
    s.durationRaw = fields.durationRaw !== undefined ? fields.durationRaw : value;
  };
  function addShot(fields = {}) {
    if (shots().length >= MAX_SHOTS) throw new Error(`分镜数量超限（≤${MAX_SHOTS}）`);
    const s = { id: uid('s'), ...blank(), assetIds: [], imageNodeId: null, nodeId: null, createdAt: Date.now(), updatedAt: Date.now(), versions: [] };
    for (const [k] of SHOT_FIELDS) if (fields[k] !== undefined) {
      if (k === 'duration') writeDuration(s, fields[k], fields);
      else s[k] = String(fields[k]).slice(0, 20000);
    }
    shots().push(s); store.touch({ type: 'data' }); return s;
  }
  function updateShot(id, patch = {}) {
    const s = find(id); if (!s) return null;
    if (patch.duration !== undefined && patch.duration !== s.duration
      && !isValidShotDuration(patch.duration) && patch.durationInvalid !== true)
      throw new Error(`分镜时长须为 ${SHOT_DURATION_MIN}–${SHOT_DURATION_MAX} 的整数秒（收到 ${patch.duration}），未写入`);
    pushVersion(s);
    for (const [k] of SHOT_FIELDS) if (patch[k] !== undefined) {
      if (k === 'duration') { if (patch[k] !== s.duration) writeDuration(s, patch[k], patch); }
      else s[k] = String(patch[k]).slice(0, 20000);
    }
    // assetIds 保留 null 缺失槽位：空槽是显式失效引用，不因 update/filter 缩减用户参考
    if (Array.isArray(patch.assetIds)) {
      const seen = new Set(), next = [];
      for (const x of patch.assetIds) {
        if (typeof x === 'string' && x) { if (!seen.has(x)) { seen.add(x); next.push(x); } }
        else next.push(null);
      }
      s.assetIds = next.slice(0, 50);
    }
    s.updatedAt = Date.now(); store.touch({ type: 'data' }); return s;
  }
  function moveShot(id, dir) {
    const a = shots(); const i = a.findIndex(s => s.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return false;
    [a[i], a[j]] = [a[j], a[i]]; store.touch({ type: 'data' }); return true;
  }
  function reorderShot(id, toIndex) {
    const a = shots(); const i = a.findIndex(s => s.id === id);
    const j = Math.max(0, Math.min(a.length - 1, Math.trunc(Number(toIndex))));
    if (i < 0 || i === j || !Number.isFinite(j)) return false;
    a.splice(j, 0, a.splice(i, 1)[0]); store.touch({ type: 'data' }); return true;
  }
  function removeShot(id) {   // 只解除关联，不删画布节点
    const a = shots(); const i = a.findIndex(s => s.id === id);
    if (i < 0) return false;
    a.splice(i, 1); store.touch({ type: 'data' }); return true;
  }
  function restoreVersion(id, index) {
    const s = find(id); const v = s?.versions?.[index];
    if (!s || !v) return false;
    if (!v.fields || typeof v.fields !== 'object')
      throw new Error('该历史版本缺少字段内容（可能来自旧版导出），无法回滚');
    pushVersion(s);
    for (const [k] of SHOT_FIELDS) s[k] = v.fields[k] ?? (k === 'duration' ? 5 : '');
    flagDuration(s);   // 版本快照只存字段：按恢复出的时长重新推导非法标记
    s.updatedAt = Date.now(); store.touch({ type: 'data' }); return true;
  }

  // ---------- 脚本导入（同步、确定性解析）----------
  // mode: 'append'（默认）| 'replace'；返回新建分镜数组；脚本内容记入 studio.script 供脏提示对比。
  // 整批原子：全量解析/数量预检先于任何写入，超限或非法一律整体拒绝、不留半批。
  function fromScript(text, { mode = 'append' } = {}) {
    if (mode !== 'append' && mode !== 'replace') throw new Error(`未知导入模式：${mode}`);
    const parsed = parseScript(text);
    const base = mode === 'replace' ? 0 : shots().length;
    if (base + parsed.length > MAX_SHOTS)
      throw new Error(`分镜数量超限（现有 ${base} + 导入 ${parsed.length} > ${MAX_SHOTS}），整批未导入`);
    if (mode === 'replace') shots().length = 0;
    const made = parsed.map(f => addShot(f));
    const sc = script();
    if (sc.text !== String(text)) { sc.text = String(text); sc.updatedAt = Date.now(); }
    // 本批镜头来自刚导入的脚本；跨毫秒的解析不能把新镜头误标成过期。
    for (const s of made) s.updatedAt = Math.max(s.updatedAt ?? 0, sc.updatedAt);
    store.touch({ type: 'data' });
    return made;
  }
  function setScript(text) {
    const sc = script();
    const v = String(text ?? '');
    if (sc.text !== v) { sc.text = v; sc.updatedAt = Date.now(); store.saveSoon?.(); }
  }
  const scriptStale = s => script().updatedAt > 0 && s.updatedAt < script().updatedAt;

  // ---------- 文件导入（TXT/DOCX/JSON）：本地解析与限额在 script-import.js，原子应用在此 ----------
  const importPlans = new WeakMap();
  const importSignature = project => {
    const st = studioState(project);
    const source = typeof st.script === 'string' ? { text: st.script, updatedAt: 0 } : st.script ?? null;
    return JSON.stringify({ shots: st.shots, script: source });
  };
  // prepared 携带发起时的项目身份与分镜数组引用：应用/确认前逐项核验，切项目或重置一律拒写。
  async function prepareImport(files, { encoding = 'auto', domParser } = {}) {
    const project = store.project;
    if (!project) throw new Error('没有打开的项目');
    const arrRef = studioState(project).shots;
    const signature = importSignature(project);
    const prepared = await prepareImportFiles(files, {
      encoding, maxShots: MAX_SHOTS, domParser,
      parse: parseScript,
    });
    prepared.project = project;
    prepared.shotsRef = arrRef;
    importPlans.set(prepared, { project, signature, files: JSON.stringify(prepared.files) });
    return prepared;
  }
  // mode: 'append'（默认）| 'replace'；replace 必须提供 confirmReplace(prepared)→boolean。
  // 确认回调返回假 → 不写入、返回 null；项目核验失败抛错，绝不写半个批次。
  async function applyImport(prepared, { mode = 'append', confirmReplace } = {}) {
    if (!prepared || !Array.isArray(prepared.files) || !prepared.files.length)
      throw new Error('导入数据为空，请先执行 prepareImport');
    if (mode !== 'append' && mode !== 'replace') throw new Error(`未知导入模式：${mode}`);
    const original = importPlans.get(prepared);
    if (!original || original.files !== JSON.stringify(prepared.files)) throw new Error('导入预览已失效或被修改，请重新解析');
    if (mode === 'replace' && typeof confirmReplace !== 'function')
      throw new Error('replace 为破坏性导入，必须提供 confirmReplace 确认回调');
    for (const f of prepared.files)
      if (!Array.isArray(f?.fields) || !f.fields.length)
        throw new Error(`文件「${f?.name ?? '未命名'}」缺少有效解析结果`);
    const total = prepared.files.reduce((n, f) => n + f.fields.length, 0);
    const alive = () => {
      const project = original.project;
      if (store.project !== project || studioState(project).shots !== prepared.shotsRef) return null;
      if (importSignature(project) !== original.signature) throw new Error('剧本或分镜在预览后已变更，请重新解析预览');
      return studioState(project).shots;
    };
    const checkCap = arr => {
      const base = mode === 'replace' ? 0 : arr.length;
      if (base + total > MAX_SHOTS)
        throw new Error(`分镜数量超限（现有 ${base} + 导入 ${total} > ${MAX_SHOTS}），整批未导入`);
    };
    let arr = alive();
    if (!arr) throw new Error('项目在文件解析后已切换或重置，导入未写入');
    checkCap(arr);
    const previousText = typeof studioState(original.project).script === 'string' ? studioState(original.project).script : studioState(original.project).script?.text ?? '';
    const combined = [mode === 'append' ? previousText : '', ...prepared.files.map(f => f.text)].filter(Boolean).join('\n\n');
    if (combined.length > 8 * 1024 * 1024) throw new Error('剧本原文总量超限，整批未导入');
    if (mode === 'replace' && !(await confirmReplace(prepared))) return null;
    if (original.files !== JSON.stringify(prepared.files)) throw new Error('导入内容在确认期间已变更，请重新解析预览');
    arr = alive();
    if (!arr) throw new Error('项目在导入确认期间已切换，未写入任何分镜');
    checkCap(arr);
    const at = Date.now();
    const made = prepared.files.flatMap(f => f.fields.map(fields => ({ id: uid('s'), ...blank(), ...fields, assetIds: [], imageNodeId: null, nodeId: null, createdAt: at, updatedAt: at, versions: [] })));
    deps.editor?.checkpoint?.();
    // 全部构建成功后一次发布，不让观察者看到半批分镜。
    const st = studioState(original.project);
    st.shots = mode === 'replace' ? made : [...arr, ...made];
    st.script = { text: combined, updatedAt: at };
    importPlans.delete(prepared);
    store.touch({ type: 'data' });
    return made;
  }
  async function importFiles(files, { mode = 'append', encoding = 'auto', confirmReplace, domParser } = {}) {
    const prepared = await prepareImport(files, { encoding, domParser });
    return applyImport(prepared, { mode, confirmReplace });
  }

  // ---------- AI 拆分：走真实文本生成节点，失败即报错，无本地伪实现 ----------
  // 型号经 generators 可用型号助手（textModels/imageModels/videoModels）选择：
  // 数组 [{id,usable?/available?}|id] 取首个可用项；助手缺席/非数组 → null
  //（可用性未知，不设 model 交给生成侧如实校验）；助手返回数组但无可用项 → 显式拒绝。
  const modelList = kind => deps.generators?.[`${kind}Models`]?.();
  const pickModel = kind => {
    const list = modelList(kind);
    if (!Array.isArray(list)) return null;
    for (const m of list) {
      if (typeof m === 'string' && m) return m;
      if (m && typeof m.id === 'string' && m.usable !== false && m.available !== false) return m.id;
    }
    return null;
  };
  const noUsableModel = kind => Array.isArray(modelList(kind)) && !pickModel(kind);

  // 视频型号候选事实源：generators.videoModels() 显式清单优先；
  // 缺席时回退能力表全型号 × keyvault.isModelUsable（从未拉取 /v1/models = 可用性
  // 未验证，不按不可用处理）。无能力条目的候选 = 能力信息缺失（unverified）：
  // 可列出但不参与自动选型——模式/端口/时长都依赖能力声明，猜出来的草稿是不实的。
  function videoCandidates() {
    const helper = deps.generators?.videoModels?.();
    if (Array.isArray(helper)) {
      return helper.map(m => {
        const id = typeof m === 'string' ? m : m?.id;
        if (typeof id !== 'string' || !id) return null;
        const usable = (typeof m === 'string' ? true : (m.usable !== false && m.available !== false)) && isModelUsable(id);
        return { id, usable, capable: !!getModel(id) };
      }).filter(Boolean);
    }
    const ids = modelIds();
    return ids.length ? ids.map(id => ({ id, usable: isModelUsable(id), capable: true })) : null;
  }
  // 选型：默认 H3 仅在「声明可用且时长落在该型号范围内」时保留；
  // 否则按清单顺序取首个有能力信息且兼容时长的型号；一个都没有 → 抛出显式可执行
  // 错误（列出各型号范围与能力未验证名单），调用方在建节点前失败，绝不静默改时长。
  function pickVideoModel(seconds) {
    const cands = videoCandidates();
    if (cands === null) return { model: DEFAULT_VIDEO_MODEL, verified: false };   // 两类事实源都缺：保持默认，生成侧如实校验
    const usable = cands.filter(c => c.usable);
    if (!usable.length) throw new Error('当前密钥下无可用视频型号：请检查密钥或在设置中重新拉取型号目录');
    const fits = c => c.capable && seconds >= getModel(c.id).seconds.min && seconds <= getModel(c.id).seconds.max && (!getModel(c.id).allowed_seconds || getModel(c.id).allowed_seconds.includes(seconds));
    const dflt = usable.find(c => c.id === DEFAULT_VIDEO_MODEL);
    if (dflt && fits(dflt)) return { model: dflt.id, verified: true };
    const hit = usable.find(fits);
    if (hit) return { model: hit.id, verified: true };
    const ranges = usable.filter(c => c.capable).map(c => {
      const m = getModel(c.id);
      return `${c.id} ${m.allowed_seconds ? m.allowed_seconds.join('/') : `${m.seconds.min}–${m.seconds.max}`}s`;
    });
    const unv = usable.filter(c => !c.capable).map(c => c.id);
    throw new Error(`分镜时长 ${seconds}s 不在可用视频型号范围内`
      + `${ranges.length ? `（${ranges.join('、')}）` : ''}`
      + `${unv.length ? `；${unv.join('、')} 能力信息缺失未验证` : ''}`
      + '——请先调整分镜时长或改用兼容型号/密钥');
  }
  async function breakdownWithAI(text, { count } = {}) {
    if (!deps.generators?.generate) throw new Error('未接入文本生成能力，无法 AI 拆分');
    if (noUsableModel('text')) throw new Error('当前密钥下无可用文本模型，无法 AI 拆分');
    const project = store.project;   // 捕获发起时项目：await 返回后若已切换，结果一律不写
    const sys = `你是分镜编剧。把用户剧本拆成${count ? `约 ${count} 个` : '若干'}分镜，严格输出 JSON：` +
      `{"shots":[{"title":"","duration":5,"description":"","shotSize":"","camera":"","emotion":"","lighting":"","dialogue":"","sound":"","characters":"","imagePrompt":"","videoPrompt":""}]}。` +
      `只输出 JSON，不要解释；duration 为 1-30 的数字，其余字段为字符串。`;
    const model = pickModel('text');
    const node = store.addNode('text', 60, 60, { title: '分镜拆分（AI）', system: sys, text: String(text ?? ''), ...(model ? { model } : {}) });
    try {
      await deps.generators.generate(node, { purpose: 'shot-breakdown' });
      if (store.project !== project || !store.node(node.id))
        throw new Error('项目已切换或拆分节点已删除，结果未写入');
      const raw = String(node.data?.resultText ?? node.data?.outputText ?? '').replace(/```(?:json)?/g, '').trim();
      if (!raw) throw new Error('生成结果为空');
      const made = fromScript(raw, { mode: 'append' });
      const sc = script(); sc.text = String(text ?? ''); sc.updatedAt = Date.now();
      for (const s of made) s.updatedAt = Math.max(s.updatedAt ?? 0, sc.updatedAt);   // 拆分结果来自当前脚本，不立即标「脚本已更新」
      return made;
    } catch (e) { throw new Error(`AI 拆分失败：${e.message}`); }
  }

  // ---------- 网格与节点 ----------
  function createGrid(count, { withNodes = true } = {}) {
    if (!GRID_COUNTS.includes(count)) throw new Error(`网格数须为 ${GRID_COUNTS.join('/')}`);
    if (shots().length + count > MAX_SHOTS)
      throw new Error(`分镜数量超限（现有 ${shots().length} + 新建 ${count} > ${MAX_SHOTS}），整组未创建`);
    const cols = Math.ceil(Math.sqrt(count));
    const imgModel = pickModel('image');   // 型号取 generators 可用助手；未知则留空交生成侧处理
    const made = [], nodes = [];
    for (let i = 0; i < count; i++) {
      const s = addShot({ title: `镜头 ${shots().length + 1}` });
      if (withNodes) {
        const n = store.addNode('image', 40 + (i % cols) * 300, 40 + Math.floor(i / cols) * 340,
          { title: `分镜·${s.title}`, prompt: s.imagePrompt || s.description || '', params: { shotId: s.id }, ...(imgModel ? { model: imgModel } : {}) });
        s.imageNodeId = n.id; nodes.push(n);
      }
      made.push(s);
    }
    store.touch({ type: 'structure' });
    return { shots: made, nodes };
  }
  function ensureImageNode(s) {
    if (s.imageNodeId && store.node(s.imageNodeId)) return store.node(s.imageNodeId);
    const imgModel = pickModel('image');
    const n = store.addNode('image', 40, 40, { title: `分镜·${s.title || '未命名'}`, prompt: s.imagePrompt || s.description || '', params: { shotId: s.id }, ...(imgModel ? { model: imgModel } : {}) });
    s.imageNodeId = n.id; store.touch({ type: 'structure' }); return n;
  }
  // 视频节点草稿规划（纯函数，不建节点不发请求）：modelId 显式选型，否则按可用型号×时长
  // 自动选型；anchor:true 按 family 单图方案定 intent/port；intent:'refs' 走素材参考。
  // 时长非法/超范围/能力缺失一律抛错，绝不静默改时长或换型号。
  function planVideoDraft(s, { modelId = null, anchor = false, intent: forced = null } = {}) {
    const seconds = s.duration;
    if (s.durationInvalid === true || !isValidShotDuration(seconds))
      throw new Error(`分镜时长 ${s.durationRaw ?? seconds} 无效：须为 ${SHOT_DURATION_MIN}–${SHOT_DURATION_MAX} 整数秒，请先在分镜表中修正`);
    const { model, verified } = modelId
      ? { model: modelId, verified: !!getModel(modelId) }
      : pickVideoModel(seconds);   // 无兼容型号 → 在建节点前抛出
    const m = getModel(model);
    if (m && (seconds < m.seconds.min || seconds > m.seconds.max || (m.allowed_seconds && !m.allowed_seconds.includes(seconds))))
      throw new Error(`分镜时长 ${seconds}s 不符合 ${model} 的 ${m.allowed_seconds ? m.allowed_seconds.join('/') : `${m.seconds.min}–${m.seconds.max}`}s 时长要求`);
    let intent = 'text', port = null;
    if (forced === 'refs') {
      if (m && !modeForIntent(model, 'refs')) throw new Error(`视频型号 ${model} 不支持素材参考模式`);
      intent = 'refs'; port = 'refs';
    } else if (anchor) {
      // 能力已验证 → 按 family 单图方案；能力缺失但型号即默认 H3 → 其真实单图方案为 frames
      const plan = m ? singleImagePlan(model)
        : model === DEFAULT_VIDEO_MODEL ? { intent: 'frames', port: 'frames' } : null;
      if (!plan) throw new Error(`视频型号 ${model} 能力信息缺失，无法安全接入单图锚点——请补全能力表或改用已知型号`);
      intent = plan.intent; port = plan.port;
    }
    const ratio = m?.ratios?.options?.includes('16:9') ? '16:9' : (m?.ratios?.options?.[0] ?? '16:9');
    // 只写能力允许的开关：不支持的键一律不进草稿，控件不显示、请求体也不会带
    const switches = {};
    if (m?.switches?.generate_audio) switches.generate_audio = true;
    if (m?.switches?.face_mode) switches.face_mode = false;
    return { model, verified, intent, port, draft: { model, intent, seconds, ratio, prompt: s.videoPrompt || s.description || '', switches } };
  }
  function ensureVideoNode(s) {
    if (s.nodeId && store.node(s.nodeId)) return store.node(s.nodeId);
    const anchor = s.imageNodeId ? store.node(s.imageNodeId) : null;
    const pv = planVideoDraft(s, { anchor: !!anchor });   // 非法时长/无兼容型号 → 在建节点前抛出
    const n = store.addNode('gen', (anchor?.x ?? 40) + 300, anchor?.y ?? 40, {
      title: `分镜·${s.title || '未命名'}·视频`,
      draft: pv.draft,
      perModel: {}, run: null, params: { shotId: s.id },
      ...(pv.verified ? {} : { modelUnverified: true }),   // 能力/可用性未验证的显式标记，不冒充已验证
    });
    if (anchor && pv.port) {
      const edge = store.addEdge(anchor.id, 'out', n.id, pv.port, 'image');   // 各 family 的真实单图端口
      if (!edge) {   // 端口拒绝 → 不留无锚半成品节点
        store.removeNode(n.id);
        throw new Error(`图片锚点接入 ${pv.port} 端口被拒绝，视频节点未创建`);
      }
    }
    s.nodeId = n.id;
    store.touch({ type: 'structure' }); return n;
  }
  // 目标端口规划：按节点类型与 gen 草稿意图决定可接素材种类与容量——
  // frames 口仅图片：frames 与锚点合计 ≤2，last_frame 恰好 1 图（仅尾帧）；
  // i2v 恰好 1 图（锚点已占则满）；
  // refs 按型号 reference_limits；text 意图不接素材；图片节点 refs 仅图片。
  function wirePlan(target) {
    if (target.type === 'gen') {
      const intent = target.data?.draft?.intent ?? 'text';
      if (intent === 'last_frame') return { port: 'frames', accept: new Set(['image']), limit: { image: 1, total: 1 }, label: '尾帧（恰好 1 张图片）' };
      if (intent === 'frames') return { port: 'frames', accept: new Set(['image']), limit: { image: 2, total: 2 }, label: '首尾帧（仅图片，合计≤2）' };
      if (intent === 'i2v') return { port: 'refs', accept: new Set(['image']), limit: { image: 1, total: 1 }, label: '单图模式（恰好 1 张图片）' };
      if (intent === 'refs') {
        const lim = getModel(target.data?.draft?.model)?.reference_limits ?? { image: 9, video: 3, audio: 3, total: 9 };
        return { port: 'refs', accept: new Set(['image', 'video', 'audio']), limit: lim, label: '素材参考' };
      }
      return { port: null, accept: new Set(), limit: { total: 0 }, label: '纯文字模式' };
    }
    if (target.type === 'image')
      return { port: 'refs', accept: new Set(['image']), limit: { image: IMAGE_NODE_MAX_REFS, total: IMAGE_NODE_MAX_REFS }, label: '图片参考' };
    return { port: 'refs', accept: new Set(['image', 'video', 'audio']), limit: { total: IMAGE_NODE_MAX_REFS }, label: '输入' };
  }
  const wireSrcKind = src => {
    if (!src) return null;
    if (src.type === 'asset') return store.project.assets[src.data?.assetId]?.kind ?? null;
    if (src.type === 'gen') return 'video';
    if (src.type === 'image') return 'image';
    if (src.type === 'text') return 'text';
    const first = nodeOutputIds(src).find(aid => store.project.assets[aid]);
    return first ? store.project.assets[first].kind : null;
  };
  // 分镜素材 → 节点连线：整批预检（存在/缺失文件/类型/端口容量/重复），任一项不过 →
  // 全部不接并返回显式问题清单（素材留在分镜上可见）；预检全过后才应用，
  // 应用期意外被拒同样回滚本批全部新增节点与连线——不留半批、不静默跳边。
  // 返回 {wired,duplicates,problems,applied}。
  function wireShotAssets(id) {
    const s = find(id); if (!s) return { wired: 0, duplicates: 0, problems: ['分镜不存在'], applied: false };
    const target = (s.nodeId && store.node(s.nodeId)) || (s.imageNodeId && store.node(s.imageNodeId));
    if (!target) return { wired: 0, duplicates: 0, problems: ['分镜还没有可连线的生成节点'], applied: false };
    const plan = wirePlan(target);
    const existing = plan.port ? store.edgesInto(target.id, plan.port) : [];
    const used = { image: 0, video: 0, audio: 0, total: 0 };
    for (const e of existing) { const k = wireSrcKind(store.node(e.from.node)); if (k && used[k] != null) used[k]++; used.total++; }
    const problems = [], todo = [];
    let duplicates = 0;
    for (const aid of s.assetIds) {
      const a = typeof aid === 'string' && aid ? store.project.assets[aid] : null;
      if (!a) { problems.push(`素材引用 ${aid ?? '（空槽位）'} 不存在或已删除`); continue; }
      if (a.missing) { problems.push(`素材「${a.name}」本地文件缺失，需先重绑`); continue; }
      if (!plan.port) { problems.push(`素材「${a.name}」：目标为${plan.label}，不接受素材输入`); continue; }
      if (!plan.accept.has(a.kind)) { problems.push(`素材「${a.name}」（${KIND_LABEL[a.kind] ?? a.kind}）不能接入${plan.label}`); continue; }
      const anode = store.project.nodes.find(x => x.type === 'asset' && x.data.assetId === aid);
      if (anode && existing.some(e => e.from.node === anode.id)) { duplicates++; continue; }
      const kindCap = plan.limit[a.kind] ?? plan.limit.total ?? IMAGE_NODE_MAX_REFS;
      if (used.total >= (plan.limit.total ?? IMAGE_NODE_MAX_REFS) || used[a.kind] >= kindCap) {
        problems.push(`素材「${a.name}」：${plan.label}容量已满`); continue;
      }
      used[a.kind]++; used.total++;
      todo.push({ a, anode });
    }
    if (problems.length) return { wired: 0, duplicates, problems, applied: false };
    const madeNodes = [], madeEdges = [];
    for (const { a, anode } of todo) {
      const node = anode ?? store.addNode('asset', target.x - 260, target.y + madeNodes.length * 140, { assetId: a.id, title: a.name });
      if (!anode) madeNodes.push(node.id);
      const e = store.addEdge(node.id, 'out', target.id, plan.port, a.kind);
      if (!e) {
        for (const eid of madeEdges) store.removeEdge(eid);
        for (const nid of madeNodes) store.removeNode(nid);
        return { wired: 0, duplicates, problems: [`「${a.name}」接入 ${plan.port} 端口被拒，整批已回滚`], applied: false };
      }
      madeEdges.push(e.id);
    }
    if (madeEdges.length) store.touch({ type: 'structure' });
    return { wired: madeEdges.length, duplicates, problems: [], applied: madeEdges.length > 0 };
  }

  // ---------- 分镜预览建图（§6.3）：预览不发起任何生成/网络请求；apply 全或无 ----------
  // 模板三选：t2v 纯文字 gen；i2v 图片节点→单图锚点 gen；ref 素材节点→refs gen。
  // 已有 s.nodeId/s.imageNodeId 默认复用不复制；问题只列入 conflicts 不静默修
  //（不换型号、不改时长、不丢素材）。plan.sig 覆盖分镜字段+素材状态+模板+型号——
  // 改分镜/切项目/改素材 → 计划失效须重建；重复 apply 命中已建链接 → 幂等不重复。
  const SHOT_PLAN_MAX = 20;
  const SHOT_PLAN_TEMPLATES = new Set(['t2v', 'i2v', 'ref']);
  const shotPlans = new WeakMap();
  const shotPlanSig = (project, { shotIds, template, modelId, reuses = [] }) => {
    const st = studioState(project);
    const rows = (shotIds ?? []).map(id => {
      const s = st.shots.find(x => x.id === id) ?? null;
      return s ? [...SHOT_FIELDS.map(([k]) => s[k] ?? null), s.durationInvalid === true, s.durationRaw ?? null, s.assetIds ?? []] : null;
    });
    const aids = new Set();
    for (const id of shotIds ?? []) {
      const s = st.shots.find(x => x.id === id);
      for (const aid of s?.assetIds ?? []) if (aid) aids.add(aid);
    }
    const assets = [...aids].sort().map(aid => {
      const a = project.assets?.[aid];
      return [aid, a ? (a.missing ? 0 : 1) : -1, a?.size ?? -1, a?.contentRevision ?? ''];
    });
    // 触及复用节点的既有连线入签名（A 审 m3）：预览后向复用节点加线 → 端口容量判定过期 → 拒建
    const reuseIds = new Set(reuses.map(r => r.nodeId));
    const edgeRefs = project.edges
      .filter(e => reuseIds.has(e.to.node) || reuseIds.has(e.from.node))
      .map(e => `${e.id}|${e.from.node}>${e.from.port}->${e.to.node}>${e.to.port}|${e.kind ?? ''}`)
      .sort();
    return JSON.stringify({ p: project.id, t: template, m: modelId ?? null, rows, assets, edgeRefs });
  };

  function previewShotWorkflow({ shotIds, template = 't2v', modelId = null } = {}) {
    const project = store.project;
    if (!project) throw new Error('没有打开的项目');
    if (!SHOT_PLAN_TEMPLATES.has(template)) throw new Error(`未知建图模板：${template}（可选 t2v/i2v/ref）`);
    if (!Array.isArray(shotIds) || !shotIds.length) throw new Error('请先选择要建图的分镜');
    if (shotIds.length > SHOT_PLAN_MAX) throw new Error(`单次建图最多 ${SHOT_PLAN_MAX} 个分镜（收到 ${shotIds.length}）`);
    if (new Set(shotIds).size !== shotIds.length) throw new Error('分镜选择存在重复项');
    const creates = [], edges = [], reuses = [], conflicts = [];
    const plannedAssets = new Set();   // 同一素材多个分镜共用 → 只计划一个素材节点
    for (const [i, id] of shotIds.entries()) {
      const s = find(id);
      if (!s) { conflicts.push({ shotId: id, reason: '分镜不存在或已删除' }); continue; }
      const liveVid = s.nodeId ? store.node(s.nodeId) : null;
      const liveImg = s.imageNodeId ? store.node(s.imageNodeId) : null;
      if (liveVid) reuses.push({ shotId: s.id, nodeId: liveVid.id, role: 'video' });
      if (liveImg) reuses.push({ shotId: s.id, nodeId: liveImg.id, role: 'image' });
      // 时长非法 → conflicts，不建（与 ensureVideoNode 同一合同）
      if (s.durationInvalid === true || !isValidShotDuration(s.duration)) {
        conflicts.push({ shotId: s.id, reason: `时长无效（${s.durationRaw ?? s.duration}），需先在分镜表中修正` });
        continue;
      }
      let pv = null;
      if (liveVid) {
        // 复用既有视频节点：型号/模式与计划不符 → conflicts 只列不改（不静默换型号/模式）
        const dm = liveVid.data?.draft?.model ?? null;
        if (modelId && dm && dm !== modelId) {
          conflicts.push({ shotId: s.id, reason: `已有视频节点型号为 ${dm}，与所选 ${modelId} 不一致，未应用` });
          continue;
        }
        if (template !== 't2v') {
          const wp = wirePlan(liveVid);
          if (!wp.port) { conflicts.push({ shotId: s.id, reason: `已有视频节点为纯文字模式，不能接入${template === 'i2v' ? '图片锚点' : '素材参考'}` }); continue; }
          if (template === 'ref' && liveVid.data?.draft?.intent !== 'refs') {
            conflicts.push({ shotId: s.id, reason: `已有视频节点模式为 ${liveVid.data?.draft?.intent ?? '?'}，非素材参考，未应用` });
            continue;
          }
          if (template === 'i2v') {
            const cap = Math.min(wp.limit.total ?? 2, wp.limit.image ?? wp.limit.total ?? 2);
            if (store.edgesInto(liveVid.id, wp.port).length >= cap) {
              conflicts.push({ shotId: s.id, reason: '已有视频节点端口容量已满，无法接入图片锚点' });
              continue;
            }
          }
        }
      } else {
        try {
          pv = planVideoDraft(s, { modelId, anchor: template === 'i2v', intent: template === 'ref' ? 'refs' : null });
        } catch (e) { conflicts.push({ shotId: s.id, reason: e.message }); continue; }
        creates.push({ shotId: s.id, role: 'video', nodeSpec: {
          type: 'gen', x: 40 + (i % 5) * 320 + 300, y: 40 + Math.floor(i / 5) * 360,
          data: { title: `分镜·${s.title || '未命名'}·视频`, draft: pv.draft, perModel: {}, run: null, params: { shotId: s.id },
            ...(pv.verified ? {} : { modelUnverified: true }) },
        } });
      }
      if (template === 'i2v') {
        if (!liveImg) {
          const imgModel = pickModel('image');
          creates.push({ shotId: s.id, role: 'image', nodeSpec: {
            type: 'image', x: 40 + (i % 5) * 320, y: 40 + Math.floor(i / 5) * 360,
            data: { title: `分镜·${s.title || '未命名'}`, prompt: s.imagePrompt || s.description || '', params: { shotId: s.id }, ...(imgModel ? { model: imgModel } : {}) },
          } });
        }
        edges.push({ shotId: s.id, fromRole: 'image', toRole: 'video', port: liveVid ? wirePlan(liveVid).port : pv.port, kind: 'image' });
      } else if (template === 'ref') {
        const bound = s.assetIds ?? [];
        if (!bound.some(Boolean)) { conflicts.push({ shotId: s.id, reason: '素材参考模板需要至少一个已绑定素材（分镜素材为空）' }); continue; }
        let bad = false;
        const usable = [];
        for (const aid of bound) {
          if (!aid) { conflicts.push({ shotId: s.id, reason: '素材引用存在空槽位（已失效引用），需先在分镜素材中修正' }); bad = true; continue; }
          const a = project.assets?.[aid];
          if (!a) { conflicts.push({ shotId: s.id, reason: `素材引用 ${aid} 不存在或已删除` }); bad = true; continue; }
          if (a.missing) { conflicts.push({ shotId: s.id, reason: `素材「${a.name}」本地文件缺失，需先重绑` }); bad = true; continue; }
          usable.push(a);
        }
        if (bad) continue;
        // 端口容量预检：复用节点按现状计，新建节点按计划型号限额计
        const lim = liveVid ? wirePlan(liveVid)
          : { limit: getModel(pv.model)?.reference_limits ?? { image: 9, video: 3, audio: 3, total: 9 } };
        const used = { image: 0, video: 0, audio: 0, total: 0 };
        if (liveVid) for (const e of store.edgesInto(liveVid.id, 'refs')) {
          const k = wireSrcKind(store.node(e.from.node));
          if (k && used[k] != null) used[k]++; used.total++;
        }
        for (const a of usable) {
          const kindCap = lim.limit[a.kind] ?? lim.limit.total ?? 9;
          if (used.total >= (lim.limit.total ?? 9) || used[a.kind] >= kindCap) {
            conflicts.push({ shotId: s.id, reason: `素材「${a.name}」：素材参考容量已满` });
            bad = true; break;
          }
          used[a.kind]++; used.total++;
          const anode = project.nodes.find(x => x.type === 'asset' && x.data?.assetId === a.id);
          if (anode) reuses.push({ shotId: s.id, nodeId: anode.id, role: 'asset' });
          else if (!plannedAssets.has(a.id)) {
            plannedAssets.add(a.id);
            creates.push({ shotId: s.id, role: 'asset', assetId: a.id, nodeSpec: {
              type: 'asset', x: 40 + (i % 5) * 320 - 260, y: 40 + Math.floor(i / 5) * 360,
              data: { assetId: a.id, title: a.name },
            } });
          }
          edges.push({ shotId: s.id, fromRole: 'asset', fromAssetId: a.id, toRole: 'video', port: 'refs', kind: a.kind });
        }
      }
    }
    const plan = {
      id: uid('splan'), projectId: project.id, template, modelId, shotIds: [...shotIds],
      creates, edges, reuses, conflicts, createdAt: Date.now(),
    };
    const sig = shotPlanSig(project, { shotIds, template, modelId, reuses });
    // 签发快照入令牌（A 审 m1）：apply 只信 rec 内深拷贝——调用方事后清空 conflicts、
    // 篡改 edges、注入 creates 一律不影响签发内容
    shotPlans.set(plan, {
      project, sig,
      scope: { shotIds: [...shotIds], template, modelId: modelId ?? null },
      creates: clone(creates), edges: clone(edges), reuses: clone(reuses), conflicts: clone(conflicts),
    });
    return { ok: conflicts.length === 0, plan, sig };
  }

  // 应用建图计划：全或无。计划签发/签名/冲突/存活逐项核验——任一不符整体不建；
  // 节点创建与连线任一步失败回滚本批全部新增（含已写回的分镜链接），不留半个图。
  function applyShotWorkflow(plan) {
    const rec = plan && typeof plan === 'object' ? shotPlans.get(plan) : null;
    if (!rec) throw new Error('建图计划无效或已过期，请重新预览');
    const project = store.project;
    if (!project || project !== rec.project) throw new Error('项目已切换，建图计划未应用');
    // 签名按签发时快照重算（rec.scope/rec.reuses），调用方对 plan 字段的篡改不参与判定
    if (shotPlanSig(project, { ...rec.scope, reuses: rec.reuses }) !== rec.sig)
      throw new Error('分镜或素材在预览后已变更，请重新预览建图');
    if (rec.conflicts.length)
      throw new Error(`建图计划存在 ${rec.conflicts.length} 项冲突，未创建任何节点`);
    for (const id of rec.scope.shotIds)
      if (!find(id)) throw new Error('部分分镜已删除，建图计划未应用');
    const madeNodes = [], madeEdges = [], linked = [];
    const link = (s, field, nid) => { linked.push([s, field, s[field]]); s[field] = nid; };
    const assetNodeFor = new Map();   // assetId → 本批创建或既有素材节点
    const rollback = () => {
      for (const [s, f, old] of linked) s[f] = old;
      for (const eid of madeEdges) store.removeEdge(eid);
      for (const nid of madeNodes) store.removeNode(nid);
    };
    try {
      for (const c of rec.creates) {
        const s = find(c.shotId);
        if (!s) throw new Error('分镜在应用前被删除，建图整体未应用');
        if (c.role === 'video') {
          if (s.nodeId && store.node(s.nodeId)) continue;   // 期间已建 → 幂等复用
          const n = store.addNode(c.nodeSpec.type, c.nodeSpec.x, c.nodeSpec.y, clone(c.nodeSpec.data));
          madeNodes.push(n.id); link(s, 'nodeId', n.id);
        } else if (c.role === 'image') {
          if (s.imageNodeId && store.node(s.imageNodeId)) continue;
          const n = store.addNode(c.nodeSpec.type, c.nodeSpec.x, c.nodeSpec.y, clone(c.nodeSpec.data));
          madeNodes.push(n.id); link(s, 'imageNodeId', n.id);
        } else if (c.role === 'asset') {
          const existing = project.nodes.find(x => x.type === 'asset' && x.data?.assetId === c.assetId)
            ?? (assetNodeFor.has(c.assetId) ? store.node(assetNodeFor.get(c.assetId)) : null);
          if (existing) { assetNodeFor.set(c.assetId, existing.id); continue; }
          const n = store.addNode('asset', c.nodeSpec.x, c.nodeSpec.y, clone(c.nodeSpec.data));
          madeNodes.push(n.id); assetNodeFor.set(c.assetId, n.id);
        }
      }
      for (const e of rec.edges) {
        const s = find(e.shotId);
        if (!s) throw new Error('分镜在连线前被删除，建图整体未应用');
        const toId = s.nodeId;
        if (!toId || !store.node(toId)) throw new Error(`分镜「${s.title || s.id}」缺少视频节点，建图整体未应用`);
        let fromId = null;
        if (e.fromRole === 'image') fromId = s.imageNodeId;
        else if (e.fromRole === 'asset') {
          fromId = assetNodeFor.get(e.fromAssetId)
            ?? project.nodes.find(x => x.type === 'asset' && x.data?.assetId === e.fromAssetId)?.id ?? null;
        }
        if (!fromId || !store.node(fromId)) throw new Error('连线来源缺失，建图整体未应用');
        if (project.edges.some(x => x.to.node === toId && x.to.port === e.port && x.from.node === fromId)) continue;   // 已连 → 幂等跳过
        const edge = store.addEdge(fromId, 'out', toId, e.port, e.kind);
        if (!edge) throw new Error(`素材/锚点接入 ${e.port} 端口被拒，建图整体未应用`);
        madeEdges.push(edge.id);
      }
    } catch (err) {
      rollback();
      throw err;
    }
    if (madeNodes.length || madeEdges.length || linked.length) store.touch({ type: 'structure' });
    return { nodes: [...madeNodes], edges: [...madeEdges], reused: rec.reuses.length };
  }

  // 跨项目导入兼容适配：core 的 sanitizeNode 不保留 gen 节点 data.params，
  // params.shotId 可能在导入后丢失。分镜侧以 shot→nodeId 为权威链接，
  // 打开面板/聚焦时把缺失的 shotId 回填到仍被引用的节点（合并不覆盖其他 params 键）。
  function healShotLinks() {
    let fixed = 0;
    for (const s of shots()) {
      for (const nid of [s.imageNodeId, s.nodeId]) {
        const n = nid ? store.node(nid) : null;
        if (!n) continue;
        const params = n.data?.params;
        if (params?.shotId === s.id) continue;
        store.updateNodeData(n.id, { params: { ...(params ?? {}), shotId: s.id } });
        fixed++;
      }
    }
    return fixed;
  }

  // ---------- 行↔节点提示词：显式双向同步 + 分歧标记 ----------
  const nodePromptOf = n => !n ? '' : n.type === 'gen' ? (n.data.draft?.prompt ?? '') : (n.data.prompt ?? '');
  function writeNodePrompt(n, text) {
    if (n.type === 'gen') store.updateNodeData(n.id, { draft: { ...(n.data.draft ?? {}), prompt: text } });
    else store.updateNodeData(n.id, { prompt: text });
  }
  function divergence(s) {
    const img = s.imageNodeId ? store.node(s.imageNodeId) : null;
    const vid = s.nodeId ? store.node(s.nodeId) : null;
    return {
      image: !!img && nodePromptOf(img) !== (s.imagePrompt ?? ''),
      video: !!vid && nodePromptOf(vid) !== (s.videoPrompt ?? ''),
      imageMissing: !!(s.imageNodeId && !img),
      videoMissing: !!(s.nodeId && !vid),
    };
  }
  function syncShotToNodes(id) {
    const s = find(id); if (!s) return 0;
    let changed = 0;
    const img = s.imageNodeId && store.node(s.imageNodeId);
    if (img && nodePromptOf(img) !== (s.imagePrompt ?? '')) { writeNodePrompt(img, s.imagePrompt ?? ''); changed++; }
    const vid = s.nodeId && store.node(s.nodeId);
    if (vid && nodePromptOf(vid) !== (s.videoPrompt ?? '')) { writeNodePrompt(vid, s.videoPrompt ?? ''); changed++; }
    return changed;
  }
  function syncShotFromNodes(id) {
    const s = find(id); if (!s) return null;
    const patch = {};
    const img = s.imageNodeId && store.node(s.imageNodeId);
    const vid = s.nodeId && store.node(s.nodeId);
    if (img) patch.imagePrompt = nodePromptOf(img);
    if (vid) patch.videoPrompt = nodePromptOf(vid);
    return Object.keys(patch).length ? updateShot(id, patch) : s;
  }

  // ---------- 导出 / 批量 ----------
  function exportCSV() {
    const csv = shotsToCSV(shots());
    if (typeof document !== 'object') return csv;
    const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `分镜-${store.project.name}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return csv;
  }
  async function batchGenerate(ids) {
    try {
      const project = store.project;   // 作用域钉在发起项目：确认/估价期间切走 → 整批中止
      // 用户所选的每个 id 都必须找到——找不到即整批取消，不静默过滤后继续对其余收费
      const picked = [], unknown = [];
      for (const id of ids) {
        const s = find(id);
        if (s) picked.push(s); else unknown.push(id);
      }
      if (unknown.length) {
        toast(`所选分镜 ${unknown.slice(0, 5).join('、')} 不存在，已整批取消`, 'err', 6000);
        return null;
      }
      // 快照分镜对象与其关联节点身份（分镜侧权威，不依赖 core）：确认/preview 等
      // await 之后逐项核验——删分镜、删节点、改指关联、切项目 → 整批中止，
      // 绝不把发起时捕获的旧 targets 提交到变更后的状态上收费
      const links = picked.map(s => ({ s, imageNodeId: s.imageNodeId, nodeId: s.nodeId }));
      const alive = () => store.project === project && links.every(({ s, imageNodeId, nodeId }) =>
        shots().includes(s) && s.imageNodeId === imageNodeId && s.nodeId === nodeId &&
        (imageNodeId == null || !!store.node(imageNodeId)) &&
        (nodeId == null || !!store.node(nodeId)));
      // 死链整批阻止：关联节点已删除的分镜不得静默过滤后继续对其余收费——
      // 明确列出并取消整批，由用户重建节点后重新发起（已有参考素材一律保留）
      const dead = [], targetSet = new Set();
      for (const { s, imageNodeId, nodeId } of links) {
        for (const nid of [imageNodeId, nodeId]) {
          if (nid == null) continue;
          if (store.node(nid)) targetSet.add(nid);
          else dead.push(s.title || s.id);
        }
      }
      if (dead.length) {
        toast(`分镜「${[...new Set(dead)].slice(0, 5).join('、')}」关联的生成节点已删除，已整批取消；请重建节点后重试`, 'err', 7000);
        return null;
      }
      const targets = [...targetSet];
      if (!targets.length) { toast('所选分镜还没有生成节点', 'warn'); return null; }
      if (!deps.workflow) { toast('批量工作流未就绪', 'warn'); return null; }
      const prev = await deps.workflow.preview({ targets, onlyEmpty: true });
      if (!alive()) { toast('分镜或项目在预检期间已变更，批量生成已整批取消', 'warn'); return null; }
      // 预检问题直接阻止创建：不进入确认，不发起收费生成
      const problems = [...(prev?.fatal ?? []), ...(prev?.issues ?? [])];
      if (problems.length) {
        toast(`预检未通过，未发起生成：${problems.slice(0, 3).join('；')}${problems.length > 3 ? ` 等${problems.length}项` : ''}`, 'err', 7000);
        return null;
      }
      // 用户确认的必须就是将要执行的那份计划：预检须签发冻结运行计划，启动时按该计划逐项核验
      //（项目/密钥/画布签名/估价版本），任一变化即拒绝，不在确认后重新计算另一份计划照旧收费
      if (!prev?.plan) { toast('预检未返回可确认的运行计划，未发起生成', 'err', 7000); return null; }
      const sum = prev.skipSummary ?? {};
      const ok = await (deps.confirm ?? confirmDialog)('批量生成分镜', el('div', {},
        el('p', { text: `仅补齐空白：新执行 ${sum.run ?? targets.length} 个节点，复用 ${sum.reused ?? 0} 个已有结果，续跑 ${sum.resumed ?? 0} 个已受理任务（只查询/下载），拦截 ${sum.blocked ?? 0} 个。` }),
        el('p', { text: `估价（仅新执行）：${prev?.estimatedYuan != null ? `${prev.estimatedYuan} 元` : '未知'}（${prev?.priceKind ?? '未计价'}）` })));
      if (!ok) return null;
      if (!alive()) { toast('分镜或项目在确认期间已变更，批量生成已整批取消', 'warn'); return null; }
      return await deps.workflow.start({ plan: prev.plan, confirmed: true });
    } catch (e) {
      toast(`批量生成失败：${e.message}`, 'err', 7000);
      return null;
    }
  }

  // ---------- 面板 UI ----------
  let dlg = null, content = null;
  const selected = new Set();
  const canDOM = () => typeof document === 'object' && !!document.getElementById?.('overlay-root');
  const btn = (t, fn, cls = 'mini') => { const b = el('button', { class: cls, type: 'button', text: t }); b.addEventListener('click', fn); return b; };
  const selOf = (opts, cur, on) => { const s = el('select', {}, opts.map(([v, l]) => el('option', { value: v, text: l, selected: v === cur }))); s.addEventListener('change', () => on(s.value)); return s; };

  function open() {
    if (!canDOM()) return null;
    healShotLinks();
    if (dlg) { render(); return dlg; }
    content = el('div', { class: 'sb' });
    dlg = modal(content, { wide: true, onClose: () => { dlg = null; content = null; } });
    render(); return dlg;
  }
  function focusShot(id) {
    const s = find(id); if (!s) return null;
    healShotLinks();
    if (canDOM()) {
      open();
      const row = content?.querySelector(`[data-shot="${id}"]`);
      row?.scrollIntoView?.({ block: 'center' });
    }
    const nid = s.nodeId || s.imageNodeId;
    if (nid && store.node(nid)) deps.board?.select?.('node', nid);
    return s;
  }
  function render() {
    if (!content || !canDOM()) return;
    const total = shots().length;
    const totalSec = shots().reduce((n, s) => n + (Number(s.duration) || 0), 0);
    const gridSel = el('select', { class: 'sb-grid-sel', title: '按网格新建一组分镜' }, el('option', { value: '', text: '新建网格…' }), GRID_COUNTS.map(n => el('option', { value: n, text: `${n} 格` })));
    gridSel.addEventListener('change', () => {
      if (!gridSel.value) return;
      try { createGrid(Number(gridSel.value)); toast(`已创建 ${gridSel.value} 格分镜`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      render();
    });
    const head = el('div', { class: 'sb-head' },
      el('div', { class: 'sb-head-main' },
        el('h3', { class: 'sb-title', text: '分镜表' }),
        el('span', { class: 'sb-count', text: total ? `${total} 个分镜 · 合计约 ${totalSec}s` : '尚无分镜' })),
      el('div', { class: 'row sb-head-actions' },
        gridSel,
        btn('素材复用到所选', () => openAssetReuse({ ...deps, storyboards: { find, updateShot } }, { shotIds: [...selected] })),
        btn('预览建图所选', shotWorkflowDialog),
        btn(`批量生成所选（${selected.size}）`, () => { batchGenerate([...selected]).catch(e => toast(`批量生成失败：${e.message}`, 'err', 7000)); }, 'primary')));
    const tools = el('details', { class: 'sb-tools', open: total === 0 },
      el('summary', { text: '导入 · AI 拆分 · 导出' }),
      el('div', { class: 'row sb-bar sb-tools-body' },
        btn('导入脚本 / 文件', importDialog), btn('AI 拆分', aiDialog),
        btn('导出 CSV', () => exportCSV())));
    const ta = el('textarea', { rows: 5, value: script().text, placeholder: '在此维护剧本；修改后早于修改时间的分镜会标记「脚本已更新」。' });
    ta.addEventListener('input', () => setScript(ta.value));
    const scriptBox = el('details', { class: 'sb-script' },
      el('summary', { text: `剧本${shots().some(scriptStale) ? '（已修改，部分分镜可能过期）' : ''}` }), ta,
      script().text ? el('div', { class: 'sb-script-meta', text: `共 ${script().text.length} 字` }) : null);
    const list = el('div', { class: 'sb-grid' }, shots().map(cardOf));
    const empty = el('div', { class: 'sb-empty' },
      el('div', { class: 'sb-empty-title', text: '还没有分镜' }),
      el('p', { class: 'hint', text: '尚无分镜：导入脚本/JSON，或新建镜头网格。' }),
      btn('新建 4 格分镜', () => {
        try { createGrid(4); toast('已创建 4 格分镜', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        render();
      }, 'primary'));
    content.replaceChildren(head, tools, scriptBox, list, ...(total ? [] : [empty]));
  }
  function cardOf(s) {
    const d = divergence(s);
    const cb = el('input', { type: 'checkbox', 'aria-label': '选择该分镜用于批量生成' });
    cb.checked = selected.has(s.id);
    cb.addEventListener('change', () => { cb.checked ? selected.add(s.id) : selected.delete(s.id); render(); });
    const badges = [];
    if (s.durationInvalid) badges.push(el('span', { class: 'badge err', text: `时长无效（${s.durationRaw ?? s.duration}）` }));
    if (scriptStale(s)) badges.push(el('span', { class: 'badge warn', text: '脚本已更新' }));
    if (d.image || d.video) badges.push(el('span', { class: 'badge warn', text: '与节点分歧' }));
    if (d.imageMissing || d.videoMissing) badges.push(el('span', { class: 'badge err', text: '节点已删' }));
    const thumb = el('div', { class: 'sb-thumb' });
    const imgN = s.imageNodeId && store.node(s.imageNodeId);
    const outA = imgN && store.project.assets[imgN.data.resultAssetId ?? imgN.data.outputAssetIds?.[0]];
    const refA = s.assetIds[0] && store.project.assets[s.assetIds[0]];
    const showA = outA?.kind === 'image' ? outA : refA?.kind === 'image' ? refA : null;
    if (showA && !showA.missing) deps.assets.objectURL(showA.id).then(u => { if (u) thumb.append(el('img', { src: u, alt: '' })); }).catch(() => {});
    else thumb.append(el('span', { class: 'hint', text: s.shotSize || '无图' }));
    const idx = shots().indexOf(s) + 1;
    return el('div', { class: 'sb-card', 'data-shot': s.id },
      el('div', { class: 'sb-card-top' },
        thumb,
        el('label', { class: 'sb-check', title: '批量生成选择' }, cb),
        el('span', { class: 'hint sb-dur', text: `${s.duration}s` })),
      el('div', { class: 'sb-card-main' },
        el('div', { class: 'sb-card-title' }, el('b', { text: `${idx}. ${s.title || '未命名'}` })),
        badges.length ? el('div', { class: 'row sb-badges' }, ...badges) : null,
        el('small', { class: 'sb-card-desc', text: (s.description || '').slice(0, 60) })),
      el('div', { class: 'row actions sb-card-actions' },
        btn('编辑', () => editDialog(s)), btn('定位', () => focusShot(s.id)),
        btn('素材', () => assetsDialog(s)), btn('⋮', () => moreDialog(s))));
  }
  function editDialog(s) {
    const inputs = {};
    const fieldEl = ([k, label]) => {
      let input;
      if (k === 'duration') input = el('input', { type: 'number', min: 1, max: 30, value: s[k] });
      else if (SELECT_OPTS[k]) input = el('select', {}, SELECT_OPTS[k].map(o => el('option', { value: o, text: o || '（空）', selected: o === s[k] })));
      else if (AREA_FIELDS.has(k)) input = el('textarea', { rows: 2, value: s[k] });
      else input = el('input', { type: 'text', value: s[k] });
      inputs[k] = input;
      return el('label', { class: `field${AREA_FIELDS.has(k) ? ' field-area' : ''}`, 'data-field': k }, el('span', { text: label }), input);
    };
    const fieldByKey = new Map(SHOT_FIELDS.map(f => [f[0], fieldEl(f)]));
    const used = new Set();
    const secs = FIELD_GROUPS.map(([gname, keys]) => {
      const items = keys.filter(k => fieldByKey.has(k) && !used.has(k)).map(k => { used.add(k); return fieldByKey.get(k); });
      return items.length ? el('section', { class: 'sb-sec' },
        el('div', { class: 'sb-sec-title', text: gname }),
        el('div', { class: 'sb-sec-grid' }, items)) : null;
    }).filter(Boolean);
    const rest = SHOT_FIELDS.map(([k]) => k).filter(k => !used.has(k)).map(k => fieldByKey.get(k));
    if (rest.length) secs.push(el('section', { class: 'sb-sec' },
      el('div', { class: 'sb-sec-title', text: '其他' }),
      el('div', { class: 'sb-sec-grid' }, rest)));
    const save = btn('保存', () => {
      const patch = {};
      for (const [k] of SHOT_FIELDS) patch[k] = k === 'duration' ? Number(inputs[k].value) : inputs[k].value;
      try { updateShot(s.id, patch); }
      catch (e) { toast(e.message, 'err', 6000); return; }
      m.close(); render();
    }, 'primary');
    const m = modal(el('div', { class: 'sb-edit' }, el('h3', { text: `编辑分镜：${s.title || '未命名'}` }),
      el('div', { class: 'sb-form' }, secs),
      el('div', { class: 'modal-actions' }, save)), { wide: true });
  }
  function importDialog() {
    const owner = store.project;
    let closed = false, epoch = 0, unsubscribe = null, preparedKind = '';
    const ta = el('textarea', { rows: 8, placeholder: '粘贴剧本文本（编号行或空行分段）或分镜 JSON：[{"title":"…","duration":5,…}]' });
    const mode = selOf([['append', '追加到现有分镜'], ['replace', '替换现有分镜']], 'append', () => renderPrev());
    const ok = btn('预览文本', () => prepareSelection([new File([ta.value], '粘贴剧本.txt', { type: 'text/plain' })], 'paste', 'auto'));
    ta.addEventListener('input', () => { if (preparedKind === 'paste') { epoch++; prepared = null; busy = false; renderPrev(); } });
    // 文件导入：选文件 → 本地解析出显式预览（逐文件名 + 分镜数）→ 应用；replace 再经显式确认
    const fileInput = el('input', { type: 'file', multiple: true, accept: '.txt,.docx,.json', class: 'sbi-file', 'aria-label': '选择脚本文件（TXT/DOCX/JSON）' });
    const enc = selOf([['auto', '编码：自动（UTF-8 / UTF-16 BOM）'], ['gb18030', '编码：GB18030（旧版 GBK 文档）']], 'auto', () => { if (preparedKind !== 'paste') return parseFiles(); });
    const prevBox = el('div', { class: 'sbi-preview' });
    let prepared = null, busy = false, lastErr = '', selectedFiles = [];
    const renderPrev = () => {
      const rows = [];
      if (busy) rows.push(el('p', { class: 'hint', text: '正在解析文件…' }));
      if (lastErr) rows.push(el('p', { class: 'sbi-error', text: lastErr }));
      if (prepared) {
        for (const f of prepared.files)
          rows.push(el('div', { class: 'sbi-row' },
            el('span', { class: 'sbi-name', text: f.name }),
            el('span', { class: 'sbi-meta', text: `${f.kind.toUpperCase()} · ${fmtBytes(f.bytes)} · ${f.shots} 个分镜` })));
        rows.push(el('p', { class: 'hint', text: `共 ${prepared.files.length} 个文件 · ${prepared.totalShots} 个分镜（${mode.value === 'replace' ? '将替换现有分镜' : '追加到现有分镜'}）` }));
        for (const f of prepared.files) rows.push(el('details', { class: 'sbi-excerpt' }, el('summary', { text: `${f.name} · 查看分镜预览` }),
          el('ol', {}, f.fields.map(s => el('li', {},
            el('b', { text: `${s.title} · ${s.duration}s` }),
            s.durationInvalid ? el('span', { class: 'badge err', text: `时长无效（${s.durationRaw}），需修正后才能生成` }) : null,
            el('p', { text: s.description || s.dialogue || s.videoPrompt || '（空分镜）' }))))));
        if (prepared.files.some(f => f.fields.some(s => s.durationInvalid)))
          rows.push(el('p', { class: 'sbi-error', text: '部分分镜时长非法或超出 1–30 秒（含小数）：导入后请先在分镜表中修正，未修正前不能生成。' }));
      }
      prevBox.replaceChildren(...rows);
      applyBtn.disabled = busy || !prepared || closed;
    };
    const prepareSelection = async (files, kind, encoding) => {
      const token = ++epoch;
      prepared = null; preparedKind = kind; lastErr = '';
      if (!files.length) { busy = false; renderPrev(); return; }
      busy = true; renderPrev();
      try {
        const result = await prepareImport(files, { encoding });
        if (closed || epoch !== token || store.project !== owner) return;
        prepared = result;
      } catch (e) { if (!closed && epoch === token) lastErr = e.message; }
      finally { if (!closed && epoch === token) { busy = false; renderPrev(); } }
    };
    const parseFiles = async () => {
      return prepareSelection(selectedFiles, 'files', enc.value);
    };
    fileInput.addEventListener('change', () => {
      selectedFiles = Array.from(fileInput.files ?? []);
      fileInput.value = ''; // 允许修正文件后再次选择同一文件名。
      return parseFiles();
    });
    const applyBtn = btn('确认导入', async () => {
      if (!prepared || busy || closed) return;
      const plan = prepared, token = epoch;
      applyBtn.disabled = true;
      try {
        const confirmReplace = async () => {
          const yes = await confirmDialog('替换现有分镜', el('div', {},
            el('p', { text: `将以 ${plan.totalShots} 个新分镜替换现有 ${shots().length} 个分镜。画布节点与素材文件保留。` }),
            el('ul', { class: 'sbi-confirm-list' }, plan.files.map(f => el('li', { text: `${f.name}（${f.shots} 个分镜）` })))));
          return yes && !closed && token === epoch;
        };
        const made = await applyImport(plan, { mode: mode.value, confirmReplace });
        if (!made) { toast('已取消替换，分镜未变更', 'info'); return; }
        toast(`导入 ${made.length} 个分镜`, 'ok'); m.close(); render();
      } catch (e) { toast(`导入失败：${e.message}`, 'err', 6000); }
      finally { if (!closed) renderPrev(); }
    }, 'primary');
    const m = modal(el('div', { class: 'sb-import' }, el('h3', { text: '导入脚本 / 文件' }),
      el('p', { class: 'hint', text: '可粘贴文本/JSON，或选择 .txt/.docx/.json 文件（≤20 个、单文件 ≤20MiB、合计 ≤40MiB）。解析预览确认后才写入；失败或取消时保留当前分镜。' }),
      el('div', { class: 'sbi-drop' },
        el('div', { class: 'row sbi-head' }, fileInput, enc),
        prevBox),
      el('details', { class: 'sbi-paste' }, el('summary', { text: '或粘贴文本 / JSON' }), ta, el('div', { class: 'row' }, ok)),
      el('div', { class: 'row sb-import-mode' }, el('span', { class: 'hint', text: '导入方式（文本与文件共用）' }), mode),
      el('div', { class: 'modal-actions' }, applyBtn)), { wide: true, onClose: () => { closed = true; epoch++; unsubscribe?.(); } });
    unsubscribe = store.onChange?.(() => { if (store.project !== owner) m.close(); });
    renderPrev();
  }
  function aiDialog() {
    const ta = el('textarea', { rows: 8, value: script().text, placeholder: '剧本全文（经文本生成节点拆分，需已配置生成能力与密钥）' });
    const cnt = el('input', { type: 'number', min: 2, max: 25, value: 9 });
    const ok = btn('AI 拆分', async () => {
      ok.disabled = true;
      try { const made = await breakdownWithAI(ta.value, { count: Number(cnt.value) || undefined }); toast(`已拆分 ${made.length} 个分镜`, 'ok'); m.close(); render(); }
      catch (e) { toast(e.message, 'err', 6000); }
      finally { ok.disabled = false; }
    }, 'primary');
    const m = modal(el('div', { class: 'sb-ai' }, el('h3', { text: 'AI 拆分分镜' }),
      el('p', { class: 'hint', text: '将创建一个「分镜拆分（AI）」文本节点并调用已配置的文本生成；失败会如实报错，不会本地编造结果。' }),
      ta, el('label', { class: 'row sb-ai-count' }, el('span', { text: '目标镜头数' }), cnt),
      el('div', { class: 'modal-actions' }, ok)), { wide: true });
  }
  function assetsDialog(s) {
    const all = Object.values(store.project.assets);
    const byCat = {};
    for (const a of all) (byCat[a.category ?? 'other'] ??= []).push(a);
    const chosen = new Set(s.assetIds);
    const wire = el('input', { type: 'checkbox' }); wire.checked = true;
    const groups = Object.entries(byCat).map(([cat, list]) => el('section', { class: 'sb-asset-cat' },
      el('h4', { text: `${ASSET_CATEGORIES[cat] ?? cat}（${list.length}）` }),
      el('div', { class: 'sb-asset-items' }, list.map(a => {
        const c = el('input', { type: 'checkbox' }); c.checked = chosen.has(a.id);
        c.addEventListener('change', () => c.checked ? chosen.add(a.id) : chosen.delete(a.id));
        return el('label', { class: 'row sb-asset' }, c, el('span', { class: 'sb-asset-name', text: `${a.name}（${KIND_LABEL[a.kind] ?? a.kind}）` }));
      }))));
    const ok = btn('应用', () => {
      updateShot(s.id, { assetIds: [...chosen] });
      if (wire.checked) {
        const r = wireShotAssets(s.id);
        if (r.problems.length) toast(`素材连线未完成（整批未接）：${r.problems.slice(0, 3).join('；')}${r.problems.length > 3 ? ` 等${r.problems.length}项` : ''}`, 'err', 6000);
        else if (r.wired) toast(`已连线 ${r.wired} 个素材${r.duplicates ? `，${r.duplicates} 个原本已接` : ''}`, 'ok');
        else if (r.duplicates) toast('所选素材均已连线', 'info');
      }
      m.close(); render();
    }, 'primary');
    const m = modal(el('div', { class: 'sb-assets' }, el('h3', { text: `分镜素材：${s.title || '未命名'}` }),
      el('div', { class: 'sb-scroll' },
        all.length ? null : el('p', { class: 'hint', text: '素材库为空' }), ...groups),
      el('label', { class: 'row sb-wire' }, wire, el('span', { text: '同时把素材连线到分镜节点' })),
      el('div', { class: 'modal-actions' }, ok)), { wide: true });
  }
  // 分镜预览建图入口（§6.3，裁决 14：入口在分镜表面板内）：
  // 预览只规划节点与连线，不发起任何生成/网络请求；应用全或无。
  function shotWorkflowDialog() {
    const ids = [...selected].filter(id => find(id));
    if (!ids.length) { toast('请先勾选要建图的分镜', 'warn'); return; }
    if (ids.length > SHOT_PLAN_MAX) { toast(`单次建图最多 ${SHOT_PLAN_MAX} 个分镜（已选 ${ids.length}）`, 'err', 6000); return; }
    const tmpl = selOf([['t2v', '纯文字视频（t2v）'], ['i2v', '图片锚点视频（i2v）'], ['ref', '素材参考视频（ref）']], 't2v', () => refresh());
    const cands = videoCandidates() ?? [];
    const modelSel = selOf([['', '自动选型（按时长×能力）'], ...cands.map(c => [c.id, `${c.id}${c.usable ? '' : '（不可用）'}`])], '', () => refresh());
    const prevBox = el('div', { class: 'sbi-preview' });
    let plan = null;
    const applyBtn = btn('应用建图', () => {
      if (!plan) return;
      try {
        const r = applyShotWorkflow(plan);
        toast(`建图完成：新建 ${r.nodes.length} 个节点、${r.edges.length} 条连线`, 'ok');
        m.close(); render();
      } catch (e) { toast(`建图未应用：${e.message}`, 'err', 7000); refresh(); }
    }, 'primary');
    const refresh = () => {
      plan = null;
      const rows = [el('p', { class: 'hint', text: '预览仅规划节点与连线，不会发起任何生成请求。' })];
      try {
        const r = previewShotWorkflow({ shotIds: ids, template: tmpl.value, modelId: modelSel.value || null });
        plan = r.plan;
        rows.push(el('p', { text: `计划：新建 ${plan.creates.length} 个节点、${plan.edges.length} 条连线；复用 ${plan.reuses.length} 个既有节点` }));
        for (const c of plan.conflicts.slice(0, 10)) rows.push(el('p', { class: 'sbi-error', text: `冲突：${c.reason}` }));
        if (plan.conflicts.length > 10) rows.push(el('p', { class: 'sbi-error', text: `…共 ${plan.conflicts.length} 项冲突` }));
        if (!r.ok) rows.push(el('p', { class: 'sbi-error', text: '存在冲突时应用会被整体拒绝（全部不建），请先逐项修正' }));
      } catch (e) { rows.push(el('p', { class: 'sbi-error', text: e.message })); }
      prevBox.replaceChildren(...rows);
      applyBtn.disabled = !plan || plan.conflicts.length > 0;
    };
    const m = modal(el('div', { class: 'sb-shotwf' },
      el('h3', { text: `分镜预览建图（${ids.length} 个分镜）` }),
      el('div', { class: 'row sb-shotwf-opts' }, tmpl, modelSel),
      prevBox,
      el('div', { class: 'modal-actions' }, applyBtn)), { wide: true });
    refresh();
  }
  function moreDialog(s) {
    const item = (t, fn) => el('div', { class: 'sb-more-item' }, btn(t, async () => { m.close(); try { await fn(); } catch (e) { toast(e.message, 'err', 6000); } render(); }));
    const m = modal(el('div', { class: 'sb-more' }, el('h3', { text: s.title || '分镜' }),
      item('上移', () => moveShot(s.id, -1)),
      item('下移', () => moveShot(s.id, 1)),
      item('建 / 定位图片节点', () => { ensureImageNode(s); deps.board?.select?.('node', s.imageNodeId); }),
      item('建 / 定位视频节点', () => {
        try { ensureVideoNode(s); deps.board?.select?.('node', s.nodeId); }
        catch (e) { toast(e.message, 'err', 6000); }   // 无兼容型号/时长越界等显式失败如实提示
      }),
      item('同步：分镜 → 节点提示词', () => { const n = syncShotToNodes(s.id); toast(`已写入 ${n} 个节点`); }),
      item('同步：节点 → 分镜提示词', () => { syncShotFromNodes(s.id); }),
      item('版本历史', () => versionsDialog(s)),
      item('删除分镜（节点保留）', async () => {
        if (await confirmDialog('删除分镜', el('p', { text: `删除「${s.title}」？画布节点保留。` }))) { selected.delete(s.id); removeShot(s.id); }
      })));
  }
  function versionsDialog(s) {
    const vs = (s.versions ?? []).map((v, i) => ({ v, i })).reverse();
    modal(el('div', { class: 'sb-versions' }, el('h3', { text: `版本：${s.title || '未命名'}` }),
      vs.length ? null : el('p', { class: 'hint', text: '尚无历史版本（首次编辑后产生）' }),
      ...vs.map(({ v, i }) => {
        const b = btn('回滚到此', () => { try { restoreVersion(s.id, i); render(); } catch (e) { toast(e.message, 'err', 6000); } });
        return el('div', { class: 'row sb-ver' }, el('span', { text: `${new Date(v.at).toLocaleString('zh-CN', { hour12: false })} · ${String(v.fields.title || '').slice(0, 20)}` }), b);
      })), { wide: true });
  }

  return {
    open, fromScript, createGrid, focusShot,
    list: shots, find, addShot, updateShot, moveShot, reorderShot, removeShot, restoreVersion,
    setScript, scriptText: () => script().text, scriptStale, scriptDirty: () => shots().some(scriptStale),
    breakdownWithAI, ensureImageNode, ensureVideoNode, wireShotAssets,
    previewShotWorkflow, applyShotWorkflow,
    healShotLinks,
    prepareImport, applyImport, importFiles,
    syncShotToNodes, syncShotFromNodes, divergence, exportCSV, batchGenerate,
  };
}
