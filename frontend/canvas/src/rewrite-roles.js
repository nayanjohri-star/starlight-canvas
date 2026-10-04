// AI 改写：角色（改写前注入的提示词）与改写记录。纯数据，不依赖界面。
//
// 角色保存在项目里（project.studio.rewriteRoles），随工程包导出导入：
//  · 内置角色可以修改、隐藏、恢复默认；项目里只存与默认不同的部分；
//  · 用户可以新增、复制、删除自己的角色。
//
// 其中「分镜润色（图像提示词）」「图生视频润色」「参考生视频润色」三段提示词取自开源项目
// iFrame Studio（garage.uniart.fun，设置 → 默认 Prompt），经原开发者同意原样使用。
// 原文面向其自身流水线：含 {DRAFT}/{ASSETS}/{SLOTS} 占位符、要求输出 prompt_cn/prompt_en 的 JSON。
// 这里不改动原文，只在发送前填入占位符（renderRolePrompt），并从返回的 JSON 里取出中文提示词作为改写结果
// （parseRewriteOutput），英文版一并保存。

export const MAX_VERSIONS = 5;
export const MAX_ROLES = 60;

const SCREENWRITER = `你是一名专业的影视编剧，擅长把零散的想法、小说片段或口语化描述改写成结构清晰、有画面感的分场剧本。

规则：
1. 保留原文的核心人物、情节与情绪走向，不臆造原文没有的关键剧情；可以补充必要的场景、动作与对白，使其可拍摄。
2. 使用以下剧本格式：
   - 场景标题行：编号 地点 [时间] [内/外]，例如「1-1 城门 [黄昏] [外]」
   - 人物行：人物：角色名1，角色名2
   - 动作描述：以「△」开头，一行一个主要动作，写看得见、拍得到的内容
   - 对白：角色名（情绪）：对白内容；画外音写作「角色名 (V.O.)：」
3. 语言使用简体中文，简洁、具体，避免空泛的形容。
4. 如果用户给出了改写要求（场数、字数、风格等），优先满足。
5. 只输出剧本正文，不要解释、不要加 Markdown 标题或代码块。`;

const POLISH = `你是一名资深中文编辑。请在保留原意、事实与关键信息的前提下润色用户提供的文字：
1. 修正错别字、病句与标点，理顺逻辑与段落衔接；
2. 语言简洁、自然、具体，去掉空话和重复；
3. 保留原文中的专有名词、数字、@图片1 这类素材引用和 [characterN:name] 这类标签，原样不动；
4. 如果用户给出了改写要求（语气、长度、受众等），优先满足；
5. 只输出润色后的正文，不要解释修改了什么。`;

// ---- 以下三段取自 iFrame Studio 默认 Prompt（原样，经原开发者同意）----
const SHOT_POLISH = `# 角色
你是一名资深分镜师与提示词工程师。你的任务是把一段草稿提示词改写成高质量的图像生成提示词，专用于多参考图（multi-reference）工作流。

# 背景
用户已选定若干参考图（素材）来构成一个画面。
在提示词中描述这些素材时，你必须用它们的 Image ID（如 "Image 1"、"Image 2"）来指代。

# 可用素材
{ASSETS}

# 规则
1.  **整合素材**：描述对应的角色、场景或道具时，显式写出 "Image X"。
2.  **自然连贯**：不要简单拼接。要写成连贯的句子或段落来描述视觉画面。
3.  **严格忠实**：不要臆造草稿中不存在的情绪、动作或剧情。若草稿写 "坐着"，不要擅自加 "悲伤地" 或 "开心地"，除非草稿明确写明。保持叙述中性、准确。
4.  **丰富细节**：可基于草稿补充视觉细节（光线、氛围、情绪），但要保持素材指代清晰。
5.  **不要解释**：只返回润色后的提示词文本。
6.  **双语输出**：
    - **Prompt CN**：流畅中文，严格遵循草稿内容。
    - **Prompt EN**：自然英文描述，优先体现视觉氛围。

# 输出格式
严格返回一个 JSON 对象：
{{
    "prompt_cn": "含 Image X 指代的中文描述……",
    "prompt_en": "English cinematic description with Image X references..."
}}

# 示例
**输入草稿**：男孩（Image 1）坐在病床（Image 2）上。
**输出**：
{{
    "prompt_cn": "图像1中的男孩坐在图像2的病床边缘。病房内光线柔和，自然光从侧面照射在男孩身上，勾勒出真实的轮廓。画面构图稳定，质感写实。",
    "prompt_en": "The boy from Image 1 is seated on the edge of the hospital bed in Image 2. Soft natural light illuminates the scene from the side, highlighting the fabric textures of the bedding and the realistic skin tone of the boy. Cinematic composition, high resolution, photorealistic."
}}

# 用户草稿提示词
{DRAFT}`;

const I2V_POLISH = `你是一名资深视频提示词工程师。你的任务是为「图生视频」（Image-to-Video）模型优化一段草稿提示词。

准则：
1.  **结构**：提示词 = 运动描述 + 镜头运动。
2.  **运动描述**：描述图像中各元素（角色、物体）的动态动作。用副词控制速度与强度（如 "缓慢地"、"快速地"、"轻微的"）。
3.  **镜头运动**：如有需要，显式说明镜头移动（如 "推近"、"向左平移"、"固定镜头"）。
4.  **清晰**：简洁但具体，聚焦视觉运动。

示例：

*   **拉远（Zoom Out）**："一个柔软圆润的动画角色带着好奇的表情醒来，发现自己的床是一颗巨大的金色玉米粒。镜头拉远，露出整个房间原来是一座巨大的玉米仓，回声四起，玉米粒堆得像墙一样高，一束温暖的阳光从高处的窗户洒入，投下长长的影子。"
*   **向左平移（Pan Left）**："镜头向左平移，缓缓扫过一扇奢华的橱窗，里面满是光鲜的模特与昂贵商品。镜头继续向左，离开橱窗，露出隔壁巷子角落里一个衣衫褴褛、瑟瑟发抖的流浪汉。"

任务：
按上述准则，把下面的草稿提示词改写成高质量的视频生成提示词。

输出格式：
严格返回一个 JSON 对象：
{{
    "prompt_cn": "润色后的中文视频提示词，关注运动和镜头",
    "prompt_en": "Polished English video prompt, focusing on motion and camera"
}}`;

const R2V_POLISH = `# 角色
你是参考生视频（Reference-to-Video）模型的提示词工程师。

# 背景
R2V（Reference-to-Video）模型通过把参考角色视频与文本提示词结合来生成视频片段。
用户已上传以下参考视频：
{SLOTS}

用户输入的提示词中可能已包含写作 [characterN:name] 的参考标签（例如 [character1:小兔子]）。
这些标签是指代某个 slot 的规范写法——characterN 是模型需要的 slot 编号，:name 是便于你和
用户辨认每个 slot 对应哪个角色的可读标签。模型通过对标签内 "characterN" 的字面匹配来解析
slot，因此 :name 后缀不会干扰——它只是补充可见的上下文。

# 任务
严格遵循以下规则，把用户输入的提示词改写成结构化格式：

1. **原样保留 [characterN:name] 标签**。不要去掉方括号、slot 编号或 :name 后缀。
   只要指代 SLOTS 列表中存在的角色，就写出完整标签（例如 [character1:小兔子]）——
   绝不要只写裸的 "character1"，也绝不要只写不带标签的角色名 "小兔子"。如果输入中有
   未加括号、但能与某个 SLOTS 条目匹配的角色名，首次指代时把它转换为完整的
   [characterN:name] 形式；同一段提示词中后续指代可复用该完整标签。
   **同一角色的每次提及都复用同一个 slot 编号。** slot 编号由上面的 SLOTS 列表按角色固定——
   [character1:小兔子] 被引用三次，三次都保持 [character1:小兔子]。不要为已有 slot 的角色
   臆造新的 slot 编号（如 [character3:小兔子]）。每个 slot 与一张参考图 1:1 对应，新增 slot
   会破坏模型对参考图数量的预期。
2. **结构**：使用如下格式：
   - 场景设定（环境、光线、氛围）
   - 角色动作（[characterN:name] 在做什么、表情、动作）
   - 镜头运动（如适用）
3. **对白格式**：若提示词包含对白，按如下格式书写：
   '[character1:name] says: "对白内容"'
4. **保留意图**：保持原有意图与情绪基调。
5. **强化**：补充视觉细节以增强戏剧效果（光线、"缓慢地"/"快速地" 等速度副词）。

# 输出格式
严格返回一个 JSON 对象：
{{
    "prompt_cn": "润色后的中文提示词，保留 [characterN:name] 完整标签",
    "prompt_en": "Polished English prompt, preserving [characterN:name] tags verbatim"
}}

# 示例

输入：主角从门里跳出来说话
SLOTS：character1 = "White rabbit / 小兔子", character2 = "Robot dog / 机械狗"
输出：
{{
    "prompt_cn": "[character1:小兔子] 从门里猛然跳出，落地时耳朵竖起，充满活力。房间昏暗，温暖的光线从尘土飞扬的窗户中透入。[character1:小兔子] 兴奋地环顾四周说道：'我正好赶上了！' 镜头随着跳跃略微倾斜。",
    "prompt_en": "[character1:White rabbit] bursts through the door with an exaggerated jump, landing energetically with ears perked up. The room is dimly lit with warm ambient light streaming through dusty windows. [character1:White rabbit] looks around excitedly and says: 'I made it just in time!' Camera follows the jump with a slight tilt."
}}`;

export const BUILTIN_ROLES = [
  { id: 'screenwriter', name: '专业编剧', desc: '把想法或小说片段改写成分场剧本', prompt: SCREENWRITER },
  { id: 'shot-polish', name: '分镜润色', desc: '把草稿改写成多参考图的图像提示词（中英双语）', prompt: SHOT_POLISH, source: 'iframe-studio' },
  { id: 'i2v-polish', name: '图生视频润色', desc: '专为 MiniMax H3 首帧/首尾帧模式：改写成「运动 + 镜头」的视频提示词（中英双语）', prompt: I2V_POLISH, source: 'iframe-studio', scope: 'h3-frames' },
  { id: 'r2v-polish', name: '参考生视频润色', desc: '专为 MiniMax H3 素材参考模式：保留素材与角色标签的视频提示词（中英双语）', prompt: R2V_POLISH, source: 'iframe-studio', scope: 'h3-refs' },
  { id: 'polish', name: '文字润色', desc: '保留原意，修正并润色文字', prompt: POLISH },
];
export const DEFAULT_ROLE_ID = 'screenwriter';

// 适用范围：空 = 通用；h3-frames / h3-refs = 只给 MiniMax H3 的「首帧/首尾帧」或「素材参考」模式用。
// H3 以外的视频型号、以及 H3 的其他模式都不显示这类角色。
export const ROLE_SCOPES = {
  '': { label: '通用', short: '' },
  'h3-frames': { label: '仅 MiniMax H3 · 首帧/首尾帧模式', short: 'H3 首尾帧', intents: ['frames', 'last_frame'] },
  'h3-refs': { label: '仅 MiniMax H3 · 素材参考模式', short: 'H3 素材参考', intents: ['refs'] },
};
// h3Intents：当前场景下可用的 H3 模式集合（例如下游 H3 视频节点的模式，或正在编辑的 H3 节点本身的模式）
export function roleFits(role, h3Intents = new Set()) {
  const scope = ROLE_SCOPES[role?.scope ?? ''];
  if (!scope?.intents) return true;
  return scope.intents.some(i => h3Intents.has(i));
}
// 某个 H3 模式对应的专用改写角色
export const roleIdForH3Intent = intent => ['frames', 'last_frame'].includes(intent) ? 'i2v-polish' : intent === 'refs' ? 'r2v-polish' : null;
const BUILTIN = new Map(BUILTIN_ROLES.map(r => [r.id, r]));
export const isBuiltinRole = id => BUILTIN.has(id);
export const builtinRole = id => BUILTIN.get(id) ?? null;

// 占位符在画布里的含义：素材在草稿中写作 @图片N / @视频N，下游节点靠它绑定素材，所以要求原样保留。
const ASSETS_NOTE = '本画布中，素材在草稿里写作 @图片1、@图片2、@视频1……（依次对应 Image 1、Image 2……）。请在 prompt_cn 与 prompt_en 中都沿用 @图片N / @视频N 的写法指代素材，不要改写成 Image N，也不要新增草稿里没有的编号。';
const SLOTS_NOTE = '本画布没有单独提供参考视频列表。草稿中的 [characterN:name] 标签，以及 @图片N / @视频N 这类素材引用，都请原样保留，不要新增编号。';

const str = (v, max) => typeof v === 'string' && v.length <= max;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// 项目里存的角色：内置角色只存改动（name/desc/prompt/hidden），自定义角色存完整内容。
export function sanitizeRewriteRoles(input) {
  if (!Array.isArray(input)) return null;
  const out = [], seen = new Set();
  for (const r of input.slice(0, MAX_ROLES)) {
    if (!isObj(r) || !str(r.id, 64) || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const role = { id: r.id };
    if (str(r.name, 64) && r.name.trim()) role.name = r.name;
    if (str(r.desc, 200)) role.desc = r.desc;
    if (str(r.prompt, 50000)) role.prompt = r.prompt;
    if (r.hidden === true) role.hidden = true;
    if (typeof r.scope === 'string' && r.scope in ROLE_SCOPES && r.scope) role.scope = r.scope;
    if (!isBuiltinRole(r.id) && (!role.name || typeof role.prompt !== 'string')) continue;   // 自定义角色必须完整
    out.push(role);
  }
  return out;
}

// 项目当前可用的角色：内置（套上项目里的改动）在前，自定义在后。
export function resolveRoles(project, { includeHidden = false } = {}) {
  const saved = project?.studio?.rewriteRoles ?? [];
  const byId = new Map(saved.map(r => [r.id, r]));
  const list = BUILTIN_ROLES.map(b => {
    const o = byId.get(b.id) ?? {};
    return { ...b, ...o, scope: b.scope ?? '', builtin: true, modified: ['name', 'desc', 'prompt'].some(k => k in o && o[k] !== b[k]) };
  });
  for (const r of saved) if (!isBuiltinRole(r.id)) list.push({ desc: '', scope: '', ...r, builtin: false, modified: false });
  return includeHidden ? list : list.filter(r => !r.hidden);
}
export function findRole(project, id) {
  return resolveRoles(project, { includeHidden: true }).find(r => r.id === id) ?? null;
}

// 写回项目：内置角色只保留与默认不同的字段，没有改动就不存。
export function saveRoles(project, roles) {
  const out = [];
  for (const r of roles) {
    const b = builtinRole(r.id);
    if (b) {
      const diff = { id: r.id };
      for (const k of ['name', 'desc', 'prompt']) if (typeof r[k] === 'string' && r[k] !== b[k]) diff[k] = r[k];
      // 内置角色的适用范围固定（H3 专用提示词不能挪给其他型号）
      if (r.hidden) diff.hidden = true;
      if (Object.keys(diff).length > 1) out.push(diff);
    } else out.push({ id: r.id, name: r.name, desc: r.desc ?? '', prompt: r.prompt ?? '', ...(r.scope ? { scope: r.scope } : {}) });
  }
  project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  project.studio.rewriteRoles = sanitizeRewriteRoles(out);
  return project.studio.rewriteRoles;
}

// 发送前组装：提示词里带 {DRAFT}/{text} 的角色把原文放进提示词里整体作为用户消息；
// 其他角色的提示词作为系统提示，原文（加改写要求）作为用户消息。
export function renderRolePrompt(promptText, { source, request } = {}) {
  const draft = request?.trim() ? `${source}\n\n【改写要求】${request.trim()}` : String(source ?? '');
  let t = String(promptText ?? '').replace(/\{\{/g, '{').replace(/\}\}/g, '}');
  const inline = /\{(DRAFT|text)\}/.test(t);
  t = t.replace(/\{ASSETS\}/g, ASSETS_NOTE).replace(/\{SLOTS\}/g, SLOTS_NOTE).replace(/\{entities_str\}/g, '（未提供）');
  if (inline) return { system: '', prompt: t.replace(/\{(DRAFT|text)\}/g, () => draft) };
  return { system: t, prompt: draft };
}

// 模型按角色要求返回 {prompt_cn, prompt_en} 时取中文作为结果、英文另存；其他情况原样作为结果。
export function parseRewriteOutput(raw) {
  const text = String(raw ?? '').trim();
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (body.startsWith('{')) {
    try {
      const j = JSON.parse(body);
      if (isObj(j) && typeof j.prompt_cn === 'string' && j.prompt_cn.trim())
        return { text: j.prompt_cn.trim(), en: typeof j.prompt_en === 'string' ? j.prompt_en.trim() : '' };
    } catch { /* 不是合法 JSON：按普通文本处理 */ }
  }
  return { text, en: '' };
}

// 节点上的改写状态：所选角色、改写要求、本次临时改过的提示词、最近 5 版结果。
export function sanitizeRewriteState(r) {
  if (!isObj(r)) return null;
  const out = {};
  if (str(r.roleId, 64)) out.roleId = r.roleId;
  if (str(r.request, 20000)) out.request = r.request;
  if (str(r.promptOverride, 50000)) out.promptOverride = r.promptOverride;
  if (Array.isArray(r.history)) {
    out.history = r.history.filter(h => isObj(h) && str(h.text, 200000)).slice(-MAX_VERSIONS).map(h => ({
      text: h.text,
      ...(str(h.en, 200000) && h.en ? { en: h.en } : {}),
      ...(typeof h.at === 'number' && Number.isFinite(h.at) ? { at: h.at } : {}),
      ...(str(h.roleId, 64) ? { roleId: h.roleId } : {}),
      ...(str(h.roleName, 64) ? { roleName: h.roleName } : {}),
      ...(str(h.model, 256) ? { model: h.model } : {}),
      ...(typeof h.ms === 'number' && Number.isFinite(h.ms) && h.ms >= 0 ? { ms: h.ms } : {}),
    }));
  }
  if (Number.isInteger(r.index)) out.index = Math.max(0, Math.min((out.history?.length ?? 1) - 1, r.index));
  return out;
}

// 新结果入列：保留最近 5 版，当前指向最新一版。
export function pushVersion(state, entry) {
  const s = state ?? {};
  const history = [...(s.history ?? []), entry].slice(-MAX_VERSIONS);
  return { ...s, history, index: history.length - 1 };
}
