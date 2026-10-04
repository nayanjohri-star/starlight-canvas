// WO-D2b 高风险 e2e 验收用例（本轮编写，实跑等 C2 性能测量结束 + B2/C3 交付入口对齐）。
// 三个端到端不变量：
//   E1 多标签同节点提交 → 幂等互斥，不多任务（真实 Web Locks + 共享 IndexedDB）
//   E2 10 镜成片按分镜顺序入轨 → 片段顺序正确 → 导出（ffmpeg 缺失如实标注）
//   E3 工程包导入干净环境 → 任务恢复、轮询恢复、零生成 POST
// 与 accept-*.test.mjs 的内存层断言互补：这里验证真实浏览器+真实 IndexedDB+真实锁语义。
// 全部 loopback mock（createCanvasServer+mockUpstream），零生产零付费。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  chromium, createCanvasServer, ROOT, MP4, CHROME, BROWSER_OK, FFMPEG_OK,
  makeState, mockUpstream, setKey, genData, watchEgress, RESOURCES,
} from './e2e-helpers.mjs';

const DIRECTOR_DIR = join(ROOT, '..', '..', 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage');

// 统一装配：loopback 服务 + 单浏览器；返回 {state, server, browser, port}
async function rig(t) {
  assert.ok(BROWSER_OK, 'E2E 浏览器缺失：npx playwright install chromium 或设 CANVAS_E2E_CHROME');
  const state = makeState();
  const server = createCanvasServer({
    staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: DIRECTOR_DIR,
    upstreamFetch: mockUpstream(state),
  });
  await new Promise(r => server.listen(4184, '127.0.0.1', r));   // integration 分配端口 4184（端口池登记；4178 不动）
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => {
    await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });
  return { state, server, browser, port: server.address().port };
}

async function boot(browser, port, { viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });
  return { ctx, page };
}

// ---------- E1：多标签同节点提交 → 不多任务 ----------
// 复现面：标签2 持项目旧快照（节点无 run），标签1 提交建任务后，标签2 再提交同一节点。
// Web Locks 互斥区内 adoptDurable 只读持久化记录认领任务——断言全链只一次付费 POST。
test('E1：两标签页共享项目同节点提交 → 幂等互斥只建一个任务', { timeout: 120000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const { state, browser, port } = await rig(t);
  const { ctx, page: p1 } = await boot(browser, port);
  t.after(() => ctx.close().catch(() => {}));
  await setKey(p1);
  const egress = await watchEgress(p1, { abort: true });

  const nodeId = await p1.evaluate(() => window.__xp.store.addNode('gen', 300, 200, {
    draft: { model: 'minimax-h3-768p-per-second', intent: 'text', prompt: '多标签幂等用例', seconds: 4, ratio: '16:9', switches: {} },
    perModel: {},
  }).id);
  const pid = await p1.evaluate(() => window.__xp.store.project.id);
  await p1.evaluate(() => window.__xp.store.flush());

  // 标签2：同源同上下文 → 共享 IndexedDB 与 Web Locks；此刻载入的是「无 run」旧快照
  const page2 = await ctx.newPage();
  await page2.goto(`http://127.0.0.1:${port}/`);
  await page2.waitForFunction(() => window.__xp?.store, null, { timeout: 15000 });
  await setKey(page2);
  const egress2 = await watchEgress(page2, { abort: true });
  await page2.evaluate(id => window.__xp.store.openProject(id), pid);
  const node2 = await page2.evaluate(id => {
    const n = window.__xp.store.project.nodes.find(x => x.id === id);
    return n ? { id: n.id, hasRun: Boolean(n.data?.run) } : null;
  }, nodeId);
  assert.ok(node2, '标签2 应载入同一节点');
  assert.equal(node2.hasRun, false, '标签2 快照为提交前状态（run 为空）');

  // 标签1 提交建任务（task-1）；标签2 持旧快照随后提交 → 互斥区内持久化核查应认领而非新建
  await p1.evaluate(id => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.id === id)), nodeId);
  await p1.waitForFunction(id => {
    const n = window.__xp.store.project.nodes.find(x => x.id === id);
    return n?.data?.run?.taskId;
  }, nodeId, { timeout: 15000 });

  await page2.evaluate(id => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.id === id)), nodeId);
  await page2.waitForFunction(id => {
    const n = window.__xp.store.project.nodes.find(x => x.id === id);
    return n?.data?.run?.taskId || n?.data?.run?.pendingKey;
  }, nodeId, { timeout: 15000 });

  assert.equal(state.creates.length, 1, `跨标签同节点提交只允许一次付费 POST（实际 ${state.creates.length}）`);
  const bound2 = await page2.evaluate(id => window.__xp.store.project.nodes.find(n => n.id === id)?.data?.run, nodeId);
  assert.ok(bound2?.taskId || bound2?.pendingKey, '标签2 应认领持久化任务/未决记录而非另建');
  assert.deepEqual(egress(), [], '标签1 存在非 loopback 外联请求');
  assert.deepEqual(egress2(), [], '标签2 存在非 loopback 外联请求');
});

// ---------- E2：10 镜成片按分镜顺序入轨（C3 合同路径）→ 导出 ----------
// 页面内构造 project.studio.shots + 带 outputAssetIds 的 gen 节点（shot.nodeId → 节点成片素材），
// 走 previewShotsToTimeline → applyTimelinePlan 真实链路：
//   ① 按 studio.shots 数组序（分镜权威序）解析与入轨；② 同计划再确认→过期拒绝；
//   ③ 新预览轨尾判重 dup → apply 拒绝；④「再次插入」allowDuplicate 显式放行。
// 判重/冲突/过期细节由 timeline-shots.test.mjs 12 例钉住，此处覆盖 e2e 链路与顺序。
// 渲染导出需 ffmpeg：缺失时该子断言如实标注「未验收」，入轨断言不受影响。
test('E2：10 段成片按分镜序入轨（C3 合同路径）→ 判重/再次插入 → 导出', { timeout: 180000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const { state, browser, port } = await rig(t);
  const { ctx, page } = await boot(browser, port);
  t.after(() => ctx.close().catch(() => {}));
  await setKey(page);
  const egress = await watchEgress(page, { abort: true });

  // 10 个分镜：每镜一个 video 素材 + gen 节点（outputAssetIds 成片）+ studio.shots 条目
  const shotAssets = await page.evaluate(async bytes => {
    const S = window.__xp.store;
    const st = S.project.studio ??= {}; st.shots ??= [];
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const a = await window.__xp.assets.registerBlob(
        new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), `shot-${String(i + 1).padStart(2, '0')}.mp4`, 'video');
      const n = S.addNode('gen', 40 + (i % 5) * 220, 60 + Math.floor(i / 5) * 160, { outputAssetIds: [a.id] });
      st.shots.push({
        id: `s${i + 1}`, title: `镜头${i + 1}`, duration: i + 1,
        nodeId: n.id, imageNodeId: null, assetIds: [], versions: [], createdAt: i, updatedAt: i,
      });
      ids.push(a.id);
    }
    return ids;
  }, MP4);
  assert.equal(shotAssets.length, 10);

  // ① 预览：按分镜权威序解析，零冲突、未判重。
  // plan 保留在页面上下文（__e2ePlan）——C 的签发校验只认 previewShotsToTimeline 签发的
  // 对象本身（WeakSet），跨 evaluate 序列化会丢对象身份；每次预览覆盖该槽位。
  const prev = await page.evaluate(() => window.__xp.timeline.previewShotsToTimeline({ shotIds: window.__xp.store.project.studio.shots.map(x => x.id) })
    .then(r => { window.__e2ePlan = r.plan; return { ok: r.ok, n: r.items.length, conflicts: r.conflicts.length,
      total: r.total, shotIds: r.items.map(i => i.shotId), dup: r.plan.dup }; }));
  assert.ok(prev.ok, `预览应成功（conflicts=${prev.conflicts}）`);
  assert.deepEqual(prev.shotIds, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'], '预览须按分镜权威序');
  assert.equal(prev.conflicts, 0); assert.equal(prev.total, 10); assert.equal(prev.dup, false);

  // ② 确认：apply → 10 片段按序首尾相接落到 v1
  const applied = await page.evaluate(() => window.__xp.timeline.applyTimelinePlan(window.__e2ePlan));
  assert.ok(applied.ok, `入轨应成功（${applied.reason ?? 'ok'}）`);
  const ordered = await page.evaluate(() => window.__xp.timeline.clips().map(c => ({ assetId: c.assetId, start: c.start, end: c.end })));
  assert.deepEqual(ordered.map(c => c.assetId), shotAssets, '时间线片段顺序必须等于分镜顺序');
  for (let i = 1; i < ordered.length; i++)
    assert.ok(ordered[i].start >= ordered[i - 1].end - 1e-6,
      `片段 ${i} 起点(${ordered[i].start})不得早于前段终点(${ordered[i - 1].end})`);

  // ③ 同一计划再确认 → 已消费拒绝；新预览轨尾判重 → apply 拒绝
  const again = await page.evaluate(() => window.__xp.timeline.applyTimelinePlan(window.__e2ePlan));
  assert.equal(again.ok, false); assert.match(again.reason ?? '', /已经加入过/);
  const prev2 = await page.evaluate(() => window.__xp.timeline.previewShotsToTimeline({ shotIds: window.__xp.store.project.studio.shots.map(x => x.id) })
    .then(r => { window.__e2ePlan = r.plan; return { dup: r.plan.dup }; }));
  assert.equal(prev2.dup, true, '轨尾同序列应被判重标记');
  const r2 = await page.evaluate(() => window.__xp.timeline.applyTimelinePlan(window.__e2ePlan));
  assert.equal(r2.ok, false); assert.match(r2.reason ?? '', /重复|再次插入/);

  // ④「再次插入」显式放行 → 20 片段
  const prev3 = await page.evaluate(() => window.__xp.timeline.previewShotsToTimeline({ shotIds: window.__xp.store.project.studio.shots.map(x => x.id), allowDuplicate: true })
    .then(r => { window.__e2ePlan = r.plan; return { allowDup: r.plan.allowDup }; }));
  assert.equal(prev3.allowDup, true);
  const r3 = await page.evaluate(() => window.__xp.timeline.applyTimelinePlan(window.__e2ePlan));
  assert.ok(r3.ok, `「再次插入」应放行（${r3.reason ?? 'ok'}）`);
  const total = await page.evaluate(() => window.__xp.timeline.clips().length);
  assert.equal(total, 20, '再次插入后应为 20 片段');

  // 导出（渲染需 ffmpeg；缺失如实标注，不包装通过）
  if (!FFMPEG_OK) { t.diagnostic('渲染导出未验收：ffmpeg 缺失（env-check 语义化 skip）'); return; }
  const result = await page.evaluate(() => window.__xp.timeline.renderExport().then(
    r => ({ ok: true, hasBlob: Boolean(r?.blob ?? r?.url ?? r) }),
    e => ({ ok: false, error: String(e?.message ?? e) })));
  assert.ok(result.ok && result.hasBlob, `导出应产出结果（实际 ${JSON.stringify(result)}）`);
  assert.deepEqual(egress(), [], '存在非 loopback 外联请求');
});

// ---------- E3：工程包导入干净环境 → 任务恢复 + 零生成 POST ----------
// 旧环境导出工程包 → 全新浏览器上下文（隔离 IndexedDB）导入 →
// 任务记录恢复、未决任务恢复轮询（只发 GET），绝不重新发创建 POST。
test('E3：工程包导入隔离环境 → 任务恢复轮询，零生成 POST', { timeout: 120000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const { state, browser, port } = await rig(t);
  const { ctx, page: p1 } = await boot(browser, port);
  t.after(() => ctx.close().catch(() => {}));
  await setKey(p1);
  const egress1 = await watchEgress(p1, { abort: true });

  const nodeId = await p1.evaluate(() => window.__xp.store.addNode('gen', 300, 200, {
    draft: { model: 'minimax-h3-768p-per-second', intent: 'text', prompt: '导入恢复用例', seconds: 4, ratio: '16:9', switches: {} },
    perModel: {},
  }).id);
  await p1.evaluate(id => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.id === id)), nodeId);
  await p1.waitForFunction(id => window.__xp.store.project.nodes.find(n => n.id === id)?.data?.run?.taskId, nodeId, { timeout: 15000 });
  assert.equal(state.creates.length, 1);
  const exported = await p1.evaluate(() => window.__xp.store.exportJSON());
  const createsAtExport = state.creates.length;

  // 全新上下文 = 隔离 IndexedDB 干净环境
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => ctx2.close().catch(() => {}));
  const p2 = await ctx2.newPage();
  await p2.goto(`http://127.0.0.1:${port}/`);
  await p2.waitForFunction(() => window.__xp?.store, null, { timeout: 15000 });
  await setKey(p2);
  const egress2 = await watchEgress(p2, { abort: true });
  const queriesAtImport = state.queries.length;

  const imported = await p2.evaluate(text => window.__xp.store.importJSON(text).then(
    () => ({ ok: true }), e => ({ ok: false, error: String(e?.message ?? e) })), exported);
  assert.ok(imported.ok, `工程包导入失败：${imported.error}`);

  const tasks2 = await p2.evaluate(() => window.__xp.store.tasksOfProject());
  assert.ok(tasks2.length >= 1, '导入应恢复任务记录');
  const rec = tasks2[0];
  assert.equal(rec.status === 'completed' || rec.status === 'queued' || rec.status === 'in_progress', true,
    `任务终态/在途状态应按导出时事实恢复（实际 ${rec.status}）`);

  // 恢复轮询：只允许状态 GET，绝不补发创建 POST
  await p2.evaluate(() => window.__xp.runner.resumeAll());
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(state.creates.length, createsAtExport, `导入恢复不得新建生成 POST（导出时 ${createsAtExport}，现 ${state.creates.length}）`);
  assert.ok(state.queries.length > queriesAtImport, '未决任务应恢复状态查询轮询');
  assert.deepEqual(egress1(), [], '导出侧存在非 loopback 外联请求');
  assert.deepEqual(egress2(), [], '导入侧存在非 loopback 外联请求');
});

// 资源结论（启动时即打印，供证据链记录）
test('E0：验收资源清单', () => {
  console.log('[e2e-accept] resources=', JSON.stringify({
    browser: RESOURCES.browser, playwrightFrom: RESOURCES.playwrightFrom,
    ffmpeg: RESOURCES.ffmpeg, director: RESOURCES.director,
  }));
});
