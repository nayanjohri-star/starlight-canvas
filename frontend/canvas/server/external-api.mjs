import { DEFAULT_PROVIDER, normalizeApiBase, upstreamUrl } from '../src/provider-config.js';
import { checkStudioBody, IMAGE_JSON_LIMIT, StudioHttpError } from './studio-proxy.mjs';

export function requestProvider(headers) {
  const value = headers['x-canvas-api-base'];
  if (value == null) {
    if (headers['x-canvas-api-protocol'] != null) throw new StudioHttpError(400, 'invalid_provider', '服务商配置不完整');
    return DEFAULT_PROVIDER;
  }
  try {
    const protocol = headers['x-canvas-api-protocol'];
    if (!['site', 'openai'].includes(protocol)) throw new Error();
    return { id: 'external', protocol, baseUrl: normalizeApiBase(decodeURIComponent(value)), videoEnabled: headers['x-canvas-video-contract'] === '1' && protocol === 'site' };
  } catch { throw new StudioHttpError(400, 'invalid_provider', '服务商地址或协议无效'); }
}
export { upstreamUrl };

// Generic image APIs receive standard multipart edits. The browser keeps an
// exact JSON request for its durable operation guard; no external URL is fetched.
export function externalImageRequest(kind, raw) {
  let b;
  try { b = JSON.parse(raw.toString('utf8')); } catch { throw new StudioHttpError(400, 'invalid_json', '图片请求不是合法 JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.model !== 'string' || !b.model || b.model.length > 256)
    throw new StudioHttpError(400, 'bad_model', '图片型号无效');
  if (raw.length > IMAGE_JSON_LIMIT) throw new StudioHttpError(413, 'body_too_large', '图片请求超过大小限制');
  // Reuse the existing prompt/size/reference byte validation with an internal
  // model placeholder and matching size. Only the real model/standard size pass on.
  const allowed = new Set(['model', 'prompt', 'size', 'n', 'response_format', 'image', 'images']);
  if (Object.keys(b).some(k => !allowed.has(k)) || !['1024x1024', '1536x1024', '1024x1536'].includes(b.size))
    throw new StudioHttpError(400, 'unsupported_field', '外部图片请求包含不支持的参数或尺寸');
  checkStudioBody(kind, Buffer.from(JSON.stringify({ ...b, model: 'gpt-image-2.5-flare', size: '1024x1024' })));
  if (kind === 'image_gen') {
    if (/^gpt-image-/i.test(b.model)) delete b.response_format; // GPT Image always returns base64.
    return { body: JSON.stringify(b), contentType: 'application/json' };
  }
  if (/^dall-e-/i.test(b.model)) throw new StudioHttpError(400, 'edit_not_supported', '此适配器不支持 DALL-E 参考图编辑');
  const form = new FormData();
  for (const k of ['model', 'prompt', 'size', 'n']) form.set(k, String(b[k]));
  if (!/^gpt-image-/i.test(b.model)) form.set('response_format', 'b64_json');
  for (const [i, url] of (b.images ?? [b.image]).entries()) {
    const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    form.append('image[]', new Blob([Buffer.from(m[3], 'base64')], { type: m[1] }), `reference-${i + 1}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`);
  }
  return { body: form, contentType: null };
}
