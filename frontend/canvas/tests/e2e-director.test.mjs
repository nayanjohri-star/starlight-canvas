// 旧插件兼容 3D E2E：显式 legacy runtime + 真实本机服务 + 真实 MiniMax 参考插件 + 真实 WebGL。
// 用软件渲染（SwiftShader / --enable-unsafe-swiftshader）串行跑，避免依赖本机 GPU
// 与 GPU 黑屏；单浏览器单页面顺序验收。
// 验收：隔离源握手、会话身份、scene.edit set_campath 真实编辑 + 自动保存（包裹记录）、
// 原生「导出图片 / 导出运镜视频」按钮进素材库（字节可解码、fromDirector 绑定）、
// 关闭重开恢复、Esc/项目切换清理、双开防护。无桥接兜底——只验收真实导出路径。
// 默认不跑（需本地 Chromium + WebGL 软件渲染）：npm run test:director 或 E2E_DIRECTOR=1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  chromium, createCanvasServer, ROOT, SHOTS, CHROME, DIRECTOR_DIR, DIRECTOR_OK,
  assertVideoDecodes, assertImageDecodes, setKey, MODELS_11,
} from './e2e-helpers.mjs';
import { installLegacyDirectorRuntime } from './legacy-director-fixture.mjs';

// 缺资源语义（裁决11）：开关未开 → skip；开关已开但资源/浏览器缺失 → 如实 skip 标注「未验收」，不判 fail。
const DIRECTOR_SKIP = process.env.E2E_DIRECTOR !== '1'
  || (!DIRECTOR_OK && '导演台资源未随共享分支分发（docs/minimax-video-ref/bundled-plugins/3d-director-stage 缺失），未验收')
  || (!CHROME && 'E2E 浏览器缺失，未验收');

test('E2E 导演台：真实插件 + 隔离源 + 导出解码 + 重开恢复 + 会话清理', { skip: DIRECTOR_SKIP, timeout: 420000 }, async t => {
  assert.ok(existsSync(join(DIRECTOR_DIR, 'index.html')), '需要 MiniMax 参考插件 docs/minimax-video-ref/bundled-plugins/3d-director-stage');
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: DIRECTOR_DIR, upstreamFetch: async (url, init) =>
    new URL(url).pathname === '/v1/models' && init.method === 'GET'
      ? Response.json({ data: MODELS_11.map(id => ({ id })) })
      : new Response('{}', { status: 404 }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser = null;
  t.after(async () => { await browser?.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  // 软件渲染 WebGL：无 GPU 环境（含 headless CI）也能真实初始化 three.js 上下文
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installLegacyDirectorRuntime(page.context()); // Explicit optional legacy-plugin regression.
  const pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  page.on('pageerror', e => { pageErrors.push(String(e?.message ?? e)); console.log('[pageerror]', e.message); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 15000 });
  await setKey(page);
  await page.evaluate(() => window.__xp.store.newProject('导演台验收'));
  const nodeId = await page.evaluate(() => window.__xp.store.addNode('director', 200, 120, {}).id);
  await page.waitForSelector('.node-director', { timeout: 5000 });
  await page.locator('.node-director button', { hasText: '打开导演台' }).click();

  // ---------- 1) 真实 iframe + 隔离源握手 ----------
  const frameEl = page.locator('iframe.director-frame');
  await frameEl.waitFor({ state: 'visible', timeout: 15000 });
  const src = await frameEl.getAttribute('src');
  assert.match(src, new RegExp(`^http://localhost:${port}/director/index\\.html\\?node=${nodeId}&nonce=`), 'iframe 走隔离源且带节点+nonce');
  assert.equal(await page.evaluate(() => window.__xp.host.isOpen(window.__xp.store.project.nodes[0].id)), true, '会话已登记');
  // 双开防护：再点不叠第二个 iframe（节点体按钮仍是同一节点）
  await page.evaluate(nid => window.__xp.host.openEditor(window.__xp.store.node(nid)), nodeId);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('iframe.director-frame').count(), 1, '同节点不叠第二个会话');

  const realFrame = await (await frameEl.elementHandle()).contentFrame();
  assert.ok(realFrame, '导演台 iframe 存在');
  await realFrame.waitForURL(/\/director\/index\.html/, { timeout: 15000 });
  const origin = new URL(realFrame.url()).origin;
  assert.notEqual(origin, `http://127.0.0.1:${port}`, '插件源与画布源不同（隔离）');
  await realFrame.waitForFunction(() => window.hub?.ready, null, { timeout: 20000 });
  await realFrame.evaluate(() => window.hub.ready);
  assert.equal(await realFrame.evaluate(() => window.hub.canvas.getCurrentNodeId()), nodeId, '节点身份透传');
  assert.equal(await realFrame.evaluate(() => typeof window.hub.key), 'undefined', 'iframe 内无任何密钥面');
  // 真实 WebGL：插件画布拿到 WebGL 上下文（软件渲染也算，只要非降级失败页）
  await realFrame.waitForSelector('canvas', { timeout: 30000 });
  const glOK = await realFrame.evaluate(() => {
    const c = document.querySelector('canvas');
    return !!(c && (c.getContext('webgl2') || c.getContext('webgl')));
  });
  assert.ok(glOK, '插件内 WebGL 上下文真实初始化');
  await page.screenshot({ path: join(SHOTS, 'director-open.png'), fullPage: false });

  // ---------- 2) AI 编辑器上下文摘要：原生插件以多行字符串调 agent.setEditorState ----------
  // 原生 bundle：PL → hub.agent.setEditorState(c0(scene,selectedIds))，c0 产出
  // 「3D Director Stage scene:」开头的多行上下文摘要（场景对象本身另存 composition）。
  // 宿主按 {summary: 原文} 规范持久化——必须真实落盘，不得再抛根类型 pageerror。
  let savedState = null;
  for (let i = 0; i < 40; i++) {
    savedState = await page.evaluate(nid => window.__xp.store.node(nid)?.data?.editorState ?? null, nodeId);
    if (savedState && typeof savedState.summary === 'string' && savedState.summary.length) break;
    await page.waitForTimeout(250);
  }
  assert.ok(savedState && typeof savedState === 'object' && !Array.isArray(savedState), 'editorState 以对象形式持久化');
  assert.equal(typeof savedState.summary, 'string', '原生摘要字符串落入 summary 字段');
  assert.match(savedState.summary, /3D Director Stage scene:/, 'summary 为原生场景摘要文本（非伪造对象）');
  assert.ok(savedState.summary.includes('\n'), 'summary 保留原生多行结构');

  // ---------- 3) 真实场景编辑：scene.edit set_campath（文档化契约，确定性优于 UI 文案） ----------
  const editRes = await page.evaluate(async nid => window.__xp.host.invokeAgent(nid, {
    method: 'scene.edit',
    args: {
      description: '验收缓推',
      operations: [{ type: 'set_campath', dsl: 'campath "验收缓推"\n  look at 0 1.2 0\n  from 0 1.6 6 fov 45\n  dolly in 2 4s' }],
    },
  }), nodeId);
  assert.equal(editRes?.ok, true, `scene.edit 应成功：${JSON.stringify(editRes)?.slice(0, 400)}`);
  assert.equal(editRes.applied, 1, '应恰好应用 1 个操作');
  const sumText = typeof editRes.summary === 'string' ? editRes.summary : JSON.stringify(editRes.summary ?? '');
  assert.match(sumText, /path|camPath|运镜/i, 'summary 应体现新建路径');
  assert.match(sumText, /track|clip|轨道|时间线/i, 'summary 应体现新建轨道');

  // ---------- 4) 场景自动保存 → dir:<nodeId>:composition 包裹记录（{schemaVersion,savedAt,composition}） ----------
  // 持久化是异步 RPC，直接轮询最终记录，不能将尚未完成的 Promise 当成保存完成。
  async function readSaved(frame) {
    for (let i = 0; i < 80; i++) {
      const json = await frame.evaluate(async () => {
        const v = await window.hub.storage.get('composition');
        return JSON.stringify((typeof v === 'string' ? JSON.parse(v) : v)?.composition ?? null);
      });
      const comp = JSON.parse(json);
      if (comp?.camPaths?.length) return comp;
      await page.waitForTimeout(250);
    }
    throw new Error('场景未在 20 秒内持久化');
  }
  const comp1 = await readSaved(realFrame);
  assert.ok(comp1 && typeof comp1 === 'object', '包裹记录内 composition 为对象');
  assert.ok(Array.isArray(comp1.camPaths) && comp1.camPaths.length >= 1, '已保存场景含运镜路径');
  // 与权威 scene.get 对照：保存内容必须与实时场景一致
  const live1 = await page.evaluate(nid => window.__xp.host.invokeAgent(nid, { method: 'scene.get', args: {} }), nodeId);
  const livePath = (live1.camPaths ?? []).find(p => (p.label ?? p.name) === '验收缓推');
  assert.ok(livePath, 'scene.get 能读到新建运镜路径');
  assert.equal(livePath.duration, 4000, '运镜时长 4s（scene.get 的 duration 单位为毫秒）');
  assert.ok(comp1.camPaths.some(p => (p.label ?? p.name) === '验收缓推'), '已保存场景包含同一路径');

  // ---------- 5) 原生「导出图片」：先记素材身份再点击，新素材须绑定本节点且真实可解码 ----------
  const imgBefore = await page.evaluate(() => Object.values(window.__xp.store.project.assets).filter(a => a.kind === 'image').map(a => a.id));
  await realFrame.getByRole('button', { name: '导出图片', exact: true }).first().click();
  await page.waitForFunction(
    before => Object.values(window.__xp.store.project.assets).some(a => a.kind === 'image' && !before.includes(a.id)),
    imgBefore, { timeout: 60000 });
  const imgAssetId = await page.evaluate(before =>
    Object.values(window.__xp.store.project.assets).find(a => a.kind === 'image' && !before.includes(a.id)).id, imgBefore);
  const imgMeta = await page.evaluate(id => {
    const a = window.__xp.store.project.assets[id];
    const node = window.__xp.store.project.nodes.find(n => n.data?.assetId === id);
    return { kind: a.kind, mime: a.mime, fromDirector: a.fromDirector, title: node?.data?.title ?? a.name, size: a.size };
  }, imgAssetId);
  assert.equal(imgMeta.kind, 'image');
  assert.equal(imgMeta.fromDirector, nodeId, '导出素材绑定导演台节点');
  assert.ok(imgMeta.title, '导出节点带标题');
  assert.ok(imgMeta.size > 0 && imgMeta.size <= 30 * 1024 * 1024, '图片大小在限内');
  const imgBytes = await page.evaluate(async id => [...new Uint8Array(await (await window.__xp.assets.blobOf(id)).arrayBuffer())], imgAssetId);
  assert.ok(await assertImageDecodes(page, imgBytes), '导出图片真实可解码');

  // ---------- 6) 原生「导出运镜视频」：4s 运镜路径使按钮可用；点击自动导出，无额外交互 ----------
  const vidBefore = await page.evaluate(() => Object.values(window.__xp.store.project.assets).filter(a => a.kind === 'video').map(a => a.id));
  await realFrame.getByRole('button', { name: '导出运镜视频', exact: true }).first().click();
  await page.waitForFunction(
    before => Object.values(window.__xp.store.project.assets).some(a => a.kind === 'video' && !before.includes(a.id)),
    vidBefore, { timeout: 90000 });
  const vidAssetId = await page.evaluate(before =>
    Object.values(window.__xp.store.project.assets).find(a => a.kind === 'video' && !before.includes(a.id)).id, vidBefore);
  const vidMeta = await page.evaluate(id => ({ size: window.__xp.store.project.assets[id].size, mime: window.__xp.store.project.assets[id].mime, fromDirector: window.__xp.store.project.assets[id].fromDirector }), vidAssetId);
  assert.ok(vidMeta.size > 0 && vidMeta.size <= 100 * 1024 * 1024, '视频大小在限内');
  assert.equal(vidMeta.fromDirector, nodeId);
  const vidBytes = await page.evaluate(async id => [...new Uint8Array(await (await window.__xp.assets.blobOf(id)).arrayBuffer())], vidAssetId);
  assert.ok(await assertVideoDecodes(page, vidBytes, vidMeta.mime || 'video/mp4'), '导出视频真实可解码');
  // 复用：导演台导出素材可连线生成节点（分镜/生成工作流入口）
  const wired = await page.evaluate(async id => {
    const s = window.__xp.store;
    const gen = s.addNode('gen', 700, 300, { draft: {}, perModel: {} });
    const an = s.project.nodes.find(n => n.data?.assetId === id);
    const e = s.addEdge(an.id, 'out', gen.id, 'refs', 'video');
    return !!e;
  }, vidAssetId);
  assert.ok(wired, '导演台导出素材可连线生成节点复用');

  // ---------- 7) Esc 清理 + 重开恢复：场景路径与导出文件均存活 ----------
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('iframe.director-frame'), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__xp.host.isOpen(window.__xp.store.project.nodes.find(n => n.type === 'director').id)), false, 'Esc 终结会话');
  await page.locator('.node-director button', { hasText: '打开导演台' }).click();
  const frame2 = page.locator('iframe.director-frame');
  await frame2.waitFor({ state: 'visible', timeout: 15000 });
  const realFrame2 = await (await frame2.elementHandle()).contentFrame();
  await realFrame2.waitForURL(/\/director\/index\.html/, { timeout: 15000 });
  await realFrame2.waitForFunction(() => window.hub?.ready, null, { timeout: 20000 });
  await realFrame2.evaluate(() => window.hub.ready);
  const comp2 = await readSaved(realFrame2);
  assert.ok(comp2, '重开后场景仍在');
  assert.deepEqual(
    (comp2.camPaths ?? []).map(p => ({ label: p.label ?? p.name, duration: p.duration, points: p.points })),
    (comp1.camPaths ?? []).map(p => ({ label: p.label ?? p.name, duration: p.duration, points: p.points })),
    '重开后运镜路径一致');
  // 导出文件随项目存活：重开后 blob 仍可取回
  assert.ok(await page.evaluate(async id => !!(await window.__xp.assets.blobOf(id)), imgAssetId), '导出图片文件仍在');
  assert.ok(await page.evaluate(async id => !!(await window.__xp.assets.blobOf(id)), vidAssetId), '导出视频文件仍在');
  // 重开后插件 500ms 定时再次上送摘要（此刻场景已含恢复出的运镜）：仍须按 {summary} 契约落盘
  let savedState2 = null;
  for (let i = 0; i < 40; i++) {
    savedState2 = await page.evaluate(nid => window.__xp.store.node(nid)?.data?.editorState?.summary ?? null, nodeId);
    if (typeof savedState2 === 'string' && savedState2.length) break;
    await page.waitForTimeout(250);
  }
  assert.ok(typeof savedState2 === 'string' && /3D Director Stage scene:/.test(savedState2), '重开后原生摘要仍按 {summary} 契约持久化');
  await page.screenshot({ path: join(SHOTS, 'director-reopen.png'), fullPage: false });

  // ---------- 8) 项目切换清理：会话/iframe 立即终结，不得跨项目泄漏 ----------
  await page.evaluate(() => window.__xp.store.newProject('切换验收'));
  await page.waitForFunction(() => !document.querySelector('iframe.director-frame'), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__xp.host.isOpen(window.__xp.store.project.nodes.find(n => n?.type === 'director')?.id ?? '')), false);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.mask iframe').length), 0, '切换后无残留 iframe');

  // ---------- 9) 全流程零页面级错误：原生 setEditorState 字符串契约不再抛错，亦不掩盖其他失败 ----------
  assert.deepEqual(pageErrors, [], '导演台全流程不得有 pageerror（修复前曾出现 setEditorState 根类型报错 ×3）');
});
