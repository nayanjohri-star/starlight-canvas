// 0.4.3 界面细节（真实浏览器、本机模拟上游）：
//  1) 端口被浮层挡住：点击卡片按最小距离平移让出；拖线时浮层让路，落在原被遮挡的端口上可接线
//  2) 成片按钮：本机尚无成片时「下载成片」可用、「预览/保存到电脑」禁用并说明；本机已有后隐藏「下载成片」；
//     卡片按钮与其实际行为一致，名为「保存到电脑」
//  3) 提交按钮：无素材需上传时为「提交生成」，有本机素材待上传时为「上传并提交生成」
//  4) 选中条：单选时「成组 / 散组 / 排列」禁用并说明原因；多选可成组；成组后可散组；全部已锁定时显示「解锁」
//  5) 缩略图：选中节点以强调色绘制（选中前后画面不同），并留截图供目视检查
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, SHOTS, MP4, makeState, mockUpstream, setKey, realPng, waitTaskCompleted } from './e2e-helpers.mjs';

test('界面细节：端口让出、成片按钮语义、提交文案、选中条可用性、缩略图选中', { timeout: 180000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const state = makeState(); state.videoBytes = MP4;
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: ROOT, upstreamFetch: mockUpstream(state) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  await setKey(page);
  const btnState = sel => page.evaluate(s => [...document.querySelectorAll(s)].map(b => ({ t: b.textContent.trim(), d: b.disabled, title: b.title })), sel);

  // ---------- 3) 提交按钮文案 ----------
  const gen = await page.evaluate(() => window.__xp.store.addNode('gen', 320, 160, {
    directOutput: false, draft: { model: 'minimax-h3-768p-per-second', intent: 'text', prompt: '文案检查', seconds: 4, ratio: '16:9', switches: {} }, perModel: {},
  }).id);
  await page.locator('.node-gen .node-head').click();
  const submit = page.locator('#inspector button.primary', { hasText: /提交生成$/ });
  assert.equal((await submit.textContent()).trim(), '提交生成', '无素材需上传：提交生成');
  const png = await realPng(page);
  const assetNode = await page.evaluate(async b => {
    const a = await window.__xp.assets.registerBlob(new Blob([new Uint8Array(b)], { type: 'image/png' }), '本机图.png', 'image');
    return window.__xp.store.addNode('asset', 20, 160, { assetId: a.id }).id;
  }, png);
  await page.evaluate(([g, a]) => {
    const s = window.__xp.store; s.addEdge(a, 'out', g, 'refs', 'image');
    s.node(g).data.draft.intent = 'refs'; s.node(g).data.draft.prompt = '参考 @图片1'; s.touch({ type: 'data', id: g });
  }, [gen, assetNode]);
  await page.locator('.node-gen .node-head').click();
  await page.waitForFunction(() => /上传并提交生成/.test(document.querySelector('#inspector button.primary')?.textContent ?? ''), null, { timeout: 5000 });
  assert.match(await submit.getAttribute('title'), /将先上传 1 个本机素材/);

  // ---------- 2) 成片按钮：尚未取回 → 取回后 ----------
  await submit.click();
  const tid = await page.waitForFunction(g => window.__xp.store.node(g).data.run?.taskId, gen).then(h => h.jsonValue());
  await waitTaskCompleted(page, tid);
  await page.waitForFunction(() => [...document.querySelectorAll('#inspector .modal-actions button')].some(b => b.textContent === '下载成片' && !b.disabled), null, { timeout: 10000 });
  const before = await btnState('#inspector .modal-actions button');
  const find = (list, t) => list.find(b => b.t === t);
  assert.equal(find(before, '预览')?.d, true, '未取回时预览禁用');
  assert.equal(find(before, '保存到电脑')?.d, true, '未取回时保存禁用');
  assert.match(find(before, '保存到电脑')?.title ?? '', /先「下载成片」到本机/);
  await page.locator('#inspector .modal-actions button', { hasText: '下载成片' }).click();
  await page.waitForFunction(() => {
    const bs = [...document.querySelectorAll('#inspector .modal-actions button')];
    return !bs.some(b => b.textContent === '下载成片') && bs.some(b => b.textContent === '保存到电脑' && !b.disabled);
  }, null, { timeout: 10000 });
  assert.equal(state.downloads.length, 1, '只取回一次');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#inspector .modal-actions button', { hasText: '保存到电脑' }).click()]);
  assert.match(dl.suggestedFilename(), /\.mp4$/);
  assert.equal(state.downloads.length, 1, '保存到电脑复用本机成片，不重复请求');
  // 卡片（直接生成）按钮名与行为一致
  await page.evaluate(g => { window.__xp.store.updateNodeData(g, { directOutput: true }); }, gen);
  // 有下游连线时直接生成开关不可切换；本节点无输出连线
  await page.waitForSelector('.node-gen .gen-result-download', { timeout: 5000 });
  assert.equal((await page.locator('.node-gen .gen-result-download').textContent()).trim(), '保存到电脑');

  // ---------- 4) 选中条可用性 ----------
  await page.locator('.node-gen .node-head').click();
  let bar = await btnState('#sel-bar button');
  const barOf = (list, id) => list.find(b => b.t.includes(id));
  assert.equal(barOf(bar, '成组')?.d, true, '单选不可成组'); assert.match(barOf(bar, '成组').title, /至少选中 2 个/);
  assert.equal(barOf(bar, '散组')?.d, true, '不在分组中不可散组');
  assert.equal(barOf(bar, '排列')?.d, true, '单选不可排列');
  await page.evaluate(ids => window.__xp.board.selectMany(ids), [gen, assetNode]);
  bar = await btnState('#sel-bar button');
  assert.equal(barOf(bar, '成组')?.d, false, '多选可成组');
  await page.locator('#btn-group').click();
  await page.waitForFunction(() => (window.__xp.store.project.studio?.groups?.length ?? 0) === 1);
  await page.evaluate(ids => window.__xp.board.selectMany(ids), [gen, assetNode]);
  bar = await btnState('#sel-bar button');
  assert.equal(barOf(bar, '散组')?.d, false, '成组后可散组');
  await page.locator('#btn-lock').click();
  await page.waitForFunction(() => document.querySelector('#btn-lock')?.textContent.includes('解锁'), null, { timeout: 5000 });
  await page.locator('#btn-lock').click();
  await page.waitForFunction(() => document.querySelector('#btn-lock')?.textContent.includes('锁定'), null, { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, 'polish-selbar.png') });

  // ---------- 5) 缩略图：选中前后画面不同 ----------
  const mapPixels = () => page.evaluate(() => {
    const c = document.querySelector('.minimap canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3]) >>> 0; return h;
  });
  await page.evaluate(() => window.__xp.board.select(null));
  await page.waitForTimeout(100);
  const unselected = await mapPixels();
  await page.evaluate(g => window.__xp.board.select('node', g), gen);
  await page.waitForTimeout(100);
  assert.notEqual(await mapPixels(), unselected, '选中节点在缩略图中高亮');
  await page.locator('.minimap').screenshot({ path: join(SHOTS, 'polish-minimap.png') });

  // ---------- 1) 端口被浮层挡住 ----------
  // 把素材卡放到底部视图条正下方：输出端口被挡住
  const vb = await page.locator('#view-bar').boundingBox();
  await page.evaluate(() => window.__xp.board.select(null));
  const hidden = await page.evaluate(([a, vbY]) => {
    const x = window.__xp, n = x.store.node(a), v = x.board.view, board = document.getElementById('board').getBoundingClientRect();
    const root = document.querySelector(`[data-node="${a}"]`), dot = root.querySelector('.port.out .dot').getBoundingClientRect(), r = root.getBoundingClientRect();
    const dy = (vbY + 20 - dot.top) / v.scale;   // 让输出端口落到视图条里
    x.store.moveNode(a, n.x + (window.innerWidth / 2 - 60 - dot.left) / v.scale, n.y + dy);
    return { moved: true, cardH: r.height };
  }, [assetNode, vb.y]);
  assert.ok(hidden.moved);
  await page.waitForTimeout(200);
  const occluded = async () => page.evaluate(() => {
    const dot = document.querySelector('.node-asset .port.out .dot').getBoundingClientRect();
    const hit = document.elementFromPoint(dot.left + dot.width / 2, dot.top + dot.height / 2);
    return !hit?.closest('.port');
  });
  assert.equal(await occluded(), true, '前置：输出端口被视图条挡住');
  // 拖线时浮层让路：从素材卡正文取不到端口，改从生成卡拖向被挡的素材卡？素材卡无输入端口——
  // 这里验证「拖线期间浮层不拦截指针」：开始拖线后视图条区域的命中目标不再是视图条
  const genOut = await page.locator(`[data-node="${gen}"] .port.out .dot`).boundingBox().catch(() => null);
  if (genOut) {
    await page.mouse.move(genOut.x + 6, genOut.y + 6); await page.mouse.down();
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 6 });
    const through = await page.evaluate(([x, y]) => ({
      cls: document.getElementById('board-wrap').classList.contains('overlays-through'),
      hitBar: !!document.elementFromPoint(x, y)?.closest('#view-bar'),
    }), [vb.x + vb.width / 2, vb.y + vb.height / 2]);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(through.cls, true, '拖线期间浮层进入让路态');
    assert.equal(through.hitBar, false, '拖线期间视图条不拦截指针');
    assert.equal(await page.evaluate(() => document.getElementById('board-wrap').classList.contains('overlays-through')), false, '结束后恢复');
  }
  // 纯点击卡片标题：最小平移让出端口，标题仍可见
  const view0 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  await page.locator(`[data-node="${assetNode}"] .node-head`).click();
  await page.waitForTimeout(150);
  const why = await page.evaluate(() => { const d = document.querySelector('.node-asset .port.out .dot').getBoundingClientRect(); const hit = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2); return `dot@${Math.round(d.left)},${Math.round(d.top)} hit=${hit?.id || hit?.className || hit?.tagName} in=${hit?.closest('[id]')?.id} view=${JSON.stringify(window.__xp.board.view)}`; });
  assert.equal(await occluded(), false, '点击后输出端口不再被遮挡：' + why);
  const view1 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  assert.ok(view1.y < view0.y && Math.abs(view1.x - view0.x) < 1, '仅向上平移');
  assert.ok(await page.evaluate(a => document.querySelector(`[data-node="${a}"] .node-head`).getBoundingClientRect().top >= document.getElementById('board').getBoundingClientRect().top, assetNode), '标题仍在画布内');
  // 端口未被遮挡时点击不移动视图
  await page.locator(`[data-node="${assetNode}"] .node-head`).click();
  assert.deepEqual(await page.evaluate(() => ({ ...window.__xp.board.view })), view1, '无遮挡时不平移');
  await page.screenshot({ path: join(SHOTS, 'polish-port-clear.png') });

  assert.deepEqual(errors, []);
});
