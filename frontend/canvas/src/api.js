// /site 本机代理客户端。浏览器内 base 默认 '/site'；测试可注入 base 与 fetch。
// 所有方法经 getKey() 取内存密钥；密钥永不进 URL、不落地。
import { createAccountScopedStorage } from './storage.js';
import { DEFAULT_PROVIDER, providerContext, providerHeaders, isExternalProvider } from './provider-config.js';

const verifiedHostedScopes = new WeakMap();

export class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message || code || `HTTP ${status}`);
    this.status = status; this.code = code || ''; this.retryAfter = retryAfter ?? null;
  }
}

function retryAfterSeconds(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(h);                       // HTTP-date 形式
  if (Number.isFinite(t)) return Math.max(1, Math.ceil((t - Date.now()) / 1000));
  return null;
}

async function parseErrorBody(res) {
  let code = '', message = '';
  try {
    const data = await res.json();
    if (data && data.error) { code = data.error.code || ''; message = data.error.message || ''; }
    else if (data && typeof data === 'object') { code = data.code || ''; message = data.message || ''; }
  } catch { /* 非 JSON 错误体 */ }
  return new ApiError(res.status, code, message, retryAfterSeconds(res));
}

const VIDEO_TYPES = ['video/mp4', 'video/webm'];

// 校验 206 Content-Range，返回区间应收字节数。rangeStart=null 表示未请求分段：
// 仅接受可验证覆盖全文的区间（0-(total-1)/total），局部内容不得冒充完整成片入库。
// rangeStart=N 对应请求 bytes=N-（到末尾）：起点必须一致且必须覆盖到 total-1。
function checkedContentRange(header, rangeStart) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header || '');
  if (!m || m[3] === '*')
    throw new ApiError(206, 'bad_content_range', `非法 Content-Range：${header || '缺失'}`);
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total)
    throw new ApiError(206, 'bad_content_range', `Content-Range 区间越界：${header}`);
  if (rangeStart != null) {
    if (start !== rangeStart) throw new ApiError(206, 'range_mismatch', `分段起点不符：请求 ${rangeStart}，返回 ${start}`);
    if (end !== total - 1) throw new ApiError(206, 'incomplete_content', `分段未覆盖到末尾：${header}`);
  } else if (start !== 0 || end !== total - 1) {
    throw new ApiError(206, 'incomplete_content', `未请求分段却收到局部内容：${header}`);
  }
  return end - start + 1;
}

// 完整成片不得是 JSON/文本错误页被错标为 video/*：负向嗅探（真实 mp4/webm 绝不会以 { [ < 开头）。
// 分段中段（起点>0）位于文件内部无法判定，由调用方在拼接完整后自行校验。
async function looksLikeErrorPage(blob) {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const text = new TextDecoder().decode(head).trimStart();
  return text.startsWith('{') || text.startsWith('[') || text.startsWith('<');
}

function hostedBase(base) {
  if (typeof base !== 'string' || base.startsWith('//'))
    throw new Error('托管 API 必须使用同源路径');
  const origin = globalThis.location?.origin ?? 'http://127.0.0.1';
  const url = new URL(base, origin);
  if (url.origin !== origin || url.pathname !== '/canvas-api' || url.search || url.hash)
    throw new Error('托管 API 必须使用同源 /canvas-api 路径');
  return base;
}

export async function openHostedCanvasSession({ storage, getKey, fetchImpl = fetch, base = '/canvas-api' } = {}) {
  hostedBase(base);
  if (!storage) throw new TypeError('需要项目存储');
  const key = getKey?.();
  if (typeof key !== 'string' || !key) throw new ApiError(401, 'key_required', '请先输入本站 API Key');
  const options = { method: 'GET', credentials: key.startsWith('cs1.') ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'manual' };
  const featureResponse = await fetchImpl(base + '/features', options);
  if (!featureResponse.ok) throw await parseErrorBody(featureResponse);
  const features = await featureResponse.json().catch(() => null);
  if (features?.mode !== 'hosted' || features.apiVersion !== 1 || typeof features.features?.cancel !== 'boolean')
    throw new ApiError(502, 'unsupported_hosted_api', '托管 API 版本或能力声明不兼容');
  const identityResponse = await fetchImpl(base + '/identity', {
    ...options, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (getKey?.() !== key) throw new ApiError(409, 'identity_changed', '密钥已切换，已丢弃旧身份响应');
  if (!identityResponse.ok) throw await parseErrorBody(identityResponse);
  const identity = await identityResponse.json().catch(() => null);
  if (getKey?.() !== key) throw new ApiError(409, 'identity_changed', '密钥已切换，已丢弃旧身份响应');
  if (!/^u[1-9][0-9]*$/.test(identity?.subject ?? ''))
    throw new ApiError(502, 'bad_identity', '身份响应缺少有效账户标识');
  const scope = createAccountScopedStorage(storage, { subject: identity.subject });
  verifiedHostedScopes.set(scope, key);
  const api = createSiteClient({ mode: 'hosted', base, getKey, fetchImpl, scope, imageJobs: features.features.imageJobs === true });
  return { identity, features, storage: scope, api, invalidate: () => scope.invalidate() };
}

export function createSiteClient({ mode = 'local', base = mode === 'hosted' ? '/canvas-api' : '/site',
  getKey, fetchImpl, scope, imageJobs = false, getProvider = () => DEFAULT_PROVIDER } = {}) {
  const doFetch = fetchImpl ?? fetch.bind(globalThis);
  const hosted = mode === 'hosted';
  if (mode !== 'local' && !hosted) throw new Error('未知画布 API 模式');
  if (hosted) {
    hostedBase(base);
    if (scope?.mode !== 'hosted' || typeof scope.assertActive !== 'function' ||
        !verifiedHostedScopes.has(scope) || verifiedHostedScopes.get(scope) !== getKey?.())
      throw new Error('托管 API 需要已核验的账户存储会话');
  }
  const sessionKey = hosted ? getKey?.() : null;
  const responseIdentity = new WeakMap();
  let externalReady = null;
  const provider = () => hosted ? DEFAULT_PROVIDER : getProvider();
  const liveIdentity = () => `${providerContext(provider())}\n${getKey?.() ?? ''}`;
  function checkResponse(res) {
    checkLive();
    if (!hosted && responseIdentity.has(res) && responseIdentity.get(res) !== liveIdentity())
      throw new ApiError(0, 'identity_changed', '服务商或密钥已切换，旧请求已失效；已提交的结果仍需核对');
  }
  async function checkExternalService() {
    if (!externalReady) externalReady = (async () => {
      const res = await doFetch(base.replace(/\/site$/, '') + '/health', { credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const h = res.ok ? await res.json().catch(() => null) : null;
      if (h?.service !== 'xingpan-canvas' || h?.externalApi !== true || h?.apiLevel < 6)
        throw new ApiError(503, 'external_api_unavailable', '请重启新版本机服务后再使用外部 API');
    })().catch(e => { externalReady = null; throw e; });
    return externalReady;
  }
  function checkLive() {
    if (!hosted) return;
    scope.assertActive();
    if (!sessionKey || getKey?.() !== sessionKey)
      throw new ApiError(409, 'identity_changed', '密钥已切换，旧请求已失效');
  }
  function key() {
    checkLive();
    const k = getKey?.();
    if (!k) throw new ApiError(401, 'key_required', '请先输入本站 API Key');
    return k;
  }
  async function request(path, { method = 'GET', headers = {}, body, signal } = {}) {
    const selected = provider(), identity = liveIdentity(), bearer = key();
    if (!hosted && isExternalProvider(selected)) {
      if (/^\/v1\/videos|^\/reference-assets/.test(path) && !selected.videoEnabled)
        throw new ApiError(400, 'video_contract_required', '此服务商未启用兼容画布的视频任务协议');
      await checkExternalService();
      if (identity !== liveIdentity()) throw new ApiError(409, 'identity_changed', '服务商或密钥已切换，请重新操作');
    }
    const res = await doFetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, ...(!hosted ? providerHeaders(selected) : {}),
        ...(hosted ? { 'X-Canvas-Subject': scope.subject } : {}), ...headers },
      body,
      signal,
      redirect: 'manual',
      ...(hosted ? { credentials: sessionKey.startsWith('cs1.') ? 'same-origin' : 'omit', cache: 'no-store' } : {}),
    });
    responseIdentity.set(res, identity);
    checkResponse(res);
    if (!res.ok) {
      const error = await parseErrorBody(res);
      checkResponse(res);
      // Some gateways echo an invalid credential in their error body. Such
      // errors can become durable operation records, so remove the exact key.
      const scrub = value => String(value ?? '').split(bearer).join('[密钥已隐藏]');
      error.message = scrub(error.message);
      error.code = scrub(error.code);
      throw error;
    }
    return res;
  }
  async function readJson(res) {
    const value = await res.json();
    checkResponse(res);
    return value;
  }
  async function waitImageJob(id, { signal } = {}) {
    if (!hosted || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new ApiError(0, 'invalid_image_job', '图片任务编号无效');
    const deadline = Date.now() + 20 * 60 * 1000;
    let errors = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const res = await request(`/v1/images/jobs/${encodeURIComponent(id)}`, { signal });
        const data = await readJson(res);
        if (res.status === 200) return data;
        if (res.status !== 202 || data?.id !== id || data.status !== 'processing')
          throw new ApiError(0, 'bad_image_job', '图片任务状态无法确认');
        errors = 0;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (e.code === 'image_job_rejected') throw e;
        if (['image_job_uncertain', 'image_job_expired', 'identity_changed', 'auth_required'].includes(e.code)
          || ++errors > 5) throw new ApiError(0, e.code, e.message);
      }
      await new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, 3000);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new ApiError(0, 'image_job_wait_timeout', '图片仍未取得结果，可稍后查询原任务；请勿重新生成。');
  }
  async function sendImage(path, bodyString, { signal, operationId } = {}) {
    const asyncJob = hosted && imageJobs && operationId;
    try {
      const res = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(asyncJob ? { 'X-Canvas-Image-Job': operationId } : {}) }, body: bodyString, signal });
      if (!asyncJob || res.status !== 202) return readJson(res);
      await res.body?.cancel();
    } catch (e) {
      if (!asyncJob || signal?.aborted || (e.status >= 400 && e.status < 500)) throw e;
      // Lost acceptance response: query the pre-persisted ID, never POST twice.
    }
    return waitImageJob(operationId, { signal });
  }
  return {
    providerInfo: () => ({ id: provider().id, name: provider().name, baseUrl: provider().baseUrl, protocol: provider().protocol }),
    supportsImageJobs: hosted && imageJobs,
    waitImageJob,
    async identity() {
      if (!hosted) throw new ApiError(404, 'not_hosted', '本机模式没有托管身份');
      const data = await readJson(await request('/identity'));
      if (data?.subject !== scope.subject) throw new ApiError(409, 'identity_changed', '账户身份已变更');
      return data;
    },
    async listModels({ signal } = {}) {
      const res = await request('/v1/models', { signal });
      return readJson(res);
    },
    // 公开价目（可选能力）：固定路径 GET；不携带 Authorization、不转发 Cookie。
    // 只接受 JSON 对象——供「标准价」参考；不得据此推断实际分组价，绝不 eval 其中任何字段。
    async pricing({ signal } = {}) {
      checkLive();
      if (!hosted && isExternalProvider(provider())) return { models: {}, external: true };
      const res = await doFetch(base + '/api/pricing', {
        method: 'GET', headers: { Accept: 'application/json' }, signal, redirect: 'manual',
        ...(hosted ? { credentials: 'omit', cache: 'no-store' } : {}),
      });
      checkLive();
      if (!res.ok) {
        const error = await parseErrorBody(res);
        checkLive();
        throw error;
      }
      const data = await res.json().catch(() => null);
      checkLive();
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new ApiError(200, 'bad_response', '价目响应不是合法 JSON 对象');
      return data;
    },
    async uploadAsset(file, { signal } = {}) {
      const res = await request('/reference-assets', { method: 'POST', headers: { 'Content-Type': file.type }, body: file, signal });
      return readJson(res);
    },
    // bodyString 必须是持久化时的原始字节，重试不得重新序列化
    async createTask(bodyString, idempotencyKey) {
      const res = await request('/v1/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: bodyString,
      });
      return readJson(res);
    },
    async getTask(id) {
      const res = await request(`/v1/videos/${encodeURIComponent(id)}`);
      return readJson(res);
    },
    // 停止后续渠道尝试（H3 v2 父任务）：固定路径 POST + JSON 空对象；
    // 响应即同一公开任务结构——按响应 status 继续跟踪，绝不本地直接标终态
    async cancelTask(id) {
      const res = await request(`/v1/videos/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return readJson(res);
    },
    // 返回 { status, contentType, blob, contentRange }；严格仅 200/206 + video/mp4|video/webm。
    // 未请求分段绝不把局部 206 当完整成片：仅接受可验证覆盖全文的区间且实收字节=total；
    // bytes=N- 请求要求返回起点=N、end=total-1、实收字节=区间长；任何不符即拒绝入库。
    async downloadContent(id, { rangeStart } = {}) {
      const start = rangeStart == null ? null : Number(rangeStart);
      if (start != null && (!Number.isSafeInteger(start) || start < 0))
        throw new ApiError(0, 'invalid_range', `非法下载起点：${rangeStart}`);
      const headers = {};
      if (start != null) headers.Range = `bytes=${start}-`;
      const res = await request(`/v1/videos/${encodeURIComponent(id)}/content`, { headers });
      if (res.status !== 200 && res.status !== 206) throw await parseErrorBody(res);
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!VIDEO_TYPES.includes(contentType)) {
        await res.text().catch(() => '');
        throw new ApiError(res.status, 'unexpected_content_type', `下载返回非视频类型（${contentType || '未知'}）`);
      }
      const contentRange = res.headers.get('content-range');
      const expected = res.status === 206 ? checkedContentRange(contentRange, start) : null;
      // 分段请求被回 200：服务端忽略 Range 返回完整内容，status 如实返回，按完整内容校验
      const blob = await res.blob();
      checkResponse(res);
      const declared = res.headers.get('content-length');
      if (declared != null && !res.headers.get('content-encoding')) {
        if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
          throw new ApiError(res.status, 'bad_content_length', `非法 Content-Length：${declared}`);
        if (Number(declared) !== blob.size)
          throw new ApiError(res.status, 'truncated_content', `下载字节不完整：声明 ${declared}，实收 ${blob.size}`);
      }
      if (expected != null && blob.size !== expected)
        throw new ApiError(206, 'truncated_content', `分段字节不完整：区间 ${contentRange}，实收 ${blob.size}`);
      if (res.status === 200 && blob.size === 0)
        throw new ApiError(200, 'empty_content', '下载内容为空');
      if ((res.status === 200 || (start ?? 0) === 0) && await looksLikeErrorPage(blob))
        throw new ApiError(res.status, 'not_video_payload', '返回内容疑似 JSON/文本而非视频，已拒绝');
      return { status: res.status, contentType, blob, contentRange };
    },
    // ---- 同步文本/图片接口（本站合同）。这些调用没有 24h 幂等承诺：
    // 防重复扣费完全由调用方的持久化操作守卫负责，客户端自身绝不自动重放。
    async chatCompletion(bodyString, { signal } = {}) {
      const res = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyString,
        signal,
      });
      return readJson(res);
    },
    async imageGeneration(bodyString, options = {}) {
      return sendImage('/v1/images/generations', bodyString, options);
    },
    // edits 统一走 JSON dataURL：字节确定，可与持久化操作摘要一一对应
    async imageEdit(bodyString, options = {}) {
      return sendImage('/v1/images/edits', bodyString, options);
    },
  };
}

// ---- 响应形态校验（本站合同）：只接受合同字段；绝不返回 url 让调用方去拉取外部地址 ----
export function chatResponseText(data) {
  const c = data?.choices?.[0];
  const t = c?.message?.content ?? c?.text;
  if (typeof t !== 'string' || !t.trim()) throw new ApiError(200, 'bad_response', '对话响应缺少文本内容');
  return t;
}
export function imageResponseB64(data) {
  const item = data?.data?.[0];
  if (!item || typeof item.b64_json !== 'string' || !item.b64_json.trim())
    throw new ApiError(200, 'bad_response', '图片响应缺少 b64_json（本站不支持代拉 url 结果）');
  return item.b64_json;
}
