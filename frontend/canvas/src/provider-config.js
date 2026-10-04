// Shared by the local proxy and browser. Profiles contain no credentials.
export const DEFAULT_PROVIDER = Object.freeze({ id: 'xingpan', name: '星盘', baseUrl: 'https://xingpan.site', protocol: 'site', textModels: [], imageModels: [], videoEnabled: true });
export const EXTERNAL_IMAGE_SIZES = Object.freeze({ '1K': Object.freeze({ '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }) });

export function normalizeApiBase(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\s\\%?#]/.test(value) || /\/\.{1,2}(?:\/|$)/.test(value)) throw new Error('API 地址无效');
  let u;
  try { u = new URL(value); } catch { throw new Error('请填写完整的 API 地址'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('外部 API 需使用 HTTPS；本机接口可用 HTTP');
  if (u.username || u.password || u.search || u.hash || /%|\/\//.test(u.pathname)) throw new Error('API 地址不能包含密钥、查询参数或转义路径');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function modelNames(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/);
  const out = [...new Set(items.map(x => String(x).trim()).filter(Boolean))];
  if (out.length > 200 || out.some(x => x.length > 256 || /[\s\u0000-\u001f]/.test(x))) throw new Error('型号名称无效，请每行填写一个型号');
  return out;
}

export function normalizeProvider(value) {
  if (value?.id === DEFAULT_PROVIDER.id) return { ...DEFAULT_PROVIDER };
  const id = value?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('服务商编号无效');
  const name = String(value.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('请填写服务商名称（最多 80 字）');
  if (!['openai', 'site'].includes(value.protocol)) throw new Error('不支持的 API 协议');
  return { id, name, baseUrl: normalizeApiBase(value.baseUrl), protocol: value.protocol,
    textModels: modelNames(value.textModels), imageModels: modelNames(value.imageModels),
    videoEnabled: value.protocol === 'site' && value.videoEnabled === true };
}

export const isExternalProvider = p => p?.id !== DEFAULT_PROVIDER.id;
export const providerContext = p => isExternalProvider(p) ? `${p.baseUrl}\n${p.protocol}` : '';
export function providerHeaders(p) {
  return !isExternalProvider(p) ? {} : { 'X-Canvas-Api-Base': encodeURIComponent(p.baseUrl), 'X-Canvas-Api-Protocol': p.protocol,
    'X-Canvas-Video-Contract': p.videoEnabled ? '1' : '0' };
}
export function upstreamUrl(p, path) {
  return p.baseUrl.replace(/\/v1$/, '') + path;
}

export function manualCatalog(p) {
  return [...p.textModels.map(id => ({ id, endpoints: ['/v1/chat/completions'] })),
    ...p.imageModels.map(id => ({ id, endpoints: ['/v1/images/generations'] }))];
}
