import {clickCanvasAction,openCanvasDock} from './e2e-helpers.mjs';
// 独立验收：针对 2026-09-15 审查复现，真实页面/IndexedDB/Web Locks，全部模拟上游。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, FIXTURES, MODELS_11, setKey, CHROME } from './e2e-helpers.mjs';

test('审查修复：导入、状态、任务恢复、快捷键、拖线、手机与跨标签提交', { timeout: 120000 }, async t => {
  const calls = [], bytes = await readFile(join(FIXTURES, 'sample.mp4'));
  const staticDir = process.env.CANVAS_TEST_DIST || join(ROOT, 'dist');
  const server = createCanvasServer({ staticDir, directorDir: staticDir, upstreamFetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/models') return Response.json({ data: MODELS_11.map(id => ({ id })) });
    if (path === '/v1/videos' && init.method === 'POST') {
      calls.push({ key: init.headers['Idempotency-Key'], body: init.body });
      const id = `mock-safety-${calls.length}`;
      await new Promise(resolve => setTimeout(resolve, 150));
      return Response.json({ id, status: 'queued' });
    }
    if (path.endsWith('/content')) return new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
    if (path.startsWith('/v1/videos/')) return Response.json({ status: 'completed', delivery_status: 'ready', progress: 100 });
    throw new Error(`Unexpected mock path ${path}`);
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-accelerated-video-decode'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => window.__xp?.store?.project);
  await setKey(page, 'mock-safety-only');
  await clickCanvasAction(page, '[data-add-node="gen"]'); await page.click('.node-gen .node-head');
  await page.fill('#inspector textarea', '切换模型保留公共提示词');
  await page.locator('#inspector select').first().selectOption('wan-3.0');
  await page.fill('#inspector input[type=number]', '6');
  await page.locator('#inspector select').first().selectOption('minimax-h3-768p-per-second');
  await page.evaluate(async () => { const s = window.__xp.store; await s.importJSON(await s.exportJSON()); });
  await page.click('.node-gen .node-head');
  await page.locator('#inspector select').first().selectOption('wan-3.0');
  const imported = await page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').data.draft);
  assert.equal(imported.model, 'wan-3.0', '导入后选择 Wan 应保留选定型号');
  assert.equal(imported.prompt, '切换模型保留公共提示词');
  assert.equal(imported.seconds, 6, '导入后每模型时长仍恢复');

  await clickCanvasAction(page, '#btn-new-project'); await clickCanvasAction(page, '[data-add-node="gen"]'); await page.click('.node-gen .node-head');
  await page.fill('#inspector textarea', '本机模拟任务，检查状态更新');
  await page.getByRole('button', { name: /^(上传并)?提交生成$/ }).click();
  await page.waitForFunction(() => { const n = window.__xp.store.project.nodes.find(n => n.type === 'gen'); return n.data.run?.taskId && window.__xp.runner.taskPeek(n.data.run.taskId)?.status === 'completed'; });
  await page.waitForFunction(() => !document.querySelector('.node-gen .node-body')?.innerText.includes('排队中'));
  assert.match(await page.locator('.node-gen .node-body').innerText(), /完成|completed/);
  const overlap = await page.locator('.node-gen .port.out').evaluate(e => {
    const dot = e.querySelector('.dot'), label = [...e.querySelectorAll('span')].find(s => !s.classList.contains('dot'));
    const a = dot.getBoundingClientRect(), b = label.getBoundingClientRect();
    return Math.min(a.right, b.right) - Math.max(a.left, b.left);
  });
  assert.ok(overlap <= 0, '成片标签与端口圆点不得重叠');
  const taskId = await page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').data.run.taskId);
  await page.click('.node-gen .del');
  await openCanvasDock(page, 'task');
  // 任务中心（R05-A）：本机尚无已校验文件 → 「恢复下载」；已有 → 直接「本地文件已校验」可预览/保存
  const row = page.locator(`#task-list .task-item[data-task-id="${taskId}"]`);
  await row.waitFor();
  await page.waitForFunction(id => ['ready_to_download', 'local_verified'].includes(document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState), taskId);
  // 成片可能已被自动取回（行随之从「待下载」变为「本地文件已校验」并重建）：先等自动取回，仍待下载才由用户点「恢复下载」
  const auto = await page.waitForFunction(id => document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState === 'local_verified', taskId, { timeout: 5000 }).then(() => true, () => false);
  if (!auto) await row.getByRole('button', { name: '恢复下载' }).click();
  await page.waitForFunction(id => window.__xp.runner.localResult(id).then(r => r.ready), taskId);
  await page.waitForFunction(id => document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState === 'local_verified', taskId);
  assert.ok(await row.getByRole('button', { name: '预览' }).count(), '删除节点后任务中心仍可预览本机成片');
  assert.ok(await page.evaluate(id => window.__xp.runner.resultURL(id).then(Boolean), taskId), '删除节点后仍可取得任务结果');

  await clickCanvasAction(page, '[data-add-node="gen"]'); await page.click('.node-gen .node-head');
  await clickCanvasAction(page, '#btn-rename'); await page.locator('.modal').getByRole('button', { name: '保存' }).focus(); await page.keyboard.press('Delete');
  assert.equal(await page.locator('.node-gen').count(), 1, '弹窗不得穿透删除画布节点');
  await page.keyboard.press('Escape');
  if (await page.locator('.modal').count()) await page.mouse.click(20, 850);
  await page.evaluate(() => {
    const s = window.__xp.store;
    for (const n of [...s.project.nodes]) s.removeNode(n.id);
    const d = () => ({ directOutput: false, draft: { model: 'minimax-h3-768p-per-second', prompt: 'mock', intent: 'text', seconds: 4, ratio: '16:9' }, perModel: {} });
    s.addNode('gen', 20, 200, d()); s.addNode('gen', 400, 200, d());
    // 节点按固定画布坐标摆放：先回到默认视图（此前选中节点时编辑器可能已为腾出空间滚动过画布）
    const b = window.__xp.board; b.select(null); b.view.x = 0; b.view.y = 0; b.view.scale = 1; b.applyView();
  });
  const from = await page.locator('.node-gen .port.out .dot').first().boundingBox();
  const to = await page.locator('.node-gen .port[data-port="refs"] .dot').last().boundingBox();
  await page.mouse.move(from.x + 6, from.y + 6); await page.mouse.down(); await page.mouse.move(500, 20); await page.mouse.up();
  await page.mouse.click(to.x + 6, to.y + 6);
  assert.equal(await page.evaluate(() => window.__xp.store.project.edges.length), 0, '画布外结束连线后普通点击不能接线');
  await page.mouse.move(from.x + 6, from.y + 6); await page.mouse.down();
  await page.mouse.move(to.x + 6, to.y + 6, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__xp.store.project.edges.length), 1, '修复取消后正常拖线仍应可用');

  // 两个真实同源标签使用独立 JS 实例、共享 IndexedDB 和 Web Locks。
  const identity = await page.evaluate(async () => {
    const s = window.__xp.store; await s.newProject('跨标签独立验收');
    const n = s.addNode('gen', 100, 100, { draft: { model: 'minimax-h3-768p-per-second', prompt: '同一节点两标签提交', intent: 'text', seconds: 4, ratio: '16:9', switches: {} }, perModel: {} });
    await s.flush(); return { projectId: s.project.id, nodeId: n.id };
  });
  const page2 = await context.newPage(); await page2.goto(origin); await page2.waitForFunction(() => window.__xp?.store?.project);
  await setKey(page2, 'mock-safety-only');
  await page2.evaluate(async id => { await window.__xp.store.openProject(id); }, identity.projectId);
  const before = calls.length;
  await Promise.all([page, page2].map(p => p.evaluate(async id => { const s = window.__xp.store; await window.__xp.runner.submit(s.node(id)); }, identity.nodeId)));
  assert.equal(calls.length - before, 1, '两个实际标签页同一节点应只创建一次');
  const atomic = await page.evaluate(async () => {
    const { createIdbStorage } = await import('/storage.js');
    const db = await createIdbStorage();
    if (typeof db.batch !== 'function') return { skipped: true };
    const key = 'mock-batch-atomic-' + crypto.randomUUID();
    let rejected = false;
    try { await db.batch([[key, { value: 1 }], [key + '-invalid', () => {}]]); } catch { rejected = true; }
    await new Promise(resolve => setTimeout(resolve, 20));
    return { rejected, absent: (await db.get(key)) == null };
  });
  if (!atomic.skipped) assert.deepEqual(atomic, { rejected: true, absent: true }, '真实 IndexedDB 批次中途失败必须整批回滚');
  await page2.close(); await context.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await mobile.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const mp = await mobile.newPage(); await mp.goto(origin); await mp.waitForFunction(() => window.__xp?.store?.project);
  await mp.click('#sidebar-toggle'); await clickCanvasAction(mp, '[data-add-node="gen"]');
  // 新建节点会选中并打开检查器；390px 放不下两个抽屉，侧栏随之收起（不再互相遮挡）。
  await mp.waitForFunction(() => document.querySelector('#inspector')?.classList.contains('open'), null, { timeout: 10000 });
  assert.ok(await mp.locator('#sidebar').evaluate(e => !e.classList.contains('open')), '窄屏检查器与侧栏互斥');
  await mp.click('#inspector .drawer-close');
  await mp.click('.node-gen .node-head');
  assert.ok(await mp.locator('#inspector').evaluate(e => e.classList.contains('open')), '手机点选节点必须打开参数面板');
  await mobile.close();
});
