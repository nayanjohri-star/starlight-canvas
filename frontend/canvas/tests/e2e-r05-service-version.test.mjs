// R05 独立验收（浏览器）：前后端版本检测与导演台四态。
//  · 真实混合场景：0.4.4 旧服务进程（从基线提交 c582a02 取出的服务端代码，独立子进程运行）
//    仍在运行，而磁盘上的页面已是新构建 → 页面显示自身版本、提示服务过旧；导演台检测失败，不新建节点。
//  · 新服务：检测慢（超时）、返回 500、协议比页面新；「重新检测」通过后才执行原操作，且只执行一次。
//  · 已有工程中的导演台节点在任何状态下都保留。
// 全部本机模拟上游，零真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, makeState, mockUpstream } from './e2e-helpers.mjs';
import { installLegacyDirectorRuntime } from './legacy-director-fixture.mjs';
import { checkDirectorAssets } from '../server/app.mjs';

const BASELINE = 'c582a02a6d9b2c5a1489444fbcaa335b65745ee4';
const DIST = process.env.CANVAS_TEST_DIST || join(ROOT, 'dist');
const NO_ASSETS = join(ROOT, 'tests', 'no-director-assets');

async function startOldService(t) {
  const dir = await mkdtemp(join(tmpdir(), 'r05-old-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 逐文件 git show 取出基线服务端代码（跨平台，不依赖 tar）
  const repo = join(ROOT, '..', '..');
  // 旧进程加载的是旧版服务端与其依赖的旧 src 模块，一并取出
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', BASELINE, 'frontend/canvas/server', 'frontend/canvas/src', 'frontend/canvas/package.json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(ls.status, 0, `无法读取基线提交（需要完整 git 历史）：${ls.stderr}`);
  const files = ls.stdout.split('\n').filter(f => f && !f.endsWith('.test.mjs'));
  assert.ok(files.includes('frontend/canvas/server/app.mjs'), '基线提交中应有 server/app.mjs');
  for (const f of files) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    const r = spawnSync('git', ['show', `${BASELINE}:${f}`], { cwd: repo, encoding: 'buffer', maxBuffer: 16 << 20 });
    assert.equal(r.status, 0, `取出 ${f} 失败`);
    await writeFile(join(dir, f), r.stdout);
  }
  const launcher = join(dir, 'launch.mjs');
  await writeFile(launcher, [
    "import { createCanvasServer } from './frontend/canvas/server/app.mjs';",
    "const s = createCanvasServer({ staticDir: process.env.R05_DIST, directorDir: process.env.R05_DIRECTOR,",
    "  upstreamFetch: async () => Response.json({ error: { message: 'offline test' } }, { status: 503 }) });",
    "s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));",
  ].join('\n'));
  const child = spawn(process.execPath, [launcher], { env: { PATH: process.env.PATH, R05_DIST: DIST, R05_DIRECTOR: NO_ASSETS }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; const m = out.match(/PORT=(\d+)/); if (m) resolve(Number(m[1])); });
    let err = ''; child.stderr.on('data', d => { err += d; });
    child.on('exit', c => reject(new Error(`旧服务退出 ${c}：${err.slice(0, 800)}`)));
    setTimeout(() => reject(new Error('旧服务启动超时')), 15000);
  });
  return `http://127.0.0.1:${port}`;
}

async function newPage(browser, origin, t) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => ctx.close().catch(() => {}));
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  await installLegacyDirectorRuntime(ctx); // R05 targets optional legacy plugin health, not hosted availability.
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors };
}
const directorCount = page => page.evaluate(() => window.__xp.store.project.nodes.filter(n => n.type === 'director').length);

test('R05 版本检测：旧服务进程 + 新页面文件 → 提示服务过旧，导演台检测失败且不建节点', { timeout: 90000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const built = JSON.parse(await readFile(join(DIST, 'build.json'), 'utf8'));
  const origin = await startOldService(t);
  const oldHealth = await (await fetch(origin + '/health')).json();
  assert.equal(oldHealth.apiLevel, undefined, '前提：确实是未报告 apiLevel 的旧服务');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(() => browser.close().catch(() => {}));
  const { page, errors } = await newPage(browser, origin, t);
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  await page.waitForFunction(() => !document.getElementById('service-banner').hidden, null, { timeout: 10000 });
  assert.equal(await page.locator('#build-badge').textContent(), `v${built.version}`, '页面显示自身构建版本');
  assert.equal(await page.locator('#build-badge').getAttribute('data-compat'), 'service-outdated');
  assert.match(await page.locator('#service-banner').textContent(), /本机服务版本较旧.*请重启本机服务/);
  await page.click('#btn-director-mode');
  const dlg = page.locator('.modal', { hasText: '无法确认导演台资源' });
  await dlg.waitFor({ timeout: 5000 });
  assert.equal(await dlg.locator('button', { hasText: '重新检测' }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await directorCount(page), 0, '未确认可用时不新建导演台');
  // 已有导演台节点保留（数据不因检测失败被清理）
  const id = await page.evaluate(() => window.__xp.store.addNode('director', 200, 200, { title: '导演台', scene: { keep: 1 } }).id);
  await page.locator(`[data-node="${id}"] button`, { hasText: '打开导演台' }).click();
  await page.locator('.modal', { hasText: '无法确认导演台资源' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(i => window.__xp.store.node(i)?.data?.scene, id), { keep: 1 });
  assert.deepEqual(errors, []);
});

test('R05 导演台四态：检测超时 / 500 / 页面过旧，重新检测确认可用后才执行原操作且只执行一次', { timeout: 120000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const server = createCanvasServer({ staticDir: DIST, directorDir: NO_ASSETS, upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const missingLegacy = checkDirectorAssets(NO_ASSETS);
  assert.equal(missingLegacy.available, false, '前提：旧本机插件目录缺资源');
  const bundledHealth = await (await fetch(origin + '/health')).json();
  assert.equal(bundledHealth.director.available, true, '真实新版服务报告随构建安装的托管导演台可用');
  assert.equal(bundledHealth.director_available, true, '旧布尔字段与真实捆绑资源状态一致');
  assert.match(bundledHealth.director.pluginVersion, /^cozyclay-/, '可用资源来自捆绑导演台，而非旧插件目录');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(() => browser.close().catch(() => {}));

  // 1) 检测挂起 → 检测中不放行 → 超时后检测失败
  {
    const { page, errors } = await newPage(browser, origin, t);
    await page.route('**/health', () => { /* 永不响应 */ });
    await page.goto(origin);
    await page.waitForFunction(() => window.__xp?.store?.project);
    await page.click('#btn-director-mode');
    await page.locator('.modal', { hasText: '正在检测导演台资源' }).waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    assert.equal(await directorCount(page), 0, '检测中不放行');
    await page.waitForFunction(() => /超时/.test(document.getElementById('service-banner')?.textContent ?? ''), null, { timeout: 10000 });
    await page.click('#btn-director-mode');
    await page.locator('.modal', { hasText: '检测本机服务超时' }).waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    assert.equal(await directorCount(page), 0);
    assert.deepEqual(errors, []);
  }
  // 2) 500 → 失败；3) 协议比页面新 → 提示刷新页面
  {
    const { page } = await newPage(browser, origin, t);
    let mode = '500';
    await page.route('**/health', async route => {
      if (mode === '500') return route.fulfill({ status: 500, body: 'boom' });
      const res = await route.fetch(); const j = await res.json();
      if (mode === 'newer') j.apiLevel += 1;
      // 此页面显式使用旧插件 runtime；真实服务的捆绑资源可用状态已在上方独立验证。
      j.director = mode === 'available'
        ? { available: true, reason: null, pluginVersion: 'test' } : missingLegacy;
      j.director_available = j.director.available;
      return route.fulfill({ response: res, json: j });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.__xp?.store?.project);
    await page.waitForFunction(() => /本机服务返回错误/.test(document.getElementById('service-banner')?.textContent ?? ''), null, { timeout: 10000 });
    await page.click('#btn-director-mode');
    await page.locator('.modal', { hasText: '本机服务返回错误' }).waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    assert.equal(await directorCount(page), 0, '500 检测失败不新建导演台');
    mode = 'newer';
    await page.locator('#service-banner button', { hasText: '重新检测' }).click();
    await page.waitForFunction(() => /请刷新页面/.test(document.getElementById('service-banner')?.textContent ?? ''), null, { timeout: 10000 });
    assert.equal(await page.locator('#build-badge').getAttribute('data-compat'), 'page-outdated');
    assert.equal(await directorCount(page), 0, '协议检测与刷新提示不新建导演台');
    // 4) 缺资源（服务确认 unavailable）→ 说明且不建；「重新检测」确认可用 → 执行原操作一次
    mode = 'ok';
    await page.locator('#service-banner button', { hasText: '重新检测' }).click();
    await page.waitForFunction(() => document.getElementById('service-banner').hidden, null, { timeout: 10000 });
    await page.click('#btn-director-mode');
    const dlg = page.locator('.modal', { hasText: '插件资源不随代码仓库分发' });
    await dlg.waitFor({ timeout: 5000 });
    assert.equal(await directorCount(page), 0);
    mode = 'available';
    await dlg.locator('button', { hasText: '重新检测' }).click();
    await page.waitForFunction(() => window.__xp.store.project.nodes.some(n => n.type === 'director'), null, { timeout: 10000 });
    await page.waitForTimeout(300);
    assert.equal(await directorCount(page), 1, '确认可用后原操作只执行一次');
  }
});
