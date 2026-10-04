// 浏览器端到端回归（H3 兼容补全：两个新接入型号）：全部上游调用走本地 mock，零生产、零费用。
// 与 e2e.test.mjs 独立：随机端口、独立 context、单浏览器实例串行、headless --disable-gpu、
// 不读用户 Chrome 配置；本测试自包一层 mock——仅在 GET /v1/models 响应中给既有 11 型号
// 目录追加两个新型号（不改动 e2e-helpers）；context.route 阻断一切非本机真实网络请求；
// pageerror 一律记为失败。
// 前置：dist 构建需含 13 型号能力表与 last_frame 支持（可用 CANVAS_TEST_DIST 指定测试构建）。
//
// 覆盖：
//  1) 13 型号全部可选 + 单图请求合约（SD→refs 单图 / Wan→i2v / 按秒 H3→frames 首帧 /
//     限版→omni refs / 慢速版→last_frame 尾帧）
//  2) 限版 minimax-h3-768p-limited：仅 纯文字+素材参考（无 frames/last_frame）、时长恰 6/10/15、
//     比例仅 16:9、¥1.50 按次价（慢速版为 ¥0.10/秒按请求秒数）、无声音/人脸开关；视频超限(0)/纯音频/非档位时长本地拒绝且 0 POST；
//     完整 上传→提交→轮询→鉴权下载→解码
//  3) 慢速版 minimax-h3-768p-full-slow：intent=last_frame→metadata.mode=frames、恰好 1 图只发
//     last_frame_url（不发 first_frame_url/普通素材数组）；普通 refs 不混发；正常 frames 行为
//     保持（1 图 only-first、2 图 first+last）；音频单独参考（supports_audio_only）；
//     WebM（视频白名单仅 mp4）与超 media_max_bytes 素材拒绝且 0 POST；完整全流程 + 下载解码
//  4) 型号往返：prompt/@绑定/素材连线/perModel intent 完整保留
//  5) 1280/1440/1920 桌面视口：限版时长档/¥1.50/仅尾帧参数可见、无横向溢出、截图入 shots（不测手机）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  chromium, createCanvasServer, ROOT, MP4, WEBM, WAV, SHOTS, CHROME,
  realPng, assertVideoDecodes, assertImageDecodes, assertAudioDecodes,
  makeState, mockUpstream, MODELS_11, waitTaskCompleted, setKey, addAsset,
  selectAndFill, downloadCurrent, genData, clickCanvasAction, explainGenStall } from './e2e-helpers.mjs';

const LIMITED = 'minimax-h3-768p-limited';   // 能力受限768p：¥1.5/次、仅 6/10/15s、仅 16:9
const SLOW = 'minimax-h3-768p-full-slow';    // 满参慢速版768p：¥0.10/秒、仅尾帧/纯音频/mp4-only
const ALL_IDS = [...MODELS_11, LIMITED, SLOW];

// 有效音频使用真实2秒PCM WAV；共享helper的一秒样本不符合DMC的最短时长。
const AUDIO_2S = (() => {
  const bytes = new Uint8Array(44 + 32000), view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, 32000, true);
  for (let i = 0; i < 16000; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * 220 / 8000) * 2000), true);
  return [...bytes];
})();

test('E2E H3 兼容：13 型号合约 + 限版/慢速版全流程 + 桌面三视口', { timeout: 300000 }, async t => {
  const state = makeState();
  // helper 型号目录只有 11 个：本测试包一层，仅改写 GET /v1/models，其余路由全委托既有 mock
  const baseUpstream = mockUpstream(state);
  const server = createCanvasServer({
    staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: join(ROOT, '..', '..', 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage'),
    upstreamFetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (init.method === 'GET' && path === '/v1/models') return Response.json({ data: ALL_IDS.map(id => ({ id })) });
      const response = await baseUpstream(url, init);
      if (init.method === 'POST' && path === '/reference-assets' && response.ok) {
        const body = await response.clone().json();
        // 模拟探测响应与本测试实际上传的2秒WAV一致。
        if (body.kind === 'audio') return Response.json({ ...body, duration_seconds: 2 });
      }
      return response;
    },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser = null;
  t.after(async () => {
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  // 阻断一切非本机请求：页面与上游全部同源本机；外网请求 abort 并留痕
  const guardNet = c => c.route(/^https?:\/\//, route => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return route.continue();
    console.log('[blocked net]', u.href);
    return route.abort();
  });
  const pageErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await guardNet(ctx);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  page.on('pageerror', e => { pageErrors.push(String(e?.message ?? e)); console.log('[pageerror]', e.message); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });
  await setKey(page);   // /v1/models 含 13 型号 → 全部可用

  const postCount = () => state.uploads.length + state.creates.length;
  const genId = await page.evaluate(() => window.__xp.store.addNode('gen', 300, 200, { draft: {}, perModel: {} }).id);
  const sel = i => page.locator('#inspector select').nth(i);
  // 清掉 gen 全部入线，再按 {port:[[nodeId,kind]]} 接线（refs/frames 互斥场景通用）
  const setWires = byPort => page.evaluate(([g, bp]) => {
    const s = window.__xp.store;
    s.project.edges = s.project.edges.filter(e => e.to.node !== g);
    for (const [port, items] of Object.entries(bp))
      for (const [from, kind] of items) s.addEdge(from, 'out', g, port, kind);
    s.touch({ type: 'structure' });
  }, [genId, byPort]);
  const submit = () => page.evaluate(() => window.__xp.runner.submit(window.__xp.store.project.nodes.find(n => n.type === 'gen')));
  const submitAndGetTask = async () => {
    await submit();
    return page.waitForFunction(() => {
      const run = window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run;
      return run?.taskId ?? (run?.error || run?.pendingKey ? { fail: run.error ?? run.pendingKey } : null);
    }, null, { timeout: 15000 }).then(h => h.jsonValue(), async e => { throw new Error(await explainGenStall(page, 'H3 兼容提交'), { cause: e }); });
  };
  // 预期本地校验拒绝：提交后 0 POST、节点不留下 taskId/pendingKey
  const submitExpectReject = async label => {
    const before = postCount();
    await submit();
    await page.waitForTimeout(400);
    assert.equal(postCount(), before, `${label}：本地拒绝须 0 POST`);
    const left = await page.evaluate(() => {
      const run = window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run;
      return { taskId: !!run?.taskId, pendingKey: !!run?.pendingKey };
    });
    assert.deepEqual(left, { taskId: false, pendingKey: false }, `${label}：拒绝不得留下任务/待决`);
  };
  const detachGen = () => page.evaluate(async () => {
    const n = window.__xp.store.project.nodes.find(x => x.type === 'gen');
    await window.__xp.runner.detach(n);
    n.data.resultAssetId = null;
  });
  const setDraft = patch => page.evaluate(p => {
    Object.assign(window.__xp.store.project.nodes.find(x => x.type === 'gen').data.draft, p);
  }, patch);
  const lastBody = () => JSON.parse(String(state.creates.at(-1).body));

  // ---------- 0) 真实媒体样本入库 ----------
  state.videoBytes = MP4;
  const pngA = await realPng(page), pngB = await realPng(page, 120);
  assert.ok(await assertImageDecodes(page, pngA), 'PNG 可解码');
  assert.ok(await assertVideoDecodes(page, MP4, 'video/mp4'), 'MP4 可解码');
  assert.ok(await assertVideoDecodes(page, WEBM, 'video/webm'), 'WebM 可解码');
  assert.ok(await assertAudioDecodes(page, AUDIO_2S), '2秒WAV 可解码');
  const imgA = await addAsset(page, pngA, 'a.png', 'image', 40, 60);
  const imgB = await addAsset(page, pngB, 'b.png', 'image', 40, 220);
  const audA = await addAsset(page, AUDIO_2S, 'bgm.wav', 'audio', 40, 380);
  const vidA = await addAsset(page, MP4, 'clip.mp4', 'video', 40, 540);
  const webmA = await page.evaluate(async b => {   // 慢速版视频白名单仅 mp4 → WebM 用于拒绝验收
    const a = await window.__xp.assets.registerBlob(new Blob([new Uint8Array(b)], { type: 'video/webm' }), 'clip.webm', 'video');
    return { assetId: a.id, nodeId: window.__xp.store.addNode('asset', 40, 700, { assetId: a.id }).id };
  }, WEBM);
  // 超限音频（慢速版 media_max_bytes.audio=15MB）：优先真实 20MB WAV；注册失败回退为记录 size 超限
  const bigAud = await page.evaluate(async wav => {
    let a = null;
    try {
      const n = 20 * 1024 * 1024, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
      const ws = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
      ws(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ws(8, 'WAVE');
      ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, 'data'); dv.setUint32(40, n, true);
      a = await window.__xp.assets.registerBlob(new Blob([buf], { type: 'audio/wav' }), 'big.wav', 'audio');
    } catch { /* 注册侧若做解码校验则回退小样本 */ }
    if (!a) a = await window.__xp.assets.registerBlob(new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'big.wav', 'audio');
    if (!(a.size > 15 * 1024 * 1024)) a.size = 20 * 1024 * 1024;
    return { assetId: a.id, nodeId: window.__xp.store.addNode('asset', 40, 860, { assetId: a.id }).id };
  }, WAV);

  // ---------- 1) 13 型号全部可选 ----------
  await page.click('.node-gen .node-head');
  await page.waitForSelector('#inspector select', { timeout: 8000 });
  const modelOpts = await sel(0).evaluate(s => [...s.options].map(o => ({ v: o.value, d: o.disabled, t: o.textContent })));
  for (const id of ALL_IDS) {
    const o = modelOpts.find(x => x.v === id);
    assert.ok(o, `${id} 出现在型号下拉`);
    assert.equal(o.d, false, `${id} 当前密钥可选`);
  }
  assert.match(modelOpts.find(x => x.v === LIMITED)?.t ?? '', /¥1\.5\/次/, '限版标注按次价');
  assert.match(modelOpts.find(x => x.v === SLOW)?.t ?? '', /¥0\.1\/秒/, '慢速版标注按秒价（能力表 2026-09-18.1：¥0.10/秒）');
  console.log('13 型号可选性 ok');

  // ---------- 2) 13 型号单图请求合约（每型号按其真实单图模式提交一次） ----------
  const SWEEP = [
    ['seedance-2.5-vip-480p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-vip-720p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-vip-1080p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-discount-480p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-discount-720p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-special-480p', 'refs', 'refs', 'sd'],
    ['seedance-2.5-special-720p', 'refs', 'refs', 'sd'],
    ['wan-3.0', 'i2v', 'refs', 'wan'],
    ['wan-3.0-prime', 'i2v', 'refs', 'wan'],
    ['minimax-h3-768p-per-second', 'frames', 'frames', 'h3first'],
    ['minimax-h3-2k-per-second', 'frames', 'frames', 'h3first'],
    [LIMITED, 'refs', 'refs', 'ltd'],
    [SLOW, 'last_frame', 'frames', 'last'],
  ];
  const CHECKS = {
    sd: (m, meta) => {
      assert.equal(meta.mode, 'references', m);
      assert.equal(meta.image_urls?.length, 1, m);
      assert.ok(!meta.video_urls && !meta.audio_urls && !('first_frame_url' in meta) && !('last_frame_url' in meta), m);
    },
    wan: (m, meta) => {
      assert.equal(meta.mode, 'image_to_video', m);
      assert.equal(meta.image_urls?.length, 1, m);
      assert.ok(!meta.video_urls && !meta.audio_urls && !('first_frame_url' in meta), m);
    },
    h3first: (m, meta) => {
      assert.equal(meta.mode, 'frames', m);
      assert.ok(meta.first_frame_url?.startsWith('https://'), m);
      assert.ok(!('last_frame_url' in meta) && !('image_urls' in meta), `${m} 单图 frames 只发 first_frame_url`);
    },
    ltd: (m, meta) => {
      assert.equal(meta.mode, 'omni_reference', m);
      assert.equal(meta.image_urls?.length, 1, m);
      assert.equal(meta.ratio, '16:9', m);
      assert.ok(!meta.video_urls && !meta.audio_urls && !('first_frame_url' in meta) && !('last_frame_url' in meta), m);
      assert.ok(!('generate_audio' in meta) && !('face_mode' in meta), `${m} 不支持的开关不下发`);
    },
    last: (m, meta) => {
      assert.equal(meta.mode, 'frames', m);
      assert.ok(meta.last_frame_url?.startsWith('https://'), m);
      assert.ok(!('first_frame_url' in meta) && !('image_urls' in meta) && !('video_urls' in meta) && !('audio_urls' in meta),
        `${m} 仅尾帧只发 last_frame_url`);
    },
  };
  for (const [model, intent, port, kind] of SWEEP) {
    await detachGen();
    await setWires({ [port]: [[imgA.nodeId, 'image']] });
    await selectAndFill(page, { model, intent, prompt: `${model} 单图合约` });
    const before = state.creates.length;
    const tid = await submitAndGetTask();
    if (typeof tid === 'object') throw new Error(`${model} 提交未受理：${JSON.stringify(tid)}`);
    assert.equal(state.creates.length, before + 1, `${model} 恰好创建一次`);
    const body = lastBody();
    assert.equal(body.model, model, `${model} 请求型号一致`);
    CHECKS[kind](model, body.metadata);
  }
  console.log('13 型号单图合约 ok');

  // ---------- 3) 限版：控件/价格/拒绝项 + 完整流程 ----------
  await detachGen();
  await setWires({});
  await selectAndFill(page, { model: LIMITED, intent: 'refs', prompt: '限版控件' });
  assert.deepEqual((await sel(1).evaluate(s => [...s.options].map(o => o.value))).sort(), ['refs', 'text'], '限版仅 纯文字+素材参考');
  assert.deepEqual(await sel(2).evaluate(s => [...s.options].map(o => o.value)), ['6', '10', '15'], '限版时长恰为 6/10/15');
  assert.deepEqual(await sel(3).evaluate(s => [...s.options].map(o => o.value)), ['16:9'], '限版比例仅 16:9');
  assert.equal(await page.locator('#inspector input[type=checkbox]').count(), 0, '限版不出现无效的声音/人脸开关');
  for (const sec of ['6', '10', '15']) {
    await sel(2).selectOption(sec);
    await page.waitForTimeout(80);
    assert.match(await page.locator('#inspector .cost').textContent(), /¥1\.50/, `限版 ${sec}s 恒 ¥1.50（按次）`);
  }
  assert.equal(await page.locator('#inspector button.primary').isDisabled(), true, 'refs 无素材禁用提交');
  await page.screenshot({ path: join(SHOTS, 'h3-limited-controls.png'), fullPage: false });

  await setWires({ refs: [[imgA.nodeId, 'image']] });
  await setDraft({ seconds: 8 });
  await submitExpectReject('限版非 6/10/15 秒');
  await setDraft({ seconds: 10 });
  await setWires({ refs: [[imgA.nodeId, 'image'], [vidA.nodeId, 'video']] });
  await submitExpectReject('限版接视频素材');
  await setWires({ refs: [[audA.nodeId, 'audio']] });
  await submitExpectReject('限版纯音频参考');
  console.log('限版控件/拒绝项 ok');

  await detachGen();
  await setWires({ refs: [[imgA.nodeId, 'image'], [audA.nodeId, 'audio']] });
  await selectAndFill(page, { model: LIMITED, intent: 'refs', prompt: '限版全流程@图片1' });
  await setDraft({ seconds: 10 });
  const upL = state.uploads.length;
  const tidL = await submitAndGetTask();
  if (typeof tidL === 'object') throw new Error(`限版提交未受理：${JSON.stringify(tidL)}`);
  assert.equal(state.uploads.length, upL + 1, '限版仅新上传音频（图片远端仍有效）');
  await waitTaskCompleted(page, tidL);
  const bodyL = lastBody();
  assert.equal(bodyL.model, LIMITED);
  assert.equal(bodyL.seconds, 10, '限版请求秒数=10');
  assert.equal(bodyL.prompt, '限版全流程@1', '本站规范 token');
  assert.deepEqual(Object.keys(bodyL.metadata).sort(), ['audio_urls', 'image_urls', 'mode', 'ratio'], '限版请求体字段');
  assert.equal(bodyL.metadata.mode, 'omni_reference');
  assert.equal(bodyL.metadata.image_urls.length, 1);
  assert.equal(bodyL.metadata.audio_urls.length, 1);
  await downloadCurrent(page, tidL);
  console.log('限版全流程 ok');

  // ---------- 4) 慢速版：仅尾帧 / 纯音频 / 媒体白名单 ----------
  await detachGen();
  await selectAndFill(page, { model: SLOW });
  const slowIntents = await sel(1).evaluate(s => [...s.options].map(o => o.value));
  for (const i of ['text', 'refs', 'frames', 'last_frame']) assert.ok(slowIntents.includes(i), `慢速版提供 ${i}`);
  { // 慢速版按请求秒数计价（¥0.10/秒）：检查器金额须等于当前草稿秒数 × 0.10
    const slowSec = await page.evaluate(() => window.__xp.store.project.nodes.find(x => x.type === 'gen').data.draft.seconds);
    const slowCost = await page.locator('#inspector .cost').textContent();
    assert.ok(slowCost.includes(`¥${(slowSec * 0.1).toFixed(2)}`), `慢速版 ${slowSec}s 应为 ¥${(slowSec * 0.1).toFixed(2)}（实际 ${slowCost}）`);
    await setDraft({ seconds: 5 });
    await page.evaluate(() => window.__xp.store.touch({ type: 'data' }));
    await page.locator('.node-gen .node-head').first().click();
    await page.waitForFunction(() => document.querySelector('#inspector .cost')?.textContent.includes('¥0.50'), null, { timeout: 5000 })
      .catch(async () => assert.fail(`慢速版 5s 应为 ¥0.50（实际 ${await page.locator('#inspector .cost').textContent()}）`));
    await setDraft({ seconds: slowSec }); }
  assert.equal(await page.locator('#inspector input[type=checkbox]').count(), 0, '慢速版不出现无效的声音/人脸开关');
  await selectAndFill(page, { model: 'minimax-h3-768p-per-second' });
  assert.ok(!(await sel(1).evaluate(s => [...s.options].map(o => o.value))).includes('last_frame'), '按秒 H3 不提供仅尾帧');
  await selectAndFill(page, { model: LIMITED });
  assert.ok(!(await sel(1).evaluate(s => [...s.options].map(o => o.value))).includes('last_frame'), '限版不提供仅尾帧');

  // 4a) 仅尾帧全流程：恰好 1 图 → 只发 last_frame_url
  await detachGen();
  await setWires({ frames: [[imgB.nodeId, 'image']] });
  await selectAndFill(page, { model: SLOW, intent: 'last_frame', prompt: '只给尾帧的镜头' });
  const upS = state.uploads.length;
  const tidS = await submitAndGetTask();
  if (typeof tidS === 'object') throw new Error(`慢速版提交未受理：${JSON.stringify(tidS)}`);
  assert.equal(state.uploads.length, upS + 1, '尾帧图片真实上传');
  await waitTaskCompleted(page, tidS);
  const bodyS = lastBody();
  assert.equal(bodyS.model, SLOW);
  assert.deepEqual(Object.keys(bodyS.metadata).sort(), ['last_frame_url', 'mode', 'ratio'], '仅尾帧请求只发 last_frame_url');
  assert.equal(bodyS.metadata.mode, 'frames');
  assert.ok(bodyS.metadata.last_frame_url.startsWith('https://xingpan.site/reference-assets/'));
  await downloadCurrent(page, tidS);

  // 4b) 正常 frames 行为保持：2 图 first+last、1 图 only-first
  await detachGen();
  await setWires({ frames: [[imgA.nodeId, 'image'], [imgB.nodeId, 'image']] });
  await selectAndFill(page, { model: SLOW, intent: 'frames', prompt: '首尾帧双图' });
  const tidF2 = await submitAndGetTask();
  if (typeof tidF2 === 'object') throw new Error(`frames 双图未受理：${JSON.stringify(tidF2)}`);
  let meta = lastBody().metadata;
  assert.equal(meta.mode, 'frames');
  assert.ok(meta.first_frame_url && meta.last_frame_url, '双图 frames 发 first+last');
  assert.notEqual(meta.first_frame_url, meta.last_frame_url, '首/尾帧指向不同素材');
  await detachGen();
  await setWires({ frames: [[imgA.nodeId, 'image']] });
  const tidF1 = await submitAndGetTask();
  if (typeof tidF1 === 'object') throw new Error(`frames 单图未受理：${JSON.stringify(tidF1)}`);
  meta = lastBody().metadata;
  assert.ok(meta.first_frame_url && !('last_frame_url' in meta), '单图 frames 仅 first_frame_url');

  // 4c) 音频单独参考（supports_audio_only）
  await detachGen();
  await setWires({ refs: [[audA.nodeId, 'audio']] });
  await selectAndFill(page, { model: SLOW, intent: 'refs', prompt: '只按音频氛围生成' });
  const tidA = await submitAndGetTask();
  if (typeof tidA === 'object') throw new Error(`慢速版纯音频未受理：${JSON.stringify(tidA)}`);
  meta = lastBody().metadata;
  assert.equal(meta.mode, 'omni_reference');
  assert.equal(meta.audio_urls?.length, 1, '纯音频参考发 audio_urls');
  assert.ok(!('image_urls' in meta) && !('video_urls' in meta) && !('first_frame_url' in meta) && !('last_frame_url' in meta), '纯音频不带图/视频/帧');

  // 4d) 每种模式只提交自己的输入口：多余/另一口的连线在编辑器中列为「不会提交」，请求体绝不混发；
  //     缺图等真实输入问题仍在本地拒绝（0 POST）
  const remoteUrl = assetId => page.evaluate(id => window.__xp.store.project.assets[id].remote?.url, assetId);
  await detachGen();
  await selectAndFill(page, { intent: 'last_frame' });   // 型号仍为慢速版
  await setWires({ frames: [[imgA.nodeId, 'image'], [imgB.nodeId, 'image']] });
  const tidL2 = await submitAndGetTask();
  if (typeof tidL2 === 'object') throw new Error(`仅尾帧（多连一张）未受理：${JSON.stringify(tidL2)}`);
  meta = lastBody().metadata;
  assert.deepEqual(Object.keys(meta).sort(), ['last_frame_url', 'mode', 'ratio'], '仅尾帧只提交一张图');
  assert.equal(meta.last_frame_url, await remoteUrl(imgB.assetId), '仅尾帧使用最后一张图片（编辑器中显示的尾帧）');
  await detachGen();
  await setWires({});
  await submitExpectReject('仅尾帧缺图');
  await setWires({ frames: [[imgA.nodeId, 'image']], refs: [[vidA.nodeId, 'video']] });
  const tidLR = await submitAndGetTask();
  if (typeof tidLR === 'object') throw new Error(`仅尾帧（另连普通素材）未受理：${JSON.stringify(tidLR)}`);
  assert.deepEqual(Object.keys(lastBody().metadata).sort(), ['last_frame_url', 'mode', 'ratio'], '仅尾帧不混发普通 refs');
  await detachGen();
  await selectAndFill(page, { intent: 'refs' });
  await setWires({ refs: [[webmA.nodeId, 'video']] });
  await submitExpectReject('慢速版 WebM 素材');
  await setWires({ refs: [[bigAud.nodeId, 'audio']] });
  await submitExpectReject('慢速版超限音频');
  await selectAndFill(page, { intent: 'frames' });
  await setWires({ frames: [[imgA.nodeId, 'image']], refs: [[vidA.nodeId, 'video']] });
  const tidFR = await submitAndGetTask();
  if (typeof tidFR === 'object') throw new Error(`首尾帧（另连普通素材）未受理：${JSON.stringify(tidFR)}`);
  meta = lastBody().metadata;
  assert.ok(meta.first_frame_url && !('video_urls' in meta) && !('image_urls' in meta) && !('audio_urls' in meta), 'frames 不混发普通 refs');
  await detachGen();
  console.log('慢速版合约/拒绝项 ok');

  // ---------- 5) 型号往返：prompt/@绑定/素材连线/perModel intent 保留 ----------
  await detachGen();
  await setWires({ refs: [[imgA.nodeId, 'image'], [audA.nodeId, 'audio']] });
  await selectAndFill(page, { model: LIMITED, intent: 'refs', prompt: '往返保留@图片1 人物' });
  await sel(2).selectOption('10');   // 限版时长为档位 select
  await page.evaluate(() => document.activeElement?.blur());
  await selectAndFill(page, { model: SLOW, intent: 'last_frame' });
  await selectAndFill(page, { model: LIMITED });
  const keep = await genData(page);
  assert.equal(keep.draft.model, LIMITED);
  assert.equal(keep.draft.intent, 'refs', '往返恢复限版 intent');
  assert.equal(keep.draft.seconds, 10, '往返恢复限版时长档');
  assert.equal(keep.draft.ratio, '16:9', '往返恢复限版比例');
  assert.equal(keep.draft.prompt, '往返保留@图片1 人物', '提示词不被存档覆盖');
  assert.equal(keep.draft.bindings?.['image:1'], imgA.assetId, '@绑定仍指向同一素材');
  assert.equal(keep.perModel?.[SLOW]?.intent, 'last_frame', '慢速版 perModel intent 保留');
  assert.equal(await page.evaluate(g => window.__xp.store.project.edges.filter(e => e.to.node === g && e.to.port === 'refs').length, genId),
    2, '往返素材连线保留');
  await selectAndFill(page, { model: SLOW });
  assert.equal((await genData(page)).draft.intent, 'last_frame', '切回慢速版恢复 last_frame intent');
  console.log('型号往返保留 ok');
  assert.deepEqual(pageErrors, [], '前半程无 pageerror');

  // ---------- 6) 桌面三视口：参数可见 + 无横向溢出 + 截图 ----------
  for (const w of [1280, 1440, 1920]) {
    const c2 = await browser.newContext({ viewport: { width: w, height: 900 } });
    await guardNet(c2);
    const p2 = await c2.newPage();
    p2.on('pageerror', e => { pageErrors.push(`vp${w}: ${e?.message ?? e}`); console.log(`[pageerror ${w}]`, e.message); });
    try {
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });
      await setKey(p2);
      await clickCanvasAction(p2, '[data-add-node="gen"]');
      await p2.waitForSelector('.node-gen', { timeout: 5000 });
      await p2.click('.node-gen .node-head');
      await p2.waitForSelector('#inspector select', { timeout: 8000 });
      await p2.locator('#inspector select').nth(0).selectOption(LIMITED);
      await p2.waitForTimeout(150);
      const secText = await p2.locator('#inspector select').nth(2).evaluate(s => [...s.options].map(o => o.textContent).join('|'));
      assert.match(secText, /6 秒\|10 秒\|15 秒/, `${w}px 限版时长档 6/10/15 可见`);
      assert.match(await p2.locator('#inspector .cost').textContent(), /¥1\.50/, `${w}px 限版价格可见`);
      await p2.locator('#inspector select').nth(0).selectOption(SLOW);
      await p2.locator('#inspector select').nth(1).selectOption('last_frame');
      await p2.waitForTimeout(150);
      assert.equal(await p2.evaluate(() => window.__xp.store.project.nodes.find(n => n.type === 'gen').data.draft.intent),
        'last_frame', `${w}px 慢速版仅尾帧可选`);
      const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= w, `${w}px 无横向溢出（scrollWidth=${sw}）`);
      for (const theme of ['dark', 'light']) {
        await p2.locator(`[data-theme-option="${theme}"]`).click();
        assert.equal(await p2.evaluate(() => document.documentElement.dataset.theme), theme);
        assert.equal(await p2.locator(`[data-theme-option="${theme}"]`).getAttribute('aria-pressed'), 'true');
        assert.equal(await p2.locator(`[data-theme-option="${theme === 'dark' ? 'light' : 'dark'}"]`).getAttribute('aria-pressed'), 'false');
        assert.ok(await p2.locator('#inspector select').nth(1).isVisible(), `${w}px ${theme} 模式控件可见`);
        assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}px ${theme} 无横向溢出`);
        await p2.screenshot({ path: join(SHOTS, `h3-compat-${w}-${theme}.png`), fullPage: false, animations: 'disabled' });
      }
      console.log(`viewport ${w}: 限版/慢速版参数可见 ok`);
    } finally { await c2.close(); }
  }

  // ---------- 收口：全局计数 + 页面错误 ----------
  assert.equal(state.creates.length, 21, '创建总数 = 13 合约 + 8 次有效提交（含 3 次仅提交本模式输入口）');
  assert.equal(state.uploads.length, 3, '上传总数 = 图A/图B/音频A 各一次（远端缓存复用；拒绝项与本模式不使用的素材 0 上传）');
  assert.equal(state.downloads.length, 2, '两个新型号各一次鉴权下载');
  assert.deepEqual(pageErrors, [], '全程无页面脚本错误');
});
