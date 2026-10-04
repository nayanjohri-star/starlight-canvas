import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, SHOTS, createCanvasServer, makeState, mockUpstream, MODELS_11, realPng, MP4, addAsset, setKey, watchEgress } from './e2e-helpers.mjs';

test('node composer: @ search, keyboard selection, stable graph references, pinning and small screens', { timeout: 120000 }, async t => {
  const state = makeState(), upstream = mockUpstream(state);
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: (url, init) =>
    new URL(url).pathname.endsWith('/models') ? Response.json({ data: [...MODELS_11, 'minimax-h3-768p-full-slow', 'gpt-image-2.5-flare'].map(id => ({ id })) }) : upstream(url, init) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const egress = await watchEgress(page, { abort: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const a = await addAsset(page, await realPng(page), '角色 A.png', 'image', 20, 30);
  const v = await addAsset(page, MP4, '运镜.mp4', 'video', 20, 330);
  const nodeId = await page.evaluate(() => window.__xp.store.addNode('gen', 440, 20, { draft: { model: 'minimax-h3-768p-full-slow', intent: 'text', seconds: 5, ratio: '16:9', prompt: '' }, perModel: {} }).id);
  await page.locator(`[data-node="${nodeId}"] .node-head`).click();
  await page.waitForSelector('#inspector.node-composer');
  const prompt = page.getByRole('textbox', { name: '视频提示词', exact: true });
  await prompt.fill('人物参考 @'); await prompt.press('Escape');
  assert.equal(await page.locator('.reference-menu:not([hidden])').count(), 0);
  await prompt.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await prompt.fill('人物参考 @图片');
  assert.equal(await page.locator('.reference-menu:not([hidden])').count(), 0, 'Chinese composition does not prematurely pick a reference');
  await prompt.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  assert.equal(await page.locator('.reference-menu:not([hidden])').count(), 1);
  await prompt.fill('人物参考 @角色');
  await page.getByRole('button', { name: '+ 参考素材', exact: true }).click();
  await page.locator(`[data-reference-asset="${a.assetId}"]`).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.draft.prompt.includes('@图片1'), nodeId);
  await prompt.press('End'); await prompt.pressSequentially('运镜参考 @视频');
  await page.getByRole('button', { name: '+ 参考素材', exact: true }).click();
  await page.locator(`[data-reference-asset="${v.assetId}"]`).waitFor({ state: 'visible' });
  await page.getByRole('searchbox', { name: '搜索引用素材' }).press('Enter');
  await page.waitForFunction(id => window.__xp.store.node(id).data.draft.prompt.includes('@视频1'), nodeId);
  const actual = await page.evaluate(id => ({ draft: window.__xp.store.node(id).data.draft, refs: window.__xp.store.edgesInto(id, 'refs').length }), nodeId);
  assert.equal(actual.draft.intent, 'refs'); assert.equal(actual.refs, 2);
  assert.equal(actual.draft.bindings['image:1'], a.assetId); assert.equal(actual.draft.bindings['video:1'], v.assetId);
  assert.equal(state.creates.length + state.uploads.length, 0, 'picking references is local and nonbillable');
  // New nodes start near the center. On a normal laptop viewport the editor hangs
  // directly below the (compact) card — never beside or above it, never covering
  // the preview, ports or switch — keeps the node header visible, and does not
  // move while typing.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(id => {
    const x = window.__xp, n = x.store.node(id); n.x = 540; n.y = 270;
    x.board.view.x = 0; x.board.view.y = 0; x.board.view.scale = 1;
    x.store.touch({ type: 'structure' }); x.board.applyView();
    x.board.select(null);
  }, nodeId);
  // Clicking the centred node makes room once (the board scrolls; the editor never flips sides).
  await page.locator(`[data-node="${nodeId}"] .node-head`).click({ position: { x: 40, y: 12 } });
  await page.waitForSelector('#inspector.node-composer');
  const placement = () => page.evaluate(id => {
    const root = document.querySelector(`[data-node="${id}"]`), node = root.getBoundingClientRect();
    const head = root.querySelector('.node-head').getBoundingClientRect();
    const editor = document.getElementById('inspector').getBoundingClientRect();
    return { below: editor.top >= node.bottom + 4 && editor.top <= node.bottom + 24,
      centred: Math.abs((editor.left + editor.width / 2) - (node.left + node.width / 2)) < 2 || (editor.left <= node.left && editor.right >= node.right),
      headVisible: head.top >= 0, submitVisible: document.querySelector('#inspector .gen-cta button.primary').getBoundingClientRect().bottom <= innerHeight,
      at: [Math.round(editor.left), Math.round(editor.top)] };
  }, nodeId);
  await page.waitForFunction(id => {
    const node = document.querySelector(`[data-node="${id}"]`).getBoundingClientRect();
    const top = document.getElementById('inspector').getBoundingClientRect().top;
    return top >= node.bottom + 4 && top <= node.bottom + 24;
  }, nodeId);
  const before = await placement();
  assert.ok(before.below && before.centred && before.headVisible && before.submitVisible, `editor anchored below the preview: ${JSON.stringify(before)}`);
  await prompt.press('End'); await prompt.pressSequentially(' 镜头缓慢推进，人物转身看向远处');
  assert.deepEqual((await placement()).at, before.at, 'typing never moves the editor');
  await page.screenshot({ path: join(SHOTS, 'node-composer-dark.png') });
  await prompt.press('End'); await prompt.pressSequentially(' @');
  assert.equal(await page.locator('.reference-menu:not([hidden])').evaluate(menu => {
    const r = menu.getBoundingClientRect();
    const overlaps = x => r.left < x.right && r.right > x.left && r.top < x.bottom && r.bottom > x.top;
    return [document.querySelector('[aria-label="视频提示词"]'), document.querySelector('#inspector .gen-cta')]
      .filter(Boolean).some(x => overlaps(x.getBoundingClientRect()));
  }), false, 'picker escapes the editor scroll container and never covers the prompt or submit controls');
  await page.screenshot({ path: join(SHOTS, 'node-composer-reference-menu.png') });
  await prompt.press('Escape'); await prompt.fill(actual.draft.prompt);
  await page.locator('[data-theme-option="light"]').click();
  await page.screenshot({ path: join(SHOTS, 'node-composer-light.png') });
  await page.locator('[data-theme-option="dark"]').click();
  await page.getByRole('button', { name: '固定到右侧', exact: true }).click(); await page.waitForFunction(() => !document.getElementById('inspector').classList.contains('node-composer'));
  assert.equal(await prompt.inputValue(), actual.draft.prompt);
  await page.getByRole('button', { name: '跟随节点', exact: true }).click(); await page.waitForSelector('#inspector.node-composer');
  await page.evaluate(() => { window.__xp.board.view.x -= 100; window.__xp.board.applyView(); });
  assert.equal(await prompt.inputValue(), actual.draft.prompt);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(id => window.__xp.board.select('node', id), nodeId);
  await page.waitForSelector('#inspector.open'); assert.equal(await prompt.inputValue(), actual.draft.prompt);
  await prompt.press('End'); await prompt.pressSequentially(' @');
  assert.equal(await page.locator('.reference-menu:not([hidden])').evaluate(menu => {
    const r = menu.getBoundingClientRect(), input = document.querySelector('[aria-label="视频提示词"]').getBoundingClientRect();
    return r.left < input.right && r.right > input.left && r.top < input.bottom && r.bottom > input.top;
  }), false, 'small viewport picker uses available space or layout flow without covering the prompt');
  await prompt.press('Escape'); await prompt.fill(actual.draft.prompt);
  await page.screenshot({ path: join(SHOTS, 'node-composer-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const imageId = await page.evaluate(() => window.__xp.store.addNode('image', 440, 20, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: '' }).id);
  await page.evaluate(id => window.__xp.board.select('node', id), imageId);
  const imagePrompt = page.getByRole('textbox', { name: '图片提示词', exact: true });
  await imagePrompt.fill('保持 @');
  assert.equal(await page.locator('.reference-menu:not([hidden]) [data-reference-asset]').count(), 0, 'new node has no connected references');
  await page.getByRole('button', { name: '+ 参考素材', exact: true }).click();
  assert.equal(await page.locator('.reference-menu:not([hidden]) [data-reference-asset]').count(), 1, 'image editor only offers supported image references');
  await page.locator(`[data-reference-asset="${a.assetId}"]`).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.bindings?.['image:1'], imageId);
  assert.equal(await page.getByRole('button', { name: '按参考图编辑', exact: true }).isEnabled(), true);
  await imagePrompt.fill(''); assert.equal(await page.getByRole('button', { name: '按参考图编辑', exact: true }).isEnabled(), false);
  await imagePrompt.fill('保持 @图片1 的角色'); assert.equal(await page.getByRole('button', { name: '按参考图编辑', exact: true }).isEnabled(), true);
  await imagePrompt.press('Tab');
  await page.evaluate(id => window.__xp.store.removeEdge(window.__xp.store.edgesInto(id, 'refs')[0].id), imageId);
  await page.waitForFunction(() => document.querySelector('.image-prompt-errors')?.textContent.includes('引用已失效'));
  assert.equal(state.creates.length + state.uploads.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(egress(), []);
});
