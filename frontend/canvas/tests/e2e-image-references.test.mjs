import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, SHOTS, createCanvasServer, realPng, addAsset, setKey, watchEgress } from './e2e-helpers.mjs';

test('image composer selects three @ references, retains them after reload and sends every original image', { timeout: 90000 }, async t => {
  const requests = [];
  let result;
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: async (url, init) => {
    if (new URL(url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-image-2.5-flare' }] });
    if (new URL(url).pathname.endsWith('/images/edits')) {
      requests.push(JSON.parse(init.body.toString()));
      return Response.json({ data: [{ b64_json: Buffer.from(result).toString('base64') }] });
    }
    return Response.json({ data: [] });
  }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const egress = await watchEgress(page, { abort: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const inputs = [];
  for (const [index, name] of ['分镜构图', '蓝色角色', '金色角色'].entries()) {
    const bytes = await realPng(page, index * 110);
    inputs.push({ bytes, ...await addAsset(page, bytes, name + '.png', 'image', 80, 40 + index * 230) });
  }
  result = inputs[0].bytes;
  const id = await page.evaluate(() => window.__xp.store.addNode('image', 550, 90, {
    model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '16:9', prompt: '' }).id);
  await page.locator(`[data-node="${id}"] .node-head`).click();
  for (const [index, input] of inputs.entries()) {
    const prompt = page.getByRole('textbox', { name: '图片提示词', exact: true });
    await prompt.press('End'); await prompt.pressSequentially('@');
    await page.getByRole('button', { name: '+ 参考素材', exact: true }).click();
    await page.locator(`[data-reference-asset="${input.assetId}"]`).click();
    await page.waitForFunction(([id, n]) => window.__xp.store.node(id).data.prompt.includes('@图片' + n), [id, index + 1]);
  }
  assert.match(await page.locator('#inspector').innerText(), /参考图 3\/8/);
  await page.evaluate(() => window.__xp.store.flush());
  await page.reload(); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  await page.locator(`[data-node="${id}"] .node-head`).click();
  assert.match(await page.getByRole('textbox', { name: '图片提示词', exact: true }).inputValue(), /@图片1.*@图片2.*@图片3/);
  const buttonBox = await page.getByRole('button', { name: '按参考图编辑', exact: true }).boundingBox();
  const panelBox = await page.locator('#inspector').boundingBox();
  assert.ok(buttonBox.y >= panelBox.y && buttonBox.y + buttonBox.height <= panelBox.y + panelBox.height + 1, 'multi-image list must not hide the generate button');
  await page.screenshot({ path: join(SHOTS, 'image-multi-reference.png') });
  await page.getByRole('button', { name: '按参考图编辑', exact: true }).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.operation?.state === 'completed', id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].image, undefined);
  assert.match(requests[0].prompt, /@1.*@2.*@3/);
  assert.equal(requests[0].images.length, 3);
  for (const [index, input] of inputs.entries()) assert.deepEqual(Buffer.from(requests[0].images[index].split(',')[1], 'base64'), Buffer.from(input.bytes));
  assert.deepEqual(errors, []);
  assert.deepEqual(egress(), []);
});
