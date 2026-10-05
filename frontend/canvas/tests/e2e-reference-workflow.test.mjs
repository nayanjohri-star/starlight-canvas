import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, SHOTS, createCanvasServer, makeState, mockUpstream, realPng, addAsset, setKey } from './e2e-helpers.mjs';

async function assertExpandedPrompt(page) {
  // Reference changes can rebuild the inspector after its 250 ms debounce.
  // Resolve and measure the current textarea in one browser task: the expanded
  // class survives a rebuild, but an ElementHandle used by boundingBox does not.
  await page.waitForFunction(() => {
    const input = document.querySelector('#inspector.composer-expanded textarea[aria-label="图片提示词"]');
    return input && input.getClientRects().length > 0 && getComputedStyle(input).visibility === 'visible'
      && input.getBoundingClientRect().height >= 250;
  });
}

test('connected mentions, hover, replacement, resizable image editor and clone stay local', { timeout: 60000 }, async t => {
  const state = makeState();
  const server = createCanvasServer({ staticDir: join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: mockUpstream(state) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const png = await realPng(page), refs = [];
  for (const name of ['角色.png', '场景.png', '其他结果.png']) refs.push(await addAsset(page, png, name, 'image', 30, refs.length * 130));
  const id = await page.evaluate(refs => {
    const x = window.__xp, n = x.store.addNode('image', 540, 30, { prompt: '@图片1 和 @图片2', bindings: { 'image:1': refs[0].assetId, 'image:2': refs[1].assetId } });
    for (const ref of refs.slice(0, 2)) {
      const source = x.store.project.nodes.find(n => n.type === 'asset' && n.data.assetId === ref.assetId);
      x.store.addEdge(source.id, 'out', n.id, 'refs', 'image');
    }
    x.board.select('node', n.id); return n.id;
  }, refs);
  const prompt = page.getByRole('textbox', { name: '图片提示词', exact: true });
  await prompt.press('End'); await prompt.pressSequentially(' @');
  const menu = page.locator('.reference-menu:not([hidden])');
  assert.equal(await menu.locator('[data-reference-asset]').count(), 2);
  assert.equal(await menu.locator(`[data-reference-asset="${refs[2].assetId}"]`).count(), 0);
  assert.equal(await menu.getByRole('button', { name: /^全部素材/ }).count(), 0, '@ cannot browse or auto-wire unconnected images');
  await menu.locator(`[data-reference-asset="${refs[0].assetId}"]`).hover();
  await page.locator('.reference-hover img').waitFor({ state: 'visible' });
  const hover = await page.locator('.reference-hover').boundingBox(), row = await menu.boundingBox();
  assert.ok(hover.x + hover.width <= row.x + 12, 'wide-screen preview should be on the left');
  await page.screenshot({ path: join(SHOTS, 'reference-hover-left.png') });
  const scroll = await page.locator('#inspector').evaluate(el => el.scrollTop);
  await menu.locator(`[data-reference-asset="${refs[0].assetId}"]`).click();
  assert.ok(Math.abs(await page.locator('#inspector').evaluate(el => el.scrollTop) - scroll) <= 2);
  await page.getByRole('button', { name: '查看引用 @图片1 角色.png', exact: true }).click();
  await page.locator('.media-preview-stage img').waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
  const before = await prompt.inputValue();
  await page.getByRole('button', { name: '替换引用 @图片1 角色.png', exact: true }).click();
  await menu.locator(`[data-reference-asset="${refs[2].assetId}"]`).click();
  await page.waitForFunction(([id, a]) => window.__xp.store.node(id).data.bindings['image:1'] === a, [id, refs[2].assetId]);
  assert.equal(await prompt.inputValue(), before);
  const panel = page.locator('#inspector'), size = await panel.boundingBox();
  const handle = await page.getByRole('button', { name: '调整编辑面板大小', exact: true }).boundingBox();
  await page.mouse.move(handle.x + 12, handle.y + 12); await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y - 60, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(width => document.querySelector('#inspector').getBoundingClientRect().width < width - 50, size.width);
  await page.getByRole('button', { name: '放大编辑', exact: true }).click();
  await assertExpandedPrompt(page);
  // Exercise a real delayed store refresh with focus outside the input. The
  // old field is detached, but the replacement must stay expanded and editable.
  // Repeat the expand/collapse flow so a stale class or lost draft cannot pass.
  for (let cycle = 0; cycle < 3; cycle++) {
    const previousPrompt = await page.evaluateHandle(id => {
      document.querySelector('#inspector .composer-expand').focus();
      const input = document.querySelector('#inspector textarea[aria-label="图片提示词"]');
      window.__xp.store.touch({ type: 'data', id });
      return input;
    }, id);
    await page.waitForFunction(input => !input.isConnected, previousPrompt);
    assert.equal(await previousPrompt.boundingBox(), null, 'the delayed refresh replaces the old prompt');
    await previousPrompt.dispose();
    await assertExpandedPrompt(page);
    assert.equal(await prompt.inputValue(), before);
    await page.getByRole('button', { name: '收起编辑', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#inspector').classList.contains('composer-expanded'));
    assert.equal(await prompt.inputValue(), before);
    await page.getByRole('button', { name: '放大编辑', exact: true }).click();
    await assertExpandedPrompt(page);
  }
  await prompt.fill(before + ' 保持镜头位置');
  await page.screenshot({ path: join(SHOTS, 'image-expanded-editor.png') });
  await page.getByRole('button', { name: '收起编辑', exact: true }).click();
  assert.equal(await prompt.inputValue(), before + ' 保持镜头位置');
  await page.getByRole('button', { name: '克隆节点', exact: true }).click();
  await page.waitForFunction(id => window.__xp.store.project.nodes.filter(n => n.type === 'image' && n.id !== id).length === 1, id);
  const clone = await page.evaluate(id => { const x = window.__xp, n = x.store.project.nodes.find(n => n.type === 'image' && n.id !== id); return { data: n.data, refs: x.store.edgesInto(n.id, 'refs').length }; }, id);
  assert.equal(clone.data.prompt, before + ' 保持镜头位置'); assert.equal(clone.refs, 2);
  assert.equal(clone.data.operation, undefined); assert.equal(clone.data.resultAssetId, undefined);
  assert.equal(state.creates.length + state.uploads.length, 0);
});
