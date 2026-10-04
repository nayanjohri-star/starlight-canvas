// 托管验收拓扑（测试辅助，不是生产代码）。只模拟供应商与 New API 的数据面，不模拟托管安全边界：
//   · /canvas/*：按 deploy/canvas-web/Caddyfile 的语义提供 dist-hosted（响应头直接读该 Caddyfile）；
//     只允许 GET/HEAD；未知路径 404（不回退到 index）；/canvas → 308 /canvas/。
//   · /canvas-api/*：Sol 的真实适配层 deploy/canvas-hosted-api/server.mjs（每次请求核验 Key 的账户、
//     subject 一致性、路由白名单、新建幂等键要求、取消 501、上传限额、禁止重定向）。
//   · 适配层背后：合成 New API（本文件 syntheticNewApi）——合成用户与令牌、按用户隔离的任务与幂等、
//     与 New API 相同的“他人任务 = task_not_exist”语义、模拟视频供应商。New API 自身授权代码由其 Go 测试覆盖。
// 设置 CANVAS_HOSTED_URL 时改用外部拓扑（CI：真实 Caddy 容器 + 独立适配层进程），本进程只运行合成 New API。
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const REPO_ROOT = join(ROOT, '..', '..');
export const HOSTED_DIST = process.env.CANVAS_HOSTED_DIST || join(ROOT, 'dist-hosted');
const CADDYFILE = join(REPO_ROOT, 'deploy', 'canvas-web', 'Caddyfile');
const ADAPTER = join(REPO_ROOT, 'deploy', 'canvas-hosted-api', 'server.mjs');
export const SYNTHETIC_SESSION_BRIDGE = 'canvas-test-only-session-bridge-not-a-production-secret';
const syntheticSession = key => `cs1.synthetic.${createHash('sha256').update(key).digest('hex')}`;

// 从 canvas-web Caddyfile 的 header 块读取安全头（唯一来源）
export function caddyHeaders() {
  const text = readFileSync(CADDYFILE, 'utf8');
  const start = text.indexOf('\theader {');
  const block = text.slice(start, text.indexOf('\t}', start));
  const out = {};
  for (const line of block.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^([A-Za-z-]+)\s+(?:"(.*)"|(\S+))$/);
    if (m && !m[1].startsWith('-')) out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const cacheControlFor = path => (path === '/canvas/' || path === '/canvas/index.html' ? 'no-store' : 'no-cache');
const listen = srv => new Promise((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)); });
const stop = srv => { srv.closeAllConnections?.(); return new Promise(r => srv.close(r)); };

export async function startHostedTopology({ newApi, dist = HOSTED_DIST, imageJobsDir } = {}) {
  if (!newApi) throw new Error('需要合成 New API（syntheticNewApi）');
  if (process.env.CANVAS_HOSTED_URL) {
    const port = Number(process.env.CANVAS_HOSTED_BACKEND_PORT);
    if (!Number.isInteger(port)) throw new Error('CANVAS_HOSTED_URL 需要同时设置 CANVAS_HOSTED_BACKEND_PORT');
    const gwPort = Number(process.env.CANVAS_HOSTED_GATEWAY_PORT);
    if (!Number.isInteger(gwPort)) throw new Error('外部拓扑还需要 CANVAS_HOSTED_GATEWAY_PORT（适配层 VIDEO_API_URL 指向的合成视频网关）');
    const api = createServer(newApi.handler), gw = createServer(newApi.gatewayHandler);
    await new Promise((r, j) => { api.once('error', j); api.listen(port, '127.0.0.1', r); });
    await new Promise((r, j) => { gw.once('error', j); gw.listen(gwPort, '127.0.0.1', r); });
    return { origin: process.env.CANVAS_HOSTED_URL.replace(/\/$/, ''), external: true, close: async () => { await stop(api); await stop(gw); } };
  }
  if (!existsSync(join(dist, 'runtime-config.js'))) throw new Error(`缺少托管构建：${dist}（先运行 node scripts/build.mjs --mode hosted）`);
  const headers = caddyHeaders();
  const backend = createServer(newApi.handler);
  const backendOrigin = await listen(backend);
  const gateway = createServer(newApi.gatewayHandler);
  const gatewayOrigin = await listen(gateway);
  let adapterPort = null;
  const front = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/canvas') { res.writeHead(308, { Location: '/canvas/' }); return res.end(); }
    if (url.pathname === '/canvas-api' || url.pathname.startsWith('/canvas-api/')) {
      // 与主 Caddy 片段一致：原样转给适配层（不改路径、不加认证）
      const up = httpRequest({ host: '127.0.0.1', port: adapterPort, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      return req.pipe(up);
    }
    if (url.pathname.startsWith('/canvas/')) {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('method not allowed'); }
      const rel = decodeURIComponent(url.pathname.slice('/canvas/'.length) || 'index.html');
      const file = normalize(join(dist, rel));
      if (!file.startsWith(normalize(dist) + sep) || rel.split('/').some(p => p.startsWith('.')) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
      }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cacheControlFor(url.pathname) });
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  });
  const origin = await listen(front);
  const { createHostedApiServer } = await import(pathToFileURL(ADAPTER).href);
  const adapter = createHostedApiServer({ newApiBase: backendOrigin, videoApiBase: gatewayOrigin, assetsBase: backendOrigin, publicOrigin: origin, sessionBridgeKey: SYNTHETIC_SESSION_BRIDGE, imageJobsDir });
  adapterPort = Number(new URL(await listen(adapter)).port);
  return { origin, external: false, close: async () => { await stop(front); await stop(adapter); await stop(backend); await stop(gateway); } };
}

// 合成 New API + 合成视频任务网关（只模拟数据面与供应商，路由与授权语义按 hosted-api-contract.md 的最终视频路由）：
//   · 视频新建经网关：返回 vjob_<32 位小写十六进制>；幂等按“原 Key 的 SHA-256 + 幂等键”限定；
//     首次被查询时建立内部 New API 任务 task_<32 位字母数字>（相当于网关已单次提交计费核心）。
//   · 网关原生 vjob_ 查询与内容是公开分享能力（不校验 Key）；账户授权由适配层先调 New API 所有权端点：
//     GET /api/usage/token/canvas-video-ownership/:id —— 排队期对照 Key 哈希，已有内部任务时对照任务所属用户；
//     204 = 属于当前用户，他人或不存在一律 404。
//   · New API 的 /v1/videos POST 不应被托管路径调用（计数为 directVideoPosts，测试断言为 0）。

const hex = n => [...Array(n)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const alnum = n => [...Array(n)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
const sha = s => createHash('sha256').update(s).digest('hex');

export function syntheticNewApi({ tokens = { 'sk-synth-alice': 1, 'sk-synth-alice-2': 1, 'sk-synth-bob': 2 }, names = { 1: 'alice', 2: 'bob' },
  videoBytes, models, completeAfterGets = 2, imagePng = null } = {}) {
  const state = { creates: [], queries: [], downloads: [], uploads: [], denied: [], images: [], identityChecks: 0, ownershipChecks: 0,
    directVideoPosts: 0, tasks: new Map(), revoked: new Set(), idem: new Map(),
    holdNext: 0, failContentNext: 0, failQueries: new Map(), failContent: new Map() };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const keyOf = req => /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const userOf = req => { const k = keyOf(req); return k && !state.revoked.has(k) ? tokens[k] ?? null : null; };
  const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  // ---- 合成 New API ----
  const handler = async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/internal/canvas/ready' || p === '/internal/canvas/session') {
      if (keyOf(req) !== SYNTHETIC_SESSION_BRIDGE) return json(res, 401, { code: 'auth_required' });
      if (p.endsWith('/ready')) return json(res, 200, { ready: true });
      const key = Object.keys(tokens).find(k => syntheticSession(k) === req.headers['x-canvas-session']);
      if (!key || state.revoked.has(key)) return json(res, 401, { code: 'auth_required' });
      return json(res, 200, { subject: `u${tokens[key]}`, key, fingerprint: sha(key).slice(0, 16) });
    }
    if (p === '/api/pricing') return json(res, 200, { success: true, data: [] });
    const uid = userOf(req);
    if (p === '/api/usage/token/canvas-identity') {
      state.identityChecks++;
      return uid ? json(res, 200, { success: true, data: { subject: `u${uid}`, display_name: names[uid] } }) : json(res, 401, { success: false, message: 'invalid token' });
    }
    if (!uid) return json(res, 401, { error: { message: '无效的令牌', type: 'new_api_error' } });
    const own = /^\/api\/usage\/token\/canvas-video-ownership\/(vjob_[a-f0-9]{32})$/.exec(p);
    if (own && req.method === 'GET') {
      state.ownershipChecks++;
      const job = state.tasks.get(own[1]);
      const mine = job && (job.internal ? job.owner === uid : job.keyHash === sha(keyOf(req)));
      if (!mine) { if (job) state.denied.push({ uid, task: own[1] }); return json(res, 404, { success: false, message: 'not found' }); }
      res.writeHead(204); return res.end();
    }
    if (p === '/v1/models' && req.method === 'GET') return json(res, 200, { data: models.map(id => ({ id })) });
    if (p === '/v1/images/generations' && req.method === 'POST') {
      state.images.push({ uid, body: JSON.parse((await body(req)).toString('utf8')) });
      return json(res, 200, { data: [{ b64_json: Buffer.from(state.imagePng ?? imagePng ?? []).toString('base64') }] });
    }
    if (p === '/reference-assets' && req.method === 'POST') {
      const b = await body(req); state.uploads.push({ uid, size: b.length });
      const ct = String(req.headers['content-type'] ?? '').split(';')[0];
      const kind = ct.startsWith('image/') ? 'image' : ct.startsWith('video/') ? 'video' : 'audio';
      const id = hex(64);
      return json(res, 200, { id, url: `https://xingpan.site/reference-assets/${id}.${ct.split('/')[1] ?? 'bin'}`, kind, content_type: ct, size: b.length, expires_at: Math.floor(Date.now() / 1000) + 86000, duration_seconds: kind === 'image' ? null : 2 });
    }
    if (p === '/v1/videos' && req.method === 'POST') { state.directVideoPosts++; return json(res, 500, { error: { code: 'unexpected', message: '托管视频新建不应直达 New API' } }); }
    const legacy = /^\/v1\/videos\/(task_[A-Za-z0-9]{32})(\/content)?$/.exec(p);
    if (legacy) return json(res, 400, { error: { code: 'task_not_exist', message: 'task not found' } });
    return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
  };

  // ---- 合成视频任务网关 ----
  const gatewayHandler = async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/v1/videos' && req.method === 'POST') {
      const uid = userOf(req);
      if (!uid) return json(res, 401, { error: { code: 'invalid_api_key', message: '无效的令牌' } });
      const raw = (await body(req)).toString('utf8');
      const keyHash = sha(keyOf(req));
      const ik = `${keyHash}:${req.headers['idempotency-key']}`;
      if (state.idem.has(ik)) return json(res, 200, { id: state.idem.get(ik), task_id: state.idem.get(ik), status: 'queued', executor_version: 2 });
      let model = null; try { model = JSON.parse(raw).model; } catch { /* 非 JSON */ }
      const jobId = `vjob_${hex(32)}`;
      state.creates.push({ uid, key: req.headers['idempotency-key'], model, jobId });
      state.tasks.set(jobId, { owner: uid, keyHash, internal: null, gets: 0, status: 'queued', hold: state.holdNext > 0 ? (state.holdNext--, true) : false });
      state.idem.set(ik, jobId);
      if (state.failContentNext > 0) { state.failContentNext--; state.failContent.set(jobId, 1); }
      return json(res, 200, { id: jobId, task_id: jobId, status: 'queued', executor_version: 2 });
    }
    const m = /^\/v1\/videos\/(vjob_[a-f0-9]{32})(\/content)?$/.exec(p);
    if (m && req.method === 'GET') {
      const t = state.tasks.get(m[1]);
      if (!t) return json(res, 404, { error: { code: 'task_not_found', message: 'not found' } });
      if (m[2]) {
        const cf = state.failContent.get(m[1]) ?? 0;
        if (cf > 0) { state.failContent.set(m[1], cf - 1); return json(res, 502, { error: { code: 'upstream_error', message: 'delivery failed' } }); }
        if (t.expired) return json(res, 410, { error: { code: 'download_expired', message: 'expired' } });
        if (t.status !== 'completed') return json(res, 409, { error: { code: 'not_ready', message: 'not ready' } });
        state.downloads.push({ task: m[1] });
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(videoBytes.length) });
        return res.end(Buffer.from(videoBytes));
      }
      state.queries.push({ task: m[1] });
      const qf = state.failQueries.get(m[1]) ?? 0;
      if (qf > 0) { state.failQueries.set(m[1], qf - 1); return json(res, 503, { error: { code: 'upstream_unavailable', message: 'busy' } }); }
      if (!t.internal) t.internal = `task_${alnum(32)}`;   // 网关已单次提交计费核心，建立内部任务
      t.gets++; t.status = t.hold ? 'in_progress' : t.gets >= completeAfterGets ? 'completed' : 'in_progress';
      const done = t.status === 'completed';
      return json(res, 200, { id: m[1], status: t.status, executor_version: 2, progress: done ? 100 : 40, stage: done ? 'succeeded' : 'running', content_ready: done,
        delivery_status: done ? (t.expired ? 'expired' : 'ready') : undefined, download_expired: t.expired || undefined, download_expires_at: done && !t.expired ? Math.floor(Date.now() / 1000) + 3600 : undefined });
    }
    return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
  };

  return {
    state, handler, gatewayHandler, revoke: key => state.revoked.add(key),
    holdNext: n => { state.holdNext = n; },
    release: id => { const t = state.tasks.get(id); if (t) t.hold = false; },
    held: () => [...state.tasks].filter(([, t]) => t.hold).map(([id]) => id),
    failQueries: (id, n) => state.failQueries.set(id, n),
    failContent: (id, n) => state.failContent.set(id, n),
    failNextContent: n => { state.failContentNext = n; },
    expire: id => { const t = state.tasks.get(id); if (t) t.expired = true; },
    setImage: bytes => { state.imagePng = bytes; },
  };
}

// Synthetic topology supplies a login cookie, then uses the real adapter and
// browser bootstrap. Full password/MFA/session authorization is covered by the
// separate real-New-API launch staging and production browser checks.
export async function signIn(page, key, { expectOk = true } = {}) {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: 'new_api_canvas', value: syntheticSession(key), url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(`${origin}/canvas/`);
  if (expectOk) await page.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 20000 });
}
// 在任务中心取回成片：可能已被自动取回（行随之重建），先等自动取回，仍待下载才点击“恢复下载”
export async function downloadViaTaskCenter(page, taskId, openDock) {
  await openDock(page, 'task');
  const rowSel = `#task-list .task-item[data-task-id="${taskId}"]`;
  await page.waitForFunction(s => ['ready_to_download', 'local_verified'].includes(document.querySelector(s)?.dataset.taskState), rowSel, { timeout: 30000 });
  const auto = await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'local_verified', rowSel, { timeout: 5000 }).then(() => true, () => false);
  if (!auto) await page.locator(rowSel).getByRole('button', { name: '恢复下载' }).click();
  await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'local_verified', rowSel, { timeout: 30000 });
  return rowSel;
}
