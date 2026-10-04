// R05 独立验收：完整 12 镜模拟商业项目（真实浏览器 + 真实 IndexedDB + 本机服务 + 本地模拟上游）。
// 一条连续业务链覆盖：空选择、预算暂停、重复确认、项目切换、请求取消（任务中心界面）、
// 本地存储写失败与恢复、页面刷新续跑、畸形文档导入、缺失素材、导出失败与恢复，最终真实 MP4 导出。
// 全程只与本地模拟上游通信（浏览器外部请求一律拦截；服务端 upstreamFetch 为本地函数），
// 合成密钥与本地夹具；断言付费请求总数恰为计划数，任何环节不盲目重新生成。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, FFMPEG_OK, MODELS_11, MP4, makeState, mockUpstream, setKey, realPng, openCanvasDock, clickCanvasAction } from './e2e-helpers.mjs';

const SHOTS = 12;
const IMAGE_MODEL = 'gpt-image-2.5-flare', VIDEO_MODEL = 'minimax-h3-768p-per-second';

function businessUpstream(png) {
  const state = makeState(); state.videoBytes = MP4;
  const base = mockUpstream(state);
  // 任务脚本：默认第 1 次查询在途、第 2 次起完成就绪；hold 中的任务保持在途；取消请求后下一次查询为已取消
  const tasks = new Map();
  const images = [], cancels = [], texts = [];
  let holdLeft = 0;   // 接下来新建的若干个任务保持在途（工作流逐镜执行，一次只需扣住一个）
  const v2 = (id, t, extra = {}) => Response.json({ id, executor_version: 2, progress: t.status === 'completed' ? 100 : 40,
    stage: t.status === 'completed' ? 'succeeded' : 'running', content_ready: t.status === 'completed',
    delivery_status: t.status === 'completed' ? 'ready' : undefined, status: t.status,
    cancel_requested: t.cancelRequested || undefined,
    download_expires_at: t.status === 'completed' ? Math.floor(Date.now() / 1000) + 3600 : undefined, ...extra });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname, method = init.method ?? 'GET';
    if (path === '/v1/models') return Response.json({ data: [...MODELS_11, IMAGE_MODEL, 'gpt-5.6-sol'].map(id => ({ id })) });
    if (path === '/v1/images/generations') { images.push(JSON.parse(init.body)); return Response.json({ data: [{ b64_json: Buffer.from(png()).toString('base64') }] }); }
    if (path === '/v1/chat/completions') { texts.push(1); return Response.json({ choices: [{ message: { content: '不应调用' } }] }); }
    if (path === '/v1/videos' && method === 'POST') {
      const res = await base(url, init);
      const body = await res.clone().json();
      if (body.task_id) tasks.set(body.task_id, { status: 'queued', gets: 0, hold: holdLeft > 0 ? (holdLeft--, true) : false, cancelRequested: false });
      return res;
    }
    const cm = path.match(/^\/v1\/videos\/([^/]+)\/cancel$/);
    if (cm && method === 'POST') {
      const t = tasks.get(cm[1]); cancels.push(cm[1]);
      if (!t) return Response.json({ error: { code: 'not_found', message: 'no task' } }, { status: 404 });
      t.cancelRequested = true;
      return v2(cm[1], t);
    }
    const qm = path.match(/^\/v1\/videos\/([^/]+)$/);
    if (qm && method === 'GET') {
      const t = tasks.get(qm[1]); state.queries.push(qm[1]);
      if (!t) return Response.json({ error: { code: 'not_found', message: 'no task' } }, { status: 404 });
      t.gets++;
      if (t.cancelRequested && t.status !== 'completed') t.status = 'cancelled';
      else if (!t.hold && t.gets >= 2) t.status = 'completed';
      else if (t.status === 'queued') t.status = 'in_progress';
      return v2(qm[1], t);
    }
    return base(url, init);
  };
  return { state, tasks, images, cancels, texts, fetchImpl, holdNext: n => { holdLeft = n; }, release: id => { const t = tasks.get(id); if (t) t.hold = false; } };
}

const ffprobe = file => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('R05 业务全链路：12 镜模拟商业项目（预算/取消/刷新/切换/存储故障/畸形文档/缺素材/导出失败）', { timeout: 420000, skip: (!BROWSER_OK || !FFMPEG_OK) && '需要浏览器与 FFmpeg（严格门禁中缺失即失败）' }, async t => {
  let pngBytes = null;
  const up = businessUpstream(() => pngBytes);
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, 'tests', 'no-director-assets'), upstreamFetch: up.fetchImpl });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blocked = [];
  await ctx.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin === origin) return r.continue(); blocked.push(u.href); return r.abort(); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 本地存储故障注入：只影响 task:* 键的 IndexedDB 写入（与真实 QuotaExceededError 同路径）
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (window.__failTaskWrites && typeof key === 'string' && key.startsWith('task:')) throw new DOMException('模拟磁盘已满', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.workflow && window.__xp?.storyboards);
  await setKey(page, 'synthetic-business-key');
  pngBytes = await realPng(page, 30);
  const paid = () => up.images.length + up.state.creates.length;

  // ---------- ① 建项目：12 镜，每镜 图片 → 视频 ----------
  const prep = await page.evaluate(async ([IMAGE_MODEL, VIDEO_MODEL, N]) => {
    const x = window.__xp, s = x.store;
    await s.newProject('R05 商业项目 · 12 镜');
    const grid = x.storyboards.createGrid(N), targets = [];
    for (const [i, shot] of grid.shots.entries()) {
      x.storyboards.updateShot(shot.id, { duration: 4, imagePrompt: `商业画面 ${i + 1}`, videoPrompt: `镜头运动 ${i + 1}` });
      x.storyboards.syncShotToNodes(shot.id);
      const image = s.node(shot.imageNodeId); image.data.model = IMAGE_MODEL; image.data.resolution = '1K'; image.data.ratio = '16:9';
      const video = x.storyboards.ensureVideoNode(shot); video.data.draft.model = VIDEO_MODEL; video.data.draft.ratio = '16:9'; video.data.draft.seconds = 4;
      targets.push(video.id);
    }
    await s.flush();
    const pv = await x.workflow.preview({ targets });
    return { pid: s.project.id, targets, shotIds: s.project.studio.shots.map(x => x.id), estimated: pv.estimatedYuan, unknown: pv.unknownPaid };
  }, [IMAGE_MODEL, VIDEO_MODEL, SHOTS]);
  assert.equal(prep.targets.length, SHOTS);
  assert.equal(prep.unknown, 0, '全部付费节点都有本地估价');
  const perShot = prep.estimated / SHOTS;
  t.diagnostic(`BUSINESS_ESTIMATE ${JSON.stringify({ totalYuan: prep.estimated, perShotYuan: perShot, note: '本地能力表估算，非实际扣费' })}`);

  // ---------- ② 空选择：绝不回落全画布，零请求 ----------
  const empty = await page.evaluate(async () => {
    const x = window.__xp;
    let error = null;
    try { await x.workflow.start({ targets: [], confirmed: true }); } catch (e) { error = e.message; }
    return { error, status: x.workflow.getState()?.status ?? null };
  });
  assert.ok(empty.error || empty.status !== 'running', `空选择不得启动：${JSON.stringify(empty)}`);
  assert.equal(paid(), 0, '空选择零付费请求');

  // ---------- ③ 预算暂停：本地估算护栏在超出前停下 ----------
  const budget = Math.round(perShot * 3.5 * 100) / 100;   // 约 3.5 镜的额度
  const b = await page.evaluate(async ([targets, budget]) => {
    const r = await window.__xp.workflow.start({ targets, budgetYuan: budget, confirmed: true });
    return { status: r.status, pauseReason: r.pauseReason, spend: r.estimatedSpendYuan, budgetBlocked: Object.values(r.nodes).filter(n => n.reason === 'budget').length };
  }, [prep.targets, budget]);
  assert.equal(b.status, 'paused', JSON.stringify(b));
  assert.match(b.pauseReason, /预算上限/);
  assert.ok(b.budgetBlocked >= 1);
  assert.ok(b.spend <= budget + 1e-9, `估算支出 ${b.spend} 不超过预算 ${budget}`);
  const afterBudget = paid();
  assert.ok(afterBudget > 0 && afterBudget < SHOTS * 2, `预算内部分执行：${afterBudget}`);
  t.diagnostic(`BUSINESS_BUDGET ${JSON.stringify({ budget, ...b, paidRequests: afterBudget })}`);

  // ---------- ④ 重复确认：同一计划并发确认只启动一次 ----------
  // 工作流按依赖顺序逐镜执行；下一个新建的视频任务（A）保持在途，用于检验切换与取消
  up.holdNext(1);
  const dup = await page.evaluate(async targets => {
    const x = window.__xp;
    // 默认模式会重新执行全部目标（含已有图片产出）；续做业务用「仅补空白」计划，已完成节点零费用复用
    const full = await x.workflow.preview({ targets, budgetYuan: 1000 });
    const pv = await x.workflow.preview({ targets, budgetYuan: 1000, onlyEmpty: true });
    window.__bizEstimates = { fullModeYuan: full.estimatedYuan, onlyEmptyYuan: pv.estimatedYuan, onlyEmptySummary: pv.skipSummary };
    const first = x.workflow.start({ plan: pv.plan, confirmed: true });
    window.__bizRun = first.then(r => r, e => ({ error: e.message }));
    let second = null;
    try { await x.workflow.start({ plan: pv.plan, confirmed: true }); second = 'started'; } catch (e) { second = e.message; }
    return { second };
  }, prep.targets);
  t.diagnostic(`BUSINESS_RECONFIRM_ESTIMATE ${JSON.stringify(await page.evaluate(() => window.__bizEstimates))}`);
  assert.match(dup.second, /已提交执行|在运行/, `第二次确认必须被拒：${dup.second}`);
  const waitHeld = async () => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const held = [...up.tasks].filter(([, v]) => v.hold && v.status !== 'cancelled').map(([k]) => k);
      if (held.length) return held[0];
      if (Date.now() > deadline) throw new Error('等待在途任务超时：creates=' + up.state.creates.length
        + ' tasks=' + JSON.stringify([...up.tasks].map(([id, task]) => [id, task.status, task.hold])));
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const taskA = await waitHeld();
  assert.equal(new Set(up.state.creates.map(c => c.key)).size, up.state.creates.length, '每个视频请求幂等键唯一');

  // ---------- ⑤ 项目切换：在途任务不串写到其他项目 ----------
  const createsBeforeSwitch = up.state.creates.length;
  // 通过界面切换（新建项目 → 下拉切回），走应用自己的切换钩子（afterProjectSwitch / resumeAll）
  await clickCanvasAction(page, '#btn-new-project');
  await page.waitForFunction(pid => window.__xp.store.project.id !== pid, prep.pid);
  await page.waitForTimeout(2500);   // 覆盖若干轮查询
  const sw = await page.evaluate(() => ({ otherNodes: window.__xp.store.project.nodes.length, otherAssets: Object.keys(window.__xp.store.project.assets).length }));
  await page.locator('#project-list').selectOption(prep.pid);
  await page.waitForFunction(pid => window.__xp.store.project.id === pid, prep.pid);
  assert.equal(sw.otherNodes, 0); assert.equal(sw.otherAssets, 0, '其他项目未被写入结果');
  assert.equal(up.state.creates.length, createsBeforeSwitch, '切换项目不产生新 POST');
  // 切走会暂停当前工作流驱动；回到项目后显式续跑（只继续已受理任务）
  await page.waitForFunction(() => window.__xp.workflow.getState()?.status === 'paused', null, { timeout: 15000 });
  const pausedBySwitch = await page.evaluate(() => window.__xp.workflow.getState().pauseReason);
  assert.match(pausedBySwitch, /项目|密钥/, '切换项目使工作流调度安全停止');
  // 用户点「继续」。resume 的 Promise 在整段工作流结束时才兑现；任务 A 此时被故意保持在途，
  // 因此只等待状态变为 running，不在页面评价里等待 Promise 结束。
  const switchResume = await page.evaluate(async targets => {
    const x = window.__xp;
    let settled = false;
    const resuming = x.workflow.resume().then(
      value => { settled = true; return value; },
      error => { settled = true; return { error: error.message }; },
    );
    window.__bizRun = resuming;
    const deadline = Date.now() + 5000;
    while (x.workflow.getState()?.status !== 'running' && !settled && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 50));
    const st = x.workflow.getState();
    if (st.status === 'running') return { path: 'resume' };
    if (!settled) throw new Error('继续调度未进入运行态，也未返回结果');
    const refused = (st.issues ?? []).slice(-1)[0] ?? null;
    const pv = await x.workflow.preview({ targets, budgetYuan: 1000, onlyEmpty: true });
    window.__bizRun = x.workflow.start({ plan: pv.plan, confirmed: true }).catch(e => ({ error: e.message }));
    return { path: 're-preview', refused, reused: pv.skipSummary?.reused ?? null, resumed: pv.skipSummary?.resumed ?? null, run: pv.skipSummary?.run ?? null };
  }, prep.targets);
  t.diagnostic(`BUSINESS_SWITCH_RESUME ${JSON.stringify(switchResume)}`);
  if (switchResume.path === 're-preview') assert.ok(switchResume.refused, '继续被拒时必须给出可见原因，不静默');
  await page.waitForFunction(() => window.__xp.workflow.getState()?.status === 'running', null, { timeout: 15000 });
  assert.equal(up.state.creates.length, createsBeforeSwitch, '继续/重新确认不重复提交在途任务');

  // ---------- ⑥ 请求取消：通过任务中心界面，对原任务请求取消，任务号保留，不自动重生 ----------
  up.holdNext(1);   // 取消后工作流继续下一镜，下一个任务（B）保持在途用于存储故障
  await openCanvasDock(page, 'task');
  const rowSel = id => `#task-list .task-item[data-task-id="${id}"]`;
  const stateOf = id => page.evaluate(s => document.querySelector(s)?.dataset.taskState ?? null, rowSel(id));
  const row = page.locator(rowSel(taskA));
  await row.waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: '请求取消' }).click();
  await page.locator('.modal').getByRole('button', { name: '确认' }).click();
  await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'server_cancelled', rowSel(taskA), { timeout: 20000, polling: 200 });
  assert.deepEqual(up.cancels, [taskA]);
  assert.match(await row.innerText(), new RegExp(taskA), '任务号保留可见');

  // ---------- ⑦ 本地存储写失败：显示待恢复，恢复后收敛；期间不新建任务 ----------
  const taskB = await waitHeld();
  assert.notEqual(taskB, taskA);
  await page.waitForFunction(s => !!document.querySelector(s), rowSel(taskB), { timeout: 15000 });
  const createsAtB = up.state.creates.length;
  await page.evaluate(() => { window.__failTaskWrites = true; });
  up.holdNext(1);   // 恢复后下一个任务（C）保持在途用于刷新
  up.release(taskB);
  await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'save_pending', rowSel(taskB), { timeout: 30000, polling: 200 });
  assert.match(await page.locator(rowSel(taskB)).innerText(), /本地保存失败/);
  assert.equal(up.state.creates.length, createsAtB, '本地保存待恢复期间不新建付费任务');
  await page.evaluate(() => { window.__failTaskWrites = false; });
  await page.waitForFunction(s => { const st = document.querySelector(s)?.dataset.taskState; return st && st !== 'save_pending'; }, rowSel(taskB), { timeout: 60000, polling: 300 });
  t.diagnostic(`BUSINESS_SAVE_RECOVERED ${JSON.stringify({ taskB, state: await stateOf(taskB) })}`);

  // ---------- ⑧ 刷新：页面重载后按原任务号续查，零新 POST ----------
  const taskC = await waitHeld();
  const createsBeforeReload = up.state.creates.length;
  await page.reload();
  await page.waitForFunction(() => window.__xp?.workflow && window.__xp.store?.project);
  await page.waitForTimeout(1500);
  assert.equal(up.state.creates.length, createsBeforeReload, '重载本身不产生 POST');
  // 密钥只保存在当前会话：刷新后任务按身份暂停（需原密钥），用户重新输入同一密钥后按原任务号继续
  const needKey = await page.evaluate(id => window.__xp.taskPeek(id)?.paused === true || window.__xp.keyvault.getFingerprint() == null, taskC);
  assert.ok(needKey, '刷新后无密钥时不得继续查询/提交');
  await setKey(page, 'synthetic-business-key');
  await page.waitForTimeout(500);
  assert.equal(up.state.creates.length, createsBeforeReload, '重新输入密钥不产生 POST');
  up.release(taskC);
  // 重载后工作流驱动已随页面结束：显式续跑（只对已受理任务查询/下载，不重建）
  const final = await page.evaluate(async () => {
    const x = window.__xp;
    // 用户点「继续」。记录实际路径；若未来又出现遗留 running 稿无人接管，
    // 仍验证「暂停 → 继续」恢复路径不会重复提交。
    const progressOf = () => JSON.stringify(Object.values(x.workflow.getState()?.nodes ?? {}).map(n => n.status));
    const before = progressOf();
    await x.workflow.resume();
    await new Promise(r => setTimeout(r, 3000));
    let path = 'resume';
    if (x.workflow.getState()?.status === 'running' && progressOf() === before) {
      path = 'pause-then-resume';
      await x.workflow.pause();
      await x.workflow.resume();
    }
    window.__reloadPath = path;
    const deadline = Date.now() + 180000;
    for (;;) {
      const s = x.workflow.getState();
      if (s?.status !== 'running') return s;
      if (Date.now() > deadline) return { timeout: true, ...s };
      await new Promise(r => setTimeout(r, 300));
    }
  });
  assert.ok(!final.timeout, `续跑超时：${JSON.stringify(final?.nodes)}`);
  t.diagnostic(`BUSINESS_RELOAD_RESUME ${JSON.stringify({ path: await page.evaluate(() => window.__reloadPath) })}`);
  t.diagnostic(`BUSINESS_FINAL ${JSON.stringify({ status: final.status, pauseReason: final.pauseReason ?? null, issues: final.issues ?? null, keyAfterReload: await page.evaluate(() => window.__xp.keyvault.getFingerprint()), nodes: Object.values(final.nodes ?? {}).reduce((m, n) => (m[n.status] = (m[n.status] ?? 0) + 1, m), {}) })}`);
  const videos = await page.evaluate(targets => targets.map(id => {
    const n = window.__xp.store.node(id);
    return { id, taskId: n?.data.run?.taskId ?? null, asset: n?.data.resultAssetId ?? null };
  }), prep.targets);
  const done = videos.filter(v => v.asset);
  const cancelledNode = videos.find(v => v.taskId === taskA);
  assert.ok(cancelledNode && !cancelledNode.asset, '被取消的镜头没有成片，也没有被自动重新生成');
  assert.equal(done.length, SHOTS - 1, `其余 ${SHOTS - 1} 镜全部完成：${JSON.stringify(videos)}`);
  assert.equal(up.state.creates.length, SHOTS, `视频付费请求恰为 ${SHOTS} 次（含被取消的一次），无重复`);
  assert.equal(up.images.length, SHOTS, `图片付费请求恰为 ${SHOTS} 次`);
  assert.equal(new Set(up.state.creates.map(c => c.key)).size, SHOTS);
  assert.equal(up.texts.length, 0);

  // ---------- ⑨ 畸形文档：导入失败不破坏当前项目 ----------
  const malformed = await page.evaluate(async () => {
    const x = window.__xp, s = x.store;
    const before = { id: s.project.id, nodes: s.project.nodes.length, shots: s.project.studio.shots.length };
    const results = [];
    for (const doc of ['{"broken": ', JSON.stringify({ nodes: 'not-an-array', edges: 7 }), JSON.stringify({ format: 'xingpan-canvas', version: 99, nodes: [{ id: 1, type: '<script>' }] })]) {
      try { await s.importJSON(doc); results.push('accepted'); } catch (e) { results.push('rejected:' + e.message.slice(0, 60)); }
    }
    const { importProjectPackage } = await import('/export-project.js');
    try { await importProjectPackage({ store: s, assets: x.assets }, new Uint8Array([80, 75, 3, 4, 0, 0, 0])); results.push('pkg-accepted'); }
    catch (e) { results.push('pkg-rejected:' + e.message.slice(0, 60)); }
    if (s.project.id !== before.id) await s.openProject(before.id);
    return { before, after: { id: s.project.id, nodes: s.project.nodes.length, shots: s.project.studio.shots.length }, results };
  });
  t.diagnostic(`BUSINESS_MALFORMED ${JSON.stringify(malformed.results)}`);
  assert.ok(malformed.results[0].startsWith('rejected'), '语法错误的文档必须拒绝');
  assert.ok(malformed.results[3].startsWith('pkg-rejected'), '损坏的工程包必须拒绝');
  assert.deepEqual(malformed.after, malformed.before, '当前项目不被畸形导入破坏');

  // ---------- ⑩ 分镜入轨：被取消镜头显式省略（需确认部分插入），其余按分镜顺序 ----------
  // 单次最多 10 个分镜（发布侧限制）→ 分两批，每批先严格预览（缺成片即整批阻止），再显式选择「仅加入可用镜头」
  const tl = await page.evaluate(async shotIds => {
    const x = window.__xp;
    const tooMany = await x.timeline.previewShotsToTimeline({ shotIds });
    const batches = [shotIds.slice(0, 6), shotIds.slice(6)], out = { tooMany: tooMany.code, strict: [], omitted: 0, applied: [] };
    for (const ids of batches) {
      const strict = await x.timeline.previewShotsToTimeline({ shotIds: ids });
      out.strict.push(strict.ok ? 'ok' : strict.code);
      const plan = strict.ok ? strict.plan : (await x.timeline.previewShotsToTimeline({ shotIds: ids, allowPartial: true })).plan;
      out.omitted += plan?.omitted?.length ?? 0;
      const r = plan ? await x.timeline.applyTimelinePlan(plan) : { ok: false, code: 'no_plan' };
      out.applied.push(r.ok ? r.clips.length : r.code);
    }
    out.clips = x.timeline.clips().filter(c => c.track === 'v1').sort((a, b) => a.start - b.start).map(c => c.assetId);
    return out;
  }, prep.shotIds);
  t.diagnostic(`BUSINESS_TIMELINE ${JSON.stringify({ ...tl, clips: tl.clips.length })}`);
  assert.equal(tl.tooMany, 'too_many', '超过单次上限时整批拒绝，不截断');
  assert.equal(tl.strict.filter(c => c === 'unavailable_shots').length, 1, '含被取消镜头的一批默认整批阻止');
  assert.equal(tl.omitted, 1, '仅加入可用镜头时明确列出被略过的镜头');
  assert.deepEqual(tl.applied.reduce((a, b) => a + b, 0), SHOTS - 1);
  assert.deepEqual(tl.clips, done.map(v => v.asset), '时间线顺序 = 分镜顺序（去掉被取消镜头）');

  // ---------- ⑪ 导出失败：本机渲染服务出错 → 明确失败、不产生文件；缺素材 → 阻断 ----------
  await page.route('**/media/render**', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'render_failed', message: '模拟渲染失败' } }) }));
  const failed = await page.evaluate(async () => {
    try { const r = await window.__xp.timeline.renderExport({ via: 'server', silent: true }); return { ok: true, via: r.via }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  await page.unroute('**/media/render**');
  assert.equal(failed.ok, false, `渲染服务失败时必须如实失败：${JSON.stringify(failed)}`);
  const missing = await page.evaluate(async () => {
    const x = window.__xp, c = x.timeline.clips()[0], a = x.store.project.assets[c.assetId];
    a.missing = true;
    try { await x.timeline.renderExport({ via: 'server', silent: true }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
    finally { a.missing = false; }
  });
  assert.equal(missing.ok, false); assert.match(missing.message, /无法渲染|缺失/);

  // ---------- ⑫ 真实导出：MP4 可解码、尺寸与时长正确 ----------
  const out = await page.evaluate(async () => {
    const r = await window.__xp.timeline.renderExport({ via: 'server', silent: true });
    return { bytes: [...new Uint8Array(await r.blob.arrayBuffer())], seconds: Math.max(...window.__xp.timeline.clips().map(c => c.end)) };
  });
  const dir = await mkdtemp(join(tmpdir(), 'r05-business-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'business.mp4');
  await writeFile(file, Buffer.from(out.bytes));
  const info = ffprobe(file);
  const v = info.streams.find(s => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.ok(Math.abs(Number(info.format.duration) - out.seconds) <= 0.3, `时长 ${info.format.duration} ≈ ${out.seconds}`);
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.ok(dec.status === 0 && !dec.stderr.trim(), dec.stderr.slice(0, 300));

  t.diagnostic(`BUSINESS_SUMMARY ${JSON.stringify({ shots: SHOTS, images: up.images.length, videoCreates: up.state.creates.length, cancels: up.cancels.length, queries: up.state.queries.length, downloads: up.state.downloads.length, clips: tl.clips.length, exportSeconds: out.seconds, blockedExternal: blocked.length })}`);
  assert.deepEqual(blocked, [], '浏览器没有尝试访问任何外部地址');
  assert.deepEqual(errors, []);
});
