// 默认托管导演台按需装配；显式旧插件 fixture 保留缺资源提示与工程保护覆盖。
// 这里只验收画布入口装配；真实 3D 与导出由独立导演台验收覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, makeState, mockUpstream } from './e2e-helpers.mjs';
import { installLegacyDirectorRuntime, installDirectorAssemblyFixture, assertHostedDirectorEntry } from './legacy-director-fixture.mjs';

test('旧插件兼容 fixture：缺少资源时入口标记、说明原因且不新建节点，已有节点保留', { timeout: 90000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, 'tests', 'no-director-assets'), upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const health = await (await fetch(origin + '/health')).json();
  assert.equal(health.director_available, true, '/health 如实报告已随默认构建安装的托管导演台');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  await installLegacyDirectorRuntime(ctx, { available: false, reason: '插件资源不随代码仓库分发', pluginVersion: null });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  await page.waitForTimeout(300);   // 等 /health 回填

  // 入口徽标
  assert.equal(await page.locator('#btn-director-mode .dev-badge').textContent(), '开发中');
  assert.equal(await page.locator('[data-add-node="director"] .dev-badge').count(), 1);
  // 顶栏入口：说明原因，不新建节点
  await page.click('#btn-director-mode');
  const dlg = page.locator('.modal', { hasText: '3D 导演台（开发中）' });
  await dlg.waitFor({ timeout: 5000 });
  assert.match(await dlg.textContent(), /不随代码仓库分发/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__xp.store.project.nodes.filter(n => n.type === 'director').length), 0, '不新建空白导演台');
  // 右键添加菜单：标注开发中，选择后同样只说明
  assert.equal(await page.locator('.modal').count(), 0, '说明对话框已关闭');
  await page.mouse.click(950, 180, { button: 'right' });
  const item = page.locator('.menu [role=menuitem]', { hasText: '导演台' }).first();
  await item.waitFor({ timeout: 5000 });
  assert.equal(await item.locator('.menu-hint').textContent(), '开发中', '添加菜单标注开发中');
  await item.click();
  await page.locator('.modal', { hasText: '3D 导演台（开发中）' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__xp.store.project.nodes.filter(n => n.type === 'director').length), 0);
  // 已有工程中的导演台节点：保留，检查器标记开发中，打开按钮只说明
  const id = await page.evaluate(() => window.__xp.store.addNode('director', 300, 200, { title: '导演台' }).id);
  await page.locator(`[data-node="${id}"] .node-head`).click();
  assert.equal(await page.locator('#inspector .dev-badge').textContent(), '开发中');
  await page.locator(`[data-node="${id}"] button`, { hasText: '打开导演台' }).click();
  await page.locator('.modal', { hasText: '3D 导演台（开发中）' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(i => !!window.__xp.store.node(i), id), true, '已有导演台节点保留');
  assert.equal(await page.locator('iframe[src*="/director/"]').count(), 0, '未加载空白导演台页面');
  // 其他功能不受影响：分镜可打开
  await page.click('#btn-storyboard');
  await page.locator('.modal').first().waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
});

test('默认导演台：无需本机插件，无开发中提示，点击后按需加载同源入口并复用节点', { timeout: 90000 }, async t => {
  const state = makeState();
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: join(ROOT, 'tests', 'no-director-assets'), upstreamFetch: mockUpstream(state) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const external = [];
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  const entries = await installDirectorAssemblyFixture(ctx);
  const page = await ctx.newPage(), errors = [], requested = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requested.push(new URL(r.url()).pathname));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  assert.equal(await page.locator('#btn-director-mode .dev-badge,[data-add-node="director"] .dev-badge').count(), 0);
  assert.equal(await page.locator('.director-frame').count(), 0);
  assert.equal(entries.length, 0, '启动画布不加载导演台 iframe');
  assert.equal(requested.filter(path => path.includes('/director/')).length, 0,
    `打开前不下载完整导演台资源：${requested.filter(path => path.includes('/director/')).join(', ')}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#btn-director-mode').click();
    await page.frameLocator('.director-frame').locator('[data-director-assembly-fixture]').waitFor();
    const scope = await page.evaluate(() => ({ projectId: window.__xp.store.project.id,
      nodeId: window.__xp.store.project.nodes.find(n => n.type === 'director').id }));
    assertHostedDirectorEntry(await page.locator('.director-frame').getAttribute('src'), origin, scope);
    assert.equal(await page.evaluate(() => window.__xp.store.project.nodes.filter(n => n.type === 'director').length), 1);
    assert.doesNotMatch(await page.locator('.modal').last().innerText(), /开发中|插件资源|无法确认导演台资源/);
    await page.evaluate(id => window.__xp.host.closeEditor(id), scope.nodeId);
  }
  assert.equal(entries.length, 2);
  assert.notEqual(new URL(entries[0]).searchParams.get('sessionId'), new URL(entries[1]).searchParams.get('sessionId'));
  assert.equal(requested.some(path => /\/__hub-sdk__\.js$/.test(path)), false, '不请求旧插件 SDK');
  assert.equal(state.creates.length, 0, '打开与关闭入口不创建模型任务');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
