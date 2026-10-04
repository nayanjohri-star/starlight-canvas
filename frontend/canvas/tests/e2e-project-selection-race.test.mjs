import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK } from './e2e-helpers.mjs';

test('project selection retains the requested project while a pending save refreshes the list',
  { timeout: 60000, skip: !BROWSER_OK && '需要真实浏览器' }, async t => {
    let upstreamCalls = 0;
    const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
      directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),
      upstreamFetch: async () => { upstreamCalls++; throw new Error('禁止真实上游请求'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.__xp?.store?.project);
    const ids = await page.evaluate(async () => {
      const store = window.__xp.store;
      await store.newProject('请求打开的项目'); const requested = store.project.id;
      await store.newProject('刷新时仍打开的项目'); const current = store.project.id;
      return { requested, current };
    });
    await page.waitForFunction(({ requested, current }) => {
      const select = document.querySelector('#project-list');
      return select.value === current && [...select.options].some(option => option.value === requested);
    }, ids);
    await page.evaluate(() => {
      const store = window.__xp.store, flush = store.flush.bind(store);
      const gate = new Promise(resolve => { window.__releaseProjectSelectionSave = resolve; });
      store.flush = async (...args) => {
        store.flush = flush; window.__projectSelectionSaveStarted = true;
        await gate; return flush(...args);
      };
    });
    await page.locator('#project-list').selectOption(ids.requested);
    await page.waitForFunction(() => window.__projectSelectionSaveStarted);
    // The normal project notification rebuilds the real select while saving is pending.
    await page.evaluate(() => window.__xp.store.touch({ type: 'project' }));
    await page.waitForFunction(id => document.querySelector('#project-list').value === id, ids.current);
    await page.evaluate(() => window.__releaseProjectSelectionSave());
    await page.waitForFunction(id => window.__xp.store.project.id === id, ids.requested, { timeout: 5000 });
    await page.waitForFunction(id => document.querySelector('#project-list').value === id, ids.requested);
    assert.equal(await page.evaluate(() => window.__xp.store.project.name), '请求打开的项目');
    assert.equal(upstreamCalls, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  });
