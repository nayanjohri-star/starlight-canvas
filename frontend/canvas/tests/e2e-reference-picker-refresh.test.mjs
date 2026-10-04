import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, createCanvasServer, makeState, mockUpstream, realPng, addAsset, setKey } from './e2e-helpers.mjs';

test('portaled reference picker survives background inspector refresh while reading local media', { timeout: 30000 }, async t => {
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const a = await addAsset(page, await realPng(page), 'reference.png', 'image', 20, 30);
  const id = await page.evaluate(() => { const x = window.__xp, n = x.store.addNode('gen', 440, 20, { draft: { model: 'minimax-h3-768p-per-second', intent: 'text', seconds: 5, ratio: '16:9', prompt: '' }, perModel: {} }); x.board.select('node', n.id); return n.id; });
  await page.getByRole('button', { name: '+ 参考素材', exact: true }).click();
  await page.evaluate(() => {
    const x = window.__xp, read = x.assets.blobOf;
    x.assets.blobOf = async id => { window.__referenceReadStarted = true; await new Promise(r => { window.__releaseReferenceRead = r; }); return read(id); };
    window.__originalPrompt = document.querySelector('[aria-label="视频提示词"]');
  });
  await page.locator(`[data-reference-asset="${a.assetId}"]`).click();
  await page.waitForFunction(() => window.__referenceReadStarted);
  // A background task update schedules the existing 250 ms inspector refresh.
  await page.evaluate(async () => { window.__xp.store.touch({ type: 'data' }); await new Promise(r => setTimeout(r, 400)); });
  assert.equal(await page.evaluate(() => window.__originalPrompt.isConnected), true, 'active reference UI must not be rebuilt during the local read');
  await page.evaluate(() => window.__releaseReferenceRead());
  await page.waitForFunction(id => window.__xp.store.node(id).data.draft.prompt.includes('@图片1'), id);
  assert.equal(await page.evaluate(id => window.__xp.store.node(id).data.draft.bindings['image:1'], id), a.assetId);
});
