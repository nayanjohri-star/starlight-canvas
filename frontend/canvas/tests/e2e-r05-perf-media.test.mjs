// R05 性能（真实媒体）：200 节点 / 300 连线，其中含真实图片与视频素材卡片，
// 至少一个视频在测量全程播放，默认吸附（网格 + 对齐）保持开启。
// 真实鼠标输入驱动 3 轮交互，每轮 ≥200 个有效帧间隔样本，逐轮报告 P50/P95/最大值（不取最好一轮），
// 并记录长任务、JS 堆内存、节点与视频元素是否被重建、视频是否持续播放。阈值：每轮 P95 ≤ 50ms。
// 本层在门禁中串行运行，不与其他浏览器/编码负载竞争。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, MP4, makeState, mockUpstream, realPng, skipIf } from './e2e-helpers.mjs';

const P95_TARGET = 50, MIN_SAMPLES = 200, MOVES = 230;
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)]; };

test('R05 性能：真实图片/视频 + 播放中视频 + 默认吸附，200/300 三轮 P95 ≤ 50ms，无节点/视频重建', { skip: skipIf(!BROWSER_OK, '浏览器缺失'), timeout: 300000 }, async t => {
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, 'tests', 'no-director-assets'), upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close().catch(() => {}));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? null;

  // 真实素材：20 张不同色相 PNG + 10 段 MP4（夹具，可解码）
  const pngs = [];
  for (let i = 0; i < 20; i++) pngs.push(await realPng(page, (i * 17) % 360));
  const built = await page.evaluate(async ([pngs, mp4]) => {
    const x = window.__xp, s = x.store;
    const W = 18; let k = 0; const pos = () => [(k % W) * 330, Math.floor(k++ / W) * 300];
    const ids = { text: [], image: [], gen: [], asset: [], video: [] };
    for (let i = 0; i < 80; i++) { const [a, b] = pos(); ids.text.push(s.addNode('text', a, b, { text: '剧本段 ' + i, title: '文本' + i }).id); }
    for (let i = 0; i < 50; i++) { const [a, b] = pos(); ids.image.push(s.addNode('image', a, b, { prompt: '分镜图 ' + i, title: '图片' + i }).id); }
    for (let i = 0; i < 40; i++) { const [a, b] = pos(); ids.gen.push(s.addNode('gen', a, b, { prompt: '镜头 ' + i, title: '视频' + i }).id); }
    for (let i = 0; i < 30; i++) {
      const video = i < 10;
      const blob = new Blob([new Uint8Array(video ? mp4 : pngs[i - 10])], { type: video ? 'video/mp4' : 'image/png' });
      const a = await x.assets.registerBlob(blob, video ? `片段${i}.mp4` : `图${i}.png`, video ? 'video' : 'image');
      const [px, py] = i === 0 ? [360, 140] : pos();   // 第一段视频放在视口内，用于测量期间播放
      const id = s.addNode('asset', px, py, { assetId: a.id }).id;
      ids.asset.push(id); if (video) ids.video.push(id);
    }
    let added = 0;
    const E = (f, fp, tn, tp, kd) => { if (s.addEdge(f, fp, tn, tp, kd)) added++; };
    for (let i = 0; i < 60; i++) E(ids.text[i % 80], 'out', ids.gen[i % 40], 'prompt', 'text');
    for (let i = 0; i < 40; i++) E(ids.text[(i + 20) % 80], 'out', ids.image[i % 50], 'prompt', 'text');
    for (let i = 0; i < 60; i++) E(ids.text[(i + 40) % 80], 'out', ids.text[(i + 1) % 80], 'prompt', 'text');
    for (let i = 0; i < 40; i++) E(ids.image[i % 50], 'out', ids.gen[i % 40], 'frames', 'image');
    for (let i = 0; i < 30; i++) E(ids.image[(i + 10) % 50], 'out', ids.image[(i + 11) % 50], 'refs', 'image');
    for (let i = 0; i < 20; i++) E(ids.gen[i % 40], 'out', ids.gen[(i + 13) % 40], 'refs', 'video');
    for (let i = 0; i < 30; i++) E(ids.asset[i], 'out', ids.gen[(i + 7) % 40], 'refs', i < 10 ? 'video' : 'image');
    for (let i = 0; i < 20; i++) E(ids.asset[10 + i], 'out', ids.image[(i + 23) % 50], 'refs', 'image');
    return { ids, nodes: s.project.nodes.length, edges: s.project.edges.length, added, snap: { ...x.board.snap } };
  }, [pngs, MP4]);
  assert.equal(built.nodes, 200);
  assert.equal(built.edges, 300, `计划 300 边，实建 ${built.edges}`);
  assert.deepEqual(built.snap, { grid: true, align: true }, '默认吸附保持开启');

  // 启动播放：视口内第一段视频循环播放（静音以满足自动播放策略）
  await page.waitForFunction(id => document.querySelector(`[data-node="${id}"] video`)?.readyState >= 2, built.ids.video[0], { timeout: 20000 });
  await page.evaluate(id => {
    const v = document.querySelector(`[data-node="${id}"] video`);
    v.loop = true; v.muted = true; window.__r05video = v;
    for (const el of document.querySelectorAll('.node')) el.dataset.r05tag = '1';
    window.__r05longtasks = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.__r05longtasks.push(e.duration); }).observe({ type: 'longtask', buffered: false });
    return v.play();
  }, built.ids.video[0]);
  await page.waitForFunction(() => !window.__r05video.paused && window.__r05video.currentTime > 0, null, { timeout: 10000 });
  await page.waitForTimeout(800);
  const heapBefore = await heap();

  async function round(label, from, dx, dy) {
    await page.evaluate(() => {
      window.__r05iv = []; window.__r05longtasks.length = 0;
      let prev = performance.now();
      const tick = () => { const n = performance.now(); window.__r05iv.push(n - prev); prev = n; window.__r05raf = requestAnimationFrame(tick); };
      window.__r05raf = requestAnimationFrame(tick);
      window.__r05t0 = window.__r05video.currentTime;
    });
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= MOVES; i++) await page.mouse.move(from.x + i * dx, from.y + i * dy);
    await page.mouse.up();
    const r = await page.evaluate(() => { cancelAnimationFrame(window.__r05raf); return { iv: window.__r05iv.slice(4), longtasks: [...window.__r05longtasks], played: window.__r05video.currentTime !== window.__r05t0 || window.__r05video.loop, paused: window.__r05video.paused }; });
    return { label, samples: r.iv.length, p50: quantile(r.iv, 0.5), p95: quantile(r.iv, 0.95), max: Math.max(...r.iv), longTasks: r.longtasks.length, longTaskMs: Math.round(r.longtasks.reduce((a, b) => a + b, 0)), videoPaused: r.paused };
  }
  const box = async id => page.locator(`[data-node="${id}"] .node-head`).boundingBox();
  const genHead = await box(built.ids.gen[0]);
  const vidHead = await box(built.ids.video[0]);
  const rounds = [
    await round('拖动生成节点（多条入边重算）', { x: genHead.x + 40, y: genHead.y + 12 }, 1, 0.5),
    await round('平移画布（可见性 + 小地图 + 连线）', { x: 1000, y: 820 }, -2, -1),
    await round('拖动正在播放的视频卡片', { x: vidHead.x + 40, y: vidHead.y + 12 }, 1, 0.4),
  ];
  const heapAfter = await heap();
  const after = await page.evaluate(id => ({
    untagged: [...document.querySelectorAll('.node')].filter(el => el.dataset.r05tag !== '1').length,
    sameVideo: document.querySelector(`[data-node="${id}"] video`) === window.__r05video && window.__r05video.isConnected,
    paused: window.__r05video.paused, currentTime: window.__r05video.currentTime,
    snap: { ...window.__xp.board.snap },
    nodes: window.__xp.store.project.nodes.length, edges: window.__xp.store.project.edges.length,
  }), built.ids.video[0]);
  const env = await page.evaluate(() => ({ ua: navigator.userAgent, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency }));
  const report = { viewport: '1440x900', nodes: 200, edges: 300, realMedia: { images: 20, videos: 10, playing: 1 }, snap: after.snap, env,
    rounds, heapMB: { before: heapBefore && +(heapBefore / 1048576).toFixed(1), after: heapAfter && +(heapAfter / 1048576).toFixed(1) },
    rebuild: { nodesRecreated: after.untagged, videoElementPreserved: after.sameVideo, videoStillPlaying: !after.paused } };
  t.diagnostic(`PERF_MEDIA ${JSON.stringify(report)}`);
  for (const r of rounds) {
    assert.ok(r.samples >= MIN_SAMPLES, `${r.label}：有效样本 ${r.samples} < ${MIN_SAMPLES}`);
    assert.ok(r.p95 <= P95_TARGET, `${r.label}：P95=${r.p95.toFixed(1)}ms 超过 ${P95_TARGET}ms（如实上报，不降阈值）`);
  }
  assert.equal(after.untagged, 0, '交互期间节点卡片不应被重建');
  assert.equal(after.sameVideo, true, '播放中的视频元素不应被重建');
  assert.equal(after.paused, false, '交互后视频仍在播放');
  assert.deepEqual(after.snap, { grid: true, align: true }, '测量全程保持默认吸附');
  assert.equal(after.nodes, 200); assert.equal(after.edges, 300);
  assert.deepEqual(errors, []);
});
