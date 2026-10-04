import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, createCanvasServer, makeState, mockUpstream, realPng, addAsset, setKey } from './e2e-helpers.mjs';

test('manual wires have stable visible numbers, token search works and tab closes the menu', { timeout: 30000 }, async t => {
  const state = makeState();
  const server = createCanvasServer({ staticDir: join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: mockUpstream(state) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const a = await addAsset(page, await realPng(page), '角色.png', 'image', 20, 20);
  const id = await page.evaluate(a => {
    const x = window.__xp, n = x.store.addNode('image', 450, 30, { prompt: '' });
    const source = x.store.project.nodes.find(n => n.type === 'asset' && n.data.assetId === a.assetId);
    x.store.addEdge(source.id, 'out', n.id, 'refs', 'image'); x.board.select('node', n.id); return n.id;
  }, a);
  const manualLabel = await page.locator('.reference-connected-item').getAttribute('aria-label');
  const prompt = page.getByRole('textbox', { name: '图片提示词', exact: true });
  await prompt.fill('@图片1');
  const matches = await page.locator('.reference-menu:not([hidden]) [data-reference-asset]').count();
  await prompt.press('Tab');
  await page.waitForTimeout(100);
  const stillOpen = await page.locator('.reference-menu:not([hidden])').count();
  assert.deepEqual({ manualLabel, matches, stillOpen }, { manualLabel: '查看引用 @图片1 角色.png', matches: 1, stillOpen: 0 });
  assert.equal(await page.evaluate(id => window.__xp.store.edgesInto(id, 'refs').length, id), 1);
  assert.equal(state.creates.length + state.uploads.length, 0);
});
