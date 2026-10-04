import {clickCanvasAction,openCanvasDock} from './e2e-helpers.mjs';
// 升级验收（canvas 域 e2e）：真实页面/IndexedDB/Web Locks，上游全模拟，零真实 API。
// 1440 桌面：moduleStatus 完整 + 模块入口显式反馈、空白模板+撤销、调色板建点、工作流面板
//            （预检弹明细/启动须确认/取消零付费）、复制粘贴副本零请求、Ctrl+V 媒体文件
//            让位节点粘贴、图片输出接入视频参考口、右键重命名、搜索聚焦、工具栏、项目切换恢复。
// 768/390：抽屉开关与 drawer-close、点选节点自动开检查器、resizer/折叠钮隐藏、空白点按收抽屉。
// 其他域模块并行产出中：只断言「状态可查 + 入口有可见反馈」，不断言外部模块内部行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, setKey, makeState, mockUpstream, MP4, realPng, CHROME } from './e2e-helpers.mjs';

test('升级验收：模块接线/抽屉/模板/工作流/粘贴让位（1440·768·390，全模拟上游）', { timeout: 120000 }, async t => {
  const state = makeState();
  state.videoBytes = new Uint8Array(MP4);
  const staticDir = process.env.CANVAS_TEST_DIST || join(ROOT, 'dist');
  const server = createCanvasServer({ staticDir, directorDir: staticDir, upstreamFetch: mockUpstream(state) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-accelerated-video-decode'] });

  const newPage = async (w, h, extra = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...extra });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => window.__xp?.store?.project && window.__xp?.moduleStatus);
    return { ctx, page };
  };
  const blur = page => page.evaluate(() => document.activeElement?.blur?.());
  const overlayCount = page => page.evaluate(() => document.getElementById('overlay-root').childElementCount);
  const toastText = page => page.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join('|'));
  const clearLayers = page => page.evaluate(() => {
    document.getElementById('overlay-root').replaceChildren();
    document.getElementById('toast-root').replaceChildren();
  });
  const counts = page => page.evaluate(() => ({
    total: window.__xp.store.project.nodes.length,
    edges: window.__xp.store.project.edges.length,
    byType: Object.fromEntries([...new Set(window.__xp.store.project.nodes.map(n => n.type))]
      .map(tp => [tp, window.__xp.store.project.nodes.filter(n => n.type === tp).length])),
  }));

  // ---------- 桌面 1440 ----------
  const { ctx: ctxD, page } = await newPage(1440, 900);
  assert.equal(await page.locator('#overlay-root .mask').count(), 0, '启动不得自动弹出遮罩层');
  const status = await page.evaluate(() => window.__xp.moduleStatus);
  for (const k of ['generators', 'tools', 'workflow', 'storyboards', 'library', 'timeline', 'projectHub', 'assistant']) {
    assert.ok(k in status, `moduleStatus 缺 ${k}`);
    assert.equal(typeof status[k].ok, 'boolean', `${k} 状态必须显式`);
    if (!status[k].ok) assert.ok(status[k].error, `${k} 失败必须暴露原因`);
  }
  const mods = await page.evaluate(() => Object.fromEntries(Object.entries(window.__xp.modules).map(([k, v]) => [k, v !== null])));
  for (const k of ['generators', 'tools', 'workflow', 'storyboards', 'library', 'timeline', 'projectHub', 'assistant'])
    assert.equal(!!mods[k], status[k].ok === true, `${k} 实例与状态一致`);
  assert.equal(await page.evaluate(() => typeof window.__xp.openModule), 'function');

  // 域模块入口：在→开界面；缺→明确「未就绪」；绝不静默
  for (const [btn, key] of [['#btn-storyboard', 'storyboards'], ['#btn-timeline', 'timeline'],
    ['#btn-library', 'library'], ['#btn-hub', 'projectHub'], ['#btn-assistant', 'assistant']]) {
    await clearLayers(page);
    await clickCanvasAction(page, btn);
    await page.waitForTimeout(200);
    const [ov, tx] = [await overlayCount(page), await toastText(page)];
    if (status[key]?.ok) assert.ok(ov > 0 || tx.length > 0, `${key} 入口必须有可见反馈`);
    else assert.match(tx, /未就绪/, `${key} 缺席必须明确提示未就绪`);
    await page.keyboard.press('Escape');
    await clearLayers(page);
  }

  // 桌面布局：侧栏/检查器常驻，抽屉开关与移动端折叠按钮不出现
  assert.ok(await page.locator('#sidebar').isVisible());
  assert.ok(await page.locator('#sidebar-toggle').isHidden(), '桌面不显示抽屉开关');
  assert.ok(await page.locator('#inspector-toggle').isHidden());
  assert.ok(await page.locator('#btn-left-panel').isVisible());

  // 主题切换
  await page.click('[data-theme-option="light"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.click('[data-theme-option="dark"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

  // 空白模板 + 撤销
  assert.ok(await page.locator('#empty-state').isVisible(), '新项目显示空白态');
  await page.locator('#empty-state .tpl-item', { hasText: '文本 → 视频' }).click();
  let c = await counts(page);
  assert.equal(c.total, 2); assert.equal(c.edges, 1);
  assert.ok(await page.evaluate(() => {
    const s = window.__xp.store, e = s.project.edges[0];
    return s.node(e.from.node)?.type === 'text' && s.node(e.to.node)?.type === 'gen' && e.to.port === 'prompt';
  }), '模板连线 文本.out → 视频.prompt');
  assert.ok(await page.locator('#empty-state').isHidden());
  await blur(page);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__xp.store.project.nodes.length === 0);
  assert.ok(await page.locator('#empty-state').isVisible(), '撤销回空白态');

  // 调色板建点
  await clickCanvasAction(page, '[data-add-node="text"]');
  await clickCanvasAction(page, '[data-add-node="image"]');
  await clickCanvasAction(page, '[data-add-node="gen"]');
  c = await counts(page);
  assert.deepEqual(c.byType, { text: 1, image: 1, gen: 1 });

  // 密钥（仅校验 /v1/models，后续全程零付费）
  await setKey(page, 'e2e-upgrade');
  // 密钥目录全量入库：图片/文本型号表按 /v1/models 如实标可用性（mock 只回 11 个视频型号）
  if (status.generators?.ok) {
    const ims = await page.evaluate(() => window.__xp.generators.imageModels().map(m => ({ id: m.id, usable: m.usable })));
    assert.equal(ims.length, 4, '图片型号表恒为 4 项');
    assert.ok(ims.every(m => m.usable === false), 'mock 密钥未返回图片型号 → 如实标不可用');
    assert.ok(Array.isArray(await page.evaluate(() => window.__xp.generators.textModels())), '文本型号目录可查');
  }

  // 工作流面板：按钮齐备、预检弹明细、启动须确认、取消零请求
  await openCanvasDock(page, 'run');
  const wfPanel = page.locator('#workflow-panel');
  for (const label of ['预检', '提交运行', '暂停', '继续', '明细'])
    assert.ok(await wfPanel.locator('button', { hasText: label }).count() >= 1, `工作流面板缺「${label}」`);
  assert.ok(await wfPanel.locator('input[type=number]').count() >= 1, '缺预算输入');
  assert.ok(!(await wfPanel.innerText()).includes('扣费'), '面板不得把估算显示成已扣费');
  await wfPanel.locator('button', { hasText: '预检' }).click();
  await page.waitForTimeout(250);
  if (status.workflow?.ok) {
    const mt = await page.locator('.modal').last().innerText();
    assert.match(mt, /工作流预检/);
    assert.match(mt, /预估费用/, '预检必须给出显式报价');
    await page.keyboard.press('Escape');
    await wfPanel.locator('button', { hasText: '提交运行' }).click();
    await page.waitForTimeout(250);
    const cm = await page.locator('.modal').last().innerText();
    assert.match(cm, /确认运行工作流/, '启动必须显式确认');
    await page.locator('.modal button', { hasText: '取消' }).click();
    const st = await page.evaluate(() => window.__xp.workflow?.getState?.() ?? null);
    assert.notEqual(st?.status, 'running', '取消后不进入运行态');
  } else {
    assert.match(await toastText(page), /未就绪/, '工作流缺席时预检必须明确提示');
  }
  assert.equal(state.creates.length, 0, '预检/取消启动不得发起付费请求');

  // 复制/粘贴/副本零付费
  await page.locator('.node-text .node-head').first().click();
  await blur(page);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.__xp.store.project.nodes.filter(n => n.type === 'text').length === 2);
  await page.keyboard.press('Control+d');
  await page.waitForFunction(() => window.__xp.store.project.nodes.filter(n => n.type === 'text').length === 3);
  assert.equal(state.creates.length, 0, '复制/粘贴/副本不得发起请求');
  assert.equal(state.uploads.length, 0);

  // Ctrl+V 剪贴板媒体文件让位节点粘贴（真实 DOM 事件时序：keydown → paste → 宏任务）
  await page.evaluate(() => {
    const xp = window.__xp;
    const n = xp.store.project.nodes.find(x => x.type === 'text');
    xp.board.select('node', n.id);
    xp.editor.copy([n.id]);
  });
  const png = await realPng(page, 150);
  const textBefore = (await counts(page)).byType.text;
  await page.evaluate(b => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'clipboard.png', { type: 'image/png' }));
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.dispatchEvent(ev);
  }, png);
  await page.waitForFunction(() => Object.keys(window.__xp.store.project.assets).length >= 1, null, { timeout: 8000 });
  const c2 = await counts(page);
  assert.equal(c2.byType.text, textBefore, '媒体文件粘贴不得再粘一份节点');
  assert.equal(c2.byType.asset ?? 0, 1, '剪贴板图片应入库并生成素材节点');

  // 锁定保护：Delete 不删也不丢选中，Ctrl+L 解锁后才可删
  const lockId = await page.evaluate(() => {
    const s = window.__xp.store;
    const n = s.addNode('note', 2000, 2000, { title: '锁保护', text: '' });
    window.__xp.board.select('node', n.id);
    return n.id;
  });
  await blur(page);
  await page.keyboard.press('Control+l');
  assert.equal(await page.evaluate(id => window.__xp.store.node(id)?.data.locked === true, lockId), true);
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(id => !!window.__xp.store.node(id), lockId), true, '锁定节点 Delete 不删除');
  assert.deepEqual(await page.evaluate(() => window.__xp.board.selectedIds), [lockId], '删除未发生时选中保留');
  await page.keyboard.press('Control+l');
  await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(id => window.__xp.store.node(id) === null, lockId), true, '解锁后删除生效');

  // Ctrl+V 显式文本剪贴板 → 生成文本节点，不得误粘画布内旧节点
  const preTextPaste = (await counts(page)).total;
  await page.evaluate(() => {
    const xp = window.__xp;
    const n = xp.store.project.nodes.find(x => x.type === 'text');
    xp.board.select('node', n.id);
    xp.editor.copy([n.id]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    const dt = new DataTransfer();
    dt.setData('text/plain', '外部剪贴板文本');
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.dispatchEvent(ev);
  });
  await page.waitForFunction(b => window.__xp.store.project.nodes.length === b + 1, preTextPaste);
  const pastedData = await page.evaluate(() => window.__xp.store.project.nodes.at(-1)?.data ?? {});
  assert.equal(pastedData.text, '外部剪贴板文本', '显式文本落地为文本节点内容');
  assert.equal(pastedData.title, '粘贴的文本', '不复用画布内复制节点');
  assert.equal(state.creates.length, 0, '文本粘贴零付费');

  // 图片输出可接入视频参考口（schema 层合同）
  assert.ok(await page.evaluate(() => {
    const s = window.__xp.store;
    const img = s.project.nodes.find(n => n.type === 'image');
    const gen = s.project.nodes.find(n => n.type === 'gen');
    return !!s.addEdge(img.id, 'out', gen.id, 'refs', 'image');
  }), '图片节点输出必须能接入视频生成的素材参考口');

  // 右键重命名（真实手势）
  await page.locator('.node-text .node-head').first().click({ button: 'right' });
  await page.locator('.popup .menu-item', { hasText: '重命名' }).click();
  await page.locator('.rename-pop input').fill('镜头一脚本');
  await page.keyboard.press('Enter');
  assert.ok(await page.evaluate(() => window.__xp.store.project.nodes.some(n => n.data.title === '镜头一脚本')));

  // 搜索聚焦
  await blur(page);
  await page.fill('#node-search', '镜头一');
  await page.locator('.popup .menu-item').first().click();
  assert.equal((await page.evaluate(() => window.__xp.board.selectedIds)).length, 1);

  // 工具栏：缩放/吸附/缩略图/适配
  const s0 = await page.evaluate(() => window.__xp.board.view.scale);
  await page.click('#btn-zoom-in');
  assert.ok((await page.evaluate(() => window.__xp.board.view.scale)) > s0);
  await page.click('#btn-snap');
  assert.equal(await page.locator('#btn-snap').getAttribute('aria-pressed'), 'false');
  await page.click('#btn-snap');
  await page.click('#btn-minimap');
  assert.ok(await page.locator('.minimap').evaluate(e => e.classList.contains('hidden')));
  await page.click('#btn-fit');

  // 项目切换恢复
  const p1 = await page.evaluate(() => window.__xp.store.project.id);
  const n1 = (await counts(page)).total;
  await clickCanvasAction(page, '#btn-new-project');
  await page.waitForFunction(() => window.__xp.store.project.nodes.length === 0);
  await page.selectOption('#project-list', p1);
  await page.waitForFunction(n => window.__xp.store.project.nodes.length === n, n1);
  const ed = await page.evaluate(() => window.__xp.editor.state());
  assert.equal(ed.depth.undo, 0, '切项目后编辑历史重置，不跨项目撤销');
  await ctxD.close();

  // ---------- 平板 768 ----------
  const { ctx: ctxT, page: tp } = await newPage(768, 1024);
  assert.ok(await tp.locator('#sidebar-toggle').isVisible(), '平板显示抽屉开关');
  assert.ok(await tp.locator('#inspector-toggle').isVisible());
  assert.ok(await tp.locator('#sidebar-resizer').isHidden(), '平板隐藏分隔条');
  assert.ok(await tp.locator('#inspector-resizer').isHidden());
  assert.ok(await tp.locator('#btn-left-panel').isHidden(), '平板隐藏面板折叠钮');
  assert.ok(await tp.locator('#btn-right-panel').isHidden());
  await tp.click('#sidebar-toggle');
  assert.ok(await tp.locator('#sidebar').evaluate(e => e.classList.contains('open')));
  await clickCanvasAction(tp, '[data-add-node="text"]');
  await tp.click('#sidebar .drawer-close');
  assert.ok(await tp.locator('#sidebar').evaluate(e => !e.classList.contains('open')), 'drawer-close 收侧栏');
  await tp.click('.node-text .node-head');
  assert.ok(await tp.locator('#inspector').evaluate(e => e.classList.contains('open')), '点选节点自动开检查器');
  await tp.click('#inspector .drawer-close');
  await ctxT.close();

  // ---------- 手机 390 ----------
  const { ctx: ctxM, page: mp } = await newPage(390, 800);
  assert.ok(await mp.locator('#sidebar-toggle').isVisible());
  assert.ok(await mp.locator('#inspector-toggle').isVisible());
  assert.ok(await mp.locator('#theme-switch').isVisible(), '手机主题切换可达');
  assert.ok(await mp.locator('#btn-key').isVisible(), '手机密钥按钮可达');
  assert.ok(await mp.locator('#project-list').isVisible(), '手机项目切换可达');
  await mp.click('#sidebar-toggle');
  await clickCanvasAction(mp, '[data-add-node="note"]');
  assert.equal(await mp.evaluate(() => window.__xp.store.project.nodes.length), 1);
  // 新建节点即选中并打开检查器；390px 放不下两个抽屉 → 侧栏自动收起，不再出现上层抽屉盖住下层 × 的状态
  await mp.waitForFunction(() => document.querySelector('#inspector')?.classList.contains('open'), null, { timeout: 10000 });
  assert.ok(await mp.locator('#sidebar').evaluate(e => !e.classList.contains('open')), '窄屏打开检查器时侧栏自动收起');
  await mp.click('#inspector .drawer-close');
  await mp.click('#sidebar-toggle');
  assert.ok(await mp.locator('#sidebar').evaluate(e => e.classList.contains('open')), '侧栏可重新打开');
  await mp.click('#sidebar .drawer-close');
  assert.ok(await mp.locator('#sidebar').evaluate(e => !e.classList.contains('open')), '侧栏 × 可点击关闭');
  await mp.click('.node-note .node-head');
  assert.ok(await mp.locator('#inspector').evaluate(e => e.classList.contains('open')), '手机点选节点开检查器');
  await mp.click('#inspector .drawer-close');
  await mp.waitForFunction(() => document.querySelector('#inspector').getBoundingClientRect().left >= innerWidth - 1);
  await mp.click('#sidebar-toggle');
  const boardRect = await mp.locator('#board').boundingBox();
  const blankTarget = await mp.evaluate(([x,y]) => document.elementFromPoint(x,y)?.outerHTML.slice(0,250), [boardRect.x + boardRect.width - 12, boardRect.y + 12]);
  await mp.mouse.click(boardRect.x + boardRect.width - 12, boardRect.y + 12);   // 抽屉外的空白画布
  assert.ok(await mp.locator('#sidebar').evaluate(e => !e.classList.contains('open')), '空白点按收侧栏；命中：'+blankTarget);
  await mp.click('#inspector-toggle');
  assert.ok(await mp.locator('#inspector').evaluate(e => e.classList.contains('open')), '顶栏 ⚙ 开检查器');
  await ctxM.close();

  assert.equal(state.creates.length, 0, '全程零付费创建请求');
  assert.equal(state.uploads.length, 0, '全程零上传请求');
});
