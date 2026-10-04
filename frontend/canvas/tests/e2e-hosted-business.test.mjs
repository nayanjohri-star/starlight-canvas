// 托管网页版 12 镜商业流程验收（真实浏览器 + /canvas/ + 登录门 + Sol 的真实适配层 + 合成 New API/模拟供应商）：
//   ① 已有产出：先完成 4 镜（图片 + 视频）；
//   ② 已受理任务：第 5、6 镜视频被供应商扣住在途，其中一个先连续查询失败，另一个首次交付失败；
//   ③ 刷新：页面重载 → 自动识别同一账户 → 工作流由新页面接管（原驱动已随页面销毁），只按原任务号查询/下载；
//   ④ 交付失败：任务中心“恢复下载”取回原任务成片，不新建任务；
//   ⑤ 本地保存失败：IndexedDB 写任务记录失败时显示“本地保存失败 · 待恢复”，恢复后收敛，期间不新建付费任务；
//   ⑥ 新工作：“仅补空白”运行覆盖全部 12 镜——复用已有 6 镜，只为其余 6 镜付费；
//   ⑦ 远端交付过期：已下载的完整成片仍“本地文件已校验”，可入轨；
//   ⑧ 入轨（两批）→ 浏览器导出 WebM → ffprobe 逐帧解码；
//   ⑨ 工程包导出 → 全新浏览器配置导入同一账户：分镜、片段与原任务号保留，零新建。
// 断言付费请求总数恰为计划数（图片 12、视频 12），任何环节不盲目重新生成；浏览器零外部请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium, CHROME, BROWSER_OK, FFMPEG_OK, MP4, MODELS_11, realPng, openCanvasDock, clickCanvasAction } from './e2e-helpers.mjs';
import { startHostedTopology, syntheticNewApi, signIn, downloadViaTaskCenter } from './hosted-topology.mjs';

const SHOTS = 12, IMAGE_MODEL = 'gpt-image-2.5-flare', VIDEO_MODEL = 'minimax-h3-768p-per-second';
const IDB_FAIL = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    // 账户分区后的任务记录键形如 hosted:v1:u1:task:<项目>:<任务>
    if (window.__failTaskWrites && typeof key === 'string' && /(^|:)task:/.test(key)) throw new DOMException('模拟磁盘已满', 'QuotaExceededError');
    return put.call(this, value, key);
  };
};

test('托管 12 镜商业流程：已有产出 + 已受理任务 + 新工作；刷新/查询失败/交付失败/本地保存失败/远端过期；入轨导出；工程包迁移到干净浏览器', { timeout: 600000, skip: (!BROWSER_OK || !FFMPEG_OK) && '需要浏览器与 FFmpeg（严格门禁中缺失即失败）' }, async t => {
  const api = syntheticNewApi({ videoBytes: MP4, models: [...MODELS_11, IMAGE_MODEL] });
  const topo = await startHostedTopology({ newApi: api });
  t.after(() => topo.close());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close().catch(() => {}));
  const external = [];
  const newContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin === topo.origin) return r.continue(); external.push(u.href); return r.abort(); });
    await ctx.addInitScript(IDB_FAIL);
    const page = await ctx.newPage();
    page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
    return { ctx, page };
  };
  const { page } = await newContext();
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  api.setImage(await realPng(page, 200));
  const paid = () => api.state.images.length + api.state.creates.length;

  // ---- 建 12 镜 ----
  const prep = await page.evaluate(async ([IMAGE_MODEL, VIDEO_MODEL, N]) => {
    const x = window.__xp, s = x.store;
    await s.newProject('托管商业项目 · 12 镜');
    // 剧本导入（真实解析与原子应用路径）：12 场，统一角色设定
    const script = JSON.stringify({ shots: Array.from({ length: N }, (_, i) => ({ title: `第 ${i + 1} 场`, duration: 4,
      description: `商业短片第 ${i + 1} 场`, characters: '主角：星盘向导', imagePrompt: `托管画面 ${i + 1}`, videoPrompt: `镜头运动 ${i + 1}` })) });
    const made = x.storyboards.fromScript(script, { mode: 'replace' });
    if (made.length !== N) throw new Error(`剧本导入 ${made.length} 场`);
    const targets = [];
    for (const shot of made) {
      x.storyboards.ensureImageNode(shot); x.storyboards.syncShotToNodes(shot.id);
      const image = s.node(shot.imageNodeId); image.data.model = IMAGE_MODEL; image.data.resolution = '1K'; image.data.ratio = '16:9';
      const video = x.storyboards.ensureVideoNode(shot); video.data.draft.model = VIDEO_MODEL; video.data.draft.ratio = '16:9'; video.data.draft.seconds = 4;
      targets.push(video.id);
    }
    await s.flush();
    return { pid: s.project.id, targets, shotIds: s.project.studio.shots.map(x => x.id) };
  }, [IMAGE_MODEL, VIDEO_MODEL, SHOTS]);

  // ---- ① 已有产出：前 4 镜 ----
  const first = await page.evaluate(async targets => (await window.__xp.workflow.start({ targets, confirmed: true, onlyEmpty: true })).status, prep.targets.slice(0, 4));
  assert.equal(first, 'done');
  assert.equal(api.state.images.length, 4); assert.equal(api.state.creates.length, 4);

  // ---- ② 已受理任务：第 5 镜视频被扣住在途且先连续查询失败；第 6 镜（续跑时新建）首次交付失败 ----
  api.holdNext(1);
  await page.evaluate(targets => { window.__bizRun = window.__xp.workflow.start({ targets, confirmed: true, onlyEmpty: true }).catch(e => ({ error: e.message })); }, prep.targets.slice(4, 6));
  const deadline = Date.now() + 60000;
  while (api.held().length < 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  const held1 = api.held()[0];
  assert.ok(held1, '第 5 镜的视频任务已受理并在途');
  api.failQueries(held1, 3);
  const createsBeforeReload = api.state.creates.length;
  // 项目切换（界面入口）：在途期间切到新项目再切回，任务身份不变、零新建
  await clickCanvasAction(page, '#btn-new-project');
  await page.waitForFunction(pid => window.__xp.store.project.id !== pid, prep.pid);
  await page.locator('#project-list').selectOption(prep.pid);
  await page.waitForFunction(pid => window.__xp.store.project.id === pid, prep.pid);
  assert.equal(api.state.creates.length, createsBeforeReload, '切换项目不产生新 POST');
  const keyOf = id => api.state.creates[[...api.state.tasks.keys()].indexOf(id)]?.key;

  // ---- ③ 刷新：自动恢复账号，新页面接管原运行：第 5 镜只按原任务号查询；第 6 镜是计划内的新工作 ----
  await page.reload();
  await page.waitForFunction(() => window.__xp?.store?.project);
  assert.equal(api.state.creates.length, createsBeforeReload, '刷新自动恢复账号不产生 POST');
  api.failNextContent(1);   // 续跑中新建的第 6 镜任务：首次交付失败
  api.release(held1);
  const resumed = await page.evaluate(async pid => {
    const x = window.__xp;
    if (x.store.project.id !== pid) await x.store.openProject(pid);
    const st = x.workflow.getState();
    if (st?.status === 'running' || st?.status === 'paused') await x.workflow.resume();
    const until = Date.now() + 120000;
    for (;;) { const s = x.workflow.getState(); if (s?.status !== 'running' || Date.now() > until) return { status: s?.status, nodes: Object.values(s?.nodes ?? {}).map(n => [n.status, n.reason ?? null]) }; await new Promise(r => setTimeout(r, 300)); }
  }, prep.pid);
  t.diagnostic(`HOSTED_BIZ_RESUME ${JSON.stringify(resumed)}`);
  assert.equal(api.state.creates.filter(c => c.key === keyOf(held1)).length, 1, '原受理任务没有被重新提交');
  assert.ok(api.state.creates.length <= createsBeforeReload + 1, '续跑只为计划内的第 6 镜新建一次');
  assert.ok(api.state.queries.some(q => q.task === held1), '查询失败后按原任务号继续查询');
  const shot6 = [...api.state.tasks.keys()][createsBeforeReload] ?? null;

  // ---- ④ 交付失败 → 任务中心恢复下载原任务（不新建） ----
  const createsAt4 = api.state.creates.length;
  for (const id of [held1, shot6].filter(Boolean)) await downloadViaTaskCenter(page, id, openCanvasDock);
  assert.equal(api.state.creates.length, createsAt4, '恢复下载不新建任务');
  const deadline2 = Date.now() + 60000;

  // ---- ⑤ 本地保存失败：显示待恢复，恢复后收敛；期间不新建付费任务 ----
  api.holdNext(1);
  await page.evaluate(targets => { window.__bizRun = window.__xp.workflow.start({ targets, confirmed: true, onlyEmpty: true }).catch(e => ({ error: e.message })); }, prep.targets.slice(6, 7));
  while (api.held().length < 1 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 200));
  const held3 = api.held()[0];
  await openCanvasDock(page, 'task');
  const row3 = `#task-list .task-item[data-task-id="${held3}"]`;
  await page.waitForSelector(row3, { timeout: 20000 });
  const createsAt3 = api.state.creates.length;
  await page.evaluate(() => { window.__failTaskWrites = true; });
  api.release(held3);
  await page.waitForFunction(s => document.querySelector(s)?.dataset.taskState === 'save_pending', row3, { timeout: 30000, polling: 200 });
  assert.match(await page.locator(row3).innerText(), /本地保存失败/);
  assert.equal(api.state.creates.length, createsAt3, '待恢复期间不新建付费任务');
  await page.evaluate(() => { window.__failTaskWrites = false; });
  await page.waitForFunction(s => { const st = document.querySelector(s)?.dataset.taskState; return st && st !== 'save_pending'; }, row3, { timeout: 60000, polling: 300 });
  await page.evaluate(() => window.__bizRun);

  // ---- ⑥ 新工作：“仅补空白”覆盖全部 12 镜，复用已完成的 7 镜，只为其余 5 镜付费 ----
  const plan = await page.evaluate(async targets => {
    const pv = await window.__xp.workflow.preview({ targets, onlyEmpty: true });
    const r = await window.__xp.workflow.start({ plan: pv.plan, confirmed: true });
    return { summary: pv.skipSummary, status: r.status };
  }, prep.targets);
  t.diagnostic(`HOSTED_BIZ_PLAN ${JSON.stringify(plan)}`);
  assert.equal(plan.status, 'done');
  assert.equal(api.state.images.length, SHOTS, `图片付费恰为 ${SHOTS}`);
  assert.equal(api.state.creates.length, SHOTS, `视频付费恰为 ${SHOTS}`);
  assert.equal(new Set(api.state.creates.map(c => c.key)).size, SHOTS, '幂等键唯一');

  // ---- ⑥b 重新执行已有付费产出：界面默认“仅补空白”；取消勾选后必须逐个列出并单独确认，取消则零请求 ----
  await openCanvasDock(page, 'run');
  const onlyEmptyBox = page.getByRole('checkbox', { name: '仅补齐空白节点' });
  assert.equal(await onlyEmptyBox.isChecked(), true, '默认仅补空白');
  await page.locator('#workflow-panel select').first().selectOption('all');
  await onlyEmptyBox.uncheck();
  const paidBefore = paid();
  await page.getByRole('button', { name: '提交运行' }).click();
  const dlg = page.locator('.modal').last();
  await dlg.waitFor();
  const dlgText = await dlg.innerText();
  assert.match(dlgText, /将重新执行已有结果的节点/);
  assert.match(dlgText, /会重新生成并再次计费/);
  assert.match(dlgText, /视频节点已有任务，不会重新提交/);
  assert.match(dlgText, /仅补空白 ¥/);
  await dlg.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(800);
  assert.equal(paid(), paidBefore, '取消后零新付费请求');
  await onlyEmptyBox.check();

  // ---- ⑦ 远端交付过期：已下载完整成片仍可用 ----
  const firstTask = api.state.creates.length && [...api.state.tasks.keys()][0];
  api.expire(firstTask);
  await page.evaluate(id => window.__xp.runner.requery?.(id), firstTask);
  await page.waitForTimeout(1500);
  await openCanvasDock(page, 'task');
  await page.waitForFunction(id => document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState === 'local_verified', firstTask, { timeout: 20000 });
  assert.match(await page.locator(`#task-list .task-item[data-task-id="${firstTask}"]`).innerText(), /远端下载链接已过期/);

  // ---- ⑧ 入轨（两批）→ 浏览器导出 → 逐帧解码 ----
  const tl = await page.evaluate(async shotIds => {
    const x = window.__xp, out = [];
    for (const ids of [shotIds.slice(0, 6), shotIds.slice(6)]) {
      const p = await x.timeline.previewShotsToTimeline({ shotIds: ids });
      if (!p.ok) return { error: p.code, reason: p.reason };
      const r = await x.timeline.applyTimelinePlan(p.plan);
      out.push(r.ok ? r.clips.length : r.code);
    }
    const r = await x.timeline.renderExport({ via: 'browser', silent: true, format: 'webm' });
    return { applied: out, clips: x.timeline.clips().filter(c => c.track === 'v1').length, bytes: [...new Uint8Array(await r.blob.arrayBuffer())], via: r.via };
  }, prep.shotIds);
  assert.ok(!tl.error, JSON.stringify(tl));
  assert.deepEqual(tl.applied, [6, 6]); assert.equal(tl.clips, SHOTS); assert.equal(tl.via, 'browser');
  const dir = await mkdtemp(join(tmpdir(), 'hosted-biz-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const webm = join(dir, 'export.webm');
  await writeFile(webm, Buffer.from(tl.bytes));
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', webm, '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-f', 'null', '-'], { encoding: 'utf8' });
  assert.ok(dec.status === 0 && !dec.stderr.trim(), `导出解码有错误：${dec.stderr.slice(0, 300)}`);

  // ---- ⑨ 工程包导出 → 全新浏览器配置（干净 IndexedDB）导入同一账户 ----
  const pkg = await page.evaluate(async () => {
    const x = window.__xp, { buildProjectPackage } = await import('./export-project.js');
    const bytes = await buildProjectPackage({ projectJson: await x.store.exportJSON(), clips: x.store.project.studio.timeline, meta: x.store.project.studio.timelineMeta,
      assets: x.store.project.assets, blobOf: id => x.assets.blobOf(id) });
    return [...bytes];
  });
  assert.ok(pkg.length > 1000);
  const createsBeforeImport = api.state.creates.length;
  const clean = await newContext();
  await clean.page.goto(`${topo.origin}/canvas/`);
  await signIn(clean.page, 'sk-synth-alice-2');
  const imported = await clean.page.evaluate(async bytes => {
    const x = window.__xp, { importProjectPackage } = await import('./export-project.js');
    const r = await importProjectPackage({ store: x.store, assets: x.assets }, new Uint8Array(bytes));
    const tasks = await x.store.tasksOfProject();
    return { shots: r.project.studio.shots.length, clips: r.project.studio.timeline.length, missing: r.missing?.length ?? 0, taskIds: tasks.map(t => t.taskId).sort() };
  }, pkg);
  t.diagnostic(`HOSTED_BIZ_IMPORT ${JSON.stringify({ ...imported, taskIds: imported.taskIds.length })}`);
  assert.equal(imported.shots, SHOTS); assert.equal(imported.clips, SHOTS); assert.equal(imported.missing, 0);
  assert.deepEqual(imported.taskIds, [...api.state.tasks.keys()].sort(), '导入后保留原任务号');
  await clean.page.waitForTimeout(1500);
  assert.equal(api.state.creates.length, createsBeforeImport, '导入不自动生成');

  t.diagnostic(`HOSTED_BIZ_SUMMARY ${JSON.stringify({ images: api.state.images.length, videos: api.state.creates.length, queries: api.state.queries.length, downloads: api.state.downloads.length, identityChecks: api.state.identityChecks, external: external.length })}`);
  assert.equal(paid(), SHOTS * 2);
  assert.equal(api.state.directVideoPosts, 0, '视频新建全部经视频网关，未直达 New API');
  assert.ok([...api.state.tasks.keys()].every(id => /^vjob_[a-f0-9]{32}$/.test(id)), '全部为网关任务号');
  assert.deepEqual(external, []);
  assert.deepEqual(page.errors, []); assert.deepEqual(clean.page.errors, []);
});
