import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, createCanvasServer, realPng, addAsset, watchEgress } from './e2e-helpers.mjs';

test('self-deployed API settings generate text/images, edit references and survive reload without storing keys', { timeout: 45000 }, async t => {
  const calls = [], errors = [];
  let png = null;
  const server = createCanvasServer({ staticDir: join(ROOT, 'dist'), directorDir: join(ROOT, '../director/dist'), mediaService: false,
    upstreamFetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ url: String(url), init });
      if (path.endsWith('/models')) return Response.json({ data: [{ id: 'custom-chat' }, { id: 'gpt-image-1' }] });
      if (path.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: '测试文本结果' } }] });
      if (path.includes('/images/')) return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
      throw new Error('Unexpected mock route');
    } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  const egress = await watchEgress(page, { abort: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project);
  png = await realPng(page);
  const original = await page.evaluate(() => {
    const x = window.__xp, n = x.store.addNode('image', 420, 40, { model: 'gpt-image-2.5-flare', resolution: '4K', ratio: '16:9', prompt: 'original' });
    x.board.select('node', n.id); return n.id;
  });
  await page.locator('#btn-key').click();
  await page.getByRole('combobox', { name: 'API 服务商', exact: true }).selectOption('__new');
  await page.getByRole('textbox', { name: '服务商名称', exact: true }).fill('自带 API');
  await page.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://provider.example/gateway/v1');
  await page.getByRole('textbox', { name: '手动文本型号', exact: true }).fill('custom-chat');
  await page.getByRole('textbox', { name: '手动图片型号', exact: true }).fill('gpt-image-1');
  await page.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('test-only-provider-key');
  await page.getByRole('button', { name: '校验并保存到内存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.match(await page.locator('#btn-key').getAttribute('aria-label'), /自带 API/);
  assert.deepEqual(await page.evaluate(id => {
    const d = window.__xp.store.node(id).data; return { model: d.model, resolution: d.resolution, ratio: d.ratio };
  }, original), { model: 'gpt-image-2.5-flare', resolution: '4K', ratio: '16:9' });
  const text = await page.evaluate(async () => {
    const x = window.__xp, n = x.store.addNode('text', 10, 10, { model: 'custom-chat', text: 'test' });
    await x.generators.generate(n); return n.data.resultText;
  });
  assert.equal(text, '测试文本结果');
  const imageId = await page.evaluate(async () => {
    const x = window.__xp, n = x.store.addNode('image', 420, 40, { model: 'gpt-image-1', prompt: 'test', resolution: '1K', ratio: '3:2' });
    x.board.select('node', n.id); await x.generators.generate(n); return n.id;
  });
  const quote = await page.evaluate(id => window.__xp.generators.quote(window.__xp.store.node(id)), imageId);
  assert.equal(quote.estimatedYuan, null); assert.equal(quote.priceKind, 'unknown');
  const imageRec = await page.evaluate(id => window.__xp.store.node(id).data.operation, imageId);
  assert.equal(imageRec.state, 'completed'); assert.equal(imageRec.provider.baseUrl, 'https://provider.example/gateway/v1');
  const a = await addAsset(page, png, 'reference.png', 'image', 30, 200);
  const edited = await page.evaluate(async a => {
    const x = window.__xp, source = x.store.project.nodes.find(n => n.type === 'asset' && n.data.assetId === a.assetId);
    const n = x.store.addNode('image', 420, 300, { model: 'gpt-image-1', prompt: 'edit', resolution: '1K', ratio: '1:1' });
    x.store.addEdge(source.id, 'out', n.id, 'refs', 'image'); await x.generators.generate(n); return n.data.operation.state;
  }, a);
  assert.equal(edited, 'completed');
  const edit = calls.find(c => c.url.endsWith('/images/edits'));
  assert.ok(edit.init.body instanceof FormData); assert.equal(edit.init.body.getAll('image[]').length, 1);
  assert.ok(calls.every(c => c.url.startsWith('https://provider.example/gateway/v1/')));
  const metadata = await page.evaluate(() => localStorage.getItem('xp-api-providers-v1'));
  assert.ok(!metadata.includes('test-only-provider-key'));
  await page.reload(); await page.waitForFunction(() => window.__xp?.store.project);
  assert.equal(await page.evaluate(() => window.__xp.keyvault.hasKey()), false);
  assert.match(await page.locator('#btn-key').getAttribute('aria-label'), /自带 API.*未设密钥/);
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 3);
  assert.deepEqual(errors, []); assert.deepEqual(egress(), []);
});
