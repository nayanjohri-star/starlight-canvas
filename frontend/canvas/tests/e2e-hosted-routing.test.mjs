// 托管网页版验收：/canvas/ 基础路径、登录门与账户、同源 /canvas-api 边界、本机专属能力关闭、
// 已核实的满参慢速型号提交与恢复、跨账户隔离、会话失效、账户切换不串数据、密钥卫生。
// 通过托管路由边界驱动真实界面（输入、点击、刷新），不直接调用内部辅助函数冒充流程。
// 拓扑：tests/hosted-topology.mjs（本机：Caddyfile 语义静态服务 + Sol 的真实适配层 + 合成 New API）；
// CI 中 CANVAS_HOSTED_URL 指向真实 Caddy 容器 + 独立适配层进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, BROWSER_OK, MP4, MODELS_11, SHOTS, clickCanvasAction, openCanvasDock } from './e2e-helpers.mjs';
import { startHostedTopology, syntheticNewApi, caddyHeaders, signIn, downloadViaTaskCenter } from './hosted-topology.mjs';
import { installDirectorAssemblyFixture, assertHostedDirectorEntry } from './legacy-director-fixture.mjs';

const FULL_SLOW = 'minimax-h3-768p-full-slow';
const ALLOWED = [/^\/login$/, /^\/canvas$/, /^\/canvas\//, /^\/canvas-api\/(features|identity|session|v1\/models|api\/pricing|reference-assets)$/,
  /^\/canvas-api\/v1\/videos(\/[A-Za-z0-9_-]+(\/content)?)?$/, /^\/canvas-api\/v1\/(chat\/completions|images\/(generations|edits))$/];
const LOCAL_ONLY = /^\/(health|media|workspace|site|director|__hub-sdk__\.js|v1|api|reference-assets)(\/|$)/;
const skip = !BROWSER_OK && '浏览器缺失（严格门禁中缺失即失败）';

async function boot(t) {
  const api = syntheticNewApi({ videoBytes: MP4, models: [...MODELS_11, FULL_SLOW] });
  const topo = await startHostedTopology({ newApi: api });
  t.after(() => topo.close());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(() => browser.close().catch(() => {}));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const external = [], seen = [];
  await ctx.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.origin !== topo.origin) { external.push(u.href); return r.abort(); }
    seen.push({ method: r.request().method(), path: u.pathname, search: u.search });
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  return { api, topo, ctx, page, external, seen, errors };
}
const offRoute = seen => seen.filter(r => !ALLOWED.some(re => re.test(r.path)) ||
  (r.path === '/canvas-api/session' && (r.method !== 'GET' || r.search !== '')));

function assertHostedDirectorCsp(csp) {
  const directives = Object.fromEntries(csp.split(';').map(part => part.trim().split(/\s+/)).filter(tokens => tokens[0]).map(([key, ...tokens]) => [key, tokens]));
  assert.ok(directives['script-src']?.includes("'self'"));
  assert.ok(directives['script-src']?.includes('blob:'), '本地渲染 Worker 可从 blob 加载自身模块');
  assert.equal(directives['script-src']?.includes("'unsafe-eval'"), false, '不允许 JavaScript eval');
  assert.equal(directives['script-src']?.includes("'unsafe-inline'"), false, '导演台从同源静态脚本加载');
  assert.ok(directives['worker-src']?.includes("'self'"));
  assert.ok(directives['worker-src']?.includes('blob:'));
  assert.deepEqual(directives['frame-src'], ["'self'"], '托管导演台不依赖本机异源插件');
  assert.equal(directives['connect-src']?.some(token => /^https?:/.test(token)), false, '不开放第三方模型直连');
}

test('托管导演台 CSP：同源 iframe 与本地 Worker 可用，JavaScript eval 与外部模型直连关闭', () => {
  assertHostedDirectorCsp(caddyHeaders()['Content-Security-Policy']);
});

test('托管账号入口：启动不显示密钥表单；未登录跳用户站；登录后自动进入和刷新；安全头来自部署模板', { timeout: 120000, skip }, async t => {
  const { topo, page, external, seen, errors } = await boot(t);
  let hold;
  const pending = new Promise(resolve => { hold = resolve; });
  await page.route('**/canvas-api/session', route => hold(route));
  const resp = await page.goto(`${topo.origin}/canvas`);
  assert.equal(new URL(page.url()).pathname, '/canvas/');
  const h = resp.headers();
  for (const [k, v] of Object.entries(caddyHeaders())) assert.equal(h[k.toLowerCase()], v, `响应头 ${k}`);
  assertHostedDirectorCsp(h['content-security-policy']);
  assert.equal(h['cache-control'], 'no-store');
  const request = await pending;
  await page.waitForSelector('.hosted-gate');
  assert.equal(await page.locator('#hosted-key,input[type=password]').count(), 0, '启动期间也没有密钥输入框');
  assert.equal(await page.locator('#btn-key').isVisible(), false, '账号核验期间不显示未装配的画布');
  assert.match(await page.locator('.hosted-gate').innerText(), /只保存在当前浏览器与设备中.*导出工程包/s);
  assert.equal(await page.evaluate(() => Boolean(window.__xp)), false, '核验前不启动画布');
  await page.screenshot({ path: join(SHOTS, 'hosted-account-startup.png') });
  await request.continue(); await page.unroute('**/canvas-api/session');
  await page.waitForURL(`${topo.origin}/login?canvas=1`);
  await signIn(page, 'sk-synth-alice');
  const rt = await page.evaluate(async () => { const m = await import('./runtime-config.js'); return { ...m.RUNTIME }; });
  assert.equal(rt.mode, 'hosted'); assert.equal(rt.apiBase, '/canvas-api');
  assert.match(await page.locator('#btn-key').getAttribute('aria-label'), /alice/);
  await page.reload();
  await page.waitForFunction(() => window.__xp?.store?.project);
  assert.match(await page.locator('#btn-key').getAttribute('aria-label'), /alice/);
  assert.equal(await page.locator('#hosted-key').count(), 0, '刷新自动恢复账号，不索要密钥');
  const raw = async (method, path, headers = {}) => (await fetch(`${topo.origin}${path}`, { method, headers, redirect: 'manual' })).status;
  assert.equal(await raw('POST', '/canvas/'), 405);
  assert.equal(await raw('GET', '/canvas/not-a-file.js'), 404);
  assert.equal(await raw('GET', '/canvas/__hub-sdk__.js'), 404);
  assert.equal(await raw('GET', '/canvas-api/v1/files'), 404, '适配层不是通用代理');
  assert.equal(await raw('GET', '/canvas-api/v1/models'), 401, '无 Key 拒绝');
  assert.deepEqual(offRoute(seen), []);
  assert.deepEqual(seen.filter(r => LOCAL_ONLY.test(r.path)), [], '不访问本机服务路由或绕过适配层');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('托管账号入口：认证服务故障保留当前页并可重连，不降级为手填密钥或错误登出', { timeout: 120000, skip }, async t => {
  const { topo, page, errors } = await boot(t);
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  for (const status of [503, 404]) {
    await page.route('**/canvas-api/session', route => route.fulfill({ status, contentType: 'application/json', body: '{}' }));
    await page.reload();
    await page.getByRole('button', { name: '重新连接', exact: true }).waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).pathname, '/canvas/');
    assert.equal(await page.locator('input[type=password],#hosted-key').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.__xp)), false);
    assert.equal(await page.locator('#btn-key').isVisible(), false);
    if (status === 503) await page.screenshot({ path: join(SHOTS, 'hosted-account-retry.png') });
    await page.unroute('**/canvas-api/session');
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await page.waitForFunction(() => window.__xp?.store?.project);
    assert.match(await page.locator('#btn-key').getAttribute('aria-label'), /alice/);
  }
  assert.deepEqual(errors, []);
});

test('托管功能边界：云端工作区停用；导演台无本机插件且按需同源装配；导出前只列浏览器导出', { timeout: 150000, skip }, async t => {
  const { topo, ctx, page, seen, external, errors } = await boot(t);
  const entries = await installDirectorAssemblyFixture(ctx);
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  const ws = await page.evaluate(() => { const b = document.getElementById('btn-workspace'); return { disabled: b.disabled, title: b.title }; });
  assert.equal(ws.disabled, true); assert.match(ws.title, /导出工程包/);
  assert.doesNotMatch(await page.locator('body').innerText(), /部分功能模块未就绪/, '明确停用的云工作区不是加载故障');
  assert.equal(await page.locator('#btn-director-mode .dev-badge,[data-add-node="director"] .dev-badge').count(), 0);
  assert.equal(entries.length, 0, '登录与启动画布不加载完整导演台');
  await clickCanvasAction(page, '#btn-director-mode');
  await page.frameLocator('.director-frame').locator('[data-director-assembly-fixture]').waitFor();
  const scope = await page.evaluate(() => ({ projectId: window.__xp.store.project.id,
    nodeId: window.__xp.store.project.nodes.find(n => n.type === 'director').id }));
  assertHostedDirectorEntry(await page.locator('.director-frame').getAttribute('src'), topo.origin, scope);
  assert.doesNotMatch(await page.locator('.modal').last().innerText(), /开发中|插件资源|无法确认导演台资源/);
  assert.equal(entries.length, 1);
  await page.locator('.modal').last().getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.equal(await page.locator('.director-frame').count(), 0);
  await page.evaluate(() => window.__xp.openModule?.('timeline'));
  await page.getByRole('button', { name: '导出 ▾' }).first().click();
  await page.getByRole('button', { name: /导出视频（浏览器）/ }).click();
  const dlg = page.locator('.modal').last();
  await dlg.waitFor();
  const text = await dlg.innerText();
  assert.match(text, /浏览器导出/); assert.match(text, /托管网页版不提供/); assert.match(text, /时间线最长 600 秒/);
  assert.equal(await dlg.getByRole('button', { name: /本机服务/ }).count(), 0);
  assert.deepEqual(seen.filter(r => LOCAL_ONLY.test(r.path)), []);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('托管生成：经 /canvas-api 提交与下载；满参慢速版按秒估算并正常生成；跨账户读取被拒；伪造账户头被拒；无请求取消；密钥不落地', { timeout: 180000, skip }, async t => {
  const { api, topo, page, seen, external, errors } = await boot(t);
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  await clickCanvasAction(page, '[data-add-node="gen"]');
  await page.click('.node-gen .node-head');
  await page.locator('#inspector select').first().selectOption(FULL_SLOW);
  await page.fill('#inspector textarea', '托管满参慢速验证');
  await page.locator('#inspector input[type=number]').first().fill('5');
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(500); // allow the existing 250ms inspector refresh to settle before a real click
  assert.match(await page.locator('#inspector').innerText(), /预估 ¥0\.50/);
  assert.doesNotMatch(await page.locator('#inspector').innerText(), /计费口径.*尚未得到权威确认/);
  // Direct calls still require idempotency; a verified model is not rejected by a stale billing hold.
  const direct = await page.evaluate(async () => {
    const r = await fetch('/canvas-api/v1/videos', { method: 'POST', headers: { Authorization: 'Bearer sk-synth-alice', 'X-Canvas-Subject': 'u1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'minimax-h3-768p-full-slow', prompt: 'x', seconds: 5 }) });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(direct.status, 400); assert.equal(direct.body.error.code, 'idempotency_key_required');
  assert.equal(api.state.creates.length, 0);
  await page.evaluate(() => {window.__submitNotices=[];new MutationObserver(()=>{window.__submitNotices.push(...[...document.querySelectorAll('.toast')].map(x=>x.textContent));}).observe(document.querySelector('#toast-root'),{childList:true,subtree:true});});
  await page.getByRole('button', { name: /^(上传并)?提交生成$/ }).click();
  const taskId = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 20000 }).then(h => h.jsonValue()).catch(async () => assert.fail(JSON.stringify({ creates:api.state.creates.length, errors, state:await page.evaluate(() => ({run:window.__xp.store.project.nodes.find(n=>n.type==='gen')?.data.run, notices:window.__submitNotices, inspector:document.querySelector('#inspector')?.textContent})) })));
  await openCanvasDock(page, 'task');
  const rowSel = `#task-list .task-item[data-task-id="${taskId}"]`;
  const auto = await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'local_verified', rowSel, { timeout: 20000 }).then(() => true, () => false);
  if (!auto) await page.locator(rowSel).getByRole('button', { name: '恢复下载' }).click();
  await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'local_verified', rowSel, { timeout: 20000 });
  assert.equal(await page.locator(rowSel).getByRole('button', { name: '请求取消' }).count(), 0, '服务器不支持取消时不提供');
  assert.equal(api.state.creates.length, 1); assert.equal(api.state.creates[0].uid, 1); assert.equal(api.state.creates[0].model, FULL_SLOW);
  // 跨账户：bob 读取/下载 alice 的任务 → 404；伪造账户头 → 409
  const cross = await page.evaluate(async id => Promise.all([
    fetch(`/canvas-api/v1/videos/${id}`, { headers: { Authorization: 'Bearer sk-synth-bob', 'X-Canvas-Subject': 'u2' } }).then(r => r.status),
    fetch(`/canvas-api/v1/videos/${id}/content`, { headers: { Authorization: 'Bearer sk-synth-bob', 'X-Canvas-Subject': 'u2' } }).then(r => r.status),
    fetch(`/canvas-api/v1/videos/${id}`, { headers: { Authorization: 'Bearer sk-synth-bob', 'X-Canvas-Subject': 'u1' } }).then(r => r.status),
  ]), taskId);
  assert.deepEqual(cross, [404, 404, 409]);
  assert.ok(api.state.denied.length >= 2, '合成 New API 记录了越权尝试');
  // 最终视频路由（hosted-api-contract.md）：新建只经视频网关（vjob_），从不直达 New API；vjob_ 访问前逐次核验所有权
  assert.match(taskId, /^vjob_[a-f0-9]{32}$/, '任务号来自视频网关');
  assert.equal(api.state.directVideoPosts, 0, '视频新建没有直达 New API');
  assert.ok(api.state.ownershipChecks > 0, 'vjob_ 查询/下载前经 New API 所有权端点核验');
  // 密钥卫生：地址、浏览器存储与 IndexedDB 中都没有原始密钥
  assert.ok(!seen.some(r => (r.path + r.search).includes('sk-synth')));
  const stored = await page.evaluate(async () => {
    const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        parts.push(JSON.stringify(all.map(v => (v instanceof Blob ? '[blob]' : v))));
      }
      db.close();
    }
    return parts.join('\n');
  });
  assert.ok(stored.length > 100);
  assert.ok(!stored.includes('sk-synth-alice'), '浏览器存储与 IndexedDB 中没有原始密钥');
  assert.deepEqual(offRoute(seen), []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('账户切换：退出后另一账户看不到前一账户的项目与任务；同账户换新 Key 仍可用原任务且不重新生成', { timeout: 240000, skip }, async t => {
  const { api, topo, page, errors } = await boot(t);
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  const alicePid = await page.evaluate(async () => { const s = window.__xp.store; await s.newProject('Alice 私人项目'); s.addNode('text', 0, 0, { text: 'alice 草稿' }); await s.flush(); return s.project.id; });
  await clickCanvasAction(page, '[data-add-node="gen"]');
  await page.click('.node-gen .node-head');
  await page.fill('#inspector textarea', '账户切换验证');
  await page.evaluate(() => document.activeElement?.blur());
  await page.getByRole('button', { name: /^(上传并)?提交生成$/ }).click();
  const taskId = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 20000 }).then(h => h.jsonValue());
  await downloadViaTaskCenter(page, taskId, openCanvasDock);
  await page.locator('#btn-key').click();
  await Promise.all([page.waitForURL(`${topo.origin}/console`), page.getByRole('button', { name: '切换账户 / 退出' }).click()]);
  await signIn(page, 'sk-synth-bob');
  const bob = await page.evaluate(async () => ({ projects: (await window.__xp.store.listProjects()).map(p => p.name), tasks: (await window.__xp.store.tasksOfProject()).length }));
  assert.ok(!bob.projects.includes('Alice 私人项目'), `bob 看不到 alice 的项目：${bob.projects}`);
  assert.equal(bob.tasks, 0);
  assert.equal(await page.evaluate(id => window.__xp.runner.localResult(id).then(r => r.ready), taskId), false, 'bob 无法取得 alice 的本机成片');
  await page.locator('#btn-key').click();
  await Promise.all([page.waitForURL(`${topo.origin}/console`), page.getByRole('button', { name: '切换账户 / 退出' }).click()]);
  await signIn(page, 'sk-synth-alice-2');
  const again = await page.evaluate(async pid => {
    const s = window.__xp.store; const names = (await s.listProjects()).map(p => p.name);
    if (s.project.id !== pid) await s.openProject(pid);
    const gen = s.project.nodes.find(n => n.type === 'gen');
    const lr = gen ? await window.__xp.runner.localResult(gen.data.run.taskId) : null; const rec = gen ? await window.__xp.runner.recOf(gen.data.run.taskId) : null;
    return { names, local: lr?.ready ?? null, reason: lr?.reason ?? null, recKeys: rec ? Object.keys(rec).filter(k => /result|owner|keyFp/.test(k)).map(k => k + "=" + String(rec[k]).slice(0, 24)) : null, assets: Object.values(s.project.assets).map(a => a.id + ":" + a.fromTask) };
  }, alicePid);
  assert.ok(again.names.includes('Alice 私人项目'));
  assert.equal(again.local, true, '同账户换 Key 后原任务的本机成片仍可用：' + JSON.stringify(again));
  assert.equal(api.state.creates.length, 1, '切换账户与换 Key 都不重新生成');
  assert.deepEqual(errors, []);
});

test('会话失效是生命周期转换：密钥被停用后无需点击即停止付费请求与工作流；待恢复保存数准确；重新登录用原任务恢复且零新建', { timeout: 240000, skip }, async t => {
  const { api, topo, ctx, page, errors } = await boot(t);
  await ctx.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (window.__failTaskWrites && typeof key === 'string' && /(^|:)task:/.test(key)) throw new DOMException('模拟磁盘已满', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  const ids = await page.evaluate(() => {
    const s = window.__xp.store;
    const d = p => ({ draft: { model: 'minimax-h3-768p-per-second', intent: 'text', prompt: p, seconds: 4, ratio: '16:9', switches: {} }, perModel: {} });
    return [s.addNode('gen', 0, 0, d('第一镜')).id, s.addNode('gen', 400, 0, d('第二镜')).id];
  });
  api.holdNext(1);
  await page.evaluate(targets => { window.__run = window.__xp.workflow.start({ targets, confirmed: true, onlyEmpty: true }).catch(e => ({ error: e.message })); }, ids);
  const until = Date.now() + 30000;
  while (!api.held().length && Date.now() < until) await new Promise(r => setTimeout(r, 200));
  const [task1] = api.held();
  assert.ok(task1, '第一镜任务已受理并在途');
  // 首次终态写盘失败 → 本地保存待恢复；工作流因此暂停依赖链，不会去建第二镜
  await page.evaluate(() => { window.__failTaskWrites = true; });
  api.release(task1);
  await page.waitForFunction(id => window.__xp.runner.taskPeek(id)?.localSaveState === 'pending', task1, { timeout: 30000 });
  const createsBefore = api.state.creates.length;
  // 密钥被停用；下一次后台请求（这里模拟一次查询）返回 401 —— 不点击任何东西
  api.revoke('sk-synth-alice');
  await page.evaluate(id => window.__xp.runner.requery?.(id).catch(() => {}), task1).catch(() => {});
  await page.evaluate(() => window.__xp.api.listModels().catch(() => null));
  await page.waitForFunction(() => document.getElementById('service-banner')?.dataset.session === 'invalid', null, { timeout: 20000 });
  assert.match(await page.locator('#service-banner').innerText(), /已停止本账户的任务查询、工作流与新的付费请求/);
  assert.match(await page.locator('#service-banner').innerText(), /有 1 个任务的最新状态尚未写入本机/, '待恢复保存数准确');
  // 失效后：解除写盘故障、恢复供应商，也不得再有任何付费请求——工作流不再调度，直接调用 API 在本地被拒
  await page.evaluate(() => { window.__failTaskWrites = false; });
  const direct = await page.evaluate(() => window.__xp.api.createTask(JSON.stringify({ model: 'minimax-h3-768p-per-second', prompt: 'x', seconds: 4 }), 'late-attempt-0001').then(() => 'sent', e => e.code ?? e.message));
  assert.equal(direct, 'identity_changed', '失效后新请求在本地被拒');
  await page.waitForTimeout(3000);
  assert.equal(api.state.creates.length, createsBefore, '失效后零新付费请求（工作流未继续调度第二镜）');
  const rec = await page.evaluate(id => window.__xp.taskPeek(id), task1);
  assert.ok(!['failed', 'cancelled', 'not_found', 'expired'].includes(rec?.status), `认证失败不能写成任务终态：${rec?.status}`);
  // 重新登录（同一用户的新 Key）：按原任务号恢复并取回成片，零新建
  await Promise.all([page.waitForEvent('load'), page.locator('#service-banner').getByRole('button', { name: '重新登录' }).click()]);
  await signIn(page, 'sk-synth-alice-2');
  await downloadViaTaskCenter(page, task1, openCanvasDock);
  assert.equal(api.state.creates.length, createsBefore, '重新登录与恢复不新建任务');
  assert.deepEqual(errors, []);
});

test('上游业务计费 409 不是会话失效：模拟计费拒绝后会话和查询继续可用', { timeout: 120000, skip }, async t => {
  const { api, topo, page, errors } = await boot(t);
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  await page.route('**/canvas-api/v1/videos', route => route.fulfill({ status:409, contentType:'application/json', body:JSON.stringify({error:{code:'model_billing_unverified',message:'synthetic billing refusal'}}) }));
  const r = await page.evaluate(() => window.__xp.api.createTask(JSON.stringify({ model: 'minimax-h3-768p-full-slow', prompt: 'x', seconds: 5 }), 'billing-gate-0001').then(() => 'sent', e => ({ status: e.status, code: e.code })));
  assert.deepEqual(r, { status: 409, code: 'model_billing_unverified' });
  await page.unroute('**/canvas-api/v1/videos');
  await page.waitForTimeout(500);
  assert.notEqual(await page.evaluate(() => document.getElementById('service-banner')?.dataset.session ?? null), 'invalid');
  const models = await page.evaluate(() => window.__xp.api.listModels().then(x => x.data.length, e => e.code));
  assert.ok(typeof models === 'number' && models > 0, '会话继续可用');
  assert.equal(api.state.creates.length, 0);
  assert.deepEqual(errors, []);
});
