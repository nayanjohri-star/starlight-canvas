import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, SHOTS, createCanvasServer, setKey, watchEgress } from './e2e-helpers.mjs';

// 图片生成面板：大图结果在面板内等比完整显示、面板只纵向滚动、提交 → 生成中（计时）→ 完成（保留用时）/ 失败。
test('image panel fits large results, keeps one width and shows live generation status', { timeout: 120000 }, async t => {
  let big = null, release = null, reject = false;
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-image-2.5-flare' }] });
    if (path.endsWith('/images/generations')) {
      await new Promise(r => { release = r; });
      if (reject) return Response.json({ error: { message: 'prompt rejected', code: 'bad_prompt' } }, { status: 400 });
      return Response.json({ data: [{ b64_json: Buffer.from(big).toString('base64') }] });
    }
    return Response.json({ data: [] });
  } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // Answer the upstream request only after it has really arrived (生成中 shows as soon as sentAt is saved).
  const releaseNext = async () => {
    const t0 = Date.now();
    while (!release) { if (Date.now() - t0 > 30000) throw new Error('image request never reached upstream'); await new Promise(r => setTimeout(r, 20)); }
    const r = release; release = null; r();
  };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { release?.(); await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const egress = await watchEgress(page, { abort: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  big = await page.evaluate(() => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1152;
    const g = c.getContext('2d'); g.fillStyle = '#2a6'; g.fillRect(0, 0, 2048, 1152);
    c.toBlob(async b => res([...new Uint8Array(await b.arrayBuffer())]), 'image/png');
  }));
  const id = await page.evaluate(() => window.__xp.store.addNode('image', 400, 120, {
    model: 'gpt-image-2.5-flare', resolution: '2K', ratio: '16:9', prompt: '一只猫' }).id);
  const select = async () => {
    await page.mouse.click(1250, 700);
    await page.locator(`[data-node="${id}"] .node-head`).click();
    await page.waitForSelector('#inspector .image-generation-form');
  };
  const status = () => page.locator('#inspector .gen-run-line').innerText();
  const layout = () => page.evaluate(() => {
    const box = document.querySelector('#inspector'), r = s => box.querySelector(s)?.getBoundingClientRect();
    const panel = box.getBoundingClientRect(), head = r('.insp-head'), cta = r('.gen-cta'), btn = r('.gen-cta button.primary'), img = r('.image-result-preview img');
    return { client: box.clientWidth, scroll: box.scrollWidth, panel: { top: panel.top, bottom: panel.bottom },
      head: head?.width, cta: cta?.width, btn: btn && { top: btn.top, bottom: btn.bottom }, img: img && { w: img.width, h: img.height } };
  });
  const assertLayout = (m, tag) => {
    assert.ok(m.scroll <= m.client + 1, `${tag}: panel must not scroll horizontally (${m.scroll} > ${m.client})`);
    assert.ok(Math.abs(m.head - m.cta) <= 2, `${tag}: title bar ${m.head} and submit bar ${m.cta} must share one width`);
    assert.ok(m.img && m.img.w <= m.client && m.img.h <= 260, `${tag}: preview must fit the panel (${JSON.stringify(m.img)})`);
    assert.ok(m.btn.top >= m.panel.top && m.btn.bottom <= m.panel.bottom + 1, `${tag}: generate button must stay visible`);
  };

  await select();
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await page.waitForFunction(() => /生成中/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''));
  await page.waitForFunction(() => /已用时 [1-9]\d*秒/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''), null, { timeout: 5000 });
  assert.match(await page.locator('#inspector .gen-cta button.primary').innerText(), /^生成中/);
  assert.equal(await page.locator('#inspector .gen-cta button.primary').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#inspector').innerText(), /人工确认/, 'no manual resolution while this page still waits for the result');
  // Reopening the node keeps the running state; typing defers the inspector rebuild but status still updates in place.
  await select();
  assert.match(await status(), /生成中/);
  const prompt = page.getByRole('textbox', { name: '图片提示词', exact: true });
  await prompt.click(); await prompt.press('End'); await prompt.pressSequentially('，草地');
  await releaseNext();
  await page.waitForFunction(id => window.__xp.store.node(id).data.operation?.state === 'completed', id);
  await page.waitForFunction(() => /已完成[\s\S]*用时 \d+秒/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''));
  assert.equal(await prompt.evaluate(e => e === document.activeElement), true, 'status update must not steal prompt focus');

  // The card shows the status while not being edited (the floating editor shows it otherwise).
  await page.mouse.click(1250, 700);
  await page.waitForFunction(id => /已完成[\s\S]*用时 \d+秒/.test(document.querySelector(`[data-node="${id}"]`)?.innerText ?? ''), id);
  await select();
  assertLayout(await layout(), 'floating');
  for (const scale of [0.4, 2]) {
    await page.evaluate(s => { const b = window.__xp.board; b.view.scale = s; b.applyView(); }, scale);
    await page.waitForTimeout(300);
    assertLayout(await layout(), `zoom ${scale}`);
  }
  await page.evaluate(() => { const b = window.__xp.board; b.view.scale = 1; b.applyView(); });
  await page.click('.image-result-preview');
  await page.waitForSelector('.media-preview-dialog img');
  await page.waitForFunction(() => /^\d+%$/.test(document.querySelector('.media-preview-zoom')?.textContent ?? ''));
  const dialog = await page.evaluate(() => { const r = document.querySelector('.media-preview-dialog img').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  assert.ok(dialog.w > 640 && dialog.w <= 1600, `enlarged preview should fit the window (${dialog.w}x${dialog.h})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.media-preview-dialog', { state: 'detached' });

  await page.click('.composer-pin');
  await page.evaluate(() => { const b = document.querySelector('#inspector'); b.style.width = '300px'; b.style.minWidth = '300px'; });
  await page.waitForTimeout(300);
  assertLayout(await layout(), 'narrow side panel');
  await page.screenshot({ path: join(SHOTS, 'image-panel-narrow.png') });

  // Total time survives a reload.
  await page.evaluate(() => window.__xp.store.flush());
  await page.reload(); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  await select();
  assert.match(await status(), /已完成[\s\S]*用时 \d+秒/);

  // A portrait result is fitted by height, whole and centred.
  big = await page.evaluate(() => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 1440; c.height = 2560;
    const g = c.getContext('2d'); g.fillStyle = '#a26'; g.fillRect(0, 0, 1440, 2560);
    c.toBlob(async b => res([...new Uint8Array(await b.arrayBuffer())]), 'image/png');
  }));
  await page.locator('#inspector select').nth(2).selectOption({ label: '9:16（1440x2560）' });
  await page.waitForFunction(id => window.__xp.store.node(id).data.ratio === '9:16', id);
  await select();
  await page.locator('#inspector .gen-cta button.primary').click();
  await releaseNext();
  await page.waitForFunction(id => window.__xp.store.node(id).data.operation?.state === 'completed', id);
  await page.waitForFunction(() => /已完成/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''));
  await page.waitForFunction(() => document.querySelector('#inspector .image-result-preview img')?.naturalHeight === 2560);
  const portrait = await page.evaluate(() => {
    const frame = document.querySelector('#inspector .image-result-preview').getBoundingClientRect();
    const img = document.querySelector('#inspector .image-result-preview img');
    const scale = Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
    return { frameW: frame.width, frameH: frame.height, shownW: img.naturalWidth * scale, shownH: img.naturalHeight * scale,
      client: document.querySelector('#inspector').clientWidth, scroll: document.querySelector('#inspector').scrollWidth };
  });
  assert.ok(portrait.shownH <= portrait.frameH && portrait.shownW < portrait.shownH && portrait.shownW <= portrait.frameW, `portrait fitted whole: ${JSON.stringify(portrait)}`);
  assert.ok(portrait.scroll <= portrait.client + 1, 'portrait: no horizontal scroll');
  // Sub-second results read 「不足1秒」, never 「0秒」.
  assert.match(await status(), /已完成[\s\S]*用时 (不足1秒|\d+秒)/);
  assert.doesNotMatch(await status(), /用时 0秒/);
  await page.screenshot({ path: join(SHOTS, 'image-panel-portrait.png') });

  // A rejected request is shown as a failure with its reason.
  reject = true;
  await prompt.fill('再来一张');
  await page.locator('#inspector .gen-cta button.primary').click();
  await page.waitForFunction(() => /生成中/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''));
  await releaseNext();
  await page.waitForFunction(id => window.__xp.store.node(id).data.operation?.state === 'rejected', id);
  await page.waitForFunction(() => /生成失败[\s\S]*bad_prompt/.test(document.querySelector('#inspector .gen-run-line')?.innerText ?? ''));
  // Narrow screens have no floating editor: the pin/follow toggle is hidden instead of doing nothing.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => document.querySelector('.composer-pin')?.hidden === true);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForFunction(() => document.querySelector('.composer-pin')?.hidden === false);
  assert.deepEqual(errors, []);
  assert.deepEqual(egress(), []);
});

// AI 改写共用状态行：进行中显示「生成中」与计时、不出现人工确认；完成后卡片不显示与版本用时冲突的完成用时。
test('AI rewrite node shows running status and keeps per-version timing', { timeout: 90000 }, async t => {
  let release = null;
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'gemini-3.8-flash-high' }] });
    if (path === '/v1/chat/completions' && init.method === 'POST') {
      await new Promise(r => { release = r; });
      return Response.json({ id: 'chat-1', choices: [{ message: { role: 'assistant', content: '改写后的文本' } }] });
    }
    return Response.json({ data: [] });
  } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { release?.(); await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const egress = await watchEgress(page, { abort: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  await page.waitForFunction(() => window.__xp.generators?.textModels?.().length >= 1);
  const id = await page.evaluate(() => {
    const n = window.__xp.spawnNodeAt('text', { x: 400, y: 140 });
    Object.assign(n.data, { model: 'gemini-3.8-flash-high', text: '英雄归来' }); window.__xp.store.touch({ type: 'data', id: n.id });
    return n.id;
  });
  await page.evaluate(id => window.__xp.board.select('node', id), id);
  await page.waitForSelector('#inspector .rewrite-form');
  await page.locator('#inspector .gen-cta button.primary').click();
  while (!release) await page.waitForTimeout(20);
  await page.waitForFunction(() => /改写中/.test(document.querySelector('#inspector .gen-cta button.primary')?.textContent ?? ''));
  assert.doesNotMatch(await page.locator('#inspector').innerText(), /人工确认|已发送待确认/, 'no stale or manual state while the rewrite is running');
  await page.mouse.click(1250, 700);
  await page.waitForFunction(id => /生成中[\s\S]*已用时 \d+秒/.test(document.querySelector(`[data-node="${id}"]`)?.innerText ?? ''), id);
  release(); release = null;
  await page.waitForFunction(id => window.__xp.store.node(id).data.operation?.state === 'completed', id);
  await page.waitForFunction(id => !/状态/.test(document.querySelector(`[data-node="${id}"]`)?.innerText ?? '状态'), id);
  await page.evaluate(id => window.__xp.board.select('node', id), id);
  await page.waitForFunction(() => /第 1 \/ 1 版[\s\S]*用时 \d+秒/.test(document.querySelector('#inspector')?.innerText ?? ''));
  assert.equal(await page.locator('#inspector .rewrite-result').inputValue(), '改写后的文本');
  assert.deepEqual(errors, []);
  assert.deepEqual(egress(), []);
});
