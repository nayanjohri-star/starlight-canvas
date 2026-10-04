import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname, join, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkStudioBody, StudioHttpError, CHAT_JSON_LIMIT, IMAGE_JSON_LIMIT, EDIT_MULTIPART_LIMIT } from './studio-proxy.mjs';
import { requestProvider, upstreamUrl, externalImageRequest } from './external-api.mjs';
import { createMediaService } from './media-service.mjs';

export const SITE_ORIGIN = 'https://xingpan.site';
// 本机服务协议级别：/health 字段结构或页面依赖的服务接口变化时递增。页面 build-info 声明所需级别，
// 低于要求（或旧服务未报告）时页面提示「服务与页面版本不一致，请重启本机服务」。
export const SERVER_API_LEVEL = 6;
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

// 运行中进程的身份：只在创建服务时读取一次（= 本进程实际加载的代码），之后磁盘上的新文件不会冒充已加载。
function readProcessIdentity() {
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(SERVER_DIR, '..', 'package.json'), 'utf8')).version ?? 'unknown'; } catch { /* 缺失即 unknown */ }
  const h = createHash('sha256');
  try {
    for (const name of readdirSync(SERVER_DIR).filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort())
      h.update(name).update('\n').update(readFileSync(join(SERVER_DIR, name)));
  } catch { h.update('unreadable'); }
  return { version, apiLevel: SERVER_API_LEVEL, instanceId: randomUUID().slice(0, 12), startedAt: new Date().toISOString(), codeHash: h.digest('hex').slice(0, 16) };
}

// 导演台插件资源完整性（不下载、不伪造）：manifest 可解析且 id 正确、entry 存在，
// entry 页面引用的每个本地 ./assets/* 文件都存在且非空。只读检查，短时缓存。
export function checkDirectorAssets(dir) {
  const fail = reason => ({ available: false, reason, pluginVersion: null });
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); }
  catch (e) { return fail(e?.code === 'ENOENT' ? '缺少插件资源（manifest.json 不存在）' : 'manifest.json 无法解析'); }
  if (manifest?.id !== '3d-director-stage') return fail('manifest.json 不是导演台插件');
  const entry = typeof manifest.entry === 'string' ? manifest.entry : 'index.html';
  if (!/^[A-Za-z0-9_.-]+\.html$/.test(entry)) return fail('manifest.json 的 entry 不合法');
  let html;
  try { html = readFileSync(join(dir, entry), 'utf8'); } catch { return fail(`缺少入口文件 ${entry}`); }
  const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[A-Za-z0-9_.-]+)"/g)].map(m => m[1]);
  if (!refs.length) return fail('入口页面没有引用任何插件资源');
  for (const ref of refs) {
    let st = null;
    try { st = statSync(join(dir, ref)); } catch { /* 缺失 */ }
    if (!st?.isFile() || st.size === 0) return fail(`缺少插件资源文件 ${ref}`);
  }
  return { available: true, reason: null, pluginVersion: typeof manifest.version === 'string' ? manifest.version : null };
}
const MiB = 1024 * 1024;
const MEDIA_LIMITS = new Map([
  ['image/png', 30 * MiB], ['image/jpeg', 30 * MiB], ['image/webp', 30 * MiB],
  ['video/mp4', 100 * MiB], ['video/webm', 100 * MiB],
  ['audio/mpeg', 30 * MiB], ['audio/wav', 30 * MiB], ['audio/x-wav', 30 * MiB], ['audio/mp4', 30 * MiB],
]);
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'retry-after'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.cclayproject': 'application/json' };

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function error(res, status, code, message) {
  if (res.headersSent || res.destroyed) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: { code, message, type: 'canvas_error' } }));
}
function assertLocalRequest(req) {
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new HttpError(403, 'invalid_host', '仅允许通过本机地址访问画布');
  const origin = req.headers.origin;
  // A separate localhost origin isolates the third-party director from the
  // parent page's API-key input and IndexedDB. Only its static entry/assets
  // may cross between the two local origins; /site always stays same-origin.
  const directorAsset = ['GET', 'HEAD'].includes(req.method) && (/^\/director\//.test(req.url || '') || (req.url || '').split('?')[0] === '/__hub-sdk__.js');
  const otherOrigin = directorOrigin(host);
  if (origin && origin !== `http://${host}` && !(directorAsset && origin === otherOrigin)) throw new HttpError(403, 'invalid_origin', '请求来源与本机画布不一致');
  if (req.headers['sec-fetch-site'] === 'cross-site' && !directorAsset) throw new HttpError(403, 'cross_site_request', '不接受其他网站发起的请求');
  if (req.method === 'POST' && origin !== `http://${host}`) throw new HttpError(403, 'origin_required', '提交请求必须来自本机画布');
}
export function directorOrigin(host) {
  return `http://${host.startsWith('127.0.0.1:') ? 'localhost' : '127.0.0.1'}:${host.split(':').at(-1)}`;
}
function routeFor(method, pathname) {
  if (pathname === '/v1/models' && method === 'GET') return 'models';
  if (pathname === '/reference-assets' && method === 'POST') return 'upload';
  if (pathname === '/v1/videos' && method === 'POST') return 'create';
  if (/^\/v1\/videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(pathname) && method === 'GET') return 'video';
  // 停止后续渠道尝试：仅放行 POST /v1/videos/<validID>/cancel，不开放任意子路径或 DELETE 通配
  if (/^\/v1\/videos\/[A-Za-z0-9_-]+\/cancel$/.test(pathname) && method === 'POST') return 'video_cancel';
  if (pathname === '/v1/chat/completions' && method === 'POST') return 'chat';
  if (pathname === '/v1/images/generations' && method === 'POST') return 'image_gen';
  if (pathname === '/v1/images/edits' && method === 'POST') return 'image_edit';
  // 站点公开价目（可选）：固定路径 GET；不要求、也不转发任何凭据
  if (pathname === '/api/pricing' && method === 'GET') return 'pricing';
  throw new HttpError(404, 'route_not_allowed', '该接口不属于画布视频接入范围');
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large', '请求体超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJSON(req, limit) {
  const raw = await readBody(req, limit);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', '创建请求不是合法 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw new HttpError(400, 'invalid_request', '创建请求缺少模型');
  // Preserve the exact request bytes across retries; do not reserialize.
  return raw;
}
function limitedStream(req, limit, onTooLarge) {
  let size = 0;
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > limit) { const e = new HttpError(413, 'asset_too_large', '参考素材超过此类型的大小限制'); onTooLarge(e); callback(e); }
    else callback(null, chunk);
  } });
  req.on('error', e => stream.destroy(e));
  req.pipe(stream);
  return stream;
}

async function proxy(req, res, url, upstreamFetch) {
  const kind = routeFor(req.method, url.pathname.slice('/site'.length));
  if (url.search) throw new HttpError(400, 'query_not_allowed', '此接口不接受查询参数，请勿在地址中填写密钥');
  let provider;
  try { provider = requestProvider(req.headers); }
  catch (e) { throw new HttpError(e.status, e.code, e.message); }
  if (provider.id !== 'xingpan' && kind === 'pricing') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ models: {}, external: true }));
  }
  if (provider.id !== 'xingpan' && ['create', 'video', 'video_cancel', 'upload'].includes(kind) && !provider.videoEnabled)
    throw new HttpError(400, 'video_contract_required', '此服务商未启用兼容画布的视频任务协议');
  let authorization = null;
  if (kind !== 'pricing') {
    authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization) || authorization.length > 2048) throw new HttpError(401, 'key_required', '请先设置 API 密钥');
  }
  // pricing 为公开接口：绝不携带 Authorization/Cookie
  const headers = authorization ? { Authorization: authorization, Accept: 'application/json' } : { Accept: 'application/json' };
  const controller = new AbortController();
  let body; let tooLarge;
  if (kind === 'create') {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required', '创建请求需要 application/json');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new HttpError(400, 'idempotency_key_required', '创建视频必须提供有效的 Idempotency-Key');
    const length = Number(req.headers['content-length']);
    if (length > 8 * MiB) throw new HttpError(413, 'body_too_large', '创建请求超过大小限制');
    body = await readJSON(req, 8 * MiB);
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
  } else if (kind === 'video_cancel') {
    // 取消不要求专属 Idempotency-Key（同任务重复取消天然幂等）；仅 JSON 对象 + 小体量上限
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required', '取消请求需要 application/json');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 4 * 1024) throw new HttpError(413, 'body_too_large', '取消请求超过大小限制');
    const raw = await readBody(req, 4 * 1024);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid_json', '取消请求不是合法 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_request', '取消请求体必须是 JSON 对象');
    body = raw.length ? raw : Buffer.from('{}');
    headers['Content-Type'] = 'application/json';
  } else if (kind === 'upload') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const limit = MEDIA_LIMITS.get(type);
    if (!limit) throw new HttpError(415, 'unsupported_media_type', '不支持的参考素材格式');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) === 0)) throw new HttpError(400, 'empty_asset', '参考素材不能为空');
    if (Number(length) > limit) throw new HttpError(413, 'asset_too_large', '参考素材超过此类型的大小限制');
    headers['Content-Type'] = type;
    if (length !== undefined) headers['Content-Length'] = length;
    body = limitedStream(req, limit, e => { tooLarge = e; controller.abort(e); });
  } else if (kind === 'chat' || kind === 'image_gen' || kind === 'image_edit') {
    // 同步接口：不强制 Idempotency-Key（本站无 24h 幂等承诺），但请求体按窄化合同严格校验
    const contentType = req.headers['content-type'] || '';
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    try {
      if (provider.protocol === 'openai' && kind !== 'chat') {
        if (mediaType !== 'application/json') throw new StudioHttpError(415, 'json_required', '外部图片接口需要 JSON 请求');
        const raw = await readBody(req, IMAGE_JSON_LIMIT);
        const converted = externalImageRequest(kind, raw);
        body = converted.body;
        if (converted.contentType) headers['Content-Type'] = converted.contentType;
      } else if (kind === 'image_edit' && mediaType === 'multipart/form-data') {
        const length = Number(req.headers['content-length']);
        if (Number.isFinite(length) && length > EDIT_MULTIPART_LIMIT) throw new StudioHttpError(413, 'body_too_large', '编辑请求超过大小限制');
        body = await readBody(req, EDIT_MULTIPART_LIMIT);
        checkStudioBody('image_edit_multipart', body, contentType);
        headers['Content-Type'] = contentType;   // 原样转发（含 boundary）
      } else {
        if (mediaType !== 'application/json') throw new StudioHttpError(415, 'json_required', '该接口需要 application/json');
        body = await readBody(req, kind === 'image_edit' ? IMAGE_JSON_LIMIT : CHAT_JSON_LIMIT);
        checkStudioBody(kind, body, contentType);
        headers['Content-Type'] = 'application/json';
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(Number.isInteger(e?.status) ? e.status : 400,
        typeof e?.code === 'string' ? e.code : 'invalid_request',
        typeof e?.message === 'string' ? e.message : '请求不合法');
    }
  }
  if (url.pathname.endsWith('/content')) {
    headers.Accept = 'video/mp4, video/webm, application/json';
    if (req.headers.range) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) throw new HttpError(400, 'invalid_range', '仅支持单段字节范围');
      headers.Range = req.headers.range;
    }
  }
  const disconnect = () => { if (!res.writableFinished) controller.abort(); };
  res.on('close', disconnect);
  const timeout = setTimeout(() => controller.abort(), ['image_gen', 'image_edit'].includes(kind) ? 900_000 : 180_000);
  timeout.unref();
  try {
    const upstream = await upstreamFetch(new URL(upstreamUrl(provider, url.pathname.slice('/site'.length))), {
      method: req.method, headers, body, signal: controller.signal, redirect: 'manual', ...(body instanceof Readable ? { duplex: 'half' } : {}),
    });
    if (tooLarge) throw tooLarge;
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); throw new HttpError(502, 'redirect_blocked', '本站接口返回了重定向，画布未跟随，请稍后重试'); }
    if (kind === 'pricing') {
      // 只接受 200 + JSON 对象；缓冲（≤256KiB）解析后再序列化，不原样透传上游内容/标头
      if (upstream.status !== 200) { await upstream.body?.cancel(); throw new HttpError(502, 'pricing_unavailable', '价目接口暂不可用'); }
      const raw = await upstream.text();
      if (raw.length > 256 * 1024) throw new HttpError(502, 'pricing_too_large', '价目响应超过大小限制');
      let data;
      try { data = JSON.parse(raw); } catch { throw new HttpError(502, 'pricing_invalid', '价目响应不是合法 JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(502, 'pricing_invalid', '价目响应结构不合法');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(JSON.stringify(data));
    }
    // No Set-Cookie, Location, credentials, or upstream identifying headers are copied.
    const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      // fetch transparently decompresses, so the original compressed length is invalid.
      if (value && !(name === 'content-length' && upstream.headers.has('content-encoding'))) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res); else res.end();
  } catch (e) {
    if (tooLarge) throw tooLarge;
    if (e instanceof HttpError) throw e;
    if (res.destroyed) return;
    throw new HttpError(502, 'site_connection_error', '连接 API 失败；提交结果可能未确认，请保留原任务、幂等键和请求内容，核对服务商记录后再操作');
  } finally {
    clearTimeout(timeout); res.off('close', disconnect);
    if (body instanceof Readable) { req.unpipe(body); if (!body.destroyed) body.destroy(); }
  }
}

async function serveFile(req, res, root, relative, director = false) {
  const resolvedRoot = await realpath(root);
  let path;
  try { path = await realpath(resolve(resolvedRoot, relative)); } catch { throw new HttpError(404, 'file_not_found', '文件不存在，请先构建画布'); }
  if (!path.startsWith(resolvedRoot + sep)) throw new HttpError(403, 'invalid_path', '禁止访问应用目录之外的文件');
  const details = await stat(path);
  if (!details.isFile() || !MIME[extname(path).toLowerCase()]) throw new HttpError(404, 'file_not_found', '文件不存在');
  const hostedEditor = !director && existsSync(join(root, 'director', 'index.html'));
  const scriptPolicy = director ? "'self' 'unsafe-inline' 'unsafe-eval'" : hostedEditor ? "'self' blob: 'wasm-unsafe-eval'" : "'self'";
  const otherOrigin = directorOrigin(req.headers.host);
  const localFrameOrigins = `http://${req.headers.host} ${otherOrigin}`;
  // Original character/prop assets are public static resources. They are not
  // MiniMax generation endpoints and never receive the site's Authorization.
  const directorAssets = director ? ' https://cdn.hailuoai.com https://cdn.hailuoai.video https://file.cdn.minimax.io https://filecdn.minimax.chat' : '';
  // The original plugin turns its own canvas data URL into a Blob via fetch.
  // data: stays entirely local; preview videos use this known static directory.
  const directorData = director || hostedEditor ? ' data:' : '';
  const directorPreviews = director ? ' https://filecdn.minimax.chat/public/hub-plugins/3d-director-stage/campath-previews/' : '';
  // 双本机源隔离的服务端兜底（客户端 director.js 始终用对侧源嵌入，见 directorOrigin()）：
  //  · 导演台文档只允许被「对侧画布源」嵌入——frame-ancestors 精确为对侧 origin，不含 'self'/本源；
  //    同源嵌入会让带 unsafe-eval 的三方 bundle 摸到父页密钥输入与 IndexedDB，此路径由 CSP 直接封死；
  //  · 画布文档 frame-src 只放行「对侧导演台源」与本地 blob: 资源，不再放行同源 iframe；
  //  · 画布文档 frame-ancestors 仅 'self'——对侧导演台源不得反向嵌入父页（父页持有密钥输入与 IndexedDB）；
  //    父页 iframe 嵌入导演台由导演台文档自身的 frame-ancestors=对侧画布源放行，不受影响；
  //  · 导演台自身 frame-src 保持 'self' + 双本机源 + blob:，不收紧插件内部子帧/资源。
  const frameSrc = director ? `'self' ${localFrameOrigins} blob:` : `${hostedEditor ? "'self' " : ''}${otherOrigin} blob:`;
  const frameAncestors = director ? otherOrigin : `'self'`;
  res.writeHead(200, {
    'Content-Type': MIME[extname(path).toLowerCase()], 'Content-Length': details.size,
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:${directorAssets}; media-src 'self' blob: data:${directorPreviews}; connect-src 'self' blob:${directorData}${directorAssets}; worker-src 'self' blob:; frame-src ${frameSrc}; object-src 'none'; base-uri 'self'; frame-ancestors ${frameAncestors}`,
  });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(path), res);
}

export function createCanvasServer({ staticDir, directorDir, upstreamFetch = fetch, mediaService, workspaceService = null } = {}) {
  if (!staticDir || !directorDir) throw new Error('staticDir and directorDir are required');
  // 本地媒体服务：每个服务器实例一个（media-service.mjs 工厂）；测试注入同合同替身
  // handleRequest(req,res,pathname)；显式传 false 可禁用
  const media = mediaService === false ? null : (mediaService ?? createMediaService());
  const identity = readProcessIdentity();
  let directorCheck = null, directorCheckedAt = 0;
  const directorStatus = () => {
    if (existsSync(join(staticDir, 'director', 'index.html')))
      return { available: true, reason: null, pluginVersion: 'cozyclay-1.10.0-starlight' };
    if (!directorCheck || Date.now() - directorCheckedAt > 5000) { directorCheck = checkDirectorAssets(directorDir); directorCheckedAt = Date.now(); }
    return directorCheck;
  };
  return createServer(async (req, res) => {
    try {
      assertLocalRequest(req);
      const rawPath = (req.url || '/').split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'invalid_path', '地址编码无效'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..') || !rawPath.startsWith('/') || rawPath.startsWith('//')) throw new HttpError(400, 'invalid_path', '地址无效');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/site/')) return await proxy(req, res, url, upstreamFetch);
      if (url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
        if (!workspaceService) throw new HttpError(503, 'workspace_unavailable', '账户工作区服务尚未启用，本地项目仍可正常使用');
        await workspaceService.handleRequest(req, res, url.pathname + url.search);
        return;
      }
      // 本地媒体服务（GET /media/capabilities、POST /media/render）：固定路径、拒绝查询参数；
      // Origin/Sec-Fetch 已由上面的 assertLocalRequest 校验（POST 强制本机 Origin）
      if (media && url.pathname.startsWith('/media/')) {
        if (url.search) throw new HttpError(400, 'query_not_allowed', '媒体接口不接受查询参数');
        await media.handleRequest(req, res, url.pathname);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'method_not_allowed', '不支持此请求方法');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
          ok: true, service: 'xingpan-canvas', upstream: SITE_ORIGIN, externalApi: true,
          // 运行中进程身份（启动时确定）：页面据此判断前后端是否匹配，不读磁盘上的新版本冒充
          version: identity.version, apiLevel: identity.apiLevel,
          instance: { id: identity.instanceId, startedAt: identity.startedAt, codeHash: identity.codeHash },
          director_url: `${directorOrigin(req.headers.host)}/director/`,
          // 导演台为开发中功能：插件资源不随仓库分发；完整性按 manifest/entry/引用资源逐项检查
          director: (({ available, reason, pluginVersion }) => ({ available, reason, pluginVersion }))(directorStatus()),
          director_available: directorStatus().available }));
      }
      if (url.pathname.startsWith('/director/')) {
        if (existsSync(join(staticDir, 'director', 'index.html')))
          return await serveFile(req, res, staticDir, url.pathname.slice(1));
        const path = url.pathname.slice('/director/'.length) || 'index.html';
        if (!/^(?:index\.html|favicon\.svg|assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|jpg|webp|woff2))$/.test(path)) throw new HttpError(404, 'file_not_found', '文件不存在');
        return await serveFile(req, res, directorDir, path, true);
      }
      return await serveFile(req, res, staticDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    } catch (e) {
      // Never expose exception details, user URLs, request bodies, or credentials.
      error(res, e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.code : 'local_service_error', e instanceof HttpError ? e.message : '本地服务暂时不可用，请确认已构建应用且参考目录仍在原位置');
    }
  });
}
