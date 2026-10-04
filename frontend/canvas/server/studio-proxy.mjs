// 画布 /site 代理的窄化放行校验：文本对话与 image2.5 图片接口。
// 只放行本站明确支持的形态——固定 4 个 image2.5 型号、枚举尺寸（4K ≤3840）、
// n=1、b64_json；参考图最多 8 张、合计 30MiB，不拉取外部 URL。

export class StudioHttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const err = (status, code, message) => { throw new StudioHttpError(status, code, message); };

const MiB = 1024 * 1024;
export const CHAT_JSON_LIMIT = 8 * MiB;
export const IMAGE_JSON_LIMIT = 45 * MiB;      // dataURL 约 4/3 膨胀 + 余量
export const EDIT_MULTIPART_LIMIT = 34 * MiB;
export const EDIT_IMAGE_MAX = 30 * MiB;
const IMAGE_EDIT_MAX_REFERENCES = 8;

export const IMAGE_MODELS = new Set([
  'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare-special', 'gpt-image-2.5-sunburst-special',
]);
const CHAT_FIELDS = new Set(['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'response_format', 'user']);
const IMAGE_FIELDS = new Set(['model', 'prompt', 'size', 'resolution', 'aspect_ratio', 'n', 'response_format', 'quality', 'user']);
const EDIT_FIELDS = new Set([...IMAGE_FIELDS, 'image', 'images']);
const VALID_SIZES = new Set(['1024x1024', '1536x864', '864x1536', '1152x864', '864x1152', '2048x2048', '2560x1440', '1440x2560', '2048x1536', '1536x2048', '3840x2160', '2160x3840']);
const DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/;

function sniff(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function checkSizeShape(get) {
  const size = get('size'), res = get('resolution'), ar = get('aspect_ratio');
  if (size != null && (res != null || ar != null)) err(400, 'conflicting_size', 'size 与 resolution/aspect_ratio 不能同时传');
  if (size != null) {
    if (typeof size !== 'string' || !/^\d{3,5}x\d{3,5}$/.test(size)) err(400, 'bad_size', 'size 需为 宽x高 形式');
    const [w, h] = size.split('x').map(Number);
    if (!w || !h || w > 3840 || h > 3840) err(400, 'size_out_of_range', '边长需 ≤3840');
    if (!VALID_SIZES.has(size)) err(400, 'bad_size', 'size 不在本站支持范围');
  }
  if (res != null || ar != null) {
    if (!['1K', '2K', '4K'].includes(res)) err(400, 'bad_resolution', 'resolution 需为 1K/2K/4K');
    if (typeof ar !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(ar)) err(400, 'bad_aspect', 'aspect_ratio 需为 宽:高 形式');
  }
}

function checkImageCommon(obj, fields) {
  for (const k of Object.keys(obj)) if (!fields.has(k)) err(400, 'unsupported_field', `不允许的字段：${k}`);
  if (typeof obj.model !== 'string' || !IMAGE_MODELS.has(obj.model)) err(400, 'unsupported_model', '仅支持 image2.5 系列型号');
  if (typeof obj.prompt !== 'string' || !obj.prompt.trim() || obj.prompt.length > 100000) err(400, 'bad_prompt', 'prompt 缺失或超长');
  if (obj.n !== 1) err(400, 'bad_n', '仅支持 n=1');
  if (obj.response_format !== 'b64_json') err(400, 'bad_response_format', '仅支持 b64_json 返回（本站不支持代拉 url 结果）');
  if (obj.quality != null && obj.quality !== 'default') err(400, 'bad_quality', '仅支持默认质量');
  if (obj.user != null && (typeof obj.user !== 'string' || obj.user.length > 256)) err(400, 'bad_user', 'user 字段不合法');
  checkSizeShape(k => obj[k]);
}

function checkChat(obj) {
  for (const k of Object.keys(obj)) if (!CHAT_FIELDS.has(k)) err(400, 'unsupported_field', `不允许的字段：${k}`);
  if (typeof obj.model !== 'string' || !obj.model || obj.model.length > 256) err(400, 'bad_model', '缺少型号');
  if (obj.stream !== false) err(400, 'stream_required_false', '仅支持 stream:false 的同步调用');
  if (!Number.isInteger(obj.max_tokens) || obj.max_tokens < 1 || obj.max_tokens > 128000)
    err(400, 'bad_max_tokens', '必须显式给出 1–128000 的 max_tokens');
  if (!Array.isArray(obj.messages) || !obj.messages.length || obj.messages.length > 200) err(400, 'bad_messages', 'messages 需为 1–200 条');
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || !['system', 'user', 'assistant'].includes(m.role)
      || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 200000)
      err(400, 'bad_messages', 'message 结构不合法');
    for (const k of Object.keys(m)) if (!['role', 'content', 'name'].includes(k)) err(400, 'bad_messages', `message 含不支持字段：${k}`);
  }
  for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'])
    if (obj[k] != null && (typeof obj[k] !== 'number' || !Number.isFinite(obj[k]))) err(400, 'bad_param', `${k} 需为有限数字`);
  if (obj.stop != null && !(typeof obj.stop === 'string' || (Array.isArray(obj.stop) && obj.stop.length <= 8 && obj.stop.every(x => typeof x === 'string' && x.length < 500))))
    err(400, 'bad_stop', 'stop 字段不合法');
  if (obj.response_format != null && (typeof obj.response_format !== 'object' || obj.response_format === null || !['text', 'json_object'].includes(obj.response_format.type)))
    err(400, 'bad_response_format', 'response_format 仅支持 text/json_object');
}

function checkEditImageField(image) {
  const m = typeof image === 'string' ? DATAURL_RE.exec(image) : null;
  if (!m) err(400, 'bad_image', 'image 必须为单张 PNG/JPEG/WebP 的 data URL');
  let bytes;
  try { bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { err(400, 'bad_image', 'image base64 解码失败'); }
  if (!bytes.length) err(400, 'bad_image', 'image 内容为空');
  if (bytes.length > EDIT_IMAGE_MAX) err(413, 'image_too_large', '参考图超过 30MiB 上限');
  if (sniff(bytes) !== `image/${m[1]}`) err(400, 'bad_image', '参考图内容与声明格式不符');
  return bytes.length;
}

const textField = (fields, name) => {
  const f = fields.get(name);
  return f && f.filename == null ? f.data.toString('utf8').trim() : null;
};

export function parseMultipart(buffer, contentType) {
  const m = /boundary="?([^"\s;]+)"?/i.exec(contentType || '');
  if (!m) err(400, 'bad_multipart', 'multipart 缺少 boundary');
  const boundary = Buffer.from('--' + m[1]);
  const fields = new Map();
  let pos = buffer.indexOf(boundary);
  while (pos >= 0) {
    let p = pos + boundary.length;
    if (buffer[p] === 0x2D && buffer[p + 1] === 0x2D) break;   // 结束边界
    if (buffer[p] === 0x0D && buffer[p + 1] === 0x0A) p += 2;
    const headEnd = buffer.indexOf('\r\n\r\n', p);
    if (headEnd < 0) break;
    const head = buffer.slice(p, headEnd).toString('latin1');
    const next = buffer.indexOf(boundary, headEnd + 4);
    const end = (next < 0 ? buffer.length : next) - 2;         // 去掉边界前的 CRLF
    const data = buffer.slice(headEnd + 4, Math.max(headEnd + 4, end));
    const name = /name="([^"]+)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim().toLowerCase();
    if (name) {
      const part = { filename, contentType: ctype, data };
      if (fields.has(name)) {
        if (!['image', 'image[]'].includes(name)) err(400, 'bad_multipart', '重复的表单参数');
        fields.set(name, [...[fields.get(name)].flat(), part]);
      } else fields.set(name, part);
    }
    pos = next;
  }
  return fields;
}

function checkEditMultipart(fields) {
  if (!fields.size) err(400, 'bad_multipart', 'multipart 内容为空');
  for (const k of fields.keys()) if (!IMAGE_FIELDS.has(k) && !['image', 'image[]'].includes(k)) err(400, 'unsupported_field', `不允许的字段：${k}`);
  const model = textField(fields, 'model');
  if (!IMAGE_MODELS.has(model)) err(400, 'unsupported_model', '仅支持 image2.5 系列型号');
  const prompt = textField(fields, 'prompt');
  if (!prompt || prompt.length > 100000) err(400, 'bad_prompt', 'prompt 缺失或超长');
  if (textField(fields, 'n') !== '1') err(400, 'bad_n', '仅支持 n=1');
  if (textField(fields, 'response_format') !== 'b64_json') err(400, 'bad_response_format', '仅支持 b64_json 返回');
  const quality = textField(fields, 'quality');
  if (quality != null && quality !== 'default') err(400, 'bad_quality', '仅支持默认质量');
  checkSizeShape(k => textField(fields, k));
  const images = [...fields.keys()].filter(k => k === 'image' || /^image[[\]._]/.test(k));
  if (images.length !== 1) err(400, 'bad_image', '请使用 image 或 image[] 上传，不能混用');
  const uploads = [fields.get(images[0])].flat();
  if (uploads.length > IMAGE_EDIT_MAX_REFERENCES) err(400, 'bad_image', '本站最多支持 8 张参考图');
  let total = 0;
  for (const img of uploads) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(img.contentType)) err(415, 'bad_image_type', '参考图仅支持 PNG/JPEG/WebP');
    total += img.data.length;
    if (!img.data.length || total > EDIT_IMAGE_MAX) err(413, 'image_too_large', '参考图为空或合计超过 30MiB');
    if (sniff(img.data) !== img.contentType) err(400, 'bad_image', '参考图内容与声明格式不符');
  }
}

// kind: 'chat' | 'image_gen' | 'image_edit' | 'image_edit_multipart'；校验通过返回 undefined，否则抛 StudioHttpError
export function checkStudioBody(kind, buffer, contentType = '') {
  if (kind === 'image_edit_multipart') return checkEditMultipart(parseMultipart(buffer, contentType));
  let obj;
  try { obj = JSON.parse(buffer.toString('utf8')); } catch { err(400, 'invalid_json', '请求不是合法 JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) err(400, 'invalid_request', '请求结构不合法');
  if (kind === 'chat') return checkChat(obj);
  if (kind === 'image_gen') return checkImageCommon(obj, IMAGE_FIELDS);
  if (kind === 'image_edit') {
    checkImageCommon(obj, EDIT_FIELDS);
    if (obj.image !== undefined && obj.images !== undefined) err(400, 'bad_image', 'image 和 images 不能混用');
    const images = obj.images ?? [obj.image];
    if (!Array.isArray(images) || !images.length || images.length > IMAGE_EDIT_MAX_REFERENCES)
      err(400, 'bad_image', '请选择 1–8 张参考图');
    let total = 0;
    for (const image of images) {
      total += checkEditImageField(image);
      if (total > EDIT_IMAGE_MAX) err(413, 'image_too_large', '参考图合计超过 30MiB');
    }
    return;
  }
  err(404, 'route_not_allowed', '该接口不属于画布接入范围');
}
