// 节点编辑器回归：首尾帧图片框（选择/替换/交换/移除，模式切换后只提交本模式输入口）、
// 面板锚定在预览下方且输入与状态更新时不移动、任务状态与错误分区展示、生成耗时（刷新后继续）、
// 缩略图放大/折叠。全部使用本地模拟上游与合成密钥，禁止外部出站。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, BROWSER_OK, ROOT, SHOTS, createCanvasServer, makeState, mockUpstream, MODELS_11, realPng, MP4, addAsset, setKey, watchEgress, waitTaskCompleted } from './e2e-helpers.mjs';

test('节点编辑器：首尾帧图片框、稳定位置、任务状态与耗时、缩略图', { timeout: 180000, skip: !BROWSER_OK && '浏览器缺失' }, async t => {
  const state = makeState(), upstream = mockUpstream(state);
  state.videoBytes = MP4;
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),
    upstreamFetch: (url, init) => new URL(url).pathname.endsWith('/models') ? Response.json({ data: MODELS_11.map(id => ({ id })) }) : upstream(url, init) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const egress = await watchEgress(page, { abort: true });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(origin); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);

  const a = await addAsset(page, await realPng(page, 20), '首帧候选.png', 'image', 20, 30);
  const b = await addAsset(page, await realPng(page, 200), '尾帧候选.png', 'image', 20, 300);
  const v = await addAsset(page, MP4, '参考视频.mp4', 'video', 20, 570);
  const nodeId = await page.evaluate(([ia, iv]) => {
    const s = window.__xp.store;
    const g = s.addNode('gen', 520, 120, { draft: { model: 'minimax-h3-768p-per-second', intent: 'refs', seconds: 5, ratio: '16:9', prompt: '' }, perModel: {} });
    s.addEdge(ia, 'out', g.id, 'refs', 'image'); s.addEdge(iv, 'out', g.id, 'refs', 'video'); s.touch({ type: 'structure' });
    return g.id;
  }, [a.nodeId, v.nodeId]);
  await page.locator(`[data-node="${nodeId}"] .node-head`).click();
  await page.waitForSelector('#inspector.node-composer');
  const editorAt = () => page.evaluate(() => { const r = document.getElementById('inspector').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; });
  const frames = () => page.evaluate(id => window.__xp.store.edgesInto(id, 'frames').map(e => window.__xp.store.node(e.from.node).data.assetId), nodeId);

  // ① 切换到首尾帧：明确的首帧/尾帧框；普通参考素材列为“不会提交”，不再报“不应连接普通素材”
  await page.getByRole('combobox', { name: '生成模式' }).selectOption('frames');
  await page.waitForSelector('.frame-slot-card[data-slot="first"] .frame-slot-empty');
  assert.equal(await page.locator('.frame-slot-card[data-slot="last"] .frame-slot-empty').isDisabled(), true, '未选首帧时尾帧不可选');
  assert.match(await page.locator('.frame-slots-head').innerText(), /首帧必选，尾帧可选 · 已选 0\/2/);
  assert.equal(await page.locator('.unused-inputs li').count(), 2, '已连接的普通参考素材列为不会提交');
  assert.doesNotMatch(await page.locator('#inspector').innerText(), /不应连接普通素材/);
  const anchored = await editorAt();

  // ② 选择、交换、移除（确认后原尾帧变首帧）、替换——都只改连线，不上传不生成
  await page.locator('.frame-slot-card[data-slot="first"] .frame-slot-empty').click();
  await page.locator(`.frame-picker-popup [data-frame-asset="${a.assetId}"]`).click();
  await page.locator('.frame-slot-card[data-slot="last"] .frame-slot-empty').click();
  await page.locator(`.frame-picker-popup [data-frame-asset="${b.assetId}"]`).click();
  assert.deepEqual(await frames(), [a.assetId, b.assetId]);
  await page.getByRole('button', { name: '交换首帧和尾帧' }).click();
  assert.deepEqual(await frames(), [b.assetId, a.assetId], '交换首尾帧');
  await page.getByRole('button', { name: '移除首帧' }).click();
  await page.locator('.modal button.primary', { hasText: '确认' }).click();
  assert.deepEqual(await frames(), [a.assetId], '移除首帧后原尾帧成为首帧');
  await page.getByRole('button', { name: '+ 选择尾帧' }).click();
  await page.locator(`.frame-picker-popup [data-frame-asset="${b.assetId}"]`).click();
  const assetNodes = () => page.evaluate(() => window.__xp.store.project.nodes.filter(n => n.type === 'asset').length);
  const nodesBefore = await assetNodes();
  await page.getByRole('button', { name: '替换尾帧' }).click();
  await page.locator(`.frame-picker-popup [data-frame-asset="${b.assetId}"]`).click();
  assert.equal(await assetNodes(), nodesBefore, '替换为同一张图不新建素材节点');
  assert.deepEqual(await frames(), [a.assetId, b.assetId]);
  assert.match(await page.locator('.frame-slots-head').innerText(), /已选 2\/2/);
  assert.equal(state.uploads.length + state.creates.length, 0, '选择首尾帧不上传、不生成');

  // ③ 长提示词：输入不改变编辑器位置；生成按钮始终可见
  const prompt = page.getByRole('textbox', { name: '视频提示词', exact: true });
  await prompt.click();
  await prompt.pressSequentially('镜头从清晨海边缓慢推进到黄昏城市，海浪拍打礁石，天空由蓝变橙，路灯一盏盏亮起，最后停在天际线。');
  assert.deepEqual(await editorAt(), anchored, '输入提示词不移动编辑器');
  assert.ok(await page.locator('#inspector .gen-cta button.primary').evaluate(b => b.getBoundingClientRect().bottom <= innerHeight), '生成按钮可见');
  await page.locator('#inspector .composer-expand').click();
  await page.waitForSelector('#inspector.composer-expanded');
  assert.ok(await prompt.evaluate(t => t.getBoundingClientRect().height >= 260), '展开后提示词区域放大');
  await page.locator('#inspector .composer-expand').click();
  await page.waitForFunction(() => !document.getElementById('inspector').classList.contains('composer-expanded'));
  await page.screenshot({ path: join(SHOTS, 'composer-frames.png') });

  // ④ 提交只含首尾帧：参考视频既不上传也不进入请求体；任务进行中显示“已等待”并持续计时，编辑器不移动
  state.slowTaskId = 'task-1';
  await page.locator('#inspector .gen-cta button.primary').click();
  const taskId = await page.waitForFunction(id => window.__xp.store.node(id).data.run?.taskId, nodeId).then(h => h.jsonValue());
  const body = JSON.parse(String(state.creates[0].body));
  assert.equal(body.metadata.mode, 'frames');
  assert.ok(body.metadata.first_frame_url && body.metadata.last_frame_url, '提交首帧与尾帧');
  for (const k of ['image_urls', 'video_urls', 'audio_urls']) assert.ok(!(k in body.metadata), `不混发普通参考素材（${k}）`);
  assert.equal(state.uploads.length, 2, '只上传首尾帧两张图片');
  await page.waitForSelector('#inspector .gen-task .task-elapsed');
  assert.match(await page.locator('#inspector .gen-task').innerText(), /当前任务[\s\S]*已等待/);
  assert.equal(await page.locator('#inspector .input-check').innerText(), '', '任务区与输入检查分开，进行中不显示输入错误');
  const t1 = await page.locator(`[data-node="${nodeId}"] .task-elapsed`).first().innerText();
  await page.waitForFunction(([id, t]) => document.querySelector(`[data-node="${id}"] .task-elapsed`)?.textContent !== t, [nodeId, t1], { timeout: 4000 });
  assert.deepEqual(await editorAt(), anchored, '状态更新不移动编辑器');

  // ⑤ 刷新后继续计时（从提交时刻起算，不重新计时），完成后显示用时
  await page.waitForTimeout(1200);
  await page.reload(); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const secs = await page.locator(`[data-node="${nodeId}"] .task-elapsed`).first().innerText().then(s => Number(/(\d+)秒/.exec(s)?.[1] ?? 0) + 60 * Number(/(\d+)分/.exec(s)?.[1] ?? 0));
  assert.ok(secs >= 2, `刷新后按提交时刻继续计时（${secs} 秒）`);
  state.slowTaskId = null;
  await page.evaluate(id => window.__xp.runner.poll(id, window.__xp.store.project.id, { immediate: true }), taskId);
  await waitTaskCompleted(page, taskId);
  await page.waitForFunction(id => /用时/.test(document.querySelector(`[data-node="${id}"] .task-elapsed`)?.textContent ?? ''), nodeId);

  // ⑥ 提交结果未确认：原任务区用可理解的操作，不混入输入错误，也不出现技术化文案
  await page.evaluate(id => window.__xp.board.select('node', id), nodeId);
  await page.getByRole('button', { name: '创建新版本', exact: true }).click();   // 复制参数与首尾帧，原任务保留
  const copyId = await page.waitForFunction(id => window.__xp.board.selected?.id !== id && window.__xp.board.selected?.id, nodeId).then(h => h.jsonValue());
  assert.deepEqual(await page.evaluate(id => window.__xp.store.edgesInto(id, 'frames').map(e => window.__xp.store.node(e.from.node).data.assetId), copyId), [a.assetId, b.assetId], '新版本保留首尾帧');
  state.createFailsLeft = 1;
  await page.locator('#inspector .gen-cta button.primary').click();
  await page.waitForFunction(id => !!window.__xp.store.node(id).data.run?.pendingKey, copyId);
  await page.waitForSelector('#inspector .gen-task');
  const pendingText = await page.locator('#inspector .gen-task').innerText();
  assert.match(pendingText, /原任务结果待确认/);
  for (const label of ['再次确认结果', '暂停等待', '检查能否重新提交']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 1, label);
  assert.doesNotMatch(await page.locator('#inspector').innerText(), /同幂等键|停止本地跟踪|解除提交保护/);
  assert.equal(await page.locator('#inspector .input-check').innerText(), '');
  await page.getByRole('button', { name: '再次确认结果', exact: true }).click();
  await page.waitForFunction(id => !!window.__xp.store.node(id).data.run?.taskId, copyId);
  assert.equal(new Set(state.creates.slice(-2).map(c => c.key)).size, 1, '再次确认使用同一次提交，不会重复收费');

  // ⑦ 缩略图：放大、折叠为“地图”、再展开
  await page.evaluate(() => window.__xp.board.select(null));
  await page.waitForFunction(() => !document.getElementById('inspector').classList.contains('node-composer'));
  const mapSize = () => page.locator('.minimap canvas').evaluate(c => [c.getBoundingClientRect().width, c.getBoundingClientRect().height].map(Math.round));
  assert.deepEqual(await mapSize(), [240, 150]);
  await page.getByRole('button', { name: '放大缩略图' }).click();
  assert.deepEqual(await mapSize(), [380, 238]);
  await page.getByRole('button', { name: '收起缩略图' }).click();
  assert.equal(await page.locator('.minimap canvas').isVisible(), false);
  await page.getByRole('button', { name: '展开导航缩略图' }).click();
  assert.deepEqual(await mapSize(), [380, 238], '展开后恢复上次尺寸');

  assert.deepEqual(errors, []); assert.deepEqual(egress(), []);
});
