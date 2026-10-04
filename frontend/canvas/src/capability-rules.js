// 画布侧能力规则与本地常量（contracts.md §6.5 冻结裁决 5）：
// 共享能力表 docs/星盘AI_视频模型能力表.json 是跨组件只读数据（portal/backend/deploy 共用），
// 画布不在其中塞私有规则；凡画布自有规则一律集中于此文件，由 capabilities.js 消费并转发。
// 本文件只放规则数据/常量，不放请求/存储/DOM 逻辑；改规则只改这里，不改生产渠道能力。

// ---- UI 意图 → request metadata.mode（按 family 的画布侧映射，非共享表字段） ----
// intent: 'text' 纯文字 | 'refs' 素材参考 | 'i2v' 单图 | 'frames' 首尾帧/单首帧 | 'last_frame' 仅尾帧
export const INTENTS = {
  h3: [
    { intent: 'text', mode: 'text_to_video', label: '纯文字' },
    { intent: 'refs', mode: 'omni_reference', label: '素材参考（图/视频/音频）' },
    { intent: 'frames', mode: 'frames', label: '首帧 / 首尾帧' },
    { intent: 'last_frame', mode: 'frames', label: '仅尾帧' },
  ],
  sd25: [
    { intent: 'text', mode: 'references', label: '纯文字' },
    { intent: 'refs', mode: 'references', label: '素材参考（图/视频/音频）' },
    { intent: 'frames', mode: 'frames', label: '首尾帧（两张）' },
  ],
  wan: [
    { intent: 'text', mode: 'text_to_video', label: '纯文字' },
    { intent: 'i2v', mode: 'image_to_video', label: '单图生成' },
    { intent: 'refs', mode: 'omni_reference', label: '素材参考（图/视频/音频）' },
  ],
};

// ---- 介质种类词表：可作为视频参考/上传的素材类型 ----
export const MEDIA_KINDS = ['image', 'video', 'audio'];

// ---- 型号级素材时长合同（秒）：共享表尚无 media_seconds 字段的画布侧声明；
// 表内字段存在时 mediaDurationRule 优先读表，此处仅为表外补充 ----
export const MEDIA_SECONDS_RULES = { 'minimax-h3-768p-full-slow': { min: 2, max: 15, kind_total: 15 } };

// ---- 远端素材宽限：临近过期按无效处理 ----
export const REMOTE_GRACE_MS = 60 * 1000;

// ---- image2.5 已知的 4 个型号。非 special 的标准价依赖分组基数，未经本站验证 → price=null；
// standard_estimate 为用户确认过的版本化基线估算（仅预算参考，不是实际分组价/扣费上限） ----
export const IMAGE25_MODELS = {
  'gpt-image-2.5-flare':            { display_name: 'Image 2.5 · Flare',      price: null, standard_estimate: { '1K': 0.03, '2K': 0.04, '4K': 0.06 }, estimate_version: 'image2.5-baseline-2026-09' },
  'gpt-image-2.5-sunburst':         { display_name: 'Image 2.5 · Sunburst',   price: null, standard_estimate: { '1K': 0.03, '2K': 0.04, '4K': 0.06 }, estimate_version: 'image2.5-baseline-2026-09' },
  'gpt-image-2.5-flare-special':    { display_name: '官转 image2.5 · 速度版',  price: { '1K': 0.06, '2K': 0.08, '4K': 0.11 } },
  'gpt-image-2.5-sunburst-special': { display_name: '官转 image2.5 · 细节版',  price: { '1K': 0.08, '2K': 0.11, '4K': 0.14 } },
};

// ---- 与本站图片创作页一致的 档位→比例→尺寸 表；上游拒绝 >3840 边长，4K 仅保留已验证比例 ----
export const IMAGE_SIZES = {
  '1K': { '1:1': '1024x1024', '16:9': '1536x864', '9:16': '864x1536', '4:3': '1152x864', '3:4': '864x1152' },
  '2K': { '1:1': '2048x2048', '16:9': '2560x1440', '9:16': '1440x2560', '4:3': '2048x1536', '3:4': '1536x2048' },
  '4K': { '16:9': '3840x2160', '9:16': '2160x3840' },
};
export const VALID_IMAGE_SIZES = new Set(Object.values(IMAGE_SIZES).flatMap(t => Object.values(t)));

// ---- 结果图片可信上界（本站合同 ≤3840/边；余量只为挡异常巨图） ----
export const IMAGE_DECODE_MAX_SIDE = 8192;
export const IMAGE_DECODE_MAX_PIXELS = 8192 * 4096;
// 结果图接收上限：先按 b64 字符串长度估出原始字节数，超限/非法直接拒绝
export const IMAGE_RESULT_MAX_BYTES = 48 * 1024 * 1024;
// 单张参考图上传上限
export const IMAGE_EDIT_MAX_BYTES = 30 * 1024 * 1024;
// Site upload budget; the aggregate byte limit stays the same for multiple inputs.
export const IMAGE_EDIT_MAX_REFERENCES = 8;

// ---- 从 /v1/models 原始目录挑文本型号的启发式（画布侧规则，不回写视频能力表）----
// 名称疑似对话用途；有显式 endpoints 时以端点为准（声明优先于名字猜测）
export const CHAT_NAME_RE = /chat|gpt|claude|deepseek|qwen|gemini|llama|kimi|doubao|glm|mistral|grok|ernie|spark|hunyuan|o[1-9]|minimax|abab/i;
// 名称已暴露非对话用途（图/视/音/嵌入/TTS/视频专用型号）：缺少显式端点声明时一律排除
export const NON_CHAT_NAME_RE = /image|video|audio|speech|tts|embed|whisper|transcri|voice|music|dall|flux|kling|hailuo|sora|vidu|midjourney|diffus|sdxl|wan\d|h3|upscal|moderat|rerank/i;
