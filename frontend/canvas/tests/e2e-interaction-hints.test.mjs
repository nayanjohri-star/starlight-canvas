// 交互易用性（0.4.1 后续）：真实鼠标/点击验收
//  · 阻断提示附带一键处理：未设密钥 →「输入密钥」打开密钥框；提示词为空 →「填写提示词」聚焦输入框；
//    纯文字模式连了素材 →「切换为「素材参考…」」由用户点击后才切换（不自动改模式）
//  · 拖线过程中可接端口高亮、不可接端口变淡；落到不兼容端口说明原因并列出可接端口；松手后清除
//  · 在画布上拖动越过工具栏/状态栏不选中页面文字
//  · 缩略图只响应左键：右键不跳转视图
// 全部本机模拟上游，零真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, SHOTS, makeState, mockUpstream, setKey, realPng } from './e2e-helpers.mjs';

test('交互提示：一键处理阻断、拖线高亮与拒绝原因、拖动不选中文字、缩略图仅左键', { timeout: 150000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: ROOT, upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);

  // ---------- 未设密钥：「输入密钥」打开密钥框 ----------
  await page.getByText('新建视频节点').click();
  const keyFix = page.locator('#inspector .err-fix', { hasText: '输入密钥' });
  await keyFix.waitFor({ timeout: 10000 });
  await keyFix.click();
  await page.waitForSelector('.modal input[type=password]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
  await setKey(page);

  // ---------- 提示词为空：「填写提示词」聚焦输入框 ----------
  await page.locator('.node-gen .node-head').first().click();
  const promptFix = page.locator('#inspector .err-fix', { hasText: '填写提示词' });
  await promptFix.waitFor({ timeout: 10000 });
  await promptFix.click();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('#inspector')), true, '点击后聚焦提示词输入框');
  await page.keyboard.type('清晨湖边，镜头缓慢推进 @图片1');
  await page.evaluate(() => document.activeElement?.blur());

  // ---------- 拖线：高亮可接端口、拒绝原因、松手清除 ----------
  const png = await realPng(page);
  await page.evaluate(async b => {
    const a = await window.__xp.assets.registerBlob(new Blob([new Uint8Array(b)], { type: 'image/png' }), '参考图.png', 'image');
    window.__xp.store.addNode('asset', 60, 120, { assetId: a.id });
  }, png);
  await page.waitForTimeout(300);
  const outDot = await page.locator('.node-asset .port.out .dot').boundingBox();
  const genId = await page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').id);
  const portBox = id => page.locator(`.node-gen .port.in[data-port="${id}"] .dot`).boundingBox();
  await page.mouse.move(outDot.x + 6, outDot.y + 6);
  await page.mouse.down();
  await page.mouse.move(outDot.x + 80, outDot.y + 40, { steps: 6 });
  const mid = await page.evaluate(() => ({
    wiring: document.getElementById('board').classList.contains('wiring'),
    ok: [...document.querySelectorAll('.node-gen .port.in.wire-ok')].map(r => r.dataset.port).sort(),
  }));
  await page.screenshot({ path: join(SHOTS, 'hints-wiring.png') });
  assert.equal(mid.wiring, true, '拖线中画布进入拖线态');
  assert.deepEqual(mid.ok, ['frames', 'refs'], '图片可接：首尾帧、素材；提示词端口不高亮');
  // 落到不兼容的「提示词」端口：说明原因并列出可接端口
  const pb = await portBox('prompt');
  await page.mouse.move(pb.x + 6, pb.y + 6, { steps: 6 });
  await page.mouse.up();
  const refusal = await page.locator('#toast-root, .toast').last().textContent();
  assert.match(refusal, /「提示词」不接收图片；可接到「首尾帧」、「素材」/, `拒绝原因：${refusal}`);
  const after = await page.evaluate(() => ({ wiring: document.getElementById('board').classList.contains('wiring'), ok: document.querySelectorAll('.wire-ok').length, edges: window.__xp.store.project.edges.length }));
  assert.deepEqual(after, { wiring: false, ok: 0, edges: 0 }, '松手后清除高亮，且未建立连线');
  // 正确连到「素材」
  const rb = await portBox('refs');
  await page.mouse.move(outDot.x + 6, outDot.y + 6); await page.mouse.down();
  await page.mouse.move(rb.x + 6, rb.y + 6, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__xp.store.project.edges.length), 1, '连到素材端口');

  // ---------- 纯文字模式连了素材：一键切换，由用户点击触发 ----------
  await page.locator('.node-gen .node-head').first().click();
  const modeFix = page.locator('#inspector .err-fix', { hasText: /切换为「素材参考/ });
  await modeFix.waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(id => window.__xp.store.node(id).data.draft.intent, genId), 'text', '点击前不自动切换模式');
  await page.screenshot({ path: join(SHOTS, 'hints-mode-fix.png') });
  await modeFix.click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.draft.intent === 'refs', genId, { timeout: 5000 });
  assert.equal(await page.locator('#inspector button.primary', { hasText: /提交生成/ }).isDisabled(), false, '切换后可以提交');

  // ---------- 误拖不选中界面文字 ----------
  // 真实复现：从底部工具条起手拖向左上，旧版会选中左侧栏与工具条的一片标签
  const vb = await page.locator('#view-bar').boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height - 4); await page.mouse.down();
  await page.mouse.move(40, 120, { steps: 12 });
  const selFromChrome = await page.evaluate(() => String(getSelection()));
  await page.mouse.up();
  assert.equal(selFromChrome, '', `从工具条起手拖动不应选中界面文字：「${selFromChrome}」`);
  // 画布平移拖过侧栏与状态栏同样不选中，松开后恢复可选
  await page.mouse.move(700, 250); await page.mouse.down();
  await page.mouse.move(60, 880, { steps: 12 });
  const selDuring = await page.evaluate(() => String(getSelection()));
  await page.mouse.up();
  assert.equal(selDuring, '', `拖动期间不应选中文字：「${selDuring}」`);
  assert.equal(await page.evaluate(() => document.body.classList.contains('xp-gesture')), false, '松开后恢复文字选择');

  // ---------- 缩略图：右键不跳转，左键点视口框外定位，拖动视口框平移 ----------
  // 缩略图左右留白始终在视口框之外（范围 = 节点 ∪ 当前视口，另加边距）；视口框内按下则是“抓住”视口框
  await page.evaluate(() => window.__xp.board.select(null));   // 取消选中：编辑面板不遮挡、缩略图不避让
  await page.waitForFunction(() => !document.getElementById('inspector').classList.contains('node-composer'));
  await page.waitForSelector('.minimap:not(.yield):not(.yield-hidden) canvas');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const mm = await page.locator('.minimap canvas').boundingBox();
  const corner = [mm.x + 3, mm.y + mm.height / 2];   // 左侧留白正中（避开圆角裁切）
  const v0 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  await page.mouse.click(...corner, { button: 'right' });
  await page.keyboard.press('Escape');
  const v1 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  assert.deepEqual(v1, v0, '右键缩略图不改变视图');
  await page.mouse.click(...corner);
  const v2 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  assert.notDeepEqual(v2, v0, '左键缩略图仍可定位');
  // 按下即抓住视口框（框外按下先定位到该点再抓住）；拖动时视口随指针同向移动，松开后结束拖动
  await page.mouse.move(...corner); await page.mouse.down();
  const vDown = await page.evaluate(() => ({ ...window.__xp.board.view }));
  await page.mouse.move(corner[0] + 30, corner[1] - 20, { steps: 5 });
  const v3 = await page.evaluate(() => ({ ...window.__xp.board.view }));
  await page.mouse.up();
  assert.ok(v3.x < vDown.x && v3.y > vDown.y, `拖动视口框：视口向右上移动，画布内容相应左下移动 ${JSON.stringify([vDown, v3])}`);
  assert.equal(await page.locator('.minimap.dragging').count(), 0, '松开后结束拖动');

  assert.deepEqual(errors, []);
});
