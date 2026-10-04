import {clickCanvasAction,openCanvasDock, explainGenStall } from './e2e-helpers.mjs';
// 浏览器端到端回归（画布主体）：全部上游调用走本地 mock，零生产、零费用。
// 覆盖：密钥门控、真实媒体素材、11 型号 上传→创建→轮询→鉴权下载→解码校验、
// 双击去重、上传失败 0 POST、未知提交恢复、换密钥暂停/恢复、导入重映射、
// SD 30 图→H3 超限阻断与还原、三视口（1440/768/390）真实 UI 实操截图。
// 导演台 3D 回归暂缓：见 e2e-director.test.mjs（npm run test:director，默认不跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  chromium, createCanvasServer, ROOT, MP4, WEBM, WAV, SHOTS, CHROME,
  realPng, assertVideoDecodes, assertImageDecodes, assertAudioDecodes,
  makeState, mockUpstream, waitTaskCompleted, setKey, addAsset, rewire,
  selectAndFill, downloadCurrent, genData,
} from './e2e-helpers.mjs';
// ---------- 主 E2E ----------
test('E2E：密钥门控 + 11 型号全流程 + 幂等/恢复 + 三视口', { timeout: 300000 }, async t => {
  const state = makeState();
  const server = createCanvasServer({
    staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: join(ROOT, '..', '..', 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage'),
    upstreamFetch: mockUpstream(state),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // 清理先于浏览器启动注册：启动失败也不会泄漏服务；关闭均 await
  let browser = null;
  t.after(async () => {
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });
  // 单浏览器串行 + 关硬件 GPU（本机显卡掉线后避免触发 GPU 进程）
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });

  // 0) 密钥门控：未设密钥时 0 请求（无自动弹窗，点 #btn-key）
  const genId = await page.evaluate(() => window.__xp.store.addNode('gen', 300, 200, { draft: {}, perModel: {} }).id);
  await page.evaluate(() => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
  assert.equal(state.uploads.length + state.creates.length, 0, '无密钥不得发请求');
  await setKey(page);

  // 真实媒体素材入库（ffmpeg 生成的真实样本 + 真实解码校验）
  const pngBytes = await realPng(page);
  state.videoBytes = MP4;
  assert.ok(await assertImageDecodes(page, pngBytes), 'PNG 可解码');
  assert.ok(await assertVideoDecodes(page, WEBM, 'video/webm'), 'WebM 可解码');
  assert.ok(await assertVideoDecodes(page, MP4, 'video/mp4'), 'MP4 可解码');
  assert.ok(await assertAudioDecodes(page, WAV), 'WAV 可解码');

  const imgA = await addAsset(page, pngBytes, 'a.png', 'image', 40, 60);
  const vidA = await addAsset(page, MP4, 'clip.mp4', 'video', 40, 240);
  const audA = await addAsset(page, WAV, 'bgm.wav', 'audio', 40, 420);
  const imgB = await addAsset(page, await realPng(page, 120), 'b.png', 'image', 40, 600);

  // 1) 首单：SD refs（图+视+音）→ 上传→创建→轮询→鉴权下载→解码
  await rewire(page, genId, 'refs', [[imgA.nodeId, 'image'], [vidA.nodeId, 'video'], [audA.nodeId, 'audio']]);
  await selectAndFill(page, { model: 'seedance-2.5-vip-720p', intent: 'refs', prompt: '保持@图片1的人物外观，参考@视频1运镜，配@音频1氛围', seconds: 5 });
  await page.waitForSelector('#inspector button.primary:not([disabled])');
  await page.click('#inspector button.primary');
  const t1id = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 10000 }).then(h => h.jsonValue());
  await waitTaskCompleted(page, t1id);
  assert.equal(state.uploads.length, 3, '三类素材各上传一次');
  assert.equal(state.creates.length, 1, '只创建一次');
  const task1 = state.creates[0];
  assert.ok(task1.key?.length > 10, '幂等键存在');
  const body1 = JSON.parse(task1.body), meta = body1.metadata;
  assert.equal(meta.mode, 'references');
  assert.equal(meta.image_urls.length + meta.video_urls.length + meta.audio_urls.length, 3);
  assert.ok(meta.image_urls[0].startsWith('https://xingpan.site/reference-assets/'));
  assert.equal(body1.prompt, '保持@1的人物外观，参考@视频1运镜，配@音频1氛围', '本站规范 token');
  assert.deepEqual(Object.keys(meta).sort(), ['audio_urls', 'face_mode', 'generate_audio', 'image_urls', 'mode', 'ratio', 'video_urls'], '请求体字段');
  await downloadCurrent(page, t1id);
  assert.equal(state.downloads.length, 1);
  assert.equal((await page.evaluate(id => window.__xp.taskPeek(id)?.resultType, t1id)), 'video/mp4');
  // 保存到电脑：Playwright download 事件验收真实文件字节，复用本地 Blob 不重复 GET
  const dlEvent = page.waitForEvent('download', { timeout: 8000 });
  await page.locator('#inspector .modal-actions button', { hasText: '保存到电脑' }).click();
  const dlFile = await dlEvent;
  assert.ok(dlFile.suggestedFilename().endsWith('.mp4'), '保存文件扩展名随 content-type');
  const savedBytes = readFileSync(await dlFile.path());
  assert.equal(savedBytes.length, state.videoBytes.length, '落盘字节长度一致');
  assert.deepEqual([...savedBytes], [...new Uint8Array(state.videoBytes)], '落盘完整字节内容一致');
  assert.equal(state.downloads.length, 1, '保存到电脑不得重复 GET');

  // 2) 双击/重复提交只 1 次 POST
  await page.evaluate(() => window.__xp.runner.detach(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
  const before2 = state.creates.length;
  await page.evaluate(() => {
    const n = window.__xp.store.project.nodes.find(x => x.type === 'gen');
    return Promise.all([window.__xp.runner.submit(n), window.__xp.runner.submit(n)]);
  });
  const t2id = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 10000 }).then(h => h.jsonValue());
  await waitTaskCompleted(page, t2id);
  assert.equal(state.creates.length, before2 + 1, '双击只产生一次 POST');

  // 3) 上传失败 → 0 POST（全新未缓存素材）
  const failImg = await addAsset(page, await realPng(page, 30), 'fail.png', 'image', 560, 60);
  await rewire(page, genId, 'refs', [[failImg.nodeId, 'image']]);
  await selectAndFill(page, { prompt: '上传失败验收' });   // 清掉旧 @引用，避免 pre 校验先拒
  state.failUpload = true;
  await page.evaluate(async () => { const n = window.__xp.store.project.nodes.find(x => x.type === 'gen'); await window.__xp.runner.detach(n); return window.__xp.runner.submit(n); });
  await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.error?.includes('上传失败'), null, { timeout: 8000 });
  assert.equal(state.creates.length, before2 + 1, '上传失败不得创建任务');
  state.failUpload = false;

  // 4) 未知结果 POST → 同键同体重试成功
  await rewire(page, genId, 'refs', [[imgA.nodeId, 'image']]);
  state.createFailsLeft = 1;
  await page.evaluate(async () => { const n = window.__xp.store.project.nodes.find(x => x.type === 'gen'); await window.__xp.runner.detach(n); return window.__xp.runner.submit(n); });
  await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.pendingKey, null, { timeout: 8000 });
  const pendKey = await page.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').data.run.pendingKey);
  assert.equal((await page.evaluate(k => window.__xp.store.pendingCreate(k), pendKey)).state, 'uncertain');
  await page.evaluate(() => window.__xp.runner.retrySubmit(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
  const t4id = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 10000 }).then(h => h.jsonValue());
  await waitTaskCompleted(page, t4id);
  const last2 = state.creates.slice(-2);
  assert.equal(last2[0].key, last2[1].key, '重试保持同幂等键');
  assert.equal(String(last2[0].body), String(last2[1].body), '重试保持同 body');

  // 5) 在途任务换密钥 → 暂停（不发 GET）；恢复原密钥 → GET 恢复
  await page.evaluate(async () => { const n = window.__xp.store.project.nodes.find(x => x.type === 'gen'); await window.__xp.runner.detach(n); return window.__xp.runner.submit(n); });
  const t5id = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 10000 }).then(h => h.jsonValue());
  state.slowTaskId = t5id;                        // 该任务保持 in_progress，保证换密钥窗口
  await setKey(page, 'sk-e2e-different');
  await page.evaluate(id => window.__xp.runner.poll(id), t5id);
  await page.waitForFunction(id => window.__xp.taskPeek(id)?.paused === true, t5id, { timeout: 10000 });
  const qPaused = state.queries.length;
  await page.waitForTimeout(2500);
  assert.equal(state.queries.length, qPaused, '暂停期间不发 GET');
  await setKey(page, 'sk-e2e-test');
  await page.evaluate(id => window.__xp.runner.poll(id), t5id);
  await page.waitForTimeout(3500);                  // poll 首 tick 1.2s 后即 GET
  assert.ok(state.queries.length > qPaused, '恢复原密钥后 GET 恢复');
  state.slowTaskId = null;

  // 5b) 项目切换恢复：A 有在途任务 → 新建 B → 经真实 #project-list 切回 A → 自动恢复 GET
  const pidA = await page.evaluate(() => window.__xp.store.project.id);
  await page.evaluate(async () => { const n = window.__xp.store.project.nodes.find(x => x.type === 'gen'); await window.__xp.runner.detach(n); return window.__xp.runner.submit(n); });
  const tSw = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 10000 }).then(h => h.jsonValue());
  state.slowTaskId = tSw;                              // 保持在途
  await clickCanvasAction(page, '#btn-new-project');
  await page.selectOption('#project-list', pidA);
  const qSwBefore = state.queries.filter(q => q === tSw).length;
  await page.waitForTimeout(2600);                     // poll 首 tick 1.2s
  assert.ok(state.queries.filter(q => q === tSw).length > qSwBefore, '切回项目后在途任务自动恢复轮询');
  state.slowTaskId = null;

  // 6) 11 型号循环：上传→创建→轮询→鉴权下载→解码
  const plan = [
    ['seedance-2.5-vip-480p', 'frames'], ['seedance-2.5-vip-1080p', 'refs'],
    ['seedance-2.5-discount-480p', 'text'], ['seedance-2.5-discount-720p', 'frames'],
    ['seedance-2.5-special-480p', 'refs'], ['seedance-2.5-special-720p', 'refs'],
    ['wan-3.0', 'i2v'], ['wan-3.0-prime', 'refs'],
    ['minimax-h3-768p-per-second', 'frames'], ['minimax-h3-2k-per-second', 'refs'],
  ];
  const needFor = intent =>
    intent === 'frames' ? [['frames', [[imgA.nodeId, 'image'], [imgB.nodeId, 'image']]]]
    : intent === 'text' ? []
    : intent === 'i2v' ? [['refs', [[imgA.nodeId, 'image']]]]
    : [['refs', [[imgA.nodeId, 'image'], [vidA.nodeId, 'video'], [audA.nodeId, 'audio']]]];
  const done = new Set(['seedance-2.5-vip-720p']);
  for (const [model, intent] of plan) {
    await page.evaluate(async ([g, lists]) => {
      const s = window.__xp.store;
      s.project.edges = s.project.edges.filter(e => e.to.node !== g);
      for (const [port, items] of lists) for (const [from, kind] of items) s.addEdge(from, 'out', g, port, kind);
      const n = s.project.nodes.find(x => x.id === g);
      await window.__xp.runner.detach(n); n.data.resultAssetId = null;
      s.touch({ type: 'structure' });
    }, [genId, needFor(intent)]);
    await selectAndFill(page, { model, intent, prompt: `${model} 验收` });
    const createsBefore = state.creates.length;
    await page.evaluate(() => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
    const tid = await page.waitForFunction(() => {
      const run = window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run;
      return run?.taskId ?? (run?.error || run?.pendingKey ? { fail: run.error ?? run.pendingKey } : null);
    }, null, { timeout: 15000 }).then(h => h.jsonValue(), async e => { throw new Error(await explainGenStall(page, model), { cause: e }); });
    if (typeof tid === 'object') throw new Error(`${model} 提交未受理：${JSON.stringify(tid)}`);
    await waitTaskCompleted(page, tid);
    await downloadCurrent(page, tid);
    assert.ok(state.creates.length > createsBefore, `${model} 已创建`);
    done.add(model);
  }
  assert.equal(done.size, 11, '11 型号全部走通');

  // 7) SD 30 图 refs → 切 H3：素材/提示词/绑定完整保留 + 超限阻止 + 切回恢复
  //    imgA/imgB 保留在 30 图内——@图片1 已绑定 imgA（稳定绑定语义：改提示词不重置绑定）
  const extra = [];
  for (let i = 0; i < 28; i++) extra.push(await addAsset(page, await realPng(page, i * 11), `x${i}.png`, 'image', 620 + (i % 10) * 75, 40 + Math.floor(i / 10) * 115));
  await rewire(page, genId, 'refs', [[imgA.nodeId, 'image'], [imgB.nodeId, 'image'], ...extra.map(e => [e.nodeId, 'image'])]);
  await selectAndFill(page, { model: 'seedance-2.5-vip-1080p', intent: 'refs', prompt: '群像以@图片1为主角' });
  await selectAndFill(page, { model: 'minimax-h3-768p-per-second' });
  const kept = await genData(page);
  assert.equal(kept.draft.prompt, '群像以@图片1为主角', '切型号保留提示词');
  assert.equal(await page.evaluate(g => window.__xp.store.project.edges.filter(e => e.to.node === g && e.to.port === 'refs').length, genId), 30, '切型号保留 30 条素材连线');
  assert.ok(kept.draft.bindings?.['image:1'], '切型号保留 @绑定');
  const cB = state.creates.length;
  await page.evaluate(() => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
  assert.equal(state.creates.length, cB, 'H3 超限不得提交');
  await selectAndFill(page, { model: 'seedance-2.5-vip-1080p' });
  await page.evaluate(async () => { const n = window.__xp.store.project.nodes.find(x => x.type === 'gen'); await window.__xp.runner.detach(n); return window.__xp.runner.submit(n); });
  await page.waitForTimeout(600);
  let t7id;
  try {
    t7id = await page.waitForFunction(() => {
      const run = window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run;
      return run?.taskId ?? (run?.error || run?.pendingKey ? { fail: run.error ?? run.pendingKey } : null);
    }, null, { timeout: 15000 }).then(h => h.jsonValue());
  } catch (e) {
    console.log('diag:', JSON.stringify(await page.evaluate(() => ({
      run: window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run,
      draft: window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.draft,
      toasts: [...document.querySelectorAll('#toast-root > *')].map(x => x.textContent),
      busy: window.__xp.runner.isBusy(window.__xp.store.project.nodes.find(n => n.type === 'gen').id),
      uploadsPending: window.__xp.store.project.nodes.filter(n => n.type === 'asset').length,
    }))));
    throw e;
  }
  if (typeof t7id === 'object') throw new Error(`切回 SD 提交未受理：${JSON.stringify(t7id)}`);
  await waitTaskCompleted(page, t7id);
  assert.ok(state.creates.length > cB, '切回 SD 可提交');

  // 8) 导出→导入重映射
  const exported = await page.evaluate(() => window.__xp.store.exportJSON());
  const imported = await page.evaluate(tx => window.__xp.store.importJSON(tx), exported);
  const impAsset = imported.nodes.find(n => n.type === 'asset');
  assert.ok(impAsset.data.assetId && imported.assets[impAsset.data.assetId], '导入素材 id 已重映射且存在');
  assert.ok(imported.assets[impAsset.data.assetId].missing, '导入素材标记缺文件');
  assert.ok(imported.edges.length === imported.edges.filter(e => imported.nodes.some(n => n.id === e.from.node) && imported.nodes.some(n => n.id === e.to.node)).length, '连线端点重映射一致');

  // 9) 三视口真实操作 + 截图（真实 UI 路径：侧栏/点选生成节点/拖动/连线/参数/预览解码）
  for (const w of [1440, 768, 390]) {
    const c2 = await browser.newContext({ viewport: { width: w, height: 800 } });
    const p2 = await c2.newPage();
    try {
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });
      await setKey(p2);
      if (w <= 900) await p2.click('#sidebar-toggle');          // 小屏打开侧栏
      const vpPng = await realPng(p2);
      await p2.evaluate(b => window.__xp.assets.registerBlob(new Blob([new Uint8Array(b)], { type: 'image/png' }), 'v.png', 'image'), vpPng);
      // 素材行「＋节点」真实点击生成素材节点（触屏路径），gen 经调色板落到视口中心
      await openCanvasDock(p2, 'asset');
      await p2.locator('.asset-item button', { hasText: '＋节点' }).first().click();
      await clickCanvasAction(p2, '[data-add-node="gen"]');
      // 抽屉自带 × 关闭；放不下两个抽屉的宽度下，新建节点打开检查器时侧栏已自动收起（互斥）
      if (w <= 900 && await p2.locator('#inspector').evaluate(e=>e.classList.contains('open'))) await p2.locator('#inspector .drawer-close').click();
      if (w <= 900 && await p2.locator('#sidebar').evaluate(e=>e.classList.contains('open'))) await p2.locator('#sidebar .drawer-close').click();
      if (w <= 900) assert.ok(await p2.locator('#sidebar').evaluate(e=>!e.classList.contains('open')), `${w}px 侧栏可关闭`);
      if (w <= 900) await p2.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1 && document.getElementById('inspector').getBoundingClientRect().left>=innerWidth-1);
      await p2.click('#btn-fit');
      await p2.waitForSelector('.node-gen', { timeout: 5000 });
      // 真实节点拖动：把 gen 头向上拖开（模拟用户摆位，避免与素材节点重叠；端口保持在视口内）
      const gh = await p2.locator('.node-gen .node-head').boundingBox();
      assert.ok(gh, `${w}px gen 节点可见`);
      await p2.mouse.move(gh.x + gh.width / 2, gh.y + gh.height / 2);
      await p2.mouse.down();
      await p2.mouse.move(gh.x + gh.width / 2, gh.y + gh.height / 2 - 200, { steps: 8 });
      await p2.mouse.up();
      if (w <= 900) assert.equal(await p2.locator('#inspector').evaluate(e=>e.classList.contains('open')),false,'拖动节点不能弹出面板遮住画布');
      await p2.click('#btn-fit');
      // 真实拖拽连线（out 整行可发起；端口必须在可视区内）
      const outDot = await p2.locator('.node-asset .port.out .dot').boundingBox();
      const inDot = await p2.locator('.node-gen .port[data-port="refs"] .dot').boundingBox();
      assert.ok(outDot && inDot, `${w}px 连线端口须在可视区内`);
      await p2.mouse.move(outDot.x + outDot.width / 2, outDot.y + outDot.height / 2);
      await p2.mouse.down();
      await p2.mouse.move(inDot.x + inDot.width / 2, inDot.y + inDot.height / 2, { steps: 8 });
      await p2.mouse.up();
      await p2.waitForFunction(() => window.__xp.store.project.edges.length >= 1, null, { timeout: 5000 });
      // 真实参数操作：切型号 + 时长输入（输入即同步：节点体与草稿立刻更新为 6s）
      await p2.click('.node-gen .node-head');                   // ≤900 选中自动展开检查器
      if (w <= 900 && !(await p2.evaluate(() => document.getElementById('inspector').classList.contains('open'))))
        await p2.click('#inspector-toggle');
      await p2.waitForSelector('#inspector select', { timeout: 5000 });
      await p2.locator('#inspector select').first().selectOption('wan-3.0');
      await p2.fill('#inspector input[type=number]', '6');
      await p2.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.draft.seconds === 6, null, { timeout: 5000 });
      // 素材预览：真实 PNG 可见且可解码
      const pvBytes = await p2.evaluate(async () => {
        const a = Object.values(window.__xp.store.project.assets).find(x => x.kind === 'image');
        const b = await window.__xp.assets.blobOf(a.id);
        return [...new Uint8Array(await b.arrayBuffer())];
      });
      assert.ok(await assertImageDecodes(p2, pvBytes), `${w}px 预览图片可解码`);
      const previewVisible = await p2.locator('.node-asset img').first().isVisible().catch(() => false);
      assert.ok(previewVisible, `${w}px 素材预览可见`);
      const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= w, `${w}px 无横向溢出（scrollWidth=${sw}）`);
      // 等抽屉动画结束再验收，避免截图只捕获滑入过程；编辑后仍需能关闭。
      if (w <= 900) {
        await p2.waitForFunction(() => {
          const r = document.querySelector('#inspector').getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth + 1;
        });
        assert.equal(await p2.locator('#inspector .drawer-close').isVisible(), true, '编辑节点后保留关闭面板入口');
      }
      await p2.screenshot({ path: join(SHOTS, `canvas-${w}.png`), fullPage: false });
      if (w <= 900) {
        await p2.locator('#inspector .drawer-close').click();
        assert.equal(await p2.locator('#inspector').evaluate(e => e.classList.contains('open')), false, '参数面板可以正常关闭');
      }
      console.log(`viewport ${w}: connected/param/preview ok`);
    } finally { await c2.close(); }
  }
});
