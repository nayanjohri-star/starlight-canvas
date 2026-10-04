// E2E 共享辅助：mock 上游、真实媒体样本、通用操作。
// 被 e2e.test.mjs（默认画布回归）与 e2e-director.test.mjs（暂缓的导演台回归）复用。
// 依赖合同（裁决10/11）：playwright-core 优先解析 canvas 自身 node_modules，
// portal node_modules 为兼容回退；缺依赖给明确提示而非栈崩溃；缺资源一律语义化 skip。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return { pw: require('playwright-core'), from: 'canvas:node_modules' }; }
  catch (e1) {
    try { return { pw: require('../../portal/node_modules/playwright-core'), from: 'portal:node_modules' }; }
    catch (e2) {
      throw new Error(
        'E2E 依赖缺失：请先在 frontend/canvas 运行 npm install（playwright-core 已声明 devDependency），' +
        '或 npm run test:env 查看环境清单；portal node_modules 回退亦不可用。\n' +
        `  canvas 解析错误：${e1.message}\n  portal 回退错误：${e2.message}`);
    }
  }
}
const { pw: playwright, from: PLAYWRIGHT_FROM } = loadPlaywright();
export const { chromium } = playwright;
export { PLAYWRIGHT_FROM };
export const { createCanvasServer } = await import('../server/app.mjs');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(ROOT, '..', '..');
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const MP4 = [...readFileSync(join(FIXTURES, 'sample.mp4'))];
export const WEBM = [...readFileSync(join(FIXTURES, 'sample.webm'))];
export const WAV = [...readFileSync(join(FIXTURES, 'sample.wav'))];
export const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOTS, { recursive: true });

// 浏览器二进制解析：playwright 托管优先，其次 CANVAS_E2E_CHROME，最后系统 Chrome。
// playwright-core executablePath() 在浏览器缺失时可能抛错——逐候选探测文件存在性。
export function resolveChrome() {
  const candidates = [];
  try { const p = chromium.executablePath(); if (p) candidates.push(p); } catch { /* 未安装 */ }
  if (process.env.CANVAS_E2E_CHROME) candidates.push(process.env.CANVAS_E2E_CHROME);
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  return candidates.find(p => existsSync(p)) ?? candidates[0] ?? null;
}
export const CHROME = resolveChrome();
export const BROWSER_OK = Boolean(CHROME && existsSync(CHROME));

// ---- 资源探测与 skip 语义（裁决11：缺资源 → skip 并标注「未验收」，不得 fail 或包装通过）----
export const DIRECTOR_DIR = join(REPO_ROOT, 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage');
export const DIRECTOR_OK = existsSync(join(DIRECTOR_DIR, 'index.html'));
export const FFMPEG_OK = (() => {
  try { const r = spawnSync('ffmpeg', ['-version'], { timeout: 8000, windowsHide: true }); return !r.error && r.status === 0; }
  catch { return false; }
})();
// 供 test({ skip }) 使用：cond 为真即给出去因标注
export const skipIf = (cond, reason) => (cond ? reason : false);
export const RESOURCES = {
  playwright: true,                       // 能走到这里说明模块已加载
  playwrightFrom: PLAYWRIGHT_FROM,
  browser: BROWSER_OK, chrome: CHROME,
  director: DIRECTOR_OK, directorDir: DIRECTOR_DIR,
  ffmpeg: FFMPEG_OK,
};
// 统一浏览器启动（headless；附加参数按用例传入）
export async function launchBrowser(args = [], opts = {}) {
  if (!BROWSER_OK) throw new Error('E2E 浏览器缺失：npx playwright install chromium 或设置 CANVAS_E2E_CHROME');
  return chromium.launch({ executablePath: CHROME, headless: true, ...opts, args });
}
// loopback 守门（WO-D0-6）：拦截页面全部请求，收集非 loopback 外联（http/https 且非 127.0.0.1/localhost/::1）。
// 用法：const egress = await watchEgress(page); …操作…; assert.deepEqual(egress(), [])
// opts.abort=true：非 loopback 直接 abort（隔离而非事后检测），同时仍记录 hits 供断言。
export async function watchEgress(page, { abort = false } = {}) {
  const hits = [];
  await page.route('**/*', route => {
    try {
      const u = new URL(route.request().url());
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) {
        hits.push(u.href);
        if (abort) return route.abort();
      }
    } catch { /* 非 URL 请求放行 */ }
    return route.continue();
  });
  return () => hits;
}

// 沿实际导航打开折叠面板/项目菜单，旧业务回归继续点击原按钮本体。
export async function openCanvasDock(page, name) {
  if (await page.evaluate(() => innerWidth <= 900)) {
    if (!await page.locator('#sidebar').evaluate(e => e.classList.contains('open'))) await page.click('#sidebar-toggle');
    return;
  }
  const button = page.locator(`[data-rail="${name}"]`);
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
}
export async function clickCanvasAction(page, selector) {
  const target = page.locator(selector);
  if (!await target.isVisible() || await target.evaluate(e => !!e.closest('[inert]'))) {
    if (/^#btn-(new-project|rename|hub|workspace|export|import)$/.test(selector)) await page.click('#btn-project-menu');
    else if (selector === '#btn-library') await openCanvasDock(page, 'asset');
    else if (selector === '#btn-add-asset' || selector.includes('data-add-node')) await openCanvasDock(page, 'create');
  }
  await target.click();
}
export const hdr = (h, n) => {
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(n);
  const k = Object.keys(h).find(k => k.toLowerCase() === n.toLowerCase());
  return k ? h[k] : null;
};

// ---------- 真实可解码媒体样本 ----------
export async function realPng(page, hue = 210) {
  return page.evaluate(h => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 54;
    const g = c.getContext('2d');
    g.fillStyle = `hsl(${h},65%,42%)`; g.fillRect(0, 0, 96, 54);
    g.fillStyle = '#f5c542'; g.beginPath(); g.arc(48, 27, 15, 0, 7); g.fill();
    c.toBlob(async b => res([...new Uint8Array(await b.arrayBuffer())]), 'image/png');
  }), hue);
}
// 视频/音频样本用 ffmpeg 生成的真实文件（tests/fixtures/），保证可解码
export async function assertVideoDecodes(page, bytes, mime = 'video/webm') {
  return page.evaluate(async ([b, mt]) => {
    const v = document.createElement('video');
    v.src = URL.createObjectURL(new Blob([new Uint8Array(b)], { type: mt }));
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video decode failed')); setTimeout(() => rej(new Error('video decode timeout')), 8000); });
    return v.videoWidth > 0;
  }, [bytes, mime]);
}
export async function assertImageDecodes(page, bytes) {
  return page.evaluate(async b => { const img = new Image(); img.src = URL.createObjectURL(new Blob([new Uint8Array(b)], { type: 'image/png' })); await img.decode(); return img.naturalWidth > 0; }, bytes);
}
export async function assertAudioDecodes(page, bytes) {
  return page.evaluate(async b => {
    const AC = window.OfflineAudioContext || window.AudioContext;
    const ac = new AC(1, 8000, 8000);
    const buf = await ac.decodeAudioData(new Uint8Array(b).buffer.slice(0));
    return buf.duration > 0.1;
  }, bytes);
}

// ---------- mock 上游（本站合同形态）----------
export const MODELS_11 = [
  'seedance-2.5-vip-480p', 'seedance-2.5-vip-720p', 'seedance-2.5-vip-1080p',
  'seedance-2.5-discount-480p', 'seedance-2.5-discount-720p',
  'seedance-2.5-special-480p', 'seedance-2.5-special-720p',
  'wan-3.0', 'wan-3.0-prime',
  'minimax-h3-768p-per-second', 'minimax-h3-2k-per-second',
];
const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a' };
const KIND_OF = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/webm': 'video', 'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/x-m4a': 'audio', 'audio/mp4': 'audio' };

async function consumeBody(b) {
  if (b == null) return new Uint8Array();
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (typeof b === 'string') return new TextEncoder().encode(b);
  if (b?.arrayBuffer) return new Uint8Array(await b.arrayBuffer());
  if (b?.getReader) { const r = b.getReader(), out = []; let n = 0; for (;;) { const { done, value } = await r.read(); if (done) break; out.push(value); n += value.length; } const all = new Uint8Array(n); let o = 0; for (const c of out) { all.set(c, o); o += c.length; } return all; }
  if (b?.[Symbol.asyncIterator]) { const out = []; let n = 0; for await (const c of b) { out.push(c); n += c.length; } const all = new Uint8Array(n); let o = 0; for (const c of out) { all.set(c, o); o += c.length; } return all; }
  return new Uint8Array();
}
export function makeState() {
  return { uploads: [], creates: [], queries: [], downloads: [], queryCount: new Map(), failUpload: false, createFailsLeft: 0, videoBytes: null, slowTaskId: null };
}
export function mockUpstream(state) {
  return async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (init.method === 'GET' && p === '/v1/models')
      return Response.json({ data: MODELS_11.map(id => ({ id })) });
    if (p === '/reference-assets' && init.method === 'POST') {
      const body = await consumeBody(init.body);           // 真实消耗请求体
      const ct = String(hdr(init.headers, 'content-type') ?? '').split(';')[0];
      state.uploads.push({ size: body.length, ct });
      if (state.failUpload) return Response.json({ error: { code: 'upload_failed', message: 'mock 拒绝' } }, { status: 500 });
      const kind = KIND_OF[ct], ext = EXT_OF[ct] ?? 'bin';
      const hex = randomBytes(32).toString('hex');
      return Response.json({
        id: hex, url: `https://xingpan.site/reference-assets/${hex}.${ext}`,
        kind, content_type: ct, size: body.length,
        expires_at: Math.floor(Date.now() / 1000) + 86000,
        duration_seconds: kind === 'video' ? 2 : kind === 'audio' ? 1 : null,
      });
    }
    if (p === '/v1/videos' && init.method === 'POST') {
      state.creates.push({ key: hdr(init.headers, 'idempotency-key'), body: init.body });
      if (state.createFailsLeft-- > 0) return Response.json({ error: { code: 'upstream_err', message: 'mock 502' } }, { status: 502 });
      return Response.json({ task_id: `task-${state.creates.length}`, status: 'queued' });
    }
    const mc = p.match(/^\/v1\/videos\/([^/]+)\/content$/);
    if (mc && init.method === 'GET') {
      state.downloads.push(mc[1]);
      return new Response(new Uint8Array(state.videoBytes), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(state.videoBytes.length) } });
    }
    const m = p.match(/^\/v1\/videos\/([^/]+)$/);
    if (m && init.method === 'GET') {
      state.queries.push(m[1]);
      const n = (state.queryCount.get(m[1]) ?? 0) + 1; state.queryCount.set(m[1], n);
      if (state.slowTaskId === m[1] || n < 2) return Response.json({ id: m[1], status: 'in_progress', progress: 50 });
      return Response.json({ id: m[1], status: 'completed', progress: 100, delivery_status: 'ready', download_expires_at: Math.floor(Date.now() / 1000) + 86000 });
    }
    return Response.json({ error: { code: 'not_found', message: `未匹配路由 ${init.method} ${p}` } }, { status: 404 });
  };
}

// ---------- 测试辅助 ----------
export const genNode = page => page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').id);
export const genData = page => page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data ?? null);
export async function waitTaskCompleted(page, taskId, timeout = 25000) {
  await page.waitForFunction(id => {
    const r = window.__xp.taskPeek(id);
    return r?.status === 'completed' && r.deliveryStatus !== 'delivering';
  }, taskId, { timeout, polling: 300 });
}
export async function openKeyModal(page) {
  if (await page.locator('#btn-key').count()) {
    await page.click('#btn-key');
    await page.waitForSelector('.modal input[type=password]', { timeout: 5000 });
  }
}
export async function setKey(page, key = 'sk-e2e-test') {
  await openKeyModal(page);
  await page.fill('.modal input[type=password]', key);
  await page.click('.modal button.primary');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
}
export async function addAsset(page, bytes, name, kind, x, y) {
  return page.evaluate(async ([b, nm, kd, px, py]) => {
    const mime = { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kd];
    const a = await window.__xp.assets.registerBlob(new Blob([new Uint8Array(b)], { type: mime }), nm, kd);
    const n = window.__xp.store.addNode('asset', px, py, { assetId: a.id });
    return { assetId: a.id, nodeId: n.id };
  }, [bytes, name, kind, x, y]);
}
export async function rewire(page, gen, port, list) {
  return page.evaluate(([g, p, l]) => {
    const s = window.__xp.store;
    s.project.edges = s.project.edges.filter(e => !(e.to.node === g && e.to.port === p));
    for (const [from, kind] of l) s.addEdge(from, 'out', g, p, kind);
    s.touch({ type: 'structure' });
  }, [gen, port, list]);
}
export async function selectAndFill(page, { model, intent, prompt, seconds }) {
  await page.click('.node-gen .node-head');
  await page.waitForSelector('#inspector select');
  const sels = page.locator('#inspector select');
  if (model) await sels.nth(0).selectOption(model);
  if (intent) await sels.nth(1).selectOption(intent);
  if (prompt != null) await page.fill('#inspector textarea', prompt);
  if (seconds) await page.fill('#inspector input[type=number]', String(seconds));
  await page.evaluate(() => document.activeElement?.blur());   // 编辑态会冻结检查器重渲染
  await page.waitForTimeout(120);
}
export async function downloadCurrent(page, taskId) {
  // 本机已有成片时检查器不再显示「下载成片」（直接生成已自动取回）。先等状态落定：
  // 要么本机已有成片，要么「下载成片」已可点——再决定是否点击，避免点到即将重绘的旧按钮
  await page.waitForFunction(id => {
    if (window.__xp.taskPeek(id)?.resultBlobId) return true;
    const b = [...document.querySelectorAll('#inspector .modal-actions button')].find(x => x.textContent === '下载成片');
    return !!b && !b.disabled;
  }, taskId, { timeout: 15000 });
  if (!await page.evaluate(id => !!window.__xp.taskPeek(id)?.resultBlobId, taskId))
    await page.locator('#inspector .modal-actions button', { hasText: '下载成片' }).click();
  await page.waitForFunction(id => !!window.__xp.taskPeek(id)?.resultBlobId, taskId, { timeout: 15000 });
  // 节点关联异步进行——单独等待（防止 resultAssetId 竞态）
  await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.resultAssetId, null, { timeout: 10000 });
  const bytes = await page.evaluate(async id => {
    const u = await window.__xp.runner.resultURL(id);
    return [...new Uint8Array(await (await fetch(u)).arrayBuffer())];
  }, taskId);
  assert.ok(await assertVideoDecodes(page, bytes, 'video/mp4'), `${taskId} 成片可解码`);
}

// 失败说明（不改变等待时长）：等待任务号超时时附上节点运行态、密钥/锁状态与最近提示，便于在 CI 日志中定位
export async function explainGenStall(page, label) {
  const info = await page.evaluate(() => {
    const n = window.__xp.store.project.nodes.find(x => x.type === 'gen');
    const toasts = [...document.querySelectorAll('#toast-root .toast')].slice(-4).map(t => t.textContent);
    return { run: n?.data.run ?? null, model: n?.data.draft?.model ?? null, busy: n ? window.__xp.runner.isBusy?.(n.id) : null,
      lockScope: window.__xp.runner.submitLockScope ?? null, hasKey: window.__xp.keyvault?.hasKey?.() ?? null, toasts };
  }).catch(e => ({ evaluateFailed: String(e?.message ?? e) }));
  return `${label} 等待任务号超时：${JSON.stringify(info)}`;
}
